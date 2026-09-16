/**
 * Drives `claude setup-token` from inside the plugin so connecting a Claude
 * account never requires the user to open a terminal.
 *
 * On a normal desktop session `setup-token` opens the user's browser and
 * completes via a local OAuth callback server with no further input — it only
 * falls back to an interactive "paste code" prompt over SSH/WSL2/containers
 * (see https://code.claude.com/docs/en/authentication), which this headless
 * spawn can't satisfy. That's an accepted gap: those environments already
 * require a real terminal for Claude Code's own login, so this feature isn't
 * making anything worse there — it just doesn't help.
 */

export interface ClaudeSetupTokenSuccess {
  ok: true;
  token: string;
}

export interface ClaudeSetupTokenFailure {
  ok: false;
  error: string;
  /** Combined stdout+stderr, so the UI can show it as a manual-copy fallback when parsing fails. */
  rawOutput: string;
}

export type ClaudeSetupTokenResult = ClaudeSetupTokenSuccess | ClaudeSetupTokenFailure;

/** Minimal shape of the `child_process.spawn` result this module depends on (mockable in tests). */
export interface SpawnedProcess {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  kill(): unknown;
}

export type SpawnFn = (command: string, args: string[]) => SpawnedProcess;

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1B\[[0-9;]*[A-Za-z]/g;

// Every Anthropic-issued secret (API keys, OAuth/session tokens) uses this
// prefix family. `setup-token`'s exact output format isn't documented beyond
// "prints the token to the terminal", so this is a best-effort scrape: if the
// output ever contains anything other than exactly one such string, treat
// parsing as inconclusive rather than guessing — callers fall back to
// showing the raw output for the user to copy by hand.
const TOKEN_PATTERN = /sk-ant-[A-Za-z0-9_-]{20,}/g;

export function extractSetupToken(rawOutput: string): string | null {
  const clean = rawOutput.replace(ANSI_PATTERN, '');
  const matches = [...new Set(clean.match(TOKEN_PATTERN) ?? [])];
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Runs `<claudeBinaryPath> setup-token` and resolves once it exits (or is
 * aborted via `signal`). Never rejects — every outcome, including a spawn
 * failure, resolves to a tagged result so callers don't need a try/catch.
 */
export function runClaudeSetupToken(
  claudeBinaryPath: string,
  spawnFn: SpawnFn,
  signal?: AbortSignal,
): Promise<ClaudeSetupTokenResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, error: 'Cancelled.', rawOutput: '' });
      return;
    }

    let child: SpawnedProcess;
    try {
      child = spawnFn(claudeBinaryPath, ['setup-token']);
    } catch (err) {
      resolve({ ok: false, error: `Could not start "${claudeBinaryPath} setup-token": ${(err as Error).message}`, rawOutput: '' });
      return;
    }

    let output = '';
    let settled = false;
    const finish = (result: ClaudeSetupTokenResult): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      child.kill();
      finish({ ok: false, error: 'Cancelled.', rawOutput: output });
    };
    signal?.addEventListener('abort', onAbort);

    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', (err) => {
      finish({ ok: false, error: `"${claudeBinaryPath} setup-token" failed to run: ${err.message}`, rawOutput: output });
    });
    child.on('close', (code) => {
      if (settled) return; // already resolved via onAbort
      if (code !== 0) {
        finish({ ok: false, error: `"claude setup-token" exited with code ${code ?? 'unknown'}.`, rawOutput: output });
        return;
      }
      const token = extractSetupToken(output);
      if (!token) {
        finish({ ok: false, error: 'Finished, but no token was found in the output.', rawOutput: output });
        return;
      }
      finish({ ok: true, token });
    });
  });
}

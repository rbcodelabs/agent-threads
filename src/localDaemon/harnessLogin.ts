/**
 * Local daemon: signing in non-Claude harnesses inside the daemon container.
 *
 * - `codex login --device-auth` prints a verification URL and a one-time code, waits until the user approves the page,
 *   and writes `~/.codex/auth.json` itself.
 * - `agy acp --login` prints a Google OAuth URL over plain stdio (no pseudo-terminal needed), reads the authorization
 *   code (or callback URL) on stdin, and writes `~/.gemini/jetski-standalone-oauth-token` itself.
 *
 * In both flows the credential is created INSIDE the container in the daemon user's HOME (`/var/lib/agent-threads/home`,
 * the data volume), so it survives restarts and updates and never touches Geode's settings, keychain or logs.
 *
 * OpenCode's `auth login` is an interactive provider picker with no non-interactive mode, so it is not driven from
 * here: the panel shows the exact `container exec` line instead (`manualLoginCommand`).
 */

import { stripAnsi, type SpawnLike } from '../claudeContainerAuthCli';
import { VM_BINARY } from '../containerCli';
import { parseAntigravityLogin, parseDeviceLogin } from './parse';
import { antigravityLoginArgs, codexLoginArgs } from './spec';

export type HarnessLoginResult = { ok: true } | { ok: false; error: string };

export interface DeviceLoginOptions {
  spawn: SpawnLike;
  /** Host-side env for the `container` binary itself (see `runnerEnv()`); never the container's own secrets. */
  hostEnv: NodeJS.ProcessEnv;
  containerName: string;
  onProgress?: (text: string) => void;
  /** The verification page, for a manual fallback link (the host also opens it). */
  onUrl?: (url: string) => void;
  /** Device codes are valid for about 15 minutes. */
  timeoutMs?: number;
}

export interface AntigravityLoginOptions extends DeviceLoginOptions {
  /** Resolves with the authorization code (or callback URL) pasted by the user, or `null` if cancelled. */
  onCodePrompt: () => Promise<string | null>;
  /** Fallback idle window (ms) after the URL prints before prompting if the CLI's prompt text changed. */
  idleMsBeforeCodePrompt?: number;
}

export const CODEX_LOGIN_TIMEOUT_MS = 15 * 60_000;
export const ANTIGRAVITY_LOGIN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_IDLE_BEFORE_CODE_PROMPT_MS = 1500;

/** Keeps anything token- or auth-code-shaped out of an error message (the CLI should print none, but never rely on it). */
function redact(text: string, secrets: ReadonlyArray<string | undefined> = []): string {
  let out = text
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '<redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_.-]+/g, '<redacted>')
    .replace(/\bya29\.[A-Za-z0-9._-]{16,}/g, '<redacted>')
    .replace(/\b1\/\/[A-Za-z0-9_-]{20,}/g, '<redacted>')
    .replace(/\b4\/[A-Za-z0-9_-]{16,}/g, '<redacted>')
    .replace(/([?&](?:code|access_token|refresh_token)=)[^&\s'"]+/gi, '$1<redacted>');
  for (const s of secrets) if (s) out = out.split(s).join('<redacted>');
  return out;
}

export function signInToCodexInContainer(opts: DeviceLoginOptions): Promise<HarnessLoginResult> {
  const timeoutMs = opts.timeoutMs ?? CODEX_LOGIN_TIMEOUT_MS;
  return new Promise<HarnessLoginResult>((resolve) => {
    let settled = false;
    let buffer = '';
    let urlShown = false;
    let codeShown = false;
    let child: ReturnType<SpawnLike> | undefined;

    const finish = (result: HarnessLoginResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch { /* already exited */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `Codex sign-in timed out after ${Math.round(timeoutMs / 60_000)} min. Start it again for a new code.` }), timeoutMs);

    const tail = (): string => redact(stripAnsi(buffer).trim().slice(-400));
    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const { url, code } = parseDeviceLogin(stripAnsi(buffer));
      if (url && !urlShown) { urlShown = true; opts.onUrl?.(url); }
      if (code && !codeShown) { codeShown = true; opts.onProgress?.(`Enter the code ${code} on the Codex sign-in page. Waiting for you to approve it…`); }
    };

    try {
      child = opts.spawn(VM_BINARY, codexLoginArgs(opts.containerName), { env: opts.hostEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      finish({ ok: false, error: `Could not start the Codex sign-in: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    opts.onProgress?.('Starting Codex sign-in in the daemon container…');
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => finish({ ok: false, error: `Could not run the Codex sign-in: ${err.message}` }));
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, error: `Codex sign-in did not complete (exit ${code ?? 'signal'}).${tail() ? `\n${tail()}` : ''}` });
    });
  });
}

export function signInToAntigravityInContainer(opts: AntigravityLoginOptions): Promise<HarnessLoginResult> {
  const timeoutMs = opts.timeoutMs ?? ANTIGRAVITY_LOGIN_TIMEOUT_MS;
  const idleMs = opts.idleMsBeforeCodePrompt ?? DEFAULT_IDLE_BEFORE_CODE_PROMPT_MS;
  return new Promise<HarnessLoginResult>((resolve) => {
    let settled = false;
    let buffer = '';
    let urlShown = false;
    let prompted = false;
    let submittedSecret: string | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<SpawnLike> | undefined;

    const finish = (result: HarnessLoginResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      try { child?.stdin?.end?.(); } catch { /* already closed */ }
      try { child?.kill(); } catch { /* already exited */ }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: `Antigravity sign-in timed out after ${Math.round(timeoutMs / 60_000)} min. Start it again for a new link.` }),
      timeoutMs,
    );

    const tail = (): string => redact(stripAnsi(buffer).trim().slice(-400), [submittedSecret]);

    const promptForCode = (): void => {
      if (settled || prompted) return;
      prompted = true;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
      opts.onProgress?.('Approve the Google sign-in page in your browser, then paste the authorization code (or callback URL) below.');
      void opts.onCodePrompt().then(
        (raw) => {
          if (settled) return;
          const code = raw?.trim();
          if (!code) {
            finish({ ok: false, error: 'Antigravity sign-in was cancelled.' });
            return;
          }
          submittedSecret = code;
          opts.onProgress?.('Completing Antigravity sign-in…');
          try {
            child?.stdin?.write(`${code}\n`);
            child?.stdin?.end?.();
          } catch (err) {
            finish({ ok: false, error: `Could not send the authorization code to Antigravity: ${err instanceof Error ? err.message : String(err)}` });
          }
        },
        (err) => finish({ ok: false, error: `Antigravity sign-in failed: ${err instanceof Error ? err.message : String(err)}` }),
      );
    };

    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const { url, waitingForCode } = parseAntigravityLogin(stripAnsi(buffer));
      if (url && !urlShown) {
        urlShown = true;
        opts.onUrl?.(url);
      }
      if (waitingForCode && !prompted) {
        promptForCode();
      } else if (urlShown && !prompted) {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(promptForCode, idleMs);
      }
    };

    try {
      child = opts.spawn(VM_BINARY, antigravityLoginArgs(opts.containerName), { env: opts.hostEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      finish({ ok: false, error: `Could not start the Antigravity sign-in: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    opts.onProgress?.('Starting Antigravity sign-in in the daemon container…');
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => finish({ ok: false, error: `Could not run the Antigravity sign-in: ${err.message}` }));
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, error: `Antigravity sign-in did not complete (exit ${code ?? 'signal'}).${tail() ? `\n${tail()}` : ''}` });
    });
  });
}

import { parseClaudeAuthStatus } from './claudeAuthRecovery';

/**
 * Drives the Claude CLI's own sign-in for the in-thread "Sign in to Claude"
 * button: `claude auth login` (opens the browser, exits once the OAuth
 * callback lands and the keychain entry is written), then `claude auth
 * status` to confirm `loggedIn: true`. Desktop only — callers must gate on
 * the platform; Node's child_process is injected so this stays testable and
 * never loads at module init on mobile.
 */

type ChildLike = {
  stdout?: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'close', cb: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  kill(signal?: string): boolean;
};

export type SpawnLike = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'] },
) => ChildLike;

export interface SignInOptions {
  spawn: SpawnLike;
  env: NodeJS.ProcessEnv;
  /** Max time to wait for the browser sign-in to complete. */
  timeoutMs?: number;
  onProgress?: (text: string) => void;
  /** The sign-in URL the CLI printed, for a manual fallback link. */
  onUrl?: (url: string) => void;
}

export type SignInResult = { ok: true } | { ok: false; error: string };

export const CLAUDE_SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const STATUS_TIMEOUT_MS = 20_000;

interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function run(
  spawn: SpawnLike,
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  onStdout?: (text: string) => void,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      finish(null);
    }, timeoutMs);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
    });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => finish(code));
  });
}

export async function signInToClaude(binary: string, opts: SignInOptions): Promise<SignInResult> {
  const timeoutMs = opts.timeoutMs ?? CLAUDE_SIGN_IN_TIMEOUT_MS;
  let urlReported = false;
  try {
    opts.onProgress?.('Waiting for browser sign-in…');
    const login = await run(opts.spawn, binary, ['auth', 'login'], opts.env, timeoutMs, (text) => {
      const url = !urlReported ? text.match(/https:\/\/\S+/)?.[0] : undefined;
      if (url) {
        urlReported = true;
        opts.onUrl?.(url);
      }
    });
    if (login.timedOut) {
      return { ok: false, error: `Sign-in timed out after ${Math.round(timeoutMs / 60_000) || 1} min. Try again, or run \`claude auth login\` in a terminal.` };
    }
    if (login.code !== 0) {
      const detail = (login.stderr.trim() || login.stdout.trim()).split('\n').slice(-3).join('\n');
      return { ok: false, error: detail || `claude auth login exited with code ${login.code}` };
    }
    opts.onProgress?.('Checking sign-in…');
    const status = await run(opts.spawn, binary, ['auth', 'status'], opts.env, STATUS_TIMEOUT_MS);
    if (!parseClaudeAuthStatus(status.stdout)) {
      return { ok: false, error: 'Sign-in finished but Claude is still signed out.Run `claude auth status` in a terminal to check.' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

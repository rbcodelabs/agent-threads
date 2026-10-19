/**
 * Local daemon: signing in the Codex CLI inside the daemon container.
 *
 * `codex login --device-auth` is the one agent login that works headless: it prints a verification URL and a
 * one-time code, then waits until the user approves the page, and writes `~/.codex/auth.json` itself. Nothing is
 * pasted back, no pseudo-terminal is needed, and the credential is created INSIDE the container in the daemon user's
 * HOME (`/var/lib/agent-threads/home`, the data volume), so it survives restarts and updates and never touches
 * Geode's settings, keychain or logs. This module only relays the URL and code to the UI.
 *
 * OpenCode's `auth login` is an interactive provider picker with no non-interactive mode, so it is not driven from
 * here: the panel shows the exact `container exec` line instead (`manualLoginCommand`).
 */

import { stripAnsi, type SpawnLike } from '../claudeContainerAuthCli';
import { VM_BINARY } from '../containerCli';
import { parseDeviceLogin } from './parse';
import { codexLoginArgs } from './spec';

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

export const CODEX_LOGIN_TIMEOUT_MS = 15 * 60_000;

/** Keeps anything token-shaped out of an error message (the CLI should print none, but never rely on it). */
function redact(text: string): string {
  return text.replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '<redacted>').replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_.-]+/g, '<redacted>');
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

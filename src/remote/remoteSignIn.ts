/**
 * Client half of the daemon-side Claude sign-in (`auth.signin.*`, daemon/signin.ts). Drives the WS exchange:
 * start, show the URL, ask for the login code, send it, and receive the minted token. Pure of any keychain or UI:
 * the caller supplies the handlers and stores the token. Never logs or returns the token anywhere but the result.
 */
import { DaemonCommandError, type CommandResult } from './DaemonClient';
import type { ClientCommand, ClientCommandType, SigninEvent } from '../protocol';
import type { ConnectionState } from './DaemonClient';

/** The slice of `DaemonClient` this flow uses (a fake stands in for tests). */
export interface RemoteSignInClient {
  command<K extends Exclude<ClientCommandType, 'hello'>>(type: K, payload: Omit<Extract<ClientCommand, { type: K }>, 'type'>, opts?: { timeoutMs?: number; resend?: boolean }): Promise<CommandResult>;
  onSigninEvent(listener: (e: SigninEvent) => void): () => void;
  onState(listener: (s: ConnectionState) => void): () => void;
}

export interface RemoteSignInHandlers {
  onProgress?: (text: string) => void;
  onUrl?: (url: string) => void;
  /** Resolve with the pasted code, or `null` if the user cancelled. */
  onCodePrompt: () => Promise<string | null>;
}

export type RemoteSignInResult = { ok: true; token: string } | { ok: false; error: string };

/** A little over the daemon's own 5 minute budget, so its error reaches us first. */
export const REMOTE_SIGN_IN_TIMEOUT_MS = 6 * 60_000;
const START_TIMEOUT_MS = 15_000;

function describeCommandError(err: unknown): string {
  if (err instanceof DaemonCommandError) {
    if (err.code === 'unknown_command') return 'This daemon is too old to sign in from the app. Update it, or sign in on the machine itself with `claude /login`.';
    if (err.code === 'forbidden') return 'Signing in on the daemon needs an admin token. Add one in Settings, Remote daemons, Edit.';
    if (err.code === 'unauthorized') return 'The daemon rejected the admin token.';
    if (err.code === 'unreachable' || err.code === 'timeout' || err.code === 'closed') return `Could not reach the daemon: ${err.message}`;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export function runRemoteSignIn(client: RemoteSignInClient, handlers: RemoteSignInHandlers, opts: { timeoutMs?: number } = {}): Promise<RemoteSignInResult> {
  return new Promise<RemoteSignInResult>((resolve) => {
    let done = false;
    let flowId: string | undefined;
    let promptSeen = false;
    const unsubs: Array<() => void> = [];

    const finish = (result: RemoteSignInResult, cancelRemote: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const u of unsubs) u();
      // A flow still running on the daemon (we gave up first) must not linger.
      if (cancelRemote) void client.command('auth.signin.cancel', flowId ? { flowId } : {}, { timeoutMs: 5_000, resend: false }).catch(() => { /* the daemon ends it on disconnect */ });
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'Sign-in timed out.' }, true), opts.timeoutMs ?? REMOTE_SIGN_IN_TIMEOUT_MS);

    unsubs.push(client.onState((s) => {
      if (s.status !== 'connected' && s.status !== 'connecting') finish({ ok: false, error: `Lost the connection to the daemon during sign-in${s.detail ? ` (${s.detail})` : ''}.` }, false);
    }));

    unsubs.push(client.onSigninEvent((e) => {
      if (done) return;
      // Events can beat the start ack by a frame; once the id is known, ignore anything else's.
      if (flowId !== undefined && e.flowId !== flowId) return;
      switch (e.kind) {
        case 'progress': handlers.onProgress?.(e.text); return;
        case 'url': handlers.onUrl?.(e.url); return;
        case 'token': finish({ ok: true, token: e.token }, false); return;
        case 'error': finish({ ok: false, error: e.message }, false); return;
        case 'prompt': {
          if (promptSeen) return;
          promptSeen = true;
          void handlers.onCodePrompt().then(async (code) => {
            if (done) return;
            if (!code) { finish({ ok: false, error: 'Sign-in cancelled.' }, true); return; }
            try {
              await client.command('auth.signin.code', { flowId: flowId ?? e.flowId, code }, { timeoutMs: 15_000, resend: false });
            } catch (err) {
              finish({ ok: false, error: describeCommandError(err) }, true);
            }
          }, (err: unknown) => finish({ ok: false, error: describeCommandError(err) }, true));
          return;
        }
      }
    }));

    handlers.onProgress?.('Starting sign-in on the daemon…');
    client.command('auth.signin.start', {}, { timeoutMs: START_TIMEOUT_MS, resend: false }).then(
      (r) => { if (typeof r.flowId === 'string') flowId = r.flowId; },
      (err: unknown) => finish({ ok: false, error: describeCommandError(err) }, false),
    );
  });
}

/**
 * The interactive half of `claude setup-token`, independent of WHERE it runs. `claude setup-token` has no
 * headless/no-browser flag: it prints an OAuth URL, the user authorizes in their own browser, the browser then shows a
 * login CODE, and the CODE must be typed back into the CLI's own stdin to finish. That prompt renders nothing without
 * a pseudo-terminal, so callers hand this a command that already provides one (`expect`'s `spawn ...; interact` for
 * the container, `expect`/`script` for a remote daemon); this module only drives the plain pipes around it.
 *
 * Pure orchestration: the child process is injected (`SpawnLike`), so it is testable with fake timers and runs in
 * both the plugin and the daemon. Every secret is redacted from the failure text; the token is only ever returned.
 */
import { extractOAuthError, extractSignInUrl, extractToken, redactToken, stripAnsi, TOKEN_PREFIX_PATTERN } from './setupTokenParse';

export type ChildLike = {
  stdout?: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  stdin?: { write(data: string): unknown } | null;
  on(event: 'close', cb: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  kill(signal?: string): boolean;
};

/** Mirrors `SpawnLike` in claudeAuthCli.ts, plus `stdin` - we write the pasted code back through it. */
export type SpawnLike = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildLike;

export type SetupTokenResult = { ok: true; token: string } | { ok: false; error: string };

export const DEFAULT_IDLE_MS_BEFORE_CODE_PROMPT = 900;

/** Pause between typing the code and pressing Enter, so the TUI sees them as separate input events. */
export const ENTER_DELAY_MS = 300;

/** After a token first appears, wait this long for trailing characters before taking it. */
export const TOKEN_SETTLE_MS = 800;

/** Max wait between submitting the code and seeing EITHER a token or a rejection before failing with the CLI's own last output. */
export const VERIFY_WATCHDOG_MS = 60_000;

/** The whole flow's budget when the caller gives none. */
export const SETUP_TOKEN_TIMEOUT_MS = 5 * 60_000;

export interface SetupTokenSessionOptions {
  spawn: SpawnLike;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  onProgress?: (text: string) => void;
  /** The sign-in URL the CLI printed, for a manual fallback link. */
  onUrl?: (url: string) => void;
  /** Called once, after stdout has gone quiet for a bit following the URL. Resolve with the pasted code, or `null` if the user cancelled. */
  onCodePrompt: () => Promise<string | null>;
  timeoutMs?: number;
  /**
   * Debounce window (ms) of no new stdout/stderr data, once the URL has been captured, before treating the CLI as
   * now waiting for the code. There is no reliable text to pattern-match for the prompt itself - the CLI's TUI
   * renders it with cursor-positioning escape codes between words, no literal whitespace - so idle-on-stdout is the
   * signal instead. Overridable for tests; production callers should leave this at the default.
   */
  idleMsBeforeCodePrompt?: number;
  /** Runs once when the flow ends for any reason after the child started (reap what killing the child leaves behind). */
  cleanup?: () => void;
  /** Aborting ends the flow as cancelled and kills the child. */
  signal?: AbortSignal;
}

export function runSetupTokenSession(opts: SetupTokenSessionOptions): Promise<SetupTokenResult> {
  const timeoutMs = opts.timeoutMs ?? SETUP_TOKEN_TIMEOUT_MS;
  const idleMs = opts.idleMsBeforeCodePrompt ?? DEFAULT_IDLE_MS_BEFORE_CODE_PROMPT;

  return new Promise<SetupTokenResult>((resolve) => {
    let settled = false;
    let buffer = '';
    let urlShown = false;
    let codePromptFired = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let tokenTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    /** `buffer.length` at the moment the code was written - everything after it is the CLI's reaction to the code. */
    let submittedAt = -1;
    let child: ChildLike | undefined;

    const timer = setTimeout(() => {
      finish({ ok: false, error: `Sign-in timed out after ${Math.round(timeoutMs / 60_000) || 1} min.` });
    }, timeoutMs);

    const onAbort = (): void => finish({ ok: false, error: 'Sign-in cancelled.' });

    function finish(result: SetupTokenResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (tokenTimer) clearTimeout(tokenTimer);
      if (watchdog) clearTimeout(watchdog);
      opts.signal?.removeEventListener('abort', onAbort);
      try { child?.kill(); } catch { /* already exited - fine */ }
      if (child) { try { opts.cleanup?.(); } catch { /* best effort */ } }
      resolve(result);
    }

    /** Last ~400 chars of readable output, token-redacted - so a stall or failure explains itself instead of a silent spinner. */
    function tailForError(): string {
      const clean = stripAnsi(buffer);
      return redactToken(clean.trim().slice(-400), extractToken(clean));
    }

    /** What the CLI printed since we wrote the code, escape-free. */
    function afterSubmit(): string {
      return submittedAt < 0 ? '' : stripAnsi(buffer.slice(submittedAt));
    }

    /** Runs on every chunk once a code has been written: notices a finished token or a server-side rejection without waiting for the process to exit. */
    function checkAfterSubmit(): void {
      const out = afterSubmit();
      const reason = extractOAuthError(out);
      if (reason) {
        finish({ ok: false, error: `${reason} Click “Sign in to Claude” to try again.` });
        return;
      }
      const prefixed = out.match(TOKEN_PREFIX_PATTERN);
      if (prefixed && prefixed.length > 0) {
        // The token arrives in one burst, but give any trailing characters a moment to land before taking the last
        // match. Debounced, so a token still mid-stream keeps extending until output settles.
        if (tokenTimer) clearTimeout(tokenTimer);
        tokenTimer = setTimeout(() => {
          const latest = afterSubmit().match(TOKEN_PREFIX_PATTERN);
          if (latest && latest.length > 0) finish({ ok: true, token: latest[latest.length - 1] });
        }, TOKEN_SETTLE_MS);
      }
    }

    // Debounced "the CLI has gone quiet" signal - reset on every chunk of output, fired only once, and only once the
    // URL has already been seen.
    function scheduleIdleCheck(): void {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (settled || codePromptFired || !urlShown) return;
        codePromptFired = true;
        opts.onProgress?.('Waiting for your login code…');
        void opts.onCodePrompt().then((code) => {
          if (settled) return;
          if (!code) {
            finish({ ok: false, error: 'Sign-in cancelled.' });
            return;
          }
          opts.onProgress?.('Verifying code…');
          try {
            submittedAt = buffer.length;
            // Text and Enter go as SEPARATE writes. Written together, a long code (~87 chars: `code#state`) arrives as
            // one burst the TUI treats as a paste, and the trailing Enter is swallowed as paste content - the prompt
            // just fills with `*` and never submits (reproduced live; short codes happened to work). A distinct
            // keystroke after the text has landed submits it.
            child?.stdin?.write(code);
            setTimeout(() => {
              if (settled) return;
              try { child?.stdin?.write('\r'); } catch (err) {
                finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
              }
            }, ENTER_DELAY_MS);
            // Never leave the UI on "Verifying code…" indefinitely: if the CLI neither prints a token nor rejects the
            // code, say what it DID print.
            watchdog = setTimeout(() => {
              finish({
                ok: false,
                error: `Sign-in didn’t complete within ${Math.round(VERIFY_WATCHDOG_MS / 1000)}s of submitting the code. Last output from Claude:\n${tailForError() || '(none)'}`,
              });
            }, VERIFY_WATCHDOG_MS);
          } catch (err) {
            finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        });
      }, idleMs);
    }

    if (opts.signal?.aborted) {
      clearTimeout(timer);
      resolve({ ok: false, error: 'Sign-in cancelled.' });
      return;
    }

    let started: ChildLike;
    try {
      started = opts.spawn(opts.command, opts.args, { env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      clearTimeout(timer);
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    child = started;
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    opts.onProgress?.('Waiting for browser sign-in…');

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      if (!urlShown) {
        const url = extractSignInUrl(buffer);
        if (url) {
          urlShown = true;
          opts.onUrl?.(url);
        }
      }
      if (submittedAt >= 0) checkAfterSubmit();
      // Once the code is in, stop re-arming the "waiting for the code" idle check - codePromptFired already guards
      // it, this just avoids churn.
      scheduleIdleCheck();
    };
    started.stdout?.on('data', onData);
    started.stderr?.on('data', onData);

    started.on('error', (err) => {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });

    started.on('close', (code) => {
      // Extract from escape-stripped text: raw TUI output interleaves cursor and color codes that can split a token.
      const clean = stripAnsi(buffer);
      const token = extractToken(clean);
      if (code !== 0 && code !== null) {
        const tail = redactToken(clean.trim().split('\n').slice(-3).join('\n'), token);
        finish({ ok: false, error: tail || `${opts.command.split('/').pop() || 'sign-in'} exited with code ${code}` });
        return;
      }
      if (!token) {
        finish({ ok: false, error: `Sign-in finished but no token was found in the output. Last output from Claude:\n${tailForError() || '(none)'}` });
        return;
      }
      finish({ ok: true, token });
    });
  });
}

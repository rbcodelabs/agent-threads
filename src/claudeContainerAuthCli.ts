import { CLAUDE_SIGN_IN_TIMEOUT_MS } from './claudeAuthCli';
import { VM_BINARY } from './sandboxVm';

/**
 * Drives Claude sign-in **inside** a thread's sandbox container, for the case
 * where the harness itself runs there too (ADR-0015) and there is no host
 * `claude` install to sign in with `claudeAuthCli.ts`'s `claude auth login`.
 *
 * `claude setup-token` has no headless/no-browser flag (checked live against
 * `claude auth login --help` / `claude setup-token --help` in the built
 * harness image): it prints an OAuth URL, the user authorizes in their own
 * browser, the browser then shows a login CODE (no automatic callback — a
 * container can't redirect back to a local port), and the CODE must be typed
 * back into the CLI's own stdin to finish. That interactive prompt renders
 * nothing at all without a real pseudo-terminal on the CLI's end (verified
 * live: a plain piped stdin produced zero output for 40+ seconds).
 *
 * This runs through `/usr/bin/expect`'s `spawn ...; interact` over a
 * completely ORDINARY plain-pipe child process — no pty on the Node/host
 * side at all. `expect` allocates the pty its spawned `container exec -t`
 * needs; `interact` then relays that pty's I/O back out through expect's own
 * perfectly normal stdout/stdin pipes. Verified live end-to-end: the printed
 * OAuth URL arrives via ordinary stdout 'data' events, and a plain
 * `child.stdin.write(code + '\r')` reaches the container's `claude
 * setup-token` prompt and produces the real CLI's real response (including
 * a genuine server-side rejection of a bad code).
 *
 * Deliberately NOT `node-pty`: this plugin's release workflow only uploads
 * `dist/main.js`/`styles.css`/`manifest.json`/`versions.json` — never
 * `node_modules/` — so a native module's compiled binary can never reach a
 * real install. `expect` ships standard on every macOS install, which this
 * whole feature already requires (Apple's `container` runtime is
 * macOS-only), so it needs zero packaging.
 */

type ChildLike = {
  stdout?: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  stdin?: { write(data: string): unknown } | null;
  on(event: 'close', cb: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  kill(signal?: string): boolean;
};

/** Mirrors `SpawnLike` in claudeAuthCli.ts, plus `stdin` — we write the pasted code back through it. */
export type SpawnLike = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildLike;

export interface ContainerSignInOptions {
  spawn: SpawnLike;
  /** Host-side env for the `expect`/`container` binaries themselves — see `runnerEnv()` in sandboxVm.ts. Never the container's own secrets. */
  hostEnv: NodeJS.ProcessEnv;
  containerName: string;
  containerBinaryPath: string;
  onProgress?: (text: string) => void;
  /** The sign-in URL the CLI printed, for a manual fallback link. */
  onUrl?: (url: string) => void;
  /** Called once, after stdout has gone quiet for a bit following the URL. Resolve with the pasted code, or `null` if the user cancelled. */
  onCodePrompt: () => Promise<string | null>;
  timeoutMs?: number;
  /**
   * Debounce window (ms) of no new stdout/stderr data, once the URL has been
   * captured, before treating the CLI as now waiting for the code. There is
   * no reliable text to pattern-match for the prompt itself — the CLI's TUI
   * renders it with cursor-positioning escape codes between words (e.g.
   * `...Paste...code...here...` each preceded by an `ESC[<n>G` absolute-
   * column code, no literal whitespace) — so idle-on-stdout is the signal
   * instead. Overridable for tests; production callers should leave this at
   * the default.
   */
  idleMsBeforeCodePrompt?: number;
}

export type ContainerSignInResult = { ok: true; token: string } | { ok: false; error: string };

/** Matches `CLAUDE_SIGN_IN_TIMEOUT_MS` in claudeAuthCli.ts — same 5-minute budget for the equivalent host-side flow. */
export const CLAUDE_CONTAINER_SIGN_IN_TIMEOUT_MS = CLAUDE_SIGN_IN_TIMEOUT_MS;

const DEFAULT_IDLE_MS_BEFORE_CODE_PROMPT = 900;

/** Pause between typing the code and pressing Enter, so the TUI sees them as separate input events. */
const ENTER_DELAY_MS = 300;

/** After a token first appears, wait this long for trailing characters before taking it. */
const TOKEN_SETTLE_MS = 800;

/** Max wait between submitting the code and seeing EITHER a token or a rejection before failing with the CLI's own last output. */
const VERIFY_WATCHDOG_MS = 60_000;

/** Ships standard on every macOS install (verified on macOS 26.4.1) — this feature already requires macOS for Apple's `container` runtime, so no PATH resolution or bundling is needed. */
export const EXPECT_BINARY = '/usr/bin/expect';

/**
 * Secret-storage name (see `secretStorageKey`) for the token this sign-in
 * mints. Intentionally NOT `CLAUDE_CODE_OAUTH_TOKEN` and never listed in
 * `secretEnvKeys`: `ThreadSession` injects it only into VM-routed sessions.
 */
export const CONTAINER_AUTH_TOKEN_SECRET = 'CLAUDE_THREADS_CONTAINER_OAUTH_TOKEN';

/**
 * Kills leftover `<binary> setup-token` processes inside the container.
 * Killing the host-side `expect` does NOT stop the process it started inside
 * the container — abandoned sign-ins were observed piling up there. Matches
 * only a cmdline that STARTS with the binary path (so this `sh -c` itself,
 * whose cmdline starts with "sh", is never a match); the binary path is
 * passed as a positional argument, never interpolated into the script.
 */
export const KILL_LEFTOVER_SETUP_TOKEN_SCRIPT =
  'for p in /proc/[0-9]*; do c=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null); case "$c" in "$1 setup-token"*) kill "${p#/proc/}" 2>/dev/null;; esac; done';

export function buildKillLeftoverSetupTokenArgs(containerName: string, containerBinaryPath: string): string[] {
  return ['exec', containerName, 'sh', '-c', KILL_LEFTOVER_SETUP_TOKEN_SCRIPT, 'sh', containerBinaryPath];
}

/** Env var names the Tcl script below reads via `$env(...)` — see `buildContainerSetupTokenExpectArgs`'s doc comment for why these are never string-interpolated into the script text itself. */
export const CT_CONTAINER_NAME_ENV = 'CT_CONTAINER_NAME';
export const CT_BINARY_PATH_ENV = 'CT_BINARY_PATH';

/**
 * Fixed Tcl script for `expect -c` — always the same string, regardless of
 * `containerName`/`containerBinaryPath`. Those are NEVER interpolated
 * directly into this text: `containerBinaryPath` in particular can be a
 * Settings-configured value, and string-building a Tcl (or, if Tcl ever
 * shells out, POSIX shell) command from untrusted input is a classic
 * injection hazard. Instead they ride the child process's environment (see
 * `buildContainerSetupTokenEnv`) and the script reads them back via
 * `$env(...)`.
 *
 * Verified live that this is actually safe, not just theoretically so: Tcl
 * substitutes an env var's value as a SINGLE literal argv token to `spawn`,
 * even when the value contains characters like `;`, `&&`, or spaces — it is
 * never re-interpreted as further Tcl or shell syntax. A value of
 * `weird name; rm -rf /` was round-tripped byte-for-byte as one literal
 * argument, not executed.
 *
 * `log_user 1` (the default) keeps the spawned process's I/O echoed to
 * expect's own stdout; `interact` hands control to it, relaying our
 * perfectly ordinary stdin/stdout pipes through to the container's tty —
 * confirmed live end-to-end, including a real rejected OAuth code.
 */
export function buildContainerSetupTokenExpectArgs(): string[] {
  return [
    '-c',
    // Size expect's OWN pty right after spawn; `container exec -t` forwards it
    // into the container. Without this the container terminal is 0x0, the CLI
    // falls back to 80 columns, and the ~108-char token is hard-wrapped mid-
    // string — which truncated the saved token in a live run (the signed-in
    // session then failed to authenticate). Verified live: an `stty` run
    // INSIDE the container is reset to 0x0 by `container exec` shortly after
    // start (a race we lose), whereas sizing this host-side pty propagates and
    // sticks (`stty size` inside reads 50 500).
    `log_user 1; spawn ${VM_BINARY} exec -i -t $env(${CT_CONTAINER_NAME_ENV}) $env(${CT_BINARY_PATH_ENV}) setup-token; stty rows 50 columns 500 < $spawn_out(slave,name); interact`,
  ];
}

/** Strips OSC (hyperlinks, titles), CSI (colors, cursor moves), other ESC sequences and CRs so pattern matching sees plain text. */
export function stripAnsi(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r/g, '');
}

/** Env additions carrying `containerName`/`containerBinaryPath` safely into the Tcl script above (never string-interpolated — see that function's doc comment). */
export function buildContainerSetupTokenEnv(
  hostEnv: NodeJS.ProcessEnv,
  containerName: string,
  containerBinaryPath: string,
): NodeJS.ProcessEnv {
  return { ...hostEnv, [CT_CONTAINER_NAME_ENV]: containerName, [CT_BINARY_PATH_ENV]: containerBinaryPath };
}

/** Long-lived Anthropic OAuth tokens are documented as `sk-ant-oat...`. Picks the LAST match so an earlier, unrelated fragment can never win over the real token printed at the end. */
const TOKEN_PREFIX_PATTERN = /sk-ant-oat[0-9]*-[A-Za-z0-9_-]+/g;

/**
 * Extracts the setup-token output's long-lived token. Prefers the documented
 * `sk-ant-oat...` prefix; falls back to the last printed line ONLY if it is
 * shaped like a bare token (no whitespace, no punctuation besides `_`/`-`,
 * long enough not to be a stray short word) — never falls back to guessing
 * from an arbitrary line, which would silently hand back garbage.
 */
export function extractToken(output: string): string | undefined {
  const prefixed = output.match(TOKEN_PREFIX_PATTERN);
  if (prefixed && prefixed.length > 0) return prefixed[prefixed.length - 1];
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1];
  if (lastLine && /^[A-Za-z0-9_-]{20,}$/.test(lastLine)) return lastLine;
  return undefined;
}

/** Content-match redaction (never positional) — same convention as `redactSecretsInArgv` in harnessVmRouting.ts. */
function redactToken(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join('<redacted>');
}

export async function signInToClaudeInContainer(opts: ContainerSignInOptions): Promise<ContainerSignInResult> {
  const timeoutMs = opts.timeoutMs ?? CLAUDE_CONTAINER_SIGN_IN_TIMEOUT_MS;
  const idleMs = opts.idleMsBeforeCodePrompt ?? DEFAULT_IDLE_MS_BEFORE_CODE_PROMPT;

  return new Promise<ContainerSignInResult>((resolve) => {
    let settled = false;
    let buffer = '';
    let urlShown = false;
    let codePromptFired = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let tokenTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    /** `buffer.length` at the moment the code was written — everything after it is the CLI's reaction to the code. */
    let submittedAt = -1;
    let child: ChildLike | undefined;

    const timer = setTimeout(() => {
      finish({ ok: false, error: `Sign-in timed out after ${Math.round(timeoutMs / 60_000) || 1} min.` });
    }, timeoutMs);

    /** Best effort, fire-and-forget: reap the in-container process killing `expect` leaves behind. */
    function cleanupLeftoverProcess(): void {
      if (!child) return;
      try {
        const reaper = opts.spawn(VM_BINARY, buildKillLeftoverSetupTokenArgs(opts.containerName, opts.containerBinaryPath), {
          env: opts.hostEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        reaper.on('error', () => { /* container gone or CLI missing — nothing to reap */ });
      } catch { /* best effort */ }
    }

    function finish(result: ContainerSignInResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (tokenTimer) clearTimeout(tokenTimer);
      if (watchdog) clearTimeout(watchdog);
      try { child?.kill(); } catch { /* already exited — fine */ }
      cleanupLeftoverProcess();
      resolve(result);
    }

    /** Last ~400 chars of readable output, token-redacted — so a stall or failure explains itself instead of a silent spinner. */
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
      const rejected = out.match(/OAuth error:[^\n]*/);
      if (rejected) {
        // The TUI moves the cursor instead of printing newlines, so the "Press
        // Enter to retry." hint lands on the same line — it means nothing in our UI.
        const reason = rejected[0].replace(/\s*Press\s+Enter\s+to\s+retry\.?/i, '').trim();
        finish({ ok: false, error: `${reason} Click “Sign in to Claude” to try again.` });
        return;
      }
      const prefixed = out.match(TOKEN_PREFIX_PATTERN);
      if (prefixed && prefixed.length > 0) {
        // The token arrives in one burst, but give any trailing characters a
        // moment to land before taking the last match. Debounced, so a token
        // still mid-stream keeps extending until output settles.
        if (tokenTimer) clearTimeout(tokenTimer);
        tokenTimer = setTimeout(() => {
          const latest = afterSubmit().match(TOKEN_PREFIX_PATTERN);
          if (latest && latest.length > 0) finish({ ok: true, token: latest[latest.length - 1] });
        }, TOKEN_SETTLE_MS);
      }
    }

    // Debounced "the CLI has gone quiet" signal — reset on every chunk of
    // output, fired only once, and only once the URL has already been seen.
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
            // Text and Enter go as SEPARATE writes. Written together, a long
            // code (~87 chars: `code#state`) arrives as one burst the TUI
            // treats as a paste, and the trailing Enter is swallowed as paste
            // content — the prompt just fills with `*` and never submits
            // (reproduced live; short codes happened to work). A distinct
            // keystroke after the text has landed submits it.
            child?.stdin?.write(code);
            setTimeout(() => {
              if (settled) return;
              try { child?.stdin?.write('\r'); } catch (err) {
                finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
              }
            }, ENTER_DELAY_MS);
            // Never leave the UI on "Verifying code…" indefinitely: if the CLI
            // neither prints a token nor rejects the code, say what it DID print.
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

    let started: ChildLike;
    try {
      started = opts.spawn(
        EXPECT_BINARY,
        buildContainerSetupTokenExpectArgs(),
        { env: buildContainerSetupTokenEnv(opts.hostEnv, opts.containerName, opts.containerBinaryPath), stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (err) {
      clearTimeout(timer);
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    child = started;

    opts.onProgress?.('Waiting for browser sign-in…');

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      if (!urlShown) {
        // Deliberately NOT \S+ — verified live against the real CLI's TUI:
        // it renders the URL as an OSC-8 hyperlink immediately followed by a
        // second, dimmer, width-truncated copy for display, with only
        // control bytes (BEL `\x07` closing the OSC-8 escape, ESC `\x1b`
        // starting the next SGR code) between them, no whitespace. `\S+`
        // treats those control bytes as non-whitespace and happily spans
        // straight through into the second copy, producing one garbled
        // string with raw escape bytes baked in — exactly the string that
        // would go into the "Browser didn't open?" link's `href`, which is
        // the ONLY way to reach the sign-in page here (nothing can
        // auto-open a browser from inside the container). Stopping at the
        // first control byte (0x00-0x1F, 0x7F) keeps the real URL and
        // nothing else.
        const match = buffer.match(/https:\/\/[^\s\x00-\x1f\x7f]+/);
        if (match) {
          urlShown = true;
          opts.onUrl?.(match[0]);
        }
      }
      if (submittedAt >= 0) checkAfterSubmit();
      // Once the code is in, stop re-arming the "waiting for the code" idle
      // check — codePromptFired already guards it, this just avoids churn.
      scheduleIdleCheck();
    };
    started.stdout?.on('data', onData);
    started.stderr?.on('data', onData);

    started.on('error', (err) => {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });

    started.on('close', (code) => {
      // Extract from escape-stripped text: raw TUI output interleaves cursor
      // and color codes that can split a token.
      const clean = stripAnsi(buffer);
      const token = extractToken(clean);
      if (code !== 0 && code !== null) {
        const tail = redactToken(clean.trim().split('\n').slice(-3).join('\n'), token);
        finish({ ok: false, error: tail || `expect exited with code ${code}` });
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

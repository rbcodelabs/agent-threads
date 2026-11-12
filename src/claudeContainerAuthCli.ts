import { CLAUDE_SIGN_IN_TIMEOUT_MS } from './claudeAuthCli';
import { VM_BINARY } from './containerCli';
import { runSetupTokenSession, type SpawnLike } from './setupTokenSession';
import { extractToken, stripAnsi } from './setupTokenParse';

// Moved to the shared modules (the remote-daemon sign-in drives the same TUI); re-exported for existing importers.
export { extractToken, stripAnsi };
export type { SpawnLike };

/**
 * Drives Claude sign-in **inside** the local daemon's container, where the
 * harness runs and there is no host `claude` install to sign in with
 * `claudeAuthCli.ts`'s `claude auth login`.
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

export interface ContainerSignInOptions {
  spawn: SpawnLike;
  /** Host-side env for the `expect`/`container` binaries themselves — see `runnerEnv()` in containerCli.ts. Never the container's own secrets. */
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

/** Ships standard on every macOS install (verified on macOS 26.4.1) — this feature already requires macOS for Apple's `container` runtime, so no PATH resolution or bundling is needed. */
export const EXPECT_BINARY = '/usr/bin/expect';

/**
 * Secret-storage name (see `secretStorageKey`) for the token this sign-in
 * mints. Intentionally NOT `CLAUDE_CODE_OAUTH_TOKEN` and never listed in
 * `secretEnvKeys`: the local daemon controller injects it into the daemon container only.
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

/** Env additions carrying `containerName`/`containerBinaryPath` safely into the Tcl script above (never string-interpolated — see that function's doc comment). */
export function buildContainerSetupTokenEnv(
  hostEnv: NodeJS.ProcessEnv,
  containerName: string,
  containerBinaryPath: string,
): NodeJS.ProcessEnv {
  return { ...hostEnv, [CT_CONTAINER_NAME_ENV]: containerName, [CT_BINARY_PATH_ENV]: containerBinaryPath };
}

export async function signInToClaudeInContainer(opts: ContainerSignInOptions): Promise<ContainerSignInResult> {
  return runSetupTokenSession({
    spawn: opts.spawn,
    command: EXPECT_BINARY,
    args: buildContainerSetupTokenExpectArgs(),
    env: buildContainerSetupTokenEnv(opts.hostEnv, opts.containerName, opts.containerBinaryPath),
    onProgress: opts.onProgress,
    onUrl: opts.onUrl,
    onCodePrompt: opts.onCodePrompt,
    timeoutMs: opts.timeoutMs ?? CLAUDE_CONTAINER_SIGN_IN_TIMEOUT_MS,
    idleMsBeforeCodePrompt: opts.idleMsBeforeCodePrompt,
    // Best effort, fire-and-forget: reap the in-container process killing `expect` leaves behind.
    cleanup: () => {
      const reaper = opts.spawn(VM_BINARY, buildKillLeftoverSetupTokenArgs(opts.containerName, opts.containerBinaryPath), {
        env: opts.hostEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      reaper.on('error', () => { /* container gone or CLI missing - nothing to reap */ });
    },
  });
}

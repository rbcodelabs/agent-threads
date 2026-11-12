/**
 * Claude sign-in on the daemon's own machine (`auth.signin.*`).
 *
 * A remote daemon with a blank Claude login cannot be fixed from the app's host: `claude auth login` there only signs
 * the Mac in. This runs `claude setup-token` HERE, in a pseudo-terminal, hands the OAuth URL to the client, takes the
 * login code the user pastes back, and returns the minted long-lived token to the (admin) client over the same
 * connection. The client keeps it in its keychain and pushes it back as `CLAUDE_CODE_OAUTH_TOKEN` through the
 * ordinary credential channel; nothing about the token is written to disk or to a log here.
 *
 * Rules:
 *   - admin scope only (enforced by `REQUIRED_SCOPE`); the flow belongs to the connection that started it;
 *   - one flow per daemon at a time;
 *   - the flow ends, and any leftover `setup-token` process is killed, on cancel, on timeout and on disconnect;
 *   - the token is never audited or logged: only the outcome is.
 *
 * The pty comes from `expect` (preferred) or `script`; neither is bundled, so a missing one fails with a message that
 * says what to install.
 */
import { accessSync, constants, readdirSync, readFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runSetupTokenSession, type SpawnLike } from '../src/setupTokenSession';
import type { ErrorCode, SigninEvent } from '../src/protocol';

/** Env var names the pty wrapper scripts read; the binary path rides the environment, never the script text. */
export const SIGNIN_CLAUDE_BIN_ENV = 'CT_CLAUDE_BIN';

export type PtyTool = { kind: 'expect' | 'script'; path: string };

export class SigninError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'SigninError';
  }
}

/**
 * Command line that runs `<claude> setup-token` inside a 50x500 pty (wide, so the ~108-character token is not
 * hard-wrapped mid-string) with plain pipes on our side. Fixed text: the binary path is read from the environment.
 */
export function buildSetupTokenPtyCommand(tool: PtyTool): { command: string; args: string[] } {
  if (tool.kind === 'expect') {
    return {
      command: tool.path,
      args: ['-c', `log_user 1; spawn $env(${SIGNIN_CLAUDE_BIN_ENV}) setup-token; stty rows 50 columns 500 < $spawn_out(slave,name); interact`],
    };
  }
  // util-linux `script` (verified with plain pipes on Linux). BSD `script` insists on a real terminal for stdin, so
  // `findPtyTool` never offers it on macOS/FreeBSD, where `expect` ships standard.
  const inner = `stty rows 50 columns 500 2>/dev/null; exec "${SIGNIN_CLAUDE_BIN_ENV}" setup-token`;
  return { command: tool.path, args: ['-q', '-e', '-c', inner, '/dev/null'] };
}

const executable = (p: string): boolean => {
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
};

/** `expect` if installed, else util-linux `script` (not on macOS/FreeBSD, see above); null when neither is. */
export function findPtyTool(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): PtyTool | null {
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), '/usr/bin', '/usr/local/bin', '/bin'];
  const kinds = platform === 'darwin' || platform === 'freebsd' ? (['expect'] as const) : (['expect', 'script'] as const);
  for (const kind of kinds) {
    const found = dirs.map((d) => join(d, kind)).find(executable);
    if (found) return { kind, path: found };
  }
  return null;
}

/**
 * Kill `setup-token` processes left behind (killing the pty wrapper normally hangs them up, but a wedged TUI can
 * linger). Linux `/proc` only; elsewhere the wrapper's own teardown has to suffice. Matches argv ending in
 * `setup-token` whose program is the claude binary (directly or via node), never the wrapper or this process.
 */
export function reapLeftoverSetupTokens(claudeBinary: string, procDir = '/proc', kill: (pid: number) => void = (pid) => process.kill(pid, 'SIGTERM')): number {
  let killed = 0;
  let entries: string[];
  try { entries = readdirSync(procDir); } catch { return 0; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    let argv: string[];
    try { argv = readFileSync(join(procDir, entry, 'cmdline'), 'utf8').split('\0').filter(Boolean); } catch { continue; }
    if (argv.length < 2 || argv[argv.length - 1] !== 'setup-token') continue;
    const program = argv[0];
    const viaNode = basename(program) === 'node' && argv.length >= 3 && (argv[1] === claudeBinary || basename(argv[1]) === 'claude');
    if (program === claudeBinary || basename(program) === 'claude' || viaNode) {
      try { kill(Number(entry)); killed++; } catch { /* already gone */ }
    }
  }
  return killed;
}

export interface SigninManagerDeps {
  spawn: SpawnLike;
  env?: NodeJS.ProcessEnv;
  /** The claude CLI to run, or null when it is not installed. */
  claudeBinary(): string | null;
  /** The pty provider; defaults to `findPtyTool`. */
  ptyTool?(): PtyTool | null;
  /** Reap stragglers; defaults to `reapLeftoverSetupTokens`. */
  reap?(claudeBinary: string): void;
  audit(record: Record<string, unknown>): void;
  timeoutMs?: number;
  idleMsBeforeCodePrompt?: number;
}

interface Flow {
  id: string;
  connId: number;
  abort: AbortController;
  /** Set while the flow waits for the user's code. */
  resolveCode: ((code: string | null) => void) | null;
  /** A code that arrived before the prompt was ready. */
  earlyCode: string | null;
  finished: boolean;
}

export class SigninManager {
  private flow: Flow | null = null;

  constructor(private readonly deps: SigninManagerDeps) {}

  /** A sign-in is running (the daemon should not restart under it). */
  get active(): boolean { return this.flow !== null && !this.flow.finished; }

  /**
   * Begin a flow for `connId`; `emit` receives each step. The first event is delivered on a later turn of the event
   * loop, so the caller's `ack` (with the flow id) is always queued ahead of it.
   */
  start(connId: number, emit: (event: SigninEvent) => void): { flowId: string } {
    if (this.active) throw new SigninError('conflict', 'a Claude sign-in is already in progress on this daemon; finish or cancel it first');
    const claude = this.deps.claudeBinary();
    if (!claude) throw new SigninError('internal', 'the claude CLI is not installed for the daemon user, so it cannot sign in. Install Claude Code on this machine first.');
    const tool = (this.deps.ptyTool ?? (() => findPtyTool(this.deps.env)))();
    if (!tool) throw new SigninError('internal', 'signing in from the app needs `expect` (or `script`) on the daemon machine, and neither was found. Install expect (for example `apt install expect`) and try again, or run `claude setup-token` there yourself.');

    const flow: Flow = { id: randomUUID(), connId, abort: new AbortController(), resolveCode: null, earlyCode: null, finished: false };
    this.flow = flow;
    const { command, args } = buildSetupTokenPtyCommand(tool);
    const send = (event: SigninEvent): void => {
      try { emit(event); } catch { /* the connection is gone; the abort below ends the flow */ }
    };
    queueMicrotask(() => {
      if (flow.finished) return;
      void runSetupTokenSession({
        spawn: this.deps.spawn,
        command,
        args,
        env: { ...(this.deps.env ?? process.env), [SIGNIN_CLAUDE_BIN_ENV]: claude },
        signal: flow.abort.signal,
        ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
        ...(this.deps.idleMsBeforeCodePrompt !== undefined ? { idleMsBeforeCodePrompt: this.deps.idleMsBeforeCodePrompt } : {}),
        onProgress: (text) => send({ kind: 'progress', flowId: flow.id, text }),
        onUrl: (url) => send({ kind: 'url', flowId: flow.id, url }),
        onCodePrompt: () => new Promise<string | null>((resolve) => {
          if (flow.earlyCode !== null) { const c = flow.earlyCode; flow.earlyCode = null; resolve(c); return; }
          flow.resolveCode = resolve;
          send({ kind: 'prompt', flowId: flow.id });
        }),
        cleanup: () => this.reap(claude),
      }).then((result) => {
        flow.finished = true;
        if (this.flow === flow) this.flow = null;
        // Outcome only: the token and any CLI output stay out of the audit trail.
        this.deps.audit({ event: 'signin', flowId: flow.id, outcome: result.ok ? 'ok' : flow.abort.signal.aborted ? 'cancelled' : 'failed' });
        send(result.ok ? { kind: 'token', flowId: flow.id, token: result.token } : { kind: 'error', flowId: flow.id, message: result.error });
      });
    });
    this.deps.audit({ event: 'signin_start', flowId: flow.id });
    return { flowId: flow.id };
  }

  /** The user's login code. Only the connection that started the flow may answer it. */
  code(connId: number, flowId: string, code: string): void {
    const flow = this.owned(connId, flowId);
    const trimmed = code.trim();
    if (!trimmed) throw new SigninError('bad_frame', 'the login code is empty');
    if (flow.resolveCode) {
      const resolve = flow.resolveCode;
      flow.resolveCode = null;
      resolve(trimmed);
    } else {
      flow.earlyCode = trimmed;
    }
  }

  /** Cancel the caller's flow (`flowId` absent) or the named one. Idempotent: no flow is not an error. */
  cancel(connId: number, flowId?: string): void {
    const flow = this.flow;
    if (!flow || flow.finished) return;
    if (flowId !== undefined && flowId !== flow.id) return;
    if (flow.connId !== connId) throw new SigninError('forbidden', 'this sign-in was started by another connection');
    flow.abort.abort();
  }

  /** The connection closed: its flow cannot be answered any more. */
  connectionGone(connId: number): void {
    if (this.flow && !this.flow.finished && this.flow.connId === connId) this.flow.abort.abort();
  }

  dispose(): void {
    this.flow?.abort.abort();
  }

  private owned(connId: number, flowId: string): Flow {
    const flow = this.flow;
    if (!flow || flow.finished || flow.id !== flowId) throw new SigninError('not_found', 'no such sign-in is in progress (it may have timed out or been cancelled)');
    if (flow.connId !== connId) throw new SigninError('forbidden', 'this sign-in was started by another connection');
    return flow;
  }

  private reap(claude: string): void {
    try { (this.deps.reap ?? ((bin) => { reapLeftoverSetupTokens(bin); }))(claude); } catch { /* best effort */ }
  }
}

/**
 * `agent-threads run "<prompt>"` (v0): open an ephemeral session on the daemon, send one prompt,
 * stream the answer, and exit with a code that says how the turn ended.
 *
 *   --detach      send, release the thread, print its id and exit; the turn keeps running on the
 *                 daemon and `agent-threads attach <id>` replays everything from the start.
 *   --unattended  nobody is there to answer: defaults to the `dontAsk` permission mode and fails
 *                 (exit 7) the moment a permission/question/plan request is raised.
 *
 * Without a terminal (and without --json) there is also nobody to ask, so a request fails the run
 * the same way instead of waiting for an hour.
 */
import { randomUUID } from 'node:crypto';
import { fetchWorkspaces, DaemonCommandError, type DaemonClient } from '../../src/remote/DaemonClient';
import type { RemoteSessionSpec, WorkspaceInfo } from '../../src/protocol';
import { terminalFailure, exitForOutcome } from './attach';
import { command, connectDaemon, resolveConnectionSettings, type ConnectionFlags } from './connection';
import { CliError, EXIT, exitCodeFor, messageOf } from './exit';
import { Follower, type AnswerMode } from './follow';
import { cliLine } from './render';
import type { CliRuntime, RawIo } from './runtime';
import { createTerminalPrompter, readJsonCommands } from './terminal';

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions'] as const;

export interface RunArgs extends ConnectionFlags {
  prompt: string;
  cwd?: string;
  permissionMode?: string;
  model?: string;
  thread?: string;
  detach: boolean;
  unattended: boolean;
  json: boolean;
  connectTimeoutMs?: number;
}

/** Where the session starts: the daemon's idea of the right folder, never a guess about its disk. */
export function chooseCwd(opts: { flag?: string; localCwd: string; local: boolean; workspaces: WorkspaceInfo[] | undefined }): { cwd: string } | { error: string } {
  if (opts.flag) return { cwd: opts.flag };
  const ws = opts.workspaces ?? [];
  const inside = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);
  // Same machine: the shell's own folder, if the daemon allows sessions there.
  if (opts.local && (ws.length === 0 || ws.some((w) => inside(w.path, opts.localCwd)))) return { cwd: opts.localCwd };
  const pick = ws.find((w) => w.isDefault) ?? ws.find((w) => !w.readOnly) ?? ws[0];
  if (pick) return { cwd: pick.path };
  return { error: 'no --cwd given and the daemon does not advertise any workspace; pass --cwd <folder on the daemon machine>' };
}

export function permissionModeFor(flag: string | undefined, unattended: boolean): string {
  if (flag !== undefined) {
    if (!(PERMISSION_MODES as readonly string[]).includes(flag)) throw new CliError(`--permission-mode must be one of ${PERMISSION_MODES.join(', ')}`, EXIT.USAGE);
    return flag;
  }
  return unattended ? 'dontAsk' : 'default';
}

export function newRunThreadId(): string {
  return `run-${randomUUID().slice(0, 8)}`;
}

/** `session.send`, retrying while the daemon is at its concurrent-turn limit (it says so with `retryable`). */
async function sendWithRetry(client: DaemonClient, threadId: string, text: string, userMessageUuid: string, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  let delay = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      await client.command('session.send', { threadId, text, userMessageUuid });
      return;
    } catch (err) {
      if (err instanceof DaemonCommandError && err.retryable && attempt < 6) { await sleep(delay); delay = Math.min(delay * 2, 8000); continue; }
      throw err instanceof DaemonCommandError ? new CliError(`session.send: ${err.message}`, exitCodeFor(err)) : err;
    }
  }
}

export async function runRun(args: RunArgs, io: RawIo, rt: CliRuntime): Promise<number> {
  if (!args.prompt.trim()) throw new CliError('run needs a prompt: agent-threads run [options] "<prompt>"', EXIT.USAGE);
  const permissionMode = permissionModeFor(args.permissionMode, args.unattended);
  const settings = resolveConnectionSettings(args, rt.env);
  const client = await connectDaemon(settings, { reconnect: true, connectTimeoutMs: args.connectTimeoutMs, createSocket: rt.createSocket });
  let follower: Follower | undefined;
  let interruptedByUser = false;
  let stopStdin: (() => void) | undefined;
  let prompter: ReturnType<typeof createTerminalPrompter> | undefined;
  let failure: CliError | null = null;
  let sigints = 0;
  let threadId = args.thread ?? newRunThreadId();
  const stopSigint = rt.onInterrupt(() => {
    sigints++;
    interruptedByUser = true;
    if (sigints > 1 || !follower) { follower?.stop('stopped'); return; }
    io.err('[cli] interrupting the turn (Ctrl-C again to leave it running)\n');
    void client.command('session.interrupt', { threadId }).catch(() => follower?.stop('stopped'));
  });
  const offState = client.onState((s) => {
    const f = terminalFailure(s);
    if (f) { failure = f; follower?.stop('failed', f.message); }
  });
  try {
    const workspaces = args.cwd ? undefined : await fetchWorkspaces(client).catch(() => undefined);
    const chosen = chooseCwd({ flag: args.cwd, localCwd: rt.cwd, local: settings.local, workspaces });
    if ('error' in chosen) throw new CliError(chosen.error, EXIT.USAGE);

    const spec: RemoteSessionSpec = {
      harness: 'claude',
      cwd: chosen.cwd,
      permissionMode: permissionMode as RemoteSessionSpec['permissionMode'],
      extraEnvRaw: '',
      ...(args.model ? { model: args.model } : {}),
    };
    const opened = await command<{ lastSeq: number; epoch?: string }>(client, 'session.open', { threadId, spec });
    if (args.json) io.out(`${cliLine('started', { threadId, cwd: chosen.cwd, permissionMode, detach: args.detach })}\n`);
    else io.err(`[cli] thread ${threadId} (cwd ${chosen.cwd}, permission mode ${permissionMode})\n`);

    const messageId = `cli-${randomUUID()}`;
    if (args.detach) {
      await sendWithRetry(client, threadId, args.prompt, messageId);
      await command(client, 'session.detach', { threadId });
      if (args.json) io.out(`${cliLine('detached', { threadId })}\n`);
      else io.out(`${threadId}\n`);
      return EXIT.OK;
    }

    let answer: AnswerMode;
    if (args.unattended) answer = 'deny';
    else if (args.json) answer = 'json';
    else if (rt.stdinIsTTY || rt.prompter) answer = 'terminal';
    else answer = 'deny';
    follower = new Follower({
      client, threadId, afterSeq: opened.lastSeq, epoch: opened.epoch, observe: false, json: args.json, answer,
      prompter: answer === 'terminal' ? (rt.prompter ?? (prompter = createTerminalPrompter(rt.stdin))) : undefined,
      stopOn: 'turn_end',
      io: { out: (t) => io.out(t), err: (t) => io.err(t) },
    });
    follower.start();
    if (answer === 'json') {
      stopStdin = readJsonCommands(rt.stdin, (cmd) => { void follower!.resolve(cmd); },
        (line) => io.out(`${cliLine('command_result', { ok: false, error: `not a JSON object: ${line.slice(0, 80)}` })}\n`),
        () => follower?.setAnswerMode('deny'));
    }
    await Promise.race([follower.attached, follower.finished]);
    await sendWithRetry(client, threadId, args.prompt, messageId);

    const result = await follower.finished;
    if (failure) throw failure;
    // The session is ephemeral: free its claude process. The journal stays for `attach`.
    // (A second Ctrl-C means "leave it running", so that one is only detached from.)
    if (result.outcome !== 'stopped') await client.command('session.close', { threadId }).catch(() => undefined);
    let code: number = exitForOutcome(result.outcome);
    if (result.outcome === 'interrupted' && interruptedByUser) code = EXIT.SIGINT;
    if (result.outcome === 'stopped' && interruptedByUser) code = EXIT.SIGINT;
    if (args.json) io.out(`${cliLine('end', { outcome: result.outcome, exitCode: code, threadId, lastSeq: result.lastSeq, ...(result.message ? { message: result.message } : {}) })}\n`);
    else if (result.message) io.err(`[cli] ${result.message}\n`);
    return code;
  } catch (err) {
    throw err instanceof CliError ? err : new CliError(messageOf(err), exitCodeFor(err));
  } finally {
    stopSigint();
    stopStdin?.();
    prompter?.close();
    offState();
    client.dispose();
  }
}

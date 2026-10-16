/**
 * `agent-threads attach <thread>`: render a thread's live stream, replaying from a cursor first.
 *
 * Read-only unless `--claim`: an observer never takes the thread's read-write seat, so watching a
 * thread from a terminal cannot lock Geode out of it. With `--claim` the CLI takes the seat when it
 * is free (and answers permission/question/plan requests); if another client holds it, the CLI says
 * so and keeps observing.
 */
import type { ConnectionState } from '../../src/remote/DaemonClient';
import { connectDaemon, resolveConnectionSettings, type ConnectionFlags } from './connection';
import { CliError, EXIT, exitCodeFor, messageOf, type ExitCode } from './exit';
import { Follower, type AnswerMode, type FollowOutcome } from './follow';
import { fetchThreads, resolveThreadId } from './list';
import { cliLine } from './render';
import type { CliRuntime, RawIo } from './runtime';
import { createTerminalPrompter, readJsonCommands } from './terminal';

export interface AttachArgs extends ConnectionFlags {
  thread: string | undefined;
  /** First seq to deliver after: a number, or `end` to start at the live edge. */
  from: string | undefined;
  claim: boolean;
  untilIdle: boolean;
  json: boolean;
  connectTimeoutMs?: number;
}

export function exitForOutcome(outcome: FollowOutcome): ExitCode {
  switch (outcome) {
    case 'done': case 'idle': case 'stopped': return EXIT.OK;
    case 'interrupted': return EXIT.INTERRUPTED;
    case 'needs_input': return EXIT.NEEDS_INPUT;
    case 'closed': return EXIT.UNREACHABLE;
    case 'error': case 'failed': return EXIT.FAILED;
  }
}

/** Connection states that end a follow for good (the client retries the rest by itself). */
export function terminalFailure(s: ConnectionState): CliError | null {
  if (s.status === 'unauthorized') return new CliError(`the daemon rejected the token${s.detail ? `: ${s.detail}` : ''}`, EXIT.UNAUTHORIZED);
  if (s.status === 'incompatible') return new CliError(s.detail ?? 'incompatible daemon', EXIT.INCOMPATIBLE);
  return null;
}

export async function runAttach(args: AttachArgs, io: RawIo, rt: CliRuntime): Promise<number> {
  if (!args.thread) throw new CliError('attach needs a thread id (see `agent-threads list`)', EXIT.USAGE);
  let afterSeqFlag: number | 'end' = 0;
  if (args.from !== undefined) {
    if (args.from === 'end') afterSeqFlag = 'end';
    else if (/^\d+$/.test(args.from)) afterSeqFlag = Number(args.from);
    else throw new CliError('--from must be a sequence number or "end"', EXIT.USAGE);
  }
  const settings = resolveConnectionSettings(args, rt.env);
  const client = await connectDaemon(settings, { reconnect: true, connectTimeoutMs: args.connectTimeoutMs, createSocket: rt.createSocket });
  let follower: Follower | undefined;
  const stopSigint = rt.onInterrupt(() => follower?.stop('stopped'));
  let stopStdin: (() => void) | undefined;
  let prompter: ReturnType<typeof createTerminalPrompter> | undefined;
  let failure: CliError | null = null;
  const offState = client.onState((s) => {
    const f = terminalFailure(s);
    if (f) { failure = f; follower?.stop('failed', f.message); }
    else if (s.status === 'reconnecting' || s.status === 'unreachable') {
      if (args.json) io.out(`${cliLine('connection', { status: s.status, detail: s.detail ?? null })}\n`);
      else io.err(`[cli] connection lost (${s.detail ?? s.status}); reconnecting, the stream will resume\n`);
    }
  });
  try {
    const rows = await fetchThreads(client);
    const threadId = resolveThreadId(rows, args.thread);
    const afterSeq = afterSeqFlag === 'end' ? (rows.find((r) => r.threadId === threadId)?.lastSeq ?? 0) : afterSeqFlag;

    let answer: AnswerMode = 'none';
    if (args.claim) answer = args.json ? 'json' : rt.stdinIsTTY || rt.prompter ? 'terminal' : 'none';
    follower = new Follower({
      client, threadId, afterSeq, observe: !args.claim, json: args.json, answer,
      prompter: answer === 'terminal' ? (rt.prompter ?? (prompter = createTerminalPrompter(rt.stdin))) : undefined,
      stopOn: args.untilIdle ? 'idle' : 'never',
      io: { out: (t) => io.out(t), err: (t) => io.err(t) },
    });
    follower.start();
    const info = await Promise.race([follower.attached, follower.finished.then(() => null)]);
    if (info && !args.claim && info.controller) {
      // `observe` was requested but this daemon granted the seat anyway: it predates the flag. Holding the seat
      // would lock the real client out of its own thread, so give it back and say why.
      try { await client.command('session.detach', { threadId }, { timeoutMs: 3000 }); } catch { /* the disconnect releases the seat */ }
      follower.stop('failed', 'daemon too old for read-only attach');
      throw new CliError('this daemon is older than the CLI: it does not support read-only attach and gave this terminal the thread\'s read-write seat. Detached again so the real client is not locked out; upgrade the daemon, or use --claim to take over deliberately.', EXIT.INCOMPATIBLE);
    }
    if (info && args.claim && !info.controller) {
      const msg = 'another client holds this thread\'s read-write seat; staying read-only (detach it there to take over)';
      if (args.json) io.out(`${cliLine('note', { text: msg })}\n`);
      else io.err(`[cli] ${msg}\n`);
    }
    if (answer === 'json' && info?.controller) {
      stopStdin = readJsonCommands(rt.stdin, (cmd) => { void follower!.resolve(cmd); },
        (line) => io.out(`${cliLine('command_result', { ok: false, error: `not a JSON object: ${line.slice(0, 80)}` })}\n`), () => { /* stdin closed: keep following */ });
    }
    const result = await follower.finished;
    follower.ackCurrent();
    if (failure) throw failure;
    const code = result.outcome === 'failed' ? EXIT.FAILED : exitForOutcome(result.outcome);
    if (args.json) io.out(`${cliLine('end', { outcome: result.outcome, exitCode: code, lastSeq: result.lastSeq, ...(result.message ? { message: result.message } : {}) })}\n`);
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

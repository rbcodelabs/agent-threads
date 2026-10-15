/**
 * Replay fidelity (PR 6), against the daemon's REAL in-process server with the scripted harness:
 *
 *   - a turn that finished while the client was away comes back with its ORIGINAL times;
 *   - the saved cursor always covers the transcript it was saved with, and the daemon is acked only
 *     for what is actually persisted;
 *   - a cursor older than the journal's low-water mark yields a `resync` that reconciles (discard the
 *     unfinished stream, keep the finalized transcript, add what was missed once, re-present an open
 *     request once);
 *   - the journal on disk shrinks after an ack and its sidecar stays truthful across a restart.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { HarnessSessionOptions } from '../../src/HarnessSession';
import { CALLBACK_DISPOSITION } from '../../src/protocol';
import { DaemonClient, type WebSocketFactory } from '../../src/remote/DaemonClient';
import { DaemonRegistry } from '../../src/remote/DaemonRegistry';
import { RemoteHarnessSession } from '../../src/remote/RemoteHarnessSession';
import { saveThenAck } from '../../src/remote/persistAck';
import { ThreadManager, type ThreadEvent } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS, type RemoteDaemonConfig, type Thread } from '../../src/types';
import { fakeTokenText } from '../../daemon/fakeHarness';
import { startKillableProxy } from '../helpers/killableProxy';
import { TestClient, startTestDaemon, sleep, SPEC, type TestDaemon } from '../helpers/daemonTestClient';

const wsFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as ReturnType<WebSocketFactory>;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = 1_800_000_000_000; // the daemon's fake wall clock at the start of the story

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function until(pred: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const tokensText = (n: number, size = 0): string => Array.from({ length: n }, (_, i) => fakeTokenText(i, size)).join('');

/** A "Geode process": manager + registry. Several of these over one daemon model quit/reopen. */
function geode(td: TestDaemon, clock: () => number) {
  const cfg: RemoteDaemonConfig = { id: 'box', name: 'my-server', url: td.daemon.url, tokenSecretName: 'AT_TOKEN' };
  const registry = new DaemonRegistry({ getDaemons: () => [cfg], getToken: () => td.adminToken, createSocket: wsFactory, clientVersion: '0.62.2' });
  cleanups.push(() => registry.disposeAll());
  const manager = new ThreadManager({ ...DEFAULT_SETTINGS, remoteDaemons: [cfg] });
  manager.remoteDaemons = registry;
  manager.clock = clock;
  const events: ThreadEvent[] = [];
  manager.subscribe((_id, e) => events.push(e));
  return { manager, registry, events, cfg };
}

const clone = (t: Thread): Thread => JSON.parse(JSON.stringify(t)) as Thread;
const assistantOf = (t: Thread) => t.messages.filter((m) => m.role === 'assistant');
const journalOf = (td: TestDaemon, id: string) => td.daemon.threads.journalFor(id)!;

describe('original timestamps survive a replay', () => {
  it('a turn that finishes while the client is away keeps the daemon time of its events, minutes later', async () => {
    let wall = T0;
    const td = await startTestDaemon({ now: () => wall });
    cleanups.push(() => td.cleanup());
    const first = geode(td, () => T0 + 1000);
    const thread = first.manager.createRemoteThread('away', { daemonId: 'box', remoteCwd: '/srv/workspaces/x', clientId: 'c' });
    await first.manager.sendMessage(thread.id, '/tokens 40 burst=1 delay=15');
    await until(() => journalOf(td, thread.id).lastSeq > 8, 'streaming to start');
    // Quit Geode mid-turn: the client is gone; the daemon keeps going.
    await first.manager.gracefulShutdown(500);
    const persisted = clone(thread);
    first.registry.disposeAll();
    expect(persisted.messages.filter((m) => m.role === 'assistant')).toHaveLength(0);

    await until(() => !td.daemon.threads.list().find((t) => t.threadId === thread.id)!.turnInFlight, 'the turn to finish on the daemon');
    // The message was journaled at T0. Ten minutes pass before Geode is reopened.
    wall = T0 + 10 * MINUTE;
    const REOPEN = T0 + 10 * MINUTE + 5000;
    const second = geode(td, () => REOPEN);
    second.manager.loadThreads([persisted]);
    expect(second.manager.resumeRemoteTurns()).toEqual([thread.id]);
    await until(() => persisted.status === 'waiting' && assistantOf(persisted).length > 0, 'the transcript to complete');

    const assistant = assistantOf(persisted);
    expect(assistant).toHaveLength(1); // nothing duplicated
    expect(assistant[0].content).toBe(tokensText(40));
    expect(assistant[0].timestamp).toBe(T0); // the original time, not "10 minutes ago" turned "just now"
    expect(persisted.updatedAt).toBeLessThanOrEqual(REOPEN);
    expect(persisted.remote!.turnPending).toBeUndefined();

    // A live message after the replay is stamped with THIS machine's clock, not the daemon's.
    wall = T0 + 20 * MINUTE;
    await second.manager.sendMessage(thread.id, '/tokens 3 burst=3');
    await until(() => assistantOf(persisted).length === 2, 'the live reply');
    expect(assistantOf(persisted)[1].timestamp).toBe(REOPEN);
    second.manager.destroy();
  });
});

describe('the saved cursor covers the saved transcript', () => {
  it('a snapshot taken inside the message callback (what the host does) does not replay that message after a quit', async () => {
    const td = await startTestDaemon();
    cleanups.push(() => td.cleanup());
    const first = geode(td, () => Date.now());
    const thread = first.manager.createRemoteThread('snap', { daemonId: 'box', remoteCwd: '/srv/workspaces/x', clientId: 'c' });
    let snapshot: Thread | null = null;
    first.manager.subscribe((_id, e) => {
      // Exactly what main.ts does on a message: save right now, from inside the event.
      if (e.type === 'message' && !snapshot) snapshot = clone(thread);
    });
    await first.manager.sendMessage(thread.id, '/tokens 20 burst=2 delay=3');
    await until(() => snapshot !== null, 'the message event');
    await first.manager.gracefulShutdown(500); // "final events arrive during shutdown"
    first.registry.disposeAll();
    const saved = snapshot as unknown as Thread;
    expect(assistantOf(saved)).toHaveLength(1);
    expect(saved.remote!.lastSeq).toBeGreaterThanOrEqual(journalOf(td, thread.id).lastSeq - 4); // covers the message, at most the tail events behind

    await until(() => !td.daemon.threads.list().find((t) => t.threadId === thread.id)!.turnInFlight, 'the turn to finish');
    const second = geode(td, () => Date.now());
    second.manager.loadThreads([saved]);
    saved.remote!.turnPending = true; // quit before the post-message save landed
    second.manager.resumeRemoteTurns();
    await until(() => saved.status === 'waiting', 'the resumed turn to settle');
    expect(assistantOf(saved)).toHaveLength(1);
    expect(assistantOf(saved)[0].content).toBe(tokensText(20));
    second.manager.destroy();
  });

  it('acks the daemon only after the save finishes, and only up to what that save covered', async () => {
    const td = await startTestDaemon();
    cleanups.push(() => td.cleanup());
    const g = geode(td, () => Date.now());
    const thread = g.manager.createRemoteThread('ack', { daemonId: 'box', remoteCwd: '/srv/workspaces/x', clientId: 'c' });
    await g.manager.sendMessage(thread.id, '/tokens 10 burst=5');
    await until(() => thread.status === 'waiting' && assistantOf(thread).length === 1, 'turn');
    const journal = journalOf(td, thread.id);
    expect(journal.ackedSeq).toBe(0); // nothing acks on its own

    let finishSave!: () => void;
    const slowSave = new Promise<void>((resolve) => { finishSave = resolve; });
    const covered = thread.remote!.lastSeq;
    const acked = saveThenAck(g.manager, thread.id, () => slowSave);
    // The cursor moves on while the write is in flight (a second turn lands).
    await g.manager.sendMessage(thread.id, '/tokens 4 burst=4');
    await until(() => assistantOf(thread).length === 2, 'second turn');
    expect(thread.remote!.lastSeq).toBeGreaterThan(covered);
    await sleep(150);
    expect(journal.ackedSeq).toBe(0); // still writing: no ack

    finishSave();
    await acked;
    await until(() => journal.ackedSeq > 0, 'the ack');
    expect(journal.ackedSeq).toBe(covered); // not the live cursor
    g.manager.destroy();
  });

  it('a failed save acks nothing', async () => {
    const td = await startTestDaemon();
    cleanups.push(() => td.cleanup());
    const g = geode(td, () => Date.now());
    const thread = g.manager.createRemoteThread('nack', { daemonId: 'box', remoteCwd: '/srv/workspaces/x', clientId: 'c' });
    await g.manager.sendMessage(thread.id, '/tokens 5 burst=5');
    await until(() => thread.status === 'waiting' && assistantOf(thread).length === 1, 'turn');
    await expect(saveThenAck(g.manager, thread.id, () => Promise.reject(new Error('disk full')))).rejects.toThrow('disk full');
    await sleep(150);
    expect(journalOf(td, thread.id).ackedSeq).toBe(0);
    g.manager.destroy();
  });
});

describe('resync after a forced low-water gap', () => {
  it('reconciles the transcript: keeps what it has, adds what it missed once, at the original times', async () => {
    let wall = T0;
    // Small cap so a later, bigger turn evicts the history this client's cursor points into.
    const td = await startTestDaemon({ now: () => wall, journalLimits: { maxBytes: 9000 } });
    cleanups.push(() => td.cleanup());
    const first = geode(td, () => T0 + 1000);
    const thread = first.manager.createRemoteThread('gap', { daemonId: 'box', remoteCwd: '/srv/workspaces/x', clientId: 'c' });
    await first.manager.sendMessage(thread.id, '/tokens 30 burst=1 delay=10');
    await until(() => journalOf(td, thread.id).lastSeq > 8, 'streaming');
    await first.manager.gracefulShutdown(500);
    const persisted = clone(thread);
    first.registry.disposeAll();
    const cursor = persisted.remote!.lastSeq;
    await until(() => !td.daemon.threads.list().find((t) => t.threadId === thread.id)!.turnInFlight, 'turn 2 to finish');

    // While away, another client runs a big turn an hour later; the cap evicts past our cursor.
    wall = T0 + HOUR;
    const other = await TestClient.connect(td.daemon.url, td.adminToken);
    await other.cmd('attach', { ch: `t:${thread.id}`, afterSeq: journalOf(td, thread.id).lastSeq });
    const sent = await other.cmd('session.send', { threadId: thread.id, text: '/tokens 120 size=200', userMessageUuid: 'other-1' });
    expect(sent.type).toBe('ack');
    await until(() => !td.daemon.threads.list().find((t) => t.threadId === thread.id)!.turnInFlight && journalOf(td, thread.id).lastSeq > cursor + 100, 'the big turn');
    await other.close();
    expect(journalOf(td, thread.id).lowWater).toBeGreaterThan(cursor); // the forced gap

    wall = T0 + 3 * HOUR;
    const REOPEN = T0 + 3 * HOUR + 1000;
    const second = geode(td, () => REOPEN);
    second.manager.loadThreads([persisted]);
    expect(second.manager.resumeRemoteTurns()).toEqual([thread.id]);
    await until(() => persisted.status === 'waiting' && assistantOf(persisted).length >= 2, 'the resynced transcript');
    await sleep(100);

    const assistant = assistantOf(persisted);
    expect(assistant.map((m) => m.content)).toEqual([tokensText(30), tokensText(120, 200)]); // each exactly once, in order
    expect(assistant.map((m) => m.timestamp)).toEqual([T0, T0 + HOUR]);
    expect(persisted.messages[0]).toMatchObject({ role: 'user', content: '/tokens 30 burst=1 delay=10' });
    expect(second.events.filter((e) => e.type === 'stream_reset')).toHaveLength(1);
    expect(persisted.remote!.turnPending).toBeUndefined();
    expect(persisted.lastError).toBeUndefined();

    // And it continues live afterwards, with nothing duplicated or lost.
    await second.manager.sendMessage(thread.id, 'live-after-resync');
    await until(() => assistantOf(persisted).length === 3, 'a live turn after the resync');
    expect(assistantOf(persisted)[2].content).toContain('live-after-resync');
    expect(assistantOf(persisted)[2].timestamp).toBe(REOPEN);
    expect(persisted.messages.filter((m) => m.role === 'assistant')).toHaveLength(3);
    second.manager.destroy();
  });
});

// ── session-level resync: open requests and the streaming buffer ───────────────

function recorder() {
  const r = {
    tokens: [] as string[], messages: [] as string[], resets: 0, errors: [] as Error[], interrupted: 0, done: 0,
    prompts: [] as Array<{ answer(allow: boolean): void }>,
    callbacks: {} as SessionCallbacks,
  };
  const cb: Record<string, unknown> = {};
  for (const name of Object.keys(CALLBACK_DISPOSITION)) cb[name] = () => undefined;
  r.callbacks = {
    ...cb,
    onToken: (t: string) => { r.tokens.push(t); },
    onMessage: (c: string) => { r.messages.push(c); },
    onStreamReset: () => { r.resets++; r.tokens.length = 0; },
    onError: (e: Error) => { r.errors.push(e); },
    onInterrupted: () => { r.interrupted++; },
    onDone: () => { r.done++; },
    onPermissionRequest: () => new Promise<boolean>((resolve) => { r.prompts.push({ answer: resolve }); }),
    onAskUserQuestion: () => new Promise(() => undefined),
  } as unknown as SessionCallbacks;
  return r;
}
const opts = (r: ReturnType<typeof recorder>): HarnessSessionOptions => ({ cwd: '/srv/workspaces/x', permissionMode: 'default', extraEnvRaw: '', callbacks: r.callbacks });
const remoteThread = (id: string, lastSeq = 0): Thread => ({
  id, title: id, cwd: '/srv/workspaces/x', messages: [], createdAt: 0, updatedAt: 0, status: 'waiting', agentHarness: 'claude',
  remote: { daemonId: 'd1', ownership: 'client', remoteCwd: '/srv/workspaces/x', lastSeq, ownerClientId: 'geode-test' },
} as Thread);
const mkClient = (url: string, token: string, backoffMs: readonly number[] = [20, 40, 80]): DaemonClient => {
  const c = new DaemonClient({ url, getToken: () => token, createSocket: wsFactory, clientVersion: '0.62.2', backoffMs, ackDebounceMs: 20, idleProbeMs: 60_000 });
  cleanups.push(() => c.dispose());
  return c;
};
/** Fill a journal with filler events so the byte cap evicts everything before them. */
function flood(td: TestDaemon, id: string, n = 40): void {
  for (let i = 0; i < n; i++) journalOf(td, id).append({ name: 'onNotification', args: ['x'.repeat(400), 'low'] }, Date.now());
}

describe('resync and open requests', () => {
  it('finishes a turn that ended while the client was cut off: the missed message arrives once and the turn is closed', async () => {
    const td = await startTestDaemon({ journalLimits: { maxBytes: 6000 } });
    cleanups.push(() => td.cleanup());
    const proxy = await startKillableProxy('127.0.0.1', td.daemon.port);
    cleanups.push(() => proxy.close());
    const thread = remoteThread('unseen');
    // A long reconnect backoff: the client stays away while the turn ends and the history moves on.
    const s = new RemoteHarnessSession(mkClient(`ws://127.0.0.1:${proxy.port}/v1/ws`, td.adminToken, [1500]), thread);
    const r = recorder();
    await s.start(opts(r));
    s.send('/tokens 40 burst=1 delay=8');
    await until(() => r.tokens.length >= 5, 'some streaming');
    proxy.killAll();
    await until(() => !td.daemon.threads.list().find((t) => t.threadId === 'unseen')!.turnInFlight, 'the turn to finish on the daemon');
    flood(td, 'unseen');

    await until(() => r.done >= 1, 'the turn to be closed after the resync');
    expect(r.messages).toEqual([tokensText(40)]); // once, complete
    expect(r.resets).toBe(1);
    expect(r.errors).toHaveLength(0);
    expect(s.turnInFlight).toBe(false);
    s.close();
  });

  it('re-presents an open permission request once to a fresh process, and it stays answerable', async () => {
    const td = await startTestDaemon({ journalLimits: { maxBytes: 6000 } });
    cleanups.push(() => td.cleanup());
    const thread = remoteThread('perm-fresh');
    const a = new RemoteHarnessSession(mkClient(td.daemon.url, td.adminToken), thread);
    const ra = recorder();
    await a.start(opts(ra));
    a.send('/permission');
    await until(() => ra.prompts.length === 1, 'the first prompt');
    a.detach(); // quit
    flood(td, thread.id);
    expect(journalOf(td, thread.id).lowWater).toBeGreaterThan(thread.remote!.lastSeq);

    const reopened = remoteThread('perm-fresh', thread.remote!.lastSeq);
    reopened.remote!.turnPending = true;
    const b = new RemoteHarnessSession(mkClient(td.daemon.url, td.adminToken), reopened);
    const rb = recorder();
    await b.start(opts(rb), { attachOnly: true });
    await until(() => rb.prompts.length >= 1, 'the prompt to be re-presented');
    await sleep(150);
    expect(rb.prompts).toHaveLength(1); // once
    expect(rb.resets).toBe(1);
    rb.prompts[0].answer(true);
    await until(() => rb.messages.length === 1, 'the turn to finish after the answer');
    expect(rb.messages[0]).toContain('permission resolved');
    b.close();
  });

  it('a prompt the user is already looking at is not shown a second time by a resync', async () => {
    const td = await startTestDaemon({ journalLimits: { maxBytes: 6000 } });
    cleanups.push(() => td.cleanup());
    const proxy = await startKillableProxy('127.0.0.1', td.daemon.port);
    cleanups.push(() => proxy.close());
    const thread = remoteThread('perm-live');
    const s = new RemoteHarnessSession(mkClient(`ws://127.0.0.1:${proxy.port}/v1/ws`, td.adminToken), thread);
    const r = recorder();
    await s.start(opts(r));
    s.send('/permission');
    await until(() => r.prompts.length === 1, 'the prompt');

    proxy.killAll();
    flood(td, thread.id);
    await until(() => r.resets === 1, 'the resync after reconnecting');
    expect(r.prompts).toHaveLength(1); // still the one on screen
    r.prompts[0].answer(false);
    await until(() => r.messages.length === 1, 'the turn to finish');
    s.close();
  });

  it('withdraws a prompt the daemon no longer has open', async () => {
    const td = await startTestDaemon({ journalLimits: { maxBytes: 6000 } });
    cleanups.push(() => td.cleanup());
    const proxy = await startKillableProxy('127.0.0.1', td.daemon.port);
    cleanups.push(() => proxy.close());
    const thread = remoteThread('perm-gone');
    const s = new RemoteHarnessSession(mkClient(`ws://127.0.0.1:${proxy.port}/v1/ws`, td.adminToken), thread);
    const r = recorder();
    await s.start(opts(r));
    s.send('/permission');
    await until(() => r.prompts.length === 1, 'the prompt');
    proxy.killAll();
    // Another client answers while we are cut off; then the history moves past our cursor.
    const other = await TestClient.connect(td.daemon.url, td.adminToken);
    await other.cmd('attach', { ch: `t:${thread.id}`, afterSeq: journalOf(td, thread.id).lastSeq });
    const open = journalOf(td, thread.id).checkpoint().openRequests[0].event.args as { requestId: string };
    await other.cmd('resolve.permission', { threadId: thread.id, requestId: open.requestId, allow: true });
    await other.close();
    flood(td, thread.id);
    await until(() => r.resets === 1, 'the resync');
    expect(s.hasPendingPermission).toBe(false); // withdrawn locally, not left dangling
    s.close();
  });
});

// ── the journal on disk ──────────────────────────────────────────────────────

describe('journal on disk', () => {
  it('shrinks after the plugin persists and acks; the sidecar and a restarted daemon agree', async () => {
    const td = await startTestDaemon();
    cleanups.push(() => td.cleanup());
    const g = geode(td, () => Date.now());
    const thread = g.manager.createRemoteThread('disk', { daemonId: 'box', remoteCwd: '/srv/workspaces/x', clientId: 'c' });
    await g.manager.sendMessage(thread.id, '/tokens 300 size=200 burst=50');
    await until(() => thread.status === 'waiting' && assistantOf(thread).length === 1, 'the turn');
    const file = join(td.dataDir, 'journal', `${thread.id}.ndjson`);
    await sleep(100);
    const before = statSync(file).size;
    expect(before).toBeGreaterThan(60_000);

    await saveThenAck(g.manager, thread.id, async () => { /* persisted */ });
    const journal = journalOf(td, thread.id);
    await until(() => statSync(file).size < before * 0.5, 'the file to shrink', 4000);
    const after = statSync(file).size;
    const lastSeq = journal.lastSeq;
    const size = journal.size;
    expect(journal.ackedSeq).toBe(thread.remote!.lastSeq);

    // Sidecar is truthful, and agrees with the file.
    const idx = JSON.parse(readFileSync(join(td.dataDir, 'journal', `${thread.id}.idx`), 'utf8')) as { lowWater: number; lastSeq: number; ackedSeq: number };
    expect(idx).toMatchObject({ lowWater: 0, lastSeq, ackedSeq: journal.ackedSeq });
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { seq: number; event: { name: string } });
    expect(lines).toHaveLength(size);
    expect(lines.some((l) => l.event.name === 'onToken')).toBe(false);
    expect(lines.at(-1)!.seq).toBe(lastSeq);
    g.manager.destroy();
    g.registry.disposeAll();

    // Restart the daemon on the same data directory.
    await td.daemon.stop();
    const td2 = await startTestDaemon({ dataDir: td.dataDir });
    cleanups.push(() => td2.cleanup());
    const j2 = td2.daemon.threads.journalFor(thread.id)!;
    expect(j2).not.toBeNull();
    expect({ lastSeq: j2.lastSeq, lowWater: j2.lowWater, ackedSeq: j2.ackedSeq, size: j2.size }).toEqual({ lastSeq, lowWater: 0, ackedSeq: journal.ackedSeq, size });
    expect(statSync(file).size).toBe(after);

    // A client with an old cursor is served from the compacted file: messages, no tokens, in order, no duplicates.
    const c = await TestClient.connect(td2.daemon.url, td2.adminToken);
    await c.cmd('attach', { ch: `t:${thread.id}`, afterSeq: 0 });
    await sleep(100);
    const seen = c.events();
    expect(seen.map((e) => e.seq)).toEqual(lines.map((l) => l.seq));
    expect(seen.every((e) => e.replay === true)).toBe(true); // backlog is flagged so the client keeps original times
    // Seq is never reused after the restart.
    await c.cmd('session.open', { threadId: thread.id, spec: SPEC });
    await c.cmd('session.send', { threadId: thread.id, text: '/tokens 2 burst=2', userMessageUuid: 'u2' });
    const live = await c.waitFor((f) => f.type === 'event' && f.name === 'onMessage' && f.seq > lastSeq, 5000, 'a live message after restart');
    expect(live.seq).toBeGreaterThan(lastSeq);
    expect(live.replay).toBeUndefined();
    await c.close();
  });

  it('honours the TTL: entries older than the cap are dropped and a stale cursor resyncs', async () => {
    let wall = T0;
    const td = await startTestDaemon({ now: () => wall, journalLimits: { maxAgeMs: 7 * 24 * HOUR } });
    cleanups.push(() => td.cleanup());
    const c = await TestClient.connect(td.daemon.url, td.adminToken);
    await c.cmd('session.open', { threadId: 'ttl', spec: SPEC });
    await c.cmd('attach', { ch: 't:ttl', afterSeq: 0 });
    await c.cmd('session.send', { threadId: 'ttl', text: '/tokens 20 burst=20', userMessageUuid: 'u' });
    await c.waitFor((f) => f.type === 'event' && f.name === 'onDone', 5000, 'done');
    await sleep(80);
    const journal = journalOf(td, 'ttl');
    const file = join(td.dataDir, 'journal', 'ttl.ndjson');
    const before = statSync(file).size;

    wall = T0 + 6 * 24 * HOUR;
    td.daemon.threads.compactAll();
    expect(journal.lowWater).toBe(0); // inside the TTL: nothing goes

    wall = T0 + 8 * 24 * HOUR;
    td.daemon.threads.compactAll();
    expect(journal.lowWater).toBeGreaterThan(0);
    expect(statSync(file).size).toBeLessThan(before);
    await c.close();

    const d = await TestClient.connect(td.daemon.url, td.adminToken);
    const attach = await d.cmd('attach', { ch: 't:ttl', afterSeq: 1 });
    expect(attach.result).toMatchObject({ resync: true });
    await d.close();
  });

  it('honours the size cap: the file never grows past the cap by more than one entry', async () => {
    const td = await startTestDaemon({ journalLimits: { maxBytes: 20_000 } });
    cleanups.push(() => td.cleanup());
    const c = await TestClient.connect(td.daemon.url, td.adminToken);
    await c.cmd('session.open', { threadId: 'cap', spec: SPEC });
    await c.cmd('session.send', { threadId: 'cap', text: '/tokens 400 size=200 burst=50', userMessageUuid: 'u' });
    await until(() => !td.daemon.threads.list().find((t) => t.threadId === 'cap')!.turnInFlight && journalOf(td, 'cap').lastSeq > 400, 'the turn');
    await sleep(100);
    expect(journalOf(td, 'cap').lowWater).toBeGreaterThan(0);
    expect(statSync(join(td.dataDir, 'journal', 'cap.ndjson')).size).toBeLessThan(20_000 + 2000);
    await c.close();
  });
});

const freePort = () => new Promise<number>((resolve) => { const sv = net.createServer(); sv.listen(0, '127.0.0.1', () => { const p = (sv.address() as net.AddressInfo).port; sv.close(() => resolve(p)); }); });

describe('daemon killed mid-turn (seqs reused after the crash)', () => {
  it('the live client still sees daemon_restarted + interrupted, not a silent duplicate-drop', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'at-crash-'));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const port = await freePort();
    // A slow journal flush: the tokens the client sees live are NOT on disk when the daemon dies.
    const td1 = await startTestDaemon({ dataDir, config: { port }, journalFlushMs: 60_000 });
    const thread = remoteThread('crash');
    const session = new RemoteHarnessSession(mkClient(td1.daemon.url, td1.adminToken), thread);
    const r = recorder();
    await session.start(opts(r));
    session.send('/tokens 400 burst=1 delay=3');
    await until(() => r.tokens.length >= 30, 'tokens to stream');
    const applied = thread.remote!.lastSeq;
    const seenLive = journalOf(td1, 'crash').lastSeq;
    expect(seenLive).toBeGreaterThan(20);
    await td1.daemon.crash(); // kill -9: unflushed journal data is gone

    const td2 = await startTestDaemon({ dataDir, config: { port } });
    cleanups.push(() => td2.cleanup());
    const recoveredAt = journalOf(td2, 'crash');
    expect(td2.daemon.recovered).toContain('crash');
    expect(recoveredAt.lastSeq).toBeLessThan(seenLive); // the daemon really lost what the client had applied

    await until(() => r.interrupted >= 1, 'the restart to reach the client');
    expect(r.errors.map((e) => e.name)).toContain('daemon_restarted');
    expect(r.resets).toBeGreaterThanOrEqual(1); // the half-streamed text was dropped
    expect(session.turnInFlight).toBe(false);
    // The persisted cursor was lowered with the stream (it only ever moves forward otherwise) and now tracks the new history.
    await until(() => thread.remote!.lastSeq === journalOf(td2, 'crash').lastSeq, 'the cursor to follow the new history');
    expect(applied).toBeLessThanOrEqual(seenLive);
    session.close();
  });

  it('a fresh process (persisted epoch, conservative cursor) after the same crash also ends the turn', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'at-crash2-'));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const port = await freePort();
    const td1 = await startTestDaemon({ dataDir, config: { port }, journalFlushMs: 60_000 });
    const thread = remoteThread('crash2');
    const a = new RemoteHarnessSession(mkClient(td1.daemon.url, td1.adminToken), thread);
    const ra = recorder();
    await a.start(opts(ra));
    a.send('/tokens 400 burst=1 delay=3');
    await until(() => ra.tokens.length >= 30, 'tokens');
    a.detach();
    // Persist as the host would, with a cursor ahead of what the crash will leave on disk.
    const saved = remoteThread('crash2', journalOf(td1, 'crash2').lastSeq);
    saved.remote!.epoch = td1.daemon.epoch;
    saved.remote!.turnPending = true;
    await td1.daemon.crash();
    const td2 = await startTestDaemon({ dataDir, config: { port } });
    cleanups.push(() => td2.cleanup());

    const b = new RemoteHarnessSession(mkClient(td2.daemon.url, td2.adminToken), saved);
    const rb = recorder();
    await b.start(opts(rb), { attachOnly: true });
    await until(() => rb.interrupted >= 1, 'the restart notice');
    expect(rb.errors.map((e) => e.name)).toContain('daemon_restarted');
    expect(saved.remote!.lastSeq).toBeLessThanOrEqual(journalOf(td2, 'crash2').lastSeq);
    b.close();
  });
});

describe('detach', () => {
  it('an attach-only session releases its seat and subscription on detach, so another client can take over', async () => {
    const td = await startTestDaemon();
    cleanups.push(() => td.cleanup());
    const thread = remoteThread('seat');
    const opener = new RemoteHarnessSession(mkClient(td.daemon.url, td.adminToken), thread);
    await opener.start(opts(recorder()));
    opener.detach();

    // Re-attach only (no session.open): this claims the seat for this connection.
    const reattached = remoteThread('seat', 0);
    reattached.remote!.turnPending = true;
    const b = new RemoteHarnessSession(mkClient(td.daemon.url, td.adminToken), reattached);
    await b.start(opts(recorder()), { attachOnly: true });
    await sleep(100);
    // A different token (so the seat is not simply re-claimed by the same one) is refused while b holds it...
    const other = td.daemon.tokens.create('other', 'admin').token;
    const c1 = await TestClient.connect(td.daemon.url, other);
    const refused = await c1.cmd('session.open', { threadId: 'seat', spec: SPEC });
    expect(refused).toMatchObject({ type: 'err', code: 'conflict' });
    // ...and accepted after b detaches without ever having opened the session.
    b.detach();
    await sleep(200);
    const accepted = await c1.cmd('session.open', { threadId: 'seat', spec: SPEC });
    expect(accepted.type).toBe('ack');
    await c1.close();
  });
});

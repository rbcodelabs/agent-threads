/**
 * DaemonClient + RemoteHarnessSession against the daemon's REAL in-process
 * server (fake harness behind it), over real sockets, including a TCP proxy
 * that cuts the connection mid-turn.
 */
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { HarnessSessionOptions } from '../../src/HarnessSession';
import { DaemonClient, type WebSocketFactory } from '../../src/remote/DaemonClient';
import { RemoteHarnessSession } from '../../src/remote/RemoteHarnessSession';
import type { Thread } from '../../src/types';
import { fakeTokenText } from '../../daemon/fakeHarness';
import { CALLBACK_DISPOSITION } from '../../src/protocol';
import { startKillableProxy, type KillableProxy } from '../helpers/killableProxy';
import { TestClient, startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';

const wsFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as ReturnType<WebSocketFactory>;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function daemon(): Promise<TestDaemon> {
  const td = await startTestDaemon();
  cleanups.push(() => td.cleanup());
  return td;
}

function client(url: string, token: string, extra: Partial<ConstructorParameters<typeof DaemonClient>[0]> = {}): DaemonClient {
  const c = new DaemonClient({
    url, getToken: () => token, createSocket: wsFactory, clientVersion: '0.62.2',
    backoffMs: [20, 40, 80], ackDebounceMs: 20, idleProbeMs: 60_000, ...extra,
  });
  cleanups.push(() => c.dispose());
  return c;
}

function remoteThread(id: string, lastSeq = 0): Thread {
  return {
    id, title: id, cwd: '/srv/workspaces/x', messages: [], createdAt: 0, updatedAt: 0, status: 'waiting', agentHarness: 'claude',
    remote: { daemonId: 'd1', ownership: 'client', remoteCwd: '/srv/workspaces/x', lastSeq, ownerClientId: 'geode-test' },
  } as Thread;
}

interface Recorder {
  calls: Array<{ name: string; args: unknown[] }>;
  tokens: string[];
  messages: string[];
  callbacks: SessionCallbacks;
  /** Answers handed to permission prompts, in order; resolved by the test. */
  permission: { prompts: Array<{ toolName: string; detail: string; answer(allow: boolean): void }> };
  onToken?: (n: number) => void;
}

function recorder(): Recorder {
  const r: Recorder = { calls: [], tokens: [], messages: [], callbacks: {} as SessionCallbacks, permission: { prompts: [] } };
  const rec = (name: string) => (...args: unknown[]) => { r.calls.push({ name, args }); };
  const cb: Record<string, unknown> = {};
  for (const name of Object.keys(CALLBACK_DISPOSITION)) cb[name] = rec(name);
  r.callbacks = {
    ...cb,
    onToken: (text: string) => { r.tokens.push(text); r.calls.push({ name: 'onToken', args: [text] }); r.onToken?.(r.tokens.length); },
    onMessage: (content: string, toolCalls: unknown[]) => { r.messages.push(content); r.calls.push({ name: 'onMessage', args: [content, toolCalls] }); },
    onPermissionRequest: (toolName: string, detail: string) => new Promise<boolean>((resolve) => {
      r.calls.push({ name: 'onPermissionRequest', args: [toolName, detail] });
      r.permission.prompts.push({ toolName, detail, answer: resolve });
    }),
    onAskUserQuestion: () => new Promise(() => undefined),
  } as unknown as SessionCallbacks;
  return r;
}

const optionsFor = (r: Recorder): HarnessSessionOptions => ({ cwd: '/srv/workspaces/x', permissionMode: 'default', extraEnvRaw: '', callbacks: r.callbacks });
const names = (r: Recorder): string[] => r.calls.map((c) => c.name);
async function until(pred: () => boolean, what: string, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const expectedTokens = (n: number): string[] => Array.from({ length: n }, (_, i) => fakeTokenText(i));

describe('RemoteHarnessSession streaming', () => {
  it('turns daemon events into ordered callbacks and keeps the getters in step', async () => {
    const td = await daemon();
    const c = client(td.daemon.url, td.adminToken);
    const thread = remoteThread('s1');
    const r = recorder();
    const session = new RemoteHarnessSession(c, thread);
    expect(session.turnInFlight).toBe(false);
    await session.start(optionsFor(r));
    expect(thread.remote!.epoch).toBe(td.daemon.epoch);

    session.send('/tokens 40 burst=3', undefined, 'u1');
    expect(session.turnInFlight).toBe(true); // optimistic, before the daemon says so
    await until(() => names(r).includes('onDone'), 'onDone');
    await until(() => !session.turnInFlight, 'turn to end');

    expect(r.tokens).toEqual(expectedTokens(40));
    expect(r.messages).toEqual([expectedTokens(40).join('')]);
    const order = names(r).filter((n) => n !== 'onNotification');
    expect(order.indexOf('onMessage')).toBeGreaterThan(order.lastIndexOf('onToken'));
    expect(order.indexOf('onDone')).toBeGreaterThan(order.indexOf('onMessage'));
    expect(thread.remote!.turnPending).toBeUndefined();
    // Everything is reflected, so the persisted cursor is at the head of the journal.
    expect(thread.remote!.lastSeq).toBe(td.daemon.threads.journalFor('s1')!.lastSeq);
    session.close();
  });

  it('keeps the persisted cursor before an unfinished message and advances it when finished', async () => {
    const td = await daemon();
    const c = client(td.daemon.url, td.adminToken);
    const thread = remoteThread('s2');
    const r = recorder();
    const session = new RemoteHarnessSession(c, thread);
    await session.start(optionsFor(r));
    const before = thread.remote!.lastSeq;
    session.send('/tokens 30 burst=1 delay=15', undefined, 'u');
    await until(() => r.tokens.length >= 5, 'a few tokens');
    expect(thread.remote!.turnPending).toBe(true);
    // Tokens have been applied, but the transcript has no message yet: the cursor must not pass them.
    const mid = thread.remote!.lastSeq;
    const firstTokenSeq = td.daemon.threads.journalFor('s2')!.replay(0);
    expect(firstTokenSeq.kind).toBe('entries');
    const entries = (firstTokenSeq as { entries: Array<{ seq: number; event: { name: string } }> }).entries;
    const tokenSeq = entries.find((e) => e.event.name === 'onToken')!.seq;
    expect(mid).toBe(tokenSeq - 1);
    expect(mid).toBeGreaterThanOrEqual(before);
    await until(() => names(r).includes('onDone'), 'onDone');
    expect(thread.remote!.lastSeq).toBeGreaterThan(tokenSeq);
    session.close();
  });
});

describe('resume across a dropped connection', () => {
  it('loses and duplicates nothing when the socket is cut repeatedly mid-turn', async () => {
    const td = await daemon();
    const proxy = await startKillableProxy('127.0.0.1', td.daemon.port);
    cleanups.push(() => proxy.close());
    const c = client(`ws://127.0.0.1:${proxy.port}/v1/ws`, td.adminToken);
    const thread = remoteThread('d1');
    const r = recorder();
    const N = 300;
    let kills = 0;
    r.onToken = (n) => { if (n % 60 === 0 && kills < 4) { kills++; proxy.killAll(); } };
    const session = new RemoteHarnessSession(c, thread);
    await session.start(optionsFor(r));
    session.send(`/tokens ${N} burst=1 delay=2`, undefined, 'u');
    await until(() => names(r).includes('onDone'), 'onDone', 20000);

    expect(kills).toBe(4);
    expect(r.tokens).toEqual(expectedTokens(N)); // exactly once each, in order
    expect(r.messages).toEqual([expectedTokens(N).join('')]);
    expect(names(r).filter((n) => n === 'onDone')).toHaveLength(1);
    session.close();
  });

  it('survives a cut while a permission prompt is open: shown once, still answerable', async () => {
    const td = await daemon();
    const proxy = await startKillableProxy('127.0.0.1', td.daemon.port);
    cleanups.push(() => proxy.close());
    const c = client(`ws://127.0.0.1:${proxy.port}/v1/ws`, td.adminToken);
    const thread = remoteThread('p1');
    const r = recorder();
    const session = new RemoteHarnessSession(c, thread);
    await session.start(optionsFor(r));
    session.send('/permission', undefined, 'u');
    await until(() => r.permission.prompts.length === 1, 'permission prompt');
    expect(r.permission.prompts[0]).toMatchObject({ toolName: 'Bash' });
    expect(session.hasPendingPermission).toBe(true);

    proxy.killAll();
    await until(() => c.connection.status === 'reconnecting' || c.connection.status === 'connected', 'drop noticed');
    await until(() => c.connection.status === 'connected', 'reconnected');
    await new Promise((res) => setTimeout(res, 150)); // let the reopen frame arrive
    expect(r.permission.prompts).toHaveLength(1); // the re-delivered request did not re-prompt

    r.permission.prompts[0].answer(true);
    await until(() => names(r).includes('onDone'), 'onDone');
    expect(r.messages[0]).toContain('permission resolved');
    expect(session.hasPendingPermission).toBe(false);
    session.close();
  });
});

describe('quit and reopen mid-turn', () => {
  it('a fresh process re-attaches from the persisted cursor and the transcript completes', async () => {
    const td = await daemon();
    const N = 80;

    // Process 1: start a slow turn, then "quit" (detach) part way through.
    const c1 = client(td.daemon.url, td.adminToken);
    const thread1 = remoteThread('q1');
    const r1 = recorder();
    const s1 = new RemoteHarnessSession(c1, thread1);
    await s1.start(optionsFor(r1));
    s1.send(`/tokens ${N} burst=1 delay=10`, undefined, 'u');
    await until(() => r1.tokens.length >= 15, 'some tokens');
    s1.detach();
    c1.dispose();
    const persisted = JSON.parse(JSON.stringify(thread1)) as Thread; // what data.json would hold
    expect(persisted.remote!.turnPending).toBe(true);
    expect(r1.messages).toHaveLength(0);

    // The turn keeps running on the daemon with nobody attached.
    await until(() => !td.daemon.threads.list().find((t) => t.threadId === 'q1')!.turnInFlight, 'daemon to finish the turn', 8000);

    // Process 2: new client, new session object, attach-only (no process spawned just to look).
    const c2 = client(td.daemon.url, td.adminToken);
    const r2 = recorder();
    const s2 = new RemoteHarnessSession(c2, persisted);
    await s2.start(optionsFor(r2), { attachOnly: true });
    await until(() => names(r2).includes('onDone'), 'replayed onDone');
    expect(r2.messages).toEqual([expectedTokens(N).join('')]); // the full message, once
    expect(persisted.remote!.turnPending).toBeUndefined();
    expect(persisted.remote!.lastSeq).toBe(td.daemon.threads.journalFor('q1')!.lastSeq);
    // Tokens of the unfinished message were replayed (the transcript never had them).
    expect(r2.tokens.length).toBeGreaterThanOrEqual(N);
    s2.close();
  });

  it('re-offers an open permission prompt to the new process', async () => {
    const td = await daemon();
    const c1 = client(td.daemon.url, td.adminToken);
    const thread1 = remoteThread('q2');
    const r1 = recorder();
    const s1 = new RemoteHarnessSession(c1, thread1);
    await s1.start(optionsFor(r1));
    s1.send('/permission', undefined, 'u');
    await until(() => r1.permission.prompts.length === 1, 'prompt');
    // Make sure the persisted cursor is past the request: it was seen, then Geode quit.
    expect(thread1.remote!.lastSeq).toBeGreaterThan(0);
    s1.detach();
    c1.dispose();
    const persisted = JSON.parse(JSON.stringify(thread1)) as Thread;

    const c2 = client(td.daemon.url, td.adminToken);
    const r2 = recorder();
    const s2 = new RemoteHarnessSession(c2, persisted);
    await s2.start(optionsFor(r2), { attachOnly: true });
    await until(() => r2.permission.prompts.length === 1, 're-offered prompt');
    r2.permission.prompts[0].answer(true);
    await until(() => names(r2).includes('onDone'), 'onDone');
    expect(r2.messages[0]).toContain('permission resolved');
    s2.close();
  });

  it('reports a missing daemon thread instead of hanging', async () => {
    const td = await daemon();
    const c = client(td.daemon.url, td.adminToken);
    const thread = remoteThread('ghost', 12);
    thread.remote!.turnPending = true;
    const r = recorder();
    const s = new RemoteHarnessSession(c, thread);
    await s.start(optionsFor(r), { attachOnly: true });
    await until(() => names(r).includes('onError'), 'onError');
    expect(String((r.calls.find((x) => x.name === 'onError')!.args[0] as Error).message)).toMatch(/no longer has this thread/);
    s.close();
  });
});

describe('commands', () => {
  it('holds a send made mid-turn and delivers it after the turn ends', async () => {
    const td = await daemon();
    const c = client(td.daemon.url, td.adminToken);
    const r = recorder();
    const s = new RemoteHarnessSession(c, remoteThread('c1'));
    await s.start(optionsFor(r));
    s.send('/tokens 10 burst=1 delay=10', undefined, 'u1');
    s.send('second turn', undefined, 'u2');
    await until(() => r.messages.length === 2, 'both messages', 8000);
    expect(r.messages[1]).toBe('echo: second turn');
    expect(names(r).filter((n) => n === 'onDone')).toHaveLength(2);
    s.close();
  });

  it('interrupt stops the turn and drops held sends', async () => {
    const td = await daemon();
    const c = client(td.daemon.url, td.adminToken);
    const r = recorder();
    const s = new RemoteHarnessSession(c, remoteThread('c2'));
    await s.start(optionsFor(r));
    s.send('/hang', undefined, 'u1');
    await until(() => s.turnInFlight && r.tokens.length === 1, 'hang started');
    s.send('never delivered', undefined, 'u2');
    await s.interrupt();
    await until(() => names(r).includes('onInterrupted'), 'onInterrupted');
    await until(() => !s.turnInFlight, 'idle');
    await new Promise((res) => setTimeout(res, 100));
    expect(r.messages).toHaveLength(0);
    s.close();
  });

  it('serves model, mode and the async RPCs', async () => {
    const td = await daemon();
    const c = client(td.daemon.url, td.adminToken);
    const s = new RemoteHarnessSession(c, remoteThread('c3'));
    await s.start(optionsFor(recorder()));
    await s.setModel('opus');
    await s.setPermissionMode('acceptEdits');
    expect(await s.getContextUsage()).toMatchObject({ model: 'opus' });
    expect(await s.mcpServerStatus()).toEqual([{ name: 'fake-mcp', status: 'connected' }]);
    expect(await s.getUsageSnapshot(true)).toMatchObject({ fake: true, includeAccountUsage: true });
    s.close();
  });

  it('reports "unreachable" through onError when the daemon cannot be reached', async () => {
    const td = await daemon();
    const proxy = await startKillableProxy('127.0.0.1', td.daemon.port);
    const c = client(`ws://127.0.0.1:${proxy.port}/v1/ws`, td.adminToken, { commandTimeoutMs: 400 });
    const r = recorder();
    const s = new RemoteHarnessSession(c, remoteThread('c4'));
    await s.start(optionsFor(r));
    await proxy.close(); // nothing listens any more
    s.send('hello', undefined, 'u');
    await until(() => names(r).includes('onError'), 'onError', 5000);
    expect(String((r.calls.find((x) => x.name === 'onError')!.args[0] as Error).message)).toMatch(/unreachable/);
    expect(s.turnInFlight).toBe(false);
    s.close();
  });

  it('close() ends the daemon session; the next send cold-resumes it', async () => {
    const td = await daemon();
    const c = client(td.daemon.url, td.adminToken);
    const thread = remoteThread('c5');
    const r = recorder();
    const s = new RemoteHarnessSession(c, thread);
    await s.start(optionsFor(r));
    s.send('one', undefined, 'u1');
    await until(() => r.messages.length === 1, 'first reply');
    s.close();
    await until(() => !td.daemon.threads.list().find((t) => t.threadId === 'c5')!.open, 'daemon session closed');

    const r2 = recorder();
    const s2 = new RemoteHarnessSession(c, thread);
    await s2.start(optionsFor(r2));
    s2.send('two', undefined, 'u2');
    await until(() => r2.messages.length >= 1, 'second reply');
    expect(r2.messages.at(-1)).toBe('echo: two');
    s2.close();
  });

  it('detach() leaves the turn running on the daemon', async () => {
    const td = await daemon();
    const c = client(td.daemon.url, td.adminToken);
    const r = recorder();
    const s = new RemoteHarnessSession(c, remoteThread('c6'));
    await s.start(optionsFor(r));
    s.send('/tokens 60 burst=1 delay=10', undefined, 'u');
    await until(() => r.tokens.length >= 5, 'streaming');
    s.detach();
    await new Promise((res) => setTimeout(res, 100));
    expect(td.daemon.threads.list().find((t) => t.threadId === 'c6')).toMatchObject({ open: true, turnInFlight: true });
    const watcher = await TestClient.connect(td.daemon.url, td.adminToken);
    cleanups.push(() => watcher.close().catch(() => undefined));
    await watcher.cmd('attach', { ch: 't:c6', afterSeq: 0 });
    await watcher.waitFor((f) => f.name === 'onDone', 8000, 'daemon-side completion');
  });
});

describe('proxy helper', () => {
  it('counts and kills connections', async () => {
    const td = await daemon();
    const proxy: KillableProxy = await startKillableProxy('127.0.0.1', td.daemon.port);
    cleanups.push(() => proxy.close());
    const c = client(`ws://127.0.0.1:${proxy.port}/v1/ws`, td.adminToken);
    c.connect();
    await until(() => c.connection.status === 'connected', 'connected via proxy');
    expect(proxy.connections).toBe(1);
    expect(proxy.killAll()).toBe(1);
    await until(() => c.connection.status !== 'connected', 'drop');
    await until(() => c.connection.status === 'connected', 'reconnect');
  });
});

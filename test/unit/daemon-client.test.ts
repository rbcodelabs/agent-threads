import { afterEach, describe, expect, it } from 'vitest';
import {
  DaemonClient,
  DaemonCommandError,
  compareVersions,
  daemonWsUrl,
  probeDaemon,
  type ConnectionState,
} from '../../src/remote/DaemonClient';
import { WELCOME, fakeTransport, tick, until, type Json } from '../helpers/fakeTransport';

const clients: DaemonClient[] = [];
function make(opts: Partial<ConstructorParameters<typeof DaemonClient>[0]> & { transport: ReturnType<typeof fakeTransport> }): DaemonClient {
  const { transport, ...rest } = opts;
  const c = new DaemonClient({
    url: 'ws://daemon.test/v1/ws',
    getToken: () => 'tok',
    createSocket: transport.factory,
    clientVersion: '0.62.2',
    backoffMs: [5, 10, 20],
    idleProbeMs: 60_000,
    ackDebounceMs: 10,
    ...rest,
  });
  clients.push(c);
  return c;
}
afterEach(() => { for (const c of clients.splice(0)) c.dispose(); });

const ev = (seq: number, name: string, args: unknown, extra: Json = {}): Json =>
  ({ ch: 't:T', seq, ts: 1000 + seq, type: 'event', name, args, ...extra });

describe('daemonWsUrl', () => {
  it('normalises schemes and appends the endpoint once', () => {
    expect(daemonWsUrl('claude-box:7433')).toBe('ws://claude-box:7433/v1/ws');
    expect(daemonWsUrl('https://box.ts.net:8443/')).toBe('wss://box.ts.net:8443/v1/ws');
    expect(daemonWsUrl('http://127.0.0.1:1')).toBe('ws://127.0.0.1:1/v1/ws');
    expect(daemonWsUrl('wss://x/v1/ws')).toBe('wss://x/v1/ws');
  });
});

describe('compareVersions', () => {
  it('orders dotted versions numerically', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('2.0.1', '2.0.0')).toBe(1);
  });
});

describe('connection and auth', () => {
  it('sends the token in the first frame, never in the URL, and reports connected', async () => {
    const t = fakeTransport();
    t.autoServe();
    const c = make({ transport: t });
    c.connect();
    await until(() => c.connection.status === 'connected');
    const hello = t.current.sent[0];
    expect(hello).toMatchObject({ type: 'hello', protocol: 1, client: 'geode-plugin', clientVersion: '0.62.2', token: 'tok' });
    expect(t.current.url).not.toContain('tok');
    expect(c.daemonInfo?.epoch).toBe('epoch-1');
  });

  it('is unauthorized (no retry) when no token is configured', async () => {
    const t = fakeTransport();
    const c = make({ transport: t, getToken: () => undefined });
    c.connect();
    expect(c.connection.status).toBe('unauthorized');
    expect(t.sockets).toHaveLength(0);
    await expect(c.command('session.list', {})).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('treats close 4401 as unauthorized and stops retrying', async () => {
    const t = fakeTransport();
    t.autoServe((f, s) => { if (f.type === 'x') s.serverClose(4401); });
    const c = make({ transport: t });
    c.connect();
    await until(() => t.sockets.length === 1);
    await until(() => c.connection.status === 'connecting' || c.connection.status === 'connected');
    t.current.serverClose(4401, 'unauthorized');
    await until(() => c.connection.status === 'unauthorized');
    await tick(60);
    expect(t.sockets).toHaveLength(1);
  });

  it('reports incompatible when the daemon requires a newer client', async () => {
    const t = fakeTransport();
    t.autoServe(undefined, { minClientVersion: '9.0.0' });
    const c = make({ transport: t });
    c.connect();
    await until(() => c.connection.status === 'incompatible');
    expect(c.connection.detail).toMatch(/update the plugin/);
    await tick(40);
    expect(t.sockets).toHaveLength(1);
    await expect(c.command('session.list', {})).rejects.toBeInstanceOf(DaemonCommandError);
  });

  it('reports incompatible when the daemon speaks a different protocol', async () => {
    const t = fakeTransport();
    t.autoServe(undefined, { protocol: 2 });
    const c = make({ transport: t });
    c.connect();
    await until(() => c.connection.status === 'incompatible');
    expect(c.connection.detail).toMatch(/protocol 2/);
  });
});

describe('reconnect', () => {
  it('walks reconnecting -> unreachable on the backoff ladder, then connected again', async () => {
    const t = fakeTransport();
    let failing = true;
    const states: string[] = [];
    // Sockets that never open while failing.
    const factory = (url: string) => {
      const s = t.factory(url);
      if (failing) { s.open = () => undefined; queueMicrotask(() => s.serverClose(1006, 'refused')); }
      return s;
    };
    t.autoServe();
    const c = make({ transport: { ...t, factory } as never, unreachableAfter: 3 });
    c.onState((s) => states.push(`${s.status}:${s.attempt}`));
    c.connect();
    await until(() => c.connection.status === 'unreachable');
    failing = false;
    await until(() => c.connection.status === 'connected', 'connected after recovery');
    expect(states).toContain('reconnecting:1');
    expect(states).toContain('reconnecting:2');
    expect(states).toContain('unreachable:3');
    expect(c.connection.attempt).toBe(0);
  });
});

describe('channels: resume and duplicate drop', () => {
  async function connected(): Promise<{ t: ReturnType<typeof fakeTransport>; c: DaemonClient }> {
    const t = fakeTransport();
    t.autoServe();
    const c = make({ transport: t });
    c.connect();
    await until(() => c.connection.status === 'connected');
    return { t, c };
  }

  it('attaches with the cursor and applies events in order', async () => {
    const { t, c } = await connected();
    const seen: number[] = [];
    c.subscribe('T', { onEvent: (f) => seen.push(f.seq) }, 41);
    await until(() => t.current.framesOfType('attach').length === 1);
    expect(t.current.framesOfType('attach')[0]).toMatchObject({ ch: 't:T', afterSeq: 41 });
    t.current.serverSend(ev(42, 'onToken', ['a']));
    t.current.serverSend(ev(43, 'onToken', ['b']));
    expect(seen).toEqual([42, 43]);
  });

  it('drops events at or below the cursor (replay overlapping live)', async () => {
    const { t, c } = await connected();
    const seen: number[] = [];
    c.subscribe('T', { onEvent: (f) => seen.push(f.seq) }, 10);
    await until(() => t.current.framesOfType('attach').length === 1);
    for (const seq of [11, 12, 12, 11, 13, 10, 14]) t.current.serverSend(ev(seq, 'onToken', ['x']));
    expect(seen).toEqual([11, 12, 13, 14]);
  });

  it('delivers a reopen request below the cursor without moving it', async () => {
    const { t, c } = await connected();
    const seen: Array<[number, boolean]> = [];
    const sub = c.subscribe('T', { onEvent: (f, m) => seen.push([f.seq, m.reopen]) }, 50);
    await until(() => t.current.framesOfType('attach').length === 1);
    t.current.serverSend(ev(30, 'permission_request', { requestId: 'r', toolName: 'Bash', detail: 'ls' }, { reopen: true }));
    t.current.serverSend(ev(51, 'onToken', ['x']));
    expect(seen).toEqual([[30, true], [51, false]]);
    expect(sub.cursor.lastSeq).toBe(51);
  });

  it('re-attaches after a reconnect from the exact point it applied', async () => {
    const { t, c } = await connected();
    const seen: number[] = [];
    c.subscribe('T', { onEvent: (f) => seen.push(f.seq) }, 0);
    await until(() => t.current.framesOfType('attach').length === 1);
    t.current.serverSend(ev(1, 'onToken', ['a']));
    t.current.serverSend(ev(2, 'onToken', ['b']));
    const first = t.current;
    first.serverClose(1006);
    await until(() => t.sockets.length === 2 && c.connection.status === 'connected');
    await until(() => t.current.framesOfType('attach').length === 1);
    expect(t.current.framesOfType('attach')[0]).toMatchObject({ ch: 't:T', afterSeq: 2 });
    // The daemon replays from 3 and also (as a real overlap) 2.
    t.current.serverSend(ev(2, 'onToken', ['b']));
    t.current.serverSend(ev(3, 'onToken', ['c']));
    expect(seen).toEqual([1, 2, 3]);
  });

  it('hands a resync to the consumer and moves the cursor to the checkpoint', async () => {
    const { t, c } = await connected();
    const resyncs: number[] = [];
    const sub = c.subscribe('T', { onEvent: () => undefined, onResync: (f) => resyncs.push(f.checkpoint.seq) }, 5);
    await until(() => t.current.framesOfType('attach').length === 1);
    t.current.serverSend({ ch: 't:T', seq: 90, ts: 1, type: 'resync', checkpoint: { seq: 90, ts: 1, inFlightText: 'so far', openRequests: [], state: null, recentMessages: [] } });
    expect(resyncs).toEqual([90]);
    expect(sub.cursor.lastSeq).toBe(90);
  });

  it('keeps going when a consumer throws', async () => {
    const { t, c } = await connected();
    const seen: number[] = [];
    c.subscribe('T', { onEvent: (f) => { seen.push(f.seq); if (f.seq === 1) throw new Error('boom'); } }, 0);
    await until(() => t.current.framesOfType('attach').length === 1);
    t.current.serverSend(ev(1, 'onToken', ['a']));
    t.current.serverSend(ev(2, 'onToken', ['b']));
    expect(seen).toEqual([1, 2]);
  });

  it('acks only what the consumer says is persisted, debounced', async () => {
    const { t, c } = await connected();
    const sub = c.subscribe('T', { onEvent: () => undefined }, 0);
    await until(() => t.current.framesOfType('attach').length === 1);
    t.current.serverSend(ev(1, 'onToken', ['a']));
    t.current.serverSend(ev(2, 'onToken', ['b']));
    await tick(40);
    expect(t.current.framesOfType('ack')).toHaveLength(0); // applied is not persisted
    sub.ack(1);
    sub.ack(2);
    await until(() => t.current.framesOfType('ack').length === 1);
    expect(t.current.framesOfType('ack')[0]).toMatchObject({ ch: 't:T', seq: 2 });
  });
});

describe('idempotent commands', () => {
  it('re-sends an unacked command with the SAME cmdId after reconnect and resolves once', async () => {
    const t = fakeTransport();
    let swallow = true;
    t.autoServe((f) => (f.type === 'session.send' && swallow ? true : undefined));
    const c = make({ transport: t });
    c.connect();
    await until(() => c.connection.status === 'connected');
    const p = c.command('session.send', { threadId: 'T', text: 'hi', userMessageUuid: 'u1' });
    await until(() => t.current.framesOfType('session.send').length === 1);
    const original = t.current.framesOfType('session.send')[0];
    swallow = false;
    t.current.serverClose(1006); // the ack is lost with the connection
    await until(() => t.sockets.length === 2 && c.connection.status === 'connected');
    await until(() => t.current.framesOfType('session.send').length === 1);
    expect(t.current.framesOfType('session.send')[0].cmdId).toBe(original.cmdId);
    await expect(p).resolves.toEqual({});
  });

  it('queues a command issued while disconnected and sends it on connect', async () => {
    const t = fakeTransport();
    t.autoServe();
    const c = make({ transport: t });
    const p = c.command('session.list', {}); // implicitly connects
    await expect(p).resolves.toEqual({});
    expect(t.current.framesOfType('session.list')).toHaveLength(1);
  });

  it('rejects with the daemon error code and retryable flag', async () => {
    const t = fakeTransport();
    t.autoServe((f, s) => {
      if (f.type === 'session.send') { s.serverSend({ type: 'err', cmdId: f.cmdId, code: 'conflict', message: 'busy', retryable: true }); return true; }
    });
    const c = make({ transport: t });
    c.connect();
    await until(() => c.connection.status === 'connected');
    await expect(c.command('session.send', { threadId: 'T', text: 'x', userMessageUuid: 'u' })).rejects.toMatchObject({ code: 'conflict', retryable: true });
  });

  it('gives up with "unreachable" when the daemon never comes back within the timeout', async () => {
    const t = fakeTransport();
    const factory = (url: string) => { const s = t.factory(url); s.open = () => undefined; queueMicrotask(() => s.serverClose(1006)); return s; };
    const c = make({ transport: { ...t, factory } as never, commandTimeoutMs: 60 });
    await expect(c.command('session.list', {})).rejects.toMatchObject({ code: 'unreachable' });
  });
});

describe('liveness probe', () => {
  it('drops a socket that stops answering and reconnects', async () => {
    const t = fakeTransport();
    t.autoServe((f) => (f.type === 'attach' && f.ch === 'ctl' ? true : undefined)); // probes go unanswered
    const c = make({ transport: t, idleProbeMs: 30, probeTimeoutMs: 30 });
    c.connect();
    await until(() => c.connection.status === 'connected');
    await until(() => t.sockets.length >= 2, 'reconnect after a silent socket', 3000);
    const probe = t.sockets[0].sent.find((f) => f.type === 'attach' && f.ch === 'ctl');
    expect(probe).toBeTruthy();
  });
});

describe('probeDaemon', () => {
  it('returns the daemon info', async () => {
    const t = fakeTransport();
    t.autoServe();
    const r = await probeDaemon({ url: 'ws://x/v1/ws', token: 'tok', createSocket: t.factory, clientVersion: '0.62.2' });
    expect(r).toMatchObject({ ok: true, info: { daemonVersion: WELCOME.daemonVersion, protocol: 1 } });
    expect(t.current.readyState === 3 || t.current.terminated).toBe(true);
  });

  it('classifies a wrong token', async () => {
    const t = fakeTransport();
    t.autoServe((f, s) => {
      if (f.type === 'hello') { s.serverSend({ type: 'err', cmdId: 'hello', code: 'unauthorized', message: 'invalid token' }); s.serverClose(4401); return true; }
    });
    const r = await probeDaemon({ url: 'ws://x/v1/ws', token: 'bad', createSocket: t.factory, clientVersion: '0.62.2' });
    expect(r).toMatchObject({ ok: false, status: 'unauthorized' });
  });

  it('reports unreachable once, without retrying', async () => {
    const t = fakeTransport();
    const factory = (url: string) => { const s = t.factory(url); s.open = () => undefined; queueMicrotask(() => s.serverClose(1006, 'ECONNREFUSED')); return s; };
    const r = await probeDaemon({ url: 'ws://x/v1/ws', token: 't', createSocket: factory, clientVersion: '0.62.2' });
    expect(r).toMatchObject({ ok: false, status: 'unreachable' });
    expect(t.sockets).toHaveLength(1);
  });
});

describe('state listeners', () => {
  it('notifies on every change and stops after unsubscribe', async () => {
    const t = fakeTransport();
    t.autoServe();
    const c = make({ transport: t });
    const seen: ConnectionState['status'][] = [];
    const off = c.onState((s) => seen.push(s.status));
    c.connect();
    await until(() => c.connection.status === 'connected');
    off();
    c.dispose();
    expect(seen).toEqual(['connecting', 'connected']);
  });
});

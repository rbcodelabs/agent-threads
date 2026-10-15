/**
 * Hardening regressions from the remote-daemon security/correctness review.
 * Each block names the review finding it pins (A..L).
 */
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_COMMAND_TYPES } from '../../src/protocol';
import { REQUIRED_SCOPE } from '../../daemon/connection';
import { FailureThrottle } from '../../daemon/failureThrottle';
import { MAX_UNAUTHENTICATED_CONNECTIONS } from '../../daemon/server';
import { SPEC, TestClient, sleep, startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const track = async (opts?: Parameters<typeof startTestDaemon>[0]): Promise<TestDaemon> => {
  const td = await startTestDaemon(opts);
  cleanups.push(() => td.cleanup());
  return td;
};
const connect = async (td: TestDaemon, token = td.adminToken, instanceId?: string): Promise<TestClient> => {
  const c = await TestClient.connect(td.daemon.url, token, {}, instanceId ? { instanceId } : {});
  cleanups.push(() => c.close().catch(() => {}));
  return c;
};

describe('A. one writer per thread across client instances sharing a token', () => {
  it('a second instance on the same token is refused the seat; it observes', async () => {
    const td = await track();
    const one = await connect(td, td.adminToken, 'install-1');
    await one.cmd('session.open', { threadId: 't', spec: SPEC });
    const two = await connect(td, td.adminToken, 'install-2');
    expect((await two.cmd('attach', { ch: 't:t', afterSeq: 0 })).result).toMatchObject({ controller: false });
    expect(await two.cmd('session.send', { threadId: 't', text: 'x', userMessageUuid: 'u' })).toMatchObject({ type: 'err', code: 'conflict' });
    // The first instance still holds the seat.
    expect((await one.cmd('session.send', { threadId: 't', text: 'x', userMessageUuid: 'u1' })).type).toBe('ack');
  });

  it('the same instance reconnecting takes the seat back from its own stale socket', async () => {
    const td = await track();
    const stale = await connect(td, td.adminToken, 'install-1');
    await stale.cmd('session.open', { threadId: 't', spec: SPEC });
    const fresh = await connect(td, td.adminToken, 'install-1');
    expect((await fresh.cmd('attach', { ch: 't:t', afterSeq: 0 })).result).toMatchObject({ controller: true });
    expect((await fresh.cmd('session.send', { threadId: 't', text: 'x', userMessageUuid: 'u1' })).type).toBe('ack');
  });

  it('a client without an instance id keeps the old per-token behaviour', async () => {
    const td = await track();
    const a = await connect(td);
    await a.cmd('session.open', { threadId: 't', spec: SPEC });
    const b = await connect(td);
    expect((await b.cmd('attach', { ch: 't:t', afterSeq: 0 })).result).toMatchObject({ controller: true });
  });

  it('a different token is still refused', async () => {
    const td = await track();
    const other = td.daemon.tokens.create('other', 'control').token;
    const a = await connect(td, td.adminToken, 'i');
    await a.cmd('session.open', { threadId: 't', spec: SPEC });
    const b = await connect(td, other, 'i');
    expect(await b.cmd('session.send', { threadId: 't', text: 'x', userMessageUuid: 'u' })).toMatchObject({ type: 'err', code: 'conflict' });
  });
});

describe('B. bad input cannot crash the daemon', () => {
  it('a corrupt tokens.json fails closed (no new auth, open connections dropped) and recovers when fixed', async () => {
    const logs: string[] = [];
    const td = await track({ log: (l) => logs.push(l), timings: { pingIntervalMs: 60 } });
    const file = join(td.dataDir, 'tokens.json');
    const good = readFileSync(file, 'utf8');
    const c = await connect(td);

    writeFileSync(file, '{ this is not json');
    // Force a different mtime: filesystems with coarse timestamps would otherwise hide the change.
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    expect((await c.closed).code).toBe(4401); // heartbeat found the store unusable, dropped the connection, did not throw

    const again = await TestClient.open(td.daemon.url);
    expect(await again.cmd('hello', { protocol: 1, client: 'cli', clientVersion: 't', token: td.adminToken })).toMatchObject({ type: 'err', code: 'unauthorized' });
    // Bearer upgrade with the same token is refused as well, with a normal 401 (not a crashed handler).
    await expect(TestClient.open(td.daemon.url, { headers: { authorization: `Bearer ${td.adminToken}` } })).rejects.toMatchObject({ status: 401 });
    expect(logs.filter((l) => l.includes('Rejecting ALL authentication'))).toHaveLength(1); // logged once, clearly

    writeFileSync(file, good);
    utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    const back = await TestClient.connect(td.daemon.url, td.adminToken);
    expect((await back.cmd('session.list')).type).toBe('ack');
    await back.close();
  });

  it('a result that cannot be serialized becomes an internal error; the connection and daemon keep serving', async () => {
    const td = await track();
    const c = await connect(td);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const real = td.daemon.threads.list.bind(td.daemon.threads);
    td.daemon.threads.list = () => [cyclic as never];
    expect(await c.cmd('session.list')).toMatchObject({ type: 'err', code: 'internal' });
    td.daemon.threads.list = real;
    expect((await c.cmd('session.list')).type).toBe('ack');
  });

  it('a timer or handler that throws closes that connection only (1011); the daemon keeps serving', async () => {
    const td = await track({ timings: { pingIntervalMs: 40 } });
    const victim = await connect(td);
    const real = td.daemon.tokens.isActive.bind(td.daemon.tokens);
    td.daemon.tokens.isActive = () => { throw new Error('boom'); };
    expect((await victim.closed).code).toBe(1011);
    td.daemon.tokens.isActive = real;
    const other = await connect(td);
    expect((await other.cmd('session.list')).type).toBe('ack');
  });
});

describe('E. resource limits', () => {
  it('closes a connection that sends an oversized frame before hello', async () => {
    const td = await track();
    const c = await TestClient.open(td.daemon.url);
    c.ws.send('x'.repeat(8 * 1024));
    expect((await c.closed).code).toBe(1009);
  });

  it('after hello the full frame size is available again', async () => {
    const td = await track();
    const c = await connect(td);
    const long = `/${'a'.repeat(200_000)}`;
    expect(await c.cmd('path.check', { path: long })).toMatchObject({ type: 'ack', result: { allowed: false } });
  });

  it('a Bearer-authenticated upgrade can send big frames immediately too', async () => {
    const td = await track();
    const c = await TestClient.open(td.daemon.url, { headers: { authorization: `Bearer ${td.adminToken}` } });
    cleanups.push(() => c.close().catch(() => {}));
    await c.cmd('hello', { protocol: 1, client: 'cli', clientVersion: 't', token: '' });
    expect(await c.cmd('path.check', { path: `/${'a'.repeat(100_000)}` })).toMatchObject({ type: 'ack' });
  });

  it('refuses sockets beyond maxConnections with 503', async () => {
    const td = await track({ config: { maxConnections: 2 } });
    await connect(td);
    await connect(td);
    await expect(TestClient.open(td.daemon.url)).rejects.toMatchObject({ status: 503 });
  });

  it('limits unauthenticated sockets far below the total, so a flood cannot crowd the owner out', async () => {
    const td = await track({ timings: { helloTimeoutMs: 30_000 } });
    const idle: TestClient[] = [];
    for (let i = 0; i < MAX_UNAUTHENTICATED_CONNECTIONS; i++) idle.push(await TestClient.open(td.daemon.url));
    cleanups.push(async () => { await Promise.all(idle.map((c) => c.close().catch(() => {}))); });
    await expect(TestClient.open(td.daemon.url)).rejects.toMatchObject({ status: 503 });
    // A Bearer-less owner is turned away too while the flood lasts, but authenticated clients are unaffected.
    idle[0].kill();
    await idle[0].closed;
    await sleep(30);
    const owner = await TestClient.connect(td.daemon.url, td.adminToken);
    cleanups.push(() => owner.close().catch(() => {}));
  });

  it('closes 4408 a client whose replies pile up unread (control queue is bounded like events)', async () => {
    const td = await track({ maxOutboundBytes: 60_000, timings: { closeGraceMs: 20_000 } });
    const c = await connect(td);
    // A big reply: many threads known to the daemon.
    for (let i = 0; i < 400; i++) await c.cmd('session.open', { threadId: `th-${i}`, spec: SPEC });
    // Stop reading at the TCP level, then keep asking.
    const sock = (c.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    sock.pause();
    for (let i = 0; i < 300; i++) c.sendRaw({ cmdId: `q${i}`, type: 'session.list' });
    await sleep(500);
    sock.resume();
    expect((await c.closed).code).toBe(4408);
  }, 30_000);
});

describe('F. failure throttle behind a local reverse proxy', () => {
  it('does not count loopback peers by default: bad tokens from one peer never lock the owner out', async () => {
    const td = await track();
    for (let i = 0; i < 8; i++) {
      const c = await TestClient.open(td.daemon.url);
      await c.cmd('hello', { protocol: 1, client: 'cli', clientVersion: 't', token: `bad-${i}` });
      await c.closed;
    }
    const owner = await TestClient.connect(td.daemon.url, td.adminToken);
    await owner.close();
  });

  it('bad Bearer headers count toward the throttle where it applies', async () => {
    const td = await track({ throttle: new FailureThrottle(2, 60_000), throttleLoopback: true });
    for (let i = 0; i < 2; i++) {
      await expect(TestClient.open(td.daemon.url, { headers: { authorization: 'Bearer atd_nope' } })).rejects.toMatchObject({ status: 401 });
    }
    await expect(TestClient.open(td.daemon.url, { headers: { authorization: `Bearer ${td.adminToken}` } })).rejects.toMatchObject({ status: 429 });
  });

  it('bad Bearer headers from loopback are not counted by default', async () => {
    const td = await track({ throttle: new FailureThrottle(2, 60_000) });
    for (let i = 0; i < 5; i++) {
      await expect(TestClient.open(td.daemon.url, { headers: { authorization: 'Bearer atd_nope' } })).rejects.toMatchObject({ status: 401 });
    }
    const ok = await TestClient.open(td.daemon.url, { headers: { authorization: `Bearer ${td.adminToken}` } });
    await ok.close();
  });
});

describe('G. audit log', () => {
  it('records commands without a line per retention ack, batched, mode 0600', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-it-'));
    try {
      const td = await startTestDaemon({ dataDir: dir, audit: { flushMs: 10 } });
      const c = await TestClient.connect(td.daemon.url, td.adminToken);
      await c.cmd('session.open', { threadId: 't', spec: SPEC });
      await c.cmd('attach', { ch: 't:t', afterSeq: 0 });
      for (let i = 0; i < 5; i++) await c.cmd('ack', { ch: 't:t', seq: i });
      await sleep(80);
      await c.close();
      await td.daemon.stop();
      const lines = readFileSync(join(dir, 'audit.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const commands = lines.filter((l) => l.event === 'command').map((l) => l.type);
      expect(commands).toContain('session.open');
      expect(commands).not.toContain('ack');
      expect(statSync(join(dir, 'audit.ndjson')).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('L. scopes and request ownership', () => {
  // Minimal valid payload per command so the frame passes the codec and reaches the scope check.
  const SAMPLE: Record<string, object> = {
    attach: { ch: 't:x', afterSeq: 0 },
    'session.list': {},
    'path.check': { path: '/tmp' },
    'workspaces.list': {},
    'path.list': { path: '/tmp' },
    'session.getContextUsage': { threadId: 'x' },
    'session.mcpServerStatus': { threadId: 'x' },
    'session.getUsageSnapshot': { threadId: 'x' },
    ack: { ch: 't:x', seq: 0 },
    'session.open': { threadId: 'x', spec: SPEC },
    'session.detach': { threadId: 'x' },
    'session.close': { threadId: 'x' },
    'session.send': { threadId: 'x', text: 'hi', userMessageUuid: 'u' },
    'session.prepareForSend': { threadId: 'x', text: 'hi' },
    'session.interrupt': { threadId: 'x' },
    'session.sendAgentMessage': { threadId: 'x', nativeAgentId: 'a', text: 'hi' },
    'session.interruptAgent': { threadId: 'x', nativeAgentId: 'a' },
    'session.setModel': { threadId: 'x', model: 'm' },
    'session.setPermissionMode': { threadId: 'x', mode: 'default' },
    'resolve.permission': { threadId: 'x', requestId: 'r', allow: true },
    'resolve.question': { threadId: 'x', requestId: 'r', answers: {} },
    'resolve.plan': { threadId: 'x', requestId: 'r', approve: true },
    'resolve.elicitation': { threadId: 'x', requestId: 'r', result: {} },
    'resolve.openTab': { threadId: 'x', requestId: 'r', openedThreadId: 'y', title: 't' },
    'tool.result': { threadId: 'x', callId: 'c', success: true, text: '' },
    'tool.manifest': { threadId: 'x', servers: {} },
    'creds.push': { kind: 'k', ttlSec: 1, fields: {} },
  };

  it('REQUIRED_SCOPE lists exactly every command except hello, and each sample is a valid frame', () => {
    const all = Object.keys(CLIENT_COMMAND_TYPES).filter((t) => t !== 'hello').sort();
    expect(Object.keys(REQUIRED_SCOPE).sort()).toEqual(all);
    expect(Object.keys(SAMPLE).sort()).toEqual(all);
  });

  for (const [type, need] of Object.entries(REQUIRED_SCOPE)) {
    if (need === 'read') continue; // nothing is below read
    it(`${type} (needs ${need}) is forbidden for a lower scope`, async () => {
      const td = await track();
      const lower = need === 'admin' ? ['read', 'control'] : ['read'];
      for (const scope of lower) {
        const token = td.daemon.tokens.create(`low-${scope}`, scope as 'read' | 'control').token;
        const c = await connect(td, token);
        const reply = await c.cmd(type, SAMPLE[type]);
        expect(reply, `${scope} -> ${type}`).toMatchObject({ type: 'err', code: 'forbidden' });
      }
    });
  }

  it('a request id from one thread cannot be resolved through another thread', async () => {
    const td = await track();
    const c = await connect(td);
    await c.cmd('session.open', { threadId: 'a', spec: SPEC });
    await c.cmd('session.open', { threadId: 'b', spec: SPEC });
    await c.cmd('attach', { ch: 't:a', afterSeq: 0 });
    await c.cmd('session.send', { threadId: 'a', text: '/permission', userMessageUuid: 'u' });
    const req = await c.waitFor((f) => f.name === 'permission_request');
    const requestId = req.args.requestId as string;
    expect(await c.cmd('resolve.permission', { threadId: 'b', requestId, allow: true })).toMatchObject({ type: 'err', code: 'not_found' });
    expect(await c.cmd('resolve.permission', { threadId: 'a', requestId, allow: true })).toMatchObject({ type: 'ack' });
  });

  it('malformed images and specs are refused with bad_frame before they reach a session', async () => {
    const td = await track();
    const c = await connect(td);
    await c.cmd('session.open', { threadId: 't', spec: SPEC });
    for (const images of [[null], ['x'], [{ base64: 'AAAA', mediaType: 'image/svg+xml', name: 'x' }], [{ base64: 'AAAA', mediaType: 'image/png', name: 5 }], new Array(11).fill({ base64: 'AAAA', mediaType: 'image/png', name: 'x' })]) {
      expect(await c.cmd('session.send', { threadId: 't', text: 'x', userMessageUuid: 'u', images })).toMatchObject({ type: 'err', code: 'bad_frame' });
      expect(await c.cmd('session.prepareForSend', { threadId: 't', text: 'x', images })).toMatchObject({ type: 'err', code: 'bad_frame' });
    }
    for (const spec of [{ ...SPEC, cwd: 5 }, { ...SPEC, disallowedTools: [null] }, { ...SPEC, mcpServers: { a: null } }, { ...SPEC, mcpServers: { a: { type: 'stdio', url: 'x' } } }, { ...SPEC, sessionOptions: { betas: [1] } }, { ...SPEC, permissionMode: 7 }, 'nope']) {
      expect(await c.cmd('session.open', { threadId: 'u', spec }), JSON.stringify(spec)).toMatchObject({ type: 'err', code: 'bad_frame' });
    }
    // The valid session is unaffected.
    expect((await c.cmd('session.send', { threadId: 't', text: 'x', userMessageUuid: 'ok' })).type).toBe('ack');
  });
});

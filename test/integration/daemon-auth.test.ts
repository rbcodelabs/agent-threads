import { afterEach, describe, expect, it } from 'vitest';
import { FailureThrottle } from '../../daemon/failureThrottle';
import { SPEC, TestClient, sleep, startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';

let td: TestDaemon | undefined;
afterEach(async () => { await td?.cleanup(); td = undefined; });

describe('GET /healthz', () => {
  it('answers {ok:true,protocol:1} without credentials', async () => {
    td = await startTestDaemon();
    const res = await fetch(`http://${td.daemon.host}:${td.daemon.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, protocol: 1 });
  });

  it('404s unknown paths and non-/v1/ws upgrades', async () => {
    td = await startTestDaemon();
    expect((await fetch(`http://${td.daemon.host}:${td.daemon.port}/nope`)).status).toBe(404);
    await expect(TestClient.open(`ws://${td.daemon.host}:${td.daemon.port}/other`)).rejects.toMatchObject({ status: 404 });
  });
});

describe('first-frame authentication', () => {
  it('closes 4401 on a wrong token', async () => {
    td = await startTestDaemon();
    const c = await TestClient.open(td.daemon.url);
    const reply = await c.cmd('hello', { protocol: 1, client: 'cli', clientVersion: 't', token: 'atd_wrong' });
    expect(reply).toMatchObject({ type: 'err', code: 'unauthorized' });
    expect((await c.closed).code).toBe(4401);
  });

  it('closes 4401 when no hello arrives within the timeout (default 5 s, shortened here)', async () => {
    td = await startTestDaemon({ timings: { helloTimeoutMs: 150 } });
    const c = await TestClient.open(td.daemon.url);
    const started = Date.now();
    expect((await c.closed).code).toBe(4401);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('closes 4401 when the first frame is not hello', async () => {
    td = await startTestDaemon();
    const c = await TestClient.open(td.daemon.url);
    c.sendRaw({ cmdId: 'x', type: 'session.list' });
    expect((await c.closed).code).toBe(4401);
  });

  it('closes 4401 on garbage before hello', async () => {
    td = await startTestDaemon();
    const c = await TestClient.open(td.daemon.url);
    c.ws.send('not json');
    expect((await c.closed).code).toBe(4401);
  });

  it('accepts a valid token and reports epoch + daemonId in welcome', async () => {
    td = await startTestDaemon();
    const c = await TestClient.open(td.daemon.url);
    const w = await c.cmd('hello', { protocol: 1, client: 'cli', clientVersion: 't', token: td.adminToken });
    expect(w).toMatchObject({ type: 'welcome', protocol: 1, epoch: td.daemon.epoch, daemonId: td.daemon.daemonId });
    expect(w.capabilities).toContain('journal.resume');
    await c.close();
  });

  it('accepts Authorization: Bearer on the upgrade (CLI), never a query-string token', async () => {
    td = await startTestDaemon();
    const c = await TestClient.open(td.daemon.url, { headers: { authorization: `Bearer ${td.adminToken}` } });
    const w = await c.cmd('hello', { protocol: 1, client: 'cli', clientVersion: 't', token: '' });
    expect(w.type).toBe('welcome');
    await c.close();

    const viaQuery = await TestClient.open(`${td.daemon.url}?token=${td.adminToken}`);
    const r = await viaQuery.cmd('hello', { protocol: 1, client: 'cli', clientVersion: 't', token: '' });
    expect(r).toMatchObject({ type: 'err', code: 'unauthorized' });
    expect((await viaQuery.closed).code).toBe(4401);
  });

  it('rejects an unsupported protocol version', async () => {
    td = await startTestDaemon();
    const c = await TestClient.open(td.daemon.url);
    const r = await c.cmd('hello', { protocol: 2, client: 'cli', clientVersion: 't', token: td.adminToken });
    expect(r).toMatchObject({ type: 'err', code: 'unsupported_version' });
    await c.closed;
  });
});

describe('abuse controls', () => {
  it('throttles an address after repeated failures (429 on the next upgrade)', async () => {
    td = await startTestDaemon({ throttle: new FailureThrottle(3, 60_000) });
    for (let i = 0; i < 3; i++) {
      const c = await TestClient.open(td.daemon.url);
      await c.cmd('hello', { protocol: 1, client: 'cli', clientVersion: 't', token: `bad-${i}` });
      await c.closed;
    }
    await expect(TestClient.open(td.daemon.url)).rejects.toMatchObject({ status: 429 });
    // Even the right token is refused from a throttled address.
    await expect(TestClient.connect(td.daemon.url, td.adminToken)).rejects.toMatchObject({ status: 429 });
  });

  it('rejects browser origins that are not allowlisted, accepts allowlisted and header-less clients', async () => {
    td = await startTestDaemon({ allowedOrigins: ['app://geode'] });
    await expect(TestClient.open(td.daemon.url, { headers: { origin: 'https://evil.example' } })).rejects.toMatchObject({ status: 403 });
    const ok = await TestClient.connect(td.daemon.url, td.adminToken, { headers: { origin: 'app://geode' } });
    await ok.close();
    const cli = await TestClient.connect(td.daemon.url, td.adminToken);
    await cli.close();
  });

  it('enforces scopes: read can attach but not open/send; control cannot creds.push', async () => {
    td = await startTestDaemon();
    const read = td.daemon.tokens.create('viewer', 'read').token;
    const control = td.daemon.tokens.create('driver', 'control').token;
    const admin = await TestClient.connect(td.daemon.url, td.adminToken);
    await admin.cmd('session.open', { threadId: 's1', spec: SPEC });

    const r = await TestClient.connect(td.daemon.url, read);
    expect((await r.cmd('attach', { ch: 't:s1', afterSeq: 0 })).type).toBe('ack');
    expect(await r.cmd('session.send', { threadId: 's1', text: 'hi', userMessageUuid: 'u' })).toMatchObject({ type: 'err', code: 'forbidden' });
    expect(await r.cmd('session.open', { threadId: 's2', spec: SPEC })).toMatchObject({ type: 'err', code: 'forbidden' });

    const c = await TestClient.connect(td.daemon.url, control);
    expect((await c.cmd('session.send', { threadId: 's1', text: 'hi', userMessageUuid: 'u' })).type).toBe('ack');
    expect(await c.cmd('creds.push', { kind: 'x', ttlSec: 1, fields: {} })).toMatchObject({ type: 'err', code: 'forbidden' });
    await Promise.all([admin.close(), r.close(), c.close()]);
  });

  it('closes live connections 4401 when their token is revoked', async () => {
    td = await startTestDaemon({ timings: { pingIntervalMs: 60 } });
    const { record, token } = td.daemon.tokens.create('temp', 'control');
    const c = await TestClient.connect(td.daemon.url, token);
    expect(td.daemon.tokens.revoke(record.id)).toBe(true);
    expect((await c.closed).code).toBe(4401);
    // And the revoked token cannot come back.
    const again = await TestClient.open(td.daemon.url);
    expect(await again.cmd('hello', { protocol: 1, client: 'cli', clientVersion: 't', token })).toMatchObject({ type: 'err', code: 'unauthorized' });
  });
});

describe('heartbeat', () => {
  it('keeps a responsive client and drops one that stops answering pings', async () => {
    td = await startTestDaemon({ timings: { pingIntervalMs: 60, pongTimeoutMs: 60 } });
    const good = await TestClient.connect(td.daemon.url, td.adminToken);
    const mute = await TestClient.connect(td.daemon.url, td.adminToken, { autoPong: false } as never);
    await mute.closed;
    expect(good.closeInfo).toBeNull();
    await sleep(200);
    expect(good.closeInfo).toBeNull();
    await good.close();
  });
});

describe('command idempotency', () => {
  it('returns the original ack for a retried cmdId instead of sending twice', async () => {
    td = await startTestDaemon();
    const a = await TestClient.connect(td.daemon.url, td.adminToken);
    await a.cmd('session.open', { threadId: 'idem', spec: SPEC });
    await a.cmd('attach', { ch: 't:idem', afterSeq: 0 });
    const first = await a.cmd('session.send', { threadId: 'idem', text: 'hello there', userMessageUuid: 'u1' }, 'cmd-fixed');
    expect(first.type).toBe('ack');
    await a.waitFor((f) => f.name === 'onDone');
    a.kill();
    await a.closed;

    // Flaky-network retry on a new connection with the same cmdId.
    const b = await TestClient.connect(td.daemon.url, td.adminToken);
    const retry = await b.cmd('session.send', { threadId: 'idem', text: 'hello there', userMessageUuid: 'u1' }, 'cmd-fixed');
    expect(retry).toEqual(first);
    await b.cmd('attach', { ch: 't:idem', afterSeq: 0 });
    await sleep(100);
    const dones = b.events().filter((e) => e.name === 'onDone');
    expect(dones).toHaveLength(1);
    await b.close();
  });
});

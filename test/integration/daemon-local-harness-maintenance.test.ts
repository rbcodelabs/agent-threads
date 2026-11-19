import { afterEach, expect, it } from 'vitest';
import { FakeHarnessSession } from '../../daemon/fakeHarness';
import { requestHarnessMaintenance } from '../../src/localDaemon/wiring';
import { randomHex } from '../../src/remote/randomId';
import { startTestDaemon, TestClient, SPEC, type TestDaemon } from '../helpers/daemonTestClient';

const daemons: TestDaemon[] = [];
afterEach(async () => {
  for (const item of daemons.splice(0).reverse()) await item.cleanup();
});

async function start(options: Parameters<typeof startTestDaemon>[0] = {}) {
  const item = await startTestDaemon({ localHarnessMaintenance: true, ...options });
  daemons.push(item);
  return item;
}

it('authorizes the maintenance owner and blocks new turns across daemon replacement', async () => {
  const first = await start();
  const control = first.daemon.tokens.create('managed', 'control').token;
  const readOnly = first.daemon.tokens.create('read-only', 'read').token;
  const id = randomHex(16);
  const endpoint = first.daemon.port;
  const client = await TestClient.connect(first.daemon.url, control);
  expect(await requestHarnessMaintenance(endpoint, readOnly, 'POST', id)).toBe('unknown');
  expect(await requestHarnessMaintenance(endpoint, control, 'GET')).toBe('idle');
  expect(await requestHarnessMaintenance(endpoint, control, 'POST', id)).toBe('idle');
  expect(await client.cmd('session.open', { threadId: 'thread', spec: SPEC })).toMatchObject({ type: 'err', code: 'conflict' });
  expect(await client.cmd('session.list')).toMatchObject({ type: 'ack' });
  await client.close();
  await first.daemon.stop();

  const replacement = await start({ dataDir: first.dataDir });
  const next = await TestClient.connect(replacement.daemon.url, control);
  expect(await next.cmd('session.open', { threadId: 'thread', spec: SPEC })).toMatchObject({ type: 'err', code: 'conflict' });
  expect(await requestHarnessMaintenance(replacement.daemon.port, control, 'DELETE', randomHex(16))).toBe('busy');
  expect(await requestHarnessMaintenance(replacement.daemon.port, control, 'DELETE', id)).toBe('idle');
  expect(await next.cmd('session.open', { threadId: 'thread', spec: SPEC })).toMatchObject({ type: 'ack' });
  await next.close();
});

it('refuses to acquire while a turn or asynchronous send preparation is active', async () => {
  let markPreparing!: () => void;
  let finishPreparing!: () => void;
  const startup = new Promise<void>((resolve) => { markPreparing = resolve; });
  const prepared = new Promise<void>((resolve) => { finishPreparing = resolve; });
  const item = await start({
    driverFactory: (ctx) => Object.assign(new FakeHarnessSession(ctx), {
      prepareForSend: async () => { markPreparing(); await prepared; },
    }),
  });
  const check = (method: 'GET' | 'POST' | 'DELETE', id?: string) =>
    requestHarnessMaintenance(item.daemon.port, item.adminToken, method, id);
  const client = await TestClient.connect(item.daemon.url, item.adminToken);
  const threadId = 'active-thread';
  expect(await client.cmd('session.open', { threadId, spec: SPEC })).toMatchObject({ type: 'ack' });
  const preparing = client.cmd('session.prepareForSend', { threadId, text: 'hello' });
  await startup;
  try {
    expect(await check('POST', randomHex(16))).toBe('busy');
  } finally {
    finishPreparing();
    await preparing;
  }
  expect(await client.cmd('session.send', { threadId, text: '/hang', userMessageUuid: 'm1' })).toMatchObject({ type: 'ack' });
  expect(await check('POST', randomHex(16))).toBe('busy');
  expect(await client.cmd('session.interrupt', { threadId })).toMatchObject({ type: 'ack' });
  const lease = randomHex(16);
  expect(await check('POST', lease)).toBe('idle');
  expect(await client.cmd('session.send', { threadId, text: 'hello', userMessageUuid: 'm2' })).toMatchObject({ type: 'err', code: 'conflict' });
  expect(await check('DELETE', lease)).toBe('idle');
  await client.close();
});

it('does not expose maintenance on ordinary remote daemons', async () => {
  const item = await start({ localHarnessMaintenance: false });
  expect(await requestHarnessMaintenance(item.daemon.port, item.adminToken, 'GET')).toBe('unsupported');
});

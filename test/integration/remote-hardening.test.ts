/**
 * Plugin-side hardening (review finding J): wire-supplied callback names, retryable conflicts,
 * unconfirmed sends, and instance ids in `hello`.
 */
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { HarnessSessionOptions } from '../../src/HarnessSession';
import { CALLBACK_DISPOSITION } from '../../src/protocol';
import { DaemonClient, DaemonCommandError, type WebSocketFactory } from '../../src/remote/DaemonClient';
import { RemoteHarnessSession, isEventCallbackName } from '../../src/remote/RemoteHarnessSession';
import { forkBlockedReason } from '../../src/remote/threadLocation';
import type { Thread } from '../../src/types';
import { SPEC, TestClient, startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';

const wsFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as ReturnType<WebSocketFactory>;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const daemon = async (opts: Parameters<typeof startTestDaemon>[0] = {}): Promise<TestDaemon> => {
  const td = await startTestDaemon(opts);
  cleanups.push(() => td.cleanup());
  return td;
};
const client = (td: TestDaemon, extra: Partial<ConstructorParameters<typeof DaemonClient>[0]> = {}): DaemonClient => {
  const c = new DaemonClient({
    url: td.daemon.url, getToken: () => td.adminToken, createSocket: wsFactory, clientVersion: '0.62.2',
    backoffMs: [20, 40], ackDebounceMs: 20, idleProbeMs: 60_000, ...extra,
  });
  cleanups.push(() => c.dispose());
  return c;
};
const thread = (id: string): Thread => ({
  id, title: id, cwd: '/srv/workspaces/x', messages: [], createdAt: 0, updatedAt: 0, status: 'waiting', agentHarness: 'claude',
  remote: { daemonId: 'd1', ownership: 'client', remoteCwd: '/srv/workspaces/x', lastSeq: 0, ownerClientId: 'geode-test' },
}) as Thread;

function callbacks(): { cb: SessionCallbacks; calls: string[]; errors: Error[]; notes: string[] } {
  const calls: string[] = [];
  const errors: Error[] = [];
  const notes: string[] = [];
  const cb: Record<string, unknown> = {};
  for (const name of Object.keys(CALLBACK_DISPOSITION)) cb[name] = () => { calls.push(name); };
  cb.onError = (e: Error) => { calls.push('onError'); errors.push(e); };
  cb.onNotification = (m: string) => { notes.push(m); };
  cb.onPermissionRequest = () => new Promise(() => undefined);
  cb.onAskUserQuestion = () => new Promise(() => undefined);
  return { cb: cb as unknown as SessionCallbacks, calls, errors, notes };
}
const opts = (cb: SessionCallbacks): HarnessSessionOptions => ({ cwd: '/srv/workspaces/x', permissionMode: 'default', extraEnvRaw: '', callbacks: cb });
async function until(pred: () => boolean, what: string, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('J. only protocol events are dispatched to the callbacks object', () => {
  it('isEventCallbackName accepts exactly the names classified as events', () => {
    for (const [name, kind] of Object.entries(CALLBACK_DISPOSITION)) expect(isEventCallbackName(name), name).toBe(kind === 'event');
    for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'bogus', '', 7, null, undefined]) expect(isEventCallbackName(bad), String(bad)).toBe(false);
  });

  it('a journaled event naming a non-event function on the callbacks object is ignored', async () => {
    const td = await daemon();
    const c = client(td);
    const t = thread('inj');
    const { cb, calls, notes } = callbacks();
    const session = new RemoteHarnessSession(c, t);
    await session.start(opts(cb));
    // Append events the plugin must NOT turn into calls: onRawEvent / onStreamReset are not on the wire,
    // onPermissionRequest is a request, and `constructor` is not a callback at all.
    const journal = td.daemon.threads.journalFor('inj')!;
    for (const name of ['onRawEvent', 'onStreamReset', 'onPermissionRequest', 'constructor', 'toString']) journal.append({ name, args: [] } as never);
    journal.append({ name: 'onNotification', args: ['hello', 'low'] } as never);
    await until(() => notes.includes('hello'), 'the legitimate event');
    expect(calls).not.toContain('onRawEvent');
    expect(calls).not.toContain('onStreamReset');
    expect(calls).not.toContain('onPermissionRequest');
    session.close();
  });
});

describe('J. a retryable conflict is retried, not surfaced as a failed turn', () => {
  it('waits out a full daemon (maxConcurrentTurns) and then sends the same message', async () => {
    const td = await daemon({ config: { maxConcurrentTurns: 1 } });
    // A second client occupies the only turn slot with a long fake turn.
    const other = await TestClient.connect(td.daemon.url, td.adminToken, {}, { instanceId: 'other' });
    cleanups.push(() => other.close().catch(() => {}));
    await other.cmd('session.open', { threadId: 'busy', spec: SPEC });
    await other.cmd('session.send', { threadId: 'busy', text: '/tokens 20 burst=1 delay=25', userMessageUuid: 'b1' });

    const c = client(td);
    const t = thread('waits');
    const { cb, calls, errors } = callbacks();
    const session = new RemoteHarnessSession(c, t, { retryDelaysMs: [30, 30, 60, 120, 240, 480, 960] });
    await session.start(opts(cb));
    session.send('/tokens 3', undefined, 'mine');
    await until(() => calls.includes('onDone'), 'the retried turn to finish', 10_000);
    expect(errors).toEqual([]);
    expect(session.turnInFlight).toBe(false);
    session.close();
  });

  it('gives up after the last delay with the daemon\'s own message', async () => {
    const td = await daemon({ config: { maxConcurrentTurns: 1 } });
    const other = await TestClient.connect(td.daemon.url, td.adminToken, {}, { instanceId: 'other' });
    cleanups.push(() => other.close().catch(() => {}));
    await other.cmd('session.open', { threadId: 'busy', spec: SPEC });
    await other.cmd('session.send', { threadId: 'busy', text: '/permission', userMessageUuid: 'b1' }); // blocks forever

    const c = client(td);
    const { cb, errors } = callbacks();
    const session = new RemoteHarnessSession(c, thread('gives-up'), { retryDelaysMs: [10, 10] });
    await session.start(opts(cb));
    session.send('hi', undefined, 'mine');
    await until(() => errors.length > 0, 'the turn to fail');
    expect(errors[0].message).toMatch(/maxConcurrentTurns/);
    expect(session.turnInFlight).toBe(false);
    session.close();
  });

  it('interrupt cancels a send that is waiting for a slot', async () => {
    const td = await daemon({ config: { maxConcurrentTurns: 1 } });
    const other = await TestClient.connect(td.daemon.url, td.adminToken, {}, { instanceId: 'other' });
    cleanups.push(() => other.close().catch(() => {}));
    await other.cmd('session.open', { threadId: 'busy', spec: SPEC });
    await other.cmd('session.send', { threadId: 'busy', text: '/permission', userMessageUuid: 'b1' });

    const c = client(td);
    const { cb, errors } = callbacks();
    const session = new RemoteHarnessSession(c, thread('cancel'), { retryDelaysMs: [40, 40, 40, 40, 40, 40] });
    await session.start(opts(cb));
    session.send('hi', undefined, 'mine');
    await new Promise((r) => setTimeout(r, 60));
    await session.interrupt();
    expect(session.turnInFlight).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(errors).toEqual([]);
    expect(td.daemon.threads.list().find((e) => e.threadId === 'cancel')?.turnInFlight).toBeFalsy();
    session.close();
  });
});

describe('J. a send whose ack never came back is "unconfirmed", not "not delivered"', () => {
  const fakeClient = (rejectWith: Error): DaemonClient => ({
    command: async (type: string) => {
      if (type === 'session.open') return { epoch: 'e', created: true };
      throw rejectWith;
    },
    subscribe: () => ({ close() {}, ack() {} }),
  }) as unknown as DaemonClient;

  async function failWith(err: Error): Promise<Error> {
    const { cb, errors } = callbacks();
    const session = new RemoteHarnessSession(fakeClient(err), thread('f'));
    await session.start(opts(cb));
    session.send('hi', undefined, 'u');
    await until(() => errors.length > 0, 'failure');
    return errors[0];
  }

  it('transmitted + timed out: says unconfirmed and never claims non-delivery', async () => {
    const e = await failWith(new DaemonCommandError('timeout', 'session.send timed out', false, true));
    expect(e.message).toMatch(/did not confirm/);
    expect(e.message).not.toMatch(/not delivered/i);
  });

  it('transmitted then unreachable is unconfirmed too', async () => {
    const e = await failWith(new DaemonCommandError('unreachable', 'daemon unreachable', false, true));
    expect(e.message).not.toMatch(/not delivered/i);
  });

  it('never left this process: "not delivered" is accurate', async () => {
    const e = await failWith(new DaemonCommandError('unreachable', 'daemon unreachable', false, false));
    expect(e.message).toMatch(/not delivered/);
  });

  it('DaemonClient marks a command unconfirmed only once it was written to a socket', async () => {
    const td = await daemon();
    // A proxy-less trick: a client pointed at a dead port never transmits.
    const dead = new DaemonClient({ url: 'ws://127.0.0.1:9', getToken: () => 'x', createSocket: wsFactory, clientVersion: '0.62.2', backoffMs: [20], commandTimeoutMs: 120, idleProbeMs: 60_000 });
    cleanups.push(() => dead.dispose());
    const never = await dead.command('session.list', {}).catch((e: unknown) => e);
    expect(never).toBeInstanceOf(DaemonCommandError);
    expect((never as DaemonCommandError).unconfirmed).toBe(false);
    void td;
  });
});

describe('A (plugin). hello carries the install id', () => {
  it('two DaemonClients with different instance ids sharing a token: only the first writes', async () => {
    const td = await daemon();
    const a = client(td, { instanceId: 'install-a' });
    const b = client(td, { instanceId: 'install-b' });
    const ta = thread('shared');
    const { cb: cba } = callbacks();
    const sa = new RemoteHarnessSession(a, ta);
    await sa.start(opts(cba));

    const err = await b.command('session.send', { threadId: 'shared', text: 'x', userMessageUuid: 'u' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonCommandError);
    expect((err as DaemonCommandError).code).toBe('conflict');
    sa.close();
  });
});

describe('J. fork is refused for remote threads', () => {
  it('explains why, naming the host; local threads are not blocked', () => {
    expect(forkBlockedReason({ remote: undefined })).toBeUndefined();
    const msg = forkBlockedReason({ remote: { daemonId: 'd1', ownership: 'client', remoteCwd: '/x', lastSeq: 0, ownerClientId: 'c' } }, () => 'my-server');
    expect(msg).toMatch(/not available for remote threads/);
    expect(msg).toContain('my-server');
  });
});

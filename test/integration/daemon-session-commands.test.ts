/**
 * The session command surface and the request/resolve round trips, driven over
 * real sockets against the scripted fake harness (the Claude-specific mapping
 * is covered in daemon-claude-host.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SPEC, TestClient, sleep, startTestDaemon, type Frame, type TestDaemon } from '../helpers/daemonTestClient';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const track = async (opts?: Parameters<typeof startTestDaemon>[0]): Promise<TestDaemon> => {
  const td = await startTestDaemon(opts);
  cleanups.push(() => td.cleanup());
  return td;
};
const connect = async (td: TestDaemon, token = td.adminToken): Promise<TestClient> => {
  const c = await TestClient.connect(td.daemon.url, token);
  cleanups.push(() => c.close().catch(() => {}));
  return c;
};

const stateOf = (c: TestClient): Frame | undefined => c.events().filter((f) => f.name === 'session.state').at(-1);

describe('request / resolve round trips', () => {
  const KINDS = [
    { script: '/permission', event: 'permission_request', resolve: 'resolve.permission', payload: { allow: true } },
    { script: '/question', event: 'question_request', resolve: 'resolve.question', payload: { answers: { 'Pick one?': 'a' } } },
    { script: '/plan', event: 'plan_ready', resolve: 'resolve.plan', payload: { approve: true, editedPlan: 'edited' } },
    { script: '/elicitation', event: 'elicitation_request', resolve: 'resolve.elicitation', payload: { result: { action: 'accept' } } },
  ] as const;

  for (const k of KINDS) {
    it(`${k.event}: daemon-owned id, resolvable once, turn continues with the answer`, async () => {
      const td = await track();
      const c = await connect(td);
      await c.cmd('session.open', { threadId: 't', spec: SPEC });
      await c.cmd('attach', { ch: 't:t', afterSeq: 0 });
      await c.cmd('session.send', { threadId: 't', text: k.script, userMessageUuid: 'u' });
      const req = await c.waitFor((f) => f.name === k.event);
      const requestId = req.args.requestId as string;
      expect(requestId).toMatch(/\w+-\d+|[0-9a-f-]{36}/);
      expect(stateOf(c)!.args).toMatchObject({ turnInFlight: true, hasPendingPermission: true });

      expect((await c.cmd(k.resolve, { threadId: 't', requestId, ...k.payload })).type).toBe('ack');
      const resolved = await c.waitFor((f) => f.name === 'request_resolved' && f.args.requestId === requestId);
      expect(resolved.args).toMatchObject({ outcome: 'resolved' });
      const done = await c.waitFor((f) => f.name === 'onMessage');
      expect(done.args[0]).toContain(`${k.script.slice(1)} resolved`);
      await c.waitFor((f) => f.name === 'onDone');

      // First resolver wins; a late duplicate learns the request is gone.
      expect(await c.cmd(k.resolve, { threadId: 't', requestId, ...k.payload })).toMatchObject({ type: 'err', code: 'not_found' });
    });
  }

  it('rejects an answer of the wrong kind or with an unknown id without disturbing the turn', async () => {
    const td = await track();
    const c = await connect(td);
    await c.cmd('session.open', { threadId: 't', spec: SPEC });
    await c.cmd('attach', { ch: 't:t', afterSeq: 0 });
    await c.cmd('session.send', { threadId: 't', text: '/permission', userMessageUuid: 'u' });
    const req = await c.waitFor((f) => f.name === 'permission_request');
    expect(await c.cmd('resolve.question', { threadId: 't', requestId: req.args.requestId, answers: {} })).toMatchObject({ type: 'err', code: 'not_found' });
    expect(await c.cmd('resolve.permission', { threadId: 't', requestId: 'nope', allow: true })).toMatchObject({ type: 'err', code: 'not_found' });
    // "Always allow" is not implemented: the ack says so and the journal does not claim a standing rule.
    expect(await c.cmd('resolve.permission', { threadId: 't', requestId: req.args.requestId, allow: false, alwaysAllow: true })).toMatchObject({ type: 'ack', result: { alwaysAllow: 'not_supported' } });
    const resolved = await c.waitFor((f) => f.name === 'request_resolved');
    expect(resolved.args).toMatchObject({ outcome: 'resolved' });
    expect(resolved.args).not.toHaveProperty('alwaysAllow');
  });

  it('open-tab resolution is refused: daemon sessions cannot create Geode threads', async () => {
    const td = await track();
    const c = await connect(td);
    await c.cmd('session.open', { threadId: 't', spec: SPEC });
    expect(await c.cmd('resolve.openTab', { threadId: 't', requestId: 'x', openedThreadId: 'a', title: 'b' }))
      .toMatchObject({ type: 'err', code: 'unknown_command' });
  });

  it('interrupt cancels the open request and ends the turn', async () => {
    const td = await track();
    const c = await connect(td);
    await c.cmd('session.open', { threadId: 't', spec: SPEC });
    await c.cmd('attach', { ch: 't:t', afterSeq: 0 });
    await c.cmd('session.send', { threadId: 't', text: '/permission', userMessageUuid: 'u' });
    const req = await c.waitFor((f) => f.name === 'permission_request');
    expect((await c.cmd('session.interrupt', { threadId: 't' })).type).toBe('ack');
    expect((await c.waitFor((f) => f.name === 'request_resolved')).args).toMatchObject({ requestId: req.args.requestId, outcome: 'canceled' });
    await c.waitFor((f) => f.name === 'onInterrupted');
    await sleep(30);
    expect(stateOf(c)!.args).toMatchObject({ turnInFlight: false, hasPendingPermission: false });
  });
});

describe('open requests survive a lost client (design 3.6)', () => {
  it('re-delivers a still-open request flagged `reopen` when the cursor is already past it, and it stays resolvable', async () => {
    const td = await track();
    const a = await connect(td);
    await a.cmd('session.open', { threadId: 't', spec: SPEC });
    await a.cmd('attach', { ch: 't:t', afterSeq: 0 });
    await a.cmd('session.send', { threadId: 't', text: '/permission', userMessageUuid: 'u' });
    const req = await a.waitFor((f) => f.name === 'permission_request');
    const cursor = a.events().at(-1)!.seq as number; // client saw everything up to here
    a.kill();
    await a.closed;

    const b = await connect(td);
    const attach = await b.cmd('attach', { ch: 't:t', afterSeq: cursor });
    expect(attach.result).toMatchObject({ controller: true });
    const again = await b.waitFor((f) => f.name === 'permission_request');
    expect(again).toMatchObject({ seq: req.seq, reopen: true });
    expect(again.args.requestId).toBe(req.args.requestId);

    expect((await b.cmd('resolve.permission', { threadId: 't', requestId: again.args.requestId, allow: true })).type).toBe('ack');
    await b.waitFor((f) => f.name === 'onDone');
  });

  it('a normal replay (cursor before the request) delivers it once, unflagged', async () => {
    const td = await track();
    const a = await connect(td);
    await a.cmd('session.open', { threadId: 't', spec: SPEC });
    await a.cmd('session.send', { threadId: 't', text: '/permission', userMessageUuid: 'u' });
    await a.cmd('attach', { ch: 't:t', afterSeq: 0 });
    await a.waitFor((f) => f.name === 'permission_request');
    await sleep(30);
    expect(a.events().filter((f) => f.name === 'permission_request')).toHaveLength(1);
    expect(a.events().find((f) => f.name === 'permission_request')!.reopen).toBeUndefined();
  });

  it('is not re-delivered once resolved', async () => {
    const td = await track();
    const a = await connect(td);
    await a.cmd('session.open', { threadId: 't', spec: SPEC });
    await a.cmd('attach', { ch: 't:t', afterSeq: 0 });
    await a.cmd('session.send', { threadId: 't', text: '/permission', userMessageUuid: 'u' });
    const req = await a.waitFor((f) => f.name === 'permission_request');
    await a.cmd('resolve.permission', { threadId: 't', requestId: req.args.requestId, allow: true });
    await a.waitFor((f) => f.name === 'onDone');
    const cursor = a.events().at(-1)!.seq as number;
    a.kill();
    const b = await connect(td);
    await b.cmd('attach', { ch: 't:t', afterSeq: cursor - 2 });
    await sleep(60);
    expect(b.events().some((f) => f.name === 'permission_request')).toBe(false);
  });

  it('a daemon restart expires the request: it cannot be resolved, and the turn is closed as daemon_restarted', async () => {
    const first = await track();
    const a = await connect(first);
    await a.cmd('session.open', { threadId: 't', spec: SPEC });
    await a.cmd('attach', { ch: 't:t', afterSeq: 0 });
    await a.cmd('session.send', { threadId: 't', text: '/permission', userMessageUuid: 'u' });
    const req = await a.waitFor((f) => f.name === 'permission_request');
    a.kill();
    await first.daemon.crash();

    const second = await track({ dataDir: first.dataDir });
    const b = await connect(second);
    await b.cmd('attach', { ch: 't:t', afterSeq: 0 });
    await b.waitFor((f) => f.name === 'onInterrupted');
    const resolved = b.events().find((f) => f.name === 'request_resolved' && f.args.requestId === req.args.requestId);
    expect(resolved!.args).toMatchObject({ outcome: 'expired' });
    expect(b.events().find((f) => f.name === 'onError')!.args[0]).toMatchObject({ name: 'daemon_restarted' });
    expect(await b.cmd('resolve.permission', { threadId: 't', requestId: req.args.requestId, allow: true })).toMatchObject({ type: 'err', code: 'not_found' });
    // Nothing is replayed as open after the expiry.
    const c = await connect(second);
    await c.cmd('attach', { ch: 't:t', afterSeq: b.events().at(-1)!.seq });
    await sleep(40);
    expect(c.events().some((f) => f.name === 'permission_request')).toBe(false);
  });
});

describe('command surface', () => {
  it('setModel / setPermissionMode / getContextUsage / mcpServerStatus / getUsageSnapshot / prepareForSend', async () => {
    const td = await track();
    const c = await connect(td);
    await c.cmd('session.open', { threadId: 't', spec: SPEC });
    expect((await c.cmd('session.setModel', { threadId: 't', model: 'claude-haiku-4-5' })).type).toBe('ack');
    expect((await c.cmd('session.setPermissionMode', { threadId: 't', mode: 'plan' })).type).toBe('ack');
    expect((await c.cmd('session.getContextUsage', { threadId: 't' })).result.usage).toMatchObject({ model: 'claude-haiku-4-5' });
    expect((await c.cmd('session.mcpServerStatus', { threadId: 't' })).result.servers).toEqual([{ name: 'fake-mcp', status: 'connected' }]);
    expect((await c.cmd('session.getUsageSnapshot', { threadId: 't', includeAccountUsage: true })).result.snapshot).toMatchObject({ includeAccountUsage: true });
    expect((await c.cmd('session.prepareForSend', { threadId: 't', text: 'x' })).type).toBe('ack');
    // Child-agent controls are optional; the fake has none.
    expect(await c.cmd('session.sendAgentMessage', { threadId: 't', nativeAgentId: 'a', text: 'x' })).toMatchObject({ type: 'err', code: 'unknown_command' });
  });

  it('getters on a read-scope token work; mutations do not', async () => {
    const td = await track();
    const read = td.daemon.tokens.create('viewer', 'read').token;
    const admin = await connect(td);
    await admin.cmd('session.open', { threadId: 't', spec: SPEC });
    const r = await connect(td, read);
    expect((await r.cmd('session.getContextUsage', { threadId: 't' })).type).toBe('ack');
    expect(await r.cmd('session.setModel', { threadId: 't', model: 'x' })).toMatchObject({ type: 'err', code: 'forbidden' });
    expect((await r.cmd('attach', { ch: 't:t', afterSeq: 0 })).result.controller).toBe(false);
  });

  it('unknown threads are not_found', async () => {
    const td = await track();
    const c = await connect(td);
    for (const [type, extra] of [['session.send', { text: 'x', userMessageUuid: 'u' }], ['session.interrupt', {}], ['session.setModel', { model: 'm' }], ['session.getContextUsage', {}], ['session.close', {}], ['session.detach', {}]] as const) {
      expect(await c.cmd(type, { threadId: 'ghost', ...extra }), type).toMatchObject({ type: 'err', code: 'not_found' });
    }
  });

  it('session.list reports live state', async () => {
    const td = await track();
    const c = await connect(td);
    await c.cmd('session.open', { threadId: 't', spec: SPEC });
    await c.cmd('session.send', { threadId: 't', text: '/hang', userMessageUuid: 'u' });
    const list = (await c.cmd('session.list')).result.threads as Array<Record<string, unknown>>;
    expect(list).toEqual([expect.objectContaining({ threadId: 't', open: true, turnInFlight: true, cwd: SPEC.cwd, nativeSessionId: 'fake-t' })]);
  });

  it('session.state carries cwd and canIdleReap', async () => {
    const td = await track();
    const c = await connect(td);
    await c.cmd('session.open', { threadId: 't', spec: SPEC });
    await c.cmd('attach', { ch: 't:t', afterSeq: 0 });
    await c.cmd('session.send', { threadId: 't', text: '/hang', userMessageUuid: 'u' });
    await c.waitFor((f) => f.name === 'session.state' && f.args.turnInFlight === true);
    expect(stateOf(c)!.args).toMatchObject({ turnInFlight: true, canIdleReap: false, cwd: SPEC.cwd });
    await c.cmd('session.interrupt', { threadId: 't' });
    await c.waitFor((f) => f.name === 'session.state' && f.args.turnInFlight === false && f.args.canIdleReap === true);
  });
});

describe('detach, close, cold resume', () => {
  it('detach leaves a running turn running; a later attach sees it finish', async () => {
    const td = await track();
    const a = await connect(td);
    await a.cmd('session.open', { threadId: 't', spec: SPEC });
    await a.cmd('attach', { ch: 't:t', afterSeq: 0 });
    await a.cmd('session.send', { threadId: 't', text: '/permission', userMessageUuid: 'u' });
    const req = await a.waitFor((f) => f.name === 'permission_request');
    expect((await a.cmd('session.detach', { threadId: 't' })).type).toBe('ack');
    const seen = a.events().length;
    await sleep(40);
    expect(a.events().length).toBe(seen); // no more events after detach

    const b = await connect(td);
    await b.cmd('attach', { ch: 't:t', afterSeq: 0 });
    await b.cmd('resolve.permission', { threadId: 't', requestId: req.args.requestId, allow: true });
    await b.waitFor((f) => f.name === 'onDone');
  });

  it('close stops the session (turn closed as interrupted) and the next send cold-resumes the same native session', async () => {
    const td = await track();
    const c = await connect(td);
    await c.cmd('session.open', { threadId: 't', spec: SPEC });
    await c.cmd('attach', { ch: 't:t', afterSeq: 0 });
    await c.cmd('session.send', { threadId: 't', text: '/hang', userMessageUuid: 'u' });
    await c.waitFor((f) => f.name === 'onToken');
    expect((await c.cmd('session.close', { threadId: 't' })).type).toBe('ack');
    await c.waitFor((f) => f.name === 'onInterrupted');
    const closed = await c.waitFor((f) => f.name === 'session.state' && f.args.closed === 'client');
    expect(closed.args).toMatchObject({ turnInFlight: false, canIdleReap: true });
    expect(((await c.cmd('session.list')).result.threads as Array<{ open: boolean }>)[0].open).toBe(false);

    expect((await c.cmd('session.send', { threadId: 't', text: 'again', userMessageUuid: 'u2' })).type).toBe('ack');
    await c.waitFor((f) => f.name === 'onMessage' && String(f.args[0]).includes('again'));
    expect(((await c.cmd('session.list')).result.threads as Array<{ open: boolean }>)[0].open).toBe(true);
  });

  it('setModel on a stopped session is remembered for the next resume', async () => {
    const td = await track();
    const c = await connect(td);
    await c.cmd('session.open', { threadId: 't', spec: SPEC });
    await c.cmd('session.close', { threadId: 't' });
    expect((await c.cmd('session.setModel', { threadId: 't', model: 'remembered' })).type).toBe('ack');
    await c.cmd('session.send', { threadId: 't', text: 'x', userMessageUuid: 'u' });
    expect((await c.cmd('session.getContextUsage', { threadId: 't' })).result.usage).toMatchObject({ model: 'remembered' });
  });
});

describe('idle reaper', () => {
  it('stops an idle session with a journaled notice and cold-resumes it on the next send; never reaps a busy one', async () => {
    const td = await track({ config: { idleReapMinutes: 1 } });
    const c = await connect(td);
    await c.cmd('session.open', { threadId: 'idle', spec: SPEC });
    await c.cmd('session.open', { threadId: 'busy', spec: SPEC });
    await c.cmd('attach', { ch: 't:idle', afterSeq: 0 });
    await c.cmd('session.send', { threadId: 'busy', text: '/hang', userMessageUuid: 'u' });

    const later = Date.now() + 2 * 60_000;
    expect(td.daemon.threads.reapIdle(Date.now())).toEqual([]); // not idle long enough
    expect(td.daemon.threads.reapIdle(later)).toEqual(['idle']);
    const state = await c.waitFor((f) => f.name === 'session.state' && f.args.closed === 'idle');
    expect(state.args).toMatchObject({ turnInFlight: false });

    const byId = Object.fromEntries(((await c.cmd('session.list')).result.threads as Array<{ threadId: string; open: boolean }>).map((t) => [t.threadId, t.open]));
    expect(byId).toEqual({ idle: false, busy: true });

    await c.cmd('session.send', { threadId: 'idle', text: 'wake', userMessageUuid: 'u2' });
    await c.waitFor((f) => f.name === 'onMessage' && String(f.args[0]).includes('wake'));
  });

  it('a thread waiting on a human is not idle', async () => {
    const td = await track({ config: { idleReapMinutes: 1 } });
    const c = await connect(td);
    await c.cmd('session.open', { threadId: 't', spec: SPEC });
    await c.cmd('attach', { ch: 't:t', afterSeq: 0 });
    await c.cmd('session.send', { threadId: 't', text: '/permission', userMessageUuid: 'u' });
    await c.waitFor((f) => f.name === 'permission_request');
    expect(td.daemon.threads.reapIdle(Date.now() + 3_600_000)).toEqual([]);
  });

  it('the timer reaps on its own, without a client asking', async () => {
    const td = await track({ idleReapMs: 60, reapCheckMs: 20 });
    const c = await connect(td);
    await c.cmd('session.open', { threadId: 't', spec: SPEC });
    await c.cmd('attach', { ch: 't:t', afterSeq: 0 });
    const state = await c.waitFor((f) => f.name === 'session.state' && f.args.closed === 'idle', 3000, 'idle reap');
    expect(state.args.turnInFlight).toBe(false);
  });
});

describe('concurrency cap', () => {
  it('refuses a send beyond maxConcurrentTurns with a retryable conflict, and admits it once a slot frees', async () => {
    const td = await track({ config: { maxConcurrentTurns: 1 } });
    const c = await connect(td);
    await c.cmd('session.open', { threadId: 'a', spec: SPEC });
    await c.cmd('session.open', { threadId: 'b', spec: SPEC });
    expect((await c.cmd('session.send', { threadId: 'a', text: '/hang', userMessageUuid: 'u1' })).type).toBe('ack');
    const refused = await c.cmd('session.send', { threadId: 'b', text: 'hi', userMessageUuid: 'u2' });
    expect(refused).toMatchObject({ type: 'err', code: 'conflict', retryable: true });
    expect(refused.message).toMatch(/maxConcurrentTurns/);
    await c.cmd('session.interrupt', { threadId: 'a' });
    expect((await c.cmd('session.send', { threadId: 'b', text: 'hi', userMessageUuid: 'u3' })).type).toBe('ack');
  });

  it('a second send on the same busy thread is a plain conflict', async () => {
    const td = await track();
    const c = await connect(td);
    await c.cmd('session.open', { threadId: 'a', spec: SPEC });
    await c.cmd('session.send', { threadId: 'a', text: '/hang', userMessageUuid: 'u1' });
    expect(await c.cmd('session.send', { threadId: 'a', text: 'x', userMessageUuid: 'u2' })).toMatchObject({ type: 'err', code: 'conflict' });
  });
});

describe('single read-write client per thread', () => {
  it('a second client (other token) observes but cannot mutate; the seat frees on detach or disconnect', async () => {
    const td = await track();
    const t2 = td.daemon.tokens.create('second', 'control').token;
    const one = await connect(td);
    const two = await connect(td, t2);
    await one.cmd('session.open', { threadId: 't', spec: SPEC });

    const attach = await two.cmd('attach', { ch: 't:t', afterSeq: 0 });
    expect(attach.result.controller).toBe(false);
    for (const [type, extra] of [['session.send', { text: 'x', userMessageUuid: 'u' }], ['session.interrupt', {}], ['session.setModel', { model: 'm' }], ['resolve.permission', { requestId: 'r', allow: true }]] as const) {
      expect(await two.cmd(type, { threadId: 't', ...extra }), type).toMatchObject({ type: 'err', code: 'conflict' });
    }
    // The observer still sees the stream.
    await one.cmd('session.send', { threadId: 't', text: 'hello', userMessageUuid: 'u' });
    await two.waitFor((f) => f.name === 'onDone');

    // Disconnect of the holder frees the seat.
    one.kill();
    await one.closed;
    await sleep(30);
    expect((await two.cmd('session.send', { threadId: 't', text: 'mine now', userMessageUuid: 'u2' })).type).toBe('ack');
  });

  it('the same token reconnecting takes its seat back immediately from its own stale connection', async () => {
    const td = await track();
    const stale = await connect(td);
    await stale.cmd('session.open', { threadId: 't', spec: SPEC });
    // The stale socket is not closed: this is the "half-open TCP" case a laptop resume creates.
    const fresh = await connect(td);
    expect((await fresh.cmd('attach', { ch: 't:t', afterSeq: 0 })).result.controller).toBe(true);
    expect((await fresh.cmd('session.send', { threadId: 't', text: 'x', userMessageUuid: 'u' })).type).toBe('ack');
  });

  it('only the controller\'s acks bound retention', async () => {
    const td = await track();
    const t2 = td.daemon.tokens.create('second', 'control').token;
    const one = await connect(td);
    const two = await connect(td, t2);
    await one.cmd('session.open', { threadId: 't', spec: SPEC });
    await one.cmd('session.send', { threadId: 't', text: 'x', userMessageUuid: 'u' });
    await sleep(50);
    const lastSeq = td.daemon.threads.journalFor('t')!.lastSeq;
    await two.cmd('attach', { ch: 't:t', afterSeq: 0 });
    await two.cmd('ack', { ch: 't:t', seq: lastSeq });
    expect(td.daemon.threads.journalFor('t')!.ackedSeq).toBe(0);
    await one.cmd('ack', { ch: 't:t', seq: lastSeq });
    expect(td.daemon.threads.journalFor('t')!.ackedSeq).toBe(lastSeq);
  });
});

describe('welcome', () => {
  it('advertises the session host and the resume features', async () => {
    const td = await track();
    const raw = await TestClient.open(td.daemon.url);
    const welcome = await raw.cmd('hello', { protocol: 1, client: 'cli', clientVersion: 't', token: td.adminToken });
    expect(welcome.capabilities).toEqual(expect.arrayContaining(['harness.fake', 'requests.reopen', 'session.cold_resume']));
    await raw.close();
  });
});

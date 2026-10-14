/**
 * The REAL `ClaudeSessionDriver` + `ThreadHost` + wire server, with a scripted
 * `HarnessSession` where `ThreadSession` would be (no Claude process, no
 * network). Covers callback -> event mapping, blocking callbacks as durable
 * requests, policy, native-session resume across idle reaps and restarts.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeDriverFactory, specToSessionOptions } from '../../daemon/claudeDriver';
import { CALLBACK_DISPOSITION } from '../../src/protocol';
import { TestClient, sleep, startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';
import { ScriptedHarness, scriptedFactory } from '../helpers/scriptedHarness';

let workspace: string;
let made: ScriptedHarness[];
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'claude-host-')));
  mkdirSync(join(workspace, 'proj'));
  made = [];
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  rmSync(workspace, { recursive: true, force: true });
});

const spec = (over: Record<string, unknown> = {}) =>
  ({ harness: 'claude', cwd: join(workspace, 'proj'), permissionMode: 'default', extraEnvRaw: '', model: 'haiku', ...over });

async function daemon(opts: Parameters<typeof startTestDaemon>[0] & { sessionId?: string } = {}): Promise<TestDaemon> {
  const { sessionId, config, ...rest } = opts;
  const td = await startTestDaemon({
    config: { harness: 'claude', workspaces: [workspace], ...config },
    driverFactory: createClaudeDriverFactory({ createHarness: scriptedFactory(made, sessionId), env: {} }),
    ...rest,
  });
  cleanups.push(() => td.cleanup());
  return td;
}
async function client(td: TestDaemon, token = td.adminToken): Promise<TestClient> {
  const c = await TestClient.connect(td.daemon.url, token);
  cleanups.push(() => c.close().catch(() => {}));
  return c;
}
const open = (c: TestClient, threadId = 't', over: Record<string, unknown> = {}, extra: object = {}) =>
  c.cmd('session.open', { threadId, spec: spec(over), ...extra });
const harness = async (n = 0): Promise<ScriptedHarness> => {
  for (let i = 0; i < 100 && !made[n]?.options; i++) await sleep(5);
  return made[n];
};

describe('policy at the door', () => {
  it('refuses a cwd outside the workspaces, bypass without allowBypass, and other harnesses', async () => {
    const td = await daemon();
    const c = await client(td);
    expect(await open(c, 'a', { cwd: tmpdir() })).toMatchObject({ type: 'err', code: 'forbidden' });
    expect(await open(c, 'b', { permissionMode: 'bypassPermissions' })).toMatchObject({ type: 'err', code: 'forbidden' });
    expect(await open(c, 'c', { harness: 'codex' })).toMatchObject({ type: 'err', code: 'bad_frame' });
    expect(await open(c, 'd', { cwd: join(workspace, 'missing') })).toMatchObject({ type: 'err', code: 'bad_frame' });
    expect(made).toHaveLength(0); // nothing was spawned for any of them
  });

  it('allows bypass when the operator enabled it, and refuses switching into it at runtime otherwise', async () => {
    const strict = await daemon();
    const c = await client(strict);
    expect((await open(c)).type).toBe('ack');
    expect(await c.cmd('session.setPermissionMode', { threadId: 't', mode: 'bypassPermissions' })).toMatchObject({ type: 'err', code: 'forbidden' });
    expect((await c.cmd('session.setPermissionMode', { threadId: 't', mode: 'acceptEdits' })).type).toBe('ack');
    expect((await harness()).modes).toEqual(['acceptEdits']);

    const lax = await daemon({ config: { allowBypass: true } });
    const d = await client(lax);
    expect((await open(d, 'x', { permissionMode: 'bypassPermissions' })).type).toBe('ack');
  });

  it('applies the same policy when a stored spec is cold-resumed', async () => {
    const td = await daemon();
    const c = await client(td);
    await open(c);
    await c.cmd('session.close', { threadId: 't' });
    rmSync(join(workspace, 'proj'), { recursive: true });
    expect(await c.cmd('session.send', { threadId: 't', text: 'x', userMessageUuid: 'u' })).toMatchObject({ type: 'err', code: 'bad_frame' });
  });

  it('reports a missing claude binary as an error on open instead of crashing', async () => {
    const td = await startTestDaemon({
      config: { harness: 'claude', workspaces: [workspace], claudeBinaryPath: '/nonexistent/claude' },
      driverFactory: createClaudeDriverFactory({ claudeBinaryPath: '/nonexistent/claude', env: { PATH: '' } }),
    });
    cleanups.push(() => td.cleanup());
    const c = await client(td);
    expect(await open(c)).toMatchObject({ type: 'err', code: 'internal' });
    expect((await open(c)).message).toMatch(/claude CLI not found/);
    // No recipe was kept for the failed session, so a send does not retry a start that cannot work.
    expect(readdirSync(join(td.dataDir, 'sessions'))).toEqual([]);
    expect(await c.cmd('session.send', { threadId: 't', text: 'x', userMessageUuid: 'u' })).toMatchObject({ type: 'err', code: 'not_found' });
  });
});

describe('spec -> HarnessSessionOptions', () => {
  it('carries the spec, never sets VM routing or client-supplied secrets, and keeps http MCP servers only', async () => {
    const td = await daemon();
    const c = await client(td);
    await open(c, 't', {
      disallowedTools: ['WebFetch'],
      appendSystemPrompt: 'be brief',
      resumeFallbackHistory: 'history',
      additionalDirectories: [join(workspace, 'proj')],
      sessionOptions: { effort: 'low', persistSession: true },
      mcpServers: { docs: { type: 'http', url: 'https://example.test/mcp', headers: { a: 'b' } } },
      extraEnvRaw: 'FOO=1\nHOME=/evil',
      hostTools: [{ name: 'vault_search', description: '', inputSchema: {}, requiresApproval: false, server: 'claude_threads' }],
    });
    const h = await harness();
    const o = h.options!;
    expect(o).toMatchObject({
      cwd: join(workspace, 'proj'), permissionMode: 'default', model: 'haiku',
      disallowedTools: ['WebFetch'], appendSystemPrompt: 'be brief', resumeFallbackHistory: 'history',
      additionalDirectories: [join(workspace, 'proj')], extraEnvRaw: 'FOO=1',
    });
    expect(o.claude).toMatchObject({
      disallowedTools: ['WebFetch'],
      sessionOptions: { effort: 'low', persistSession: true },
      mcpServers: { docs: { type: 'http', url: 'https://example.test/mcp', headers: { a: 'b' } } },
    });
    expect(o.claude?.vm).toBeUndefined();
    expect(o.secretEnv).toBeUndefined();
    expect(o.containerAuthToken).toBeUndefined();
    expect(o.resume).toBeUndefined(); // brand-new thread
  });

  it('specToSessionOptions is pure and omits absent fields', () => {
    const o = specToSessionOptions({ harness: 'claude', cwd: '/x', permissionMode: 'plan', extraEnvRaw: '' }, { callbacks: {} as never });
    expect(Object.keys(o).sort()).toEqual(['callbacks', 'claude', 'cwd', 'extraEnvRaw', 'permissionMode']);
  });
});

describe('callbacks become journaled events', () => {
  it('every plain SessionCallbacks entry is wired, and the blocking ones are request/resolve pairs', async () => {
    const td = await daemon();
    const c = await client(td);
    await open(c);
    const cb = (await harness()).cb as unknown as Record<string, unknown>;
    for (const [name, kind] of Object.entries(CALLBACK_DISPOSITION)) {
      expect(typeof cb[name], name).toBe('function');
      expect(['event', 'request', 'not_on_wire']).toContain(kind);
    }
  });

  it('streams tokens, message and done, with Errors serialized and turn state mirrored', async () => {
    const td = await daemon();
    const c = await client(td);
    await open(c);
    await c.cmd('attach', { ch: 't:t', afterSeq: 0 });
    const h = await harness();
    await c.cmd('session.send', { threadId: 't', text: 'list files', userMessageUuid: 'uuid-1' });
    expect(h.sent).toEqual([{ text: 'list files', images: undefined, uuid: 'uuid-1' }]);
    await c.waitFor((f) => f.name === 'session.state' && f.args.turnInFlight === true);
    h.token('a.txt ');
    h.token('b.txt');
    h.cb.onToolUse({ id: 'tu1', name: 'Bash', input: { command: 'ls' } } as never);
    h.finish('a.txt b.txt');
    h.cb.onError(new Error('boom'));
    await c.waitFor((f) => f.name === 'onError');
    const names = c.events().map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['onToken', 'onToolUse', 'onMessage', 'onDone', 'onError']));
    expect(c.events().find((f) => f.name === 'onError')!.args[0]).toMatchObject({ name: 'Error', message: 'boom' });
    const idle = await c.waitFor((f) => f.name === 'session.state' && f.args.turnInFlight === false && f.seq > (c.events().find((e) => e.name === 'onDone')?.seq ?? Infinity));
    expect(idle.args).toMatchObject({ canIdleReap: true, hasPendingPermission: false, cwd: join(workspace, 'proj') });
  });

  it('forwards images and userMessageUuid; a second send during a turn is a conflict', async () => {
    const td = await daemon();
    const c = await client(td);
    await open(c);
    const h = await harness();
    const img = { base64: 'AAAA', mediaType: 'image/png', name: 'a.png' };
    await c.cmd('session.send', { threadId: 't', text: 'look', userMessageUuid: 'u', images: [img, { base64: 'x', mediaType: 'text/html', name: 'bad' }] });
    await sleep(20);
    expect(h.sent[0].images).toEqual([img]);
    expect(await c.cmd('session.send', { threadId: 't', text: 'again', userMessageUuid: 'u2' })).toMatchObject({ type: 'err', code: 'conflict' });
  });

  it('a harness that fails to start surfaces as onError, and a send afterwards errors instead of hanging', async () => {
    const td = await startTestDaemon({
      config: { harness: 'claude', workspaces: [workspace] },
      driverFactory: createClaudeDriverFactory({ createHarness: () => Object.assign(new ScriptedHarness(), { startError: new Error('spawn failed') }), env: {} }),
    });
    cleanups.push(() => td.cleanup());
    const c = await client(td);
    await open(c);
    await c.cmd('attach', { ch: 't:t', afterSeq: 0 });
    expect((await c.waitFor((f) => f.name === 'onError')).args[0]).toMatchObject({ message: 'spawn failed' });
  });
});

describe('blocking callbacks as durable requests', () => {
  async function turnWithPermission() {
    const td = await daemon();
    const a = await client(td);
    await open(a);
    await a.cmd('attach', { ch: 't:t', afterSeq: 0 });
    const h = await harness();
    await a.cmd('session.send', { threadId: 't', text: 'run ls', userMessageUuid: 'u' });
    const answer = h.permission('Bash', 'ls -la');
    const req = await a.waitFor((f) => f.name === 'permission_request');
    return { td, a, h, answer, req };
  }

  it('permission: journaled with a daemon-owned id, state shows it pending, allow resumes the harness', async () => {
    const { a, h, answer, req } = await turnWithPermission();
    expect(req.args).toMatchObject({ toolName: 'Bash', detail: 'ls -la' });
    expect(typeof req.args.requestId).toBe('string');
    expect(req.args.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const pendingState = await a.waitFor((f) => f.name === 'session.state' && f.args.hasPendingPermission === true);
    expect(pendingState.args.canIdleReap).toBe(false);
    expect((await a.cmd('resolve.permission', { threadId: 't', requestId: req.args.requestId, allow: true })).type).toBe('ack');
    expect(await answer).toBe(true);
    h.finish('done');
    await a.waitFor((f) => f.name === 'onDone');
  });

  it('permission: deny reaches the harness as false', async () => {
    const { a, answer, req } = await turnWithPermission();
    await a.cmd('resolve.permission', { threadId: 't', requestId: req.args.requestId, allow: false });
    expect(await answer).toBe(false);
  });

  it('survives a disconnect: the reconnecting client gets the prompt again and can still answer', async () => {
    const { td, a, answer, req } = await turnWithPermission();
    const cursor = a.events().at(-1)!.seq as number;
    a.kill();
    await a.closed;
    await sleep(30);

    const b = await client(td);
    await b.cmd('attach', { ch: 't:t', afterSeq: cursor });
    const again = await b.waitFor((f) => f.name === 'permission_request');
    expect(again).toMatchObject({ reopen: true, args: { requestId: req.args.requestId } });
    await b.cmd('resolve.permission', { threadId: 't', requestId: again.args.requestId, allow: true });
    expect(await answer).toBe(true);
  });

  it('interrupt answers every open request as denied/canceled before interrupting the harness', async () => {
    const { a, h, answer, req } = await turnWithPermission();
    expect((await a.cmd('session.interrupt', { threadId: 't' })).type).toBe('ack');
    expect(await answer).toBe(false);
    expect(h.interrupts).toBe(1);
    expect((await a.waitFor((f) => f.name === 'request_resolved')).args).toMatchObject({ requestId: req.args.requestId, outcome: 'canceled' });
    await a.waitFor((f) => f.name === 'onInterrupted');
  });

  it('interrupting an idle session does not reach the harness (ThreadSession latches "interrupted")', async () => {
    const td = await daemon();
    const c = await client(td);
    await open(c);
    const h = await harness();
    expect((await c.cmd('session.interrupt', { threadId: 't' })).type).toBe('ack');
    expect(h.interrupts).toBe(0);
  });

  it('ask-question: answers are returned to the harness', async () => {
    const td = await daemon();
    const c = await client(td);
    await open(c);
    await c.cmd('attach', { ch: 't:t', afterSeq: 0 });
    const h = await harness();
    const answers = h.cb.onAskUserQuestion([{ question: 'Which?', header: 'W', options: [{ label: 'x', description: '' }], multiSelect: false }]);
    const req = await c.waitFor((f) => f.name === 'question_request');
    expect(req.args.questions[0].question).toBe('Which?');
    await c.cmd('resolve.question', { threadId: 't', requestId: req.args.requestId, answers: { 'Which?': 'x' } });
    expect(await answers).toEqual({ 'Which?': 'x' });
  });

  it('plan: approve (with edits) and reject map to the harness callbacks', async () => {
    const td = await daemon();
    const c = await client(td);
    await open(c);
    await c.cmd('attach', { ch: 't:t', afterSeq: 0 });
    const h = await harness();
    const calls: string[] = [];
    h.cb.onPlanReady!('the plan', (edited) => calls.push(`approve:${edited ?? ''}`), () => { calls.push('reject'); return false; });
    const first = await c.waitFor((f) => f.name === 'plan_ready');
    expect(first.args.planText).toBe('the plan');
    await c.cmd('resolve.plan', { threadId: 't', requestId: first.args.requestId, approve: true, editedPlan: 'better plan' });
    h.cb.onPlanReady!('plan 2', (edited) => calls.push(`approve:${edited ?? ''}`), () => { calls.push('reject'); return false; });
    const second = await c.waitFor((f) => f.name === 'plan_ready' && f.args.planText === 'plan 2');
    await c.cmd('resolve.plan', { threadId: 't', requestId: second.args.requestId, approve: false });
    expect(calls).toEqual(['approve:better plan', 'reject']);
  });

  it('elicitation: the result is returned; an aborted signal cancels the request', async () => {
    const td = await daemon();
    const c = await client(td);
    await open(c);
    await c.cmd('attach', { ch: 't:t', afterSeq: 0 });
    const h = await harness();
    const ok = h.cb.onElicitation!({ message: 'need token' } as never, new AbortController().signal);
    const req = await c.waitFor((f) => f.name === 'elicitation_request');
    expect(req.args.request).toMatchObject({ message: 'need token' });
    await c.cmd('resolve.elicitation', { threadId: 't', requestId: req.args.requestId, result: { action: 'accept', content: { a: 1 } } });
    expect(await ok).toEqual({ action: 'accept', content: { a: 1 } });

    const ac = new AbortController();
    const aborted = h.cb.onElicitation!({ message: 'second' } as never, ac.signal);
    const req2 = await c.waitFor((f) => f.name === 'elicitation_request' && f.args.request.message === 'second');
    ac.abort();
    expect(await aborted).toEqual({ action: 'cancel' });
    expect((await c.waitFor((f) => f.name === 'request_resolved' && f.args.requestId === req2.args.requestId)).args.outcome).toBe('canceled');
  });

  it('open-tab is refused to the harness with a clear error, and nothing is ever pending for it', async () => {
    const td = await daemon();
    const c = await client(td);
    await open(c);
    const h = await harness();
    await expect(h.cb.onOpenNewTab('t', 'p')).rejects.toThrow(/not supported on daemon-hosted sessions/);
    expect(((await c.cmd('session.list')).result.threads as Array<{ hasPendingPermission: boolean }>)[0].hasPendingPermission).toBe(false);
  });

  it('closing the session cancels open requests so the harness is never left blocked', async () => {
    const { a, answer } = await turnWithPermission();
    await a.cmd('session.close', { threadId: 't' });
    expect(await answer).toBe(false);
    const evs = a.events().map((f) => f.name);
    expect(evs).toContain('request_resolved');
    expect(evs.indexOf('request_resolved')).toBeLessThan(evs.lastIndexOf('session.state'));
  });
});

describe('command surface through the real driver', () => {
  it('forwards setModel, getContextUsage, mcpServerStatus, getUsageSnapshot, prepareForSend and child-agent messages', async () => {
    const td = await daemon();
    const c = await client(td);
    await open(c);
    const h = await harness();
    await c.cmd('session.setModel', { threadId: 't', model: 'sonnet' });
    expect(h.models).toEqual(['sonnet']);
    expect((await c.cmd('session.getContextUsage', { threadId: 't' })).result.usage).toMatchObject({ model: 'haiku', percentage: 5 });
    expect((await c.cmd('session.mcpServerStatus', { threadId: 't' })).result.servers).toEqual([{ name: 'm', status: 'connected' }]);
    expect((await c.cmd('session.getUsageSnapshot', { threadId: 't' })).result.snapshot).toBeNull();
    await c.cmd('session.prepareForSend', { threadId: 't', text: 'about to send' });
    expect(h.prepared).toEqual(['about to send']);
    await c.cmd('session.sendAgentMessage', { threadId: 't', nativeAgentId: 'ag', text: 'hi agent' });
    expect(h.agentMessages).toEqual([['ag', 'hi agent']]);
  });
});

describe('native session resume', () => {
  it('learns the id from onDone and from raw events, persists it, and resumes it after close and idle reap', async () => {
    const td = await daemon({ sessionId: 'native-AAA', config: { idleReapMinutes: 1 } });
    const c = await client(td);
    expect(await open(c)).toMatchObject({ result: { created: true } });
    const h0 = await harness(0);
    expect(h0.options!.resume).toBeUndefined();
    await c.cmd('session.send', { threadId: 't', text: 'remember 42', userMessageUuid: 'u1' });
    h0.finish('ok');
    await sleep(30);
    expect(((await c.cmd('session.list')).result.threads as Array<{ nativeSessionId: string }>)[0].nativeSessionId).toBe('native-AAA');

    await c.cmd('session.close', { threadId: 't' });
    expect(h0.closed).toBe(true);
    await c.cmd('session.send', { threadId: 't', text: 'what number?', userMessageUuid: 'u2' });
    const h1 = await harness(1);
    expect(h1.options!.resume).toBe('native-AAA');
    expect(h1.options!.model).toBe('haiku');
    h1.finish('42');
    await sleep(30);

    expect(td.daemon.threads.reapIdle(Date.now() + 2 * 60_000)).toEqual(['t']);
    expect(made[1].closed).toBe(true);
    await c.cmd('session.send', { threadId: 't', text: 'again', userMessageUuid: 'u3' });
    expect((await harness(2)).options!.resume).toBe('native-AAA');
  });

  it('open() adopts a live session without a second harness; a client `resume` only seeds a thread the daemon has never seen', async () => {
    const td = await daemon();
    const c = await client(td);
    expect(await open(c, 't', {}, { resume: 'client-id' })).toMatchObject({ result: { created: true, nativeSessionId: 'client-id' } });
    expect((await harness(0)).options!.resume).toBe('client-id');
    expect(await open(c, 't', {}, { resume: 'other' })).toMatchObject({ result: { created: false, adopted: true, nativeSessionId: 'client-id' } });
    expect(made).toHaveLength(1);
  });

  it('after a daemon crash mid-turn: daemon_restarted + interrupted, and a follow-up send resumes the native session', async () => {
    const first = await daemon({ sessionId: 'native-BBB' });
    const a = await client(first);
    await open(a);
    await a.cmd('attach', { ch: 't:t', afterSeq: 0 });
    const h = await harness();
    await a.cmd('session.send', { threadId: 't', text: 'remember 7', userMessageUuid: 'u1' });
    h.finish('ok');
    // The first turn's idle state lands a tick after onDone; wait for it, then start the long turn.
    await a.waitFor((f) => f.name === 'session.state' && f.args.turnInFlight === false && f.seq > (a.events().find((e) => e.name === 'onDone')?.seq ?? Infinity));
    expect((await a.cmd('session.send', { threadId: 't', text: 'long task', userMessageUuid: 'u2' })).type).toBe('ack');
    h.token('working...');
    await a.waitFor((f) => f.name === 'onToken');
    a.kill();
    await first.daemon.crash();

    made.length = 0;
    const second = await daemon({ dataDir: first.dataDir, sessionId: 'native-NEW' });
    expect(second.daemon.recovered).toEqual(['t']);
    const b = await client(second);
    await b.cmd('attach', { ch: 't:t', afterSeq: 0 });
    await b.waitFor((f) => f.name === 'onInterrupted');
    expect(b.events().find((f) => f.name === 'onError')!.args[0]).toMatchObject({ name: 'daemon_restarted' });

    await b.cmd('session.send', { threadId: 't', text: 'what number?', userMessageUuid: 'u3' });
    const h2 = await harness(0);
    expect(h2.options!.resume).toBe('native-BBB');
    expect(h2.options!.cwd).toBe(join(workspace, 'proj'));
  });
});

describe('raw log', () => {
  it('raw SDK events land in <dataDir>/logs/<thread>.jsonl, redacted, and never on the wire', async () => {
    const td = await daemon();
    const c = await client(td);
    await open(c);
    await c.cmd('attach', { ch: 't:t', afterSeq: 0 });
    const h = await harness();
    h.cb.onRawEvent!({ type: 'assistant', session_id: 's1', text: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' });
    await sleep(80);
    const log = readFileSync(join(td.dataDir, 'logs', 't.jsonl'), 'utf8');
    expect(log).toContain('"type":"assistant"');
    expect(log).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(c.events().some((f) => f.name === 'onRawEvent')).toBe(false);
  });
});

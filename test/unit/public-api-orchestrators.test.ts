/**
 * Public API v1: orchestrator wake-up delegation, `enabled`, dispatch
 * `queueIfBusy`, and run events for runs not started through the API.
 */
import { describe, expect, it, vi } from 'vitest';
import { createClaudeThreadsApiV1 } from '../../src/main';
import ClaudeThreadsPlugin from '../../src/main';

type Ev = { type: string; message?: Record<string, unknown>; error?: Error };

function harness(opts: { withDelegate?: boolean; orchestrators?: any[]; resolve?: (t: { id: string }) => Promise<string | null> } = {}) {
  const withDelegate = opts.withDelegate ?? true;
  const listeners = new Set<(id: string, e: Ev) => void>();
  const threads = new Map<string, any>();
  const setWakeupDelegated = vi.fn();
  const sendMessage = vi.fn(async (_id: string, _p: string) => {});
  const interruptThread = vi.fn(async (_id: string) => {});
  const resolveOrchestrator = vi.fn(opts.resolve ?? (async (t: { id: string }) => t.id === 'portfolio' ? 'orch' : null));
  const emit = (id: string, e: Ev) => { for (const l of [...listeners]) l(id, e); };
  const add = (id: string, extra: Record<string, unknown> = {}) => {
    const t = { id, title: id, status: 'waiting', messages: [], createdAt: 1, updatedAt: 2, cwd: '/v', agentHarness: 'claude', ...extra };
    threads.set(id, t); return t;
  };
  add('orch');
  const service = createClaudeThreadsApiV1({
    getThreads: () => [...threads.values()], getThread: (id: string) => threads.get(id),
    isRunning: (id: string) => threads.get(id)?.status === 'active',
    createThread: vi.fn(), sendMessage, interruptThread, openThread: vi.fn(),
    subscribe: (l: any) => { listeners.add(l); return () => listeners.delete(l); },
    listOrchestrators: () => opts.orchestrators ?? [{ id: 'portfolio', kind: 'portfolio', threadId: 'orch', title: 'P', enabled: true }],
    resolveOrchestrator, triggerHostEvent: vi.fn(),
    ...(withDelegate ? { setWakeupDelegated } : {}),
  } as any);
  const events: any[] = [];
  service.api.threads.subscribe((e: unknown) => events.push(e));
  return { service, api: service.api as any, emit, add, threads, events, setWakeupDelegated, sendMessage, interruptThread, resolveOrchestrator };
}
const flush = () => new Promise<void>(r => setTimeout(r, 0));

describe('orchestrators.delegateWakeup', () => {
  it('is advertised only when the host can delegate, and throws PLUGIN_UNAVAILABLE otherwise', () => {
    const on = harness(); const off = harness({ withDelegate: false });
    expect(on.api.capabilities).toContain('orchestrators.wakeup.delegate');
    expect(off.api.capabilities).not.toContain('orchestrators.wakeup.delegate');
    expect(() => off.api.orchestrators.delegateWakeup({ pluginId: 'p' })).toThrowError(expect.objectContaining({ code: 'PLUGIN_UNAVAILABLE' }));
  });

  it('suppresses on first delegate and resumes exactly once on dispose', () => {
    const h = harness();
    const d = h.api.orchestrators.delegateWakeup({ pluginId: 'p' });
    expect(h.setWakeupDelegated.mock.calls).toEqual([[true]]);
    d.dispose();
    expect(h.setWakeupDelegated.mock.calls).toEqual([[true], [false]]);
  });

  it('dispose is idempotent', () => {
    const h = harness();
    const d = h.api.orchestrators.delegateWakeup({ pluginId: 'p' });
    d.dispose(); d.dispose();
    expect(h.setWakeupDelegated.mock.calls).toEqual([[true], [false]]);
  });

  it('with two delegates, stays suppressed until the last one disposes', () => {
    const h = harness();
    const a = h.api.orchestrators.delegateWakeup({ pluginId: 'a' });
    const b = h.api.orchestrators.delegateWakeup({ pluginId: 'b' });
    expect(h.setWakeupDelegated.mock.calls).toEqual([[true]]);
    a.dispose();
    expect(h.setWakeupDelegated).toHaveBeenCalledTimes(1);
    b.dispose();
    expect(h.setWakeupDelegated.mock.calls).toEqual([[true], [false]]);
  });

  it('a double dispose of one delegate cannot release another delegate\'s hold', () => {
    const h = harness();
    const a = h.api.orchestrators.delegateWakeup({ pluginId: 'a' });
    h.api.orchestrators.delegateWakeup({ pluginId: 'b' });
    a.dispose(); a.dispose();
    expect(h.setWakeupDelegated.mock.calls).toEqual([[true]]);
  });

  it('can be re-claimed after a full release', () => {
    const h = harness();
    h.api.orchestrators.delegateWakeup({ pluginId: 'p' }).dispose();
    h.api.orchestrators.delegateWakeup({ pluginId: 'p' });
    expect(h.setWakeupDelegated.mock.calls).toEqual([[true], [false], [true]]);
  });

  it('stop() while delegated resumes core, and a stale dispose afterwards is a no-op', () => {
    const h = harness();
    const d = h.api.orchestrators.delegateWakeup({ pluginId: 'p' });
    h.service.stop();
    expect(h.setWakeupDelegated.mock.calls).toEqual([[true], [false]]);
    d.dispose();
    expect(h.setWakeupDelegated).toHaveBeenCalledTimes(2);
  });

  it('stop() with no delegate does not touch wake-up', () => {
    const h = harness();
    h.service.stop();
    expect(h.setWakeupDelegated).not.toHaveBeenCalled();
  });

  it('rejects delegation after stop()', () => {
    const h = harness(); h.service.stop();
    expect(() => h.api.orchestrators.delegateWakeup({ pluginId: 'p' })).toThrowError(expect.objectContaining({ code: 'PLUGIN_UNAVAILABLE' }));
    expect(h.setWakeupDelegated).not.toHaveBeenCalled();
  });

  it.each([
    ['missing owner', undefined], ['missing pluginId', {}], ['empty', { pluginId: '' }], ['whitespace', { pluginId: '   ' }],
    ['non-string', { pluginId: 7 }], ['129 chars', { pluginId: 'x'.repeat(129) }],
  ])('rejects invalid owner (%s) without delegating', (_n, owner) => {
    const h = harness();
    expect(() => h.api.orchestrators.delegateWakeup(owner)).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(h.setWakeupDelegated).not.toHaveBeenCalled();
  });

  it('accepts a 128 character pluginId', () => {
    const h = harness();
    h.api.orchestrators.delegateWakeup({ pluginId: 'x'.repeat(128) });
    expect(h.setWakeupDelegated).toHaveBeenCalledWith(true);
  });

  it('API run lifecycle is unaffected by delegation', async () => {
    const h = harness(); h.add('t');
    h.api.orchestrators.delegateWakeup({ pluginId: 'p' });
    const { runId } = await h.api.threads.send('t', { prompt: 'x' });
    h.emit('t', { type: 'done' });
    await expect(h.api.threads.wait(runId)).resolves.toMatchObject({ status: 'completed' });
  });
});

describe('orchestrators.list / dispatch targets', () => {
  it('passes the enabled flag through, frozen', async () => {
    const h = harness({ orchestrators: [
      { id: 'portfolio', kind: 'portfolio', threadId: 'orch', title: 'P', enabled: true },
      { id: 'project:a', kind: 'project', projectId: 'a', threadId: 'pa', title: 'A', enabled: false },
    ] });
    const list = await h.api.orchestrators.list();
    expect(list.map((o: any) => [o.id, o.enabled])).toEqual([['portfolio', true], ['project:a', false]]);
    expect(Object.isFrozen(list[1])).toBe(true);
  });

  it('dispatch to a target the host refuses fails ORCHESTRATOR_NOT_FOUND and sends nothing', async () => {
    const h = harness();
    await expect(h.api.orchestrators.dispatch({ id: 'project:off' }, { prompt: 'x' })).rejects.toMatchObject({ code: 'ORCHESTRATOR_NOT_FOUND' });
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });
});

describe('orchestrators.dispatch queueIfBusy', () => {
  it('default: running target fails THREAD_BUSY and sends nothing', async () => {
    const h = harness(); h.threads.get('orch').status = 'active';
    await expect(h.api.orchestrators.dispatch({ id: 'portfolio' }, { prompt: 'x' })).rejects.toMatchObject({ code: 'THREAD_BUSY' });
    await expect(h.api.orchestrators.dispatch({ id: 'portfolio' }, { prompt: 'x', queueIfBusy: false })).rejects.toMatchObject({ code: 'THREAD_BUSY' });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('queueIfBusy:true on a running (non-API) target hands the prompt to sendMessage and returns a run', async () => {
    const h = harness(); h.threads.get('orch').status = 'active';
    const { runId } = await h.api.orchestrators.dispatch({ id: 'portfolio' }, { prompt: 'queued', queueIfBusy: true });
    expect(runId).toMatch(/\S/);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).toHaveBeenCalledWith('orch', 'queued');
    expect(h.events.map(e => e.kind)).toEqual(['run.started']);
    h.emit('orch', { type: 'done' });
    await expect(h.api.threads.wait(runId)).resolves.toMatchObject({ status: 'completed', runId });
  });

  it('queueIfBusy:true while an API run is active: both runs settle on the same terminal event', async () => {
    const h = harness();
    const first = await h.api.orchestrators.dispatch({ id: 'portfolio' }, { prompt: 'one' });
    h.threads.get('orch').status = 'active';
    const second = await h.api.orchestrators.dispatch({ id: 'portfolio' }, { prompt: 'two', queueIfBusy: true });
    expect(second.runId).not.toBe(first.runId);
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
    h.emit('orch', { type: 'done' });
    const [a, b] = await Promise.all([h.api.threads.wait(first.runId), h.api.threads.wait(second.runId)]);
    expect([a.status, b.status]).toEqual(['completed', 'completed']); await flush();
    expect(h.events.filter(e => e.kind === 'run.completed').map(e => e.runId).sort()).toEqual([first.runId, second.runId].sort());
  });

  it('without queueIfBusy an API run in flight still blocks a second dispatch', async () => {
    const h = harness();
    await h.api.orchestrators.dispatch({ id: 'portfolio' }, { prompt: 'one' });
    await expect(h.api.orchestrators.dispatch({ id: 'portfolio' }, { prompt: 'two' })).rejects.toMatchObject({ code: 'THREAD_BUSY' });
  });

  it('queueIfBusy:true on an idle target behaves like a normal send', async () => {
    const h = harness();
    await h.api.orchestrators.dispatch({ id: 'portfolio' }, { prompt: 'x', queueIfBusy: true });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([['string', 'true'], ['number', 1], ['null', null], ['object', {}]])('rejects non-boolean queueIfBusy (%s) before resolving the target', async (_n, value) => {
    const h = harness();
    await expect(h.api.orchestrators.dispatch({ id: 'portfolio' }, { prompt: 'x', queueIfBusy: value })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(h.resolveOrchestrator).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('queued send whose sendMessage rejects fails the run with a sanitized error', async () => {
    const h = harness(); h.threads.get('orch').status = 'active';
    h.sendMessage.mockRejectedValueOnce(new Error('secret=1'));
    const { runId } = await h.api.orchestrators.dispatch({ id: 'portfolio' }, { prompt: 'x', queueIfBusy: true });
    await expect(h.api.threads.wait(runId)).resolves.toMatchObject({ status: 'failed', error: { code: 'RUN_FAILED' } });
    expect(JSON.stringify(h.events)).not.toContain('secret=1');
  });

  it('threads.send ignores queueIfBusy: it is a dispatch-only option', async () => {
    const h = harness(); h.add('t', { status: 'active' });
    await expect(h.api.threads.send('t', { prompt: 'x', queueIfBusy: true })).rejects.toMatchObject({ code: 'THREAD_BUSY' });
  });
});

describe('run events for runs not started through the API', () => {
  it('done with no API run publishes one run.completed with a fresh runId and the final message', async () => {
    const h = harness(); h.add('t', { messages: [{ id: 'm', role: 'assistant', content: 'hi', timestamp: 1 }] });
    h.emit('t', { type: 'done' }); await flush();
    const done = h.events.filter(e => e.kind === 'run.completed');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ threadId: 't', finalMessage: { content: 'hi' } });
    expect(done[0].runId).toMatch(/\S/);
  });

  it('error and interrupted publish run.failed with the matching sanitized code', async () => {
    const h = harness(); h.add('t');
    h.emit('t', { type: 'error', error: new Error('token=zzz') });
    h.emit('t', { type: 'interrupted' }); await flush();
    expect(h.events.map(e => [e.kind, e.error?.code])).toEqual([['run.failed', 'RUN_FAILED'], ['run.failed', 'RUN_INTERRUPTED']]);
    expect(JSON.stringify(h.events)).not.toContain('zzz');
  });

  it('two consecutive non-API runs get distinct runIds', async () => {
    const h = harness(); h.add('t');
    h.emit('t', { type: 'done' }); h.emit('t', { type: 'done' }); await flush();
    const ids = h.events.filter(e => e.kind === 'run.completed').map(e => e.runId);
    expect(ids).toHaveLength(2); expect(new Set(ids).size).toBe(2);
  });

  it('an API run completing produces exactly one run.completed (its own runId), no synthetic duplicate', async () => {
    const h = harness(); h.add('t');
    const { runId } = await h.api.threads.send('t', { prompt: 'x' });
    h.emit('t', { type: 'done' }); await flush();
    expect(h.events.filter(e => e.kind === 'run.completed').map(e => e.runId)).toEqual([runId]);
  });

  it('after the API run settles, a following non-API completion is announced', async () => {
    const h = harness(); h.add('t');
    const { runId } = await h.api.threads.send('t', { prompt: 'x' });
    h.emit('t', { type: 'done' }); await flush();
    h.emit('t', { type: 'done' }); await flush();
    const ids = h.events.filter(e => e.kind === 'run.completed').map(e => e.runId);
    expect(ids).toHaveLength(2); expect(ids[0]).toBe(runId); expect(ids[1]).not.toBe(runId);
  });

  it('cancel() whose interrupt event arrives late is not re-announced as a non-API run', async () => {
    const h = harness(); h.add('t');
    const { runId } = await h.api.threads.send('t', { prompt: 'x' });
    await h.api.threads.cancel(runId);
    h.emit('t', { type: 'interrupted' }); await flush();
    expect(h.events.filter(e => e.kind === 'run.failed').every(e => e.runId === runId)).toBe(true);
  });

  it('cancel() whose interrupt event arrives during the interrupt call yields only the cancelled runId', async () => {
    const h = harness(); h.add('t');
    h.interruptThread.mockImplementation(async (id: string) => { h.emit(id, { type: 'interrupted' }); });
    const { runId } = await h.api.threads.send('t', { prompt: 'x' });
    await h.api.threads.cancel(runId); await flush();
    expect(h.events.filter(e => e.kind === 'run.failed').every(e => e.runId === runId)).toBe(true);
  });

  it('a new API send after cancel() clears any leftover expectation', async () => {
    const h = harness(); h.add('t');
    const first = await h.api.threads.send('t', { prompt: 'x' });
    await h.api.threads.cancel(first.runId);
    const second = await h.api.threads.send('t', { prompt: 'y' });
    h.emit('t', { type: 'done' }); await flush();
    expect(h.events.filter(e => e.kind === 'run.completed').map(e => e.runId)).toEqual([second.runId]);
  });

  // SOURCE BUG (QA): cancel() marks the thread's next terminal event as "expected" before
  // interrupting. ThreadManager.interrupt() emits nothing when the thread has no live session,
  // so the mark leaks and swallows the NEXT genuine non-API completion on that thread.
  it('cancel() that produces no terminal event must not swallow a later non-API completion', async () => {
    const h = harness(); h.add('t');
    const { runId } = await h.api.threads.send('t', { prompt: 'x' });
    await h.api.threads.cancel(runId); // interruptThread is a no-op: no event follows
    h.emit('t', { type: 'done' }); await flush(); // a user-typed turn finishing later
    const synthetic = h.events.filter(e => e.kind === 'run.completed');
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0].runId).not.toBe(runId);
  });

  it('cancel() whose interrupt event arrives during the interrupt call publishes run.failed exactly once', async () => {
    const h = harness(); h.add('t');
    h.interruptThread.mockImplementation(async (id: string) => { h.emit(id, { type: 'interrupted' }); });
    const { runId } = await h.api.threads.send('t', { prompt: 'x' });
    await expect(h.api.threads.cancel(runId)).resolves.toMatchObject({ status: 'failed', error: { code: 'RUN_INTERRUPTED' } });
    await flush();
    expect(h.events.filter(e => e.kind === 'run.failed')).toHaveLength(1);
  });

  it('cancel() with a silent interrupt publishes run.failed once for the cancelled run', async () => {
    const h = harness(); h.add('t');
    const { runId } = await h.api.threads.send('t', { prompt: 'x' });
    await h.api.threads.cancel(runId); await flush();
    expect(h.events.filter(e => e.kind === 'run.failed').map(e => e.runId)).toEqual([runId]);
  });

  it('a leaked cancel mark never absorbs error', async () => {
    const h = harness(); h.add('t');
    const { runId } = await h.api.threads.send('t', { prompt: 'x' });
    await h.api.threads.cancel(runId);
    h.emit('t', { type: 'error', error: new Error('e') }); await flush();
    expect(h.events.filter(e => e.kind === 'run.failed' && e.runId !== runId)).toHaveLength(1);
  });

  // Known, accepted residual gap (QA decision): a silent cancel() leaves a mark that absorbs
  // exactly ONE later genuine non-API `interrupted`; it is then cleared. Pinned so a change is deliberate.
  it('a leaked cancel mark absorbs at most one later non-API interrupted, then announcements resume', async () => {
    const h = harness(); h.add('t');
    const { runId } = await h.api.threads.send('t', { prompt: 'x' });
    await h.api.threads.cancel(runId);
    h.emit('t', { type: 'interrupted' }); await flush();
    h.emit('t', { type: 'interrupted' }); await flush();
    expect(h.events.filter(e => e.kind === 'run.failed' && e.runId !== runId)).toHaveLength(1);
  });

  it('events for one thread do not consume another thread\'s expectation', async () => {
    const h = harness(); h.add('a'); h.add('b');
    const { runId } = await h.api.threads.send('a', { prompt: 'x' });
    await h.api.threads.cancel(runId);
    h.emit('b', { type: 'done' }); await flush();
    expect(h.events.filter(e => e.kind === 'run.completed').map(e => e.threadId)).toEqual(['b']);
  });
});

describe('plugin wiring (listPublicOrchestrators / resolvePublicOrchestrator / setWakeupDelegated)', () => {
  function plugin(projects: any[], extra: Record<string, unknown> = {}) {
    const threads: Record<string, any> = { orch: { id: 'orch', title: 'Port' }, pa: { id: 'pa', title: 'A' }, pb: { id: 'pb', title: 'B' } };
    const ensureProjectOrchestratorThread = vi.fn(async (id: string) => `p${id}`);
    const p = Object.assign(Object.create(ClaudeThreadsPlugin.prototype), {
      settings: { orchestratorThreadId: 'orch' },
      manager: { getThread: (id: string) => threads[id], getProjects: () => projects, getProject: (id: string) => projects.find(x => x.id === id) },
      ensureOrchestratorThread: vi.fn(async () => {}),
      ensureProjectOrchestratorThread,
      ...extra,
    }) as any;
    return { p, ensureProjectOrchestratorThread };
  }

  it('list reports enabled: portfolio true, disabled project false, legacy undefined as true', () => {
    const { p } = plugin([
      { id: 'a', orchestratorThreadId: 'pa', orchestratorEnabled: false },
      { id: 'b', orchestratorThreadId: 'pb' },
    ]);
    expect(p.listPublicOrchestrators().map((o: any) => [o.id, o.enabled])).toEqual([['portfolio', true], ['project:a', false], ['project:b', true]]);
  });

  it('list reports a thread-less DISABLED project as enabled:false with empty threadId; enabled thread-less and deleted projects stay absent', () => {
    const { p } = plugin([
      { id: 'a', name: 'Alpha', orchestratorEnabled: false },
      { id: 'b', name: 'Beta', orchestratorEnabled: true },
      { id: 'c', name: 'Gamma' },
      { id: 'd', name: 'Delta', orchestratorThreadId: 'pa', orchestratorEnabled: false },
      { id: 'e', name: 'Echo', orchestratorThreadId: 'gone', orchestratorEnabled: false },
    ]);
    const list = p.listPublicOrchestrators();
    expect(list.map((o: any) => [o.id, o.enabled, o.threadId])).toEqual([['portfolio', true, 'orch'], ['project:a', false, ''], ['project:d', false, 'pa'], ['project:e', false, '']]);
    expect(list[1]).toEqual({ id: 'project:a', kind: 'project', projectId: 'a', threadId: '', title: 'Alpha orchestrator', enabled: false });
  });

  it('dispatch is still refused for the thread-less disabled entry, before creation', async () => {
    const { p, ensureProjectOrchestratorThread } = plugin([{ id: 'a', name: 'Alpha', orchestratorEnabled: false }]);
    await expect(p.resolvePublicOrchestrator({ id: 'project:a' })).resolves.toBeNull();
    expect(ensureProjectOrchestratorThread).not.toHaveBeenCalled();
  });

  it('resolve refuses a disabled project BEFORE creating any thread', async () => {
    const { p, ensureProjectOrchestratorThread } = plugin([{ id: 'a', orchestratorEnabled: false }]);
    await expect(p.resolvePublicOrchestrator({ id: 'project:a' })).resolves.toBeNull();
    expect(ensureProjectOrchestratorThread).not.toHaveBeenCalled();
  });

  it('resolve still creates on demand for an enabled project and for legacy undefined', async () => {
    const { p, ensureProjectOrchestratorThread } = plugin([{ id: 'a', orchestratorEnabled: true }, { id: 'b' }]);
    await expect(p.resolvePublicOrchestrator({ id: 'project:a' })).resolves.toBe('pa');
    await expect(p.resolvePublicOrchestrator({ id: 'project:b' })).resolves.toBe('pb');
    expect(ensureProjectOrchestratorThread).toHaveBeenCalledTimes(2);
  });

  it.each(['project:', 'project:missing', 'bogus'])('resolve returns null for %s without creating', async (id) => {
    const { p, ensureProjectOrchestratorThread } = plugin([{ id: 'a' }]);
    await expect(p.resolvePublicOrchestrator({ id })).resolves.toBeNull();
    expect(ensureProjectOrchestratorThread).not.toHaveBeenCalled();
  });

  it('end to end through the API: dispatch to a disabled project fails and creates nothing', async () => {
    const { p, ensureProjectOrchestratorThread } = plugin([{ id: 'a', orchestratorThreadId: 'pa', orchestratorEnabled: false }]);
    const trigger = vi.fn();
    Object.assign(p, { app: { workspace: { trigger } }, openThreadInChatView: async () => {}, getEffectiveCwd: () => '/v', saveSettings: async () => {} });
    Object.assign(p.manager, { getThreads: () => [], isRunning: () => false, createThread: vi.fn(), sendMessage: vi.fn(), subscribe: () => () => {}, assertLaunchAllowedNow: async () => {} });
    p.initializePublicApi();
    await expect(p.api.v1.orchestrators.dispatch({ id: 'project:a' }, { prompt: 'x' })).rejects.toMatchObject({ code: 'ORCHESTRATOR_NOT_FOUND' });
    expect(ensureProjectOrchestratorThread).not.toHaveBeenCalled();
    p.revokePublicApi();
  });

  it('delegateWakeup toggles plugin.wakeupDelegated, discards batches on claim, and resumes on dispose and on revoke', () => {
    const discardAll = vi.fn();
    const { p } = plugin([], { orchestratorWakeup: { discardAll }, app: { workspace: { trigger: vi.fn() } }, openThreadInChatView: async () => {}, getEffectiveCwd: () => '/v', saveSettings: async () => {} });
    Object.assign(p.manager, { getThreads: () => [], isRunning: () => false, createThread: vi.fn(), sendMessage: vi.fn(), subscribe: () => () => {}, assertLaunchAllowedNow: async () => {} });
    p.initializePublicApi();
    expect(p.api.v1.capabilities).toContain('orchestrators.wakeup.delegate');
    const d = p.api.v1.orchestrators.delegateWakeup({ pluginId: 'x' });
    expect(p.wakeupDelegated).toBe(true); expect(discardAll).toHaveBeenCalledTimes(1);
    d.dispose();
    expect(p.wakeupDelegated).toBe(false);
    p.api.v1.orchestrators.delegateWakeup({ pluginId: 'x' });
    expect(p.wakeupDelegated).toBe(true);
    p.revokePublicApi();
    expect(p.wakeupDelegated).toBe(false);
  });
});

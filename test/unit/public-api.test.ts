import { describe, expect, it, vi } from 'vitest';
import { createClaudeThreadsApiV1 } from '../../src/main';
import ClaudeThreadsPlugin from '../../src/main';

type InternalEvent = { type: string; message?: Record<string, unknown>; error?: Error };

function makeHarness() {
  const listeners = new Set<(threadId: string, event: InternalEvent) => void>();
  const threads = new Map<string, any>();
  const hostSignals: Array<{ name: string; payload: unknown }> = [];
  let nextId = 1;
  let sendImpl: (threadId: string, prompt: string) => Promise<void> = async () => {};
  const emit = (threadId: string, event: InternalEvent) => {
    for (const listener of [...listeners]) listener(threadId, event);
  };
  const addThread = (overrides: Record<string, unknown> = {}) => {
    const id = String(overrides.id ?? `thread-${nextId++}`);
    const thread = { id, title: 'Thread', status: 'waiting', reviewed: false, cwd: '/vault', projectId: undefined,
      agentHarness: 'claude', messages: [], createdAt: 10, updatedAt: 20, ...overrides };
    threads.set(id, thread);
    return thread;
  };
  const harness = {
    threads, hostSignals, emit, addThread,
    setSendImpl(fn: typeof sendImpl) { sendImpl = fn; },
    service: createClaudeThreadsApiV1({
      getThreads: () => [...threads.values()],
      getThread: (id: string) => threads.get(id),
      isRunning: (id: string) => threads.get(id)?.status === 'active',
      createThread: (input: Record<string, unknown>) => addThread({ title: input.title ?? 'New Thread', ...input }),
      sendMessage: (id: string, prompt: string) => sendImpl(id, prompt),
      openThread: vi.fn(async () => {}),
      subscribe: (listener: (threadId: string, event: InternalEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      listOrchestrators: () => [{ id: 'portfolio', kind: 'portfolio', threadId: 'orch', title: 'Portfolio Orchestrator' }],
      resolveOrchestrator: async (target: { id: string }) => target.id === 'portfolio' ? 'orch' : null,
      triggerHostEvent: (name: string, payload: unknown) => hostSignals.push({ name, payload }),
    } as any),
  };
  return harness;
}

describe('Claude Threads public API v1 contract', () => {
  it('exposes lifecycle tools only when backed by host capabilities and rejects stale calls', async () => {
    const { service } = makeHarness();
    expect(service.api.agentTools.createBundle('voice-orchestration').tools.map(t => t.name)).not.toContain('ct_archive_thread');
    await expect(service.api.threads.archive('one')).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' });
  });

  it('routes public lifecycle methods and bundle results through guarded host callbacks', async () => {
    const archiveThread = vi.fn(async (threadId: string, assertActive: () => void) => { assertActive(); return { status: 'archived' as const, threadId }; });
    const markThreadReviewed = vi.fn(async (threadId: string, assertActive: () => void) => { assertActive(); return { threadId, reviewed: true as const, changed: true }; });
    const service = createClaudeThreadsApiV1({
      getThreads: () => [], getThread: () => undefined, isRunning: () => false,
      createThread: vi.fn(), sendMessage: vi.fn(), openThread: vi.fn(), subscribe: () => () => {},
      listOrchestrators: () => [], resolveOrchestrator: async () => null, triggerHostEvent: vi.fn(),
      archiveThread, markThreadReviewed,
    });
    expect(service.api.capabilities).toEqual(expect.arrayContaining(['threads.archive', 'threads.markReviewed']));
    const bundle = service.api.agentTools.createBundle('voice-orchestration');
    expect(bundle.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['ct_archive_thread', 'ct_mark_reviewed']));
    await expect(bundle.execute('ct_archive_thread', { thread_id: 'one' })).resolves.toBe('Archived thread one.');
    await expect(bundle.execute('ct_mark_reviewed', { thread_id: 'one' })).resolves.toBe('Marked thread one reviewed.');
    await expect(bundle.execute('ct_archive_thread', { thread_id: 123 })).resolves.toMatch(/^Error:/);
    await expect(service.api.threads.archive('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    archiveThread.mockResolvedValueOnce({ status: 'cancelled', threadId: 'one' } as any);
    await expect(bundle.execute('ct_archive_thread', { thread_id: 'one' })).resolves.toBe('Archive cancelled for thread one.');
    const calls = archiveThread.mock.calls.length;
    service.stop();
    await expect(service.api.threads.archive('one')).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' });
    await expect(bundle.execute('ct_mark_reviewed', { thread_id: 'one' })).resolves.toMatch(/^Error:/);
    expect(archiveThread).toHaveBeenCalledTimes(calls);
  });
  it('publishes version, generation, immutable capabilities, and the ready host signal', () => {
    const { service, hostSignals } = makeHarness();
    expect(service.api.apiVersion).toBe(1);
    expect(service.api.generation).toMatch(/\S/);
    expect(service.api.capabilities).toContain('threads.wait');
    expect(Object.isFrozen(service.api.capabilities)).toBe(true);
    service.start();
    expect(hostSignals).toEqual([{ name: 'claude-threads:api-ready', payload: { apiVersion: 1, generation: service.api.generation } }]);
  });

  it('supports create → observe → wait → open using only the public contract', async () => {
    const { service, emit, threads } = makeHarness();
    const events: any[] = [];
    service.api.threads.subscribe((event: unknown) => events.push(event));
    const { threadId } = await service.api.threads.create({ title: 'Peer task' });
    const { runId } = await service.api.threads.send(threadId, { prompt: 'Do work' });
    threads.get(threadId).messages.push({ id: 'a1', role: 'assistant', content: 'Done', timestamp: 30 });
    emit(threadId, { type: 'message', message: threads.get(threadId).messages[0] });
    emit(threadId, { type: 'done' });
    await expect(service.api.threads.wait(runId)).resolves.toMatchObject({ status: 'completed', runId, threadId });
    await service.api.threads.open(threadId);
    expect(events.map(event => event.kind)).toEqual(['run.started', 'message.completed', 'run.completed']);
  });

  it('returns deeply immutable, detached thread and message snapshots', async () => {
    const { service, addThread, threads } = makeHarness();
    const thread = addThread({ messages: [{ id: 'm1', role: 'assistant', content: 'Original', timestamp: 12 }] });
    const snapshot = await service.api.threads.get(thread.id) as any;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.messages)).toBe(true);
    expect(Object.isFrozen(snapshot.messages[0])).toBe(true);
    expect(() => { snapshot.messages[0].content = 'Changed'; }).toThrow();
    expect(threads.get(thread.id).messages[0].content).toBe('Original');
  });

  it('filters queries without leaking excluded internal fields', async () => {
    const { service, addThread } = makeHarness();
    addThread({ id: 'a', projectId: 'p1', status: 'waiting', rawLogPath: 'secret.jsonl', managerNotes: 'private' });
    addThread({ id: 'b', projectId: 'p2', status: 'error', lastError: 'provider stack' });
    const listed = await service.api.threads.list({ projectId: 'p1', status: 'waiting', limit: 1 }) as any[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: 'a', projectId: 'p1' });
    expect(listed[0]).not.toHaveProperty('rawLogPath');
    expect(listed[0]).not.toHaveProperty('managerNotes');
    expect(listed[0]).not.toHaveProperty('lastError');
  });

  it('rejects unknown threads and runs with structured public errors', async () => {
    const { service } = makeHarness();
    await expect(service.api.threads.send('missing', { prompt: 'x' })).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });
    await expect(service.api.threads.open('missing')).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });
    await expect(service.api.threads.wait('missing')).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
  });

  it('bounds waits and returns a structured timeout without ending the run', async () => {
    vi.useFakeTimers();
    try {
      const { service, addThread } = makeHarness();
      const thread = addThread();
      const { runId } = await service.api.threads.send(thread.id, { prompt: 'slow' });
      const waiting = service.api.threads.wait(runId, { timeoutMs: 25 });
      await vi.advanceTimersByTimeAsync(25);
      await expect(waiting).resolves.toMatchObject({ status: 'timed_out', runId, threadId: thread.id });
    } finally { vi.useRealTimers(); }
  });

  it('maps internal failures to sanitized semantic events and wait results', async () => {
    const { service, addThread, emit } = makeHarness();
    const thread = addThread();
    const events: any[] = [];
    service.api.threads.subscribe((event: unknown) => events.push(event));
    const { runId } = await service.api.threads.send(thread.id, { prompt: 'fail' });
    emit(thread.id, { type: 'error', error: new Error('token=super-secret') });
    await expect(service.api.threads.wait(runId)).resolves.toMatchObject({ status: 'failed', error: { code: 'RUN_FAILED', message: 'The agent run failed.' } });
    expect(events.at(-1)).toMatchObject({ kind: 'run.failed', runId, error: { code: 'RUN_FAILED' } });
    expect(JSON.stringify(events)).not.toContain('super-secret');
  });

  it('filters callback-bearing internal events and isolates listener exceptions', () => {
    const { service, addThread, emit } = makeHarness();
    const thread = addThread();
    const observed: any[] = [];
    service.api.threads.subscribe(() => { throw new Error('peer bug'); });
    service.api.threads.subscribe((event: unknown) => observed.push(event));
    emit(thread.id, { type: 'plan_ready', approve: () => {}, reject: () => false } as any);
    emit(thread.id, { type: 'permission_request' });
    emit(thread.id, { type: 'thread_deleted' });
    expect(observed).toEqual([{ kind: 'thread.removed', threadId: thread.id, at: expect.any(Number) }]);
  });

  it('returns an idempotent subscription disposable', () => {
    const { service, emit, addThread } = makeHarness();
    const thread = addThread();
    const listener = vi.fn();
    const disposable = service.api.threads.subscribe(listener);
    disposable.dispose(); disposable.dispose();
    emit(thread.id, { type: 'thread_deleted' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('revokes stale generations, settles waiters, and announces stopping once', async () => {
    const { service, addThread, hostSignals } = makeHarness();
    const thread = addThread();
    const { runId } = await service.api.threads.send(thread.id, { prompt: 'pending' });
    const waiting = service.api.threads.wait(runId);
    service.stop(); service.stop();
    await expect(waiting).resolves.toMatchObject({ status: 'failed', error: { code: 'PLUGIN_UNAVAILABLE', message: 'Agent Threads became unavailable.' } });
    await expect(service.api.threads.list()).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE', message: 'Agent Threads is not available.', generation: service.api.generation });
    expect(hostSignals.filter(signal => signal.name === 'claude-threads:api-stopping')).toHaveLength(1);
  });

  it('lists and dispatches only declared orchestrator targets', async () => {
    const { service, addThread, emit } = makeHarness();
    addThread({ id: 'orch', title: 'Portfolio Orchestrator' });
    expect(await service.api.orchestrators.list()).toEqual([{ id: 'portfolio', kind: 'portfolio', threadId: 'orch', title: 'Portfolio Orchestrator' }]);
    const { runId } = await service.api.orchestrators.dispatch({ id: 'portfolio' }, { prompt: 'Review' });
    emit('orch', { type: 'done' });
    await expect(service.api.threads.wait(runId)).resolves.toMatchObject({ status: 'completed', threadId: 'orch' });
    await expect(service.api.orchestrators.dispatch({ id: 'unknown' }, { prompt: 'x' })).rejects.toMatchObject({ code: 'ORCHESTRATOR_NOT_FOUND' });
  });

  it('creates a transport-neutral voice-orchestration tool bundle', async () => {
    const { service, addThread, emit } = makeHarness();
    const thread = addThread({ id: 'existing', messages: [{ id: 'm', role: 'assistant', content: 'Hello', timestamp: 1 }] });
    const bundle = service.api.agentTools.createBundle('voice-orchestration');
    expect(bundle.tools.map((tool: any) => tool.name)).toEqual(['ct_send_message', 'ct_new_thread', 'ct_wait_for_thread', 'ct_get_thread', 'ct_list_threads', 'ct_open_thread']);
    await expect(bundle.execute('ct_send_message', { thread_id: thread.id, message: 'Continue', wait: false })).resolves.toContain('Running in the background');
    const listResult = await bundle.execute('ct_list_threads', { status: 'all' });
    expect(JSON.parse(listResult).threads[0]).toMatchObject({ id: 'existing' });
    await expect(bundle.execute('ct_open_thread', { thread_id: thread.id })).resolves.toBe(`Opened thread ${thread.id} in the Agent Threads panel.`);
    await expect(bundle.execute('ct_close_thread', {})).resolves.toBe('Error: Agent Threads tool "ct_close_thread" is not available in public API v1.');
    emit(thread.id, { type: 'done' });
  });

  it('wires api.v1 onto the plugin instance, persists creation, and emits lifecycle signals through the workspace', async () => {
    const trigger = vi.fn();
    const thread = { id: 'orch', title: 'Portfolio', status: 'waiting', messages: [], createdAt: 1, updatedAt: 1 };
    const plugin = Object.assign(Object.create(ClaudeThreadsPlugin.prototype), {
      app: { workspace: { trigger } },
      settings: { orchestratorThreadId: 'orch' },
      manager: {
        getThreads: () => [thread], getThread: (id: string) => id === 'orch' ? thread : undefined, getProjects: () => [],
        isRunning: () => false, createThread: () => thread, sendMessage: async () => {}, subscribe: () => () => {},
      },
      openThreadInChatView: async () => {},
      ensureOrchestratorThread: async () => {},
      ensureProjectOrchestratorThread: async () => undefined,
      getEffectiveCwd: () => '/vault',
      saveSettings: vi.fn(async () => {}),
    }) as any;

    plugin.initializePublicApi();
    expect(plugin.api.v1.apiVersion).toBe(1);
    expect(trigger).toHaveBeenCalledWith('claude-threads:api-ready', expect.objectContaining({ apiVersion: 1 }));
    await plugin.api.v1.threads.create({ title: 'Persist me' });
    expect(plugin.saveSettings).toHaveBeenCalledOnce();
    plugin.revokePublicApi();
    expect(trigger).toHaveBeenCalledWith('claude-threads:api-stopping', expect.objectContaining({ generation: plugin.api.v1.generation }));
  });
});

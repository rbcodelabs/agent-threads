/**
 * orchestrator-wakeup.test.ts
 *
 * Covers the debounced wake-up ping sent to the orchestrator thread when
 * other threads finish (see src/OrchestratorWakeup.ts). Specifically guards
 * against the regression where the message body dropped the actual thread
 * ids/titles/status — the batch of pending threads must survive from event
 * capture through to the composed message, and `pending` must be snapshotted
 * before it's cleared (clearing first would silently discard the data the
 * message is built from).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrchestratorWakeup, type OrchestratorWakeupDeps } from '../../src/OrchestratorWakeup';
import type { ThreadManager, ThreadEvent } from '../../src/ThreadManager';

type Listener = (threadId: string, event: ThreadEvent) => void;

function makeManager(titles: Record<string, string> = {}): {
  manager: ThreadManager;
  emit: (threadId: string, event: ThreadEvent) => void;
} {
  const listeners = new Set<Listener>();
  const manager = {
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getThread: (id: string) => ({ id, title: titles[id], updatedAt: 1_700_000_000_000 }),
  } as unknown as ThreadManager;

  return {
    manager,
    emit: (threadId, event) => listeners.forEach((l) => l(threadId, event)),
  };
}

function makeDeps(overrides: Partial<OrchestratorWakeupDeps> = {}): {
  deps: OrchestratorWakeupDeps;
  sendMessage: ReturnType<typeof vi.fn>;
  setTimeoutFn: ReturnType<typeof vi.fn>;
  runTimer: () => void;
} {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  let scheduled: (() => void) | null = null;
  const setTimeoutFn = vi.fn((cb: () => void) => {
    scheduled = cb;
    return 'timer-handle';
  });
  const deps: OrchestratorWakeupDeps = {
    resolveBucket: (threadId) => threadId.startsWith('project-') ? `project:${threadId.split('-')[1]}` : 'portfolio',
    resolveTarget: () => 'orchestrator-thread',
    threadExists: () => true,
    sendMessage,
    setTimeoutFn,
    clearTimeoutFn: vi.fn(),
    ...overrides,
  };
  return {
    deps,
    sendMessage,
    setTimeoutFn,
    runTimer: () => {
      const cb = scheduled;
      scheduled = null;
      cb?.();
    },
  };
}

describe('OrchestratorWakeup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('includes the thread id, title, and status for a single finished thread', async () => {
    const { manager, emit } = makeManager({ 'thread-1': 'Fix login bug' });
    const { deps, sendMessage, runTimer } = makeDeps();
    const wakeup = new OrchestratorWakeup(manager, deps);
    wakeup.start();

    emit('thread-1', { type: 'done' });
    runTimer();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [threadId, message] = sendMessage.mock.calls[0];
    expect(threadId).toBe('orchestrator-thread');
    expect(message).toBe(
      [
        'New activity on 1 thread. Review only the named changed thread; do not run a full reconciliation. The heartbeat handles missed activity.',
        '- thread-1 "Fix login bug" (done; updatedAt=1700000000000)',
      ].join('\n'),
    );
  });

  it('batches multiple threads into one ping with a bullet per thread, preserving id/title/status', async () => {
    const { manager, emit } = makeManager({
      'thread-1': 'Fix login bug',
      'thread-2': 'Update docs',
    });
    const { deps, sendMessage, runTimer } = makeDeps();
    const wakeup = new OrchestratorWakeup(manager, deps);
    wakeup.start();

    emit('thread-1', { type: 'done' });
    emit('thread-2', { type: 'error', error: new Error('boom') });
    runTimer();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, message] = sendMessage.mock.calls[0];
    expect(message).toBe(
      [
        'New activity on 2 threads. Review only the named changed threads; do not run a full reconciliation. The heartbeat handles missed activity.',
        '- thread-1 "Fix login bug" (done; updatedAt=1700000000000)',
        '- thread-2 "Update docs" (error; updatedAt=1700000000000)',
      ].join('\n'),
    );
  });

  it('falls back to the bare thread id when the title is unavailable', async () => {
    const { manager, emit } = makeManager(); // no titles registered
    const { deps, sendMessage, runTimer } = makeDeps();
    const wakeup = new OrchestratorWakeup(manager, deps);
    wakeup.start();

    emit('thread-1', { type: 'done' });
    runTimer();
    await Promise.resolve();

    const [, message] = sendMessage.mock.calls[0];
    expect(message).toBe(
      'New activity on 1 thread. Review only the named changed thread; do not run a full reconciliation. The heartbeat handles missed activity.\n- thread-1 (done; updatedAt=1700000000000)',
    );
  });

  it('keeps only the most recent status when a thread fires multiple events before flush', async () => {
    const { manager, emit } = makeManager({ 'thread-1': 'Flaky thread' });
    const { deps, sendMessage, runTimer } = makeDeps();
    const wakeup = new OrchestratorWakeup(manager, deps);
    wakeup.start();

    emit('thread-1', { type: 'error', error: new Error('first') });
    emit('thread-1', { type: 'done' });
    runTimer();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, message] = sendMessage.mock.calls[0];
    expect(message).toBe(
      'New activity on 1 thread. Review only the named changed thread; do not run a full reconciliation. The heartbeat handles missed activity.\n- thread-1 "Flaky thread" (done; updatedAt=1700000000000)',
    );
  });

  it('debounces projects independently and resolves each target at flush time', async () => {
    const { manager, emit } = makeManager({ 'project-a-worker': 'A', 'project-b-worker': 'B' });
    const targets = new Map([['project:a', 'orch-a'], ['project:b', 'orch-b']]);
    const callbacks: Array<() => void> = [];
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const wakeup = new OrchestratorWakeup(manager, {
      resolveBucket: (threadId) => threadId.includes('-a-') ? 'project:a' : 'project:b',
      resolveTarget: async (bucket) => targets.get(bucket),
      threadExists: () => true,
      sendMessage,
      setTimeoutFn: (cb) => { callbacks.push(cb); return cb; },
      clearTimeoutFn: () => {},
    });
    wakeup.start();

    emit('project-a-worker', { type: 'done' });
    emit('project-b-worker', { type: 'error', error: new Error('boom') });
    targets.set('project:a', 'replacement-a');
    callbacks.forEach(cb => cb());
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith('replacement-a', expect.stringContaining('project-a-worker'));
    expect(sendMessage).toHaveBeenCalledWith('orch-b', expect.stringContaining('project-b-worker'));
  });

  it('clears pending state on flush even if it is empty, and never calls sendMessage', async () => {
    const { manager } = makeManager();
    const { deps, sendMessage, setTimeoutFn } = makeDeps();
    const wakeup = new OrchestratorWakeup(manager, deps);
    wakeup.start();

    // No events emitted — timer never armed, nothing to flush.
    expect(setTimeoutFn).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('skips sending and warns when the orchestrator thread no longer exists at flush time', async () => {
    const { manager, emit } = makeManager({ 'thread-1': 'Fix login bug' });
    const onWarn = vi.fn();
    const { deps, sendMessage, runTimer } = makeDeps({ threadExists: () => false, onWarn });
    const wakeup = new OrchestratorWakeup(manager, deps);
    wakeup.start();

    emit('thread-1', { type: 'done' });
    runTimer();
    await Promise.resolve();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it('supports a summary-only portfolio fallback without exposing Project thread details', async () => {
    const { manager, emit } = makeManager({ 'project-a-worker': 'Sensitive task' });
    const { deps, sendMessage, runTimer } = makeDeps({
      resolveBucket: () => 'project:a',
      resolveTarget: () => ({ threadId: 'portfolio', summaryOnly: true }),
    });
    const wakeup = new OrchestratorWakeup(manager, deps);
    wakeup.start();
    emit('project-a-worker', { type: 'error', error: new Error('boom') });
    runTimer();
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith('portfolio', 'New activity in Project a — the Project orchestrator could not be reached.');
  });

  it('invalidates a queued bucket before its debounce fires', async () => {
    const { manager, emit } = makeManager({ 'project-a-worker': 'A' });
    const resolveTarget = vi.fn(() => 'orchestrator-thread');
    const { deps, sendMessage, runTimer } = makeDeps({ resolveBucket: () => 'project:a', resolveTarget });
    const wakeup = new OrchestratorWakeup(manager, deps);
    wakeup.start();

    emit('project-a-worker', { type: 'done' });
    wakeup.invalidateBucket('project:a');
    runTimer();
    await Promise.resolve();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it('invalidates a bucket while its target is resolving', async () => {
    const { manager, emit } = makeManager({ 'project-a-worker': 'A' });
    let finishResolve!: (target: string) => void;
    const resolveTarget = vi.fn(() => new Promise<string>(resolve => { finishResolve = resolve; }));
    const { deps, sendMessage, runTimer } = makeDeps({ resolveBucket: () => 'project:a', resolveTarget });
    const wakeup = new OrchestratorWakeup(manager, deps);
    wakeup.start();

    emit('project-a-worker', { type: 'done' });
    runTimer();
    await Promise.resolve();
    wakeup.invalidateBucket('project:a');
    finishResolve('old-orchestrator');
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not revive an invalidated flush when new activity arrives in the same bucket', async () => {
    const { manager, emit } = makeManager({ 'project-a-old': 'Old', 'project-a-new': 'New' });
    const callbacks: Array<() => void> = [];
    const resolvers: Array<(target: string) => void> = [];
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const wakeup = new OrchestratorWakeup(manager, {
      resolveBucket: () => 'project:a',
      resolveTarget: () => new Promise<string>(resolve => resolvers.push(resolve)),
      threadExists: () => true,
      sendMessage,
      setTimeoutFn: cb => { callbacks.push(cb); return cb; },
      clearTimeoutFn: () => {},
    });
    wakeup.start();

    emit('project-a-old', { type: 'done' });
    callbacks.shift()!();
    await Promise.resolve();
    wakeup.invalidateBucket('project:a');
    emit('project-a-new', { type: 'done' });
    callbacks.shift()!();
    await Promise.resolve();
    resolvers[0]!('old-orchestrator');
    resolvers[1]!('new-orchestrator');
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith('new-orchestrator', expect.stringContaining('project-a-new'));
  });

  describe('delegation suppression', () => {
    it('ignores events while suspended and sends nothing', async () => {
      const { manager, emit } = makeManager({ 'thread-1': 'T' });
      let suspended = true;
      const { deps, sendMessage, setTimeoutFn, runTimer } = makeDeps({ isSuspended: () => suspended });
      const wakeup = new OrchestratorWakeup(manager, deps);
      wakeup.start();

      emit('thread-1', { type: 'done' });
      expect(setTimeoutFn).not.toHaveBeenCalled();
      runTimer();
      await Promise.resolve();
      expect(sendMessage).not.toHaveBeenCalled();
      suspended = false;
    });

    it('discardAll drops pending batches and timers; later events ping exactly once (no double ping)', async () => {
      const { manager, emit } = makeManager({ 'thread-1': 'T' });
      let suspended = false;
      const clearTimeoutFn = vi.fn();
      const { deps, sendMessage, runTimer } = makeDeps({ isSuspended: () => suspended, clearTimeoutFn });
      const wakeup = new OrchestratorWakeup(manager, deps);
      wakeup.start();

      emit('thread-1', { type: 'done' }); // pending + armed
      suspended = true;
      wakeup.discardAll();
      expect(clearTimeoutFn).toHaveBeenCalled();
      emit('thread-1', { type: 'done' }); // ignored while suspended
      runTimer();
      await Promise.resolve();
      expect(sendMessage).not.toHaveBeenCalled();

      suspended = false; // delegate disposed
      emit('thread-1', { type: 'done' });
      runTimer();
      await Promise.resolve();
      await Promise.resolve();
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it('does not send when suspension begins while a flush is resolving its target', async () => {
      const { manager, emit } = makeManager({ 'thread-1': 'T' });
      let suspended = false;
      let release!: (id: string) => void;
      const { deps, sendMessage, runTimer } = makeDeps({
        isSuspended: () => suspended,
        resolveTarget: () => new Promise<string>((resolve) => { release = resolve; }),
      });
      const wakeup = new OrchestratorWakeup(manager, deps);
      wakeup.start();

      emit('thread-1', { type: 'done' });
      runTimer();
      suspended = true;
      wakeup.discardAll();
      release('orchestrator-thread');
      await new Promise((r) => setTimeout(r, 0));
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('delegation suppression edge cases', () => {
    it('absent isSuspended means never suspended', async () => {
      const { manager, emit } = makeManager({ 'thread-1': 'T' });
      const { deps, sendMessage, runTimer } = makeDeps();
      new OrchestratorWakeup(manager, deps).start();
      emit('thread-1', { type: 'done' });
      runTimer();
      await Promise.resolve();
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it('discardAll with no state is a no-op and does not throw', () => {
      const { manager } = makeManager();
      const { deps } = makeDeps({ isSuspended: () => true });
      expect(() => new OrchestratorWakeup(manager, deps).discardAll()).not.toThrow();
    });

    it('discardAll clears every bucket, not just one', async () => {
      const { manager, emit } = makeManager({ 'thread-1': 'T', 'project-a-1': 'P' });
      const timers: Array<() => void> = [];
      const setTimeoutFn = vi.fn((cb: () => void) => { timers.push(cb); return `h${timers.length}`; });
      const { deps, sendMessage } = makeDeps({ setTimeoutFn, isSuspended: () => false });
      const wakeup = new OrchestratorWakeup(manager, deps);
      wakeup.start();
      emit('thread-1', { type: 'done' });
      emit('project-a-1', { type: 'done' });
      wakeup.discardAll();
      expect(deps.clearTimeoutFn).toHaveBeenCalledTimes(2);
      timers.forEach((cb) => cb());
      await new Promise((r) => setTimeout(r, 0));
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('a flush already armed when suspension starts sends nothing and drops its pending batch', async () => {
      const { manager, emit } = makeManager({ 'thread-1': 'T' });
      let suspended = false;
      const { deps, sendMessage, runTimer } = makeDeps({ isSuspended: () => suspended });
      new OrchestratorWakeup(manager, deps).start();
      emit('thread-1', { type: 'done' });
      suspended = true; // no discardAll: the flush guard alone must hold
      runTimer();
      await new Promise((r) => setTimeout(r, 0));
      expect(sendMessage).not.toHaveBeenCalled();
      suspended = false;
      runTimer(); // nothing re-armed
      await new Promise((r) => setTimeout(r, 0));
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('suspension in the summaryOnly path sends nothing', async () => {
      const { manager, emit } = makeManager({ 'project-a-1': 'P' });
      let suspended = false;
      let release!: (v: { threadId: string; summaryOnly: true }) => void;
      const { deps, sendMessage, runTimer } = makeDeps({
        isSuspended: () => suspended,
        resolveTarget: () => new Promise((resolve) => { release = resolve as typeof release; }),
      });
      const wakeup = new OrchestratorWakeup(manager, deps);
      wakeup.start();
      emit('project-a-1', { type: 'done' });
      runTimer();
      suspended = true;
      wakeup.discardAll();
      release({ threadId: 'portfolio-orch', summaryOnly: true });
      await new Promise((r) => setTimeout(r, 0));
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('ignores interrupted events regardless of suspension (only done/error wake)', async () => {
      const { manager, emit } = makeManager({ 'thread-1': 'T' });
      const { deps, setTimeoutFn } = makeDeps();
      new OrchestratorWakeup(manager, deps).start();
      emit('thread-1', { type: 'interrupted' } as ThreadEvent);
      expect(setTimeoutFn).not.toHaveBeenCalled();
    });

    it('orchestrator thread removed while suspension lapses: no send, warns', async () => {
      const { manager, emit } = makeManager({ 'thread-1': 'T' });
      const onWarn = vi.fn();
      const { deps, sendMessage, runTimer } = makeDeps({ threadExists: () => false, onWarn });
      new OrchestratorWakeup(manager, deps).start();
      emit('thread-1', { type: 'done' });
      runTimer();
      await new Promise((r) => setTimeout(r, 0));
      expect(sendMessage).not.toHaveBeenCalled();
      expect(onWarn).toHaveBeenCalled();
    });

    // Claim then release while a flush is already awaiting resolveTarget: the batch
    // was captured BEFORE delegation, so it must be discarded (design: delegation
    // discards pending batches), otherwise core pings after the delegate gave
    // control back for events the delegate already owned.
    it('a flush in flight across a full claim+release cycle does not ping (batch discarded)', async () => {
      const { manager, emit } = makeManager({ 'thread-1': 'T' });
      let suspended = false;
      let release!: (id: string) => void;
      const { deps, sendMessage, runTimer } = makeDeps({
        isSuspended: () => suspended,
        resolveTarget: () => new Promise<string>((resolve) => { release = resolve; }),
      });
      const wakeup = new OrchestratorWakeup(manager, deps);
      wakeup.start();
      emit('thread-1', { type: 'done' });
      runTimer(); // flush now awaiting resolveTarget; timers/pending already cleared
      suspended = true;
      wakeup.discardAll();
      suspended = false; // delegate disposed before target resolved
      release('orchestrator-thread');
      await new Promise((r) => setTimeout(r, 0));
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });
});

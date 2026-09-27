import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler, type SchedulerOptions } from '../../src/Scheduler';

// Scheduler uses window.setTimeout/clearTimeout; alias window to globalThis so
// the fake timers installed by vitest are what the scheduler arms.
beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as Record<string, unknown>).window = globalThis;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).window;
});

function makeOptions(overrides: Partial<SchedulerOptions> = {}): {
  options: SchedulerOptions;
  sendMessage: ReturnType<typeof vi.fn>;
  createThread: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const createThread = vi.fn().mockReturnValue({ id: 'new-thread' });
  const options: SchedulerOptions = {
    getItems: () => [],
    saveItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
    createThread,
    sendMessage,
    getDefaultCwd: () => '/tmp',
    ...overrides,
  };
  return { options, sendMessage, createThread };
}

describe('Scheduler targetThreadId (loops)', () => {
  it('sends the prompt into the existing target thread when it exists', async () => {
    const { options, sendMessage, createThread } = makeOptions({
      threadExists: (id) => id === 'thread-1',
    });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    await scheduler.createItem({
      name: 'Loop: check build',
      prompt: 'check the build',
      schedule: { type: 'interval', intervalSeconds: 60 },
      enabled: true,
      targetThreadId: 'thread-1',
    });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(sendMessage).toHaveBeenCalledWith('thread-1', 'check the build');
    expect(createThread).not.toHaveBeenCalled();
    scheduler.destroy();
  });

  it('falls back to creating a new thread when the target thread is gone', async () => {
    const { options, sendMessage, createThread } = makeOptions({
      threadExists: () => false,
    });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    await scheduler.createItem({
      name: 'Loop: check build',
      prompt: 'check the build',
      schedule: { type: 'interval', intervalSeconds: 60 },
      enabled: true,
      targetThreadId: 'deleted-thread',
    });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(createThread).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('new-thread', 'check the build');
    scheduler.destroy();
  });

  it('creates a new thread when threadExists is not provided (backwards compat)', async () => {
    const { options, sendMessage, createThread } = makeOptions();
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    await scheduler.createItem({
      name: 'Loop: check build',
      prompt: 'check the build',
      schedule: { type: 'interval', intervalSeconds: 60 },
      enabled: true,
      targetThreadId: 'thread-1',
    });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(createThread).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('new-thread', 'check the build');
    scheduler.destroy();
  });
});

describe('Scheduler isOrchestratorHeartbeat (stale target guard)', () => {
  it('does not create a replacement thread or send a message when the heartbeat target is gone', async () => {
    const onOrchestratorHeartbeatStale = vi.fn();
    const { options, sendMessage, createThread } = makeOptions({
      threadExists: () => false,
      onOrchestratorHeartbeatStale,
    });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    const item = await scheduler.createItem({
      name: 'Thread Orchestrator Heartbeat',
      prompt: 'Heartbeat: run your review pass across all threads.',
      schedule: { type: 'interval', intervalSeconds: 3600 },
      enabled: true,
      targetThreadId: 'deleted-orchestrator-thread',
      isOrchestratorHeartbeat: true,
    });

    await vi.advanceTimersByTimeAsync(3601_000);

    expect(createThread).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(onOrchestratorHeartbeatStale).toHaveBeenCalledOnce();
    expect(onOrchestratorHeartbeatStale.mock.calls[0][0].id).toBe(item.id);

    // lastRun/nextRun still advance so the item doesn't spin retrying every cycle.
    const fresh = scheduler.getItem(item.id);
    expect(fresh?.lastRun).toBeDefined();
    expect(fresh?.nextRun).toBeGreaterThan(Date.now());

    scheduler.destroy();
  });

  it('sends into the existing thread normally when the heartbeat target still exists', async () => {
    const onOrchestratorHeartbeatStale = vi.fn();
    const { options, sendMessage, createThread } = makeOptions({
      threadExists: (id) => id === 'orchestrator-thread',
      onOrchestratorHeartbeatStale,
    });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    await scheduler.createItem({
      name: 'Thread Orchestrator Heartbeat',
      prompt: 'Heartbeat: run your review pass across all threads.',
      schedule: { type: 'interval', intervalSeconds: 3600 },
      enabled: true,
      targetThreadId: 'orchestrator-thread',
      isOrchestratorHeartbeat: true,
    });

    await vi.advanceTimersByTimeAsync(3601_000);

    expect(sendMessage).toHaveBeenCalledWith('orchestrator-thread', 'Heartbeat: run your review pass across all threads.');
    expect(createThread).not.toHaveBeenCalled();
    expect(onOrchestratorHeartbeatStale).not.toHaveBeenCalled();

    scheduler.destroy();
  });
});

describe('Scheduler isThreadBusy (dedup pileup guard)', () => {
  it('skips sending and retries when the target thread is busy', async () => {
    const { options, sendMessage } = makeOptions({
      threadExists: (id) => id === 'thread-1',
      isThreadBusy: () => true,
    });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    const item = await scheduler.createItem({
      name: 'Loop: check build',
      prompt: 'check the build',
      schedule: { type: 'interval', intervalSeconds: 60 },
      enabled: true,
      targetThreadId: 'thread-1',
    });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(scheduler.getItem(item.id)?.lastRun).toBeUndefined();
    // A retry timer should be registered under the same item id.
    expect((scheduler as unknown as { timers: Map<string, number> }).timers.size).toBe(1);

    scheduler.destroy();
  });

  it('retries and sends once the thread frees up', async () => {
    let busy = true;
    const { options, sendMessage } = makeOptions({
      threadExists: (id) => id === 'thread-1',
      isThreadBusy: () => busy,
    });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    await scheduler.createItem({
      name: 'Loop: check build',
      prompt: 'check the build',
      schedule: { type: 'interval', intervalSeconds: 60 },
      enabled: true,
      targetThreadId: 'thread-1',
    });

    // First tick: thread busy, retry armed (retryMs = min(15s, 60s) = 15s).
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendMessage).not.toHaveBeenCalled();

    // Still busy through the first retry window.
    await vi.advanceTimersByTimeAsync(14_000);
    expect(sendMessage).not.toHaveBeenCalled();

    // Thread frees up; next retry should succeed.
    busy = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('thread-1', 'check the build');

    scheduler.destroy();
  });

  it('cancels the pending busy-retry when the item is deleted', async () => {
    const { options, sendMessage } = makeOptions({
      threadExists: (id) => id === 'thread-1',
      isThreadBusy: () => true,
    });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    const item = await scheduler.createItem({
      name: 'Loop: check build',
      prompt: 'check the build',
      schedule: { type: 'interval', intervalSeconds: 60 },
      enabled: true,
      targetThreadId: 'thread-1',
    });

    await vi.advanceTimersByTimeAsync(61_000);
    expect(sendMessage).not.toHaveBeenCalled();
    expect((scheduler as unknown as { timers: Map<string, number> }).timers.size).toBe(1);

    await scheduler.deleteItem(item.id);

    // deleteItem must clear the pending retry timer, not just the item.
    expect((scheduler as unknown as { timers: Map<string, number> }).timers.size).toBe(0);

    // Advance well past when the retry (and any subsequent retries) would
    // have fired if the timer had leaked.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sendMessage).not.toHaveBeenCalled();

    scheduler.destroy();
  });

  // A new-thread item IS overlap-guarded from its second cycle onward (see
  // scheduler-overlap-skip.test.ts), but the first cycle has no previous run to
  // conflict with, so a busy-reporting isThreadBusy must not block it.
  it('fires a non-loop item on its first cycle even when isThreadBusy reports busy', async () => {
    const { options, sendMessage, createThread } = makeOptions({
      isThreadBusy: () => true,
    });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    await scheduler.createItem({
      name: 'One-off reminder',
      prompt: 'do the thing',
      schedule: { type: 'interval', intervalSeconds: 60 },
      enabled: true,
    });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(createThread).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('new-thread', 'do the thing');

    scheduler.destroy();
  });
});

describe('Scheduler createThread scheduledItemId', () => {
  it('passes the scheduled item id as the 4th argument to createThread when firing', async () => {
    const { options, createThread } = makeOptions();
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    const item = await scheduler.createItem({
      name: 'One-off reminder',
      prompt: 'do the thing',
      schedule: { type: 'interval', intervalSeconds: 60 },
      enabled: true,
    });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(createThread).toHaveBeenCalledWith('One-off reminder', '/tmp', undefined, item.id);

    scheduler.destroy();
  });
});

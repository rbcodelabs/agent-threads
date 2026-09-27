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

/**
 * Builds SchedulerOptions with a createThread that hands out a distinct id per
 * call, so a test can tell which cycle produced which thread (and assert that a
 * skipped cycle produced none at all).
 */
function makeOptions(overrides: Partial<SchedulerOptions> = {}): {
  options: SchedulerOptions;
  sendMessage: ReturnType<typeof vi.fn>;
  createThread: ReturnType<typeof vi.fn>;
} {
  let seq = 0;
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const createThread = vi.fn(() => ({ id: `thread-${++seq}` }));
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

const INTERVAL = { type: 'interval' as const, intervalSeconds: 60 };

describe('Scheduler overlap guard (new-thread jobs)', () => {
  it('skips the cycle when the previous run is still in flight', async () => {
        // Always busy: the first cycle has no prior thread so it fires; every
        // cycle after that must be dropped rather than stacked.
    const { options, createThread } = makeOptions({ isThreadBusy: () => true });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    const item = await scheduler.createItem({
      name: 'Comment sweep',
      prompt: 'handle the comments',
      schedule: INTERVAL,
      enabled: true,
    });

    await vi.advanceTimersByTimeAsync(61_000);
    expect(createThread).toHaveBeenCalledTimes(1);
    const afterFirstFire = scheduler.getItem(item.id);
    const lastRunAfterFire = afterFirstFire?.lastRun;
    expect(lastRunAfterFire).toBeDefined();

    // Second cycle comes due while thread-1 is still running.
    await vi.advanceTimersByTimeAsync(61_000);

    expect(createThread).toHaveBeenCalledTimes(1);
    const skipped = scheduler.getItem(item.id);
    expect(skipped?.lastSkipReason).toBe('busy');
    // Nothing ran, so lastRun must not advance.
    expect(skipped?.lastRun).toBe(lastRunAfterFire);
    // But the item stays on cadence rather than stalling.
    expect(skipped?.nextRun).toBeGreaterThan(Date.now());

    const history = skipped?.runHistory ?? [];
    expect(history.map((e) => e.outcome)).toEqual(['fired', 'skipped-busy']);
    // The skip records which thread blocked it, for diagnosis.
    expect(history[1].threadId).toBe('thread-1');

    scheduler.destroy();
  });

  it('keeps skipping without stacking threads while the run stays in flight', async () => {
    const { options, createThread } = makeOptions({ isThreadBusy: () => true });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    const item = await scheduler.createItem({
      name: 'Comment sweep',
      prompt: 'handle the comments',
      schedule: INTERVAL,
      enabled: true,
    });

    // Ten intervals pass with the first run never finishing.
    await vi.advanceTimersByTimeAsync(61_000 + 10 * 60_000);

    // Exactly one thread total — the pile-up this guard exists to prevent.
    expect(createThread).toHaveBeenCalledTimes(1);
    const history = scheduler.getItem(item.id)?.runHistory ?? [];
    expect(history.filter((e) => e.outcome === 'fired')).toHaveLength(1);
    expect(history.filter((e) => e.outcome === 'skipped-busy').length).toBeGreaterThanOrEqual(9);

    scheduler.destroy();
  });

  it('fires the next cycle once the previous run finishes, and clears the skip reason', async () => {
    let busy = true;
    const { options, createThread } = makeOptions({ isThreadBusy: () => busy });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    const item = await scheduler.createItem({
      name: 'Comment sweep',
      prompt: 'handle the comments',
      schedule: INTERVAL,
      enabled: true,
    });

    await vi.advanceTimersByTimeAsync(61_000);
    expect(createThread).toHaveBeenCalledTimes(1);

    // A cycle is skipped while busy.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(scheduler.getItem(item.id)?.lastSkipReason).toBe('busy');

    // The run finishes; the following cycle fires normally.
    busy = false;
    await vi.advanceTimersByTimeAsync(61_000);

    expect(createThread).toHaveBeenCalledTimes(2);
    const fresh = scheduler.getItem(item.id);
    // A successful dispatch must not strand the previous cycle's skip reason.
    expect(fresh?.lastSkipReason).toBeUndefined();
    expect(fresh?.lastThreadId).toBe('thread-2');

    scheduler.destroy();
  });

  it('fires when the previous thread is gone (isThreadBusy false for unknown ids)', async () => {
    // Mirrors ThreadManager.isRunning, which returns false for a thread with no
    // live session — archived, deleted, or never resumed. The guard must fail
    // open here rather than wedging the job forever.
    const { options, createThread } = makeOptions({
      isThreadBusy: (id) => id === 'some-other-live-thread',
    });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    await scheduler.createItem({
      name: 'Comment sweep',
      prompt: 'handle the comments',
      schedule: INTERVAL,
      enabled: true,
    });

    await vi.advanceTimersByTimeAsync(61_000);
    await vi.advanceTimersByTimeAsync(61_000);

    expect(createThread).toHaveBeenCalledTimes(2);

    scheduler.destroy();
  });

  it('fires normally when isThreadBusy is not supplied (backwards compat)', async () => {
    const { options, createThread } = makeOptions();
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    const item = await scheduler.createItem({
      name: 'Comment sweep',
      prompt: 'handle the comments',
      schedule: INTERVAL,
      enabled: true,
    });

    await vi.advanceTimersByTimeAsync(61_000);
    await vi.advanceTimersByTimeAsync(61_000);

    expect(createThread).toHaveBeenCalledTimes(2);
    expect(scheduler.getItem(item.id)?.lastSkipReason).toBeUndefined();

    scheduler.destroy();
  });

  it('does not skip a loop item — the reuse path still retries instead', async () => {
    // A targetThreadId item wants its tick delivered into that thread, so it
    // defers rather than dropping the cycle. Assert the busy-skip bookkeeping
    // does not leak into that path.
    const { options, sendMessage } = makeOptions({
      threadExists: (id) => id === 'loop-thread',
      isThreadBusy: () => true,
    });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    const item = await scheduler.createItem({
      name: 'Loop: check build',
      prompt: 'check the build',
      schedule: INTERVAL,
      enabled: true,
      targetThreadId: 'loop-thread',
    });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(sendMessage).not.toHaveBeenCalled();
    const fresh = scheduler.getItem(item.id);
    expect(fresh?.lastSkipReason).toBeUndefined();
    expect(fresh?.runHistory ?? []).toHaveLength(0);

    scheduler.destroy();
  });

  it('does not skip an orchestrator heartbeat whose target is gone', async () => {
    // The heartbeat notifies instead of creating a thread, so there is no
    // overlap to guard against; a busy prior thread must not silence it.
    const onOrchestratorHeartbeatStale = vi.fn();
    const { options, createThread } = makeOptions({
      threadExists: () => false,
      isThreadBusy: () => true,
      onOrchestratorHeartbeatStale,
    });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    await scheduler.createItem({
      name: 'Thread Orchestrator Heartbeat',
      prompt: 'Heartbeat: run your review pass.',
      schedule: { type: 'interval', intervalSeconds: 3600 },
      enabled: true,
      targetThreadId: 'deleted-orchestrator-thread',
      isOrchestratorHeartbeat: true,
    });

    await vi.advanceTimersByTimeAsync(3601_000);
    await vi.advanceTimersByTimeAsync(3601_000);

    expect(createThread).not.toHaveBeenCalled();
    expect(onOrchestratorHeartbeatStale).toHaveBeenCalledTimes(2);

    scheduler.destroy();
  });
});

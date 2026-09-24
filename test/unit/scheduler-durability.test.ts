import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler, type SchedulerOptions } from '../../src/Scheduler';
import type { ScheduledItem } from '../../src/types';

// Regression coverage for the cron-persistence race: Scheduler.createItem/
// updateItem/deleteItem used to fire-and-forget their disk writes, so a
// caller (e.g. the CronUpdate MCP tool) could observe "success" before
// data.json actually reflected the change. If a plugin reload happened in
// that window, the new instance loaded stale pre-write data and could
// resurrect a just-disabled item. These tests confirm the mutators now await
// their own persistence before resolving, and that a second Scheduler
// instance constructed against the same disk after an awaited disable never
// re-arms the item.
//
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

/**
 * A tiny mutable in-memory "disk" — stands in for data.json shared by two
 * coexisting plugin instances (mirrors the helper in scheduler-fencing.test.ts).
 */
function makeSharedDisk(initial: ScheduledItem[] = []) {
  let items = initial.map((i) => ({ ...i }));
  return {
    read: (): ScheduledItem[] => items.map((i) => ({ ...i })),
    write: (next: ScheduledItem[]): void => {
      items = next.map((i) => ({ ...i }));
    },
  };
}

describe('Scheduler mutator durability', () => {
  it('keeps a failed deletion discoverable so an archive retry must persist it', async () => {
    const removeItem = vi.fn().mockRejectedValueOnce(new Error('disk unavailable')).mockResolvedValue(undefined);
    const { options } = makeOptions({ removeItem });
    const scheduler = new Scheduler(options);
    const item = await scheduler.createItem({ name: 'Wake', prompt: 'Wake', schedule: { type: 'interval', intervalSeconds: 3600 } });
    await expect(scheduler.deleteItem(item.id)).rejects.toThrow('disk unavailable');
    expect(scheduler.listItems().map(item => item.id)).toContain(item.id);
    await scheduler.deleteItem(item.id);
    expect(removeItem).toHaveBeenCalledTimes(2);
    expect(scheduler.listItems()).toEqual([]);
    scheduler.destroy();
  });
  it('updateItem does not resolve until saveItem resolves, even though in-memory state updates immediately', async () => {
    let resolveSave: (() => void) | undefined;
    const saveItem = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const { options } = makeOptions({ saveItem });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    // createItem's own save must resolve for setup — give it an immediate mock first.
    saveItem.mockResolvedValueOnce(undefined);
    const item = await scheduler.createItem({
      name: 'Nightly digest',
      prompt: 'send the digest',
      schedule: { type: 'interval', intervalSeconds: 3600 },
      enabled: true,
    });

    // Now swap in the delayed implementation for the update under test.
    saveItem.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );

    let updateResolved = false;
    const updatePromise = scheduler.updateItem(item.id, { enabled: false }).then((updated) => {
      updateResolved = true;
      return updated;
    });

    // Let any pending microtasks run without resolving the save.
    await Promise.resolve();
    await Promise.resolve();

    // In-memory state must already reflect the update (optimistic sync mutation)...
    expect(scheduler.getItem(item.id)?.enabled).toBe(false);
    // ...but the promise returned to the caller must not have resolved yet.
    expect(updateResolved).toBe(false);

    // Now let the mocked disk write land.
    expect(resolveSave).toBeDefined();
    resolveSave!();
    const updated = await updatePromise;

    expect(updateResolved).toBe(true);
    expect(updated.enabled).toBe(false);

    scheduler.destroy();
  });

  it('updateItem rejects and leaves the rejection visible to the caller when saveItem fails', async () => {
    const saveItem = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk full'));
    const { options } = makeOptions({ saveItem });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    const item = await scheduler.createItem({
      name: 'Nightly digest',
      prompt: 'send the digest',
      schedule: { type: 'interval', intervalSeconds: 3600 },
      enabled: true,
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(scheduler.updateItem(item.id, { enabled: false })).rejects.toThrow('disk full');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();

    scheduler.destroy();
  });
});

describe('Scheduler cron-persistence race regression', () => {
  it('a disable that has been awaited on instance A is never resurrected by a second instance loading the same disk', async () => {
    const item: ScheduledItem = {
      id: 'amazon-export',
      name: 'Amazon Monthly Data Export',
      prompt: 'run the export',
      schedule: { type: 'interval', intervalSeconds: 60 },
      enabled: true,
      nextRun: Date.now() - 5_000, // already overdue, as in the real incident
    };

    const disk = makeSharedDisk([item]);
    const sendMessageA = vi.fn().mockResolvedValue(undefined);
    const createThreadA = vi.fn().mockReturnValue({ id: 'thread-a' });
    const sendMessageB = vi.fn().mockResolvedValue(undefined);
    const createThreadB = vi.fn().mockReturnValue({ id: 'thread-b' });

    const makeInstanceOptions = (
      sendMessage: ReturnType<typeof vi.fn>,
      createThread: ReturnType<typeof vi.fn>,
    ): SchedulerOptions => ({
      getItems: () => disk.read(),
      saveItem: async (saved) => {
        const items = disk.read();
        const idx = items.findIndex((i) => i.id === saved.id);
        if (idx >= 0) items[idx] = saved;
        else items.push(saved);
        disk.write(items);
      },
      removeItem: async (id) => {
        disk.write(disk.read().filter((i) => i.id !== id));
      },
      createThread,
      sendMessage,
      getDefaultCwd: () => '/tmp',
    });

    // Instance A: the "old" plugin instance that disables the item. Because
    // updateItem now awaits its own save, by the time this line resolves the
    // shared disk is guaranteed to already reflect the disable.
    const schedulerA = new Scheduler(makeInstanceOptions(sendMessageA, createThreadA));
    schedulerA.start([item]);
    await schedulerA.updateItem(item.id, { enabled: false });

    expect(disk.read().find((i) => i.id === item.id)?.enabled).toBe(false);

    // Instance B: simulates a plugin reload constructing a fresh Scheduler
    // against the same on-disk data. It must load the disabled state and arm
    // no timers for it.
    const schedulerB = new Scheduler(makeInstanceOptions(sendMessageB, createThreadB));
    schedulerB.start(disk.read());

    expect(schedulerB.getItem(item.id)?.enabled).toBe(false);
    expect((schedulerB as unknown as { timers: Map<string, number> }).timers.size).toBe(0);

    // Advance well past the old overdue nextRun and any catch-up delay —
    // no thread should ever be created on either instance.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(createThreadA).not.toHaveBeenCalled();
    expect(sendMessageA).not.toHaveBeenCalled();
    expect(createThreadB).not.toHaveBeenCalled();
    expect(sendMessageB).not.toHaveBeenCalled();

    schedulerA.destroy();
    schedulerB.destroy();
  });
});

describe('Scheduler catch-up staggering', () => {
  it('staggers successive overdue items at start() and logs a warning for the second+', async () => {
    const now = Date.now();
    const itemA: ScheduledItem = {
      id: 'overdue-a',
      name: 'Overdue Item A',
      prompt: 'do a',
      schedule: { type: 'interval', intervalSeconds: 60 },
      enabled: true,
      nextRun: now - 1_000,
    };
    const itemB: ScheduledItem = {
      id: 'overdue-b',
      name: 'Overdue Item B',
      prompt: 'do b',
      schedule: { type: 'interval', intervalSeconds: 60 },
      enabled: true,
      nextRun: now - 1_000,
    };

    const { options, sendMessage, createThread } = makeOptions();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const scheduler = new Scheduler(options);
    scheduler.start([itemA, itemB]);

    // First item fires at the base 5s catch-up delay; second is staggered an
    // additional 2s out (5s + 1*2s = 7s), not simultaneously with the first.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(createThread).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(createThread).toHaveBeenCalledTimes(2);

    // The second (staggered) catch-up fire must have logged a warning naming it.
    const warnedAboutB = warnSpy.mock.calls.some((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('Overdue Item B')),
    );
    expect(warnedAboutB).toBe(true);

    warnSpy.mockRestore();
    scheduler.destroy();
  });
});

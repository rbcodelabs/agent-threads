import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler, CATCHUP_GRACE_MS, type SchedulerOptions } from '../../src/Scheduler';
import type { ScheduledItem } from '../../src/types';

// A restart must not fire every job whose slot passed hours ago while the app
// was closed. Overdue within the grace window still catches up; stale misses
// are skipped and advanced; one-shots always fire.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 12, 11, 46, 0)); // Monday 11:46 local
  (globalThis as Record<string, unknown>).window = globalThis;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).window;
});

function setup() {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const createThread = vi.fn().mockReturnValue({ id: 'new-thread' });
  const saveItem = vi.fn().mockResolvedValue(undefined);
  const options: SchedulerOptions = {
    getItems: () => [],
    saveItem,
    removeItem: vi.fn().mockResolvedValue(undefined),
    createThread,
    sendMessage,
    getDefaultCwd: () => '/tmp',
  };
  return { options, sendMessage, createThread, saveItem };
}

function item(over: Partial<ScheduledItem>): ScheduledItem {
  return {
    id: 'i1',
    name: 'job',
    prompt: 'go',
    schedule: { type: 'daily', timeOfDay: '08:00' },
    enabled: true,
    ...over,
  };
}

describe('Scheduler stale missed-run catch-up', () => {
  it('still catches up an item overdue within the grace window', async () => {
    const { options, createThread } = setup();
    const s = new Scheduler(options);
    s.start([item({ nextRun: Date.now() - 60_000 })]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(createThread).toHaveBeenCalledTimes(1);
    s.destroy();
  });

  it.each([
    ['daily', { type: 'daily', timeOfDay: '08:00' }],
    ['weekly', { type: 'weekly', timeOfDay: '08:00', daysOfWeek: [1] }],
    ['interval', { type: 'interval', intervalSeconds: 3600 }],
  ] as const)('does not fire a stale %s item and advances nextRun', async (_n, schedule) => {
    const { options, createThread, saveItem } = setup();
    const s = new Scheduler(options);
    const staleAt = Date.now() - 3 * 60 * 60_000;
    s.start([item({ schedule: { ...schedule }, nextRun: staleAt, lastRun: 123 })]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(createThread).not.toHaveBeenCalled();
    const got = s.getItem('i1')!;
    expect(got.nextRun).toBeGreaterThan(Date.now());
    expect(got.lastRun).toBe(123);
    expect(saveItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1', nextRun: got.nextRun }));
    s.destroy();
  });

  it('does not storm: many stale items fire nothing on boot', async () => {
    const { options, createThread } = setup();
    const s = new Scheduler(options);
    const items = Array.from({ length: 14 }, (_, n) =>
      item({ id: `j${n}`, nextRun: Date.now() - 3 * 60 * 60_000 }),
    );
    s.start(items);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(createThread).not.toHaveBeenCalled();
    s.destroy();
  });

  it('treats exactly-at-grace as catch-up, just beyond as stale', async () => {
    const { options, createThread } = setup();
    const s = new Scheduler(options);
    s.start([
      item({ id: 'edge', nextRun: Date.now() - CATCHUP_GRACE_MS }),
      item({ id: 'past', nextRun: Date.now() - CATCHUP_GRACE_MS - 1 }),
    ]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(createThread).toHaveBeenCalledTimes(1);
    s.destroy();
  });

  it('still fires a stale one-shot', async () => {
    const { options, createThread } = setup();
    const s = new Scheduler(options);
    const fireAt = Date.now() - 5 * 60 * 60_000;
    s.start([item({ schedule: { type: 'once', fireAt }, nextRun: fireAt })]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(createThread).toHaveBeenCalledTimes(1);
    s.destroy();
  });
});

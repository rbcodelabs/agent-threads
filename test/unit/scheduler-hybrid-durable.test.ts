import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_SCHEDULER_TIMEOUT_MS,
  Scheduler,
  computeNextRun,
  type SchedulerOptions,
} from '../../src/Scheduler';
import type { ScheduledItem } from '../../src/types';
import { ScheduleCoordinator } from '../../src/ScheduleCoordinator';

// The calendar tests below assert on LOCAL wall-clock fields (`getDate`,
// `getHours`) of the instant node-cron returns, and they exist to pin DST
// behaviour — which only means anything in a zone that observes DST. Left to
// the ambient zone they are not deterministic: `2026-03-07T10:00:00-05:00` is
// 10:00 in America/New_York (so the next 09:30 is the 8th, across the spring
// forward) but 09:00 in America/Chicago (so the next 09:30 is the 7th, and the
// assertion fails on any developer machine west of Eastern). Pin the zone so
// the expected values are a property of the schedule, not of who ran the test.
//
// `vi.hoisted` runs before the imports above, so `node-cron` and `Scheduler`
// are evaluated with TZ already set rather than capturing the ambient zone.
const originalTZ = vi.hoisted(() => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  return previous;
});

afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T12:00:00-05:00'));
  (globalThis as Record<string, unknown>).window = globalThis;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).window;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function makeOptions(overrides: Partial<SchedulerOptions> = {}) {
  const items: ScheduledItem[] = [];
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const createThread = vi.fn().mockReturnValue({ id: 'new-thread' });
  const options: SchedulerOptions = {
    getItems: () => items.map((item) => ({ ...item })),
    saveItem: vi.fn(async (saved: ScheduledItem) => {
      const index = items.findIndex((item) => item.id === saved.id);
      if (index >= 0) items[index] = { ...saved };
      else items.push({ ...saved });
    }),
    removeItem: vi.fn(async (id: string) => {
      const index = items.findIndex((item) => item.id === id);
      if (index >= 0) items.splice(index, 1);
    }),
    createThread,
    sendMessage,
    getDefaultCwd: () => '/tmp',
    ...overrides,
  };
  return { options, items, sendMessage, createThread };
}

describe('durable deadline heartbeat', () => {
  it('never arms beyond one day and a 30-day interval fires exactly once at its deadline', async () => {
    const { options, sendMessage, createThread } = makeOptions();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    await scheduler.createItem({
      name: 'Amazon Monthly Data Export',
      prompt: 'export data',
      schedule: { type: 'interval', intervalSeconds: 30 * 24 * 60 * 60 },
      enabled: true,
    });

    expect(Math.max(...setTimeoutSpy.mock.calls.map((call) => Number(call[1] ?? 0))))
      .toBeLessThanOrEqual(MAX_SCHEDULER_TIMEOUT_MS);

    await vi.advanceTimersByTimeAsync(29 * 24 * 60 * 60 * 1000);
    expect(createThread).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    scheduler.destroy();
  });

  it('daily heartbeat chunks rearm without requesting an early execution', async () => {
    const { options, sendMessage } = makeOptions();
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    await scheduler.createItem({
      name: 'Long deadline',
      prompt: 'wait for it',
      schedule: { type: 'once', fireAt: Date.now() + 3 * 24 * 60 * 60 * 1000 },
      enabled: true,
    });

    await vi.advanceTimersByTimeAsync(MAX_SCHEDULER_TIMEOUT_MS);
    expect(sendMessage).not.toHaveBeenCalled();
    expect((scheduler as unknown as { timers: Map<string, number> }).timers.size).toBe(1);

    await vi.advanceTimersByTimeAsync(2 * MAX_SCHEDULER_TIMEOUT_MS);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    scheduler.destroy();
  });
});

describe('node-cron calendar calculation', () => {
  it('keeps daily schedules at the same local wall-clock time across spring DST', () => {
    vi.setSystemTime(new Date('2026-03-07T10:00:00-05:00'));
    const item: ScheduledItem = {
      id: 'daily', name: 'Daily', prompt: 'run', enabled: true,
      schedule: { type: 'daily', timeOfDay: '09:30' },
    };

    const next = new Date(computeNextRun(item, true));
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(2);
    expect(next.getDate()).toBe(8);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(30);
  });

  it('keeps weekly schedules on the configured local weekday across fall DST', () => {
    vi.setSystemTime(new Date('2026-10-31T10:00:00-04:00'));
    const item: ScheduledItem = {
      id: 'weekly', name: 'Weekly', prompt: 'run', enabled: true,
      schedule: { type: 'weekly', timeOfDay: '09:30', daysOfWeek: [0] },
    };

    const next = new Date(computeNextRun(item, true));
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(10);
    expect(next.getDate()).toBe(1);
    expect(next.getDay()).toBe(0);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(30);
  });
});

describe('disable reauthorization', () => {
  it('does not dispatch when disabled while the durable claim persistence is blocked', async () => {
    const claimSave = deferred<void>();
    let saveCount = 0;
    const { options, createThread, sendMessage } = makeOptions({
      saveItem: vi.fn(async () => {
        saveCount += 1;
        if (saveCount === 2) await claimSave.promise;
      }),
    });
    const scheduler = new Scheduler(options);
    scheduler.start([]);
    const item = await scheduler.createItem({
      name: 'Claim race', prompt: 'run', schedule: { type: 'interval', intervalSeconds: 1 }, enabled: true,
    });

    vi.setSystemTime(item.nextRun!);
    const firePromise = (scheduler as unknown as { requestFire: (id: string, dueAt: number) => Promise<void> })
      .requestFire(item.id, item.nextRun!);
    await Promise.resolve();
    const disablePromise = scheduler.updateItem(item.id, { enabled: false });
    expect(scheduler.getItem(item.id)?.enabled).toBe(false);
    claimSave.resolve();
    await Promise.all([firePromise, disablePromise]);

    expect(createThread).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(scheduler.getItem(item.id)?.enabled).toBe(false);
    scheduler.destroy();
  });

  it('does not dispatch when disabled while the gate is blocked', async () => {
    const gateResult = deferred<{ exitCode: number; stdout: string; timedOut: boolean }>();
    const { options, createThread, sendMessage } = makeOptions({
      runGate: vi.fn(() => gateResult.promise),
    });
    const scheduler = new Scheduler(options);
    scheduler.start([]);
    const item = await scheduler.createItem({
      name: 'Gate race', prompt: 'run', schedule: { type: 'interval', intervalSeconds: 1 }, enabled: true,
      gate: { command: 'test -s work.txt' },
    });

    vi.setSystemTime(item.nextRun!);
    const firePromise = (scheduler as unknown as { requestFire: (id: string, dueAt: number) => Promise<void> })
      .requestFire(item.id, item.nextRun!);
    await Promise.resolve();
    await scheduler.updateItem(item.id, { enabled: false });
    gateResult.resolve({ exitCode: 0, stdout: 'ready', timedOut: false });
    await firePromise;

    expect(createThread).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(scheduler.getItem(item.id)?.enabled).toBe(false);
    scheduler.destroy();
  });

  it('preserves a disable and does not rearm after an already-started send settles', async () => {
    const send = deferred<void>();
    const sendMessage = vi.fn(() => send.promise);
    const { options } = makeOptions({ sendMessage });
    const scheduler = new Scheduler(options);
    scheduler.start([]);
    const item = await scheduler.createItem({
      name: 'Send race', prompt: 'run', schedule: { type: 'interval', intervalSeconds: 1 }, enabled: true,
    });

    vi.setSystemTime(item.nextRun!);
    const firePromise = (scheduler as unknown as { requestFire: (id: string, dueAt: number) => Promise<void> })
      .requestFire(item.id, item.nextRun!);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    await scheduler.updateItem(item.id, { enabled: false });
    send.resolve();
    await firePromise;

    expect(scheduler.getItem(item.id)?.enabled).toBe(false);
    expect((scheduler as unknown as { timers: Map<string, number> }).timers.size).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    scheduler.destroy();
  });
});

describe('serialized occurrence claims', () => {
  it('releases durable state after the last scheduler instance is destroyed', async () => {
    const firstOptions = makeOptions();
    const first = new Scheduler(firstOptions.options);
    first.start([{
      id: 'reused-id', name: 'First generation', prompt: 'first', enabled: true,
      schedule: { type: 'interval', intervalSeconds: 60 },
      nextRun: Date.now() - 1_000,
    }]);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(firstOptions.sendMessage).toHaveBeenCalledWith('new-thread', 'first');
    first.destroy();

    const runGate = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'second', timedOut: false });
    const secondOptions = makeOptions({ runGate });
    const second = new Scheduler(secondOptions.options);
    second.start([{
      id: 'reused-id', name: 'Second generation', prompt: '{{gateOutput}}', enabled: true,
      schedule: { type: 'interval', intervalSeconds: 60 },
      nextRun: Date.now() - 1_000,
      gate: { command: 'check-second-generation' },
    }]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(runGate).toHaveBeenCalledWith(
      'check-second-generation',
      expect.objectContaining({ cwd: '/tmp' }),
    );
    expect(secondOptions.sendMessage).toHaveBeenCalledWith('new-thread', 'second');
    second.destroy();
  });

  it('admits one external dispatch across two scheduler instances without an async claim barrier', async () => {
    const persisted: ScheduledItem[] = [];
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const createThread = vi.fn().mockReturnValue({ id: 'shared-thread' });
    const options: SchedulerOptions = {
      getItems: () => persisted.map((item) => ({ ...item })),
      saveItem: async (saved) => {
        const index = persisted.findIndex((item) => item.id === saved.id);
        if (index >= 0) persisted[index] = { ...saved };
        else persisted.push({ ...saved });
      },
      removeItem: async (id) => {
        const index = persisted.findIndex((item) => item.id === id);
        if (index >= 0) persisted.splice(index, 1);
      },
      createThread,
      sendMessage,
      getDefaultCwd: () => '/tmp',
    };
    const item: ScheduledItem = {
      id: 'shared', name: 'Shared', prompt: 'run', enabled: true,
      schedule: { type: 'interval', intervalSeconds: 60 },
      nextRun: Date.now() + 60_000,
    };
    persisted.push({ ...item });

    const first = new Scheduler(options);
    const second = new Scheduler(options);
    first.start([item]);
    second.start([item]);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    first.destroy();
    second.destroy();
  });

  it('uses a claim token when a one-shot nextRun remains equal to fireAt', async () => {
    const saved: ScheduledItem[] = [];
    const coordinator = new ScheduleCoordinator();
    const once: ScheduledItem = {
      id: 'once', name: 'Once', prompt: 'wake', enabled: true,
      schedule: { type: 'once', fireAt: Date.now() },
      nextRun: Date.now(),
    };
    coordinator.activate([once], {
      saveItem: async (item) => { saved.push(item); },
      removeItem: async () => undefined,
    });

    const first = await coordinator.claim('once', once.nextRun!, () => once.nextRun!);
    const second = await coordinator.claim('once', once.nextRun!, () => once.nextRun!);

    expect(first.claimed).toBe(true);
    expect(first.item?.nextRun).toBe(once.schedule.fireAt);
    expect(first.item?._scheduleClaimToken).toBeTypeOf('string');
    expect(second.claimed).toBe(false);
    expect(second.item?._scheduleClaimToken).toBe(first.item?._scheduleClaimToken);
    expect(saved).toHaveLength(1);
  });

  it('performs one catch-up attempt after restart rather than replaying missed occurrences', async () => {
    const { options, sendMessage } = makeOptions();
    const overdue: ScheduledItem = {
      id: 'overdue', name: 'Overdue', prompt: 'run', enabled: true,
      schedule: { type: 'interval', intervalSeconds: 60 },
      nextRun: Date.now() - 10 * 60 * 1000,
    };
    const scheduler = new Scheduler(options);
    scheduler.start([overdue]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    scheduler.destroy();
  });
});

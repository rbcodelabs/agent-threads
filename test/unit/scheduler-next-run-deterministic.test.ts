/**
 * computeNextRun must return the earliest correct calendar instant, not
 * whatever node-cron 4.2.1 reports.
 *
 * Live repro (Geode QA, 2026-09-25): a weekday schedule `0 8 * * 1-5` created
 * Fri 2026-09-25 09:21 local got nextRun = Thu Oct 01 08:00 from node-cron. The
 * old validity check only asked "allowed weekday, within 8 days", so it
 * accepted Thursday and the item silently skipped Mon–Wed. Correct: Mon Sep 28.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { computeNextRun } from '../../src/Scheduler';
import type { ScheduledItem, ScheduledItemSchedule } from '../../src/types';

// Pin a DST-observing zone before node-cron/Scheduler evaluate (see
// scheduler-hybrid-durable.test.ts for why this must be vi.hoisted).
const originalTZ = vi.hoisted(() => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  return previous;
});

afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

afterEach(() => {
  vi.useRealTimers();
});

function item(schedule: ScheduledItemSchedule, extra: Partial<ScheduledItem> = {}): ScheduledItem {
  return { id: 'i', name: 'n', prompt: 'p', enabled: true, schedule, ...extra };
}

/** Local wall-clock fields of an epoch ms, for readable assertions. */
function local(ms: number) {
  const d = new Date(ms);
  return {
    date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    day: d.getDay(),
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  };
}

function at(isoLocal: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(isoLocal));
}

describe('weekday schedules', () => {
  const weekdays8am = { type: 'weekly', timeOfDay: '08:00', daysOfWeek: [1, 2, 3, 4, 5] } as const;

  it('exact repro: created Fri 09:21 → next is Mon 08:00, not Thu', () => {
    at('2026-09-25T09:21:00-04:00'); // Friday
    expect(local(computeNextRun(item({ ...weekdays8am }), true))).toEqual({ date: '2026-09-28', day: 1, time: '08:00' });
  });

  it('Friday before 08:00 → same day', () => {
    at('2026-09-25T07:59:00-04:00');
    expect(local(computeNextRun(item({ ...weekdays8am }), true)).date).toBe('2026-09-25');
  });

  it('Mon–Thu after 08:00 → next day', () => {
    for (const [now, expected] of [
      ['2026-09-28T08:00:00-04:00', '2026-09-29'], // exactly at the slot → strictly later
      ['2026-09-29T12:00:00-04:00', '2026-09-30'],
      ['2026-09-30T23:59:00-04:00', '2026-10-01'],
      ['2026-10-01T09:00:00-04:00', '2026-10-02'],
    ] as const) {
      at(now);
      expect(local(computeNextRun(item({ ...weekdays8am }), true)).date).toBe(expected);
    }
  });

  it('weekend → Monday', () => {
    at('2026-09-26T10:00:00-04:00'); // Saturday
    expect(local(computeNextRun(item({ ...weekdays8am }), true)).date).toBe('2026-09-28');
    at('2026-09-27T23:00:00-04:00'); // Sunday
    expect(local(computeNextRun(item({ ...weekdays8am }), true)).date).toBe('2026-09-28');
  });

  it('every weekday start point for a sparse schedule (Mon/Wed) picks the earliest allowed day', () => {
    const monWed = { type: 'weekly', timeOfDay: '17:30', daysOfWeek: [3, 1] } as const;
    const expectations: Record<string, string> = {
      '2026-09-27T12:00:00-04:00': '2026-09-28', // Sun → Mon
      '2026-09-28T18:00:00-04:00': '2026-09-30', // Mon after → Wed
      '2026-09-30T18:00:00-04:00': '2026-10-05', // Wed after → next Mon
      '2026-10-02T09:00:00-04:00': '2026-10-05', // Fri → Mon
    };
    for (const [now, expected] of Object.entries(expectations)) {
      at(now);
      const next = local(computeNextRun(item({ ...monWed }), true));
      expect(next).toMatchObject({ date: expected, time: '17:30' });
    }
  });

  it('single weekly day, later the same weekday → one week out', () => {
    at('2026-09-25T18:00:00-04:00'); // Fri after 17:00
    expect(local(computeNextRun(item({ type: 'weekly', timeOfDay: '17:00', daysOfWeek: [5] }), true)).date).toBe('2026-10-02');
  });
});

describe('daily schedules', () => {
  it('later today when the time has not passed, else tomorrow', () => {
    at('2026-09-25T07:00:00-04:00');
    expect(local(computeNextRun(item({ type: 'daily', timeOfDay: '08:00' }), true))).toMatchObject({ date: '2026-09-25', time: '08:00' });
    at('2026-09-25T09:21:00-04:00');
    expect(local(computeNextRun(item({ type: 'daily', timeOfDay: '08:00' }), true))).toMatchObject({ date: '2026-09-26', time: '08:00' });
  });
});

describe('DST boundaries (America/New_York)', () => {
  it('spring forward: 08:00 the day after the clocks change keeps local 08:00', () => {
    at('2026-03-07T09:00:00-05:00'); // Sat; DST starts Sun Mar 8 02:00
    expect(local(computeNextRun(item({ type: 'daily', timeOfDay: '08:00' }), true))).toMatchObject({ date: '2026-03-08', time: '08:00' });
    at('2026-03-06T09:00:00-05:00'); // Fri → weekday schedule lands Mon Mar 9 08:00 EDT
    expect(local(computeNextRun(item({ type: 'weekly', timeOfDay: '08:00', daysOfWeek: [1, 2, 3, 4, 5] }), true)))
      .toEqual({ date: '2026-03-09', day: 1, time: '08:00' });
  });

  it('fall back: 08:00 on and after the change keeps local 08:00', () => {
    at('2026-10-31T09:00:00-04:00'); // Sat; DST ends Sun Nov 1 02:00
    expect(local(computeNextRun(item({ type: 'daily', timeOfDay: '08:00' }), true))).toMatchObject({ date: '2026-11-01', time: '08:00' });
    at('2026-10-30T09:00:00-04:00'); // Fri → Mon Nov 2 08:00 EST
    expect(local(computeNextRun(item({ type: 'weekly', timeOfDay: '08:00', daysOfWeek: [1, 2, 3, 4, 5] }), true)))
      .toEqual({ date: '2026-11-02', day: 1, time: '08:00' });
  });

  it('the result is always strictly in the future', () => {
    at('2026-03-08T01:59:00-05:00');
    const now = Date.now();
    expect(computeNextRun(item({ type: 'daily', timeOfDay: '08:00' }), true)).toBeGreaterThan(now);
  });
});

describe('interval and once (unchanged)', () => {
  it('interval: from now, or lastRun + interval', () => {
    at('2026-09-25T09:21:00-04:00');
    const now = Date.now();
    expect(computeNextRun(item({ type: 'interval', intervalSeconds: 3600 }), true)).toBe(now + 3_600_000);
    expect(computeNextRun(item({ type: 'interval', intervalSeconds: 60 }, { lastRun: now - 30_000 }))).toBe(now + 30_000);
  });

  it('once: the fixed fireAt', () => {
    at('2026-09-25T09:21:00-04:00');
    expect(computeNextRun(item({ type: 'once', fireAt: 123 }))).toBe(123);
  });
});

describe('the scheduler actually wakes at the computed next run', () => {
  it('a weekday item created Fri 09:21 fires on Mon 08:00 (not Thu), then Tue 08:00', async () => {
    const { Scheduler } = await import('../../src/Scheduler');
    at('2026-09-25T09:21:00-04:00');
    (globalThis as Record<string, unknown>).window = globalThis;
    const items: ScheduledItem[] = [];
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const scheduler = new Scheduler({
      getItems: () => items.map(i => ({ ...i })),
      saveItem: async (saved) => {
        const idx = items.findIndex(i => i.id === saved.id);
        if (idx >= 0) items[idx] = { ...saved }; else items.push({ ...saved });
      },
      removeItem: async () => {},
      createThread: () => ({ id: 'thread' }),
      sendMessage,
      getDefaultCwd: () => '/tmp',
    });
    try {
      scheduler.start([]);
      await scheduler.createItem({
        name: 'Chief of Staff — morning brief',
        prompt: 'brief',
        schedule: { type: 'weekly', timeOfDay: '08:00', daysOfWeek: [1, 2, 3, 4, 5] },
        enabled: true,
      });
      expect(local(items[0]!.nextRun!).date).toBe('2026-09-28');

      await vi.advanceTimersByTimeAsync(new Date('2026-09-28T07:59:00-04:00').getTime() - Date.now());
      expect(sendMessage).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2 * 60_000); // Mon 08:01
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(local(items[0]!.nextRun!).date).toBe('2026-09-29');

      await vi.advanceTimersByTimeAsync(new Date('2026-09-29T08:01:00-04:00').getTime() - Date.now());
      expect(sendMessage).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.destroy();
      delete (globalThis as Record<string, unknown>).window;
    }
  });
});

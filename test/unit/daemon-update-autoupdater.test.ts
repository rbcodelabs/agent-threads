import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoUpdater, type AutoUpdaterOptions } from '../../daemon/update/autoUpdater';
import { UpdateError, UpdateHeld, type LatestRelease } from '../../daemon/update/release';
import { readState, readStatus, writeRequest, writeState } from '../../daemon/update/state';

const REL = (v: string): LatestRelease => ({ version: v, tag: `v${v}`, bundleUrl: 'https://github.com/x', checksumUrl: 'https://github.com/y' });
const MIN = 60_000;

let dir: string;
let busy: string[];
let lastActivityAt: number;
let latest: LatestRelease | null;
let restarts: Array<{ to: string }>;
let applyCalls: string[];
const logs: string[] = [];
const audits: Array<Record<string, unknown>> = [];

function make(over: Partial<AutoUpdaterOptions> = {}): AutoUpdater {
  return new AutoUpdater({
    dataDir: dir,
    currentVersion: '0.68.2',
    enabled: true,
    assessment: { available: true, kind: 'systemd', bundlePath: '/b/agent-threads.cjs', unit: { name: 'agent-threads.service', scope: 'user', restart: 'on-failure' } },
    intervalMs: 60 * MIN,
    quietMs: 2 * MIN,
    tickMs: 15_000,
    initialDelayMs: 0,
    retryBaseMs: MIN,
    releases: { latest: async () => latest },
    apply: async (r) => { applyCalls.push(r.version); return { from: '0.68.2', to: r.version, prevPath: '/b/prev', bundlePath: '/b/agent-threads.cjs' }; },
    activity: { activity: () => ({ busy, lastActivityAt }) },
    log: (l) => logs.push(l),
    audit: (r) => audits.push(r),
    onRestart: (i) => restarts.push(i),
    ...over,
  });
}

/** Run the loop for `ms` of fake time. */
async function run(u: AutoUpdater, ms: number): Promise<void> {
  u.start();
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  dir = mkdtempSync(join(tmpdir(), 'at-updater-'));
  busy = [];
  lastActivityAt = Date.now() - 60 * MIN;
  latest = REL('0.68.3');
  restarts = [];
  applyCalls = [];
  logs.length = 0;
  audits.length = 0;
});
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

describe('idle gating', () => {
  it('restarts onto the new bundle when idle and quiet', async () => {
    const u = make();
    await run(u, 20_000);
    expect(applyCalls).toEqual(['0.68.3']);
    expect(restarts).toEqual([{ to: '0.68.3' }]);
    expect(audits.map((a) => a.event)).toEqual(expect.arrayContaining(['update_check', 'update_apply', 'update_restart']));
  });

  it('never restarts while a turn is running, however long it runs, then restarts after it ends', async () => {
    busy = ['t1'];
    const u = make();
    await run(u, 3 * 60 * MIN);
    expect(applyCalls).toEqual(['0.68.3']); // staged, waiting
    expect(restarts).toEqual([]);
    expect(u.currentPhase).toBe('waiting_for_idle');
    expect(readStatus(dir)).toMatchObject({ phase: 'waiting_for_idle', pendingVersion: '0.68.3', waiting: { busyThreads: 1 } });

    busy = [];
    lastActivityAt = Date.now(); // the turn just ended
    await vi.advanceTimersByTimeAsync(MIN);
    expect(restarts).toEqual([]); // quiet window not yet satisfied
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(restarts).toEqual([{ to: '0.68.3' }]);
  });

  it('a new turn or request during the quiet window resets it', async () => {
    busy = ['t1'];
    const u = make();
    await run(u, MIN);
    busy = [];
    lastActivityAt = Date.now();
    await vi.advanceTimersByTimeAsync(MIN + 30_000); // 90s of the 120s window
    expect(restarts).toEqual([]);
    busy = ['t2']; // someone sends a new turn
    await vi.advanceTimersByTimeAsync(30_000);
    busy = [];
    lastActivityAt = Date.now();
    await vi.advanceTimersByTimeAsync(MIN + 30_000); // would have passed 120s since the FIRST end
    expect(restarts).toEqual([]);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(restarts).toHaveLength(1);
  });

  it('a command that arrives while nothing is running (activity only) also resets the window', async () => {
    const u = make();
    lastActivityAt = Date.now();
    await run(u, 30_000);
    expect(restarts).toEqual([]);
    lastActivityAt = Date.now();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(restarts).toEqual([]);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(restarts).toHaveLength(1);
  });
});

describe('checking', () => {
  it('does nothing when up to date or when the latest release is older (no downgrade)', async () => {
    latest = REL('0.68.2');
    await run(make(), 20_000);
    latest = REL('0.60.0');
    const u2 = make();
    await run(u2, 20_000);
    expect(applyCalls).toEqual([]);
    expect(u2.currentPhase).toBe('up_to_date');
  });

  it('checks on the configured interval, not on every tick', async () => {
    const calls: number[] = [];
    latest = REL('0.68.2');
    await run(make({ releases: { latest: async () => { calls.push(Date.now()); return latest; } }, intervalMs: 15 * MIN }), 50 * MIN);
    expect(calls.length).toBe(4); // t=0, 15, 30, 45
  });

  it('a failed check leaves everything alone and backs off exponentially, capped at the interval', async () => {
    const times: number[] = [];
    await run(make({ intervalMs: 15 * MIN, releases: { latest: async () => { times.push(Date.now()); throw new UpdateError('check', 'offline'); } } }), 16 * MIN);
    const gaps = times.slice(1).map((t, i) => Math.round((t - times[i]) / MIN));
    expect(gaps.slice(0, 3)).toEqual([1, 2, 4]);
    expect(applyCalls).toEqual([]);
    expect(restarts).toEqual([]);
    expect(audits.filter((a) => a.event === 'update_failed').length).toBeGreaterThan(2);
  });

  it('honours a rate-limit wait longer than the backoff', async () => {
    let calls = 0;
    await run(make({ releases: { latest: async () => { calls++; throw new UpdateError('check', 'rate limited', 30 * MIN); } } }), 20 * MIN);
    expect(calls).toBe(1);
  });

  it('a failed download/verify/sanity step is logged and retried, never restarting', async () => {
    let n = 0;
    await run(make({ apply: async () => { n++; throw new UpdateError('checksum', 'checksum mismatch'); } }), 5 * MIN);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(restarts).toEqual([]);
    expect(logs.join('\n')).toMatch(/checksum failed/);
    expect(audits).toContainEqual(expect.objectContaining({ event: 'update_failed', stage: 'checksum' }));
  });

  it('a held release (protocol change) is reported once, recorded, and not retried', async () => {
    let n = 0;
    const u = make({ apply: async () => { n++; throw new UpdateHeld('0.68.3', 'speaks protocol v2'); }, intervalMs: 15 * MIN });
    await run(u, 60 * MIN);
    expect(n).toBe(1);
    expect(u.currentPhase).toBe('held');
    expect(readState(dir).held).toMatchObject({ version: '0.68.3', reason: 'speaks protocol v2' });
    expect(restarts).toEqual([]);
    expect(audits).toContainEqual(expect.objectContaining({ event: 'update_held' }));
  });

  it('holds a major bump without trying to apply it', async () => {
    latest = REL('1.0.0');
    const u = make();
    await run(u, 20_000);
    expect(applyCalls).toEqual([]);
    expect(u.currentPhase).toBe('held');
  });

  it('after a rollback, pauses for the failed release and resumes for a different one', async () => {
    writeState(dir, { rolledBack: { from: '0.68.3', to: '0.68.2', at: 1 } });
    const u = make({ intervalMs: 15 * MIN });
    await run(u, 20 * MIN);
    expect(applyCalls).toEqual([]);
    expect(u.currentPhase).toBe('paused_after_rollback');
    latest = REL('0.68.4');
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(applyCalls).toEqual(['0.68.4']);
    expect(readState(dir).rolledBack).toBeUndefined();
  });
});

describe('availability', () => {
  it('on an unavailable install it logs once why, makes no requests and never restarts', async () => {
    let fetches = 0;
    const u = make({ assessment: { available: false, kind: 'container', reason: 'running in a container: pull a newer image tag' }, releases: { latest: async () => { fetches++; return latest; } } });
    await run(u, 6 * 60 * MIN);
    expect(fetches).toBe(0);
    expect(restarts).toEqual([]);
    expect(logs.filter((l) => l.includes('unavailable here'))).toHaveLength(1);
    expect(logs[0]).toMatch(/image tag/);
    expect(u.autoEnabled).toBe(false);
    expect(readStatus(dir)).toMatchObject({ enabled: true, available: false, phase: 'unavailable', reason: expect.stringContaining('container') });
  });

  it('is silent when auto-update is off and unavailable', async () => {
    await run(make({ enabled: false, assessment: { available: false, kind: 'container', reason: 'container' } }), 20_000);
    expect(logs).toEqual([]);
  });

  it('with auto-update off it never checks the network', async () => {
    let fetches = 0;
    const u = make({ enabled: false, releases: { latest: async () => { fetches++; return latest; } } });
    await run(u, 6 * 60 * MIN);
    expect(fetches).toBe(0);
    expect(u.autoEnabled).toBe(false);
    expect(u.currentPhase).toBe('off');
  });
});

describe('update --apply requests', () => {
  it('a request restarts a daemon that has auto-update off, but only when idle', async () => {
    busy = ['t1'];
    const u = make({ enabled: false });
    u.start();
    writeRequest(dir, { version: '0.68.3', now: false, requestedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(restarts).toEqual([]);
    expect(u.pendingVersion).toBe('0.68.3');
    busy = [];
    lastActivityAt = Date.now();
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(restarts).toEqual([{ to: '0.68.3' }]);
  });

  it('--now skips the idle wait, even mid-turn', async () => {
    busy = ['t1'];
    const u = make({ enabled: false });
    u.start();
    writeRequest(dir, { version: '0.68.3', now: true, requestedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(restarts).toEqual([{ to: '0.68.3' }]);
  });

  it('ignores a request that is not newer than what is running, and a malformed one', async () => {
    const u = make({ enabled: false });
    u.start();
    writeRequest(dir, { version: '0.68.2', now: true, requestedAt: 1 });
    await vi.advanceTimersByTimeAsync(20_000);
    writeFileSync(join(dir, 'update-request.json'), 'garbage');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(restarts).toEqual([]);
    expect(u.pendingVersion).toBeUndefined();
  });
});

describe('lifecycle', () => {
  it('stop() ends the loop', async () => {
    const u = make();
    u.start();
    u.stop();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(applyCalls).toEqual([]);
  });
  it('asks for the restart exactly once', async () => {
    await run(make(), 10 * MIN);
    expect(restarts).toHaveLength(1);
  });
});

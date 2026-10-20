import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalDaemonWatchdog, type WatchdogTarget } from '../../src/localDaemon/watchdog';
import type { LocalDaemonSnapshot } from '../../src/localDaemon/controller';

type Mode = 'wedged' | 'healthy' | 'stopped' | 'not-set-up';

function snapshotFor(mode: Mode): LocalDaemonSnapshot {
  const assessment = mode === 'wedged'
    ? { status: 'degraded', degraded: 'health-down' }
    : mode === 'healthy' ? { status: 'running' } : { status: mode };
  return {
    assessment,
    observed: {
      container: mode === 'wedged' || mode === 'healthy' ? 'running' : mode === 'stopped' ? 'stopped' : 'absent',
      health: mode === 'wedged' ? 'down' : mode === 'healthy' ? 'ok' : 'na',
    },
    busy: null,
  } as unknown as LocalDaemonSnapshot;
}

function setUp(opts: { enabled?: () => boolean; restart?: () => Promise<unknown> } = {}) {
  let mode: Mode = 'wedged';
  let busy = false;
  const restart = vi.fn(opts.restart ?? (async () => undefined));
  const snapshot = vi.fn(async () => snapshotFor(mode));
  const target: WatchdogTarget = { snapshot, restart, getBusy: () => (busy ? { kind: 'stop' } : null) };
  const onChange = vi.fn();
  const dog = new LocalDaemonWatchdog({ target, isEnabled: opts.enabled ?? (() => true), onChange });
  return { dog, restart, snapshot, onChange, setMode: (m: Mode) => { mode = m; }, setBusy: (b: boolean) => { busy = b; } };
}

describe('LocalDaemonWatchdog', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 20, 14, 5, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it('restarts only after three consecutive failed checks', async () => {
    const t = setUp();
    t.dog.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.restart).toHaveBeenCalledTimes(1);
    const s = t.dog.getState();
    expect(s).toMatchObject({ status: 'watching', lastRestartOk: true, attempts: 1, consecutiveFailures: 0 });
    expect(s.lastRestartAt).toBeDefined();
    t.dog.stop();
  });

  it('a healthy check in between resets the count', async () => {
    const t = setUp();
    t.dog.start();
    await vi.advanceTimersByTimeAsync(60_000);
    t.setMode('healthy');
    await vi.advanceTimersByTimeAsync(30_000);
    t.setMode('wedged');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.restart).not.toHaveBeenCalled();
    t.dog.stop();
  });

  it.each(['stopped', 'not-set-up'] as const)('never acts on a %s daemon', async (mode) => {
    const t = setUp();
    t.setMode(mode);
    t.dog.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.restart).not.toHaveBeenCalled();
    t.dog.stop();
  });

  it('does not check or act while disabled (setup incomplete or setting off)', async () => {
    let enabled = false;
    const t = setUp({ enabled: () => enabled });
    t.dog.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(t.snapshot).not.toHaveBeenCalled();
    expect(t.restart).not.toHaveBeenCalled();
    enabled = true;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(t.restart).toHaveBeenCalledTimes(1);
    t.dog.stop();
  });

  it('skips while an operation runs, so a user stop or restart is never fought', async () => {
    const t = setUp();
    t.setBusy(true);
    t.dog.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(t.restart).not.toHaveBeenCalled();
    expect(t.dog.getState().consecutiveFailures).toBe(0);
    t.dog.stop();
  });

  it('backs off between attempts, caps attempts per window and reports giving up', async () => {
    const t = setUp();
    t.dog.start();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(t.restart).toHaveBeenCalledTimes(1);
    // three more failures arrive at 3 min, but the 2 min backoff from the first attempt (90 s) ends at 3.5 min
    await vi.advanceTimersByTimeAsync(90_000);
    expect(t.restart).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.restart).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.restart).toHaveBeenCalledTimes(3);
    // the cap holds however long it stays wedged inside the window
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.restart).toHaveBeenCalledTimes(3);
    expect(t.dog.getState()).toMatchObject({ status: 'gave-up', attempts: 3, maxAttempts: 3 });
    // once the window slides past the old attempts it may try again
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(t.restart.mock.calls.length).toBeGreaterThan(3);
    t.dog.stop();
  });

  it('clears the gave-up state once the daemon answers again', async () => {
    const t = setUp();
    t.dog.start();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(t.dog.getState().status).toBe('gave-up');
    t.setMode('healthy');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.dog.getState().status).toBe('watching');
    t.dog.stop();
  });

  it('records a failed restart and counts it against the cap', async () => {
    const t = setUp({ restart: async () => { throw new Error('stop failed'); } });
    t.dog.start();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(t.dog.getState()).toMatchObject({ lastRestartOk: false, lastError: 'stop failed', attempts: 1 });
    t.dog.stop();
  });

  it('a health check that cannot run neither counts nor acts', async () => {
    const t = setUp();
    t.snapshot.mockRejectedValue(new Error('cli hung'));
    t.dog.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.restart).not.toHaveBeenCalled();
    t.dog.stop();
  });

  it('stop clears the timer and a stopped watchdog does nothing', async () => {
    const t = setUp();
    t.dog.start();
    expect(vi.getTimerCount()).toBe(1);
    t.dog.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.snapshot).not.toHaveBeenCalled();
  });

  it('start is idempotent (one timer)', () => {
    const t = setUp();
    t.dog.start();
    t.dog.start();
    expect(vi.getTimerCount()).toBe(1);
    t.dog.stop();
  });
});

/**
 * Unit tests for the stale-run heartbeat (fix/stale-run-spinner-cpu).
 *
 * A thread wedged at an unanswered plan/permission prompt keeps
 * `isRunning === true` forever (the pending answer needs the live session), so
 * its CSS spinners composited at 60fps for days and pegged the renderer. The
 * fix pauses those animations once a running thread has made no progress for
 * `STALE_MS`. These tests cover the core signal the views key off:
 * `msSinceActivity` / `isRunStale`, plus the `hasPendingPlan` getter that fixes
 * the plan-parked-thread misclassification on the same wedge path.
 *
 * Uses the canonical ThreadSession mock (see run-state-settled.test.ts) so the
 * real ThreadManager runs; only ThreadSession (the subprocess) is faked. Fake
 * timers drive `Date.now()`, which the heartbeat records.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { ThreadSessionOptions } from '../../src/ThreadSession';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { ImageAttachment } from '../../src/types';

const mock = vi.hoisted(() => ({
  callbacks: null as SessionCallbacks | null,
  lastKnownSessionId: undefined as string | undefined,
}));

vi.mock('../../src/ThreadSession', () => ({
  ThreadSession: class {
    private _turnInFlight = false;
    constructor(_claudePath: string) {}
    get turnInFlight(): boolean { return this._turnInFlight; }
    async start(options: ThreadSessionOptions): Promise<void> {
      mock.lastKnownSessionId = options.resume;
      const raw = options.callbacks;
      mock.callbacks = {
        ...raw,
        onDone: (sessionId, cost, numTurns) => {
          mock.lastKnownSessionId = sessionId;
          raw.onDone(sessionId, cost, numTurns);
          this._turnInFlight = false;
        },
        onInterrupted: (sessionId) => {
          raw.onInterrupted(sessionId);
          this._turnInFlight = false;
        },
        onError: (err) => {
          raw.onError(err);
          this._turnInFlight = false;
        },
      };
    }
    send(_text: string, _images?: ImageAttachment[]): void {
      this._turnInFlight = true;
    }
    async interrupt(): Promise<void> {
      mock.callbacks?.onInterrupted(mock.lastKnownSessionId ?? '');
    }
    async setModel(_model?: string): Promise<void> {}
    async setPermissionMode(_mode: unknown): Promise<void> {}
    async restart(): Promise<void> {}
    close(): void {}
    async getContextUsage(): Promise<null> { return null; }
  },
}));

const { ThreadManager, STALE_MS } = await import('../../src/ThreadManager');
type ThreadManagerInstance = InstanceType<typeof ThreadManager>;

function makeManager(overrides = {}): ThreadManagerInstance {
  return new ThreadManager({ ...DEFAULT_SETTINGS, ...overrides });
}

beforeEach(() => {
  mock.callbacks = null;
  mock.lastKnownSessionId = undefined;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ThreadManager — STALE_MS constant', () => {
  it('invalidates reviewed state when a new run completes without any views mounted', async () => {
    const manager = makeManager();
    const thread = manager.createThread('Reviewed work', '/tmp');
    thread.reviewed = true;
    await manager.sendMessage(thread.id, 'More work');
    mock.callbacks!.onDone('sess-review', 0.001, 1);
    expect(thread.reviewed).toBe(false);
  });
  it('is exported and equals 45s', () => {
    expect(STALE_MS).toBe(45_000);
  });
});

describe('ThreadManager.msSinceActivity', () => {
  it('returns Infinity for a thread that has never emitted a progress event', () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());
    expect(manager.msSinceActivity(thread.id)).toBe(Infinity);
  });

  it('resets to ~0 on send-start and grows as the fake clock advances', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());

    await manager.sendMessage(thread.id, 'Hi'); // emits streaming_start → heartbeat
    expect(manager.msSinceActivity(thread.id)).toBe(0);

    vi.advanceTimersByTime(10_000);
    expect(manager.msSinceActivity(thread.id)).toBe(10_000);
  });
});

describe('ThreadManager.isRunStale', () => {
  it('a freshly-started running thread is NOT stale', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());

    await manager.sendMessage(thread.id, 'Hi');
    expect(manager.isRunning(thread.id)).toBe(true);
    expect(manager.isRunStale(thread.id)).toBe(false);
  });

  it('becomes stale after STALE_MS of no progress while still running', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());

    await manager.sendMessage(thread.id, 'Hi');

    // Exactly STALE_MS is the boundary (strict `>`), so not yet stale.
    vi.advanceTimersByTime(STALE_MS);
    expect(manager.isRunStale(thread.id)).toBe(false);

    // One tick past STALE_MS — now wedged.
    vi.advanceTimersByTime(1);
    expect(manager.isRunning(thread.id)).toBe(true);
    expect(manager.isRunStale(thread.id)).toBe(true);
  });

  it('a progress event (token) resets the heartbeat and clears staleness', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());

    await manager.sendMessage(thread.id, 'Hi');
    vi.advanceTimersByTime(STALE_MS + 1);
    expect(manager.isRunStale(thread.id)).toBe(true);

    // A streamed token arrives — the thread is genuinely making progress.
    mock.callbacks!.onToken('still working');
    expect(manager.isRunStale(thread.id)).toBe(false);
    expect(manager.msSinceActivity(thread.id)).toBe(0);

    // …and it can go stale again if it wedges after that.
    vi.advanceTimersByTime(STALE_MS + 1);
    expect(manager.isRunStale(thread.id)).toBe(true);
  });

  it('is never stale when the thread is not running, even long after activity', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());

    await manager.sendMessage(thread.id, 'Hi');
    vi.advanceTimersByTime(STALE_MS + 1);
    expect(manager.isRunStale(thread.id)).toBe(true); // running + wedged

    // Turn completes → isRunning flips false → no longer "stale" regardless of age.
    mock.callbacks!.onDone('sess-1', 0.001, 1);
    await Promise.resolve();
    await Promise.resolve();

    expect(manager.isRunning(thread.id)).toBe(false);
    expect(manager.isRunStale(thread.id)).toBe(false);
  });

  it('respects a custom staleMs argument', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());

    await manager.sendMessage(thread.id, 'Hi');
    vi.advanceTimersByTime(20_000);

    expect(manager.isRunStale(thread.id, 10_000)).toBe(true);  // 20s > 10s
    expect(manager.isRunStale(thread.id, 30_000)).toBe(false); // 20s <= 30s
  });
});

describe('ThreadManager.hasPendingPlan', () => {
  it('is false for a thread with no pending plan', () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());
    expect(manager.hasPendingPlan(thread.id)).toBe(false);
  });

  it('is true while thread.pendingPlan is set, false once cleared', () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());

    manager.setThreadPendingPlan(thread.id, 'Here is my plan…');
    expect(manager.hasPendingPlan(thread.id)).toBe(true);

    manager.setThreadPendingPlan(thread.id, undefined);
    expect(manager.hasPendingPlan(thread.id)).toBe(false);
  });

  it('is false for an unknown thread id', () => {
    const manager = makeManager();
    expect(manager.hasPendingPlan('does-not-exist')).toBe(false);
  });
});

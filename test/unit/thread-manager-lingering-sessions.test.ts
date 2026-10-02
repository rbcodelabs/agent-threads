/**
 * Tests for ThreadManager's per-thread session bookkeeping under the
 * single-map ThreadSession model (ADR-0002 Stage 2).
 *
 * This file used to test the two-map "lingering session" design
 * (`sessions` + `lingeringSessions`, `LINGER_MAX_MS`, `unwindLingeringSession()`)
 * that existed because the old per-turn `ClaudeSession` model could end up
 * with a session whose first `result` had landed (thread looks idle) but
 * whose `run()` hadn't resolved yet — a second `ClaudeSession` could then be
 * constructed for the SAME thread while the first was still draining,
 * racing it for the CLI's stdin. `unwindLingeringSession()`'s own force
 * `endInput()`/`close()` on that first session — independent of whether a
 * permission request was in flight — was itself the second, previously
 * unguarded root cause of the "Stream closed" bug class documented in
 * ADR-0002's "Context" section.
 *
 * ADR-0002 Stage 2 removes the premise entirely: `ThreadManager.sessions`
 * is now a single `Map<string, ThreadSession>`, one long-lived session per
 * thread for its whole lifetime. There is no second map, no linger timer,
 * and — because a thread's session is looked up-or-created synchronously
 * with no `await` before it's stored in the map (see `sendMessage()`'s doc
 * comment) — never a second `ThreadSession` instance to race for the same
 * thread's stdin. `isRunning()` is a plain `session.turnInFlight` read.
 *
 * This file is the single highest-value rewrite in the migration: it is
 * testing the exact bug class the whole ADR exists to fix. The main
 * regression test below reproduces the specific bug Stage C's rewrite of
 * `onInterrupted` fixed: rolling back only the trailing pending user message
 * (matching a single closure-captured id, safe under the old "at most one
 * unresolved message" invariant) is not enough once `sendMessage()` no
 * longer gates on "busy" — two or more user messages can be unresolved at
 * once, and ALL of them must be rolled back on interrupt, not just the last.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { ThreadSessionOptions } from '../../src/ThreadSession';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { ImageAttachment } from '../../src/types';

// ─── canonical ThreadSession mock (see test/unit/session-message-handlers.test.ts) ──

const mock = vi.hoisted(() => ({
  callbacks: null as SessionCallbacks | null,
  lastKnownSessionId: undefined as string | undefined,
  constructCount: 0,
  startCallCount: 0,
  sendCallCount: 0,
  interruptCalls: 0,
  closeCalls: 0,
  sentPrompts: [] as string[],
  startOptions: null as ThreadSessionOptions | null,
}));

// NOTE: callbacks/lastKnownSessionId are tracked BOTH per-instance (`this.*`,
// used by interrupt()/send() so multi-thread tests — each thread gets its own
// ThreadSession instance — don't cross-contaminate) AND mirrored onto the
// shared `mock` object (a convenience for single-thread tests that just want
// to reach `mock.callbacks!` directly, matching the rest of this test suite's
// established convention).
vi.mock('../../src/ThreadSession', () => ({
  ThreadSession: class {
    private _turnInFlight = false;
    private ownCallbacks: SessionCallbacks | null = null;
    private ownLastKnownSessionId: string | undefined;
    constructor(_claudePath: string) { mock.constructCount += 1; }
    get turnInFlight(): boolean { return this._turnInFlight; }
    async start(options: ThreadSessionOptions): Promise<void> {
      mock.startOptions = options;
      mock.startCallCount += 1;
      this.ownLastKnownSessionId = options.resume;
      mock.lastKnownSessionId = options.resume;
      const raw = options.callbacks;
      const wrapped: SessionCallbacks = {
        ...raw,
        onDone: (sessionId, cost, numTurns, metadata) => {
          this.ownLastKnownSessionId = sessionId;
          mock.lastKnownSessionId = sessionId;
          raw.onDone(sessionId, cost, numTurns, metadata);
          if ((metadata?.queuedTurnCount ?? 0) === 0) this._turnInFlight = false;
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
      this.ownCallbacks = wrapped;
      mock.callbacks = wrapped;
    }
    send(text: string, _images?: ImageAttachment[]): void {
      mock.sendCallCount += 1;
      mock.sentPrompts.push(text);
      this._turnInFlight = true;
    }
    async interrupt(): Promise<void> {
      mock.interruptCalls += 1;
      this.ownCallbacks?.onInterrupted(this.ownLastKnownSessionId ?? '');
    }
    async setModel(_model?: string): Promise<void> {}
    async setPermissionMode(_mode: unknown): Promise<void> {}
    async restart(): Promise<void> {}
    close(): void { mock.closeCalls += 1; }
    async getContextUsage(): Promise<null> { return null; }
  },
}));

const { ThreadManager } = await import('../../src/ThreadManager');

function makeManager(overrides = {}) {
  return new ThreadManager({ ...DEFAULT_SETTINGS, ...overrides });
}

beforeEach(() => {
  mock.callbacks = null;
  mock.lastKnownSessionId = undefined;
  mock.constructCount = 0;
  mock.startCallCount = 0;
  mock.sendCallCount = 0;
  mock.interruptCalls = 0;
  mock.closeCalls = 0;
  mock.sentPrompts = [];
});

describe('ThreadManager — single-session-per-thread model (no lingering-session map)', () => {
  it('supplies Claude with canonical prior history when resuming, excluding the current send', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());
    thread.sessionId = 'missing-native-session';
    thread.messages.push({ id: 'prior', role: 'user', content: 'Earlier canonical request', timestamp: Date.now() });
    await manager.sendMessage(thread.id, 'Current request');
    expect(mock.startOptions?.resumeFallbackHistory).toContain('Earlier canonical request');
    expect(mock.startOptions?.resumeFallbackHistory).not.toContain('Current request');
  });
  it('there is no separate lingeringSessions map anymore — only one `sessions` map', () => {
    const manager = makeManager();
    expect((manager as unknown as { lingeringSessions?: unknown }).lingeringSessions).toBeUndefined();
    expect((manager as unknown as { sessions: Map<string, unknown> }).sessions).toBeInstanceOf(Map);
  });

  it('a second sendMessage() for the same thread while a turn is in flight reuses the SAME ThreadSession — never constructs a second one', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());

    await manager.sendMessage(thread.id, 'First');
    expect(manager.isRunning(thread.id)).toBe(true);
    expect(mock.constructCount).toBe(1);

    // Under the old model, a message arriving for a thread whose previous
    // generation was still lingering would force ThreadManager to unwind
    // the first session (endInput + poll, hard-close after a timeout) before
    // constructing a second one — the exact race ADR-0002 §"Context" traces
    // as the second, previously-unguarded root cause of "Stream closed".
    // Under the single-session model there is nothing to unwind: the SAME
    // instance just receives a second push.
    await manager.sendMessage(thread.id, 'Second');
    expect(mock.constructCount).toBe(1);
    expect(mock.sendCallCount).toBe(2);
    // NOTE: the second push's text is NOT the literal string 'Second' — since
    // no `result` has landed yet, thread.sessionId is still unset, and
    // sendMessage() treats "no sessionId + prior messages exist" as an
    // unresumed session and prepends a history preamble (buildHistoryPreamble)
    // before the raw text (see ThreadManager.sendMessage()'s
    // isFreshUnresumedSession branch). That check doesn't currently
    // distinguish "genuinely fresh/disconnected session" (e.g. after a cwd
    // change) from "a second push coalescing into the same still-in-flight
    // first turn" — harmless (the model still gets full context, just
    // redundantly via text rather than native history) but worth flagging;
    // see this file's final report. The assertion that matters here is what
    // this test is actually about: a single ThreadSession construction, and
    // the second send() carrying the "Second" text through, whatever the
    // preamble wrapping.
    expect(mock.sentPrompts[0]).toBe('First');
    expect(mock.sentPrompts[1]).toContain('Second');
  });

  it('isRunning() is a plain read of session.turnInFlight — true after send(), false after onDone', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());

    expect(manager.isRunning(thread.id)).toBe(false);
    await manager.sendMessage(thread.id, 'Hi');
    expect(manager.isRunning(thread.id)).toBe(true);

    mock.callbacks!.onDone('sess-1', 0.001, 1);
    expect(manager.isRunning(thread.id)).toBe(false);
  });

  it('interrupt() always reaches the thread\'s live session (no lingering-session fallback needed — there is only ever one)', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());

    await manager.sendMessage(thread.id, 'Hi');
    expect(manager.isRunning(thread.id)).toBe(true);

    await manager.interrupt(thread.id);
    expect(mock.interruptCalls).toBe(1);
    expect(manager.isRunning(thread.id)).toBe(false);
  });

  it('deleteThread() closes and removes the single session entry', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());
    await manager.sendMessage(thread.id, 'Hi');

    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(sessions.has(thread.id)).toBe(true);

    manager.deleteThread(thread.id);
    expect(mock.closeCalls).toBe(1);
    expect(sessions.has(thread.id)).toBe(false);
  });
});

describe('ThreadManager — onInterrupted rolls back ALL unresolved user messages (Stage C regression)', () => {
  it('a single message sent then interrupted is rolled back (baseline — still worked under the old model too)', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());

    await manager.sendMessage(thread.id, 'Hello');
    expect(thread.messages).toHaveLength(1);

    await manager.interrupt(thread.id);
    expect(thread.messages).toHaveLength(0);
  });

  it('regression: 2+ messages sent before a single interrupt lands — NONE are left orphaned looking answered', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());

    // Under ADR-0002 §2's confirmed always-safe-to-send() model, sendMessage()
    // no longer gates on "busy" — a follow-up (or several) can land and get
    // pushed to thread.messages before the first generation's result/interrupt
    // settles. Send three messages back to back, none of them yet answered.
    await manager.sendMessage(thread.id, 'First');
    await manager.sendMessage(thread.id, 'Second');
    await manager.sendMessage(thread.id, 'Third');

    expect(thread.messages).toHaveLength(3);
    expect(thread.messages.every((m) => m.role === 'user')).toBe(true);

    const pendingIds = (manager as unknown as { pendingUserMessageIds: Map<string, string[]> })
      .pendingUserMessageIds.get(thread.id);
    expect(pendingIds).toHaveLength(3);

    // A single interrupt lands for the (coalesced) generation all three
    // pushes landed in. Under the OLD per-turn model this bug couldn't
    // manifest because at most one message could ever be unresolved at once
    // (sendMessage() gated on busy) — onInterrupted only ever needed to
    // splice out one closure-captured id. Rolling back only the trailing
    // message here would leave "First" and "Second" sitting in the
    // transcript looking like they were successfully sent and answered when
    // they were never actually processed — exactly the bug Stage C's
    // pendingUserMessageIds rewrite (a per-thread ARRAY of ids, not a single
    // id) fixes.
    await manager.interrupt(thread.id);

    expect(thread.messages).toHaveLength(0);
    expect(
      (manager as unknown as { pendingUserMessageIds: Map<string, string[]> })
        .pendingUserMessageIds.get(thread.id),
    ).toBeUndefined();
  });

  it('regression variant: messages from TWO separate threads never cross-contaminate on interrupt', async () => {
    const manager = makeManager();
    const threadA = manager.createThread('A', process.cwd());
    const threadB = manager.createThread('B', process.cwd());

    await manager.sendMessage(threadA.id, 'A1');
    await manager.sendMessage(threadA.id, 'A2');
    await manager.sendMessage(threadB.id, 'B1');

    expect(threadA.messages).toHaveLength(2);
    expect(threadB.messages).toHaveLength(1);

    await manager.interrupt(threadA.id);

    // Only thread A's pending messages are rolled back; thread B's
    // still-unresolved message is untouched by an unrelated thread's interrupt.
    expect(threadA.messages).toHaveLength(0);
    expect(threadB.messages).toHaveLength(1);
    expect(threadB.messages[0].content).toBe('B1');
  });

  it('a successful onDone after multiple coalesced sends clears pendingUserMessageIds without rolling anything back', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());

    await manager.sendMessage(thread.id, 'First');
    await manager.sendMessage(thread.id, 'Second');
    expect(thread.messages).toHaveLength(2);

    // Both pushes coalesce into ONE generation (ADR-0002 §2 live-CLI probe) —
    // a single onDone settles both.
    mock.callbacks!.onToken('Reply');
    mock.callbacks!.onMessage('Reply', []);
    mock.callbacks!.onDone('sess-1', 0.001, 1);

    expect(thread.messages).toHaveLength(3); // 2 user + 1 assistant, none rolled back
    expect(
      (manager as unknown as { pendingUserMessageIds: Map<string, string[]> })
        .pendingUserMessageIds.get(thread.id),
    ).toBeUndefined();
  });

  it('a queued result settles only its correlated user message and keeps the thread running', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, event) => events.push(event));

    await manager.sendMessage(thread.id, 'First');
    await manager.sendMessage(thread.id, 'Second');
    const [firstId, secondId] = thread.messages.map((message) => message.id);

    mock.callbacks!.onDone('sess-1', 0.001, 1, {
      queuedTurnCount: 1,
      userMessageUuid: firstId,
    });

    expect(manager.isRunning(thread.id)).toBe(true);
    expect(thread.status).toBe('active');
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(
      (manager as unknown as { pendingUserMessageIds: Map<string, string[]> })
        .pendingUserMessageIds.get(thread.id),
    ).toEqual([secondId]);

    mock.callbacks!.onDone('sess-1', 0.001, 1, {
      queuedTurnCount: 0,
      userMessageUuid: secondId,
    });
    expect(manager.isRunning(thread.id)).toBe(false);
    expect(thread.status).toBe('waiting');
    expect(events.some((event) => event.type === 'done')).toBe(true);
  });
});

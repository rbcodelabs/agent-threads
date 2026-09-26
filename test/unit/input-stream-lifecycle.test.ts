/**
 * Tests for ThreadSession's push-channel lifecycle (ADR-0002 Stage 2).
 *
 * This file used to test ClaudeSession's per-turn release-gate mechanics
 * (pendingBgTaskIds / sawTaskNotificationSinceLastResult / the three-condition
 * releaseInput() check) — the machinery that decided when it was "safe" to
 * let the held-open input generator complete (triggering the SDK's
 * transport.endInput()) without cutting off a still-pending permission
 * round-trip. ADR-0002 deletes that machinery outright: ThreadSession has no
 * release gate at all. Its input channel stays open unconditionally from
 * start() until an explicit close()/restart() — there is no "is it safe to
 * end the channel yet?" decision to get wrong, because the channel is never
 * ended implicitly. `send()` pushes onto it unconditionally, whether or not a
 * turn is in flight or a canUseTool call is pending (confirmed against the
 * live CLI — see ADR-0002 §2's two probes).
 *
 * The exact bug class the old release-gate tests guarded against — a
 * still-pending permission request (ExitPlanMode / AskUserQuestion / a
 * generic tool prompt) getting its stdin cut out from under it, producing
 * "Stream closed" / "Tool permission request failed" — is now structurally
 * impossible rather than patched case-by-case. The tests below prove that
 * directly: they drive a real pending canUseTool call and a concurrent
 * send(), against ThreadSession itself (mocking only the raw SDK, same
 * technique the old file used against ClaudeSession), and assert nothing
 * ever throws or drops the request, mirroring ADR-0002 §2's live-CLI probes.
 *
 * Also covers two Stage B regressions found during Stage B/C/D review that
 * didn't have coverage yet:
 *   - the double q.close() guard (`if (this.query === q)` in pumpMessages'
 *     finally) — an external close() racing the pump loop's own cleanup must
 *     not produce a second close()/spurious error.
 *   - the `_turnInFlight` race in the transport-error auto-retry path — a
 *     retry's own send() sets turnInFlight = true for the NEW generation;
 *     the OLD generation's pump-loop finally must not stomp it back to false
 *     (fixed via the `supersededByRestart` guard).
 */

import { describe, it, expect, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { ThreadSessionOptions } from '../../src/ThreadSession';

// ─── controllable output-message channel (mirrors the old file's helper) ─────
//
// A push()/close()-driven async iterable (rather than a static pre-baked
// array) so tests can pace exactly which SDK message the pump loop has
// processed before asserting on state.

function makeChannel() {
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<(v: IteratorResult<Record<string, unknown>>) => void> = [];
  let closed = false;
  return {
    push(msg: Record<string, unknown>) {
      if (waiters.length > 0) waiters.shift()!({ value: msg, done: false });
      else queue.push(msg);
    },
    close() {
      closed = true;
      while (waiters.length > 0) waiters.shift()!({ value: undefined as never, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next: (): Promise<IteratorResult<Record<string, unknown>>> => {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}

/**
 * Like makeChannel(), but supports injecting a rejection into whichever
 * `.next()` call is next in line (either a pending waiter, if the pump loop
 * is already suspended awaiting output, or the next call if none is pending
 * yet). Used to simulate a transport dropping mid-turn at a controlled point
 * — rather than rejecting immediately on construction — so the test can
 * arrange state (send a turn, arm the next generation's channel) before
 * triggering the failure.
 */
function makeThrowableChannel() {
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<{ resolve: (v: IteratorResult<Record<string, unknown>>) => void; reject: (e: Error) => void }> = [];
  let closed = false;
  let pendingError: Error | null = null;
  return {
    push(msg: Record<string, unknown>) {
      if (waiters.length > 0) waiters.shift()!.resolve({ value: msg, done: false });
      else queue.push(msg);
    },
    throwNext(err: Error) {
      if (waiters.length > 0) waiters.shift()!.reject(err);
      else pendingError = err;
    },
    close() {
      closed = true;
      while (waiters.length > 0) waiters.shift()!.resolve({ value: undefined as never, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next: (): Promise<IteratorResult<Record<string, unknown>>> => {
          if (pendingError) {
            const e = pendingError;
            pendingError = null;
            return Promise.reject(e);
          }
          if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
        },
      };
    },
  };
}

// ─── SDK mock — tracks every query() invocation ("generation") separately so
// tests can inspect restart()'s second generation independently of the first ──

interface Generation {
  promptArg: AsyncIterable<Record<string, unknown>>;
  options: Record<string, unknown>;
  canUseTool: ((name: string, input: unknown, opts: Record<string, unknown>) => Promise<unknown>) | null;
  closeCalls: number;
  setPermissionMode: ReturnType<typeof vi.fn>;
}

const sdk = vi.hoisted(() => ({
  generations: [] as Generation[],
  nextIterable: null as AsyncIterable<Record<string, unknown>> | null,
  contextUsage: null as Record<string, unknown> | null,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: (opts: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
      const gen: Generation = {
        promptArg: opts.prompt,
        options: opts.options,
        canUseTool: (opts.options.canUseTool as Generation['canUseTool']) ?? null,
        closeCalls: 0,
        setPermissionMode: vi.fn(async () => {}),
      };
      sdk.generations.push(gen);
      const outputIterable = sdk.nextIterable!;
      return {
        [Symbol.asyncIterator]: () => outputIterable[Symbol.asyncIterator](),
        close: () => { gen.closeCalls += 1; },
        interrupt: async () => {},
        supportedModels: async () => [],
        supportedAgents: async () => [],
        getContextUsage: async () => sdk.contextUsage,
        setPermissionMode: gen.setPermissionMode,
        setModel: async () => {},
      };
    },
    __setNextOutputIterable: (it: AsyncIterable<Record<string, unknown>>) => { sdk.nextIterable = it; },
    __generations: () => sdk.generations,
  };
});

const { ThreadSession } = await import('../../src/ThreadSession');

function minimalCallbacks(overrides: Partial<SessionCallbacks> = {}): SessionCallbacks {
  return {
    onToken: () => {},
    onToolUse: () => {},
    onMessage: () => {},
    onRecap: () => {},
    onDone: () => {},
    onInterrupted: () => {},
    onError: () => {},
    onPermissionRequest: async () => true,
    onAskUserQuestion: async () => ({}),
    onOpenNewTab: async () => ({ threadId: '', title: '' }),
    ...overrides,
  };
}

const baseOptions = (callbacks: SessionCallbacks): ThreadSessionOptions => ({
  claudePath: '/fake/claude',
  cwd: '/tmp',
  permissionMode: 'default',
  extraEnvRaw: '',
  callbacks,
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await tick();
}

const successResult = (sessionId = 's', numTurns = 1) =>
  ({ type: 'result', subtype: 'success', session_id: sessionId, total_cost_usd: 0, num_turns: numTurns });

describe('ThreadSession — push-channel content shape', () => {
  it('passes refreshed goal context and the durable session id to the Claude query', async () => {
    sdk.generations = [];
    sdk.nextIterable = makeChannel();
    const session = new ThreadSession('/fake/claude');
    await session.start({
      ...baseOptions(minimalCallbacks()),
      resume: 'durable-claude-session',
      appendSystemPrompt: 'Vault root (filesystem path): /vault\nWorking directory: /tmp\n\n## Active Goal\nShip the release',
    });

    expect(sdk.generations[0].options).toMatchObject({
      resume: 'durable-claude-session',
      extraArgs: {
        'append-system-prompt': 'Vault root (filesystem path): /vault\nWorking directory: /tmp\n\n## Active Goal\nShip the release',
      },
    });
    session.close();
  });

  it('pushes the user text, then the per-turn current-time block, for a text-only send()', async () => {
    sdk.generations = [];
    sdk.nextIterable = makeChannel();
    const session = new ThreadSession('/fake/claude');
    await session.start(baseOptions(minimalCallbacks()));

    const gen = sdk.generations[0];
    const iter = gen.promptArg[Symbol.asyncIterator]();

    session.send('hello there');
    const first = await iter.next();
    expect(first.done).toBe(false);
    const msg = first.value as { type: string; parent_tool_use_id: unknown; message: { role: string; content: unknown } };
    expect(msg.type).toBe('user');
    expect(msg.parent_tool_use_id).toBeNull();
    expect(msg.message.role).toBe('user');
    expect(msg.message.content).toEqual([{ type: 'text', text: 'hello there' }, { type: 'text', text: expect.stringMatching(/^\[Current local time: /) }]);

    session.close();
  });

  it('stamps the host user-message id onto the SDK message uuid', async () => {
    sdk.generations = [];
    sdk.nextIterable = makeChannel();
    const session = new ThreadSession('/fake/claude');
    await session.start(baseOptions(minimalCallbacks()));

    const iter = sdk.generations[0].promptArg[Symbol.asyncIterator]();
    session.send('hello there', undefined, 'host-message-123');
    const first = await iter.next();

    expect(first.value).toMatchObject({ type: 'user', uuid: 'host-message-123' });
    session.close();
  });

  it('pushes text+image content blocks for an image send()', async () => {
    sdk.generations = [];
    sdk.nextIterable = makeChannel();
    const session = new ThreadSession('/fake/claude');
    await session.start(baseOptions(minimalCallbacks()));

    const gen = sdk.generations[0];
    const iter = gen.promptArg[Symbol.asyncIterator]();

    session.send('look at this', [{ mediaType: 'image/png', base64: 'AAAA' }]);
    const first = await iter.next();
    const msg = first.value as { message: { content: Array<Record<string, unknown>> } };
    expect(Array.isArray(msg.message.content)).toBe(true);
    expect(msg.message.content[0]).toMatchObject({ type: 'text', text: 'look at this' });
    expect(msg.message.content[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });

    session.close();
  });
});

describe('ThreadSession — proactive compaction guard', () => {
  it('finishes an internal /compact turn before allowing the next user turn', async () => {
    sdk.generations = [];
    sdk.contextUsage = {
      totalTokens: 925_000,
      autoCompactThreshold: 934_000,
      isAutoCompactEnabled: true,
    };
    const out = makeChannel();
    sdk.nextIterable = out;
    const onDone = vi.fn();
    const onCompact = vi.fn();
    const session = new ThreadSession('/fake/claude');
    await session.start(baseOptions(minimalCallbacks({ onDone, onCompact })));

    const iter = sdk.generations[0].promptArg[Symbol.asyncIterator]();
    const preparing = session.prepareForSend('next user message');
    const maintenance = await iter.next();
    expect((maintenance.value as { message: { content: string } }).message.content).toBe('/compact');

    out.push({
      type: 'system', subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 925_000 },
    });
    out.push(successResult('compacted-session'));
    await preparing;

    expect(onCompact).toHaveBeenCalledWith('auto', 925_000);
    expect(onDone).not.toHaveBeenCalled();
    session.send('next user message');
    const userTurn = await iter.next();
    expect((userTurn.value as { message: { content: Array<{ text: string }> } }).message.content[0]).toEqual({ type: 'text', text: 'next user message' });
    session.close();
    sdk.contextUsage = null;
  });

  it('does nothing while comfortably below the SDK threshold', async () => {
    sdk.generations = [];
    sdk.contextUsage = { totalTokens: 100_000, autoCompactThreshold: 934_000 };
    sdk.nextIterable = makeChannel();
    const session = new ThreadSession('/fake/claude');
    await session.start(baseOptions(minimalCallbacks()));
    await session.prepareForSend('small turn');
    expect(session.turnInFlight).toBe(false);
    session.close();
    sdk.contextUsage = null;
  });
});

describe('ThreadSession — channel stays open regardless of turn state (no release gate)', () => {
  it('keeps the turn in flight and reports result correlation while SDK turns remain queued', async () => {
    sdk.generations = [];
    const out = makeChannel();
    sdk.nextIterable = out;
    const onDone = vi.fn();
    const session = new ThreadSession('/fake/claude');
    await session.start(baseOptions(minimalCallbacks({ onDone })));
    session.send('hi', undefined, 'user-1');

    out.push({ ...successResult(), queued_turn_count: 1, user_message_uuid: 'user-1' });
    await flush();

    expect(onDone).toHaveBeenCalledWith('s', 0, 1, {
      queuedTurnCount: 1,
      userMessageUuid: 'user-1',
    });
    expect(session.turnInFlight).toBe(true);
    session.close();
  });

  it('does NOT auto-close the channel after a result — only close()/restart() ends it', async () => {
    sdk.generations = [];
    const out = makeChannel();
    sdk.nextIterable = out;
    const session = new ThreadSession('/fake/claude');
    await session.start(baseOptions(minimalCallbacks()));

    const gen = sdk.generations[0];
    const iter = gen.promptArg[Symbol.asyncIterator]();
    session.send('hi');
    await iter.next();

    out.push(successResult());
    await flush();

    // The channel must still be open: racing another .next() against a
    // macrotask tick must NOT resolve — unlike the old ClaudeSession release
    // gate, a result alone is never sufficient to end the channel now.
    let resolvedEarly = false;
    const secondNext = iter.next().then((r) => { resolvedEarly = true; return r; });
    await Promise.race([secondNext, tick()]);
    expect(resolvedEarly).toBe(false);

    session.close();
    const second = await secondNext;
    expect(second.done).toBe(true);
    expect(resolvedEarly).toBe(true);
  });

  it('regression: send() succeeds unconditionally while a canUseTool (permission) call is pending — the old "Stream closed" failure mode is structurally impossible', async () => {
    sdk.generations = [];
    sdk.nextIterable = makeChannel();
    // Permission never resolves during this test — mirrors a human still
    // staring at an approval dialog when a follow-up message arrives.
    const session = new ThreadSession('/fake/claude');
    await session.start(baseOptions(minimalCallbacks({
      onPermissionRequest: () => new Promise(() => {}),
    })));

    const gen = sdk.generations[0];
    const iter = gen.promptArg[Symbol.asyncIterator]();
    session.send('first message');
    await iter.next();

    // Simulate the model calling a tool mid-generation — canUseTool now has
    // a pending, unresolved promise (a human permission prompt in flight).
    expect(gen.canUseTool).not.toBeNull();
    const canUseToolPromise = gen.canUseTool!('Bash', { command: 'ls' }, {});
    let permissionSettled = false;
    void canUseToolPromise.then(() => { permissionSettled = true; });
    await flush();
    expect(permissionSettled).toBe(false); // still pending — human hasn't acted

    // A second message arrives (e.g. the user typed a follow-up) while that
    // permission request is still in flight. Under the old ClaudeSession
    // model this exact scenario — a new message landing while
    // pendingInteractiveCallbacks > 0 — was the one case PR #298's guard was
    // built to protect, and ThreadManager's separate unwindLingeringSession()
    // force-unwind path could still race past it (ADR-0002 "Context" section,
    // second root cause). Under ThreadSession there is no gate and no second
    // session to race: send() must just work.
    expect(() => session.send('second message')).not.toThrow();

    const second = await iter.next();
    expect(second.done).toBe(false);
    const msg = second.value as { message: { content: unknown } };
    expect((msg.message.content as Array<{ text: string }>)[0]).toEqual({ type: 'text', text: 'second message' });

    // The permission request is still exactly as pending as before — sending
    // more input never force-rejected it.
    expect(permissionSettled).toBe(false);

    session.close();
  });

  it('send() throws a clear error if called before start() or after close()', async () => {
    const session = new ThreadSession('/fake/claude');
    expect(() => session.send('too early')).toThrow(/before start\(\)/);

    sdk.generations = [];
    sdk.nextIterable = makeChannel();
    await session.start(baseOptions(minimalCallbacks()));
    session.close();
    expect(() => session.send('too late')).toThrow();
  });
});

describe('ThreadSession — double-close guard (Stage B regression)', () => {
  it('an external close() during an in-flight pump does not produce a second q.close() when the pump loop later unwinds', async () => {
    sdk.generations = [];
    const out = makeChannel();
    sdk.nextIterable = out;
    const session = new ThreadSession('/fake/claude');
    await session.start(baseOptions(minimalCallbacks()));

    const gen = sdk.generations[0];
    const iter = gen.promptArg[Symbol.asyncIterator]();
    session.send('hi');
    await iter.next();

    // Nothing has been pushed to the output stream yet — the pump loop's
    // `for await` is suspended waiting on it, exactly like a real in-flight
    // generation. An external caller (e.g. deleteThread()/gracefulShutdown())
    // closes the session out from under it.
    session.close();
    expect(gen.closeCalls).toBe(1);

    // The suspended pump loop now gets its result and naturally unwinds.
    // Its `finally` block must notice `this.query` is no longer THIS
    // generation's q (already nulled by the external close() above) and
    // must NOT call q.close() a second time.
    out.push(successResult());
    out.close();
    await flush();

    expect(gen.closeCalls).toBe(1);
  });
});

describe('ThreadSession — transport-error auto-retry turnInFlight race (Stage B regression)', () => {
  it('turnInFlight stays true across an internal transport-error retry — the old generation\'s pump-loop finally must not stomp the new generation\'s flag back to false', async () => {
    sdk.generations = [];
    // Generation 0's output stream: nothing pushed yet, so the pump loop's
    // `for await` suspends waiting for output — exactly like a real
    // in-flight generation — until the test triggers the transport failure
    // explicitly below.
    const out0 = makeThrowableChannel();
    sdk.nextIterable = out0;

    const reconnectingCalls: string[] = [];
    const session = new ThreadSession('/fake/claude');
    await session.start(baseOptions(minimalCallbacks({
      onReconnecting: (err) => { reconnectingCalls.push(err); },
    })));

    expect(sdk.generations).toHaveLength(1);
    session.send('trigger a turn');
    expect(session.turnInFlight).toBe(true);

    // Arm the NEXT generation's output stream (left permanently open — this
    // test only cares about the retry's own turnInFlight bookkeeping, not
    // draining generation 1 to completion) BEFORE triggering the failure, so
    // that when restart()'s internal start() calls query() again, it picks
    // up a channel that won't itself immediately fail and cascade into a
    // second, unrelated retry-exhaustion path.
    sdk.nextIterable = makeChannel();

    // Trigger the dropped-transport failure on generation 0's suspended
    // `for await` — propagates into the catch block's auto-retry path
    // (isTransportClosedError → shouldAutoRetryTransportError → restart() →
    // send(TRANSPORT_ERROR_CONTINUATION_PROMPT)), and finally into the
    // ORIGINAL pump call's `finally` block.
    out0.throwNext(new Error('Stream closed'));
    await flush(5);

    // The retry happened: a second generation was opened, and onReconnecting
    // fired for the UI's "hang on, recovering" signal.
    expect(sdk.generations).toHaveLength(2);
    expect(reconnectingCalls).toHaveLength(1);
    expect(reconnectingCalls[0]).toMatch(/stream closed/i);

    // The critical assertion: turnInFlight must still read true, because the
    // retry's own send() (for the NEW generation) set it true, and the OLD
    // generation's pump-loop finally is gated by `supersededByRestart` so it
    // must not have reset it back to false afterward.
    expect(session.turnInFlight).toBe(true);

    session.close();
  });
});

describe('ThreadSession.cwd getter', () => {
  it('is undefined before start() and reflects the started options.cwd after', async () => {
    sdk.generations = [];
    sdk.nextIterable = makeChannel();
    const session = new ThreadSession('/fake/claude');

    expect(session.cwd).toBeUndefined();

    const opts = { ...baseOptions(minimalCallbacks()), cwd: '/tmp/some-worktree' };
    await session.start(opts);

    expect(session.cwd).toBe('/tmp/some-worktree');

    session.close();
  });
});

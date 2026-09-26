/**
 * Integration tests for ThreadSession's rate-limit auto-retry path
 * (fix/rate-limit-auto-retry, re-homed onto the long-lived ThreadSession per
 * ADR-0002). Unlike the transport-closed retry (which resends a synthetic
 * continuation message, since a tool call may already have gone out), a
 * rate-limit error happens before the turn is processed at all — the model
 * never saw the prompt. So the retry must silently REPLAY THE EXACT SAME turn
 * after a backoff delay, with no new visible message.
 *
 * Mocks the SDK `query()` (not ThreadSession), mirroring
 * input-stream-lifecycle.test.ts: each query() call is a "generation", and a
 * throwable output channel lets us inject a rate-limit rejection into the
 * pump loop's suspended `for await` at a controlled point. Fake timers
 * fast-forward the real backoff delays (3s/8s/20s/45s/90s).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { ThreadSessionOptions } from '../../src/ThreadSession';
import { MAX_RATE_LIMIT_AUTO_RETRIES, rateLimitBackoffMs } from '../../src/rateLimitRecovery';

const RATE_LIMIT_MESSAGE = 'Server is temporarily limiting requests (not your usage limit) · Rate limited';

// ─── controllable output channel that can inject a rejection on demand ───────
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

// ─── SDK mock — one entry per query() invocation ("generation") ──────────────
interface Generation {
  promptArg: AsyncIterable<Record<string, unknown>>;
  closeCalls: number;
}

const sdk = vi.hoisted(() => ({
  generations: [] as Generation[],
  nextIterable: null as AsyncIterable<Record<string, unknown>> | null,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: (opts: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
      const gen: Generation = { promptArg: opts.prompt, closeCalls: 0 };
      sdk.generations.push(gen);
      const outputIterable = sdk.nextIterable!;
      return {
        [Symbol.asyncIterator]: () => outputIterable[Symbol.asyncIterator](),
        close: () => { gen.closeCalls += 1; },
        interrupt: async () => {},
        supportedModels: async () => [],
        supportedAgents: async () => [],
        getContextUsage: async () => null,
        setPermissionMode: vi.fn(async () => {}),
        setModel: async () => {},
      };
    },
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

/** Flush pending microtasks without relying on setTimeout (fake timers eat it). */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Read the first message the given generation received on its input channel. */
async function firstInput(gen: Generation): Promise<{ role: string; content: unknown; uuid?: string }> {
  const res = await gen.promptArg[Symbol.asyncIterator]().next();
  const value = res.value as { uuid?: string; message: { role: string; content: unknown } };
  return { ...value.message, uuid: value.uuid };
}

describe('ThreadSession — rate-limit auto-retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sdk.generations = [];
    sdk.nextIterable = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays the exact same turn after a backoff and fires onRateLimitRetry, not onError', async () => {
    const out0 = makeThrowableChannel();
    sdk.nextIterable = out0;

    const retries: Array<{ attempt: number; maxRetries: number; delayMs: number }> = [];
    const errors: Error[] = [];
    const session = new ThreadSession('/fake/claude');
    await session.start(baseOptions(minimalCallbacks({
      onRateLimitRetry: (attempt, maxRetries, delayMs) => retries.push({ attempt, maxRetries, delayMs }),
      onError: (e) => errors.push(e),
    })));

    expect(sdk.generations).toHaveLength(1);
    session.send('do the thing', undefined, '0198f7b2-aaaa-7bbb-8ccc-123456789abc');
    expect(session.turnInFlight).toBe(true);

    // Arm generation 1's (the retry's) output channel BEFORE the failure so
    // restart()'s internal start() gets a channel that won't itself fail.
    const out1 = makeThrowableChannel();
    sdk.nextIterable = out1;

    // Reject generation 0's suspended `for await` with a rate-limit error.
    out0.throwNext(new Error(RATE_LIMIT_MESSAGE));
    await flushMicrotasks();

    // onRateLimitRetry fired immediately with the first backoff; no restart yet
    // (still inside the backoff delay).
    expect(retries).toEqual([{ attempt: 1, maxRetries: MAX_RATE_LIMIT_AUTO_RETRIES, delayMs: rateLimitBackoffMs(0) }]);
    expect(sdk.generations).toHaveLength(1);

    // Fast-forward the backoff → restart() opens generation 1 and replays.
    await vi.advanceTimersByTimeAsync(rateLimitBackoffMs(0));
    await flushMicrotasks();

    expect(sdk.generations).toHaveLength(2);
    expect(errors).toHaveLength(0);
    expect(session.turnInFlight).toBe(true);

    // The replayed turn carries the original user text unchanged — no synthetic
    // continuation prompt, no new user text (the clock block is recomputed).
    const replayed = await firstInput(sdk.generations[1]);
    expect(replayed.role).toBe('user');
    expect(replayed.content).toEqual([{ type: 'text', text: 'do the thing' }, { type: 'text', text: expect.stringMatching(/^\[Current local time: /) }]);
    expect(replayed.uuid).toBe('0198f7b2-aaaa-7bbb-8ccc-123456789abc');

    session.close();
  });

  it('surfaces a terminal onError once the retry budget is exhausted', async () => {
    const retries: number[] = [];
    const errors: Error[] = [];
    const session = new ThreadSession('/fake/claude');

    let out = makeThrowableChannel();
    sdk.nextIterable = out;
    await session.start(baseOptions(minimalCallbacks({
      onRateLimitRetry: (attempt) => retries.push(attempt),
      onError: (e) => errors.push(e),
    })));
    session.send('do the thing');

    // Reject every generation with a rate-limit error. The budget allows
    // MAX_RATE_LIMIT_AUTO_RETRIES silent retries; the next rejection is terminal.
    for (let attempt = 1; attempt <= MAX_RATE_LIMIT_AUTO_RETRIES; attempt++) {
      const next = makeThrowableChannel();
      sdk.nextIterable = next;
      out.throwNext(new Error(RATE_LIMIT_MESSAGE));
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(rateLimitBackoffMs(attempt - 1));
      await flushMicrotasks();
      out = next;
    }

    expect(retries).toEqual([1, 2, 3, 4, 5]);
    expect(errors).toHaveLength(0);

    // One more rejection — budget now exhausted → terminal error.
    out.throwNext(new Error(RATE_LIMIT_MESSAGE));
    await flushMicrotasks();

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/rate limited/i);

    session.close();
  });

  it('does not retry a non-rate-limit error', async () => {
    const out0 = makeThrowableChannel();
    sdk.nextIterable = out0;
    const retries: number[] = [];
    const errors: Error[] = [];
    const session = new ThreadSession('/fake/claude');
    await session.start(baseOptions(minimalCallbacks({
      onRateLimitRetry: (attempt) => retries.push(attempt),
      onError: (e) => errors.push(e),
    })));
    session.send('do the thing');

    out0.throwNext(new Error('ENOENT: no such file or directory'));
    await flushMicrotasks();

    expect(retries).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(sdk.generations).toHaveLength(1);

    session.close();
  });
});

/**
 * ThreadSession's expired-Claude-sign-in recovery. Concurrent CLI processes
 * race to refresh the shared OAuth token in the macOS keychain; the loser
 * keeps a dead token until its process is restarted. So on the first auth
 * failure of a turn, ThreadSession tears down its CLI process (the new
 * spawn re-reads the keychain) and silently replays the same turn — once.
 * A second failure surfaces a terminal "sign-in expired" error.
 *
 * Mocks the SDK `query()` the same way rate-limit-retry.test.ts does: each
 * query() call is a "generation" with a controllable output channel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { ThreadSessionOptions } from '../../src/ThreadSession';
import { isAwsSignInExpiredError } from '../../src/awsAuthRecovery';
import { CLAUDE_SIGN_IN_EXPIRED_MESSAGE, isClaudeSignInExpiredError } from '../../src/claudeAuthRecovery';

const OAUTH_EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed';

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
        return: (): Promise<IteratorResult<Record<string, unknown>>> => {
          closed = true;
          return Promise.resolve({ value: undefined as never, done: true });
        },
      };
    },
  };
}

interface Generation {
  promptArg: AsyncIterable<Record<string, unknown>>;
  closeCalls: number;
}

const sdk = vi.hoisted(() => ({
  generations: [] as Generation[],
  nextIterable: null as AsyncIterable<Record<string, unknown>> | null,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: { prompt: AsyncIterable<Record<string, unknown>> }) => {
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
      setPermissionMode: async () => {},
      setModel: async () => {},
    };
  },
}));

const { ThreadSession } = await import('../../src/ThreadSession');

function callbacks(overrides: Partial<SessionCallbacks> = {}): SessionCallbacks {
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

const options = (cb: SessionCallbacks): ThreadSessionOptions => ({
  cwd: '/tmp',
  permissionMode: 'default',
  extraEnvRaw: '',
  callbacks: cb,
});

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Collect every message a generation received on its input channel so far. */
async function drainInputs(gen: Generation, count: number): Promise<Array<{ content: unknown; uuid?: string }>> {
  const it = gen.promptArg[Symbol.asyncIterator]();
  const out: Array<{ content: unknown; uuid?: string }> = [];
  for (let i = 0; i < count; i++) {
    const res = await it.next();
    const value = res.value as { uuid?: string; message: { content: unknown } };
    out.push({ content: value.message.content, uuid: value.uuid });
  }
  return out;
}

/** The exact stream the CLI emits for an expired OAuth session. */
function emitAuthFailure(channel: ReturnType<typeof makeThrowableChannel>) {
  channel.push({
    type: 'assistant',
    error: 'authentication_failed',
    parent_tool_use_id: null,
    message: { content: [{ type: 'text', text: OAUTH_EXPIRED }] },
    session_id: 's1',
  });
  channel.push({
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: OAUTH_EXPIRED,
    api_error_status: 401,
    session_id: 's1',
    total_cost_usd: 0,
    num_turns: 1,
    usage: {},
  });
}

function emitSuccess(channel: ReturnType<typeof makeThrowableChannel>, text = 'All done') {
  channel.push({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'text', text }] },
    session_id: 's2',
  });
  channel.push({
    type: 'result', subtype: 'success', is_error: false, result: text,
    session_id: 's2', total_cost_usd: 0.01, num_turns: 1, usage: {},
  });
}

describe('ThreadSession — expired Claude sign-in recovery', () => {
  beforeEach(() => {
    sdk.generations = [];
    sdk.nextIterable = null;
  });

  it('tears down the CLI process and replays the same turn once, with no error and no auth-error message', async () => {
    const out0 = makeThrowableChannel();
    sdk.nextIterable = out0;
    const events: string[] = [];
    const messages: string[] = [];
    const session = new ThreadSession('/fake/claude');
    await session.start(options(callbacks({
      onAuthRetry: () => events.push('auth_retry'),
      onAuthRequired: () => events.push('auth_required'),
      onMessage: (content) => messages.push(content),
      onDone: () => events.push('done'),
      onError: (e) => events.push(`error:${e.message}`),
    })));
    session.send('do the thing', undefined, '0198f7b2-aaaa-7bbb-8ccc-123456789abc');

    const out1 = makeThrowableChannel();
    sdk.nextIterable = out1;
    emitAuthFailure(out0);
    await flush();

    // A fresh process was spawned and the old one closed.
    expect(sdk.generations).toHaveLength(2);
    expect(sdk.generations[0].closeCalls).toBeGreaterThan(0);
    expect(events).toEqual(['auth_retry']);
    // The auth-error text was never surfaced as an assistant message.
    expect(messages).toEqual([]);

    // Exactly one replay of the original turn, same uuid.
    const [replayed] = await drainInputs(sdk.generations[1], 1);
    expect(replayed.uuid).toBe('0198f7b2-aaaa-7bbb-8ccc-123456789abc');
    expect(JSON.stringify(replayed.content)).toContain('do the thing');

    emitSuccess(out1);
    await flush();
    expect(events).toEqual(['auth_retry', 'done']);
    expect(messages).toEqual(['All done']);
    session.close();
  });

  it('never retries twice for one turn: a second auth failure surfaces the sign-in-expired error', async () => {
    const out0 = makeThrowableChannel();
    sdk.nextIterable = out0;
    const events: string[] = [];
    const required: string[] = [];
    const session = new ThreadSession('/fake/claude');
    await session.start(options(callbacks({
      onAuthRetry: () => events.push('auth_retry'),
      onAuthRequired: (m) => { events.push('auth_required'); required.push(m); },
      onDone: () => events.push('done'),
      onError: () => events.push('error'),
    })));
    session.send('do the thing');

    const out1 = makeThrowableChannel();
    sdk.nextIterable = out1;
    emitAuthFailure(out0);
    await flush();

    const out2 = makeThrowableChannel();
    sdk.nextIterable = out2;
    emitAuthFailure(out1);
    await flush();

    expect(sdk.generations).toHaveLength(2); // no third spawn
    expect(events).toEqual(['auth_retry', 'auth_required']);
    expect(isClaudeSignInExpiredError(required[0])).toBe(true);
    expect(required[0]).toContain(OAUTH_EXPIRED);
    // The failed process is torn down so the next spawn re-reads the keychain.
    expect(sdk.generations[1].closeCalls).toBeGreaterThan(0);
    expect(() => session.send('again')).toThrow();
  });

  it('falls back to onError with the sign-in-expired message when no onAuthRequired handler is wired (unattended callers)', async () => {
    const out0 = makeThrowableChannel();
    sdk.nextIterable = out0;
    const errors: Error[] = [];
    const session = new ThreadSession('/fake/claude');
    await session.start(options(callbacks({ onError: (e) => errors.push(e) })));
    session.send('do the thing');
    const out1 = makeThrowableChannel();
    sdk.nextIterable = out1;
    emitAuthFailure(out0);
    await flush();
    emitAuthFailure(out1);
    await flush();
    expect(errors).toHaveLength(1);
    expect(errors[0].message.startsWith(CLAUDE_SIGN_IN_EXPIRED_MESSAGE)).toBe(true);
  });

  it('recovers from an auth failure thrown by the output iterator', async () => {
    const out0 = makeThrowableChannel();
    sdk.nextIterable = out0;
    const events: string[] = [];
    const session = new ThreadSession('/fake/claude');
    await session.start(options(callbacks({
      onAuthRetry: () => events.push('auth_retry'),
      onError: () => events.push('error'),
      onDone: () => events.push('done'),
    })));
    session.send('do the thing');
    const out1 = makeThrowableChannel();
    sdk.nextIterable = out1;
    out0.throwNext(new Error(OAUTH_EXPIRED));
    await flush();
    expect(sdk.generations).toHaveLength(2);
    expect(events).toEqual(['auth_retry']);
    emitSuccess(out1);
    await flush();
    expect(events).toEqual(['auth_retry', 'done']);
    session.close();
  });

  it('gives each new user turn its own single retry', async () => {
    const out0 = makeThrowableChannel();
    sdk.nextIterable = out0;
    const events: string[] = [];
    const session = new ThreadSession('/fake/claude');
    await session.start(options(callbacks({
      onAuthRetry: () => events.push('auth_retry'),
      onAuthRequired: () => events.push('auth_required'),
      onDone: () => events.push('done'),
    })));
    session.send('first');
    const out1 = makeThrowableChannel();
    sdk.nextIterable = out1;
    emitAuthFailure(out0);
    await flush();
    emitSuccess(out1);
    await flush();

    session.send('second');
    const out2 = makeThrowableChannel();
    sdk.nextIterable = out2;
    emitAuthFailure(out1);
    await flush();
    expect(events).toEqual(['auth_retry', 'done', 'auth_retry']);
    expect(sdk.generations).toHaveLength(3);
    session.close();
  });

  it('does not treat an unrelated is_error result as an auth failure', async () => {
    const out0 = makeThrowableChannel();
    sdk.nextIterable = out0;
    const events: string[] = [];
    const session = new ThreadSession('/fake/claude');
    await session.start(options(callbacks({
      onAuthRetry: () => events.push('auth_retry'),
      onDone: () => events.push('done'),
    })));
    session.send('go');
    out0.push({ type: 'result', subtype: 'success', is_error: true, result: 'Prompt is too long', session_id: 's', total_cost_usd: 0, num_turns: 1, usage: {} });
    await flush();
    expect(events).toEqual(['done']);
    expect(sdk.generations).toHaveLength(1);
    session.close();
  });

  it("AWS Bedrock credential failures skip the silent restart and go straight to onAuthRequired (a restart cannot fix an expired SSO session)", async () => {
    const AWS_TEXT = "API Error: Could not load AWS credentials · The SSO session token associated with profile=probe-expired was not found or is invalid. To refresh this SSO session run 'aws sso login' with the corresponding profile.";
    const out0 = makeThrowableChannel();
    sdk.nextIterable = out0;
    const events: string[] = [];
    const required: string[] = [];
    const session = new ThreadSession("/fake/claude");
    await session.start(options(callbacks({
      onAuthRetry: () => events.push("auth_retry"),
      onAuthRequired: (m) => { events.push("auth_required"); required.push(m); },
      onDone: () => events.push("done"),
      onError: () => events.push("error"),
    })));
    session.send("do the thing");
    out0.push({ type: "assistant", error: "cloud_credential_error", parent_tool_use_id: null, message: { content: [{ type: "text", text: AWS_TEXT }] }, session_id: "s1" });
    out0.push({ type: "result", subtype: "success", is_error: true, result: AWS_TEXT, api_error_status: null, terminal_reason: "api_error", session_id: "s1", total_cost_usd: 0, num_turns: 1, usage: {} });
    await flush();
    expect(sdk.generations).toHaveLength(1); // no silent respawn
    expect(events).toEqual(["auth_required"]);
    expect(isAwsSignInExpiredError(required[0])).toBe(true);
    expect(required[0]).toContain("profile=probe-expired");
    expect(isClaudeSignInExpiredError(required[0])).toBe(false);
  });
});

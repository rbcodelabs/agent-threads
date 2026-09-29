/**
 * Regression tests for a silent data-loss bug in ThreadSession.pumpMessages'
 * `case 'assistant'` handler.
 *
 * `pendingToolCalls` collects `tool_use` blocks from the CURRENT SDK
 * `assistant` message only. Before the fix, it was flushed to
 * `thread.messages` (via `callbacks.onMessage`) ONLY if that same SDK message
 * also contained a text block — but the buffer was unconditionally cleared
 * right after, every message, not just at generation end. Claude Code
 * agentic turns routinely involve sequential, dependent tool calls (each its
 * own round-trip SDK `assistant` message with only `tool_use` blocks, no
 * text) — those tool calls rendered live via `onToolUse` but were NEVER
 * committed via `onMessage`, so they silently vanished from persisted
 * history the moment a later message flushed (or the buffer was wiped).
 *
 * The fix: flush whenever there's text OR pending tool calls, and add a
 * defensive backstop in the `finally` block so an external close() (or any
 * other early unwind) mid-generation still commits whatever tool calls were
 * collected so far.
 *
 * Mocks the SDK `query()` following the pattern in rate-limit-retry.test.ts
 * and input-stream-lifecycle.test.ts: each query() call is a "generation",
 * and a controllable async-iterable output channel feeds messages into a
 * real ThreadSession instance's pump loop.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { ThreadSessionOptions } from '../../src/ThreadSession';
import type { ToolCallRecord } from '../../src/types';

// ─── controllable output-message channel (mirrors input-stream-lifecycle.test.ts) ───
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

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await tick();
}

const successResult = (sessionId = 's', numTurns = 1) =>
  ({ type: 'result', subtype: 'success', session_id: sessionId, total_cost_usd: 0, num_turns: numTurns });

const toolUseAssistantMsg = (toolUseId: string, name = 'EnterWorktree', input: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: toolUseId, name, input },
    ],
  },
});

const textAndToolAssistantMsg = (text: string, toolUseId: string, name = 'Read', input: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text },
      { type: 'tool_use', id: toolUseId, name, input },
    ],
  },
});


describe('ThreadSession — browser tool records feed the session card', () => {
  it('summarises browser tool_use inputs and copies url/title/error from results (never page content or typed text)', async () => {
    sdk.generations = [];
    const out = makeChannel();
    sdk.nextIterable = out;
    const toolUses: ToolCallRecord[] = [];
    const session = new ThreadSession('/fake/claude');
    await session.start(baseOptions(minimalCallbacks({ onToolUse: (r) => toolUses.push(r) })));
    session.send('browse');
    await flush();

    const NAV = 'mcp__claude_threads__browser_navigate';
    out.push(toolUseAssistantMsg('nav-1', NAV, { url: 'https://acme.io/pricing?utm=secret#x' }));
    out.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'nav-1', is_error: false,
      content: [{ type: 'text', text: JSON.stringify({ success: true, url: 'https://acme.io/pricing?utm=secret', title: 'Pricing', snapshot: 'PAGE BODY' }) }] }] } });
    out.push(toolUseAssistantMsg('type-1', 'mcp__claude_threads__browser_type', { ref: 'e3', epoch: 1, text: 'hunter2' }));
    out.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'type-1', is_error: true,
      content: [{ type: 'text', text: JSON.stringify({ success: false, error: { code: 'stale_snapshot', message: 'Page changed', retryable: true } }) }] }] } });
    await flush();

    const nav = toolUses.find((t) => t.toolUseId === 'nav-1')!;
    expect(nav.summary).toBe('https://acme.io/pricing');
    expect(nav.status).toBe('success');
    expect(nav.browser).toEqual({ pageUrl: 'https://acme.io/pricing', pageTitle: 'Pricing' });

    const typed = toolUses.find((t) => t.toolUseId === 'type-1')!;
    expect(typed.summary).toBe('e3 · 7 chars');
    expect(typed.status).toBe('error');
    expect(typed.browser).toEqual({ error: 'Page changed' });

    const serialized = JSON.stringify(toolUses);
    expect(serialized).not.toContain('PAGE BODY');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('utm=secret');
    session.close();
    out.close();
  });
});

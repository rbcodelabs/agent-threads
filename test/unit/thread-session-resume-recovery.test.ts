import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';

const sdk = vi.hoisted(() => ({ outputs: [] as AsyncIterable<unknown>[], calls: [] as any[], failCall: -1 }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: any) => {
    sdk.calls.push(args);
    if (sdk.calls.length === sdk.failCall) throw new Error('CLI initialization failed');
    const output = sdk.outputs.shift()!;
    return { [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), close: vi.fn(),
      supportedModels: async () => [], supportedAgents: async () => [] };
  },
}));
const { ThreadSession } = await import('../../src/ThreadSession');
const missing = 'No conversation found with session ID: gone';
function failing(events: unknown[]): AsyncIterable<unknown> {
  return { async *[Symbol.asyncIterator]() { await Promise.resolve(); for (const event of events) yield event; throw new Error(missing); } };
}
function waiting(): AsyncIterable<unknown> {
  return { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } };
}
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function callbacks(): SessionCallbacks {
  return { onToken: vi.fn(), onToolUse: vi.fn(), onMessage: vi.fn(), onRecap: vi.fn(),
    onDone: vi.fn(), onInterrupted: vi.fn(), onError: vi.fn(), onReconnecting: vi.fn(),
    onPermissionRequest: async () => true, onAskUserQuestion: async () => ({}),
    onOpenNewTab: async () => ({ threadId: '', title: '' }) };
}
describe('Claude missing-session recovery', () => {
  beforeEach(() => { sdk.calls = []; sdk.outputs = []; sdk.failCall = -1; });
  it('reports the original initialization failure once if fresh fallback cannot start', async () => {
    sdk.outputs = [failing([])]; sdk.failCall = 2;
    const cb = callbacks(); const session = new ThreadSession('/fake/claude');
    await session.start({ cwd: '/tmp', permissionMode: 'default', extraEnvRaw: '', resume: 'gone', callbacks: cb });
    session.send('continue'); await flush();
    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(cb.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'CLI initialization failed' }));
    session.close();
  });
  it('does not replay a stale user turn when a restarted session fails before another send', async () => {
    sdk.outputs = [waiting(), failing([]), waiting()];
    const cb = callbacks(); const session = new ThreadSession('/fake/claude');
    await session.start({ cwd: '/tmp', permissionMode: 'default', extraEnvRaw: '', resume: 'gone', callbacks: cb });
    session.send('old action');
    await session.restart('transport-error'); await flush();
    expect(sdk.calls).toHaveLength(2);
    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(cb.onReconnecting).not.toHaveBeenCalled();
    session.close();
  });
  it('recovers after init and an error result, preserving history, images and message UUID', async () => {
    sdk.outputs = [failing([{ type: 'system', subtype: 'init', session_id: 'gone' },
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [missing] }]), waiting()];
    const cb = callbacks();
    const session = new ThreadSession('/fake/claude');
    await session.start({ cwd: '/tmp', permissionMode: 'default', extraEnvRaw: '', resume: 'gone',
      resumeFallbackHistory: 'Prior canonical history\n\n', callbacks: cb });
    session.send('continue', [{ mediaType: 'image/png', base64: 'image', name: 'x' }], 'user-uuid');
    await flush();
    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[1].options.resume).toBeUndefined();
    const input = await sdk.calls[1].prompt[Symbol.asyncIterator]().next();
    expect(input.value.uuid).toBe('user-uuid');
    expect(input.value.message.content).toContainEqual({ type: 'text', text: 'Prior canonical history\n\ncontinue' });
    expect(input.value.message.content).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'image' } });
    expect(cb.onError).not.toHaveBeenCalled();
    expect(cb.onReconnecting).toHaveBeenCalledTimes(1);
    session.close();
  });
  it('does not replay after assistant tool work and reports only one terminal error', async () => {
    sdk.outputs = [failing([{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } },
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [missing] }])];
    const cb = callbacks(); const session = new ThreadSession('/fake/claude');
    await session.start({ cwd: '/tmp', permissionMode: 'default', extraEnvRaw: '', resume: 'gone', callbacks: cb });
    session.send('continue'); await flush();
    expect(sdk.calls).toHaveLength(1);
    expect(cb.onError).toHaveBeenCalledTimes(1);
    session.close();
  });
  it('does not loop when the fresh fallback also fails', async () => {
    sdk.outputs = [failing([]), failing([{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [missing] }])];
    const cb = callbacks(); const session = new ThreadSession('/fake/claude');
    await session.start({ cwd: '/tmp', permissionMode: 'default', extraEnvRaw: '', resume: 'gone', callbacks: cb });
    session.send('continue'); await flush();
    expect(sdk.calls).toHaveLength(2);
    expect(cb.onError).toHaveBeenCalledTimes(1);
    session.close();
  });
});

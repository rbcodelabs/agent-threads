import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import { clearLogRing, getLogRing } from '../../src/logger';

const GH = 'ghp_' + 'b'.repeat(36);

const sdk = vi.hoisted(() => ({ outputs: [] as AsyncIterable<unknown>[] }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const output = sdk.outputs.shift()!;
    return { [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), close: vi.fn(),
      supportedModels: async () => [], supportedAgents: async () => [] };
  },
}));
const { ThreadSession } = await import('../../src/ThreadSession');

function throwing(message: string): AsyncIterable<unknown> {
  return { async *[Symbol.asyncIterator]() { await Promise.resolve(); throw new Error(message); } };
}
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function callbacks(): SessionCallbacks {
  return { onToken: vi.fn(), onToolUse: vi.fn(), onMessage: vi.fn(), onRecap: vi.fn(),
    onDone: vi.fn(), onInterrupted: vi.fn(), onError: vi.fn(), onReconnecting: vi.fn(),
    onPermissionRequest: async () => true, onAskUserQuestion: async () => ({}),
    onOpenNewTab: async () => ({ threadId: '', title: '' }) };
}

describe('ThreadSession pump error logging', () => {
  beforeEach(() => {
    sdk.outputs = [];
    clearLogRing();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('masks a secret in the pump error before it reaches the console or the log ring', async () => {
    sdk.outputs = [throwing(`upstream rejected GITHUB_TOKEN=${GH}`)];
    const cb = callbacks();
    const session = new ThreadSession('/fake/claude');
    await session.start({ cwd: '/tmp', permissionMode: 'default', extraEnvRaw: '', callbacks: cb });
    session.send('go');
    await flush();

    const consoleOut = JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls);
    expect(consoleOut).toContain('ThreadSession pump error');
    expect(consoleOut).not.toContain(GH);
    expect(JSON.stringify(getLogRing())).not.toContain(GH);
    expect(cb.onError).toHaveBeenCalledTimes(1);
    session.close();
  });
});

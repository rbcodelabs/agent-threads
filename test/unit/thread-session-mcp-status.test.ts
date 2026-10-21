import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';

const sdk = vi.hoisted(() => ({ outputs: [] as AsyncIterable<unknown>[] }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const output = sdk.outputs.shift()!;
    return { [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), close: vi.fn(), supportedModels: async () => [], supportedAgents: async () => [] };
  },
}));
const { ThreadSession } = await import('../../src/ThreadSession');

function stream(events: unknown[]): AsyncIterable<unknown> {
  return { async *[Symbol.asyncIterator]() { await Promise.resolve(); for (const e of events) yield e; await new Promise(() => {}); } };
}
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function callbacks(onMcpServerStatus: SessionCallbacks['onMcpServerStatus']): SessionCallbacks {
  return { onToken: vi.fn(), onToolUse: vi.fn(), onMessage: vi.fn(), onRecap: vi.fn(), onDone: vi.fn(), onInterrupted: vi.fn(), onError: vi.fn(),
    onReconnecting: vi.fn(), onPermissionRequest: async () => true, onAskUserQuestion: async () => ({}),
    onOpenNewTab: async () => ({ threadId: '', title: '' }), onMcpServerStatus };
}

describe('system/init mcp_servers -> onMcpServerStatus', () => {
  beforeEach(() => { sdk.outputs = []; });

  it('reports each server, with a failed one as failed', async () => {
    sdk.outputs = [stream([{ type: 'system', subtype: 'init', session_id: 's1', mcp_servers: [{ name: 'claude_threads', status: 'connected' }, { name: 'docs', status: 'failed' }] }])];
    const onStatus = vi.fn();
    const session = new ThreadSession('/fake/claude');
    await session.start({ cwd: '/tmp', permissionMode: 'default', extraEnvRaw: '', callbacks: callbacks(onStatus) });
    session.send('hi'); await flush();
    expect(onStatus).toHaveBeenCalledWith([{ name: 'claude_threads', status: 'connected' }, { name: 'docs', status: 'failed' }]);
    session.close();
  });

  it('stays silent when init carries no server list', async () => {
    sdk.outputs = [stream([{ type: 'system', subtype: 'init', session_id: 's1' }])];
    const onStatus = vi.fn();
    const session = new ThreadSession('/fake/claude');
    await session.start({ cwd: '/tmp', permissionMode: 'default', extraEnvRaw: '', callbacks: callbacks(onStatus) });
    session.send('hi'); await flush();
    expect(onStatus).not.toHaveBeenCalled();
    session.close();
  });
});

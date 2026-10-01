/**
 * Wiring of the sandbox loopback resolver into the host-side URL tools:
 * browser_navigate (via ThreadBrowser) and obsidian_open_url / host_open_url.
 */
import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({
    name, description, inputSchema, handler,
  }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools }),
}));

import { ThreadBrowser } from '../../src/agentBrowser/ThreadBrowser';
import { AgentBrowserError } from '../../src/agentBrowser/agentBrowserErrors';
import type { AgentBrowserPool } from '../../src/agentBrowser/AgentBrowserPool';
import { createClaudeThreadsMcpServers } from '../../src/ObsidianTools';
import { VmLoopbackError, type VmUrlResolution } from '../../src/vmPortForward';

function browserWith(resolveUrl?: (url: string) => Promise<VmUrlResolution>) {
  const navigate = vi.fn(async () => undefined);
  const snapshot = { url: 'x', title: 't', origin: 'o', epoch: 1, count: 0, truncated: false, snapshot: '' };
  const guest = { navigate, runScript: vi.fn(async () => snapshot) };
  const pool = { acquire: async () => guest } as unknown as AgentBrowserPool;
  return { browser: new ThreadBrowser({ threadId: 't1', pool, resolveUrl }), navigate };
}

describe('ThreadBrowser.navigate with a sandbox URL resolver', () => {
  it('navigates the original URL when no resolver is configured (host-local threads)', async () => {
    const { browser, navigate } = browserWith();
    const res = await browser.navigate('http://localhost:3000/');
    expect(navigate).toHaveBeenCalledWith('http://localhost:3000/');
    expect(res).not.toHaveProperty('note');
  });

  it('navigates the original URL on passthrough', async () => {
    const { browser, navigate } = browserWith(async () => ({ kind: 'passthrough' }));
    await browser.navigate('http://localhost:3000/');
    expect(navigate).toHaveBeenCalledWith('http://localhost:3000/');
  });

  it('navigates the forwarded URL and tells the agent what happened', async () => {
    const { browser, navigate } = browserWith(async () => ({
      kind: 'forwarded', url: 'http://127.0.0.1:50000/', requestedUrl: 'http://localhost:8000/',
      hostPort: 50000, guestPort: 8000, note: 'forwarded note',
    }));
    const res = await browser.navigate('http://localhost:8000/');
    expect(navigate).toHaveBeenCalledWith('http://127.0.0.1:50000/');
    expect(res).toMatchObject({ requestedUrl: 'http://localhost:8000/', note: 'forwarded note' });
  });

  it('turns a VmLoopbackError into an actionable AgentBrowserError without navigating', async () => {
    const { browser, navigate } = browserWith(async () => {
      throw new VmLoopbackError('Nothing is listening on port 8000 inside the sandbox VM', 'run it in the background');
    });
    const err = await browser.navigate('http://localhost:8000/').catch((e) => e);
    expect(err).toBeInstanceOf(AgentBrowserError);
    expect(err.message).toMatch(/nothing is listening on port 8000/i);
    expect(err.hint).toMatch(/background/);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('obsidian_open_url with a sandbox URL resolver', () => {
  const setViewState = vi.fn(async () => undefined);
  const leaf = { setViewState };
  const app = {
    plugins: { plugins: {} },
    workspace: {
      getLeavesOfType: () => [], getLeaf: () => leaf, revealLeaf: () => undefined, onLayoutReady: (cb: () => void) => cb(),
    },
    vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
    metadataCache: { on: () => {} },
  } as unknown as App;

  function openUrlTool(resolveSandboxUrl?: (url: string) => Promise<VmUrlResolution>) {
    const server = createClaudeThreadsMcpServers(app, {
      threadId: 't1', enableOpenUrl: true, resolveSandboxUrl,
    } as never).claude_threads as unknown as { tools: Array<{ name: string; handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }> };
    return server.tools.find((t) => t.name === 'host_open_url')!;
  }

  it('opens the forwarded URL and reports the note', async () => {
    setViewState.mockClear();
    const tool = openUrlTool(async () => ({
      kind: 'forwarded', url: 'http://127.0.0.1:50000/', requestedUrl: 'http://localhost:8000/',
      hostPort: 50000, guestPort: 8000, note: 'forwarded note',
    }));
    const r = await tool.handler({ url: 'http://localhost:8000/' }, {});
    const payload = JSON.parse(r.content[0].text);
    expect(payload).toMatchObject({ success: true, url: 'http://127.0.0.1:50000/', requestedUrl: 'http://localhost:8000/', note: 'forwarded note' });
    expect(setViewState).toHaveBeenCalledWith(expect.objectContaining({ state: { url: 'http://127.0.0.1:50000/' } }));
  });

  it('returns the actionable error as a tool error', async () => {
    const tool = openUrlTool(async () => { throw new VmLoopbackError('Nothing is listening on port 8000 inside the sandbox VM', 'hint text'); });
    const r = await tool.handler({ url: 'http://localhost:8000/' }, {});
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text)).toMatchObject({ success: false, hint: 'hint text' });
  });

  it('is unchanged without a resolver', async () => {
    setViewState.mockClear();
    const tool = openUrlTool();
    await tool.handler({ url: 'http://localhost:8000/' }, {});
    expect(setViewState).toHaveBeenCalledWith(expect.objectContaining({ state: { url: 'http://localhost:8000/' } }));
  });
});

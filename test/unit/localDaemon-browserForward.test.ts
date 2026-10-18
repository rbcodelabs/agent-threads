/**
 * Wiring of the local daemon's loopback forwarder into the host-side browser tool (browser_navigate via ThreadBrowser).
 * (host_open_url is not offered to daemon threads, see toolRouting NEVER_OFFERED; browser_navigate covers the use.)
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools }),
}));

import { ThreadBrowser } from '../../src/agentBrowser/ThreadBrowser';
import { AgentBrowserError } from '../../src/agentBrowser/agentBrowserErrors';
import type { AgentBrowserPool } from '../../src/agentBrowser/AgentBrowserPool';
import { DaemonLoopbackError, type DaemonUrlResolution } from '../../src/loopbackUrl';

function browserWith(resolveUrl?: (url: string) => Promise<DaemonUrlResolution>) {
  const navigate = vi.fn(async () => undefined);
  const snapshot = { url: 'x', title: 't', origin: 'o', epoch: 1, count: 0, truncated: false, snapshot: '' };
  const guest = { navigate, runScript: vi.fn(async () => snapshot) };
  const pool = { acquire: async () => guest } as unknown as AgentBrowserPool;
  return { browser: new ThreadBrowser({ threadId: 't1', pool, resolveUrl }), navigate };
}

describe('ThreadBrowser.navigate with the local daemon URL resolver', () => {
  it('navigates the original URL when no resolver is configured (host threads)', async () => {
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

  it('turns a DaemonLoopbackError into an actionable AgentBrowserError without navigating', async () => {
    const { browser, navigate } = browserWith(async () => {
      throw new DaemonLoopbackError('Nothing is listening on port 8000 inside the local daemon', 'run it in the background');
    });
    const err = await browser.navigate('http://localhost:8000/').catch((e) => e);
    expect(err).toBeInstanceOf(AgentBrowserError);
    expect(err.message).toMatch(/nothing is listening on port 8000/i);
    expect(err.hint).toMatch(/background/);
    expect(navigate).not.toHaveBeenCalled();
  });
});

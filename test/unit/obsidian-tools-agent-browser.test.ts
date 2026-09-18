/**
 * obsidian-tools-agent-browser.test.ts
 *
 * Registration and error-envelope tests for the browser_* MCP tools.
 *
 * Strategy matches obsidian-tools-open-url.test.ts: mock the SDK so each tool's
 * handler can be captured and invoked directly, with a fake ThreadBrowser
 * standing in for a real guest.
 */

import { describe, it, expect, vi } from 'vitest';
import type { App } from 'obsidian';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (
    name: string,
    _description: string,
    _schema: unknown,
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>,
  ) => ({ _toolName: name, _handler: handler }),
  createSdkMcpServer: ({ tools }: { tools: CapturedTool[] }) => ({ tools }),
}));

import { createObsidianMcpServer } from '../../src/ObsidianTools';
import { AGENT_BROWSER_TOOL_NAMES } from '../../src/agentBrowser/agentBrowserTools';
import { AgentBrowserError } from '../../src/agentBrowser/agentBrowserErrors';
import type { ThreadBrowser } from '../../src/agentBrowser/ThreadBrowser';

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

interface CapturedTool {
  _toolName: string;
  _handler: (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;
}

interface CapturedServer {
  tools: CapturedTool[];
}

function makeApp(): App {
  return {
    plugins: { plugins: {} },
    workspace: {
      getLeavesOfType: vi.fn().mockReturnValue([]),
      getLeaf: vi.fn().mockReturnValue({ setViewState: vi.fn() }),
      revealLeaf: vi.fn(),
      onLayoutReady: (cb: () => void) => cb(),
    },
    vault: { getAbstractFileByPath: () => null },
    metadataCache: { on: () => {} },
  } as unknown as App;
}

function fakeBrowser(overrides: Partial<ThreadBrowser> = {}): ThreadBrowser {
  return {
    threadId: 't1',
    navigate: vi.fn().mockResolvedValue({
      url: 'https://example.com/', title: 'Example', origin: 'https://example.com',
      epoch: 1, count: 1, truncated: false, snapshot: '- link "Home" [ref=e1]',
    }),
    snapshot: vi.fn().mockResolvedValue({
      url: 'https://example.com/', title: 'Example', origin: 'https://example.com',
      epoch: 2, count: 1, truncated: false, snapshot: '- link "Home" [ref=e1]',
    }),
    readText: vi.fn().mockResolvedValue({ url: 'https://example.com/', title: 'Example', content: 'framed' }),
    click: vi.fn().mockResolvedValue({ url: 'https://example.com/', title: 'Example' }),
    type: vi.fn().mockResolvedValue({ url: 'https://example.com/', title: 'Example' }),
    screenshot: vi.fn().mockResolvedValue(new Uint8Array([137, 80, 78, 71])),
    close: vi.fn(),
    status: vi.fn().mockReturnValue({ inUse: 1, max: 2, fdBlocked: false, fdAvailable: true, guests: [], threadHasSession: true }),
    ...overrides,
  } as unknown as ThreadBrowser;
}

function getTool(server: CapturedServer, name: string): CapturedTool {
  const found = server.tools.find((t) => t._toolName === name);
  if (!found) throw new Error(`Tool "${name}" not found`);
  return found;
}

function parse(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text ?? '{}');
}

describe('agent browser tool registration', () => {
  it('registers nothing when no browser is supplied', () => {
    // An unsupported host must not pay context for tools that can only refuse.
    const server = createObsidianMcpServer(makeApp(), {}) as unknown as CapturedServer;
    const names = server.tools.map((t) => t._toolName);
    for (const name of AGENT_BROWSER_TOOL_NAMES) {
      expect(names, name).not.toContain(name);
    }
  });

  it('registers the full set when a browser is supplied', () => {
    const server = createObsidianMcpServer(makeApp(), { browser: fakeBrowser() }) as unknown as CapturedServer;
    const names = server.tools.map((t) => t._toolName);
    for (const name of AGENT_BROWSER_TOOL_NAMES) {
      expect(names, name).toContain(name);
    }
  });

  it('does not collide with existing tool names', () => {
    const server = createObsidianMcpServer(makeApp(), { browser: fakeBrowser() }) as unknown as CapturedServer;
    const names = server.tools.map((t) => t._toolName);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('agent browser tool behaviour', () => {
  it('returns the snapshot and its epoch from navigate', () => {
    const server = createObsidianMcpServer(makeApp(), { browser: fakeBrowser() }) as unknown as CapturedServer;
    return getTool(server, 'browser_navigate')
      ._handler({ url: 'https://example.com' })
      .then((result) => {
        const payload = parse(result);
        expect(payload.success).toBe(true);
        expect(payload.epoch).toBe(1);
        expect(payload.snapshot).toContain('[ref=e1]');
      });
  });

  it('passes the ref and epoch through to the browser', async () => {
    const browser = fakeBrowser();
    const server = createObsidianMcpServer(makeApp(), { browser }) as unknown as CapturedServer;
    await getTool(server, 'browser_click')._handler({ ref: 'e3', epoch: 7 });
    expect(browser.click).toHaveBeenCalledWith('e3', 7);
    await getTool(server, 'browser_type')._handler({ ref: 'e1', epoch: 7, text: 'hi', submit: true });
    expect(browser.type).toHaveBeenCalledWith('e1', 7, 'hi', true);
  });

  it('returns a screenshot as an image content block', async () => {
    const server = createObsidianMcpServer(makeApp(), { browser: fakeBrowser() }) as unknown as CapturedServer;
    const result = await getTool(server, 'browser_screenshot')._handler({});
    expect(result.content[0].type).toBe('image');
    expect(result.content[0].mimeType).toBe('image/png');
    // Base64 of the PNG magic bytes, produced without Node's Buffer.
    expect(result.content[0].data).toBe('iVBORw==');
  });

  it('reports a failure as a value, never as a thrown exception', async () => {
    // The MCP surface contract: handlers return isError, they do not throw.
    const browser = fakeBrowser({
      navigate: vi.fn().mockRejectedValue(
        new AgentBrowserError({
          code: 'admission_denied_cap',
          message: 'All 2 browser sessions are in use.',
          retryable: true,
          hint: 'Close one with browser_close.',
        }),
      ) as unknown as ThreadBrowser['navigate'],
    });
    const server = createObsidianMcpServer(makeApp(), { browser }) as unknown as CapturedServer;

    const result = await getTool(server, 'browser_navigate')._handler({ url: 'https://example.com' });

    expect(result.isError).toBe(true);
    const payload = parse(result) as { error: Record<string, unknown> };
    // Code, retryability and hint survive intact so the agent can act on them
    // rather than parse prose.
    expect(payload.error.code).toBe('admission_denied_cap');
    expect(payload.error.retryable).toBe(true);
    expect(payload.error.hint).toContain('browser_close');
  });

  it('marks an unrecognised failure as non-retryable', async () => {
    // An error we did not anticipate is not one we can promise will clear.
    const browser = fakeBrowser({
      snapshot: vi.fn().mockRejectedValue(new Error('boom')) as unknown as ThreadBrowser['snapshot'],
    });
    const server = createObsidianMcpServer(makeApp(), { browser }) as unknown as CapturedServer;
    const result = await getTool(server, 'browser_snapshot')._handler({});
    const payload = parse(result) as { error: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe('unknown');
    expect(payload.error.retryable).toBe(false);
  });

  it('closes the session on request', async () => {
    const browser = fakeBrowser();
    const server = createObsidianMcpServer(makeApp(), { browser }) as unknown as CapturedServer;
    const result = await getTool(server, 'browser_close')._handler({});
    expect(browser.close).toHaveBeenCalled();
    expect(parse(result).closed).toBe(true);
  });
});

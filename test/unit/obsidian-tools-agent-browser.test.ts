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
    description: string,
    _schema: unknown,
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>,
  ) => ({ _toolName: name, _description: description, _handler: handler }),
  createSdkMcpServer: ({ tools }: { tools: CapturedTool[] }) => ({ tools }),
}));

import { createObsidianMcpServer } from '../../src/ObsidianTools';
import {
  AGENT_BROWSER_READ_ONLY_TOOL_NAMES,
  AGENT_BROWSER_TOOL_NAMES,
} from '../../src/agentBrowser/agentBrowserTools';
import { isTrustedBuiltInTool } from '../../src/toolNameUtils';
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
    canSavePages: true,
    savePage: vi.fn().mockResolvedValue({
      path: '/tmp/geode-browser/t1/0001-page.json', bytes: 120, chars: 118, contentType: 'application/json',
      url: 'https://example.com/data.json', truncated: false, note: 'untrusted',
    }),
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
    scroll: vi.fn().mockResolvedValue({ url: 'https://example.com/', title: 'Example', moved: true, scrollX: 0, scrollY: 400, maxScrollX: 0, maxScrollY: 2000 }),
    screenshot: vi.fn().mockResolvedValue(new Uint8Array([137, 80, 78, 71])),
    close: vi.fn(),
    status: vi.fn().mockReturnValue({ inUse: 1, max: 2, fdBlocked: false, fdAvailable: true, guests: [], threadHasSession: true }),
    resize: vi.fn().mockResolvedValue({
      url: 'https://example.com/', title: 'Example', origin: 'https://example.com',
      epoch: 3, count: 1, truncated: false, snapshot: '- link "Home" [ref=e1]',
    }),
    console: vi.fn().mockResolvedValue({ url: 'https://example.com/', total: 0, returned: 0, buffered: 0, dropped: 0, content: 'framed' }),
    network: vi.fn().mockResolvedValue({ url: 'https://example.com/', total: 0, returned: 0, buffered: 0, dropped: 0, content: 'framed' }),
    evaluate: vi.fn().mockResolvedValue({ url: 'https://example.com/', type: 'number', truncated: false, threw: false, content: 'framed' }),
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

describe('browser_scroll', () => {
  it('is registered, prompt-free (read-only set) and a trusted built-in', () => {
    expect(AGENT_BROWSER_TOOL_NAMES).toContain('browser_scroll');
    expect(AGENT_BROWSER_READ_ONLY_TOOL_NAMES).toContain('browser_scroll');
    expect(isTrustedBuiltInTool('mcp__claude_threads__browser_scroll')).toBe(true);
  });

  it('passes direction, amount, ref and epoch through to the browser', async () => {
    const browser = fakeBrowser();
    const server = createObsidianMcpServer(makeApp(), { browser }) as unknown as CapturedServer;
    const down = parse(await getTool(server, 'browser_scroll')._handler({ direction: 'down', amount: 250 }));
    expect(browser.scroll).toHaveBeenCalledWith({ direction: 'down', amount: 250, ref: undefined, epoch: undefined });
    expect(down.success).toBe(true);
    expect(down.moved).toBe(true);
    await getTool(server, 'browser_scroll')._handler({ ref: 'e4', epoch: 9 });
    expect(browser.scroll).toHaveBeenLastCalledWith({ direction: undefined, amount: undefined, ref: 'e4', epoch: 9 });
  });

  it('returns a refusal as an error value, not a throw', async () => {
    const browser = fakeBrowser({
      scroll: vi.fn().mockRejectedValue(new AgentBrowserError({ code: 'stale_snapshot', message: 'stale', retryable: true })),
    } as Partial<ThreadBrowser>);
    const server = createObsidianMcpServer(makeApp(), { browser }) as unknown as CapturedServer;
    const result = await getTool(server, 'browser_scroll')._handler({ ref: 'e1', epoch: 1 });
    expect(result.isError).toBe(true);
  });

  it('browser_eval description is an explicit last resort naming the safe tools', () => {
    const server = createObsidianMcpServer(makeApp(), { browser: fakeBrowser() }) as unknown as CapturedServer;
    const description = String((getTool(server, 'browser_eval') as unknown as { _description: string })._description);
    expect(description).toMatch(/LAST RESORT/);
    for (const safe of ['browser_snapshot', 'browser_scroll', 'browser_click', 'browser_type', 'browser_read_text', 'browser_console', 'browser_network']) {
      expect(description, safe).toContain(safe);
    }
    expect(description).toMatch(/approval prompt/);
  });
});

describe('browser_save_page registration', () => {
  it('is a browser tool but is not read-only, because it writes a file', () => {
    expect(AGENT_BROWSER_TOOL_NAMES).toContain('browser_save_page');
    expect(AGENT_BROWSER_READ_ONLY_TOOL_NAMES).not.toContain('browser_save_page');
  });

  it('is not registered when the host supplies no file sink', () => {
    const browser = fakeBrowser({ canSavePages: false } as Partial<ThreadBrowser>);
    const server = createObsidianMcpServer(makeApp(), { browser }) as unknown as CapturedServer;
    const names = server.tools.map((t) => t._toolName);
    expect(names).not.toContain('browser_save_page');
    // The rest of the browser set is unaffected.
    expect(names).toContain('browser_read_text');
  });

  it('is a trusted built-in tool', () => {
    expect(isTrustedBuiltInTool('mcp__claude_threads__browser_save_page')).toBe(true);
  });
});

describe('devtools tools (console / network / eval)', () => {
  it('console and network are read-only; eval is not (same approval as click/type)', () => {
    expect(AGENT_BROWSER_READ_ONLY_TOOL_NAMES).toContain('browser_console');
    expect(AGENT_BROWSER_READ_ONLY_TOOL_NAMES).toContain('browser_network');
    expect(AGENT_BROWSER_READ_ONLY_TOOL_NAMES).not.toContain('browser_eval');
    expect(AGENT_BROWSER_TOOL_NAMES).toContain('browser_eval');
  });

  it('is trusted as a built-in', () => {
    for (const name of ['browser_console', 'browser_network', 'browser_eval']) {
      expect(isTrustedBuiltInTool(`mcp__claude_threads__${name}`), name).toBe(true);
    }
  });

  it('eval is always registered (so it can explain itself), even though it defaults off', () => {
    const server = createObsidianMcpServer(makeApp(), { browser: fakeBrowser() }) as unknown as CapturedServer;
    expect(server.tools.map((t) => t._toolName)).toContain('browser_eval');
  });

  it('passes console, network and eval arguments through', async () => {
    const browser = fakeBrowser();
    const server = createObsidianMcpServer(makeApp(), { browser }) as unknown as CapturedServer;
    await getTool(server, 'browser_console')._handler({ level: 'error', limit: 5, clear: true });
    expect(browser.console).toHaveBeenCalledWith({ level: 'error', limit: 5, clear: true });
    await getTool(server, 'browser_network')._handler({ filter: 'api', limit: 9, failedOnly: true });
    expect(browser.network).toHaveBeenCalledWith({ filter: 'api', limit: 9, failedOnly: true, clear: undefined });
    const result = await getTool(server, 'browser_eval')._handler({ expression: 'document.title' });
    expect(browser.evaluate).toHaveBeenCalledWith('document.title');
    expect(parse(result)).toMatchObject({ success: true, type: 'number' });
  });

  it('eval returns the setting-naming error as an isError result when disabled', async () => {
    const evaluate = vi.fn().mockRejectedValue(
      new AgentBrowserError({ code: 'capability_unavailable', message: 'browser_eval is disabled. enable X', retryable: false }),
    );
    const server = createObsidianMcpServer(makeApp(), { browser: fakeBrowser({ evaluate } as never) }) as unknown as CapturedServer;
    const result = await getTool(server, 'browser_eval')._handler({ expression: '1' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(parse(result))).toContain('disabled');
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

  it('save: returns the inline image AND the saved path/size, passing maxWidth and filename through', async () => {
    const screenshotAndSave = vi.fn().mockResolvedValue({ png: new Uint8Array([137, 80, 78, 71]), path: '/tmp/geode-browser/t1/1-shot.png', bytes: 4 });
    const screenshot = vi.fn();
    const server = createObsidianMcpServer(makeApp(), { browser: fakeBrowser({ screenshotAndSave, screenshot } as never) }) as unknown as CapturedServer;
    const result = await getTool(server, 'browser_screenshot')._handler({ save: true, maxWidth: 640, filename: 'x' });
    expect(screenshotAndSave).toHaveBeenCalledWith({ maxWidth: 640, filename: 'x' });
    expect(screenshot).not.toHaveBeenCalled();
    expect(result.content[0].type).toBe('image');
    expect(result.content[0].data).toBe('iVBORw==');
    expect(JSON.parse(result.content[1].text ?? '{}')).toEqual({ success: true, path: '/tmp/geode-browser/t1/1-shot.png', bytes: 4 });
  });

  it('save: a failure is a value (isError), with no image', async () => {
    const screenshotAndSave = vi.fn().mockRejectedValue(
      new AgentBrowserError({ code: 'capability_unavailable', message: 'nope', retryable: false }),
    );
    const server = createObsidianMcpServer(makeApp(), { browser: fakeBrowser({ screenshotAndSave } as never) }) as unknown as CapturedServer;
    const result = await getTool(server, 'browser_screenshot')._handler({ save: true });
    expect(result.isError).toBe(true);
    expect(result.content.some((c) => c.type === 'image')).toBe(false);
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

  it('passes format and filename to savePage and returns the path and size', async () => {
    const browser = fakeBrowser();
    const server = createObsidianMcpServer(makeApp(), { browser }) as unknown as CapturedServer;
    const result = await getTool(server, 'browser_save_page')._handler({ format: 'html', filename: 'listing' });
    expect(browser.savePage).toHaveBeenCalledWith({ format: 'html', filename: 'listing' });
    const payload = parse(result);
    expect(payload.success).toBe(true);
    expect(payload.path).toBe('/tmp/geode-browser/t1/0001-page.json');
    expect(payload.bytes).toBe(120);
    expect(payload.truncated).toBe(false);
  });

  it('reports a save failure as a value, never as a thrown exception', async () => {
    const browser = fakeBrowser({
      savePage: vi.fn().mockRejectedValue(
        new AgentBrowserError({ code: 'stale_snapshot', message: 'The page changed while it was being saved.', retryable: true }),
      ) as unknown as ThreadBrowser['savePage'],
    });
    const server = createObsidianMcpServer(makeApp(), { browser }) as unknown as CapturedServer;
    const result = await getTool(server, 'browser_save_page')._handler({});
    expect(result.isError).toBe(true);
    const payload = parse(result) as { error: Record<string, unknown> };
    expect(payload.error.code).toBe('stale_snapshot');
    expect(payload.error.retryable).toBe(true);
  });

  it('closes the session on request', async () => {
    const browser = fakeBrowser();
    const server = createObsidianMcpServer(makeApp(), { browser }) as unknown as CapturedServer;
    const result = await getTool(server, 'browser_close')._handler({});
    expect(browser.close).toHaveBeenCalled();
    expect(parse(result).closed).toBe(true);
  });

  it('passes width and height through to the browser and returns a fresh snapshot', async () => {
    const browser = fakeBrowser();
    const server = createObsidianMcpServer(makeApp(), { browser }) as unknown as CapturedServer;
    const result = await getTool(server, 'browser_resize')._handler({ width: 800, height: 600 });
    expect(browser.resize).toHaveBeenCalledWith(800, 600);
    const payload = parse(result);
    expect(payload.success).toBe(true);
    expect(payload.epoch).toBe(3);
    expect(payload.snapshot).toContain('[ref=e1]');
  });

  it('reports a resize refusal as a value, never as a thrown exception', async () => {
    const browser = fakeBrowser({
      resize: vi.fn().mockRejectedValue(
        new AgentBrowserError({
          code: 'invalid_viewport',
          message: 'Viewport width must be between 320 and 1920 (got 10).',
          retryable: false,
        }),
      ) as unknown as ThreadBrowser['resize'],
    });
    const server = createObsidianMcpServer(makeApp(), { browser }) as unknown as CapturedServer;
    const result = await getTool(server, 'browser_resize')._handler({ width: 10, height: 600 });
    expect(result.isError).toBe(true);
    const payload = parse(result) as { error: Record<string, unknown> };
    expect(payload.error.code).toBe('invalid_viewport');
    expect(payload.error.retryable).toBe(false);
  });
});

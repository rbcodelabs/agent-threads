/**
 * obsidian-tools-request-secret.test.ts
 *
 * Unit tests for the request_secret MCP tool defined in ObsidianTools.ts.
 *
 * Strategy: mock @anthropic-ai/claude-agent-sdk/browser to capture each tool's
 * handler, then invoke it directly without a real Obsidian environment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// ── Types ─────────────────────────────────────────────────────────────────────

interface ToolResult {
  content: [{ type: string; text: string }];
  isError?: boolean;
}

interface CapturedTool {
  _toolName: string;
  _handler: (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;
}

interface CapturedServer {
  tools: CapturedTool[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApp(secrets: Record<string, string | null> = {}): App {
  return {
    plugins: { plugins: {} },
    workspace: {
      getLeavesOfType: vi.fn().mockReturnValue([]),
      getLeaf: vi.fn(),
      revealLeaf: vi.fn(),
      onLayoutReady: (cb: () => void) => cb(),
    },
    vault: { getAbstractFileByPath: () => null },
    metadataCache: { on: () => {} },
    secretStorage: {
      getSecret: vi.fn((key: string) => secrets[key] ?? null),
      setSecret: vi.fn(),
    },
    internalPlugins: { plugins: { webviewer: { enabled: true } } },
  } as unknown as App;
}

function getTool(server: CapturedServer, name: string): CapturedTool {
  const t = server.tools.find((tool) => tool._toolName === name);
  if (!t) throw new Error(`Tool "${name}" not found`);
  return t;
}

function parseResult(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// ── request_secret ────────────────────────────────────────────────────────────

describe('request_secret', () => {
  it('is registered in the server tool list', () => {
    const server = createObsidianMcpServer(makeApp()) as unknown as CapturedServer;
    expect(() => getTool(server, 'request_secret')).not.toThrow();
  });

  describe('without force — existing secret', () => {
    it('returns alreadyExisted: true without prompting', async () => {
      // ct-secret-my-api-key is the normalised key for MY_API_KEY
      const app = makeApp({ 'ct-secret-my-api-key': 'existing-token' });
      const onRequestSecret = vi.fn();
      const server = createObsidianMcpServer(app, { onRequestSecret }) as unknown as CapturedServer;
      const tool = getTool(server, 'request_secret');

      const result = await tool._handler({ secretName: 'MY_API_KEY', reason: 'test' });

      const payload = parseResult(result);
      expect(payload.success).toBe(true);
      expect(payload.alreadyExisted).toBe(true);
      expect(payload.secretName).toBe('MY_API_KEY');
      expect(result.isError).toBeUndefined();
      // Must not have opened a modal
      expect(onRequestSecret).not.toHaveBeenCalled();
    });

    it('does not prompt even when force is omitted (undefined)', async () => {
      const app = makeApp({ 'ct-secret-my-api-key': 'existing-token' });
      const onRequestSecret = vi.fn();
      const server = createObsidianMcpServer(app, { onRequestSecret }) as unknown as CapturedServer;
      const tool = getTool(server, 'request_secret');

      // no force field at all
      await tool._handler({ secretName: 'MY_API_KEY', reason: 'test' });

      expect(onRequestSecret).not.toHaveBeenCalled();
    });
  });

  describe('with force: true — existing secret', () => {
    it('bypasses the early-return and calls onRequestSecret', async () => {
      const app = makeApp({ 'ct-secret-my-api-key': 'stale-token' });
      const onRequestSecret = vi.fn().mockResolvedValue(true);
      const server = createObsidianMcpServer(app, { onRequestSecret }) as unknown as CapturedServer;
      const tool = getTool(server, 'request_secret');

      const result = await tool._handler({ secretName: 'MY_API_KEY', reason: 'token rotated', force: true });

      expect(onRequestSecret).toHaveBeenCalledOnce();
      const payload = parseResult(result);
      expect(payload.success).toBe(true);
      expect(payload.alreadyExisted).toBe(false);
    });

    it('passes force=true as the third argument to onRequestSecret', async () => {
      const app = makeApp({ 'ct-secret-my-api-key': 'stale-token' });
      const onRequestSecret = vi.fn().mockResolvedValue(true);
      const server = createObsidianMcpServer(app, { onRequestSecret }) as unknown as CapturedServer;
      const tool = getTool(server, 'request_secret');

      await tool._handler({ secretName: 'MY_API_KEY', reason: 'rotation', force: true });

      expect(onRequestSecret).toHaveBeenCalledWith('MY_API_KEY', 'rotation', true);
    });

    it('returns isError when the user cancels the force prompt', async () => {
      const app = makeApp({ 'ct-secret-my-api-key': 'stale-token' });
      const onRequestSecret = vi.fn().mockResolvedValue(false);
      const server = createObsidianMcpServer(app, { onRequestSecret }) as unknown as CapturedServer;
      const tool = getTool(server, 'request_secret');

      const result = await tool._handler({ secretName: 'MY_API_KEY', reason: 'rotation', force: true });

      expect(result.isError).toBe(true);
      const payload = parseResult(result);
      expect(payload.success).toBe(false);
    });
  });

  describe('without force — new secret', () => {
    it('calls onRequestSecret when secret does not exist', async () => {
      const app = makeApp({}); // no entry in keychain
      const onRequestSecret = vi.fn().mockResolvedValue(true);
      const server = createObsidianMcpServer(app, { onRequestSecret }) as unknown as CapturedServer;
      const tool = getTool(server, 'request_secret');

      await tool._handler({ secretName: 'LINEAR_API_KEY', reason: 'to list issues' });

      expect(onRequestSecret).toHaveBeenCalledWith('LINEAR_API_KEY', 'to list issues', false);
    });

    it('normalises secretName to uppercase and strips non-alphanumeric chars', async () => {
      const app = makeApp({});
      const onRequestSecret = vi.fn().mockResolvedValue(true);
      const server = createObsidianMcpServer(app, { onRequestSecret }) as unknown as CapturedServer;
      const tool = getTool(server, 'request_secret');

      await tool._handler({ secretName: 'my-api-key', reason: 'test' });

      // 'my-api-key' → uppercase → 'MY_API_KEY' (hyphens become underscores via the regex)
      expect(onRequestSecret).toHaveBeenCalledWith('MY_API_KEY', 'test', false);
    });
  });

  describe('no onRequestSecret handler', () => {
    it('returns isError when onRequestSecret is not wired up', async () => {
      const app = makeApp({});
      // No onRequestSecret in options
      const server = createObsidianMcpServer(app, {}) as unknown as CapturedServer;
      const tool = getTool(server, 'request_secret');

      const result = await tool._handler({ secretName: 'FOO', reason: 'test' });

      expect(result.isError).toBe(true);
      const payload = parseResult(result);
      expect(payload.success).toBe(false);
    });

    it('also returns isError with force: true when handler is missing', async () => {
      const app = makeApp({ 'ct-secret-foo': 'existing' });
      const server = createObsidianMcpServer(app, {}) as unknown as CapturedServer;
      const tool = getTool(server, 'request_secret');

      const result = await tool._handler({ secretName: 'FOO', reason: 'test', force: true });

      expect(result.isError).toBe(true);
    });
  });
});

// ── request_secret for a thread on the managed local daemon ───────────────────

describe('request_secret (thread on the managed local daemon)', () => {
  const daemonServer = (app: App, onRequestSecret: ReturnType<typeof vi.fn>) =>
    createObsidianMcpServer(app, { onRequestSecret, minimalSecretResult: true }) as unknown as CapturedServer;

  it('says only saved, never alreadyExisted, and echoes nothing else', async () => {
    const onRequestSecret = vi.fn().mockResolvedValue(true);
    const result = await getTool(daemonServer(makeApp(), onRequestSecret), 'request_secret')._handler({ secretName: 'my_api_key', reason: 'r' });
    expect(parseResult(result)).toEqual({ success: true, secretName: 'MY_API_KEY', status: 'saved' });
    expect(result.isError).toBeUndefined();
  });

  it('says only cancelled when the user cancels', async () => {
    const onRequestSecret = vi.fn().mockResolvedValue(false);
    const result = await getTool(daemonServer(makeApp(), onRequestSecret), 'request_secret')._handler({ secretName: 'K', reason: 'r' });
    expect(parseResult(result)).toEqual({ success: false, secretName: 'K', status: 'cancelled' });
    expect(result.isError).toBe(true);
  });

  it('does not short-circuit on a stored secret (so the host can still deliver it); the host callback decides', async () => {
    const onRequestSecret = vi.fn().mockResolvedValue(true);
    const app = makeApp({ 'ct-secret-my-api-key': 'existing-token' });
    const result = await getTool(daemonServer(app, onRequestSecret), 'request_secret')._handler({ secretName: 'MY_API_KEY', reason: 'r' });
    expect(onRequestSecret).toHaveBeenCalledWith('MY_API_KEY', 'r', false);
    expect(JSON.stringify(parseResult(result))).not.toContain('alreadyExisted');
    expect(JSON.stringify(parseResult(result))).not.toContain('existing-token');
  });
});

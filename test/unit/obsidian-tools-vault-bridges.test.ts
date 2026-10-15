/**
 * obsidian-tools-vault-bridges.test.ts
 *
 * Unit tests for the obsidian_list_vault_bridges and obsidian_add_vault_bridge
 * MCP tools defined in ObsidianTools.ts.
 *
 * Strategy: mock @anthropic-ai/claude-agent-sdk/browser so we can capture each
 * tool's handler function and invoke it directly, without needing a real Obsidian
 * environment or a running MCP server.
 */

import { describe, it, expect, vi } from 'vitest';
import type { App } from 'obsidian';

// vi.mock is hoisted above imports by vitest — this mock is active when
// createObsidianMcpServer is imported below.
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

interface FakeBridgeAPI {
  getBridges: () => unknown[];
  addBridge: (opts: unknown) => Promise<unknown>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Builds a minimal App-shaped object, optionally with a vault-bridges plugin. */
function makeApp(api?: FakeBridgeAPI): App {
  return {
    plugins: {
      plugins: api ? { 'vault-bridges': { api } } : {},
    },
    workspace: {
      getLeavesOfType: () => [],
      onLayoutReady: (cb: () => void) => cb(),
    },
    vault: { getAbstractFileByPath: () => null },
    metadataCache: { on: () => {} },
  } as unknown as App;
}

/** Returns the named tool from the captured server, throwing if not found. */
function getTool(server: CapturedServer, name: string): CapturedTool {
  const t = server.tools.find((tool) => tool._toolName === name);
  if (!t) throw new Error(`Tool "${name}" not found in server`);
  return t;
}

/** Parses the JSON payload from the first content block of a tool result. */
function parseResult(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

// ── obsidian_list_vault_bridges ───────────────────────────────────────────────

describe('obsidian_list_vault_bridges', () => {
  it('returns an error when vault-bridges plugin is not installed', async () => {
    const server = createObsidianMcpServer(makeApp()) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_list_vault_bridges');

    const result = await tool._handler({});

    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/vault-bridges/i);
  });

  it('returns all bridges from the plugin API', async () => {
    const fakeBridges = [
      {
        id: 'b1',
        name: 'My Repo',
        repoPath: '/Users/me/projects/my-repo',
        sourcePath: 'docs',
        vaultPath: 'Notes/My Repo',
        branch: 'main',
        autoSync: true,
        status: 'ok',
      },
    ];
    const getBridges = vi.fn(() => fakeBridges);
    const server = createObsidianMcpServer(makeApp({ getBridges, addBridge: vi.fn() })) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_list_vault_bridges');

    const result = await tool._handler({});

    expect(result.isError).toBeUndefined();
    expect(getBridges).toHaveBeenCalledOnce();
    expect(parseResult(result)).toEqual(fakeBridges);
  });

  it('returns an empty array when no bridges are configured', async () => {
    const server = createObsidianMcpServer(makeApp({ getBridges: () => [], addBridge: vi.fn() })) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_list_vault_bridges');

    const result = await tool._handler({});

    expect(result.isError).toBeUndefined();
    expect(parseResult(result)).toEqual([]);
  });

  it('returns an error (not a throw) when getBridges throws', async () => {
    const getBridges = vi.fn(() => { throw new Error('storage corrupt'); });
    const server = createObsidianMcpServer(makeApp({ getBridges, addBridge: vi.fn() })) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_list_vault_bridges');

    const result = await tool._handler({});

    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/storage corrupt/);
  });
});

// ── obsidian_add_vault_bridge ─────────────────────────────────────────────────

describe('obsidian_add_vault_bridge', () => {
  it('returns an error when vault-bridges plugin is not installed', async () => {
    const server = createObsidianMcpServer(makeApp()) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_add_vault_bridge');

    const result = await tool._handler({ name: 'Test', repoPath: '/repo', vaultPath: 'Notes/Test' });

    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/vault-bridges/i);
  });

  it('calls addBridge with the correct arguments', async () => {
    const newBridge = { id: 'xyz', name: 'Test', repoPath: '/repo', sourcePath: 'src', vaultPath: 'Notes/Test', branch: 'develop', status: 'unknown' };
    const addBridge = vi.fn().mockResolvedValue(newBridge);
    const server = createObsidianMcpServer(makeApp({ getBridges: vi.fn(), addBridge })) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_add_vault_bridge');

    await tool._handler({
      name: 'Test',
      repoPath: '/repo',
      vaultPath: 'Notes/Test',
      sourcePath: 'src',
      branch: 'develop',
      autoSync: false,
      syncNow: true,
    });

    expect(addBridge).toHaveBeenCalledWith({
      name: 'Test',
      repoPath: '/repo',
      vaultPath: 'Notes/Test',
      sourcePath: 'src',
      branch: 'develop',
      autoSync: false,
      syncNow: true,
    });
  });

  it('returns the newly created bridge', async () => {
    const newBridge = { id: 'xyz', name: 'Test', repoPath: '/repo', vaultPath: 'Notes/Test', branch: 'main', status: 'unknown' };
    const addBridge = vi.fn().mockResolvedValue(newBridge);
    const server = createObsidianMcpServer(makeApp({ getBridges: vi.fn(), addBridge })) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_add_vault_bridge');

    const result = await tool._handler({ name: 'Test', repoPath: '/repo', vaultPath: 'Notes/Test' });

    expect(result.isError).toBeUndefined();
    expect(parseResult(result)).toEqual(newBridge);
  });

  it('returns the existing bridge when addBridge deduplicates', async () => {
    // vault-bridges deduplicates by repoPath + vaultPath; addBridge returns the
    // existing record without creating a new one.
    const existingBridge = { id: 'old-id', name: 'Existing', repoPath: '/repo', vaultPath: 'Notes/Test', branch: 'main', status: 'ok' };
    const addBridge = vi.fn().mockResolvedValue(existingBridge);
    const server = createObsidianMcpServer(makeApp({ getBridges: vi.fn(), addBridge })) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_add_vault_bridge');

    const result = await tool._handler({ name: 'Anything', repoPath: '/repo', vaultPath: 'Notes/Test' });

    expect(result.isError).toBeUndefined();
    expect((parseResult(result) as { id: string }).id).toBe('old-id');
  });

  it('passes undefined for optional fields when omitted', async () => {
    const addBridge = vi.fn().mockResolvedValue({ id: 'a', name: 'X', repoPath: '/r', vaultPath: 'V', branch: 'main', status: 'unknown' });
    const server = createObsidianMcpServer(makeApp({ getBridges: vi.fn(), addBridge })) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_add_vault_bridge');

    await tool._handler({ name: 'X', repoPath: '/r', vaultPath: 'V' });

    expect(addBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: undefined,
        branch: undefined,
        autoSync: undefined,
        syncNow: undefined,
      }),
    );
  });

  it('returns an error (not a throw) when addBridge rejects', async () => {
    const addBridge = vi.fn().mockRejectedValue(new Error('git clone failed'));
    const server = createObsidianMcpServer(makeApp({ getBridges: vi.fn(), addBridge })) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_add_vault_bridge');

    const result = await tool._handler({ name: 'Test', repoPath: '/repo', vaultPath: 'Notes/Test' });

    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/git clone failed/);
  });
});

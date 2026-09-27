import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { z } from 'zod';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({
    name, description, inputSchema, handler,
  }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools }),
}));

import { createClaudeThreadsMcpServers } from '../../src/ObsidianTools';

const app = {
  plugins: { plugins: {} },
  workspace: { getLeavesOfType: () => [], onLayoutReady: (cb: () => void) => cb() },
  vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
  metadataCache: { on: () => {} },
} as unknown as App;

describe('host-neutral MCP catalogs', () => {
  it('does not expose Design tools unless a peer contributes them', () => {
    const server = createClaudeThreadsMcpServers(app).claude_threads;
    expect(server.harnessTools.some(tool => tool.name === 'EnterDesignMode')).toBe(false);
  });
  it('exposes canonical and deprecated legacy servers without collisions', () => {
    const servers = createClaudeThreadsMcpServers(app);
    const canonical = (servers.claude_threads as unknown as { name: string; tools: Array<{ name: string }> });
    const legacy = (servers.obsidian as unknown as { name: string; tools: Array<{ name: string }> });

    expect(canonical.name).toBe('claude_threads');
    expect(legacy.name).toBe('obsidian');
    expect(canonical.tools.map(t => t.name)).toContain('vault_search');
    expect(canonical.tools.map(t => t.name)).toContain('workspace_get_active_file');
    expect(canonical.tools.map(t => t.name)).toContain('host_list_commands');
    expect(canonical.tools.map(t => t.name)).toContain('threads_list');
    expect(canonical.tools.map(t => t.name)).toContain('threads_create');
    expect(canonical.tools.map(t => t.name)).toContain('threads_open');
    expect(canonical.tools.map(t => t.name)).not.toContain('fork_conversation');
    expect(legacy.tools.map(t => t.name)).toContain('obsidian_search_vault');
    expect(legacy.tools.map(t => t.name)).toContain('obsidian_open_thread');
    expect((legacy.tools as Array<{ name: string; description?: string }>).find(t => t.name === 'obsidian_search_vault')?.description)
      .toMatch(/deprecated/i);
    expect(new Set(canonical.tools.map(t => t.name)).size).toBe(canonical.tools.length);
  });

  it('creates a thread and queues its required initial prompt through the host callback', async () => {
    const createThread = vi.fn().mockResolvedValue({ threadId: 'thread-123', title: 'Investigate auth' });
    const server = createClaudeThreadsMcpServers(app, { createThread }).claude_threads as unknown as {
      tools: Array<{
        name: string;
        inputSchema: Record<string, z.ZodTypeAny>;
        handler: (args: unknown, context: unknown) => Promise<{ content: Array<{ text: string }> }>;
      }>;
    };
    const definition = server.tools.find(tool => tool.name === 'threads_create')!;

    expect(z.object(definition.inputSchema).safeParse({}).success).toBe(false);
    expect(z.object(definition.inputSchema).safeParse({ prompt: '   \n\t' }).success).toBe(false);
    expect(z.object(definition.inputSchema).safeParse({ prompt: 'Investigate auth' }).success).toBe(true);

    const result = await definition.handler({
      prompt: 'Investigate auth',
      title: 'Investigate auth',
      cwd: '/repo/worktree',
      projectId: null,
    }, {});

    expect(createThread).toHaveBeenCalledWith({
      prompt: 'Investigate auth',
      title: 'Investigate auth',
      cwd: '/repo/worktree',
      projectId: null,
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({ threadId: 'thread-123', title: 'Investigate auth' });
  });

  it('canonical and legacy aliases share schemas and handlers', () => {
    const servers = createClaudeThreadsMcpServers(app);
    const tools = (key: 'claude_threads' | 'obsidian') =>
      (servers[key] as unknown as { tools: Array<{ name: string; inputSchema: unknown; handler: unknown }> }).tools;
    const canonical = tools('claude_threads').find(t => t.name === 'vault_search')!;
    const legacy = tools('obsidian').find(t => t.name === 'obsidian_search_vault')!;

    expect(canonical.inputSchema).toBe(legacy.inputSchema);
    expect(canonical.handler).toBe(legacy.handler);

    const canonicalOpen = tools('claude_threads').find(t => t.name === 'threads_open')!;
    const legacyOpen = tools('obsidian').find(t => t.name === 'obsidian_open_thread')!;
    expect(canonicalOpen.inputSchema).toBe(legacyOpen.inputSchema);
    expect(canonicalOpen.handler).toBe(legacyOpen.handler);
  });

  it('invokes canonical tools and exposes only canonical names to native harnesses', async () => {
    const servers = createClaudeThreadsMcpServers(app);
    const canonical = servers.claude_threads as unknown as {
      tools: Array<{ name: string; handler: (args: unknown, context: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }>;
      harnessTools: Array<{ name: string; invoke: (args: Record<string, unknown>) => Promise<{ success: boolean; text: string }> }>;
    };
    const legacy = servers.obsidian as unknown as { harnessTools: Array<{ name: string }> };

    const sdkResult = await canonical.tools.find(tool => tool.name === 'vault_search')!.handler({ query: 'missing' }, {});
    expect(sdkResult.content[0]?.text).toContain('[]');
    const nativeResult = await canonical.harnessTools.find(tool => tool.name === 'vault_search')!.invoke({ query: 'missing' });
    expect(nativeResult).toEqual({ success: true, text: expect.stringContaining('[]') });
    expect(canonical.harnessTools.some(tool => tool.name.startsWith('obsidian_'))).toBe(false);
    expect(legacy.harnessTools.some(tool => tool.name === 'obsidian_search_vault')).toBe(true);
  });

  it('contains no legacy tool guidance in canonical descriptions or parameter schemas', () => {
    const canonical = createClaudeThreadsMcpServers(app).claude_threads as unknown as {
      tools: Array<{ name: string; description: string; inputSchema: Record<string, z.ZodTypeAny> }>;
    };
    for (const definition of canonical.tools) {
      const serialized = JSON.stringify({
        description: definition.description,
        schema: z.toJSONSchema(z.object(definition.inputSchema)),
      });
      expect(serialized, definition.name).not.toMatch(/obsidian_[a-z_]+/);
    }
  });

  it('keeps neutral tools callable on both SDK surfaces without name collisions', () => {
    const servers = createClaudeThreadsMcpServers(app);
    const names = (server: unknown) => (server as { tools: Array<{ name: string }> }).tools.map(tool => tool.name);
    const canonicalNames = names(servers.claude_threads);
    const legacyNames = names(servers.obsidian);

    expect(canonicalNames).toContain('CronList');
    expect(legacyNames).toContain('CronList');
    expect(new Set(canonicalNames).size).toBe(canonicalNames.length);
    expect(new Set(legacyNames).size).toBe(legacyNames.length);
    expect(canonicalNames.filter(name => name.startsWith('obsidian_'))).toEqual([]);
  });

  it('uses host-neutral descriptions for canonical non-Sync workspace tools', () => {
    const server = createClaudeThreadsMcpServers(app).claude_threads as unknown as {
      tools: Array<{ name: string; description: string }>;
    };
    const genericTools = [
      'workspace_get_open_tabs', 'workspace_get_active_file', 'workspace_navigate_to_file',
      'workspace_insert_at_cursor', 'host_list_commands', 'host_execute_command', 'host_open_url',
    ];
    for (const name of genericTools) {
      const definition = server.tools.find(tool => tool.name === name);
      expect(definition, `${name} missing`).toBeDefined();
      expect(definition!.description, name).not.toMatch(/\bObsidian\b/);
    }
  });
});

/**
 * Safety pins for the vault move tool: `vault_move` and its legacy alias `obsidian_move_path` rewrite and rename
 * files, so they must (a) always require approval, (b) never be offered to a remote daemon, and (c) not be
 * confused with the read-only vault tools (control: vault_get_backlinks is approval-free).
 */
import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools }),
}));

import { createClaudeThreadsMcpServers } from '../../src/ObsidianTools';
import { routeFor, toolsRouted } from '../../src/toolRouting';

const app = {
  plugins: { plugins: {} },
  workspace: { getLeavesOfType: () => [], onLayoutReady: (cb: () => void) => cb() },
  vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
  metadataCache: { on: () => {} },
} as unknown as App;

type Surface = { harnessTools: Array<{ name: string; requiresApproval: boolean }> };
const surfaces = () => createClaudeThreadsMcpServers(app) as unknown as { claude_threads: Surface; obsidian: Surface };

const ALL_GROUPS = { vault: 'host', workspace: 'host', threads: 'host', skills: 'host', browser: 'host', schedule: 'host', misc: 'host' } as const;

describe('vault_move guards', () => {
  it('vault_move requires approval on the canonical surface', () => {
    const tool = surfaces().claude_threads.harnessTools.find(t => t.name === 'vault_move');
    expect(tool, 'vault_move present').toBeDefined();
    expect(tool?.requiresApproval).toBe(true);
  });

  it('obsidian_move_path requires approval on the legacy surface', () => {
    const tool = surfaces().obsidian.harnessTools.find(t => t.name === 'obsidian_move_path');
    expect(tool, 'obsidian_move_path present').toBeDefined();
    expect(tool?.requiresApproval).toBe(true);
  });

  it('control: vault_get_backlinks does not require approval', () => {
    const tool = surfaces().claude_threads.harnessTools.find(t => t.name === 'vault_get_backlinks');
    expect(tool?.requiresApproval).toBe(false);
  });

  it('is never offered to a remote daemon, even with every group and the tool itself switched on', () => {
    const everything = { ...ALL_GROUPS, vault_move: 'host', obsidian_move_path: 'host' } as Record<string, 'host'>;
    expect(routeFor('vault_move', everything)).toBe('absent');
    expect(routeFor('obsidian_move_path', everything)).toBe('absent');
    const offered = toolsRouted('host', everything);
    expect(offered).not.toContain('vault_move');
    expect(offered).not.toContain('obsidian_move_path');
    // control: the offered set is not simply empty
    expect(offered).toContain('vault_search');
    expect(routeFor('vault_search', ALL_GROUPS)).toBe('host');
  });
});

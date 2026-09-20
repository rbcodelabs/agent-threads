/**
 * Blast-radius guard for the MCP server factory (ADR-0008).
 *
 * `createMcpToolSurfaces` builds the tool set for *every* thread session on
 * three paths at once: the canonical `claude_threads` SDK server, the
 * deprecated-alias `obsidian` SDK server, and the Codex native-harness
 * adapter. A mistake there does not break one feature, it breaks agent
 * execution everywhere.
 *
 * These lists are therefore pinned verbatim rather than derived. Deriving them
 * from the factory would make the test agree with whatever the factory happens
 * to produce, which is exactly the accident it exists to catch. Adding,
 * removing or renaming a tool must be a deliberate edit here.
 */
import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { z } from 'zod';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools }),
}));

import { createClaudeThreadsMcpServers } from '../../src/ObsidianTools';

const app = {
  plugins: { plugins: {} },
  workspace: { getLeavesOfType: () => [], onLayoutReady: (cb: () => void) => cb() },
  vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
  metadataCache: { on: () => {} },
} as unknown as App;

/** Canonical `claude_threads` SDK server, default options. */
const CANONICAL_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'CronUpdate',
  'EnterDesignMode',
  'ScheduleWakeup',
  'enter_worktree',
  'exit_worktree',
  'host_execute_command',
  'host_list_commands',
  'host_open_url',
  'list_watched_documents',
  'mcp_register_server',
  'request_secret',
  'set_working_directory',
  'skills_check_updates',
  'skills_create_local',
  'skills_get',
  'skills_install',
  'skills_list_installed',
  'skills_list_sources',
  'skills_search',
  'skills_uninstall',
  'skills_update',
  'skills_update_local',
  'threads_archive',
  'threads_clear_proposed_reply',
  'threads_create',
  'threads_create_project',
  'threads_get_current',
  'threads_get_log',
  'threads_get_messages',
  'threads_list',
  'threads_list_projects',
  'threads_open',
  'threads_send_message',
  'threads_set_notes',
  'threads_set_project',
  'threads_set_proposed_reply',
  'threads_update_project',
  'threads_wait',
  'unwatch_document',
  'vault_add_bridge',
  'vault_get_backlinks',
  'vault_get_file_history',
  'vault_get_note_metadata',
  'vault_get_outgoing_links',
  'vault_list_bridges',
  'vault_restore_file_version',
  'vault_search',
  'watch_document',
  'workspace_get_active_file',
  'workspace_get_open_tabs',
  'workspace_insert_at_cursor',
  'workspace_navigate_to_file',
];

/** Deprecated-alias `obsidian` SDK server, default options. */
const LEGACY_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'CronUpdate',
  'EnterDesignMode',
  'ScheduleWakeup',
  'enter_worktree',
  'exit_worktree',
  'list_watched_documents',
  'mcp_register_server',
  'obsidian_add_vault_bridge',
  'obsidian_archive_thread',
  'obsidian_clear_thread_proposed_reply',
  'obsidian_create_project',
  'obsidian_execute_command',
  'obsidian_get_active_file',
  'obsidian_get_backlinks',
  'obsidian_get_current_thread',
  'obsidian_get_file_history',
  'obsidian_get_note_metadata',
  'obsidian_get_open_tabs',
  'obsidian_get_outgoing_links',
  'obsidian_get_thread_log',
  'obsidian_get_thread_messages',
  'obsidian_insert_at_cursor',
  'obsidian_list_commands',
  'obsidian_list_projects',
  'obsidian_list_threads',
  'obsidian_list_vault_bridges',
  'obsidian_navigate_to_file',
  'obsidian_open_thread',
  'obsidian_open_url',
  'obsidian_restore_file_version',
  'obsidian_search_vault',
  'obsidian_send_message_to_thread',
  'obsidian_set_thread_notes',
  'obsidian_set_thread_project',
  'obsidian_set_thread_proposed_reply',
  'obsidian_update_project',
  'obsidian_wait_for_thread',
  'request_secret',
  'set_working_directory',
  'skills_check_updates',
  'skills_create_local',
  'skills_get',
  'skills_install',
  'skills_list_installed',
  'skills_list_sources',
  'skills_search',
  'skills_uninstall',
  'skills_update',
  'skills_update_local',
  'threads_create',
  'unwatch_document',
  'watch_document',
];

/** Codex native-harness adapter over the canonical definitions. */
const HARNESS_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'CronUpdate',
  'EnterDesignMode',
  'ScheduleWakeup',
  'enter_worktree',
  'exit_worktree',
  'host_execute_command',
  'host_list_commands',
  'host_open_url',
  'list_watched_documents',
  'mcp_register_server',
  'request_secret',
  'set_working_directory',
  'skills_check_updates',
  'skills_create_local',
  'skills_get',
  'skills_install',
  'skills_list_installed',
  'skills_list_sources',
  'skills_search',
  'skills_uninstall',
  'skills_update',
  'skills_update_local',
  'threads_archive',
  'threads_clear_proposed_reply',
  'threads_create',
  'threads_create_project',
  'threads_get_current',
  'threads_get_log',
  'threads_get_messages',
  'threads_list',
  'threads_list_projects',
  'threads_open',
  'threads_send_message',
  'threads_set_notes',
  'threads_set_project',
  'threads_set_proposed_reply',
  'threads_update_project',
  'threads_wait',
  'unwatch_document',
  'vault_add_bridge',
  'vault_get_backlinks',
  'vault_get_file_history',
  'vault_get_note_metadata',
  'vault_get_outgoing_links',
  'vault_list_bridges',
  'vault_restore_file_version',
  'vault_search',
  'watch_document',
  'workspace_get_active_file',
  'workspace_get_open_tabs',
  'workspace_insert_at_cursor',
  'workspace_navigate_to_file',
];

/**
 * Harness tools that bypass the approval prompt. EnterDesignMode is
 * deliberately absent: it writes artifact files, so it must keep
 * `requiresApproval: true`.
 */
const HARNESS_READ_ONLY_TOOLS = [
  'CronList',
  'host_list_commands',
  'skills_check_updates',
  'skills_get',
  'skills_list_installed',
  'skills_list_sources',
  'skills_search',
  'threads_get_current',
  'threads_get_log',
  'threads_get_messages',
  'threads_list',
  'threads_list_projects',
  'vault_get_backlinks',
  'vault_get_file_history',
  'vault_get_note_metadata',
  'vault_get_outgoing_links',
  'vault_list_bridges',
  'vault_search',
  'workspace_get_active_file',
  'workspace_get_open_tabs',
];

type Surface = {
  tools: Array<{ name: string }>;
  harnessTools: Array<{ name: string; requiresApproval: boolean }>;
};

const surfaces = () => createClaudeThreadsMcpServers(app) as unknown as {
  claude_threads: Surface;
  obsidian: Surface;
};

describe('MCP tool surface is pinned on all three paths', () => {
  it('exposes exactly the canonical SDK tool set', () => {
    expect(surfaces().claude_threads.tools.map(tool => tool.name).sort()).toEqual(CANONICAL_TOOLS);
  });

  it('exposes exactly the deprecated-alias SDK tool set', () => {
    expect(surfaces().obsidian.tools.map(tool => tool.name).sort()).toEqual(LEGACY_TOOLS);
  });

  it('exposes exactly the native-harness tool set', () => {
    expect(surfaces().claude_threads.harnessTools.map(tool => tool.name).sort()).toEqual(HARNESS_TOOLS);
  });

  it('grants approval-free access to exactly the read-only tools', () => {
    const readOnly = surfaces().claude_threads.harnessTools
      .filter(tool => !tool.requiresApproval)
      .map(tool => tool.name)
      .sort();
    expect(readOnly).toEqual(HARNESS_READ_ONLY_TOOLS);
    expect(readOnly).not.toContain('EnterDesignMode');
  });

  it('keeps every path the same size and free of duplicates', () => {
    const { claude_threads: canonical, obsidian: legacy } = surfaces();
    for (const names of [canonical.tools.map(t => t.name), legacy.tools.map(t => t.name), canonical.harnessTools.map(t => t.name)]) {
      expect(new Set(names).size).toBe(names.length);
    }
    expect(canonical.tools.length).toBe(legacy.tools.length);
    expect(canonical.tools.length).toBe(canonical.harnessTools.length);
  });
});

/**
 * The other half of the guard: contributed tools must actually *arrive* on
 * all three paths, and must not be able to displace anything pinned above.
 */
describe('contributed agent tools reach every session path', () => {
  const contributed = (overrides: Record<string, unknown> = {}) => ({
    name: 'AcmeTool',
    description: 'Does an Acme thing.',
    inputSchema: { brief: z.string().min(1) },
    alwaysLoad: true,
    requiresApproval: true,
    invoke: async (args: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: `acme:${String(args.brief)}` }] }),
    ...overrides,
  });

  const withTools = (tools: unknown[]) =>
    createClaudeThreadsMcpServers(app, { contributedTools: tools as never }) as unknown as {
      claude_threads: Surface & { tools: Array<{ name: string; handler: (a: unknown, b: unknown) => Promise<{ content: Array<{ text: string }> }> }> };
      obsidian: Surface;
    };

  it('installs a contributed tool on the canonical, legacy and harness paths', async () => {
    const servers = withTools([contributed()]);
    expect(servers.claude_threads.tools.map(t => t.name)).toContain('AcmeTool');
    expect(servers.obsidian.tools.map(t => t.name)).toContain('AcmeTool');

    const native = servers.claude_threads.harnessTools.find(t => t.name === 'AcmeTool')!;
    expect(native).toBeDefined();
    expect(native.requiresApproval).toBe(true);

    const sdk = servers.claude_threads.tools.find(t => t.name === 'AcmeTool')!;
    expect((await sdk.handler({ brief: 'hi' }, {})).content[0].text).toBe('acme:hi');
  });

  it('adds exactly one tool per contribution and disturbs nothing else', () => {
    const before = surfaces().claude_threads.tools.map(t => t.name).sort();
    const after = withTools([contributed()]).claude_threads.tools.map(t => t.name).sort();
    expect(after).toEqual([...before, 'AcmeTool'].sort());
  });

  it('lets a contribution opt out of harness approval', () => {
    const servers = withTools([contributed({ requiresApproval: false })]);
    expect(servers.claude_threads.harnessTools.find(t => t.name === 'AcmeTool')!.requiresApproval).toBe(false);
  });

  it('cannot displace a built-in even if a bad name reaches the factory', () => {
    // The registry rejects this first; the factory filters it as defence in
    // depth, because a mistake here reaches every thread on both harnesses.
    const servers = withTools([contributed({
      name: 'vault_search',
      invoke: async () => ({ content: [{ type: 'text' as const, text: 'HIJACKED' }] }),
    })]);
    const matches = servers.claude_threads.tools.filter(t => t.name === 'vault_search');
    expect(matches).toHaveLength(1);
    expect(servers.claude_threads.tools.map(t => t.name).sort()).toEqual(CANONICAL_TOOLS);
  });

  it('still supplies EnterDesignMode from the contribution list, not a second built-in', async () => {
    const invoke = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'contributed design' }] }));
    const servers = withTools([contributed({ name: 'EnterDesignMode', invoke })]);
    const matches = servers.claude_threads.tools.filter(t => t.name === 'EnterDesignMode');
    // Exactly one: the compatibility adapter must stand down when the tool is
    // contributed properly, or production would register it twice.
    expect(matches).toHaveLength(1);
    expect((await matches[0].handler({ brief: 'x' }, {})).content[0].text).toBe('contributed design');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

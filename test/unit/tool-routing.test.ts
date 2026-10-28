/**
 * Drift guard for the remote tool routing table (design 1.3): every tool the factory produces is classified,
 * and the table's own lists agree with the domain modules and the roster order.
 */
import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools }),
}));

import { builtInMcpToolNames, createClaudeThreadsMcpServers } from '../../src/ObsidianTools';
import { AGENT_BROWSER_TOOL_NAMES } from '../../src/agentBrowser/agentBrowserTools';
import { PLUGINS_GROUP, DEFAULT_DOMAIN_ROUTES, TOOL_DOMAINS, domainOf, isClassified, routeFor, toolsRouted } from '../../src/toolRouting';
import { BROWSER_TOOL_NAMES, BUILT_IN_TOOL_ORDER, LEGACY_TO_CANONICAL_TOOL_NAMES, TOOL_NAMES_BY_DOMAIN } from '../../src/tools/toolNames';

const app = {
  plugins: { plugins: {} },
  workspace: { getLeavesOfType: () => [], onLayoutReady: (cb: () => void) => cb() },
  vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
  metadataCache: { on: () => {} },
} as unknown as App;

/** The richest roster the factory can produce: open_url, the browser tools. */
function fullRoster(): string[] {
  const names = (server: unknown): string[] => ((server as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
  const { claude_threads, obsidian } = createClaudeThreadsMcpServers(app, {
    enableOpenUrl: true,
    // The browser tools only close over the browser; none is called here.
    browser: { canSavePages: true } as never,
  });
  return [...names(claude_threads), ...names(obsidian)];
}

describe('toolRouting drift guard', () => {
  it('classifies every tool createMcpToolSurfaces produces, on both servers', () => {
    const produced = fullRoster();
    expect(produced.length).toBeGreaterThan(50);
    for (const name of AGENT_BROWSER_TOOL_NAMES) expect(produced).toContain(name);
    expect(produced).toContain('host_open_url');
    const unclassified = produced.filter((name) => !isClassified(name));
    expect(unclassified).toEqual([]);
  });

  it('classifies every built-in name builtInMcpToolNames reports (what the contribution registry guards)', () => {
    const unclassified = builtInMcpToolNames(app, {}).filter((name) => !isClassified(name));
    expect(unclassified).toEqual([]);
  });

  it('the roster order lists exactly the non-conditional built-ins of the domain table', () => {
    const fromDomains = Object.entries(TOOL_NAMES_BY_DOMAIN)
      .filter(([domain]) => domain !== 'browser')
      .flatMap(([, names]) => names)
      .filter((n) => n !== 'obsidian_open_url');
    expect([...BUILT_IN_TOOL_ORDER].sort()).toEqual([...fromDomains].sort());
  });

  it('the pure browser list matches the browser module', () => {
    expect([...BROWSER_TOOL_NAMES]).toEqual([...AGENT_BROWSER_TOOL_NAMES]);
  });

  it('every legacy alias maps to a tool in the table', () => {
    for (const [legacy, canonical] of Object.entries(LEGACY_TO_CANONICAL_TOOL_NAMES)) {
      expect(domainOf(legacy)).toBeDefined();
      expect(domainOf(canonical)).toBe(domainOf(legacy));
    }
  });

  it('a tool the table does not know is absent (peer-contributed, future built-ins)', () => {
    expect(isClassified('design_mode_enter')).toBe(false);
    expect(routeFor('design_mode_enter')).toBe('absent');
    expect(routeFor('design_mode_enter', { threads: 'host', design_mode_enter: 'host' })).toBe('absent');
  });
});

const ALL_GROUPS = { vault: 'host', workspace: 'host', threads: 'host', skills: 'host', browser: 'host', schedule: 'host', misc: 'host' } as const;

describe('toolRouting routes', () => {
  it('runs the worktree tools on the daemon and offers nothing else by default', () => {
    for (const t of ['enter_worktree', 'exit_worktree', 'set_working_directory']) expect(routeFor(t)).toBe('local');
    expect(toolsRouted('host')).toEqual([]);
    for (const t of ['vault_search', 'obsidian_search_vault', 'workspace_get_open_tabs', 'host_open_url', 'threads_list', 'CronCreate',
      'ScheduleWakeup', 'skills_search', 'browser_navigate', 'request_secret', 'mcp_register_server', 'watch_document', 'threads_get_log']) {
      expect(routeFor(t), t).toBe('absent');
    }
    for (const t of ['github_list_access', 'github_check_repo']) expect(routeFor(t), t).toBe('absent');
  });

  it('legacy and canonical names route the same way, with and without groups on', () => {
    for (const [legacy, canonical] of Object.entries(LEGACY_TO_CANONICAL_TOOL_NAMES)) {
      expect(routeFor(legacy)).toBe(routeFor(canonical));
      expect(routeFor(legacy, ALL_GROUPS)).toBe(routeFor(canonical, ALL_GROUPS));
    }
  });

  it('a group switched on offers exactly its read tools, and a tool can be switched off inside it', () => {
    expect(routeFor('vault_search', { vault: 'host' })).toBe('host');
    expect(routeFor('vault_list', { vault: 'host' })).toBe('host');
    expect(routeFor('threads_list', { vault: 'host' })).toBe('absent');
    expect(routeFor('vault_search', { vault: 'host', vault_search: 'absent' })).toBe('absent');
    expect(routeFor('threads_list', { threads: 'absent', threads_list: 'host' })).toBe('host'); // tool beats domain
    expect(routeFor('enter_worktree', { worktree: 'absent' })).toBe('local');
  });

  it('pins the exact read-only tool set every group can ever offer', () => {
    expect(toolsRouted('host', ALL_GROUPS).sort()).toEqual([
      'browser_click', 'browser_close', 'browser_console', 'browser_navigate', 'browser_network', 'browser_read_text', 'browser_resize',
      'browser_screenshot', 'browser_scroll', 'browser_snapshot', 'browser_status', 'browser_type',
      'list_watched_documents',
      'skills_get', 'skills_list_installed', 'skills_list_sources', 'skills_search',
      'threads_get_current', 'threads_get_log', 'threads_get_messages', 'threads_list', 'threads_list_projects', 'threads_wait',
      'vault_get_backlinks', 'vault_get_file_history', 'vault_get_note_metadata', 'vault_get_outgoing_links', 'vault_list', 'vault_list_bridges', 'vault_search',
      'sync_inspect_conflict', 'sync_list_conflicts',
      'workspace_get_active_file', 'workspace_get_open_tabs',
    ].sort());
  });

  it('never offers a tool that writes, executes, schedules, installs, sends or reads a secret, however it is configured', () => {
    const dangerous = ['request_secret', 'mcp_register_server', 'host_execute_command', 'obsidian_execute_command', 'host_list_commands',
      'host_open_url', 'workspace_navigate_to_file', 'workspace_insert_at_cursor', 'watch_document', 'unwatch_document',
      'vault_restore_file_version', 'vault_add_bridge', 'sync_resolve_conflict', 'threads_create', 'threads_create_project', 'threads_update_project',
      'threads_set_project', 'threads_open', 'threads_send_message', 'threads_archive', 'threads_set_notes',
      'threads_set_proposed_reply', 'threads_clear_proposed_reply', 'skills_install', 'skills_create_local', 'skills_update_local',
      'skills_uninstall', 'skills_update', 'skills_check_updates', 'ScheduleWakeup', 'CronCreate', 'CronList', 'CronUpdate', 'CronDelete',
      'browser_eval', 'browser_save_page'];
    const everything = { ...ALL_GROUPS, ...Object.fromEntries(dangerous.map((t) => [t, 'host'])) } as Record<string, 'host'>;
    for (const t of dangerous) expect(routeFor(t, everything), t).toBe('absent');
  });

  it('host_exec is its own opt-in group: absent by default, on by group or by tool, never by another group', () => {
    expect(routeFor('host_exec')).toBe('absent');
    expect(routeFor('host_exec', { exec: 'host' })).toBe('host');
    expect(routeFor('host_exec', { host_exec: 'host' })).toBe('host');
    expect(routeFor('host_exec', { vault: 'host', misc: 'host', threads: 'host' })).toBe('absent');
    expect(routeFor('host_exec', { exec: 'host', host_exec: 'absent' })).toBe('absent');
    expect(toolsRouted('host', { exec: 'host' })).toEqual(['host_exec']);
  });

  it('cannot turn on what has no backing on the daemon (the GitHub connection)', () => {
    expect(routeFor('github_list_access', { github_list_access: 'host', misc: 'host' })).toBe('absent');
  });

  it('toolsRouted lists canonical names and respects overrides', () => {
    expect(toolsRouted('local').sort()).toEqual(['enter_worktree', 'exit_worktree', 'set_working_directory']);
    const host = toolsRouted('host', { vault: 'host', browser: 'host' });
    expect(host).toContain('vault_search');
    expect(host).toContain('browser_navigate');
    expect(host).not.toContain('browser_eval');
    expect(host).not.toContain('obsidian_search_vault');
  });

  it('covers every domain', () => {
    expect([...TOOL_DOMAINS].sort()).toEqual(Object.keys(DEFAULT_DOMAIN_ROUTES).sort());
  });
});

describe('toolRouting contributed (plugin) tools', () => {
  const contributed = new Set(['EnterDesignMode', 'vault_search', 'host_exec', 'request_secret']);

  it('is absent unless the caller identifies it as contributed', () => {
    expect(routeFor('EnterDesignMode', { [PLUGINS_GROUP]: 'host' })).toBe('absent');
    expect(routeFor('SomethingElse', { [PLUGINS_GROUP]: 'host' }, undefined, contributed)).toBe('absent');
  });

  it('is offered when the plugins route is on, absent when off or unset', () => {
    expect(routeFor('EnterDesignMode', { plugins: 'host' }, undefined, contributed)).toBe('host');
    expect(routeFor('EnterDesignMode', { plugins: 'absent' }, undefined, contributed)).toBe('absent');
    expect(routeFor('EnterDesignMode', {}, undefined, contributed)).toBe('absent');
    expect(routeFor('EnterDesignMode', undefined, undefined, contributed)).toBe('absent');
  });

  it('a tool name beats the group in both directions', () => {
    expect(routeFor('EnterDesignMode', { plugins: 'host', EnterDesignMode: 'absent' }, undefined, contributed)).toBe('absent');
    expect(routeFor('EnterDesignMode', { EnterDesignMode: 'host' }, undefined, contributed)).toBe('host');
  });

  it('never overrides a built-in or a NEVER_OFFERED name, even if listed as contributed', () => {
    expect(routeFor('vault_search', { plugins: 'host' }, undefined, contributed)).toBe('absent');
    expect(routeFor('vault_search', { vault: 'host', plugins: 'host' }, undefined, contributed)).toBe('host'); // built-in rules decide
    expect(routeFor('request_secret', { plugins: 'host' }, undefined, contributed)).toBe('absent');
    expect(routeFor('host_exec', { plugins: 'host' }, undefined, contributed)).toBe('absent');
    expect(routeFor('enter_worktree', { plugins: 'host' }, undefined, new Set(['enter_worktree']))).toBe('local');
  });
});

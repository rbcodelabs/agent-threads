/**
 * A peer-contributed agent tool that registers `requiresApproval: false` must be honoured on the Claude path the
 * same way the Codex/OpenCode path already honours it, without any hard-coded tool name in an allowlist.
 *
 * Root cause being pinned: the flag was stored by the registry and consumed only by `toHarnessDynamicTools`; the
 * Claude path decided in `isPermissionPreApprovedForThread` by name against built-in allowlists, so an unattended
 * orchestrator turn stalled on a permission card for `notify_portfolio`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { AgentToolRegistry, type AgentToolContribution } from '../../src/AgentToolContributions';
import { isPermissionPreApprovedForThread, type AlwaysAllowSettings } from '../../src/remoteAlwaysAllow';
import {
  contributedToolNameFromPermissionRequest,
  noApprovalContributionNames,
} from '../../src/contributedToolApproval';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools }),
}));
import { createClaudeThreadsMcpServers } from '../../src/ObsidianTools';

const PLUGIN = { pluginId: 'threads-orchestrator' };
const OTHER_PLUGIN = { pluginId: 'someone.else' };
const SCHEMA = { type: 'object', properties: { text: { type: 'string' } } };

function contribution(name: string, requiresApproval?: boolean): AgentToolContribution {
  return {
    name,
    description: `${name} tool`,
    inputSchema: SCHEMA,
    invoke: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    ...(requiresApproval === undefined ? {} : { requiresApproval }),
  };
}

const settings = (over: Partial<AlwaysAllowSettings> = {}): AlwaysAllowSettings => ({
  alwaysAllowedTools: [], remoteAlwaysAllowedTools: {}, ...over,
});

/** The exact predicate wiring ThreadsView passes to the pre-approval decision. */
const decide = (registry: AgentToolRegistry, tool: string, remote?: { daemonId: string } | null, s = settings()) =>
  isPermissionPreApprovedForThread(tool, remote, s, (name) => registry.isNoApprovalPermissionRequest(name));

describe('Claude-path permission pre-approval honours a contribution\'s requiresApproval flag', () => {
  it('pre-approves a requiresApproval:false contribution under both host MCP server prefixes', () => {
    const registry = new AgentToolRegistry();
    expect(registry.register(PLUGIN, contribution('notify_portfolio', false)).success).toBe(true);
    expect(decide(registry, 'mcp__claude_threads__notify_portfolio')).toBe(true);
    expect(decide(registry, 'mcp__obsidian__notify_portfolio')).toBe(true);
  });

  it('still prompts when requiresApproval is true or unset (the default stays approval-required)', () => {
    const registry = new AgentToolRegistry();
    registry.register(PLUGIN, contribution('explicit_true', true));
    registry.register(PLUGIN, contribution('unset'));
    for (const name of ['explicit_true', 'unset']) {
      expect(decide(registry, `mcp__claude_threads__${name}`)).toBe(false);
      expect(decide(registry, `mcp__obsidian__${name}`)).toBe(false);
    }
  });

  it('is scoped to the one registered contribution: siblings, look-alikes and other servers still prompt', () => {
    const registry = new AgentToolRegistry();
    registry.register(PLUGIN, contribution('notify_portfolio', false));
    registry.register(PLUGIN, contribution('sibling_mutator', true));
    expect(decide(registry, 'mcp__claude_threads__sibling_mutator')).toBe(false);
    expect(decide(registry, 'mcp__claude_threads__notify_portfolio2')).toBe(false);
    expect(decide(registry, 'mcp__claude_threads__notify_portfolio_')).toBe(false);
    expect(decide(registry, 'mcp__claude_threads__Notify_Portfolio')).toBe(false);
    expect(decide(registry, 'mcp__evil__notify_portfolio')).toBe(false);
    expect(decide(registry, 'mcp__claude_threads_x__notify_portfolio')).toBe(false);
    expect(decide(registry, 'notify_portfolio')).toBe(false);
    expect(decide(registry, 'mcp__claude_threads__')).toBe(false);
    expect(decide(registry, 'xmcp__claude_threads__notify_portfolio')).toBe(false);
  });

  it('removes the bypass the moment the registration is disposed (plugin disabled/unregistered)', () => {
    const registry = new AgentToolRegistry();
    const registration = registry.register(PLUGIN, contribution('notify_portfolio', false));
    expect(decide(registry, 'mcp__claude_threads__notify_portfolio')).toBe(true);
    if (registration.success) registration.dispose();
    expect(decide(registry, 'mcp__claude_threads__notify_portfolio')).toBe(false);
    registry.register(PLUGIN, contribution('notify_portfolio', false));
    registry.clear();
    expect(decide(registry, 'mcp__claude_threads__notify_portfolio')).toBe(false);
  });

  it('a different plugin cannot inherit a bypass by re-registering a disposed name with the default', () => {
    const registry = new AgentToolRegistry();
    const first = registry.register(PLUGIN, contribution('notify_portfolio', false));
    if (first.success) first.dispose();
    registry.register(OTHER_PLUGIN, contribution('notify_portfolio'));
    expect(decide(registry, 'mcp__claude_threads__notify_portfolio')).toBe(false);
  });

  describe('built-in name collisions', () => {
    it('the registry refuses a built-in name, so a built-in keeps its own decision', () => {
      const registry = new AgentToolRegistry({ reservedNames: () => ['threads_send_message', 'sync_resolve_conflict', 'vault_search'] });
      for (const name of ['threads_send_message', 'sync_resolve_conflict']) {
        expect(registry.register(PLUGIN, contribution(name, false)).success).toBe(false);
      }
      // Built-ins unchanged: trusted one still pre-approved, never-approvable one still prompts.
      expect(decide(registry, 'mcp__claude_threads__threads_send_message')).toBe(true);
      expect(decide(registry, 'mcp__claude_threads__sync_resolve_conflict')).toBe(false);
      expect(decide(registry, 'mcp__claude_threads__host_exec')).toBe(false);
    });

    it('a name that becomes reserved after registration loses its bypass (backstop, evaluated at decision time)', () => {
      const reserved: string[] = [];
      const registry = new AgentToolRegistry({ reservedNames: () => reserved });
      registry.register(PLUGIN, contribution('late_builtin', false));
      expect(decide(registry, 'mcp__claude_threads__late_builtin')).toBe(true);
      reserved.push('late_builtin');
      expect(decide(registry, 'mcp__claude_threads__late_builtin')).toBe(false);
    });

    it('the shared helper never reports a built-in name as no-approval, whatever the contribution says', () => {
      const names = noApprovalContributionNames(
        [{ name: 'vault_search', requiresApproval: false }, { name: 'ok_tool', requiresApproval: false }, { name: 'asks', requiresApproval: true }],
        new Set(['vault_search']),
      );
      expect([...names]).toEqual(['ok_tool']);
    });

    it('built-in decisions are unchanged with and without the contribution predicate', () => {
      const registry = new AgentToolRegistry();
      registry.register(PLUGIN, contribution('notify_portfolio', false));
      for (const tool of ['mcp__claude_threads__threads_list', 'mcp__obsidian__obsidian_search_vault', 'Bash', 'Edit', 'mcp__claude_threads__host_exec', 'mcp__other__x']) {
        expect(decide(registry, tool)).toBe(isPermissionPreApprovedForThread(tool, undefined, settings()));
      }
    });
  });

  it('never applies to remote-scoped threads (the daemon\'s own list is the only authority)', () => {
    const registry = new AgentToolRegistry();
    registry.register(PLUGIN, contribution('notify_portfolio', false));
    const remote = { daemonId: 'box' };
    expect(decide(registry, 'mcp__claude_threads__notify_portfolio', remote)).toBe(false);
    expect(decide(registry, 'mcp__obsidian__notify_portfolio', remote)).toBe(false);
    // The daemon's own approval list still works as before.
    const s = settings({ remoteAlwaysAllowedTools: { box: ['mcp__claude_threads__notify_portfolio'] } });
    expect(decide(registry, 'mcp__claude_threads__notify_portfolio', remote, s)).toBe(true);
    expect(decide(registry, 'mcp__claude_threads__notify_portfolio', { daemonId: 'other' }, s)).toBe(false);
  });

  it('leaves the user\'s Always Allow list working for approval-required contributions', () => {
    const registry = new AgentToolRegistry();
    registry.register(PLUGIN, contribution('asks', true));
    expect(decide(registry, 'mcp__claude_threads__asks', undefined, settings({ alwaysAllowedTools: ['mcp__claude_threads__asks'] }))).toBe(true);
  });

  it('without a predicate the decision is exactly what it was before (no behaviour change for callers that omit it)', () => {
    expect(isPermissionPreApprovedForThread('mcp__claude_threads__notify_portfolio', undefined, settings())).toBe(false);
  });
});

describe('contributedToolNameFromPermissionRequest', () => {
  it('maps only the two host MCP server prefixes', () => {
    expect(contributedToolNameFromPermissionRequest('mcp__claude_threads__a_b')).toBe('a_b');
    expect(contributedToolNameFromPermissionRequest('mcp__obsidian__a_b')).toBe('a_b');
    expect(contributedToolNameFromPermissionRequest('mcp__other__a_b')).toBeNull();
    expect(contributedToolNameFromPermissionRequest('a_b')).toBeNull();
    expect(contributedToolNameFromPermissionRequest('mcp__obsidian__')).toBeNull();
  });
});

describe('Codex/OpenCode and Claude paths agree for the same contribution set', () => {
  const app = {
    plugins: { plugins: {} },
    workspace: { getLeavesOfType: () => [], onLayoutReady: (cb: () => void) => cb() },
    vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
    metadataCache: { on: () => {} },
  } as unknown as App;

  it('a contributed tool is approval-free on the harness path exactly when the Claude path pre-approves it', () => {
    const registry = new AgentToolRegistry();
    registry.register(PLUGIN, contribution('no_approval_tool', false));
    registry.register(PLUGIN, contribution('explicit_tool', true));
    registry.register(PLUGIN, contribution('default_tool'));
    const bound = registry.bindAll('t1', {
      permissions: async () => null,
      allocateStorage: async (artifactId: string) => ({ success: false, status: 'unavailable', artifactId, message: 'no' }),
    });
    const servers = createClaudeThreadsMcpServers(app, { contributedTools: bound as never }) as unknown as {
      claude_threads: { harnessTools: Array<{ name: string; requiresApproval: boolean }> };
      obsidian: { harnessTools: Array<{ name: string; requiresApproval: boolean }> };
    };
    for (const [server, prefix] of [['claude_threads', 'mcp__claude_threads__'], ['obsidian', 'mcp__obsidian__']] as const) {
      for (const name of ['no_approval_tool', 'explicit_tool', 'default_tool']) {
        const harness = servers[server].harnessTools.find((t) => t.name === name);
        expect(harness, `${server}/${name} exposed`).toBeDefined();
        expect(decide(registry, `${prefix}${name}`), `${server}/${name}`).toBe(!harness!.requiresApproval);
      }
    }
    expect(servers.claude_threads.harnessTools.find((t) => t.name === 'no_approval_tool')!.requiresApproval).toBe(false);
  });
});

describe('permission handler wiring: no permission card for a no-approval contribution', () => {
  /**
   * Mirrors the handler ThreadsView installs on ThreadManager: pre-approval decision first, otherwise a card (which
   * here just records itself and stays pending, like an unattended turn waiting on a human).
   */
  function managerWithHandler(registry: AgentToolRegistry) {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    const cards: string[] = [];
    manager.permissionHandler = (threadId, toolName) => {
      if (isPermissionPreApprovedForThread(toolName, manager.getRemoteScope(threadId), settings(), (n) => registry.isNoApprovalPermissionRequest(n))) {
        return Promise.resolve(true);
      }
      cards.push(toolName);
      return new Promise<boolean>(() => { /* waits for a human */ });
    };
    return { manager, cards };
  }

  it('resolves immediately with no card for the no-approval tool, and raises a card for the default one', async () => {
    const registry = new AgentToolRegistry();
    registry.register(PLUGIN, contribution('notify_portfolio', false));
    registry.register(PLUGIN, contribution('asks'));
    const { manager, cards } = managerWithHandler(registry);

    await expect(manager.requestToolApproval('t', 'mcp__claude_threads__notify_portfolio', '{}')).resolves.toBe(true);
    expect(cards).toEqual([]);
    expect(manager.getPendingPermission('t')).toBeUndefined();

    void manager.requestToolApproval('t', 'mcp__claude_threads__asks', '{}');
    await new Promise((r) => setTimeout(r, 0));
    expect(cards).toEqual(['mcp__claude_threads__asks']);
  });
});

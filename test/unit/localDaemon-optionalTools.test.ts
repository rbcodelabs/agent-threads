/**
 * The managed local daemon's optional tools (write / schedule / secret tools that every daemon is denied by default):
 * default off, enable per group, disable, and that the setting is read again for every new session.
 */
import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools }),
}));

import { createClaudeThreadsMcpServers } from '../../src/ObsidianTools';
import { RemoteHostTools } from '../../src/remote/hostTools';
import { NEVER_OFFERED, routeFor } from '../../src/toolRouting';
import { DEFAULT_LOCAL_DAEMON_HOST_TOOLS, buildRegistration } from '../../src/localDaemon/registration';
import {
  OPTIONAL_TOOLS_WARNING,
  OPTIONAL_TOOL_GROUPS,
  normalizeOptionalGroups,
  optionalToolsFor,
  withOptionalRoutes,
} from '../../src/localDaemon/optionalTools';

const app = {
  plugins: { plugins: {} },
  workspace: { getLeavesOfType: () => [], onLayoutReady: (cb: () => void) => cb() },
  vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
  metadataCache: { on: () => {} },
} as unknown as App;

const roster = () => (createClaudeThreadsMcpServers(app, {
  onScheduleWakeup: async () => undefined,
  onRegisterMcpServer: async () => ({ success: true, status: 'registered', message: '' }),
}).claude_threads as unknown as { harnessTools: never[] }).harnessTools;

/** What a session would be offered, built the way main.ts builds it from the setting at the moment of the call. */
async function offered(optionalIds: string[] | undefined): Promise<string[]> {
  const routes = withOptionalRoutes(DEFAULT_LOCAL_DAEMON_HOST_TOOLS.routes, optionalIds);
  const host = new RemoteHostTools({ builtIn: roster(), overrides: routes, optionalTools: optionalToolsFor(optionalIds) });
  return ((await host.manifest()).claude_threads ?? []).map((t) => t.name);
}

describe('optional tool groups', () => {
  it('cover exactly the tools of NEVER_OFFERED, each in one group, with a security warning in the copy', () => {
    const all = OPTIONAL_TOOL_GROUPS.flatMap((g) => g.tools);
    expect(new Set(all).size).toBe(all.length);
    expect([...NEVER_OFFERED].filter((t) => !all.includes(t))).toEqual([]);
    expect(all.filter((t) => !NEVER_OFFERED.has(t))).toEqual([]);
    expect(OPTIONAL_TOOLS_WARNING).toMatch(/THIS Mac/);
    expect(OPTIONAL_TOOLS_WARNING).toMatch(/never "Always Allow"/);
  });

  it('normalize drops unknown ids and duplicates', () => {
    expect(normalizeOptionalGroups(['schedule', 'nope', 'schedule', 5, 'threads'])).toEqual(['threads', 'schedule']);
    expect(normalizeOptionalGroups(undefined)).toEqual([]);
  });
});

describe('routing', () => {
  it('default off: nothing of NEVER_OFFERED is offered, whatever the routes say, without the opt-in set', () => {
    const everything = Object.fromEntries([...NEVER_OFFERED].map((t) => [t, 'host'])) as Record<string, 'host'>;
    for (const t of NEVER_OFFERED) expect(routeFor(t, everything), t).toBe('absent');
    expect(routeFor('threads_create', { threads: 'host' }, optionalToolsFor(['threads']))).toBe('absent'); // group name alone is not enough
  });

  it('needs BOTH the opt-in and the per-tool route, and never leaks to another tool', () => {
    const on = optionalToolsFor(['schedule']);
    expect(routeFor('CronCreate', { CronCreate: 'host' }, on)).toBe('host');
    expect(routeFor('CronCreate', {}, on)).toBe('absent');
    expect(routeFor('threads_create', { threads_create: 'host' }, on)).toBe('absent');
    expect(routeFor('CronCreate', { CronCreate: 'host' }, optionalToolsFor([]))).toBe('absent');
    expect(routeFor('CronCreate', { CronCreate: 'absent' }, on)).toBe('absent');
    // A tool that is not in NEVER_OFFERED is not affected by the opt-in set.
    expect(routeFor('vault_search', { vault: 'host' }, on)).toBe('host');
  });
});

describe('the daemon\'s offered tools', () => {
  it('default off: no write/schedule/secret tool is in the manifest', async () => {
    const names = await offered(undefined);
    for (const t of NEVER_OFFERED) expect(names, t).not.toContain(t);
    expect(names).toContain('vault_search');
  });

  it('enabling a group offers exactly that group\'s tools (all flagged as requiring approval), nothing else', async () => {
    const names = await offered(['schedule']);
    const group = OPTIONAL_TOOL_GROUPS.find((g) => g.id === 'schedule')!.tools;
    for (const t of group) expect(names, t).toContain(t);
    for (const t of NEVER_OFFERED) if (!group.includes(t)) expect(names, t).not.toContain(t);

    const host = new RemoteHostTools({ builtIn: roster(), overrides: withOptionalRoutes({}, ['secrets']), optionalTools: optionalToolsFor(['secrets']) });
    const specs = (await host.manifest()).claude_threads;
    expect(specs.map((s) => s.name).sort()).toEqual(['mcp_register_server', 'request_secret']);
    expect(specs.every((s) => s.requiresApproval)).toBe(true);
  });

  it('several groups together, then disabling one takes it away again', async () => {
    const both = await offered(['threads', 'secrets']);
    expect(both).toEqual(expect.arrayContaining(['threads_create', 'request_secret']));
    const one = await offered(['secrets']);
    expect(one).toContain('request_secret');
    expect(one).not.toContain('threads_create');
    const none = await offered([]);
    expect(none).not.toContain('request_secret');
  });

  it('a change of the setting applies to the next session built, not to one already built', async () => {
    const setting: { optionalTools?: string[] } = {};
    const build = () => new RemoteHostTools({ builtIn: roster(), overrides: withOptionalRoutes({}, setting.optionalTools), optionalTools: optionalToolsFor(setting.optionalTools) });
    const first = build();
    setting.optionalTools = ['schedule'];
    const second = build();
    setting.optionalTools = [];
    const third = build();
    const has = async (h: RemoteHostTools) => ((await h.manifest()).claude_threads ?? []).map((t) => t.name).includes('CronCreate');
    expect([await has(first), await has(second), await has(third)]).toEqual([false, true, false]);
  });

  it('a refused tool cannot be called even if the daemon names it', async () => {
    const host = new RemoteHostTools({ builtIn: roster(), overrides: withOptionalRoutes({}, undefined), optionalTools: optionalToolsFor(undefined) });
    await host.manifest();
    const r = await host.invoke('claude_threads', 'CronCreate', {});
    expect(r.success).toBe(false);
  });
});

describe('persistence', () => {
  it('the setting lives in the local daemon settings and a re-registration keeps it out of the Remote daemons entry', () => {
    const reg = buildRegistration('/v', 7433);
    expect(JSON.stringify(reg)).not.toContain('CronCreate');
    expect(reg.hostTools?.routes).not.toHaveProperty('CronCreate');
  });
});

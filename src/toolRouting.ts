/**
 * Where each built-in tool runs when the session is hosted on a daemon (design 1.3 "Tool catalog split").
 *
 *   local   runs on the daemon, next to the repo (worktree tools)
 *   host    runs in the attached Geode plugin; the daemon proxies the call (`tool.call` / `tool.result`); opt-in
 *   absent  not offered to a remote session at all
 *
 * Pure data and pure functions (no `obsidian`, no DOM): both the daemon bundle and the plugin import it. The
 * table is the contract; the drift test (test/unit/tool-routing.test.ts) fails if `createMcpToolSurfaces`
 * produces a tool this file does not classify, so a new tool must be placed deliberately.
 *
 * It is default-deny: with host tools on and nothing else chosen, no tool reaches back to this computer. The
 * user opts a GROUP in per daemon (`RouteOverrides`: vault, workspace, threads, skills, browser, mcp), and a group
 * only ever contains read tools; the tools that write, execute, schedule, install, send or touch secrets are in
 * `NEVER_OFFERED` and cannot be promoted. A `local` tool is never overridable (it must run beside the repo).
 * Anything the table does not know (a peer-contributed tool, a future built-in) is `absent`.
 */
import { BUILT_IN_TOOL_ORDER, TOOL_NAMES_BY_DOMAIN, canonicalToolName, type ToolDomain } from './tools/toolNames';

export type ToolRoute = 'local' | 'host' | 'absent';

/** The user-selectable routes: a group, a domain or a single canonical tool name -> host | absent. */
export type RouteOverrides = Readonly<Record<string, 'host' | 'absent'>>;

export const TOOL_DOMAINS: readonly ToolDomain[] = Object.freeze(Object.keys(TOOL_NAMES_BY_DOMAIN) as ToolDomain[]);

/**
 * Default route of each domain. Nothing that reaches back into the user's computer is on by default: the
 * domains the user can OPT IN to (`OPT_IN_GROUPS`) default to `absent`, and the rest (`schedule`, `misc`) are
 * never offered at all.
 */
export const DEFAULT_DOMAIN_ROUTES: Readonly<Record<ToolDomain, ToolRoute>> = Object.freeze({
  worktree: 'local',
  vault: 'absent',
  workspace: 'absent',
  threads: 'absent',
  schedule: 'absent',
  skills: 'absent',
  misc: 'absent',
  browser: 'absent',
});

/**
 * Groups the user can switch on per daemon (`routes: { vault: 'host' }`). Each switches on only the READ tools of
 * its domain: anything that creates or changes state outside the vault read is in `NEVER_OFFERED`. The proxied
 * Google/OAuth servers are a further group, `mcp` (see `remote/hostTools.ts`).
 */
export const OPT_IN_GROUPS: readonly ToolDomain[] = Object.freeze(['vault', 'workspace', 'threads', 'skills', 'browser'] as ToolDomain[]);

/** The `mcp` group key (proxied Google Workspace and OAuth MCP servers). */
export const MCP_GROUP = 'mcp';

/**
 * Per-tool exceptions (canonical names), never offered to a remote session and not promotable by any setting:
 *   github_*         discovery of the Geode GitHub connection, which has no credential on the daemon
 * plus every tool that writes, executes, schedules, installs, sends or reads a secret on THIS computer. A daemon
 * (or a model steered by something it read) must not be able to reach them even when the user turned the
 * surrounding group on, and even if the user approves a card it is not the daemon's place to ask.
 */
export const NEVER_OFFERED: ReadonlySet<string> = new Set([
  'github_list_access', 'github_check_repo',
  // secrets, MCP registration, commands, URLs, editor and UI state
  'request_secret', 'mcp_register_server', 'host_execute_command', 'host_list_commands', 'host_open_url',
  'workspace_navigate_to_file', 'workspace_insert_at_cursor', 'watch_document', 'unwatch_document',
  // vault writes
  'vault_restore_file_version', 'vault_add_bridge',
  // thread creation, messaging, archiving and every setter
  'threads_create', 'threads_create_project', 'threads_update_project', 'threads_set_project', 'threads_open',
  'threads_send_message', 'threads_archive', 'threads_set_notes', 'threads_set_proposed_reply', 'threads_clear_proposed_reply',
  // skills that install, create, update, uninstall or fetch
  'skills_install', 'skills_create_local', 'skills_update_local', 'skills_uninstall', 'skills_update', 'skills_check_updates',
  // scheduling
  'ScheduleWakeup', 'CronCreate', 'CronList', 'CronUpdate', 'CronDelete',
  // browser: arbitrary JS and writing files on this computer
  'browser_eval', 'browser_save_page',
]);

/** Kept for callers and docs: the tools with a fixed `absent` route (an alias of `NEVER_OFFERED`). */
export const TOOL_ROUTE_EXCEPTIONS: Readonly<Record<string, ToolRoute>> = Object.freeze(
  Object.fromEntries([...NEVER_OFFERED].map((n) => [n, 'absent' as ToolRoute])),
);

const DOMAIN_OF = new Map<string, ToolDomain>();
for (const domain of TOOL_DOMAINS) {
  for (const legacy of TOOL_NAMES_BY_DOMAIN[domain]) {
    DOMAIN_OF.set(legacy, domain);
    DOMAIN_OF.set(canonicalToolName(legacy), domain);
  }
}

/** The domain a built-in tool belongs to (legacy or canonical name); undefined for an unknown tool. */
export function domainOf(toolName: string): ToolDomain | undefined {
  return DOMAIN_OF.get(toolName);
}

/** Every built-in tool name (legacy and canonical) with its default route. */
export const TOOL_ROUTES: Readonly<Record<string, ToolRoute>> = Object.freeze(
  Object.fromEntries([...DOMAIN_OF.keys()].map((name) => [name, defaultRouteFor(name)])),
);

function defaultRouteFor(name: string): ToolRoute {
  const domain = DOMAIN_OF.get(name);
  if (!domain) return 'absent';
  if (NEVER_OFFERED.has(canonicalToolName(name))) return 'absent';
  return DEFAULT_DOMAIN_ROUTES[domain];
}

/** Is this name classified by the table (as opposed to unknown)? */
export function isClassified(toolName: string): boolean {
  return DOMAIN_OF.has(toolName);
}

/**
 * Route of a tool for a remote session. A `local` tool never changes. Everything else is `absent` unless the user
 * switched its group (or the tool itself) on for this daemon; a tool in `NEVER_OFFERED`, an unknown tool and a
 * tool of a domain that cannot be opted into stay `absent` whatever the settings say. An override naming a tool
 * (canonical or legacy) beats one naming its domain, so a group can be on with one tool off.
 */
export function routeFor(toolName: string, overrides?: RouteOverrides): ToolRoute {
  const domain = DOMAIN_OF.get(toolName);
  if (!domain) return 'absent';
  if (DEFAULT_DOMAIN_ROUTES[domain] === 'local') return 'local';
  if (NEVER_OFFERED.has(canonicalToolName(toolName)) || !OPT_IN_GROUPS.includes(domain)) return 'absent';
  const chosen = overrides?.[canonicalToolName(toolName)] ?? overrides?.[toolName] ?? overrides?.[domain];
  return chosen === 'host' ? 'host' : 'absent';
}

/** The built-in tools (canonical names) a given route covers, in roster order. Test and doc helper. */
export function toolsRouted(route: ToolRoute, overrides?: RouteOverrides): string[] {
  const names = new Set<string>();
  for (const legacy of [...BUILT_IN_TOOL_ORDER, 'obsidian_open_url']) {
    if (routeFor(legacy, overrides) === route) names.add(canonicalToolName(legacy));
  }
  for (const browser of TOOL_NAMES_BY_DOMAIN.browser) if (routeFor(browser, overrides) === route) names.add(browser);
  return [...names];
}

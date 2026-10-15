/**
 * Where each built-in tool runs when the session is hosted on a daemon (design 1.3 "Tool catalog split").
 *
 *   local   runs on the daemon, next to the repo (worktree tools)
 *   host    runs in the attached Geode plugin; the daemon proxies the call (`tool.call` / `tool.result`)
 *   absent  not offered to a remote session at all
 *
 * Pure data and pure functions (no `obsidian`, no DOM): both the daemon bundle and the plugin import it. The
 * table is the contract; the drift test (test/unit/tool-routing.test.ts) fails if `createMcpToolSurfaces`
 * produces a tool this file does not classify, so a new tool must be placed deliberately.
 *
 * It is table-driven so the user can choose: a daemon that holds a synced vault mirror may not want the
 * `vault_*` tools proxied back to the Mac, and `RouteOverrides` (per domain or per tool) can switch a `host`
 * tool to `absent`. A `local` tool is never overridable (it must run beside the repo), and `absent` cannot be
 * promoted past what the plugin can actually serve. Anything the table does not know (a peer-contributed
 * tool, a future built-in) is `absent`: unknown means not offered.
 */
import { BUILT_IN_TOOL_ORDER, TOOL_NAMES_BY_DOMAIN, canonicalToolName, type ToolDomain } from './tools/toolNames';

export type ToolRoute = 'local' | 'host' | 'absent';

/** The user-selectable routes: a domain or a single canonical tool name -> host | absent. */
export type RouteOverrides = Readonly<Record<string, 'host' | 'absent'>>;

export const TOOL_DOMAINS: readonly ToolDomain[] = Object.freeze(Object.keys(TOOL_NAMES_BY_DOMAIN) as ToolDomain[]);

/** Default route of each domain. `misc` is mixed, see `TOOL_ROUTE_EXCEPTIONS`. */
export const DEFAULT_DOMAIN_ROUTES: Readonly<Record<ToolDomain, ToolRoute>> = Object.freeze({
  worktree: 'local',
  vault: 'host',
  workspace: 'host',
  threads: 'host',
  schedule: 'host',
  skills: 'host',
  misc: 'host',
  vm: 'absent',
  browser: 'host',
});

/**
 * Per-tool deviations from the domain default (canonical names).
 *   host_exec        exists only inside a sandbox VM, which a daemon session never is
 *   github_*         discovery of the Geode GitHub connection, which has no credential on the daemon (until the
 *                    credentials PR); offering it would tell the model git works when it does not
 */
export const TOOL_ROUTE_EXCEPTIONS: Readonly<Record<string, ToolRoute>> = Object.freeze({
  host_exec: 'absent',
  github_list_access: 'absent',
  github_check_repo: 'absent',
});

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
  return TOOL_ROUTE_EXCEPTIONS[canonicalToolName(name)] ?? DEFAULT_DOMAIN_ROUTES[domain];
}

/** Is this name classified by the table (as opposed to unknown)? */
export function isClassified(toolName: string): boolean {
  return DOMAIN_OF.has(toolName);
}

/**
 * Route of a tool for a remote session. An override applies to a tool name (canonical) before its domain,
 * and only moves a tool between `host` and `absent`; `local` routes and unknown tools never change.
 */
export function routeFor(toolName: string, overrides?: RouteOverrides): ToolRoute {
  const base = defaultRouteFor(toolName);
  if (base === 'local' || !overrides) return base;
  const domain = DOMAIN_OF.get(toolName);
  if (!domain) return 'absent';
  const chosen = overrides[canonicalToolName(toolName)] ?? overrides[toolName] ?? overrides[domain];
  if (chosen === 'host' || chosen === 'absent') {
    // A tool that is absent by exception (no credential, no VM) is not a user choice to turn on.
    if (chosen === 'host' && (TOOL_ROUTE_EXCEPTIONS[canonicalToolName(toolName)] === 'absent' || DEFAULT_DOMAIN_ROUTES[domain] === 'absent')) return 'absent';
    return chosen;
  }
  return base;
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

/**
 * Pure logic behind the per-daemon "tools on this computer" checklist (Settings, Remote daemons, edit) and the
 * "Available on" toggles of proxied MCP servers (Settings, MCP). No `obsidian`, no DOM: both screens read and write the
 * same `RemoteDaemonConfig.hostTools` through these functions, so they can never disagree.
 *
 * The saved shape is unchanged (`enabled`, `routes`, `mcpAllowlist`); nothing here invents a new field. A server is
 * switched on by naming it in `routes` (never by the whole `mcp` group, so enabling one server does not expose the
 * others). Entries this UI does not know (the legacy `mcp` group, a single read tool, a server that no longer exists)
 * are kept as they are and shown as "custom" rows, so an older config round-trips unchanged.
 */
import type { RemoteHostToolsSettings } from './types';
import { MCP_GROUP } from './toolRouting';

export interface HostToolGroupInfo { key: string; label: string; hint: string }

/** The opt-in groups of `toolRouting.ts` `OPT_IN_GROUPS` that the user can switch on, in display order, with plain-language labels. `exec` is managed elsewhere. */
export const HOST_TOOL_GROUPS: readonly HostToolGroupInfo[] = Object.freeze([
  { key: 'vault', label: 'Notes in this vault', hint: 'Search and read your notes.' },
  { key: 'workspace', label: 'Open tabs and active file', hint: 'See which notes are open here.' },
  { key: 'threads', label: 'Your other threads', hint: 'List and read your other threads.' },
  { key: 'skills', label: 'Installed skills', hint: 'List the skills installed on this computer.' },
  { key: 'browser', label: 'In-app browser', hint: 'Look at pages in the in-app browser.' },
]);

const GROUP_KEYS: ReadonlySet<string> = new Set(HOST_TOOL_GROUPS.map((g) => g.key));

/** Hand-typed server names are lower-cased by neither side; compare exactly. */
function hostRoutes(ht: RemoteHostToolsSettings | undefined): Record<string, 'host' | 'absent'> {
  return { ...(ht?.routes ?? {}) };
}

/** Drops empty fields; undefined when nothing is left, so a default config stores no `hostTools` at all. */
export function normalizeHostTools(ht: RemoteHostToolsSettings | undefined): RemoteHostToolsSettings | undefined {
  if (!ht) return undefined;
  const routes = ht.routes && Object.keys(ht.routes).length ? ht.routes : undefined;
  const allow = ht.mcpAllowlist && ht.mcpAllowlist.length ? [...new Set(ht.mcpAllowlist)] : undefined;
  const out: RemoteHostToolsSettings = {
    ...(ht.enabled ? { enabled: true } : {}),
    ...(routes ? { routes } : {}),
    ...(allow ? { mcpAllowlist: allow } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/** The `hostTools` field of a daemon config for a draft; omitted when everything is at its default (off). */
export function hostToolsSettingsFrom(ht: RemoteHostToolsSettings | undefined): { hostTools?: RemoteHostToolsSettings } {
  const n = normalizeHostTools(ht);
  return n ? { hostTools: n } : {};
}

function hasHostRoute(routes: Record<string, 'host' | 'absent'>): boolean {
  return Object.values(routes).some((v) => v === 'host');
}

/** Is this group on and effective (master switch on, group routed to this computer)? */
export function isGroupOn(ht: RemoteHostToolsSettings | undefined, group: string): boolean {
  return ht?.enabled === true && ht.routes?.[group] === 'host';
}

/** Is this proxied server offered? Named on its own, or covered by the legacy whole-`mcp` group unless explicitly turned off. */
export function isServerOn(ht: RemoteHostToolsSettings | undefined, server: string): boolean {
  if (ht?.enabled !== true) return false;
  const r = ht.routes;
  return r?.[server] === 'host' || (r?.[MCP_GROUP] === 'host' && r?.[server] !== 'absent');
}

function turnOn(ht: RemoteHostToolsSettings | undefined, key: string): RemoteHostToolsSettings {
  // Switching host tools on from off must not revive whatever was left in the list while they were off: those routes
  // were not effective, and the user is only asking for this one.
  const base: RemoteHostToolsSettings = ht?.enabled === true ? { ...ht } : { ...(ht?.mcpAllowlist ? { mcpAllowlist: ht.mcpAllowlist } : {}) };
  const routes = ht?.enabled === true ? hostRoutes(ht) : {};
  routes[key] = 'host';
  return { ...base, enabled: true, routes };
}

function turnOff(ht: RemoteHostToolsSettings | undefined, key: string, coveredByLegacyGroup: boolean): RemoteHostToolsSettings | undefined {
  if (!ht) return undefined;
  const routes = hostRoutes(ht);
  // The legacy `mcp` group cannot be removed by turning one server off; name that server `absent` instead.
  if (coveredByLegacyGroup) routes[key] = 'absent'; else delete routes[key];
  // Nothing left routed to this computer: host tools go off rather than sit on with an empty list.
  const next: RemoteHostToolsSettings = { ...ht, routes, ...(hasHostRoute(routes) ? {} : { enabled: false }) };
  return normalizeHostTools(next);
}

/** Switch one proxied MCP server on or off for a daemon. On: host tools on, and only this server is named. */
export function setServerAvailable(ht: RemoteHostToolsSettings | undefined, server: string, on: boolean): RemoteHostToolsSettings | undefined {
  return normalizeHostTools(on ? turnOn(ht, server) : turnOff(ht, server, ht?.routes?.[MCP_GROUP] === 'host'));
}

/** Switch one tool group (`vault`, `workspace`, ...) on or off. */
export function setGroupAvailable(ht: RemoteHostToolsSettings | undefined, group: string, on: boolean): RemoteHostToolsSettings | undefined {
  return normalizeHostTools(on ? turnOn(ht, group) : turnOff(ht, group, false));
}

/** Remove an entry this UI does not know (a "custom" row) without touching the rest. */
export function removeRoute(ht: RemoteHostToolsSettings | undefined, key: string): RemoteHostToolsSettings | undefined {
  return turnOff(ht, key, false);
}

/** The master switch. Off keeps the list, so switching it back on restores what was chosen. */
export function setHostToolsEnabled(ht: RemoteHostToolsSettings | undefined, enabled: boolean): RemoteHostToolsSettings | undefined {
  return normalizeHostTools({ ...(ht ?? {}), enabled });
}

/** Names in `routes` routed to this computer that neither the groups nor the known proxied servers explain, including the legacy `mcp` group. */
export function customRoutes(ht: RemoteHostToolsSettings | undefined, knownServers: readonly string[]): string[] {
  const known = new Set(knownServers);
  return Object.entries(ht?.routes ?? {})
    .filter(([k, v]) => v === 'host' && !GROUP_KEYS.has(k) && !known.has(k))
    .map(([k]) => k);
}

export function describeCustomRoute(key: string): string {
  return key === MCP_GROUP
    ? 'Every connected Google Workspace and OAuth server (older setting).'
    : 'Kept from an earlier setting. Turn it off to remove it.';
}

/** Names the daemon is allowed to receive among the user's own (non-OAuth) servers: toggled on or off in the list. */
export function setMcpSent(ht: RemoteHostToolsSettings | undefined, name: string, on: boolean): RemoteHostToolsSettings | undefined {
  const cur = ht?.mcpAllowlist ?? [];
  const next = on ? [...new Set([...cur, name])] : cur.filter((n) => n !== name);
  const { mcpAllowlist: _drop, ...rest } = ht ?? {};
  return normalizeHostTools({ ...rest, ...(next.length ? { mcpAllowlist: next } : {}) });
}

/** Names of the proxied servers the user can offer: connected OAuth servers and enabled Google Workspace services, sorted. */
export function proxiedServerNames(settings: {
  oauthMcpServers?: Record<string, unknown>;
  googleWorkspaceMcp?: Partial<Record<'docs' | 'drive' | 'sheets' | 'slides' | 'gmail' | 'calendar', boolean>>;
}): string[] {
  const oauth = Object.keys(settings.oauthMcpServers ?? {});
  const google = Object.entries(settings.googleWorkspaceMcp ?? {}).filter(([, on]) => on === true).map(([svc]) => `google-${svc}`);
  return [...new Set([...google, ...oauth])].sort((a, b) => a.localeCompare(b));
}

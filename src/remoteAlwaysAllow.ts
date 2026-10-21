/**
 * remoteAlwaysAllow.ts: "Always Allow" for permission cards on threads hosted on a remote daemon.
 *
 * The tool name on a remote thread's card is the daemon's word, so a bare-name allowlist shared with local threads
 * (or with other daemons) would let one daemon, or a forged name, ride on an approval given elsewhere. Remote
 * approvals therefore live in their own map keyed by `Thread.remote.daemonId`:
 *
 *   - a remote thread is pre-approved only by its OWN daemon's list (never `alwaysAllowedTools`, never the
 *     trusted built-in set);
 *   - a local thread is never affected by any daemon's list;
 *   - tools that must be decided afresh every time (`canAlwaysAllow`: host_exec, sync_resolve_conflict) are never
 *     stored and never pre-approved, even if a hand-edited data.json lists them.
 */
import { canAlwaysAllow, isPermissionPreApproved } from './toolNameUtils';

export interface AlwaysAllowSettings {
  alwaysAllowedTools: string[];
  /** daemonId -> tool names always allowed on threads hosted by that daemon. */
  remoteAlwaysAllowedTools?: Record<string, string[]>;
}

/** The slice of `Thread.remote` that scopes an approval. */
export interface AlwaysAllowScope {
  daemonId: string;
}

/** The scope for a thread's `remote` field: null for a local thread. */
export function alwaysAllowScopeFor(remote: AlwaysAllowScope | undefined | null): AlwaysAllowScope | null {
  return remote ? { daemonId: remote.daemonId } : null;
}

/** Clean persisted data: keep only well-formed, deduplicated, allowable tool names for each daemon. */
export function normalizeRemoteAlwaysAllowed(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [daemonId, list] of Object.entries(raw as Record<string, unknown>)) {
    // Assigning "__proto__" would swap the map's prototype instead of adding a key.
    if (daemonId === '__proto__' || !Array.isArray(list)) continue;
    const tools: string[] = [];
    for (const t of list) {
      if (typeof t === 'string' && t !== '' && canAlwaysAllow(t) && !tools.includes(t)) tools.push(t);
    }
    if (tools.length > 0) out[daemonId] = tools;
  }
  return out;
}

function daemonList(settings: AlwaysAllowSettings, daemonId: string): string[] {
  const map = settings.remoteAlwaysAllowedTools;
  if (!map || !Object.prototype.hasOwnProperty.call(map, daemonId)) return [];
  return map[daemonId];
}

/** Records an approval for one daemon. False when nothing changed (already present, or never allowable). */
export function addRemoteAlwaysAllow(settings: AlwaysAllowSettings, daemonId: string, toolName: string): boolean {
  if (!canAlwaysAllow(toolName)) return false;
  if (daemonList(settings, daemonId).includes(toolName)) return false;
  if (daemonId === '__proto__') return false;
  const map = (settings.remoteAlwaysAllowedTools ??= {});
  map[daemonId] = [...daemonList(settings, daemonId), toolName];
  return true;
}

/** Revokes one daemon's approval, dropping the daemon's entry when it empties. False when it was not there. */
export function removeRemoteAlwaysAllow(settings: AlwaysAllowSettings, daemonId: string, toolName: string): boolean {
  const current = daemonList(settings, daemonId);
  if (!current.includes(toolName)) return false;
  const next = current.filter((t) => t !== toolName);
  if (next.length === 0) delete settings.remoteAlwaysAllowedTools![daemonId];
  else settings.remoteAlwaysAllowedTools![daemonId] = next;
  return true;
}

/**
 * True when a permission request may be resolved without a card. Local threads: trusted built-ins or the local
 * list. Remote threads: only their own daemon's list.
 */
export function isPermissionPreApprovedForThread(
  toolName: string,
  remote: AlwaysAllowScope | undefined | null,
  settings: AlwaysAllowSettings,
): boolean {
  const scope = alwaysAllowScopeFor(remote);
  if (!scope) return isPermissionPreApproved(toolName, settings.alwaysAllowedTools);
  return canAlwaysAllow(toolName) && daemonList(settings, scope.daemonId).includes(toolName);
}

/** Persists an "Always Allow" click into the right list for the thread. False when nothing changed. */
export function recordAlwaysAllow(
  settings: AlwaysAllowSettings,
  toolName: string,
  remote: AlwaysAllowScope | undefined | null,
): boolean {
  const scope = alwaysAllowScopeFor(remote);
  if (scope) return addRemoteAlwaysAllow(settings, scope.daemonId, toolName);
  if (!canAlwaysAllow(toolName) || settings.alwaysAllowedTools.includes(toolName)) return false;
  settings.alwaysAllowedTools.push(toolName);
  return true;
}

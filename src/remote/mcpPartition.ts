/**
 * Which of the user's external MCP servers (Settings, MCP) a remote thread gets (design section 2, row
 * "External MCP servers"). A daemon is another machine, so:
 *
 *   - `stdio` servers run a program on THIS computer: dropped;
 *   - a URL on this computer (localhost, 127.x, ::1) is not reachable from the daemon: dropped;
 *   - a server whose config needs a keychain secret (`${NAME}`) is dropped: secret values never cross;
 *   - a server with literal headers (usually credentials) is sent only if the user listed it in the daemon's
 *     MCP allowlist;
 *   - everything else (an http/sse URL the daemon can reach, no headers) passes through.
 *
 * With an allowlist set, ONLY listed servers pass (headers included). Every dropped server comes back with a
 * reason so the user is told, not left guessing why a tool is missing.
 */
import { resolveMcpServers } from '../mcpServerStore';
import type { StoredMcpServer } from '../types';
import type { RemoteMcpServerConfig } from '../protocol';

export interface DroppedMcpServer { name: string; reason: string }

export interface McpPartition {
  passthrough: Record<string, RemoteMcpServerConfig>;
  dropped: DroppedMcpServer[];
}

export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return true; } // unparseable: not something a daemon can use
  const h = host.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || h === '::' || /^127\./.test(h);
}

export function partitionExternalMcpServers(
  stored: Record<string, StoredMcpServer> | undefined,
  allowlist?: readonly string[],
): McpPartition {
  const passthrough: Record<string, RemoteMcpServerConfig> = {};
  const dropped: DroppedMcpServer[] = [];
  if (!stored || typeof stored !== 'object') return { passthrough, dropped };
  // Resolved against an EMPTY environment: any `${NAME}` placeholder fails to resolve, so no secret value is ever read.
  const { servers } = resolveMcpServers(stored, {});
  const allow = allowlist ? new Set(allowlist) : null;
  for (const [name, raw] of Object.entries(stored)) {
    const type = (raw as { type?: string } | undefined)?.type;
    if (type !== 'stdio' && type !== 'http' && type !== 'sse') continue; // oauth/invalid entries are handled elsewhere
    if (type === 'stdio') { dropped.push({ name, reason: 'it starts a program on this computer' }); continue; }
    const resolved = servers[name] as { type?: string; url?: string; headers?: Record<string, string> } | undefined;
    if (!resolved) { dropped.push({ name, reason: 'its configuration uses a secret from this computer, which is never sent to a daemon' }); continue; }
    const url = resolved.url ?? '';
    if (isLoopbackUrl(url)) { dropped.push({ name, reason: 'its address is on this computer and the daemon cannot reach it' }); continue; }
    if (allow && !allow.has(name)) { dropped.push({ name, reason: "it is not on this daemon's MCP allowlist" }); continue; }
    const hasHeaders = !!resolved.headers && Object.keys(resolved.headers).length > 0;
    if (hasHeaders && !allow) { dropped.push({ name, reason: "it sends headers (usually credentials); add it to this daemon's MCP allowlist to send it" }); continue; }
    passthrough[name] = { type: type as 'http' | 'sse', url, ...(hasHeaders ? { headers: resolved.headers } : {}) };
  }
  return { passthrough, dropped };
}

/** One line for the transcript; stable so a notice is shown again only when the set changes. */
export function describeDroppedMcp(dropped: readonly DroppedMcpServer[], daemonName: string): string | undefined {
  if (dropped.length === 0) return undefined;
  return `Not available on ${daemonName}: ${dropped.map((d) => `${d.name} (${d.reason})`).join('; ')}.`;
}

/**
 * MCP server status helpers shared by the session (which reads it from the SDK) and the remote-daemon UI.
 * Pure: no Node or Obsidian imports, safe on mobile.
 */
import type { McpServerStatusEntry } from './ClaudeSession';

/** The `mcp_servers` array of the SDK's `system/init` message, or null when it is absent or malformed. */
export function parseInitMcpServers(value: unknown): McpServerStatusEntry[] | null {
  if (!Array.isArray(value)) return null;
  const out: McpServerStatusEntry[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const { name, status, error } = item as { name?: unknown; status?: unknown; error?: unknown };
    if (typeof name !== 'string' || !name) continue;
    out.push({ name, status: typeof status === 'string' ? status : 'unknown', ...(typeof error === 'string' && error ? { error } : {}) });
  }
  return out;
}

/** Servers whose tools are missing from the session: failed or awaiting sign-in. `pending`/`disabled` are not problems. */
export function mcpAttentionServers(servers: readonly McpServerStatusEntry[]): McpServerStatusEntry[] {
  return servers.filter((s) => s.status === 'failed' || s.status === 'needs-auth');
}

/** What the daemon modal says for one server. A server that is not `connected` is called out as a problem. */
export function describeMcpServer(entry: McpServerStatusEntry): { text: string; ok: boolean } {
  const ok = entry.status === 'connected';
  const label = entry.status === 'needs-auth' ? 'needs sign-in' : entry.status;
  return { text: `${entry.name}: ${label}${entry.error ? ` (${entry.error})` : ''}`, ok };
}

/** Last MCP status each daemon reported, in memory only (it describes live sessions, so it is stale across restarts). */
export class DaemonMcpStatusStore {
  private readonly byDaemon = new Map<string, { at: number; servers: McpServerStatusEntry[] }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  set(daemonId: string, servers: McpServerStatusEntry[]): void {
    this.byDaemon.set(daemonId, { at: this.now(), servers });
  }

  get(daemonId: string): { at: number; servers: McpServerStatusEntry[] } | undefined {
    return this.byDaemon.get(daemonId);
  }
}

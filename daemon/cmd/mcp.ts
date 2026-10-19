/**
 * `agent-threads mcp sync --stdin`: send MCP server definitions to the daemon (`mcp.sync`, admin scope).
 *
 * Standard input is a JSON object of `name -> definition` (the same shapes as the `mcpServers` section of config.json,
 * with credentials written as `${mcpsync-<project>.NAME}` and pushed separately with `creds push mcpsync-<project>`).
 * It is a full replace of the accepted servers: servers not in the input are removed from the daemon. If servers are given
 * and the daemon accepts none, it keeps the previous set (reply `kept`), and the command exits 1. The managed local daemon uses this
 * from inside its container, where its admin token lives (src/localDaemon/credsPusher.ts).
 */
import type { McpSyncReply } from '../../src/protocol';
import type { DaemonClient } from '../../src/remote/DaemonClient';
import { command } from './connection';
import { CliError, EXIT } from './exit';

export interface McpSyncOptions {
  stdinJson: boolean;
  /** Allow an empty server set (removes every synced server); never done by accident. */
  clear: boolean;
}

export function prepareSync(opts: McpSyncOptions, stdinText: string | undefined): Record<string, unknown> {
  if (!opts.stdinJson) throw new CliError('mcp sync reads the definitions from standard input: pass --stdin (a JSON object of name -> definition)', EXIT.USAGE);
  let parsed: unknown;
  try { parsed = JSON.parse(stdinText ?? ''); } catch { throw new CliError('--stdin expects a JSON object of name -> definition on standard input', EXIT.USAGE); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new CliError('--stdin expects a JSON object of name -> definition', EXIT.USAGE);
  const servers = parsed as Record<string, unknown>;
  if (Object.keys(servers).length === 0 && !opts.clear) {
    throw new CliError('no servers on standard input: that would remove every synced server; pass --clear if that is what you want', EXIT.USAGE);
  }
  return servers;
}

export async function syncMcp(client: DaemonClient, servers: Record<string, unknown>): Promise<McpSyncReply> {
  // An empty set is only ever sent as an explicit clear (prepareSync refused it otherwise).
  const empty = Object.keys(servers).length === 0;
  const r = await command<Partial<McpSyncReply>>(client, 'mcp.sync', { servers, ...(empty ? { clear: true } : {}) });
  return { accepted: r.accepted ?? [], rejected: r.rejected ?? [], requiredCreds: r.requiredCreds ?? [], shadowed: r.shadowed ?? [], ...(r.kept === true ? { kept: true } : {}) };
}

export function formatSync(r: McpSyncReply): string[] {
  const lines = [r.kept ? 'no server was accepted: the previously synced set was kept unchanged' : r.accepted.length ? `synced ${r.accepted.length} server${r.accepted.length === 1 ? '' : 's'}: ${r.accepted.join(', ')}` : 'no servers are synced now'];
  for (const x of r.rejected) lines.push(`rejected ${x.name}: ${x.reason}`);
  if (r.shadowed.length) lines.push(`overridden by config.json: ${r.shadowed.join(', ')}`);
  if (r.requiredCreds.length) lines.push(`needs credentials (push with "creds push"): ${r.requiredCreds.join(', ')}`);
  return lines;
}

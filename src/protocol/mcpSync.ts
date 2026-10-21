/**
 * `mcp.sync`: the app pushes the MCP server definitions the user chose to run on a daemon (Settings, MCP).
 *
 * Definitions travel with `${NAME}` placeholders UNRESOLVED; the secret values go separately with `creds.push`
 * (kind `mcpsync-<project>`, field = placeholder name) and are filled in on the daemon each time a session starts.
 * Pure TypeScript shared by the daemon, the CLI and the app. The definitions are the harness-neutral
 * `HarnessMcpServerConfig`, so any harness adapter can consume what the daemon resolves from them.
 */
import type { HarnessMcpServerConfig } from '../HarnessSession';

/** The server map carried by `mcp.sync` (full replace of the accepted servers: a name that is absent is removed). */
export type SyncedMcpServers = Record<string, HarnessMcpServerConfig>;

export interface McpSyncRejection { name: string; reason: string }

export interface McpSyncReply {
  /** Names now stored on the daemon (including the shadowed ones). */
  accepted: string[];
  /** Definitions the daemon refused, each with the reason (policy or validation). Never a value. */
  rejected: McpSyncRejection[];
  /** Every `${NAME}` the accepted definitions refer to: the credential fields that must be pushed. Names only. */
  requiredCreds: string[];
  /** Accepted names that a same-named server in the daemon's config.json overrides. */
  shadowed: string[];
  /**
   * True when the request named servers but the daemon accepted none of them: the previously synced set was left
   * exactly as it was (nothing rewritten, nothing removed) and `rejected` says why. Absent otherwise, so a client
   * that predates the field reads the reply as before. Clients must not treat a kept reply as a successful sync.
   */
  kept?: boolean;
}

export const MAX_SYNCED_MCP_SERVERS = 64;
/** Server and credential-reference names, as the daemon's own `mcpServers` section allows them. */
export const SYNCED_MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** `${NAME}` or `${kind.NAME}` (the dotted form reads one credential kind only). */
export const MCP_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g;

/** Capability the daemon advertises when it understands `mcp.sync`. */
export const MCP_SYNC_CAPABILITY = 'mcp.sync';
/** Advertised additionally when the daemon's operator allows synced stdio servers (`allowSyncedStdio`). */
export const MCP_SYNC_STDIO_CAPABILITY = 'mcp.sync.stdio';

/** Check the `servers` of an `mcp.sync`. Returns a message naming the first problem, or null. */
export function validateSyncedMcpShape(servers: unknown, clear = false): string | null {
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return 'servers must be an object of name -> definition';
  const entries = Object.entries(servers);
  if (clear && entries.length > 0) return 'clear removes every synced server, so servers must be empty';
  if (entries.length > MAX_SYNCED_MCP_SERVERS) return `at most ${MAX_SYNCED_MCP_SERVERS} servers`;
  for (const [name, def] of entries) {
    if (typeof def !== 'object' || def === null || Array.isArray(def)) return `servers.${name.slice(0, 40)} must be an object`;
  }
  return null;
}

/** Every distinct `${NAME}` referenced by a definition (URL, header values, command, args, env values), in order. */
export function placeholdersOf(def: HarnessMcpServerConfig): string[] {
  const texts: string[] = [];
  if ('url' in def) {
    texts.push(def.url, ...Object.values(def.headers ?? {}));
  } else {
    texts.push(def.command, ...(def.args ?? []), ...Object.values(def.env ?? {}));
  }
  const found = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(MCP_PLACEHOLDER)) found.add(m[1]);
  return [...found];
}

/** JSON with object keys sorted, so equal definitions serialize (and hash) identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

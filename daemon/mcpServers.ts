/**
 * Daemon-owned MCP servers: the operator lists them in `config.json` (`mcpServers`), with `${NAME}` placeholders
 * wherever a secret belongs (URL, header value, command argument, env value). The placeholders are filled from the
 * credential store (`creds.push`) each time a session starts, so a rotated credential reaches the next session
 * without a daemon restart and the secret never sits in config.json or a session's stored spec.
 *
 * A server whose placeholder has no credential yet is NOT started; it is reported as failed with the missing names
 * so the user can see why it has no tools.
 */
import type { HarnessMcpServerConfig } from '../src/HarnessSession';

/** Server names the daemon reserves for its own tools. */
export const RESERVED_MCP_NAMES: readonly string[] = ['claude_threads', 'obsidian'];

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type DaemonMcpServers = Record<string, HarnessMcpServerConfig>;

export interface ResolvedMcpServers {
  servers: DaemonMcpServers;
  /** Servers left out because a credential they reference is not stored. */
  unresolved: Array<{ name: string; missing: string[] }>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringMap = (v: unknown): v is Record<string, string> => isObject(v) && Object.values(v).every((x) => typeof x === 'string');
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Validate the `mcpServers` section of config.json. Throws with the offending name on any problem. */
export function parseDaemonMcpServers(raw: unknown): DaemonMcpServers {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new Error('invalid mcpServers: expected an object of name -> server');
  const out: DaemonMcpServers = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!NAME.test(name)) throw new Error(`invalid mcpServers name "${name}"`);
    if (RESERVED_MCP_NAMES.includes(name)) throw new Error(`mcpServers.${name} is reserved for the daemon's own tools`);
    if (!isObject(value)) throw new Error(`invalid mcpServers.${name}: expected an object`);
    const type = value.type ?? 'stdio';
    if (type === 'http' || type === 'sse') {
      if (typeof value.url !== 'string' || !value.url) throw new Error(`mcpServers.${name}.url must be a string`);
      if (value.headers !== undefined && !isStringMap(value.headers)) throw new Error(`mcpServers.${name}.headers must map names to strings`);
      out[name] = { type, url: value.url, ...(value.headers ? { headers: value.headers as Record<string, string> } : {}) };
    } else if (type === 'stdio') {
      if (typeof value.command !== 'string' || !value.command) throw new Error(`mcpServers.${name}.command must be a string`);
      if (value.args !== undefined && !isStringList(value.args)) throw new Error(`mcpServers.${name}.args must be a list of strings`);
      if (value.env !== undefined && !isStringMap(value.env)) throw new Error(`mcpServers.${name}.env must map names to strings`);
      out[name] = {
        type: 'stdio',
        command: value.command,
        ...(value.args ? { args: value.args as string[] } : {}),
        ...(value.env ? { env: value.env as Record<string, string> } : {}),
      };
    } else {
      throw new Error(`mcpServers.${name}.type must be "stdio", "http" or "sse"`);
    }
  }
  return out;
}

/** Replace `${NAME}` in one string; collects the names `lookup` could not supply. */
function fill(text: string, lookup: (name: string) => string | undefined, missing: Set<string>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = lookup(name);
    if (value === undefined) { missing.add(name); return whole; }
    return value;
  });
}

function fillMap(map: Record<string, string> | undefined, lookup: (n: string) => string | undefined, missing: Set<string>): Record<string, string> | undefined {
  if (!map) return undefined;
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, fill(v, lookup, missing)]));
}

/** Resolve every placeholder in `servers` against `lookup`. Pure: the same inputs give the same output. */
export function resolveDaemonMcpServers(servers: DaemonMcpServers, lookup: (name: string) => string | undefined): ResolvedMcpServers {
  const resolved: DaemonMcpServers = {};
  const unresolved: ResolvedMcpServers['unresolved'] = [];
  for (const [name, server] of Object.entries(servers)) {
    const missing = new Set<string>();
    let next: HarnessMcpServerConfig;
    if (server.type === 'http' || server.type === 'sse') {
      const headers = fillMap(server.headers, lookup, missing);
      next = { type: server.type, url: fill(server.url, lookup, missing), ...(headers ? { headers } : {}) };
    } else {
      const env = fillMap(server.env, lookup, missing);
      next = {
        type: 'stdio',
        command: fill(server.command, lookup, missing),
        ...(server.args ? { args: server.args.map((a) => fill(a, lookup, missing)) } : {}),
        ...(env ? { env } : {}),
      };
    }
    if (missing.size) unresolved.push({ name, missing: [...missing] });
    else resolved[name] = next;
  }
  return { servers: resolved, unresolved };
}

/**
 * MCP servers synced from a client (`mcp.sync`, admin scope): the user's Settings servers that should also run on
 * this daemon. Stored in `<data-dir>/synced-mcp.json` (0600, written atomically), one record per server with the
 * token that synced it and a hash of the definition.
 *
 * What is stored are DEFINITIONS with `${NAME}` placeholders unresolved. The values live in `creds/` (pushed with
 * `creds.push`) and are filled in when a session starts, exactly like the operator's `config.json` servers, so a
 * synced definition never holds a secret and is never copied into `sessions/<id>.json`.
 *
 * Everything here is typed as the harness-neutral `HarnessMcpServerConfig`; nothing is specific to one harness.
 *
 * Precedence when a session starts, lowest to highest: the spec's own passthrough servers, synced servers,
 * `config.json` servers, then the daemon's own host servers (`claude_threads`, `obsidian` reserved). The operator's
 * `config.json` therefore always wins a name clash (reported as `shadowed`).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessMcpServerConfig } from '../src/HarnessSession';
import { MAX_SYNCED_MCP_SERVERS, canonicalJson, placeholdersOf, type McpSyncReply, type McpSyncRejection } from '../src/protocol/mcpSync';
import { writeFileAtomic } from './fsutil';
import { RESERVED_MCP_NAMES, parseDaemonMcpServers, type DaemonMcpServers } from './mcpServers';

/** Largest serialized definition accepted for one server. */
export const MAX_SYNCED_DEFINITION_BYTES = 16 * 1024;

export interface SyncedMcpPolicy {
  /** Accept `stdio` definitions (they run a program on this machine). Off unless the operator opts in. */
  allowStdio: boolean;
  /**
   * With a non-empty list, a stdio command must be listed: a bare name matches only a bare command (looked up on
   * PATH), an absolute path matches only that exact command.
   */
  commandAllowlist: readonly string[];
}

export const DEFAULT_SYNCED_POLICY: SyncedMcpPolicy = { allowStdio: false, commandAllowlist: [] };

export interface SyncedMcpRecord {
  def: HarnessMcpServerConfig;
  /** sha256 of the canonical definition. */
  hash: string;
  /** Id of the token that synced it. */
  syncedBy: string;
  syncedAt: number;
}

interface SyncedFile { version: 1; servers: Record<string, SyncedMcpRecord> }

export interface SyncedMcpChange extends McpSyncReply {
  added: string[];
  removed: string[];
}

export const hashMcpDefinition = (def: HarnessMcpServerConfig): string => createHash('sha256').update(canonicalJson(def)).digest('hex');

/**
 * A synced definition may only read credentials of kind `mcpsync-<project>`, by the qualified form
 * `${mcpsync-<project>.NAME}`. A bare `${NAME}` searches every stored kind, which would let anyone holding an admin
 * token read the GitHub token, another project's secrets or session environment back out through a server URL they
 * choose. (The operator's own config.json keeps the bare form: it is operator-trusted.)
 */
export const SYNCED_PLACEHOLDER = /^mcpsync-[a-z0-9][a-z0-9_-]{0,50}\.[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Why a definition may not be stored under `policy`, or undefined when it may. */
export function policyViolation(def: HarnessMcpServerConfig, policy: SyncedMcpPolicy): string | undefined {
  const badRef = placeholdersOf(def).find((p) => !SYNCED_PLACEHOLDER.test(p));
  if (badRef !== undefined) return `\${${badRef}} is not allowed: a synced server may only refer to credentials as \${mcpsync-<project>.NAME}`;
  if ('url' in def) return undefined;
  if (!policy.allowStdio) return 'stdio servers are not allowed on this daemon (its operator must set allowSyncedStdio)';
  if (placeholdersOf({ type: 'stdio', command: def.command }).length) return 'the command of a synced stdio server cannot contain a ${...} placeholder';
  if (policy.commandAllowlist.length && !policy.commandAllowlist.includes(def.command)) return `the command "${def.command.slice(0, 80)}" is not on this daemon's synced command allowlist`;
  return undefined;
}

export class SyncedMcpStore {
  readonly file: string;

  constructor(
    dataDir: string,
    private readonly policy: SyncedMcpPolicy = DEFAULT_SYNCED_POLICY,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.file = join(dataDir, 'synced-mcp.json');
  }

  /** Whether synced stdio definitions are accepted here (advertised as a capability). */
  get allowsStdio(): boolean { return this.policy.allowStdio; }

  /** Stored records. A missing or damaged file reads as empty (fail closed: nothing synced runs). */
  records(): Record<string, SyncedMcpRecord> {
    if (!existsSync(this.file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SyncedFile> | null;
      if (!parsed || typeof parsed.servers !== 'object' || parsed.servers === null) return {};
      const out: Record<string, SyncedMcpRecord> = {};
      for (const [name, rec] of Object.entries(parsed.servers)) {
        // Re-validated on every read: the file is data, and policy may have tightened since it was written.
        try {
          const def = parseDaemonMcpServers({ [name]: rec?.def })[name];
          out[name] = { def, hash: hashMcpDefinition(def), syncedBy: String(rec.syncedBy ?? ''), syncedAt: Number(rec.syncedAt ?? 0) };
        } catch { /* skip a record that no longer validates */ }
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * Replace the stored set. Each entry is validated on its own, so one bad definition does not stop the others.
   * When some are accepted, a name that is rejected is also dropped from the store (full replace), never kept from an
   * earlier sync: the definition it had was superseded by one the daemon refuses, and silently running the old one
   * would contradict what the client was just told.
   * When the request named servers and NONE was accepted, nothing is replaced (`kept`): a policy change (stdio turned
   * off) or one invalid definition must not wipe a working set. An empty request is a deliberate clear.
   * `configured` is the set of names the operator's config.json defines: they are accepted but reported as shadowed.
   */
  replace(servers: unknown, tokenId: string, configured: ReadonlySet<string> = new Set()): SyncedMcpChange {
    const previous = this.records();
    const next: Record<string, SyncedMcpRecord> = {};
    const rejected: McpSyncRejection[] = [];
    const entries = typeof servers === 'object' && servers !== null && !Array.isArray(servers) ? Object.entries(servers) : [];
    for (const [name, raw] of entries.slice(0, MAX_SYNCED_MCP_SERVERS)) {
      const reject = (reason: string) => rejected.push({ name: name.slice(0, 64), reason });
      if (RESERVED_MCP_NAMES.includes(name)) { reject('the name is reserved for the daemon\'s own tools'); continue; }
      if (JSON.stringify(raw).length > MAX_SYNCED_DEFINITION_BYTES) { reject(`the definition is larger than ${MAX_SYNCED_DEFINITION_BYTES} bytes`); continue; }
      let def: HarnessMcpServerConfig;
      try {
        def = parseDaemonMcpServers({ [name]: raw })[name];
      } catch (err) {
        reject((err instanceof Error ? err.message : String(err)).split(`mcpServers.${name}`).join('definition'));
        continue;
      }
      const violation = policyViolation(def, this.policy);
      if (violation) { reject(violation); continue; }
      const hash = hashMcpDefinition(def);
      const before = previous[name];
      next[name] = { def, hash, syncedBy: tokenId, syncedAt: before && before.hash === hash ? before.syncedAt : this.now() };
    }
    const names = Object.keys(next);
    if (entries.length > 0 && names.length === 0) {
      return { accepted: [], rejected, requiredCreds: [], shadowed: [], kept: true, added: [], removed: [] };
    }
    writeFileAtomic(this.file, `${JSON.stringify({ version: 1, servers: next } satisfies SyncedFile)}\n`);
    return {
      accepted: names,
      rejected,
      requiredCreds: [...new Set(names.flatMap((n) => placeholdersOf(next[n].def)))].sort(),
      shadowed: names.filter((n) => configured.has(n)),
      added: names.filter((n) => !(n in previous)),
      removed: Object.keys(previous).filter((n) => !(n in next)),
    };
  }

  /**
   * The synced definitions a session may start, under the CURRENT policy (a stdio server synced before the operator
   * switched `allowSyncedStdio` off is not started).
   */
  active(): DaemonMcpServers {
    const out: DaemonMcpServers = {};
    for (const [name, rec] of Object.entries(this.records())) {
      if (!policyViolation(rec.def, this.policy) && !RESERVED_MCP_NAMES.includes(name)) out[name] = rec.def;
    }
    return out;
  }
}

/**
 * Merge synced definitions beneath the operator's: `configured` (config.json) replaces a synced server of the same
 * name. Both are still unresolved; run `resolveDaemonMcpServers` over the result.
 */
export function mergeDaemonMcpServers(synced: DaemonMcpServers, configured: DaemonMcpServers): { servers: DaemonMcpServers; shadowed: string[] } {
  return {
    servers: { ...synced, ...configured },
    shadowed: Object.keys(synced).filter((n) => n in configured),
  };
}

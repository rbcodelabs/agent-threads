/**
 * Sync the user's Settings MCP servers to the remote daemons they opted in for (design: `docs/remote-daemon.md`,
 * "MCP servers synced from the app").
 *
 * What crosses, and how:
 *   - the DEFINITION of each opted-in server (command, args, env / url, headers) with its `${NAME}` placeholders
 *     rewritten to `${mcpsync-<project>.NAME}` and sent with `mcp.sync` (full replace);
 *   - the VALUES of exactly those secrets, read from the keychain only for opted-in, confirmed servers, sent with
 *     `creds.push` as kind `mcpsync-<project>` (field = placeholder name, 30 day TTL, refreshed on connect and on every
 *     settings edit). The qualified form is the only one a synced definition may use (the daemon enforces it), so a
 *     project's secrets can never fill another project's server.
 *
 * Never synced: oauth servers (they live in `oauthMcpServers` and are brokered by this computer), anything that points
 * at this computer (loopback, so also the Google and OAuth capability proxies), a server whose secret is not a stored
 * keychain secret, or that holds a literal credential. A definition the user has not confirmed in its current form is
 * not synced. Secret values are held only inside `run()` and are scrubbed from every message that leaves this module.
 */
import type { HarnessMcpServerConfig } from '../HarnessSession';
import { normalizeStoredServer } from '../mcpServerStore';
import { MCP_SYNC_CAPABILITY, MCP_SYNC_STDIO_CAPABILITY, canonicalJson, urlCarriesCredentials, type McpSyncReply, type SyncedMcpServers } from '../protocol';
import { isSecretVisibleToProject } from '../secretUtils';
import type { DaemonMcpSyncEntry, RemoteDaemonConfig, StoredMcpServer } from '../types';
import { DaemonCommandError, type DaemonClient } from './DaemonClient';
import { isLoopbackUrl } from './mcpPartition';
import { sha256Hex } from './sha256';

export const MCP_SYNC_TTL_SEC = 30 * 24 * 60 * 60;
/** Kind used by the admin probe: pushing no fields to a kind that holds nothing changes nothing on the daemon. */
const PROBE_KIND = 'mcpsync-probe';
/** Pre-session refresh: a sync older than this is repeated before a thread starts (keeps the 30 day TTL far away). */
const FRESH_MS = 12 * 60 * 60_000;
const SYNC_DEBOUNCE_MS = 400;
const PLACEHOLDER = /\$\{([^}]+)\}/g;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SENSITIVE_NAME = /auth|api[-_]?key|token|secret|cookie|passw|credential|bearer/i;

// ── pure: kinds, evaluation ───────────────────────────────────────────────────

export const MCP_SYNC_KIND_PREFIX = 'mcpsync-';
export const MCP_SYNC_GLOBAL_KIND = 'mcpsync-global';

/** `mcpsync-p-<project id>` for a project-limited secret, `mcpsync-global` for the rest. Fits the daemon's kind pattern. */
export function mcpSyncKind(projectId: string | undefined): string {
  if (!projectId) return MCP_SYNC_GLOBAL_KIND;
  const slug = projectId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 40) || 'project';
  return `${MCP_SYNC_KIND_PREFIX}p-${slug}`;
}

export type BlockCode = 'invalid' | 'oauth' | 'loopback' | 'unsyncable-secret' | 'literal-secret' | 'mixed-scope';

export interface ServerEvaluation {
  name: string;
  /** Why this server can never be synced as configured; the other fields are then absent. */
  blocked?: { code: BlockCode; reason: string };
  /** Definition as stored on this computer (placeholders as written). Shown in the confirmation. */
  stored?: StoredMcpServer;
  /** What goes on the wire: placeholders rewritten to `${kind.NAME}`. */
  wire?: HarnessMcpServerConfig;
  kind?: string;
  /** Keychain secret NAMES this server needs on the daemon. */
  secretNames: string[];
  /** The one project that secret visibility is limited to, when it is. */
  limitedToProject?: string;
  /** Fingerprint of the stored definition plus its credential kind; what the user confirms. */
  hash: string;
}

export interface EvalContext {
  /** `settings.secretEnvKeys`: the names that exist as keychain secrets. */
  secretKeys: readonly string[];
  /** `settings.secretEnvScopes`. */
  secretScopes: Record<string, string[]> | undefined;
  /** Names of `oauthMcpServers`: a same-named entry is never synced. */
  oauthNames: ReadonlySet<string>;
}

function stringLeaves(def: StoredMcpServer): string[] {
  return def.type === 'stdio'
    ? [def.command, ...(def.args ?? []), ...Object.values(def.env ?? {})]
    : [def.url, ...Object.values(def.headers ?? {})];
}

function mapLeaves(def: StoredMcpServer, f: (s: string) => string): HarnessMcpServerConfig {
  const mapRecord = (r: Record<string, string> | undefined): Record<string, string> | undefined =>
    r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, f(v)])) : undefined;
  if (def.type === 'stdio') {
    const env = mapRecord(def.env);
    return { type: 'stdio', command: f(def.command), ...(def.args ? { args: def.args.map(f) } : {}), ...(env ? { env } : {}) };
  }
  const headers = mapRecord(def.headers);
  return { type: def.type, url: f(def.url), ...(headers ? { headers } : {}) };
}

/** A literal credential in the definition (as opposed to a `${NAME}` placeholder), or undefined. */
function literalCredential(def: StoredMcpServer): string | undefined {
  // A sensitive-looking value with no placeholder at all is a credential typed into the config.
  const hasLiteral = (v: string): boolean => v.trim() !== '' && !/\$\{[^}]+\}/.test(v);
  if (def.type === 'stdio') {
    for (const [k, v] of Object.entries(def.env ?? {})) if (SENSITIVE_NAME.test(k) && hasLiteral(v)) return `its environment variable ${k} holds a literal value`;
    return undefined;
  }
  for (const [k, v] of Object.entries(def.headers ?? {})) if (SENSITIVE_NAME.test(k) && hasLiteral(v)) return `its header ${k} holds a literal value`;
  const withX = def.url.replace(PLACEHOLDER, 'x');
  let u: URL;
  try { u = new URL(withX); } catch { return undefined; }
  const authority = (/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(def.url)?.[1] ?? '');
  if ((u.username || u.password) && !authority.includes('${')) return 'its address carries a user name or password';
  // A query value that is a `${NAME}` placeholder is fine; any other credential-looking value is a literal one.
  const query = def.url.split('#')[0].split('?')[1];
  if (query !== undefined) {
    const literalOnly = new URL(withX);
    literalOnly.search = '';
    for (const pair of query.split('&')) {
      const [k, ...rest] = pair.split('=');
      if (!k || rest.join('=').includes('${')) continue;
      literalOnly.searchParams.append(decodeURIComponent(k), decodeURIComponent(rest.join('=')));
    }
    if (urlCarriesCredentials(literalOnly.toString())) return 'its address carries a credential in the query';
  }
  return undefined;
}

/** Does any string in the definition name a URL on this computer? (The Google and OAuth proxies are loopback URLs.) */
function pointsAtThisComputer(def: StoredMcpServer): boolean {
  if (def.type !== 'stdio') return isLoopbackUrl(def.url.replace(PLACEHOLDER, 'x'));
  return stringLeaves(def).some((s) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s.trim()) && isLoopbackUrl(s.trim().replace(PLACEHOLDER, 'x')))
    || stringLeaves(def).some((s) => /(?:^|[=\s])[a-z]+:\/\/(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)[:/\s]/i.test(s));
}

export function evaluateServer(name: string, raw: unknown, ctx: EvalContext): ServerEvaluation {
  const blocked = (code: BlockCode, reason: string): ServerEvaluation => ({ name, secretNames: [], hash: '', blocked: { code, reason } });
  if (ctx.oauthNames.has(name)) return blocked('oauth', 'it signs in with OAuth through this computer, so it cannot run on a daemon');
  const stored = normalizeStoredServer(raw);
  if (!stored) return blocked('invalid', 'its configuration is not valid');
  if (pointsAtThisComputer(stored)) return blocked('loopback', 'it points at an address on this computer (localhost), which a daemon cannot reach');
  const names = [...new Set(stringLeaves(stored).flatMap((s) => [...s.matchAll(PLACEHOLDER)].map((m) => m[1])))].sort();
  const unknown = names.filter((n) => !ctx.secretKeys.includes(n));
  if (unknown.length) return blocked('unsyncable-secret', `\${${unknown[0]}} is not a secret stored under Settings, Secrets (environment variables of this computer are never sent)`);
  const badName = names.find((n) => !FIELD_NAME.test(n));
  if (badName) return blocked('unsyncable-secret', `the secret name ${badName} cannot be used on a daemon (letters, digits and _ only)`);
  const literal = literalCredential(stored);
  if (literal) return blocked('literal-secret', `${literal}; move it to Settings, Secrets and refer to it as \${NAME}`);
  // Visibility: all global -> the shared kind; limited to exactly one project -> that project's kind; anything else cannot be honoured.
  const scopeLists = names.map((n) => ctx.secretScopes?.[n]).filter((l): l is string[] => !!l && l.length > 0);
  const distinct = new Set(scopeLists.map((l) => [...l].sort().join('\n')));
  let limitedToProject: string | undefined;
  if (distinct.size > 1 || scopeLists.some((l) => l.length > 1)) {
    return blocked('mixed-scope', 'its secrets are limited to different projects, and a daemon cannot tell projects apart');
  }
  if (scopeLists.length) limitedToProject = scopeLists[0][0];
  const kind = mcpSyncKind(limitedToProject);
  const wire = mapLeaves(stored, (s) => s.replace(PLACEHOLDER, (_m, n: string) => `\${${kind}.${n}}`));
  return {
    name, stored, wire, kind, secretNames: names,
    ...(limitedToProject ? { limitedToProject } : {}),
    hash: sha256Hex(canonicalJson({ def: stored, kind })),
  };
}

/** Replace every secret value in `text` (used on anything that could be logged or shown). */
export function scrubSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join('***');
  return out;
}

// ── transports ───────────────────────────────────────────────────────────────

/** How credentials and definitions reach one daemon. Empty `fields` removes the kind. */
export interface McpSyncTransport {
  pushCreds(kind: string, fields: Record<string, string>, ttlSec: number): Promise<void>;
  syncServers(servers: SyncedMcpServers): Promise<McpSyncReply>;
  /** Wire transports can learn whether the token is an admin token; the managed daemon's is in its container. */
  probeAdmin?(): Promise<boolean>;
}

export class NeedsAdminError extends Error {
  constructor() { super('needs an admin token'); }
}

/** Over the wire with the daemon's stored token (the user-added remote daemons). */
export function wireTransport(client: DaemonClient): McpSyncTransport {
  const forbidden = (e: unknown): never => {
    if (e instanceof DaemonCommandError && e.code === 'forbidden') throw new NeedsAdminError();
    throw e;
  };
  return {
    async pushCreds(kind, fields, ttlSec) {
      try { await client.command('creds.push', { kind, ttlSec, fields }, { timeoutMs: 15_000 }); } catch (e) { forbidden(e); }
    },
    async syncServers(servers) {
      try {
        // An empty set is always an explicit clear, so a daemon that distinguishes the two honours it.
        const payload = Object.keys(servers).length === 0 ? { servers, clear: true } : { servers };
        const r = (await client.command('mcp.sync', payload, { timeoutMs: 15_000 })) as unknown as Partial<McpSyncReply>;
        return { accepted: r.accepted ?? [], rejected: r.rejected ?? [], requiredCreds: r.requiredCreds ?? [], shadowed: r.shadowed ?? [], ...(r.kept === true ? { kept: true } : {}) };
      } catch (e) { return forbidden(e); }
    },
    async probeAdmin() {
      try { await client.command('creds.push', { kind: PROBE_KIND, ttlSec: 0, fields: {} }, { timeoutMs: 10_000 }); return true; } catch (e) {
        if (e instanceof DaemonCommandError && e.code === 'forbidden') return false;
        throw e;
      }
    },
  };
}

// ── status ───────────────────────────────────────────────────────────────────

export type McpSyncServerStatus =
  | { state: 'off' }
  | { state: 'blocked'; code: BlockCode; reason: string }
  | { state: 'needs-confirm' }
  | { state: 'missing-secret'; names: string[] }
  | { state: 'pending' }
  | { state: 'synced'; shadowed: boolean }
  | { state: 'rejected'; reason: string }
  | { state: 'error'; reason: string };

export type McpSyncAvailability =
  | { ok: true }
  | { ok: false; code: 'not-connected' | 'daemon-too-old' | 'needs-admin' | 'stdio-forbidden' | 'policy'; reason: string };

interface DaemonState {
  phase: 'idle' | 'syncing' | 'ok' | 'error';
  at?: number;
  error?: string;
  accepted: Set<string>;
  rejected: Record<string, string>;
  shadowed: Set<string>;
  missing: Record<string, string[]>;
  adminState: 'unknown' | 'yes' | 'no';
  statuses: Record<string, McpSyncServerStatus>;
}

const newState = (): DaemonState => ({ phase: 'idle', accepted: new Set(), rejected: {}, shadowed: new Set(), missing: {}, adminState: 'unknown', statuses: {} });

export interface McpSyncDeps {
  daemons(): RemoteDaemonConfig[];
  settings(): {
    mcpServers?: Record<string, unknown>;
    oauthMcpServers?: Record<string, unknown>;
    secretEnvKeys?: string[];
    secretEnvScopes?: Record<string, string[]>;
  };
  /** Read ONE keychain secret. Called only for secrets of opted-in, confirmed servers. */
  readSecret(name: string): string | undefined;
  capabilitiesOf(daemonId: string): string[] | undefined;
  /** The transport for a daemon, or undefined when this install cannot reach it (managed daemon not available, no client). */
  transportFor(daemon: RemoteDaemonConfig): McpSyncTransport | undefined;
  saveSettings(): Promise<void>;
  /** Managed policy: why this daemon must not be reached at all, or undefined (docs/managed-policy.md). */
  policyDenial?(daemon: RemoteDaemonConfig): string | undefined;
  now?: () => number;
  log?(message: string): void;
}

/**
 * The sync engine. One instance per plugin. All daemon traffic for a daemon is serialised (a trigger during a sync
 * schedules exactly one more), and triggers within a short window coalesce.
 */
export class McpSyncEngine {
  private readonly states = new Map<string, DaemonState>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Map<string, 'normal' | 'force'>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<(daemonId: string) => void>();
  private readonly lastKey = new Map<string, { key: string; at: number }>();
  private readonly now: () => number;

  constructor(private readonly deps: McpSyncDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  onChange(listener: (daemonId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private state(daemonId: string): DaemonState {
    let s = this.states.get(daemonId);
    if (!s) { s = newState(); this.states.set(daemonId, s); }
    return s;
  }

  private emit(daemonId: string): void { for (const l of [...this.listeners]) l(daemonId); }
  private daemon(daemonId: string): RemoteDaemonConfig | undefined { return this.deps.daemons().find((d) => d.id === daemonId); }

  private ctx(): EvalContext {
    const s = this.deps.settings();
    return { secretKeys: s.secretEnvKeys ?? [], secretScopes: s.secretEnvScopes, oauthNames: new Set(Object.keys(s.oauthMcpServers ?? {})) };
  }

  /** Every Settings server, evaluated. */
  evaluateAll(): ServerEvaluation[] {
    const servers = this.deps.settings().mcpServers ?? {};
    const ctx = this.ctx();
    return Object.entries(servers).map(([name, raw]) => evaluateServer(name, raw, ctx));
  }

  evaluate(name: string): ServerEvaluation | undefined {
    const raw = (this.deps.settings().mcpServers ?? {})[name];
    return raw === undefined ? undefined : evaluateServer(name, raw, this.ctx());
  }

  // ── what the UI and the session path ask ────────────────────────────────────

  /** Can servers be synced to this daemon at all, and (with `ev`) can this one? */
  availability(daemonId: string, ev?: ServerEvaluation): McpSyncAvailability {
    const daemon = this.daemon(daemonId);
    const caps = this.deps.capabilitiesOf(daemonId);
    if (!daemon) return { ok: false, code: 'not-connected', reason: 'This daemon is no longer configured.' };
    const denied = this.deps.policyDenial?.(daemon);
    if (denied) return { ok: false, code: 'policy', reason: denied };
    if (!caps) return { ok: false, code: 'not-connected', reason: 'Connect to this daemon first, so its abilities are known.' };
    if (!caps.includes(MCP_SYNC_CAPABILITY)) return { ok: false, code: 'daemon-too-old', reason: 'This daemon is too old to receive MCP servers. Update it.' };
    if (daemon.managed !== 'local-container' && this.state(daemonId).adminState === 'no') {
      return { ok: false, code: 'needs-admin', reason: 'Needs an admin token. Create one with `agent-threads token create --scope admin` on the daemon and use it for this daemon.' };
    }
    if (ev?.stored?.type === 'stdio' && !caps.includes(MCP_SYNC_STDIO_CAPABILITY)) {
      return { ok: false, code: 'stdio-forbidden', reason: 'This daemon does not accept programs from the app (its operator must enable allowSyncedStdio).' };
    }
    return { ok: true };
  }

  /** Learn whether the stored token is an admin token (no effect on the daemon). Cached until the next connection. */
  async probeAdmin(daemonId: string): Promise<void> {
    const daemon = this.daemon(daemonId);
    const st = this.state(daemonId);
    if (!daemon || daemon.managed === 'local-container' || st.adminState !== 'unknown') return;
    if (this.deps.policyDenial?.(daemon)) return;
    if (!this.deps.capabilitiesOf(daemonId)?.includes(MCP_SYNC_CAPABILITY)) return;
    const transport = this.deps.transportFor(daemon);
    if (!transport?.probeAdmin) return;
    try {
      st.adminState = (await transport.probeAdmin()) ? 'yes' : 'no';
      this.emit(daemonId);
    } catch { /* unreachable now: ask again later */ }
  }

  entryOf(daemonId: string, name: string): DaemonMcpSyncEntry | undefined { return this.daemon(daemonId)?.mcpSync?.[name]; }

  /** Opted in, but the definition changed since the user confirmed it. */
  needsConfirmation(daemonId: string, name: string): boolean {
    const entry = this.entryOf(daemonId, name);
    const ev = this.evaluate(name);
    return !!entry?.enabled && !!ev && !ev.blocked && entry.confirmedHash !== ev.hash;
  }

  statusOf(daemonId: string, name: string): McpSyncServerStatus {
    const entry = this.entryOf(daemonId, name);
    if (!entry?.enabled) return { state: 'off' };
    return this.state(daemonId).statuses[name] ?? this.computeStatus(daemonId, name);
  }

  private computeStatus(daemonId: string, name: string): McpSyncServerStatus {
    const ev = this.evaluate(name);
    if (!ev) return { state: 'error', reason: 'this server no longer exists in Settings' };
    if (ev.blocked) return { state: 'blocked', code: ev.blocked.code, reason: ev.blocked.reason };
    if (this.needsConfirmation(daemonId, name)) return { state: 'needs-confirm' };
    return { state: 'pending' };
  }

  /** Names the daemon is running for this install (accepted by its last reply). */
  syncedNamesOf(daemonId: string): ReadonlySet<string> { return this.state(daemonId).accepted; }

  /** Why an opted-in server is not (yet) running on this daemon, for the transcript note; undefined when it is or was never asked for. */
  unsyncedReasonOf(daemonId: string, name: string): string | undefined {
    if (!this.entryOf(daemonId, name)?.enabled || this.state(daemonId).accepted.has(name)) return undefined;
    const st = this.statusOf(daemonId, name);
    switch (st.state) {
      case 'blocked': case 'rejected': case 'error': return st.reason;
      case 'needs-confirm': return 'its definition changed and has not been confirmed for this daemon (Settings, MCP)';
      case 'missing-secret': return `the secret ${st.names.join(', ')} is not set on this computer`;
      case 'pending': return 'it has not been synced to this daemon yet';
      default: return undefined;
    }
  }

  // ── changes ─────────────────────────────────────────────────────────────────

  /** Turn a server off or on for a daemon. Turning on records the confirmed hash (the caller shows the confirmation first). */
  async setEnabled(daemonId: string, name: string, enabled: boolean, confirmedHash?: string): Promise<void> {
    const daemon = this.daemon(daemonId);
    if (!daemon) return;
    const map = daemon.mcpSync ?? (daemon.mcpSync = {});
    if (!enabled) {
      // Keep the confirmation so turning it back on with an unchanged definition needs no second prompt.
      map[name] = { ...(map[name] ?? {}), enabled: false };
    } else {
      map[name] = { enabled: true, ...(confirmedHash ?? map[name]?.confirmedHash ? { confirmedHash: confirmedHash ?? map[name]?.confirmedHash } : {}) };
    }
    await this.deps.saveSettings();
    this.state(daemonId).statuses = {};
    this.emit(daemonId);
    this.schedule(daemonId, 'normal', 0);
  }

  /** Settings changed (a server edited or removed, a secret changed): re-evaluate every daemon with opt-ins. */
  onSettingsChanged(): void {
    for (const d of this.deps.daemons()) {
      if (this.hasHistory(d) || this.optedIn(d).length) this.schedule(d.id, 'normal');
    }
  }

  /** The daemon (re)connected: its admin state may differ and its credentials may have lapsed. */
  onConnected(daemonId: string): void {
    const st = this.state(daemonId);
    st.adminState = 'unknown';
    const d = this.daemon(daemonId);
    if (d && (this.hasHistory(d) || this.optedIn(d).length)) this.schedule(daemonId, 'force', 0);
    else void this.probeAdmin(daemonId);
  }

  /** "Push now": send definitions and credentials again regardless of what was sent before. */
  pushNow(daemonId: string): Promise<void> { return this.sync(daemonId, 'force'); }

  /** Before a thread starts on the daemon: repeat the sync if it is old or failed. Never throws, bounded wait. */
  async ensureFresh(daemonId: string, timeoutMs = 8_000): Promise<void> {
    const d = this.daemon(daemonId);
    if (!d || !this.optedIn(d).length) return;
    const last = this.lastKey.get(daemonId);
    const st = this.state(daemonId);
    if (st.phase === 'ok' && last && this.now() - last.at < FRESH_MS && !this.signatureChanged(daemonId)) return;
    await Promise.race([this.sync(daemonId, 'normal'), new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  }

  private optedIn(d: RemoteDaemonConfig): string[] {
    return Object.entries(d.mcpSync ?? {}).filter(([, e]) => e.enabled).map(([n]) => n);
  }
  private hasHistory(d: RemoteDaemonConfig): boolean { return (d.mcpSyncKinds?.length ?? 0) > 0 || (d.mcpSyncNames?.length ?? 0) > 0; }

  private schedule(daemonId: string, mode: 'normal' | 'force', delayMs = SYNC_DEBOUNCE_MS): void {
    const prev = this.timers.get(daemonId);
    if (prev) clearTimeout(prev);
    const effective = mode === 'force' || this.again.get(daemonId) === 'force' ? 'force' : 'normal';
    this.again.set(daemonId, effective);
    this.timers.set(daemonId, setTimeout(() => {
      this.timers.delete(daemonId);
      const m = this.again.get(daemonId) ?? 'normal';
      this.again.delete(daemonId);
      void this.sync(daemonId, m);
    }, delayMs));
  }

  /** Serialised per daemon: a call during a run waits for it and then runs once more. */
  sync(daemonId: string, mode: 'normal' | 'force'): Promise<void> {
    const prior = this.running.get(daemonId) ?? Promise.resolve();
    const next = prior.then(() => this.run(daemonId, mode)).catch((err) => { this.deps.log?.(`[mcp-sync] ${daemonId}: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`); });
    this.running.set(daemonId, next);
    void next.finally(() => { if (this.running.get(daemonId) === next) this.running.delete(daemonId); });
    return next;
  }

  /** Cheap signature of what a sync would send (no values): lets a normal trigger skip an unchanged state. */
  private signatureChanged(daemonId: string): boolean {
    const d = this.daemon(daemonId);
    const last = this.lastKey.get(daemonId);
    if (!d || !last) return true;
    return this.signature(d) !== last.key.split('\u0000')[0];
  }

  private signature(d: RemoteDaemonConfig): string {
    return this.optedIn(d).sort().map((n) => { const ev = this.evaluate(n); const e = d.mcpSync?.[n]; return `${n}:${ev?.hash ?? 'x'}:${e?.confirmedHash ?? ''}`; }).join(',');
  }

  // ── the sync itself ─────────────────────────────────────────────────────────

  private async run(daemonId: string, mode: 'normal' | 'force'): Promise<void> {
    const daemon = this.daemon(daemonId);
    if (!daemon) return;
    const st = this.state(daemonId);
    const wanted = this.optedIn(daemon);
    if (wanted.length === 0 && !this.hasHistory(daemon)) { st.phase = 'idle'; st.statuses = {}; st.accepted = new Set(); this.emit(daemonId); return; }

    const avail = this.availability(daemonId);
    if (!avail.ok && avail.code !== 'stdio-forbidden') {
      st.phase = 'error';
      st.error = avail.reason;
      st.statuses = Object.fromEntries(wanted.map((n) => [n, { state: 'error', reason: avail.reason } as McpSyncServerStatus]));
      this.emit(daemonId);
      return;
    }
    const transport = this.deps.transportFor(daemon);
    if (!transport) {
      st.phase = 'error';
      st.error = 'this computer cannot reach the daemon right now';
      st.statuses = Object.fromEntries(wanted.map((n) => [n, { state: 'error', reason: st.error! } as McpSyncServerStatus]));
      this.emit(daemonId);
      return;
    }

    const caps = this.deps.capabilitiesOf(daemonId) ?? [];
    const statuses: Record<string, McpSyncServerStatus> = {};
    const included: ServerEvaluation[] = [];
    const secrets = new Map<string, string>();
    const missing: Record<string, string[]> = {};
    try {
      for (const name of wanted) {
        const ev = this.evaluate(name);
        if (!ev) { statuses[name] = { state: 'error', reason: 'this server no longer exists in Settings' }; continue; }
        if (ev.blocked) { statuses[name] = { state: 'blocked', code: ev.blocked.code, reason: ev.blocked.reason }; continue; }
        if (daemon.mcpSync?.[name]?.confirmedHash !== ev.hash) { statuses[name] = { state: 'needs-confirm' }; continue; }
        if (ev.stored?.type === 'stdio' && !caps.includes(MCP_SYNC_STDIO_CAPABILITY)) {
          statuses[name] = { state: 'blocked', code: 'invalid', reason: 'this daemon does not accept programs from the app (allowSyncedStdio is off)' };
          continue;
        }
        const lacking = ev.secretNames.filter((n) => {
          const visible = isSecretVisibleToProject(this.deps.settings().secretEnvScopes, n, ev.limitedToProject);
          const v = visible ? this.deps.readSecret(n) : undefined;
          if (v) secrets.set(`${ev.kind}\u0000${n}`, v);
          return !v;
        });
        if (lacking.length) { statuses[name] = { state: 'missing-secret', names: lacking }; missing[name] = lacking; continue; }
        included.push(ev);
      }

      const fieldsByKind = (evs: ServerEvaluation[]): Map<string, Record<string, string>> => {
        const out = new Map<string, Record<string, string>>();
        for (const ev of evs) {
          // A server without secrets needs no kind: it must not create one (an empty push would delete the kind).
          if (ev.secretNames.length === 0) continue;
          const f = out.get(ev.kind!) ?? {};
          for (const n of ev.secretNames) f[n] = secrets.get(`${ev.kind}\u0000${n}`)!;
          out.set(ev.kind!, f);
        }
        return out;
      };
      const key = `${this.signature(daemon)}\u0000${sha256Hex(JSON.stringify([...secrets.entries()].sort()))}`;
      const last = this.lastKey.get(daemonId);
      if (mode === 'normal' && st.phase === 'ok' && last && last.key === key && this.now() - last.at < FRESH_MS) {
        st.statuses = { ...statuses, ...Object.fromEntries([...st.accepted].filter((n) => wanted.includes(n)).map((n) => [n, { state: 'synced', shadowed: st.shadowed.has(n) } as McpSyncServerStatus])) };
        this.emit(daemonId);
        return;
      }

      st.phase = 'syncing';
      this.emit(daemonId);
      const previousKinds = new Set(daemon.mcpSyncKinds ?? []);
      // 1. credentials first, so a definition never arrives before the values it needs.
      let kinds = fieldsByKind(included);
      for (const [kind, fields] of kinds) await transport.pushCreds(kind, fields, MCP_SYNC_TTL_SEC);
      // 2. definitions (full replace of the synced set).
      const servers: SyncedMcpServers = Object.fromEntries(included.map((ev) => [ev.name, ev.wire!]));
      const reply = await transport.syncServers(servers);
      const rejected = Object.fromEntries(reply.rejected.map((r) => [r.name, r.reason]));
      if (reply.kept) {
        // Every server was refused and the daemon kept what it already ran. Nothing changed there, so: no pruning of
        // credentials (the running set may still need them), no record of new names, no "synced" status, and the next
        // trigger retries instead of treating this state as fresh.
        const reason = 'the daemon refused every server and kept the previous set';
        st.phase = 'error';
        st.error = `${reason}: ${reply.rejected.map((r) => `${r.name} (${r.reason})`).join('; ').slice(0, 400)}`;
        st.rejected = rejected;
        st.adminState = 'yes';
        st.missing = missing;
        st.statuses = { ...statuses, ...Object.fromEntries(included.map((ev) => [ev.name, { state: 'rejected', reason: rejected[ev.name] ?? 'the daemon did not accept it' } as McpSyncServerStatus])) };
        this.lastKey.delete(daemonId);
        this.emit(daemonId);
        return;
      }
      const accepted = new Set(reply.accepted);
      // 3. a server the daemon refused does not keep its secrets there.
      const keep = included.filter((ev) => accepted.has(ev.name));
      if (keep.length !== included.length) {
        kinds = fieldsByKind(keep);
        for (const kind of new Set(included.filter((e) => e.secretNames.length).map((e) => e.kind!))) await transport.pushCreds(kind, kinds.get(kind) ?? {}, MCP_SYNC_TTL_SEC);
      }
      // 4. kinds that are no longer used are removed (an empty push deletes the kind).
      for (const kind of previousKinds) if (!kinds.has(kind)) await transport.pushCreds(kind, {}, 0);

      for (const ev of included) {
        statuses[ev.name] = accepted.has(ev.name)
          ? { state: 'synced', shadowed: reply.shadowed.includes(ev.name) }
          : { state: 'rejected', reason: rejected[ev.name] ?? 'the daemon did not accept it' };
      }
      st.phase = 'ok';
      st.error = undefined;
      st.at = this.now();
      st.accepted = accepted;
      st.rejected = rejected;
      st.shadowed = new Set(reply.shadowed);
      st.missing = missing;
      st.adminState = 'yes';
      st.statuses = statuses;
      this.lastKey.set(daemonId, { key, at: this.now() });
      const nextKinds = [...kinds.keys()].sort();
      const nextNames = [...accepted].sort();
      if (JSON.stringify(nextKinds) !== JSON.stringify(daemon.mcpSyncKinds ?? []) || JSON.stringify(nextNames) !== JSON.stringify(daemon.mcpSyncNames ?? [])) {
        daemon.mcpSyncKinds = nextKinds;
        daemon.mcpSyncNames = nextNames;
        await this.deps.saveSettings();
      }
      this.emit(daemonId);
    } catch (err) {
      const all = [...secrets.values()];
      const raw = err instanceof NeedsAdminError ? err.message : err instanceof Error ? err.message : String(err);
      const reason = scrubSecrets(raw, all);
      if (err instanceof NeedsAdminError) st.adminState = 'no';
      st.phase = 'error';
      st.error = reason;
      // Nothing is known to be running now: assume the worst for the transcript note.
      st.accepted = new Set();
      st.statuses = { ...statuses, ...Object.fromEntries(included.map((e) => [e.name, { state: 'error', reason } as McpSyncServerStatus])) };
      this.lastKey.delete(daemonId);
      this.deps.log?.(`[mcp-sync] ${daemon.name}: ${reason.slice(0, 200)}`);
      this.emit(daemonId);
    }
  }
}

/** Drop opt-ins for servers that no longer exist and shape-check what data.json held. Idempotent. */
export function normalizeDaemonMcpSync(daemons: RemoteDaemonConfig[], serverNames: ReadonlySet<string>): void {
  for (const d of daemons) {
    const raw = d.mcpSync as unknown;
    if (raw === undefined) continue;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { delete d.mcpSync; continue; }
    const clean: Record<string, DaemonMcpSyncEntry> = {};
    for (const [name, e] of Object.entries(raw as Record<string, unknown>)) {
      if (!serverNames.has(name) || !e || typeof e !== 'object') continue;
      const entry = e as Partial<DaemonMcpSyncEntry>;
      clean[name] = { enabled: entry.enabled === true, ...(typeof entry.confirmedHash === 'string' ? { confirmedHash: entry.confirmedHash } : {}) };
    }
    d.mcpSync = clean;
    if (!Array.isArray(d.mcpSyncKinds)) delete d.mcpSyncKinds; else d.mcpSyncKinds = d.mcpSyncKinds.filter((k) => typeof k === 'string');
    if (!Array.isArray(d.mcpSyncNames)) delete d.mcpSyncNames; else d.mcpSyncNames = d.mcpSyncNames.filter((k) => typeof k === 'string');
  }
}

/**
 * Pushing allowlisted secrets from this computer to a REMOTE daemon (design "Secret push to remote daemons").
 *
 * Push only: the host decides what leaves, per daemon, by name (`RemoteDaemonConfig.pushedSecrets`). Mirrors what the
 * managed local daemon does (`localDaemon/sessionPrep.ts` + `credsPusher.ts`): resolve the project's environment, keep
 * the forwardable variables the daemon's allowlist names, push them as the credential kind `sessenv-<project>` with the
 * existing `creds.push` command, and put only the kind's NAME in the session spec (`envKind`); the daemon reads the
 * values itself when the session starts.
 *
 *   - `creds.push` needs an admin token. The everyday token is `control`, so a SEPARATE optional admin token lives in
 *     the keychain (`adminTokenSecretNameFor`) and is used only by the short-lived connection that pushes. No admin
 *     token means no push and a warning.
 *   - Never over plain ws:// to a host that is not this computer.
 *   - Every push has a short TTL and is refreshed; dropping a name from the allowlist, removing the daemon, or quitting
 *     re-pushes the kind without it (empty fields delete the kind); the TTL covers a daemon that is away.
 *   - Values are never logged and are redacted from every error text.
 *
 * `prepare()` never throws; a failure is a warning and the session starts without the secrets.
 */
import { CredsSink, EnvKindDelivery, forwardableEnv, sessionEnvKind } from '../credsDelivery';
import { SESSION_ENV_KIND_PATTERN } from '../protocol/spec';
import { redactSecrets } from '../secretRedaction';
import type { RemoteDaemonConfig } from '../types';
import { isLoopbackHost } from './daemonConfig';

/** How long a pushed environment is honoured by the daemon. Refreshed at half this age and at every session start. */
export const REMOTE_SECRET_TTL_SEC = 60 * 60;
const PUSH_TIMEOUT_MS = 10_000;
/** Quit must not hang on an unreachable daemon: the TTL deletes what could not be revoked. */
const REVOKE_TIMEOUT_MS = 3_000;
const REVOKE_TTL_SEC = 60;

/** The part of `DaemonClient` this module uses; lets tests (and a differently authenticated client) stand in. */
export interface PushClient {
  command(type: 'creds.push', payload: { kind: string; ttlSec: number; fields: Record<string, string> }, opts?: { timeoutMs?: number }): Promise<unknown>;
  dispose(): void;
}

// ── allowlist ────────────────────────────────────────────────────────────────

/**
 * The part of `env` this daemon's allowlist names for `projectId`: forwardable variables only. An entry `NAME` applies
 * to every project, `<project>/NAME` to that project only, so one project's secret cannot reach a daemon through
 * another project's session.
 */
export function filterAllowlisted(env: Readonly<Record<string, string | undefined>>, allowlist: readonly string[], projectId: string | undefined): Record<string, string> {
  const allowed = new Set<string>();
  for (const entry of allowlist) {
    const slash = entry.indexOf('/');
    if (slash < 0) { allowed.add(entry); continue; }
    if (projectId !== undefined && entry.slice(0, slash) === projectId) allowed.add(entry.slice(slash + 1));
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(forwardableEnv(env))) if (allowed.has(name)) out[name] = value;
  return out;
}

// ── transport guard ──────────────────────────────────────────────────────────

/**
 * Throws unless secrets may safely cross to `rawUrl`: wss:// / https://, or any scheme to this computer's loopback.
 * Stricter than the Settings warning (which tolerates a tailnet): a secret is never sent in the clear to another host.
 */
export function assertSecureTransportForPush(rawUrl: string): void {
  const raw = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `ws://${raw}`);
  } catch {
    throw new Error('the daemon address is not a valid URL, so no secrets were sent');
  }
  if (parsed.protocol === 'wss:' || parsed.protocol === 'https:') return;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isLoopbackHost(host)) return;
  throw new Error(`secrets are never sent over unencrypted ${parsed.protocol}// to ${host}: use a wss:// address (for example through \`tailscale serve\`)`);
}

// ── sink ─────────────────────────────────────────────────────────────────────

/** A `CredsSink` that sends `creds.push` over an authenticated daemon connection. Only `sessenv-*` kinds. */
export class RemoteWsSink implements CredsSink {
  constructor(
    private readonly client: Pick<PushClient, 'command'>,
    /** Extra strings to mask in error text besides the pushed values (the admin token). */
    private readonly extraSecrets: () => readonly string[] = () => [],
  ) {}

  async push(kind: string, fields: Record<string, string>, ttlSec: number): Promise<void> {
    if (!SESSION_ENV_KIND_PATTERN.test(kind)) throw new Error(`only session environment kinds (sessenv-...) are pushed to remote daemons, not "${kind.slice(0, 40)}"`);
    try {
      await this.client.command('creds.push', { kind, ttlSec, fields }, { timeoutMs: Object.keys(fields).length === 0 ? REVOKE_TIMEOUT_MS : PUSH_TIMEOUT_MS });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`pushing "${kind}" to the remote daemon failed: ${redactSecrets(detail, [...Object.values(fields), ...this.extraSecrets()])}`);
    }
  }

  /** Empty fields delete the kind on the daemon (no new wire variant); never throws. */
  async remove(kind: string): Promise<void> {
    try { await this.push(kind, {}, REVOKE_TTL_SEC); } catch { /* the TTL covers it */ }
  }
}

// ── orchestration ────────────────────────────────────────────────────────────

export interface RemoteSecretPushDeps {
  daemons(): readonly RemoteDaemonConfig[];
  /** The separate admin token from the keychain; undefined when none is stored. */
  adminToken(daemon: RemoteDaemonConfig): string | undefined;
  /** Extra environment variables plus the keychain secrets visible to `projectId`, as a host session would get them. */
  resolveEnv(projectId: string | undefined): Record<string, string>;
  /** A client authenticated with `adminToken` for `daemon`. Disposed by this class. */
  createClient(daemon: RemoteDaemonConfig, adminToken: string): PushClient;
  /** Managed policy: why this daemon must not be connected to at all, or undefined (docs/managed-policy.md). */
  policyDenial?(daemon: RemoteDaemonConfig): string | undefined;
  now?(): number;
  log?(message: string): void;
}

export interface RemoteSecretPrep {
  /** Name of the pushed kind for the session spec's `envKind`; absent when nothing was pushed. */
  envKind?: string;
  warnings: string[];
}

interface DaemonState {
  signature: string;
  client: PushClient;
  delivery: EnvKindDelivery;
  /** kind -> project it was built for, so a settings change can be re-evaluated without a session. */
  projects: Map<string, string | undefined>;
}

export class RemoteSecretPush {
  private readonly states = new Map<string, DaemonState>();
  /** Admin tokens seen, for masking in error text. */
  private readonly knownAdmin = new Set<string>();

  constructor(private readonly deps: RemoteSecretPushDeps) {}

  /** Pushes what `projectId`'s session on `daemonId` may have. Never throws. */
  async prepare(daemonId: string, projectId: string | undefined): Promise<RemoteSecretPrep> {
    const cfg = this.deps.daemons().find((d) => d.id === daemonId);
    const allowlist = cfg?.pushedSecrets ?? [];
    // A daemon the administrator disallowed is never contacted, not even to revoke: the pushed kind's TTL covers that.
    const denied = cfg ? this.deps.policyDenial?.(cfg) : undefined;
    if (cfg && denied) {
      this.dropState(daemonId);
      return { warnings: [`Secrets for "${cfg.name}" were not sent: ${denied}`] };
    }
    if (!cfg || allowlist.length === 0) {
      await this.revokeDaemon(daemonId);
      return { warnings: [] };
    }
    const fail = (message: string): RemoteSecretPrep => {
      this.deps.log?.(`[remote-secrets] ${cfg.name}: ${message}`);
      return { warnings: [`Secrets for "${cfg.name}" were not sent: ${message}`] };
    };
    const admin = this.deps.adminToken(cfg);
    let env: Record<string, string> = {};
    try {
      assertSecureTransportForPush(cfg.url);
      if (!admin) return fail('no admin token is stored for this daemon. Pushing needs one (agent-threads token create --scope admin); add it in Settings, Remote daemons, Edit.');
      this.knownAdmin.add(admin);
      env = filterAllowlisted(this.deps.resolveEnv(projectId), allowlist, projectId);
      const state = this.stateFor(cfg, admin);
      const kind = sessionEnvKind(projectId);
      state.projects.set(kind, projectId);
      const present = await state.delivery.deliver(kind, env, REMOTE_SECRET_TTL_SEC);
      if (present) this.deps.log?.(`[remote-secrets] ${cfg.name}: ${Object.keys(env).length} secret(s) available as ${kind} (${Object.keys(env).sort().join(', ')})`);
      return present ? { envKind: kind, warnings: [] } : { warnings: [] };
    } catch (err) {
      return fail(this.redact(err, env));
    }
  }

  /**
   * Settings changed (allowlist edited, daemon removed, admin token cleared): bring every pushed kind in line, which
   * re-pushes it without the revoked names or deletes it. Never throws.
   */
  async reconcile(): Promise<void> {
    for (const [daemonId, state] of [...this.states]) {
      const cfg = this.deps.daemons().find((d) => d.id === daemonId);
      if (cfg && this.deps.policyDenial?.(cfg)) { this.dropState(daemonId); continue; }
      const allowlist = cfg?.pushedSecrets ?? [];
      const admin = cfg ? this.deps.adminToken(cfg) : undefined;
      for (const [kind, projectId] of [...state.projects]) {
        let env: Record<string, string> = {};
        try {
          if (cfg && admin && allowlist.length > 0) env = filterAllowlisted(this.deps.resolveEnv(projectId), allowlist, projectId);
          await state.delivery.deliver(kind, env, REMOTE_SECRET_TTL_SEC);
          if (Object.keys(env).length === 0) state.projects.delete(kind);
        } catch (err) {
          this.deps.log?.(`[remote-secrets] ${cfg?.name ?? daemonId}: could not update ${kind}: ${this.redact(err, env)}`);
        }
      }
      if (!cfg) this.dropState(daemonId);
    }
  }

  /** Revokes everything pushed (best effort, bounded) and closes the connections. For app quit. */
  async stop(): Promise<void> {
    await Promise.all([...this.states.keys()].map((id) => {
      const cfg = this.deps.daemons().find((d) => d.id === id);
      if (cfg && this.deps.policyDenial?.(cfg)) { this.dropState(id); return Promise.resolve(); }
      return this.revokeDaemon(id);
    }));
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private stateFor(cfg: RemoteDaemonConfig, admin: string): DaemonState {
    const signature = `${cfg.url}\n${admin}`;
    const existing = this.states.get(cfg.id);
    if (existing && existing.signature === signature) return existing;
    // A new address or admin token: what the old one holds is only reachable through it, so revoke through it first.
    if (existing) void existing.delivery.stop().finally(() => existing.client.dispose());
    const client = this.deps.createClient(cfg, admin);
    const sink = new RemoteWsSink(client, () => [...this.knownAdmin]);
    const state: DaemonState = {
      signature,
      client,
      delivery: new EnvKindDelivery(sink, { refreshMs: (REMOTE_SECRET_TTL_SEC * 1000) / 2, now: this.deps.now }),
      projects: new Map(),
    };
    this.states.set(cfg.id, state);
    return state;
  }

  private async revokeDaemon(daemonId: string): Promise<void> {
    const state = this.states.get(daemonId);
    if (!state) return;
    try { await state.delivery.stop(); } finally { this.dropState(daemonId); }
  }

  private dropState(daemonId: string): void {
    const state = this.states.get(daemonId);
    if (!state) return;
    this.states.delete(daemonId);
    try { state.client.dispose(); } catch { /* closing */ }
  }

  private redact(err: unknown, env: Readonly<Record<string, string>>): string {
    return redactSecrets(err instanceof Error ? err.message : String(err), [...Object.values(env), ...this.knownAdmin]);
  }
}

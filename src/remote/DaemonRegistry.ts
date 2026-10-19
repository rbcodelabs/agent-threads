/**
 * DaemonRegistry
 *
 * Owns one `DaemonClient` per configured remote daemon (Settings -> Remote
 * daemons) and hands them to `HarnessFactory`. A client is created on first
 * use and rebuilt when its URL or token secret name changes; a token VALUE
 * change is picked up at the next reconnect because `getToken` is read then.
 */
import type { RemoteDaemonConfig, RemoteHostToolsSettings, RemoteVaultMapping } from '../types';
import type { McpSyncView } from './mcpPartition';
import type { RemoteMount } from './sessionSpec';
import { DaemonClient, daemonWsUrl, type ConnectionState, type WebSocketFactory } from './DaemonClient';

/** What `HarnessFactory` / `ThreadManager` need; implemented by `DaemonRegistry`. */
export interface RemoteDaemonResolver {
  clientFor(daemonId: string): DaemonClient | undefined;
  /** Display name for UI / prompts; falls back to the id for a removed daemon. */
  nameOf(daemonId: string): string;
  /** Where the vault is mirrored on that daemon, if configured. */
  vaultMappingOf?(daemonId: string): RemoteVaultMapping | undefined;
  /** Host folders mounted into that daemon's machine (local daemon only); undefined = none known. */
  mountsOf?(daemonId: string): readonly RemoteMount[] | undefined;
  /** What the daemon may do on this computer (host tools, MCP allowlist); undefined = defaults. */
  hostToolsOf?(daemonId: string): RemoteHostToolsSettings | undefined;
  /** Which Settings MCP servers the daemon runs from the app's sync (and why the others are not); undefined = none known. */
  mcpSyncOf?(daemonId: string): McpSyncView | undefined;
  /** `welcome.capabilities` of the last connection, or undefined while the daemon has not been reached yet. */
  capabilitiesOf?(daemonId: string): string[] | undefined;
  /** Start connecting (if not already) and resolve once connected, failed for good, or `timeoutMs` passed. Never rejects. */
  warm?(daemonId: string, timeoutMs?: number): Promise<void>;
}

export interface DaemonRegistryOptions {
  getDaemons: () => RemoteDaemonConfig[];
  /** Resolve the keychain secret for a daemon; undefined when none is stored. */
  getToken: (daemon: RemoteDaemonConfig) => string | undefined;
  createSocket: WebSocketFactory;
  clientVersion: string;
  /** This install's stable id, sent in `hello` so the daemon can tell installs sharing a token apart. */
  getInstanceId?: () => string | undefined;
  /** Mounts of a managed daemon, if this host knows them (the local daemon's controller). */
  getMounts?: (daemonId: string) => readonly RemoteMount[] | undefined;
  /** MCP servers synced to a daemon (see `mcpSync.ts`). */
  getMcpSync?: (daemonId: string) => McpSyncView | undefined;
  log?: (message: string) => void;
}

interface Entry {
  signature: string;
  client: DaemonClient;
  unsubscribe: () => void;
}

export class DaemonRegistry implements RemoteDaemonResolver {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(daemonId: string, state: ConnectionState) => void>();
  private disposed = false;

  constructor(private readonly opts: DaemonRegistryOptions) {}

  private config(daemonId: string): RemoteDaemonConfig | undefined {
    return this.opts.getDaemons().find((d) => d.id === daemonId);
  }

  nameOf(daemonId: string): string {
    return this.config(daemonId)?.name ?? daemonId;
  }

  vaultMappingOf(daemonId: string): RemoteVaultMapping | undefined {
    return this.config(daemonId)?.vaultMapping;
  }

  mountsOf(daemonId: string): readonly RemoteMount[] | undefined {
    return this.opts.getMounts?.(daemonId);
  }

  hostToolsOf(daemonId: string): RemoteHostToolsSettings | undefined {
    return this.config(daemonId)?.hostTools;
  }

  mcpSyncOf(daemonId: string): McpSyncView | undefined {
    return this.opts.getMcpSync?.(daemonId);
  }

  capabilitiesOf(daemonId: string): string[] | undefined {
    return this.entries.get(daemonId)?.client.daemonInfo?.capabilities;
  }

  warm(daemonId: string, timeoutMs = 4000): Promise<void> {
    const client = this.clientFor(daemonId);
    if (!client) return Promise.resolve();
    if (client.daemonInfo) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let off: (() => void) | undefined;
      const done = (): void => { clearTimeout(timer); off?.(); resolve(); };
      const timer = setTimeout(done, timeoutMs);
      off = client.onState((s) => {
        if (s.info || s.status === 'unreachable' || s.status === 'unauthorized' || s.status === 'incompatible' || s.status === 'closed') done();
      });
      client.connect();
    });
  }

  clientFor(daemonId: string): DaemonClient | undefined {
    if (this.disposed) return undefined;
    const cfg = this.config(daemonId);
    if (!cfg) return undefined;
    const signature = `${cfg.url}\n${cfg.tokenSecretName}`;
    const existing = this.entries.get(daemonId);
    if (existing && existing.signature === signature) return existing.client;
    existing?.unsubscribe();
    existing?.client.dispose();
    const client = new DaemonClient({
      url: daemonWsUrl(cfg.url),
      getToken: () => this.opts.getToken(cfg),
      createSocket: this.opts.createSocket,
      clientVersion: this.opts.clientVersion,
      instanceId: this.opts.getInstanceId?.(),
      log: this.opts.log,
    });
    const unsubscribe = client.onState((s) => {
      for (const l of [...this.listeners]) l(daemonId, s);
    });
    this.entries.set(daemonId, { signature, client, unsubscribe });
    return client;
  }

  /** Current state of a daemon's connection, `undefined` if it has never been used. */
  stateOf(daemonId: string): ConnectionState | undefined {
    return this.entries.get(daemonId)?.client.connection;
  }

  onState(listener: (daemonId: string, state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Settings changed: drop clients for removed daemons, retry ones that were failing on bad config. */
  refresh(): void {
    const live = new Set(this.opts.getDaemons().map((d) => d.id));
    for (const [id, entry] of [...this.entries]) {
      if (!live.has(id)) {
        entry.unsubscribe();
        entry.client.dispose();
        this.entries.delete(id);
        continue;
      }
      const status = entry.client.connection.status;
      if (status === 'unauthorized' || status === 'incompatible' || status === 'unreachable') entry.client.reconnectNow();
    }
  }

  disposeAll(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.unsubscribe();
      entry.client.dispose();
    }
    this.entries.clear();
    this.listeners.clear();
  }
}

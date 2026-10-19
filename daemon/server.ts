/**
 * HTTP + WebSocket server: `GET /healthz`, `GET /v1/ws`.
 *
 * Everything pre-authentication is deliberately cheap and stateless: origin
 * check, per-IP failure throttle, path check. Credentials are only ever read
 * from the first `hello` frame or an `Authorization: Bearer` header, never the
 * URL, so tokens do not end up in proxy logs.
 */
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '../src/protocol';
import { AuditLog } from './auditLog';
import { CommandCache } from './cmdCache';
import { isLoopbackAddress, isWildcardAddress, loadOrCreateDaemonId, updateConfigFile, type DaemonConfig } from './config';
import { createGhAuthPreflight } from './ghPreflight';
import { createClaudeDriverFactory, describeCredentialSource, resolveCredentialEnv, sessionEnvFromCreds } from './claudeDriver';
import { HARNESS_BINARY, HARNESS_SECRET_ENV, describeHarnessCredential, findHarnessBinary, harnessCapabilities, type RealHarness } from './harnesses';
import { describePathAccess, withRepoRoot, type SessionPolicy } from './sessionPolicy';
import { ReposManager } from './repos';
import { SyncedMcpStore } from './syncedMcp';
import { pruneIdleWorktrees } from './worktreePrune';
import { listSubfolders, listWorkspaces } from './workspaces';
import { Connection, DEFAULT_TIMINGS, MAX_OUTBOUND_BYTES, PRE_AUTH_MAX_FRAME_BYTES, capabilitiesFor, type ServerContext, type Timings } from './connection';
import { ControlRegistry } from './controlRegistry';
import { fakeHarnessFactory } from './fakeHarness';
import { FailureThrottle } from './failureThrottle';
import { CredStore } from './credStore';
import { ensureDir } from './fsutil';
import { sweepRawLogs } from './logRetention';
import type { DriverFactory } from './sessionDriver';
import { ThreadHost } from './threadHost';
import { RawLogWriter } from '../src/RawLogWriter';
import { setKnownSecretsProvider } from '../src/secretRedaction';
import { TokenStore } from './tokenStore';
import { DAEMON_VERSION } from './version';

export interface DaemonOptions {
  config: DaemonConfig;
  driverFactory?: DriverFactory;
  timings?: Partial<Timings>;
  journalFlushMs?: number;
  /** Test seam: idle window in ms, overriding `config.idleReapMinutes`. */
  idleReapMs?: number;
  /** How often the idle reaper looks (default: half the idle window, at most a minute). */
  reapCheckMs?: number;
  maxOutboundBytes?: number;
  /** Test seams: host-tool grace and answer timeouts in ms, overriding `config.hostToolGraceSec` / `hostToolTimeoutSec`. */
  hostToolGraceMs?: number;
  hostToolTimeoutMs?: number;
  /** Test seam: wall clock for journal timestamps and TTL (default `Date.now`). */
  now?: () => number;
  /** Test seam: journal retention overriding `config.journalTtlDays` / `journalMaxMb`. */
  journalLimits?: { maxAgeMs?: number; maxBytes?: number };
  /** How often journals are compacted for TTL/size regardless of acks (default 5 min). */
  maintenanceMs?: number;
  throttle?: FailureThrottle;
  /**
   * Apply the per-address failure throttle to loopback peers too (default false). Behind `tailscale serve`
   * or a reverse proxy every client arrives from 127.0.0.1, so throttling loopback would let one peer's
   * bad tokens lock the owner out; off by default, on in tests that exercise the throttle.
   */
  throttleLoopback?: boolean;
  /** Test seam: audit log tuning. */
  audit?: ConstructorParameters<typeof AuditLog>[1];
  log?: (line: string) => void;
}

export interface DaemonHandle {
  readonly host: string;
  readonly port: number;
  readonly epoch: string;
  readonly daemonId: string;
  readonly url: string;
  readonly tokens: TokenStore;
  readonly threads: ThreadHost;
  /** The repositories this daemon keeps cloned. */
  readonly repos: ReposManager;
  /** Resolves when the start-up worktree prune and first repo sync have finished (they run in the background). */
  readonly startup: Promise<void>;
  /** Thread ids whose in-flight turn was closed out during startup recovery. */
  readonly recovered: string[];
  /** Graceful: close sockets, flush + fsync journals. */
  stop(): Promise<void>;
  /** Test hook: behave like SIGKILL; unflushed journal data is lost. */
  crash(): Promise<void>;
}

/** Sockets that have not authenticated yet, at most. */
export const MAX_UNAUTHENTICATED_CONNECTIONS = 16;

/** Is the peer on this machine? (`::ffff:127.0.0.1` is how Node reports IPv4 loopback on a dual-stack socket.) */
export function isLoopbackPeer(ip: string): boolean {
  return ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127.');
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const { config } = options;
  const log = options.log ?? (() => {});
  ensureDir(config.dataDir);
  ensureDir(join(config.dataDir, 'journal'));
  const daemonId = loadOrCreateDaemonId(config.dataDir);
  const epoch = randomUUID();
  // Throws on a corrupt tokens.json: a startup failure, reported and fatal. Later corruption fails closed (tokenStore.ts).
  const tokens = new TokenStore(config.dataDir, undefined, (l) => (options.log ?? console.error)(l));
  // Who did what, never content. Batched and rotated; best effort (audit failure must not take the daemon down).
  const auditLog = new AuditLog(join(config.dataDir, 'audit.ndjson'), options.audit);
  const audit = (record: Record<string, unknown>): void => auditLog.record(record);
  const rawLogLimits = {
    ...(config.journalTtlDays > 0 || options.journalLimits?.maxAgeMs !== undefined ? { maxAgeMs: options.journalLimits?.maxAgeMs ?? config.journalTtlDays * 86_400_000 } : {}),
    ...(config.journalMaxMb > 0 || options.journalLimits?.maxBytes !== undefined ? { maxBytes: options.journalLimits?.maxBytes ?? config.journalMaxMb * 1024 * 1024 } : {}),
  };
  const logsDir = join(config.dataDir, 'logs');

  const creds = new CredStore(config.dataDir, options.now);
  ensureDir(creds.dir);
  const real = config.harness !== 'fake';
  // Repositories kept cloned under config.repoRoot. The list lives in config.json (changed by `repos.sync`).
  let repoList = config.repos;
  const repos = new ReposManager({
    dataDir: config.dataDir,
    root: config.repoRoot,
    creds,
    getRepos: () => repoList,
    setRepos: (next) => { repoList = next; updateConfigFile(config.dataDir, { repos: next }); },
    allowLocalUrls: config.allowLocalRepoUrls,
    ...(options.now ? { now: options.now } : {}),
    log,
  });
  const syncedMcp = new SyncedMcpStore(config.dataDir, { allowStdio: config.allowSyncedStdio, commandAllowlist: config.syncedCommandAllowlist }, options.now);
  let driverFactory = options.driverFactory;
  let rawLog: ((threadId: string, event: Record<string, unknown>) => void) | undefined;
  if (real) {
    const env = process.env;
    // Raw SDK events -> <dataDir>/logs/<threadId>.jsonl (full fidelity, secrets masked). Never on the wire.
    // The directory is 0700 so the log files inside are private whatever mode appendFile gives them
    // (a process-wide umask would instead leak into every file the agent creates in a workspace).
    ensureDir(join(config.dataDir, 'logs'));
    const writer = new RawLogWriter(() => config.dataDir, () => '.');
    rawLog = (threadId, event) => {
      const type = typeof event.type === 'string' ? event.type : 'event';
      if (!RawLogWriter.shouldLog(type)) return;
      writer.append(threadId, typeof event.session_id === 'string' ? event.session_id : undefined, type, event);
    };
    const credentialEnv = resolveCredentialEnv(env);
    setKnownSecretsProvider(() => [env.CLAUDE_CODE_OAUTH_TOKEN, env.ANTHROPIC_API_KEY, credentialEnv.CLAUDE_CODE_OAUTH_TOKEN, ...HARNESS_SECRET_ENV.map((k) => env[k]), ...creds.secretValues(), ...repos.envSecretValues()].filter((v): v is string => !!v));
    if (!driverFactory) {
      driverFactory = createClaudeDriverFactory({ claudeBinaryPath: config.claudeBinaryPath, codexBinaryPath: config.codexBinaryPath, opencodeBinaryPath: config.opencodeBinaryPath, env, mcpServers: config.mcpServers, syncedMcp, creds, requestTimeoutMs: config.requestTimeoutMinutes * 60_000, sessionEnv: (spec) => ({ ...repos.sessionEnv(), ...sessionEnvFromCreds(creds, spec) }), onSessionStart: (cwd) => repos.refreshForCwd(cwd), authPreflight: createGhAuthPreflight({ hasToken: () => repos.hasToken() }) });
      const explicit: Record<RealHarness, string | undefined> = { claude: config.claudeBinaryPath, codex: config.codexBinaryPath, opencode: config.opencodeBinaryPath };
      for (const kind of config.harnesses) {
        const b = HARNESS_BINARY[kind];
        const binary = findHarnessBinary(kind, explicit[kind], env);
        log(binary ? `${b.exe} CLI: ${binary}` : `WARNING: ${b.exe} CLI not found; ${kind} sessions will fail until it is installed (or set ${b.configKey} / ${b.envVar})`);
        log(`${kind} credential: ${kind === 'claude' ? describeCredentialSource(env) : describeHarnessCredential(kind, env)}`);
      }
    }
    log(`harnesses: ${config.harnesses.join(', ')} (default ${config.harness}); workspaces: ${config.workspaces.join(', ') || '(none)'}${config.readOnlyWorkspaces.length ? `; read-only workspaces: ${config.readOnlyWorkspaces.join(', ')}` : ''}; bypassPermissions ${config.allowBypass ? 'ALLOWED' : 'refused'}; maxConcurrentTurns ${config.maxConcurrentTurns}; maxLiveSessions ${config.maxLiveSessions}; client env ${config.allowedClientEnv.length ? `limited to ${config.allowedClientEnv.join(', ')}` : 'ignored'}; idle reap ${config.idleReapMinutes ? `${config.idleReapMinutes} min` : 'off'}`);
  }

  const configuredPolicy: SessionPolicy = { workspaces: config.workspaces, readOnlyWorkspaces: config.readOnlyWorkspaces, allowBypass: config.allowBypass, allowedClientEnv: config.allowedClientEnv, harnesses: config.harnesses, pluginRoot: join(config.dataDir, 'skills') };
  // The repo root is always allowed as a session folder; it is only OFFERED (workspaces.list) once something has been cloned there.
  const sessionPolicy: SessionPolicy = withRepoRoot(configuredPolicy, config.repoRoot);
  const host = new ThreadHost({
    dataDir: config.dataDir,
    epoch,
    driverFactory: driverFactory ?? fakeHarnessFactory,
    flushMs: options.journalFlushMs,
    ...(options.now ? { now: options.now } : {}),
    journalOptions: {
      ...(options.now ? { now: options.now } : {}),
      ...journalLimits(config, options.journalLimits),
    },
    // The scripted fake has no side effects, so only the real host is policed.
    ...(real ? { policy: sessionPolicy } : {}),
    cwdPolicy: sessionPolicy,
    maxConcurrentTurns: config.maxConcurrentTurns,
    maxLiveSessions: config.maxLiveSessions,
    idleReapMs: options.idleReapMs ?? config.idleReapMinutes * 60_000,
    rawLog,
    hostToolGraceMs: options.hostToolGraceMs ?? config.hostToolGraceSec * 1000,
    hostToolTimeoutMs: options.hostToolTimeoutMs ?? config.hostToolTimeoutSec * 1000,
    worktreeRoot: config.worktreeRoot ?? defaultWorktreeRoot(config),
    repoRoot: config.repoRoot,
    audit,
  });
  const controllers = new ControlRegistry();
  controllers.onChange((threadId, owner) => host.setSeatHolder(threadId, owner?.id));
  const recovered = host.recover();
  sweepRawLogs(logsDir, rawLogLimits, options.now?.());
  for (const id of recovered) log(`recovered thread ${id}: closed in-flight turn as daemon_restarted`);

  const ctx: ServerContext = {
    host,
    tokens,
    throttle: options.throttle ?? new FailureThrottle(),
    cmdCache: new CommandCache(),
    daemonId,
    epoch,
    capabilities: capabilitiesFor(config.harness, config.harnesses, config.allowSyncedStdio),
    controllers,
    creds,
    repos,
    syncedMcp,
    configuredMcpNames: () => new Set(Object.keys(config.mcpServers)),
    checkPath: (path) => describePathAccess(path, sessionPolicy),
    listWorkspaces: () => listWorkspaces(existsSync(config.repoRoot) ? sessionPolicy : configuredPolicy),
    listPath: (path) => listSubfolders(path, sessionPolicy),
    timings: { ...DEFAULT_TIMINGS, ...options.timings },
    maxOutboundBytes: options.maxOutboundBytes ?? MAX_OUTBOUND_BYTES,
    audit,
  };

  const connections = new Set<Connection>();
  // Small until `hello` succeeds (an unauthenticated peer can make us buffer at most this much per frame);
  // an authenticated connection raises its own limit (connection.ts).
  const wss = new WebSocketServer({ noServer: true, maxPayload: PRE_AUTH_MAX_FRAME_BYTES });
  const throttleExempt = (ip: string): boolean => !options.throttleLoopback && isLoopbackPeer(ip);

  const http = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      const body = JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not_found"}');
  });

  http.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const reject = (status: string, why: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
      audit({ event: 'upgrade_rejected', status, why, ip: req.socket.remoteAddress });
    };
    const path = (req.url ?? '/').split('?')[0];
    if (path !== '/v1/ws') { reject('404 Not Found', 'path'); return; }
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (!throttleExempt(ip) && ctx.throttle.isBlocked(ip)) { reject('429 Too Many Requests', 'throttled'); return; }
    // Bound the sockets we hold. Unauthenticated ones are limited much harder so a flood of them cannot
    // crowd out the owner's reconnect.
    if (connections.size >= config.maxConnections) { reject('503 Service Unavailable', 'max_connections'); return; }
    let unauthenticated = 0;
    for (const c of connections) if (!c.authenticated) unauthenticated++;
    if (unauthenticated >= MAX_UNAUTHENTICATED_CONNECTIONS) { reject('503 Service Unavailable', 'max_unauthenticated'); return; }
    // Browsers always send Origin on WebSocket handshakes; the CLI does not.
    const origin = req.headers.origin;
    if (origin !== undefined && !config.allowedOrigins.includes(origin)) { reject('403 Forbidden', 'origin'); return; }
    let preAuth = null;
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (bearer) {
      preAuth = tokens.verify(bearer[1]);
      if (!preAuth) {
        if (!throttleExempt(ip)) ctx.throttle.recordFailure(ip);
        reject('401 Unauthorized', 'bad bearer');
        return;
      }
    }
    wss.handleUpgrade(req, socket, Buffer.alloc(0), (ws) => {
      const conn = new Connection(ws, ip, ctx, preAuth, (c) => connections.delete(c), req, throttleExempt(ip));
      connections.add(conn);
    });
  });

  const sweep = setInterval(() => ctx.cmdCache.sweep(), 60_000);
  sweep.unref();
  // Retention (TTL and size) must hold even for a client that never acks, so compaction is not only ack-driven.
  const maintenance = setInterval(() => {
    try { host.compactAll(); } catch (err) { console.error('journal maintenance:', err); }
    try { sweepRawLogs(logsDir, rawLogLimits, options.now?.()); } catch (err) { console.error('raw log maintenance:', err); }
  }, options.maintenanceMs ?? 5 * 60_000);
  maintenance.unref();
  const idleMs = options.idleReapMs ?? config.idleReapMinutes * 60_000;
  const reaper = idleMs > 0
    ? setInterval(() => {
      try {
        for (const id of host.reapIdle()) log(`idle-reaped session ${id}`);
      } catch (err) { console.error('idle reaper:', err); }
    }, options.reapCheckMs ?? Math.min(60_000, Math.max(1_000, Math.floor(idleMs / 2))))
    : null;
  reaper?.unref();

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(config.port, config.listen, () => { http.off('error', reject); resolve(); });
  });
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  const hostName = config.listen;
  const url = `ws://${hostName.includes(':') ? `[${hostName}]` : hostName}:${port}/v1/ws`;
  log(`agent-threads ${DAEMON_VERSION} listening on ${url} (data: ${config.dataDir}, epoch ${epoch})`);
  if (!isLoopbackAddress(hostName)) {
    log(isWildcardAddress(hostName)
      ? 'WARNING: listening on ALL interfaces over plain ws://. Anyone who can reach this port can try tokens. Prefer 127.0.0.1 + "tailscale serve".'
      : `WARNING: listening on ${hostName} over plain ws://. Traffic is unencrypted outside a Tailscale/VPN tunnel.`);
  }

  // Housekeeping that must never delay or fail startup: drop worktrees idle for a long time, then bring the clones up to date.
  const startup = (async () => {
    try {
      const pruned = await pruneIdleWorktrees({
        repoRoot: config.repoRoot,
        worktreeRoots: [join(config.repoRoot, '.worktrees'), ...(config.worktreeRoot ? [config.worktreeRoot] : [])],
        days: config.worktreePruneDays,
        ...(options.now ? { now: options.now } : {}),
        log,
      });
      if (pruned.removed.length) log(`pruned ${pruned.removed.length} idle worktree(s)`);
    } catch (err) { log(`worktree prune failed: ${String(err)}`); }
    try { await repos.syncAll(); } catch (err) { log(`repo sync failed: ${String(err)}`); }
  })();

  const closeHttp = (srv: Server) => new Promise<void>((resolve) => { srv.close(() => resolve()); srv.closeAllConnections?.(); });

  return {
    host: hostName,
    port,
    epoch,
    daemonId,
    url,
    tokens,
    threads: host,
    repos,
    startup,
    recovered,
    async stop() {
      clearInterval(sweep);
      clearInterval(maintenance);
      if (reaper) clearInterval(reaper);
      for (const c of connections) c.closeWith(1001, 'daemon shutting down');
      host.shutdown();
      wss.close();
      auditLog.flushSync();
      await closeHttp(http);
    },
    async crash() {
      clearInterval(sweep);
      clearInterval(maintenance);
      if (reaper) clearInterval(reaper);
      host.crash();
      auditLog.flushSync();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await closeHttp(http);
    },
  };
}


/** `<first read-write workspace>/.worktrees`: inside a workspace, so a session can resume in the worktree. */
function defaultWorktreeRoot(config: DaemonConfig): string | undefined {
  const root = config.workspaces.find((w) => !config.readOnlyWorkspaces.includes(w));
  return root ? join(root, '.worktrees') : undefined;
}

/** The configured journal bounds as `InMemoryJournal` options; 0 means unbounded. */
function journalLimits(config: DaemonConfig, override?: { maxAgeMs?: number; maxBytes?: number }): { maxAgeMs?: number; maxBytes?: number } {
  const maxAgeMs = override?.maxAgeMs ?? (config.journalTtlDays > 0 ? config.journalTtlDays * 86_400_000 : undefined);
  const maxBytes = override?.maxBytes ?? (config.journalMaxMb > 0 ? config.journalMaxMb * 1024 * 1024 : undefined);
  return { ...(maxAgeMs !== undefined ? { maxAgeMs } : {}), ...(maxBytes !== undefined ? { maxBytes } : {}) };
}

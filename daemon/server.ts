/**
 * HTTP + WebSocket server: `GET /healthz`, `GET /v1/ws`.
 *
 * Everything pre-authentication is deliberately cheap and stateless: origin
 * check, per-IP failure throttle, path check. Credentials are only ever read
 * from the first `hello` frame or an `Authorization: Bearer` header, never the
 * URL, so tokens do not end up in proxy logs.
 */
import { appendFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '../src/protocol';
import { CommandCache } from './cmdCache';
import { isLoopbackAddress, isWildcardAddress, loadOrCreateDaemonId, type DaemonConfig } from './config';
import { createClaudeDriverFactory, describeCredentialSource, findClaudeBinary, resolveCredentialEnv } from './claudeDriver';
import { Connection, DEFAULT_TIMINGS, MAX_OUTBOUND_BYTES, capabilitiesFor, type ServerContext, type Timings } from './connection';
import { ControlRegistry } from './controlRegistry';
import { fakeHarnessFactory } from './fakeHarness';
import { FailureThrottle } from './failureThrottle';
import { ensureDir } from './fsutil';
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
  /** How often the idle reaper looks (default: half the idle window, at most a minute). */
  reapCheckMs?: number;
  maxOutboundBytes?: number;
  throttle?: FailureThrottle;
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
  /** Thread ids whose in-flight turn was closed out during startup recovery. */
  readonly recovered: string[];
  /** Graceful: close sockets, flush + fsync journals. */
  stop(): Promise<void>;
  /** Test hook: behave like SIGKILL; unflushed journal data is lost. */
  crash(): Promise<void>;
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const { config } = options;
  const log = options.log ?? (() => {});
  ensureDir(config.dataDir);
  ensureDir(join(config.dataDir, 'journal'));
  const daemonId = loadOrCreateDaemonId(config.dataDir);
  const epoch = randomUUID();
  const tokens = new TokenStore(config.dataDir);
  const auditPath = join(config.dataDir, 'audit.ndjson');
  const audit = (record: Record<string, unknown>): void => {
    // Who did what, never content. Best effort: audit failure must not take the daemon down.
    try { appendFileSync(auditPath, `${JSON.stringify({ ts: Date.now(), ...record })}\n`, { mode: 0o600 }); } catch { /* ignore */ }
  };

  const real = config.harness === 'claude';
  let driverFactory = options.driverFactory;
  let rawLog: ((threadId: string, event: Record<string, unknown>) => void) | undefined;
  if (real) {
    const env = process.env;
    // Raw SDK events -> <dataDir>/logs/<threadId>.jsonl (full fidelity, secrets masked). Never on the wire.
    const writer = new RawLogWriter(() => config.dataDir, () => '.');
    rawLog = (threadId, event) => {
      const type = typeof event.type === 'string' ? event.type : 'event';
      if (!RawLogWriter.shouldLog(type)) return;
      writer.append(threadId, typeof event.session_id === 'string' ? event.session_id : undefined, type, event);
    };
    const credentialEnv = resolveCredentialEnv(env);
    setKnownSecretsProvider(() => [env.CLAUDE_CODE_OAUTH_TOKEN, env.ANTHROPIC_API_KEY, credentialEnv.CLAUDE_CODE_OAUTH_TOKEN].filter((v): v is string => !!v));
    if (!driverFactory) {
      driverFactory = createClaudeDriverFactory({ claudeBinaryPath: config.claudeBinaryPath, env });
      const binary = findClaudeBinary(config.claudeBinaryPath, env);
      log(binary ? `claude CLI: ${binary}` : 'WARNING: claude CLI not found; session.open will fail until it is installed (or set claudeBinaryPath / AGENT_THREADS_CLAUDE_BINARY)');
      log(`claude credential: ${describeCredentialSource(env)}`);
    }
    log(`workspaces: ${config.workspaces.join(', ') || '(none)'}; bypassPermissions ${config.allowBypass ? 'ALLOWED' : 'refused'}; maxConcurrentTurns ${config.maxConcurrentTurns}; idle reap ${config.idleReapMinutes ? `${config.idleReapMinutes} min` : 'off'}`);
  }

  const host = new ThreadHost({
    dataDir: config.dataDir,
    epoch,
    driverFactory: driverFactory ?? fakeHarnessFactory,
    flushMs: options.journalFlushMs,
    // The scripted fake has no side effects, so only the real host is policed.
    ...(real ? { policy: { workspaces: config.workspaces, allowBypass: config.allowBypass } } : {}),
    maxConcurrentTurns: config.maxConcurrentTurns,
    idleReapMs: config.idleReapMinutes * 60_000,
    rawLog,
  });
  const recovered = host.recover();
  for (const id of recovered) log(`recovered thread ${id}: closed in-flight turn as daemon_restarted`);

  const ctx: ServerContext = {
    host,
    tokens,
    throttle: options.throttle ?? new FailureThrottle(),
    cmdCache: new CommandCache(),
    daemonId,
    epoch,
    capabilities: capabilitiesFor(config.harness),
    controllers: new ControlRegistry(),
    timings: { ...DEFAULT_TIMINGS, ...options.timings },
    maxOutboundBytes: options.maxOutboundBytes ?? MAX_OUTBOUND_BYTES,
    audit,
  };

  const connections = new Set<Connection>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

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
    if (ctx.throttle.isBlocked(ip)) { reject('429 Too Many Requests', 'throttled'); return; }
    // Browsers always send Origin on WebSocket handshakes; the CLI does not.
    const origin = req.headers.origin;
    if (origin !== undefined && !config.allowedOrigins.includes(origin)) { reject('403 Forbidden', 'origin'); return; }
    let preAuth = null;
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (bearer) {
      preAuth = tokens.verify(bearer[1]);
      if (!preAuth) {
        ctx.throttle.recordFailure(ip);
        reject('401 Unauthorized', 'bad bearer');
        return;
      }
    }
    wss.handleUpgrade(req, socket, Buffer.alloc(0), (ws) => {
      const conn = new Connection(ws, ip, ctx, preAuth, (c) => connections.delete(c), req);
      connections.add(conn);
    });
  });

  const sweep = setInterval(() => ctx.cmdCache.sweep(), 60_000);
  sweep.unref();
  const idleMs = config.idleReapMinutes * 60_000;
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

  const closeHttp = (srv: Server) => new Promise<void>((resolve) => { srv.close(() => resolve()); srv.closeAllConnections?.(); });

  return {
    host: hostName,
    port,
    epoch,
    daemonId,
    url,
    tokens,
    threads: host,
    recovered,
    async stop() {
      clearInterval(sweep);
      if (reaper) clearInterval(reaper);
      for (const c of connections) c.closeWith(1001, 'daemon shutting down');
      host.shutdown();
      wss.close();
      await closeHttp(http);
    },
    async crash() {
      clearInterval(sweep);
      if (reaper) clearInterval(reaper);
      host.crash();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await closeHttp(http);
    },
  };
}


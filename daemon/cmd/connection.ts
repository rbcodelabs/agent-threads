/**
 * Where the CLI connects and how it proves who it is.
 *
 * URL:    --url > AGENT_THREADS_URL > ws://127.0.0.1:<port> (the port from the local data
 *         directory's config.json when there is one, else 7433).
 * Token:  --token > AGENT_THREADS_TOKEN > `<data-dir>/cli-token`.
 *
 * `cli-token` exists only if the operator asked for it (`agent-threads token create --save`):
 * the daemon keeps just a hash of every token, so a same-machine default needs a plaintext
 * copy that only the daemon's own unix user can read. That is no new capability: whoever can
 * read the data directory can already read every journal and run `claude` as that user.
 *
 * Nothing here creates a directory or writes a file; resolving a connection is read-only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
  DaemonClient,
  DaemonCommandError,
  daemonWsUrl,
  type ConnectionState,
  type WebSocketFactory,
  type WebSocketLike,
} from '../../src/remote/DaemonClient';
import { DEFAULT_LISTEN, DEFAULT_PORT, isWildcardAddress } from '../config';
import { DAEMON_VERSION } from '../version';
import { CliError, EXIT, exitCodeFor } from './exit';

export const CLI_TOKEN_FILE = 'cli-token';

export interface ConnectionFlags {
  url?: string;
  token?: string;
  dataDir?: string;
}

export type UrlSource = 'flag' | 'env' | 'data-dir' | 'default';
export type TokenSource = 'flag' | 'env' | 'data-dir' | 'none';

export interface ConnectionSettings {
  /** The WebSocket endpoint (`ws://host:port/v1/ws`). */
  url: string;
  token: string | undefined;
  urlSource: UrlSource;
  tokenSource: TokenSource;
  /** The data directory the token (or port) was read from, if any. */
  dataDir?: string;
  /** The daemon is on this machine (loopback address). */
  local: boolean;
}

export interface FsLike {
  exists(path: string): boolean;
  read(path: string): string | null;
}

export const realFs: FsLike = {
  exists: (p) => existsSync(p),
  read: (p) => {
    try { return readFileSync(p, 'utf8'); } catch { return null; }
  },
};

/** Directories that may hold this machine's daemon state, most specific first. Never created. */
export function dataDirCandidates(flags: ConnectionFlags, env: NodeJS.ProcessEnv, fs: FsLike = realFs, home = homedir()): string[] {
  if (flags.dataDir) return [flags.dataDir];
  const out: string[] = [];
  if (env.DATA_DIR) out.push(env.DATA_DIR);
  for (const d of ['/var/lib/agent-threads', join(home, '.agent-threads'), join(home, '.local/state/agent-threads')]) {
    if (!out.includes(d) && fs.exists(d)) out.push(d);
  }
  return out;
}

const isLoopbackUrl = (url: string): boolean => {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || host.startsWith('127.');
  } catch {
    return false;
  }
};

export function resolveConnectionSettings(
  flags: ConnectionFlags,
  env: NodeJS.ProcessEnv = process.env,
  fs: FsLike = realFs,
  home = homedir(),
): ConnectionSettings {
  const dirs = dataDirCandidates(flags, env, fs, home);

  let token = flags.token;
  let tokenSource: TokenSource = flags.token ? 'flag' : 'none';
  let tokenDir: string | undefined;
  if (!token && env.AGENT_THREADS_TOKEN) { token = env.AGENT_THREADS_TOKEN.trim(); tokenSource = 'env'; }
  if (!token) {
    for (const dir of dirs) {
      const raw = fs.read(join(dir, CLI_TOKEN_FILE))?.trim();
      if (raw) { token = raw; tokenSource = 'data-dir'; tokenDir = dir; break; }
    }
  }

  let url: string;
  let urlSource: UrlSource;
  if (flags.url) { url = daemonWsUrl(flags.url); urlSource = 'flag'; }
  else if (env.AGENT_THREADS_URL) { url = daemonWsUrl(env.AGENT_THREADS_URL); urlSource = 'env'; }
  else {
    // Same-machine default. If the local daemon was told to listen elsewhere, follow its config.json.
    let host = DEFAULT_LISTEN;
    let port = DEFAULT_PORT;
    urlSource = 'default';
    for (const dir of tokenDir ? [tokenDir] : dirs) {
      const raw = fs.read(join(dir, 'config.json'));
      if (!raw) continue;
      try {
        const cfg = JSON.parse(raw) as { listen?: unknown; port?: unknown };
        if (typeof cfg.port === 'number' && cfg.port > 0) port = cfg.port;
        if (typeof cfg.listen === 'string' && cfg.listen && !isWildcardAddress(cfg.listen)) host = cfg.listen;
        urlSource = 'data-dir';
        break;
      } catch { /* an unreadable config is doctor's business, not ours */ }
    }
    const envPort = env.AGENT_THREADS_PORT ? Number(env.AGENT_THREADS_PORT) : NaN;
    if (Number.isInteger(envPort) && envPort > 0) port = envPort;
    url = daemonWsUrl(`ws://${host.includes(':') ? `[${host}]` : host}:${port}`);
  }
  return { url, token, urlSource, tokenSource, ...(tokenDir ? { dataDir: tokenDir } : dirs[0] ? { dataDir: dirs[0] } : {}), local: isLoopbackUrl(url) };
}

/** The HTTP base of a ws endpoint, for `/healthz`. */
export function httpBaseOf(wsUrl: string): string {
  return wsUrl.replace(/^ws/i, 'http').replace(/\/v1\/ws$/, '');
}

/** `ws` behind the transport-agnostic `DaemonClient` seam. No `Origin` header is sent, which the daemon allows. */
export const nodeSocketFactory: WebSocketFactory = (url) =>
  new WebSocket(url, { handshakeTimeout: 10_000, perMessageDeflate: false }) as unknown as WebSocketLike;

export interface ConnectOptions {
  /** Retry forever after the first connection (attach/run) or give up on the first failure (list). */
  reconnect: boolean;
  /** Longest wait for the first welcome. */
  connectTimeoutMs?: number;
  createSocket?: WebSocketFactory;
  /** Stable id of this CLI process; the daemon keys the read-write seat on (token, instance). */
  instanceId?: string;
  log?: (message: string) => void;
}

/** A per-process id: two `agent-threads` processes sharing one token still contend for the seat, as two Geodes would. */
export const newInstanceId = (): string => `cli-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

/**
 * Connect and wait for the daemon's welcome. Rejects with a `CliError` carrying the right exit code
 * (unreachable / unauthorized / incompatible) and a message that says what to do.
 */
export async function connectDaemon(settings: ConnectionSettings, opts: ConnectOptions): Promise<DaemonClient> {
  if (!settings.token) {
    throw new CliError(
      'no access token: pass --token, set AGENT_THREADS_TOKEN, or save one on the daemon machine with `agent-threads token create --name cli --save`',
      EXIT.UNAUTHORIZED,
    );
  }
  const client = new DaemonClient({
    url: settings.url,
    getToken: () => settings.token,
    createSocket: opts.createSocket ?? nodeSocketFactory,
    client: 'cli',
    clientVersion: DAEMON_VERSION,
    instanceId: opts.instanceId ?? newInstanceId(),
    reconnect: opts.reconnect,
    ...(opts.log ? { log: opts.log } : {}),
  });
  const timeoutMs = opts.connectTimeoutMs ?? 10_000;
  return new Promise<DaemonClient>((resolve, reject) => {
    let settled = false;
    const finish = (err: CliError | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      if (err) { client.dispose(); reject(err); } else resolve(client);
    };
    const onState = (s: ConnectionState): void => {
      switch (s.status) {
        case 'connected': finish(null); return;
        case 'unauthorized':
          finish(new CliError(`the daemon at ${settings.url} rejected the token${s.detail ? ` (${s.detail})` : ''}; check --token / AGENT_THREADS_TOKEN`, EXIT.UNAUTHORIZED));
          return;
        case 'incompatible':
          finish(new CliError(`${s.detail ?? 'incompatible daemon'}; use an agent-threads CLI that matches the daemon's version`, EXIT.INCOMPATIBLE));
          return;
        case 'unreachable':
          // With reconnect on, `unreachable` just means "3 failures so far"; the timeout decides.
          if (!opts.reconnect) finish(new CliError(`cannot reach the daemon at ${settings.url}${s.detail ? `: ${s.detail}` : ''}`, EXIT.UNREACHABLE));
          return;
        case 'closed':
          finish(new CliError('connection closed', EXIT.UNREACHABLE));
          return;
        default:
      }
    };
    const off = client.onState(onState);
    const timer = setTimeout(() => {
      const d = client.connection.detail;
      finish(new CliError(`cannot reach the daemon at ${settings.url} within ${Math.round(timeoutMs / 1000)}s${d ? ` (${d})` : ''}`, EXIT.UNREACHABLE));
    }, timeoutMs);
    client.connect();
    onState(client.connection);
  });
}

/** Run a command and turn a daemon refusal into a `CliError` with the matching exit code. */
export async function command<T = Record<string, unknown>>(client: DaemonClient, ...args: Parameters<DaemonClient['command']>): Promise<T> {
  try {
    return (await client.command(...args)) as T;
  } catch (err) {
    if (err instanceof DaemonCommandError) throw new CliError(`${args[0]}: ${err.message}`, exitCodeFor(err));
    throw err;
  }
}

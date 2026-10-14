/**
 * Daemon configuration. Precedence: CLI flag > environment > config.json > default.
 * The data directory layout is design section 5.1.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from './fsutil';

export const DEFAULT_PORT = 7433;
export const DEFAULT_LISTEN = '127.0.0.1';
const SYSTEM_DATA_DIR = '/var/lib/agent-threads';

export interface DaemonConfig {
  dataDir: string;
  listen: string;
  port: number;
  /** Browser `Origin` values allowed to open the WebSocket. Requests without an Origin (CLI) are always allowed. */
  allowedOrigins: string[];
  /** Required to bind a wildcard address. */
  acknowledgeOpen: boolean;
  /** Which session host runs behind `session.open`. 'fake' is the scripted harness used by tests and smoke runs. */
  harness: HarnessKind;
  /** Absolute directories a session's cwd (and additionalDirectories) must sit under. */
  workspaces: string[];
  /** Accept `permissionMode: 'bypassPermissions'`. Off unless the operator opts in. */
  allowBypass: boolean;
  /** At most this many turns run at once; further `session.send` is refused (retryable). */
  maxConcurrentTurns: number;
  /** A session idle this long (no turn, nothing awaiting a human) is stopped; the next send cold-resumes it. 0 disables. */
  idleReapMinutes: number;
  /** Explicit path to the `claude` CLI; otherwise discovered on PATH and in the usual install dirs. */
  claudeBinaryPath?: string;
}

export type HarnessKind = 'claude' | 'fake';

export const DEFAULT_WORKSPACES = ['/srv/workspaces'];
export const DEFAULT_MAX_CONCURRENT_TURNS = 3;
export const DEFAULT_IDLE_REAP_MINUTES = 30;

export interface ConfigInputs {
  flags?: Partial<{
    dataDir: string; listen: string; port: number; allowedOrigins: string[]; acknowledgeOpen: boolean;
    harness: HarnessKind; workspaces: string[]; allowBypass: boolean; maxConcurrentTurns: number;
    idleReapMinutes: number; claudeBinaryPath: string;
  }>;
  env?: NodeJS.ProcessEnv;
}

/** `/var/lib/agent-threads` when we can create/write it (systemd StateDirectory), else `~/.agent-threads`. */
export function defaultDataDir(): string {
  try {
    mkdirSync(SYSTEM_DATA_DIR, { recursive: true, mode: 0o700 });
    accessSync(SYSTEM_DATA_DIR, constants.W_OK);
    return SYSTEM_DATA_DIR;
  } catch {
    return join(homedir(), '.agent-threads');
  }
}

interface ConfigFile {
  daemonId?: string;
  listen?: string;
  port?: number;
  allowedOrigins?: string[];
  workspaces?: string[];
  allowBypass?: boolean;
  maxConcurrentTurns?: number;
  idleReapMinutes?: number;
  claudeBinaryPath?: string;
}

/** `~` and `~/x` mean the daemon user's home; everything else must already be absolute. */
export function expandHome(p: string, home = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

function positiveInt(name: string, value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) throw new Error(`invalid ${name}: ${String(value)}`);
  return value;
}

export function readConfigFile(dataDir: string): ConfigFile {
  const file = join(dataDir, 'config.json');
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as ConfigFile) : {};
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
}

/** Stable identity of this data directory; created on first start. */
export function loadOrCreateDaemonId(dataDir: string): string {
  const cfg = readConfigFile(dataDir);
  if (typeof cfg.daemonId === 'string' && cfg.daemonId) return cfg.daemonId;
  const daemonId = randomUUID();
  writeFileAtomic(join(dataDir, 'config.json'), `${JSON.stringify({ ...cfg, daemonId }, null, 2)}\n`);
  return daemonId;
}

export function isWildcardAddress(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '' || host === '0:0:0:0:0:0:0:0';
}

export function isLoopbackAddress(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

export function resolveConfig(input: ConfigInputs = {}): DaemonConfig {
  const env = input.env ?? process.env;
  const flags = input.flags ?? {};
  const dataDir = flags.dataDir ?? (env.DATA_DIR || undefined) ?? defaultDataDir();
  const file = readConfigFile(dataDir);

  const envPort = env.AGENT_THREADS_PORT ? Number(env.AGENT_THREADS_PORT) : undefined;
  const port = flags.port ?? envPort ?? file.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${String(port)}`);

  const envOrigins = env.AGENT_THREADS_ALLOWED_ORIGINS
    ? env.AGENT_THREADS_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  const listen = flags.listen ?? env.AGENT_THREADS_LISTEN ?? file.listen ?? DEFAULT_LISTEN;
  const acknowledgeOpen = flags.acknowledgeOpen ?? false;
  if (isWildcardAddress(listen) && !acknowledgeOpen) {
    throw new Error(`refusing to listen on ${listen || '(wildcard)'}: pass --i-know-this-is-open, or bind loopback and use "tailscale serve"`);
  }

  const envList = (v: string | undefined) => (v ? v.split(':').map((x) => x.trim()).filter(Boolean) : undefined);
  const workspaces = (flags.workspaces ?? envList(env.AGENT_THREADS_WORKSPACES) ?? file.workspaces ?? DEFAULT_WORKSPACES)
    .map((w) => expandHome(w));
  for (const w of workspaces) {
    if (!isAbsolute(w)) throw new Error(`workspace "${w}" must be an absolute path`);
  }
  const harness = flags.harness ?? (env.AGENT_THREADS_HARNESS as HarnessKind | undefined) ?? 'claude';
  if (harness !== 'claude' && harness !== 'fake') throw new Error(`invalid harness: ${String(harness)}`);
  const envInt = (v: string | undefined) => (v !== undefined && v !== '' ? Number(v) : undefined);
  const claudeBinaryPath = flags.claudeBinaryPath ?? (env.AGENT_THREADS_CLAUDE_BINARY || undefined) ?? file.claudeBinaryPath;
  return {
    dataDir,
    listen,
    port,
    allowedOrigins: flags.allowedOrigins ?? envOrigins ?? file.allowedOrigins ?? [],
    acknowledgeOpen,
    harness,
    workspaces: [...new Set(workspaces.map((w) => resolve(w)))],
    allowBypass: flags.allowBypass ?? (env.AGENT_THREADS_ALLOW_BYPASS === '1' || file.allowBypass === true),
    maxConcurrentTurns: positiveInt('maxConcurrentTurns', flags.maxConcurrentTurns ?? envInt(env.AGENT_THREADS_MAX_CONCURRENT_TURNS) ?? file.maxConcurrentTurns ?? DEFAULT_MAX_CONCURRENT_TURNS, 1),
    idleReapMinutes: positiveInt('idleReapMinutes', flags.idleReapMinutes ?? envInt(env.AGENT_THREADS_IDLE_REAP_MINUTES) ?? file.idleReapMinutes ?? DEFAULT_IDLE_REAP_MINUTES, 0),
    ...(claudeBinaryPath ? { claudeBinaryPath } : {}),
  };
}

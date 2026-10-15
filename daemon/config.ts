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
  /** Folders sessions may run in but whose files the harness's edit tools may not change (also allowed as cwd). */
  readOnlyWorkspaces: string[];
  /** Accept `permissionMode: 'bypassPermissions'`. Off unless the operator opts in. */
  allowBypass: boolean;
  /** At most this many turns run at once; further `session.send` is refused (retryable). */
  maxConcurrentTurns: number;
  /** A session idle this long (no turn, nothing awaiting a human) is stopped; the next send cold-resumes it. 0 disables. */
  idleReapMinutes: number;
  /** Explicit path to the `claude` CLI; otherwise discovered on PATH and in the usual install dirs. */
  claudeBinaryPath?: string;
  /** A journal entry older than this is dropped (a client that was away longer gets a `resync`). 0 = keep forever. */
  journalTtlDays: number;
  /** Cap on one thread's retained journal (approximate JSON bytes); oldest entries go first. 0 = no cap. */
  journalMaxMb: number;
  /** Sockets accepted at once (authenticated or not); further upgrades get 503. */
  maxConnections: number;
  /** Sessions with a live `claude` process at once; `session.open` / a cold resume beyond this is refused. */
  maxLiveSessions: number;
  /** A permission/question/plan/elicitation request nobody answers for this long is canceled so it cannot hold a turn slot forever. 0 = never. */
  requestTimeoutMinutes: number;
  /**
   * Environment variable NAMES a client may set through `extraEnvRaw`. Empty (the default) means the
   * daemon ignores client-supplied environment entirely: a client-chosen variable such as HTTPS_PROXY,
   * NODE_EXTRA_CA_CERTS, BASH_ENV or GIT_SSH_COMMAND can redirect or subvert the agent's traffic and commands.
   */
  allowedClientEnv: string[];
  /**
   * How long a proxied host-tool call waits for the user's Geode to (re)connect before it fails with a
   * model-readable error. The turn is never held longer than this plus `hostToolTimeoutSec`.
   */
  hostToolGraceSec: number;
  /** How long an attached Geode may take to answer one proxied host-tool call before it is failed. */
  hostToolTimeoutSec: number;
  /**
   * Directory `enter_worktree` creates worktrees under (a daemon path, so it must be inside a workspace for the
   * session to resume there). Default: `.worktrees` inside the first read-write workspace.
   */
  worktreeRoot?: string;
}

export type HarnessKind = 'claude' | 'fake';

export const DEFAULT_WORKSPACES = ['/srv/workspaces'];
export const DEFAULT_MAX_CONCURRENT_TURNS = 3;
export const DEFAULT_IDLE_REAP_MINUTES = 30;
export const DEFAULT_JOURNAL_TTL_DAYS = 7;
export const DEFAULT_JOURNAL_MAX_MB = 64;
export const DEFAULT_MAX_CONNECTIONS = 64;
export const DEFAULT_MAX_LIVE_SESSIONS = 8;
export const DEFAULT_REQUEST_TIMEOUT_MINUTES = 60;
export const DEFAULT_HOST_TOOL_GRACE_SEC = 60;
export const DEFAULT_HOST_TOOL_TIMEOUT_SEC = 300;

export interface ConfigInputs {
  flags?: Partial<{
    dataDir: string; listen: string; port: number; allowedOrigins: string[]; acknowledgeOpen: boolean;
    harness: HarnessKind; workspaces: string[]; readOnlyWorkspaces: string[]; allowBypass: boolean; maxConcurrentTurns: number;
    idleReapMinutes: number; claudeBinaryPath: string; journalTtlDays: number; journalMaxMb: number;
    maxConnections: number; maxLiveSessions: number; requestTimeoutMinutes: number; allowedClientEnv: string[];
    hostToolGraceSec: number; hostToolTimeoutSec: number; worktreeRoot: string;
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
  readOnlyWorkspaces?: string[];
  allowBypass?: boolean;
  maxConcurrentTurns?: number;
  idleReapMinutes?: number;
  claudeBinaryPath?: string;
  journalTtlDays?: number;
  journalMaxMb?: number;
  maxConnections?: number;
  maxLiveSessions?: number;
  requestTimeoutMinutes?: number;
  allowedClientEnv?: string[];
  hostToolGraceSec?: number;
  hostToolTimeoutSec?: number;
  worktreeRoot?: string;
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

function allowedClientEnv(names: unknown): string[] {
  if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) throw new Error('invalid allowedClientEnv: expected a list of variable names');
  for (const n of names as string[]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new Error(`invalid allowedClientEnv entry: ${n}`);
  }
  return [...new Set(names as string[])];
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
  const readOnlyWorkspaces = (flags.readOnlyWorkspaces ?? envList(env.AGENT_THREADS_READONLY_WORKSPACES) ?? file.readOnlyWorkspaces ?? [])
    .map((w) => expandHome(w));
  for (const w of readOnlyWorkspaces) {
    if (!isAbsolute(w)) throw new Error(`read-only workspace "${w}" must be an absolute path`);
  }
  const harness = flags.harness ?? (env.AGENT_THREADS_HARNESS as HarnessKind | undefined) ?? 'claude';
  if (harness !== 'claude' && harness !== 'fake') throw new Error(`invalid harness: ${String(harness)}`);
  const envInt = (v: string | undefined) => (v !== undefined && v !== '' ? Number(v) : undefined);
  const worktreeRootRaw = flags.worktreeRoot ?? (env.AGENT_THREADS_WORKTREE_ROOT || undefined) ?? file.worktreeRoot;
  const worktreeRoot = worktreeRootRaw ? resolve(expandHome(worktreeRootRaw)) : undefined;
  if (worktreeRoot && !isAbsolute(worktreeRoot)) throw new Error(`worktreeRoot "${worktreeRoot}" must be an absolute path`);
  const claudeBinaryPath = flags.claudeBinaryPath ?? (env.AGENT_THREADS_CLAUDE_BINARY || undefined) ?? file.claudeBinaryPath;
  return {
    dataDir,
    listen,
    port,
    allowedOrigins: flags.allowedOrigins ?? envOrigins ?? file.allowedOrigins ?? [],
    acknowledgeOpen,
    harness,
    workspaces: [...new Set(workspaces.map((w) => resolve(w)))],
    readOnlyWorkspaces: [...new Set(readOnlyWorkspaces.map((w) => resolve(w)))],
    allowBypass: flags.allowBypass ?? (env.AGENT_THREADS_ALLOW_BYPASS === '1' || file.allowBypass === true),
    maxConcurrentTurns: positiveInt('maxConcurrentTurns', flags.maxConcurrentTurns ?? envInt(env.AGENT_THREADS_MAX_CONCURRENT_TURNS) ?? file.maxConcurrentTurns ?? DEFAULT_MAX_CONCURRENT_TURNS, 1),
    idleReapMinutes: positiveInt('idleReapMinutes', flags.idleReapMinutes ?? envInt(env.AGENT_THREADS_IDLE_REAP_MINUTES) ?? file.idleReapMinutes ?? DEFAULT_IDLE_REAP_MINUTES, 0),
    journalTtlDays: positiveInt('journalTtlDays', flags.journalTtlDays ?? envInt(env.AGENT_THREADS_JOURNAL_TTL_DAYS) ?? file.journalTtlDays ?? DEFAULT_JOURNAL_TTL_DAYS, 0),
    journalMaxMb: positiveInt('journalMaxMb', flags.journalMaxMb ?? envInt(env.AGENT_THREADS_JOURNAL_MAX_MB) ?? file.journalMaxMb ?? DEFAULT_JOURNAL_MAX_MB, 0),
    maxConnections: positiveInt('maxConnections', flags.maxConnections ?? envInt(env.AGENT_THREADS_MAX_CONNECTIONS) ?? file.maxConnections ?? DEFAULT_MAX_CONNECTIONS, 1),
    maxLiveSessions: positiveInt('maxLiveSessions', flags.maxLiveSessions ?? envInt(env.AGENT_THREADS_MAX_LIVE_SESSIONS) ?? file.maxLiveSessions ?? DEFAULT_MAX_LIVE_SESSIONS, 1),
    requestTimeoutMinutes: positiveInt('requestTimeoutMinutes', flags.requestTimeoutMinutes ?? envInt(env.AGENT_THREADS_REQUEST_TIMEOUT_MINUTES) ?? file.requestTimeoutMinutes ?? DEFAULT_REQUEST_TIMEOUT_MINUTES, 0),
    allowedClientEnv: allowedClientEnv(flags.allowedClientEnv ?? envList(env.AGENT_THREADS_ALLOWED_CLIENT_ENV) ?? file.allowedClientEnv ?? []),
    hostToolGraceSec: positiveInt('hostToolGraceSec', flags.hostToolGraceSec ?? envInt(env.AGENT_THREADS_HOST_TOOL_GRACE_SEC) ?? file.hostToolGraceSec ?? DEFAULT_HOST_TOOL_GRACE_SEC, 0),
    hostToolTimeoutSec: positiveInt('hostToolTimeoutSec', flags.hostToolTimeoutSec ?? envInt(env.AGENT_THREADS_HOST_TOOL_TIMEOUT_SEC) ?? file.hostToolTimeoutSec ?? DEFAULT_HOST_TOOL_TIMEOUT_SEC, 1),
    ...(worktreeRoot ? { worktreeRoot } : {}),
    ...(claudeBinaryPath ? { claudeBinaryPath } : {}),
  };
}

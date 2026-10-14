/**
 * Daemon configuration. Precedence: CLI flag > environment > config.json > default.
 * The data directory layout is design section 5.1.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
}

export interface ConfigInputs {
  flags?: Partial<{ dataDir: string; listen: string; port: number; allowedOrigins: string[]; acknowledgeOpen: boolean }>;
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
  return {
    dataDir,
    listen,
    port,
    allowedOrigins: flags.allowedOrigins ?? envOrigins ?? file.allowedOrigins ?? [],
    acknowledgeOpen,
  };
}

/**
 * Durable and shared update state, all under the data directory (0700, the daemon user's):
 *
 * - `update.json`          what must survive a restart: the pending-upgrade marker (rollback), a rollback record
 *                          that pauses auto-update for the release that failed, and releases held back.
 * - `update-status.json`   what the running daemon is doing, for `agent-threads update --check` and `doctor`.
 * - `update-request.json`  `agent-threads update --apply` asking a running daemon to restart onto the bundle it just
 *                          installed, when idle (or at once with `now`).
 * - `update.lock`          one staging at a time (daemon and CLI share it).
 */
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, writeFileAtomic } from '../fsutil';

export interface PendingUpgrade {
  from: string;
  to: string;
  /** The saved previous bundle (`agent-threads.cjs.prev-<from>`). */
  prevPath: string;
  /** The bundle the upgrade replaced; rollback only acts when this is the bundle that is running. */
  bundlePath: string;
  appliedAt: number;
  /** Starts of the new version that did not reach healthy. */
  boots: number;
}

export interface UpdateState {
  pendingUpgrade?: PendingUpgrade;
  /** A rolled-back upgrade: auto-update stays paused until a release other than `from` appears. */
  rolledBack?: { from: string; to: string; at: number };
  /** A release seen but not applied automatically (incompatible protocol, major bump). */
  held?: { version: string; reason: string; at: number };
}

export type UpdatePhase =
  | 'unavailable' | 'off' | 'idle' | 'checking' | 'downloading' | 'up_to_date'
  | 'waiting_for_idle' | 'restarting' | 'held' | 'paused_after_rollback' | 'error';

export interface UpdateStatus {
  pid: number;
  version: string;
  enabled: boolean;
  /** This install can replace its own bundle and be restarted by a supervisor. */
  available: boolean;
  reason?: string;
  phase: UpdatePhase;
  intervalMinutes: number;
  quietMinutes: number;
  latestVersion?: string;
  lastCheckAt?: number;
  nextCheckAt?: number;
  /** A newer bundle is installed on disk and the daemon is waiting to restart onto it. */
  pendingVersion?: string;
  /** While waiting: threads in the way and how much quiet is still needed. */
  waiting?: { busyThreads: number; quietRemainingMs: number };
  lastError?: string;
  updatedAt: number;
}

export interface UpdateRequest { version: string; now: boolean; requestedAt: number }

export const STATE_FILE = 'update.json';
export const STATUS_FILE = 'update-status.json';
export const REQUEST_FILE = 'update-request.json';
const LOCK_FILE = 'update.lock';

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function readState(dataDir: string): UpdateState {
  const raw = readJson(join(dataDir, STATE_FILE));
  return isObj(raw) ? (raw as UpdateState) : {};
}

export function writeState(dataDir: string, state: UpdateState): void {
  writeFileAtomic(join(dataDir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

export function patchState(dataDir: string, patch: (s: UpdateState) => UpdateState): UpdateState {
  const next = patch(readState(dataDir));
  writeState(dataDir, next);
  return next;
}

export function readStatus(dataDir: string): UpdateStatus | null {
  const raw = readJson(join(dataDir, STATUS_FILE));
  return isObj(raw) && typeof raw.version === 'string' && typeof raw.phase === 'string' ? (raw as unknown as UpdateStatus) : null;
}

export function writeStatus(dataDir: string, status: UpdateStatus): void {
  writeFileAtomic(join(dataDir, STATUS_FILE), `${JSON.stringify(status, null, 2)}\n`);
}

export function writeRequest(dataDir: string, req: UpdateRequest): void {
  writeFileAtomic(join(dataDir, REQUEST_FILE), `${JSON.stringify(req)}\n`);
}

/** Read and delete the request, if there is a well-formed one. */
export function takeRequest(dataDir: string): UpdateRequest | null {
  const file = join(dataDir, REQUEST_FILE);
  const raw = readJson(file);
  if (raw === undefined && !fileExists(file)) return null;
  try { rmSync(file, { force: true }); } catch { /* best effort */ }
  if (!isObj(raw) || typeof raw.version !== 'string') return null;
  return { version: raw.version, now: raw.now === true, requestedAt: typeof raw.requestedAt === 'number' ? raw.requestedAt : 0 };
}

function fileExists(file: string): boolean {
  try { statSync(file); return true; } catch { return false; }
}

export const LOCK_STALE_MS = 10 * 60_000;

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Run `fn` holding the staging lock, or return `null` when someone else holds it. A lock whose owner is gone or that
 * is older than `LOCK_STALE_MS` is taken over (a crash must not block updates forever).
 */
export async function withUpdateLock<T>(dataDir: string, fn: () => Promise<T>, now: () => number = Date.now): Promise<T | null> {
  ensureDir(dataDir);
  const file = join(dataDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, at: now() })); } finally { closeSync(fd); }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const held = readJson(file);
      const pid = isObj(held) && typeof held.pid === 'number' ? held.pid : 0;
      const at = isObj(held) && typeof held.at === 'number' ? held.at : 0;
      const stale = now() - at > LOCK_STALE_MS || (pid > 0 && !pidAlive(pid));
      if (!stale || attempt === 1) return null;
      rmSync(file, { force: true });
    }
  }
  try { return await fn(); } finally { rmSync(file, { force: true }); }
}

/**
 * Leveled logger for Agent Threads.
 *
 * High-frequency operational logs (stream events, per-message, per-connection) are
 * gated behind debug mode so they don't accumulate in long-running sessions.
 * Warnings and errors always surface regardless of the setting.
 *
 * On top of console output, every retained entry is pushed to a bounded in-memory
 * ring buffer (the last ~2000 entries) so the diagnostics export can attach a recent
 * log tail when a user reports a problem. `warn`/`error`/`info` are always retained;
 * `debug` is retained only while debug mode is on. Nothing here ever touches the
 * network or the disk — the ring lives in memory and is dropped on reload.
 *
 * Back-compat: `debugLog()` / `setDebugLogging()` keep their original signatures and
 * behavior (debug-gated console.log) and are reimplemented on top of the leveled API.
 *
 * Mobile-safe: this module performs no Node.js built-in calls at load time.
 *
 * Call setDebugLogging(true) from the plugin's onload / settings change handler
 * to enable verbose output.
 */

import { redactDeep } from './secretRedaction';

export type LogLevel ='debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /** Epoch milliseconds when the entry was recorded. */
  ts: number;
  level: LogLevel;
  /** Optional subsystem tag (e.g. 'kanban', 'relay'). */
  category?: string;
  /** Rendered, single-line message text. */
  msg: string;
}

/** Max entries retained in the in-memory ring. Oldest are evicted first. */
export const LOG_RING_CAPACITY = 2000;

let _debugEnabled = false;
const _ring: LogEntry[] = [];

/** Render an arbitrary set of console-style args into one loggable string. */
function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

function pushRing(entry: LogEntry): void {
  _ring.push(entry);
  // Bound the ring: evict from the front once over capacity. A single push can
  // only overflow by one, but the while-loop keeps this correct if the cap is
  // ever lowered at runtime.
  while (_ring.length > LOG_RING_CAPACITY) _ring.shift();
}

/**
 * Core log entry point. `debug` is gated by debug mode for BOTH console output and
 * ring retention; every other level is always retained and always echoed to the
 * console via the matching method.
 */
export function log(level: LogLevel, category: string | undefined, ...args: unknown[]): void {
  if (level === 'debug' && !_debugEnabled) return;

  // Mask secrets once, up front, so neither the console nor the ring (which
  // feeds the diagnostics export) can ever see a raw credential.
  const safeArgs = args.map((a) => redactDeep(a));

  pushRing({ ts: Date.now(), level, category, msg: formatArgs(safeArgs) });

  const prefixed = category ? [`[${category}]`, ...safeArgs] : safeArgs;
  switch (level) {
    case 'debug':
    case 'info':
      console.log(...prefixed);
      break;
    case 'warn':
      console.warn(...prefixed);
      break;
    case 'error':
      console.error(...prefixed);
      break;
  }
}

/** Leveled logging helpers. Each takes console-style args; category is omitted. */
export const logger = {
  debug: (...args: unknown[]): void => log('debug', undefined, ...args),
  info: (...args: unknown[]): void => log('info', undefined, ...args),
  warn: (...args: unknown[]): void => log('warn', undefined, ...args),
  error: (...args: unknown[]): void => log('error', undefined, ...args),
  /** Log with an explicit subsystem category tag. */
  tagged: (level: LogLevel, category: string, ...args: unknown[]): void =>
    log(level, category, ...args),
};

export function setDebugLogging(enabled: boolean): void {
  _debugEnabled = enabled;
}

export function isDebugLogging(): boolean {
  return _debugEnabled;
}

/** Emit only when debug mode is on. Use for high-frequency or verbose operational logs. */
export function debugLog(...args: unknown[]): void {
  log('debug', undefined, ...args);
}

/**
 * Return a snapshot of the most recent ring entries (oldest first). Defaults to the
 * full ring. The returned array is a copy — callers cannot mutate internal state.
 */
export function getLogRing(limit?: number): LogEntry[] {
  if (limit === undefined || limit >= _ring.length) return [..._ring];
  return _ring.slice(_ring.length - Math.max(0, limit));
}

/** Clear the ring. Primarily for tests. */
export function clearLogRing(): void {
  _ring.length = 0;
}

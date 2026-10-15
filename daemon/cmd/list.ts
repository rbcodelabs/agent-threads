/** `agent-threads list`: the threads (sessions) a daemon knows about. */
import type { DaemonClient } from '../../src/remote/DaemonClient';
import { command } from './connection';
import { CliError } from './exit';

/** What `session.list` returns for one thread (see ThreadHost.list). */
export interface ThreadRow {
  threadId: string;
  lastSeq: number;
  open: boolean;
  turnInFlight: boolean;
  hasPendingPermission: boolean;
  cwd?: string;
  nativeSessionId?: string;
  lastActivityAt?: number;
}

export type ThreadState = 'waiting' | 'running' | 'idle' | 'closed';

export function stateOf(r: ThreadRow): ThreadState {
  if (r.hasPendingPermission) return 'waiting';
  if (r.turnInFlight) return 'running';
  return r.open ? 'idle' : 'closed';
}

const RANK: Record<ThreadState, number> = { waiting: 0, running: 1, idle: 2, closed: 3 };

/** Needs-you first, then running, idle, closed; ties by id so the order is deterministic. */
export function sortRows(rows: ThreadRow[]): ThreadRow[] {
  return [...rows].sort((a, b) => RANK[stateOf(a)] - RANK[stateOf(b)] || a.threadId.localeCompare(b.threadId));
}

export async function fetchThreads(client: DaemonClient): Promise<ThreadRow[]> {
  const r = await command<{ threads?: ThreadRow[] }>(client, 'session.list', {});
  return Array.isArray(r.threads) ? r.threads : [];
}

/** The NDJSON record for one thread. Field order is part of the `--json` contract. */
export function jsonRecord(r: ThreadRow): Record<string, unknown> {
  return {
    threadId: r.threadId,
    state: stateOf(r),
    lastSeq: r.lastSeq,
    open: r.open,
    turnInFlight: r.turnInFlight,
    hasPendingPermission: r.hasPendingPermission,
    cwd: r.cwd ?? null,
    nativeSessionId: r.nativeSessionId ?? null,
    lastActivityAt: r.lastActivityAt ?? null,
  };
}

export function formatTable(rows: ThreadRow[]): string[] {
  if (rows.length === 0) return ['(no threads)'];
  const header = ['THREAD', 'STATE', 'SEQ', 'CWD'];
  const body = sortRows(rows).map((r) => [r.threadId, stateOf(r), String(r.lastSeq), r.cwd ?? '-']);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const fmt = (cols: string[]): string => cols.map((c, i) => (i === cols.length - 1 ? c : c.padEnd(widths[i]))).join('  ');
  return [fmt(header), ...body.map(fmt)];
}

/**
 * Resolve what the user typed to one thread id: an exact id, or a prefix that matches exactly one.
 * Throws a `CliError` that names the candidates when it cannot decide.
 */
export function resolveThreadId(rows: ThreadRow[], given: string): string {
  if (rows.some((r) => r.threadId === given)) return given;
  const hits = rows.filter((r) => r.threadId.startsWith(given));
  if (hits.length === 1) return hits[0].threadId;
  if (hits.length === 0) throw new CliError(`no thread "${given}" on this daemon (see \`agent-threads list\`)`);
  throw new CliError(`"${given}" matches ${hits.length} threads: ${hits.slice(0, 5).map((h) => h.threadId).join(', ')}${hits.length > 5 ? ', ...' : ''}`);
}

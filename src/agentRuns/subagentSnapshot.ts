/**
 * Pure projection of `AgentRun`s into the JSON the `threads_list_subagents` MCP tool returns.
 *
 * No `obsidian`, no DOM, no store access: it takes a plain array and returns a new object, so it cannot mutate the
 * store or emit events. Status handling is deliberately conservative: only the states the store can observe live
 * (`starting`, `working`, `waiting`, `completed`, `failed`, `interrupted`) are reported as known. Everything else
 * (`unavailable`, which `AgentRunStore.restore` assigns to a run that was active when it was persisted, a missing
 * status, or a value this build does not recognise) is reported as `unknown`, never as running or completed.
 */

import type { AgentRun, AgentRunStatus } from '../types';

/** Maximum agents returned in one call; the rest are dropped and `truncated` is set. */
export const MAX_SUBAGENTS = 50;
/** Maximum characters kept from free-text fields (description, summary, error, activity). */
export const MAX_SUBAGENT_TEXT = 500;

/** The statuses whose meaning is exactly what the store recorded. */
export const KNOWN_SUBAGENT_STATUSES: readonly AgentRunStatus[] = [
  'starting', 'working', 'waiting', 'completed', 'failed', 'interrupted',
];

export type SubagentStatus = (typeof KNOWN_SUBAGENT_STATUSES)[number] | 'unknown';

export interface SubagentEntry {
  /** AgentRun id (stable plugin id). */
  id: string;
  /** Harness-native agent id: the ID to pass to SendMessage and TaskStop. */
  nativeAgentId: string;
  taskId?: string;
  description: string;
  /** Subagent type / role as reported by the harness. */
  role?: string;
  model?: string;
  harness: string;
  /** Last known lifecycle state, or `unknown` when it cannot be established. */
  status: SubagentStatus;
  /** False when `status` is `unknown`. */
  statusKnown: boolean;
  /** The status string exactly as stored (absent only if the run had none). */
  storedStatus?: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  parentAgentRunId?: string;
  parentNativeAgentId?: string;
  currentActivity?: string;
  resultSummary?: string;
  error?: string;
}

export interface SubagentList {
  threadId: string;
  count: number;
  /** True when more than MAX_SUBAGENTS runs exist; `count` is the number returned, `total` the number stored. */
  truncated: boolean;
  total: number;
  subagents: SubagentEntry[];
}

const KNOWN = new Set<string>(KNOWN_SUBAGENT_STATUSES);

export function classifySubagentStatus(stored: unknown): { status: SubagentStatus; statusKnown: boolean } {
  if (typeof stored === 'string' && KNOWN.has(stored)) return { status: stored as SubagentStatus, statusKnown: true };
  return { status: 'unknown', statusKnown: false };
}

function clip(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  return value.length > MAX_SUBAGENT_TEXT ? `${value.slice(0, MAX_SUBAGENT_TEXT)}... [truncated]` : value;
}

function toEntry(run: AgentRun): SubagentEntry {
  const { status, statusKnown } = classifySubagentStatus(run.status);
  const entry: SubagentEntry = {
    id: run.id,
    nativeAgentId: run.nativeAgentId,
    description: clip(run.description) ?? '',
    harness: run.harness,
    status,
    statusKnown,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
  };
  const optional: Array<[keyof SubagentEntry, unknown]> = [
    ['taskId', run.taskId],
    ['role', run.role],
    ['model', run.model],
    ['storedStatus', run.status],
    ['completedAt', run.completedAt],
    ['parentAgentRunId', run.parentAgentRunId],
    ['parentNativeAgentId', run.parentNativeAgentId],
    ['currentActivity', clip(run.currentActivity)],
    ['resultSummary', clip(run.resultSummary)],
    ['error', clip(run.error)],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined && value !== null && value !== '') (entry as unknown as Record<string, unknown>)[key] = value;
  }
  return entry;
}

/** Most recently updated first; ties fall back to start time then id so the order is deterministic. */
export function buildSubagentList(threadId: string, runs: readonly AgentRun[]): SubagentList {
  const sorted = [...runs]
    .filter(run => run.threadId === threadId)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.startedAt - a.startedAt || a.id.localeCompare(b.id));
  const kept = sorted.slice(0, MAX_SUBAGENTS).map(toEntry);
  return { threadId, count: kept.length, truncated: sorted.length > MAX_SUBAGENTS, total: sorted.length, subagents: kept };
}

/**
 * threadRowState.ts
 *
 * Shared classification for "what bucket does this thread belong in" —
 * extracted so AgentDashboard, KanbanView, and the ThreadsView thread
 * switcher panel (previously three independently hand-rolled partition
 * loops) agree on the exact same precedence rules.
 *
 * This does NOT replace `computeUiStatus` in ObsidianTools.ts — that's a
 * separate, coarser, external-facing vocabulary (5 states, no
 * waiting/awaiting distinction) with its own vocabulary-consistency test.
 * This module is strictly for the three view-layer duplicates.
 *
 * Priority order (highest first), matching the precedent already present in
 * the pre-refactor inline implementations (see kanban-bucketing.test.ts —
 * "waiting" is already checked before "error", etc.):
 *
 *   1. hasPendingPermission → 'awaiting' (including restored question/plan state)
 *   2. isRunning            → 'running'
 *   3. hasActiveBackgroundTasks → 'running' (folds into the existing Working
 *      bucket per product decision — a thread with no active foreground turn
 *      but an outstanding background task/subagent/workflow is still "doing
 *      something," it just isn't the caller's own turn anymore)
 *   4. hasPendingWakeup     → 'waiting' (the thread is parked on a timer; its session has not started so isRunning is false)
 *   5. lastError            → 'error'
 *   6. messageCount > 0     → 'idle-reviewed' if reviewed, else 'idle-new'
 *   7. else                 → 'empty'
 */

export type ThreadRowState =
  | 'running'
  | 'awaiting'
  | 'waiting'
  | 'idle-new'
  | 'idle-reviewed'
  | 'error'
  | 'empty';

export interface ThreadClassificationFlags {
  isRunning: boolean;
  /** Permission request OR pending AskUserQuestion. */
  hasPendingPermission: boolean;
  hasActiveBackgroundTasks: boolean;
  hasPendingWakeup: boolean;
  lastError?: string;
  messageCount: number;
  reviewed?: boolean;
}

export function classifyThreadRow(flags: ThreadClassificationFlags): ThreadRowState {
  // Persisted question/plan prompts remain action-required even after their
  // foreground session has parked or the app has reloaded.
  if (flags.hasPendingPermission) return 'awaiting';
  if (flags.isRunning) return 'running';
  if (flags.hasActiveBackgroundTasks) {
    return 'running';
  }
  if (flags.hasPendingWakeup) {
    return 'waiting';
  }
  if (flags.lastError) {
    return 'error';
  }
  if (flags.messageCount > 0) {
    return flags.reviewed ? 'idle-reviewed' : 'idle-new';
  }
  return 'empty';
}

/**
 * Buckets a list of threads (or any per-thread value `T`) by `classifyThreadRow`.
 * Callers merge/split buckets to fit their own layout — e.g. AgentDashboard
 * folds 'awaiting' into 'running' (no separate Awaiting column there), while
 * KanbanView keeps them distinct (it renders a dedicated Awaiting column).
 */
export function partitionThreads<T>(
  threads: T[],
  getFlags: (t: T) => ThreadClassificationFlags,
): Record<ThreadRowState, T[]> {
  const result: Record<ThreadRowState, T[]> = {
    running: [],
    awaiting: [],
    waiting: [],
    'idle-new': [],
    'idle-reviewed': [],
    error: [],
    empty: [],
  };
  for (const t of threads) {
    const state = classifyThreadRow(getFlags(t));
    result[state].push(t);
  }
  return result;
}

/** The live ThreadManager queries `liveRowFlags` reads; a structural subset so views and the dock share one builder. */
export interface LiveRowFlagSource {
  isRunning(id: string): boolean;
  hasPendingPermission(id: string): boolean;
  hasPendingQuestion(id: string): boolean;
  hasPendingPlan(id: string): boolean;
  hasActiveBackgroundTasks(id: string): boolean;
}

/**
 * Classification flags for a thread, read live. The single builder behind the
 * Agent Board's bucketing AND the OrchestratorDock's needs-you dot, so the two
 * can never disagree about what is awaiting Rick.
 */
export function liveRowFlags(
  source: LiveRowFlagSource,
  hasPendingWakeup: (id: string) => boolean,
  t: { id: string; lastError?: string; messages: readonly unknown[]; reviewed?: boolean },
): ThreadClassificationFlags {
  return {
    isRunning: source.isRunning(t.id),
    hasPendingPermission: source.hasPendingPermission(t.id) || source.hasPendingQuestion(t.id) || source.hasPendingPlan(t.id),
    hasActiveBackgroundTasks: source.hasActiveBackgroundTasks(t.id),
    hasPendingWakeup: hasPendingWakeup(t.id),
    lastError: t.lastError,
    messageCount: t.messages.length,
    reviewed: t.reviewed,
  };
}

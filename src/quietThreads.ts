/**
 * "Quiet" classification for the Agent Board: a thread an orchestrator has
 * concluded and that has not changed since, so it only adds noise. Quiet
 * threads collapse into a "Concluded (N)" row instead of their status column.
 * Pure (no obsidian import) so it is unit-testable without a view.
 */
import { parseManagerNotesTriage } from './orchestratorCharter';
import { threadNeedsInput, type NeedsInputSource } from './needsInput';

/** A concluded thread must have been unchanged at least this long to go quiet. */
export const QUIET_AFTER_MS = 24 * 60 * 60 * 1000;

export interface QuietThreadFacts extends NeedsInputSource {
  updatedAt: number;
  managerNotes?: string;
  lastError?: string;
}

/** Live (non-persisted) state the manager knows about a thread. */
export interface QuietLiveFlags {
  isRunning: boolean;
  hasActiveBackgroundTasks: boolean;
  hasPendingQuestion: boolean;
  hasPendingPermission: boolean;
  hasPendingPlan: boolean;
  hasPendingWakeup: boolean;
  /** The Portfolio orchestrator or a Project's orchestrator thread. */
  isOrchestrator: boolean;
}

/**
 * Quiet = v2 notes say `concluded` for exactly this `updatedAt`, it has sat for
 * 24h+, nothing is waiting on Rick, nothing is running, and it did not fail.
 * Threads without v2 notes are never quiet (no time-based fallback). Any
 * `updatedAt` change breaks the cursor match and un-quiets the thread.
 */
export function isQuietThread(thread: QuietThreadFacts, live: QuietLiveFlags, now: number): boolean {
  if (live.isOrchestrator) return false;
  if (thread.lastError) return false;
  if (live.isRunning || live.hasActiveBackgroundTasks || live.hasPendingWakeup) return false;
  if (live.hasPendingPermission || live.hasPendingPlan) return false;
  if (threadNeedsInput(thread, live.hasPendingQuestion)) return false;
  if (now - thread.updatedAt < QUIET_AFTER_MS) return false;
  const triage = parseManagerNotesTriage(thread.managerNotes, thread.updatedAt);
  return triage.notesVersion === 'v2'
    && triage.disposition === 'concluded'
    && triage.lastReviewedUpdate === thread.updatedAt;
}

/** Splits items into quiet and the rest, original order kept. */
export function partitionQuiet<T>(items: T[], isQuiet: (item: T) => boolean): { quiet: T[]; rest: T[] } {
  const quiet: T[] = [];
  const rest: T[] = [];
  for (const item of items) (isQuiet(item) ? quiet : rest).push(item);
  return { quiet, rest };
}

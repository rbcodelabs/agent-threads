/**
 * Archive suggestions for the Agent Board: quiet (concluded, unchanged) threads
 * that have also sat for SUGGEST_AFTER_MS, offered as a checklist the user can
 * bulk-archive behind a confirm. Pure (no obsidian import) so it is unit-testable.
 *
 * Nothing here archives anything. `runBulkArchive` only runs after the injected
 * `confirm` resolves true, and it re-checks eligibility per thread at that moment.
 */
import { parsePrNumber } from './gitDiffUtils';
import type { QuietThreadFacts } from './quietThreads';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A quiet thread is only suggested once it has been unchanged at least this long. */
export const SUGGEST_AFTER_MS = 3 * DAY_MS;

export interface SuggestionThreadFacts extends QuietThreadFacts {
  id: string;
  title: string;
  prUrl?: string;
}

export interface ArchiveSuggestion<T extends SuggestionThreadFacts = SuggestionThreadFacts> {
  thread: T;
  /** e.g. "concluded 5d ago · PR #123" */
  reason: string;
}

export function suggestionReason(thread: SuggestionThreadFacts, now: number): string {
  const days = Math.max(0, Math.floor((now - thread.updatedAt) / DAY_MS));
  const pr = parsePrNumber(thread.prUrl);
  return `concluded ${days}d ago${pr !== null ? ` · PR #${pr}` : ''}`;
}

/**
 * Quiet threads (per `isQuietFn`, which owns every exclusion: orchestrators,
 * running, pending input, failed, no v2 notes) that are also at least
 * SUGGEST_AFTER_MS old, oldest-updated first.
 */
export function archiveSuggestionCandidates<T extends SuggestionThreadFacts>(
  threads: T[],
  isQuietFn: (thread: T) => boolean,
  now: number,
): ArchiveSuggestion<T>[] {
  return threads
    .filter((t) => now - t.updatedAt >= SUGGEST_AFTER_MS && isQuietFn(t))
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .map((thread) => ({ thread, reason: suggestionReason(thread, now) }));
}

/** Nothing is preselected: the user must check threads or press "Select all". */
export function initialSelection(): Set<string> {
  return new Set();
}

export function selectionAfterToggle(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function selectAll(ids: readonly string[]): Set<string> {
  return new Set(ids);
}

export function clearSelection(): Set<string> {
  return new Set();
}

/** Drops ids that are no longer listed (a thread left the list while the drawer was open). */
export function pruneSelection(selected: ReadonlySet<string>, listedIds: readonly string[]): Set<string> {
  const listed = new Set(listedIds);
  return new Set([...selected].filter((id) => listed.has(id)));
}

export interface BulkArchiveDeps {
  /** Resolves true only on an explicit user confirm. */
  confirm: () => Promise<boolean>;
  /** Re-evaluated at confirm time, per id. */
  isStillEligible: (id: string) => boolean;
  isOrchestrator: (id: string) => boolean;
  archiveThread: (id: string) => Promise<void>;
}

export interface BulkArchiveResult {
  confirmed: boolean;
  archived: string[];
  /** Eligibility lost since the list was opened (changed, un-quieted, gone, or an orchestrator). */
  skipped: string[];
  failed: string[];
}

/** Archives the selected ids sequentially, only after confirm, only those still eligible. */
export async function runBulkArchive(selectedIds: readonly string[], deps: BulkArchiveDeps): Promise<BulkArchiveResult> {
  const result: BulkArchiveResult = { confirmed: false, archived: [], skipped: [], failed: [] };
  if (selectedIds.length === 0) return result;
  if (!(await deps.confirm())) return result;
  result.confirmed = true;
  for (const id of selectedIds) {
    if (deps.isOrchestrator(id) || !deps.isStillEligible(id)) {
      result.skipped.push(id);
      continue;
    }
    try {
      await deps.archiveThread(id);
      result.archived.push(id);
    } catch {
      result.failed.push(id);
    }
  }
  return result;
}

/** Short result line shown in the drawer after a bulk archive. */
export function bulkArchiveSummary(r: BulkArchiveResult): string {
  if (!r.confirmed) return '';
  const parts = [`Archived ${r.archived.length} thread${r.archived.length === 1 ? '' : 's'}`];
  if (r.skipped.length > 0) parts.push(`${r.skipped.length} skipped, changed since you opened the list`);
  if (r.failed.length > 0) parts.push(`${r.failed.length} failed`);
  return parts.join('. ') + '.';
}

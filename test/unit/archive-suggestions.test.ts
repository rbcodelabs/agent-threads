import { describe, it, expect, vi } from 'vitest';
import {
  SUGGEST_AFTER_MS, archiveSuggestionCandidates, suggestionReason, initialSelection, selectionAfterToggle,
  selectAll, clearSelection, pruneSelection, runBulkArchive, bulkArchiveSummary,
  type SuggestionThreadFacts,
} from '../../src/archiveSuggestions';
import { isQuietThread, type QuietLiveFlags } from '../../src/quietThreads';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function mk(id: string, updatedAt: number, over: Partial<SuggestionThreadFacts> = {}): SuggestionThreadFacts {
  return {
    id, title: `T ${id}`, updatedAt,
    managerNotes: ['Orchestrator state: v2', 'Thread outcome: shipped', 'Disposition: concluded', `Last reviewed update: ${updatedAt}`].join('\n'),
    ...over,
  };
}
const idle: QuietLiveFlags = {
  isRunning: false, hasActiveBackgroundTasks: false, hasPendingQuestion: false, hasPendingPermission: false,
  hasPendingPlan: false, hasPendingWakeup: false, isOrchestrator: false,
};
const quiet = (live: Partial<QuietLiveFlags> = {}) => (t: SuggestionThreadFacts) => isQuietThread(t, { ...idle, ...live }, NOW);

describe('archiveSuggestionCandidates', () => {
  it('3-day boundary: exactly 3d is a candidate, 1ms younger is not', () => {
    const exact = mk('a', NOW - SUGGEST_AFTER_MS);
    const young = mk('b', NOW - SUGGEST_AFTER_MS + 1);
    expect(archiveSuggestionCandidates([exact, young], quiet(), NOW).map((s) => s.thread.id)).toEqual(['a']);
  });

  it('SUGGEST_AFTER_MS is 3 days', () => expect(SUGGEST_AFTER_MS).toBe(3 * DAY));

  it('reuses the quiet predicate: exclusions are not re-implemented', () => {
    const old = NOW - 5 * DAY;
    const t = mk('a', old);
    expect(archiveSuggestionCandidates([t], quiet({ isOrchestrator: true }), NOW)).toEqual([]);
    expect(archiveSuggestionCandidates([t], quiet({ isRunning: true }), NOW)).toEqual([]);
    expect(archiveSuggestionCandidates([t], quiet({ hasPendingQuestion: true }), NOW)).toEqual([]);
    expect(archiveSuggestionCandidates([t], quiet({ hasPendingPermission: true }), NOW)).toEqual([]);
    expect(archiveSuggestionCandidates([t], quiet({ hasPendingPlan: true }), NOW)).toEqual([]);
    expect(archiveSuggestionCandidates([mk('f', old, { lastError: 'boom' })], quiet(), NOW)).toEqual([]);
    expect(archiveSuggestionCandidates([mk('n', old, { managerNotes: undefined })], quiet(), NOW)).toEqual([]);
    expect(archiveSuggestionCandidates([mk('v1', old, { managerNotes: 'Goal: x' })], quiet(), NOW)).toEqual([]);
    expect(archiveSuggestionCandidates([t], quiet(), NOW)).toHaveLength(1);
  });

  it('sorts oldest-updated first', () => {
    const list = [mk('mid', NOW - 4 * DAY), mk('old', NOW - 9 * DAY), mk('new', NOW - 3 * DAY)];
    expect(archiveSuggestionCandidates(list, quiet(), NOW).map((s) => s.thread.id)).toEqual(['old', 'mid', 'new']);
  });

  it('reason text with and without a PR', () => {
    expect(suggestionReason(mk('a', NOW - 5 * DAY), NOW)).toBe('concluded 5d ago');
    expect(suggestionReason(mk('a', NOW - 5 * DAY - 3600_000, { prUrl: 'https://github.com/o/r/pull/123' }), NOW)).toBe('concluded 5d ago · PR #123');
    expect(suggestionReason(mk('a', NOW - 5 * DAY, { prUrl: 'https://example.com/nope' }), NOW)).toBe('concluded 5d ago');
    const [s] = archiveSuggestionCandidates([mk('a', NOW - 6 * DAY, { prUrl: 'https://github.com/o/r/pull/7' })], quiet(), NOW);
    expect(s.reason).toBe('concluded 6d ago · PR #7');
  });
});

describe('selection helpers', () => {
  it('nothing is preselected', () => expect(initialSelection().size).toBe(0));
  it('toggle adds and removes without mutating', () => {
    const a = initialSelection();
    const b = selectionAfterToggle(a, 'x');
    expect([...b]).toEqual(['x']);
    expect(a.size).toBe(0);
    expect(selectionAfterToggle(b, 'x').size).toBe(0);
  });
  it('select all / clear / prune', () => {
    expect([...selectAll(['a', 'b'])]).toEqual(['a', 'b']);
    expect(clearSelection().size).toBe(0);
    expect([...pruneSelection(new Set(['a', 'b']), ['b', 'c'])]).toEqual(['b']);
  });
});

describe('runBulkArchive', () => {
  const base = () => ({
    confirm: vi.fn(async () => true),
    isStillEligible: vi.fn(() => true),
    isOrchestrator: vi.fn(() => false),
    archiveThread: vi.fn(async () => {}),
    exists: vi.fn(() => true),
    persist: vi.fn(async () => {}),
  });

  it('never archives when the confirm is declined', async () => {
    const d = base();
    d.confirm.mockResolvedValue(false);
    const r = await runBulkArchive(['a', 'b'], d);
    expect(d.archiveThread).not.toHaveBeenCalled();
    expect(r.confirmed).toBe(false);
  });

  it('does not even ask for confirm with an empty selection', async () => {
    const d = base();
    await runBulkArchive([], d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.archiveThread).not.toHaveBeenCalled();
  });

  it('archives only still-eligible selected ids, sequentially, and never orchestrators', async () => {
    const d = base();
    d.isStillEligible.mockImplementation((id: string) => id !== 'changed');
    d.isOrchestrator.mockImplementation((id: string) => id === 'orch');
    const order: string[] = [];
    d.archiveThread.mockImplementation(async (id: string) => { order.push(`start:${id}`); await Promise.resolve(); order.push(`end:${id}`); });
    const r = await runBulkArchive(['a', 'changed', 'orch', 'b'], d);
    expect(d.archiveThread.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
    expect(r).toMatchObject({ confirmed: true, archived: ['a', 'b'], skipped: ['changed', 'orch'], failed: [] });
    expect(bulkArchiveSummary(r)).toBe('Archived 2 threads. 2 skipped, changed since you opened the list.');
  });

  it('records a failing archive and continues', async () => {
    const d = base();
    d.archiveThread.mockImplementation(async (id: string) => { if (id === 'a') throw new Error('x'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await runBulkArchive(['a', 'b'], d);
    expect(r.archived).toEqual(['b']);
    expect(r.failed).toEqual(['a']);
    expect(warn).toHaveBeenCalled();
    expect(d.persist).toHaveBeenCalledTimes(1); // partial failure still persists the one that archived
    warn.mockRestore();
  });

  it('persists exactly once after archiving, never when nothing archived or when declined', async () => {
    const d = base();
    await runBulkArchive(['a', 'b'], d);
    expect(d.persist).toHaveBeenCalledTimes(1);
    const none = base();
    none.isStillEligible.mockReturnValue(false);
    await runBulkArchive(['a'], none);
    expect(none.persist).not.toHaveBeenCalled();
    const declined = base();
    declined.confirm.mockResolvedValue(false);
    await runBulkArchive(['a'], declined);
    expect(declined.persist).not.toHaveBeenCalled();
  });

  it('reports threads that no longer exist separately from changed ones', async () => {
    const d = base();
    d.exists.mockImplementation((id: string) => id !== 'gone');
    d.isStillEligible.mockImplementation((id: string) => id !== 'changed');
    const r = await runBulkArchive(['gone', 'changed', 'ok'], d);
    expect(r).toMatchObject({ archived: ['ok'], skipped: ['changed'], missing: ['gone'] });
    expect(bulkArchiveSummary(r)).toBe('Archived 1 thread. 1 skipped, changed since you opened the list. 1 no longer on the board.');
  });
});

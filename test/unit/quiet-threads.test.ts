import { describe, it, expect } from 'vitest';
import { isQuietThread, partitionQuiet, QUIET_AFTER_MS, type QuietThreadFacts, type QuietLiveFlags } from '../../src/quietThreads';

const NOW = 1_800_000_000_000;
const UPDATED = NOW - QUIET_AFTER_MS - 1000;

function notes(updatedAt: number, over: { disposition?: string; cursor?: number; state?: string } = {}): string {
  return [
    `Orchestrator state: ${over.state ?? 'v2'}`,
    'Thread outcome: shipped',
    `Disposition: ${over.disposition ?? 'concluded'}`,
    `Last reviewed update: ${over.cursor ?? updatedAt}`,
  ].join('\n');
}

function thread(over: Partial<QuietThreadFacts> = {}): QuietThreadFacts {
  const updatedAt = over.updatedAt ?? UPDATED;
  return { updatedAt, managerNotes: notes(updatedAt), ...over };
}

const idle: QuietLiveFlags = {
  isRunning: false,
  hasActiveBackgroundTasks: false,
  hasPendingQuestion: false,
  hasPendingPermission: false,
  hasPendingPlan: false,
  hasPendingWakeup: false,
  isOrchestrator: false,
};

const quiet = (t: QuietThreadFacts, live: Partial<QuietLiveFlags> = {}, now = NOW) =>
  isQuietThread(t, { ...idle, ...live }, now);

describe('isQuietThread', () => {
  it('is quiet for a v2 concluded thread unchanged for 24h+', () => {
    expect(quiet(thread())).toBe(true);
  });

  it('24h boundary: exactly 24h is quiet, 1ms younger is not', () => {
    const exact = NOW - QUIET_AFTER_MS;
    expect(quiet(thread({ updatedAt: exact, managerNotes: notes(exact) }))).toBe(true);
    const young = exact + 1;
    expect(quiet(thread({ updatedAt: young, managerNotes: notes(young) }))).toBe(false);
  });

  it('is not quiet when the cursor does not match updatedAt (thread changed since concluded)', () => {
    expect(quiet(thread({ managerNotes: notes(UPDATED, { cursor: UPDATED - 5 }) }))).toBe(false);
  });

  it('is not quiet for other dispositions', () => {
    for (const d of ['advance', 'needs-decision', 'no-action']) {
      expect(quiet(thread({ managerNotes: notes(UPDATED, { disposition: d }) }))).toBe(false);
    }
  });

  it('never quiets threads without v2 notes (none or legacy), no time fallback', () => {
    expect(quiet(thread({ managerNotes: undefined }))).toBe(false);
    expect(quiet(thread({ managerNotes: '   ' }))).toBe(false);
    const legacy = `Orchestrator-tracked goal: x\nStatus: done\nLast reviewed: ${UPDATED}`;
    expect(quiet(thread({ managerNotes: legacy }))).toBe(false);
    expect(quiet(thread({ managerNotes: notes(UPDATED, { state: 'v1' }) }))).toBe(false);
    expect(quiet(thread({ updatedAt: 1, managerNotes: undefined }))).toBe(false);
  });

  it('never quiets a failed thread, even if concluded', () => {
    expect(quiet(thread({ lastError: 'crashed' }))).toBe(false);
  });

  it('is not quiet with a staged reply, pending decisions or pending questions', () => {
    expect(quiet(thread({ proposedReply: { text: 'hi', generatedAt: 1 } }))).toBe(false);
    expect(quiet(thread({ pendingDecisions: [{ id: 'd' } as never] }))).toBe(false);
    expect(quiet(thread({ pendingQuestions: [{} as never] }))).toBe(false);
    expect(quiet(thread({ pendingDecisions: [], pendingQuestions: [] }))).toBe(true);
  });

  it('is not quiet with a live pending question, permission or plan', () => {
    expect(quiet(thread(), { hasPendingQuestion: true })).toBe(false);
    expect(quiet(thread(), { hasPendingPermission: true })).toBe(false);
    expect(quiet(thread(), { hasPendingPlan: true })).toBe(false);
  });

  it('is not quiet while running, with background tasks, or a pending wakeup', () => {
    expect(quiet(thread(), { isRunning: true })).toBe(false);
    expect(quiet(thread(), { hasActiveBackgroundTasks: true })).toBe(false);
    expect(quiet(thread(), { hasPendingWakeup: true })).toBe(false);
  });

  it('never quiets orchestrator threads', () => {
    expect(quiet(thread(), { isOrchestrator: true })).toBe(false);
  });

  it('does not depend on reviewed state (unreviewed concluded threads still quiet)', () => {
    expect(quiet({ ...thread(), reviewed: false } as QuietThreadFacts)).toBe(true);
  });
});

describe('partitionQuiet', () => {
  it('splits quiet from rest keeping order', () => {
    const { quiet: q, rest } = partitionQuiet([1, 2, 3, 4, 5], (n) => n % 2 === 0);
    expect(q).toEqual([2, 4]);
    expect(rest).toEqual([1, 3, 5]);
  });
});

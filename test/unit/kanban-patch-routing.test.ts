import { describe, it, expect } from 'vitest';
import { classifyThreadRow, type ThreadRowState, type ThreadClassificationFlags } from '../../src/threadRowState';

/**
 * Fix 1 — incremental card patching, ROUTING DECISION.
 *
 * The real decision lives in KanbanView.handleEvent()'s isStateChange branch,
 * which is DOM-coupled and only reachable via a fully-constructed KanbanView
 * (jsdom). This mirrors just the pure routing decision — combine the thread's
 * bucket + group into a placement key (KanbanView.computeCardPlacement, backed
 * by the shared, REAL `classifyThreadRow`), then compare against the recorded
 * placement — so it can be exercised in the node pool without a DOM.
 *
 * Keep STATUS_COLUMN_MAP / PROJECT_SECTION_MAP below in sync with the
 * identically-named consts in src/KanbanView.ts. (The real handleEvent path is
 * additionally covered end-to-end in kanban-incremental-patch.test.ts, which
 * runs under jsdom.)
 */

const STATUS_COLUMN_MAP: Record<ThreadRowState, { label: string; state: string }> = {
  running:         { label: 'Working', state: 'running' },
  awaiting:        { label: 'Awaiting', state: 'running' },
  waiting:         { label: 'Waiting', state: 'waiting' },
  'idle-new':      { label: 'New', state: 'idle' },
  'idle-reviewed': { label: 'Done', state: 'idle' },
  error:           { label: 'Failed', state: 'error' },
  empty:           { label: 'Ready', state: 'empty' },
};

const PROJECT_SECTION_MAP: Record<ThreadRowState, { label: string; state: string }> = {
  running:         { label: 'Working', state: 'running' },
  awaiting:        { label: 'Working', state: 'running' },
  waiting:         { label: 'Waiting', state: 'waiting' },
  'idle-new':      { label: 'New', state: 'idle' },
  'idle-reviewed': { label: 'Reviewed', state: 'idle' },
  error:           { label: 'Failed', state: 'error' },
  empty:           { label: 'Ready', state: 'empty' },
};

type Placement = { bucketKey: string; state: string };

function computePlacement(
  flags: ThreadClassificationFlags,
  groupBy: 'status' | 'folder' | 'project' | 'gallery',
  groupLabel: string,
  needsYou = false,
): Placement {
  const rowState = classifyThreadRow(flags);
  if (groupBy === 'gallery') {
    // Mirrors KanbanView.computeCardPlacement: featured vs grid area, status-board row state.
    return { bucketKey: needsYou ? 'gallery::featured' : 'gallery::grid', state: STATUS_COLUMN_MAP[rowState].state };
  }
  if (groupBy === 'project') {
    const { label, state } = PROJECT_SECTION_MAP[rowState];
    return { bucketKey: `${groupLabel}::${label}`, state };
  }
  const { label, state } = STATUS_COLUMN_MAP[rowState];
  if (groupBy === 'folder') return { bucketKey: `${groupLabel}::${label}`, state };
  return { bucketKey: label, state };
}

/** Mirrors the patch-vs-rebuild decision in handleEvent's isStateChange branch. */
function route(recorded: Placement | undefined, next: Placement, hasRenderedCard: boolean): 'patch' | 'rebuild' {
  if (recorded && hasRenderedCard && next.bucketKey === recorded.bucketKey && next.state === recorded.state) {
    return 'patch';
  }
  return 'rebuild';
}

const flags = (o: Partial<ThreadClassificationFlags> = {}): ThreadClassificationFlags => ({
  isRunning: false,
  hasPendingPermission: false,
  hasActiveBackgroundTasks: false,
  hasPendingWakeup: false,
  lastError: undefined,
  messageCount: 1,
  reviewed: false,
  ...o,
});

describe('KanbanView patch-vs-rebuild routing (status board)', () => {
  it('patches when the column is unchanged (idle-new stays idle-new)', () => {
    const recorded = computePlacement(flags(), 'status', '');
    expect(recorded).toEqual({ bucketKey: 'New', state: 'idle' });
    const next = computePlacement(flags(), 'status', '');
    expect(route(recorded, next, true)).toBe('patch');
  });

  it('rebuilds on a real column move (running -> New when the run finishes)', () => {
    const recorded = computePlacement(flags({ isRunning: true }), 'status', '');
    expect(recorded).toEqual({ bucketKey: 'Working', state: 'running' });
    // Run finished: no longer running, has messages, not reviewed -> New.
    const next = computePlacement(flags({ isRunning: false }), 'status', '');
    expect(next).toEqual({ bucketKey: 'New', state: 'idle' });
    expect(route(recorded, next, true)).toBe('rebuild');
  });

  it('rebuilds on running -> error (Working -> Failed)', () => {
    const recorded = computePlacement(flags({ isRunning: true }), 'status', '');
    const next = computePlacement(flags({ isRunning: false, lastError: 'boom' }), 'status', '');
    expect(next.bucketKey).toBe('Failed');
    expect(route(recorded, next, true)).toBe('rebuild');
  });

  it('rebuilds a thread_created / not-yet-rendered thread (no recorded placement)', () => {
    const next = computePlacement(flags(), 'status', '');
    expect(route(undefined, next, false)).toBe('rebuild');
  });

  it('rebuilds when the card is not currently rendered (filtered out / collapsed stack)', () => {
    const recorded = computePlacement(flags(), 'status', '');
    const next = computePlacement(flags(), 'status', '');
    expect(route(recorded, next, false)).toBe('rebuild');
  });
});

describe('KanbanView patch-vs-rebuild routing (grouped boards)', () => {
  it('folder mode: same group + same column patches; a group change rebuilds', () => {
    const recorded = computePlacement(flags(), 'folder', 'repo-a');
    expect(recorded.bucketKey).toBe('repo-a::New');
    expect(route(recorded, computePlacement(flags(), 'folder', 'repo-a'), true)).toBe('patch');
    // If it somehow lands under a different group label, that's a move -> rebuild.
    expect(route(recorded, computePlacement(flags(), 'folder', 'repo-b'), true)).toBe('rebuild');
  });

  it('project mode: awaiting folds into Working, so running<->awaiting stays a patch', () => {
    const running = computePlacement(flags({ isRunning: true }), 'project', 'proj');
    const awaiting = computePlacement(flags({ isRunning: true, hasPendingPermission: true }), 'project', 'proj');
    expect(running.bucketKey).toBe('proj::Working');
    expect(awaiting.bucketKey).toBe('proj::Working');
    expect(route(running, awaiting, true)).toBe('patch');
  });

  it('status mode: awaiting is its own column, so running -> awaiting rebuilds', () => {
    const running = computePlacement(flags({ isRunning: true }), 'status', '');
    const awaiting = computePlacement(flags({ isRunning: true, hasPendingPermission: true }), 'status', '');
    expect(running.bucketKey).toBe('Working');
    expect(awaiting.bucketKey).toBe('Awaiting');
    expect(route(running, awaiting, true)).toBe('rebuild');
  });
});

describe('KanbanView patch-vs-rebuild routing (gallery)', () => {
  it('uses its own stable bucket keys, never the status-board keys', () => {
    expect(computePlacement(flags(), 'gallery', '').bucketKey).toBe('gallery::grid');
    expect(computePlacement(flags(), 'gallery', '', true).bucketKey).toBe('gallery::featured');
  });
  it('patches in place while the card stays in its area and state', () => {
    const recorded = computePlacement(flags({ isRunning: true }), 'gallery', '');
    expect(route(recorded, computePlacement(flags({ isRunning: true }), 'gallery', ''), true)).toBe('patch');
  });
  it('rebuilds when a thread starts needing the user (grid -> featured)', () => {
    const recorded = computePlacement(flags(), 'gallery', '');
    expect(route(recorded, computePlacement(flags(), 'gallery', '', true), true)).toBe('rebuild');
  });
  it('rebuilds when the run finishes (state change)', () => {
    const recorded = computePlacement(flags({ isRunning: true }), 'gallery', '');
    expect(route(recorded, computePlacement(flags(), 'gallery', ''), true)).toBe('rebuild');
  });
});

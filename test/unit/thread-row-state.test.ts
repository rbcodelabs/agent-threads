import { describe, it, expect } from 'vitest';
import { classifyThreadRow, partitionThreads, type ThreadClassificationFlags } from '../../src/threadRowState';

function flags(overrides: Partial<ThreadClassificationFlags> = {}): ThreadClassificationFlags {
  return {
    isRunning: false,
    hasPendingPermission: false,
    hasActiveBackgroundTasks: false,
    hasPendingWakeup: false,
    lastError: undefined,
    messageCount: 0,
    reviewed: false,
    ...overrides,
  };
}

describe('classifyThreadRow', () => {
  // ── The background-task bug this module exists to fix ─────────────────────

  it('background-task-only thread (not running, has active bg task) → running', () => {
    expect(classifyThreadRow(flags({ isRunning: false, hasActiveBackgroundTasks: true }))).toBe('running');
  });

  it('background task active + pending wakeup simultaneously → running wins (background takes priority)', () => {
    expect(
      classifyThreadRow(flags({ isRunning: false, hasActiveBackgroundTasks: true, hasPendingWakeup: true })),
    ).toBe('running');
  });

  it('background task active + lastError set → running wins (background takes priority over stale error)', () => {
    expect(
      classifyThreadRow(flags({ isRunning: false, hasActiveBackgroundTasks: true, lastError: 'stale error' })),
    ).toBe('running');
  });

  it('background task active + messages + reviewed → running wins (does not fall through to idle-reviewed)', () => {
    expect(
      classifyThreadRow(flags({ isRunning: false, hasActiveBackgroundTasks: true, messageCount: 3, reviewed: true })),
    ).toBe('running');
  });

  it('background flag false + no other state → falls through correctly to idle-new/idle-reviewed/empty/error', () => {
    expect(classifyThreadRow(flags({ hasActiveBackgroundTasks: false, messageCount: 2, reviewed: false }))).toBe('idle-new');
    expect(classifyThreadRow(flags({ hasActiveBackgroundTasks: false, messageCount: 2, reviewed: true }))).toBe('idle-reviewed');
    expect(classifyThreadRow(flags({ hasActiveBackgroundTasks: false, lastError: 'boom' }))).toBe('error');
    expect(classifyThreadRow(flags({ hasActiveBackgroundTasks: false }))).toBe('empty');
  });

  // ── isRunning / awaiting precedence ────────────────────────────────────────

  it('running without pending permission → running', () => {
    expect(classifyThreadRow(flags({ isRunning: true }))).toBe('running');
  });

  it('running with pending permission → awaiting', () => {
    expect(classifyThreadRow(flags({ isRunning: true, hasPendingPermission: true }))).toBe('awaiting');
  });

  it('plan-parked thread (running + plan pending, surfaced via hasPendingPermission) → awaiting, not running', () => {
    // The 4 view call sites OR `manager.hasPendingPlan(id)` into the
    // hasPendingPermission flag so a thread wedged at an ExitPlanMode
    // plan-approval prompt classifies as the calmer 'awaiting' state rather
    // than the aggressive 'running' spinner — see fix/stale-run-spinner-cpu.
    expect(classifyThreadRow(flags({ isRunning: true, hasPendingPermission: true }))).toBe('awaiting');
  });

  it('running wins over hasActiveBackgroundTasks (isRunning checked first)', () => {
    expect(classifyThreadRow(flags({ isRunning: true, hasActiveBackgroundTasks: true, hasPendingPermission: true }))).toBe('awaiting');
  });

  it('running with a pending wakeup stays running, not waiting (isRunning wins)', () => {
    expect(classifyThreadRow(flags({ isRunning: true, hasPendingWakeup: true }))).toBe('running');
  });

  it('running with lastError → running (running branch wins)', () => {
    expect(classifyThreadRow(flags({ isRunning: true, lastError: 'stale error from last run' }))).toBe('running');
  });

  // ── waiting / error precedence (existing precedent from old inline impls) ──

  it('idle thread with a pending wakeup → waiting', () => {
    expect(classifyThreadRow(flags({ hasPendingWakeup: true }))).toBe('waiting');
  });

  it('pending wakeup takes priority over lastError (waiting, not error)', () => {
    expect(classifyThreadRow(flags({ hasPendingWakeup: true, lastError: 'stale error from a prior run' }))).toBe('waiting');
  });

  it('lastError and no messages → error (not empty)', () => {
    expect(classifyThreadRow(flags({ lastError: 'timeout', messageCount: 0 }))).toBe('error');
  });

  // ── idle-new / idle-reviewed / empty ───────────────────────────────────────

  it('idle thread with messages, reviewed: false → idle-new', () => {
    expect(classifyThreadRow(flags({ messageCount: 1, reviewed: false }))).toBe('idle-new');
  });

  it('idle thread with messages, reviewed: true → idle-reviewed', () => {
    expect(classifyThreadRow(flags({ messageCount: 1, reviewed: true }))).toBe('idle-reviewed');
  });

  it('idle thread with messages, reviewed: undefined (falsy) → idle-new', () => {
    expect(classifyThreadRow(flags({ messageCount: 1, reviewed: undefined }))).toBe('idle-new');
  });

  it('idle thread with no messages and no error → empty', () => {
    expect(classifyThreadRow(flags())).toBe('empty');
  });
});

describe('partitionThreads', () => {
  it('buckets a mixed list into all seven states', () => {
    const items = [
      { id: 'a', f: flags({ isRunning: true }) },
      { id: 'b', f: flags({ isRunning: true, hasPendingPermission: true }) },
      { id: 'c', f: flags({ hasPendingWakeup: true }) },
      { id: 'd', f: flags({ messageCount: 1, reviewed: false }) },
      { id: 'e', f: flags({ messageCount: 1, reviewed: true }) },
      { id: 'f', f: flags({ lastError: 'boom' }) },
      { id: 'g', f: flags() },
      { id: 'h', f: flags({ hasActiveBackgroundTasks: true }) },
    ];

    const result = partitionThreads(items, (item) => item.f);

    expect(result.running.map(i => i.id)).toEqual(['a', 'h']);
    expect(result.awaiting.map(i => i.id)).toEqual(['b']);
    expect(result.waiting.map(i => i.id)).toEqual(['c']);
    expect(result['idle-new'].map(i => i.id)).toEqual(['d']);
    expect(result['idle-reviewed'].map(i => i.id)).toEqual(['e']);
    expect(result.error.map(i => i.id)).toEqual(['f']);
    expect(result.empty.map(i => i.id)).toEqual(['g']);
  });

  it('empty input produces seven empty buckets', () => {
    const result = partitionThreads<{ f: ThreadClassificationFlags }>([], (item) => item.f);
    expect(result.running).toHaveLength(0);
    expect(result.awaiting).toHaveLength(0);
    expect(result.waiting).toHaveLength(0);
    expect(result['idle-new']).toHaveLength(0);
    expect(result['idle-reviewed']).toHaveLength(0);
    expect(result.error).toHaveLength(0);
    expect(result.empty).toHaveLength(0);
  });
});

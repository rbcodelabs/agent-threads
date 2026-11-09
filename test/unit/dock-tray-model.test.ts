/**
 * dock-tray-model.test.ts
 *
 * Pure model for the sheet's Needs-you tray: which attention items it lists (everything awaiting, never failures),
 * the collapse beyond three, the hand-off labels and the screen-reader text.
 */
import { describe, it, expect } from 'vitest';
import { trayItems, visibleTrayItems, TRAY_COLLAPSE_AT, handoffLabel, handoffAriaLabel, announcementFor } from '../../src/dockTrayModel';
import { attentionItems, needsYouCount, type AttentionItem } from '../../src/orchestratorDockModel';

const item = (threadId: string, kind: AttentionItem['kind'], title = `T ${threadId}`): AttentionItem => ({ threadId, title, kind });

describe('trayItems', () => {
  it('lists permission, question and plan items in the attention order and drops failures', () => {
    const items = [item('a', 'permission'), item('f', 'failed'), item('b', 'question'), item('c', 'plan')];
    expect(trayItems(items).map((i) => i.threadId)).toEqual(['a', 'b', 'c']);
  });

  it('puts permissions first (inline-actionable), keeping attention order within each group', () => {
    const items = [item('q1', 'question'), item('p1', 'permission'), item('pl', 'plan'), item('p2', 'permission'), item('q2', 'question')];
    expect(trayItems(items).map((i) => i.threadId)).toEqual(['p1', 'p2', 'q1', 'pl', 'q2']);
  });

  it('has exactly needsYouCount(...) entries, so the heading matches the dot and the board lane', () => {
    const items = [item('a', 'permission'), item('f', 'failed'), item('b', 'question'), item('f2', 'failed')];
    expect(trayItems(items)).toHaveLength(needsYouCount(items));
  });

  it('is empty when nothing awaits', () => {
    expect(trayItems([])).toEqual([]);
    expect(trayItems([item('f', 'failed')])).toEqual([]);
  });

  it('does not mutate its input', () => {
    const items = [item('a', 'permission'), item('f', 'failed')];
    const copy = JSON.stringify(items);
    trayItems(items);
    expect(JSON.stringify(items)).toBe(copy);
  });

  it('keeps the orchestrator\'s own pending permission (attentionItems does not exclude it)', () => {
    const base = { flags: { isRunning: true, hasPendingPermission: true, hasActiveBackgroundTasks: false, hasPendingWakeup: false, messageCount: 1 }, needsInput: false, pending: { permission: true, question: false, plan: false } };
    const items = attentionItems([{ threadId: 'orch', title: 'Portfolio Orchestrator', ...base }]);
    expect(trayItems(items).map((i) => i.threadId)).toEqual(['orch']);
  });
});

describe('visibleTrayItems', () => {
  const many = (n: number) => trayItems(Array.from({ length: n }, (_, i) => item(`t${i}`, 'permission')));

  it('collapses beyond three', () => {
    expect(TRAY_COLLAPSE_AT).toBe(3);
    const v = visibleTrayItems(many(5), false);
    expect(v.shown.map((i) => i.threadId)).toEqual(['t0', 't1', 't2']);
    expect(v.hidden).toBe(2);
  });

  it('shows everything when expanded', () => {
    const v = visibleTrayItems(many(5), true);
    expect(v.shown).toHaveLength(5);
    expect(v.hidden).toBe(0);
  });

  it('three or fewer never collapse', () => {
    for (const n of [0, 1, 2, 3]) expect(visibleTrayItems(many(n), false)).toEqual({ shown: many(n), hidden: 0 });
  });

  it('four is the first collapsed size: Show 1 more', () => {
    expect(visibleTrayItems(many(4), false).hidden).toBe(1);
  });
});

describe('hand-off + announcement text', () => {
  it('labels the single button per kind', () => {
    expect(handoffLabel('question')).toBe('Answer…');
    expect(handoffLabel('plan')).toBe('Review plan…');
    expect(handoffLabel('permission')).toBe('Open thread…');
  });

  it('accessible names carry the thread title and start with the visible label', () => {
    expect(handoffAriaLabel('question', 'Mobile layout polish')).toBe('Answer Mobile layout polish in its thread');
    expect(handoffAriaLabel('plan', 'Social nudge')).toBe('Review plan for Social nudge');
    expect(handoffAriaLabel('permission', 'Deploy')).toBe('Open Deploy to resolve its permission request');
  });

  it('announces new arrivals by kind', () => {
    expect(announcementFor(item('a', 'permission', 'Deploy'))).toBe('Deploy needs approval');
    expect(announcementFor(item('b', 'question', 'Polish'))).toBe('Polish has a question');
    expect(announcementFor(item('c', 'plan', 'Nudge'))).toBe('Nudge has a plan to review');
  });
});

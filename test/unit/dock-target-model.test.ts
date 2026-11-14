/**
 * dock-target-model.test.ts
 *
 * Pure model behind the dock's orchestrator menu (TASK-29 / SOL-25 / RM-12): which orchestrators the dock can
 * talk to, which one it opens on, the per-target labels, unread counts, needs-you attribution and menu rows.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDockTargets,
  hasTargetMenu,
  defaultTargetId,
  resolveTargetId,
  targetOnOpen,
  targetLabels,
  unreadCount,
  attributeNeedsYou,
  targetRows,
  rowAriaLabel,
} from '../../src/dockTargetModel';

const exists = (...ids: string[]) => (id: string) => ids.includes(id);
const project = (id: string, name: string, orchestratorThreadId?: string) => ({ id, name, orchestratorThreadId });

describe('buildDockTargets', () => {
  it('lists the Portfolio orchestrator first, then each Project orchestrator in project order', () => {
    const t = buildDockTargets({
      portfolioThreadId: 'p',
      projects: [project('x', 'Agent Threads', 'tx'), project('y', 'Compass', 'ty')],
      threadExists: exists('p', 'tx', 'ty'),
    });
    expect(t.map((x) => [x.kind, x.threadId, x.name])).toEqual([
      ['portfolio', 'p', 'Portfolio'], ['project', 'tx', 'Agent Threads'], ['project', 'ty', 'Compass'],
    ]);
    expect(t[1].projectId).toBe('x');
  });

  it('hides projects with no orchestrator thread yet and projects whose thread id is stale (archived)', () => {
    const t = buildDockTargets({
      portfolioThreadId: 'p',
      projects: [project('x', 'None yet'), project('y', 'Stale', 'gone'), project('z', 'Live', 'tz')],
      threadExists: exists('p', 'tz'),
    });
    expect(t.map((x) => x.threadId)).toEqual(['p', 'tz']);
  });

  it('omits a missing / stale Portfolio orchestrator but keeps the project ones', () => {
    expect(buildDockTargets({ portfolioThreadId: undefined, projects: [project('x', 'A', 'tx')], threadExists: exists('tx') }).map((x) => x.threadId)).toEqual(['tx']);
    expect(buildDockTargets({ portfolioThreadId: 'stale', projects: [project('x', 'A', 'tx')], threadExists: exists('tx') }).map((x) => x.threadId)).toEqual(['tx']);
  });

  it('never lists a thread twice (a hand-edited project pointing at the Portfolio thread)', () => {
    const t = buildDockTargets({ portfolioThreadId: 'p', projects: [project('x', 'A', 'p')], threadExists: exists('p') });
    expect(t.map((x) => x.threadId)).toEqual(['p']);
  });
});

describe('menu / default / selection policy', () => {
  const both = buildDockTargets({ portfolioThreadId: 'p', projects: [project('x', 'A', 'tx')], threadExists: exists('p', 'tx') });
  const portfolioOnly = buildDockTargets({ portfolioThreadId: 'p', projects: [project('x', 'A')], threadExists: exists('p') });
  const projectsOnly = buildDockTargets({ portfolioThreadId: undefined, projects: [project('x', 'A', 'tx'), project('y', 'B', 'ty')], threadExists: exists('tx', 'ty') });

  it('the title is a menu only when at least one Project orchestrator exists', () => {
    expect(hasTargetMenu(both)).toBe(true);
    expect(hasTargetMenu(projectsOnly)).toBe(true);
    expect(hasTargetMenu(portfolioOnly)).toBe(false);
    expect(hasTargetMenu([])).toBe(false);
  });

  it('the default is the Portfolio orchestrator, else the first project', () => {
    expect(defaultTargetId(both)).toBe('p');
    expect(defaultTargetId(projectsOnly)).toBe('tx');
    expect(defaultTargetId([])).toBeUndefined();
  });

  it('a selection that is no longer a target falls back to the default', () => {
    expect(resolveTargetId(both, 'tx')).toBe('tx');
    expect(resolveTargetId(both, 'gone')).toBe('p');
    expect(resolveTargetId(both, undefined)).toBe('p');
  });

  it('the sheet opens on the Portfolio unless a valid source target (an unread peek) is requested', () => {
    expect(targetOnOpen(both)).toBe('p');
    expect(targetOnOpen(both, 'tx')).toBe('tx');
    expect(targetOnOpen(both, 'gone')).toBe('p');
    expect(targetOnOpen(projectsOnly, undefined)).toBe('tx');
  });
});

describe('targetLabels', () => {
  it('Portfolio keeps today\'s exact strings', () => {
    const l = targetLabels({ kind: 'portfolio', threadId: 'p', name: 'Portfolio' });
    expect(l.title).toBe('Portfolio orchestrator');
    expect(l.askLabel).toBe('Ask the portfolio orchestrator');
    expect(l.regionLabel).toBe('Conversation with the portfolio orchestrator');
    expect(l.replyPlaceholder).toBe('Reply…');
    expect(l.askPlaceholder).toBe('Ask the orchestrator…');
    expect(l.stopLabel).toBe('Stop the orchestrator');
    expect(l.peekName).toBe('Orchestrator');
    expect(l.voice).toBe('Orchestrator');
    expect(l.ownerName).toBe('Portfolio');
  });

  it('a Project target names itself everywhere', () => {
    const l = targetLabels({ kind: 'project', threadId: 'tx', projectId: 'x', name: 'Compass' });
    expect(l.title).toBe('Compass orchestrator');
    expect(l.askLabel).toBe('Ask the Compass orchestrator');
    expect(l.regionLabel).toBe('Conversation with the Compass orchestrator');
    expect(l.replyPlaceholder).toBe('Reply to Compass orchestrator…');
    expect(l.stopLabel).toBe('Stop the Compass orchestrator');
    expect(l.peekName).toBe('Compass');
    expect(l.voice).toBe('Compass orchestrator');
  });

  it('no target (nothing set up) falls back to the Portfolio strings', () => {
    expect(targetLabels(undefined).title).toBe('Portfolio orchestrator');
  });

  it('keeps a hostile project name as plain text (the model never builds HTML)', () => {
    const l = targetLabels({ kind: 'project', threadId: 't', projectId: 'x', name: '<img src=x onerror=alert(1)>' });
    expect(l.title).toBe('<img src=x onerror=alert(1)> orchestrator');
  });
});

describe('unreadCount', () => {
  const msgs = [
    { id: 'u1', role: 'user' }, { id: 'a1', role: 'assistant' }, { id: 'u2', role: 'user' }, { id: 'a2', role: 'assistant' }, { id: 'a3', role: 'assistant' },
  ];
  it('counts assistant messages after the last seen one', () => {
    expect(unreadCount(msgs, 'a1')).toBe(2);
    expect(unreadCount(msgs, 'a3')).toBe(0);
  });
  it('a history that was never seen counts as read (seeded on first sight, so undefined means nothing is unread)', () => {
    expect(unreadCount(msgs, undefined)).toBe(0);
  });
  it('a last-seen message that was rolled back counts the latest assistant reply as one unread', () => {
    expect(unreadCount(msgs, 'gone')).toBe(1);
    expect(unreadCount([{ id: 'u1', role: 'user' }], 'gone')).toBe(0);
  });
});

describe('attributeNeedsYou', () => {
  const targets = buildDockTargets({
    portfolioThreadId: 'p', projects: [project('x', 'A', 'tx'), project('y', 'B', 'ty')], threadExists: exists('p', 'tx', 'ty'),
  });
  const item = (threadId: string, kind: 'permission' | 'question' | 'plan' | 'failed' = 'permission') => ({ threadId, title: threadId, kind });
  const projectOf = (id: string): string | undefined => ({ w1: 'x', w2: 'x', w3: 'y' } as Record<string, string>)[id];

  it('a project thread counts for its project\'s orchestrator; unassigned threads for the Portfolio', () => {
    const n = attributeNeedsYou([item('w1'), item('w2', 'question'), item('w3'), item('free')], targets, projectOf);
    expect(n.get('tx')).toBe(2);
    expect(n.get('ty')).toBe(1);
    expect(n.get('p')).toBe(1);
  });

  it('an orchestrator\'s own prompt counts for itself; failures never count', () => {
    const n = attributeNeedsYou([item('tx', 'plan'), item('w1', 'failed')], targets, projectOf);
    expect(n.get('tx')).toBe(1);
    expect(n.get('p') ?? 0).toBe(0);
  });

  it('without a Portfolio target unassigned threads belong to nobody (they still count on the dot)', () => {
    const noP = buildDockTargets({ portfolioThreadId: undefined, projects: [project('x', 'A', 'tx')], threadExists: exists('tx') });
    expect(attributeNeedsYou([item('free')], noP, projectOf).size).toBe(0);
  });
});

describe('targetRows', () => {
  const targets = buildDockTargets({ portfolioThreadId: 'p', projects: [project('x', 'A', 'tx')], threadExists: exists('p', 'tx') });
  const base = { running: false, error: false, unread: 0, needsYou: 0, hasDraft: false };

  it('one row per target in order with the selection marked', () => {
    const rows = targetRows(targets, () => base, 'tx');
    expect(rows.map((r) => [r.id, r.selected])).toEqual([['p', false], ['tx', true]]);
  });

  it('status: error beats running beats idle', () => {
    const f = (o: object) => () => ({ ...base, ...o });
    expect(targetRows(targets, f({ running: true, error: true }), 'p')[0].status).toBe('error');
    expect(targetRows(targets, f({ running: true }), 'p')[0].status).toBe('running');
    expect(targetRows(targets, f({}), 'p')[0].status).toBe('idle');
  });

  it('carries unread, needs-you and draft through', () => {
    const rows = targetRows(targets, (id) => (id === 'tx' ? { ...base, unread: 2, needsYou: 1, hasDraft: true } : base), 'p');
    expect(rows[1]).toMatchObject({ unread: 2, needsYou: 1, hasDraft: true, name: 'A', kind: 'project' });
    expect(rows[0]).toMatchObject({ unread: 0, needsYou: 0, hasDraft: false, name: 'Portfolio' });
  });

  it('rowAriaLabel reads name, state, unread, needs-you and draft', () => {
    const [r] = targetRows(targets, () => ({ running: true, error: false, unread: 2, needsYou: 1, hasDraft: true }), 'p');
    expect(rowAriaLabel(r)).toBe('Portfolio, running, 2 unread replies, 1 needs you, draft');
    const [q] = targetRows(targets, () => ({ ...base, unread: 1, needsYou: 3 }), 'p');
    expect(rowAriaLabel(q)).toBe('Portfolio, idle, 1 unread reply, 3 need you');
  });
});

/**
 * kanban-needs-you.test.ts
 * @vitest-environment jsdom
 *
 * Orchestrator inbox on the Agent Board: the "Needs you" lane bucketing, the
 * inline proposed-reply / notes / decision / question blocks, in-place event
 * patching, and the "Only needs you" filter. Drives the real KanbanView.
 */
import '../setup/obsidian-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../src/ClaudeSession', () => ({ formatToolName: (n: string) => n }));
vi.mock('../../src/DispatchInput', () => ({ DispatchInput: class { mount() {} destroy() {} setValue() {} } }));

import { KanbanView, NEEDS_YOU_LABEL } from '../../src/KanbanView';
import type { PendingDecision, Thread } from '../../src/types';

function makeThread(id: string, over: Partial<Thread> = {}): Thread {
  return {
    id, title: `Thread ${id}`, cwd: '/repo',
    messages: [{ id: `${id}-m1`, role: 'assistant', content: 'hello', createdAt: 0 }],
    createdAt: 0, updatedAt: 0, status: 'waiting', reviewed: true, ...over,
  } as Thread;
}

const decision = (over: Partial<PendingDecision> = {}): PendingDecision => ({
  id: 'd1', question: 'Ship v2?', header: 'Release',
  options: [{ label: 'Ship', description: 'go' }, { label: 'Hold', description: '' }],
  multiSelect: false, allowOther: true, createdAt: 1, sourceThreadId: 'orch', ...over,
});

function makeHarness(threads: Thread[], groupBy: 'status' | 'folder' = 'status') {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const calls: string[] = [];
  const manager = {
    vaultRoot: '/vault',
    getThreads: () => [...threads].sort((a, b) => a.createdAt - b.createdAt),
    getThread: (id: string) => byId.get(id),
    isRunning: () => false,
    hasPendingPermission: () => false,
    hasPendingQuestion: (id: string) => (byId.get(id)?.pendingQuestions?.length ?? 0) > 0,
    hasPendingPlan: () => false,
    isRunStale: () => false,
    hasActiveBackgroundTasks: () => false,
    getThreadActivity: () => 'Working...',
    getProject: () => undefined,
    getProjects: () => [],
    getPendingPermission: () => undefined,
    getPendingQuestionResolver: () => undefined,
    subscribe: () => () => {},
    notifyProposedReplyChanged: vi.fn(() => { calls.push('notify'); }),
    setThreadPendingQuestions: vi.fn(),
    sendMessage: vi.fn(async (_id: string, text: string) => { calls.push(`send:${text}`); }),
    answerDecision: vi.fn(async () => {}),
  };
  const plugin = {
    manager,
    settings: { kanbanGroupBy: groupBy, stackScheduledThreads: false, alwaysAllowedTools: [], extraEnv: '', kanbanCollapseSide: 'none' },
    hasPendingWakeup: () => false,
    getPendingWakeups: () => [],
    getActiveThreadId: () => null,
    saveSettings: vi.fn(async () => { calls.push('save'); }),
    openThreadInChatView: vi.fn(),
    openThreadWithPrefill: vi.fn(),
  };
  const view = new KanbanView({} as never, plugin as never) as unknown as {
    boardEl: HTMLElement; headerCountEl: HTMLElement; needsYouOnlyBtn: HTMLButtonElement; needsYouOnly: boolean;
    render: () => void; handleEvent: (id: string, ev: { type: string }) => void; scheduleRender: () => void;
    cardPlacements: Map<string, { bucketKey: string; state: string }>;
  };
  view.boardEl = document.createElement('div');
  view.headerCountEl = document.createElement('div');
  view.needsYouOnlyBtn = document.createElement('button');
  return { view, manager, plugin, calls };
}

const colLabels = (board: HTMLElement) => Array.from(board.querySelectorAll('.ct-kanban-col-label')).map((e) => e.textContent);
const colTitles = (board: HTMLElement, label: string) => {
  const col = Array.from(board.querySelectorAll('.ct-kanban-col')).find((c) => c.querySelector('.ct-kanban-col-label')?.textContent === label);
  return Array.from(col?.querySelectorAll('.ct-kanban-card-title') ?? []).map((e) => e.textContent);
};

beforeEach(() => vi.restoreAllMocks());

describe('Needs you lane bucketing (status board)', () => {
  it('collects reply / decision / question threads in a leading lane; others keep their column', () => {
    const { view } = makeHarness([
      makeThread('reply', { createdAt: 1, proposedReply: { text: 'go', generatedAt: 1 } }),
      makeThread('dec', { createdAt: 2, pendingDecisions: [decision()] }),
      makeThread('ask', { createdAt: 3, pendingQuestions: [{ question: 'Which?', header: 'H', options: [], multiSelect: false }] }),
      makeThread('plain', { createdAt: 4 }),
    ]);
    view.render();
    expect(colLabels(view.boardEl)[0]).toBe(NEEDS_YOU_LABEL);
    expect(colTitles(view.boardEl, NEEDS_YOU_LABEL).sort()).toEqual(['Thread ask', 'Thread dec', 'Thread reply']);
    expect(colTitles(view.boardEl, 'Done')).toEqual(['Thread plain']);
    expect(view.cardPlacements.get('reply')!.bucketKey).toBe(NEEDS_YOU_LABEL);
    expect(view.cardPlacements.get('plain')!.bucketKey).toBe('Done');
  });

  it('sorts the lane by recency and omits it when nothing needs Rick', () => {
    const { view } = makeHarness([
      makeThread('old', { updatedAt: 1, proposedReply: { text: 'a', generatedAt: 1 } }),
      makeThread('new', { updatedAt: 9, proposedReply: { text: 'b', generatedAt: 2 } }),
    ]);
    view.render();
    expect(colTitles(view.boardEl, NEEDS_YOU_LABEL)).toEqual(['Thread new', 'Thread old']);

    const none = makeHarness([makeThread('x')]);
    none.view.render();
    expect(colLabels(none.view.boardEl)).not.toContain(NEEDS_YOU_LABEL);
  });

  it('has no lane in folder mode but still renders the blocks on cards', () => {
    const { view } = makeHarness([makeThread('reply', { proposedReply: { text: 'go', generatedAt: 1 } })], 'folder');
    view.render();
    expect(colLabels(view.boardEl)).not.toContain(NEEDS_YOU_LABEL);
    expect(view.boardEl.querySelector('.ct-kanban-reply-approve')).not.toBeNull();
  });

  it('"Only needs you" filters the board', () => {
    const { view } = makeHarness([
      makeThread('reply', { proposedReply: { text: 'go', generatedAt: 1 } }),
      makeThread('plain'),
    ]);
    view.needsYouOnly = true;
    view.render();
    expect(Array.from(view.boardEl.querySelectorAll('.ct-kanban-card-title')).map((e) => e.textContent)).toEqual(['Thread reply']);
  });
});

describe('proposed reply block', () => {
  it('Approve & Send clears the proposal (notify + save) before sending', async () => {
    const t = makeThread('reply', { proposedReply: { text: 'do it', generatedAt: 1 } });
    const { view, manager, calls } = makeHarness([t]);
    view.render();
    view.boardEl.querySelector<HTMLButtonElement>('.ct-kanban-reply-approve')!.click();
    await Promise.resolve();
    expect(t.proposedReply).toBeUndefined();
    expect(manager.sendMessage).toHaveBeenCalledWith('reply', 'do it');
    expect(calls.indexOf('notify')).toBeLessThan(calls.indexOf('send:do it'));
  });

  it('Discard clears without sending; Edit clears and opens the thread prefilled', () => {
    const a = makeThread('a', { proposedReply: { text: 'draft', generatedAt: 1 } });
    const { view, manager, plugin } = makeHarness([a]);
    view.render();
    view.boardEl.querySelector<HTMLButtonElement>('.ct-kanban-reply-edit')!.click();
    expect(plugin.openThreadWithPrefill).toHaveBeenCalledWith('a', 'draft');
    expect(a.proposedReply).toBeUndefined();
    expect(manager.sendMessage).not.toHaveBeenCalled();

    const b = makeThread('b', { proposedReply: { text: 'nope', generatedAt: 2 } });
    const h2 = makeHarness([b]);
    h2.view.render();
    h2.view.boardEl.querySelector<HTMLButtonElement>('.ct-kanban-reply-discard')!.click();
    expect(b.proposedReply).toBeUndefined();
    expect(h2.manager.sendMessage).not.toHaveBeenCalled();
  });

  it('proposed_reply_changed that keeps the placement patches the block in place (folder mode)', () => {
    const t = makeThread('t', { proposedReply: { text: 'one', generatedAt: 1 } });
    const { view } = makeHarness([t], 'folder');
    view.render();
    const sched = vi.spyOn(view as never, 'scheduleRender').mockImplementation(() => {});
    const card = view.boardEl.querySelector('.ct-kanban-card')!;

    t.proposedReply = { text: 'two', generatedAt: 2 };
    view.handleEvent('t', { type: 'proposed_reply_changed' });
    expect(card.querySelector('.ct-kanban-reply-text')!.textContent).toBe('two');
    expect(view.boardEl.querySelector('.ct-kanban-card')).toBe(card);
    expect(sched).not.toHaveBeenCalled();

    delete t.proposedReply;
    view.handleEvent('t', { type: 'proposed_reply_changed' });
    expect(card.querySelector('.ct-kanban-reply')!.classList.contains('ct-hidden')).toBe(true);
    expect(card.querySelector('.ct-kanban-inbox')!.classList.contains('ct-hidden')).toBe(true);
  });

  it('a reply that moves the card into the Needs you lane schedules a rebuild instead', () => {
    const t = makeThread('t');
    const { view } = makeHarness([t]);
    view.render();
    const sched = vi.spyOn(view as never, 'scheduleRender').mockImplementation(() => {});
    t.proposedReply = { text: 'x', generatedAt: 1 };
    view.handleEvent('t', { type: 'proposed_reply_changed' });
    expect(sched).toHaveBeenCalledTimes(1);
  });
});

describe('notes block', () => {
  it('shows a read-only one-line preview, expands on click, and patches on manager_notes_changed', () => {
    const t = makeThread('t', { managerNotes: 'Goal: ship\nStatus: ok', managerNotesUpdatedAt: Date.now() });
    const { view } = makeHarness([t]);
    view.render();
    const notes = view.boardEl.querySelector<HTMLElement>('.ct-kanban-notes')!;
    expect(notes.classList.contains('ct-hidden')).toBe(false);
    expect(notes.querySelector('.ct-kanban-notes-updated')!.textContent).toBe('updated just now');
    expect(notes.querySelector('textarea, input')).toBeNull();
    notes.querySelector<HTMLElement>('.ct-kanban-notes-head')!.click();
    expect(notes.classList.contains('ct-expanded')).toBe(true);

    t.managerNotes = 'Goal: ship\nStatus: blocked';
    const sched = vi.spyOn(view as never, 'scheduleRender').mockImplementation(() => {});
    view.handleEvent('t', { type: 'manager_notes_changed' });
    expect(notes.querySelector('.ct-kanban-notes-text')!.textContent).toContain('blocked');
    expect(notes.classList.contains('ct-expanded')).toBe(true);
    expect(sched).not.toHaveBeenCalled();

    delete t.managerNotes;
    view.handleEvent('t', { type: 'manager_notes_changed' });
    expect(notes.classList.contains('ct-hidden')).toBe(true);
  });

  it('is hidden when a thread has no notes', () => {
    const { view } = makeHarness([makeThread('t')]);
    view.render();
    expect(view.boardEl.querySelector('.ct-kanban-notes')!.classList.contains('ct-hidden')).toBe(true);
  });
});

describe('decision and question blocks', () => {
  it('answers a decision through manager.answerDecision with the chosen option', async () => {
    const t = makeThread('t', { pendingDecisions: [decision()] });
    const { view, manager } = makeHarness([t]);
    view.render();
    const radios = view.boardEl.querySelectorAll<HTMLInputElement>('.ct-kanban-decision input[type=radio]');
    radios[0].checked = true;
    view.boardEl.querySelector<HTMLButtonElement>('.ct-kanban-decision .ct-kanban-inbox-primary')!.click();
    await Promise.resolve();
    expect(manager.answerDecision).toHaveBeenCalledWith('t', 'd1', 'Ship');
  });

  it('does not submit an empty decision answer', async () => {
    const t = makeThread('t', { pendingDecisions: [decision()] });
    const { view, manager } = makeHarness([t]);
    view.render();
    view.boardEl.querySelector<HTMLButtonElement>('.ct-kanban-decision .ct-kanban-inbox-primary')!.click();
    await Promise.resolve();
    expect(manager.answerDecision).not.toHaveBeenCalled();
  });

  it('pending_decisions_changed adds a new form without touching an existing one', () => {
    const t = makeThread('t', { pendingDecisions: [decision()] });
    const { view } = makeHarness([t], 'folder');
    view.render();
    const first = view.boardEl.querySelector('[data-decision-id="d1"]')!;
    t.pendingDecisions = [decision(), decision({ id: 'd2', question: 'Another?' })];
    view.handleEvent('t', { type: 'pending_decisions_changed' });
    expect(view.boardEl.querySelector('[data-decision-id="d1"]')).toBe(first);
    expect(view.boardEl.querySelector('[data-decision-id="d2"]')).not.toBeNull();
  });

  it('answers a restored pending question through the shared helper and masks secrets', async () => {
    const q = { question: 'Token?', header: 'H', options: [], multiSelect: false, isSecret: true, id: 'tok' };
    const t = makeThread('t', { pendingQuestions: [q] });
    const { view, manager } = makeHarness([t]);
    view.render();
    const text = view.boardEl.querySelector<HTMLInputElement>('.ct-kanban-question input.ct-question-other-text')!;
    expect(text.type).toBe('password');
    text.value = 'hunter2';
    text.dispatchEvent(new Event('input'));
    view.boardEl.querySelector<HTMLButtonElement>('.ct-kanban-question .ct-kanban-inbox-primary')!.click();
    expect(manager.setThreadPendingQuestions).toHaveBeenCalledWith('t', undefined);
    const sent = (manager.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]).join('\n');
    expect(sent).not.toContain('hunter2');
    expect(view.boardEl.textContent).not.toContain('hunter2');
  });
});

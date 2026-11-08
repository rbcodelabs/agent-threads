/**
 * kanban-form-interaction-guard.test.ts
 * @vitest-environment jsdom
 *
 * A board rebuild must not run while the user is mid-gesture on an inline
 * question form (pointer held down, or an input focused) — it would eat the
 * click — and the held-back rebuild must run as soon as the gesture ends.
 */
import '../setup/obsidian-dom';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/ClaudeSession', () => ({ formatToolName: (n: string) => n }));
vi.mock('../../src/DispatchInput', () => ({
  DispatchInput: class { mount() {} destroy() {} setValue() {} },
}));

import { KanbanView } from '../../src/KanbanView';
import { telemetry } from '../../src/telemetry';
import type { Thread } from '../../src/types';

function makeThread(id: string, over: Partial<Thread> = {}): Thread {
  return {
    id, title: `Thread ${id}`, cwd: '/repo',
    messages: [{ id: `${id}-m1`, role: 'assistant', content: 'hi', createdAt: 0 }],
    createdAt: 0, updatedAt: 0, status: 'waiting', ...over,
  } as Thread;
}

function makeView(threads: Thread[], running: Set<string>) {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const manager = {
    vaultRoot: '/vault',
    getThreads: () => threads,
    getThread: (id: string) => byId.get(id),
    isRunning: (id: string) => running.has(id),
    hasPendingPermission: () => false,
    hasPendingQuestion: (id: string) => (byId.get(id)?.pendingQuestions?.length ?? 0) > 0,
    hasPendingPlan: () => false,
    isRunStale: () => false,
    hasActiveBackgroundTasks: () => false,
    isAwaitingSandboxDecision: () => false,
    getThreadActivity: () => 'Working...',
    getProject: () => undefined,
    subscribe: () => () => {},
  };
  const plugin = {
    manager,
    settings: { kanbanGroupBy: 'status', orchestratorThreadId: undefined, stackScheduledThreads: false, alwaysAllowedTools: [], extraEnv: '', kanbanCollapseSide: 'none' },
    hasPendingWakeup: () => false, getPendingWakeups: () => [], getActiveThreadId: () => null,
    saveSettings: vi.fn(), openThreadInChatView: vi.fn(),
  };
  const view = new KanbanView({} as never, plugin as never) as unknown as {
    boardEl: HTMLElement; headerCountEl: HTMLElement;
    render: () => void; scheduleRender: () => void; bindFormInteractionGuards: () => void;
  };
  view.boardEl = document.createElement('div');
  document.body.appendChild(view.boardEl);
  view.headerCountEl = document.createElement('div');
  view.bindFormInteractionGuards();
  return view;
}

const ask = { question: 'Which?', header: 'H', options: [{ label: 'A', description: '' }], multiSelect: false };

describe('KanbanView — rebuilds are held while a form is being used', () => {
  beforeEach(() => { telemetry.reset(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

  it('defers a rebuild while an inline form input has focus, then runs it on blur', () => {
    const view = makeView([makeThread('a', { pendingQuestions: [ask] })], new Set());
    view.render();
    const base = telemetry.snapshot().counters.kanbanFullRebuilds;
    const input = view.boardEl.querySelector<HTMLInputElement>('[data-draft-key] input')!;
    input.focus();
    expect(document.activeElement).toBe(input);

    view.scheduleRender();
    vi.advanceTimersByTime(2000);
    expect(telemetry.snapshot().counters.kanbanFullRebuilds).toBe(base); // still held

    input.blur();
    view.boardEl.dispatchEvent(new Event('focusout', { bubbles: true }));
    vi.advanceTimersByTime(10);
    expect(telemetry.snapshot().counters.kanbanFullRebuilds - base).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(telemetry.snapshot().counters.kanbanFullRebuilds - base).toBe(1); // no duplicate
  });

  it('defers while a pointer is down on a form and runs on pointerup', () => {
    const view = makeView([makeThread('a', { pendingQuestions: [ask] })], new Set());
    view.render();
    const base = telemetry.snapshot().counters.kanbanFullRebuilds;
    const form = view.boardEl.querySelector<HTMLElement>('[data-draft-key]')!;
    form.dispatchEvent(new Event('pointerdown', { bubbles: true }));

    view.scheduleRender();
    vi.advanceTimersByTime(2000);
    expect(telemetry.snapshot().counters.kanbanFullRebuilds).toBe(base);

    form.dispatchEvent(new Event('pointerup', { bubbles: true }));
    expect(telemetry.snapshot().counters.kanbanFullRebuilds - base).toBe(1);
  });

  it('rebuilds normally when no form is being used, and gives up deferring after the cap', () => {
    const view = makeView([makeThread('a', { pendingQuestions: [ask] })], new Set());
    view.render();
    const base = telemetry.snapshot().counters.kanbanFullRebuilds;
    view.scheduleRender();
    vi.advanceTimersByTime(200);
    expect(telemetry.snapshot().counters.kanbanFullRebuilds - base).toBe(1);

    view.boardEl.querySelector<HTMLInputElement>('[data-draft-key] input')!.focus();
    view.scheduleRender();
    vi.advanceTimersByTime(61_000);
    expect(telemetry.snapshot().counters.kanbanFullRebuilds - base).toBeGreaterThanOrEqual(2);
  });
});

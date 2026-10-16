/**
 * kanban-incremental-patch.test.ts
 * @vitest-environment jsdom
 *
 * Fix 1 — incremental card patching.
 *
 * Drives the REAL KanbanView.handleEvent() routing (not a mirror) against a
 * minimal fake plugin + ThreadManager. Verifies that a state-change event whose
 * column placement is UNCHANGED takes the in-place `patchCard` path and does NOT
 * schedule a full board rebuild, while a genuine column move (running -> done)
 * and a create both fall through to `scheduleRender`.
 */

import '../setup/obsidian-dom'; // Polyfill Obsidian's HTMLElement extensions for jsdom
import { vi, describe, it, expect, beforeEach } from 'vitest';

// KanbanView only uses `formatToolName` from ClaudeSession, which transitively
// imports the (very heavy) agent SDK — stub it so the test worker can start.
vi.mock('../../src/ClaudeSession', () => ({ formatToolName: (n: string) => n }));
// DispatchInput is only instantiated in buildUI() (not exercised here) but its
// module pulls in stt/fs at load time — stub the class out.
vi.mock('../../src/DispatchInput', () => ({
  DispatchInput: class {
    mount() {}
    destroy() {}
    setValue() {}
  },
}));

import { KanbanView } from '../../src/KanbanView';
import type { Thread } from '../../src/types';

function makeThread(id: string, over: Partial<Thread> = {}): Thread {
  return {
    id,
    title: `Thread ${id}`,
    cwd: '/repo',
    messages: [{ id: `${id}-m1`, role: 'assistant', content: 'hello', createdAt: 0 }],
    createdAt: 0,
    updatedAt: 0,
    status: 'waiting',
    ...over,
  } as Thread;
}

/** Minimal ThreadManager surface the render + handleEvent paths touch. */
function makeManager(threads: Thread[], running: Set<string>) {
  const byId = new Map(threads.map((t) => [t.id, t]));
  return {
    vaultRoot: '/vault',
    getThreads: () => [...threads].sort((a, b) => a.createdAt - b.createdAt),
    getThread: (id: string) => byId.get(id),
    isRunning: (id: string) => running.has(id),
    hasPendingPermission: () => false,
    hasPendingQuestion: () => false,
    hasPendingPlan: () => false,
    isRunStale: () => false,
    hasActiveBackgroundTasks: () => false,
    isAwaitingSandboxDecision: () => false,
    getThreadActivity: () => 'Working...',
    getProject: () => undefined,
    subscribe: () => () => {},
  };
}

function makePlugin(manager: ReturnType<typeof makeManager>) {
  return {
    manager,
    settings: {
      kanbanGroupBy: 'status',
      orchestratorThreadId: undefined,
      stackScheduledThreads: false, // keep every card standalone (no rollups)
      alwaysAllowedTools: [],
      extraEnv: '',
      kanbanCollapseSide: 'none',
    },
    hasPendingWakeup: () => false,
    getPendingWakeups: () => [],
    getActiveThreadId: () => null,
    saveSettings: vi.fn(),
    openThreadInChatView: vi.fn(),
  };
}

/** Build a KanbanView wired to the fakes, with boardEl/headerCountEl stubbed so render() runs without buildUI(). */
function makeView(threads: Thread[], running: Set<string>) {
  const manager = makeManager(threads, running);
  const plugin = makePlugin(manager);
  const leaf = {} as never;
  const view = new KanbanView(leaf, plugin as never) as unknown as {
    boardEl: HTMLElement;
    headerCountEl: HTMLElement;
    render: () => void;
    handleEvent: (id: string, ev: { type: string }) => void;
    patchCard: (id: string) => void;
    scheduleRender: () => void;
    cardPlacements: Map<string, { bucketKey: string; state: string }>;
    rowEls: Map<string, HTMLElement>;
  };
  view.boardEl = document.createElement('div');
  view.headerCountEl = document.createElement('div');
  return { view, plugin, running };
}

describe('KanbanView.handleEvent — incremental patch routing', () => {
  let patchSpy: ReturnType<typeof vi.spyOn>;
  let renderSpy: ReturnType<typeof vi.spyOn>;

  function spy(view: { patchCard: unknown; scheduleRender: unknown }) {
    // patchCard calls through (exercises the real in-place DOM patch);
    // scheduleRender is stubbed so its 120ms timer never fires during the test.
    patchSpy = vi.spyOn(view as never, 'patchCard');
    renderSpy = vi.spyOn(view as never, 'scheduleRender').mockImplementation(() => {});
  }

  beforeEach(() => vi.restoreAllMocks());

  it('status_tags on an idle card whose column is unchanged patches in place (no rebuild)', () => {
    const idle = makeThread('idle', { reviewed: false });
    const { view } = makeView([idle], new Set());
    view.render();
    // Sanity: the card was recorded in the "New" column and rendered.
    expect(view.cardPlacements.get('idle')).toEqual({ bucketKey: 'New', state: 'idle' });
    expect(view.rowEls.has('idle')).toBe(true);

    spy(view);
    view.handleEvent('idle', { type: 'status_tags' });

    expect(patchSpy).toHaveBeenCalledWith('idle');
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('threads_loaded schedules exactly one board rebuild', () => {
    const { view } = makeView([], new Set());
    spy(view);

    view.handleEvent('', { type: 'threads_loaded' });

    expect(renderSpy).toHaveBeenCalledOnce();
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it.each(['project_changed', 'cwd_changed', 'projects_changed'])('%s schedules a full board rebuild', (type) => {
    const idle = makeThread('idle', { reviewed: false });
    const { view } = makeView([idle], new Set());
    view.render();
    spy(view);

    view.handleEvent('idle', { type });

    expect(renderSpy).toHaveBeenCalledOnce();
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('summary_updated on an idle card patches in place (no rebuild)', () => {
    const idle = makeThread('idle', { reviewed: false });
    const { view } = makeView([idle], new Set());
    view.render();
    spy(view);
    view.handleEvent('idle', { type: 'summary_updated' });
    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('done on a running card (running -> New) schedules a full rebuild, not a patch', () => {
    const runningThread = makeThread('run', { reviewed: false });
    const running = new Set<string>(['run']);
    const { view } = makeView([runningThread], running);
    view.render();
    expect(view.cardPlacements.get('run')).toEqual({ bucketKey: 'Working', state: 'running' });

    // Simulate the run finishing: it's no longer running, so it now belongs in "New".
    running.delete('run');

    spy(view);
    view.handleEvent('run', { type: 'done' });

    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('thread_created (no recorded placement) schedules a full rebuild', () => {
    const existing = makeThread('a', { reviewed: false });
    const { view } = makeView([existing], new Set());
    view.render();
    spy(view);
    // A brand-new thread id with no rendered card / recorded placement.
    view.handleEvent('brand-new', { type: 'thread_created' });
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('status_tags for a thread filtered out of the board (no rowEls) falls back to a rebuild', () => {
    const idle = makeThread('idle', { reviewed: false });
    const { view } = makeView([idle], new Set());
    view.render();
    // Drop the rendered element to simulate a card that isn't currently on the board.
    view.rowEls.delete('idle');
    spy(view);
    view.handleEvent('idle', { type: 'status_tags' });
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy).not.toHaveBeenCalled();
  });
});

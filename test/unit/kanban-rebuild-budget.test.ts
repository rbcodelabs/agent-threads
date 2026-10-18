/**
 * kanban-rebuild-budget.test.ts
 * @vitest-environment jsdom
 *
 * Quality gate for the v0.25.7 incremental-render fix.
 *
 * Drives a burst of thread state-change events across N threads through the REAL
 * KanbanView.handleEvent() + scheduleRender() + render() path and asserts, via the
 * telemetry `kanbanFullRebuilds` counter, that a debounced batch collapses to at
 * most ONE full board rebuild — even though every event individually requested a
 * render (`rendersScheduled` climbs to N). A regression that reintroduced a
 * rebuild-per-event storm would make kanbanFullRebuilds scale with N and fail here.
 */

import '../setup/obsidian-dom'; // Polyfill Obsidian's HTMLElement extensions for jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mirror the stubs from kanban-incremental-patch.test.ts: KanbanView transitively
// pulls in the heavy agent SDK (via ClaudeSession) and stt/fs (via DispatchInput).
vi.mock('../../src/ClaudeSession', () => ({ formatToolName: (n: string) => n }));
vi.mock('../../src/DispatchInput', () => ({
  DispatchInput: class {
    mount() {}
    destroy() {}
    setValue() {}
  },
}));

import { KanbanView } from '../../src/KanbanView';
import { telemetry } from '../../src/telemetry';
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
      stackScheduledThreads: false,
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

function makeView(threads: Thread[], running: Set<string>) {
  const manager = makeManager(threads, running);
  const plugin = makePlugin(manager);
  const view = new KanbanView({} as never, plugin as never) as unknown as {
    boardEl: HTMLElement;
    headerCountEl: HTMLElement;
    render: () => void;
    handleEvent: (id: string, ev: { type: string }) => void;
  };
  view.boardEl = document.createElement('div');
  view.headerCountEl = document.createElement('div');
  return view;
}

describe('KanbanView — full-rebuild budget under an event burst', () => {
  beforeEach(() => {
    telemetry.reset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses a burst of N done events into a single full rebuild', () => {
    const N = 12;
    const threads = Array.from({ length: N }, (_, i) => makeThread(`t${i}`, { reviewed: false }));
    const running = new Set<string>(threads.map((t) => t.id));
    const view = makeView(threads, running);

    // Initial paint records placements (all in "Working" since all running).
    view.render();
    const baseline = telemetry.snapshot().counters.kanbanFullRebuilds;
    expect(baseline).toBe(1);

    // Burst: every thread finishes at once → each event moves running→New, so each
    // routes to scheduleRender (a genuine column move, not an in-place patch).
    for (const t of threads) {
      running.delete(t.id);
      view.handleEvent(t.id, { type: 'done' });
    }

    // All N events asked for a render...
    expect(telemetry.snapshot().counters.rendersScheduled).toBe(N);
    // ...but nothing has rebuilt yet (still inside the 120ms debounce window).
    expect(telemetry.snapshot().counters.kanbanFullRebuilds).toBe(baseline);

    // Flush the debounce.
    vi.advanceTimersByTime(200);

    // Exactly one rebuild for the whole batch (≤1 per debounced batch).
    expect(telemetry.snapshot().counters.kanbanFullRebuilds - baseline).toBe(1);
  });

  it('stays at one rebuild per batch across successive bursts', () => {
    const N = 8;
    const threads = Array.from({ length: N }, (_, i) => makeThread(`t${i}`, { reviewed: false }));
    const running = new Set<string>(threads.map((t) => t.id));
    const view = makeView(threads, running);

    view.render();
    telemetry.reset(); // count only post-initial-render rebuilds

    // Batch 1: all finish.
    for (const t of threads) {
      running.delete(t.id);
      view.handleEvent(t.id, { type: 'done' });
    }
    vi.advanceTimersByTime(200);
    expect(telemetry.snapshot().counters.kanbanFullRebuilds).toBe(1);

    // Batch 2: all start streaming again (New→Working move) — another single batch.
    for (const t of threads) {
      running.add(t.id);
      view.handleEvent(t.id, { type: 'streaming_start' });
    }
    vi.advanceTimersByTime(200);
    expect(telemetry.snapshot().counters.kanbanFullRebuilds).toBe(2);
  });
});

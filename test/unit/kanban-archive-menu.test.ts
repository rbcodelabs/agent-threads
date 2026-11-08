/**
 * kanban-archive-menu.test.ts
 * @vitest-environment jsdom
 *
 * Right-click → Archive on the Kanban board, and the double-menu regression it
 * would otherwise cause. Unlike the Agents List — where an expanded rollup's
 * children go into a SIBLING div — KanbanView nests child cards INSIDE the
 * stack card, so attaching the rollup menu to the card rather than its header
 * would open two menus on every nested card. That is what the last test guards.
 *
 * KanbanView is a full Obsidian ItemView and is not constructible under vitest,
 * so these call the real prototype render methods against a stub receiver.
 */
import '../setup/obsidian-dom'; // Polyfill Obsidian's HTMLElement extensions for jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Menu, Platform } from 'obsidian';
import { KanbanView } from '../../src/KanbanView';
import type { Thread } from '../../src/types';
import type { ScheduledStack } from '../../src/scheduledStacks';

type MenuMock = Menu & {
  titles(): string[];
  item(title: string): { clickHandler?: (evt?: unknown) => unknown } | undefined;
};

let opened: MenuMock[] = [];
const realShow = Menu.prototype.showAtMouseEvent;

beforeEach(() => {
  opened = [];
  Menu.prototype.showAtMouseEvent = function (this: MenuMock, evt: unknown) {
    opened.push(this);
    return realShow.call(this, evt);
  } as typeof Menu.prototype.showAtMouseEvent;
});

afterEach(() => {
  Menu.prototype.showAtMouseEvent = realShow;
  Platform.isMobile = false;
});

function thread(id: string, extra: Partial<Thread> = {}): Thread {
  return { id, title: id, messages: [{ role: 'assistant', content: 'done' }], updatedAt: 1, reviewed: true, ...extra } as unknown as Thread;
}

function makeView(threads: Thread[]) {
  const archived: string[] = [];
  // See the twin comment in agent-dashboard-archive-menu.test.ts: the second
  // argument (`onlyIfHasMessages`) is load-bearing for bulk archives and must
  // be recorded, not swallowed by the stub.
  const archiveCalls: Array<[string, boolean | undefined]> = [];
  const cancelled: string[] = [];
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const manager = {
    getThreads: () => threads,
    isRunning: () => false,
    isRunStale: () => false,
    hasPendingPermission: () => false,
    hasPendingQuestion: () => false,
    getPendingPermission: () => null,
    getAgentRuns: () => [],
    getProjects: () => [],
    getProject: () => null,
    getThreadActivity: () => '',
    vaultRoot: '/vault',
  };
  const view = Object.assign(Object.create(KanbanView.prototype), {
    app: {},
    activeThreadId: null,
    manager,
    plugin: {
      manager,
      settings: { orchestratorThreadId: undefined },
      saveSettings,
      hasPendingWakeup: () => false,
      getPendingWakeups: () => [],
      archiveThreadById: async (id: string, onlyIfHasMessages?: boolean) => {
        archived.push(id);
        archiveCalls.push([id, onlyIfHasMessages]);
      },
      cancelWakeups: (id: string) => { cancelled.push(id); },
    },
    activityEls: new Map(),
    timeEls: new Map(),
    rowEls: new Map(),
    summaryEls: new Map(),
    taskEls: new Map(),
    replyEls: new Map(),
    decisionEls: new Map(),
    notesEls: new Map(),
    cardPlacements: new Map(),
    archiveDeps: null,
    expandedScheduledStacks: new Set<string>(),
    scheduleRender: vi.fn(),
    markReviewed: vi.fn(),
  }) as KanbanView;

  return { view, archived, archiveCalls, cancelled, saveSettings };
}

const proto = KanbanView.prototype as unknown as {
  renderCard(this: KanbanView, thread: Thread, state: string, parent: HTMLElement, placementKey: string): void;
  renderStackCard(this: KanbanView, stack: ScheduledStack, state: string, parent: HTMLElement, scopeKey: string): void;
};

function rightClick(el: Element): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
}

const THREE = [thread('t1'), thread('t2'), thread('t3')];

const RUNS = [
  thread('r1', { scheduledItemId: 'nightly', scheduledItemName: 'Nightly sweep' }),
  thread('r2', { scheduledItemId: 'nightly', scheduledItemName: 'Nightly sweep' }),
  thread('manual'),
];
const STACK: ScheduledStack = { scheduledItemId: 'nightly', scheduledItemName: 'Nightly sweep', threads: [RUNS[0], RUNS[1]] };

describe('Kanban — right-click a thread card', () => {
  it('opens exactly one menu offering Archive thread', () => {
    const { view } = makeView(THREE);
    const host = document.createElement('div');
    proto.renderCard.call(view, THREE[0], 'idle', host, 'New');

    const event = rightClick(host.querySelector('.ct-kanban-card')!);

    expect(opened).toHaveLength(1);
    expect(opened[0].titles()).toEqual(['Archive thread']);
    expect(event.defaultPrevented).toBe(true);
  });

  it('archives that thread, cancelling its wake-ups first', async () => {
    const ctx = makeView(THREE);
    const host = document.createElement('div');
    proto.renderCard.call(ctx.view, THREE[0], 'idle', host, 'New');
    rightClick(host.querySelector('.ct-kanban-card')!);

    await opened[0].item('Archive thread')!.clickHandler!();

    expect(ctx.cancelled).toEqual(['t1']);
    expect(ctx.archived).toEqual(['t1']);
    expect(ctx.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('leaves the native context menu alone on mobile', () => {
    Platform.isMobile = true;
    const { view } = makeView(THREE);
    const host = document.createElement('div');
    proto.renderCard.call(view, THREE[0], 'idle', host, 'New');

    const event = rightClick(host.querySelector('.ct-kanban-card')!);

    expect(opened).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('Kanban — right-click a scheduled-job stack card', () => {
  it('opens the rollup menu from the stack header', () => {
    const { view } = makeView(RUNS);
    const host = document.createElement('div');
    proto.renderStackCard.call(view, STACK, 'idle', host, 'New');

    rightClick(host.querySelector('.ct-kanban-stack-header')!);

    expect(opened).toHaveLength(1);
    expect(opened[0].titles()).toEqual(['Archive these 2 runs']);
  });

  it('offers the job-wide item when the job has runs in another column', () => {
    const extra = [...RUNS, thread('r3', { scheduledItemId: 'nightly', scheduledItemName: 'Nightly sweep' })];
    const { view } = makeView(extra);
    const host = document.createElement('div');
    proto.renderStackCard.call(view, STACK, 'idle', host, 'New');

    rightClick(host.querySelector('.ct-kanban-stack-header')!);

    expect(opened[0].titles()).toEqual(['Archive these 2 runs', 'Archive all 3 runs of this job']);
  });

  it('the job-wide item clears runs from every column at once', async () => {
    const extra = [...RUNS, thread('r3', { scheduledItemId: 'nightly', scheduledItemName: 'Nightly sweep' })];
    const ctx = makeView(extra);
    const host = document.createElement('div');
    proto.renderStackCard.call(ctx.view, STACK, 'idle', host, 'New');
    rightClick(host.querySelector('.ct-kanban-stack-header')!);

    const deps = (ctx.view as unknown as { archiveDeps: { confirm: unknown } }).archiveDeps;
    deps.confirm = vi.fn().mockResolvedValue(true);

    await opened[0].item('Archive all 3 runs of this job')!.clickHandler!();

    // r3 was never in this rollup — the job scope re-derived it from live state.
    expect(ctx.archived).toEqual(['r1', 'r2', 'r3']);
    expect(ctx.archiveCalls).toEqual([['r1', true], ['r2', true], ['r3', true]]);
    // One dialog covers all three runs — see the twin assertion on the Agents List.
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(ctx.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('binds the rollup menu to the header only, so the stack card itself carries no listener', () => {
    const { view } = makeView(RUNS);
    const host = document.createElement('div');
    proto.renderStackCard.call(view, STACK, 'idle', host, 'New');

    // The footer is a direct child of the stack card but NOT of its header. If
    // the rollup menu were bound to `card`, this event would bubble into it and
    // open a menu — which is also what would double up on nested cards. This
    // assertion is the one that distinguishes the attach point; the nested-card
    // test below passes either way because attachThreadArchiveMenu stops
    // propagation.
    const event = rightClick(host.querySelector('.ct-kanban-card-stack > .ct-kanban-card-footer')!);

    expect(opened).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it('opens exactly ONE menu for a card nested inside an expanded stack card', () => {
    const { view } = makeView(RUNS);
    (view as unknown as { expandedScheduledStacks: Set<string> }).expandedScheduledStacks.add('New:nightly');
    const host = document.createElement('div');
    proto.renderStackCard.call(view, STACK, 'idle', host, 'New');

    const nested = host.querySelector('.ct-kanban-stack-body .ct-kanban-card')!;
    // The nested card really is a descendant of the stack card — this is the
    // structural difference from the Agents List that makes the header-vs-card
    // attach point load-bearing.
    expect(host.querySelector('.ct-kanban-card-stack')!.contains(nested)).toBe(true);

    rightClick(nested);

    expect(opened).toHaveLength(1);
    expect(opened[0].titles()).toEqual(['Archive thread']);
  });
});

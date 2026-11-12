/**
 * kanban-focus-card.test.ts
 * @vitest-environment jsdom
 *
 * KanbanView.focusCard / clearCardFocus: the board side of the sheet's thread-link hover. Backed by rowEls; the
 * highlight is tracked by thread id because render() clears and rebuilds rowEls.
 */
import '../setup/obsidian-dom';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('../../src/ClaudeSession', () => ({ formatToolName: (n: string) => n }));
vi.mock('../../src/DispatchInput', () => ({ DispatchInput: class { mount() {} destroy() {} setValue() {} } }));

import { KanbanView } from '../../src/KanbanView';

function make() {
  const manager = {
    vaultRoot: '/v', getThreads: () => [], getThread: () => undefined, isRunning: () => false,
    hasPendingPermission: () => false, hasPendingQuestion: () => false, hasPendingPlan: () => false,
    hasActiveBackgroundTasks: () => false, isRunStale: () => false, getProjects: () => [], getProject: () => undefined,
    subscribe: vi.fn(() => vi.fn()),
  };
  const plugin = {
    manager,
    settings: { kanbanGroupBy: 'status', stackScheduledThreads: false, alwaysAllowedTools: [], extraEnv: '', kanbanCollapseSide: 'none' },
    hasPendingWakeup: () => false, getPendingWakeups: () => [], getActiveThreadId: () => null,
    ensureOrchestratorThread: vi.fn(async () => {}), openThreadInChatView: vi.fn(),
    daemonRegistry: null,
  };
  const view = new KanbanView({} as never, plugin as never);
  (view as unknown as { app: unknown }).app = { workspace: { leftSplit: { collapsed: true }, rightSplit: { collapsed: true } } };
  const rowEls = (view as unknown as { rowEls: Map<string, HTMLElement> }).rowEls;
  const card = (id: string) => {
    const el = document.createElement('div');
    el.className = 'ct-kanban-card';
    el.scrollIntoView = vi.fn();
    el.getClientRects = () => [{ width: 100, height: 40 }] as unknown as DOMRectList; // jsdom has no layout: a card with a box
    rowEls.set(id, el);
    return el;
  };
  return { view, rowEls, card };
}

const INTENT_MS = 120;

function reduceMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduce && q.includes('prefers-reduced-motion'), media: q, addEventListener() {}, removeEventListener() {} }));
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('KanbanView.focusCard', () => {
  it('highlights the card and flashes it', () => {
    reduceMotion(false);
    const { view, card } = make();
    const el = card('t1');
    expect(view.focusCard('t1', { scroll: false, flash: true })).toBe(true);
    expect(el.classList.contains('ct-kanban-card-linked')).toBe(true);
    expect(el.classList.contains('ct-kanban-card-linked-flash')).toBe(true);
    expect(el.scrollIntoView).not.toHaveBeenCalled();
  });

  it('scrolls the card into view horizontally centred and vertically minimal (swimlane / project columns) after the hover-intent delay', () => {
    vi.useFakeTimers();
    reduceMotion(false);
    const { view, card } = make();
    const el = card('t1');
    view.focusCard('t1', { scroll: true, flash: false });
    vi.advanceTimersByTime(INTENT_MS);
    expect(el.scrollIntoView).not.toHaveBeenCalled(); // the board is scrolled by the overlay-aware planner, not scrollIntoView
    expect(el.classList.contains('ct-kanban-card-linked-flash')).toBe(false);
  });

  it('prefers-reduced-motion: instant scroll and no flash', () => {
    vi.useFakeTimers();
    reduceMotion(true);
    const { view, card } = make();
    const el = card('t1');
    view.focusCard('t1', { scroll: true, flash: true });
    vi.advanceTimersByTime(INTENT_MS);
    expect(el.classList.contains('ct-kanban-card-linked')).toBe(true);
    expect(el.classList.contains('ct-kanban-card-linked-flash')).toBe(false);
  });

  it('an id that is not on the board (archived, filtered out) is a no-op and does not throw', () => {
    reduceMotion(false);
    const { view, card } = make();
    const el = card('t1');
    expect(view.focusCard('ghost', { scroll: true, flash: true })).toBe(false);
    expect(el.classList.contains('ct-kanban-card-linked')).toBe(false);
    expect(el.scrollIntoView).not.toHaveBeenCalled();
  });

  it('moves the highlight: only one card is linked at a time', () => {
    reduceMotion(false);
    const { view, card } = make();
    const a = card('a'); const b = card('b');
    view.focusCard('a', { scroll: false, flash: true });
    view.focusCard('b', { scroll: false, flash: true });
    expect(a.classList.contains('ct-kanban-card-linked')).toBe(false);
    expect(a.classList.contains('ct-kanban-card-linked-flash')).toBe(false);
    expect(b.classList.contains('ct-kanban-card-linked')).toBe(true);
  });

  it('clearCardFocus removes the highlight and the flash; safe when nothing is highlighted', () => {
    reduceMotion(false);
    const { view, card } = make();
    const el = card('a');
    view.clearCardFocus();
    view.focusCard('a', { scroll: false, flash: true });
    view.clearCardFocus();
    expect(el.classList.contains('ct-kanban-card-linked')).toBe(false);
    expect(el.classList.contains('ct-kanban-card-linked-flash')).toBe(false);
  });

  it('survives a board rebuild: the NEW card element is highlighted after render()', () => {
    reduceMotion(false);
    const { view, rowEls, card } = make();
    const old = card('a');
    view.focusCard('a', { scroll: false, flash: true });
    // render() clears rowEls and re-creates every card: emulate the rebuild's effect on the map.
    rowEls.clear();
    const fresh = card('a');
    (view as unknown as { reapplyCardFocus(): void }).reapplyCardFocus();
    expect(fresh.classList.contains('ct-kanban-card-linked')).toBe(true);
    expect(fresh.scrollIntoView).not.toHaveBeenCalled(); // re-applying never scrolls
    expect(old.classList.contains('ct-kanban-card-linked')).toBe(true); // the stale element is simply gone from the board
  });

  it('leaks nothing on close: onClose clears the highlight state', async () => {
    reduceMotion(false);
    const { view, card } = make();
    const el = card('a');
    view.focusCard('a', { scroll: false, flash: true });
    await view.onClose();
    expect(el.classList.contains('ct-kanban-card-linked')).toBe(false);
  });
});

describe('KanbanView.focusCard: hover intent, visibility and clearance', () => {
  it('a card with no layout box (collapsed lane, display:none) returns false and is not highlighted', () => {
    reduceMotion(false);
    const { view, card } = make();
    const el = card('t1');
    el.getClientRects = () => [] as unknown as DOMRectList;
    expect(view.focusCard('t1', { scroll: true, flash: true })).toBe(false);
    expect(el.classList.contains('ct-kanban-card-linked')).toBe(false);
  });

  it('every place that registers a card re-applies the highlight (gallery re-registration, rebuilt card outside render())', () => {
    reduceMotion(false);
    const { view, card } = make();
    card('a');
    view.focusCard('a', { scroll: false, flash: true });
    const fresh = document.createElement('div');
    (view as unknown as { registerCard(id: string, el: HTMLElement): void }).registerCard('a', fresh);
    expect(fresh.classList.contains('ct-kanban-card-linked')).toBe(true);
    const other = document.createElement('div');
    (view as unknown as { registerCard(id: string, el: HTMLElement): void }).registerCard('zzz', other);
    expect(other.classList.contains('ct-kanban-card-linked')).toBe(false);
    expect((view as unknown as { rowEls: Map<string, HTMLElement> }).rowEls.get('a')).toBe(fresh);
  });
});

/** A board whose scroller we can read back: rects are stubbed from a mutable scroll offset. */
function geometry(view: KanbanView, card: HTMLElement, opts: { cardRect: { left: number; top: number; right: number; bottom: number }; sheet?: { left: number; top: number; right: number; bottom: number } | null }) {
  const root = view.containerEl.children[1] as HTMLElement;
  const v = view as unknown as { boardEl?: HTMLElement };
  const board = v.boardEl ?? (v.boardEl = Object.assign(document.createElement('div'), { className: 'ct-agents-list' })); // the real scroll host
  if (!board.parentElement) root.appendChild(board);
  board.style.overflowY = 'auto';
  board.style.overflowX = 'auto';
  let top = 0; let left = 0;
  Object.defineProperty(board, 'scrollHeight', { configurable: true, get: () => 5000 });
  Object.defineProperty(board, 'clientHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(board, 'scrollWidth', { configurable: true, get: () => 5000 });
  Object.defineProperty(board, 'clientWidth', { configurable: true, get: () => 1280 });
  Object.defineProperty(board, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; } });
  Object.defineProperty(board, 'scrollLeft', { configurable: true, get: () => left, set: (v: number) => { left = v; } });
  board.scrollTo = (() => {}) as never; // force the assignment path
  board.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 } as DOMRect);
  root.getBoundingClientRect = board.getBoundingClientRect;
  board.appendChild(card);
  card.getBoundingClientRect = () => ({ ...opts.cardRect, top: opts.cardRect.top - top, bottom: opts.cardRect.bottom - top, left: opts.cardRect.left - left, right: opts.cardRect.right - left, width: opts.cardRect.right - opts.cardRect.left, height: opts.cardRect.bottom - opts.cardRect.top } as DOMRect);
  const pill = document.createElement('div');
  pill.className = 'ct-kanban-dispatch';
  pill.getBoundingClientRect = () => ({ left: 140, top: 740, right: 1140, bottom: 788, width: 1000, height: 48 } as DOMRect);
  if (opts.sheet) {
    const sh = document.createElement('div');
    sh.className = 'ct-orch-sheet';
    sh.getBoundingClientRect = () => ({ ...opts.sheet!, width: opts.sheet!.right - opts.sheet!.left, height: opts.sheet!.bottom - opts.sheet!.top } as DOMRect);
    pill.appendChild(sh);
  }
  root.appendChild(pill);
  return { board, scrollTop: () => top, scrollLeft: () => left };
}

describe('KanbanView.focusCard scrolls the board out from under the sheet and pill (QA D1)', () => {
  it('a card hidden behind the sheet is scrolled up into the uncovered region; the highlight is immediate', () => {
    vi.useFakeTimers();
    reduceMotion(true);
    const { view, card } = make();
    const el = card('t1');
    const g = geometry(view, el, { cardRect: { left: 400, top: 400, right: 660, bottom: 560 }, sheet: { left: 140, top: 230, right: 1140, bottom: 730 } });
    view.focusCard('t1', { scroll: true, flash: false });
    expect(el.classList.contains('ct-kanban-card-linked')).toBe(true);
    expect(g.scrollTop()).toBe(0); // not before the hover intent
    vi.advanceTimersByTime(INTENT_MS);
    // the card's bottom (560) must end at or above the sheet top (230): it moved up by >= 330, i.e. the board scrolled down
    expect(g.scrollTop()).toBeGreaterThanOrEqual(330);
  });

  it('a card already clear of the overlays does not scroll', () => {
    vi.useFakeTimers();
    reduceMotion(true);
    const { view, card } = make();
    const el = card('t1');
    const g = geometry(view, el, { cardRect: { left: 300, top: 20, right: 560, bottom: 200 }, sheet: { left: 140, top: 230, right: 1140, bottom: 730 } });
    view.focusCard('t1', { scroll: true, flash: false });
    vi.advanceTimersByTime(INTENT_MS);
    expect(g.scrollTop()).toBe(0);
    expect(g.scrollLeft()).toBe(0);
  });

  it('leaving before the hover intent elapses cancels the scroll; moving to another link replaces it; onClose cancels it', async () => {
    vi.useFakeTimers();
    reduceMotion(true);
    const { view, card } = make();
    const el = card('t1');
    const g = geometry(view, el, { cardRect: { left: 400, top: 400, right: 660, bottom: 560 }, sheet: { left: 140, top: 230, right: 1140, bottom: 730 } });
    view.focusCard('t1', { scroll: true, flash: false });
    vi.advanceTimersByTime(INTENT_MS - 1);
    view.clearCardFocus();
    vi.advanceTimersByTime(1000);
    expect(g.scrollTop()).toBe(0);
    view.focusCard('t1', { scroll: true, flash: false });
    await view.onClose();
    vi.advanceTimersByTime(1000);
    expect(g.scrollTop()).toBe(0);
  });

  it('adds scroll room below the cards while linked (so a card at the end of its column can still rise above the sheet) and removes it on clear', () => {
    vi.useFakeTimers();
    reduceMotion(true);
    const { view, card } = make();
    const el = card('t1');
    const g = geometry(view, el, { cardRect: { left: 400, top: 400, right: 660, bottom: 560 }, sheet: { left: 140, top: 230, right: 1140, bottom: 730 } });
    view.focusCard('t1', { scroll: true, flash: false });
    vi.advanceTimersByTime(INTENT_MS);
    expect(g.board.classList.contains('ct-kanban-clearing')).toBe(true);
    expect(g.board.style.getPropertyValue('--ct-card-clearance')).toMatch(/^\d+px$/);
    view.clearCardFocus();
    expect(g.board.classList.contains('ct-kanban-clearing')).toBe(false);
  });
});

describe('clearance follows the sheet while a link is hovered (review advisory 7)', () => {
  class FakeRO {
    static all: FakeRO[] = [];
    observed: Element[] = []; disconnected = false;
    constructor(public cb: () => void) { FakeRO.all.push(this); }
    observe(e: Element) { this.observed.push(e); }
    disconnect() { this.disconnected = true; }
  }

  it('re-measures --ct-card-clearance when the sheet resizes, and stops observing on clear', () => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', FakeRO);
    reduceMotion(true);
    const { view, card } = make();
    const el = card('t1');
    const g = geometry(view, el, { cardRect: { left: 400, top: 400, right: 660, bottom: 560 }, sheet: { left: 140, top: 230, right: 1140, bottom: 730 } });
    view.focusCard('t1', { scroll: true, flash: false });
    vi.advanceTimersByTime(INTENT_MS);
    const before = g.board.style.getPropertyValue('--ct-card-clearance');
    const sheet = view.containerEl.querySelector('.ct-orch-sheet') as HTMLElement;
    sheet.getBoundingClientRect = () => ({ left: 140, top: 100, right: 1140, bottom: 730, width: 1000, height: 630 } as DOMRect); // grew
    FakeRO.all.at(-1)!.cb();
    const after = g.board.style.getPropertyValue('--ct-card-clearance');
    expect(parseInt(after)).toBeGreaterThan(parseInt(before));
    view.clearCardFocus();
    expect(FakeRO.all.at(-1)!.disconnected).toBe(true);
  });

  it('when nothing can scroll and the overlays cover the card, the caller falls back to scrollIntoView', () => {
    vi.useFakeTimers();
    reduceMotion(true);
    const { view, card } = make();
    const el = card('t1');
    const g = geometry(view, el, { cardRect: { left: 400, top: 400, right: 660, bottom: 560 }, sheet: { left: 0, top: 0, right: 1280, bottom: 800 } }); // covers everything
    Object.defineProperty(g.board, 'scrollHeight', { configurable: true, get: () => 800 }); // nothing can scroll: the planner cannot clear it
    Object.defineProperty(g.board, 'scrollWidth', { configurable: true, get: () => 1280 });
    view.focusCard('t1', { scroll: true, flash: false });
    vi.advanceTimersByTime(INTENT_MS);
    expect(el.scrollIntoView).toHaveBeenCalled();
  });
});

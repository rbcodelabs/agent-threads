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
    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    expect(el.classList.contains('ct-kanban-card-linked-flash')).toBe(false);
  });

  it('prefers-reduced-motion: instant scroll and no flash', () => {
    vi.useFakeTimers();
    reduceMotion(true);
    const { view, card } = make();
    const el = card('t1');
    view.focusCard('t1', { scroll: true, flash: true });
    vi.advanceTimersByTime(INTENT_MS);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', inline: 'center', block: 'nearest' });
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
  it('the highlight is immediate but the SCROLL waits ~120ms, and leaving before that cancels it', () => {
    vi.useFakeTimers();
    reduceMotion(false);
    const { view, card } = make();
    const el = card('t1');
    view.focusCard('t1', { scroll: true, flash: true });
    expect(el.classList.contains('ct-kanban-card-linked')).toBe(true);
    vi.advanceTimersByTime(INTENT_MS - 1);
    expect(el.scrollIntoView).not.toHaveBeenCalled();
    view.clearCardFocus();
    vi.advanceTimersByTime(1000);
    expect(el.scrollIntoView).not.toHaveBeenCalled();
  });

  it('moving to another link cancels the first link\'s pending scroll', () => {
    vi.useFakeTimers();
    reduceMotion(false);
    const { view, card } = make();
    const a = card('a'); const b = card('b');
    view.focusCard('a', { scroll: true, flash: false });
    vi.advanceTimersByTime(50);
    view.focusCard('b', { scroll: true, flash: false });
    vi.advanceTimersByTime(1000);
    expect(a.scrollIntoView).not.toHaveBeenCalled();
    expect(b.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('onClose cancels a pending scroll (no timer outlives the view)', async () => {
    vi.useFakeTimers();
    reduceMotion(false);
    const { view, card } = make();
    const el = card('a');
    view.focusCard('a', { scroll: true, flash: false });
    await view.onClose();
    vi.advanceTimersByTime(1000);
    expect(el.scrollIntoView).not.toHaveBeenCalled();
  });

  it('a card with no layout box (collapsed lane, display:none) returns false and is not highlighted', () => {
    reduceMotion(false);
    const { view, card } = make();
    const el = card('t1');
    el.getClientRects = () => [] as unknown as DOMRectList;
    expect(view.focusCard('t1', { scroll: true, flash: true })).toBe(false);
    expect(el.classList.contains('ct-kanban-card-linked')).toBe(false);
  });

  it('keeps the card clear of the pill and the open sheet: scroll-margin-bottom = the covered height + 8px', () => {
    vi.useFakeTimers();
    reduceMotion(false);
    const { view, card } = make();
    const el = card('t1');
    const root = view.containerEl.children[1] as HTMLElement;
    root.getBoundingClientRect = () => ({ top: 0, bottom: 800, left: 0, right: 1280, width: 1280, height: 800 } as DOMRect);
    const pill = document.createElement('div');
    pill.className = 'ct-kanban-dispatch';
    pill.getBoundingClientRect = () => ({ top: 700, bottom: 748, left: 0, right: 600, width: 600, height: 48 } as DOMRect);
    const sheet = document.createElement('div');
    sheet.className = 'ct-orch-sheet';
    sheet.getBoundingClientRect = () => ({ top: 400, bottom: 690, left: 0, right: 600, width: 600, height: 290 } as DOMRect);
    pill.appendChild(sheet);
    root.appendChild(pill);
    view.focusCard('t1', { scroll: true, flash: false });
    vi.advanceTimersByTime(INTENT_MS);
    expect(el.style.scrollMarginBottom).toBe('408px');
    view.clearCardFocus();
    expect(el.style.scrollMarginBottom).toBe('');
  });

  it('only the pill (sheet closed or hidden): the clearance is the pill height + gap', () => {
    vi.useFakeTimers();
    reduceMotion(false);
    const { view, card } = make();
    const el = card('t1');
    const root = view.containerEl.children[1] as HTMLElement;
    root.getBoundingClientRect = () => ({ top: 0, bottom: 800, left: 0, right: 1280, width: 1280, height: 800 } as DOMRect);
    const pill = document.createElement('div');
    pill.className = 'ct-kanban-dispatch';
    pill.getBoundingClientRect = () => ({ top: 700, bottom: 748, left: 0, right: 600, width: 600, height: 48 } as DOMRect);
    const sheet = document.createElement('div');
    sheet.className = 'ct-orch-sheet';
    sheet.hidden = true;
    sheet.getBoundingClientRect = () => ({ top: 400, bottom: 690, left: 0, right: 600, width: 600, height: 290 } as DOMRect);
    pill.appendChild(sheet);
    root.appendChild(pill);
    view.focusCard('t1', { scroll: true, flash: false });
    vi.advanceTimersByTime(INTENT_MS);
    expect(el.style.scrollMarginBottom).toBe('108px');
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

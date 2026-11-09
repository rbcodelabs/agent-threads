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
    rowEls.set(id, el);
    return el;
  };
  return { view, rowEls, card };
}

function reduceMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduce && q.includes('prefers-reduced-motion'), media: q, addEventListener() {}, removeEventListener() {} }));
}

afterEach(() => { vi.unstubAllGlobals(); });

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

  it('scrolls the card into view horizontally centred and vertically minimal (swimlane / project columns)', () => {
    reduceMotion(false);
    const { view, card } = make();
    const el = card('t1');
    view.focusCard('t1', { scroll: true, flash: false });
    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    expect(el.classList.contains('ct-kanban-card-linked-flash')).toBe(false);
  });

  it('prefers-reduced-motion: instant scroll and no flash', () => {
    reduceMotion(true);
    const { view, card } = make();
    const el = card('t1');
    view.focusCard('t1', { scroll: true, flash: true });
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

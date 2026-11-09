// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { kanbanWheelScrollDelta, handleKanbanWheel } from '../../src/kanbanWheel';

function metrics(el: HTMLElement, m: Record<string, number>): void {
  for (const [k, v] of Object.entries(m)) Object.defineProperty(el, k, { value: v, configurable: true, writable: true });
}

function setup(opts?: { body?: Record<string, number>; board?: Record<string, number> }) {
  const root = document.createElement('div');
  root.innerHTML =
    '<div class="ct-kanban-board"><div class="ct-kanban-col"><div class="ct-kanban-col-label">L</div><div class="ct-kanban-col-body"><div class="card"></div></div></div></div>';
  document.body.appendChild(root);
  const board = root.querySelector<HTMLElement>('.ct-kanban-board')!;
  const body = root.querySelector<HTMLElement>('.ct-kanban-col-body')!;
  metrics(board, { scrollWidth: 2000, clientWidth: 800, scrollLeft: 100, ...(opts?.board ?? {}) });
  metrics(body, { scrollHeight: 1000, clientHeight: 400, scrollTop: 100, ...(opts?.body ?? {}) });
  return {
    root,
    board,
    body,
    card: body.firstElementChild as HTMLElement,
    label: root.querySelector<HTMLElement>('.ct-kanban-col-label')!,
  };
}
const wheel = (o: Partial<{ deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean }>) => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  shiftKey: false,
  ...o,
});

describe('kanbanWheelScrollDelta', () => {
  it('leaves the wheel alone inside a column body that can still scroll in that direction', () => {
    const { board, card } = setup();
    expect(kanbanWheelScrollDelta(wheel({ deltaY: 50 }), card, board)).toBeNull();
    expect(kanbanWheelScrollDelta(wheel({ deltaY: -50 }), card, board)).toBeNull();
  });

  it('converts to horizontal when the column body is at the bottom (down) or top (up)', () => {
    const bottom = setup({ body: { scrollTop: 600 } });
    expect(kanbanWheelScrollDelta(wheel({ deltaY: 50 }), bottom.card, bottom.board)).toBe(50);
    const top = setup({ body: { scrollTop: 0 } });
    expect(kanbanWheelScrollDelta(wheel({ deltaY: -50 }), top.card, top.board)).toBe(-50);
  });

  it('converts when the column body has nothing to scroll', () => {
    const { board, card } = setup({ body: { scrollHeight: 300, clientHeight: 400, scrollTop: 0 } });
    expect(kanbanWheelScrollDelta(wheel({ deltaY: 30 }), card, board)).toBe(30);
  });

  it('converts over the gutter / header (outside any column body)', () => {
    const { board, label } = setup();
    expect(kanbanWheelScrollDelta(wheel({ deltaY: 40 }), label, board)).toBe(40);
    expect(kanbanWheelScrollDelta(wheel({ deltaY: 40 }), board, board)).toBe(40);
  });

  it('leaves Shift+wheel and horizontal-dominant (trackpad) gestures to the browser', () => {
    const { board, label } = setup();
    expect(kanbanWheelScrollDelta(wheel({ deltaY: 40, shiftKey: true }), label, board)).toBeNull();
    expect(kanbanWheelScrollDelta(wheel({ deltaX: 60, deltaY: 5 }), label, board)).toBeNull();
    expect(kanbanWheelScrollDelta(wheel({ deltaX: 60 }), label, board)).toBeNull();
  });

  it('does nothing when the board cannot scroll horizontally or is at that edge', () => {
    const fit = setup({ board: { scrollWidth: 800 } });
    expect(kanbanWheelScrollDelta(wheel({ deltaY: 40 }), fit.label, fit.board)).toBeNull();
    const left = setup({ board: { scrollLeft: 0 } });
    expect(kanbanWheelScrollDelta(wheel({ deltaY: -40 }), left.label, left.board)).toBeNull();
    const right = setup({ board: { scrollLeft: 1200 } });
    expect(kanbanWheelScrollDelta(wheel({ deltaY: 40 }), right.label, right.board)).toBeNull();
  });

  it('scales line and page delta modes', () => {
    const { board, label } = setup();
    expect(kanbanWheelScrollDelta(wheel({ deltaY: 3, deltaMode: 1 }), label, board)).toBe(48);
    expect(kanbanWheelScrollDelta(wheel({ deltaY: 1, deltaMode: 2 }), label, board)).toBe(800);
  });
});

describe('handleKanbanWheel', () => {
  const fire = (target: HTMLElement, init: WheelEventInit) => {
    const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };

  it('scrolls the board and prevents default when converting', () => {
    const { root, board, label } = setup();
    root.addEventListener('wheel', handleKanbanWheel, { passive: false });
    const e = fire(label, { deltaY: 120 });
    expect(board.scrollLeft).toBe(220);
    expect(e.defaultPrevented).toBe(true);
  });

  it('does not touch the board or prevent default inside a scrollable column body', () => {
    const { root, board, card } = setup();
    root.addEventListener('wheel', handleKanbanWheel, { passive: false });
    const e = fire(card, { deltaY: 120 });
    expect(board.scrollLeft).toBe(100);
    expect(e.defaultPrevented).toBe(false);
  });

  it('ignores folder swimlane boards', () => {
    const { root, board, label } = setup();
    board.classList.add('ct-kanban-swimlanes');
    root.addEventListener('wheel', handleKanbanWheel, { passive: false });
    const e = fire(label, { deltaY: 120 });
    expect(board.scrollLeft).toBe(100);
    expect(e.defaultPrevented).toBe(false);
  });
});

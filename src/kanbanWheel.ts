/**
 * Mouse-wheel support for the horizontally scrolling Agent Board.
 *
 * The board is `overflow-x: auto; overflow-y: hidden`, so a plain vertical
 * wheel does nothing over the gutters, column headers or past the end of a
 * column's cards. This maps vertical wheel movement to horizontal scrolling,
 * except where a column body can still scroll vertically in that direction.
 * Shift+wheel and trackpad horizontal deltas are left to the browser.
 */

const LINE_PX = 16;

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
}

/** True when `el` can still scroll vertically in the direction of `deltaY`. */
function canScrollVertically(el: HTMLElement, deltaY: number): boolean {
  if (deltaY < 0) return el.scrollTop > 0;
  return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
}

/**
 * Returns the horizontal pixel delta to apply to `board.scrollLeft`, or null
 * when the event should be left to the browser (no preventDefault).
 */
export function kanbanWheelScrollDelta(
  e: WheelLike,
  target: Element | null,
  board: HTMLElement,
): number | null {
  if (e.deltaY === 0 || e.shiftKey) return null;
  // Trackpad-style / horizontal-dominant gestures already scroll natively.
  if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return null;

  const maxLeft = board.scrollWidth - board.clientWidth;
  if (maxLeft <= 0) return null;

  const body = target?.closest<HTMLElement>('.ct-kanban-col-body') ?? null;
  if (body && board.contains(body) && canScrollVertically(body, e.deltaY)) return null;

  const px =
    e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaMode === 2 ? e.deltaY * board.clientWidth : e.deltaY;
  // Already at the edge in this direction: let the event through.
  if (px < 0 && board.scrollLeft <= 0) return null;
  if (px > 0 && board.scrollLeft >= maxLeft - 1) return null;
  return px;
}

/** Wheel listener for a delegated container holding `.ct-kanban-board` elements. */
export function handleKanbanWheel(e: WheelEvent): void {
  const target = e.target instanceof Element ? e.target : null;
  const board = target?.closest<HTMLElement>('.ct-kanban-board:not(.ct-kanban-swimlanes)') ?? null;
  if (!board) return;
  const px = kanbanWheelScrollDelta(e, target, board);
  if (px === null) return;
  board.scrollLeft += px;
  e.preventDefault();
}

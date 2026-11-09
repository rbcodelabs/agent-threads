/**
 * dockCardScroll.ts
 *
 * Pure geometry for "scroll the board so the highlighted card is NOT hidden behind the open reply sheet or the pill".
 * scrollIntoView knows nothing about those overlays (they float over the board), so the card often landed under them.
 * No DOM, no `obsidian`: rectangles in, a scroll delta out.
 */
export interface Rect { left: number; top: number; right: number; bottom: number }

export interface CardScrollPlan {
  /** How far the card has to MOVE (positive = right / down) to sit in clear view. Scroll the scrollers the other way. */
  dx: number;
  dy: number;
  /** The uncovered region chosen as the target, or null when nothing at all is uncovered. */
  region: Rect | null;
  /** After the move the card (or, if it cannot fit anywhere, its top-left corner) is outside every overlay. False: the caller should fall back. */
  cleared: boolean;
}

export interface PlanOptions {
  /** False when nothing between the card and the board can scroll sideways (swimlanes, gallery). Default true. */
  allowX?: boolean;
  /**
   * Height of sticky headers pinned to the top of the scroller: a card aligned to the board's top edge is aligned this far
   * BELOW it, so it is not tucked under a header. Default 0 (the Agent Board currently has no sticky headers).
   * Horizontal scrolling assumes LTR (positive scrollLeft to the right): RTL scrollers with negative scrollLeft are not handled.
   */
  topInset?: number;
}

const w = (r: Rect): number => r.right - r.left;
const h = (r: Rect): number => r.bottom - r.top;

/**
 * The uncovered part of the board is not a rectangle (the sheet floats over the middle of the bottom). Candidates are the
 * three biggest rectangles around the obstacles: everything above them, everything left of them, everything right of them.
 */
export function uncoveredRegions(board: Rect, obstacles: readonly Rect[]): Rect[] {
  const hits = obstacles.filter((o) => o.right > board.left && o.left < board.right && o.bottom > board.top && o.top < board.bottom);
  if (hits.length === 0) return [board];
  const minTop = Math.min(...hits.map((o) => o.top));
  const minLeft = Math.min(...hits.map((o) => o.left));
  const maxRight = Math.max(...hits.map((o) => o.right));
  const regions: Rect[] = [
    { left: board.left, right: board.right, top: board.top, bottom: Math.min(board.bottom, minTop) }, // above
    { left: board.left, right: Math.min(board.right, minLeft), top: board.top, bottom: board.bottom }, // left of
    { left: Math.max(board.left, maxRight), right: board.right, top: board.top, bottom: board.bottom }, // right of
  ];
  return regions.filter((r) => w(r) > 0 && h(r) > 0);
}

function moveInto(card: Rect, regionIn: Rect, allowX: boolean, topInset = 0, boardTop = 0): { dx: number; dy: number; fits: boolean } {
  // A region that starts at the board's top edge starts below the sticky headers.
  const region = regionIn.top === boardTop && topInset > 0 ? { ...regionIn, top: regionIn.top + topInset } : regionIn;
  const cw = w(card);
  const ch = h(card);
  let dx = 0;
  let dy = 0;
  if (!allowX) {
    // The board cannot scroll sideways (swimlanes, gallery): only regions the card is ALREADY horizontally inside are usable.
    const inside = card.left >= region.left && card.right <= region.right;
    dx = 0;
    if (!inside) return { dx: 0, dy: 0, fits: false };
  } else if (cw <= w(region)) {
    const inside = card.left >= region.left && card.right <= region.right;
    if (!inside) dx = region.left + (w(region) - cw) / 2 - card.left; // inline: centre in the uncovered width
  } else {
    dx = region.left - card.left; // wider than the region: align its left edge
  }
  if (ch <= h(region)) {
    if (card.top < region.top) dy = region.top - card.top; // nearest
    else if (card.bottom > region.bottom) dy = region.bottom - card.bottom;
  } else {
    dy = region.top - card.top; // taller than the region: align its top
  }
  return { dx, dy, fits: cw <= w(region) && ch <= h(region) };
}

/** Below this much visible card height a "cleared" claim would be a lie. */
const MIN_VISIBLE_PX = 48;

const inAny = (x: number, y: number, rects: readonly Rect[]): boolean => rects.some((o) => x >= o.left && x < o.right && y >= o.top && y < o.bottom);

/** The smallest move that puts the card fully in an uncovered region (or, if it cannot fit, its top-left there). */
export function planCardScroll(card: Rect, board: Rect, obstacles: readonly Rect[], opts: PlanOptions = {}): CardScrollPlan {
  const allowX = opts.allowX ?? true;
  const topInset = opts.topInset ?? 0;
  const regions = uncoveredRegions(board, obstacles);
  const finish = (dx: number, dy: number, region: Rect | null, fits: boolean): CardScrollPlan => {
    const moved = { x: card.left + dx, y: card.top + dy };
    // A card that fits is cleared. One that does not fit only counts when a usable slice of it (>= MIN_VISIBLE_PX) is uncovered.
    const cleared = fits || (region !== null && h(region) >= MIN_VISIBLE_PX && !inAny(moved.x + 1, moved.y + 1, obstacles) && moved.y >= board.top - 1);
    return { dx: Math.round(dx), dy: Math.round(dy), region, cleared };
  };
  if (regions.length === 0) {
    // Everything is covered: put the card's top as high as the board allows; the caller will know it is not cleared.
    return { dx: 0, dy: Math.round(board.top + topInset - card.top), region: null, cleared: false };
  }
  let best: { dx: number; dy: number; cost: number; region: Rect } | null = null;
  for (const region of regions) {
    const m = moveInto(card, region, allowX, topInset, board.top);
    if (!m.fits) continue; // a region the card does not fit in is no place to put it
    const cost = Math.abs(m.dx) + Math.abs(m.dy);
    if (!best || cost < best.cost) best = { dx: m.dx, dy: m.dy, cost, region };
  }
  if (best) return finish(best.dx, best.dy, best.region, true);
  // Fits nowhere: the LARGEST uncovered region (among those the card can reach sideways) gets its top-left, so at least
  // the top of the card is readable.
  const reachable = regions.filter((r) => allowX || (card.left >= r.left && card.right <= r.right));
  const pool = reachable.length > 0 ? reachable : regions;
  const region = pool.reduce((a, b) => (w(b) * h(b) > w(a) * h(a) ? b : a));
  const m = allowX ? moveInto(card, region, true, topInset, board.top) : { dx: 0, dy: region.top + (region.top === board.top ? topInset : 0) - card.top };
  return finish(m.dx, m.dy, region, false);
}
/** Fraction (0..1) of the card's area that lies under any obstacle (overlaps counted once per obstacle, capped at 1). */
export function coveredFraction(card: Rect, obstacles: readonly Rect[]): number {
  const area = w(card) * h(card);
  if (area <= 0) return 0;
  let covered = 0;
  for (const o of obstacles) {
    const iw = Math.min(card.right, o.right) - Math.max(card.left, o.left);
    const ih = Math.min(card.bottom, o.bottom) - Math.max(card.top, o.top);
    if (iw > 0 && ih > 0) covered += iw * ih;
  }
  return Math.min(1, covered / area);
}

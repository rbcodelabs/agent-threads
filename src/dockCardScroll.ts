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

function moveInto(card: Rect, region: Rect): { dx: number; dy: number; fits: boolean } {
  const cw = w(card);
  const ch = h(card);
  let dx = 0;
  let dy = 0;
  if (cw <= w(region)) {
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

/** The smallest move that puts the card fully in an uncovered region (or, if it cannot fit, its top-left there). */
export function planCardScroll(card: Rect, board: Rect, obstacles: readonly Rect[]): CardScrollPlan {
  const regions = uncoveredRegions(board, obstacles);
  if (regions.length === 0) return { dx: 0, dy: 0, region: null };
  let best: { dx: number; dy: number; cost: number; region: Rect } | null = null;
  for (const region of regions) {
    const m = moveInto(card, region);
    const cost = Math.abs(m.dx) + Math.abs(m.dy) + (m.fits ? 0 : 100000);
    if (!best || cost < best.cost) best = { dx: m.dx, dy: m.dy, cost, region };
  }
  return { dx: Math.round(best!.dx), dy: Math.round(best!.dy), region: best!.region };
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

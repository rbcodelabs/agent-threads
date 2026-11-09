/**
 * dock-card-scroll.test.ts: the geometry that keeps a hovered card out from under the sheet / pill.
 */
import { describe, it, expect } from 'vitest';
import { planCardScroll, uncoveredRegions, coveredFraction, type Rect } from '../../src/dockCardScroll';

const r = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom });
const BOARD = r(0, 0, 1280, 800);
// Wide: the sheet floats over the middle (x 140..1140), its top at 230; the pill (y 740..788) under it.
const SHEET = r(140, 230, 1140, 730);
const PILL = r(140, 740, 1140, 788);

describe('uncoveredRegions', () => {
  it('no obstacle: the whole board', () => {
    expect(uncoveredRegions(BOARD, [])).toEqual([BOARD]);
  });
  it('sheet + pill: above, left and right of them', () => {
    const regions = uncoveredRegions(BOARD, [SHEET, PILL]);
    expect(regions).toContainEqual(r(0, 0, 1280, 230));
    expect(regions).toContainEqual(r(0, 0, 140, 800));
    expect(regions).toContainEqual(r(1140, 0, 1280, 800));
  });
  it('ignores obstacles that do not touch the board and drops empty regions', () => {
    expect(uncoveredRegions(BOARD, [r(2000, 0, 2100, 100)])).toEqual([BOARD]);
    const full = uncoveredRegions(BOARD, [r(0, 0, 1280, 800)]);
    expect(full).toEqual([]);
  });
});

describe('planCardScroll', () => {
  it('a card already fully uncovered does not move', () => {
    expect(planCardScroll(r(300, 20, 560, 200), BOARD, [SHEET, PILL])).toMatchObject({ dx: 0, dy: 0 });
  });

  it('a card BEHIND the sheet moves up into the region above it (nearest), and is not left covered', () => {
    const card = r(400, 400, 660, 560);
    const p = planCardScroll(card, BOARD, [SHEET, PILL]);
    const moved = r(card.left + p.dx, card.top + p.dy, card.right + p.dx, card.bottom + p.dy);
    expect(coveredFraction(moved, [SHEET, PILL])).toBe(0);
    expect(p.dy).toBeLessThan(0);
  });

  it('centres the card horizontally in the uncovered width when it has to move', () => {
    const card = r(1200, 400, 1460, 560); // a project column scrolled partly off the board's right edge
    const p = planCardScroll(card, BOARD, [SHEET, PILL]);
    const cx = (card.left + card.right) / 2 + p.dx;
    expect(Math.abs(cx - 640)).toBeLessThanOrEqual(1); // centre of the region above (the full width)
  });

  it('a card taller than the uncovered height aligns its top', () => {
    const card = r(400, 300, 660, 900); // 600 tall > 230
    const p = planCardScroll(card, BOARD, [SHEET, PILL]);
    expect(card.top + p.dy).toBe(0);
  });

  it('a card already inside the uncovered width keeps its horizontal position (no sideways lurch), only vertical moves', () => {
    const p = planCardScroll(r(900, 400, 1160, 560), BOARD, [SHEET, PILL]);
    expect(p.dx).toBe(0);
    expect(p.dy).toBeLessThan(0);
  });

  it('prefers the side strip when the card is already beside the sheet and fits there', () => {
    const card = r(1150, 300, 1270, 400); // 120 wide: inside the 140px strip right of the sheet
    expect(planCardScroll(card, BOARD, [SHEET, PILL])).toMatchObject({ dx: 0, dy: 0 });
  });

  it('narrow bottom sheet (covers the bottom 60%): the card goes to the top 40%', () => {
    const board = r(0, 0, 390, 844);
    const sheet = r(0, 338, 390, 844);
    const card = r(20, 500, 280, 640);
    const p = planCardScroll(card, board, [sheet]);
    expect(card.top + p.dy).toBeGreaterThanOrEqual(0);
    expect(card.bottom + p.dy).toBeLessThanOrEqual(338);
  });

  it('nothing uncovered: no move', () => {
    expect(planCardScroll(r(10, 10, 20, 20), BOARD, [r(0, 0, 1280, 800)])).toEqual({ dx: 0, dy: 0, region: null });
  });
});

describe('coveredFraction', () => {
  it('0 when clear, 1 when hidden, partial in between', () => {
    expect(coveredFraction(r(0, 0, 100, 100), [r(200, 200, 300, 300)])).toBe(0);
    expect(coveredFraction(r(0, 0, 100, 100), [r(0, 0, 500, 500)])).toBe(1);
    expect(coveredFraction(r(0, 0, 100, 100), [r(0, 50, 100, 500)])).toBeCloseTo(0.5);
  });
});

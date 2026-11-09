/**
 * dock-card-scroll-dom.test.ts
 * @vitest-environment jsdom
 *
 * Nested scrollers (outer board/lane + inner column body) with a tiny layout simulator: rects follow the scroll offsets,
 * so the algorithm's re-reads between steps are real.
 */
import { describe, it, expect } from 'vitest';
import { scrollCardIntoClearView } from '../../src/dockCardScrollDom';
import type { Rect } from '../../src/dockCardScroll';

interface Scr { el: HTMLElement; top: () => number; left: () => number }

function scroller(opts: { overflowY?: string; overflowX?: string; scrollH: number; clientH: number; scrollW?: number; clientW?: number }): Scr {
  const el = document.createElement('div');
  el.style.overflowY = opts.overflowY ?? 'auto';
  el.style.overflowX = opts.overflowX ?? 'hidden';
  let top = 0; let left = 0;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => opts.scrollH });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => opts.clientH });
  Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => opts.scrollW ?? opts.clientW ?? 1000 });
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => opts.clientW ?? 1000 });
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; } });
  Object.defineProperty(el, 'scrollLeft', { configurable: true, get: () => left, set: (v: number) => { left = v; } });
  return { el, top: () => top, left: () => left };
}
const rect = (l: number, t: number, r: number, b: number) => ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t } as DOMRect);

/**
 * host(0..800, hidden) > outer (scrolls the lane list, content 3000 tall) > column viewport (460 tall, content 900) > card
 * The column sits at content y `colY` of the outer scroller; the card at content y `cardY` of the column, `cardH` tall.
 */
function world(opts: { colY: number; cardY: number; cardH: number; colH?: number; colContent?: number }) {
  const host = document.createElement('div');
  host.style.overflowY = 'hidden';
  host.getBoundingClientRect = () => rect(0, 0, 1000, 800);
  const outer = scroller({ scrollH: 3000, clientH: 800 });
  outer.el.getBoundingClientRect = () => rect(0, 0, 1000, 800);
  const colH = opts.colH ?? 460;
  const col = scroller({ scrollH: opts.colContent ?? 900, clientH: colH });
  col.el.getBoundingClientRect = () => rect(100, opts.colY - outer.top(), 400, opts.colY - outer.top() + colH);
  const card = document.createElement('div');
  card.getBoundingClientRect = () => {
    const top = opts.colY - outer.top() + opts.cardY - col.top();
    return rect(110, top, 390, top + opts.cardH);
  };
  host.appendChild(outer.el); outer.el.appendChild(col.el); col.el.appendChild(card);
  document.body.appendChild(host);
  const visible = () => {
    const c = card.getBoundingClientRect(); const v = col.el.getBoundingClientRect();
    const top = Math.max(c.top, v.top, 0); const bottom = Math.min(c.bottom, v.bottom, 800);
    return { c, v, visibleH: Math.max(0, bottom - top) };
  };
  return { host, outer, col, card, visible };
}

const SHEET: Rect = { left: 0, top: 230, right: 1000, bottom: 730 }; // covers everything below y=230 across the board
const PILL: Rect = { left: 0, top: 740, right: 1000, bottom: 788 };

describe('scrollCardIntoClearView with nested scrollers', () => {
  it('a card scrolled up INSIDE its column past the column top is NOT the answer: the card ends fully inside the column viewport and above the sheet', () => {
    // Column at content y 600 (below the sheet), card near the column's bottom. Moving only the column body would push the card out of the column's own rect.
    const w = world({ colY: 600, cardY: 400, cardH: 100 });
    scrollCardIntoClearView(w.card, w.host, [SHEET, PILL], true);
    const { c, v } = w.visible();
    expect(c.top).toBeGreaterThanOrEqual(v.top - 1);
    expect(c.bottom).toBeLessThanOrEqual(v.bottom + 1);
    expect(c.bottom).toBeLessThanOrEqual(230 + 1);
    expect(c.top).toBeGreaterThanOrEqual(0);
  });

  it('when the column body alone can clear the card, the outer scroller is left alone (no lane lurch)', () => {
    // Column top at y 20 (already above the sheet), card low inside it.
    const w = world({ colY: 20, cardY: 380, cardH: 90 });
    scrollCardIntoClearView(w.card, w.host, [SHEET, PILL], true);
    expect(w.outer.top()).toBe(0);
    const { c, v } = w.visible();
    expect(c.bottom).toBeLessThanOrEqual(230 + 1);
    expect(c.top).toBeGreaterThanOrEqual(v.top - 1);
  });

  it('a card taller than the band above the sheet: its top is visible, the column top sits at the top of the uncovered region', () => {
    const w = world({ colY: 500, cardY: 100, cardH: 400, colContent: 1200 });
    scrollCardIntoClearView(w.card, w.host, [SHEET, PILL], true);
    const { c, visibleH } = w.visible();
    expect(c.top).toBeGreaterThanOrEqual(-1);
    expect(c.top).toBeLessThanOrEqual(30);
    expect(visibleH).toBeGreaterThanOrEqual(200); // the whole band above the sheet shows the card
  });

  it('smooth mode animates every scroller to its final offset and restores the start offsets first (no jump)', () => {
    const w = world({ colY: 600, cardY: 400, cardH: 100 });
    const calls: Array<{ el: HTMLElement; top: number }> = [];
    for (const s of [w.outer, w.col]) s.el.scrollTo = ((o: ScrollToOptions) => { calls.push({ el: s.el, top: o.top ?? 0 }); }) as never;
    scrollCardIntoClearView(w.card, w.host, [SHEET, PILL], false);
    expect(w.outer.top()).toBe(0); expect(w.col.top()).toBe(0); // restored to where they started
    expect(calls.length).toBe(2);
    expect(calls.some((c) => c.el === w.outer.el && c.top > 0)).toBe(true);
  });

  it('no scrollers at all: just reports whether the card is clear of the overlays', () => {
    const host = document.createElement('div');
    const card = document.createElement('div');
    host.appendChild(card);
    card.getBoundingClientRect = () => rect(10, 10, 100, 60);
    expect(scrollCardIntoClearView(card, host, [SHEET], true)).toBe(true);
    card.getBoundingClientRect = () => rect(10, 300, 100, 360);
    expect(scrollCardIntoClearView(card, host, [SHEET], true)).toBe(false);
  });

  it('QA N3: the result is computed on the PLANNED geometry, not after the smooth animation restored the start offsets (a card that starts off-screen)', () => {
    // The column starts far below the board (off-screen); the outer scroller can only bring it to y 600, under the sheet: partly visible, not "good".
    const mk = () => {
      const w = world({ colY: 1300, cardY: 100, cardH: 200, colContent: 400 });
      Object.defineProperty(w.outer.el, 'scrollHeight', { configurable: true, get: () => 1500 }); // max scroll 700
      return w;
    };
    const reduced = mk();
    const smooth = mk();
    for (const s of [smooth.outer, smooth.col]) s.el.scrollTo = (() => {}) as never;
    const a = scrollCardIntoClearView(reduced.card, reduced.host, [SHEET, PILL], true);
    const b = scrollCardIntoClearView(smooth.card, smooth.host, [SHEET, PILL], false);
    expect(a).toBe(true); // the card is (partly) visible after the move
    expect(b).toBe(a); // and smooth mode must say the same: it used to read the restored, off-screen start state and report false
  });

  it('a card that genuinely cannot be brought into view reports false in both modes', () => {
    const w = world({ colY: 1300, cardY: 100, cardH: 200, colContent: 400 });
    Object.defineProperty(w.outer.el, 'scrollHeight', { configurable: true, get: () => 800 }); // nothing to scroll
    Object.defineProperty(w.col.el, 'scrollHeight', { configurable: true, get: () => 460 });
    expect(scrollCardIntoClearView(w.card, w.host, [SHEET, PILL], false)).toBe(false);
  });
});

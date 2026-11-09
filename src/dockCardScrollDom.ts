/**
 * dockCardScrollDom.ts
 *
 * Moves the board's NESTED scrollers (the board / swimlane list, a lane, a column body) so the hovered card is both
 * inside its own column's viewport AND outside the open reply sheet / pill. dockCardScroll.ts is the pure geometry;
 * this file reads rects, applies scroll offsets and re-reads, one scroller at a time.
 *
 * Strategy (a card can only be as visible as the INNERMOST scroller's viewport allows, so the outer ones matter):
 *   1. Move the innermost scroller only (the column body): plan against ITS visible viewport, not the whole board, so the
 *      card never leaves the column's own rect. If that clears the card, stop (no needless sideways / lane lurch).
 *   2. Otherwise slide the outer scrollers, outermost first, so the whole inner viewport (the column band) lands in the
 *      uncovered part of the board, then redo step 1.
 * Offsets are applied instantly while planning (each step needs the rects the previous one produced); for smooth motion the
 * start offsets are restored in the same task and every scroller is animated to its final offset at once.
 */
import { coveredFraction, planCardScroll, type Rect } from './dockCardScroll';

interface Scroller { el: HTMLElement; x: boolean; y: boolean }

const rectOf = (el: Element): Rect => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; };
const area = (r: Rect): number => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
const intersect = (a: Rect, b: Rect): Rect => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
const SCROLLABLE = /(auto|scroll)/;
const CLIPPING = /(auto|scroll|hidden|clip)/;
const MIN_VISIBLE_PX = 60;

/** The element's rect clipped by every clipping ancestor up to (and including) the host. */
function visibleRect(el: HTMLElement, host: HTMLElement): Rect {
  let v = rectOf(el);
  for (let a: HTMLElement | null = el.parentElement; a; a = a === host ? null : a.parentElement) {
    const cs = getComputedStyle(a);
    if (CLIPPING.test(cs.overflowY) || CLIPPING.test(cs.overflowX)) v = intersect(v, rectOf(a));
  }
  return v;
}

/** Height of `position: sticky` children pinned at the top of a scroller (none on the board today). */
function stickyTopInset(scroller: HTMLElement): number {
  let inset = 0;
  for (const c of Array.from(scroller.children) as HTMLElement[]) {
    const cs = getComputedStyle(c);
    if (cs.position === 'sticky' && parseFloat(cs.top || '0') <= 1) inset = Math.max(inset, c.offsetHeight);
  }
  return inset;
}

function setOffsets(el: HTMLElement, top: number, left: number, smooth: boolean): void {
  if (smooth && typeof el.scrollTo === 'function') el.scrollTo({ top, left, behavior: 'smooth' });
  else { el.scrollTop = top; el.scrollLeft = left; }
}

/** Returns true when the card ends up (nearly) fully visible, or as visible as its own column / the band above the overlays allows. */
export function scrollCardIntoClearView(card: HTMLElement, host: HTMLElement, obstacles: readonly Rect[], reduced: boolean): boolean {
  const chain: Scroller[] = []; // innermost -> outermost
  for (let n: HTMLElement | null = card.parentElement; n; n = n === host ? null : n.parentElement) {
    const cs = getComputedStyle(n);
    const y = SCROLLABLE.test(cs.overflowY) && n.scrollHeight > n.clientHeight;
    const x = SCROLLABLE.test(cs.overflowX) && n.scrollWidth > n.clientWidth;
    if (x || y) chain.push({ el: n, x, y });
  }
  if (chain.length === 0) return coveredFraction(rectOf(card), obstacles) <= 0.05;

  const start = new Map(chain.map((s) => [s.el, { top: s.el.scrollTop, left: s.el.scrollLeft }]));

  const good = (): boolean => {
    const full = rectOf(card);
    const fullArea = area(full);
    if (fullArea <= 0) return true;
    const vis = visibleRect(card, host);
    const visArea = area(vis);
    const covered = coveredFraction(vis, obstacles) * visArea;
    if (visArea > 0 && (visArea - covered) / fullArea >= 0.97) return true;
    if (visArea <= 0) return false; // clipped away entirely (off the board / out of its column): never good
    // A card taller than the band it can occupy only shows what fits: its TOP must be visible and uncovered.
    // The attainable height is judged against the whole board's band above the overlays (the OUTER scrollers can slide the
    // column band up into it), not against wherever the column happens to sit now.
    const hostVp = rectOf(host);
    const minTop = obstacles.length > 0 ? Math.min(...obstacles.map((o) => o.top)) : Infinity;
    const band = Math.max(MIN_VISIBLE_PX, Math.min(hostVp.bottom, minTop) - hostVp.top);
    const attainable = Math.min(full.bottom - full.top, band);
    const visibleH = Math.max(0, Math.min(vis.bottom, minTop) - vis.top);
    const widthOk = vis.right - vis.left >= 0.97 * (full.right - full.left);
    return widthOk && Math.abs(vis.top - full.top) < 1.5 && visibleH >= 0.97 * attainable;
  };

  const step = (s: Scroller, object: Rect): void => {
    const plan = planCardScroll(object, visibleRect(s.el, host), obstacles, { allowX: s.x, allowY: s.y, topInset: stickyTopInset(s.el) });
    if (plan.dy !== 0 && s.y) s.el.scrollTop = Math.max(0, Math.min(s.el.scrollHeight - s.el.clientHeight, s.el.scrollTop - plan.dy));
    if (plan.dx !== 0 && s.x) s.el.scrollLeft = Math.max(0, Math.min(s.el.scrollWidth - s.el.clientWidth, s.el.scrollLeft - plan.dx));
  };

  const inner = chain[0];
  step(inner, rectOf(card));
  let ok = good();
  if (!ok && chain.length > 1) {
    // Slide the outer scrollers so each one's inner viewport (the column / lane band) lands in the uncovered region.
    for (let i = chain.length - 1; i >= 1; i--) step(chain[i], rectOf(chain[i - 1].el)); // the inner band as laid out (NOT clipped: a column scrolled off-screen has an empty visible rect)
    step(inner, rectOf(card));
    ok = good();
  }

  if (!reduced) {
    // Same task: restore the start offsets and animate every scroller to where it ended up.
    const finals = chain.map((s) => ({ s, top: s.el.scrollTop, left: s.el.scrollLeft }));
    for (const s of chain) { const o = start.get(s.el)!; s.el.scrollTop = o.top; s.el.scrollLeft = o.left; }
    for (const f of finals) setOffsets(f.s.el, f.top, f.left, true);
  }
  // `ok` false only matters to the caller when the card is not visible at all (then it falls back to scrollIntoView).
  const vis = visibleRect(card, host);
  return ok || area(vis) > 0;
}

/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { defaultVisibilityObserverFactory, GALLERY_LOAD_MARGIN, GALLERY_RELEASE_MARGIN } from '../../src/galleryLazy';

/**
 * The Gallery board is its own overflow scroller, so an IntersectionObserver
 * without `root` measures against the window and its rootMargin never reaches
 * the scroller's clip edge. Cards within GALLERY_LOAD_MARGIN (200px) of the
 * scroller edge must load; they are released only beyond GALLERY_RELEASE_MARGIN
 * (600px) so a card hovering around the load boundary does not thrash.
 */
interface Made { cb: IntersectionObserverCallback; opts: IntersectionObserverInit; observed: Element[]; disconnect: ReturnType<typeof vi.fn> }
const made: Made[] = [];

class FakeIO {
  constructor(cb: IntersectionObserverCallback, opts: IntersectionObserverInit = {}) {
    const rec: Made = { cb, opts, observed: [], disconnect: vi.fn() };
    made.push(rec);
    (this as unknown as { rec: Made }).rec = rec;
  }
  observe(el: Element) { (this as unknown as { rec: Made }).rec.observed.push(el); }
  unobserve() {}
  disconnect() { (this as unknown as { rec: Made }).rec.disconnect(); }
}

afterEach(() => { vi.unstubAllGlobals(); made.length = 0; });

const entry = (target: Element, isIntersecting: boolean) => [{ target, isIntersecting }] as unknown as IntersectionObserverEntry[];

describe('galleryLazy default observer', () => {
  it('documents the margins: load 200px, release 600px', () => {
    expect(GALLERY_LOAD_MARGIN).toBe('200px');
    expect(GALLERY_RELEASE_MARGIN).toBe('600px');
  });

  it('passes the scroller as root with the load and release margins', () => {
    vi.stubGlobal('IntersectionObserver', FakeIO);
    const root = document.createElement('div');
    defaultVisibilityObserverFactory(() => {}, root);
    expect(made.map((m) => m.opts.root)).toEqual([root, root]);
    expect(made.map((m) => m.opts.rootMargin).sort()).toEqual(['200px', '600px']);
  });

  it('loads at the near margin and releases only past the far margin', () => {
    vi.stubGlobal('IntersectionObserver', FakeIO);
    const onChange = vi.fn();
    const el = document.createElement('div');
    const obs = defaultVisibilityObserverFactory(onChange, document.createElement('div'))!;
    obs.observe(el);
    const near = made.find((m) => m.opts.rootMargin === '200px')!;
    const far = made.find((m) => m.opts.rootMargin === '600px')!;
    expect(near.observed).toContain(el);
    expect(far.observed).toContain(el);

    near.cb(entry(el, true), {} as IntersectionObserver);
    expect(onChange).toHaveBeenLastCalledWith(el, true);
    // leaving the near zone does not release: still inside the far zone
    near.cb(entry(el, false), {} as IntersectionObserver);
    expect(onChange).toHaveBeenCalledTimes(1);
    far.cb(entry(el, true), {} as IntersectionObserver);
    expect(onChange).toHaveBeenCalledTimes(1);
    far.cb(entry(el, false), {} as IntersectionObserver);
    expect(onChange).toHaveBeenLastCalledWith(el, false);
  });

  it('disconnects both observers', () => {
    vi.stubGlobal('IntersectionObserver', FakeIO);
    defaultVisibilityObserverFactory(() => {}, null)!.disconnect();
    expect(made.every((m) => m.disconnect.mock.calls.length === 1)).toBe(true);
  });
});

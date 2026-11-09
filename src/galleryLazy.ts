/**
 * Viewport-driven activation for Gallery cards (same idea as
 * remote/remoteImages.ts, but two-way): a card near the viewport gets its image
 * `src` attributes set, and a card that scrolls far away has them cleared again
 * so the browser can release the decoded bitmaps. Keeps the board's decoded
 * footprint to the visible neighbourhood instead of every thread's screenshots.
 */
export interface VisibilityObserver {
  observe(el: Element): void;
  unobserve?(el: Element): void;
  disconnect(): void;
}

/**
 * `root` is the element that actually scrolls the cards (the gallery board).
 * It must be passed: the board is its own overflow scroller, so an observer
 * with the implicit viewport root never applies its rootMargin to the
 * scroller's clip edge (effective margin 0).
 */
export type VisibilityObserverFactory = (
  onChange: (el: Element, visible: boolean) => void,
  root?: Element | null,
) => VisibilityObserver | undefined;

/**
 * Hysteresis: a card loads its images once it is within 200px of the scroller
 * edge (so the hero is ready before it scrolls into view) but is only released
 * once it is further than 600px away, so a card hovering around the load
 * boundary does not clear and reload (flicker) as the user scrolls back and forth.
 */
export const GALLERY_LOAD_MARGIN = '200px';
export const GALLERY_RELEASE_MARGIN = '600px';

export const defaultVisibilityObserverFactory: VisibilityObserverFactory = (onChange, root) => {
  if (typeof IntersectionObserver === 'undefined') return undefined;
  const init = (rootMargin: string): IntersectionObserverInit => ({ root: root ?? null, rootMargin });
  const load = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) onChange(e.target, true);
  }, init(GALLERY_LOAD_MARGIN));
  const release = new IntersectionObserver((entries) => {
    for (const e of entries) if (!e.isIntersecting) onChange(e.target, false);
  }, init(GALLERY_RELEASE_MARGIN));
  return {
    observe(el) { load.observe(el); release.observe(el); },
    unobserve(el) { load.unobserve(el); release.unobserve(el); },
    disconnect() { load.disconnect(); release.disconnect(); },
  };
};

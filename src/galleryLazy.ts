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

export type VisibilityObserverFactory = (
  onChange: (el: Element, visible: boolean) => void,
) => VisibilityObserver | undefined;

/** How far outside the viewport a card still counts as visible. */
export const GALLERY_ROOT_MARGIN = '200px';

export const defaultVisibilityObserverFactory: VisibilityObserverFactory = (onChange) => {
  if (typeof IntersectionObserver === 'undefined') return undefined;
  return new IntersectionObserver(
    (entries) => {
      for (const e of entries) onChange(e.target, e.isIntersecting);
    },
    { rootMargin: GALLERY_ROOT_MARGIN },
  );
};

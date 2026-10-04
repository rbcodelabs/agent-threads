/** Max characters kept for the sticky header label; CSS line-clamp handles the visual 2-line cut. */
export const STICKY_PREVIEW_MAX_CHARS = 240;

/** Sub-pixel slack so a smooth-scrolled target resting at the edge counts as "at the top". */
export const STICKY_EDGE_TOLERANCE_PX = 2;

/**
 * Pick the user message the sticky header should show: the last one whose
 * bottom edge has scrolled above the top of the scroller viewport. Scans from
 * the end so long transcripts stop at the first hit. Returns -1 when every user
 * message is still (partly) visible or below the viewport, or there are none.
 *
 * When `getTop` is supplied, a later message that straddles the top edge
 * (started at or above it, still partly visible) also yields -1: the user is
 * looking at that prompt, and a header for the previous one would only cover
 * it. This is what makes click-to-scroll land cleanly (target rests at the top).
 */
export function pickStickyUserIndex(
  count: number,
  getBottom: (index: number) => number,
  viewportTop: number,
  getTop?: (index: number) => number,
): number {
  for (let i = count - 1; i >= 0; i--) {
    if (getBottom(i) <= viewportTop) {
      if (getTop) {
        for (let j = count - 1; j > i; j--) {
          if (getTop(j) <= viewportTop + STICKY_EDGE_TOLERANCE_PX) return -1;
        }
      }
      return i;
    }
  }
  return -1;
}

/** Collapse whitespace and cap length with an ellipsis. Empty input yields ''. */
export function truncateStickyText(text: string, max = STICKY_PREVIEW_MAX_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

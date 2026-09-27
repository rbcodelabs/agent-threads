/**
 * Linear-time trailing-separator stripping for user-supplied URLs and paths.
 *
 * Replaces `s.replace(/\/+$/, '')` and `/[\\/]+$/`: CodeQL flags those as
 * polynomial ReDoS (js/polynomial-redos), because a long run of separators
 * that is *not* at the end makes the engine retry the run from every start
 * position (quadratic). A backwards scan is O(n) and behaves identically.
 * No dependencies, so it is safe to import from mobile-loaded modules.
 */
function stripTrailing(s: string, isSeparator: (code: number) => boolean): string {
  let end = s.length;
  while (end > 0 && isSeparator(s.charCodeAt(end - 1))) end--;
  return end === s.length ? s : s.slice(0, end);
}

const SLASH = 0x2f; // '/'
const BACKSLASH = 0x5c; // '\'

/** Equivalent to `s.replace(/\/+$/, '')`. */
export function stripTrailingSlashes(s: string): string {
  return stripTrailing(s, code => code === SLASH);
}

/** Equivalent to `s.replace(/[\\/]+$/, '')` — strips trailing `/` and `\`. */
export function stripTrailingPathSeparators(s: string): string {
  return stripTrailing(s, code => code === SLASH || code === BACKSLASH);
}

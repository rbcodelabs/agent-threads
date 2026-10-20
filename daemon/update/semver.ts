/** Stable `X.Y.Z` versions only: a pre-release (`1.2.3-rc.1`) or build tag is never a candidate for auto-update. */
export interface Semver { major: number; minor: number; patch: number }

export function parseStableVersion(v: string): Semver | null {
  const m = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(v.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

/** Negative when `a < b`. Throws on a non-stable version: callers decide what an unparseable version means. */
export function compareVersions(a: string, b: string): number {
  const x = parseStableVersion(a);
  const y = parseStableVersion(b);
  if (!x || !y) throw new Error(`cannot compare versions "${a}" and "${b}"`);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const c = parseStableVersion(candidate);
  const cur = parseStableVersion(current);
  return !!c && !!cur && compareVersions(candidate, current) > 0;
}

/** A major bump may break the wire protocol or the config: reported, never applied automatically. */
export function isMajorBump(candidate: string, current: string): boolean {
  const c = parseStableVersion(candidate);
  const cur = parseStableVersion(current);
  return !!c && !!cur && c.major !== cur.major;
}

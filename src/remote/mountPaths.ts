/**
 * Host <-> daemon path translation for the local daemon's bind mounts. Core module (no Node imports): the composer
 * uses it, and core must not import the Node-only `localDaemon/` code. Re-exported from `localDaemon/spec.ts`.
 */
export interface PathMount { host: string; guest: string; readOnly?: boolean }

/** Trailing slashes dropped; undefined for a relative path or one with a `..` segment (never translated). */
function cleanAbsolute(p: string): string | undefined {
  if (!p.startsWith('/')) return undefined;
  const parts = p.split('/').filter((seg) => seg !== '' && seg !== '.');
  if (parts.includes('..')) return undefined;
  return `/${parts.join('/')}`;
}

function translatePath(mounts: readonly PathMount[], path: string, from: 'host' | 'guest', to: 'host' | 'guest'): string | undefined {
  const target = cleanAbsolute(path);
  if (target === undefined) return undefined;
  let best: { root: string; other: string } | undefined;
  for (const m of mounts) {
    const root = cleanAbsolute(m[from]);
    const other = cleanAbsolute(m[to]);
    if (root === undefined || other === undefined) continue;
    const inside = root === '/' || target === root || target.startsWith(`${root}/`);
    if (inside && (!best || root.length > best.root.length)) best = { root, other };
  }
  if (!best) return undefined;
  const rest = best.root === '/' ? target : target.slice(best.root.length);
  return best.other === '/' ? (rest || '/') : `${best.other}${rest}`;
}

/** Where a path on this Mac appears inside the local daemon (deepest mount wins, subpath kept); undefined when it is not shared. */
export function hostToGuestPath(mounts: readonly PathMount[], hostPath: string): string | undefined {
  return translatePath(mounts, hostPath, 'host', 'guest');
}

/** The Mac path behind a path inside the local daemon; undefined when it is not under a mount. */
export function guestToHostPath(mounts: readonly PathMount[], guestPath: string): string | undefined {
  return translatePath(mounts, guestPath, 'guest', 'host');
}

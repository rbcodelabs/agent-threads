/**
 * What the daemon tells a client about its folders, so nobody has to type a
 * remote path from memory: `workspaces.list` (the configured roots, with a
 * guess at which ones are vaults) and `path.list` (subfolders, for browsing).
 *
 * Both are read-scope and confined to the allowlist exactly like `path.check`:
 * a path outside every workspace yields nothing, symlinks are resolved before
 * the comparison (a link inside a workspace that leads outside is not listed
 * and cannot be entered), and only directory names are ever returned, never
 * file names or contents.
 */
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { PATH_LIST_MAX_ENTRIES, type PathListEntry, type PathListReply, type WorkspaceInfo } from '../src/protocol';
import { allWorkspaceRoots, isWithin, realOrResolved, type SessionPolicy } from './sessionPolicy';

/** A folder holding one of these directories is treated as a vault. */
export const VAULT_MARKER_DIRS = ['.geode', '.obsidian', '.vault'] as const;

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export function detectWorkspaceKind(dir: string): 'vault' | 'folder' {
  return VAULT_MARKER_DIRS.some((marker) => isDirectory(join(dir, marker))) ? 'vault' : 'folder';
}

/**
 * The configured workspaces, read-write first then read-only, de-duplicated by
 * real path. The first one is the default: the first read-write workspace, or
 * the first read-only one when there is no read-write workspace at all.
 */
export function listWorkspaces(policy: SessionPolicy): WorkspaceInfo[] {
  const seen = new Set<string>();
  const out: Array<Omit<WorkspaceInfo, 'isDefault'>> = [];
  const add = (paths: readonly string[], readOnly: boolean): void => {
    for (const path of paths) {
      const real = realOrResolved(path);
      if (seen.has(real)) continue;
      seen.add(real);
      out.push({ path, name: basename(path) || path, readOnly, kind: detectWorkspaceKind(real) });
    }
  };
  add(policy.workspaces, false);
  add(policy.readOnlyWorkspaces ?? [], true);
  return out.map((w, i) => ({ ...w, isDefault: i === 0 }));
}

/** Symlinked entries resolved per `path.list` call. */
export const MAX_LINKS_RESOLVED = 500;

const NOT_ALLOWED: PathListReply = { allowed: false, entries: [], truncated: false };

/**
 * Subfolders of `path`, which must be inside a workspace. Dot-directories are
 * skipped (never what a person is looking for, and `.git` alone would bury
 * the list). Entries that resolve outside every workspace are omitted.
 */
export function listSubfolders(path: string, policy: SessionPolicy, max = PATH_LIST_MAX_ENTRIES): PathListReply {
  if (typeof path !== 'string' || !isAbsolute(path)) return NOT_ALLOWED;
  const roots = allWorkspaceRoots(policy).map(realOrResolved);
  const resolved = resolve(path);
  let real: string;
  try { real = realpathSync(resolved); } catch { return NOT_ALLOWED; }
  if (!roots.some((r) => isWithin(r, real))) return NOT_ALLOWED;
  if (!isDirectory(real)) return { allowed: true, entries: [], truncated: false };
  let dirents: Array<{ name: string; link: boolean }>;
  try {
    dirents = readdirSync(real, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.'))
      .map((d) => ({ name: d.name, link: d.isSymbolicLink() }));
  } catch {
    return { allowed: true, entries: [], truncated: false };
  }
  dirents.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  const entries: PathListEntry[] = [];
  let truncated = false;
  let linksResolved = 0;
  for (const { name, link } of dirents) {
    if (entries.length >= max) { truncated = true; break; }
    // A real subdirectory of a path already known to be inside the roots is inside them too: no syscall.
    // Only a symlink can lead elsewhere, and resolving each costs a realpath, so the number of those per
    // request is capped (a directory of thousands of links cannot turn one read-scope call into thousands of stats).
    if (link) {
      if (++linksResolved > MAX_LINKS_RESOLVED) { truncated = true; break; }
      let childReal: string;
      try { childReal = realpathSync(join(real, name)); } catch { continue; }
      if (!isDirectory(childReal) || !roots.some((r) => isWithin(r, childReal))) continue;
    }
    entries.push({ name, path: join(resolved, name) });
  }
  return { allowed: true, entries, truncated };
}

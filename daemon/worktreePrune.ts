/**
 * Removes worktrees nobody has touched for a while, so a daemon that agents create a worktree on for every task does
 * not fill its disk. Run once at daemon start.
 *
 * Deliberately conservative, because a removed worktree is gone: only worktrees of the clones under the workspace root
 * AND located under a managed worktree root are considered; a worktree is removed only when it is idle (nothing in it
 * or in its git directory changed within the window), clean (no uncommitted or untracked files), fully pushed (every
 * commit on it is on some remote branch), and not locked. `git worktree remove` is used WITHOUT `--force`.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { realGit, type GitRunner } from './repos';

/** Entries examined per worktree when looking for the newest change; more than this counts as "active". */
const MAX_SCAN_ENTRIES = 50_000;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

export interface PruneOptions {
  /** Directory holding the clones (`<root>/<name>`). */
  repoRoot: string;
  /** Directories `enter_worktree` creates worktrees under; only worktrees inside these are touched. */
  worktreeRoots: string[];
  days: number;
  now?: () => number;
  git?: GitRunner;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface PruneResult {
  removed: string[];
  kept: Array<{ path: string; reason: string }>;
}

const within = (root: string, p: string): boolean => {
  const rel = relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** Newest mtime under `dir`, or `Infinity` when the tree is too big to scan (treated as active). */
export function newestChange(dir: string): number {
  let newest = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    try { newest = Math.max(newest, statSync(cur).mtimeMs); } catch { /* raced away */ }
    for (const e of entries) {
      if (++seen > MAX_SCAN_ENTRIES) return Infinity;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(join(cur, e.name));
      } else {
        try { newest = Math.max(newest, statSync(join(cur, e.name)).mtimeMs); } catch { /* raced away */ }
      }
    }
  }
  return newest;
}

interface Linked { path: string; locked: boolean }

function parseWorktrees(porcelain: string): Linked[] {
  const out: Linked[] = [];
  let cur: Linked | null = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice('worktree '.length), locked: false }; out.push(cur); }
    else if (cur && line.startsWith('locked')) cur.locked = true;
  }
  return out.slice(1); // the first entry is the main checkout
}

export async function pruneIdleWorktrees(opts: PruneOptions): Promise<PruneResult> {
  const result: PruneResult = { removed: [], kept: [] };
  if (opts.days <= 0) return result;
  const now = (opts.now ?? Date.now)();
  const cutoff = now - opts.days * 86_400_000;
  const git = opts.git ?? realGit;
  const env = { PATH: (opts.env ?? process.env).PATH, HOME: (opts.env ?? process.env).HOME, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } as NodeJS.ProcessEnv;
  let names: string[];
  try { names = readdirSync(opts.repoRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); } catch { return result; }
  for (const name of names) {
    const repo = join(opts.repoRoot, name);
    let worktrees: Linked[];
    try { worktrees = parseWorktrees((await git(['-C', repo, 'worktree', 'list', '--porcelain'], { env })).stdout); } catch { continue; }
    for (const wt of worktrees) {
      const keep = (reason: string): void => { result.kept.push({ path: wt.path, reason }); };
      if (!opts.worktreeRoots.some((r) => within(r, wt.path))) { keep('outside the managed worktree roots'); continue; }
      if (wt.locked) { keep('locked'); continue; }
      let gitDir = '';
      try { gitDir = (await git(['-C', wt.path, 'rev-parse', '--absolute-git-dir'], { env })).stdout.trim(); } catch { keep('not readable'); continue; }
      const touched = Math.max(newestChange(wt.path), gitDir ? newestChange(gitDir) : 0);
      if (touched > cutoff) { keep('recently used'); continue; }
      try {
        if ((await git(['-C', wt.path, 'status', '--porcelain', '--untracked-files=all'], { env })).stdout.trim()) { keep('uncommitted changes'); continue; }
        if ((await git(['-C', wt.path, 'log', '--oneline', '-1', 'HEAD', '--not', '--remotes'], { env })).stdout.trim()) { keep('commits not pushed'); continue; }
        await git(['-C', repo, 'worktree', 'remove', wt.path], { env });
        result.removed.push(wt.path);
        opts.log?.(`pruned idle worktree ${wt.path}`);
      } catch (err) {
        keep(`not removed: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
      }
    }
    try { await git(['-C', repo, 'worktree', 'prune'], { env }); } catch { /* best effort */ }
  }
  return result;
}

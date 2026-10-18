import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneIdleWorktrees } from '../../daemon/worktreePrune';
import { age, git, makeRemote, tempDir } from '../helpers/gitFixtures';

let base: string;
let root: string;
let repo: string;
let wtRoot: string;

beforeEach(() => {
  base = tempDir('prune-');
  root = join(base, 'workspace');
  mkdirSync(root);
  repo = join(root, 'proj');
  git(['clone', makeRemote(base), repo]);
  wtRoot = join(root, '.worktrees');
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

const addWorktree = (branch: string, dir = join(wtRoot, 'proj', branch)): string => {
  mkdirSync(join(dir, '..'), { recursive: true });
  git(['worktree', 'add', dir, '-b', branch], repo);
  return realpathSync(dir);
};
const gitDirOf = (wt: string): string => git(['rev-parse', '--absolute-git-dir'], wt);
const prune = (days = 14) => pruneIdleWorktrees({ repoRoot: root, worktreeRoots: [wtRoot], days });

describe('pruneIdleWorktrees', () => {
  it('removes a clean, pushed worktree idle past the window, and only that one', async () => {
    const old = addWorktree('old');
    const fresh = addWorktree('fresh');
    age(old, 30); age(gitDirOf(old), 30);
    const result = await prune();
    expect(result.removed).toEqual([old]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(result.kept).toEqual([{ path: fresh, reason: 'recently used' }]);
    // git no longer lists the removed one
    expect(git(['worktree', 'list', '--porcelain'], repo)).not.toContain(old);
  });

  it('keeps an old worktree with uncommitted or untracked changes', async () => {
    const dirty = addWorktree('dirty');
    writeFileSync(join(dirty, 'wip.txt'), 'work in progress');
    age(dirty, 30); age(gitDirOf(dirty), 30);
    const result = await prune();
    expect(result.removed).toEqual([]);
    expect(result.kept[0]).toMatchObject({ path: dirty, reason: 'uncommitted changes' });
    expect(existsSync(join(dirty, 'wip.txt'))).toBe(true);
  });

  it('keeps an old worktree with commits that exist on no remote', async () => {
    const wt = addWorktree('unpushed');
    writeFileSync(join(wt, 'f.txt'), 'x');
    git(['add', '.'], wt);
    git(['commit', '-m', 'local only'], wt);
    age(wt, 30); age(gitDirOf(wt), 30);
    const result = await prune();
    expect(result.removed).toEqual([]);
    expect(result.kept[0]).toMatchObject({ path: wt, reason: 'commits not pushed' });
  });

  it('keeps a locked worktree and one outside the managed roots', async () => {
    const locked = addWorktree('locked');
    git(['worktree', 'lock', locked], repo);
    const outside = addWorktree('outside', join(base, 'elsewhere', 'outside'));
    for (const wt of [locked, outside]) { age(wt, 30); age(gitDirOf(wt), 30); }
    const result = await prune();
    expect(result.removed).toEqual([]);
    expect(result.kept.map((k) => k.reason).sort()).toEqual(['locked', 'outside the managed worktree roots']);
  });

  it('days = 0 turns pruning off', async () => {
    const old = addWorktree('old');
    age(old, 400); age(gitDirOf(old), 400);
    expect(await prune(0)).toEqual({ removed: [], kept: [] });
    expect(existsSync(old)).toBe(true);
  });

  it('a recent edit inside the worktree keeps it even if git metadata is old', async () => {
    const wt = addWorktree('busy');
    age(wt, 30); age(gitDirOf(wt), 30);
    writeFileSync(join(wt, 'README.md'), 'edited just now\n'); // dirty AND recent
    const result = await prune();
    expect(result.removed).toEqual([]);
    expect(result.kept[0].reason).toBe('recently used');
  });

  it('does nothing when the root does not exist', async () => {
    expect(await pruneIdleWorktrees({ repoRoot: join(base, 'none'), worktreeRoots: [], days: 14 })).toEqual({ removed: [], kept: [] });
  });
});

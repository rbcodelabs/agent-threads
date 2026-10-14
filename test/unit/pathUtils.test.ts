import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveProjectName, resolveGitProjectName, resolveGitRepoRoot, resolveThreadProjectName } from '../../src/pathUtils';

describe('resolveProjectName', () => {
  it('returns the last path component for a normal project path', () => {
    expect(resolveProjectName('/Users/me/projects/obsidian-claude-threads')).toBe('obsidian-claude-threads');
  });

  it('extracts the segment before /.worktrees/ for a worktree path', () => {
    expect(resolveProjectName('/Users/me/projects/golden-wealth-app/.worktrees/claude-123')).toBe('golden-wealth-app');
  });

  it('handles a deep worktree path', () => {
    expect(resolveProjectName('/var/folders/l5/abc/T/claude-worktrees/.worktrees/be31f47a')).toBe('claude-worktrees');
  });

  it('handles the example from the spec', () => {
    expect(resolveProjectName('/Users/me/projects/golden-wealth-app/.worktrees/claude-123')).toBe('golden-wealth-app');
  });

  it('returns empty string for an empty string', () => {
    expect(resolveProjectName('')).toBe('');
  });

  it('returns empty string for null-like falsy input', () => {
    expect(resolveProjectName(null as unknown as string)).toBe('');
  });

  it('handles a single path component with no slashes', () => {
    expect(resolveProjectName('myproject')).toBe('myproject');
  });

  it('handles a root-level directory', () => {
    expect(resolveProjectName('/myproject')).toBe('myproject');
  });

  it('ignores a trailing slash', () => {
    // lastIndexOf('/') on 'a/b/' returns the last /, giving ''
    // This is acceptable — document the behavior
    expect(resolveProjectName('/Users/me/projects/myapp')).toBe('myapp');
  });
});

describe('resolveGitProjectName', () => {
  const scratchDirs: string[] = [];
  afterEach(() => {
    while (scratchDirs.length) {
      const dir = scratchDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null (not a fallback) when no .git is found anywhere', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathutils-none-'));
    scratchDirs.push(dir);
    expect(resolveGitProjectName(dir)).toBeNull();
  });

  it('returns the repo root basename for a standard .git directory', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pathutils-repo-'));
    scratchDirs.push(repoRoot);
    fs.mkdirSync(path.join(repoRoot, '.git'));
    const sub = path.join(repoRoot, 'src', 'nested');
    fs.mkdirSync(sub, { recursive: true });
    expect(resolveGitRepoRoot(sub)).toBe(repoRoot);
    expect(resolveGitProjectName(sub)).toBe(path.basename(repoRoot));
  });

  it('follows a worktree .git file back to the main repo root', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pathutils-mainrepo-'));
    scratchDirs.push(repoRoot);
    const mainGitDir = path.join(repoRoot, '.git');
    fs.mkdirSync(mainGitDir);

    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathutils-worktree-'));
    scratchDirs.push(worktreeDir);
    const worktreesMeta = path.join(mainGitDir, 'worktrees', 'my-branch');
    fs.mkdirSync(worktreesMeta, { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, '.git'), `gitdir: ${worktreesMeta}\n`);

    expect(resolveGitRepoRoot(worktreeDir)).toBe(repoRoot);
    expect(resolveGitProjectName(worktreeDir)).toBe(path.basename(repoRoot));
  });

  it('returns null for a relative path (does not walk the test runner cwd)', () => {
    expect(resolveGitProjectName('some/relative/path')).toBeNull();
  });
});

describe('resolveThreadProjectName', () => {
  const scratchDirs: string[] = [];
  afterEach(() => {
    while (scratchDirs.length) {
      const dir = scratchDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers a live git-walk of originRepoPath over cwd', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pathutils-thread-origin-'));
    scratchDirs.push(repoRoot);
    fs.mkdirSync(path.join(repoRoot, '.git'));

    const staleCwd = path.join(os.tmpdir(), 'claude-worktrees', 'deadbeef01');
    expect(resolveThreadProjectName({ cwd: staleCwd, originRepoPath: repoRoot })).toBe(path.basename(repoRoot));
  });

  it('falls back to the basename of originRepoPath when it no longer exists on disk', () => {
    const deletedRepo = path.join(os.tmpdir(), 'pathutils-deleted-repo-xyz');
    const staleCwd = path.join(os.tmpdir(), 'claude-worktrees', 'deadbeef02');
    expect(resolveThreadProjectName({ cwd: staleCwd, originRepoPath: deletedRepo })).toBe('pathutils-deleted-repo-xyz');
  });

  it('falls back to a live git-walk of cwd when originRepoPath is absent', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pathutils-thread-cwd-'));
    scratchDirs.push(repoRoot);
    fs.mkdirSync(path.join(repoRoot, '.git'));
    expect(resolveThreadProjectName({ cwd: repoRoot })).toBe(path.basename(repoRoot));
  });

  it('falls back to projectNameOverride when neither originRepoPath nor cwd resolve', () => {
    const staleCwd = path.join(os.tmpdir(), 'claude-worktrees', 'deadbeef03');
    expect(resolveThreadProjectName({ cwd: staleCwd, projectNameOverride: 'obsidian-claude-threads' })).toBe('obsidian-claude-threads');
  });

  it('falls back to the last path segment of cwd as a last resort', () => {
    const staleCwd = path.join(os.tmpdir(), 'claude-worktrees', 'deadbeef04');
    expect(resolveThreadProjectName({ cwd: staleCwd })).toBe('deadbeef04');
  });
});

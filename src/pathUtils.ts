/**
 * Resolves a git repository root from a working directory path.
 *
 * Strategy (in order):
 * 1. Walk up from `cwd` looking for a `.git` entry.
 *    - `.git` is a *directory*  → we found the main repo root; return it.
 *    - `.git` is a *file*       → we're in a worktree; parse the `gitdir:` pointer,
 *                                  navigate to the main `.git` dir, and return the
 *                                  repo root.
 * 2. If nothing is found, return null — callers decide their own fallback.
 *
 * Uses synchronous fs calls (acceptable — only called from UI render paths on desktop).
 */
export function resolveGitRepoRoot(cwd: string): string | null {
  if (!cwd) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePath = require('path') as typeof import('path');

    // Fast-path string detection: if the path contains /.worktrees/, the segment
    // immediately before it is the repo/project name. This handles the common
    // Claude worktree layout without needing any filesystem I/O.
    const worktreesIdx = cwd.indexOf('/.worktrees/');
    if (worktreesIdx !== -1) {
      return nodePath.normalize(cwd.slice(0, worktreesIdx));
    }

    // For absolute paths only: walk up the directory tree looking for a .git
    // entry to determine the real repo root. Skipping relative paths avoids
    // accidentally hitting the test runner's own CWD .git entry.
    if (nodePath.isAbsolute(cwd)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs') as typeof import('fs');

      let dir = cwd;
      for (let i = 0; i < 10; i++) {
        const gitEntry = nodePath.join(dir, '.git');

        if (fs.existsSync(gitEntry)) {
          const stat = fs.statSync(gitEntry);

          if (stat.isDirectory()) {
            // Standard repo root — the parent of .git is the project.
            return dir;
          }

          if (stat.isFile()) {
            // Worktree: .git is a file like "gitdir: /path/to/main/.git/worktrees/branch"
            const content = fs.readFileSync(gitEntry, 'utf8').trim();
            const match = content.match(/^gitdir:\s*(.+)$/m);
            if (match) {
              const gitdirPath = nodePath.resolve(dir, match[1].trim());
              // gitdirPath is something like /repo/.git/worktrees/<name>
              // Navigate: strip /worktrees/<name> to reach /repo/.git, then go up one more
              const worktreesSep = nodePath.sep + 'worktrees' + nodePath.sep;
              const idx = gitdirPath.indexOf(worktreesSep);
              if (idx !== -1) {
                const mainGitDir = gitdirPath.slice(0, idx);       // /repo/.git
                const repoRoot   = nodePath.dirname(mainGitDir);   // /repo
                return repoRoot;
              }
              // Fallback: just use the parent of the gitdir we found
              return nodePath.dirname(nodePath.dirname(gitdirPath));
            }
          }
        }

        const parent = nodePath.dirname(dir);
        if (parent === dir) break; // filesystem root
        dir = parent;
      }
    }
  } catch {
    // Silently fall through to null on any I/O error
  }

  return null;
}

export function resolveGitProjectName(cwd: string): string | null {
  const root = resolveGitRepoRoot(cwd);
  if (!root) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('path') as typeof import('path');
  return nodePath.basename(root);
}

/**
 * Resolves a human-readable project name (git repo name) from a working directory path.
 *
 * Thin wrapper over `resolveGitProjectName` that preserves the historical
 * behavior of always returning *something*: when the git walk can't determine
 * a repo name, falls back to the last path segment of `cwd`.
 */
export function resolveProjectName(cwd: string): string {
  if (!cwd) return '';
  const resolved = resolveGitProjectName(cwd);
  if (resolved) return resolved;

  // Last resort: return the final path component.
  const lastSlash = cwd.lastIndexOf('/');
  return lastSlash === -1 ? cwd : cwd.slice(lastSlash + 1);
}

/**
 * Minimal shape needed to resolve a thread's project/Kanban-lane label.
 * Matches (a subset of) `Thread` from types.ts without importing it here,
 * keeping this module dependency-free for its existing unit tests.
 */
export interface ThreadProjectNameInput {
  cwd: string;
  originRepoPath?: string;
  projectNameOverride?: string;
  /** Present on a remote thread: `cwd` is on another machine, so it is never walked on this disk. */
  remote?: unknown;
}

/**
 * Resolves the project name to display for a thread, in priority order:
 *
 * 1. `originRepoPath` (the git root a worktree was cut from, captured at
 *    `enter_worktree` time) — tried via a live git-walk first in case the
 *    path itself moved, then its basename as a direct fallback. This is what
 *    keeps Kanban grouping correct after the worktree directory is deleted.
 * 2. A live git-walk from `cwd` (handles ordinary repos and worktrees that
 *    still exist on disk).
 * 3. `projectNameOverride` — a display-only label backfilled for legacy
 *    threads that predate `originRepoPath` (see
 *    `ThreadManager.backfillLegacyProjectNames()`).
 * 4. The last path segment of `cwd`, matching `resolveProjectName`'s final
 *    fallback so callers always get a non-empty label.
 */
export function resolveThreadProjectName(thread: ThreadProjectNameInput): string {
  if (thread.remote) {
    if (thread.projectNameOverride) return thread.projectNameOverride;
    const trimmed = thread.cwd.replace(/\/+$/, '');
    return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed || 'remote';
  }
  if (thread.originRepoPath) {
    const viaOrigin = resolveGitProjectName(thread.originRepoPath);
    if (viaOrigin) return viaOrigin;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePath = require('path') as typeof import('path');
    return nodePath.basename(thread.originRepoPath);
  }

  const viaCwd = resolveGitProjectName(thread.cwd);
  if (viaCwd) return viaCwd;

  if (thread.projectNameOverride) return thread.projectNameOverride;

  return resolveProjectName(thread.cwd);
}

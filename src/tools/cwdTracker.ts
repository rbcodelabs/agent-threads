/**
 * In-session working-directory state shared by the worktree, VM and host_exec
 * tools. The Claude subprocess's own cwd is frozen at spawn, so the tools keep
 * the effective cwd here and `set_working_directory` / `enter_worktree` update
 * it immediately, within the same turn.
 */
export interface CwdTracker {
  get(): string;
  set(path: string): void;
  /** worktreePath -> the git root it was created from, for the worktrees this session created. */
  readonly activeWorktrees: Map<string, string>;
}

export function createCwdTracker(initial = ''): CwdTracker {
  let cwd = initial;
  return {
    get: () => cwd,
    set: (path) => { cwd = path; },
    activeWorktrees: new Map(),
  };
}

/**
 * GitDiffService — for each thread's working directory, computes native git
 * plumbing (no `gh`, no network): whether the cwd is a git repo, its current
 * branch, the repo's default/base branch, and a "branch vs base, including
 * uncommitted changes" diff stat (what a PR opened right now would contain).
 * Powers the git diff bar + Create PR button shown above the compose box in
 * ThreadsView. Desktop-only; a no-op on mobile (no child_process).
 *
 * Structurally mirrors StatusLineService: per-cwd coalescing, a short-TTL
 * cache, a concurrency cap, and both interval + event-driven triggers. The
 * key difference is *what* runs: StatusLineService execs an arbitrary
 * user-configured command via a shell string; this service only ever runs
 * fixed `git` subcommands via `execFile` with argument arrays — no shell
 * involved, so there is no injection surface and no PATH/quoting fragility
 * beyond locating the `git` binary itself.
 */
import type { ThreadManager, ThreadEvent } from './ThreadManager';
import type { GitDiffInfo } from './types';
import { parseShortStat, parseRemoteToOwnerRepo } from './gitDiffUtils';
import { execEnv } from './dashboardUtils';
import { telemetry } from './telemetry';

/** Minimal child_process.execFile signature (callback form) the service depends on. */
export type GitDiffExecFile = (
  file: string,
  args: string[],
  opts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv },
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

export interface GitDiffServiceDeps {
  execFile: GitDiffExecFile;
  now: () => number;
  isMobile: boolean;
  /** Gate interval polls (e.g. pause when no view is open and nothing runs). Event polls always run. */
  shouldPoll?: () => boolean;
  /** Fallback cwd for threads with none. */
  getDefaultCwd?: () => string;
}

const DEFAULT_INTERVAL_MS = 20_000;
const EXEC_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 5_000;
const MAX_CONCURRENCY = 4;
const COALESCE_MS = 150;

export class GitDiffService {
  private manager: ThreadManager;
  private deps: GitDiffServiceDeps;

  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCwds = new Set<string>();
  private cache = new Map<string, { info: GitDiffInfo; at: number }>();
  private inFlight = new Set<string>();
  private started = false;

  constructor(manager: ThreadManager, deps: GitDiffServiceDeps) {
    this.manager = manager;
    this.deps = deps;
  }

  start(): void {
    if (this.deps.isMobile || this.started) return;
    this.started = true;

    this.unsubscribe = this.manager.subscribe((threadId, event) => this.onEvent(threadId, event));

    this.intervalTimer = setInterval(() => {
      if (this.deps.shouldPoll && !this.deps.shouldPoll()) return;
      void this.pollAll();
    }, DEFAULT_INTERVAL_MS);

    // Prime once on startup so the bar appears without waiting a full interval.
    void this.pollAll();
  }

  stop(): void {
    if (this.intervalTimer !== null) { clearInterval(this.intervalTimer); this.intervalTimer = null; }
    if (this.coalesceTimer !== null) { clearTimeout(this.coalesceTimer); this.coalesceTimer = null; }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.pendingCwds.clear();
    this.cache.clear();
    this.inFlight.clear();
    this.started = false;
  }

  /** Restart timers/subscriptions. */
  restart(): void {
    if (!this.started) { this.start(); return; }
    this.stop();
    this.start();
  }

  /** Force-refresh a single thread's cwd now (bypasses cache), e.g. on thread switch. */
  pokeThread(threadId: string): void {
    if (this.deps.isMobile) return;
    const cwd = this.cwdFor(threadId);
    if (!cwd) return;
    this.cache.delete(cwd);
    void this.runCwd(cwd);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private onEvent(threadId: string, event: ThreadEvent): void {
    switch (event.type) {
      case 'done':
      case 'cwd_changed':
      case 'thread_created':
      case 'active_thread_changed': {
        const cwd = this.cwdFor(threadId);
        if (cwd) this.scheduleCwd(cwd);
        break;
      }
      default:
        break;
    }
  }

  private cwdFor(threadId: string): string | null {
    const thread = this.manager.getThread(threadId);
    // Remote cwd = a path on the daemon's machine; never run local git against it (see StatusLineService).
    if (thread?.remote) return null;
    const cwd = thread?.cwd || this.deps.getDefaultCwd?.() || '';
    return cwd || null;
  }

  /** Coalesce a burst of events into a single debounced poll per cwd. */
  private scheduleCwd(cwd: string): void {
    this.pendingCwds.add(cwd);
    if (this.coalesceTimer !== null) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      const cwds = [...this.pendingCwds];
      this.pendingCwds.clear();
      for (const c of cwds) void this.runCwd(c);
    }, COALESCE_MS);
  }

  /** Poll every distinct cwd across all threads (deduped), honoring the cap. */
  async pollAll(): Promise<void> {
    if (this.deps.isMobile) return;

    const cwds = new Set<string>();
    for (const t of this.manager.getThreads()) {
      if (t.remote) continue;
      const cwd = t.cwd || this.deps.getDefaultCwd?.() || '';
      if (cwd) cwds.add(cwd);
    }
    await this.runPool([...cwds], (cwd) => this.runCwd(cwd));
  }

  /** Run worker over items with a fixed concurrency cap. */
  private async runPool(items: string[], worker: (item: string) => Promise<void>): Promise<void> {
    let idx = 0;
    const runNext = async (): Promise<void> => {
      while (idx < items.length) {
        const i = idx++;
        await worker(items[i]);
      }
    };
    const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, items.length) }, () => runNext());
    await Promise.all(workers);
  }

  /**
   * Compute (cache-aware) git diff info for one cwd and fan the result out to
   * every thread sharing that cwd.
   */
  private async runCwd(cwd: string): Promise<void> {
    if (this.deps.isMobile) return;

    const cached = this.cache.get(cwd);
    if (cached && this.deps.now() - cached.at < CACHE_TTL_MS) {
      this.applyToCwd(cwd, cached.info);
      return;
    }

    if (this.inFlight.has(cwd)) return;
    this.inFlight.add(cwd);
    try {
      const info = await this.computeGitDiff(cwd);
      this.cache.set(cwd, { info, at: this.deps.now() });
      this.applyToCwd(cwd, info);
    } finally {
      this.inFlight.delete(cwd);
    }
  }

  private applyToCwd(cwd: string, info: GitDiffInfo): void {
    for (const t of this.manager.getThreads()) {
      if (!t.remote && (t.cwd || this.deps.getDefaultCwd?.() || '') === cwd) {
        this.manager.applyGitDiff(t.id, info);
      }
    }
  }

  /** Run one git subcommand, returning trimmed stdout on success or null on error/non-zero-exit/timeout. */
  private git(cwd: string, args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: string | null) => { if (!settled) { settled = true; resolve(v); } };
      try {
        // Telemetry: each git subcommand is a child-process spawn (EDR-sensitive);
        // one refresh cycle fires several, so this climbs faster than gitdiff cycles.
        telemetry.recordSpawn('gitdiff');
        this.deps.execFile(
          'git',
          args,
          { cwd, timeout: EXEC_TIMEOUT_MS, env: execEnv() },
          (err, stdout) => done(err ? null : (stdout ?? '').trim()),
        );
      } catch {
        done(null);
      }
    });
  }

  private async computeGitDiff(cwd: string): Promise<GitDiffInfo> {
    const isRepo = await this.git(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (isRepo !== 'true') {
      return { isGitRepo: false };
    }

    const branch = await this.git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch || branch === 'HEAD') {
      // Detached HEAD, or branch lookup failed — no PR possible; still a repo.
      return { isGitRepo: true };
    }

    const baseBranch = await this.resolveBaseBranch(cwd);

    if (branch === baseBranch) {
      // Sitting on the base/default branch itself — nothing to PR against.
      return { isGitRepo: true, branch, baseBranch, isBaseBranch: true };
    }

    let mergeBase = await this.git(cwd, ['merge-base', 'HEAD', `origin/${baseBranch}`]);
    if (!mergeBase) {
      mergeBase = await this.git(cwd, ['merge-base', 'HEAD', baseBranch]);
    }

    let insertions = 0;
    let deletions = 0;
    if (mergeBase) {
      // Single-ref diff: mergeBase tree vs the current working tree — includes
      // both already-committed branch changes AND any uncommitted changes, in
      // one command, with no double-counting. This is "what the PR would
      // contain right now."
      const shortstat = await this.git(cwd, ['diff', '--shortstat', mergeBase]);
      if (shortstat !== null) {
        const parsed = parseShortStat(shortstat);
        insertions = parsed.insertions;
        deletions = parsed.deletions;
      }
    }

    const remoteUrl = await this.git(cwd, ['remote', 'get-url', 'origin']);
    const ownerRepo = remoteUrl ? (parseRemoteToOwnerRepo(remoteUrl) ?? undefined) : undefined;

    return { isGitRepo: true, branch, baseBranch, insertions, deletions, ownerRepo };
  }

  /**
   * Best-effort default/base branch detection:
   *   1. `origin/HEAD` symref (the canonical answer when the remote is set up normally)
   *   2. `origin/main` if it exists
   *   3. `origin/master` if it exists
   *   4. literal fallback: 'main'
   */
  private async resolveBaseBranch(cwd: string): Promise<string> {
    const symref = await this.git(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    if (symref) {
      const m = symref.match(/^refs\/remotes\/origin\/(.+)$/);
      if (m) return m[1];
    }
    // `show-ref --verify --quiet` prints nothing on success or failure; our
    // git() helper distinguishes them via exit code: null only on non-zero exit.
    const hasMain = await this.git(cwd, ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main']);
    if (hasMain !== null) return 'main';
    const hasMaster = await this.git(cwd, ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/master']);
    if (hasMaster !== null) return 'master';
    return 'main';
  }
}

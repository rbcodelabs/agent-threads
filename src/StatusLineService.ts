/**
 * StatusLineService — runs the configured statusLineCommand for EACH thread's
 * working directory (not just the focused one) so every thread's status pills
 * and derived prUrl stay fresh. Desktop-only; a no-op on mobile (no child_process).
 *
 * Work is coalesced by cwd (N threads on one cwd → one exec), capped in
 * concurrency, cached briefly, and triggered both on an interval and on key
 * thread events. All Node/Obsidian touch-points are injected via `deps` so the
 * scheduling logic is unit-testable.
 */
import type { ThreadManager, ThreadEvent } from './ThreadManager';
import { parseStatusLine } from './statusLine';
import { execEnv } from './dashboardUtils';
import { telemetry } from './telemetry';

/** Minimal child_process.exec signature (callback form) the service depends on. */
export type StatusLineExec = (
  cmd: string,
  opts: { timeout: number; env: NodeJS.ProcessEnv },
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => { stdin?: { write: (s: string) => void; end: () => void } | null } | void;

export interface StatusLineServiceDeps {
  exec: StatusLineExec;
  now: () => number;
  homedir: () => string;
  isMobile: boolean;
  /** Gate interval polls (e.g. pause when no view is open and nothing runs). Event polls always run. */
  shouldPoll?: () => boolean;
  /** Fallback cwd for threads with none. */
  getDefaultCwd?: () => string;
}

interface StatusLineConfig {
  statusLineCommand: string;
  statusLineIntervalMs?: number;
  /** Active Claude provider ('claude' | 'bedrock'), passed to the script so it
   *  can gate provider-specific status (e.g. only check AWS when on bedrock). */
  provider?: string;
}

const DEFAULT_INTERVAL_MS = 30_000;
const EXEC_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 5_000;
const MAX_CONCURRENCY = 4;
const COALESCE_MS = 150;

export class StatusLineService {
  private manager: ThreadManager;
  private getConfig: () => StatusLineConfig;
  private deps: StatusLineServiceDeps;

  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCwds = new Set<string>();
  private cache = new Map<string, { tags: ReturnType<typeof parseStatusLine>; at: number }>();
  private inFlight = new Set<string>();
  private started = false;

  constructor(
    manager: ThreadManager,
    getConfig: () => StatusLineConfig,
    deps: StatusLineServiceDeps,
  ) {
    this.manager = manager;
    this.getConfig = getConfig;
    this.deps = deps;
  }

  start(): void {
    if (this.deps.isMobile || this.started) return;
    this.started = true;

    this.unsubscribe = this.manager.subscribe((threadId, event) => this.onEvent(threadId, event));

    const interval = this.getConfig().statusLineIntervalMs ?? DEFAULT_INTERVAL_MS;
    this.intervalTimer = setInterval(() => {
      if (this.deps.shouldPoll && !this.deps.shouldPoll()) return;
      void this.pollAll();
    }, interval);

    // Prime once on startup so pills appear without waiting a full interval.
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

  /** Restart timers/subscriptions (e.g. after the command or interval changes). */
  restart(): void {
    if (!this.started) { this.start(); return; }
    this.stop();
    this.start();
  }

  /** Force-refresh a single thread's cwd now (bypasses cache), e.g. on focus. */
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
    // A remote thread's cwd is a path on the daemon's machine: running the status command (or git)
    // against the same string locally would report some unrelated local directory.
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
    const cmd = this.getConfig().statusLineCommand;
    if (!cmd) return;

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
   * Run the script for one cwd (cache-aware) and fan the result out to every
   * thread sharing that cwd. On exec error, the previous tags are left intact.
   */
  private async runCwd(cwd: string): Promise<void> {
    if (this.deps.isMobile) return;
    const cmd = this.getConfig().statusLineCommand;
    if (!cmd) return;

    const cached = this.cache.get(cwd);
    if (cached && this.deps.now() - cached.at < CACHE_TTL_MS) {
      this.applyToCwd(cwd, cached.tags);
      return;
    }

    if (this.inFlight.has(cwd)) return;
    this.inFlight.add(cwd);
    try {
      const stdout = await this.execScript(cmd, cwd);
      if (stdout === null) return; // error → keep previous tags
      const tags = parseStatusLine(stdout);
      this.cache.set(cwd, { tags, at: this.deps.now() });
      this.applyToCwd(cwd, tags);
    } finally {
      this.inFlight.delete(cwd);
    }
  }

  private applyToCwd(cwd: string, tags: ReturnType<typeof parseStatusLine>): void {
    for (const t of this.manager.getThreads()) {
      if (!t.remote && (t.cwd || this.deps.getDefaultCwd?.() || '') === cwd) {
        this.manager.applyStatusTags(t.id, tags);
      }
    }
  }

  /** Returns stdout, or null on error/timeout (caller keeps previous tags). */
  private execScript(cmd: string, cwd: string): Promise<string | null> {
    const home = this.deps.homedir();
    const expanded = cmd.replace(/\$HOME/g, home).replace(/^~\//, `${home}/`);
    const provider = this.getConfig().provider ?? 'claude';
    const stdin = JSON.stringify({ cwd, workspace: { current_dir: cwd }, provider });

    return new Promise((resolve) => {
      let settled = false;
      const done = (v: string | null) => { if (!settled) { settled = true; resolve(v); } };
      try {
        // Telemetry: each exec is a child-process spawn (EDR-sensitive).
        telemetry.recordSpawn('statusline');
        const child = this.deps.exec(
          expanded,
          { timeout: EXEC_TIMEOUT_MS, env: execEnv() },
          (err, stdout) => done(err ? null : (stdout ?? '')),
        );
        const c = child as { stdin?: { write: (s: string) => void; end: () => void } | null } | void;
        if (c && c.stdin) {
          c.stdin.write(stdin);
          c.stdin.end();
        }
      } catch {
        done(null);
      }
    });
  }
}

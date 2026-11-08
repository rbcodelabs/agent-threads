/**
 * OrchestratorWakeup — event-driven wake-up for the thread-orchestrator thread.
 *
 * Rather than polling on a fixed schedule, the orchestrator should "feel"
 * continuously running: whenever any other thread finishes a turn (done or
 * error), this pings the orchestrator thread to run its review pass. Multiple
 * threads finishing within a short window are batched into a single ping via
 * a debounce timer, so a burst of completions doesn't spam multiple messages.
 *
 * The 60-minute CronCreate heartbeat set up alongside the orchestrator thread
 * (see main.ts ensureOrchestratorThread()) is a resilience backstop for missed
 * events only — this class is the primary trigger.
 *
 * Structurally mirrors GitDiffService/StatusLineService: a small class taking
 * an injected-dependency object so it can be unit tested without a real
 * ThreadManager or Obsidian environment.
 */
import type { ThreadManager, ThreadEvent } from './ThreadManager';

export interface OrchestratorWakeupDeps {
  /** Resolves the logical destination bucket for a completed thread. */
  resolveBucket: (threadId: string) => string | undefined;
  /** Resolves or creates the bucket's current target at flush time. */
  resolveTarget: (bucket: string, isCurrent: () => boolean) => string | { threadId: string; summaryOnly: true } | undefined | Promise<string | { threadId: string; summaryOnly: true } | undefined>;
  /** Returns true if a thread with the given id still exists. */
  threadExists: (threadId: string) => boolean;
  /** Sends the wake-up ping to the orchestrator thread. */
  sendMessage: (threadId: string, text: string) => Promise<void>;
  /** ms to wait after the last completion before flushing a batched ping. Default 12000. */
  debounceMs?: number;
  /** Injectable timer functions for deterministic tests. Default to the global timers. */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Called with a warning message when the orchestrator thread no longer exists at flush time. */
  onWarn?: (message: string) => void;
  /** Called when sendMessage rejects. */
  onError?: (error: unknown) => void;
  /**
   * True while a plugin has delegated wake-up (public API
   * `orchestrators.delegateWakeup`). Events are ignored and nothing is sent
   * while it returns true; absent means never suspended.
   */
  isSuspended?: () => boolean;
}

const DEFAULT_DEBOUNCE_MS = 12_000;

export class OrchestratorWakeup {
  private manager: ThreadManager;
  private deps: OrchestratorWakeupDeps;
  private unsubscribe: (() => void) | null = null;
  /** Thread id -> most recent event type ('done' | 'error') since the last flush. */
  private pending = new Map<string, Map<string, 'done' | 'error'>>();
  private timers = new Map<string, unknown>();
  /** Incremented whenever queued/in-flight work for a bucket is retired. */
  private generations = new Map<string, number>();

  constructor(manager: ThreadManager, deps: OrchestratorWakeupDeps) {
    this.manager = manager;
    this.deps = deps;
  }

  start(): void {
    if (this.unsubscribe) return; // already started
    this.unsubscribe = this.manager.subscribe((threadId, event) => this.onEvent(threadId, event));
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    for (const bucket of this.timers.keys()) this.clearTimer(bucket);
    this.pending.clear();
    this.generations.clear();
  }

  /**
   * Permanently discards the bucket's currently queued and in-flight batch.
   * A later event starts a fresh generation and cannot revive an older flush.
   */
  invalidateBucket(bucket: string): void {
    this.clearTimer(bucket);
    this.pending.delete(bucket);
    this.generations.set(bucket, this.generation(bucket) + 1);
  }

  /**
   * Drops every queued batch and timer (used when wake-up is delegated away).
   * In-flight flushes are stopped by the `isSuspended` checks in `flush`.
   */
  discardAll(): void {
    const buckets = new Set<string>([...this.timers.keys(), ...this.pending.keys(), ...this.generations.keys()]);
    for (const bucket of buckets) this.invalidateBucket(bucket);
  }

  private suspended(): boolean {
    return this.deps.isSuspended?.() === true;
  }

  private generation(bucket: string): number {
    return this.generations.get(bucket) ?? 0;
  }

  private onEvent(threadId: string, event: ThreadEvent): void {
    if (event.type !== 'done' && event.type !== 'error') return;
    if (this.suspended()) return;

    const bucket = this.deps.resolveBucket(threadId);
    if (!bucket) return;
    const bucketPending = this.pending.get(bucket) ?? new Map<string, 'done' | 'error'>();
    bucketPending.set(threadId, event.type);
    this.pending.set(bucket, bucketPending);
    this.armTimer(bucket);
  }

  private armTimer(bucket: string): void {
    this.clearTimer(bucket);
    const setTimeoutFn = this.deps.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    const debounceMs = this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const timer = setTimeoutFn(() => {
      this.timers.delete(bucket);
      void this.flush(bucket);
    }, debounceMs);
    this.timers.set(bucket, timer);
  }

  private clearTimer(bucket: string): void {
    const timer = this.timers.get(bucket);
    if (timer === undefined) return;
    const clearTimeoutFn = this.deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    clearTimeoutFn(timer);
    this.timers.delete(bucket);
  }

  private async flush(bucket: string): Promise<void> {
    if (this.suspended()) { this.pending.delete(bucket); return; }
    const generation = this.generation(bucket);
    // Snapshot before clearing — building the message reads this data, so
    // clearing first (as this used to do) would silently drop it.
    const entries = Array.from(this.pending.get(bucket)?.entries() ?? []);
    this.pending.delete(bucket);
    if (entries.length === 0) return;

    const isCurrent = () => this.generation(bucket) === generation;
    const resolvedTarget = await this.deps.resolveTarget(bucket, isCurrent);
    if (this.generation(bucket) !== generation || this.suspended()) return;
    if (!resolvedTarget) {
      this.deps.onWarn?.(`Orchestrator wake-up: no target available for ${bucket}, skipping`);
      return;
    }
    const orchestratorId = typeof resolvedTarget === 'string' ? resolvedTarget : resolvedTarget.threadId;

    if (!this.deps.threadExists(orchestratorId)) {
      this.deps.onWarn?.(`Orchestrator wake-up: thread ${orchestratorId} no longer exists, skipping`);
      return;
    }

    if (typeof resolvedTarget !== 'string' && resolvedTarget.summaryOnly) {
      const projectId = bucket.startsWith('project:') ? bucket.slice('project:'.length) : 'unknown';
      try {
        if (this.generation(bucket) !== generation || this.suspended()) return;
        await this.deps.sendMessage(orchestratorId, `New activity in Project ${projectId} — the Project orchestrator could not be reached.`);
      } catch (err) {
        this.deps.onError?.(err);
      }
      return;
    }

    const count = entries.length;
    const lines = entries.map(([threadId, status]) => {
      const thread = this.manager.getThread(threadId);
      const title = thread?.title;
      const label = title ? `${threadId} "${title}"` : threadId;
      const updatedAt = thread?.updatedAt ?? 'unavailable';
      return `- ${label} (${status}; updatedAt=${updatedAt})`;
    });
    const threadLabel = count === 1 ? 'thread' : 'threads';
    const message = [
      `New activity on ${count} ${threadLabel}. Review only the named changed ${threadLabel}; do not run a full reconciliation. The heartbeat handles missed activity.`,
      ...lines,
    ].join('\n');

    try {
      if (this.generation(bucket) !== generation || this.suspended()) return;
      await this.deps.sendMessage(orchestratorId, message);
    } catch (err) {
      this.deps.onError?.(err);
    }
  }
}

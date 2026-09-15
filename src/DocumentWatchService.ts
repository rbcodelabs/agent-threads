/**
 * DocumentWatchService — alerts the owning thread whenever a watched vault
 * document's content changes. ANY content change triggers the alert; there is
 * no separate "comment" detection. Ownership is per-thread — a watch belongs
 * to the thread that created it, and two threads can independently watch the
 * same path with no dedup/merge.
 *
 * Deps-injected (no direct Obsidian/global access beyond the passed `app`)
 * so it's unit-testable without a live Obsidian instance — structurally
 * mirrors OrchestratorWakeup (per-bucket debounce-then-send) and shares the
 * shared-timer + pending-Set coalescing shape used by StatusLineService and
 * GitDiffService.
 *
 * Two-stage debounce:
 *   1. Per-path coalesce (~150ms): a burst of `modify` events on the same
 *      file collapses into one stamp check per flush.
 *   2. Per-thread alert bucket (~2000ms): multiple files changing in one
 *      burst produce ONE batched alert message per thread, not one per file.
 */
import type { App, EventRef, TAbstractFile } from 'obsidian';
import { TFile } from 'obsidian';
import type { Thread, WatchedDocument } from './types';
import { documentMention } from './documentChat';

export interface DocumentWatchServiceDeps {
  app: App;
  getWatches: () => WatchedDocument[];
  saveWatches: (next: WatchedDocument[]) => Promise<void>;
  sendMessage: (threadId: string, text: string) => Promise<void>;
  getThread: (threadId: string) => Thread | undefined;
  /** Injectable timer functions for deterministic tests. Default to the global timers. */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Called when a saveWatches/sendMessage promise rejects. */
  onError?: (error: unknown) => void;
}

const COALESCE_MS = 150;
const ALERT_DEBOUNCE_MS = 2000;

export class DocumentWatchService {
  private deps: DocumentWatchServiceDeps;
  private started = false;
  private vaultRefs: EventRef[] = [];

  private coalesceTimer: unknown = null;
  private pendingPaths = new Set<string>();

  /** threadId -> changed paths pending this alert cycle. */
  private pendingAlertsByThread = new Map<string, Set<string>>();
  /** threadId -> armed alert timer. */
  private alertTimers = new Map<string, unknown>();

  constructor(deps: DocumentWatchServiceDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const vault = this.deps.app.vault;
    this.vaultRefs.push(vault.on('modify', (file) => this.onModify(file)));
    this.vaultRefs.push(vault.on('rename', (file, oldPath) => this.onRename(file, oldPath)));
    this.vaultRefs.push(vault.on('delete', (file) => this.onDelete(file)));
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    const vault = this.deps.app.vault;
    for (const ref of this.vaultRefs) vault.offref(ref);
    this.vaultRefs = [];

    this.clearTimer(this.coalesceTimer);
    this.coalesceTimer = null;
    this.pendingPaths.clear();

    for (const timer of this.alertTimers.values()) this.clearTimer(timer);
    this.alertTimers.clear();
    this.pendingAlertsByThread.clear();
  }

  /**
   * Snapshot the current stamp onto a newly created (or re-enabled) watch so
   * watching itself never counts as a change. Mutates the passed watch;
   * callers persist it themselves alongside the rest of the watch creation.
   */
  primeWatch(watch: WatchedDocument): void {
    const stamp = this.currentStamp(watch.path);
    if (stamp !== null) watch.lastStamp = stamp;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private currentStamp(path: string): string | null {
    const abstract = this.deps.app.vault.getAbstractFileByPath(path);
    if (!(abstract instanceof TFile)) return null;
    return `${abstract.stat.mtime}:${abstract.stat.size}`;
  }

  private basenameFor(path: string): string {
    const abstract = this.deps.app.vault.getAbstractFileByPath(path);
    if (abstract instanceof TFile) return abstract.basename;
    const name = path.split('/').pop() ?? path;
    return name.replace(/\.[^./]+$/, '');
  }

  private setTimeout(cb: () => void, ms: number): unknown {
    return (this.deps.setTimeoutFn ?? ((c, m) => setTimeout(c, m)))(cb, ms);
  }

  private clearTimer(timer: unknown): void {
    if (timer === null || timer === undefined) return;
    (this.deps.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(timer);
  }

  private onModify(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    this.scheduleCoalesce(file.path);
  }

  /** Coalesce a burst of modify events into a single debounced stamp check per path. */
  private scheduleCoalesce(path: string): void {
    this.pendingPaths.add(path);
    if (this.coalesceTimer !== null) return;
    this.coalesceTimer = this.setTimeout(() => {
      this.coalesceTimer = null;
      const paths = [...this.pendingPaths];
      this.pendingPaths.clear();
      for (const p of paths) this.checkPathForChanges(p);
    }, COALESCE_MS);
  }

  private checkPathForChanges(path: string): void {
    const newStamp = this.currentStamp(path);
    if (newStamp === null) return; // no longer resolvable; the delete handler covers removal
    for (const watch of this.deps.getWatches()) {
      if (!watch.enabled || watch.path !== path) continue;
      if (watch.lastStamp === newStamp) continue; // no-op resave guard
      this.queueAlert(watch.threadId, path);
    }
  }

  private queueAlert(threadId: string, path: string): void {
    const bucket = this.pendingAlertsByThread.get(threadId) ?? new Set<string>();
    bucket.add(path);
    this.pendingAlertsByThread.set(threadId, bucket);
    this.armAlertTimer(threadId);
  }

  private armAlertTimer(threadId: string): void {
    this.clearTimer(this.alertTimers.get(threadId));
    const timer = this.setTimeout(() => {
      this.alertTimers.delete(threadId);
      void this.flushThreadAlerts(threadId);
    }, ALERT_DEBOUNCE_MS);
    this.alertTimers.set(threadId, timer);
  }

  private async flushThreadAlerts(threadId: string): Promise<void> {
    const paths = Array.from(this.pendingAlertsByThread.get(threadId) ?? []);
    this.pendingAlertsByThread.delete(threadId);
    if (paths.length === 0) return;

    const thread = this.deps.getThread(threadId);
    if (!thread) {
      // Owning thread is gone (archived/deleted): drop this batch and prune
      // every watch it owns, not just the ones in this batch.
      const remaining = this.deps.getWatches().filter((w) => w.threadId !== threadId);
      try {
        await this.deps.saveWatches(remaining);
      } catch (err) {
        this.deps.onError?.(err);
      }
      return;
    }

    // Re-check against the live watch list: a path can have been unwatched,
    // disabled, or already reported deleted during the debounce window.
    const liveWatches = this.deps.getWatches().filter((w) => w.threadId === threadId && w.enabled);
    const livePaths = paths.filter((p) => liveWatches.some((w) => w.path === p));
    if (livePaths.length === 0) return;

    const lines = livePaths.map((p) => `- ${documentMention(this.basenameFor(p))}`);
    const message = [
      '📄 Watched document(s) changed:',
      ...lines,
      '',
      '(If you just made this edit yourself, no action needed.)',
    ].join('\n');

    try {
      await this.deps.sendMessage(threadId, message);
    } catch (err) {
      this.deps.onError?.(err);
      return; // don't advance stamps for an alert that never went out
    }

    const now = Date.now();
    const updated = this.deps.getWatches().map((w) => {
      if (w.threadId !== threadId || !livePaths.includes(w.path)) return w;
      const stamp = this.currentStamp(w.path);
      return { ...w, lastStamp: stamp ?? w.lastStamp, lastAlertedAt: now };
    });
    try {
      await this.deps.saveWatches(updated);
    } catch (err) {
      this.deps.onError?.(err);
    }
  }

  private onRename(file: TAbstractFile, oldPath: string): void {
    if (!(file instanceof TFile)) return;
    const watches = this.deps.getWatches();
    if (!watches.some((w) => w.path === oldPath)) return;
    const updated = watches.map((w) => (w.path === oldPath ? { ...w, path: file.path } : w));
    this.deps.saveWatches(updated).catch((err) => this.deps.onError?.(err));
  }

  private onDelete(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    const path = file.path;
    const affected = this.deps.getWatches().filter((w) => w.path === path);
    if (affected.length === 0) return;
    void this.handleDelete(path, affected);
  }

  private async handleDelete(path: string, affected: WatchedDocument[]): Promise<void> {
    const threadIds = new Set(affected.map((w) => w.threadId));
    for (const threadId of threadIds) {
      const thread = this.deps.getThread(threadId);
      if (!thread) continue; // dead thread: nothing to alert, row removal below still applies
      try {
        await this.deps.sendMessage(threadId, `🗑️ Watched document deleted: ${path}`);
      } catch (err) {
        this.deps.onError?.(err);
      }
    }
    const removedIds = new Set(affected.map((w) => w.id));
    const remaining = this.deps.getWatches().filter((w) => !removedIds.has(w.id));
    try {
      await this.deps.saveWatches(remaining);
    } catch (err) {
      this.deps.onError?.(err);
    }
  }
}

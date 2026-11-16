import { logger } from '../logger';
import type { ImageAttachment } from '../types';
import type { WebViewerFeedbackResult } from './contract';

/**
 * Coordinates Web Viewer element feedback delivery across multi-thread sessions:
 * - Immediate delivery (`manager.sendMessage`) when the destination thread is idle.
 * - 1-slot per-thread replacement queue (30m TTL) when the destination thread is busy
 *   or mid-startup, flushing automatically when the active turn finishes
 *   (`done` / `error` / `interrupted` / `run_state_settled`).
 * - Bounded idempotency cache (100 entries / 15m TTL) keyed by
 *   `JSON.stringify([selectionId, threadId, comment])` so duplicate retries return
 *   the prior accepted outcome without double-sending.
 */

export const DEFAULT_PENDING_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const DEFAULT_DEDUPE_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const DEFAULT_MAX_DEDUPE_ENTRIES = 100;

export interface CoordinatorThreadLike {
  readonly id: string;
  readonly title?: string;
  readonly background?: boolean;
  readonly status?: string;
}

export interface CoordinatorThreadManager {
  subscribe(listener: (threadId: string, event: { type: string }) => void): () => void;
  isRunning(threadId: string): boolean;
  getThread(threadId: string): CoordinatorThreadLike | undefined;
  sendMessage(threadId: string, userText: string, images?: ImageAttachment[]): Promise<void>;
}

export interface WebViewerSendCoordinatorOptions {
  readonly now?: () => number;
  readonly pendingTtlMs?: number;
  readonly dedupeTtlMs?: number;
  readonly maxDedupeEntries?: number;
  readonly onFlushed?: (threadId: string) => void;
  readonly onFlushError?: (threadId: string, error: unknown) => void;
}

export interface DeliverOrQueueInput {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly prompt: string;
  readonly images: readonly ImageAttachment[];
  readonly dedupeKey: string;
}

interface PendingFeedbackSlot {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly prompt: string;
  readonly images: readonly ImageAttachment[];
  readonly dedupeKey: string;
  readonly expiresAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface DedupeEntry {
  readonly result: WebViewerFeedbackResult;
  readonly expiresAt: number;
}

export function buildFeedbackDedupeKey(
  selectionId: string,
  threadId: string,
  comment: string,
): string {
  return JSON.stringify([selectionId, threadId, comment]);
}

export class WebViewerSendCoordinator {
  private readonly manager: CoordinatorThreadManager;
  private readonly now: () => number;
  private readonly pendingTtlMs: number;
  private readonly dedupeTtlMs: number;
  private readonly maxDedupeEntries: number;
  private readonly onFlushed?: (threadId: string) => void;
  private readonly onFlushError?: (threadId: string, error: unknown) => void;
  private readonly unsubscribe: () => void;

  private readonly pendingByThread = new Map<string, PendingFeedbackSlot>();
  private readonly flushingThreads = new Set<string>();
  private readonly dedupeCache = new Map<string, DedupeEntry>();
  private readonly inFlightDedupe = new Map<string, Promise<WebViewerFeedbackResult>>();
  private disposed = false;

  constructor(
    manager: CoordinatorThreadManager,
    options: WebViewerSendCoordinatorOptions = {},
  ) {
    this.manager = manager;
    this.now = options.now ?? (() => Date.now());
    this.pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    this.dedupeTtlMs = options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS;
    this.maxDedupeEntries = options.maxDedupeEntries ?? DEFAULT_MAX_DEDUPE_ENTRIES;
    this.onFlushed = options.onFlushed;
    this.onFlushError = options.onFlushError;
    this.unsubscribe = this.manager.subscribe((threadId, event) => {
      this.handleThreadEvent(threadId, event);
    });
  }

  get pendingCount(): number {
    return this.pendingByThread.size;
  }

  hasPending(threadId: string): boolean {
    const slot = this.pendingByThread.get(threadId);
    if (!slot) return false;
    if (this.now() > slot.expiresAt) {
      this.clearSlot(threadId);
      return false;
    }
    return true;
  }

  getCachedOutcome(dedupeKey: string): WebViewerFeedbackResult | undefined {
    this.pruneExpiredDedupe();
    return this.dedupeCache.get(dedupeKey)?.result;
  }

  async runIdempotent(
    dedupeKey: string,
    action: () => Promise<WebViewerFeedbackResult>,
  ): Promise<WebViewerFeedbackResult> {
    if (this.disposed) {
      return {
        status: 'rejected',
        reason: 'unavailable',
        message: 'Agent Threads feedback handler is disposed.',
      };
    }

    const cached = this.getCachedOutcome(dedupeKey);
    if (cached) return cached;

    const existingInFlight = this.inFlightDedupe.get(dedupeKey);
    if (existingInFlight) return existingInFlight;

    const promise = (async (): Promise<WebViewerFeedbackResult> => {
      try {
        const result = await action();
        if (!this.disposed && result.status === 'accepted') {
          this.recordAcceptedOutcome(dedupeKey, result);
        }
        return result;
      } catch (error) {
        logger.tagged(
          'warn',
          'web-viewer-feedback',
          'Failed to deliver element feedback to thread:',
          error,
        );
        return {
          status: 'rejected',
          reason: 'failed',
          message: 'Failed to deliver element feedback to thread.',
        };
      } finally {
        this.inFlightDedupe.delete(dedupeKey);
      }
    })();

    this.inFlightDedupe.set(dedupeKey, promise);
    return promise;
  }

  async deliverOrQueue(
    input: DeliverOrQueueInput,
    options?: { readonly skipDedupe?: boolean },
  ): Promise<WebViewerFeedbackResult> {
    if (options?.skipDedupe) {
      return this.deliverOrQueueInternal(input);
    }
    return this.runIdempotent(input.dedupeKey, () => this.deliverOrQueueInternal(input));
  }

  private async deliverOrQueueInternal(
    input: DeliverOrQueueInput,
  ): Promise<WebViewerFeedbackResult> {
    if (this.disposed) {
      return {
        status: 'rejected',
        reason: 'unavailable',
        message: 'Agent Threads feedback handler is disposed.',
      };
    }

    const thread = this.manager.getThread(input.threadId);
    if (!thread || thread.background || thread.status === 'archived') {
      return {
        status: 'rejected',
        reason: 'unavailable',
        message: 'Selected thread is no longer open.',
      };
    }

    if (this.manager.isRunning(input.threadId) || this.flushingThreads.has(input.threadId)) {
      this.enqueueReplacementSlot(input);
      return {
        status: 'accepted',
        delivery: 'queued',
        threadId: input.threadId,
        message: 'Thread is busy — queued for next turn',
      };
    }

    this.clearSlot(input.threadId);
    const attachments = input.images.length > 0 ? [...input.images] : undefined;
    this.flushingThreads.add(input.threadId);
    try {
      await this.manager.sendMessage(input.threadId, input.prompt, attachments);
      this.safeNotifyFlushed(input.threadId);
      return {
        status: 'accepted',
        delivery: 'sent',
        threadId: input.threadId,
        message: `Sent to "${input.threadTitle}"`,
      };
    } finally {
      this.flushingThreads.delete(input.threadId);
      if (
        !this.disposed &&
        this.pendingByThread.has(input.threadId) &&
        !this.manager.isRunning(input.threadId)
      ) {
        void this.flushQueued(input.threadId);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.pendingByThread.values()) {
      clearTimeout(slot.timer);
    }
    this.pendingByThread.clear();
    this.flushingThreads.clear();
    this.dedupeCache.clear();
    this.inFlightDedupe.clear();
    this.unsubscribe();
  }

  private enqueueReplacementSlot(input: DeliverOrQueueInput): void {
    this.clearSlot(input.threadId);
    const expiresAt = this.now() + this.pendingTtlMs;
    const timer = setTimeout(() => {
      const current = this.pendingByThread.get(input.threadId);
      if (current && current.dedupeKey === input.dedupeKey) {
        this.pendingByThread.delete(input.threadId);
      }
    }, this.pendingTtlMs);
    (timer as { unref?: () => void }).unref?.();

    this.pendingByThread.set(input.threadId, {
      threadId: input.threadId,
      threadTitle: input.threadTitle,
      prompt: input.prompt,
      images: [...input.images],
      dedupeKey: input.dedupeKey,
      expiresAt,
      timer,
    });
  }

  private clearSlot(threadId: string): void {
    const existing = this.pendingByThread.get(threadId);
    if (existing) {
      clearTimeout(existing.timer);
      this.pendingByThread.delete(threadId);
    }
  }

  private handleThreadEvent(threadId: string, event: { type: string }): void {
    if (this.disposed || !threadId) return;

    if (event.type === 'thread_deleted') {
      this.clearSlot(threadId);
      return;
    }

    if (
      event.type === 'done' ||
      event.type === 'error' ||
      event.type === 'interrupted' ||
      event.type === 'run_state_settled'
    ) {
      if (!this.pendingByThread.has(threadId)) return;
      if (!this.manager.isRunning(threadId)) {
        void this.flushQueued(threadId);
      } else {
        // ThreadSession flips _turnInFlight = false right after onDone/onError returns.
        queueMicrotask(() => {
          if (
            !this.disposed &&
            this.pendingByThread.has(threadId) &&
            !this.manager.isRunning(threadId)
          ) {
            void this.flushQueued(threadId);
          }
        });
      }
    }
  }

  private async flushQueued(threadId: string): Promise<void> {
    if (this.disposed || this.flushingThreads.has(threadId)) return;
    const slot = this.pendingByThread.get(threadId);
    if (!slot) return;

    if (this.now() > slot.expiresAt) {
      this.clearSlot(threadId);
      return;
    }

    const thread = this.manager.getThread(threadId);
    if (!thread || thread.background || thread.status === 'archived') {
      this.clearSlot(threadId);
      return;
    }

    if (this.manager.isRunning(threadId)) {
      return;
    }

    clearTimeout(slot.timer);
    this.pendingByThread.delete(threadId);
    this.flushingThreads.add(threadId);
    try {
      const attachments = slot.images.length > 0 ? [...slot.images] : undefined;
      await this.manager.sendMessage(threadId, slot.prompt, attachments);
      this.safeNotifyFlushed(threadId);
    } catch (error) {
      try {
        this.onFlushError?.(threadId, error);
      } catch {
        // ignore callback error
      }
    } finally {
      this.flushingThreads.delete(threadId);
      if (
        !this.disposed &&
        this.pendingByThread.has(threadId) &&
        !this.manager.isRunning(threadId)
      ) {
        void this.flushQueued(threadId);
      }
    }
  }

  private safeNotifyFlushed(threadId: string): void {
    try {
      this.onFlushed?.(threadId);
    } catch {
      // ignore persistence notification error
    }
  }

  private pruneExpiredDedupe(): void {
    const now = this.now();
    for (const [key, entry] of this.dedupeCache) {
      if (entry.expiresAt <= now) {
        this.dedupeCache.delete(key);
      }
    }
  }

  private recordAcceptedOutcome(dedupeKey: string, result: WebViewerFeedbackResult): void {
    this.pruneExpiredDedupe();
    if (this.dedupeCache.has(dedupeKey)) {
      this.dedupeCache.delete(dedupeKey);
    }
    while (this.dedupeCache.size >= this.maxDedupeEntries) {
      const oldestKey = this.dedupeCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.dedupeCache.delete(oldestKey);
    }
    this.dedupeCache.set(dedupeKey, {
      result,
      expiresAt: this.now() + this.dedupeTtlMs,
    });
  }
}

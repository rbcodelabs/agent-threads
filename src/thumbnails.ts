import type { AttachmentStore } from './host/AttachmentStore';

/**
 * 160px-wide WebP thumbnails for the Agent Board gallery.
 *
 * The board must not hold or decode full-size screenshots for every thread, so
 * each externalized tool-result image gets a small sidecar
 * (`<messageId>-<index>.thumb.webp`, see buildThumbPath). Sidecars are written
 * at capture time and lazily backfilled for older images when a gallery card
 * becomes visible. Generation happens in the renderer (desktop only) with
 * createImageBitmap + OffscreenCanvas; where those are missing, or anything
 * fails, the caller falls back to the full image and a single line is logged.
 */

export const THUMB_WIDTH = 160;
/** Backfill must never stall the app on a big vault. */
const MAX_CONCURRENCY = 2;

export interface ThumbSource {
  mediaType: string;
  /** Inline bytes, when still in memory. */
  base64?: string;
  /** A fetchable URL for the full-size file (e.g. adapter.getResourcePath). */
  url?: string;
}

/** Core never touches canvas APIs: a host without a generator simply gets no thumbnails. */
export const NULL_THUMBNAIL_GENERATOR: ThumbnailGenerator = async () => null;

/** Produces the base64 of a 160px WebP for `src`, or null when it cannot. Injectable for tests. */
export type ThumbnailGenerator = (src: ThumbSource) => Promise<string | null>;

export interface ThumbnailJob {
  threadId: string;
  messageId: string;
  index: number;
  source: ThumbSource;
  /** Private threads are never read or thumbnailed. */
  isPrivate?: boolean;
}

export interface ThumbnailServiceDeps {
  generate: ThumbnailGenerator;
  store: AttachmentStore;
  log: (message: string, detail?: string) => void;
}

/**
 * Bounded (concurrency 2), de-duplicated thumbnail generation + sidecar write.
 * `ensure` never throws: it resolves to the sidecar path or null.
 */
export class ThumbnailService {
  private inFlight = new Map<string, Promise<string | null>>();
  /** Images whose generation already failed this session: not retried every time a card scrolls into view. */
  private failed = new Set<string>();
  private waiting: Array<() => void> = [];
  private active = 0;
  private loggedFailure = false;

  constructor(private deps: ThumbnailServiceDeps) {}

  ensure(job: ThumbnailJob): Promise<string | null> {
    if (job.isPrivate) return Promise.resolve(null);
    if (!this.deps.store.isDesktop() || typeof this.deps.store.writeThumbnail !== 'function') {
      return Promise.resolve(null);
    }
    const key = `${job.threadId}/${job.messageId}-${job.index}`;
    if (this.failed.has(key)) return Promise.resolve(null);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = this.withSlot(() => this.run(job, key)).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  private async run(job: ThumbnailJob, key: string): Promise<string | null> {
    try {
      const base64 = await this.deps.generate(job.source);
      if (!base64) throw new Error('thumbnail generation unavailable or produced no data');
      const path = await this.deps.store.writeThumbnail!(job.threadId, job.messageId, job.index, base64);
      if (!path) throw new Error('thumbnail write failed');
      return path;
    } catch (err) {
      this.failed.add(key);
      if (!this.loggedFailure) {
        this.loggedFailure = true;
        this.deps.log('[ClaudeThreads] gallery thumbnails unavailable; falling back to full images:', String(err));
      }
      return null;
    }
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENCY) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

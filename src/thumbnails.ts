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
const THUMB_QUALITY = 0.8;
/** Backfill must never stall the app on a big vault. */
const MAX_CONCURRENCY = 2;

export interface ThumbSource {
  mediaType: string;
  /** Inline bytes, when still in memory. */
  base64?: string;
  /** A fetchable URL for the full-size file (e.g. adapter.getResourcePath). */
  url?: string;
}

/** Produces the base64 of a 160px WebP for `src`, or null when it cannot. Injectable for tests. */
export type ThumbnailGenerator = (src: ThumbSource) => Promise<string | null>;

function base64ToBlob(base64: string, mediaType: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mediaType });
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function loadSourceBlob(src: ThumbSource): Promise<Blob | null> {
  if (src.base64) return base64ToBlob(src.base64, src.mediaType);
  if (src.url) {
    const res = await fetch(src.url);
    if (!res.ok) return null;
    return res.blob();
  }
  return null;
}

/** Real generator. Guarded: resolves null where the canvas APIs are unavailable. */
export const defaultThumbnailGenerator: ThumbnailGenerator = async (src) => {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
  const blob = await loadSourceBlob(src);
  if (!blob) return null;
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width <= 0 || bitmap.height <= 0) return null;
    const width = Math.min(THUMB_WIDTH, bitmap.width);
    const height = Math.max(1, Math.round((bitmap.height * width) / bitmap.width));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const out = await canvas.convertToBlob({ type: 'image/webp', quality: THUMB_QUALITY });
    // Some engines silently fall back to PNG; never write a mislabelled .webp.
    if (out.type !== 'image/webp') return null;
    return bytesToBase64(new Uint8Array(await out.arrayBuffer()));
  } finally {
    bitmap.close?.();
  }
};

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

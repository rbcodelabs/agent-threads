/**
 * Inline images in a remote thread's chat: `![alt](/abs/path/on/the/daemon.png)`.
 *
 * The path is on the daemon's machine, so the browser cannot load it. After the markdown is rendered, each such
 * `<img>` is emptied (so nothing requests the path from this app) and filled in lazily with the bytes the daemon
 * returns for `file.read`, as a data URL. Anything that cannot be shown becomes an "Image unavailable" note.
 * http(s) / data / blob sources and threads that are not remote are never touched.
 *
 * DOM-dependent, so it is imported by the views only (never by core).
 */
import type { FileReadReply } from '../protocol';
import { DaemonClient, fetchRemoteImage } from './DaemonClient';

export const FILE_READ_CAPABILITY = 'file.read';
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)$/i;
export const IMAGE_UNAVAILABLE_TEXT = 'Image unavailable';

/**
 * The daemon-side absolute path an `<img src>` names, or undefined when the source is something else (a URL, a data
 * URI, a relative path, a Windows path) and so keeps its current behaviour. marked percent-encodes `src`; decoded here.
 */
export function remoteImagePathFromSrc(src: string | null | undefined): string | undefined {
  if (!src || !src.startsWith('/') || src.startsWith('//')) return undefined;
  let path: string;
  try { path = decodeURI(src); } catch { return undefined; }
  if (path.includes('\0') || path.includes('?') || path.includes('#')) return undefined;
  return IMAGE_EXTENSION.test(path) ? path : undefined;
}

/** Decoded images kept by key, evicting the least recently used once the total exceeds `maxChars` (data URLs are big). */
export class RemoteImageCache {
  private readonly entries = new Map<string, string>();
  private chars = 0;
  private readonly inflight = new Map<string, Promise<string | undefined>>();

  constructor(private readonly maxChars = 40_000_000) {}

  get(key: string): string | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  private set(key: string, value: string): void {
    if (value.length > this.maxChars) return;
    const old = this.entries.get(key);
    if (old !== undefined) { this.chars -= old.length; this.entries.delete(key); }
    this.entries.set(key, value);
    this.chars += value.length;
    for (const [k, v] of this.entries) {
      if (this.chars <= this.maxChars) break;
      this.entries.delete(k);
      this.chars -= v.length;
    }
  }

  /**
   * One load per key at a time. A found image is cached; a refusal or a connection failure is not (the file may
   * appear later, the daemon may come back), and a rejection is passed to every waiter.
   */
  load(key: string, fetcher: () => Promise<string | undefined>): Promise<string | undefined> {
    const cached = this.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = fetcher().then((url) => { if (url !== undefined) this.set(key, url); return url; }).finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, p);
    return p;
  }
}

export interface RemoteImageClients {
  clientFor(daemonId: string): DaemonClient | undefined;
}

export const toDataUrl = (reply: FileReadReply): string => `data:${reply.mediaType};base64,${reply.base64}`;

/** `(path) => data URL` for one daemon; undefined = the image cannot be shown (old daemon, refused, missing). */
export function createRemoteImageLoader(
  clients: RemoteImageClients,
  cache: RemoteImageCache,
  daemonId: string,
): (path: string) => Promise<string | undefined> {
  return (path) => cache.load(`${daemonId}\0${path}`, async () => {
    const client = clients.clientFor(daemonId);
    if (!client) return undefined;
    const caps = client.daemonInfo?.capabilities;
    // Known to lack the command: skip the round trip. Unknown (not connected yet): try, a failure just shows the note.
    if (caps && !caps.includes(FILE_READ_CAPABILITY)) return undefined;
    const reply = await fetchRemoteImage(client, path);
    return reply ? toDataUrl(reply) : undefined;
  });
}

function showUnavailable(img: HTMLImageElement): void {
  const note = img.ownerDocument.createElement('span');
  note.className = 'ct-remote-img-unavailable';
  note.textContent = IMAGE_UNAVAILABLE_TEXT;
  const alt = img.getAttribute('alt');
  if (alt) note.title = alt;
  img.replaceWith(note);
}

export interface HydrateRemoteImagesOptions {
  load: (path: string) => Promise<string | undefined>;
  /** Aborted when the message is re-rendered or the view closes: nothing is written to the DOM afterwards. */
  signal: AbortSignal;
  /** Test seam; defaults to the global IntersectionObserver (loading starts at once when there is none). */
  observerFactory?: (onVisible: (el: Element) => void) => LazyObserver | undefined;
}

/** Returns the number of images taken over. */
export function hydrateRemoteImages(root: ParentNode, options: HydrateRemoteImagesOptions): number {
  const { load, signal } = options;
  const targets: Array<{ img: HTMLImageElement; path: string }> = [];
  root.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
    const path = remoteImagePathFromSrc(img.getAttribute('src'));
    if (path === undefined) return;
    // Emptied before anything can fetch it: the path means nothing to this app's own origin.
    img.removeAttribute('src');
    img.classList.add('ct-remote-img', 'is-loading');
    targets.push({ img, path });
  });
  if (targets.length === 0) return 0;

  const start = (img: HTMLImageElement, path: string): void => {
    if (signal.aborted) return;
    load(path).then(
      (url) => {
        if (signal.aborted) return;
        if (url === undefined) { showUnavailable(img); return; }
        img.classList.remove('is-loading');
        img.setAttribute('src', url);
      },
      () => { if (!signal.aborted) showUnavailable(img); },
    );
  };

  const byEl = new Map<Element, string>(targets.map((t) => [t.img, t.path]));
  const factory = options.observerFactory ?? defaultObserverFactory;
  const observer: LazyObserver | undefined = factory((el) => {
    const path = byEl.get(el);
    if (path === undefined) return;
    byEl.delete(el);
    observer?.unobserve?.(el);
    start(el as HTMLImageElement, path);
  });
  if (!observer) {
    for (const t of targets) start(t.img, t.path);
    return targets.length;
  }
  signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  for (const t of targets) observer.observe(t.img);
  return targets.length;
}

export type LazyObserver = { observe(el: Element): void; disconnect(): void; unobserve?(el: Element): void };

function defaultObserverFactory(onVisible: (el: Element) => void): LazyObserver | undefined {
  if (typeof IntersectionObserver === 'undefined') return undefined;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) onVisible(e.target);
  }, { rootMargin: '200px' });
  return io;
}

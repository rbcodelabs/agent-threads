import { describe, it, expect, vi } from 'vitest';
import {
  ThumbnailService,
  THUMB_WIDTH,
  type ThumbnailGenerator,
} from '../../src/thumbnails';
import { canvasThumbnailGenerator as defaultThumbnailGenerator } from '../../src/thumbnailGenerator';
import { buildAttachmentPath, buildThumbPath, serializeThreadForSave } from '../../src/imageExternalization';
import type { AttachmentStore } from '../../src/host/AttachmentStore';
import type { Thread } from '../../src/types';

function makeStore(over: Partial<AttachmentStore> = {}): AttachmentStore & { thumbs: string[] } {
  const thumbs: string[] = [];
  return {
    thumbs,
    isDesktop: () => true,
    write: async () => null,
    removeThreadDir: async () => undefined,
    writeThumbnail: async (t, m, i) => {
      const p = buildThumbPath('Claude', t, m, i);
      thumbs.push(p);
      return p;
    },
    ...over,
  } as AttachmentStore & { thumbs: string[] };
}

const job = (over = {}) => ({
  threadId: 't1', messageId: 'm1', index: 0, source: { mediaType: 'image/png', base64: 'AAAA' }, ...over,
});

describe('buildThumbPath', () => {
  it('is a .thumb.webp sidecar next to the externalized image', () => {
    const full = buildAttachmentPath('Claude', 't1', 'm1', 2, 'image/png');
    const thumb = buildThumbPath('Claude', 't1', 'm1', 2);
    expect(full).toBe('Claude/attachments/t1/m1-2.png');
    expect(thumb).toBe('Claude/attachments/t1/m1-2.thumb.webp');
    expect(thumb.slice(0, thumb.lastIndexOf('/'))).toBe(full.slice(0, full.lastIndexOf('/')));
  });
  it('defaults the vault folder the same way the full-size path does', () => {
    expect(buildThumbPath('', 't', 'm', 0).split('/attachments/')[0]).toBe(
      buildAttachmentPath('', 't', 'm', 0, 'image/png').split('/attachments/')[0],
    );
  });
});

describe('serializeThreadForSave with thumbPath', () => {
  it('keeps thumbPath and path, strips the inline data', () => {
    const thread = {
      id: 't1', messages: [{ id: 'm1', role: 'assistant', content: '', timestamp: 0,
        toolResultImages: [{ mediaType: 'image/png', data: 'BIG', path: 'p.png', thumbPath: 'p.thumb.webp' }] }],
    } as unknown as Thread;
    const out = serializeThreadForSave(thread);
    expect(out.messages[0].toolResultImages![0]).toEqual({ mediaType: 'image/png', path: 'p.png', thumbPath: 'p.thumb.webp' });
    // live object untouched
    expect(thread.messages[0].toolResultImages![0].data).toBe('BIG');
  });
  it('keeps a thumbPath on an image that has no data to strip (same reference when unchanged)', () => {
    const thread = {
      id: 't1', messages: [{ id: 'm1', role: 'assistant', content: '', timestamp: 0,
        toolResultImages: [{ mediaType: 'image/png', path: 'p.png', thumbPath: 'p.thumb.webp' }] }],
    } as unknown as Thread;
    expect(serializeThreadForSave(thread)).toBe(thread);
  });
});

describe('ThumbnailService', () => {
  it('generates and writes a sidecar, returning its path', async () => {
    const gen: ThumbnailGenerator = vi.fn(async () => 'WEBPB64');
    const store = makeStore();
    const svc = new ThumbnailService({ generate: gen, store, log: vi.fn() });
    expect(await svc.ensure(job())).toBe('Claude/attachments/t1/m1-0.thumb.webp');
    expect(gen).toHaveBeenCalledTimes(1);
    expect(store.thumbs).toHaveLength(1);
  });

  it('does nothing off desktop', async () => {
    const gen = vi.fn(async () => 'X');
    const svc = new ThumbnailService({ generate: gen, store: makeStore({ isDesktop: () => false }), log: vi.fn() });
    expect(await svc.ensure(job())).toBeNull();
    expect(gen).not.toHaveBeenCalled();
  });

  it('never touches private threads', async () => {
    const gen = vi.fn(async () => 'X');
    const svc = new ThumbnailService({ generate: gen, store: makeStore(), log: vi.fn() });
    expect(await svc.ensure(job({ isPrivate: true }))).toBeNull();
    expect(gen).not.toHaveBeenCalled();
  });

  it('returns null when the store cannot write thumbnails', async () => {
    const store = makeStore();
    delete (store as { writeThumbnail?: unknown }).writeThumbnail;
    const svc = new ThumbnailService({ generate: async () => 'X', store, log: vi.fn() });
    expect(await svc.ensure(job())).toBeNull();
  });

  it('caps concurrency at 2', async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const gen: ThumbnailGenerator = () => new Promise((resolve) => {
      active++; peak = Math.max(peak, active);
      releases.push(() => { active--; resolve('X'); });
    });
    const svc = new ThumbnailService({ generate: gen, store: makeStore(), log: vi.fn() });
    const all = Promise.all([0, 1, 2, 3, 4].map((i) => svc.ensure(job({ index: i }))));
    await new Promise((r) => setTimeout(r, 0));
    expect(active).toBe(2);
    while (releases.length) { releases.shift()!(); await new Promise((r) => setTimeout(r, 0)); }
    await all;
    expect(peak).toBe(2);
  });

  it('coalesces duplicate in-flight requests for the same image', async () => {
    const gen = vi.fn(async () => 'X');
    const svc = new ThumbnailService({ generate: gen, store: makeStore(), log: vi.fn() });
    const [a, b] = await Promise.all([svc.ensure(job()), svc.ensure(job())]);
    expect(a).toBe(b);
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it('falls back (null) on failure and logs only once across failures', async () => {
    const log = vi.fn();
    const svc = new ThumbnailService({ generate: async () => { throw new Error('boom'); }, store: makeStore(), log });
    expect(await svc.ensure(job({ index: 0 }))).toBeNull();
    expect(await svc.ensure(job({ index: 1 }))).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('treats a generator returning null as a failure, not a write', async () => {
    const store = makeStore();
    const svc = new ThumbnailService({ generate: async () => null, store, log: vi.fn() });
    expect(await svc.ensure(job())).toBeNull();
    expect(store.thumbs).toHaveLength(0);
  });

  it('does not retry an image whose generation already failed', async () => {
    const gen = vi.fn(async () => null);
    const svc = new ThumbnailService({ generate: gen, store: makeStore(), log: vi.fn() });
    await svc.ensure(job());
    await svc.ensure(job());
    expect(gen).toHaveBeenCalledTimes(1);
  });
});

describe('defaultThumbnailGenerator', () => {
  it('is 160px wide by contract', () => {
    expect(THUMB_WIDTH).toBe(160);
  });
  it('returns null (no throw) where OffscreenCanvas / createImageBitmap are unavailable', async () => {
    expect(await defaultThumbnailGenerator({ mediaType: 'image/png', base64: 'AAAA' })).toBeNull();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { AttachmentStore } from '../../src/host/AttachmentStore';
import type { ChatMessage, Thread } from '../../src/types';

function setup(opts: { desktop?: boolean; priv?: boolean; gen?: () => Promise<string | null> } = {}) {
  const writes: string[] = [];
  const store: AttachmentStore = {
    isDesktop: () => opts.desktop ?? true,
    write: async (t, m, i) => { const p = `att/${t}/${m}-${i}.png`; writes.push(p); return p; },
    writeThumbnail: async (t, m, i) => { const p = `att/${t}/${m}-${i}.thumb.webp`; writes.push(p); return p; },
    removeThreadDir: async () => undefined,
  };
  const gen = vi.fn(opts.gen ?? (async () => 'WEBP'));
  const manager = new ThreadManager({ ...DEFAULT_SETTINGS } as never, store, gen);
  const msg = { id: 'm1', role: 'assistant', content: '', timestamp: 0,
    toolResultImages: [{ mediaType: 'image/png', data: 'AAAA' }] } as ChatMessage;
  const thread = { id: 't1', title: 'T', messages: [msg], createdAt: 0, updatedAt: 0, status: 'idle', private: opts.priv } as unknown as Thread;
  manager.loadThreads([thread]);
  return { manager, msg, gen, writes };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const externalize = (m: ThreadManager, id: string, msg: ChatMessage) =>
  (m as unknown as { externalizeMessageImages(t: string, msg: ChatMessage): void }).externalizeMessageImages(id, msg);

describe('ThreadManager thumbnails', () => {
  it('writes a sidecar after the full image and records thumbPath', async () => {
    const { manager, msg, writes } = setup();
    externalize(manager, 't1', msg);
    await flush(); await flush();
    expect(msg.toolResultImages![0].path).toBe('att/t1/m1-0.png');
    expect(msg.toolResultImages![0].thumbPath).toBe('att/t1/m1-0.thumb.webp');
    expect(writes).toEqual(['att/t1/m1-0.png', 'att/t1/m1-0.thumb.webp']);
  });

  it('skips private threads entirely', async () => {
    const { manager, msg, gen, writes } = setup({ priv: true });
    externalize(manager, 't1', msg);
    await flush();
    expect(gen).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(await manager.ensureImageThumbnail('t1', 'm1', 0, 'app://x')).toBeNull();
  });

  it('skips off desktop', async () => {
    const { manager, msg, gen } = setup({ desktop: false });
    externalize(manager, 't1', msg);
    expect(await manager.ensureImageThumbnail('t1', 'm1', 0, 'app://x')).toBeNull();
    expect(gen).not.toHaveBeenCalled();
  });

  it('keeps the image when thumbnail generation fails', async () => {
    const { manager, msg } = setup({ gen: async () => { throw new Error('nope'); } });
    externalize(manager, 't1', msg);
    await flush(); await flush();
    expect(msg.toolResultImages![0].path).toBe('att/t1/m1-0.png');
    expect(msg.toolResultImages![0].thumbPath).toBeUndefined();
  });

  it('lazy backfill generates from the resource URL for a path-only image and is idempotent', async () => {
    const { manager, msg, gen } = setup();
    msg.toolResultImages = [{ mediaType: 'image/png', path: 'att/t1/m1-0.png' }];
    const tp = await manager.ensureImageThumbnail('t1', 'm1', 0, 'app://full.png');
    expect(tp).toBe('att/t1/m1-0.thumb.webp');
    expect(gen).toHaveBeenCalledWith(expect.objectContaining({ url: 'app://full.png', mediaType: 'image/png' }));
    expect(msg.toolResultImages[0].thumbPath).toBe(tp);
    await manager.ensureImageThumbnail('t1', 'm1', 0, 'app://full.png');
    expect(gen).toHaveBeenCalledTimes(1);
  });
});

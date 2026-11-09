import { describe, it, expect } from 'vitest';
import { buildGalleryImages, GALLERY_IMAGE_CAP } from '../../src/galleryImages';
import type { ChatMessage, ToolCallRecord } from '../../src/types';

type TR = NonNullable<ChatMessage['toolResultImages']>;

function msg(id: string, over: Partial<ChatMessage> & { tri?: TR } = {}): ChatMessage {
  const { tri, ...rest } = over;
  return { id, role: 'assistant', content: '', timestamp: 0, toolResultImages: tri, ...rest } as ChatMessage;
}

const shot = (status: ToolCallRecord['status'] = 'success'): ToolCallRecord =>
  ({ name: 'mcp__claude_threads__browser_screenshot', summary: '', status }) as ToolCallRecord;

describe('buildGalleryImages', () => {
  it('returns newest first across messages', () => {
    const out = buildGalleryImages({
      messages: [
        msg('m1', { tri: [{ mediaType: 'image/png', path: 'a/1.png' }] }),
        msg('m2', { tri: [{ mediaType: 'image/png', path: 'a/2.png' }, { mediaType: 'image/png', path: 'a/3.png' }] }),
      ],
    });
    expect(out.map((i) => i.path)).toEqual(['a/3.png', 'a/2.png', 'a/1.png']);
    expect(out[0]).toMatchObject({ messageId: 'm2', index: 1 });
  });

  it('puts pending (not yet attached) images first, as the newest', () => {
    const out = buildGalleryImages({
      messages: [msg('m1', { tri: [{ mediaType: 'image/png', path: 'a/1.png' }] })],
      pending: [{ mediaType: 'image/png', data: 'PENDINGDATA' }],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ data: 'PENDINGDATA', pending: true });
    expect(out[1].path).toBe('a/1.png');
  });

  it('caps at 50 keeping the newest', () => {
    const tri: TR = Array.from({ length: 60 }, (_, i) => ({ mediaType: 'image/png', path: `p/${i}.png` }));
    const out = buildGalleryImages({ messages: [msg('m1', { tri })] });
    expect(GALLERY_IMAGE_CAP).toBe(50);
    expect(out).toHaveLength(50);
    expect(out[0].path).toBe('p/59.png');
    expect(out[49].path).toBe('p/10.png');
  });

  it('dedupes images that share a path or identical inline data', () => {
    const out = buildGalleryImages({
      messages: [
        msg('m1', { tri: [{ mediaType: 'image/png', path: 'a/1.png' }] }),
        msg('m2', { tri: [{ mediaType: 'image/png', path: 'a/1.png' }, { mediaType: 'image/png', data: 'XYZ' }] }),
      ],
      pending: [{ mediaType: 'image/png', data: 'XYZ' }],
    });
    expect(out).toHaveLength(2);
  });

  it('excludes user-attached images and ignores messages without tool images', () => {
    const out = buildGalleryImages({
      messages: [
        msg('u1', { role: 'user', images: [{ base64: 'AAA', mediaType: 'image/png', name: 'x.png' }] }),
        msg('m1', { content: 'text only' }),
      ],
    });
    expect(out).toEqual([]);
  });

  it('returns nothing for private threads, even with pending images', () => {
    const out = buildGalleryImages({
      isPrivate: true,
      messages: [msg('m1', { tri: [{ mediaType: 'image/png', path: 'a/1.png' }] })],
      pending: [{ mediaType: 'image/png', data: 'D' }],
    });
    expect(out).toEqual([]);
  });

  it('badges an image paired with a completed browser_screenshot as Browser, others as Image', () => {
    const out = buildGalleryImages({
      messages: [
        msg('m1', { toolCalls: [shot()] }),
        msg('m2', { content: 'done', tri: [{ mediaType: 'image/png', path: 'a/shot.png' }, { mediaType: 'image/png', path: 'a/other.png' }] }),
      ],
    });
    // FIFO pairing: the first image on m2 belongs to the screenshot call, the second is a plain image.
    const bySrc = Object.fromEntries(out.map((i) => [i.path, i.source]));
    expect(bySrc['a/shot.png']).toBe('Browser');
    expect(bySrc['a/other.png']).toBe('Image');
  });

  it('does not badge as Browser when the screenshot call failed', () => {
    const out = buildGalleryImages({
      messages: [msg('m1', { toolCalls: [shot('error')] }), msg('m2', { tri: [{ mediaType: 'image/png', path: 'a/x.png' }] })],
    });
    expect(out[0].source).toBe('Image');
  });

  it('pairs pending images with an outstanding browser_screenshot', () => {
    const out = buildGalleryImages({
      messages: [msg('m1', { toolCalls: [shot()] })],
      pending: [{ mediaType: 'image/png', data: 'LIVE1' }],
    });
    expect(out[0]).toMatchObject({ pending: true, source: 'Browser' });
  });

  it('carries path and thumbPath through for lazy loading', () => {
    const out = buildGalleryImages({
      messages: [msg('m1', { tri: [{ mediaType: 'image/png', path: 'a/1.png', thumbPath: 'a/1.thumb.webp' }] })],
    });
    expect(out[0]).toMatchObject({ path: 'a/1.png', thumbPath: 'a/1.thumb.webp', key: 'm1-0' });
  });
});

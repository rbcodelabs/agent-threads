import type { ChatMessage } from './types';
import { assignBrowserScreenshots, type BrowserRowInput } from './browserSession';

/**
 * Pure image selection for the Agent Board's Gallery mode.
 *
 * Only tool-result images (what the agent produced) are included: user uploads
 * (`ChatMessage.images`) are excluded by design, the browser live frame is never
 * part of a message so it cannot appear, and private threads yield nothing so
 * their images are never read or turned into thumbnails.
 */

/** Newest images kept per thread. Older ones are ignored by the gallery only; nothing is deleted. */
export const GALLERY_IMAGE_CAP = 50;

export type GalleryImageSource = 'Browser' | 'Image';

export interface GalleryImage {
  /** Stable per image: `<messageId>-<index>`, or `pending-<index>` for unattached images. */
  key: string;
  messageId: string;
  index: number;
  mediaType: string;
  /** Vault-relative externalized file. Absent for inline-only images. */
  path?: string;
  /** Vault-relative 160px WebP sidecar, when generated. */
  thumbPath?: string;
  /** Inline base64, when still in memory. */
  data?: string;
  source: GalleryImageSource;
  /** Message timestamp; pending images use the thread's last activity (see callers). */
  timestamp?: number;
  /** True when the image has not yet been attached to a persisted message. */
  pending?: boolean;
}

export interface GalleryImageInput {
  messages: readonly ChatMessage[];
  /** Images that have arrived but will land on the NEXT assistant message. */
  pending?: ReadonlyArray<{ mediaType: string; data: string }>;
  isPrivate?: boolean;
}

/** Cheap identity for inline data so identical bytes are not listed twice. */
function dataIdentity(data: string): string {
  return `${data.length}:${data.slice(0, 48)}:${data.slice(-48)}`;
}

/**
 * Newest-first list of the images a thread's gallery card can step through,
 * capped at {@link GALLERY_IMAGE_CAP}. Source badge: 'Browser' when the image
 * pairs (FIFO, via assignBrowserScreenshots) with a completed browser_screenshot
 * call, otherwise 'Image'.
 */
export function buildGalleryImages(input: GalleryImageInput): GalleryImage[] {
  if (input.isPrivate) return [];
  const pending = input.pending ?? [];

  // Pending images belong to the next assistant message: model them as one
  // synthetic trailing row so they pair with any still-outstanding screenshot.
  const rows: BrowserRowInput[] = input.messages.map((m) => ({
    id: m.id,
    role: m.role,
    hasText: m.role === 'user' || m.content.trim().length > 0,
    tools: m.toolCalls ?? [],
    imageCount: m.toolResultImages?.length ?? 0,
  }));
  rows.push({ id: '__pending__', role: 'assistant', hasText: false, tools: [], imageCount: pending.length });
  const { claimed } = assignBrowserScreenshots(rows);

  const chronological: GalleryImage[] = [];
  input.messages.forEach((m, rowIndex) => {
    m.toolResultImages?.forEach((img, index) => {
      chronological.push({
        key: `${m.id}-${index}`,
        messageId: m.id,
        index,
        mediaType: img.mediaType,
        path: img.path,
        thumbPath: img.thumbPath,
        data: img.data,
        source: claimed.get(rowIndex)?.has(index) ? 'Browser' : 'Image',
        timestamp: m.timestamp,
      });
    });
  });
  const pendingRow = input.messages.length;
  pending.forEach((img, index) => {
    chronological.push({
      key: `pending-${index}`,
      messageId: '',
      index,
      mediaType: img.mediaType,
      data: img.data,
      source: claimed.get(pendingRow)?.has(index) ? 'Browser' : 'Image',
      pending: true,
    });
  });

  const seen = new Set<string>();
  const out: GalleryImage[] = [];
  for (let i = chronological.length - 1; i >= 0 && out.length < GALLERY_IMAGE_CAP; i--) {
    const img = chronological[i];
    const identity = img.path ? `p:${img.path}` : img.data ? `d:${dataIdentity(img.data)}` : `k:${img.key}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(img);
  }
  return out;
}

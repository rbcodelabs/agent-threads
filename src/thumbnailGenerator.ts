import { THUMB_WIDTH, type ThumbSource, type ThumbnailGenerator } from './thumbnails';

/**
 * Renderer-only (DOM) thumbnail generator: createImageBitmap + OffscreenCanvas.
 * Lives outside the host-free core so the daemon closure stays DOM-free; the
 * plugin passes it to ThreadManager. Guarded: resolves null where the canvas
 * APIs are unavailable.
 */
const THUMB_QUALITY = 0.8;

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
export const canvasThumbnailGenerator: ThumbnailGenerator = async (src) => {
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


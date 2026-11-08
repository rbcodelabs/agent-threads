import type { Thread, ChatMessage, ImageAttachment } from './types';
import { DEFAULT_VAULT_FOLDER } from './productIdentity';

/**
 * Image externalization helpers (ADR-0003, PR 1).
 *
 * Images (`ChatMessage.images` = user-pasted, `ChatMessage.toolResultImages` =
 * tool outputs) used to be serialized inline as base64 into data.json, which was
 * ~83% of a 12.7MB file. These pure functions support moving the bytes out to
 * real vault attachment files:
 *
 *  - `buildAttachmentPath` decides where an image file lives.
 *  - `serializeThreadForSave` produces a data.json-safe copy of a thread that
 *    omits base64/data for any image already backed by a `path` (leaving the
 *    live in-memory object untouched).
 *  - `collectPendingImageExternalizations` walks threads for images that still
 *    need a file written (base64 present, no `path` yet). Used by both the
 *    finalize-time write and the one-time backfill.
 *
 * All functions here are intentionally free of any Obsidian import so they can
 * be unit-tested without a live plugin runtime. The actual file I/O lives in
 * AttachmentWriter.
 */

/** File extension (no dot) for a known image media type, falling back sanely. */
export function extForMediaType(mediaType: string): string {
  switch (mediaType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default: {
      // Derive from the subtype for anything unrecognized (e.g. image/svg+xml),
      // but only accept a plain alphanumeric token; otherwise use a neutral ext.
      const slash = mediaType.indexOf('/');
      const sub = slash >= 0 ? mediaType.slice(slash + 1) : mediaType;
      return /^[a-z0-9]+$/i.test(sub) ? sub.toLowerCase() : 'bin';
    }
  }
}

/**
 * Vault-relative root every thread's attachments hang off.
 *
 * This and `attachmentDirForThread` exist so that writing and removing derive
 * the same path from the same place. They used to be two sets of literals —
 * `buildAttachmentPath` defaulted an empty `vaultFolder` to 'Agent Threads'
 * while `AttachmentWriter.removeThreadDir` defaulted it to 'Claude' — so with
 * the setting blank the writer put files in one directory and the remover
 * confidently deleted another, which does not exist. Cleanup silently did
 * nothing and the real files leaked.
 */
export function attachmentRoot(vaultFolder: string): string {
  return `${vaultFolder || DEFAULT_VAULT_FOLDER}/attachments`;
}

/** The directory holding one thread's attachments. Also what cleanup removes. */
export function attachmentDirForThread(vaultFolder: string, threadId: string): string {
  return `${attachmentRoot(vaultFolder)}/${threadId}`;
}

/**
 * Vault-relative path for an externalized image. Mirrors the per-thread keying
 * of `RawLogWriter` (`<vaultFolder>/logs/<threadId>.jsonl`) so cleanup is a
 * single directory removal. Keyed by the stable message id + index so a retry
 * overwrites the same file idempotently.
 */
export function buildAttachmentPath(
  vaultFolder: string,
  threadId: string,
  messageId: string,
  index: number,
  mediaType: string,
): string {
  return `${attachmentDirForThread(vaultFolder, threadId)}/${messageId}-${index}.${extForMediaType(mediaType)}`;
}

/**
 * Vault-relative path of the 160px WebP thumbnail sidecar for an externalized
 * image: `<messageId>-<index>.thumb.webp` in the same per-thread folder, so
 * removing the thread's attachment directory removes the sidecars too.
 */
export function buildThumbPath(
  vaultFolder: string,
  threadId: string,
  messageId: string,
  index: number,
): string {
  return `${attachmentDirForThread(vaultFolder, threadId)}/${messageId}-${index}.thumb.webp`;
}

/**
 * Returns a copy of `images` with base64 dropped from every ref that already
 * has a `path`. Returns the SAME array reference when nothing needs stripping,
 * so callers can cheaply detect "unchanged" and avoid cloning the message.
 */
function stripImagesForSerialize(images: ImageAttachment[] | undefined): ImageAttachment[] | undefined {
  if (!images) return images;
  let changed = false;
  const out = images.map((img) => {
    if (img.path && img.base64 !== undefined) {
      changed = true;
      const { base64: _omit, ...rest } = img;
      return rest as ImageAttachment;
    }
    return img;
  });
  return changed ? out : images;
}

/** Same as stripImagesForSerialize but for the toolResultImages shape (`data`). */
function stripToolResultImagesForSerialize(
  images: ChatMessage['toolResultImages'],
): ChatMessage['toolResultImages'] {
  if (!images) return images;
  let changed = false;
  const out = images.map((img) => {
    if (img.path && img.data !== undefined) {
      changed = true;
      const { data: _omit, ...rest } = img;
      return rest;
    }
    return img;
  });
  return changed ? out : images;
}

/**
 * Produce a data.json-safe copy of a thread for serialization:
 *  1. Strip the ephemeral `statusTags` (re-derived each poll, never persisted).
 *  2. Drop base64/data from any image already backed by an externalized `path`.
 *
 * The live in-memory thread and its messages are never mutated. Identity is
 * preserved (returns the same `thread` reference) when nothing needs changing,
 * matching the pre-existing statusTags-only fast path in runSaveLoop.
 */
export function serializeThreadForSave(thread: Thread): Thread {
  let messagesChanged = false;
  const mappedMessages = thread.messages.map((m) => {
    const strippedImages = stripImagesForSerialize(m.images);
    const strippedToolImages = stripToolResultImagesForSerialize(m.toolResultImages);
    if (strippedImages === m.images && strippedToolImages === m.toolResultImages) {
      return m;
    }
    messagesChanged = true;
    const copy: ChatMessage = { ...m };
    if (strippedImages !== m.images) copy.images = strippedImages;
    if (strippedToolImages !== m.toolResultImages) copy.toolResultImages = strippedToolImages;
    return copy;
  });

  const hasStatusTags = thread.statusTags !== undefined;
  if (!messagesChanged && !hasStatusTags) return thread;

  const clone: Thread = { ...thread };
  if (messagesChanged) clone.messages = mappedMessages;
  if (hasStatusTags) delete (clone as { statusTags?: unknown }).statusTags;
  return clone;
}

/**
 * Obsidian embed markdown (`![[path]]`, one per line) for every image on a
 * message that has been externalized to a vault attachment file. Covers both
 * user-pasted `images` and tool-result `toolResultImages`. Only path-backed
 * images are embedded: an image still carrying inline base64 with no `path`
 * (not yet externalized) is skipped so the archived note never emits a broken
 * embed or dumps base64 into the markdown. Returns '' when nothing to embed.
 */
export function imageEmbedMarkdown(
  msg: Pick<ChatMessage, 'images' | 'toolResultImages'>,
): string {
  const paths: string[] = [];
  msg.images?.forEach((img) => {
    if (img.path) paths.push(img.path);
  });
  msg.toolResultImages?.forEach((img) => {
    if (img.path) paths.push(img.path);
  });
  return paths.map((p) => `![[${p}]]`).join('\n');
}

/**
 * One image that still needs to be written to disk (base64 present, no `path`).
 * `setPath` writes the resulting vault path back onto the source ref so the next
 * serialize pass drops its base64.
 */
export interface PendingImageExternalization {
  threadId: string;
  messageId: string;
  index: number;
  mediaType: string;
  base64: string;
  setPath: (path: string) => void;
}

/**
 * Walk threads for message images that still need externalizing. An image
 * qualifies when it carries inline bytes (base64 for user images, `data` for
 * tool-result images) but has no `path` yet. Used by the one-time backfill; the
 * predicate (`base64 && !path`) is the same one the finalize-time write uses.
 */
export function collectPendingImageExternalizations(threads: Thread[]): PendingImageExternalization[] {
  const out: PendingImageExternalization[] = [];
  for (const thread of threads) {
    for (const msg of thread.messages) {
      msg.images?.forEach((img, index) => {
        if (img.base64 && !img.path) {
          out.push({
            threadId: thread.id,
            messageId: msg.id,
            index,
            mediaType: img.mediaType,
            base64: img.base64,
            setPath: (p) => {
              img.path = p;
            },
          });
        }
      });
      msg.toolResultImages?.forEach((img, index) => {
        if (img.data && !img.path) {
          out.push({
            threadId: thread.id,
            messageId: msg.id,
            index,
            mediaType: img.mediaType,
            base64: img.data,
            setPath: (p) => {
              img.path = p;
            },
          });
        }
      });
    }
  }
  return out;
}

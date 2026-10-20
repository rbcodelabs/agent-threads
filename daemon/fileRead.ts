/**
 * `file.read`: hand an image file to a client so a remote thread can show it inline (`![](/abs/path)`).
 *
 * Deliberately narrow, since it is a read-scope command that returns file contents:
 * - the path must resolve (symlinks followed) inside a configured workspace root. Those roots are the session
 *   working folders, the shared `/work/*` and external `/ext/*` mounts and the vault mirror, because the
 *   managed daemon lists each of them as a workspace;
 * - png / jpeg / gif / webp only, judged by the extension AND the file's magic bytes. SVG is refused (it can carry
 *   script and external references);
 * - regular files only, at most `FILE_READ_MAX_BYTES`, never under a `.git` or `.obsidian` folder;
 * - every refusal is the same `not_found` error, so the command cannot be used to probe the disk.
 */
import { closeSync, fstatSync, openSync, readSync, realpathSync, constants as fsConstants } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { FILE_READ_MAX_BYTES, type FileReadReply } from '../src/protocol';
import { HostError } from './threadHost';
import { allWorkspaceRoots, isWithin, realOrResolved, type SessionPolicy } from './sessionPolicy';

type ImageType = FileReadReply['mediaType'];

const EXTENSION_TYPES: Record<string, ImageType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const BLOCKED_SEGMENTS: ReadonlySet<string> = new Set(['.git', '.obsidian']);

/** The type the file's leading bytes say it is, or undefined when they match none of the allowed formats. */
export function sniffImageType(head: Buffer): ImageType | undefined {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6) {
    const sig = head.subarray(0, 6).toString('latin1');
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return undefined;
}

const unavailable = (): HostError => new HostError('not_found', 'image unavailable');

export function readImageFile(path: string, policy: SessionPolicy, maxBytes = FILE_READ_MAX_BYTES): FileReadReply {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw unavailable();
  const requested = resolve(path);
  const expected = EXTENSION_TYPES[extname(requested).toLowerCase()];
  if (!expected) throw unavailable();
  let real: string;
  try { real = realpathSync(requested); } catch { throw unavailable(); }
  // The target of a link must itself look like an allowed image, not only the name of the link.
  if (EXTENSION_TYPES[extname(real).toLowerCase()] !== expected) throw unavailable();
  const root = allWorkspaceRoots(policy).map(realOrResolved).find((r) => isWithin(r, real));
  if (!root) throw unavailable();
  if (relative(root, real).split(sep).some((seg) => BLOCKED_SEGMENTS.has(seg))) throw unavailable();

  // O_NOFOLLOW: if the final component is swapped for a link between the check above and here, the open fails.
  let fd: number;
  try { fd = openSync(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch { throw unavailable(); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes || st.size === 0) throw unavailable();
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    const data = got === buf.length ? buf : buf.subarray(0, got);
    if (sniffImageType(data) !== expected) throw unavailable();
    return { base64: data.toString('base64'), mediaType: expected, size: data.length };
  } catch (err) {
    if (err instanceof HostError) throw err;
    throw unavailable();
  } finally {
    closeSync(fd);
  }
}

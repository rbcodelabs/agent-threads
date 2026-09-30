/**
 * Large-file Google Drive transfers for threads.
 *
 * Google's hosted Drive MCP tools (`create_file`, `download_file_content`) move file
 * bytes inline as base64 inside the tool call, so every byte passes through the model
 * context and the local proxy's 10 MiB request cap. These tools instead move bytes
 * between Drive and the local disk directly, using the Drive REST API with the same
 * Google Docs Sync credentials:
 *
 *  - `upload_local_file`     — resumable, chunked upload of a local file (any size).
 *  - `download_to_local_file` — streamed download (or export of a Google-native file) to disk.
 *
 * Trust model: these tools move files outside the agent's normal file-permission checks,
 * so they are confined to the thread's allowed roots (its working directory and the vault),
 * and credential/config locations (.obsidian, .git, .claude, .ssh, .aws, .gnupg, .env*,
 * .mcp.json) are always off limits, for upload sources and download destinations alike.
 *
 * Desktop only: Node `fs`/`https` are imported statically, and this module is only ever
 * loaded lazily through GoogleWorkspaceMcp.
 */
import { constants as fsConstants, createWriteStream, promises as fsp } from 'fs';
import { request as httpsRequest } from 'https';
import type { RequestOptions } from 'http';
import { randomBytes } from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path';

export const DRIVE_FILES_SERVER = 'google-drive-files';
const API = 'https://www.googleapis.com';
const UPLOAD_CHUNK = 8 * 1024 * 1024; // must be a multiple of 256 KiB
const MAX_RETRIES = 5;
const VM_WORKDIR = '/work';
const IDLE_TIMEOUT_MS = 120_000;
const BLOCKED_SEGMENTS = new Set(['.obsidian', '.git', '.claude', '.ssh', '.aws', '.gnupg', '.mcp.json']);
/** Case-insensitive: macOS and Windows filesystems fold case, so `.GIT` is `.git`. */
function isBlockedSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return BLOCKED_SEGMENTS.has(lower) || lower === '.env' || lower.startsWith('.env.');
}
const BLOCKED_MESSAGE = 'Paths inside .obsidian, .git, .claude, .ssh, .aws, .gnupg, and credential files (.env, .env.*, .mcp.json) are not allowed.';

export interface DriveHttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
}
export interface DriveHttpInit { method: string; headers: Record<string, string>; body?: Buffer; signal?: AbortSignal }
export type DriveHttp = (url: string, init: DriveHttpInit) => Promise<DriveHttpResponse>;

/**
 * Node HTTPS (bypasses renderer CSP/CORS). Never follows redirects; 308 is a resumable-upload
 * status, not a redirect. A socket that goes quiet for `idleMs` (request or response body) is
 * destroyed with an error, so a half-open connection cannot hang a transfer until the abort.
 */
export function createDriveHttp(idleMs = IDLE_TIMEOUT_MS, requestFn: (url: string, options: RequestOptions, callback: (response: import('http').IncomingMessage) => void) => import('http').ClientRequest = httpsRequest as never): DriveHttp {
  return (url, init) => new Promise((resolvePromise, reject) => {
    const request = requestFn(url, { method: init.method, headers: init.headers, signal: init.signal }, incoming => {
      const status = incoming.statusCode ?? 502;
      if ([301, 302, 303, 307].includes(status)) { incoming.destroy(); reject(new Error('Google returned an unexpected redirect.')); return; }
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      if ([204, 205, 304].includes(status)) { incoming.resume(); resolvePromise({ status, headers, body: null }); return; }
      resolvePromise({ status, headers, body: incoming });
    });
    request.setTimeout(idleMs, () => request.destroy(new Error(`Google request timed out (no data for ${Math.round(idleMs / 1000)}s).`)));
    request.on('error', reject);
    if (init.body) request.write(init.body);
    request.end();
  });
}
export const driveHttp: DriveHttp = createDriveHttp();

export interface TransferContext {
  http: DriveHttp;
  /** Fresh access token per request, so transfers longer than a token lifetime keep working. */
  getToken(): Promise<string>;
  /** Allowed local roots. The first one is the base for relative paths. */
  roots: string[];
  signal?: AbortSignal;
  /** Throws when the caller's authority has been revoked; polled between chunks. */
  check?(): void;
  sleep?(ms: number): Promise<void>;
  /** Max silence on a download body before it is abandoned. Defaults to 120 s. */
  idleTimeoutMs?: number;
}

// ── Local path sandbox ──────────────────────────────────────────────────────

async function statOrNull(path: string, follow = true): Promise<import('fs').Stats | null> {
  try { return await (follow ? fsp.stat(path) : fsp.lstat(path)); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

/**
 * Resolve `input` to a real path inside one of `roots`, following symlinks so a link
 * cannot smuggle a path out. The final component need not exist (downloads).
 */
export async function resolveInRoots(input: string, roots: string[]): Promise<string> {
  if (!roots.length) throw new Error('No local directory is available for this thread.');
  const realRoots: string[] = [];
  for (const root of roots) { try { realRoots.push(await fsp.realpath(root)); } catch { /* skip missing roots */ } }
  if (!realRoots.length) throw new Error('No local directory is available for this thread.');
  // Threads in a sandbox VM see their working directory mounted at /work.
  const guest = input === VM_WORKDIR || input.startsWith(VM_WORKDIR + '/');
  const absolute = resolve(roots[0], guest ? '.' + input.slice(VM_WORKDIR.length) : input);
  // lstat (not stat) so a dangling symlink counts as present and is rejected below, never "absent".
  let existing = absolute;
  while (!(await statOrNull(existing, false))) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  let realExisting: string;
  try { realExisting = await fsp.realpath(existing); } catch {
    throw new Error(`${existing} is a symlink that cannot be resolved.`);
  }
  const full = join(realExisting, relative(existing, absolute));
  const root = realRoots.find(candidate => within(candidate, full));
  if (!root) throw new Error('Path is outside the allowed directories (the thread working directory and the vault).');
  if (relative(root, full).split(sep).some(isBlockedSegment)) throw new Error(BLOCKED_MESSAGE);
  return full;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function readText(response: DriveHttpResponse, limit = 1024 * 1024): Promise<string> {
  if (!response.body) return '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) break;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function drain(response: DriveHttpResponse): Promise<void> {
  if (response.body) for await (const _ of response.body) { /* discard */ }
}

function googleMessage(status: number, text: string): string {
  let detail = '';
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
    detail = parsed.error?.message ?? '';
    const reason = parsed.error?.errors?.[0]?.reason;
    if (reason && !detail.includes(reason)) detail += ` (${reason})`;
  } catch { detail = text.slice(0, 200); }
  return `Google Drive returned ${status}${detail ? `: ${detail}` : ''}`;
}

/** Yield from `source`, failing if no chunk arrives within `ms` (a stalled body never resolves on its own). */
async function* withIdleTimeout(source: AsyncIterable<Uint8Array>, ms: number): AsyncGenerator<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Google download timed out (no data for ${Math.round(ms / 1000)}s).`)), ms); });
      let next: IteratorResult<Uint8Array>;
      try { next = await Promise.race([iterator.next(), stalled]); } finally { clearTimeout(timer); }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // Don't await: a stalled source's return() would never settle.
    void Promise.resolve(iterator.return?.()).catch(() => {});
  }
}

const retryable = (status: number) => status === 429 || status >= 500;
const defaultSleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

function aborted(ctx: TransferContext): void {
  if (ctx.signal?.aborted) throw new Error('Transfer cancelled.');
  ctx.check?.();
}

async function authed(ctx: TransferContext, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await ctx.getToken()}`, ...extra };
}

async function backoff(ctx: TransferContext, attempt: number): Promise<void> {
  await (ctx.sleep ?? defaultSleep)(Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250));
}

// ── Download ────────────────────────────────────────────────────────────────

const EXPORT_DEFAULTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'application/pdf',
  'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.google-apps.presentation': 'application/pdf',
  'application/vnd.google-apps.drawing': 'image/png',
};
const EXTENSIONS: Record<string, string> = {
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/csv': '.csv', 'text/html': '.html', 'image/png': '.png', 'image/jpeg': '.jpg',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};

/** Drive names are attacker-controllable: neutralise separators, dot-names and denylisted names. */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/\0]/g, '_').trim();
  if (!cleaned || /^\.+$/.test(cleaned)) return 'download';
  return isBlockedSegment(cleaned) ? `_${cleaned}` : cleaned;
}

/** Keep `name` within `maxBytes` UTF-8 bytes (filesystems cap names at 255, and we add ".xxxxxxxx.part"), preserving the extension. */
function fitName(name: string, maxBytes: number): string {
  if (Buffer.byteLength(name) <= maxBytes) return name;
  const ext = extname(name);
  const keepExt = Buffer.byteLength(ext) <= 16 ? ext : '';
  let stem = Array.from(name.slice(0, name.length - keepExt.length));
  while (stem.length && Buffer.byteLength(stem.join('')) + Buffer.byteLength(keepExt) > maxBytes) stem.pop();
  return (stem.join('') || 'download') + keepExt;
}
const MAX_DOWNLOAD_NAME_BYTES = 240;

export interface DownloadArgs { fileId: string; destPath: string; exportMimeType?: string; overwrite?: boolean }
export interface DownloadResult { path: string; bytes: number; name: string; mimeType: string; exportedAs?: string }

export async function downloadDriveFile(ctx: TransferContext, args: DownloadArgs): Promise<DownloadResult> {
  if (!args.fileId?.trim()) throw new Error('fileId is required.');
  if (!args.destPath?.trim()) throw new Error('destPath is required.');
  aborted(ctx);
  const id = encodeURIComponent(args.fileId.trim());
  const metaResponse = await ctx.http(`${API}/drive/v3/files/${id}?fields=id,name,mimeType,size&supportsAllDrives=true`,
    { method: 'GET', headers: await authed(ctx), signal: ctx.signal });
  if (metaResponse.status !== 200) throw new Error(googleMessage(metaResponse.status, await readText(metaResponse)));
  const meta = JSON.parse(await readText(metaResponse)) as { name: string; mimeType: string; size?: string };
  if (meta.mimeType === 'application/vnd.google-apps.folder') throw new Error('That Drive item is a folder, not a file.');

  const native = meta.mimeType.startsWith('application/vnd.google-apps.');
  let exportMime: string | undefined;
  if (native) {
    exportMime = args.exportMimeType || EXPORT_DEFAULTS[meta.mimeType];
    if (!exportMime) throw new Error(`${meta.mimeType} needs an explicit exportMimeType.`);
  }

  // Destination: a directory (existing, or a trailing slash) receives the Drive file name.
  const wantsDir = /[\\/]$/.test(args.destPath);
  let target = await resolveInRoots(args.destPath, ctx.roots);
  const existing = await statOrNull(target);
  if (wantsDir || existing?.isDirectory()) {
    let fileName = safeFileName(meta.name);
    const ext = exportMime ? EXTENSIONS[exportMime] : undefined;
    if (ext && !fileName.toLowerCase().endsWith(ext)) fileName += ext;
    target = join(target, fitName(fileName, MAX_DOWNLOAD_NAME_BYTES));
    // The Drive-supplied name is untrusted: validate the final path, not just destPath.
    await resolveInRoots(target, ctx.roots);
  }
  const current = await statOrNull(target, false);
  if (current && !args.overwrite) throw new Error(`${target} already exists. Pass overwrite: true to replace it.`);
  if (current?.isDirectory()) throw new Error(`${target} is a directory.`);

  const url = exportMime
    ? `${API}/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportMime)}`
    : `${API}/drive/v3/files/${id}?alt=media&supportsAllDrives=true`;
  const response = await ctx.http(url, { method: 'GET', headers: await authed(ctx), signal: ctx.signal });
  if (response.status !== 200 || !response.body) {
    const text = await readText(response);
    const exportTooLarge = exportMime && (/exportSizeLimitExceeded/.test(text) || (response.status === 403 && /too large to be exported/i.test(text)));
    throw new Error(googleMessage(response.status, text) + (exportTooLarge ? '. Google limits exports to 10 MB; download the original file type instead.' : ''));
  }

  // Only now touch the filesystem, remembering which directories we created so a failure can undo them.
  const directory = dirname(target);
  const firstCreated = await fsp.mkdir(directory, { recursive: true });
  const temp = `${target}.${randomBytes(4).toString('hex')}.part`;
  let bytes = 0;
  const body = withIdleTimeout(response.body, ctx.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
  async function* counted(): AsyncGenerator<Uint8Array> {
    for await (const chunk of body) { aborted(ctx); bytes += chunk.length; yield chunk; }
  }
  try {
    await pipeline(Readable.from(counted()), createWriteStream(temp, { flags: 'wx' }));
    if (!native && meta.size !== undefined && bytes !== Number(meta.size)) {
      throw new Error(`Download was incomplete (${bytes} of ${meta.size} bytes).`);
    }
    await finalizeDownload(temp, target, args.overwrite === true);
  } catch (error) {
    await fsp.rm(temp, { force: true });
    if (firstCreated) await removeCreatedDirs(directory, firstCreated);
    throw error;
  }
  return { path: target, bytes, name: meta.name, mimeType: meta.mimeType, ...(exportMime ? { exportedAs: exportMime } : {}) };
}

/** Move the finished temp file into place. Without overwrite this must be exclusive so a file that appeared mid-download is never replaced. */
async function finalizeDownload(temp: string, target: string, overwrite: boolean): Promise<void> {
  if (overwrite) { await fsp.rename(temp, target); return; }
  const exists = () => new Error(`${target} already exists. Pass overwrite: true to replace it.`);
  try {
    await fsp.link(temp, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw exists();
    // Filesystems without hard links: fall back to an exclusive copy.
    try { await fsp.copyFile(temp, target, fsConstants.COPYFILE_EXCL); } catch (copyError) {
      if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') throw exists();
      throw copyError;
    }
  }
  await fsp.rm(temp, { force: true });
}

/** Remove the directories `mkdir -p` created (deepest first, stopping at the first one), ignoring non-empty ones. */
async function removeCreatedDirs(deepest: string, firstCreated: string): Promise<void> {
  for (let dir = deepest; within(firstCreated, dir); dir = dirname(dir)) {
    try { await fsp.rmdir(dir); } catch { return; }
    if (dir === firstCreated) return;
  }
}

// ── Upload ──────────────────────────────────────────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.html': 'text/html', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.zip': 'application/zip', '.gz': 'application/gzip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export interface UploadArgs { path: string; name?: string; parentId?: string; mimeType?: string }
export interface UploadResult { id: string; name: string; mimeType: string; size?: string; webViewLink?: string; parents?: string[]; bytesUploaded: number }

type Progress = { done: UploadResult } | { offset: number };
/** A fully-read response, so a stall while reading the body is handled like any other retryable failure. */
interface Buffered { status: number; range: string | null; text: string }

function parseOffset(range: string | null): number {
  const match = /bytes=0-(\d+)/.exec(range ?? '');
  return match ? Number(match[1]) + 1 : 0;
}

export async function uploadDriveFile(ctx: TransferContext, args: UploadArgs): Promise<UploadResult> {
  if (!args.path?.trim()) throw new Error('path is required.');
  aborted(ctx);
  const source = await resolveInRoots(args.path, ctx.roots);
  // Open first and size from the handle, so the file we measure is the file we read (no stat-then-reopen window).
  let handle: import('fs/promises').FileHandle;
  try { handle = await fsp.open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(`${source} does not exist.`);
    if (code === 'ELOOP') throw new Error(`${source} is a symbolic link and cannot be uploaded.`);
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${source} is not a regular file.`);
    return await uploadOpenFile(ctx, args, source, handle, stat.size);
  } finally {
    await handle.close();
  }
}

async function uploadOpenFile(ctx: TransferContext, args: UploadArgs, source: string, handle: import('fs/promises').FileHandle, size: number): Promise<UploadResult> {
  const name = args.name?.trim() || basename(source);
  const mimeType = args.mimeType?.trim() || MIME_BY_EXT[extname(name).toLowerCase()] || 'application/octet-stream';

  // 1. Start a resumable session.
  const metadata: Record<string, unknown> = { name };
  if (args.parentId?.trim()) metadata.parents = [args.parentId.trim()];
  let sessionUrl = '';
  for (let attempt = 0; ; attempt++) {
    const init = await ctx.http(`${API}/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,parents`, {
      method: 'POST', signal: ctx.signal,
      headers: await authed(ctx, {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(size),
        'Content-Length': String(Buffer.byteLength(JSON.stringify(metadata))),
      }),
      body: Buffer.from(JSON.stringify(metadata)),
    });
    if (init.status === 200) { sessionUrl = init.headers.get('location') ?? ''; await drain(init); break; }
    const text = await readText(init);
    if (!retryable(init.status) || attempt >= 3) throw new Error(googleMessage(init.status, text));
    await backoff(ctx, attempt);
  }
  // The session URI is a bearer capability: only ever talk to Google with it.
  if (!sessionUrl.startsWith(`${API}/`)) throw new Error('Google returned an unexpected upload location.');

  const finish = (text: string): UploadResult => {
    const created = JSON.parse(text) as Omit<UploadResult, 'bytesUploaded'>;
    return { ...created, bytesUploaded: size };
  };
  const put = async (headers: Record<string, string>, body?: Buffer): Promise<Buffered> => {
    const response = await ctx.http(sessionUrl, {
      method: 'PUT', signal: ctx.signal, headers: { ...headers, 'Content-Length': String(body?.length ?? 0) }, body,
    });
    return { status: response.status, range: response.headers.get('range'), text: await readText(response) };
  };
  const status = async (): Promise<Progress> => {
    const response = await put({ 'Content-Range': `bytes */${size}` });
    if (response.status === 200 || response.status === 201) return { done: finish(response.text) };
    if (response.status === 308) return { offset: parseOffset(response.range) };
    throw new Error(googleMessage(response.status, response.text));
  };
  const assertUnchanged = async () => {
    const now = await handle.stat();
    if (now.size !== size) throw new Error(`${source} changed size while uploading (${size} to ${now.size} bytes).`);
  };

  // 2. Empty files finish in a single request.
  if (size === 0) {
    const response = await put({ 'Content-Type': mimeType });
    if (response.status !== 200 && response.status !== 201) throw new Error(googleMessage(response.status, response.text));
    return finish(response.text);
  }

  // 3. Send chunks; resume from the server's committed offset after any failure.
  let offset = 0;
  let committed = 0; // highest offset Google has confirmed
  let attempt = 0;
  while (true) {
    aborted(ctx);
    await assertUnchanged();
    if (offset >= size) {
      const progress = await status();
      if ('done' in progress) return progress.done;
      throw new Error('Google did not finalize the upload.');
    }
    const end = Math.min(offset + UPLOAD_CHUNK, size);
    const chunk = Buffer.alloc(end - offset);
    let read = 0;
    while (read < chunk.length) {
      const { bytesRead } = await handle.read(chunk, read, chunk.length - read, offset + read);
      if (!bytesRead) throw new Error(`${source} changed size while uploading.`);
      read += bytesRead;
    }
    let response: Buffered | null = null;
    try {
      response = await put({ 'Content-Range': `bytes ${offset}-${end - 1}/${size}`, 'Content-Type': mimeType }, chunk);
    } catch (error) {
      aborted(ctx);
      if ((error as Error).message === 'Google returned an unexpected redirect.') throw error;
    }
    if (response && (response.status === 200 || response.status === 201)) return finish(response.text);
    if (response && response.status === 308) {
      const next = parseOffset(response.range);
      offset = next;
      if (next > committed) { committed = next; attempt = 0; continue; }
      // No forward progress: don't re-send the same bytes in a tight loop.
      if (++attempt > MAX_RETRIES) throw new Error('Upload failed after repeated retries (Google is not making progress).');
      await backoff(ctx, attempt);
      continue;
    }
    if (response && !retryable(response.status)) throw new Error(googleMessage(response.status, response.text));
    if (++attempt > MAX_RETRIES) throw new Error('Upload failed after repeated retries.');
    await backoff(ctx, attempt);
    try {
      const progress = await status();
      if ('done' in progress) return progress.done;
      offset = progress.offset;
      committed = Math.max(committed, offset);
    } catch (error) {
      aborted(ctx);
      if (/Google Drive returned 4\d\d/.test((error as Error).message) && !/returned 429/.test((error as Error).message)) throw error;
    }
  }
}

// ── MCP surface ─────────────────────────────────────────────────────────────

type JsonRpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type JsonRpcReply = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

export const DRIVE_FILES_TOOLS = [
  {
    name: 'upload_local_file',
    description: 'Upload a file from the local disk to Google Drive without loading its contents into the conversation. Use this instead of the Drive create_file tool for anything binary or larger than about 1 MB; there is no practical size limit (resumable chunked upload). The file is stored as-is, with no conversion to Google Docs/Sheets/Slides. Reads bypass the agent’s normal file-permission checks, so only paths inside the thread working directory or the vault are readable, and .obsidian, .git, .claude, .ssh, .aws, .gnupg, .env files and .mcp.json are always refused. Creating files inside an existing Drive folder that this app did not create may be refused by Google.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Local file to upload (absolute, or relative to the thread working directory).' },
        name: { type: 'string', description: 'Drive file name. Defaults to the local file name.' },
        parentId: { type: 'string', description: 'Drive folder ID to upload into. Defaults to My Drive root.' },
        mimeType: { type: 'string', description: 'Content MIME type. Guessed from the extension when omitted.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'download_to_local_file',
    description: 'Download a Google Drive file straight to the local disk without loading its contents into the conversation. Use this instead of the Drive download_file_content tool for anything binary or larger than about 1 MB; there is no practical size limit for regular files. Google-native files (Docs, Sheets, Slides) are exported instead (Google caps exports at 10 MB). Writes bypass the agent’s normal file-permission checks, so only paths inside the thread working directory or the vault are writable, and .obsidian, .git, .claude, .ssh, .aws, .gnupg, .env files and .mcp.json are always refused (a Drive file with such a name is saved with a leading underscore).',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'Drive file ID.' },
        destPath: { type: 'string', description: 'Local destination. A directory (or a path ending in /) receives the Drive file name. Absolute, or relative to the thread working directory. Missing parent directories are created.' },
        exportMimeType: { type: 'string', description: 'For Google-native files: target MIME type. Defaults: Docs and Slides to PDF, Sheets to XLSX, Drawings to PNG.' },
        overwrite: { type: 'boolean', description: 'Replace an existing destination file. Defaults to false.' },
      },
      required: ['fileId', 'destPath'],
    },
  },
];

/** Pure JSON-RPC handler, separate from the HTTP listener so it can be unit tested. */
export async function handleDriveFilesRpc(message: JsonRpcMessage, ctx: TransferContext): Promise<JsonRpcReply | null> {
  if (message.id === undefined || message.id === null) return null;
  const id = message.id;
  switch (message.method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: DRIVE_FILES_SERVER, version: '1.0.0' },
      } };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: DRIVE_FILES_TOOLS } };
    case 'tools/call': {
      const name = String(message.params?.name ?? '');
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      const text = (value: string, isError: boolean): JsonRpcReply => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: value }], isError } });
      const str = (key: string) => (typeof args[key] === 'string' ? args[key] as string : undefined);
      try {
        if (name === 'upload_local_file') {
          const result = await uploadDriveFile(ctx, { path: str('path') ?? '', name: str('name'), parentId: str('parentId'), mimeType: str('mimeType') });
          return text(JSON.stringify(result, null, 2), false);
        }
        if (name === 'download_to_local_file') {
          const result = await downloadDriveFile(ctx, {
            fileId: str('fileId') ?? '', destPath: str('destPath') ?? '', exportMimeType: str('exportMimeType'), overwrite: args.overwrite === true,
          });
          return text(JSON.stringify(result, null, 2), false);
        }
        return text(`Unknown tool: ${name}`, true);
      } catch (error) {
        return text(error instanceof Error ? error.message : String(error), true);
      }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${message.method ?? ''}` } };
  }
}

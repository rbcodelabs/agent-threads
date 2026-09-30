import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash, randomBytes } from 'crypto';
import {
  downloadDriveFile, uploadDriveFile, resolveInRoots, handleDriveFilesRpc, DRIVE_FILES_TOOLS,
  type DriveHttp, type DriveHttpInit, type DriveHttpResponse, type TransferContext,
} from '../../src/GoogleDriveFiles';
import { GoogleWorkspaceMcp } from '../../src/GoogleWorkspaceMcp';

const SESSION = 'https://www.googleapis.com/upload/drive/v3/files?upload_id=abc';
const MiB = 1024 * 1024;

function reply(status: number, body: string | Buffer | Buffer[] = '', headers: Record<string, string> = {}): DriveHttpResponse {
  const chunks = Array.isArray(body) ? body : [Buffer.from(body)];
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    body: chunks.length && chunks.some(c => c.length) ? (async function* () { for (const c of chunks) yield c; })() : null,
  };
}
const json = (status: number, value: unknown) => reply(status, JSON.stringify(value), { 'content-type': 'application/json' });

/** A tiny in-memory Drive: metadata, media/export downloads and resumable uploads, with fault injection. */
function fakeDrive(options: {
  files?: Record<string, { name: string; mimeType: string; data?: Buffer; size?: string }>;
  /** Called for each chunk PUT; return a response to inject a fault, or undefined to behave. */
  fault?: (n: number, init: DriveHttpInit) => DriveHttpResponse | Promise<DriveHttpResponse> | undefined;
  location?: string;
} = {}) {
  const uploaded: Buffer[] = [];
  const requests: Array<{ url: string; init: DriveHttpInit }> = [];
  let chunkPuts = 0;
  let created: Record<string, unknown> | undefined;
  const http: DriveHttp = async (url, init) => {
    requests.push({ url, init });
    const u = new URL(url);
    if (init.method === 'POST' && u.pathname === '/upload/drive/v3/files') {
      created = JSON.parse(init.body!.toString('utf8'));
      return reply(200, '', { location: options.location ?? SESSION });
    }
    if (init.method === 'PUT') {
      const range = init.headers['Content-Range'];
      if (!range) return json(200, { id: 'EMPTY', name: created?.name, mimeType: init.headers['Content-Type'], size: '0' });
      const query = /^bytes \*\/(\d+)$/.exec(range);
      const total = Number(range.split('/')[1]);
      if (query) {
        const have = Buffer.concat(uploaded).length;
        if (have >= total && total > 0) return json(200, { id: 'NEW', name: created?.name, mimeType: 'application/octet-stream', size: String(have) });
        return reply(308, '', have ? { range: `bytes=0-${have - 1}` } : {});
      }
      const chunkNo = ++chunkPuts;
      const injected = await options.fault?.(chunkNo, init);
      if (injected) return injected;
      const [, start, end] = /^bytes (\d+)-(\d+)\//.exec(range)!;
      if (Number(start) !== Buffer.concat(uploaded).length) return reply(400, '{"error":{"message":"bad offset"}}');
      uploaded.push(init.body!);
      if (Number(end) + 1 === total) return json(200, { id: 'NEW', name: created?.name, mimeType: init.headers['Content-Type'], size: String(total) });
      return reply(308, '', { range: `bytes=0-${end}` });
    }
    const id = decodeURIComponent(u.pathname.split('/')[4]);
    const file = options.files?.[id];
    if (!file) return json(404, { error: { message: 'File not found', errors: [{ reason: 'notFound' }] } });
    if (u.pathname.endsWith('/export')) return reply(200, file.data ?? Buffer.from('exported'));
    if (u.searchParams.get('alt') === 'media') return reply(200, file.data ? [file.data.subarray(0, 3 * MiB), file.data.subarray(3 * MiB)] : []);
    return json(200, { id, name: file.name, mimeType: file.mimeType, size: file.size ?? (file.data ? String(file.data.length) : undefined) });
  };
  return { http, requests, uploaded: () => Buffer.concat(uploaded), created: () => created, chunkPuts: () => chunkPuts };
}

let root: string;
let outside: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'drive-files-root-'));
  outside = mkdtempSync(join(tmpdir(), 'drive-files-out-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
const ctxFor = (http: DriveHttp, extra: Partial<TransferContext> = {}): TransferContext => ({
  http, getToken: async () => 'TOKEN', roots: [root], sleep: async () => {}, ...extra,
});
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('resolveInRoots', () => {
  it('resolves relative paths against the first root and allows the vault root', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'drive-files-vault-'));
    try {
      expect(await resolveInRoots('a/b.txt', [root, vault])).toBe(join(require('fs').realpathSync(root), 'a', 'b.txt'));
      writeFileSync(join(vault, 'v.txt'), 'x');
      expect(await resolveInRoots(join(vault, 'v.txt'), [root, vault])).toBe(join(require('fs').realpathSync(vault), 'v.txt'));
    } finally { rmSync(vault, { recursive: true, force: true }); }
  });
  it('rejects paths outside the roots, including ../ traversal', async () => {
    await expect(resolveInRoots(join(outside, 'x'), [root])).rejects.toThrow(/outside the allowed/);
    await expect(resolveInRoots('../escape.txt', [root])).rejects.toThrow(/outside the allowed/);
  });
  it('rejects a symlink that points outside the roots, for existing and new files', async () => {
    writeFileSync(join(outside, 'secret.txt'), 's');
    symlinkSync(outside, join(root, 'link'));
    await expect(resolveInRoots('link/secret.txt', [root])).rejects.toThrow(/outside the allowed/);
    await expect(resolveInRoots('link/new.txt', [root])).rejects.toThrow(/outside the allowed/);
  });
  it('blocks .obsidian and .git segments', async () => {
    await expect(resolveInRoots('.obsidian/plugins/x/data.json', [root])).rejects.toThrow(/\.obsidian and \.git/);
    await expect(resolveInRoots('sub/.git/config', [root])).rejects.toThrow(/\.obsidian and \.git/);
  });
  it('maps the VM guest /work alias onto the working directory', async () => {
    expect(await resolveInRoots('/work/out/file.bin', [root])).toBe(join(require('fs').realpathSync(root), 'out', 'file.bin'));
    expect(await resolveInRoots('/work', [root])).toBe(require('fs').realpathSync(root));
    // Only the exact /work prefix is an alias.
    await expect(resolveInRoots('/workshop/x', [root])).rejects.toThrow(/outside the allowed/);
  });
  it('fails clearly when the thread has no usable directory', async () => {
    await expect(resolveInRoots('x', [])).rejects.toThrow(/No local directory/);
    await expect(resolveInRoots('x', [join(root, 'missing')])).rejects.toThrow(/No local directory/);
  });
});

describe('uploadDriveFile', () => {
  it('uploads a multi-chunk file (>16 MiB) byte-for-byte using a resumable session', async () => {
    const data = randomBytes(17 * MiB + 123);
    writeFileSync(join(root, 'big.bin'), data);
    const drive = fakeDrive();
    const result = await uploadDriveFile(ctxFor(drive.http), { path: 'big.bin', parentId: 'FOLDER' });
    expect(result).toMatchObject({ id: 'NEW', name: 'big.bin', bytesUploaded: data.length });
    expect(sha(drive.uploaded())).toBe(sha(data));
    expect(drive.chunkPuts()).toBe(3);
    expect(drive.created()).toEqual({ name: 'big.bin', parents: ['FOLDER'] });
    const start = drive.requests[0];
    expect(start.url).toContain('uploadType=resumable');
    expect(start.init.headers['X-Upload-Content-Length']).toBe(String(data.length));
    expect(start.init.headers.Authorization).toBe('Bearer TOKEN');
  });
  it('authorizes only the session-initiating request and never sends the bearer token with chunk PUTs', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello');
    const drive = fakeDrive();
    await uploadDriveFile(ctxFor(drive.http), { path: 'a.txt' });
    expect(drive.requests[0].init.headers.Authorization).toBe('Bearer TOKEN');
    for (const r of drive.requests.slice(1)) expect(r.init.headers.Authorization).toBeUndefined();
    for (const r of drive.requests) expect(new URL(r.url).hostname).toBe('www.googleapis.com');
  });
  it('resumes from the server offset after a 5xx mid-upload', async () => {
    const data = randomBytes(9 * MiB);
    writeFileSync(join(root, 'r.bin'), data);
    const drive = fakeDrive({ fault: n => (n === 2 ? reply(503, 'unavailable') : undefined) });
    const result = await uploadDriveFile(ctxFor(drive.http), { path: 'r.bin' });
    expect(result.bytesUploaded).toBe(data.length);
    expect(sha(drive.uploaded())).toBe(sha(data));
    // The retry asked the server where it was before continuing.
    expect(drive.requests.some(r => r.init.headers['Content-Range'] === `bytes */${data.length}`)).toBe(true);
  });
  it('resumes after a dropped connection', async () => {
    const data = randomBytes(9 * MiB);
    writeFileSync(join(root, 'd.bin'), data);
    let dropped = false;
    const drive = fakeDrive({ fault: n => { if (n === 2 && !dropped) { dropped = true; throw new Error('socket hang up'); } return undefined; } });
    const result = await uploadDriveFile(ctxFor(drive.http), { path: 'd.bin' });
    expect(result.bytesUploaded).toBe(data.length);
    expect(sha(drive.uploaded())).toBe(sha(data));
  });
  it('gives up with a clear error after repeated failures', async () => {
    writeFileSync(join(root, 'f.bin'), randomBytes(1024));
    const drive = fakeDrive({ fault: () => reply(500, 'nope') });
    await expect(uploadDriveFile(ctxFor(drive.http), { path: 'f.bin' })).rejects.toThrow(/repeated retries/);
  });
  it('does not retry non-retryable errors and surfaces Google’s message', async () => {
    writeFileSync(join(root, 'p.bin'), randomBytes(1024));
    const drive = fakeDrive({ fault: () => json(403, { error: { message: 'File not found: parent', errors: [{ reason: 'notFound' }] } }) });
    await expect(uploadDriveFile(ctxFor(drive.http), { path: 'p.bin', parentId: 'NOPE' })).rejects.toThrow(/403: File not found: parent/);
    expect(drive.chunkPuts()).toBe(1);
  });
  it('uploads an empty file in a single request', async () => {
    writeFileSync(join(root, 'empty.txt'), '');
    const drive = fakeDrive();
    const result = await uploadDriveFile(ctxFor(drive.http), { path: 'empty.txt' });
    expect(result).toMatchObject({ id: 'EMPTY', bytesUploaded: 0 });
  });
  it('rejects an upload Location outside googleapis.com before sending any bytes', async () => {
    writeFileSync(join(root, 'x.bin'), randomBytes(64));
    const drive = fakeDrive({ location: 'https://evil.example.com/upload' });
    await expect(uploadDriveFile(ctxFor(drive.http), { path: 'x.bin' })).rejects.toThrow(/unexpected upload location/);
    expect(drive.requests.every(r => !r.url.includes('evil'))).toBe(true);
  });
  it('refuses directories, missing files and paths outside the sandbox', async () => {
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(outside, 'o.txt'), 'x');
    const drive = fakeDrive();
    await expect(uploadDriveFile(ctxFor(drive.http), { path: 'dir' })).rejects.toThrow(/not a regular file/);
    await expect(uploadDriveFile(ctxFor(drive.http), { path: 'nope.txt' })).rejects.toThrow(/does not exist/);
    await expect(uploadDriveFile(ctxFor(drive.http), { path: join(outside, 'o.txt') })).rejects.toThrow(/outside the allowed/);
    expect(drive.requests).toHaveLength(0);
  });
  it('honours name and mimeType overrides and guesses MIME from the extension', async () => {
    writeFileSync(join(root, 'clip.mp4'), randomBytes(10));
    const drive = fakeDrive();
    await uploadDriveFile(ctxFor(drive.http), { path: 'clip.mp4', name: 'renamed.mp4' });
    expect(drive.created()).toEqual({ name: 'renamed.mp4' });
    expect(drive.requests[0].init.headers['X-Upload-Content-Type']).toBe('video/mp4');
    const other = fakeDrive();
    await uploadDriveFile(ctxFor(other.http), { path: 'clip.mp4', mimeType: 'application/x-custom' });
    expect(other.requests[0].init.headers['X-Upload-Content-Type']).toBe('application/x-custom');
  });
  it('stops when the caller is revoked mid-transfer', async () => {
    writeFileSync(join(root, 'big.bin'), randomBytes(20 * MiB));
    const drive = fakeDrive();
    let calls = 0;
    const check = () => { if (++calls > 3) throw new Error('revoked'); };
    await expect(uploadDriveFile(ctxFor(drive.http, { check }), { path: 'big.bin' })).rejects.toThrow('revoked');
    expect(drive.chunkPuts()).toBeLessThan(3);
  });
  it('fetches a fresh token for each authorized request', async () => {
    const drive = fakeDrive({ files: { F: { name: 'n', mimeType: 'text/plain', data: Buffer.from('abc') } } });
    let n = 0;
    await downloadDriveFile(ctxFor(drive.http, { getToken: async () => `T${++n}` }), { fileId: 'F', destPath: 'x.txt' });
    expect(drive.requests.map(r => r.init.headers.Authorization)).toEqual(['Bearer T1', 'Bearer T2']);
  });
});

describe('downloadDriveFile', () => {
  const big = randomBytes(5 * MiB + 7);
  it('streams a regular file to disk, creating parent directories', async () => {
    const drive = fakeDrive({ files: { F1: { name: 'video.bin', mimeType: 'application/octet-stream', data: big } } });
    const result = await downloadDriveFile(ctxFor(drive.http), { fileId: 'F1', destPath: 'out/deep/video.bin' });
    expect(result).toMatchObject({ bytes: big.length, name: 'video.bin' });
    expect(sha(readFileSync(join(root, 'out/deep/video.bin')))).toBe(sha(big));
    expect(readdirSync(join(root, 'out/deep')).filter(n => n.endsWith('.part'))).toEqual([]);
    expect(drive.requests.at(-1)!.url).toContain('alt=media');
  });
  it('uses the Drive file name when destPath is a directory', async () => {
    mkdirSync(join(root, 'dl'));
    const drive = fakeDrive({ files: { F1: { name: 'a/b.txt', mimeType: 'text/plain', data: Buffer.from('hi') } } });
    const viaExisting = await downloadDriveFile(ctxFor(drive.http), { fileId: 'F1', destPath: 'dl' });
    expect(viaExisting.path).toMatch(/dl[\\/]a_b\.txt$/);
    const viaSlash = await downloadDriveFile(ctxFor(drive.http), { fileId: 'F1', destPath: 'fresh/' });
    expect(viaSlash.path).toMatch(/fresh[\\/]a_b\.txt$/);
    expect(readFileSync(viaSlash.path, 'utf8')).toBe('hi');
  });
  it('refuses to overwrite unless asked', async () => {
    writeFileSync(join(root, 'keep.txt'), 'original');
    const drive = fakeDrive({ files: { F1: { name: 'n', mimeType: 'text/plain', data: Buffer.from('new') } } });
    await expect(downloadDriveFile(ctxFor(drive.http), { fileId: 'F1', destPath: 'keep.txt' })).rejects.toThrow(/already exists/);
    expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('original');
    await downloadDriveFile(ctxFor(drive.http), { fileId: 'F1', destPath: 'keep.txt', overwrite: true });
    expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('new');
  });
  it('exports Google-native files with sensible defaults and extensions', async () => {
    const drive = fakeDrive({ files: {
      DOC: { name: 'Plan', mimeType: 'application/vnd.google-apps.document' },
      SHEET: { name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet' },
    } });
    const doc = await downloadDriveFile(ctxFor(drive.http), { fileId: 'DOC', destPath: 'exports/' });
    expect(doc).toMatchObject({ exportedAs: 'application/pdf' });
    expect(doc.path).toMatch(/Plan\.pdf$/);
    const sheet = await downloadDriveFile(ctxFor(drive.http), { fileId: 'SHEET', destPath: 'exports/' });
    expect(sheet.path).toMatch(/Budget\.xlsx$/);
    const csv = await downloadDriveFile(ctxFor(drive.http), { fileId: 'SHEET', destPath: 'exports/b.csv', exportMimeType: 'text/csv' });
    expect(csv.exportedAs).toBe('text/csv');
    expect(drive.requests.some(r => r.url.includes('/export?mimeType=text%2Fcsv'))).toBe(true);
  });
  it('requires an explicit export type for other Google-native files, and rejects folders', async () => {
    const drive = fakeDrive({ files: {
      FORM: { name: 'Form', mimeType: 'application/vnd.google-apps.form' },
      DIR: { name: 'Folder', mimeType: 'application/vnd.google-apps.folder' },
    } });
    await expect(downloadDriveFile(ctxFor(drive.http), { fileId: 'FORM', destPath: 'f' })).rejects.toThrow(/explicit exportMimeType/);
    await expect(downloadDriveFile(ctxFor(drive.http), { fileId: 'DIR', destPath: 'f' })).rejects.toThrow(/folder/);
  });
  it('removes the temp file and leaves no destination when the size does not match', async () => {
    const drive = fakeDrive({ files: { F1: { name: 'n', mimeType: 'application/octet-stream', data: Buffer.from('short'), size: '999' } } });
    await expect(downloadDriveFile(ctxFor(drive.http), { fileId: 'F1', destPath: 'trunc.bin' })).rejects.toThrow(/incomplete/);
    expect(readdirSync(root)).toEqual([]);
  });
  it('cleans up when the stream errors midway', async () => {
    const http: DriveHttp = async url => {
      if (url.includes('alt=media')) return { status: 200, headers: { get: () => null }, body: (async function* () { yield Buffer.from('partial'); throw new Error('connection reset'); })() };
      return json(200, { id: 'F', name: 'n', mimeType: 'application/octet-stream', size: '100' });
    };
    await expect(downloadDriveFile(ctxFor(http), { fileId: 'F', destPath: 'x.bin' })).rejects.toThrow('connection reset');
    expect(readdirSync(root)).toEqual([]);
  });
  it('surfaces Google errors and keeps the export size hint', async () => {
    const drive = fakeDrive();
    await expect(downloadDriveFile(ctxFor(drive.http), { fileId: 'MISSING', destPath: 'x' })).rejects.toThrow(/404: File not found/);
    const http: DriveHttp = async url => url.includes('/export')
      ? json(403, { error: { message: 'This file is too large to be exported.', errors: [{ reason: 'exportSizeLimitExceeded' }] } })
      : json(200, { id: 'D', name: 'Huge', mimeType: 'application/vnd.google-apps.document' });
    await expect(downloadDriveFile(ctxFor(http), { fileId: 'D', destPath: 'x.pdf' })).rejects.toThrow(/too large[\s\S]*10 MB/);
    expect(existsSync(join(root, 'x.pdf'))).toBe(false);
  });
  it('rejects destinations outside the sandbox before requesting file bytes', async () => {
    const drive = fakeDrive({ files: { F1: { name: 'n', mimeType: 'text/plain', data: Buffer.from('x') } } });
    await expect(downloadDriveFile(ctxFor(drive.http), { fileId: 'F1', destPath: join(outside, 'x') })).rejects.toThrow(/outside the allowed/);
    await expect(downloadDriveFile(ctxFor(drive.http), { fileId: 'F1', destPath: '.obsidian/x' })).rejects.toThrow(/\.obsidian/);
    expect(drive.requests.some(r => r.url.includes('alt=media'))).toBe(false);
  });
});

describe('handleDriveFilesRpc', () => {
  it('speaks the minimal MCP handshake and lists both tools', async () => {
    const ctx = ctxFor(fakeDrive().http);
    expect(await handleDriveFilesRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx)).toBeNull();
    expect(await handleDriveFilesRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, ctx))
      .toMatchObject({ id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'google-drive-files' } } });
    expect(await handleDriveFilesRpc({ jsonrpc: '2.0', id: 2, method: 'ping' }, ctx)).toMatchObject({ id: 2, result: {} });
    const list = await handleDriveFilesRpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, ctx) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map(t => t.name)).toEqual(['upload_local_file', 'download_to_local_file']);
    expect(DRIVE_FILES_TOOLS.every(t => (t.inputSchema.required as string[]).length > 0)).toBe(true);
    expect(await handleDriveFilesRpc({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, ctx)).toMatchObject({ error: { code: -32601 } });
  });
  it('runs tools and reports failures as tool errors, not protocol errors', async () => {
    writeFileSync(join(root, 'u.txt'), 'data');
    const drive = fakeDrive();
    const ok = await handleDriveFilesRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'upload_local_file', arguments: { path: 'u.txt' } } }, ctxFor(drive.http)) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(ok.result.isError).toBe(false);
    expect(JSON.parse(ok.result.content[0].text)).toMatchObject({ id: 'NEW', bytesUploaded: 4 });
    const bad = await handleDriveFilesRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'upload_local_file', arguments: { path: '/etc/passwd' } } }, ctxFor(drive.http)) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toMatch(/outside the allowed/);
    const unknown = await handleDriveFilesRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } }, ctxFor(drive.http)) as { result: { isError: boolean } };
    expect(unknown.result.isError).toBe(true);
  });
  it('never puts the access token in an error message', async () => {
    const http: DriveHttp = async () => { throw new Error('boom'); };
    const res = await handleDriveFilesRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'download_to_local_file', arguments: { fileId: 'x', destPath: 'y' } } },
      ctxFor(http, { getToken: async () => 'SUPER_SECRET_TOKEN' }));
    expect(JSON.stringify(res)).not.toContain('SUPER_SECRET_TOKEN');
  });
});

describe('/drive-files route on the loopback proxy', () => {
  const proxies: GoogleWorkspaceMcp[] = [];
  afterEach(() => proxies.forEach(p => p.close()));
  function setup(drive: ReturnType<typeof fakeDrive>, roots: string[] = [root]) {
    let tokens = { accessToken: 'GOOGLE_SECRET', refreshToken: 'REFRESH_SECRET' };
    const plugin = { settings: { authProxyUrl: 'https://auth.example.com' }, tokenStore: {
      supportsConnectionGuard: true, get: () => tokens, getValidAccessToken: vi.fn(async () => tokens.accessToken),
    } };
    const upstream = vi.fn(async () => new Response('{}'));
    const proxy = new GoogleWorkspaceMcp(() => plugin, upstream, 30_000, { bindings: {}, save: async () => {} }, () => roots, drive.http);
    proxies.push(proxy);
    return { proxy, plugin, upstream, setTokens: (value: typeof tokens) => { tokens = value; } };
  }
  const rpc = (config: { url: string; headers: Record<string, string> }, body: unknown, init: RequestInit = {}) =>
    fetch(config.url, { method: 'POST', headers: { ...config.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...init });
  const callTool = async (config: { url: string; headers: Record<string, string> }, name: string, args: unknown) => {
    const res = await rpc(config, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } });
    expect(res.status).toBe(200);
    const text = await res.text();
    const data = text.startsWith('event:') || text.startsWith(':') ? text.split('\n').find(line => line.startsWith('data: '))!.slice(6) : text;
    return JSON.parse(data) as { result: { isError: boolean; content: Array<{ text: string }> } };
  };

  it('is exposed only with the Drive opt-in and shares the Drive capability', async () => {
    const f = setup(fakeDrive());
    await f.proxy.configure({ docs: true });
    expect(Object.keys(f.proxy.serversForThread('t1'))).toEqual(['google-docs']);
    await f.proxy.configure({ docs: true, drive: true });
    const servers = f.proxy.serversForThread('t2');
    expect(Object.keys(servers)).toEqual(['google-docs', 'google-drive', 'google-drive-files']);
    expect(servers['google-drive-files'].url).toMatch(/\/drive-files$/);
    expect(servers['google-drive-files'].headers).toEqual(servers['google-drive'].headers);
  });
  it('rejects a Docs-only capability, a bogus capability, browser origins and non-POST', async () => {
    const f = setup(fakeDrive());
    await f.proxy.configure({ docs: true, drive: true });
    const servers = f.proxy.serversForThread('t');
    const files = servers['google-drive-files'];
    expect((await rpc({ ...files, headers: { Authorization: 'Bearer nope' } }, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    expect((await rpc(files, { jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { ...files.headers, Origin: 'https://evil.example.com' } })).status).toBe(403);
    expect((await fetch(files.url, { headers: files.headers })).status).toBe(405);
    expect((await fetch(files.url, { method: 'DELETE', headers: files.headers })).status).toBe(405);
    expect(f.plugin.tokenStore.getValidAccessToken).not.toHaveBeenCalled();
    // A capability bound without drive cannot reach the file tools.
    const f2 = setup(fakeDrive());
    await f2.proxy.configure({ docs: true });
    const docs = f2.proxy.serversForThread('t')['google-docs'];
    expect((await rpc({ ...docs, url: docs.url.replace('/docs', '/drive-files') }, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
  });
  it('answers handshake requests without touching Google, and notifications with 202', async () => {
    const f = setup(fakeDrive());
    await f.proxy.configure({ drive: true });
    const files = f.proxy.serversForThread('t')['google-drive-files'];
    const init = await rpc(files, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(init.status).toBe(200);
    expect((await init.json() as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('google-drive-files');
    expect((await rpc(files, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const batch = await rpc(files, [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    expect(((await batch.json()) as unknown[]).length).toBe(2);
    expect((await rpc(files, {}, { body: 'not json' })).status).toBe(400);
    expect(f.plugin.tokenStore.getValidAccessToken).not.toHaveBeenCalled();
  });
  it('uploads and downloads files larger than the 10 MiB request cap end to end', async () => {
    const data = randomBytes(24 * MiB + 5);
    writeFileSync(join(root, 'large.bin'), data);
    const drive = fakeDrive();
    const f = setup(drive);
    await f.proxy.configure({ drive: true });
    const files = f.proxy.serversForThread('t')['google-drive-files'];
    const up = await callTool(files, 'upload_local_file', { path: 'large.bin' });
    expect(up.result.isError).toBe(false);
    expect(JSON.parse(up.result.content[0].text).bytesUploaded).toBe(data.length);
    expect(sha(drive.uploaded())).toBe(sha(data));
    // The bytes never travelled through the MCP request/response.
    expect(JSON.stringify(up)).not.toContain(data.subarray(0, 32).toString('base64'));
    expect(drive.requests[0].init.headers.Authorization).toBe('Bearer GOOGLE_SECRET');

    const downloadDrive = fakeDrive({ files: { BIG: { name: 'big.bin', mimeType: 'application/octet-stream', data } } });
    const g = setup(downloadDrive);
    await g.proxy.configure({ drive: true });
    const gfiles = g.proxy.serversForThread('t')['google-drive-files'];
    const down = await callTool(gfiles, 'download_to_local_file', { fileId: 'BIG', destPath: 'got/big.bin' });
    expect(down.result.isError).toBe(false);
    expect(sha(readFileSync(join(root, 'got/big.bin')))).toBe(sha(data));
  });
  it('scopes paths to the thread roots supplied by the host', async () => {
    writeFileSync(join(outside, 'o.txt'), 'x');
    const drive = fakeDrive();
    const f = setup(drive, [root]);
    await f.proxy.configure({ drive: true });
    const files = f.proxy.serversForThread('t')['google-drive-files'];
    const res = await callTool(files, 'upload_local_file', { path: join(outside, 'o.txt') });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/outside the allowed/);
    expect(drive.requests).toHaveLength(0);
  });
  it('asks Google Docs Sync for a fresh token on every authorized request', async () => {
    const drive = fakeDrive({ files: { F: { name: 'n', mimeType: 'text/plain', data: Buffer.from('abc') } } });
    const f = setup(drive);
    await f.proxy.configure({ drive: true });
    const files = f.proxy.serversForThread('t')['google-drive-files'];
    let n = 0;
    f.plugin.tokenStore.getValidAccessToken.mockImplementation(async () => `TOKEN_${++n}`);
    await callTool(files, 'download_to_local_file', { fileId: 'F', destPath: 'x.txt' });
    expect(drive.requests.map(r => r.init.headers.Authorization)).toEqual(['Bearer TOKEN_1', 'Bearer TOKEN_2']);
  });
  it('is revoked together with the Drive capability on reconnect', async () => {
    const drive = fakeDrive();
    const f = setup(drive);
    await f.proxy.configure({ drive: true });
    const files = f.proxy.serversForThread('t')['google-drive-files'];
    f.setTokens({ accessToken: 'OTHER', refreshToken: 'DIFFERENT_REFRESH' });
    expect((await rpc(files, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(409);
    expect(drive.requests).toHaveLength(0);
  });
  it('is revoked when Drive is switched off, and forwards nothing to the vendor endpoint', async () => {
    const f = setup(fakeDrive());
    await f.proxy.configure({ drive: true });
    const files = f.proxy.serversForThread('t')['google-drive-files'];
    await f.proxy.configure({ drive: false, docs: true });
    expect((await rpc(files, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(409);
    expect(f.upstream).not.toHaveBeenCalled();
  });
  it('is bridged into VM sessions alongside the vendor Drive server', async () => {
    const f = setup(fakeDrive());
    await f.proxy.configure({ drive: true });
    const vm = f.proxy.vmServersForThread('t');
    expect(Object.keys(vm)).toEqual(['google-drive', 'google-drive-files']);
    expect(vm['google-drive-files']).toMatchObject({ type: 'sdk', name: 'google-drive-files' });
  });
});

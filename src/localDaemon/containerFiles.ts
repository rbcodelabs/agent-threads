/**
 * Local daemon: copies small file trees (skills, agent definitions, a trimmed AWS config and SSO token files) into the
 * daemon container's data volume, so sessions there can use them without a bind mount (a mount is fixed when the
 * container is created and would recreate it on every change).
 *
 * The copy runs INSIDE the container as the daemon user: `container exec -i <name> node -e <script>` with one JSON
 * object on stdin (`{ dest, clean, files: [{ p, b, m }] }`, contents base64). Nothing is in argv. The script refuses
 * any destination outside the data directory and any file path that escapes the destination.
 *
 * Pure builders plus an injectable `FsLike`, so the walk is tested without a real filesystem; no Node built-in is
 * loaded at module scope (the plugin bundle also loads on mobile).
 */

import type { VmCommandRunner } from '../containerCli';
import { DAEMON_UID, DATA_MOUNT } from './spec';

export interface FileToCopy {
  /** Path relative to the destination (POSIX, no `..`). */
  p: string;
  /** Contents, base64. */
  b: string;
  /** File mode; default 0600. */
  m?: number;
}

export const COPY_SCRIPT = `
const fs = require('fs'); const path = require('path');
const root = process.argv[1];
let raw = '';
process.stdin.on('data', (c) => { raw += c; }).on('end', () => {
  const { dest, clean, files } = JSON.parse(raw);
  const d = path.resolve(dest);
  if (!d.startsWith(root + '/') || d.split('/').includes('..')) { console.error('destination outside the data directory'); process.exit(2); }
  if (clean) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  for (const f of files) {
    const t = path.resolve(d, f.p);
    if (!t.startsWith(d + '/')) { console.error('file path escapes the destination: ' + f.p); process.exit(2); }
    fs.mkdirSync(path.dirname(t), { recursive: true, mode: 0o700 });
    fs.writeFileSync(t, Buffer.from(f.b, 'base64'), { mode: typeof f.m === 'number' ? f.m : 0o600 });
  }
});
`.trim();

export function copyFilesArgs(containerName: string): string[] {
  return ['exec', '-i', '--user', String(DAEMON_UID), containerName, 'node', '-e', COPY_SCRIPT, DATA_MOUNT];
}

export function listDirArgs(containerName: string, dir: string): string[] {
  return ['exec', '--user', String(DAEMON_UID), containerName, 'sh', '-c', `ls -1 ${shellSingleQuote(dir)} 2>/dev/null || true`];
}

export function removeDirArgs(containerName: string, dir: string): string[] {
  return ['exec', '--user', String(DAEMON_UID), containerName, 'rm', '-rf', dir];
}

function shellSingleQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Copies `files` into `dest` (a path under the data directory). Throws with the exec's stderr tail on failure. */
export async function copyFilesToContainer(
  run: VmCommandRunner,
  containerName: string,
  dest: string,
  files: readonly FileToCopy[],
  opts: { clean?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const r = await run(copyFilesArgs(containerName), {
    timeoutMs: opts.timeoutMs ?? 120_000,
    input: JSON.stringify({ dest, clean: opts.clean === true, files }),
    maxBufferBytes: 1024 * 1024,
  });
  if (r.exitCode !== 0) throw new Error(`copying files into the local daemon failed (exit ${r.exitCode}): ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
}

// ── Reading a directory tree on the host ─────────────────────────────────────

export interface FsLike {
  /** Real path, or throws. */
  realpath(p: string): string;
  /** Directory entries (names), or throws. */
  readdir(p: string): string[];
  /** Follows symlinks: `{ dir, file, size, mtimeMs }`, or null when it cannot be read. */
  stat(p: string): { dir: boolean; file: boolean; size: number; mtimeMs: number; mode: number } | null;
  readBase64(p: string): string;
}

export interface TreeLimits { maxFiles: number; maxBytes: number; maxDepth: number }
export const DEFAULT_TREE_LIMITS: TreeLimits = { maxFiles: 2000, maxBytes: 20 * 1024 * 1024, maxDepth: 12 };

/** Directory names never copied: VCS data and dependency caches (large, and not part of a skill). */
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.DS_Store']);

export interface TreeResult {
  files: FileToCopy[];
  /** Cheap change detector: names, sizes and mtimes. Equal fingerprints mean nothing to copy. */
  fingerprint: string;
  skipped: string[];
}

/**
 * Reads a directory tree into copyable files, following symlinks (a skills folder is often a tree of links into
 * `~/.agents/...`), within `limits`. Cycles are cut by real path. Executable bits are kept. Anything over a limit is
 * skipped and listed, never an error: a skill that is too big is better missing than blocking a message.
 */
export function readTree(fs: FsLike, root: string, limits: TreeLimits = DEFAULT_TREE_LIMITS): TreeResult {
  const files: FileToCopy[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  const fpParts: string[] = [];
  let bytes = 0;
  const walk = (dir: string, rel: string, depth: number): void => {
    let real: string;
    try { real = fs.realpath(dir); } catch { return; }
    if (seen.has(real) || depth > limits.maxDepth) { if (depth > limits.maxDepth) skipped.push(rel || '.'); return; }
    seen.add(real);
    let names: string[];
    try { names = fs.readdir(dir).sort(); } catch { return; }
    for (const name of names) {
      if (SKIPPED_DIRS.has(name)) continue;
      const abs = `${dir}/${name}`;
      const relPath = rel ? `${rel}/${name}` : name;
      const st = fs.stat(abs);
      if (!st) continue;
      if (st.dir) { walk(abs, relPath, depth + 1); continue; }
      if (!st.file) continue;
      if (files.length >= limits.maxFiles || bytes + st.size > limits.maxBytes) { skipped.push(relPath); continue; }
      let b: string;
      try { b = fs.readBase64(abs); } catch { continue; }
      bytes += st.size;
      files.push({ p: relPath, b, m: st.mode & 0o111 ? 0o700 : 0o600 });
      fpParts.push(`${relPath}:${st.size}:${Math.floor(st.mtimeMs)}`);
    }
  };
  walk(root, '', 0);
  return { files, fingerprint: fpParts.join('|'), skipped };
}

/** Short stable hash (not security): names a destination directory after its source path and fingerprint. */
export function shortHash(input: string): string {
  let h1 = 0xdeadbeef; let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`.slice(0, 12);
}

/** A real filesystem for {@link readTree}. Node built-ins are required here, lazily. */
export function nodeFs(): FsLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  return {
    realpath: (p) => fs.realpathSync(p),
    readdir: (p) => fs.readdirSync(p),
    stat: (p) => {
      try {
        const s = fs.statSync(p);
        return { dir: s.isDirectory(), file: s.isFile(), size: s.size, mtimeMs: s.mtimeMs, mode: s.mode };
      } catch { return null; }
    },
    readBase64: (p) => fs.readFileSync(p).toString('base64'),
  };
}

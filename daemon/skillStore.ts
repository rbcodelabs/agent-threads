/**
 * Skill trees pushed by an admin client (`skills.sync`, `skills.put`, `skills.commit`; see src/protocol/skills.ts).
 *
 * Layout: `<dataDir>/skills/<name>-<hash12>/` (what a session's `pluginPaths` names; `keepUnder` in sessionPolicy.ts
 * still gates it) and `<dataDir>/skills/.incoming/<upload>/` for a tree being uploaded. Nothing is ever written under
 * the daemon user's `~/.claude`.
 *
 * Everything the client sends is untrusted: paths are validated, parents are created one segment at a time and
 * re-checked with `lstat` (no symlink components), files are created exclusively, no link is ever created, modes are
 * reduced to 0644/0755, and `commit` recomputes the hash and the caps from what is on disk before the atomic rename.
 *
 * Pruning is owned here, not by a client (several installs may share a daemon): a tree is deleted when it has not been
 * touched for `pruneAgeDays` and no live session names it, then least recently touched first while over budget.
 * "Touched" is the directory's mtime, set by `sync` (for trees it already has) and `commit`.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  SKILL_LIMITS,
  SKILL_UPLOAD_PATTERN,
  normalizeSkillMode,
  skillTreeHash,
  validateSkillDir,
  validateSkillFilePath,
  validateSkillManifest,
  validateSkillWireFiles,
  type SkillTreeManifest,
  type SkillWireFile,
  type SkillsSyncReply,
} from '../src/protocol/skills';

export class SkillError extends Error {}

/** Staging directories older than this are abandoned uploads. */
const INCOMING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SkillStoreOptions {
  now?: () => number;
  /** Plugin paths named by live sessions; those trees are never pruned. */
  inUse?: () => string[];
  budgetBytes?: number;
  pruneAgeMs?: number;
}

export interface SkillCommitResult {
  dir: string;
  /** False when the tree was already present (an idempotent repeat). */
  created: boolean;
}

interface StagedFile { p: string; m: number; data: Buffer }

export class SkillStore {
  readonly root: string;
  private readonly incoming: string;
  private readonly now: () => number;
  private readonly inUse: () => string[];
  private readonly budgetBytes: number;
  private readonly pruneAgeMs: number;

  constructor(dataDir: string, opts: SkillStoreOptions = {}) {
    this.root = join(dataDir, 'skills');
    this.incoming = join(this.root, '.incoming');
    this.now = opts.now ?? (() => Date.now());
    this.inUse = opts.inUse ?? (() => []);
    this.budgetBytes = opts.budgetBytes ?? SKILL_LIMITS.totalBudgetBytes;
    this.pruneAgeMs = opts.pruneAgeMs ?? SKILL_LIMITS.pruneAgeDays * 86_400_000;
  }

  /** Which of the wanted trees are already here (touching them), and which must be uploaded. */
  sync(trees: unknown): SkillsSyncReply {
    const problem = validateSkillManifest(trees);
    if (problem) throw new SkillError(problem);
    const have: string[] = [];
    const missing: string[] = [];
    for (const t of trees as SkillTreeManifest[]) {
      if (have.includes(t.dir) || missing.includes(t.dir)) continue;
      if (this.isTree(join(this.root, t.dir))) { this.touch(join(this.root, t.dir)); have.push(t.dir); } else missing.push(t.dir);
    }
    return { root: this.root, have, missing };
  }

  /** Stage one chunk. Re-sending a file with identical content is accepted (a retry after a lost ack). */
  put(upload: unknown, dir: unknown, seq: unknown, files: unknown): { received: number } {
    const id = this.checkUpload(upload);
    this.checkDir(dir);
    if (!Number.isInteger(seq) || (seq as number) < 0) throw new SkillError('seq must be a non-negative integer');
    const problem = validateSkillWireFiles(files);
    if (problem) throw new SkillError(problem);
    const list = files as SkillWireFile[];
    const stage = this.stagePath(id);
    this.ensurePrivateDir(this.root);
    this.ensurePrivateDir(this.incoming);
    this.ensurePrivateDir(stage);
    let used = this.treeBytes(stage);
    const seenFolded = new Set<string>();
    for (const f of list) {
      const folded = f.p.toLowerCase();
      if (seenFolded.has(folded)) throw new SkillError(`duplicate path (ignoring case): ${f.p}`);
      seenFolded.add(folded);
      const data = Buffer.from(f.b64, 'base64');
      if (data.length > SKILL_LIMITS.maxBytes) throw new SkillError(`limit: ${f.p} is larger than ${SKILL_LIMITS.maxBytes} bytes`);
      used += data.length;
      if (used > SKILL_LIMITS.maxBytes) throw new SkillError(`limit: tree is larger than ${SKILL_LIMITS.maxBytes} bytes`);
      this.writeStaged(stage, f.p, data, normalizeSkillMode(f.m));
    }
    return { received: list.length };
  }

  /** Verify the staged tree against what the client claims, then move it into place atomically. */
  commit(upload: unknown, dir: unknown, hash: unknown, files: unknown, bytes: unknown): SkillCommitResult {
    const id = this.checkUpload(upload);
    const name = this.checkDir(dir);
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash) || !name.endsWith(`-${hash.slice(0, 12)}`)) throw new SkillError('hash does not match dir');
    if (!Number.isInteger(files) || !Number.isInteger(bytes)) throw new SkillError('files and bytes must be integers');
    const target = join(this.root, name);
    const stage = this.stagePath(id);
    if (this.isTree(target)) {
      // Content addressed: whoever got here first wrote exactly this tree.
      this.discard(stage);
      this.touch(target);
      return { dir: name, created: false };
    }
    if (!this.isRealDir(stage)) throw new SkillError('no such upload (nothing was staged, or it expired)');
    let staged: StagedFile[];
    try {
      staged = this.readStaged(stage);
      if (staged.length > SKILL_LIMITS.maxFiles) throw new SkillError(`limit: more than ${SKILL_LIMITS.maxFiles} files`);
      const total = staged.reduce((n, f) => n + f.data.length, 0);
      if (total > SKILL_LIMITS.maxBytes) throw new SkillError(`limit: tree is larger than ${SKILL_LIMITS.maxBytes} bytes`);
      if (staged.length !== files || total !== bytes) throw new SkillError('file count or size does not match the commit');
      if (skillTreeHash(staged, createHash('sha256')) !== hash) throw new SkillError('hash mismatch');
      if (this.totalBytes() - this.treeBytes(stage) + total > this.budgetBytes) {
        this.prune();
        if (this.totalBytes() - this.treeBytes(stage) + total > this.budgetBytes) throw new SkillError(`limit: synced skills would exceed ${Math.round(this.budgetBytes / 1048576)} MiB`);
      }
    } catch (err) {
      this.discard(stage);
      throw err;
    }
    try {
      renameSync(stage, target);
    } catch (err) {
      this.discard(stage);
      // A concurrent commit of the same tree won the rename.
      if (this.isTree(target)) { this.touch(target); return { dir: name, created: false }; }
      throw err;
    }
    this.touch(target);
    try { this.prune(); } catch { /* housekeeping must not fail a commit */ }
    return { dir: name, created: true };
  }

  /** Delete stale trees and abandoned uploads; trim to the budget, least recently touched first. */
  prune(): { removed: string[] } {
    const removed: string[] = [];
    if (!this.isRealDir(this.root)) return { removed };
    const now = this.now();
    const used = this.usedDirs();
    const trees = readdirSync(this.root)
      .filter((n) => !n.startsWith('.') && this.isRealDir(join(this.root, n)))
      .map((n) => ({ name: n, mtime: lstatSync(join(this.root, n)).mtimeMs }));
    const candidates = trees.filter((t) => !used.has(t.name));
    for (const t of candidates) {
      if (now - t.mtime > this.pruneAgeMs) { this.discard(join(this.root, t.name)); removed.push(t.name); }
    }
    if (this.isRealDir(this.incoming)) {
      for (const n of readdirSync(this.incoming)) {
        const p = join(this.incoming, n);
        let st;
        try { st = lstatSync(p); } catch { continue; }
        if (now - st.mtimeMs > INCOMING_MAX_AGE_MS) this.discard(p);
      }
    }
    // A staged upload is already on disk, so it counts here.
    let over = this.totalBytes() - this.budgetBytes;
    if (over > 0) {
      const lru = candidates.filter((t) => !removed.includes(t.name)).sort((a, b) => a.mtime - b.mtime);
      for (const t of lru) {
        if (over <= 0) break;
        over -= this.treeBytes(join(this.root, t.name));
        this.discard(join(this.root, t.name));
        removed.push(t.name);
      }
    }
    return { removed };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private checkUpload(upload: unknown): string {
    if (typeof upload !== 'string' || !SKILL_UPLOAD_PATTERN.test(upload)) throw new SkillError('upload must be 8-64 characters of letters, digits, "_" or "-"');
    return upload;
  }

  private checkDir(dir: unknown): string {
    const bad = validateSkillDir(dir);
    if (bad) throw new SkillError(bad);
    return dir as string;
  }

  private stagePath(id: string): string { return join(this.incoming, id); }

  private isRealDir(p: string): boolean {
    try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; }
  }

  private isTree(p: string): boolean { return this.isRealDir(p); }

  private ensurePrivateDir(p: string): void {
    try { mkdirSync(p, { mode: 0o700 }); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
    if (!this.isRealDir(p)) throw new SkillError('refusing to use a path that is not a plain directory');
  }

  private touch(p: string): void {
    const t = new Date(this.now());
    try { utimesSync(p, t, t); } catch { /* best effort */ }
  }

  private discard(p: string): void {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  /** Names of top-level trees that a live session's plugin paths point into. */
  private usedDirs(): Set<string> {
    const base = resolve(this.root);
    const out = new Set<string>();
    for (const p of this.inUse()) {
      const r = resolve(p);
      if (r.startsWith(`${base}/`)) out.add(r.slice(base.length + 1).split('/')[0]);
    }
    return out;
  }

  private writeStaged(stage: string, rel: string, data: Buffer, mode: number): void {
    const bad = validateSkillFilePath(rel);
    if (bad) throw new SkillError(`${rel}: ${bad}`);
    const segments = rel.split('/');
    let cur = stage;
    for (const seg of segments.slice(0, -1)) {
      cur = join(cur, seg);
      this.ensurePrivateDir(cur);
    }
    const file = join(cur, segments[segments.length - 1]);
    if (!resolve(file).startsWith(`${resolve(stage)}/`)) throw new SkillError(`${rel}: escapes the upload`);
    try {
      writeFileSync(file, data, { flag: 'wx', mode });
      chmodSync(file, mode);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const st = lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || !readFileSync(file).equals(data)) throw new SkillError(`${rel}: already uploaded with different content`);
    }
  }

  /** Every file in a staged tree. Anything that is not a plain file or directory fails the commit. */
  private readStaged(stage: string): StagedFile[] {
    const out: StagedFile[] = [];
    const folded = new Set<string>();
    const walk = (dir: string, rel: string, depth: number): void => {
      if (depth > SKILL_LIMITS.maxDepth) throw new SkillError(`limit: nested deeper than ${SKILL_LIMITS.maxDepth}`);
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        const p = rel ? `${rel}/${name}` : name;
        const st = lstatSync(abs);
        if (st.isSymbolicLink()) throw new SkillError(`${p}: links are not accepted`);
        if (st.isDirectory()) { walk(abs, p, depth + 1); continue; }
        if (!st.isFile()) throw new SkillError(`${p}: not a regular file`);
        const key = p.toLowerCase();
        if (folded.has(key)) throw new SkillError(`duplicate path (ignoring case): ${p}`);
        folded.add(key);
        out.push({ p, m: st.mode & 0o111 ? 0o755 : 0o644, data: readFileSync(abs) });
        if (out.length > SKILL_LIMITS.maxFiles) throw new SkillError(`limit: more than ${SKILL_LIMITS.maxFiles} files`);
      }
    };
    walk(stage, '', 0);
    return out;
  }

  /** Bytes of regular files under `dir`; links are not followed. */
  private treeBytes(dir: string): number {
    let total = 0;
    const walk = (d: string): void => {
      let names: string[];
      try { names = readdirSync(d); } catch { return; }
      for (const n of names) {
        let st;
        try { st = lstatSync(join(d, n)); } catch { continue; }
        if (st.isDirectory()) walk(join(d, n)); else if (st.isFile()) total += st.size;
      }
    };
    if (existsSync(dir)) walk(dir);
    return total;
  }

  private totalBytes(): number { return this.treeBytes(this.root); }
}

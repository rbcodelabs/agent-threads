/**
 * Skill delivery to a remote daemon (`skills.sync`, `skills.put`, `skills.commit`; additive within v1, admin scope).
 *
 * The client sends a manifest of the skill plugin trees Agent Threads controls; the daemon answers which it already
 * holds, the client uploads the rest in chunks and commits each. A tree is content addressed: its directory name is
 * `<name>-<first 12 hex of its sha256>`, so a retry or a concurrent upload of the same tree is harmless.
 *
 * Pure TypeScript shared by the client (src/remote/skillsSync.ts) and the daemon (daemon/skillStore.ts): the path
 * rules, the limits and the hash live here once so both ends agree. The daemon never trusts the client's copy of them.
 */

/** Advertised in `welcome.capabilities`. A client sends no `skills.*` frame to a daemon without it. */
export const SKILLS_SYNC_CAPABILITY = 'skills.sync';

export const SKILL_LIMITS = {
  /** Per tree; the same numbers as the local daemon's `DEFAULT_TREE_LIMITS`. */
  maxFiles: 2000,
  maxBytes: 20 * 1024 * 1024,
  maxDepth: 12,
  /** Trees in one `skills.sync`. */
  maxTrees: 32,
  maxPathBytes: 512,
  maxSegmentBytes: 255,
  /** Raw payload per `skills.put` frame, well under MAX_FRAME_BYTES. */
  chunkBytes: 1024 * 1024,
  /** Everything under `<dataDir>/skills`. */
  totalBudgetBytes: 256 * 1024 * 1024,
  /** A synced tree not touched for this long and not used by a live session is deleted. */
  pruneAgeDays: 14,
} as const;

/** `<name>-<hash12>`; never starts with a dot (that is reserved for `.incoming`). */
export const SKILL_DIR_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}-[0-9a-f]{12}$/;
export const SKILL_HASH_PATTERN = /^[0-9a-f]{64}$/;
export const SKILL_UPLOAD_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface SkillTreeManifest {
  dir: string;
  /** sha256 hex over the sorted (path, mode, content) of every file. */
  hash: string;
  files: number;
  bytes: number;
}

export interface SkillWireFile {
  /** Relative POSIX path. */
  p: string;
  /** 0o644 or 0o755. */
  m: number;
  /** Content, base64. */
  b64: string;
}

export interface SkillsSyncReply {
  /** Absolute `<dataDir>/skills` on the daemon, so the client can build absolute `pluginPaths`. */
  root: string;
  have: string[];
  missing: string[];
}

/** Only two modes travel: the daemon never trusts a client-chosen mode beyond the executable bit. */
export const normalizeSkillMode = (mode: number): 0o644 | 0o755 => (mode & 0o111 ? 0o755 : 0o644);

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

/** Null when `dir` is a legal tree directory name. */
export function validateSkillDir(dir: unknown): string | null {
  if (typeof dir !== 'string' || !SKILL_DIR_PATTERN.test(dir) || dir.startsWith('.')) return 'dir must look like <name>-<12 hex characters>';
  return null;
}

/** Null when `p` is a safe relative path inside a tree (no escape, no oddities). */
export function validateSkillFilePath(p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0) return 'path must be a non-empty string';
  if (byteLength(p) > SKILL_LIMITS.maxPathBytes) return 'path is too long';
  if (p.includes('\0')) return 'path contains a NUL';
  if (p.includes('\\')) return 'path contains a backslash';
  if (p.startsWith('/')) return 'path must be relative';
  const segments = p.split('/');
  if (segments.length > SKILL_LIMITS.maxDepth + 1) return 'path is nested too deeply';
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..') return 'path has an empty, "." or ".." segment';
    if (byteLength(s) > SKILL_LIMITS.maxSegmentBytes) return 'path segment is too long';
  }
  return null;
}

/** Null when the `trees` of a `skills.sync` are well formed (shape and limits; not the contents). */
export function validateSkillManifest(trees: unknown): string | null {
  if (!Array.isArray(trees)) return 'trees must be an array';
  if (trees.length > SKILL_LIMITS.maxTrees) return `at most ${SKILL_LIMITS.maxTrees} trees per sync`;
  for (let i = 0; i < trees.length; i++) {
    const t: unknown = trees[i];
    if (typeof t !== 'object' || t === null || Array.isArray(t)) return `trees[${i}] must be an object`;
    const { dir, hash, files, bytes } = t as Record<string, unknown>;
    const badDir = validateSkillDir(dir);
    if (badDir) return `trees[${i}]: ${badDir}`;
    if (typeof hash !== 'string' || !SKILL_HASH_PATTERN.test(hash)) return `trees[${i}].hash must be a sha256 hex string`;
    if (!(dir as string).endsWith(`-${hash.slice(0, 12)}`)) return `trees[${i}].dir does not match its hash`;
    if (!Number.isInteger(files) || (files as number) < 0 || (files as number) > SKILL_LIMITS.maxFiles) return `trees[${i}].files is over the limit of ${SKILL_LIMITS.maxFiles}`;
    if (!Number.isInteger(bytes) || (bytes as number) < 0 || (bytes as number) > SKILL_LIMITS.maxBytes) return `trees[${i}].bytes is over the limit of ${SKILL_LIMITS.maxBytes}`;
  }
  return null;
}

/** Null when the `files` of a `skills.put` are well formed. Paths are checked again, per file, by the daemon. */
export function validateSkillWireFiles(files: unknown): string | null {
  if (!Array.isArray(files)) return 'files must be an array';
  if (files.length > SKILL_LIMITS.maxFiles) return `at most ${SKILL_LIMITS.maxFiles} files per frame`;
  for (let i = 0; i < files.length; i++) {
    const f: unknown = files[i];
    if (typeof f !== 'object' || f === null || Array.isArray(f)) return `files[${i}] must be an object`;
    const { p, m, b64 } = f as Record<string, unknown>;
    const bad = validateSkillFilePath(p);
    if (bad) return `files[${i}]: ${bad}`;
    if (typeof m !== 'number' || !Number.isInteger(m)) return `files[${i}].m must be an integer`;
    if (typeof b64 !== 'string') return `files[${i}].b64 must be a string`;
  }
  return null;
}

/** The slice of a node `Hash` this needs, so this file stays free of Node imports (the plugin also runs on mobile). */
export interface Sha256Like {
  update(data: string | Uint8Array): unknown;
  digest(encoding: 'hex'): string;
}

/**
 * sha256 over the files sorted by path: for each, `path NUL mode NUL length NUL` then the bytes. Modes are normalised
 * first. Independent of mtimes, which do not survive a copy between machines.
 */
export function skillTreeHash(files: ReadonlyArray<{ p: string; m: number; data: Uint8Array }>, hasher: Sha256Like): string {
  const sorted = [...files].sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  for (const f of sorted) {
    hasher.update(`${f.p}\0${normalizeSkillMode(f.m).toString(8)}\0${f.data.length}\0`);
    hasher.update(f.data);
  }
  return hasher.digest('hex');
}

/** Directory name for a tree: the source folder's last two segments (readable in logs) plus the hash prefix. */
export function skillDirName(sourcePath: string, hash: string): string {
  const base = sourcePath.split('/').filter(Boolean).slice(-2).join('-').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 48) || 'skills';
  return `${base}-${hash.slice(0, 12)}`;
}

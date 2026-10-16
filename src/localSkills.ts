import fs from 'fs';
import * as fsp from 'fs/promises';
import path from 'path';
import type { YamlParser } from './host/YamlParser';
import os from 'os';
import type { SkillSource } from './types';

export function externalSkillRoots(sources: SkillSource[] = []): string[] {
  return sources.map(source => source.type === 'github' ? source.clonePath : source.skillsPath)
    .filter((value): value is string => !!value).map(value => value.replace(/^~(?=\/|$)/, os.homedir()));
}

export interface LocalSkillFile { path: string; encoding: 'utf8' | 'base64'; content: string }
export interface CreateLocalSkillInput { skillId: string; skillMd: string; files?: LocalSkillFile[] }
export interface UpdateLocalSkillInput { skillId: string; files?: LocalSkillFile[]; deleteFiles?: string[] }
export interface LocalSkillResult { skillId: string; path: string; availability: 'next-session' }

function relativePath(value: string): string {
  if (typeof value !== 'string' || !value || /[\\\x00-\x1f:]/.test(value) || path.isAbsolute(value)
    || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw new Error('Expected a contained, package-relative path');
  }
  return value;
}

function exists(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function noSymlinks(base: string, target: string): void {
  const rel = path.relative(base, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Path escapes root');
  let current = base;
  for (const component of ['', ...rel.split(path.sep).filter(Boolean)]) {
    current = path.join(current, component);
    if (exists(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Symlinks are not supported in local skill paths');
  }
}

function canonicalFuturePath(value: string): string {
  let ancestor = path.resolve(value);
  while (!exists(ancestor)) ancestor = path.dirname(ancestor);
  // The native resolver preserves the filesystem's canonical spelling on
  // case-insensitive macOS volumes; realpathSync's JS implementation does not.
  return path.join(fs.realpathSync.native(ancestor), path.relative(ancestor, path.resolve(value)));
}

export function resolveLocalSkillsRoot(vaultRoot: string, folder = 'Skills', excludedRoots: string[] = []): string {
  if (!vaultRoot || !path.isAbsolute(vaultRoot)) throw new Error('A filesystem vault root is required');
  const relative = relativePath(folder.replace(/\/$/, ''));
  if (relative.split('/').some(part => part.startsWith('.'))) throw new Error('Local skills cannot use hidden configuration folders');
  const base = fs.realpathSync.native(vaultRoot);
  const lexicalRoot = path.resolve(base, relative);
  noSymlinks(base, lexicalRoot);
  const root = canonicalFuturePath(lexicalRoot);
  for (const excluded of excludedRoots) {
    const source = canonicalFuturePath(excluded);
    if (root === source || root.startsWith(source + path.sep) || source.startsWith(root + path.sep)) {
      throw new Error('Local skills folder overlaps a configured external source');
    }
  }
  return root;
}

function validateManifest(content: string, skillId: string, yaml: YamlParser): void {
  const match = typeof content === 'string' && /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw new Error('SKILL.md requires YAML frontmatter');
  let parsed: unknown;
  try { parsed = yaml.parse(match[1]); } catch { throw new Error('Invalid SKILL.md YAML frontmatter'); }
  const data = parsed as Record<string, unknown> | null;
  if (!data || Array.isArray(data) || typeof data !== 'object' || data.name !== skillId
    || typeof data.description !== 'string' || !data.description.trim()) {
    throw new Error('SKILL.md frontmatter requires name matching skillId and a nonempty description');
  }
}

function decode(file: LocalSkillFile): Buffer {
  if (typeof file.content !== 'string') throw new Error('File content must be a string');
  if (file.encoding === 'utf8') return Buffer.from(file.content, 'utf8');
  if (file.encoding !== 'base64' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) {
    throw new Error('Invalid base64 file content');
  }
  const bytes = Buffer.from(file.content, 'base64');
  if (bytes.toString('base64') !== file.content) throw new Error('Invalid base64 file content');
  return bytes;
}

const pending = new Map<string, Promise<void>>();
async function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = pending.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  pending.set(key, current);
  await previous;
  try { return await work(); } finally { release(); if (pending.get(key) === current) pending.delete(key); }
}

async function copyPackage(from: string, to: string): Promise<void> {
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not supported in local skill packages');
    if (entry.isDirectory()) { await fsp.mkdir(destination); await copyPackage(source, destination); }
    else if (entry.isFile()) { await fsp.copyFile(source, destination); }
    else throw new Error('Only regular files and directories are supported');
  }
}

async function mutate(root: string, input: UpdateLocalSkillInput, creating: boolean, yaml: YamlParser): Promise<LocalSkillResult> {
  if (!root || !path.isAbsolute(root)) throw new Error('A resolved local skills root is required');
  if (typeof input.skillId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.skillId) || input.skillId.length > 64) {
    throw new Error('skillId must be a lowercase slug of at most 64 characters');
  }
  const files = input.files ?? [];
  const deletions = input.deleteFiles ?? [];
  const seen = new Set<string>();
  for (const name of [...files.map(file => file.path), ...deletions]) {
    relativePath(name);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate or conflicting package paths');
    if (key === 'skill.md' && name !== 'SKILL.md') throw new Error('Use the exact SKILL.md filename');
    seen.add(key);
  }
  if (deletions.some(name => name.toLowerCase() === 'skill.md')) throw new Error('Cannot delete SKILL.md');
  const contents = files.map(file => ({ path: file.path, bytes: decode(file) }));
  const resolved = path.resolve(root);
  let ancestor = path.dirname(resolved);
  while (!exists(ancestor)) ancestor = path.dirname(ancestor);
  const parent = fs.realpathSync(ancestor);
  const safeRoot = path.join(parent, path.relative(ancestor, resolved));
  noSymlinks(parent, safeRoot);
  await fsp.mkdir(safeRoot, { recursive: true });
  const canonicalRoot = fs.realpathSync(safeRoot);
  const target = path.join(canonicalRoot, input.skillId);
  return locked(target, async () => {
    noSymlinks(canonicalRoot, target);
    if (creating && exists(target)) throw new Error('Local skill already exists');
    if (!creating && (!exists(target) || !fs.statSync(target).isDirectory())) throw new Error('Local skill does not exist');
    const stage = await fsp.mkdtemp(path.join(canonicalRoot, '.local-skill-'));
    const payload = path.join(stage, 'package');
    const backup = path.join(stage, 'backup');
    let movedOriginal = false;
    try {
      await fsp.mkdir(payload);
      if (!creating) await copyPackage(target, payload);
      for (const file of contents) {
        const destination = path.join(payload, file.path);
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        await fsp.writeFile(destination, file.bytes);
      }
      for (const name of deletions) await fsp.rm(path.join(payload, name), { recursive: true, force: true });
      validateManifest(await fsp.readFile(path.join(payload, 'SKILL.md'), 'utf8'), input.skillId, yaml);
      noSymlinks(canonicalRoot, target);
      if (!creating) { await fsp.rename(target, backup); movedOriginal = true; }
      else if (exists(target)) throw new Error('Local skill already exists');
      try { await fsp.rename(payload, target); }
      catch (error) {
        if (movedOriginal) { await fsp.rename(backup, target); movedOriginal = false; }
        throw error;
      }
      movedOriginal = false;
      return { skillId: input.skillId, path: target, availability: 'next-session' };
    } finally {
      // If rollback itself fails, preserve the backup for recovery.
      if (!movedOriginal) {
        try { await fsp.rm(stage, { recursive: true, force: true }); }
        catch (error) {
          // Cleanup cannot undo a completed commit or replace the original write error.
          console.warn('[ClaudeThreads] Local skill staging cleanup failed; remaining files retained at:', stage, error);
        }
      }
    }
  });
}

export async function createLocalSkill(root: string, input: CreateLocalSkillInput, yaml: YamlParser): Promise<LocalSkillResult> {
  validateManifest(input.skillMd, input.skillId, yaml);
  return mutate(root, { skillId: input.skillId, files: [{ path: 'SKILL.md', encoding: 'utf8', content: input.skillMd }, ...(input.files ?? [])] }, true, yaml);
}

export async function updateLocalSkill(root: string, input: UpdateLocalSkillInput, yaml: YamlParser): Promise<LocalSkillResult> {
  return mutate(root, input, false, yaml);
}

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillError, SkillStore } from '../../daemon/skillStore';
import { SKILL_LIMITS } from '../../src/protocol/skills';
import { wireTree } from '../helpers/skillTree';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'skillstore-')); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

const UP = 'upload-0001';
const store = (opts: ConstructorParameters<typeof SkillStore>[1] = {}) => new SkillStore(dataDir, opts);
const stage = (id = UP) => join(dataDir, 'skills', '.incoming', id);

function install(s: SkillStore, name: string, files: Record<string, string>, modes: Record<string, number> = {}, upload = UP) {
  const t = wireTree(name, files, modes);
  s.put(upload, t.manifest.dir, 0, t.wire);
  s.commit(upload, t.commit.dir, t.commit.hash, t.commit.files, t.commit.bytes);
  return t;
}

describe('sync / put / commit', () => {
  it('lands a tree under <dataDir>/skills/<dir>, reports it as present on the next sync, and masks modes', () => {
    const s = store();
    const t = wireTree('demo', { 'SKILL.md': 'hello', 'bin/run.sh': '#!/bin/sh' }, { 'bin/run.sh': 0o4755 });
    expect(s.sync([t.manifest])).toEqual({ root: join(dataDir, 'skills'), have: [], missing: [t.manifest.dir] });
    s.put(UP, t.manifest.dir, 0, t.wire);
    expect(s.commit(UP, t.commit.dir, t.commit.hash, t.commit.files, t.commit.bytes)).toEqual({ dir: t.manifest.dir, created: true });
    const base = join(dataDir, 'skills', t.manifest.dir);
    expect(readFileSync(join(base, 'SKILL.md'), 'utf8')).toBe('hello');
    expect(statSync(join(base, 'bin/run.sh')).mode & 0o7777).toBe(0o755);
    expect(statSync(join(base, 'SKILL.md')).mode & 0o7777).toBe(0o644);
    expect(existsSync(stage())).toBe(false);
    expect(s.sync([t.manifest])).toMatchObject({ have: [t.manifest.dir], missing: [] });
  });

  it('commit is idempotent and a duplicate put of identical content is accepted', () => {
    const s = store();
    const t = install(s, 'demo', { 'a.md': 'x' });
    expect(s.commit('upload-0002', t.commit.dir, t.commit.hash, t.commit.files, t.commit.bytes)).toEqual({ dir: t.manifest.dir, created: false });
    const t2 = wireTree('other', { 'a.md': 'y' });
    s.put('upload-0003', t2.manifest.dir, 0, t2.wire);
    expect(() => s.put('upload-0003', t2.manifest.dir, 0, t2.wire)).not.toThrow();
    expect(() => s.put('upload-0003', t2.manifest.dir, 1, [{ ...t2.wire[0], b64: Buffer.from('z').toString('base64') }])).toThrow(/different content/);
  });

  it('accepts a tree sent in several chunks', () => {
    const s = store();
    const t = wireTree('multi', { 'a.md': '1', 'b.md': '2', 'c/d.md': '3' });
    t.wire.forEach((f, i) => s.put(UP, t.manifest.dir, i, [f]));
    expect(s.commit(UP, t.commit.dir, t.commit.hash, t.commit.files, t.commit.bytes).created).toBe(true);
  });

  it('a hash mismatch deletes the staging directory and installs nothing', () => {
    const s = store();
    const t = wireTree('demo', { 'a.md': 'x' });
    s.put(UP, t.manifest.dir, 0, [{ ...t.wire[0], b64: Buffer.from('tampered').toString('base64') }]);
    expect(() => s.commit(UP, t.commit.dir, t.commit.hash, t.commit.files, t.commit.bytes)).toThrow(/mismatch|size/);
    expect(existsSync(stage())).toBe(false);
    expect(existsSync(join(dataDir, 'skills', t.manifest.dir))).toBe(false);
  });

  it('refuses a commit whose counts disagree, a dir that does not match its hash, and an unknown upload', () => {
    const s = store();
    const t = wireTree('demo', { 'a.md': 'x' });
    s.put(UP, t.manifest.dir, 0, t.wire);
    expect(() => s.commit(UP, t.commit.dir, t.commit.hash, 2, t.commit.bytes)).toThrow(SkillError);
    expect(() => s.commit(UP, 'demo-000000000000', t.commit.hash, 1, t.commit.bytes)).toThrow(/hash/);
    expect(() => s.commit('nonexistent1', t.commit.dir, t.commit.hash, 1, t.commit.bytes)).toThrow(/no such upload/);
  });
});

describe('paths the client must not be able to write', () => {
  const t = wireTree('demo', { 'a.md': 'x' });
  const put = (p: string, upload = UP) => store().put(upload, t.manifest.dir, 0, [{ p, m: 0o644, b64: '' }]);

  it.each(['../escape', '/abs/path', 'a/../../b', 'a\\b', 'a//b', './a', 'a\0b', 'x/'.repeat(14) + 'f'])('refuses %j', (p) => {
    expect(() => put(p)).toThrow(SkillError);
    expect(existsSync(join(dataDir, 'escape'))).toBe(false);
    expect(existsSync(join(dataDir, 'skills', 'escape'))).toBe(false);
  });

  it('refuses case-folded duplicates in one frame', () => {
    expect(() => store().put(UP, t.manifest.dir, 0, [{ p: 'A.md', m: 0o644, b64: '' }, { p: 'a.md', m: 0o644, b64: '' }])).toThrow(/duplicate/);
  });

  it('refuses a bad upload id and a bad dir', () => {
    expect(() => put('a.md', '../../x')).toThrow(/upload/);
    expect(() => store().put(UP, '../x-0123456789ab', 0, [])).toThrow(/dir/);
    expect(() => store().put(UP, '.incoming-0123456789ab', 0, [])).toThrow(/dir/);
  });

  it('does not follow a symlinked parent planted in the staging directory', () => {
    const s = store();
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    try {
      mkdirSync(stage(), { recursive: true });
      symlinkSync(outside, join(stage(), 'link'));
      expect(() => s.put(UP, t.manifest.dir, 0, [{ p: 'link/pwned.md', m: 0o644, b64: Buffer.from('x').toString('base64') }])).toThrow(SkillError);
      expect(existsSync(join(outside, 'pwned.md'))).toBe(false);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it('does not write through a symlinked file or accept a staged tree containing a link', () => {
    const s = store();
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    try {
      writeFileSync(join(outside, 'target'), 'keep');
      mkdirSync(stage(), { recursive: true });
      symlinkSync(join(outside, 'target'), join(stage(), 'a.md'));
      expect(() => s.put(UP, t.manifest.dir, 0, [{ p: 'a.md', m: 0o644, b64: Buffer.from('overwrite').toString('base64') }])).toThrow(SkillError);
      expect(readFileSync(join(outside, 'target'), 'utf8')).toBe('keep');
      expect(() => s.commit(UP, t.commit.dir, t.commit.hash, 1, 1)).toThrow(/links/);
      expect(existsSync(stage())).toBe(false);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it('refuses a symlinked skills/.incoming directory', () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    try {
      mkdirSync(join(dataDir, 'skills'), { recursive: true });
      symlinkSync(outside, join(dataDir, 'skills', '.incoming'));
      expect(() => store().put(UP, t.manifest.dir, 0, [{ p: 'a.md', m: 0o644, b64: '' }])).toThrow(SkillError);
      expect(readdirSync(outside)).toEqual([]);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});

describe('caps', () => {
  it('refuses a manifest over the file or byte cap, a sync of too many trees, and a staged tree over the cap', () => {
    const s = store();
    const t = wireTree('demo', { 'a.md': 'x' });
    expect(() => s.sync([{ ...t.manifest, files: SKILL_LIMITS.maxFiles + 1 }])).toThrow(SkillError);
    expect(() => s.sync(Array.from({ length: SKILL_LIMITS.maxTrees + 1 }, () => t.manifest))).toThrow(SkillError);
    // 2001 tiny files in a staging directory: the commit refuses before hashing.
    const dir = stage();
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i <= SKILL_LIMITS.maxFiles; i++) writeFileSync(join(dir, `f${i}`), '');
    expect(() => s.commit(UP, t.commit.dir, t.commit.hash, 1, 1)).toThrow(/limit/);
  });

  it('accepts exactly the file cap', () => {
    const s = store();
    const files = Object.fromEntries(Array.from({ length: SKILL_LIMITS.maxFiles }, (_, i) => [`f${i}`, 'x']));
    const t = wireTree('full', files);
    for (let i = 0; i < t.wire.length; i += 500) s.put(UP, t.manifest.dir, i, t.wire.slice(i, i + 500));
    expect(s.commit(UP, t.commit.dir, t.commit.hash, t.commit.files, t.commit.bytes).created).toBe(true);
  });

  it('refuses a put whose content passes the byte cap', () => {
    const s = store();
    const t = wireTree('big', { 'a.md': 'x' });
    const big = Buffer.alloc(SKILL_LIMITS.maxBytes / 2 + 1).toString('base64');
    s.put(UP, t.manifest.dir, 0, [{ p: 'a', m: 0o644, b64: big }]);
    expect(() => s.put(UP, t.manifest.dir, 1, [{ p: 'b', m: 0o644, b64: big }])).toThrow(/limit/);
  });

  it('fails a commit that would exceed the total budget, after trying to prune', () => {
    const now = Date.now();
    const s = store({ budgetBytes: 100, now: () => now });
    install(s, 'first', { 'a.md': 'x'.repeat(60) });
    // The first tree is unused but recent, so it stays and the second does not fit.
    const t = wireTree('second', { 'a.md': 'y'.repeat(60) });
    s.put('upload-0002', t.manifest.dir, 0, t.wire);
    // Over budget only matters once nothing evictable remains; the first tree is evictable (not in use), so it goes.
    expect(s.commit('upload-0002', t.commit.dir, t.commit.hash, t.commit.files, t.commit.bytes).created).toBe(true);
    const inUse = store({ budgetBytes: 100, inUse: () => [join(dataDir, 'skills', t.manifest.dir)] });
    const t3 = wireTree('third', { 'a.md': 'z'.repeat(60) });
    inUse.put('upload-0003', t3.manifest.dir, 0, t3.wire);
    expect(() => inUse.commit('upload-0003', t3.commit.dir, t3.commit.hash, t3.commit.files, t3.commit.bytes)).toThrow(/limit/);
    expect(existsSync(stage('upload-0003'))).toBe(false);
  });
});

describe('prune', () => {
  const DAY = 86_400_000;
  const age = (dir: string, days: number) => {
    const t = new Date(Date.now() - days * DAY);
    utimesSync(join(dataDir, 'skills', dir), t, t);
  };

  it('removes old unreferenced trees, keeps recent ones and ones a live session uses, and clears old staging', () => {
    const live = new Set<string>();
    const s = store({ inUse: () => [...live] });
    const old = install(s, 'old', { 'a.md': '1' }, {}, 'upload-old1');
    const recent = install(s, 'recent', { 'a.md': '2' }, {}, 'upload-new1');
    const used = install(s, 'used', { 'a.md': '3' }, {}, 'upload-use1');
    age(old.manifest.dir, 15);
    age(used.manifest.dir, 30);
    live.add(join(dataDir, 'skills', used.manifest.dir));
    mkdirSync(stage('abandoned1'), { recursive: true });
    const t = new Date(Date.now() - 2 * DAY);
    utimesSync(stage('abandoned1'), t, t);
    const { removed } = s.prune();
    expect(removed).toEqual([old.manifest.dir]);
    expect(readdirSync(join(dataDir, 'skills')).filter((n) => !n.startsWith('.')).sort()).toEqual([recent.manifest.dir, used.manifest.dir].sort());
    expect(existsSync(stage('abandoned1'))).toBe(false);
  });

  it('trims least recently used first when over budget, never a tree in use', () => {
    const live = new Set<string>();
    const s = store({ budgetBytes: 150, inUse: () => [...live] });
    const a = install(s, 'a', { 'f': 'x'.repeat(50) }, {}, 'upload-aaa1');
    const b = install(s, 'b', { 'f': 'y'.repeat(50) }, {}, 'upload-bbb1');
    const c = install(s, 'c', { 'f': 'z'.repeat(50) }, {}, 'upload-ccc1');
    age(a.manifest.dir, 3);
    age(b.manifest.dir, 2);
    live.add(join(dataDir, 'skills', a.manifest.dir));
    const d = wireTree('d', { 'f': 'w'.repeat(50) });
    s.put('upload-ddd1', d.manifest.dir, 0, d.wire);
    s.commit('upload-ddd1', d.commit.dir, d.commit.hash, d.commit.files, d.commit.bytes);
    const left = readdirSync(join(dataDir, 'skills')).filter((n) => !n.startsWith('.'));
    expect(left).toContain(a.manifest.dir);
    expect(left).not.toContain(b.manifest.dir);
    expect(left).toContain(d.manifest.dir);
    expect(left).toContain(c.manifest.dir);
  });

  it('sync touches a tree it already has, so an in-use-by-intent tree is not pruned next', () => {
    const s = store();
    const t = install(s, 'a', { 'a.md': '1' });
    age(t.manifest.dir, 20);
    s.sync([t.manifest]);
    expect(Date.now() - lstatSync(join(dataDir, 'skills', t.manifest.dir)).mtimeMs).toBeLessThan(DAY);
    expect(s.prune().removed).toEqual([]);
  });
});

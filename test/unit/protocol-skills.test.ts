import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeClientFrame } from '../../src/protocol';
import { SKILL_LIMITS, normalizeSkillMode, skillDirName, skillTreeHash, validateSkillDir, validateSkillFilePath, validateSkillManifest } from '../../src/protocol/skills';
import { wireTree } from '../helpers/skillTree';

describe('validateSkillFilePath', () => {
  const bad = ['', '/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'a/.', 'a\\b', 'a\0b', `${'x'.repeat(256)}`, `${'a/'.repeat(300)}b`, 'a/'.repeat(SKILL_LIMITS.maxDepth + 1) + 'f'];
  it.each(bad)('refuses %j', (p) => { expect(validateSkillFilePath(p)).not.toBeNull(); });
  it('accepts ordinary nested paths and the deepest allowed one', () => {
    expect(validateSkillFilePath('SKILL.md')).toBeNull();
    expect(validateSkillFilePath('scripts/run.sh')).toBeNull();
    expect(validateSkillFilePath(`${'d/'.repeat(SKILL_LIMITS.maxDepth)}f`)).toBeNull();
    expect(validateSkillFilePath('x'.repeat(255))).toBeNull();
  });
});

describe('validateSkillDir', () => {
  it.each(['a/b-0123456789ab', '.hidden-0123456789ab', 'x-0123456789AB', 'x-0123456789a', '..-0123456789ab', '', 'x'.repeat(81) + '-0123456789ab'])('refuses %j', (d) => {
    expect(validateSkillDir(d)).not.toBeNull();
  });
  it('accepts <name>-<hash12>', () => { expect(validateSkillDir('my.skills_x-0123456789ab')).toBeNull(); });
});

describe('skillTreeHash and skillDirName', () => {
  it('is independent of file order and of the executable bits other than 0111', () => {
    const a = wireTree('s', { 'a.md': '1', 'b/c.md': '2' }).manifest.hash;
    const files = [{ p: 'b/c.md', m: 0o600, data: Buffer.from('2') }, { p: 'a.md', m: 0o666, data: Buffer.from('1') }];
    expect(skillTreeHash(files, createHash('sha256'))).toBe(a);
  });
  it('changes with content, path and the executable bit', () => {
    const base = wireTree('s', { 'a.md': '1' }).manifest.hash;
    expect(wireTree('s', { 'a.md': '2' }).manifest.hash).not.toBe(base);
    expect(wireTree('s', { 'b.md': '1' }).manifest.hash).not.toBe(base);
    expect(wireTree('s', { 'a.md': '1' }, { 'a.md': 0o755 }).manifest.hash).not.toBe(base);
    expect(normalizeSkillMode(0o700)).toBe(0o755);
    expect(normalizeSkillMode(0o600)).toBe(0o644);
  });
  it('names a directory from the last two segments and the hash prefix', () => {
    const name = skillDirName('/home/u/vault/.geode/plugins/x/skills', 'abcdef0123456789'.repeat(4));
    expect(name).toBe('x-skills-abcdef012345');
    expect(validateSkillDir(name)).toBeNull();
    expect(validateSkillDir(skillDirName('/.hidden', 'a'.repeat(64)))).toBeNull();
  });
});

describe('validateSkillManifest and the codec', () => {
  const t = wireTree('s', { 'a.md': '1' });
  it('accepts a good manifest and refuses one whose dir does not match its hash', () => {
    expect(validateSkillManifest([t.manifest])).toBeNull();
    expect(validateSkillManifest([{ ...t.manifest, dir: 's-000000000000' }])).toMatch(/match/);
  });
  it('enforces the per-sync and per-tree caps at the boundary', () => {
    const many = Array.from({ length: SKILL_LIMITS.maxTrees }, () => t.manifest);
    expect(validateSkillManifest(many)).toBeNull();
    expect(validateSkillManifest([...many, t.manifest])).toMatch(/at most/);
    expect(validateSkillManifest([{ ...t.manifest, files: SKILL_LIMITS.maxFiles }])).toBeNull();
    expect(validateSkillManifest([{ ...t.manifest, files: SKILL_LIMITS.maxFiles + 1 }])).toMatch(/files/);
    expect(validateSkillManifest([{ ...t.manifest, bytes: SKILL_LIMITS.maxBytes }])).toBeNull();
    expect(validateSkillManifest([{ ...t.manifest, bytes: SKILL_LIMITS.maxBytes + 1 }])).toMatch(/bytes/);
  });
  it('decodes the three frames and rejects a bad path in a put', () => {
    const frame = (o: object) => JSON.stringify({ v: 1, cmdId: 'c', ...o });
    expect(decodeClientFrame(frame({ type: 'skills.sync', trees: [t.manifest] })).ok).toBe(true);
    expect(decodeClientFrame(frame({ type: 'skills.put', upload: 'u1234567', dir: t.manifest.dir, seq: 0, files: t.wire })).ok).toBe(true);
    expect(decodeClientFrame(frame({ type: 'skills.commit', upload: 'u1234567', ...t.commit })).ok).toBe(true);
    const evil = decodeClientFrame(frame({ type: 'skills.put', upload: 'u1234567', dir: t.manifest.dir, seq: 0, files: [{ p: '../x', m: 0o644, b64: '' }] }));
    expect(evil.ok).toBe(false);
  });
});

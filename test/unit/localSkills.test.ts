import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import * as fsp from 'fs/promises';
import os from 'os';
import path from 'path';
vi.mock('fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('fs/promises')>() }));
import {
  createLocalSkill as createLocalSkillWith,
  updateLocalSkill as updateLocalSkillWith,
  resolveLocalSkillsRoot,
  type CreateLocalSkillInput,
  type UpdateLocalSkillInput,
} from '../../src/localSkills';
import type { YamlParser } from '../../src/host/YamlParser';

// JSON is valid YAML; the host owns YAML parsing (src/host/YamlParser), this suite exercises its contract.
const yaml: YamlParser = { parse: (text) => JSON.parse(text) };
const createLocalSkill = (root: string, input: CreateLocalSkillInput) => createLocalSkillWith(root, input, yaml);
const updateLocalSkill = (root: string, input: UpdateLocalSkillInput) => updateLocalSkillWith(root, input, yaml);

const manifest = '---\n{"name":"example","description":"An example skill"}\n---\n# Instructions\n';
let vault: string;
let root: string;
beforeEach(() => { vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-skills-test-'))); root = path.join(vault, 'Skills'); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(vault, { recursive: true, force: true }); });
const textFile = (filePath: string, content = 'hello') => ({ path: filePath, encoding: 'utf8' as const, content });

describe('local skill packages', () => {
  it('rejects an unavailable root rather than writing to cwd', async () => {
    await expect(createLocalSkill('', { skillId: 'example', skillMd: manifest })).rejects.toThrow(/root/i);
  });
  it('rejects an unavailable vault and hidden configuration folders', () => {
    expect(() => resolveLocalSkillsRoot('', 'Skills')).toThrow();
    expect(() => resolveLocalSkillsRoot(vault, '.obsidian/plugins/test/skills')).toThrow();
  });
  it('rejects an authored root overlapping an external source', () => {
    expect(() => resolveLocalSkillsRoot(vault, 'Sources', [path.join(vault, 'Sources', 'team')])).toThrow(/source/i);
    expect(() => resolveLocalSkillsRoot(vault, 'Sources/team/skills', [path.join(vault, 'Sources', 'team')])).toThrow(/source/i);
  });
  it('resolves existing folder spelling before testing source overlap', () => {
    const source = path.join(vault, 'Sources'); fs.mkdirSync(source);
    const alias = path.join(vault, 'sources');
    if (fs.existsSync(alias)) expect(() => resolveLocalSkillsRoot(vault, 'sources', [source])).toThrow(/source/i);
    else expect(resolveLocalSkillsRoot(vault, 'sources', [source])).toBe(alias);
  });
  it('creates complete packages including binary resources', async () => {
    const result = await createLocalSkill(root, { skillId: 'example', skillMd: manifest, files: [textFile('references/guide.md'), { path: 'assets/icon.bin', encoding: 'base64', content: 'AP+A' }] });
    expect(result).toEqual({ skillId: 'example', path: path.join(root, 'example'), availability: 'next-session' });
    expect(fs.readFileSync(path.join(result.path, 'assets/icon.bin'))).toEqual(Buffer.from([0, 255, 128]));
  });
  it('patches supplied files, preserves others and explicitly deletes resources', async () => {
    await createLocalSkill(root, { skillId: 'example', skillMd: manifest, files: [textFile('keep'), textFile('delete')] });
    await updateLocalSkill(root, { skillId: 'example', files: [textFile('new')], deleteFiles: ['delete'] });
    expect(fs.readdirSync(path.join(root, 'example')).sort()).toEqual(['SKILL.md', 'keep', 'new']);
  });
  it('serializes concurrent patches without losing either change', async () => {
    await createLocalSkill(root, { skillId: 'example', skillMd: manifest });
    await Promise.all(['a', 'b'].map(p => updateLocalSkill(root, { skillId: 'example', files: [textFile(p)] })));
    expect(fs.readdirSync(path.join(root, 'example')).sort()).toEqual(['SKILL.md', 'a', 'b']);
  });
  it('allows exactly one concurrent creation', async () => {
    const outcomes = await Promise.allSettled([1, 2].map(() => createLocalSkill(root, { skillId: 'example', skillMd: manifest })));
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  });
  it('preserves the original manifest when replacement validation fails', async () => {
    await createLocalSkill(root, { skillId: 'example', skillMd: manifest });
    await expect(updateLocalSkill(root, { skillId: 'example', files: [textFile('SKILL.md', '# Invalid')] })).rejects.toThrow(/frontmatter/);
    expect(fs.readFileSync(path.join(root, 'example', 'SKILL.md'), 'utf8')).toBe(manifest);
  });
  it('rejects a filesystem read-only destination without losing existing files', async () => {
    await createLocalSkill(root, { skillId: 'example', skillMd: manifest });
    fs.chmodSync(root, 0o500);
    try {
      await expect(updateLocalSkill(root, { skillId: 'example', files: [textFile('new')] })).rejects.toThrow();
      expect(fs.readdirSync(path.join(root, 'example'))).toEqual(['SKILL.md']);
    } finally { fs.chmodSync(root, 0o700); }
  });
  it('rejects duplicate creation and missing update', async () => {
    await expect(updateLocalSkill(root, { skillId: 'example' })).rejects.toThrow();
    await createLocalSkill(root, { skillId: 'example', skillMd: manifest });
    await expect(createLocalSkill(root, { skillId: 'example', skillMd: manifest })).rejects.toThrow(/exists/);
  });
  it.each(['../escape', '/absolute', 'a\\b', 'a/../b', 'SKILL.md', 'skill.md', 'a//b'])('rejects unsafe or conflicting creation path %s', async (p) => {
    await expect(createLocalSkill(root, { skillId: 'example', skillMd: manifest, files: [textFile(p)] })).rejects.toThrow();
  });
  it.each(['../escape', 'Bad Name', '', 'a/b'])('rejects invalid identifier %s', async skillId => {
    await expect(createLocalSkill(root, { skillId, skillMd: manifest })).rejects.toThrow();
  });
  it.each(['SKILL.md', 'skill.md', './SKILL.md'])('rejects deleting manifest alias %s', async p => {
    await createLocalSkill(root, { skillId: 'example', skillMd: manifest });
    await expect(updateLocalSkill(root, { skillId: 'example', deleteFiles: [p] })).rejects.toThrow();
  });
  it.each(['# Missing', '---\n{bad}\n---', '---\n{"name":"example"}\n---'])('rejects invalid manifest %s', async skillMd => {
    await expect(createLocalSkill(root, { skillId: 'example', skillMd })).rejects.toThrow();
  });
  it('rejects invalid base64', async () => {
    await expect(createLocalSkill(root, { skillId: 'example', skillMd: manifest, files: [{ path: 'binary', encoding: 'base64', content: '!!!' }] })).rejects.toThrow(/base64/);
  });
  it('rejects package symlinks', async () => {
    await createLocalSkill(root, { skillId: 'example', skillMd: manifest });
    fs.symlinkSync(vault, path.join(root, 'example', 'escape'));
    await expect(updateLocalSkill(root, { skillId: 'example', files: [textFile('escape/write')] })).rejects.toThrow(/symlink/i);
  });
  it('rolls back when committing a staged package fails', async () => {
    await createLocalSkill(root, { skillId: 'example', skillMd: manifest });
    const rename = fsp.rename;
    let calls = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (...args) => { if (++calls === 2) throw new Error('write failed'); return rename(...args); });
    await expect(updateLocalSkill(root, { skillId: 'example', files: [textFile('new')] })).rejects.toThrow('write failed');
    expect(fs.readdirSync(path.join(root, 'example'))).toEqual(['SKILL.md']);
  });
  it('preserves original package on a staging write failure', async () => {
    await createLocalSkill(root, { skillId: 'example', skillMd: manifest });
    vi.spyOn(fsp, 'writeFile').mockRejectedValue(new Error('read-only'));
    await expect(updateLocalSkill(root, { skillId: 'example', files: [textFile('new')] })).rejects.toThrow('read-only');
    expect(fs.readFileSync(path.join(root, 'example', 'SKILL.md'), 'utf8')).toBe(manifest);
  });
  it('reports a successful commit when staging cleanup fails', async () => {
    await createLocalSkill(root, { skillId: 'example', skillMd: manifest });
    vi.spyOn(fsp, 'rm').mockRejectedValue(new Error('cleanup failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(updateLocalSkill(root, { skillId: 'example', files: [textFile('new')] })).resolves.toMatchObject({ availability: 'next-session' });
    expect(fs.readFileSync(path.join(root, 'example', 'new'), 'utf8')).toBe('hello');
    const stage = fs.readdirSync(root).find(name => name.startsWith('.local-skill-'))!;
    expect(fs.readFileSync(path.join(root, stage, 'backup', 'SKILL.md'), 'utf8')).toBe(manifest);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cleanup'), path.join(root, stage), expect.any(Error));
  });
  it('preserves the original write error when staging cleanup also fails', async () => {
    await createLocalSkill(root, { skillId: 'example', skillMd: manifest });
    vi.spyOn(fsp, 'writeFile').mockRejectedValue(new Error('original write failure'));
    vi.spyOn(fsp, 'rm').mockRejectedValue(new Error('cleanup failed'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(updateLocalSkill(root, { skillId: 'example', files: [textFile('new')] })).rejects.toThrow('original write failure');
    expect(fs.readFileSync(path.join(root, 'example', 'SKILL.md'), 'utf8')).toBe(manifest);
  });
});
describe('local root', () => {
  it('resolves default and nested custom vault folders', () => {
    expect(resolveLocalSkillsRoot(vault)).toBe(root);
    expect(resolveLocalSkillsRoot(vault, 'Resources/Skills/')).toBe(path.join(vault, 'Resources/Skills'));
  });
  it('creates a package in a nested folder that does not exist yet', async () => {
    const nested = resolveLocalSkillsRoot(vault, 'Resources/Skills');
    await createLocalSkill(nested, { skillId: 'example', skillMd: manifest });
    expect(fs.existsSync(path.join(nested, 'example/SKILL.md'))).toBe(true);
  });
  it.each(['', '.', '../Skills', '/Skills', 'a/../b', 'a\\b'])('rejects unsafe root %s', folder => {
    expect(() => resolveLocalSkillsRoot(vault, folder)).toThrow();
  });
  it('rejects symlink roots', () => {
    fs.symlinkSync(os.tmpdir(), root);
    expect(() => resolveLocalSkillsRoot(vault)).toThrow(/symlink/i);
  });
});

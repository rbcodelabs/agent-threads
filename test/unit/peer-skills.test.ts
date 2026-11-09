import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PeerSkillRegistry } from '../../src/PeerSkills';

const spec = (over: Record<string, unknown> = {}) => ({ name: 'thread-orchestrator', description: 'Orchestrate threads', content: '# Body\nhello', ...over });
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-skills-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('PeerSkillRegistry', () => {
  it('registers, lists, and disposes (idempotently)', () => {
    const r = new PeerSkillRegistry();
    const d = r.register({ pluginId: 'p' }, spec());
    expect(r.list().map(s => s.name)).toEqual(['thread-orchestrator']);
    d.dispose(); d.dispose();
    expect(r.list()).toEqual([]);
  });

  it('same owner re-registering replaces; the stale disposable then cannot remove the replacement', () => {
    const r = new PeerSkillRegistry();
    const first = r.register({ pluginId: 'p' }, spec({ content: 'one' }));
    r.register({ pluginId: 'p' }, spec({ content: 'two' }));
    first.dispose();
    expect(r.list()).toHaveLength(1);
    expect(r.list()[0]!.content).toBe('two');
  });

  it('a different owner cannot take over a name', () => {
    const r = new PeerSkillRegistry();
    r.register({ pluginId: 'a' }, spec());
    expect(() => r.register({ pluginId: 'b' }, spec())).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it.each([
    ['uppercase name', { name: 'Bad' }], ['path traversal', { name: '../x' }], ['empty name', { name: '' }], ['65 char name', { name: 'a'.repeat(65) }],
    ['empty description', { description: '  ' }], ['long description', { description: 'x'.repeat(1025) }], ['non-string description', { description: 3 }],
    ['empty content', { content: '' }], ['long content', { content: 'x'.repeat(100_001) }],
  ])('rejects %s', (_n, over) => {
    expect(() => new PeerSkillRegistry().register({ pluginId: 'p' }, spec(over))).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it.each([[undefined], [{}], [{ pluginId: '' }], [{ pluginId: 'x'.repeat(129) }]])('rejects invalid owner %#', (owner) => {
    expect(() => new PeerSkillRegistry().register(owner as never, spec())).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('accepts max-size content and description', () => {
    const r = new PeerSkillRegistry();
    r.register({ pluginId: 'p' }, spec({ content: 'x'.repeat(100_000), description: 'd'.repeat(1024) }));
    expect(r.list()).toHaveLength(1);
  });

  it('disposeAll clears everything', () => {
    const r = new PeerSkillRegistry();
    r.register({ pluginId: 'a' }, spec()); r.register({ pluginId: 'a' }, spec({ name: 'other' }));
    r.disposeAll();
    expect(r.list()).toEqual([]);
  });

  it('materialize writes SKILL.md with quoted frontmatter and returns plugin paths; stale dirs are removed', () => {
    const r = new PeerSkillRegistry();
    const d = r.register({ pluginId: 'p' }, spec({ description: 'He said: "hi" # not a comment' }));
    const paths = r.materialize(root);
    expect(paths).toEqual([{ type: 'local', path: path.join(root, 'thread-orchestrator') }]);
    const text = fs.readFileSync(path.join(root, 'thread-orchestrator', 'SKILL.md'), 'utf8');
    expect(text.startsWith('---\nname: thread-orchestrator\ndescription: ')).toBe(true);
    expect(text).toContain(JSON.stringify('He said: "hi" # not a comment'));
    expect(text.endsWith('# Body\nhello\n')).toBe(true);
    d.dispose();
    expect(r.materialize(root)).toEqual([]);
    expect(fs.existsSync(path.join(root, 'thread-orchestrator'))).toBe(false);
  });

  it('materialize returns [] and writes nothing when empty', () => {
    expect(new PeerSkillRegistry().materialize(path.join(root, 'none'))).toEqual([]);
    expect(fs.existsSync(path.join(root, 'none'))).toBe(false);
  });
});

describe('PeerSkillRegistry hardening', () => {
  it.each([['vault'], ['local']])('rejects reserved name %s', (name) => {
    expect(() => new PeerSkillRegistry().register({ pluginId: 'p' }, spec({ name }))).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
  it('caps registrations per owner at 16 but allows replacing, other owners, and reuse after dispose', () => {
    const r = new PeerSkillRegistry();
    const ds = Array.from({ length: 16 }, (_, i) => r.register({ pluginId: 'a' }, spec({ name: `s${i}` })));
    expect(() => r.register({ pluginId: 'a' }, spec({ name: 'extra' }))).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => r.register({ pluginId: 'a' }, spec({ name: 's3', content: 'new' }))).not.toThrow();
    expect(() => r.register({ pluginId: 'b' }, spec({ name: 'extra' }))).not.toThrow();
    ds[0]!.dispose();
    expect(() => r.register({ pluginId: 'a' }, spec({ name: 'extra' }))).not.toThrow();
  });
});

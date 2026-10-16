import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_LINKS_RESOLVED, detectWorkspaceKind, listSubfolders, listWorkspaces } from '../../daemon/workspaces';

let base: string;
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'ws-list-'))); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });
const dir = (...p: string[]): string => { const d = join(base, ...p); mkdirSync(d, { recursive: true }); return d; };

describe('detectWorkspaceKind', () => {
  it.each(['.geode', '.obsidian', '.vault'])('treats a folder with a %s directory as a vault', (marker) => {
    const v = dir('v');
    dir('v', marker);
    expect(detectWorkspaceKind(v)).toBe('vault');
  });

  it('treats a plain folder as a folder', () => {
    expect(detectWorkspaceKind(dir('plain'))).toBe('folder');
  });

  it('ignores a marker that is a file, and a missing folder', () => {
    const f = dir('file-marker');
    writeFileSync(join(f, '.obsidian'), 'not a directory');
    expect(detectWorkspaceKind(f)).toBe('folder');
    expect(detectWorkspaceKind(join(base, 'missing'))).toBe('folder');
  });
});

describe('listWorkspaces', () => {
  it('advertises path, name, kind, read-only and the default (first read-write) workspace', () => {
    const vault = dir('notes');
    dir('notes', '.obsidian');
    const projects = dir('projects');
    const archive = dir('archive');
    const list = listWorkspaces({ workspaces: [projects, vault], readOnlyWorkspaces: [archive], allowBypass: false });
    expect(list).toEqual([
      { path: projects, name: 'projects', readOnly: false, kind: 'folder', isDefault: true },
      { path: vault, name: 'notes', readOnly: false, kind: 'vault', isDefault: false },
      { path: archive, name: 'archive', readOnly: true, kind: 'folder', isDefault: false },
    ]);
  });

  it('falls back to a read-only workspace as the default when nothing is read-write', () => {
    const only = dir('only');
    expect(listWorkspaces({ workspaces: [], readOnlyWorkspaces: [only], allowBypass: false })[0]).toMatchObject({ readOnly: true, isDefault: true });
  });

  it('lists a folder once when it is both read-write and read-only, and via a symlink', () => {
    const real = dir('real');
    const link = join(base, 'link');
    symlinkSync(real, link);
    const list = listWorkspaces({ workspaces: [real, link], readOnlyWorkspaces: [real], allowBypass: false });
    expect(list).toHaveLength(1);
    expect(list[0].readOnly).toBe(false);
  });

  it('is empty with no workspaces', () => {
    expect(listWorkspaces({ workspaces: [], allowBypass: false })).toEqual([]);
  });
});

describe('listSubfolders confinement', () => {
  let root: string;
  let outside: string;
  const policy = () => ({ workspaces: [root], allowBypass: false });
  beforeEach(() => {
    root = dir('ws');
    outside = dir('secrets');
    dir('ws', 'Beta');
    dir('ws', 'alpha');
    dir('ws', '.git');
    dir('secrets', 'hidden-name');
    writeFileSync(join(root, 'a-file.md'), 'x');
    symlinkSync(outside, join(root, 'escape'));
    symlinkSync(join(root, 'alpha'), join(root, 'inside-link'));
  });

  it('lists directories only, sorted case-insensitively, without dot-folders or files', () => {
    const r = listSubfolders(root, policy());
    expect(r.allowed).toBe(true);
    expect(r.entries.map((e) => e.name)).toEqual(['alpha', 'Beta', 'inside-link']);
    expect(r.entries[0].path).toBe(join(root, 'alpha'));
    expect(r.truncated).toBe(false);
  });

  it('omits a symlink that leads outside the workspace', () => {
    expect(listSubfolders(root, policy()).entries.map((e) => e.name)).not.toContain('escape');
  });

  it('refuses a path outside every workspace and reveals no names', () => {
    expect(listSubfolders(outside, policy())).toEqual({ allowed: false, entries: [], truncated: false });
    expect(listSubfolders(join(root, 'escape'), policy())).toEqual({ allowed: false, entries: [], truncated: false });
    expect(listSubfolders(join(root, 'alpha', '..', '..', 'secrets'), policy())).toEqual({ allowed: false, entries: [], truncated: false });
    expect(listSubfolders('/', policy()).allowed).toBe(false);
  });

  it('refuses relative, missing and non-string paths without throwing', () => {
    expect(listSubfolders('ws', policy()).allowed).toBe(false);
    expect(listSubfolders(join(root, 'nope'), policy()).allowed).toBe(false);
    expect(listSubfolders(undefined as never, policy()).allowed).toBe(false);
  });

  it('allows a file path but lists nothing', () => {
    expect(listSubfolders(join(root, 'a-file.md'), policy())).toEqual({ allowed: true, entries: [], truncated: false });
  });

  it('bounds the symlink resolutions per call (a directory of links is not a stat storm)', () => {
    const many = dir('links');
    const target = dir('links', 'target');
    for (let i = 0; i < MAX_LINKS_RESOLVED + 20; i++) symlinkSync(target, join(many, `l${String(i).padStart(4, '0')}`));
    const r = listSubfolders(many, { workspaces: [many], allowBypass: false }, 10_000);
    expect(r.truncated).toBe(true);
    expect(r.entries.length).toBeLessThanOrEqual(MAX_LINKS_RESOLVED + 1);
  });

  it('plain subdirectories are listed without being resolved individually', () => {
    const many = dir('plain');
    for (let i = 0; i < 50; i++) dir('plain', `d${i}`);
    const r = listSubfolders(many, { workspaces: [many], allowBypass: false });
    expect(r.entries).toHaveLength(50);
    expect(r.truncated).toBe(false);
  });

  it('covers read-only workspaces and caps the list', () => {
    for (let i = 0; i < 5; i++) dir('ro', `d${i}`);
    const ro = join(base, 'ro');
    const r = listSubfolders(ro, { workspaces: [], readOnlyWorkspaces: [ro], allowBypass: false }, 3);
    expect(r.entries).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });
});

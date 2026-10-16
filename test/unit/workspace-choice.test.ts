import { describe, expect, it } from 'vitest';
import type { WorkspaceInfo } from '../../src/protocol';
import {
  applyDiscovery,
  describeVaultPick,
  parentPath,
  pickDefaultWorkspace,
  pickVaultWorkspace,
  workspaceContaining,
  workspaceForPath,
  workspaceLabel,
} from '../../src/remote/workspaceChoice';

const ws = (path: string, over: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  path, name: path.split('/').pop() ?? path, readOnly: false, kind: 'folder', isDefault: false, ...over,
});
const projects = ws('/home/user/projects', { isDefault: true });
const notes = ws('/home/user/notes', { kind: 'vault' });
const work = ws('/srv/workspaces/work', { kind: 'vault' });

describe('pickVaultWorkspace', () => {
  it('uses the only vault-kind workspace, whatever it is called', () => {
    expect(pickVaultWorkspace([projects, notes], 'Personal')).toEqual({ workspace: notes, reason: 'only-vault' });
  });

  it('with several vaults, prefers the one named like this vault', () => {
    expect(pickVaultWorkspace([projects, notes, work], 'Work')).toEqual({ workspace: work, reason: 'name-match' });
  });

  it('with no vault marker anywhere, still matches by folder name (a mirror may lack .obsidian)', () => {
    expect(pickVaultWorkspace([projects, ws('/srv/personal')], 'personal')).toMatchObject({ reason: 'name-match', workspace: { path: '/srv/personal' } });
  });

  it('prefers a vault-kind name match over a plain folder with the same name', () => {
    const plain = ws('/a/notes');
    const vaultNotes = ws('/b/notes', { kind: 'vault' });
    const other = ws('/c/other', { kind: 'vault' });
    expect(pickVaultWorkspace([plain, vaultNotes, other], 'notes')).toMatchObject({ workspace: vaultNotes, reason: 'name-match' });
  });

  it('leaves it unset when nothing is clearly right', () => {
    expect(pickVaultWorkspace([projects], 'Personal')).toEqual({ reason: 'none' });
    expect(pickVaultWorkspace([projects, notes, work], 'Unrelated')).toEqual({ reason: 'none' });
    expect(pickVaultWorkspace([], 'Personal')).toEqual({ reason: 'none' });
    expect(pickVaultWorkspace([projects, notes, work], undefined)).toEqual({ reason: 'none' });
  });

  it('does not guess between two equally good name matches', () => {
    expect(pickVaultWorkspace([ws('/a/notes', { kind: 'vault' }), ws('/b/notes', { kind: 'vault' })], 'notes')).toEqual({ reason: 'none' });
  });

  it('matches names ignoring case and Unicode normalization', () => {
    const cafe = ws('/srv/Café', { kind: 'vault' });
    expect(pickVaultWorkspace([cafe, work], 'café').workspace).toBe(cafe);
  });
});

describe('defaults and lookups', () => {
  it('prefers the advertised default, else the first read-write one', () => {
    expect(pickDefaultWorkspace([notes, projects])).toBe(projects);
    expect(pickDefaultWorkspace([ws('/ro', { readOnly: true }), notes])).toBe(notes);
    expect(pickDefaultWorkspace([])).toBeUndefined();
  });

  it('finds a workspace by exact path (trailing slash tolerated) or by containment', () => {
    expect(workspaceForPath([projects, notes], '/home/user/notes/')).toBe(notes);
    expect(workspaceForPath([projects, notes], '/home/user/notes/sub')).toBeUndefined();
    expect(workspaceContaining([projects, notes], '/home/user/notes/sub/deeper')).toBe(notes);
    expect(workspaceContaining([projects, notes], '/home/user/notes-old')).toBeUndefined();
  });

  it('labels with kind and read-only tags and the path', () => {
    expect(workspaceLabel(ws('/srv/x', { kind: 'vault', readOnly: true }))).toBe('x (vault, read-only) - /srv/x');
    expect(workspaceLabel(projects)).toBe('projects - /home/user/projects');
  });

  it('parentPath stops at the root', () => {
    expect(parentPath('/a/b')).toBe('/a');
    expect(parentPath('/a')).toBe('/');
    expect(parentPath('/')).toBeUndefined();
    expect(parentPath('relative')).toBeUndefined();
  });

  it('words the hint per reason', () => {
    expect(describeVaultPick({ reason: 'only-vault', workspace: notes }, 'my-server')).toMatch(/only vault on my-server/);
    expect(describeVaultPick({ reason: 'name-match', workspace: notes }, 'my-server')).toMatch(/matches this vault/);
    expect(describeVaultPick({ reason: 'none' }, 'my-server')).toMatch(/Choose one, or leave it as None/);
  });
});

describe('applyDiscovery', () => {
  const empty = { vaultRemote: '', folder: '', vaultTouched: false, folderTouched: false };

  it('fills an empty vault and default folder', () => {
    const r = applyDiscovery(empty, [projects, notes], 'Personal');
    expect(r.draft).toMatchObject({ vaultRemote: '/home/user/notes', folder: '/home/user/projects' });
    expect(r.vaultAutoSelected).toBe(true);
  });

  it('leaves the vault on None when ambiguous, but still defaults the folder', () => {
    const r = applyDiscovery(empty, [projects, notes, work], 'Unrelated');
    expect(r.draft.vaultRemote).toBe('');
    expect(r.vaultAutoSelected).toBe(false);
    expect(r.vaultPick.reason).toBe('none');
    expect(r.draft.folder).toBe('/home/user/projects');
  });

  it('never overwrites a saved or touched value', () => {
    const saved = applyDiscovery({ ...empty, vaultRemote: '/saved/vault', folder: '/saved/dir' }, [projects, notes], 'Personal');
    expect(saved.draft).toMatchObject({ vaultRemote: '/saved/vault', folder: '/saved/dir' });
    const touched = applyDiscovery({ ...empty, vaultTouched: true, folderTouched: true }, [projects, notes], 'Personal');
    expect(touched.draft).toMatchObject({ vaultRemote: '', folder: '' });
  });
});

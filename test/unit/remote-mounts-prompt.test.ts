import { describe, expect, it, vi } from 'vitest';
import { buildRemoteEnvironmentPrompt, LOCAL_VAULT_GUEST_PATH, type RemoteMount } from '../../src/remote/sessionSpec';
import { VAULT_GUEST_PATH, mountsFor } from '../../src/localDaemon/spec';

const vaultMounts: RemoteMount[] = [
  { host: '/Users/me/Vault', guest: '/vault', readOnly: false },
  { host: '/Users/me/Vault/.obsidian', guest: '/vault/.obsidian', readOnly: true },
];
const projectMounts: RemoteMount[] = [
  { host: '/Users/me/projects/compass', guest: '/work/compass', readOnly: false },
  { host: '/Users/me/ref/docs', guest: '/ext/docs', readOnly: true },
];

describe('remote environment prompt: mounted folders', () => {
  it('lists work and external mounts with read-write / read-only labels and the translation rule', () => {
    const p = buildRemoteEnvironmentPrompt('/work/compass', 'Local', 'Geode', undefined, { mounts: projectMounts });
    expect(p).toContain('Mounted folders (host path -> path on this machine):');
    expect(p).toContain('- /work/compass (read-write) <- /Users/me/projects/compass');
    expect(p).toContain('- /ext/docs (read-only) <- /Users/me/ref/docs');
    expect(p).toMatch(/starts with a host path listed above, use the corresponding path/);
    expect(p).toMatch(/Check this list before concluding a repo or folder is missing/);
  });

  it('excludes the vault mount and its masked sub-mounts', () => {
    const p = buildRemoteEnvironmentPrompt('/work/compass', 'Local', 'Geode', undefined, { mounts: [...vaultMounts, ...projectMounts] });
    expect(p).not.toContain('<- /Users/me/Vault');
    expect(p).not.toContain('/vault');
    expect(p).toContain('/work/compass (read-write)');
  });

  it('does not treat a sibling like /vault-extra as the vault', () => {
    const p = buildRemoteEnvironmentPrompt('/x', 'Local', 'Geode', undefined, { mounts: [{ host: '/h/v', guest: '/vault-extra', readOnly: false }] });
    expect(p).toContain('/vault-extra (read-write) <- /h/v');
  });

  it.each([
    ['undefined', undefined],
    ['empty', []],
    ['vault only', vaultMounts],
  ])('is byte-for-byte unchanged when mounts are %s', (_label, mounts) => {
    const plain = buildRemoteEnvironmentPrompt('/x', 'box', 'Geode');
    expect(buildRemoteEnvironmentPrompt('/x', 'box', 'Geode', undefined, { mounts })).toBe(plain);
    expect(plain).not.toContain('Mounted folders');
  });

  it('keeps the core copy of the vault guest path in step with the local daemon spec', () => {
    expect(LOCAL_VAULT_GUEST_PATH).toBe(VAULT_GUEST_PATH);
  });

  it('works end to end with mountsFor output', () => {
    const mounts = mountsFor({ vaultPath: '/Users/me/Vault', maskedDirs: ['.obsidian'], workFolders: [{ host: '/Users/me/projects/compass', name: 'compass' }], externalRoots: [{ host: '/Users/me/ref', name: 'ref' }] });
    const p = buildRemoteEnvironmentPrompt('/work/compass', 'Local', 'Geode', undefined, { mounts });
    expect(p).toContain('/work/compass (read-write) <- /Users/me/projects/compass');
    expect(p).toContain('/ext/ref (read-only) <- /Users/me/ref');
    expect(p).not.toContain('/Users/me/Vault');
  });
});

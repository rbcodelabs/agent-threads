import { describe, expect, it } from 'vitest';
import { guestToHostPath, hostToGuestPath } from '../../src/localDaemon/spec';

const mounts = [
  { host: '/Users/me/Vault', guest: '/vault', readOnly: false },
  { host: '/Users/me/Vault/.obsidian', guest: '/vault/.obsidian', readOnly: true },
  { host: '/Users/me/code/app', guest: '/work/app', readOnly: false },
];

describe('hostToGuestPath', () => {
  it('maps a mount root and keeps the subpath', () => {
    expect(hostToGuestPath(mounts, '/Users/me/code/app')).toBe('/work/app');
    expect(hostToGuestPath(mounts, '/Users/me/code/app/src/x')).toBe('/work/app/src/x');
    expect(hostToGuestPath(mounts, '/Users/me/Vault/Projects/A')).toBe('/vault/Projects/A');
  });
  it('prefers the deepest mount', () => {
    expect(hostToGuestPath(mounts, '/Users/me/Vault/.obsidian/plugins')).toBe('/vault/.obsidian/plugins');
  });
  it('tolerates trailing slashes', () => {
    expect(hostToGuestPath(mounts, '/Users/me/code/app/')).toBe('/work/app');
    expect(hostToGuestPath([{ host: '/a/', guest: '/b/' }], '/a/c')).toBe('/b/c');
  });
  it('does not match a sibling that merely shares a prefix', () => {
    expect(hostToGuestPath(mounts, '/Users/me/code/app2')).toBeUndefined();
  });
  it('returns undefined outside every mount, for relative paths and for ..', () => {
    expect(hostToGuestPath(mounts, '/Users/me/other')).toBeUndefined();
    expect(hostToGuestPath(mounts, 'code/app')).toBeUndefined();
    expect(hostToGuestPath(mounts, '/Users/me/code/app/../secret')).toBeUndefined();
  });
});

describe('guestToHostPath', () => {
  it('is the inverse', () => {
    expect(guestToHostPath(mounts, '/work/app/src')).toBe('/Users/me/code/app/src');
    expect(guestToHostPath(mounts, '/vault')).toBe('/Users/me/Vault');
    expect(guestToHostPath(mounts, '/vault/.obsidian/x')).toBe('/Users/me/Vault/.obsidian/x');
  });
  it('rejects unmounted and .. paths', () => {
    expect(guestToHostPath(mounts, '/srv/workspaces')).toBeUndefined();
    expect(guestToHostPath(mounts, '/work/app/../x')).toBeUndefined();
  });
});

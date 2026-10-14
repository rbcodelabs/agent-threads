import { describe, expect, it } from 'vitest';
import {
  effectiveLocalRoot,
  isUnderRemoteRoot,
  mapLocalToRemote,
  normalizePosixPath,
  relativeWithin,
  suggestRemoteCwd,
} from '../../src/remote/vaultMapping';
import { checkVaultMappingInput, describePathCheck, describeTest } from '../../src/remote/daemonConfig';

// The real vault lives on iCloud: spaces and a "~" in the path.
const ICLOUD = '/Users/rickbowman/Library/Mobile Documents/com~apple~CloudDocs/Documents/Personal';
const mapping = { remoteRoot: '/home/rick/vault' };

describe('normalizePosixPath', () => {
  it('collapses slashes, dots and trailing slashes', () => {
    expect(normalizePosixPath('/a//b/./c/')).toBe('/a/b/c');
    expect(normalizePosixPath('/a/b/../c')).toBe('/a/c');
    expect(normalizePosixPath('/')).toBe('/');
    expect(normalizePosixPath('  /a/b  ')).toBe('/a/b');
  });
  it('refuses relative paths, escapes above root, NUL and newlines', () => {
    for (const bad of ['', 'a/b', '~/x', '/..', '/a/../..', '/a\0b', '/a\nb']) expect(normalizePosixPath(bad), bad).toBeUndefined();
  });
  it('keeps spaces and unicode, normalizing decomposed names to NFC', () => {
    expect(normalizePosixPath(`${ICLOUD}/`)).toBe(ICLOUD);
    expect(normalizePosixPath('/v/Café')).toBe('/v/Café');
  });
});

describe('relativeWithin', () => {
  it('returns the remainder, empty for the root itself, undefined outside', () => {
    expect(relativeWithin('/v', '/v')).toBe('');
    expect(relativeWithin('/v/', '/v/a/b/')).toBe('a/b');
    expect(relativeWithin('/', '/a')).toBe('a');
    expect(relativeWithin('/v', '/vault')).toBeUndefined(); // prefix lookalike
    expect(relativeWithin('/v', '/w/v')).toBeUndefined();
    expect(relativeWithin('/v', '/v/../w')).toBeUndefined(); // lexical resolution happens first
  });
});

describe('mapLocalToRemote', () => {
  it('maps the vault root to the remote root and folders to the same relative path', () => {
    expect(mapLocalToRemote(mapping, ICLOUD, ICLOUD)).toBe('/home/rick/vault');
    expect(mapLocalToRemote(mapping, ICLOUD, `${ICLOUD}/Products/Agent Threads`)).toBe('/home/rick/vault/Products/Agent Threads');
  });
  it('tolerates trailing slashes on every input', () => {
    expect(mapLocalToRemote({ remoteRoot: '/home/rick/vault/' }, `${ICLOUD}/`, `${ICLOUD}/Daily/`)).toBe('/home/rick/vault/Daily');
  });
  it('returns undefined for paths outside the vault (including prefix lookalikes and traversal)', () => {
    expect(mapLocalToRemote(mapping, ICLOUD, '/Users/rickbowman/projects/agent-threads')).toBeUndefined();
    expect(mapLocalToRemote(mapping, ICLOUD, `${ICLOUD}-other/x`)).toBeUndefined();
    expect(mapLocalToRemote(mapping, ICLOUD, `${ICLOUD}/../Elsewhere`)).toBeUndefined();
    expect(mapLocalToRemote(mapping, ICLOUD, '/')).toBeUndefined();
  });
  it('returns undefined when there is nothing to map from or the roots are unusable', () => {
    expect(mapLocalToRemote(mapping, ICLOUD, undefined)).toBeUndefined();
    expect(mapLocalToRemote(mapping, ICLOUD, '')).toBeUndefined();
    expect(mapLocalToRemote(mapping, undefined, `${ICLOUD}/x`)).toBeUndefined(); // no vault root, no localRoot
    expect(mapLocalToRemote(mapping, '', `${ICLOUD}/x`)).toBeUndefined();
    expect(mapLocalToRemote({ remoteRoot: 'relative/vault' }, ICLOUD, `${ICLOUD}/x`)).toBeUndefined();
  });
  it('uses an explicit localRoot instead of the vault root', () => {
    const m = { localRoot: `${ICLOUD}/Products`, remoteRoot: '/home/rick/products' };
    expect(mapLocalToRemote(m, ICLOUD, `${ICLOUD}/Products/Agent Threads`)).toBe('/home/rick/products/Agent Threads');
    expect(mapLocalToRemote(m, ICLOUD, `${ICLOUD}/Daily`)).toBeUndefined(); // in the vault, outside the mapped folder
    expect(effectiveLocalRoot(m, ICLOUD)).toBe(`${ICLOUD}/Products`);
    expect(effectiveLocalRoot({ remoteRoot: '/r' }, ICLOUD)).toBe(ICLOUD);
  });
  it('is lexical only: it never consults the filesystem, so a symlinked path maps by its text', () => {
    expect(mapLocalToRemote(mapping, '/Users/me/vault', '/Users/me/vault/link-to-elsewhere/x')).toBe('/home/rick/vault/link-to-elsewhere/x');
  });
  it('matches a decomposed (NFD) macOS name against a composed one', () => {
    expect(mapLocalToRemote(mapping, '/v', '/v/Café/notes')).toBe('/home/rick/vault/Café/notes');
  });
  it('handles a remote root that is /', () => {
    expect(mapLocalToRemote({ remoteRoot: '/' }, '/v', '/v/a')).toBe('/a');
    expect(mapLocalToRemote({ remoteRoot: '/' }, '/v', '/v')).toBe('/');
  });
});

describe('isUnderRemoteRoot', () => {
  it('is true for the root and below, false for lookalikes, other places and no mapping', () => {
    expect(isUnderRemoteRoot(mapping, '/home/rick/vault')).toBe(true);
    expect(isUnderRemoteRoot(mapping, '/home/rick/vault/Daily/')).toBe(true);
    expect(isUnderRemoteRoot(mapping, '/home/rick/vault-backup')).toBe(false);
    expect(isUnderRemoteRoot(mapping, '/home/rick/projects')).toBe(false);
    expect(isUnderRemoteRoot(undefined, '/home/rick/vault')).toBe(false);
    expect(isUnderRemoteRoot(mapping, undefined)).toBe(false);
  });
});

describe('suggestRemoteCwd', () => {
  const daemon = { defaultCwdRoot: '/home/rick/projects', vaultMapping: mapping };
  it('suggests the mapped vault folder for a vault cwd', () => {
    expect(suggestRemoteCwd(daemon, `${ICLOUD}/Products`, ICLOUD)).toEqual({ cwd: '/home/rick/vault/Products', fromVault: true });
  });
  it('leaves non-vault cwds on the daemon default (unchanged behaviour)', () => {
    expect(suggestRemoteCwd(daemon, '/Users/rickbowman/projects/x', ICLOUD)).toEqual({ cwd: '/home/rick/projects', fromVault: false });
  });
  it('without a mapping it is exactly the old behaviour, even for a vault cwd', () => {
    expect(suggestRemoteCwd({ defaultCwdRoot: '/srv/w' }, ICLOUD, ICLOUD)).toEqual({ cwd: '/srv/w', fromVault: false });
    expect(suggestRemoteCwd({}, ICLOUD, ICLOUD)).toEqual({ cwd: '', fromVault: false });
  });
});

describe('checkVaultMappingInput', () => {
  it('both blank means no mapping', () => {
    expect(checkVaultMappingInput({})).toEqual({ ok: true, mapping: undefined });
    expect(checkVaultMappingInput({ remoteRoot: '  ', localRoot: ' ' })).toEqual({ ok: true, mapping: undefined });
  });
  it('normalizes and accepts a remote root alone', () => {
    expect(checkVaultMappingInput({ remoteRoot: ' /home/rick/vault/ ' })).toEqual({ ok: true, mapping: { remoteRoot: '/home/rick/vault' } });
  });
  it('accepts a local folder with spaces', () => {
    expect(checkVaultMappingInput({ remoteRoot: '/home/rick/vault', localRoot: `${ICLOUD}/` })).toEqual({ ok: true, mapping: { remoteRoot: '/home/rick/vault', localRoot: ICLOUD } });
  });
  it.each([
    [{ localRoot: '/x' }, 'remoteRoot', /vault folder on the daemon/],
    [{ remoteRoot: 'vault' }, 'remoteRoot', /absolute/],
    [{ remoteRoot: '~/vault' }, 'remoteRoot', /absolute/],
    [{ remoteRoot: '/' }, 'remoteRoot', /whole disk/],
    [{ remoteRoot: '/home/../etc' }, 'remoteRoot', /\.\./],
    [{ remoteRoot: '/a\nb' }, 'remoteRoot', /absolute/],
    [{ remoteRoot: '/v', localRoot: 'rel' }, 'localRoot', /absolute/],
    [{ remoteRoot: '/v', localRoot: '/' }, 'localRoot', /whole disk/],
    [{ remoteRoot: '/v', localRoot: '/a/../b' }, 'localRoot', /\.\./],
  ])('rejects %j', (input, field, reason) => {
    expect(checkVaultMappingInput(input)).toMatchObject({ ok: false, field, reason: expect.stringMatching(reason) });
  });
});

describe('Test connection wording for the vault folder', () => {
  const info = { daemonId: 'd', daemonVersion: '0.1.0', protocol: 1, minClientVersion: '0.0.0', capabilities: [], epoch: 'e' };
  const root = '/home/rick/vault';
  it('ok when allowed and present', () => {
    const r = describeTest({ ok: true, info, pathCheck: { allowed: true, exists: true, isDirectory: true, readOnly: false } }, root);
    expect(r.tone).toBe('ok');
    expect(r.text).toContain('Connected: agent-threads 0.1.0');
    expect(r.text).toContain(`${root} is allowed`);
  });
  it('says read-only when the workspace is read-only', () => {
    expect(describePathCheck(root, { allowed: true, exists: true, isDirectory: true, readOnly: true }).text).toMatch(/read-only/);
  });
  it('error, naming the flag to add, when not allowed', () => {
    const r = describeTest({ ok: true, info, pathCheck: { allowed: false, exists: false, isDirectory: false, readOnly: false } }, root);
    expect(r.tone).toBe('error');
    expect(r.text).toContain(`--workspace ${root}`);
  });
  it('error when allowed but missing, or a file', () => {
    expect(describePathCheck(root, { allowed: true, exists: false, isDirectory: false, readOnly: false })).toMatchObject({ tone: 'error', text: expect.stringContaining('does not exist') });
    expect(describePathCheck(root, { allowed: true, exists: true, isDirectory: false, readOnly: false }).tone).toBe('error');
  });
  it('an old daemon is reported, not treated as a failure to connect', () => {
    const r = describeTest({ ok: true, info, pathCheck: { unsupported: true } }, root);
    expect(r.tone).toBe('error');
    expect(r.text).toMatch(/too old to check folders/);
    expect(r.text).toContain('Connected');
  });
  it('without a configured folder the line is the plain connection result', () => {
    expect(describeTest({ ok: true, info }, undefined)).toEqual({ tone: 'ok', text: 'Connected: agent-threads 0.1.0, protocol 1' });
  });
  it('a failed connection stays a connection error', () => {
    expect(describeTest({ ok: false, status: 'unreachable', detail: 'ECONNREFUSED' }, root)).toEqual({ tone: 'error', text: 'Could not connect: ECONNREFUSED' });
  });
});

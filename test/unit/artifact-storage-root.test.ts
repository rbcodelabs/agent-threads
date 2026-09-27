import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { artifactStorageRoot, removeStorageRoot, resolveStorageRoot } from '../../src/artifactStorage';

/**
 * `storageRoot` is peer-supplied and is later handed to a recursive delete, so
 * these are the tests that matter most in this contribution type: every one of
 * them is a way a buggy or hostile plugin could try to aim `rm -rf` at
 * something the host never meant to touch.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function vault(): Promise<string> {
  // Resolved up front: macOS puts temp dirs behind the /var → /private/var
  // symlink, and every expectation below is about resolved paths.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'artifact-store-')));
  roots.push(root);
  await mkdir(artifactStorageRoot(root), { recursive: true });
  return root;
}

describe('storage root validation', () => {
  it('accepts a directory inside the vault artifact root', async () => {
    const root = await vault();
    const target = join(artifactStorageRoot(root), 'design-thread-1');
    await mkdir(target, { recursive: true });
    expect(resolveStorageRoot(root, target)).toEqual({ status: 'ok', path: target });
  });

  it('accepts a root that does not exist yet', async () => {
    const root = await vault();
    const target = join(artifactStorageRoot(root), 'not-created-yet');
    expect(resolveStorageRoot(root, target)).toEqual({ status: 'ok', path: target });
  });

  it('rejects a relative path, including bare parent traversal', async () => {
    const root = await vault();
    for (const candidate of ['../../..', '..', 'design-1', './design-1']) {
      expect(resolveStorageRoot(root, candidate).status).toBe('invalid');
    }
  });

  it('rejects traversal that climbs back out of the artifact root', async () => {
    const root = await vault();
    const escape = join(artifactStorageRoot(root), '..', '..', '..');
    const resolved = resolveStorageRoot(root, escape);
    expect(resolved.status).toBe('invalid');
    expect(resolved.status === 'invalid' && resolved.message).toContain('must resolve inside');
  });

  it('rejects an absolute path outside the vault', async () => {
    const root = await vault();
    for (const candidate of ['/etc', '/', join(root, '..', 'elsewhere'), '/Users/someone/Documents']) {
      expect(resolveStorageRoot(root, candidate).status).toBe('invalid');
    }
  });

  it('rejects a symlink inside the artifact root that points outside it', async () => {
    const root = await vault();
    const outside = join(root, 'not-artifacts');
    await mkdir(outside, { recursive: true });
    const link = join(artifactStorageRoot(root), 'sneaky');
    await symlink(outside, link, 'dir');

    const resolved = resolveStorageRoot(root, link);
    expect(resolved.status).toBe('invalid');
    // And the directory it pointed at is still there afterwards.
    expect(await removeStorageRoot(root, link)).toBe(false);
    expect((await stat(outside)).isDirectory()).toBe(true);
  });

  it('rejects the artifact root itself and the vault root', async () => {
    const root = await vault();
    expect(resolveStorageRoot(root, artifactStorageRoot(root)).status).toBe('invalid');
    expect(resolveStorageRoot(root, `${artifactStorageRoot(root)}${sep}`).status).toBe('invalid');
    expect(resolveStorageRoot(root, root).status).toBe('invalid');
  });

  it('rejects non-strings, blanks, null bytes and absurd lengths', async () => {
    const root = await vault();
    for (const candidate of ['', '   ', null, undefined, 42, {}, '/vault/\0/x', `/${'a'.repeat(5000)}`]) {
      expect(resolveStorageRoot(root, candidate).status).toBe('invalid');
    }
  });

  it('rejects everything when the host has no vault root', () => {
    expect(resolveStorageRoot('', '/anywhere').status).toBe('invalid');
  });
});

describe('storage root removal', () => {
  it('removes a valid root and tolerates it already being gone', async () => {
    const root = await vault();
    const target = join(artifactStorageRoot(root), 'design-thread-1');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'index.html'), '<!doctype html>');

    expect(await removeStorageRoot(root, target)).toBe(true);
    await expect(stat(target)).rejects.toThrow();
    // Second pass must not throw: thread deletion never fails on cleanup.
    expect(await removeStorageRoot(root, target)).toBe(true);
  });

  it('never deletes a root that fails validation', async () => {
    const root = await vault();
    const rm = vi.fn(async () => {});
    for (const candidate of ['/etc', root, artifactStorageRoot(root), '../../..', undefined]) {
      expect(await removeStorageRoot(root, candidate, { realpathSync: target => target, rm })).toBe(false);
    }
    expect(rm).not.toHaveBeenCalled();
  });

  it('reports failure rather than throwing when the delete itself fails', async () => {
    const root = await vault();
    const target = join(artifactStorageRoot(root), 'design-thread-1');
    const rm = vi.fn(async () => { throw new Error('EBUSY'); });
    expect(await removeStorageRoot(root, target, { realpathSync: candidate => candidate, rm })).toBe(false);
  });
});

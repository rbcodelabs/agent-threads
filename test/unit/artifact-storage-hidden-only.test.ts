import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactStorageRoot, removeStorageRoot } from '../../src/artifactStorage';

/**
 * `removeStorageRoot(..., { hiddenOnly: true })` is what thread deletion uses.
 * It must only ever delete inside `<vault>/.geode/artifacts/`, never in the
 * user-visible Artifacts folder, a lookalike sibling, or via a symlink.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function vault(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'artifact-hidden-only-')));
  roots.push(root);
  await mkdir(artifactStorageRoot(root), { recursive: true });
  return root;
}

async function seed(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), '<!doctype html>');
  return dir;
}

const exists = async (path: string) => stat(path).then(() => true, () => false);

describe('removeStorageRoot hiddenOnly', () => {
  it('removes a directory inside the hidden artifact root', async () => {
    const v = await vault();
    const target = await seed(join(artifactStorageRoot(v), 'design-1'));
    expect(await removeStorageRoot(v, target, undefined, undefined, { hiddenOnly: true })).toBe(true);
    expect(await exists(target)).toBe(false);
  });

  it('refuses a visible-root artifact and leaves its files', async () => {
    const v = await vault();
    const target = await seed(join(v, 'Artifacts', 'ns', 'Mine'));
    expect(await removeStorageRoot(v, target, undefined, undefined, { hiddenOnly: true })).toBe(false);
    expect(await exists(join(target, 'index.html'))).toBe(true);
  });

  it('refuses a visible root under a custom visibleArtifactRoot name', async () => {
    const v = await vault();
    const target = await seed(join(v, 'Boards', 'ns', 'Mine'));
    expect(await removeStorageRoot(v, target, undefined, 'Boards', { hiddenOnly: true })).toBe(false);
    expect(await exists(join(target, 'index.html'))).toBe(true);
  });

  it('refuses a lookalike sibling of the hidden root (.geode/artifacts-evil)', async () => {
    const v = await vault();
    const target = await seed(join(v, '.geode', 'artifacts-evil', 'x'));
    // Without the visible allowlist this path is already outside; hiddenOnly must not treat the prefix as containment.
    expect(await removeStorageRoot(v, target, undefined, undefined, { hiddenOnly: true })).toBe(false);
    expect(await exists(join(target, 'index.html'))).toBe(true);
  });

  it('refuses a symlink inside the hidden root that points at a visible-root artifact', async () => {
    const v = await vault();
    const real = await seed(join(v, 'Artifacts', 'ns', 'Mine'));
    const link = join(artifactStorageRoot(v), 'sneaky');
    await symlink(real, link);
    expect(await removeStorageRoot(v, link, undefined, undefined, { hiddenOnly: true })).toBe(false);
    expect(await exists(join(real, 'index.html'))).toBe(true);
  });

  it('refuses the hidden root itself', async () => {
    const v = await vault();
    const seeded = await seed(join(artifactStorageRoot(v), 'keep'));
    expect(await removeStorageRoot(v, artifactStorageRoot(v), undefined, undefined, { hiddenOnly: true })).toBe(false);
    expect(await exists(join(seeded, 'index.html'))).toBe(true);
  });
});

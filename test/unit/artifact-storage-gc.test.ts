import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';
import { artifactStorageRoot } from '../../src/artifactStorage';

/**
 * ADR-0010's live defect: deleting a thread removed its attachment directory
 * but left `.geode/artifacts/<id>` on disk forever, because artifact storage
 * had no owner. `storageRoot` gives it one.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function vault(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'artifact-gc-')));
  roots.push(root);
  await mkdir(artifactStorageRoot(root), { recursive: true });
  return root;
}

async function seedArtifact(vaultRoot: string, id: string): Promise<string> {
  const target = join(artifactStorageRoot(vaultRoot), id);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'index.html'), '<!doctype html>');
  return target;
}

function managerFor(vaultRoot: string): ThreadManager {
  const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
  manager.vaultRoot = vaultRoot;
  return manager;
}

/** `deleteThread` is synchronous and fires cleanup off; let it land. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20));
}

describe('artifact storage garbage collection', () => {
  it('removes artifact storage when the owning thread is deleted', async () => {
    const vaultRoot = await vault();
    const first = await seedArtifact(vaultRoot, 'design-thread-1');
    const second = await seedArtifact(vaultRoot, 'board-thread-1');
    const manager = managerFor(vaultRoot);
    const thread = manager.createThread('Design');
    thread.artifacts = [
      { id: 'design-thread-1', kind: 'design-static', title: 'A', providerId: 'agent-threads.design', schemaVersion: 1, storageRoot: first, createdAt: 1, updatedAt: 1 },
      { id: 'board-thread-1', kind: 'board', title: 'B', providerId: 'acme.boards', schemaVersion: 1, storageRoot: second, createdAt: 1, updatedAt: 1 },
    ];

    manager.deleteThread(thread.id);
    await settle();

    await expect(stat(first)).rejects.toThrow();
    await expect(stat(second)).rejects.toThrow();
    // Nothing above the artifacts themselves is touched.
    expect((await stat(artifactStorageRoot(vaultRoot))).isDirectory()).toBe(true);
  });

  it('tolerates a storage root that is already gone', async () => {
    const vaultRoot = await vault();
    const manager = managerFor(vaultRoot);
    const thread = manager.createThread('Design');
    thread.artifacts = [{
      id: 'design-1', kind: 'design-static', title: 'A', providerId: 'agent-threads.design', schemaVersion: 1,
      storageRoot: join(artifactStorageRoot(vaultRoot), 'never-created'), createdAt: 1, updatedAt: 1,
    }];

    expect(() => manager.deleteThread(thread.id)).not.toThrow();
    await settle();
    expect(manager.getThread(thread.id)).toBeUndefined();
  });

  it('leaves alone a record with no storage root, and refuses one pointing outside', async () => {
    const vaultRoot = await vault();
    const outside = join(vaultRoot, 'not-artifacts');
    await mkdir(outside, { recursive: true });
    const rmSpy = vi.fn(async () => {});
    const manager = managerFor(vaultRoot);
    manager.artifactStorageFs = { realpathSync: target => target, rm: rmSpy };
    const thread = manager.createThread('Design');
    thread.artifacts = [
      { id: 'no-storage', kind: 'design-static', title: 'A', createdAt: 1, updatedAt: 1 },
      // A hand-edited or hostile record: re-validated at delete time, so the
      // recursive delete never fires for it.
      { id: 'escape', kind: 'board', title: 'B', providerId: 'acme.boards', schemaVersion: 1, storageRoot: outside, createdAt: 1, updatedAt: 1 },
      { id: 'root-itself', kind: 'board', title: 'C', providerId: 'acme.boards', schemaVersion: 1, storageRoot: artifactStorageRoot(vaultRoot), createdAt: 1, updatedAt: 1 },
    ];

    manager.deleteThread(thread.id);
    await settle();

    expect(rmSpy).not.toHaveBeenCalled();
    expect((await stat(outside)).isDirectory()).toBe(true);
  });

  it('does nothing when the host has no vault root', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    const rmSpy = vi.fn(async () => {});
    manager.artifactStorageFs = { realpathSync: target => target, rm: rmSpy };
    const thread = manager.createThread('Design');
    thread.artifacts = [{ id: 'x', kind: 'board', title: 'B', storageRoot: '/anywhere', createdAt: 1, updatedAt: 1 }];

    expect(() => manager.deleteThread(thread.id)).not.toThrow();
    await settle();
    expect(rmSpy).not.toHaveBeenCalled();
  });
});

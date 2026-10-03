/**
 * Visible artifact storage (ADR-0010 addendum).
 *
 * Artifacts may live in `<vault>/Designs/<name>` as well as the hidden
 * `<vault>/.geode/artifacts/<id>`. The allowlist is the safety boundary: the
 * recursive delete that garbage-collects a thread's storage must never be
 * steerable at the `Designs` folder itself, the vault, or anything else.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VISIBLE_ARTIFACT_ROOTS,
  allocateStorageRoot,
  artifactStorageRoot,
  removeStorageRoot,
  resolveStorageRoot,
  sanitizeFolderName,
  visibleArtifactRoot,
} from '../../src/artifactStorage';
import { createArtifactStore } from '../../src/artifactStore';
import { createClaudeThreadsApiV1 } from '../../src/PublicApi';
import { ArtifactProviderRegistry } from '../../src/ArtifactContributions';
import { AgentToolRegistry } from '../../src/AgentToolContributions';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';

const VAULT = '/vault';
const HIDDEN = '/vault/.geode/artifacts';
const DESIGNS = '/vault/Designs';

function fakeFs(existing: string[] = []) {
  const dirs = new Set<string>([VAULT, '/vault/.geode', HIDDEN, ...existing]);
  return {
    dirs,
    realpathSync: (target: string) => {
      if (!dirs.has(target)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return target;
    },
    mkdir: vi.fn(async (target: string) => { dirs.add(target); }),
    rm: vi.fn(async (target: string) => { dirs.delete(target); }),
  };
}

describe('visible root constant', () => {
  it('allows exactly Designs', () => {
    expect(VISIBLE_ARTIFACT_ROOTS).toEqual(['Designs']);
    expect(visibleArtifactRoot(VAULT, 'Designs')).toBe(DESIGNS);
  });
});

describe('resolveStorageRoot allowlist', () => {
  it('accepts a root strictly inside Designs and inside the hidden root', () => {
    const storageFs = fakeFs();
    expect(resolveStorageRoot(VAULT, `${DESIGNS}/Landing`, storageFs)).toEqual({ status: 'ok', path: `${DESIGNS}/Landing` });
    expect(resolveStorageRoot(VAULT, `${HIDDEN}/design-1`, storageFs)).toEqual({ status: 'ok', path: `${HIDDEN}/design-1` });
  });

  it('rejects the Designs folder itself, the hidden root, and the vault root', () => {
    const storageFs = fakeFs([DESIGNS]);
    for (const target of [DESIGNS, `${DESIGNS}/`, HIDDEN, VAULT, '/vault/.geode', '/vault/Designs/..']) {
      expect(resolveStorageRoot(VAULT, target, storageFs).status, target).toBe('invalid');
    }
  });

  it('rejects look-alike siblings and traversal out of Designs', () => {
    const storageFs = fakeFs([DESIGNS]);
    for (const target of ['/vault/Designs2/x', '/vault/Design/x', '/vault/Notes', `${DESIGNS}/../Notes/x`, '/vault/designs-old/x', 'Designs/x']) {
      expect(resolveStorageRoot(VAULT, target, storageFs).status, target).toBe('invalid');
    }
  });

  it('still rejects null bytes and over-long roots under Designs', () => {
    const storageFs = fakeFs();
    expect(resolveStorageRoot(VAULT, `${DESIGNS}/a\0b`, storageFs).status).toBe('invalid');
    expect(resolveStorageRoot(VAULT, `${DESIGNS}/${'a'.repeat(5000)}`, storageFs).status).toBe('invalid');
  });
});

describe('sanitizeFolderName', () => {
  it('passes ordinary names through, keeping spaces and case', () => {
    expect(sanitizeFolderName('Landing Page v2', 'fallback')).toBe('Landing Page v2');
  });

  it('neutralizes traversal, separators and leading dots', () => {
    for (const hostile of ['../../etc/passwd', '..\\..\\windows', '/abs/path', '.hidden', '...', 'a/../b', '../']) {
      const cleaned = sanitizeFolderName(hostile, 'fallback');
      expect(cleaned, hostile).not.toMatch(/[\\/]/);
      expect(cleaned, hostile).not.toContain('..');
      expect(cleaned.startsWith('.'), hostile).toBe(false);
    }
    expect(sanitizeFolderName('../../etc/passwd', 'fb')).toBe('etc passwd');
    expect(sanitizeFolderName('.hidden', 'fb')).toBe('hidden');
  });

  it('strips control chars and collapses whitespace', () => {
    expect(sanitizeFolderName('a\u0000b\u0007c\n\td   e', 'fb')).toBe('abc d e');
  });

  it('falls back to the artifact id when nothing usable remains', () => {
    for (const empty of ['', '   ', '..', '/', '\u0000\u0001', undefined, 42, null]) {
      expect(sanitizeFolderName(empty, 'design-1'), String(empty)).toBe('design-1');
    }
  });

  it('caps length at 80 without leaving trailing space or dots', () => {
    const cleaned = sanitizeFolderName(`${'x'.repeat(79)} yyyy`, 'fb');
    expect(cleaned.length).toBeLessThanOrEqual(80);
    expect(cleaned).toBe('x'.repeat(79));
  });
});

describe('allocateStorageRoot visible', () => {
  it('creates <vault>/Designs/<name>, including the Designs folder', async () => {
    const storageFs = fakeFs();
    const result = await allocateStorageRoot(VAULT, 'design-1', storageFs, { location: 'visible', folderName: 'Landing Page' });
    expect(result).toMatchObject({ status: 'ok', path: `${DESIGNS}/Landing Page`, existed: false });
    expect(storageFs.mkdir).toHaveBeenCalledWith(`${DESIGNS}/Landing Page`, { recursive: true });
  });

  it('uses the artifact id when no usable folder name is given', async () => {
    const storageFs = fakeFs();
    const result = await allocateStorageRoot(VAULT, 'design-1', storageFs, { location: 'visible', folderName: '../..' });
    expect(result).toMatchObject({ status: 'ok', path: `${DESIGNS}/design-1` });
  });

  it('never escapes Designs with a hostile folder name', async () => {
    const storageFs = fakeFs();
    const result = await allocateStorageRoot(VAULT, 'design-1', storageFs, { location: 'visible', folderName: '../../.geode/artifacts/../../x' });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.path.startsWith(`${DESIGNS}/`)).toBe(true);
  });

  it('appends -2, -3 on collision with a directory this artifact does not own', async () => {
    const storageFs = fakeFs([DESIGNS, `${DESIGNS}/Landing`, `${DESIGNS}/Landing-2`]);
    const result = await allocateStorageRoot(VAULT, 'design-1', storageFs, { location: 'visible', folderName: 'Landing' });
    expect(result).toMatchObject({ status: 'ok', path: `${DESIGNS}/Landing-3`, existed: false });
    expect(storageFs.mkdir).toHaveBeenCalledTimes(1);
  });

  it('returns the artifact\'s own root as existing instead of suffixing', async () => {
    const storageFs = fakeFs([DESIGNS, `${DESIGNS}/Landing`]);
    const result = await allocateStorageRoot(VAULT, 'design-1', storageFs, {
      location: 'visible', folderName: 'Something else', ownedRoot: `${DESIGNS}/Landing`,
    });
    expect(result).toMatchObject({ status: 'ok', path: `${DESIGNS}/Landing`, existed: true });
  });

  it('ignores an owned root that is not inside the allowlist', async () => {
    const storageFs = fakeFs([DESIGNS]);
    const result = await allocateStorageRoot(VAULT, 'design-1', storageFs, {
      location: 'visible', folderName: 'Landing', ownedRoot: '/vault/Notes',
    });
    expect(result).toMatchObject({ status: 'ok', path: `${DESIGNS}/Landing` });
  });

  it('keeps the hidden default untouched, ignoring folderName', async () => {
    const storageFs = fakeFs();
    const noOptions = await allocateStorageRoot(VAULT, 'design-1', storageFs);
    expect(noOptions).toMatchObject({ status: 'ok', path: `${HIDDEN}/design-1` });
    const hidden = await allocateStorageRoot(VAULT, 'design-2', storageFs, { location: 'hidden', folderName: 'Nope' });
    expect(hidden).toMatchObject({ status: 'ok', path: `${HIDDEN}/design-2` });
    expect(storageFs.dirs.has(DESIGNS)).toBe(false);
  });

  it('rejects an unknown location and a bad artifact id', async () => {
    const storageFs = fakeFs();
    expect((await allocateStorageRoot(VAULT, 'design-1', storageFs, { location: 'elsewhere' as never })).status).toBe('invalid');
    expect((await allocateStorageRoot(VAULT, '../x', storageFs, { location: 'visible' })).status).toBe('invalid');
    expect(storageFs.mkdir).not.toHaveBeenCalled();
  });

  it('refuses when Designs is a symlink resolving outside the vault', async () => {
    const storageFs = fakeFs([DESIGNS]);
    const real = storageFs.realpathSync;
    storageFs.realpathSync = (target: string) => (target === DESIGNS ? '/elsewhere/Designs' : real(target));
    const result = await allocateStorageRoot(VAULT, 'design-1', storageFs, { location: 'visible', folderName: 'x' });
    expect(result.status).toBe('invalid');
    expect(storageFs.mkdir).not.toHaveBeenCalled();
  });
});

describe('removeStorageRoot allowlist', () => {
  it('removes a root inside Designs but never Designs, the vault or outside paths', async () => {
    const storageFs = fakeFs([DESIGNS, `${DESIGNS}/Landing`, '/vault/Notes']);
    expect(await removeStorageRoot(VAULT, `${DESIGNS}/Landing`, storageFs)).toBe(true);
    expect(storageFs.rm).toHaveBeenCalledTimes(1);
    for (const target of [DESIGNS, VAULT, HIDDEN, '/vault/Notes', '/vault/Designs/../Notes', '/', '/vault/Designs2/x']) {
      expect(await removeStorageRoot(VAULT, target, storageFs), target).toBe(false);
    }
    expect(storageFs.rm).toHaveBeenCalledTimes(1);
  });
});

describe('real filesystem', () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
  const tmpVault = async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'visible-artifacts-')));
    dirs.push(root);
    return root;
  };

  it('rejects a symlink inside Designs that escapes to a directory outside the allowlist', async () => {
    const vault = await tmpVault();
    const outside = await tmpVault();
    await mkdir(join(vault, 'Designs'), { recursive: true });
    await symlink(outside, join(vault, 'Designs', 'sneaky'));
    expect(resolveStorageRoot(vault, join(vault, 'Designs', 'sneaky')).status).toBe('invalid');
    expect(resolveStorageRoot(vault, join(vault, 'Designs', 'sneaky', 'deeper')).status).toBe('invalid');
    expect(await removeStorageRoot(vault, join(vault, 'Designs', 'sneaky'))).toBe(false);
    expect((await stat(outside)).isDirectory()).toBe(true);
  });

  it('rejects when Designs itself is a symlink out of the vault', async () => {
    const vault = await tmpVault();
    const outside = await tmpVault();
    await symlink(outside, join(vault, 'Designs'));
    expect(resolveStorageRoot(vault, join(vault, 'Designs', 'x')).status).toBe('invalid');
    const result = await allocateStorageRoot(vault, 'design-1', undefined, { location: 'visible', folderName: 'x' });
    expect(result.status).toBe('invalid');
  });

  it('allocates, collides and is reachable through real mkdir', async () => {
    const vault = await tmpVault();
    const first = await allocateStorageRoot(vault, 'a', undefined, { location: 'visible', folderName: 'Board' });
    const second = await allocateStorageRoot(vault, 'b', undefined, { location: 'visible', folderName: 'Board' });
    expect(first).toMatchObject({ status: 'ok', path: join(vault, 'Designs', 'Board') });
    expect(second).toMatchObject({ status: 'ok', path: join(vault, 'Designs', 'Board-2') });
    expect((await stat(join(vault, 'Designs', 'Board-2'))).isDirectory()).toBe(true);
  });

  it('garbage-collects a visible root on thread deletion, leaving Designs and siblings', async () => {
    const vault = await tmpVault();
    const mine = join(vault, 'Designs', 'Mine');
    const sibling = join(vault, 'Designs', 'Sibling');
    await mkdir(mine, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(join(mine, 'index.html'), '<!doctype html>');
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    manager.vaultRoot = vault;
    const thread = manager.createThread('Design');
    thread.artifacts = [
      { id: 'a', kind: 'design-static', title: 'A', providerId: 'p', schemaVersion: 1, storageRoot: mine, createdAt: 1, updatedAt: 1 },
      // Hostile/hand-edited: the Designs folder itself must survive.
      { id: 'b', kind: 'design-static', title: 'B', providerId: 'p', schemaVersion: 1, storageRoot: join(vault, 'Designs'), createdAt: 1, updatedAt: 1 },
      { id: 'c', kind: 'design-static', title: 'C', providerId: 'p', schemaVersion: 1, storageRoot: vault, createdAt: 1, updatedAt: 1 },
    ];

    manager.deleteThread(thread.id);
    await manager.artifactCleanupSettled;

    await expect(stat(mine)).rejects.toThrow();
    expect((await stat(sibling)).isDirectory()).toBe(true);
    expect((await stat(join(vault, 'Designs'))).isDirectory()).toBe(true);
    expect((await stat(vault)).isDirectory()).toBe(true);
  });
});

describe('artifacts.allocateStorage options', () => {
  const build = (threads: Record<string, { artifacts?: unknown[] }>, storageFs: ReturnType<typeof fakeFs>, extra: Record<string, unknown> = {}) =>
    createClaudeThreadsApiV1({
      getThreads: () => [], getThread: (id: string) => threads[id], isRunning: () => false,
      createThread: () => ({ id: 't' }), sendMessage: async () => {}, openThread: async () => {},
      subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null,
      triggerHostEvent: () => {},
      artifactProviders: new ArtifactProviderRegistry(),
      agentTools: new AgentToolRegistry(),
      getDefaultPermissionMode: () => 'default',
      artifactStore: createArtifactStore({ vaultRoot: () => VAULT, getThread: (id: string) => threads[id], saveSettings: async () => {}, storageFs }),
      ...extra,
    } as never);

  it('advertises artifacts.visibleStorage alongside allocateStorage', () => {
    const { api } = build({}, fakeFs());
    expect(api.capabilities).toContain('artifacts.visibleStorage');
    expect(api.capabilities).toContain('artifacts.allocateStorage');
  });

  it('allocates a visible root and reports status allocated', async () => {
    const { api } = build({ t1: { artifacts: [] } }, fakeFs());
    expect(await api.artifacts.allocateStorage('t1', 'design-1', { location: 'visible', folderName: 'Landing' }))
      .toEqual({ success: true, status: 'allocated', artifactId: 'design-1', path: `${DESIGNS}/Landing` });
  });

  it('is idempotent for the same thread and artifact, even with a different folderName', async () => {
    const storageFs = fakeFs();
    const { api } = build({ t1: { artifacts: [] } }, storageFs);
    await api.artifacts.allocateStorage('t1', 'design-1', { location: 'visible', folderName: 'Landing' });
    const again = await api.artifacts.allocateStorage('t1', 'design-1', { location: 'visible', folderName: 'Renamed' });
    expect(again).toMatchObject({ success: true, status: 'existing', path: `${DESIGNS}/Landing` });
    expect(storageFs.dirs.has(`${DESIGNS}/Renamed`)).toBe(false);
  });

  it('is idempotent after attach, using the persisted record storageRoot (e.g. after a restart)', async () => {
    const storageFs = fakeFs([DESIGNS, `${DESIGNS}/Landing`]);
    const { api } = build({ t1: { artifacts: [{ id: 'design-1', kind: 'k', title: 't', storageRoot: `${DESIGNS}/Landing`, createdAt: 1, updatedAt: 1 }] } }, storageFs);
    const result = await api.artifacts.allocateStorage('t1', 'design-1', { location: 'visible', folderName: 'Landing' });
    expect(result).toMatchObject({ success: true, status: 'existing', path: `${DESIGNS}/Landing` });
  });

  it('suffixes when another artifact already occupies the folder', async () => {
    const storageFs = fakeFs([DESIGNS, `${DESIGNS}/Landing`]);
    const { api } = build({ t1: { artifacts: [] }, t2: { artifacts: [] } }, storageFs);
    const result = await api.artifacts.allocateStorage('t2', 'design-2', { location: 'visible', folderName: 'Landing' });
    expect(result).toMatchObject({ success: true, status: 'allocated', path: `${DESIGNS}/Landing-2` });
  });

  it('gives concurrent same-name allocations distinct folders', async () => {
    const { api } = build({ t1: { artifacts: [] }, t2: { artifacts: [] } }, fakeFs());
    const [a, b] = await Promise.all([
      api.artifacts.allocateStorage('t1', 'design-1', { location: 'visible', folderName: 'Same' }),
      api.artifacts.allocateStorage('t2', 'design-2', { location: 'visible', folderName: 'Same' }),
    ]);
    expect(a).toMatchObject({ success: true });
    expect(b).toMatchObject({ success: true });
    expect(a.success && b.success && a.path !== b.path).toBe(true);
  });

  it('leaves the no-options call hidden and unchanged', async () => {
    const { api } = build({ t1: { artifacts: [] } }, fakeFs());
    expect(await api.artifacts.allocateStorage('t1', 'design-1'))
      .toEqual({ success: true, status: 'allocated', artifactId: 'design-1', path: `${HIDDEN}/design-1` });
  });

  it('rejects an invalid location with a structured result', async () => {
    const { api } = build({ t1: { artifacts: [] } }, fakeFs());
    expect(await api.artifacts.allocateStorage('t1', 'design-1', { location: 'cloud' as never }))
      .toMatchObject({ success: false, status: 'invalid' });
  });

  it('releases a visible root when the provisional transaction rolls back', async () => {
    const storageFs = fakeFs();
    const threads: Record<string, { artifacts?: unknown[] }> = { p1: { artifacts: [] } };
    const rollback = vi.fn(async () => {});
    const { api } = build(threads, storageFs, {
      beginProvisionalThread: async () => ({ thread: { id: 'p1' }, commit: async () => {}, rollback }),
    });
    const handle = await api.threads.beginProvisional({ pluginId: 'agent-threads.design' } as never, { title: 'x' } as never);
    const allocated = await api.artifacts.allocateStorage(handle.threadId, 'design-1', { location: 'visible', folderName: 'Landing' });
    expect(allocated).toMatchObject({ success: true, path: `${DESIGNS}/Landing` });
    await handle.rollback();
    expect(storageFs.rm).toHaveBeenCalledWith(`${DESIGNS}/Landing`, { recursive: true, force: true });
    expect(storageFs.dirs.has(`${DESIGNS}/Landing`)).toBe(false);
  });
});

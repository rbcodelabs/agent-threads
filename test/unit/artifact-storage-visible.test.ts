/**
 * Visible artifact storage (ADR-0010 addendum).
 *
 * Artifacts may live in `<vault>/<root>/<namespace>/<name>` (root: the
 * `visibleArtifactRoot` setting, default `Artifacts`; namespace: the calling
 * plugin id) as well as the hidden `<vault>/.geode/artifacts/<id>`. The
 * allowlist is the safety boundary: the recursive delete that garbage-collects
 * a thread's storage must never be steerable at the root, a namespace folder,
 * the vault, or anything else.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_VISIBLE_ARTIFACT_ROOT,
  allocateStorageRoot,
  artifactStorageRoot,
  removeStorageRoot,
  resolveStorageRoot,
  sanitizeFolderName,
  sanitizeVisibleRootName,
  visibleArtifactRoot,
  visibleNamespace,
} from '../../src/artifactStorage';
import { createArtifactStore } from '../../src/artifactStore';
import { createClaudeThreadsApiV1 } from '../../src/PublicApi';
import { ArtifactProviderRegistry } from '../../src/ArtifactContributions';
import { AgentToolRegistry } from '../../src/AgentToolContributions';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';

const VAULT = '/vault';
const HIDDEN = '/vault/.geode/artifacts';
const ROOT = '/vault/Artifacts';
const OWNER = { pluginId: 'example.plugin' };
const OTHER = { pluginId: 'other.plugin' };
/** The namespace folder OWNER's artifacts live in. */
const NS = `${ROOT}/example.plugin`;

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

describe('visible root constant and setting', () => {
  it('defaults to Artifacts', () => {
    expect(DEFAULT_VISIBLE_ARTIFACT_ROOT).toBe('Artifacts');
    expect(visibleArtifactRoot(VAULT, 'Artifacts')).toBe(ROOT);
  });

  it('sanitizes the setting to one segment, falling back to the default', () => {
    expect(sanitizeVisibleRootName('My Stuff')).toBe('My Stuff');
    for (const bad of ['', '   ', '..', '/', undefined, null, 42, '\u0000']) {
      expect(sanitizeVisibleRootName(bad), String(bad)).toBe('Artifacts');
    }
    for (const hostile of ['../x', 'a/b', '..\\x', '/abs', '.geode', '.hidden/../..']) {
      const cleaned = sanitizeVisibleRootName(hostile);
      expect(cleaned, hostile).not.toMatch(/[\\/]/);
      expect(cleaned, hostile).not.toContain('..');
      expect(cleaned.startsWith('.'), hostile).toBe(false);
    }
  });
});

describe('visibleNamespace', () => {
  it('accepts a safe plugin id as is', () => {
    expect(visibleNamespace({ pluginId: 'agent-threads.design' })).toEqual({ ok: true, namespace: 'agent-threads.design' });
  });

  it('rejects missing, empty and unsafe ids rather than cleaning them', () => {
    for (const owner of [undefined, null, {}, { pluginId: '' }, { pluginId: '  ' }, { pluginId: 42 }, { pluginId: '../x' }, { pluginId: 'a/b' },
      { pluginId: 'a\\b' }, { pluginId: '.hidden' }, { pluginId: 'a..b' }, { pluginId: 'a b' }, { pluginId: 'x'.repeat(81) }, { pluginId: 'a\0b' }]) {
      expect(visibleNamespace(owner).ok, JSON.stringify(owner)).toBe(false);
    }
  });
});

describe('resolveStorageRoot allowlist', () => {
  it('accepts a root strictly inside a namespace and inside the hidden root', () => {
    const storageFs = fakeFs();
    expect(resolveStorageRoot(VAULT, `${NS}/Landing`, storageFs)).toEqual({ status: 'ok', path: `${NS}/Landing` });
    expect(resolveStorageRoot(VAULT, `${NS}/Landing/deeper`, storageFs)).toEqual({ status: 'ok', path: `${NS}/Landing/deeper` });
    expect(resolveStorageRoot(VAULT, `${HIDDEN}/design-1`, storageFs)).toEqual({ status: 'ok', path: `${HIDDEN}/design-1` });
  });

  it('rejects the bare root, a bare namespace folder, the hidden root and the vault root', () => {
    const storageFs = fakeFs([ROOT, NS]);
    for (const target of [ROOT, `${ROOT}/`, NS, `${NS}/`, `${NS}/.`, HIDDEN, VAULT, '/vault/.geode', `${ROOT}/..`, `${NS}/..`]) {
      expect(resolveStorageRoot(VAULT, target, storageFs).status, target).toBe('invalid');
    }
  });

  it('rejects look-alike siblings and traversal out of the root', () => {
    const storageFs = fakeFs([ROOT]);
    for (const target of ['/vault/Artifacts2/x/y', '/vault/Artifact/x/y', '/vault/Notes', `${NS}/../../Notes/x`, '/vault/artifacts-old/x/y', 'Artifacts/x/y', '/vault/Designs/x/y']) {
      expect(resolveStorageRoot(VAULT, target, storageFs).status, target).toBe('invalid');
    }
  });

  it('still rejects null bytes and over-long roots', () => {
    const storageFs = fakeFs();
    expect(resolveStorageRoot(VAULT, `${NS}/a\0b`, storageFs).status).toBe('invalid');
    expect(resolveStorageRoot(VAULT, `${NS}/${'a'.repeat(5000)}`, storageFs).status).toBe('invalid');
  });

  it('honors a configured root and still trusts the default one', () => {
    const storageFs = fakeFs();
    expect(resolveStorageRoot(VAULT, '/vault/Board Files/p/x', storageFs, 'Board Files').status).toBe('ok');
    expect(resolveStorageRoot(VAULT, '/vault/Board Files/p', storageFs, 'Board Files').status).toBe('invalid');
    expect(resolveStorageRoot(VAULT, '/vault/Board Files', storageFs, 'Board Files').status).toBe('invalid');
    // Previously allocated under the default: still trusted after the rename.
    expect(resolveStorageRoot(VAULT, `${NS}/x`, storageFs, 'Board Files').status).toBe('ok');
    // But a third, no-longer-configured root is not.
    expect(resolveStorageRoot(VAULT, '/vault/Old Name/p/x', storageFs, 'Board Files').status).toBe('invalid');
  });

  it('falls back to the default when the configured root is unusable', () => {
    const storageFs = fakeFs();
    expect(resolveStorageRoot(VAULT, `${NS}/x`, storageFs, '../..').status).toBe('ok');
    expect(resolveStorageRoot(VAULT, '/vault/Notes/p/x', storageFs, '../..').status).toBe('invalid');
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
  it('creates <vault>/<root>/<namespace>/<name>, including the root and namespace folders', async () => {
    const storageFs = fakeFs();
    const result = await allocateStorageRoot(VAULT, 'design-1', storageFs, { location: 'visible', owner: OWNER, folderName: 'Landing Page' });
    expect(result).toMatchObject({ status: 'ok', path: `${NS}/Landing Page`, existed: false });
    expect(storageFs.mkdir).toHaveBeenCalledWith(`${NS}/Landing Page`, { recursive: true });
  });

  it('uses the artifact id when no usable folder name is given', async () => {
    const storageFs = fakeFs();
    const result = await allocateStorageRoot(VAULT, 'design-1', storageFs, { location: 'visible', owner: OWNER, folderName: '../..' });
    expect(result).toMatchObject({ status: 'ok', path: `${NS}/design-1` });
  });

  it('never escapes the namespace with a hostile folder name', async () => {
    const storageFs = fakeFs();
    const result = await allocateStorageRoot(VAULT, 'design-1', storageFs, { location: 'visible', owner: OWNER, folderName: '../../.geode/artifacts/../../x' });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.path.startsWith(`${NS}/`)).toBe(true);
  });

  it('appends -2, -3 on collision with a directory this artifact does not own', async () => {
    const storageFs = fakeFs([ROOT, NS, `${NS}/Landing`, `${NS}/Landing-2`]);
    const result = await allocateStorageRoot(VAULT, 'design-1', storageFs, { location: 'visible', owner: OWNER, folderName: 'Landing' });
    expect(result).toMatchObject({ status: 'ok', path: `${NS}/Landing-3`, existed: false });
    expect(storageFs.mkdir).toHaveBeenCalledTimes(1);
  });

  it('returns the artifact\'s own root as existing instead of suffixing', async () => {
    const storageFs = fakeFs([ROOT, NS, `${NS}/Landing`]);
    const result = await allocateStorageRoot(VAULT, 'design-1', storageFs, {
      location: 'visible', owner: OWNER, folderName: 'Something else', ownedRoot: `${NS}/Landing`,
    });
    expect(result).toMatchObject({ status: 'ok', path: `${NS}/Landing`, existed: true });
  });

  it('ignores an owned root that is not inside the allowlist', async () => {
    const storageFs = fakeFs([ROOT, NS]);
    const result = await allocateStorageRoot(VAULT, 'design-1', storageFs, {
      location: 'visible', owner: OWNER, folderName: 'Landing', ownedRoot: '/vault/Notes',
    });
    expect(result).toMatchObject({ status: 'ok', path: `${NS}/Landing` });
  });

  it('keeps the hidden default untouched, ignoring folderName', async () => {
    const storageFs = fakeFs();
    const noOptions = await allocateStorageRoot(VAULT, 'design-1', storageFs);
    expect(noOptions).toMatchObject({ status: 'ok', path: `${HIDDEN}/design-1` });
    const hidden = await allocateStorageRoot(VAULT, 'design-2', storageFs, { location: 'hidden', folderName: 'Nope' });
    expect(hidden).toMatchObject({ status: 'ok', path: `${HIDDEN}/design-2` });
    expect(storageFs.dirs.has(ROOT)).toBe(false);
  });

  it('uses the configured root, sanitized, and falls back to the default when unusable', async () => {
    const storageFs = fakeFs();
    const custom = await allocateStorageRoot(VAULT, 'd1', storageFs, { location: 'visible', owner: OWNER, folderName: 'Landing', visibleRoot: 'Board Files' });
    expect(custom).toMatchObject({ status: 'ok', path: '/vault/Board Files/example.plugin/Landing' });
    const hostile = await allocateStorageRoot(VAULT, 'd2', storageFs, { location: 'visible', owner: OWNER, folderName: 'L', visibleRoot: '../../etc' });
    expect(hostile).toMatchObject({ status: 'ok', path: '/vault/etc/example.plugin/L' });
    const fallback = await allocateStorageRoot(VAULT, 'd3', storageFs, { location: 'visible', owner: OWNER, folderName: 'L', visibleRoot: '..' });
    expect(fallback).toMatchObject({ status: 'ok', path: `${NS}/L` });
  });

  it('derives the namespace from the owner: two plugins get separate namespaces, even for the same folderName', async () => {
    const storageFs = fakeFs();
    const mine = await allocateStorageRoot(VAULT, 'd1', storageFs, { location: 'visible', owner: OWNER, folderName: 'Same' });
    const theirs = await allocateStorageRoot(VAULT, 'd2', storageFs, { location: 'visible', owner: OTHER, folderName: 'Same' });
    expect(mine).toMatchObject({ status: 'ok', path: `${ROOT}/example.plugin/Same` });
    expect(theirs).toMatchObject({ status: 'ok', path: `${ROOT}/other.plugin/Same` });
  });

  it('requires an owner for visible allocation and rejects unsafe plugin ids, creating nothing', async () => {
    const storageFs = fakeFs();
    for (const owner of [undefined, { pluginId: '' }, { pluginId: '../other.plugin' }, { pluginId: 'a/b' }, { pluginId: '..' }]) {
      const result = await allocateStorageRoot(VAULT, 'd1', storageFs, { location: 'visible', owner: owner as never, folderName: 'x' });
      expect(result.status, JSON.stringify(owner)).toBe('invalid');
    }
    expect(storageFs.mkdir).not.toHaveBeenCalled();
  });

  it('ignores owner for hidden allocation', async () => {
    const storageFs = fakeFs();
    expect(await allocateStorageRoot(VAULT, 'd1', storageFs, { location: 'hidden', owner: { pluginId: '../x' } as never }))
      .toMatchObject({ status: 'ok', path: `${HIDDEN}/d1` });
  });

  it('returns an existing owned root whichever owner is passed on re-allocation', async () => {
    const storageFs = fakeFs([ROOT, NS, `${NS}/Landing`]);
    const result = await allocateStorageRoot(VAULT, 'd1', storageFs, {
      location: 'visible', owner: OTHER, folderName: 'Whatever', ownedRoot: `${NS}/Landing`,
    });
    expect(result).toMatchObject({ status: 'ok', path: `${NS}/Landing`, existed: true });
  });

  it('keeps honoring an owned root under the default root after the setting is renamed', async () => {
    const storageFs = fakeFs([ROOT, NS, `${NS}/Landing`]);
    const result = await allocateStorageRoot(VAULT, 'd1', storageFs, {
      location: 'visible', owner: OWNER, folderName: 'Landing', ownedRoot: `${NS}/Landing`, visibleRoot: 'Renamed',
    });
    expect(result).toMatchObject({ status: 'ok', path: `${NS}/Landing`, existed: true });
  });

  it('rejects an unknown location and a bad artifact id', async () => {
    const storageFs = fakeFs();
    expect((await allocateStorageRoot(VAULT, 'design-1', storageFs, { location: 'elsewhere' as never })).status).toBe('invalid');
    expect((await allocateStorageRoot(VAULT, '../x', storageFs, { location: 'visible', owner: OWNER })).status).toBe('invalid');
    expect(storageFs.mkdir).not.toHaveBeenCalled();
  });

  it('refuses when the visible root is a symlink resolving outside the vault', async () => {
    const storageFs = fakeFs([ROOT, NS]);
    const real = storageFs.realpathSync;
    storageFs.realpathSync = (target: string) => (target === ROOT ? '/elsewhere/Artifacts' : real(target));
    const result = await allocateStorageRoot(VAULT, 'design-1', storageFs, { location: 'visible', owner: OWNER, folderName: 'x' });
    expect(result.status).toBe('invalid');
    expect(storageFs.mkdir).not.toHaveBeenCalled();
  });
});

describe('removeStorageRoot allowlist', () => {
  it('removes a root inside a namespace but never the root, a namespace, the vault or outside paths', async () => {
    const storageFs = fakeFs([ROOT, NS, `${NS}/Landing`, '/vault/Notes']);
    expect(await removeStorageRoot(VAULT, `${NS}/Landing`, storageFs)).toBe(true);
    expect(storageFs.rm).toHaveBeenCalledTimes(1);
    for (const target of [ROOT, NS, VAULT, HIDDEN, '/vault/Notes', '/vault/Artifacts/../Notes', '/', '/vault/Artifacts2/x/y']) {
      expect(await removeStorageRoot(VAULT, target, storageFs), target).toBe(false);
    }
    expect(storageFs.rm).toHaveBeenCalledTimes(1);
  });
});

describe('removeStorageRoot with a configured root', () => {
  it('removes under the configured root and the default, never a root or namespace, nor an old third root', async () => {
    const storageFs = fakeFs();
    expect(await removeStorageRoot(VAULT, '/vault/Board Files/p/x', storageFs, 'Board Files')).toBe(true);
    expect(await removeStorageRoot(VAULT, `${NS}/x`, storageFs, 'Board Files')).toBe(true);
    for (const target of ['/vault/Board Files', '/vault/Board Files/p', '/vault/Old/p/x', ROOT, NS]) {
      expect(await removeStorageRoot(VAULT, target, storageFs, 'Board Files'), target).toBe(false);
    }
    expect(storageFs.rm).toHaveBeenCalledTimes(2);
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

  it('rejects a symlink inside a namespace that escapes to a directory outside the allowlist', async () => {
    const vault = await tmpVault();
    const outside = await tmpVault();
    await mkdir(join(vault, 'Artifacts', 'p'), { recursive: true });
    await symlink(outside, join(vault, 'Artifacts', 'p', 'sneaky'));
    expect(resolveStorageRoot(vault, join(vault, 'Artifacts', 'p', 'sneaky')).status).toBe('invalid');
    expect(resolveStorageRoot(vault, join(vault, 'Artifacts', 'p', 'sneaky', 'deeper')).status).toBe('invalid');
    expect(await removeStorageRoot(vault, join(vault, 'Artifacts', 'p', 'sneaky'))).toBe(false);
    expect((await stat(outside)).isDirectory()).toBe(true);
  });

  it('rejects when the root, or a namespace, is a symlink out of the vault or onto the bare root', async () => {
    const vault = await tmpVault();
    const outside = await tmpVault();
    await symlink(outside, join(vault, 'Artifacts'));
    expect(resolveStorageRoot(vault, join(vault, 'Artifacts', 'p', 'x')).status).toBe('invalid');
    const result = await allocateStorageRoot(vault, 'design-1', undefined, { location: 'visible', owner: OWNER, folderName: 'x' });
    expect(result.status).toBe('invalid');
  });

  it('rejects a namespace symlinked back onto the bare root', async () => {
    const vault = await tmpVault();
    await mkdir(join(vault, 'Artifacts'), { recursive: true });
    await symlink(join(vault, 'Artifacts'), join(vault, 'Artifacts', 'loop'));
    expect(resolveStorageRoot(vault, join(vault, 'Artifacts', 'loop', 'x')).status).toBe('invalid');
    expect(await removeStorageRoot(vault, join(vault, 'Artifacts', 'loop', 'x'))).toBe(false);
  });

  it('allocates, collides and is reachable through real mkdir', async () => {
    const vault = await tmpVault();
    const first = await allocateStorageRoot(vault, 'a', undefined, { location: 'visible', owner: OWNER, folderName: 'Board' });
    const second = await allocateStorageRoot(vault, 'b', undefined, { location: 'visible', owner: OWNER, folderName: 'Board' });
    expect(first).toMatchObject({ status: 'ok', path: join(vault, 'Artifacts', 'example.plugin', 'Board') });
    expect(second).toMatchObject({ status: 'ok', path: join(vault, 'Artifacts', 'example.plugin', 'Board-2') });
    expect((await stat(join(vault, 'Artifacts', 'example.plugin', 'Board-2'))).isDirectory()).toBe(true);
  });

  it('garbage-collects a visible root on thread deletion, leaving the root, namespace and siblings', async () => {
    const vault = await tmpVault();
    const mine = join(vault, 'Artifacts', 'p', 'Mine');
    const sibling = join(vault, 'Artifacts', 'p', 'Sibling');
    await mkdir(mine, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(join(mine, 'index.html'), '<!doctype html>');
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    manager.vaultRoot = vault;
    const thread = manager.createThread('Design');
    thread.artifacts = [
      { id: 'a', kind: 'design-static', title: 'A', providerId: 'p', schemaVersion: 1, storageRoot: mine, createdAt: 1, updatedAt: 1 },
      // Hostile/hand-edited: the root and the namespace folder must survive.
      { id: 'b', kind: 'design-static', title: 'B', providerId: 'p', schemaVersion: 1, storageRoot: join(vault, 'Artifacts'), createdAt: 1, updatedAt: 1 },
      { id: 'd', kind: 'design-static', title: 'D', providerId: 'p', schemaVersion: 1, storageRoot: join(vault, 'Artifacts', 'p'), createdAt: 1, updatedAt: 1 },
      { id: 'c', kind: 'design-static', title: 'C', providerId: 'p', schemaVersion: 1, storageRoot: vault, createdAt: 1, updatedAt: 1 },
    ];

    manager.deleteThread(thread.id);
    await manager.artifactCleanupSettled;

    await expect(stat(mine)).rejects.toThrow();
    expect((await stat(sibling)).isDirectory()).toBe(true);
    expect((await stat(join(vault, 'Artifacts', 'p'))).isDirectory()).toBe(true);
    expect((await stat(join(vault, 'Artifacts'))).isDirectory()).toBe(true);
    expect((await stat(vault)).isDirectory()).toBe(true);
  });
});

describe('artifacts.allocateStorage options', () => {
  const build = (threads: Record<string, { artifacts?: unknown[] }>, storageFs: ReturnType<typeof fakeFs>, extra: Record<string, unknown> = {}, visibleRoot?: string) =>
    createClaudeThreadsApiV1({
      getThreads: () => [], getThread: (id: string) => threads[id], isRunning: () => false,
      createThread: () => ({ id: 't' }), sendMessage: async () => {}, openThread: async () => {},
      subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null,
      triggerHostEvent: () => {},
      artifactProviders: new ArtifactProviderRegistry(),
      agentTools: new AgentToolRegistry(),
      getDefaultPermissionMode: () => 'default',
      artifactStore: createArtifactStore({ vaultRoot: () => VAULT, getThread: (id: string) => threads[id], saveSettings: async () => {}, storageFs, visibleRoot: () => visibleRoot }),
      ...extra,
    } as never);

  it('advertises artifacts.visibleStorage alongside allocateStorage', () => {
    const { api } = build({}, fakeFs());
    expect(api.capabilities).toContain('artifacts.visibleStorage');
    expect(api.capabilities).toContain('artifacts.allocateStorage');
  });

  it('allocates a visible root and reports status allocated', async () => {
    const { api } = build({ t1: { artifacts: [] } }, fakeFs());
    expect(await api.artifacts.allocateStorage('t1', 'design-1', { location: 'visible', owner: OWNER, folderName: 'Landing' }))
      .toEqual({ success: true, status: 'allocated', artifactId: 'design-1', path: `${NS}/Landing` });
  });

  it('is idempotent for the same thread and artifact, even with a different folderName', async () => {
    const storageFs = fakeFs();
    const { api } = build({ t1: { artifacts: [] } }, storageFs);
    await api.artifacts.allocateStorage('t1', 'design-1', { location: 'visible', owner: OWNER, folderName: 'Landing' });
    const again = await api.artifacts.allocateStorage('t1', 'design-1', { location: 'visible', owner: OWNER, folderName: 'Renamed' });
    expect(again).toMatchObject({ success: true, status: 'existing', path: `${NS}/Landing` });
    expect(storageFs.dirs.has(`${NS}/Renamed`)).toBe(false);
  });

  it('is idempotent after attach, using the persisted record storageRoot (e.g. after a restart)', async () => {
    const storageFs = fakeFs([ROOT, NS, `${NS}/Landing`]);
    const { api } = build({ t1: { artifacts: [{ id: 'design-1', kind: 'k', title: 't', storageRoot: `${NS}/Landing`, createdAt: 1, updatedAt: 1 }] } }, storageFs);
    const result = await api.artifacts.allocateStorage('t1', 'design-1', { location: 'visible', owner: OWNER, folderName: 'Landing' });
    expect(result).toMatchObject({ success: true, status: 'existing', path: `${NS}/Landing` });
  });

  it('suffixes when another artifact already occupies the folder', async () => {
    const storageFs = fakeFs([ROOT, NS, `${NS}/Landing`]);
    const { api } = build({ t1: { artifacts: [] }, t2: { artifacts: [] } }, storageFs);
    const result = await api.artifacts.allocateStorage('t2', 'design-2', { location: 'visible', owner: OWNER, folderName: 'Landing' });
    expect(result).toMatchObject({ success: true, status: 'allocated', path: `${NS}/Landing-2` });
  });

  it('gives concurrent same-name allocations distinct folders', async () => {
    const { api } = build({ t1: { artifacts: [] }, t2: { artifacts: [] } }, fakeFs());
    const [a, b] = await Promise.all([
      api.artifacts.allocateStorage('t1', 'design-1', { location: 'visible', owner: OWNER, folderName: 'Same' }),
      api.artifacts.allocateStorage('t2', 'design-2', { location: 'visible', owner: OWNER, folderName: 'Same' }),
    ]);
    expect(a).toMatchObject({ success: true });
    expect(b).toMatchObject({ success: true });
    expect(a.success && b.success && a.path !== b.path).toBe(true);
  });

  it('rejects visible allocation without a usable owner, and creates nothing', async () => {
    const storageFs = fakeFs();
    const { api } = build({ t1: { artifacts: [] } }, storageFs);
    for (const owner of [undefined, { pluginId: '' }, { pluginId: '../other.plugin' }]) {
      expect(await api.artifacts.allocateStorage('t1', 'design-1', { location: 'visible', folderName: 'x', owner } as never), JSON.stringify(owner))
        .toMatchObject({ success: false, status: 'invalid' });
    }
    expect(storageFs.mkdir).not.toHaveBeenCalled();
  });

  it('gives two plugins separate namespaces', async () => {
    const { api } = build({ t1: { artifacts: [] }, t2: { artifacts: [] } }, fakeFs());
    const mine = await api.artifacts.allocateStorage('t1', 'design-1', { location: 'visible', owner: OWNER, folderName: 'Same' });
    const theirs = await api.artifacts.allocateStorage('t2', 'design-2', { location: 'visible', owner: OTHER, folderName: 'Same' });
    expect(mine).toMatchObject({ success: true, path: `${ROOT}/example.plugin/Same` });
    expect(theirs).toMatchObject({ success: true, path: `${ROOT}/other.plugin/Same` });
  });

  it('returns the same path on re-allocation even when a different owner is passed', async () => {
    const { api } = build({ t1: { artifacts: [] } }, fakeFs());
    await api.artifacts.allocateStorage('t1', 'design-1', { location: 'visible', owner: OWNER, folderName: 'Landing' });
    const again = await api.artifacts.allocateStorage('t1', 'design-1', { location: 'visible', owner: OTHER, folderName: 'Landing' });
    expect(again).toMatchObject({ success: true, status: 'existing', path: `${NS}/Landing` });
  });

  it('uses the configured visible root from the host setting', async () => {
    const { api } = build({ t1: { artifacts: [] } }, fakeFs(), {}, 'Board Files');
    expect(await api.artifacts.allocateStorage('t1', 'design-1', { location: 'visible', owner: OWNER, folderName: 'Landing' }))
      .toMatchObject({ success: true, path: '/vault/Board Files/example.plugin/Landing' });
  });

  it('attach and update accept roots inside the namespace and reject the bare root and bare namespace', async () => {
    const ATTACH_OWNER = { pluginId: 'example-plugin' };
    const storageFs = fakeFs([ROOT, NS]);
    const registry = new ArtifactProviderRegistry();
    registry.register(ATTACH_OWNER, { providerId: 'example-plugin.artifacts', kinds: ['k'], present: () => ({}), invoke: async () => ({ status: 'ok' }) } as never);
    const threads: Record<string, { artifacts?: unknown[] }> = { t1: { artifacts: [] } };
    const { api } = build(threads, storageFs, { artifactProviders: registry });
    const ref = (storageRoot: string) => ({ id: 'a1', kind: 'k', title: 'T', providerId: 'example-plugin.artifacts', storageRoot });
    for (const bad of [ROOT, NS]) {
      expect(await api.artifacts.attach(ATTACH_OWNER, 't1', ref(bad) as never), bad).toMatchObject({ success: false, status: 'invalid', message: expect.stringMatching(/bare namespace|artifact root itself/) });
    }
    const attached = await api.artifacts.attach(ATTACH_OWNER, 't1', ref(`${NS}/Landing`) as never);
    expect(attached, JSON.stringify(attached)).toMatchObject({ success: true });
    for (const bad of [ROOT, NS]) {
      expect(await api.artifacts.update(ATTACH_OWNER, 't1', 'a1', { storageRoot: bad }), bad).toMatchObject({ success: false, status: 'invalid', message: expect.stringMatching(/bare namespace|artifact root itself/) });
    }
    expect(await api.artifacts.update(ATTACH_OWNER, 't1', 'a1', { storageRoot: `${NS}/Other` })).toMatchObject({ success: true });
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
    const handle = await api.threads.beginProvisional(OWNER as never, { title: 'x' } as never);
    const allocated = await api.artifacts.allocateStorage(handle.threadId, 'design-1', { location: 'visible', owner: OWNER, folderName: 'Landing' });
    expect(allocated).toMatchObject({ success: true, path: `${NS}/Landing` });
    await handle.rollback();
    expect(storageFs.rm).toHaveBeenCalledWith(`${NS}/Landing`, { recursive: true, force: true });
    expect(storageFs.dirs.has(`${NS}/Landing`)).toBe(false);
  });
});

describe('agent tool host injects the registered owner', () => {
  const register = (registry: AgentToolRegistry, owner: { pluginId: string }, seen: { id: string; options?: unknown }[]) => {
    const result = registry.register(owner, {
      name: `${owner.pluginId.replace(/\W/g, '_')}_tool`,
      description: 'allocates',
      inputSchema: { type: 'object', properties: {} },
      invoke: async (_threadId: string, _args: unknown, host: { allocateStorage(id: string, options?: unknown): Promise<unknown> }) => {
        // A hostile tool tries to claim someone else's namespace.
        await host.allocateStorage('a1', { location: 'visible', folderName: 'x', owner: { pluginId: 'victim.plugin' } });
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
    } as never);
    expect(result.success).toBe(true);
    void seen;
  };

  it('overwrites a tool-supplied owner with the registered one, via bindAll and invoke', async () => {
    const registry = new AgentToolRegistry();
    register(registry, OWNER, []);
    const seen: { id: string; options?: { owner?: { pluginId: string } } }[] = [];
    const host = {
      permissions: async () => null,
      allocateStorage: async (id: string, options?: { owner?: { pluginId: string } }) => {
        seen.push({ id, options });
        return { success: true as const, status: 'allocated' as const, artifactId: id, path: '/p' };
      },
    };
    const [bound] = registry.bindAll('t1', host as never);
    await bound.invoke({});
    await registry.invoke('example_plugin_tool', 't1', {}, host as never);
    expect(seen).toHaveLength(2);
    for (const call of seen) expect(call.options?.owner).toEqual({ pluginId: 'example.plugin' });
  });
});

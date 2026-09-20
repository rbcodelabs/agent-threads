/**
 * `artifacts.allocateStorage` (ADR-0008).
 *
 * Before this, `attach` accepted only a root under `<vault>/.geode/artifacts/`
 * — a location the host never disclosed — so a peer had to derive the layout
 * by hand and hope. The host now creates and returns it.
 *
 * Two properties carry the weight: it must reuse the existing
 * `resolveStorageRoot` containment check rather than a second copy (that check
 * is what stops a peer steering a later recursive delete at an arbitrary
 * directory), and it must be idempotent, because re-entering design mode on a
 * thread re-allocates the same root over a user's existing work.
 */
import { describe, expect, it, vi } from 'vitest';
import { allocateStorageRoot } from '../../src/artifactStorage';
import { createArtifactStore } from '../../src/artifactStore';
import { createClaudeThreadsApiV1 } from '../../src/PublicApi';
import { ArtifactProviderRegistry } from '../../src/ArtifactContributions';
import { AgentToolRegistry } from '../../src/AgentToolContributions';

const VAULT = '/vault';
const ARTIFACT_ROOT = '/vault/.geode/artifacts';

/** In-memory filesystem: `dirs` is what exists, `mkdir` records creation. */
function fakeFs(existing: string[] = []) {
  const dirs = new Set<string>([VAULT, '/vault/.geode', ARTIFACT_ROOT, ...existing]);
  const created: string[] = [];
  return {
    dirs,
    created,
    realpathSync: (target: string) => {
      if (!dirs.has(target)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return target;
    },
    mkdir: vi.fn(async (target: string) => { created.push(target); dirs.add(target); }),
    rm: vi.fn(async () => {}),
  };
}

describe('allocateStorageRoot', () => {
  it('creates the root under the vault artifact directory and returns it', async () => {
    const storageFs = fakeFs();
    const result = await allocateStorageRoot(VAULT, 'design-thread-1', storageFs);
    expect(result).toMatchObject({ status: 'ok', path: `${ARTIFACT_ROOT}/design-thread-1`, existed: false });
    expect(storageFs.created).toEqual([`${ARTIFACT_ROOT}/design-thread-1`]);
  });

  it('is idempotent: re-allocating returns the same root and writes nothing new', async () => {
    const storageFs = fakeFs();
    const first = await allocateStorageRoot(VAULT, 'design-1', storageFs);
    const second = await allocateStorageRoot(VAULT, 'design-1', storageFs);

    expect(first).toMatchObject({ status: 'ok', existed: false });
    // The second call reports the root as pre-existing, so a caller can tell
    // "created" from "already yours" without probing the filesystem.
    expect(second).toMatchObject({ status: 'ok', path: first.status === 'ok' ? first.path : '', existed: true });
    // `mkdir` is recursive, so re-entry never clobbers; nothing else is written.
    expect(storageFs.mkdir).toHaveBeenCalledTimes(2);
    expect(storageFs.rm).not.toHaveBeenCalled();
  });

  it('refuses ids that would escape the artifact root', async () => {
    const storageFs = fakeFs();
    for (const id of ['../evil', '../../etc', 'a/b', '/absolute', '..', '.', 'x\0y', '']) {
      const result = await allocateStorageRoot(VAULT, id, storageFs);
      expect(result.status, id).toBe('invalid');
    }
    // Nothing was created by any rejected attempt.
    expect(storageFs.mkdir).not.toHaveBeenCalled();
  });

  it('relies on the shared containment check, not a parallel copy', async () => {
    // A symlinked artifact id that resolves outside the artifact root is
    // caught by resolveStorageRoot's realpath containment, not by the id
    // pattern — proving allocation goes through that same check.
    const storageFs = fakeFs([`${ARTIFACT_ROOT}/sneaky`]);
    storageFs.realpathSync = (target: string) =>
      target === `${ARTIFACT_ROOT}/sneaky` ? '/etc/passwd.d' : (storageFs.dirs.has(target) ? target : (() => { throw new Error('ENOENT'); })());

    const result = await allocateStorageRoot(VAULT, 'sneaky', storageFs);
    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.message).toMatch(/resolve inside/);
    expect(storageFs.mkdir).not.toHaveBeenCalled();
  });

  it('refuses when the host has no vault or no way to create directories', async () => {
    expect((await allocateStorageRoot('', 'design-1', fakeFs())).status).toBe('invalid');
    const noMkdir = { realpathSync: (target: string) => target };
    expect((await allocateStorageRoot(VAULT, 'design-1', noMkdir)).status).toBe('invalid');
  });
});

describe('artifacts.allocateStorage', () => {
  const api = (threads: Record<string, { artifacts?: unknown[] }>, storageFs: ReturnType<typeof fakeFs>) =>
    createClaudeThreadsApiV1({
      getThreads: () => [], getThread: (id: string) => threads[id], isRunning: () => false,
      createThread: () => ({ id: 't' }), sendMessage: async () => {}, openThread: async () => {},
      subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null,
      triggerHostEvent: () => {},
      artifactProviders: new ArtifactProviderRegistry(),
      agentTools: new AgentToolRegistry(),
      getDefaultPermissionMode: () => 'default',
      artifactStore: createArtifactStore({
        vaultRoot: () => VAULT,
        getThread: (id: string) => threads[id],
        saveSettings: async () => {},
        storageFs,
      }),
    } as never);

  it('advertises the capability and allocates for a known thread', async () => {
    const storageFs = fakeFs();
    const service = api({ 't1': { artifacts: [] } }, storageFs);
    expect(service.api.capabilities).toContain('artifacts.allocateStorage');

    const result = await service.api.artifacts.allocateStorage('t1', 'design-t1');
    expect(result).toEqual({ success: true, status: 'allocated', artifactId: 'design-t1', path: `${ARTIFACT_ROOT}/design-t1` });
  });

  it('reports `existing` on re-allocation without clobbering', async () => {
    const storageFs = fakeFs();
    const service = api({ 't1': { artifacts: [] } }, storageFs);
    await service.api.artifacts.allocateStorage('t1', 'design-t1');
    const again = await service.api.artifacts.allocateStorage('t1', 'design-t1');
    expect(again).toMatchObject({ success: true, status: 'existing', path: `${ARTIFACT_ROOT}/design-t1` });
    expect(storageFs.rm).not.toHaveBeenCalled();
  });

  it('rejects a traversal attempt with a structured result rather than throwing', async () => {
    const storageFs = fakeFs();
    const service = api({ 't1': { artifacts: [] } }, storageFs);
    const result = await service.api.artifacts.allocateStorage('t1', '../../../etc');
    expect(result).toMatchObject({ success: false, status: 'invalid' });
    expect(storageFs.mkdir).not.toHaveBeenCalled();
  });

  it('refuses an unknown thread, so no root outlives a collectable owner', async () => {
    const storageFs = fakeFs();
    const service = api({}, storageFs);
    expect(await service.api.artifacts.allocateStorage('missing', 'design-x'))
      .toMatchObject({ success: false, status: 'thread-not-found' });
    expect(storageFs.mkdir).not.toHaveBeenCalled();
  });

  it('is revoked after stop()', async () => {
    const service = api({ 't1': { artifacts: [] } }, fakeFs());
    service.stop();
    await expect(service.api.artifacts.allocateStorage('t1', 'design-t1')).rejects.toThrow(/not available/i);
  });
});

describe('threads.permissions', () => {
  const api = (thread: Record<string, unknown> | undefined, defaultMode = 'default') =>
    createClaudeThreadsApiV1({
      getThreads: () => [], getThread: () => thread, isRunning: () => false,
      createThread: () => ({ id: 't' }), sendMessage: async () => {}, openThread: async () => {},
      subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null,
      triggerHostEvent: () => {},
      artifactProviders: new ArtifactProviderRegistry(),
      agentTools: new AgentToolRegistry(),
      getDefaultPermissionMode: () => defaultMode,
    } as never).api;

  it('resolves the per-thread override against the host-private default', async () => {
    expect(await api({ id: 't1', permissionMode: 'plan' }).threads.permissions('t1')).toEqual({
      threadId: 't1', effectivePermissionMode: 'plan', overridden: true,
      planApprovalPending: false, questionPending: false,
    });
    // No override: the caller cannot compute this itself, because the global
    // default is not on any public snapshot.
    expect(await api({ id: 't1' }, 'acceptEdits').threads.permissions('t1')).toMatchObject({
      effectivePermissionMode: 'acceptEdits', overridden: false,
    });
  });

  it('reports pending plan and question state', async () => {
    expect(await api({ id: 't1', pendingPlan: 'do the thing' }).threads.permissions('t1'))
      .toMatchObject({ planApprovalPending: true });
    expect(await api({ id: 't1', pendingQuestions: [{ question: 'q' }] }).threads.permissions('t1'))
      .toMatchObject({ questionPending: true });
    expect(await api({ id: 't1', pendingQuestions: [] }).threads.permissions('t1'))
      .toMatchObject({ questionPending: false });
  });

  it('leaks no callback-bearing internals', async () => {
    const snapshot = await api({
      id: 't1', permissionMode: 'plan', pendingPlan: 'secret plan text',
      messages: [], onApprove: () => {},
    }).threads.permissions('t1');
    expect(Object.keys(snapshot!).sort()).toEqual([
      'effectivePermissionMode', 'overridden', 'planApprovalPending', 'questionPending', 'threadId',
    ]);
    // The plan *text* stays host-side: a peer needs to know approval is
    // pending, not what was proposed.
    expect(JSON.stringify(snapshot)).not.toContain('secret plan text');
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('returns null for an unknown thread', async () => {
    expect(await api(undefined).threads.permissions('missing')).toBeNull();
  });
});

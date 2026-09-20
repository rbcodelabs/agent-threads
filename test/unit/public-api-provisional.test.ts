import { describe, expect, it, vi } from 'vitest';
import { createClaudeThreadsApiV1 } from '../../src/PublicApi';
import { ArtifactProviderRegistry } from '../../src/ArtifactContributions';

function makeHarness(extra: Record<string, unknown> = {}) {
  const threads = new Map<string, any>();
  let nextId = 1;
  const commit = vi.fn(async () => {});
  const rollback = vi.fn(async () => {});
  const sendMessage = vi.fn(async () => {});
  const service = createClaudeThreadsApiV1({
    getThreads: () => [...threads.values()],
    getThread: (id: string) => threads.get(id),
    isRunning: () => false,
    createThread: () => { throw new Error('ordinary create not used'); },
    beginProvisionalThread: async (input) => {
      const thread = {
        id: `provisional-${nextId++}`,
        title: input.title ?? 'New Thread',
        status: 'waiting', reviewed: false, agentHarness: input.agentHarness ?? 'claude',
        messages: [], createdAt: 1, updatedAt: 1, origin: input.origin,
      };
      threads.set(thread.id, thread);
      return {
        thread,
        commit,
        rollback: async () => { threads.delete(thread.id); await rollback(); },
      };
    },
    sendMessage,
    openThread: async () => {},
    subscribe: () => () => {},
    listOrchestrators: () => [],
    resolveOrchestrator: async () => null,
    triggerHostEvent: () => {},
    ...extra,
  });
  return { service, threads, commit, rollback, sendMessage };
}

const owner = Object.freeze({ pluginId: 'threads-design', displayName: 'Design' });

describe('public API provisional threads', () => {
  it('creates an immutable owner-bound handle and commits once', async () => {
    const { service, commit, rollback } = makeHarness();

    const handle = await service.api.threads.beginProvisional(owner, {
      title: 'Design concept', agentHarness: 'codex', ownerPluginId: owner.pluginId,
    });

    expect(Object.isFrozen(handle)).toBe(true);
    expect(handle.threadId).toBe('provisional-1');
    expect(await handle.commit()).toEqual({ status: 'committed', threadId: handle.threadId });
    expect(await handle.commit()).toEqual({ status: 'already-committed', threadId: handle.threadId });
    expect(await handle.rollback()).toEqual({ status: 'committed', threadId: handle.threadId });
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('rolls back once and never commits afterward', async () => {
    const { service, rollback, commit, threads } = makeHarness();
    const handle = await service.api.threads.beginProvisional(owner, { title: 'Rollback' });

    expect(await handle.rollback()).toEqual({ status: 'rolled-back', threadId: handle.threadId });
    expect(await handle.rollback()).toEqual({ status: 'already-rolled-back', threadId: handle.threadId });
    expect(await handle.commit()).toEqual({ status: 'rolled-back', threadId: handle.threadId });
    expect(rollback).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(threads.has(handle.threadId)).toBe(false);
  });

  it('remains rollbackable when host commit persistence fails', async () => {
    const { service, commit, rollback, threads } = makeHarness();
    commit.mockRejectedValueOnce(new Error('disk full'));
    const handle = await service.api.threads.beginProvisional(owner, { title: 'Commit retry' });
    await expect(handle.commit()).rejects.toThrow('disk full');
    await expect(handle.rollback()).resolves.toMatchObject({ status: 'rolled-back' });
    expect(rollback).toHaveBeenCalledOnce();
    expect(threads.has(handle.threadId)).toBe(false);
  });

  it('rejects sends until the provisional thread is committed', async () => {
    const { service, sendMessage } = makeHarness();
    const handle = await service.api.threads.beginProvisional(owner, { title: 'Blocked send' });

    await expect(service.api.threads.send(handle.threadId, { prompt: 'Too early' }))
      .rejects.toMatchObject({ code: 'THREAD_BUSY' });
    expect(sendMessage).not.toHaveBeenCalled();

    await handle.commit();
    await service.api.threads.send(handle.threadId, { prompt: 'Start now' });
    expect(sendMessage).toHaveBeenCalledWith(handle.threadId, 'Start now');
  });

  it('rolls back pending handles when the API generation stops', async () => {
    const { service, rollback, threads } = makeHarness();
    const pending = await service.api.threads.beginProvisional(owner, { title: 'Pending' });
    const committed = await service.api.threads.beginProvisional(owner, { title: 'Kept' });
    await committed.commit();

    service.stop();

    await vi.waitFor(() => expect(rollback).toHaveBeenCalledOnce());
    expect(threads.has(pending.threadId)).toBe(false);
    expect(threads.has(committed.threadId)).toBe(true);
  });

  it('releases storage allocated during the provisional transaction', async () => {
    const releaseStorageRoot = vi.fn(async () => true);
    const artifactStore = {
      list: () => [],
      allocateStorageRoot: vi.fn(async () => ({ status: 'ok', path: '/vault/.geode/artifacts/design-provisional-1' })),
      releaseStorageRoot,
    };
    const { service } = makeHarness({ artifactStore, artifactProviders: new ArtifactProviderRegistry() });
    const handle = await service.api.threads.beginProvisional(owner, { title: 'Storage rollback' });
    await expect(service.api.artifacts.allocateStorage(handle.threadId, 'design-provisional-1'))
      .resolves.toMatchObject({ success: true, status: 'allocated' });
    await handle.rollback();
    expect(releaseStorageRoot).toHaveBeenCalledWith('/vault/.geode/artifacts/design-provisional-1');
  });

  it('still rolls back the thread when allocated storage cleanup fails', async () => {
    const artifactStore = {
      list: () => [],
      allocateStorageRoot: vi.fn(async () => ({ status: 'ok', path: '/vault/.geode/artifacts/design-provisional-1' })),
      releaseStorageRoot: vi.fn(async () => { throw new Error('cleanup failed'); }),
    };
    const { service, rollback } = makeHarness({ artifactStore, artifactProviders: new ArtifactProviderRegistry() });
    const handle = await service.api.threads.beginProvisional(owner, { title: 'Cleanup failure' });
    await service.api.artifacts.allocateStorage(handle.threadId, 'design-provisional-1');
    await expect(handle.rollback()).resolves.toMatchObject({ status: 'rolled-back' });
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('refuses unavailable hosts and mismatched owner metadata', async () => {
    const { service } = makeHarness();
    await expect(service.api.threads.beginProvisional(owner, {
      title: 'Wrong owner', ownerPluginId: 'someone-else',
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const unavailable = createClaudeThreadsApiV1({
      getThreads: () => [], getThread: () => undefined, isRunning: () => false,
      createThread: () => ({ id: 't' }) as never, sendMessage: async () => {}, openThread: async () => {},
      subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null,
      triggerHostEvent: () => {},
    });
    await expect(unavailable.api.threads.beginProvisional(owner, { title: 'Unavailable' }))
      .rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' });
  });
});

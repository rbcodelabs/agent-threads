import { describe, expect, it, vi } from 'vitest';
import { ArtifactProviderRegistry, type ArtifactActionResult, type ThreadArtifactRef } from '../../src/ArtifactContributions';
import { createArtifactStore } from '../../src/artifactStore';
import { createClaudeThreadsApiV1 } from '../../src/PublicApi';
import type { Thread, ThreadArtifactRecord } from '../../src/types';

const VAULT = '/vault';
const ARTIFACTS = '/vault/.geode/artifacts';
const OWNER = Object.freeze({ pluginId: 'acme-plugin', displayName: 'Acme' });
const OTHER = Object.freeze({ pluginId: 'rival-plugin' });

/** Accepts anything under the artifact root, so the API's own rules are what fails. */
const permissiveFs = { realpathSync: (target: string) => target, rm: async () => {} };

function ref(overrides: Partial<ThreadArtifactRef> = {}): ThreadArtifactRef {
  return {
    providerId: 'acme.boards', kind: 'board', schemaVersion: 1,
    id: 'board-1', title: 'Quarterly board', data: { cells: 4 },
    ...overrides,
  };
}

function setup(options: { invoke?: (actionId: string) => Promise<ArtifactActionResult>; noView?: boolean } = {}) {
  const thread = { id: 'thread-1' } as Thread;
  const invoked: string[] = [];
  const artifactProviders = new ArtifactProviderRegistry({ invokeTimeoutMs: 50 });
  const changed: string[] = [];
  const saveSettings = vi.fn(async () => {});

  const service = createClaudeThreadsApiV1({
    getThreads: () => [], getThread: (id: string) => (id === thread.id ? thread : undefined), isRunning: () => false,
    createThread: () => thread, sendMessage: async () => {}, openThread: async () => {},
    subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null,
    triggerHostEvent: () => {},
    artifactProviders,
    artifactStore: createArtifactStore({
      vaultRoot: () => VAULT,
      getThread: (id: string) => (id === thread.id ? thread : undefined),
      saveSettings,
      storageFs: permissiveFs,
      onChanged: (id: string) => changed.push(id),
      // Stands in for the view's shared action path. `noView` models no view
      // being mounted, which the store must surface rather than throw on.
      invokeAction: options.noView ? () => undefined : (_threadId, artifactId, actionId) => {
        const record = thread.artifacts?.find(candidate => candidate.id === artifactId);
        if (!record) return Promise.resolve({ status: 'error' as const, message: `Artifact not found: ${artifactId}` });
        invoked.push(actionId);
        return artifactProviders.invoke(actionId, { ...ref(), ...record, data: record } as ThreadArtifactRef, {
          openView: async () => 'tab' as const, revealInFolder: async () => true, updateArtifact: async () => {},
        });
      },
    }),
  } as never);

  const api = service.api;
  const registration = api.extensions.registerArtifactProvider(OWNER, {
    providerId: 'acme.boards', kinds: ['board'],
    present: candidate => ({ title: candidate.title, actions: [{ id: 'open', label: 'Open' }] }),
    invoke: options.invoke
      ? async actionId => options.invoke!(actionId)
      : async actionId => (actionId === 'open' ? { status: 'ok' } : { status: 'error', message: `Unknown action: ${actionId}` }),
  });
  expect(registration.success).toBe(true);
  return { api, thread, invoked, changed, saveSettings, service, artifactProviders };
}

describe('artifacts.attach', () => {
  it('attaches, persists and reports host-owned identity', async () => {
    const { api, thread, saveSettings, changed } = setup();
    const result = await api.artifacts.attach(OWNER, 'thread-1', ref({ storageRoot: `${ARTIFACTS}/board-1` }));

    expect(result).toMatchObject({ success: true, status: 'attached', artifactId: 'board-1' });
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(changed).toEqual(['thread-1']);
    expect(thread.artifacts).toHaveLength(1);
    expect(thread.artifacts![0]).toMatchObject({
      id: 'board-1', kind: 'board', providerId: 'acme.boards', schemaVersion: 1,
      storageRoot: `${ARTIFACTS}/board-1`, cells: 4,
    });
  });

  it('is idempotent on artifact id — a repeat updates in place', async () => {
    const { api, thread } = setup();
    await api.artifacts.attach(OWNER, 'thread-1', ref());
    const createdAt = thread.artifacts![0].createdAt;
    const again = await api.artifacts.attach(OWNER, 'thread-1', ref({ title: 'Revised board', data: { cells: 9 } }));

    expect(again).toMatchObject({ success: true, status: 'updated' });
    expect(thread.artifacts).toHaveLength(1);
    expect(thread.artifacts![0]).toMatchObject({ title: 'Revised board', cells: 9, createdAt });
  });

  it('refuses a provider id the caller does not own', async () => {
    const { api, thread } = setup();
    const result = await api.artifacts.attach(OTHER, 'thread-1', ref());
    expect(result).toMatchObject({ success: false, status: 'conflict' });
    expect(result.success === false && result.message).toContain('acme-plugin');
    expect(thread.artifacts ?? []).toHaveLength(0);
  });

  it('refuses a provider nobody registered', async () => {
    const { api } = setup();
    expect(await api.artifacts.attach(OWNER, 'thread-1', ref({ providerId: 'ghost.provider' })))
      .toMatchObject({ success: false, status: 'unknown-provider' });
  });

  it('refuses a kind the provider never declared', async () => {
    const { api } = setup();
    const result = await api.artifacts.attach(OWNER, 'thread-1', ref({ kind: 'smuggled' }));
    expect(result).toMatchObject({ success: false, status: 'invalid' });
    expect(result.success === false && result.message).toContain('smuggled');
  });

  it('refuses an unknown thread', async () => {
    const { api } = setup();
    expect(await api.artifacts.attach(OWNER, 'nope', ref())).toMatchObject({ success: false, status: 'thread-not-found' });
  });

  it('refuses malformed identity and oversized data', async () => {
    const { api } = setup();
    const cases: Array<Partial<ThreadArtifactRef>> = [
      { id: '' }, { id: 'x'.repeat(200) }, { title: '' }, { kind: '' },
      { providerId: 'not-namespaced' }, { schemaVersion: 0 }, { schemaVersion: 1.5 },
      { data: 'a string' }, { data: [1, 2, 3] }, { data: { blob: 'x'.repeat(300_000) } },
    ];
    for (const patch of cases) {
      expect(await api.artifacts.attach(OWNER, 'thread-1', ref(patch))).toMatchObject({ success: false, status: 'invalid' });
    }
    expect(await api.artifacts.attach({ pluginId: '' }, 'thread-1', ref())).toMatchObject({ success: false, status: 'invalid' });
  });

  it('fails the attach outright on a rejected storage root rather than dropping the field', async () => {
    const { api, thread } = setup();
    for (const storageRoot of ['../../..', '/etc', ARTIFACTS, VAULT, `${ARTIFACTS}/../../secrets`]) {
      const result = await api.artifacts.attach(OWNER, 'thread-1', ref({ storageRoot }));
      expect(result).toMatchObject({ success: false, status: 'invalid' });
    }
    expect(thread.artifacts ?? []).toHaveLength(0);
  });

  it('never lets provider data overwrite host-owned identity', async () => {
    const { api, thread } = setup();
    await api.artifacts.attach(OWNER, 'thread-1', ref({
      data: { id: 'hijacked', kind: 'evil', providerId: 'rival.boards', schemaVersion: 99, storageRoot: '/etc', cells: 2 },
    }));
    expect(thread.artifacts![0]).toMatchObject({ id: 'board-1', kind: 'board', providerId: 'acme.boards', schemaVersion: 1, cells: 2 });
    expect(thread.artifacts![0].storageRoot).toBeUndefined();
  });
});

describe('artifacts.update and detach', () => {
  it('updates the owning peer artifact and rejects another peer', async () => {
    const { api, thread } = setup();
    await api.artifacts.attach(OWNER, 'thread-1', ref());

    expect(await api.artifacts.update(OWNER, 'thread-1', 'board-1', { title: 'Renamed', data: { cells: 7 } }))
      .toMatchObject({ success: true, status: 'updated' });
    expect(thread.artifacts![0]).toMatchObject({ title: 'Renamed', cells: 7 });

    expect(await api.artifacts.update(OTHER, 'thread-1', 'board-1', { title: 'Stolen' }))
      .toMatchObject({ success: false, status: 'conflict' });
    expect(thread.artifacts![0].title).toBe('Renamed');
  });

  it('validates a storage root on update too', async () => {
    const { api, thread } = setup();
    await api.artifacts.attach(OWNER, 'thread-1', ref());
    expect(await api.artifacts.update(OWNER, 'thread-1', 'board-1', { storageRoot: '/etc' }))
      .toMatchObject({ success: false, status: 'invalid' });
    expect(thread.artifacts![0].storageRoot).toBeUndefined();
    expect(await api.artifacts.update(OWNER, 'thread-1', 'board-1', { storageRoot: `${ARTIFACTS}/board-1` }))
      .toMatchObject({ success: true });
    expect(thread.artifacts![0].storageRoot).toBe(`${ARTIFACTS}/board-1`);
  });

  it('distinguishes unknown thread from unknown artifact', async () => {
    const { api } = setup();
    expect(await api.artifacts.update(OWNER, 'nope', 'board-1', { title: 'x' })).toMatchObject({ success: false, status: 'thread-not-found' });
    expect(await api.artifacts.update(OWNER, 'thread-1', 'ghost', { title: 'x' })).toMatchObject({ success: false, status: 'artifact-not-found' });
    expect(await api.artifacts.detach(OWNER, 'nope', 'board-1')).toMatchObject({ success: false, status: 'thread-not-found' });
    expect(await api.artifacts.detach(OWNER, 'thread-1', 'ghost')).toMatchObject({ success: false, status: 'artifact-not-found' });
  });

  it('detaches only for the owning peer', async () => {
    const { api, thread } = setup();
    await api.artifacts.attach(OWNER, 'thread-1', ref());
    expect(await api.artifacts.detach(OTHER, 'thread-1', 'board-1')).toMatchObject({ success: false, status: 'conflict' });
    expect(thread.artifacts).toHaveLength(1);
    expect(await api.artifacts.detach(OWNER, 'thread-1', 'board-1')).toMatchObject({ success: true, status: 'detached' });
    expect(thread.artifacts).toHaveLength(0);
  });
});

describe('artifacts.list', () => {
  it('returns frozen refs and an empty list for an unknown thread', async () => {
    const { api } = setup();
    await api.artifacts.attach(OWNER, 'thread-1', ref());
    const listed = await api.artifacts.list('thread-1');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ providerId: 'acme.boards', kind: 'board', id: 'board-1' });
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed[0])).toBe(true);
    expect(await api.artifacts.list('nope')).toEqual([]);
  });
});

describe('artifacts.invokeAction', () => {
  it('runs the provider action and returns the card-click result shape', async () => {
    const { api, invoked } = setup();
    await api.artifacts.attach(OWNER, 'thread-1', ref());
    expect(await api.artifacts.invokeAction('thread-1', 'board-1', 'open')).toEqual({ status: 'ok' });
    expect(invoked).toEqual(['open']);
  });

  it('reports unknown thread, artifact, action and blank action distinctly', async () => {
    const { api } = setup();
    await api.artifacts.attach(OWNER, 'thread-1', ref());
    expect(await api.artifacts.invokeAction('nope', 'board-1', 'open')).toEqual({ status: 'error', message: 'Thread not found: nope' });
    expect(await api.artifacts.invokeAction('thread-1', 'ghost', 'open')).toEqual({ status: 'error', message: 'Artifact not found: ghost' });
    expect(await api.artifacts.invokeAction('thread-1', 'board-1', 'nonsense')).toEqual({ status: 'error', message: 'Unknown action: nonsense' });
    expect(await api.artifacts.invokeAction('thread-1', 'board-1', '  ')).toEqual({ status: 'error', message: 'actionId must be a non-empty string.' });
  });

  it('keeps the provider isolation and timeout of the card-click path', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exploding = setup({ invoke: async () => { throw new Error('action exploded'); } });
    await exploding.api.artifacts.attach(OWNER, 'thread-1', ref());
    expect(await exploding.api.artifacts.invokeAction('thread-1', 'board-1', 'open'))
      .toEqual({ status: 'error', message: 'action exploded' });

    const hanging = setup({ invoke: () => new Promise<ArtifactActionResult>(() => {}) });
    await hanging.api.artifacts.attach(OWNER, 'thread-1', ref());
    const timedOut = await hanging.api.artifacts.invokeAction('thread-1', 'board-1', 'open');
    expect(timedOut.status).toBe('error');
    expect(timedOut.message).toContain('timed out');
    spy.mockRestore();
  });

  it('reports an error rather than throwing when no view is mounted', async () => {
    const { api } = setup({ noView: true });
    await api.artifacts.attach(OWNER, 'thread-1', ref());
    const result = await api.artifacts.invokeAction('thread-1', 'board-1', 'open');
    expect(result.status).toBe('error');
    expect(result.message).toContain('view is not open');
  });
});

describe('artifacts lifecycle', () => {
  it('advertises one capability per operation and refuses everything after stop()', async () => {
    const { api, service } = setup();
    expect([...api.capabilities]).toEqual(expect.arrayContaining([
      'artifacts.list', 'artifacts.attach', 'artifacts.update', 'artifacts.detach', 'artifacts.invokeAction',
    ]));
    service.stop();
    await expect(api.artifacts.attach(OWNER, 'thread-1', ref())).rejects.toThrow('not available');
    await expect(api.artifacts.list('thread-1')).rejects.toThrow('not available');
    await expect(api.artifacts.invokeAction('thread-1', 'board-1', 'open')).rejects.toThrow('not available');
  });

  it('drops the namespace capabilities when the host cannot store artifacts', () => {
    const api = createClaudeThreadsApiV1({
      getThreads: () => [], getThread: () => undefined, isRunning: () => false,
      createThread: () => ({ id: 't' }), sendMessage: async () => {}, openThread: async () => {},
      subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null,
      triggerHostEvent: () => {},
    } as never).api;
    expect(api.capabilities.some(capability => capability.startsWith('artifacts.'))).toBe(false);
  });

  it('reports unavailable rather than throwing when there is no store', async () => {
    const api = createClaudeThreadsApiV1({
      getThreads: () => [], getThread: () => undefined, isRunning: () => false,
      createThread: () => ({ id: 't' }), sendMessage: async () => {}, openThread: async () => {},
      subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null,
      triggerHostEvent: () => {},
    } as never).api;
    expect(await api.artifacts.attach(OWNER, 'thread-1', ref())).toMatchObject({ success: false, status: 'unavailable' });
    expect(await api.artifacts.update(OWNER, 'thread-1', 'board-1', {})).toMatchObject({ success: false, status: 'unavailable' });
    expect(await api.artifacts.detach(OWNER, 'thread-1', 'board-1')).toMatchObject({ success: false, status: 'unavailable' });
    expect((await api.artifacts.invokeAction('thread-1', 'board-1', 'open')).status).toBe('error');
    expect(await api.artifacts.list('thread-1')).toEqual([]);
  });
});

describe('artifact records', () => {
  it('keeps a legacy record without a provider id readable', async () => {
    const { api, thread } = setup();
    const legacy: ThreadArtifactRecord = { id: 'design-1', kind: 'design-static', title: 'Old design', createdAt: 1, updatedAt: 1 };
    thread.artifacts = [legacy];
    const [listed] = await api.artifacts.list('thread-1');
    expect(listed).toMatchObject({ providerId: 'agent-threads.design', schemaVersion: 1, id: 'design-1' });
    expect(listed.storageRoot).toBeUndefined();
  });
});

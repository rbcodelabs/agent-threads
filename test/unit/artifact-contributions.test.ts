import { describe, expect, it, vi } from 'vitest';
import { createClaudeThreadsApiV1 } from '../../src/PublicApi';
import {
  ArtifactProviderRegistry,
  toArtifactRef,
  UNKNOWN_PROVIDER_ID,
  type ArtifactActionHost,
  type ArtifactContribution,
  type ThreadArtifactRef,
} from '../../src/ArtifactContributions';
import type { ThreadArtifactRecord } from '../../src/types';

function contribution(overrides: Partial<ArtifactContribution> = {}): ArtifactContribution {
  return {
    providerId: 'acme.artifacts',
    kinds: ['acme-doc'],
    present: (ref) => ({ title: ref.title, actions: [] }),
    invoke: async () => ({ status: 'ok' }),
    ...overrides,
  } as ArtifactContribution;
}

function record(overrides: Partial<ThreadArtifactRecord> = {}): ThreadArtifactRecord {
  return { id: 'a1', kind: 'acme-doc', title: 'Stored title', createdAt: 1, updatedAt: 2, ...overrides };
}

const noopHost: ArtifactActionHost = {
  openView: async () => 'tab',
  revealInFolder: async () => true,
  updateArtifact: async () => {},
};

describe('artifact provider registry', () => {
  it('rejects a duplicate provider id loudly and keeps the first registration', () => {
    const registry = new ArtifactProviderRegistry();
    const first = registry.register({ pluginId: 'acme' }, contribution({ present: () => ({ title: 'first', actions: [] }) }));
    const second = registry.register({ pluginId: 'other' }, contribution({ present: () => ({ title: 'second', actions: [] }) }));
    expect(first.success).toBe(true);
    expect(second).toMatchObject({ success: false, status: 'conflict', providerId: 'acme.artifacts' });
    const presented = registry.present(toArtifactRef(record({ providerId: 'acme.artifacts' })));
    expect(presented).toMatchObject({ status: 'ok', presentation: { title: 'first' } });
  });

  it('rejects ids that are not namespaced, as a structured result rather than a throw', () => {
    const registry = new ArtifactProviderRegistry();
    for (const providerId of ['artifacts', 'Acme.Artifacts', '.artifacts', 'acme.', 'acme..artifacts', '']) {
      const result = registry.register({ pluginId: 'acme' }, contribution({ providerId }));
      expect(result).toMatchObject({ success: false, status: 'invalid' });
    }
    expect(registry.register({ pluginId: '' }, contribution())).toMatchObject({ success: false, status: 'invalid' });
    expect(registry.register({ pluginId: 'acme' }, contribution({ kinds: [] }))).toMatchObject({ success: false, status: 'invalid' });
    expect(registry.providerIds()).toEqual([]);
  });

  it('disposes idempotently and never retracts a later registration', () => {
    const registry = new ArtifactProviderRegistry();
    const first = registry.register({ pluginId: 'acme' }, contribution());
    expect(first.success).toBe(true);
    first.dispose();
    expect(registry.has('acme.artifacts')).toBe(false);

    const second = registry.register({ pluginId: 'acme' }, contribution());
    expect(second.success).toBe(true);
    first.dispose();
    first.dispose();
    expect(registry.has('acme.artifacts')).toBe(true);
  });

  it('isolates a provider whose present() throws', () => {
    const registry = new ArtifactProviderRegistry();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    registry.register({ pluginId: 'acme' }, contribution({ present: () => { throw new Error('boom'); } }));
    expect(registry.present(toArtifactRef(record({ providerId: 'acme.artifacts' }))))
      .toMatchObject({ status: 'failed', providerId: 'acme.artifacts', message: 'boom' });
    registry.register({ pluginId: 'acme' }, contribution({ providerId: 'acme.bad', present: () => null as never }));
    expect(registry.present(toArtifactRef(record({ providerId: 'acme.bad' })))).toMatchObject({ status: 'failed' });
    spy.mockRestore();
  });

  it('reports a missing provider rather than throwing', () => {
    const registry = new ArtifactProviderRegistry();
    expect(registry.present(toArtifactRef(record({ providerId: 'gone.plugin' }))))
      .toEqual({ status: 'missing-provider', providerId: 'gone.plugin' });
  });

  it('turns a throwing or hanging invoke() into an error result', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const registry = new ArtifactProviderRegistry({ invokeTimeoutMs: 10 });
    registry.register({ pluginId: 'acme' }, contribution({ invoke: async () => { throw new Error('exploded'); } }));
    registry.register({ pluginId: 'acme' }, contribution({ providerId: 'acme.slow', invoke: () => new Promise(() => {}) }));
    registry.register({ pluginId: 'acme' }, contribution({ providerId: 'acme.junk', invoke: async () => undefined as never }));

    const ref = (providerId: string) => toArtifactRef(record({ providerId }));
    expect(await registry.invoke('go', ref('acme.artifacts'), noopHost)).toEqual({ status: 'error', message: 'exploded' });
    expect(await registry.invoke('go', ref('acme.slow'), noopHost)).toMatchObject({ status: 'error', message: /timed out/ as never });
    expect(await registry.invoke('go', ref('acme.junk'), noopHost)).toMatchObject({ status: 'error' });
    expect(await registry.invoke('go', ref('gone.plugin'), noopHost)).toMatchObject({ status: 'error' });
    spy.mockRestore();
  });

  it('adapts legacy records at read time without rewriting them', () => {
    // Exactly the shape persisted before providers existed: no providerId,
    // no schemaVersion.
    const legacy: ThreadArtifactRecord = { id: 'a1', kind: 'design-static', title: 'Stored title', createdAt: 1, updatedAt: 2 };
    const ref = toArtifactRef(legacy);
    expect(ref.providerId).toBe('agent-threads.design');
    expect(ref.schemaVersion).toBe(1);
    expect(ref.title).toBe('Stored title');
    expect(legacy).not.toHaveProperty('providerId');
    expect(toArtifactRef(record({ kind: 'mystery' })).providerId).toBe(UNKNOWN_PROVIDER_ID);
  });

  it('hands the provider a frozen copy so it cannot mutate persisted state directly', () => {
    const stored = record();
    const ref: ThreadArtifactRef = toArtifactRef(stored);
    expect(ref.data).not.toBe(stored);
    expect(Object.isFrozen(ref.data)).toBe(true);
  });
});

function apiHarness() {
  const artifactProviders = new ArtifactProviderRegistry();
  const service = createClaudeThreadsApiV1({
    getThreads: () => [],
    getThread: () => undefined,
    isRunning: () => false,
    createThread: () => ({ id: 't' }) as never,
    sendMessage: async () => {},
    openThread: async () => {},
    subscribe: () => () => {},
    listOrchestrators: () => [],
    resolveOrchestrator: async () => null,
    triggerHostEvent: () => {},
    artifactProviders,
  } as never);
  return { service, artifactProviders };
}

describe('extensions.registerArtifactProvider', () => {
  it('registers through the public surface and advertises the capability', () => {
    const { service, artifactProviders } = apiHarness();
    expect(service.api.capabilities).toContain('extensions.registerArtifactProvider');
    const result = service.api.extensions.registerArtifactProvider({ pluginId: 'acme', displayName: 'Acme' }, contribution());
    expect(result).toMatchObject({ success: true, status: 'registered', providerId: 'acme.artifacts' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(artifactProviders.has('acme.artifacts')).toBe(true);
  });

  it('drops every registration on stop(), like event listeners', () => {
    const { service, artifactProviders } = apiHarness();
    service.api.extensions.registerArtifactProvider({ pluginId: 'acme' }, contribution());
    service.api.extensions.registerArtifactProvider({ pluginId: 'acme' }, contribution({ providerId: 'acme.other' }));
    expect(artifactProviders.providerIds()).toEqual(['acme.artifacts', 'acme.other']);
    service.stop();
    expect(artifactProviders.providerIds()).toEqual([]);
    expect(() => service.api.extensions.registerArtifactProvider({ pluginId: 'acme' }, contribution()))
      .toThrow(/not available/);
  });

  it('omits capabilities whose dependencies are absent', () => {
    const service = createClaudeThreadsApiV1({
      getThreads: () => [], getThread: () => undefined, isRunning: () => false,
      createThread: () => ({ id: 't' }) as never, sendMessage: async () => {}, openThread: async () => {},
      subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null,
      triggerHostEvent: () => {},
    } as never);
    expect(service.api.capabilities).not.toContain('extensions.registerArtifactProvider');
    expect(service.api.capabilities).not.toContain('constrainedRuns.create');
    expect(service.api.capabilities).not.toContain('mcp.register');
    expect(service.api.capabilities).not.toContain('traces.readChunk');
    expect(service.api.capabilities).toContain('threads.wait');
    expect(service.api.extensions.registerArtifactProvider({ pluginId: 'acme' }, contribution()))
      .toMatchObject({ success: false, status: 'invalid' });
  });
});

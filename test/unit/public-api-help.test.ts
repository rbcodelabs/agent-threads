import { describe, expect, it } from 'vitest';
import { createClaudeThreadsApiV1 } from '../../src/PublicApi';
import { HelpProviderRegistry } from '../../src/help/HelpRegistry';

function setup(helpProviders?: HelpProviderRegistry) {
  return createClaudeThreadsApiV1({
    getThreads: () => [], getThread: () => undefined, isRunning: () => false,
    createThread: () => ({ id: 't' }), sendMessage: async () => {}, openThread: async () => {},
    subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null,
    triggerHostEvent: () => {}, helpProviders,
  } as never);
}
const contribution = { providerId: 'acme.docs', title: 'Acme', search: async () => [], get: async () => null };
const owner = { pluginId: 'acme' };

describe('public help-provider registration', () => {
  it('advertises the capability and registers through the host registry', () => {
    const registry = new HelpProviderRegistry();
    const { api } = setup(registry);
    expect(api.capabilities).toContain('extensions.registerHelpProvider');
    expect(api.extensions.registerHelpProvider(owner, contribution)).toMatchObject({ success: true });
    expect(registry.has('acme.docs')).toBe(true);
  });

  it('refuses a duplicate providerId through the public surface', () => {
    const { api } = setup(new HelpProviderRegistry());
    api.extensions.registerHelpProvider(owner, contribution);
    expect(api.extensions.registerHelpProvider({ pluginId: 'other' }, contribution)).toMatchObject({ success: false, status: 'conflict' });
  });

  it('dispose retracts the provider; stop() drops every remaining one and then refuses calls', () => {
    const registry = new HelpProviderRegistry();
    const service = setup(registry);
    const a = service.api.extensions.registerHelpProvider(owner, contribution);
    service.api.extensions.registerHelpProvider(owner, { ...contribution, providerId: 'acme.two' });
    a.dispose();
    expect(registry.has('acme.docs')).toBe(false);
    expect(registry.has('acme.two')).toBe(true);
    service.stop();
    expect(registry.has('acme.two')).toBe(false);
    expect(() => service.api.extensions.registerHelpProvider(owner, contribution)).toThrow();
  });

  it('is unavailable, and not advertised, when the host has no registry', () => {
    const { api } = setup();
    expect(api.capabilities).not.toContain('extensions.registerHelpProvider');
    expect(api.extensions.registerHelpProvider(owner, contribution)).toMatchObject({ success: false, status: 'unavailable' });
  });
});

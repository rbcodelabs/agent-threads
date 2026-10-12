import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthMcpState, StoredOAuthMcpServer } from '../../src/types';

const proxyStartMock = vi.fn();

vi.mock('../../src/OAuthMcpFlow', () => ({
  OAuthMcpFlow: vi.fn().mockImplementation(function OAuthMcpFlow() {
    return {
      discoverAS: async () => ({
        authorizationServerUrl: 'https://as.example.com',
        authorizationServerMetadata: {
          issuer: 'https://as.example.com', authorization_endpoint: 'https://as.example.com/authorize',
          token_endpoint: 'https://as.example.com/token', response_types_supported: ['code'], scopes_supported: null,
          registration_endpoint: 'https://as.example.com/register',
        },
      }),
      registerClient: async () => ({ clientId: 'cid' }),
      authorize: async () => ({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 }),
      refresh: async () => ({ accessToken: 'at2', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 }),
      clientCredentials: async () => ({ accessToken: 'm', expiresAt: Date.now() + 1000 }),
      revoke: async () => undefined,
    };
  }),
}));
vi.mock('../../src/OAuthMcpProxy', () => ({
  OAuthMcpProxy: vi.fn().mockImplementation(function OAuthMcpProxy() {
    return { start: proxyStartMock, stop: async () => {}, capabilityTokenFor: (t: string) => `cap-${t}`, retainThreads: () => {}, url: 'http://127.0.0.1:5555/' };
  }),
}));

import { OAuthMcpRegistry } from '../../src/OAuthMcpRegistry';
import { OAuthTokenStore } from '../../src/OAuthTokenStore';

function makeHost() {
  const settings: { oauthMcpServers: Record<string, StoredOAuthMcpServer>; oauthMcpState: Record<string, OAuthMcpState> } = { oauthMcpServers: {}, oauthMcpState: {} };
  const store = new Map<string, string>();
  return {
    settings,
    host: {
      getSettings: () => settings, save: async () => {},
      secretStorage: { setSecret: (id: string, s: string) => { store.set(id, s); }, getSecret: (id: string) => store.get(id) ?? null },
      openUrl: async () => undefined,
    },
  };
}

beforeEach(() => { proxyStartMock.mockReset(); proxyStartMock.mockResolvedValue(undefined); });

describe('OAuthMcpRegistry — capability layer recreation notifies sessions', () => {
  it('fires onCapabilityLayerChanged after registerServer creates a new proxy', async () => {
    const { host } = makeHost();
    const onCapabilityLayerChanged = vi.fn();
    const registry = new OAuthMcpRegistry({ ...host, onCapabilityLayerChanged });
    await registry.registerServer({ name: 'vercel', url: 'https://mcp.vercel.com/' });
    expect(onCapabilityLayerChanged).toHaveBeenCalledTimes(1);
  });

  it('does not fire when registration fails', async () => {
    proxyStartMock.mockRejectedValue(new Error('EADDRINUSE'));
    const { host } = makeHost();
    const onCapabilityLayerChanged = vi.fn();
    const registry = new OAuthMcpRegistry({ ...host, onCapabilityLayerChanged });
    await registry.registerServer({ name: 'vercel', url: 'https://mcp.vercel.com/' });
    expect(onCapabilityLayerChanged).not.toHaveBeenCalled();
  });

  it('fires once after configure() rebuilds persisted proxies', async () => {
    const { host, settings } = makeHost();
    settings.oauthMcpServers.vercel = { url: 'https://mcp.vercel.com/' };
    const tokenStore = new OAuthTokenStore(host.secretStorage, async () => ({ accessToken: 'x' }));
    tokenStore.storeClientId('vercel', 'client-abc');
    tokenStore.store('vercel', { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3600_000 });
    const onCapabilityLayerChanged = vi.fn();
    await new OAuthMcpRegistry({ ...host, onCapabilityLayerChanged }).configure();
    expect(onCapabilityLayerChanged).toHaveBeenCalledTimes(1);
  });
});

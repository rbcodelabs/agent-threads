import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthMcpState, StoredOAuthMcpServer } from '../../src/types';

const discoverASMock = vi.fn();
const registerClientMock = vi.fn();
const authorizeMock = vi.fn();
const flowRefreshMock = vi.fn();
const revokeMock = vi.fn();

vi.mock('../../src/OAuthMcpFlow', () => ({
  // A plain `function`, not an arrow function: `new OAuthMcpFlow(...)` requires
  // the mock to be constructible, and arrow functions can never be `new`-ed.
  OAuthMcpFlow: vi.fn().mockImplementation(function OAuthMcpFlow() {
    return {
      discoverAS: discoverASMock,
      registerClient: registerClientMock,
      authorize: authorizeMock,
      refresh: flowRefreshMock,
      revoke: revokeMock,
    };
  }),
}));

const proxyStartMock = vi.fn();
const proxyStopMock = vi.fn();
const mintCapabilityTokenMock = vi.fn();
const proxyRetainThreadsMock = vi.fn();
let proxyUrl = 'http://127.0.0.1:5555/';

vi.mock('../../src/OAuthMcpProxy', () => ({
  OAuthMcpProxy: vi.fn().mockImplementation(function OAuthMcpProxy() {
    return {
      start: proxyStartMock,
      stop: proxyStopMock,
      mintCapabilityToken: mintCapabilityTokenMock,
      retainThreads: proxyRetainThreadsMock,
      get url() { return proxyUrl; },
    };
  }),
}));

// vi.mock calls above are hoisted above these imports by Vitest, so
// OAuthMcpRegistry picks up the mocked OAuthMcpFlow/OAuthMcpProxy modules.
import { OAuthMcpRegistry } from '../../src/OAuthMcpRegistry';
import { OAuthTokenStore } from '../../src/OAuthTokenStore';

function fakeSecretStorage() {
  const store = new Map<string, string>();
  return {
    setSecret: (id: string, secret: string) => { store.set(id, secret); },
    getSecret: (id: string) => store.get(id) ?? null,
  };
}

function fakeAsMetadata(opts: { withoutRegistrationEndpoint?: boolean } = {}) {
  const authorizationServerMetadata: Record<string, unknown> = {
    issuer: 'https://as.example.com',
    authorization_endpoint: 'https://as.example.com/authorize',
    token_endpoint: 'https://as.example.com/token',
    response_types_supported: ['code'],
    revocation_endpoint: 'https://as.example.com/revoke',
  };
  if (!opts.withoutRegistrationEndpoint) authorizationServerMetadata.registration_endpoint = 'https://as.example.com/register';
  return { authorizationServerUrl: 'https://as.example.com', authorizationServerMetadata };
}

function makeHost() {
  const settings: { oauthMcpServers: Record<string, StoredOAuthMcpServer>; oauthMcpState: Record<string, OAuthMcpState> } = {
    oauthMcpServers: {},
    oauthMcpState: {},
  };
  const save = vi.fn(async () => {});
  return {
    host: {
      getSettings: () => settings,
      save,
      secretStorage: fakeSecretStorage(),
      openUrl: vi.fn(async () => undefined),
    },
    settings,
    save,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  proxyUrl = 'http://127.0.0.1:5555/';
  discoverASMock.mockResolvedValue(fakeAsMetadata());
  registerClientMock.mockResolvedValue('dcr-client-id');
  authorizeMock.mockResolvedValue({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3600_000 });
  flowRefreshMock.mockResolvedValue({ accessToken: 'at-2', refreshToken: 'rt-1', expiresAt: Date.now() + 3600_000 });
  revokeMock.mockResolvedValue(undefined);
  proxyStartMock.mockResolvedValue(undefined);
  proxyStopMock.mockResolvedValue(undefined);
  mintCapabilityTokenMock.mockImplementation((threadId: string) => `cap-${threadId}`);
});

describe('OAuthMcpRegistry.registerServer', () => {
  it('happy path: discovers, registers a DCR client, authorizes, persists, and starts the proxy', async () => {
    const { host, settings, save } = makeHost();
    const registry = new OAuthMcpRegistry(host);

    const result = await registry.registerServer({ name: 'vercel', url: 'https://mcp.vercel.com/' });

    expect(result).toMatchObject({ success: true, status: 'registered' });
    expect(discoverASMock).toHaveBeenCalledWith('https://mcp.vercel.com/');
    expect(registerClientMock).toHaveBeenCalledTimes(1);
    expect(authorizeMock).toHaveBeenCalledWith(expect.objectContaining({ serverName: 'vercel', clientId: 'dcr-client-id' }));
    expect(proxyStartMock).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalled();

    expect(settings.oauthMcpServers.vercel).toMatchObject({ url: 'https://mcp.vercel.com/', clientId: 'dcr-client-id' });
    expect(settings.oauthMcpState.vercel).toMatchObject({ serverName: 'vercel', status: 'connected', hasRefreshToken: true });
  });

  it('skips Dynamic Client Registration when a clientId is supplied', async () => {
    const { host } = makeHost();
    const registry = new OAuthMcpRegistry(host);

    const result = await registry.registerServer({ name: 'vercel', url: 'https://mcp.vercel.com/', clientId: 'known-public-client' });

    expect(result.success).toBe(true);
    expect(registerClientMock).not.toHaveBeenCalled();
    expect(authorizeMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'known-public-client' }));
  });

  it('rejects a name that is already registered', async () => {
    const { host, settings } = makeHost();
    settings.oauthMcpServers.vercel = { url: 'https://mcp.vercel.com/' };
    const registry = new OAuthMcpRegistry(host);

    const result = await registry.registerServer({ name: 'vercel', url: 'https://mcp.vercel.com/' });

    expect(result).toMatchObject({ success: false, status: 'conflict' });
    expect(discoverASMock).not.toHaveBeenCalled();
  });

  it('leaves no partial settings state and no running proxy when discovery fails', async () => {
    discoverASMock.mockRejectedValue(new Error('network down'));
    const { host, settings, save } = makeHost();
    const registry = new OAuthMcpRegistry(host);

    const result = await registry.registerServer({ name: 'vercel', url: 'https://mcp.vercel.com/' });

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(settings.oauthMcpServers.vercel).toBeUndefined();
    expect(settings.oauthMcpState.vercel).toBeUndefined();
    expect(proxyStartMock).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('leaves no partial settings state when the user denies consent', async () => {
    authorizeMock.mockRejectedValue(new Error('OAuth authorization was denied: access_denied'));
    const { host, settings } = makeHost();
    const registry = new OAuthMcpRegistry(host);

    const result = await registry.registerServer({ name: 'vercel', url: 'https://mcp.vercel.com/' });

    expect(result).toMatchObject({ success: false, status: 'cancelled' });
    expect(settings.oauthMcpServers.vercel).toBeUndefined();
    expect(settings.oauthMcpState.vercel).toBeUndefined();
    expect(proxyStartMock).not.toHaveBeenCalled();
  });

  it('leaves no partial settings state and stops the proxy when the final save fails', async () => {
    const { host, settings } = makeHost();
    host.save = vi.fn().mockRejectedValue(new Error('disk full'));
    const registry = new OAuthMcpRegistry(host);

    const result = await registry.registerServer({ name: 'vercel', url: 'https://mcp.vercel.com/' });

    expect(result).toMatchObject({ success: false, status: 'failed' });
    expect(settings.oauthMcpServers.vercel).toBeUndefined();
    expect(settings.oauthMcpState.vercel).toBeUndefined();
    expect(proxyStopMock).toHaveBeenCalledTimes(1);
  });

  it('fails cleanly when the proxy cannot start', async () => {
    proxyStartMock.mockRejectedValue(new Error('EADDRINUSE'));
    const { host, settings } = makeHost();
    const registry = new OAuthMcpRegistry(host);

    const result = await registry.registerServer({ name: 'vercel', url: 'https://mcp.vercel.com/' });

    expect(result).toMatchObject({ success: false, status: 'failed' });
    expect(settings.oauthMcpServers.vercel).toBeUndefined();
    expect(settings.oauthMcpState.vercel).toBeUndefined();
  });

  /**
   * Slack's registered redirect URI is `http://localhost:3118/callback` — a
   * `localhost` host, not `127.0.0.1`. Since redirect_uri validation is exact
   * string matching, the DCR registration and the later authorize() call must
   * both carry that literal string.
   */
  it('registers DCR with the exact supplied redirectUri and threads it through to authorize/persistence', async () => {
    const { host, settings } = makeHost();
    const registry = new OAuthMcpRegistry(host);
    const redirectUri = 'http://localhost:3118/callback';

    const result = await registry.registerServer({ name: 'slack', url: 'https://mcp.slack.com/', redirectUri });

    expect(result).toMatchObject({ success: true, status: 'registered' });
    expect(registerClientMock).toHaveBeenCalledWith(
      'https://as.example.com/register',
      redirectUri,
      undefined,
    );
    // Never rewritten to 127.0.0.1 anywhere along the path.
    expect(registerClientMock.mock.calls[0][1]).toContain('localhost');
    expect(authorizeMock).toHaveBeenCalledWith(expect.objectContaining({ redirectUri }));
    expect(settings.oauthMcpServers.slack).toMatchObject({ redirectUri });
  });

  it('reproduces today\'s exact portless-URI/ephemeral-port behavior when redirectUri is omitted (regression guard)', async () => {
    const { host, settings } = makeHost();
    const registry = new OAuthMcpRegistry(host);

    const result = await registry.registerServer({ name: 'vercel', url: 'https://mcp.vercel.com/' });

    expect(result).toMatchObject({ success: true, status: 'registered' });
    expect(registerClientMock).toHaveBeenCalledWith(
      'https://as.example.com/register',
      'http://127.0.0.1/callback',
      undefined,
    );
    expect(authorizeMock).toHaveBeenCalledWith(expect.objectContaining({ redirectUri: undefined }));
    expect(settings.oauthMcpServers.vercel.redirectUri).toBeUndefined();
  });

  it('fails cleanly when DCR is required but unsupported by the authorization server', async () => {
    discoverASMock.mockResolvedValue(fakeAsMetadata({ withoutRegistrationEndpoint: true }));
    const { host, settings } = makeHost();
    const registry = new OAuthMcpRegistry(host);

    const result = await registry.registerServer({ name: 'vercel', url: 'https://mcp.vercel.com/' });

    expect(result).toMatchObject({ success: false, status: 'failed' });
    expect(settings.oauthMcpServers.vercel).toBeUndefined();
  });
});

describe('OAuthMcpRegistry.serversForThread', () => {
  it('returns an http config with a minted capability-token header for every running proxy', async () => {
    const { host } = makeHost();
    const registry = new OAuthMcpRegistry(host);
    await registry.registerServer({ name: 'vercel', url: 'https://mcp.vercel.com/' });

    const servers = registry.serversForThread('thread-1');

    expect(servers).toEqual({
      vercel: { type: 'http', url: proxyUrl, headers: { 'X-Capability-Token': 'cap-thread-1' } },
    });
  });

  it('omits a server that has no running proxy', () => {
    const { host } = makeHost();
    const registry = new OAuthMcpRegistry(host);

    expect(registry.serversForThread('thread-1')).toEqual({});
  });
});

describe('OAuthMcpRegistry.retainThreads', () => {
  it('delegates to every running proxy', async () => {
    const { host } = makeHost();
    const registry = new OAuthMcpRegistry(host);
    await registry.registerServer({ name: 'vercel', url: 'https://mcp.vercel.com/' });
    await registry.registerServer({ name: 'figma', url: 'https://mcp.figma.com/' });

    const active = new Set(['thread-1']);
    registry.retainThreads(active);

    expect(proxyRetainThreadsMock).toHaveBeenCalledTimes(2);
    expect(proxyRetainThreadsMock).toHaveBeenCalledWith(active);
  });
});

describe('OAuthMcpRegistry.disconnect', () => {
  it('revokes, stops the proxy, and clears both settings maps', async () => {
    const { host, settings, save } = makeHost();
    const registry = new OAuthMcpRegistry(host);
    await registry.registerServer({ name: 'vercel', url: 'https://mcp.vercel.com/' });
    save.mockClear();

    await registry.disconnect('vercel');

    expect(revokeMock).toHaveBeenCalledWith('vercel', expect.anything());
    expect(proxyStopMock).toHaveBeenCalledTimes(1);
    expect(settings.oauthMcpServers.vercel).toBeUndefined();
    expect(settings.oauthMcpState.vercel).toBeUndefined();
    expect(save).toHaveBeenCalled();
    expect(registry.serversForThread('thread-1')).toEqual({});
  });

  it('still clears settings when there is no live connection to revoke', async () => {
    const { host, settings } = makeHost();
    settings.oauthMcpServers.vercel = { url: 'https://mcp.vercel.com/' };
    settings.oauthMcpState.vercel = {
      serverName: 'vercel', clientId: 'c', asMetadataUrl: 'https://as.example.com',
      proxyPort: 0, status: 'error', hasRefreshToken: false, tokenEndpoint: '',
    };
    const registry = new OAuthMcpRegistry(host);

    await registry.disconnect('vercel');

    expect(settings.oauthMcpServers.vercel).toBeUndefined();
    expect(settings.oauthMcpState.vercel).toBeUndefined();
  });
});

describe('OAuthMcpRegistry.configure', () => {
  it('rebuilds a proxy on startup for a server with a stored refresh token', async () => {
    const { host, settings } = makeHost();
    settings.oauthMcpServers.vercel = { url: 'https://mcp.vercel.com/' };
    const tokenStore = new OAuthTokenStore(host.secretStorage, async () => ({ accessToken: 'x' }));
    tokenStore.storeClientId('vercel', 'client-abc');
    tokenStore.store('vercel', { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3600_000 });

    const registry = new OAuthMcpRegistry(host);
    await registry.configure();

    expect(discoverASMock).toHaveBeenCalledWith('https://mcp.vercel.com/');
    expect(proxyStartMock).toHaveBeenCalledTimes(1);
    expect(settings.oauthMcpState.vercel).toMatchObject({ status: 'connected', clientId: 'client-abc' });
    expect(registry.serversForThread('thread-1')).toHaveProperty('vercel');
  });

  it('marks a server needs-auth when its access token is expired and there is no refresh token', async () => {
    const { host, settings } = makeHost();
    settings.oauthMcpServers.vercel = { url: 'https://mcp.vercel.com/' };
    const tokenStore = new OAuthTokenStore(host.secretStorage, async () => ({ accessToken: 'x' }));
    tokenStore.store('vercel', { accessToken: 'at-1', expiresAt: Date.now() - 1000 });

    const registry = new OAuthMcpRegistry(host);
    await registry.configure();

    expect(settings.oauthMcpState.vercel).toMatchObject({ status: 'needs-auth' });
  });

  it('skips a server with no stored tokens', async () => {
    const { host, settings } = makeHost();
    settings.oauthMcpServers.vercel = { url: 'https://mcp.vercel.com/' };

    const registry = new OAuthMcpRegistry(host);
    await registry.configure();

    expect(discoverASMock).not.toHaveBeenCalled();
    expect(proxyStartMock).not.toHaveBeenCalled();
  });

  it('does not throw when one server fails to rebuild, and still rebuilds the others', async () => {
    const { host, settings } = makeHost();
    settings.oauthMcpServers.broken = { url: 'https://mcp.broken.com/' };
    settings.oauthMcpServers.vercel = { url: 'https://mcp.vercel.com/' };
    const brokenStore = new OAuthTokenStore(host.secretStorage, async () => ({ accessToken: 'x' }));
    brokenStore.store('broken', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 });
    const okStore = new OAuthTokenStore(host.secretStorage, async () => ({ accessToken: 'x' }));
    okStore.store('vercel', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 });

    discoverASMock.mockImplementation(async (url: string) => {
      if (url.includes('broken')) throw new Error('discovery failed');
      return fakeAsMetadata();
    });

    const registry = new OAuthMcpRegistry(host);
    await expect(registry.configure()).resolves.toBeUndefined();

    expect(settings.oauthMcpState.broken).toMatchObject({ status: 'error' });
    expect(settings.oauthMcpState.vercel).toMatchObject({ status: 'connected' });
    expect(proxyStartMock).toHaveBeenCalledTimes(1);
  });
});

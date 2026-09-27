import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthMcpState, StoredOAuthMcpServer } from '../../src/types';

const discoverASMock = vi.fn();
const registerClientMock = vi.fn();
const authorizeMock = vi.fn();
const flowRefreshMock = vi.fn();
const clientCredentialsMock = vi.fn();
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
      clientCredentials: clientCredentialsMock,
      revoke: revokeMock,
    };
  }),
}));

const proxyStartMock = vi.fn();
const proxyStopMock = vi.fn();
const capabilityTokenForMock = vi.fn();
const proxyRetainThreadsMock = vi.fn();
let proxyUrl = 'http://127.0.0.1:5555/';

/**
 * The third constructor argument is the token accessor the proxy calls on every
 * request. Capturing it is the only seam onto the registry's private token
 * store, and therefore the only way to exercise the renewal path a running
 * server actually takes.
 */
const proxyTokenAccessors: Array<{ getAccessToken(name: string): Promise<string | null>; refresh(name: string): Promise<unknown> }> = [];

vi.mock('../../src/OAuthMcpProxy', () => ({
  OAuthMcpProxy: vi.fn().mockImplementation(function OAuthMcpProxy(_name: string, _url: string, tokens: { getAccessToken(name: string): Promise<string | null>; refresh(name: string): Promise<unknown> }) {
    proxyTokenAccessors.push(tokens);
    return {
      start: proxyStartMock,
      stop: proxyStopMock,
      capabilityTokenFor: capabilityTokenForMock,
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

/**
 * `scopesSupported` models the RFC 9728 *resource* metadata half of discovery:
 * omit the option for a resource that publishes none, pass an array for one
 * that advertises scopes, pass `null`/`[]` for the degenerate cases. The AS half
 * deliberately carries `scopes_supported: null`, matching Atlassian — which is
 * why the resource half is the only usable source of scope names.
 */
function fakeAsMetadata(opts: { withoutRegistrationEndpoint?: boolean; scopesSupported?: string[] | null } = {}) {
  const authorizationServerMetadata: Record<string, unknown> = {
    issuer: 'https://as.example.com',
    authorization_endpoint: 'https://as.example.com/authorize',
    token_endpoint: 'https://as.example.com/token',
    response_types_supported: ['code'],
    scopes_supported: null,
    revocation_endpoint: 'https://as.example.com/revoke',
  };
  if (!opts.withoutRegistrationEndpoint) authorizationServerMetadata.registration_endpoint = 'https://as.example.com/register';
  const resourceMetadata = 'scopesSupported' in opts
    ? { resource: 'https://mcp.example.com/', scopes_supported: opts.scopesSupported ?? undefined }
    : undefined;
  return { authorizationServerUrl: 'https://as.example.com', authorizationServerMetadata, resourceMetadata };
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
  proxyTokenAccessors.length = 0;
  proxyUrl = 'http://127.0.0.1:5555/';
  discoverASMock.mockResolvedValue(fakeAsMetadata());
  registerClientMock.mockResolvedValue({ clientId: 'dcr-client-id' });
  authorizeMock.mockResolvedValue({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3600_000 });
  flowRefreshMock.mockResolvedValue({ accessToken: 'at-2', refreshToken: 'rt-1', expiresAt: Date.now() + 3600_000 });
  // No refresh token: RFC 6749 §4.4.3 says the client_credentials grant SHOULD NOT issue one.
  clientCredentialsMock.mockResolvedValue({ accessToken: 'm2m-at', expiresAt: Date.now() + 86_400_000 });
  revokeMock.mockResolvedValue(undefined);
  proxyStartMock.mockResolvedValue(undefined);
  proxyStopMock.mockResolvedValue(undefined);
  capabilityTokenForMock.mockImplementation((threadId: string) => `cap-${threadId}`);
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

  /**
   * The custody rule for a confidential client: the secret goes to the keychain
   * and `data.json` records only that one exists. `StoredOAuthMcpServer` has no
   * field to hold it, so this also pins the shape against a future regression
   * that "helpfully" persists it alongside clientId.
   */
  it('puts a supplied client secret in the keychain, threads it to authorize, and records only a flag in settings', async () => {
    const { host, settings } = makeHost();
    const registry = new OAuthMcpRegistry(host);

    const result = await registry.registerServer({
      name: 'confidential', url: 'https://mcp.example.com/', clientId: 'known-client', clientSecret: 'shh-abc',
    });

    expect(result.success).toBe(true);
    expect(authorizeMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'known-client', clientSecret: 'shh-abc' }));

    const tokenStore = new OAuthTokenStore(host.secretStorage, async () => ({ accessToken: 'x' }));
    expect(tokenStore.getClientSecret('confidential')).toBe('shh-abc');

    expect(settings.oauthMcpServers.confidential).toMatchObject({ clientId: 'known-client', hasClientSecret: true });
    expect(JSON.stringify(settings.oauthMcpServers.confidential)).not.toContain('shh-abc');
    expect(JSON.stringify(settings.oauthMcpState.confidential)).not.toContain('shh-abc');
    expect(settings.oauthMcpState.confidential).toMatchObject({ hasClientSecret: true });
  });

  it('records no client-secret flag for a public client', async () => {
    const { host, settings } = makeHost();
    const registry = new OAuthMcpRegistry(host);

    await registry.registerServer({ name: 'vercel', url: 'https://mcp.vercel.com/' });

    expect(authorizeMock).toHaveBeenCalledWith(expect.objectContaining({ clientSecret: undefined }));
    expect(settings.oauthMcpServers.vercel.hasClientSecret).toBeUndefined();
    expect(settings.oauthMcpState.vercel).toMatchObject({ hasClientSecret: false });
  });

  /** RFC 7591 §3.2.1 — the AS may issue a secret even though DCR asked for `none`. */
  it('captures and stores a client_secret issued by Dynamic Client Registration', async () => {
    registerClientMock.mockResolvedValue({ clientId: 'dcr-client-id', clientSecret: 'dcr-secret' });
    const { host, settings } = makeHost();
    const registry = new OAuthMcpRegistry(host);

    const result = await registry.registerServer({ name: 'vercel', url: 'https://mcp.vercel.com/' });

    expect(result.success).toBe(true);
    expect(authorizeMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'dcr-client-id', clientSecret: 'dcr-secret' }));
    const tokenStore = new OAuthTokenStore(host.secretStorage, async () => ({ accessToken: 'x' }));
    expect(tokenStore.getClientSecret('vercel')).toBe('dcr-secret');
    expect(settings.oauthMcpServers.vercel).toMatchObject({ hasClientSecret: true });
  });

  it('leaves no client secret in the keychain when consent is denied', async () => {
    authorizeMock.mockRejectedValue(new Error('OAuth authorization was denied: access_denied'));
    const { host } = makeHost();
    const registry = new OAuthMcpRegistry(host);

    await registry.registerServer({
      name: 'confidential', url: 'https://mcp.example.com/', clientId: 'known-client', clientSecret: 'shh-abc',
    });

    const tokenStore = new OAuthTokenStore(host.secretStorage, async () => ({ accessToken: 'x' }));
    expect(tokenStore.getClientSecret('confidential')).toBeUndefined();
  });

  /**
   * The whole point of the grant: no browser, no consent screen, no loopback
   * listener. `authorize` never being called is the assertion that matters here —
   * `auth.bankrate.com` will not register a loopback redirect URI at all.
   */
  it('mints a token from client credentials without ever opening a browser', async () => {
    const { host, settings } = makeHost();
    const registry = new OAuthMcpRegistry(host);

    const result = await registry.registerServer({
      name: 'bankrate',
      url: 'https://products-mcp.bankrate.com/mcp',
      grantType: 'client_credentials',
      clientId: 'reTmVHKuhRrGiXOo3lqvS4zMUxagdXZC',
      clientSecret: 'shh-abc',
      audience: 'bankrate-api',
    });

    expect(result).toMatchObject({ success: true, status: 'registered' });
    expect(authorizeMock).not.toHaveBeenCalled();
    expect(registerClientMock).not.toHaveBeenCalled();
    expect(host.openUrl).not.toHaveBeenCalled();
    expect(clientCredentialsMock).toHaveBeenCalledWith(expect.objectContaining({
      serverName: 'bankrate',
      clientId: 'reTmVHKuhRrGiXOo3lqvS4zMUxagdXZC',
      clientSecret: 'shh-abc',
      audience: 'bankrate-api',
    }));
    expect(proxyStartMock).toHaveBeenCalledTimes(1);
  });

  it('persists grantType and audience so a restart reconnects the same way', async () => {
    const { host, settings } = makeHost();

    await new OAuthMcpRegistry(host).registerServer({
      name: 'bankrate',
      url: 'https://products-mcp.bankrate.com/mcp',
      grantType: 'client_credentials',
      clientId: 'm2m',
      clientSecret: 'shh-abc',
      audience: 'bankrate-api',
    });

    expect(settings.oauthMcpServers.bankrate).toMatchObject({
      grantType: 'client_credentials', audience: 'bankrate-api', clientId: 'm2m', hasClientSecret: true,
    });
    expect(settings.oauthMcpState.bankrate).toMatchObject({ status: 'connected', grantType: 'client_credentials' });
    // No refresh token by construction, yet still connected — the secret is the renewal material.
    expect(settings.oauthMcpState.bankrate.hasRefreshToken).toBe(false);
    expect(JSON.stringify(settings.oauthMcpServers.bankrate)).not.toContain('shh-abc');
  });

  /**
   * Backward compatibility is deliberate: an authorization_code entry written
   * after this feature must be byte-identical to one written before it, or a
   * downgrade would read fields it does not understand.
   */
  it('writes no grantType or audience key for the default authorization_code grant', async () => {
    const { host, settings } = makeHost();

    await new OAuthMcpRegistry(host).registerServer({ name: 'vercel', url: 'https://mcp.vercel.com/' });

    expect(Object.keys(settings.oauthMcpServers.vercel)).not.toContain('grantType');
    expect(Object.keys(settings.oauthMcpServers.vercel)).not.toContain('audience');
    expect(Object.keys(settings.oauthMcpState.vercel)).not.toContain('grantType');
  });

  it('refuses a client_credentials registration with no clientId, before any network call', async () => {
    const { host, settings } = makeHost();

    const result = await new OAuthMcpRegistry(host).registerServer({
      name: 'bankrate', url: 'https://products-mcp.bankrate.com/mcp', grantType: 'client_credentials', clientSecret: 'shh-abc',
    });

    expect(result).toMatchObject({ success: false, status: 'failed' });
    expect(result.message).toMatch(/client ID/i);
    expect(discoverASMock).not.toHaveBeenCalled();
    expect(settings.oauthMcpServers.bankrate).toBeUndefined();
  });

  /** There is no such thing as a public machine-to-machine client. */
  it('refuses a client_credentials registration with no clientSecret', async () => {
    const { host, settings } = makeHost();

    const result = await new OAuthMcpRegistry(host).registerServer({
      name: 'bankrate', url: 'https://products-mcp.bankrate.com/mcp', grantType: 'client_credentials', clientId: 'm2m',
    });

    expect(result).toMatchObject({ success: false, status: 'failed' });
    expect(result.message).toMatch(/client secret/i);
    expect(discoverASMock).not.toHaveBeenCalled();
    expect(settings.oauthMcpServers.bankrate).toBeUndefined();
  });

  /**
   * `cancelled` means a human declined at a consent screen. There is no human
   * here, so a token failure is always `failed` — reporting it as cancelled
   * would suggest retrying the same credentials will help.
   */
  it('reports a rejected client_credentials token request as failed, never cancelled', async () => {
    clientCredentialsMock.mockRejectedValue(new Error('Token request failed: access_denied'));
    const { host, settings } = makeHost();

    const result = await new OAuthMcpRegistry(host).registerServer({
      name: 'bankrate', url: 'https://products-mcp.bankrate.com/mcp', grantType: 'client_credentials', clientId: 'm2m', clientSecret: 'wrong',
    });

    expect(result).toMatchObject({ success: false, status: 'failed' });
    expect(settings.oauthMcpServers.bankrate).toBeUndefined();
    const tokenStore = new OAuthTokenStore(host.secretStorage, async () => ({ accessToken: 'x' }));
    expect(tokenStore.getClientSecret('bankrate')).toBeUndefined();
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

  /**
   * `audience` (Auth0's API identifier) is a general `oauth`-entry field with
   * no grant-type restriction in `mcpRegistrationSchema` — it must thread
   * through to `authorize()` for the default `authorization_code` grant too,
   * not just `clientCredentials()` (covered separately below), or setting it
   * on an interactive entry silently does nothing.
   */
  it('threads a configured audience through to authorize() for the authorization_code grant', async () => {
    const { host, settings } = makeHost();
    const registry = new OAuthMcpRegistry(host);

    const result = await registry.registerServer({ name: 'bankrate', url: 'https://mcp.bankrate.com/', audience: 'bankrate-api' });

    expect(result).toMatchObject({ success: true, status: 'registered' });
    expect(authorizeMock).toHaveBeenCalledWith(expect.objectContaining({ audience: 'bankrate-api' }));
    expect(settings.oauthMcpServers.bankrate).toMatchObject({ audience: 'bankrate-api' });
  });

  it('does not pass audience to authorize() when none is configured', async () => {
    const { host } = makeHost();
    const registry = new OAuthMcpRegistry(host);

    const result = await registry.registerServer({ name: 'vercel', url: 'https://mcp.vercel.com/' });

    expect(result).toMatchObject({ success: true, status: 'registered' });
    expect(authorizeMock).toHaveBeenCalledWith(expect.objectContaining({ audience: undefined }));
  });

  /**
   * Regression guard for the failure Atlassian's MCP server produces: registered
   * with no `scopes`, no `scope` parameter reaches the authorization request, the
   * AS issues its own default (identity-only) grant, and every real API call
   * then 401s with "scope does not match" — while `atlassianUserInfo` keeps
   * working, so the connection looks healthy.
   */
  it('falls back to the resource metadata\'s advertised scopes when none are supplied', async () => {
    discoverASMock.mockResolvedValue(fakeAsMetadata({ scopesSupported: ['offline_access', 'read:me', 'read:jira-work', 'write:jira-work'] }));
    const { host, settings } = makeHost();
    const registry = new OAuthMcpRegistry(host);

    const result = await registry.registerServer({ name: 'atlassian', url: 'https://mcp.atlassian.com/v1/mcp/authv2' });

    expect(result.success).toBe(true);
    const expected = 'offline_access read:me read:jira-work write:jira-work';
    expect(registerClientMock).toHaveBeenCalledWith('https://as.example.com/register', 'http://127.0.0.1/callback', expected);
    expect(authorizeMock).toHaveBeenCalledWith(expect.objectContaining({ scopes: expected }));
    // Persisted so a reconnect reproduces this exact grant.
    expect(settings.oauthMcpServers.atlassian.scopes).toBe(expected);
  });

  it('prefers explicitly supplied scopes over the advertised list', async () => {
    discoverASMock.mockResolvedValue(fakeAsMetadata({ scopesSupported: ['read:jira-work', 'write:jira-work', 'read:confluence-content.all', 'write:confluence-content'] }));
    const { host, settings } = makeHost();
    const registry = new OAuthMcpRegistry(host);

    const scopes = 'offline_access read:me read:jira-work write:jira-work';
    const result = await registry.registerServer({ name: 'atlassian', url: 'https://mcp.atlassian.com/v1/mcp/authv2', scopes });

    expect(result.success).toBe(true);
    expect(registerClientMock).toHaveBeenCalledWith(expect.any(String), expect.any(String), scopes);
    expect(authorizeMock).toHaveBeenCalledWith(expect.objectContaining({ scopes }));
    expect(settings.oauthMcpServers.atlassian.scopes).toBe(scopes);
    // Never widened to include the Confluence scopes the resource also advertises.
    expect(authorizeMock.mock.calls[0][0].scopes).not.toContain('confluence');
  });

  it('sends no scopes at all when neither the caller nor the resource names any', async () => {
    // A resource that publishes metadata but leaves scopes_supported out, and
    // one that publishes an empty array, must both behave like today: omit the
    // scope parameter entirely rather than sending an empty string.
    for (const scopesSupported of [null, []] as Array<string[] | null>) {
      vi.clearAllMocks();
      registerClientMock.mockResolvedValue({ clientId: 'dcr-client-id' });
      authorizeMock.mockResolvedValue({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3600_000 });
      proxyStartMock.mockResolvedValue(undefined);
      discoverASMock.mockResolvedValue(fakeAsMetadata({ scopesSupported }));
      const { host, settings } = makeHost();

      const result = await new OAuthMcpRegistry(host).registerServer({ name: 'vercel', url: 'https://mcp.vercel.com/' });

      expect(result.success).toBe(true);
      expect(registerClientMock).toHaveBeenCalledWith(expect.any(String), expect.any(String), undefined);
      expect(authorizeMock).toHaveBeenCalledWith(expect.objectContaining({ scopes: undefined }));
      expect(settings.oauthMcpServers.vercel.scopes).toBeUndefined();
    }
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

  // ThreadManager calls this on every turn but only applies the result when it
  // creates a session, so the config a live session is running on must not
  // drift underneath it. Same guarantee GoogleWorkspaceMcp's "preserves thread
  // capabilities across calls" test pins down for its side.
  it('returns an identical config when called again for the same thread', async () => {
    const { host } = makeHost();
    const registry = new OAuthMcpRegistry(host);
    await registry.registerServer({ name: 'vercel', url: 'https://mcp.vercel.com/' });

    const first = registry.serversForThread('thread-1');
    const second = registry.serversForThread('thread-1');

    expect(second).toEqual(first);
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

  /**
   * The sibling of the test directly above. An expired token with no refresh
   * token is *not* broken for this grant — the keychain secret is the renewal
   * material, so the right answer is `connected`, not `needs-auth`.
   */
  it('reconnects an expired client_credentials server as connected, because its secret can re-mint', async () => {
    const { host, settings } = makeHost();
    settings.oauthMcpServers.bankrate = {
      url: 'https://products-mcp.bankrate.com/mcp',
      grantType: 'client_credentials',
      audience: 'bankrate-api',
      clientId: 'm2m',
      hasClientSecret: true,
    };
    const tokenStore = new OAuthTokenStore(host.secretStorage, async () => ({ accessToken: 'x' }));
    tokenStore.storeClientId('bankrate', 'm2m');
    tokenStore.storeClientSecret('bankrate', 'shh-abc');
    tokenStore.store('bankrate', { accessToken: 'at-1', expiresAt: Date.now() - 1000 });

    await new OAuthMcpRegistry(host).configure();

    expect(settings.oauthMcpState.bankrate).toMatchObject({ status: 'connected', grantType: 'client_credentials' });
    expect(proxyStartMock).toHaveBeenCalledTimes(1);
  });

  it('flags needs-auth for a client_credentials server whose secret is gone from the keychain', async () => {
    const { host, settings } = makeHost();
    settings.oauthMcpServers.bankrate = {
      url: 'https://products-mcp.bankrate.com/mcp', grantType: 'client_credentials', clientId: 'm2m', hasClientSecret: true,
    };
    const tokenStore = new OAuthTokenStore(host.secretStorage, async () => ({ accessToken: 'x' }));
    tokenStore.storeClientId('bankrate', 'm2m');
    tokenStore.store('bankrate', { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 });

    await new OAuthMcpRegistry(host).configure();

    expect(settings.oauthMcpState.bankrate).toMatchObject({ status: 'needs-auth', hasClientSecret: false });
  });

  /**
   * The renewal path a client_credentials server actually takes at runtime: the
   * token store's refresh hook must route to `clientCredentials`, not `refresh`,
   * which has no refresh token to present and would throw.
   */
  it('renews a client_credentials server through clientCredentials rather than refresh', async () => {
    const { host, settings } = makeHost();
    settings.oauthMcpServers.bankrate = {
      url: 'https://products-mcp.bankrate.com/mcp',
      grantType: 'client_credentials',
      audience: 'bankrate-api',
      clientId: 'm2m',
      hasClientSecret: true,
    };
    const seed = new OAuthTokenStore(host.secretStorage, async () => ({ accessToken: 'x' }));
    seed.storeClientId('bankrate', 'm2m');
    seed.storeClientSecret('bankrate', 'shh-abc');
    // Inside the 5-minute proactive-renewal window, so the next read renews.
    seed.store('bankrate', { accessToken: 'at-1', expiresAt: Date.now() + 60_000 });

    await new OAuthMcpRegistry(host).configure();

    // Exactly what the proxy does on the next request it serves.
    await expect(proxyTokenAccessors[0].getAccessToken('bankrate')).resolves.toBe('m2m-at');

    expect(flowRefreshMock).not.toHaveBeenCalled();
    expect(clientCredentialsMock).toHaveBeenCalledWith(expect.objectContaining({
      serverName: 'bankrate', clientId: 'm2m', clientSecret: 'shh-abc', audience: 'bankrate-api',
    }));
  });

  /** The authorization-code sibling must keep taking the refresh-token path. */
  it('still renews an authorization_code server through refresh, not clientCredentials', async () => {
    const { host, settings } = makeHost();
    settings.oauthMcpServers.vercel = { url: 'https://mcp.vercel.com/' };
    const seed = new OAuthTokenStore(host.secretStorage, async () => ({ accessToken: 'x' }));
    seed.storeClientId('vercel', 'client-abc');
    seed.store('vercel', { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 60_000 });

    await new OAuthMcpRegistry(host).configure();
    await expect(proxyTokenAccessors[0].getAccessToken('vercel')).resolves.toBe('at-2');

    expect(flowRefreshMock).toHaveBeenCalledTimes(1);
    expect(clientCredentialsMock).not.toHaveBeenCalled();
  });

  it('reconnects a confidential client and reports it as one', async () => {
    const { host, settings } = makeHost();
    settings.oauthMcpServers.confidential = { url: 'https://mcp.example.com/', hasClientSecret: true };
    const tokenStore = new OAuthTokenStore(host.secretStorage, async () => ({ accessToken: 'x' }));
    tokenStore.storeClientId('confidential', 'client-abc');
    tokenStore.storeClientSecret('confidential', 'shh-abc');
    tokenStore.store('confidential', { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3600_000 });

    await new OAuthMcpRegistry(host).configure();

    expect(settings.oauthMcpState.confidential).toMatchObject({ status: 'connected', hasClientSecret: true });
  });

  /**
   * The vault's `data.json` says this is a confidential client but the keychain
   * no longer has the secret — a keychain reset, or the vault synced to another
   * machine. Every token refresh from here on would fail with `invalid_client`,
   * so say so at startup instead of looking connected until the token expires.
   */
  it('flags needs-auth with an explanation when a confidential client\'s secret is gone from the keychain', async () => {
    const { host, settings } = makeHost();
    settings.oauthMcpServers.confidential = { url: 'https://mcp.example.com/', hasClientSecret: true };
    const tokenStore = new OAuthTokenStore(host.secretStorage, async () => ({ accessToken: 'x' }));
    tokenStore.storeClientId('confidential', 'client-abc');
    tokenStore.store('confidential', { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3600_000 });

    await new OAuthMcpRegistry(host).configure();

    expect(settings.oauthMcpState.confidential).toMatchObject({ status: 'needs-auth', hasClientSecret: false });
    expect(settings.oauthMcpState.confidential.errorMessage).toMatch(/client secret.*keychain/i);
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

// vi.mock calls must be hoisted above the imports they affect.
const sdkAuth = vi.hoisted(() => ({
  discoverOAuthServerInfo: vi.fn(),
  exchangeAuthorization: vi.fn(),
  refreshAuthorization: vi.fn(),
  registerClient: vi.fn(),
  parseErrorResponse: vi.fn(async (input: Response | string) => new Error(typeof input === 'string' ? input : `HTTP ${input.status}`)),
}));

vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => sdkAuth);

const { OAuthMcpFlow, generatePkcePair, pkceChallengeForVerifier, resourceIndicatorFor } = await import('../../src/OAuthMcpFlow');
type TokenSet = import('../../src/OAuthTokenStore').TokenSet;
type OAuthTokenStoreLike = import('../../src/OAuthMcpFlow').OAuthTokenStoreLike;

function fixtureAsMetadata(overrides: Partial<OAuthServerInfo> = {}): OAuthServerInfo {
  return {
    authorizationServerUrl: 'https://vercel.com',
    authorizationServerMetadata: {
      issuer: 'https://vercel.com',
      authorization_endpoint: 'https://vercel.com/oauth/authorize',
      token_endpoint: 'https://vercel.com/oauth/token',
      registration_endpoint: 'https://vercel.com/oauth/register',
      revocation_endpoint: 'https://vercel.com/oauth/revoke',
      response_types_supported: ['code'],
    },
    ...overrides,
  };
}

function fixtureTokenStore(initial: Partial<Record<string, unknown>> = {}): OAuthTokenStoreLike & { stored: TokenSet[] } {
  const stored: TokenSet[] = [];
  return {
    stored,
    store: vi.fn(async (_serverName: string, tokens: TokenSet) => { stored.push(tokens); }),
    getClientId: vi.fn(async () => (initial.clientId as string | undefined)),
    getClientSecret: vi.fn(async () => (initial.clientSecret as string | undefined)),
    getCurrentTokens: vi.fn(async () => (initial.currentTokens as TokenSet | undefined)),
    clear: vi.fn(async () => {}),
  };
}

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.text() };
}

/**
 * Bind :0, read the port the OS handed out, release it. Tests that need a
 * *fixed* port need one that is actually free — hardcoding a number risks
 * colliding with whatever else is running on the machine (3118 itself is
 * routinely held by Claude Code/Claude Desktop).
 */
async function freePort(): Promise<number> {
  const { createServer } = await import('http');
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const address = probe.address();
  const port = address && typeof address !== 'string' ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

beforeEach(() => {
  sdkAuth.discoverOAuthServerInfo.mockReset();
  sdkAuth.exchangeAuthorization.mockReset();
  sdkAuth.refreshAuthorization.mockReset();
  sdkAuth.registerClient.mockReset();
});

describe('PKCE generation', () => {
  it('matches the RFC 7636 Appendix B.1 S256 test vector', () => {
    // https://datatracker.ietf.org/doc/html/rfc7636#appendix-B
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(pkceChallengeForVerifier(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('generatePkcePair produces a verifier/challenge pair consistent with pkceChallengeForVerifier', () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{40,}$/); // 32 random bytes, base64url — no padding, no +/=
    expect(challenge).toBe(pkceChallengeForVerifier(verifier));
  });

  it('generates a distinct verifier on every call', () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe('OAuthMcpFlow.discoverAS', () => {
  it('delegates to discoverOAuthServerInfo and returns its result', async () => {
    const info = fixtureAsMetadata();
    sdkAuth.discoverOAuthServerInfo.mockResolvedValue(info);
    const flow = new OAuthMcpFlow(fixtureTokenStore(), vi.fn());
    await expect(flow.discoverAS('https://mcp.vercel.com/')).resolves.toEqual(info);
    expect(sdkAuth.discoverOAuthServerInfo).toHaveBeenCalledWith(
      'https://mcp.vercel.com/',
      expect.objectContaining({ fetchFn: expect.any(Function) }),
    );
  });

  /**
   * Regression guard for a bug that was green in CI and broken in the app.
   *
   * Every authorization-server call must go through the injected fetchFn, never
   * the SDK's default global `fetch`. Under vitest (Node) both work, so nothing
   * here catches the difference by accident — but in the renderer the origin is
   * `file://`, from which Chromium blocks all cross-origin fetches, and the SDK
   * converts that TypeError into `undefined` metadata rather than an error. The
   * user-visible symptom was "this authorization server does not support
   * Dynamic Client Registration" for a server that plainly does.
   */
  it('routes every authorization-server call through the injected fetchFn', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const info = fixtureAsMetadata();
    sdkAuth.discoverOAuthServerInfo.mockResolvedValue(info);
    sdkAuth.registerClient.mockResolvedValue({ client_id: 'issued' });
    sdkAuth.refreshAuthorization.mockResolvedValue({ access_token: 'a', refresh_token: 'r', expires_in: 60 });

    const tokenStore = fixtureTokenStore();
    tokenStore.getCurrentTokens = vi.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
    tokenStore.getClientId = vi.fn().mockResolvedValue('client-1');
    const flow = new OAuthMcpFlow(tokenStore, vi.fn(), fetchFn);

    await flow.discoverAS('https://mcp.vercel.com/');
    await flow.registerClient('https://as.example/register', 'http://127.0.0.1:1/callback');
    await flow.refresh('vercel', info);

    for (const call of [
      sdkAuth.discoverOAuthServerInfo.mock.calls[0][1],
      sdkAuth.registerClient.mock.calls[0][1],
      sdkAuth.refreshAuthorization.mock.calls[0][1],
    ]) {
      expect(call.fetchFn).toBe(fetchFn);
    }
  });
});

describe('OAuthMcpFlow.registerClient', () => {
  it('registers with the given registration endpoint and redirect_uri, returning the issued client_id', async () => {
    const info: OAuthClientInformationFull = {
      client_id: 'client-123', redirect_uris: ['http://127.0.0.1:1234/callback'],
    };
    sdkAuth.registerClient.mockResolvedValue(info);
    const flow = new OAuthMcpFlow(fixtureTokenStore(), vi.fn());
    const registered = await flow.registerClient('https://vercel.com/oauth/register', 'http://127.0.0.1:1234/callback', 'openid profile');
    expect(registered).toEqual({ clientId: 'client-123', clientSecret: undefined });
    expect(sdkAuth.registerClient).toHaveBeenCalledWith(
      'https://vercel.com/oauth/register',
      expect.objectContaining({
        scope: 'openid profile',
        clientMetadata: expect.objectContaining({ redirect_uris: ['http://127.0.0.1:1234/callback'] }),
        metadata: expect.objectContaining({ registration_endpoint: 'https://vercel.com/oauth/register' }),
      }),
    );
  });

  /**
   * We keep asking for a public client, because that is what works with every
   * server we know of and needs no secret custody.
   */
  it('still requests token_endpoint_auth_method "none"', async () => {
    sdkAuth.registerClient.mockResolvedValue({ client_id: 'client-123', redirect_uris: ['http://127.0.0.1:1234/callback'] });
    const flow = new OAuthMcpFlow(fixtureTokenStore(), vi.fn());
    await flow.registerClient('https://vercel.com/oauth/register', 'http://127.0.0.1:1234/callback');
    expect(sdkAuth.registerClient).toHaveBeenCalledWith('https://vercel.com/oauth/register', expect.objectContaining({
      clientMetadata: expect.objectContaining({ token_endpoint_auth_method: 'none' }),
    }));
  });

  /**
   * RFC 7591 §3.2.1 lets the AS answer with a `client_secret` even when the
   * request asked for `none`. Dropping it used to turn the next token exchange
   * into an opaque `invalid_client`, which read like a consent failure.
   */
  it('returns a client_secret the AS issues despite the "none" request', async () => {
    sdkAuth.registerClient.mockResolvedValue({
      client_id: 'client-123',
      client_secret: 'issued-secret',
      redirect_uris: ['http://127.0.0.1:1234/callback'],
    });
    const flow = new OAuthMcpFlow(fixtureTokenStore(), vi.fn());
    await expect(flow.registerClient('https://vercel.com/oauth/register', 'http://127.0.0.1:1234/callback'))
      .resolves.toEqual({ clientId: 'client-123', clientSecret: 'issued-secret' });
  });
});

describe('OAuthMcpFlow.authorize', () => {
  let openUrl: ReturnType<typeof vi.fn>;
  let capturedUrl: URL;

  beforeEach(() => {
    capturedUrl = undefined as unknown as URL;
    openUrl = vi.fn(async (url: string) => { capturedUrl = new URL(url); });
  });

  it('opens a well-formed authorization URL with PKCE params, exchanges the callback code, and resolves the token set', async () => {
    const tokens: OAuthTokens = { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'bearer', expires_in: 3600 };
    sdkAuth.exchangeAuthorization.mockResolvedValue(tokens);
    const tokenStore = fixtureTokenStore();
    const flow = new OAuthMcpFlow(tokenStore, openUrl);

    const promise = flow.authorize({ serverName: 'vercel', clientId: 'client-123', asMetadata: fixtureAsMetadata(), scopes: 'openid profile' });
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalled());

    expect(capturedUrl.origin + capturedUrl.pathname).toBe('https://vercel.com/oauth/authorize');
    expect(capturedUrl.searchParams.get('response_type')).toBe('code');
    expect(capturedUrl.searchParams.get('client_id')).toBe('client-123');
    expect(capturedUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(capturedUrl.searchParams.get('scope')).toBe('openid profile');
    const state = capturedUrl.searchParams.get('state');
    const redirectUri = capturedUrl.searchParams.get('redirect_uri')!;
    expect(state).toBeTruthy();
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const callbackRes = await httpGet(`${redirectUri}?code=auth-code-1&state=${state}`);
    expect(callbackRes.status).toBe(200);

    const result = await promise;
    expect(result).toEqual({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: expect.any(Number) });
    expect(tokenStore.store).toHaveBeenCalledWith('vercel', result);
    expect(sdkAuth.exchangeAuthorization).toHaveBeenCalledWith('https://vercel.com', expect.objectContaining({
      authorizationCode: 'auth-code-1',
      redirectUri,
      clientInformation: { client_id: 'client-123' },
    }));
  });

  /**
   * A confidential client authenticates at the token endpoint only. The secret
   * must never appear on the authorization request: that URL goes through the
   * user's address bar, the AS's access logs and any referrer along the way.
   */
  it('sends a client_secret on the token exchange but never on the authorization URL', async () => {
    const tokens: OAuthTokens = { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'bearer', expires_in: 3600 };
    sdkAuth.exchangeAuthorization.mockResolvedValue(tokens);
    const flow = new OAuthMcpFlow(fixtureTokenStore(), openUrl);

    const promise = flow.authorize({
      serverName: 'confidential', clientId: 'client-123', clientSecret: 'shh-abc', asMetadata: fixtureAsMetadata(),
    });
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalled());

    expect(capturedUrl.searchParams.has('client_secret')).toBe(false);
    expect(capturedUrl.href).not.toContain('shh-abc');

    const redirectUri = capturedUrl.searchParams.get('redirect_uri')!;
    await httpGet(`${redirectUri}?code=auth-code-1&state=${capturedUrl.searchParams.get('state')}`);
    await promise;

    // The SDK's applyClientAuthentication negotiates client_secret_basic vs
    // client_secret_post from the AS metadata, so passing it through
    // clientInformation is all this layer has to do.
    expect(sdkAuth.exchangeAuthorization).toHaveBeenCalledWith('https://vercel.com', expect.objectContaining({
      clientInformation: { client_id: 'client-123', client_secret: 'shh-abc' },
    }));
  });

  it('omits client_secret from clientInformation entirely for a public client', async () => {
    const tokens: OAuthTokens = { access_token: 'at-1', token_type: 'bearer', expires_in: 3600 };
    sdkAuth.exchangeAuthorization.mockResolvedValue(tokens);
    const flow = new OAuthMcpFlow(fixtureTokenStore(), openUrl);

    const promise = flow.authorize({ serverName: 'vercel', clientId: 'client-123', asMetadata: fixtureAsMetadata() });
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalled());
    const redirectUri = capturedUrl.searchParams.get('redirect_uri')!;
    await httpGet(`${redirectUri}?code=auth-code-1&state=${capturedUrl.searchParams.get('state')}`);
    await promise;

    // Not `client_secret: undefined` — an explicit undefined key would still make
    // the SDK treat the client as confidential-with-a-blank-secret.
    const exchanged = sdkAuth.exchangeAuthorization.mock.calls[0][1] as { clientInformation: Record<string, unknown> };
    expect('client_secret' in exchanged.clientInformation).toBe(false);
  });

  it('rejects on a state mismatch without exchanging the code', async () => {
    const tokenStore = fixtureTokenStore();
    const flow = new OAuthMcpFlow(tokenStore, openUrl);
    const promise = flow.authorize({ serverName: 'vercel', clientId: 'client-123', asMetadata: fixtureAsMetadata() });
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalled());
    const redirectUri = capturedUrl.searchParams.get('redirect_uri')!;

    // Attach the rejection handler before triggering the callback — the promise rejects
    // synchronously as soon as the server processes the request, which can race ahead of
    // an `await` on the client-side fetch resolving.
    const rejection = expect(promise).rejects.toThrow(/state mismatch/i);
    const callbackRes = await httpGet(`${redirectUri}?code=auth-code-1&state=wrong-state`);
    expect(callbackRes.status).toBe(400);
    await rejection;
    expect(sdkAuth.exchangeAuthorization).not.toHaveBeenCalled();
    expect(tokenStore.store).not.toHaveBeenCalled();
  });

  it('rejects when the authorization server reports a denial', async () => {
    const tokenStore = fixtureTokenStore();
    const flow = new OAuthMcpFlow(tokenStore, openUrl);
    const promise = flow.authorize({ serverName: 'vercel', clientId: 'client-123', asMetadata: fixtureAsMetadata() });
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalled());
    const redirectUri = capturedUrl.searchParams.get('redirect_uri')!;

    const rejection = expect(promise).rejects.toThrow(/denied/i);
    const callbackRes = await httpGet(`${redirectUri}?error=access_denied`);
    expect(callbackRes.status).toBe(200); // still a normal browser-facing page
    await rejection;
    expect(sdkAuth.exchangeAuthorization).not.toHaveBeenCalled();
  });

  it('rejects and cleans up the callback server when openUrl itself fails', async () => {
    const failingOpenUrl = vi.fn(async () => { throw new Error('Web Viewer unavailable'); });
    const flow = new OAuthMcpFlow(fixtureTokenStore(), failingOpenUrl);
    await expect(flow.authorize({ serverName: 'vercel', clientId: 'c', asMetadata: fixtureAsMetadata() }))
      .rejects.toThrow('Web Viewer unavailable');
  });

  it('defaults to an ephemeral 127.0.0.1 port and a /callback path when redirectUri is omitted', async () => {
    const tokens: OAuthTokens = { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'bearer', expires_in: 3600 };
    sdkAuth.exchangeAuthorization.mockResolvedValue(tokens);
    const flow = new OAuthMcpFlow(fixtureTokenStore(), openUrl);

    const promise = flow.authorize({ serverName: 'vercel', clientId: 'client-123', asMetadata: fixtureAsMetadata() });
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalled());

    const redirectUri = capturedUrl.searchParams.get('redirect_uri')!;
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const state = capturedUrl.searchParams.get('state');
    await httpGet(`${redirectUri}?code=auth-code-1&state=${state}`);
    await promise;
    expect(sdkAuth.exchangeAuthorization).toHaveBeenCalledWith('https://vercel.com', expect.objectContaining({ redirectUri }));
  });

  /**
   * The actual Slack regression this option exists for.
   *
   * Slack registers `http://localhost:3118/callback` and validates redirect_uri
   * by exact string match, so a supplied `localhost` URI must stay `localhost`
   * in BOTH the authorization request and the token exchange. Rebuilding the URI
   * from the bound socket's address would rewrite it to `127.0.0.1` and get the
   * whole flow rejected — hence the explicit assertions on the literal string.
   */
  it('uses a supplied localhost redirectUri verbatim in the authorization URL and the token exchange', async () => {
    const tokens: OAuthTokens = { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'bearer', expires_in: 3600 };
    sdkAuth.exchangeAuthorization.mockResolvedValue(tokens);
    const port = await freePort();
    const pinned = `http://localhost:${port}/callback`;
    const flow = new OAuthMcpFlow(fixtureTokenStore(), openUrl);

    const promise = flow.authorize({ serverName: 'slack', clientId: 'client-123', asMetadata: fixtureAsMetadata(), redirectUri: pinned });
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalled());

    const redirectUri = capturedUrl.searchParams.get('redirect_uri')!;
    expect(redirectUri).toBe(pinned);
    expect(redirectUri).toContain('localhost');
    expect(redirectUri).not.toContain('127.0.0.1');

    const state = capturedUrl.searchParams.get('state');
    const callbackRes = await httpGet(`${pinned}?code=auth-code-1&state=${state}`);
    expect(callbackRes.status).toBe(200);

    await promise;
    expect(sdkAuth.exchangeAuthorization).toHaveBeenCalledWith('https://vercel.com', expect.objectContaining({
      redirectUri: pinned,
    }));
  });

  /**
   * Binding must use the hostname parsed from the URI, not a hardcoded
   * 127.0.0.1. On macOS `localhost` commonly resolves to ::1 first, so a
   * 127.0.0.1 bind for a `localhost` URI leaves the browser connecting over
   * IPv6 to a dead port — after the user has already consented.
   *
   * Asserting this by fetching `http://localhost:<port>` does NOT work as a
   * regression guard: Node's fetch (like most clients) falls back to the other
   * address family when the first refuses, so it passes either way. Instead,
   * occupy 127.0.0.1:<port> and pin an explicit `[::1]` URI on the same port
   * number. The two address families can hold the same port independently, so
   * a correct ::1 bind succeeds while a hardcoded 127.0.0.1 bind collides with
   * the blocker and fails — a deterministic discriminator with no dependence
   * on client resolution order.
   */
  it('binds the address family named in redirectUri rather than a hardcoded 127.0.0.1', async () => {
    const tokens: OAuthTokens = { access_token: 'at-1', token_type: 'bearer', expires_in: 3600 };
    sdkAuth.exchangeAuthorization.mockResolvedValue(tokens);
    const port = await freePort();
    const pinned = `http://[::1]:${port}/callback`;
    const flow = new OAuthMcpFlow(fixtureTokenStore(), openUrl);

    const { createServer } = await import('http');
    const ipv4Blocker = createServer();
    await new Promise<void>((resolve) => ipv4Blocker.listen(port, '127.0.0.1', () => resolve()));
    try {
      const promise = flow.authorize({ serverName: 'slack', clientId: 'c', asMetadata: fixtureAsMetadata(), redirectUri: pinned });
      // A hardcoded 127.0.0.1 bind would have rejected with EADDRINUSE instead.
      await vi.waitFor(() => expect(openUrl).toHaveBeenCalled());
      expect(capturedUrl.searchParams.get('redirect_uri')).toBe(pinned);
      const state = capturedUrl.searchParams.get('state');

      const res = await httpGet(`${pinned}?code=auth-code-1&state=${state}`);
      expect(res.status).toBe(200);
      await expect(promise).resolves.toMatchObject({ accessToken: 'at-1' });
    } finally {
      await new Promise<void>((resolve) => ipv4Blocker.close(() => resolve()));
    }
  });

  it('matches the callback on the path named in redirectUri, not a hardcoded /callback', async () => {
    const tokens: OAuthTokens = { access_token: 'at-1', token_type: 'bearer', expires_in: 3600 };
    sdkAuth.exchangeAuthorization.mockResolvedValue(tokens);
    const port = await freePort();
    const pinned = `http://127.0.0.1:${port}/oauth/cb`;
    const flow = new OAuthMcpFlow(fixtureTokenStore(), openUrl);

    const promise = flow.authorize({ serverName: 'slack', clientId: 'c', asMetadata: fixtureAsMetadata(), redirectUri: pinned });
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalled());
    expect(capturedUrl.searchParams.get('redirect_uri')).toBe(pinned);
    const state = capturedUrl.searchParams.get('state');

    // The old hardcoded path must no longer be the one that counts.
    const wrongPath = await httpGet(`http://127.0.0.1:${port}/callback?code=auth-code-1&state=${state}`);
    expect(wrongPath.status).toBe(404);

    const res = await httpGet(`${pinned}?code=auth-code-1&state=${state}`);
    expect(res.status).toBe(200);
    await expect(promise).resolves.toMatchObject({ accessToken: 'at-1' });
  });

  it('surfaces a clear error naming host and port when a pinned redirectUri cannot be bound', async () => {
    const flow = new OAuthMcpFlow(fixtureTokenStore(), openUrl);
    const port = await freePort();

    // Hold the port open so the flow's own listen() call fails with EADDRINUSE.
    const { createServer } = await import('http');
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', () => resolve()));
    try {
      await expect(
        flow.authorize({ serverName: 'slack', clientId: 'c', asMetadata: fixtureAsMetadata(), redirectUri: `http://127.0.0.1:${port}/callback` }),
      ).rejects.toThrow(new RegExp(`127\\.0\\.0\\.1:${port}.*already be in use`, 'i'));
      expect(openUrl).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('rejects an invalid redirectUri before opening any listener or consent screen', async () => {
    const flow = new OAuthMcpFlow(fixtureTokenStore(), openUrl);
    await expect(
      flow.authorize({ serverName: 'slack', clientId: 'c', asMetadata: fixtureAsMetadata(), redirectUri: 'http://evil.example.com:3118/callback' }),
    ).rejects.toThrow(/loopback/i);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('times out after 5 minutes of no callback and closes the listening socket', async () => {
    vi.useFakeTimers();
    try {
      const flow = new OAuthMcpFlow(fixtureTokenStore(), openUrl);
      const promise = flow.authorize({ serverName: 'vercel', clientId: 'client-123', asMetadata: fixtureAsMetadata() });
      await vi.waitFor(() => expect(openUrl).toHaveBeenCalled(), { timeout: 2000, interval: 10 });
      const redirectUri = capturedUrl.searchParams.get('redirect_uri')!;

      const rejection = expect(promise).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await rejection;

      // The callback server must be closed — a request to its port now fails outright.
      await expect(fetch(redirectUri)).rejects.toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);
});

describe('OAuthMcpFlow.refresh', () => {
  it('refreshes using the stored refresh token and client_id, and persists the result', async () => {
    const tokens: OAuthTokens = { access_token: 'at-2', refresh_token: 'rt-2', token_type: 'bearer', expires_in: 1800 };
    sdkAuth.refreshAuthorization.mockResolvedValue(tokens);
    const tokenStore = fixtureTokenStore({ clientId: 'client-123', currentTokens: { accessToken: 'at-1', refreshToken: 'rt-1' } });
    const flow = new OAuthMcpFlow(tokenStore, vi.fn());

    const result = await flow.refresh('vercel', fixtureAsMetadata());
    expect(result.accessToken).toBe('at-2');
    expect(sdkAuth.refreshAuthorization).toHaveBeenCalledWith('https://vercel.com', expect.objectContaining({
      refreshToken: 'rt-1', clientInformation: { client_id: 'client-123' },
    }));
    expect(tokenStore.store).toHaveBeenCalledWith('vercel', result);
  });

  /**
   * An AS that required the secret at the exchange also requires it here. A bare
   * refresh gets `invalid_client`, which surfaces to the user as a spontaneous
   * logout hours after a connection that looked fine.
   */
  it('re-sends the stored client_secret on refresh', async () => {
    sdkAuth.refreshAuthorization.mockResolvedValue({ access_token: 'at-2', refresh_token: 'rt-2', token_type: 'bearer', expires_in: 1800 });
    const tokenStore = fixtureTokenStore({
      clientId: 'client-123', clientSecret: 'shh-abc', currentTokens: { accessToken: 'at-1', refreshToken: 'rt-1' },
    });
    const flow = new OAuthMcpFlow(tokenStore, vi.fn());

    await flow.refresh('confidential', fixtureAsMetadata());
    expect(sdkAuth.refreshAuthorization).toHaveBeenCalledWith('https://vercel.com', expect.objectContaining({
      clientInformation: { client_id: 'client-123', client_secret: 'shh-abc' },
    }));
  });

  it('rejects without calling the AS when there is no refresh token on file', async () => {
    const tokenStore = fixtureTokenStore({ clientId: 'client-123', currentTokens: { accessToken: 'at-1' } });
    const flow = new OAuthMcpFlow(tokenStore, vi.fn());
    await expect(flow.refresh('vercel', fixtureAsMetadata())).rejects.toThrow(/refresh token/i);
    expect(sdkAuth.refreshAuthorization).not.toHaveBeenCalled();
  });

  it('rejects without calling the AS when there is no client_id on file', async () => {
    const tokenStore = fixtureTokenStore({ currentTokens: { accessToken: 'at-1', refreshToken: 'rt-1' } });
    const flow = new OAuthMcpFlow(tokenStore, vi.fn());
    await expect(flow.refresh('vercel', fixtureAsMetadata())).rejects.toThrow(/client_id/i);
    expect(sdkAuth.refreshAuthorization).not.toHaveBeenCalled();
  });
});

/**
 * RFC 8707 resource indicators.
 *
 * Motivated by a real failure: v0's MCP server (`https://v0.app/api/mcp`) rejects
 * any authorization request without `resource`, responding
 * `400 invalid_target — resource must be https://v0.app/api/mcp`. Omitting the
 * parameter made v0 impossible to connect at all. Vercel's server ignores it, so
 * the "no protected-resource metadata" path must stay byte-identical.
 */
describe('RFC 8707 resource indicator', () => {
  /** Shaped after v0's live `/.well-known/oauth-protected-resource` response. */
  function v0AsMetadata(resource = 'https://v0.app/api/mcp'): OAuthServerInfo {
    return fixtureAsMetadata({
      authorizationServerUrl: 'https://v0.app',
      authorizationServerMetadata: {
        issuer: 'https://v0.app',
        authorization_endpoint: 'https://v0.app/api/mcp/oauth/authorize',
        token_endpoint: 'https://v0.app/api/mcp/oauth/token',
        response_types_supported: ['code'],
      },
      resourceMetadata: { resource, authorization_servers: ['https://v0.app'] },
    });
  }

  it('resolves to the resource the server advertises, and to undefined when it advertises none', () => {
    expect(resourceIndicatorFor(v0AsMetadata())?.href).toBe('https://v0.app/api/mcp');
    expect(resourceIndicatorFor(fixtureAsMetadata())).toBeUndefined();
  });

  it('sends an identical resource on the authorization request and the token exchange', async () => {
    let capturedUrl = undefined as unknown as URL;
    const openUrl = vi.fn(async (url: string) => { capturedUrl = new URL(url); });
    sdkAuth.exchangeAuthorization.mockResolvedValue({ access_token: 'at-1', refresh_token: 'rt-1', token_type: 'bearer', expires_in: 3600 });
    const flow = new OAuthMcpFlow(fixtureTokenStore(), openUrl);

    const promise = flow.authorize({ serverName: 'v0', clientId: 'client-123', asMetadata: v0AsMetadata(), scopes: 'mcp' });
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalled());

    expect(capturedUrl.searchParams.get('resource')).toBe('https://v0.app/api/mcp');

    const redirectUri = capturedUrl.searchParams.get('redirect_uri')!;
    await httpGet(`${redirectUri}?code=auth-code-1&state=${capturedUrl.searchParams.get('state')}`);
    await promise;

    // RFC 8707 §2 requires the same value on both legs; a URL instance, per the SDK's signature.
    const exchanged = sdkAuth.exchangeAuthorization.mock.calls[0][1] as { resource?: URL };
    expect(exchanged.resource).toBeInstanceOf(URL);
    expect(exchanged.resource?.href).toBe('https://v0.app/api/mcp');
  });

  /**
   * Negative control. Without this, a regression that hardcoded some resource
   * value would still pass the assertions above while breaking every AS that
   * validates the parameter it never advertised.
   */
  it('omits resource entirely when the MCP server publishes no protected-resource metadata', async () => {
    let capturedUrl = undefined as unknown as URL;
    const openUrl = vi.fn(async (url: string) => { capturedUrl = new URL(url); });
    sdkAuth.exchangeAuthorization.mockResolvedValue({ access_token: 'at-1', refresh_token: 'rt-1', token_type: 'bearer', expires_in: 3600 });
    const flow = new OAuthMcpFlow(fixtureTokenStore(), openUrl);

    const promise = flow.authorize({ serverName: 'vercel', clientId: 'client-123', asMetadata: fixtureAsMetadata() });
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalled());

    expect(capturedUrl.searchParams.has('resource')).toBe(false);

    const redirectUri = capturedUrl.searchParams.get('redirect_uri')!;
    await httpGet(`${redirectUri}?code=auth-code-1&state=${capturedUrl.searchParams.get('state')}`);
    await promise;
    expect((sdkAuth.exchangeAuthorization.mock.calls[0][1] as { resource?: URL }).resource).toBeUndefined();
  });

  it('repeats the resource on refresh so the new access token keeps the same audience', async () => {
    sdkAuth.refreshAuthorization.mockResolvedValue({ access_token: 'at-2', refresh_token: 'rt-2', token_type: 'bearer', expires_in: 1800 });
    const tokenStore = fixtureTokenStore({ clientId: 'client-123', currentTokens: { accessToken: 'at-1', refreshToken: 'rt-1' } });
    const flow = new OAuthMcpFlow(tokenStore, vi.fn());

    await flow.refresh('v0', v0AsMetadata());
    const refreshed = sdkAuth.refreshAuthorization.mock.calls[0][1] as { resource?: URL };
    expect(refreshed.resource?.href).toBe('https://v0.app/api/mcp');
  });

  it('accepts protected-resource metadata whose resource covers the dialled server URL', async () => {
    sdkAuth.discoverOAuthServerInfo.mockResolvedValue(v0AsMetadata('https://v0.app/api'));
    const flow = new OAuthMcpFlow(fixtureTokenStore(), vi.fn());
    await expect(flow.discoverAS('https://v0.app/api/mcp')).resolves.toMatchObject({
      resourceMetadata: { resource: 'https://v0.app/api' },
    });
  });

  /**
   * Audience-confusion guard. Protected-resource metadata is server-controlled
   * input that names the audience our token gets minted for, so a `resource`
   * pointing somewhere unrelated must fail closed rather than mint a token an
   * unrelated origin could accept.
   */
  it('rejects protected-resource metadata naming an unrelated origin', async () => {
    sdkAuth.discoverOAuthServerInfo.mockResolvedValue(v0AsMetadata('https://evil.example.com/api/mcp'));
    const flow = new OAuthMcpFlow(fixtureTokenStore(), vi.fn());
    await expect(flow.discoverAS('https://v0.app/api/mcp')).rejects.toThrow(/different audience/i);
  });
});

describe('OAuthMcpFlow.revoke', () => {
  it('revokes both tokens at the AS revocation endpoint, then clears local state', async () => {
    const tokenStore = fixtureTokenStore({ clientId: 'client-123', currentTokens: { accessToken: 'at-1', refreshToken: 'rt-1' } });
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    const flow = new OAuthMcpFlow(tokenStore, vi.fn(), fetchFn as unknown as typeof fetch);

    await flow.revoke('vercel', fixtureAsMetadata());

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const bodies = fetchFn.mock.calls.map(([, init]) => (init as RequestInit).body as URLSearchParams);
    expect(bodies.some((b) => b.get('token') === 'rt-1' && b.get('token_type_hint') === 'refresh_token')).toBe(true);
    expect(bodies.some((b) => b.get('token') === 'at-1' && b.get('token_type_hint') === 'access_token')).toBe(true);
    expect(tokenStore.clear).toHaveBeenCalledWith('vercel');
  });

  /** RFC 7009 §2.1 — a confidential client authenticates to the revocation endpoint too. */
  it('authenticates the revocation calls with the stored client_secret', async () => {
    const tokenStore = fixtureTokenStore({
      clientId: 'client-123', clientSecret: 'shh-abc', currentTokens: { accessToken: 'at-1', refreshToken: 'rt-1' },
    });
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    const flow = new OAuthMcpFlow(tokenStore, vi.fn(), fetchFn as unknown as typeof fetch);

    await flow.revoke('confidential', fixtureAsMetadata());

    const bodies = fetchFn.mock.calls.map(([, init]) => (init as RequestInit).body as URLSearchParams);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.get('client_id')).toBe('client-123');
      expect(body.get('client_secret')).toBe('shh-abc');
    }
  });

  it('sends no client_secret key at all when revoking a public client', async () => {
    const tokenStore = fixtureTokenStore({ clientId: 'client-123', currentTokens: { accessToken: 'at-1', refreshToken: 'rt-1' } });
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    const flow = new OAuthMcpFlow(tokenStore, vi.fn(), fetchFn as unknown as typeof fetch);

    await flow.revoke('vercel', fixtureAsMetadata());

    for (const [, init] of fetchFn.mock.calls) {
      const body = (init as RequestInit).body as URLSearchParams;
      // An empty `client_secret=` would be a failed auth attempt, not no attempt.
      expect(body.has('client_secret')).toBe(false);
    }
  });

  it('still clears local state when the AS revocation call fails', async () => {
    const tokenStore = fixtureTokenStore({ clientId: 'client-123', currentTokens: { accessToken: 'at-1', refreshToken: 'rt-1' } });
    const fetchFn = vi.fn(async () => { throw new Error('network down'); });
    const flow = new OAuthMcpFlow(tokenStore, vi.fn(), fetchFn as unknown as typeof fetch);

    await flow.revoke('vercel', fixtureAsMetadata());
    expect(tokenStore.clear).toHaveBeenCalledWith('vercel');
  });

  it('skips revocation entirely when the AS has no revocation_endpoint, but still clears local state', async () => {
    const tokenStore = fixtureTokenStore({ clientId: 'client-123', currentTokens: { accessToken: 'at-1', refreshToken: 'rt-1' } });
    const fetchFn = vi.fn();
    const flow = new OAuthMcpFlow(tokenStore, vi.fn(), fetchFn as unknown as typeof fetch);

    const asMetadata = fixtureAsMetadata({
      authorizationServerMetadata: {
        issuer: 'https://vercel.com',
        authorization_endpoint: 'https://vercel.com/oauth/authorize',
        token_endpoint: 'https://vercel.com/oauth/token',
        response_types_supported: ['code'],
      },
    });
    await flow.revoke('vercel', asMetadata);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(tokenStore.clear).toHaveBeenCalledWith('vercel');
  });
});

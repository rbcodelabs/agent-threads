/**
 * Integration tests for the OAuth MCP broker: `OAuthMcpRegistry` composing the
 * REAL `OAuthMcpFlow` + `OAuthTokenStore` + `OAuthMcpProxy` classes against two
 * real local `http.createServer` instances — a mock Authorization Server (just
 * enough of RFC 9728 / RFC 8414 / RFC 7591 / RFC 6749 / RFC 7009 to drive the
 * real flow) and a mock upstream MCP server. Nothing internal is mocked; only
 * `SecretStorageLike` (an in-memory Map, standing in for the OS keychain) and
 * `openUrl` (a fake "browser" that performs the same GET → follow-redirect
 * round trip a real browser/webview would) are injected, per
 * `OAuthMcpRegistryHost`'s existing seams.
 *
 * See `test/unit/OAuthMcpFlow.test.ts`, `OAuthTokenStore.test.ts`,
 * `OAuthMcpProxy.test.ts`, and `OAuthMcpRegistry.test.ts` for the unit-level
 * coverage this complements — those mock every internal collaborator; this
 * file proves the real wiring between them actually works end to end,
 * including the RFC 8252 §7.3 portless-loopback-redirect concern flagged as a
 * known gap in `OAuthMcpRegistry.registerServer()`.
 */
import { createHash, randomBytes } from 'crypto';
import { createServer, get as httpGet, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';

import { OAuthMcpRegistry, type OAuthMcpRegistryHost } from '../../src/OAuthMcpRegistry';
import { OAuthTokenStore, type SecretStorageLike } from '../../src/OAuthTokenStore';
import type { OAuthMcpState, StoredOAuthMcpServer } from '../../src/types';

// ── Wire-level helpers ──────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function httpGetNoRedirect(urlString: string): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpGet(urlString, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });
}

function sameLoopbackRedirect(a: string, b: string): boolean {
  const ua = new URL(a);
  const ub = new URL(b);
  return ua.protocol === ub.protocol && ua.hostname === ub.hostname && ua.pathname === ub.pathname;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The response the plugin's local callback server served on the most recent
 * consent round-trip. Captured so tests can assert on the page a real user sees
 * (see the charset regression test) rather than only on the flow's return value.
 */
let lastCallbackResponse: Awaited<ReturnType<typeof httpGetNoRedirect>> | undefined;

/**
 * Stands in for a real browser/webview completing the OAuth consent redirect
 * dance: GETs the authorization URL (expecting a 302), then GETs whatever
 * `Location` it was handed — which is the REAL local callback server
 * `OAuthMcpFlow.authorize()` started. This is what actually proves the
 * redirect_uri round-trip works, not a mock of it.
 */
async function simulateBrowserConsent(authorizationUrl: string, opts: { deny?: boolean } = {}): Promise<void> {
  const target = new URL(authorizationUrl);
  if (opts.deny) target.searchParams.set('deny', '1');
  const first = await httpGetNoRedirect(target.toString());
  if (first.status < 300 || first.status >= 400 || !first.headers.location) {
    throw new Error(`Mock AS /authorize did not redirect as expected (status ${first.status}): ${first.body}`);
  }
  lastCallbackResponse = await httpGetNoRedirect(first.headers.location);
}

// ── Mock Authorization Server ───────────────────────────────────────────────

interface CodeRecord {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
}

interface TokenRecord {
  clientId: string;
  refreshToken?: string;
  expiresAt: number;
}

interface RevocationRecord {
  token: string;
  tokenTypeHint?: string;
  clientId?: string;
}

/** Just enough of RFC 8414/7591/6749/7009 to drive the real `OAuthMcpFlow`. */
class MockAuthorizationServer {
  private server?: Server;
  port = 0;

  /** Test-controlled knobs. */
  expiresInSeconds = 3600;
  includeRevocationEndpoint = true;
  omitRefreshToken = false;
  failNextRefresh = false;
  forceUnauthorizedOnce = false;
  /**
   * Confidential-client mode. RFC 7591 §3.2.1 lets an AS answer a DCR request
   * with a `client_secret` even when the request asked for
   * `token_endpoint_auth_method: 'none'` — which this plugin always does — and
   * some deployments then *require* that secret at the token endpoint. Turning
   * both knobs on models such a server: /register issues a secret, and /token
   * and /revoke reject any call that fails to present it.
   */
  issueClientSecretOnRegister = false;
  requireClientSecret = false;

  /** Inspection state for assertions. */
  registerLog: Array<{ clientId: string; redirectUris: string[] }> = [];
  authorizeLog: Array<{ clientId: string; redirectUri: string; audience?: string; resource?: string }> = [];
  revocations: RevocationRecord[] = [];
  tokenEndpointHits = 0;
  refreshGrantHits = 0;
  clientCredentialsGrantHits = 0;
  /** What each client_credentials token request carried, for wire assertions. */
  clientCredentialsLog: Array<{ clientId: string; audience?: string; scope?: string; resource?: string; interactiveParams: string[] }> = [];
  /** Client secrets issued by /register, keyed by client_id. */
  issuedClientSecrets = new Map<string, string>();
  /** How each authenticated request presented its secret, for assertions. */
  clientAuthLog: Array<{ endpoint: 'token' | 'revoke'; method: 'basic' | 'post' | 'none'; clientId: string; secretMatched: boolean }> = [];

  private codes = new Map<string, CodeRecord>();
  private tokens = new Map<string, TokenRecord>();
  private refreshTokens = new Map<string, string>();

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => { void this.handle(req, res); });
      this.server = server;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  isValidAccessToken(token: string): boolean {
    const record = this.tokens.get(token);
    return !!record && record.expiresAt > Date.now();
  }

  private issueTokens(clientId: string): { access_token: string; refresh_token?: string; expires_in: number; token_type: string } {
    const accessToken = `at_${randomBytes(12).toString('hex')}`;
    const refreshToken = this.omitRefreshToken ? undefined : `rt_${randomBytes(12).toString('hex')}`;
    const expiresAt = Date.now() + this.expiresInSeconds * 1000;
    this.tokens.set(accessToken, { clientId, refreshToken, expiresAt });
    if (refreshToken) this.refreshTokens.set(refreshToken, accessToken);
    return { access_token: accessToken, refresh_token: refreshToken, expires_in: this.expiresInSeconds, token_type: 'Bearer' };
  }

  private replyJson(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.baseUrl);
    try {
      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
        this.replyJson(res, 200, {
          issuer: this.baseUrl,
          authorization_endpoint: `${this.baseUrl}/authorize`,
          token_endpoint: `${this.baseUrl}/token`,
          registration_endpoint: `${this.baseUrl}/register`,
          ...(this.includeRevocationEndpoint ? { revocation_endpoint: `${this.baseUrl}/revoke` } : {}),
          // Advertised only in confidential mode; when absent the SDK defaults to
          // client_secret_basic for a client that has a secret (RFC 8414 §2).
          ...(this.requireClientSecret ? { token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'] } : {}),
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/authorize') {
        this.handleAuthorize(url, res);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/register') {
        await this.handleRegister(req, res);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        await this.handleToken(req, res);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/revoke') {
        await this.handleRevoke(req, res);
        return;
      }
      this.replyJson(res, 404, { error: 'not_found' });
    } catch (err) {
      this.replyJson(res, 500, { error: 'server_error', error_description: err instanceof Error ? err.message : String(err) });
    }
  }

  private handleAuthorize(url: URL, res: ServerResponse): void {
    const clientId = url.searchParams.get('client_id') ?? '';
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const codeChallenge = url.searchParams.get('code_challenge') ?? '';
    const codeChallengeMethod = url.searchParams.get('code_challenge_method');
    const state = url.searchParams.get('state') ?? '';
    const deny = url.searchParams.get('deny');

    if (!redirectUri) { this.replyJson(res, 400, { error: 'invalid_request', error_description: 'missing redirect_uri' }); return; }
    const redirect = new URL(redirectUri);

    if (deny) {
      redirect.searchParams.set('error', 'access_denied');
      redirect.searchParams.set('state', state);
      res.writeHead(302, { Location: redirect.toString() });
      res.end();
      return;
    }
    if (!clientId || !codeChallenge || codeChallengeMethod !== 'S256') {
      this.replyJson(res, 400, { error: 'invalid_request' });
      return;
    }

    const code = `code_${randomBytes(12).toString('hex')}`;
    this.codes.set(code, { clientId, codeChallenge, redirectUri });
    this.authorizeLog.push({
      clientId,
      redirectUri,
      audience: url.searchParams.get('audience') ?? undefined,
      resource: url.searchParams.get('resource') ?? undefined,
    });
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', state);
    res.writeHead(302, { Location: redirect.toString() });
    res.end();
  }

  private async handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = (await readBody(req)).toString('utf8');
    const body: { redirect_uris?: string[]; [key: string]: unknown } = raw ? JSON.parse(raw) : {};
    const clientId = `client_${randomBytes(8).toString('hex')}`;
    this.registerLog.push({ clientId, redirectUris: body.redirect_uris ?? [] });
    let clientSecret: string | undefined;
    if (this.issueClientSecretOnRegister) {
      clientSecret = `secret_${randomBytes(12).toString('hex')}`;
      this.issuedClientSecrets.set(clientId, clientSecret);
    }
    this.replyJson(res, 201, {
      ...body,
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * RFC 6749 §2.3.1 client authentication, accepting either HTTP Basic or a
   * `client_secret` form field. Returns false when confidential mode is on and
   * the caller presented no secret or the wrong one — the real `invalid_client`
   * that a dropped secret produces.
   */
  private authenticateClient(req: IncomingMessage, params: URLSearchParams, endpoint: 'token' | 'revoke'): boolean {
    const authHeader = req.headers.authorization ?? '';
    let method: 'basic' | 'post' | 'none' = 'none';
    let clientId = params.get('client_id') ?? '';
    let presented: string | undefined;
    if (authHeader.startsWith('Basic ')) {
      method = 'basic';
      const [id, secret] = Buffer.from(authHeader.slice('Basic '.length), 'base64').toString('utf8').split(':');
      // RFC 6749 §2.3.1 mandates form-urlencoding the two halves before Basic.
      clientId = decodeURIComponent(id ?? '');
      presented = decodeURIComponent(secret ?? '');
    } else if (params.get('client_secret')) {
      method = 'post';
      presented = params.get('client_secret') ?? undefined;
    }
    const expected = this.issuedClientSecrets.get(clientId);
    const secretMatched = presented !== undefined && presented === expected;
    this.clientAuthLog.push({ endpoint, method, clientId, secretMatched });
    return !this.requireClientSecret || secretMatched;
  }

  private async handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.tokenEndpointHits++;
    const raw = (await readBody(req)).toString('utf8');
    const params = new URLSearchParams(raw);
    const grantType = params.get('grant_type');

    if (!this.authenticateClient(req, params, 'token')) {
      this.replyJson(res, 401, { error: 'invalid_client', error_description: 'Client authentication failed.' });
      return;
    }

    if (grantType === 'authorization_code') {
      const code = params.get('code') ?? '';
      const verifier = params.get('code_verifier') ?? '';
      const redirectUri = params.get('redirect_uri') ?? '';
      const record = this.codes.get(code);
      if (!record) { this.replyJson(res, 400, { error: 'invalid_grant', error_description: 'Unknown or already-used code.' }); return; }
      this.codes.delete(code); // single-use
      const computedChallenge = createHash('sha256').update(verifier).digest('base64url');
      if (computedChallenge !== record.codeChallenge) { this.replyJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed.' }); return; }
      // RFC 8252 §7.3: loopback redirect_uris are validated ignoring port, matching a
      // conformant AS. This is the exact concern flagged in OAuthMcpRegistry — DCR
      // registers a portless URI, the live authorize()/token exchange use a real one.
      if (!sameLoopbackRedirect(redirectUri, record.redirectUri)) {
        this.replyJson(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch.' });
        return;
      }
      this.replyJson(res, 200, this.issueTokens(record.clientId));
      return;
    }

    if (grantType === 'refresh_token') {
      this.refreshGrantHits++;
      if (this.failNextRefresh) {
        this.failNextRefresh = false;
        this.replyJson(res, 400, { error: 'invalid_grant', error_description: 'Simulated refresh failure.' });
        return;
      }
      if (this.forceUnauthorizedOnce) {
        // Only meaningful when the caller wants the *refresh* itself to fail once; the
        // 401-retry tests instead toggle this on the mock upstream, not here.
        this.forceUnauthorizedOnce = false;
      }
      const refreshToken = params.get('refresh_token') ?? '';
      const oldAccessToken = this.refreshTokens.get(refreshToken);
      const oldRecord = oldAccessToken ? this.tokens.get(oldAccessToken) : undefined;
      if (!oldRecord) { this.replyJson(res, 400, { error: 'invalid_grant', error_description: 'Unknown refresh token.' }); return; }
      if (oldAccessToken) this.tokens.delete(oldAccessToken);
      this.refreshTokens.delete(refreshToken);
      this.replyJson(res, 200, this.issueTokens(oldRecord.clientId));
      return;
    }

    /**
     * RFC 6749 §4.4. No code, no PKCE, no redirect_uri — the client authenticates
     * as itself and gets a token. §4.4.3: "A refresh token SHOULD NOT be
     * included", so this arm never issues one even when `omitRefreshToken` is off.
     */
    if (grantType === 'client_credentials') {
      this.clientCredentialsGrantHits++;
      const clientId = this.clientIdFromRequest(req, params);
      this.clientCredentialsLog.push({
        clientId,
        audience: params.get('audience') ?? undefined,
        scope: params.get('scope') ?? undefined,
        resource: params.get('resource') ?? undefined,
        interactiveParams: ['code', 'code_verifier', 'code_challenge', 'redirect_uri', 'state'].filter((p) => params.has(p)),
      });
      const accessToken = `at_${randomBytes(12).toString('hex')}`;
      this.tokens.set(accessToken, { clientId, refreshToken: undefined, expiresAt: Date.now() + this.expiresInSeconds * 1000 });
      this.replyJson(res, 200, { access_token: accessToken, expires_in: this.expiresInSeconds, token_type: 'Bearer' });
      return;
    }

    this.replyJson(res, 400, { error: 'unsupported_grant_type' });
  }

  /** The client id may arrive in the Basic header or the form body, per RFC 6749 §2.3.1. */
  private clientIdFromRequest(req: IncomingMessage, params: URLSearchParams): string {
    const authHeader = req.headers.authorization ?? '';
    if (authHeader.startsWith('Basic ')) {
      const [id] = Buffer.from(authHeader.slice('Basic '.length), 'base64').toString('utf8').split(':');
      return decodeURIComponent(id ?? '');
    }
    return params.get('client_id') ?? '';
  }

  private async handleRevoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = (await readBody(req)).toString('utf8');
    const params = new URLSearchParams(raw);
    if (!this.authenticateClient(req, params, 'revoke')) {
      this.replyJson(res, 401, { error: 'invalid_client', error_description: 'Client authentication failed.' });
      return;
    }
    this.revocations.push({
      token: params.get('token') ?? '',
      tokenTypeHint: params.get('token_type_hint') ?? undefined,
      clientId: params.get('client_id') ?? undefined,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  }
}

// ── Mock upstream MCP server ────────────────────────────────────────────────

/** Minimal JSON-RPC MCP server: bearer-token gated, fixed tool list, one SSE method. */
class MockUpstreamMcpServer {
  private server?: Server;
  port = 0;
  forceUnauthorizedOnce = false;
  toolCallLog: string[] = [];

  constructor(private readonly authorizationServerBaseUrl: string, private readonly isValidToken: (token: string) => boolean) {}

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => { void this.handle(req, res); });
      this.server = server;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.baseUrl);

    // RFC 9728 protected-resource discovery, so a caller with no `authorizationServerUrl`
    // override still discovers the mock AS the same way a real MCP resource server would
    // advertise it.
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ resource: this.baseUrl, authorization_servers: [this.authorizationServerBaseUrl] }));
      return;
    }

    const body = await readBody(req);
    const parsed: { jsonrpc?: string; id?: unknown; method?: string; params?: { name?: string } } | undefined =
      body.length ? JSON.parse(body.toString('utf8')) : undefined;

    if (this.forceUnauthorizedOnce) {
      this.forceUnauthorizedOnce = false;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed?.id, error: { code: -32001, message: 'unauthorized' } }));
      return;
    }

    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
    if (!token || !this.isValidToken(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed?.id, error: { code: -32001, message: 'unauthorized' } }));
      return;
    }

    if (parsed?.method === 'tools/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0', id: parsed.id,
        result: { tools: [{ name: 'allowed_tool' }, { name: 'denied_tool' }, { name: 'stream_tool' }] },
      }));
      return;
    }

    if (parsed?.method === 'tools/call') {
      const name = parsed.params?.name ?? '';
      this.toolCallLog.push(name);
      if (name === 'stream_tool') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: message\n');
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { streamed: true } })}\n\n`);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: true, tool: name } }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed?.id, error: { code: -32601, message: 'Unknown method' } }));
  }
}

// ── Test harness plumbing ───────────────────────────────────────────────────

function fakeSecretStorage(): { secretStorage: SecretStorageLike; raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    secretStorage: {
      setSecret: (id: string, secret: string) => { raw.set(id, secret); },
      getSecret: (id: string) => raw.get(id) ?? null,
    },
  };
}

function makeHost(openUrl: (url: string) => Promise<unknown>): {
  host: OAuthMcpRegistryHost;
  settings: { oauthMcpServers: Record<string, StoredOAuthMcpServer>; oauthMcpState: Record<string, OAuthMcpState> };
  secretStorage: SecretStorageLike;
  raw: Map<string, string>;
} {
  const { secretStorage, raw } = fakeSecretStorage();
  const settings: { oauthMcpServers: Record<string, StoredOAuthMcpServer>; oauthMcpState: Record<string, OAuthMcpState> } = {
    oauthMcpServers: {},
    oauthMcpState: {},
  };
  return {
    // `fetchFn` is injected explicitly rather than left to the production
    // default. These tests drive a real local mock AS over 127.0.0.1 from Node,
    // where global fetch works fine; the production default is the
    // requestUrl-backed adapter, because the renderer's `file://` origin cannot
    // fetch cross-origin at all.
    //
    // Be clear about what that means for this file's coverage: everything below
    // exercises the broker's *protocol* behavior and nothing about its
    // *transport* in the real app. This suite was fully green while the feature
    // was completely non-functional in Geode. The transport is covered by
    // test/unit/requestUrlFetch.test.ts and by the fetchFn-plumbing guard in
    // test/unit/OAuthMcpFlow.test.ts.
    host: { getSettings: () => settings, save: async () => {}, secretStorage, openUrl, fetchFn: fetch },
    settings,
    secretStorage,
    raw,
  };
}

async function callProxy(config: { url: string; headers: Record<string, string> }, payload: unknown): Promise<Response> {
  return fetch(config.url, {
    method: 'POST',
    headers: { ...config.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// Every server/registry a test starts is torn down here — registries first (so
// `disconnect()` gets a chance to hit `/revoke` while the mock AS is still up
// and to clear background refresh timers), then the raw HTTP servers.
const activeRegistrations: Array<{ registry: OAuthMcpRegistry; name: string }> = [];
const activeRegistries: OAuthMcpRegistry[] = [];
const activeAsServers: MockAuthorizationServer[] = [];
const activeUpstreams: MockUpstreamMcpServer[] = [];

afterEach(async () => {
  for (const { registry, name } of activeRegistrations.splice(0)) {
    await registry.disconnect(name).catch(() => {});
  }
  for (const registry of activeRegistries.splice(0)) registry.close();
  await Promise.all(activeUpstreams.splice(0).map((s) => s.stop()));
  await Promise.all(activeAsServers.splice(0).map((s) => s.stop()));
});

/** Spins up a fresh mock AS + mock upstream pair, wired together via RFC 9728 discovery. */
async function setupServers(): Promise<{ as: MockAuthorizationServer; upstream: MockUpstreamMcpServer }> {
  const as = new MockAuthorizationServer();
  await as.start();
  activeAsServers.push(as);
  const upstream = new MockUpstreamMcpServer(as.baseUrl, (token) => as.isValidAccessToken(token));
  await upstream.start();
  activeUpstreams.push(upstream);
  return { as, upstream };
}

function registry(openUrl: (url: string) => Promise<unknown> = (url) => simulateBrowserConsent(url)): {
  registry: OAuthMcpRegistry;
  settings: ReturnType<typeof makeHost>['settings'];
  host: OAuthMcpRegistryHost;
  raw: Map<string, string>;
} {
  const { host, settings, raw } = makeHost(openUrl);
  const r = new OAuthMcpRegistry(host);
  activeRegistries.push(r);
  return { registry: r, settings, host, raw };
}

// ── Scenario 1: full flow ───────────────────────────────────────────────────

describe('OAuth MCP broker integration — full registration flow', () => {
  /**
   * The callback page is the only UI this plugin serves over HTTP, and it is
   * the last thing a user sees before returning to the app.
   *
   * Regression: it was sent as `text/html` with no charset and no
   * `<meta charset>`, so browsers decoded the UTF-8 body as Latin-1 and the em
   * dash in the success copy rendered as `\u00e2\u0080\u0094`. Asserting the
   * declared charset is the durable guard; asserting on the decoded text alone
   * would pass here regardless, because this test reads the body as UTF-8.
   */
  it('serves the consent callback page as UTF-8 so non-ASCII copy is not mojibaked', async () => {
    const { as, upstream } = await setupServers();
    const { registry: reg } = registry();
    lastCallbackResponse = undefined;

    const result = await reg.registerServer({ name: 'vercel', url: upstream.baseUrl, authorizationServerUrl: as.baseUrl });
    expect(result.success).toBe(true);

    // registerServer resolves from inside the callback handler via finish(),
    // which can beat the simulated browser finishing its read of that response.
    for (let i = 0; i < 100 && !lastCallbackResponse; i++) await delay(10);

    const callback = lastCallbackResponse;
    expect(callback).toBeDefined();
    expect(String(callback!.headers['content-type'])).toMatch(/charset=utf-8/i);
    expect(callback!.body).toContain('<meta charset="utf-8">');
    expect(callback!.body).toContain('Authorization complete');
    // The bytes a mis-declared page would have produced must not appear.
    expect(callback!.body).not.toContain('\u00e2\u0080\u0094');
  });

  it('discovers, DCRs, completes PKCE consent over a real redirect round-trip, and proxies tools/list', async () => {
    const { as, upstream } = await setupServers();
    const { registry: reg, settings } = registry();

    const result = await reg.registerServer({ name: 'vercel', url: upstream.baseUrl });
    if (result.success) activeRegistrations.push({ registry: reg, name: 'vercel' });

    expect(result).toMatchObject({ success: true, status: 'registered' });
    expect(settings.oauthMcpServers.vercel).toMatchObject({ url: upstream.baseUrl });
    expect(settings.oauthMcpState.vercel).toMatchObject({ status: 'connected', hasRefreshToken: true });

    // RFC 8252 §7.3 concern: DCR registered a portless redirect_uri, but the live
    // authorize()/token round trip used a real ephemeral port. The mock AS (correctly,
    // per §7.3) validated the live request against itself rather than against what
    // was registered, and the round trip still succeeded.
    expect(as.registerLog).toHaveLength(1);
    expect(as.registerLog[0].redirectUris).toEqual(['http://127.0.0.1/callback']);
    expect(as.authorizeLog).toHaveLength(1);
    expect(new URL(as.authorizeLog[0].redirectUri).port).not.toBe('');
    expect(as.authorizeLog[0].redirectUri).not.toBe(as.registerLog[0].redirectUris[0]);

    const config = reg.serversForThread('thread-1').vercel as { url: string; headers: Record<string, string> };
    const res = await callProxy(config, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.result.tools.map((t: { name: string }) => t.name)).toEqual(['allowed_tool', 'denied_tool', 'stream_tool']);
  });

  /**
   * `audience` has no grant-type restriction in `mcpRegistrationSchema` (see
   * `OAuthMcpRegistry.registerServer`'s comment on the same rule for
   * `client_credentials`), so it must reach the interactive `authorize()` leg
   * end to end, not just `clientCredentials()`'s token request — asserted at
   * the unit level in `OAuthMcpFlow.test.ts`; this proves the real wiring
   * through `OAuthMcpRegistry.registerServer()` and onto the wire.
   */
  it('wires a configured audience through the interactive authorization_code flow onto the wire', async () => {
    const { as, upstream } = await setupServers();
    const { registry: reg, settings } = registry();

    const result = await reg.registerServer({ name: 'bankrate', url: upstream.baseUrl, audience: 'bankrate-api' });
    if (result.success) activeRegistrations.push({ registry: reg, name: 'bankrate' });

    expect(result).toMatchObject({ success: true, status: 'registered' });
    expect(as.authorizeLog).toHaveLength(1);
    expect(as.authorizeLog[0].audience).toBe('bankrate-api');
    // Persisted so a later reconnect/re-register reproduces the same grant.
    expect(settings.oauthMcpServers.bankrate).toMatchObject({ audience: 'bankrate-api' });
  });

  // End-to-end shape of the reported bug: OAuth completes, the first tool call
  // works, then every later one dies with "Invalid or missing capability
  // token." A resumed session keeps posting the config it was spawned with, so
  // the turn-1 config has to survive later serversForThread() calls.
  it('keeps a running session authorized across later turns', async () => {
    const { upstream } = await setupServers();
    const { registry: reg } = registry();

    const result = await reg.registerServer({ name: 'vercel', url: upstream.baseUrl });
    if (result.success) activeRegistrations.push({ registry: reg, name: 'vercel' });
    expect(result.success).toBe(true);

    // Turn 1: the session is spawned with this config and holds onto it.
    const sessionConfig = reg.serversForThread('thread-1').vercel as { url: string; headers: Record<string, string> };
    expect((await callProxy(sessionConfig, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);

    // Turns 2 and 3 rebuild options for the same thread; the live session is
    // never handed the new config, so it goes on using sessionConfig.
    reg.serversForThread('thread-1');
    reg.serversForThread('thread-1');

    const later = await callProxy(sessionConfig, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(later.status).toBe(200);
    expect((await later.json()).result).toBeDefined();
  });

  it('streams an SSE tools/call response through the proxy without buffering', async () => {
    const { upstream } = await setupServers();
    const { registry: reg } = registry();

    const result = await reg.registerServer({ name: 'vercel', url: upstream.baseUrl });
    if (result.success) activeRegistrations.push({ registry: reg, name: 'vercel' });
    expect(result.success).toBe(true);

    const config = reg.serversForThread('thread-1').vercel as { url: string; headers: Record<string, string> };
    const res = await callProxy(config, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'stream_tool' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toContain('"streamed":true');
  });
});

// ── Scenario 2: tool filtering end to end ───────────────────────────────────

describe('OAuth MCP broker integration — tool filtering', () => {
  it('hides a denied tool from tools/list and blocks tools/call for it, without ever reaching upstream', async () => {
    const { upstream } = await setupServers();
    const { registry: reg } = registry();

    const result = await reg.registerServer({ name: 'vercel', url: upstream.baseUrl, tools: { deny: ['denied_tool'] } });
    if (result.success) activeRegistrations.push({ registry: reg, name: 'vercel' });
    expect(result.success).toBe(true);

    const config = reg.serversForThread('thread-1').vercel as { url: string; headers: Record<string, string> };

    const listRes = await callProxy(config, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const listPayload = await listRes.json();
    expect(listPayload.result.tools.map((t: { name: string }) => t.name)).toEqual(['allowed_tool', 'stream_tool']);

    const deniedRes = await callProxy(config, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'denied_tool' } });
    expect(deniedRes.status).toBe(200);
    const deniedPayload = await deniedRes.json();
    expect(deniedPayload).toMatchObject({ jsonrpc: '2.0', id: 2, error: { code: -32601 } });
    expect(upstream.toolCallLog).not.toContain('denied_tool');

    const allowedRes = await callProxy(config, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'allowed_tool' } });
    const allowedPayload = await allowedRes.json();
    expect(allowedPayload).toMatchObject({ result: { ok: true, tool: 'allowed_tool' } });
    expect(upstream.toolCallLog).toContain('allowed_tool');
  });
});

// ── Scenario 3: refresh transparency ────────────────────────────────────────

describe('OAuth MCP broker integration — refresh transparency', () => {
  it('proactively refreshes a token that is already expired by clock time, transparently to the caller', async () => {
    const { as, upstream } = await setupServers();
    as.expiresInSeconds = 2;
    const { registry: reg } = registry();

    const result = await reg.registerServer({ name: 'vercel', url: upstream.baseUrl });
    if (result.success) activeRegistrations.push({ registry: reg, name: 'vercel' });
    expect(result.success).toBe(true);

    // Real wait past the token's real (short) lifetime — no fake timers.
    await delay(2300);

    const config = reg.serversForThread('thread-1').vercel as { url: string; headers: Record<string, string> };
    const res = await callProxy(config, { jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: { tools: expect.any(Array) } });
    // The store's own 5-minute proactive-refresh window is wider than this token's
    // 2-second lifetime, so a background refresh (scheduleRefresh) or the on-demand
    // check in getAccessToken() — or both — will have hit the AS's refresh grant by now.
    expect(as.refreshGrantHits).toBeGreaterThanOrEqual(1);
  }, 10_000);

  it('transparently refreshes after the upstream itself returns 401 first', async () => {
    const { as, upstream } = await setupServers();
    // Long-lived token: keeps the store's own proactive-refresh window from firing,
    // so the only refresh in this test is the proxy's explicit 401-retry path.
    as.expiresInSeconds = 3600;
    const { registry: reg } = registry();

    const result = await reg.registerServer({ name: 'vercel', url: upstream.baseUrl });
    if (result.success) activeRegistrations.push({ registry: reg, name: 'vercel' });
    expect(result.success).toBe(true);
    expect(as.refreshGrantHits).toBe(0);

    upstream.forceUnauthorizedOnce = true;
    const config = reg.serversForThread('thread-1').vercel as { url: string; headers: Record<string, string> };
    const res = await callProxy(config, { jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: { tools: expect.any(Array) } });
    expect(as.refreshGrantHits).toBe(1);
    expect(upstream.forceUnauthorizedOnce).toBe(false);
  });
});

// ── Scenario 4 & 6: revocation ───────────────────────────────────────────────

describe('OAuth MCP broker integration — revocation on disconnect', () => {
  it('revokes both tokens with the real AS, clears the keychain, and stops the proxy', async () => {
    const { as, upstream } = await setupServers();
    const { registry: reg, settings, host } = registry();

    const result = await reg.registerServer({ name: 'vercel', url: upstream.baseUrl });
    expect(result.success).toBe(true);
    const config = reg.serversForThread('thread-1').vercel as { url: string; headers: Record<string, string> };
    expect((await callProxy(config, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);

    await reg.disconnect('vercel');

    expect(as.revocations.map((r) => r.tokenTypeHint).sort()).toEqual(['access_token', 'refresh_token']);
    expect(settings.oauthMcpServers.vercel).toBeUndefined();
    expect(settings.oauthMcpState.vercel).toBeUndefined();

    const probe = new OAuthTokenStore(host.secretStorage, () => Promise.reject(new Error('no refresh')));
    expect(probe.getClientId('vercel')).toBeUndefined();
    expect(probe.getCurrentTokens('vercel')).toBeUndefined();

    await expect(callProxy(config, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).rejects.toThrow();
  });

  it('clears local state without erroring when the AS has no revocation_endpoint', async () => {
    const { as, upstream } = await setupServers();
    as.includeRevocationEndpoint = false;
    const { registry: reg, settings, host } = registry();

    const result = await reg.registerServer({ name: 'vercel', url: upstream.baseUrl });
    expect(result.success).toBe(true);

    await expect(reg.disconnect('vercel')).resolves.toBeUndefined();

    expect(as.revocations).toHaveLength(0);
    expect(settings.oauthMcpServers.vercel).toBeUndefined();
    expect(settings.oauthMcpState.vercel).toBeUndefined();
    const probe = new OAuthTokenStore(host.secretStorage, () => Promise.reject(new Error('no refresh')));
    expect(probe.getCurrentTokens('vercel')).toBeUndefined();
  });
});

// ── Scenario 5: denied consent ───────────────────────────────────────────────

describe('OAuth MCP broker integration — denied consent', () => {
  it('leaves no partial settings or keychain state when the user denies consent', async () => {
    const { upstream } = await setupServers();
    const { registry: reg, settings, host } = registry((url) => simulateBrowserConsent(url, { deny: true }));

    const result = await reg.registerServer({ name: 'vercel', url: upstream.baseUrl });

    expect(result).toMatchObject({ success: false, status: 'cancelled' });
    expect(settings.oauthMcpServers.vercel).toBeUndefined();
    expect(settings.oauthMcpState.vercel).toBeUndefined();
    const probe = new OAuthTokenStore(host.secretStorage, () => Promise.reject(new Error('no refresh')));
    expect(probe.getClientId('vercel')).toBeUndefined();
    expect(probe.getCurrentTokens('vercel')).toBeUndefined();
    expect(reg.serversForThread('thread-1')).toEqual({});
  });
});

// ── Scenario 7: refresh token absent + expiry ───────────────────────────────

describe('OAuth MCP broker integration — refresh token absent', () => {
  it('marks the server needs-auth on the next configure() rebuild once its only token expires', async () => {
    const { as, upstream } = await setupServers();
    as.expiresInSeconds = 2;
    as.omitRefreshToken = true;
    const { registry: reg, settings, host } = registry();

    const result = await reg.registerServer({ name: 'vercel', url: upstream.baseUrl });
    expect(result.success).toBe(true);
    expect(settings.oauthMcpState.vercel).toMatchObject({ status: 'connected', hasRefreshToken: false });

    await delay(2300);

    // Simulate a plugin restart: a fresh OAuthMcpRegistry over the same settings/keychain.
    const restarted = new OAuthMcpRegistry(host);
    activeRegistries.push(restarted);
    await restarted.configure();

    expect(settings.oauthMcpState.vercel).toMatchObject({ status: 'needs-auth' });
  }, 10_000);
});

// ── Scenario 9: confidential client ─────────────────────────────────────────

/**
 * An AS that hands out a `client_secret` at DCR and then requires it on every
 * token-endpoint call. Before confidential-client support, `registerClient()`
 * dropped the secret and this server answered the code exchange with
 * `401 invalid_client` — indistinguishable, from the UI, from a denied consent.
 */
describe('OAuth MCP broker integration — confidential client', () => {
  it('completes the whole flow against an AS that issues a client_secret at DCR and requires it thereafter', async () => {
    const { as, upstream } = await setupServers();
    as.issueClientSecretOnRegister = true;
    as.requireClientSecret = true;
    const { registry: reg, settings, host, raw } = registry();

    const result = await reg.registerServer({ name: 'vercel', url: upstream.baseUrl });
    expect(result).toMatchObject({ success: true, status: 'registered' });

    const issuedSecret = [...as.issuedClientSecrets.values()][0];
    expect(issuedSecret).toBeTruthy();

    // The code exchange authenticated — the mock would have 401'd otherwise.
    // Which of the two RFC 6749 §2.3.1 forms the SDK picks is its business (it
    // negotiates from `token_endpoint_auth_methods_supported`), so assert only
    // that it authenticated with a real form and the secret matched.
    const exchangeAuth = as.clientAuthLog.filter((entry) => entry.endpoint === 'token');
    expect(exchangeAuth).toHaveLength(1);
    expect(exchangeAuth[0].secretMatched).toBe(true);
    expect(['basic', 'post']).toContain(exchangeAuth[0].method);

    // Custody: keychain yes, data.json no.
    const probe = new OAuthTokenStore(host.secretStorage, () => Promise.reject(new Error('no refresh')));
    expect(probe.getClientSecret('vercel')).toBe(issuedSecret);
    expect(settings.oauthMcpServers.vercel).toMatchObject({ hasClientSecret: true });
    expect(JSON.stringify(settings)).not.toContain(issuedSecret);
    // ...and it is in the keychain under this server's own namespaced key.
    expect([...raw.values()]).toContain(issuedSecret);

    // Tool calls work through the proxy.
    const config = reg.serversForThread('thread-1').vercel as { url: string; headers: Record<string, string> };
    expect((await callProxy(config, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);

    // A refresh must re-authenticate: an AS that required the secret at the
    // exchange rejects a bare refresh, which surfaces as a spontaneous logout.
    upstream.forceUnauthorizedOnce = true;
    expect((await callProxy(config, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status).toBe(200);
    expect(as.refreshGrantHits).toBe(1);
    expect(as.clientAuthLog.filter((e) => e.endpoint === 'token')).toHaveLength(2);
    expect(as.clientAuthLog.filter((e) => e.endpoint === 'token').every((e) => e.secretMatched)).toBe(true);

    // RFC 7009 §2.1 — revocation authenticates too, and disconnect wipes the secret.
    await reg.disconnect('vercel');
    expect(as.revocations.map((r) => r.tokenTypeHint).sort()).toEqual(['access_token', 'refresh_token']);
    expect(as.clientAuthLog.filter((e) => e.endpoint === 'revoke').every((e) => e.secretMatched)).toBe(true);
    expect(probe.getClientSecret('vercel')).toBeUndefined();
  }, 15_000);

  it('rebuilds a confidential client after a restart and keeps refreshing', async () => {
    const { as, upstream } = await setupServers();
    as.issueClientSecretOnRegister = true;
    as.requireClientSecret = true;
    const { registry: reg, settings, host } = registry();

    expect((await reg.registerServer({ name: 'vercel', url: upstream.baseUrl })).success).toBe(true);
    reg.close();

    // Simulate a plugin restart over the same settings + keychain.
    const restarted = new OAuthMcpRegistry(host);
    activeRegistries.push(restarted);
    await restarted.configure();
    activeRegistrations.push({ registry: restarted, name: 'vercel' });

    expect(settings.oauthMcpState.vercel).toMatchObject({ status: 'connected', hasClientSecret: true });

    const config = restarted.serversForThread('thread-1').vercel as { url: string; headers: Record<string, string> };
    upstream.forceUnauthorizedOnce = true;
    expect((await callProxy(config, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);
    expect(as.refreshGrantHits).toBe(1);
  }, 15_000);
});

// ── Scenario 7b: machine-to-machine (client_credentials) ───────────────────

describe('OAuth MCP broker integration — client_credentials grant', () => {
  /**
   * An `openUrl` that fails loudly if anything reaches for a browser, and records
   * what it was asked to open so the assertion can name it.
   */
  function forbidBrowser(): { open: (url: string) => Promise<unknown>; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      open: async (url: string) => {
        calls.push(url);
        throw new Error(`the browser must never open for client_credentials, but something asked for ${url}`);
      },
    };
  }

  /**
   * The grant exists because `auth.bankrate.com` will not register a loopback
   * redirect URI at all, so the authorization-code path is unavailable there
   * however correctly it is implemented. The load-bearing assertions are the
   * negative ones: no browser, no DCR, no code, no PKCE, no redirect_uri.
   */
  it('registers and serves tool calls with no browser, no DCR and no interactive parameters', async () => {
    const { as, upstream } = await setupServers();
    as.requireClientSecret = true;
    as.issuedClientSecrets.set('m2m-client', 'm2m-secret');
    const browser = forbidBrowser();
    const { registry: reg, settings, host, raw } = registry(browser.open);

    const result = await reg.registerServer({
      name: 'bankrate',
      url: upstream.baseUrl,
      grantType: 'client_credentials',
      clientId: 'm2m-client',
      clientSecret: 'm2m-secret',
      audience: 'bankrate-api',
    });

    expect(result).toMatchObject({ success: true, status: 'registered' });
    expect(browser.calls).toEqual([]);
    expect(as.authorizeLog).toHaveLength(0);
    expect(as.registerLog).toHaveLength(0);

    expect(as.clientCredentialsGrantHits).toBe(1);
    expect(as.clientCredentialsLog[0]).toMatchObject({ clientId: 'm2m-client', audience: 'bankrate-api' });
    expect(as.clientCredentialsLog[0].interactiveParams).toEqual([]);
    // It authenticated as a confidential client — the mock would have 401'd otherwise.
    const tokenAuth = as.clientAuthLog.filter((e) => e.endpoint === 'token');
    expect(tokenAuth).toHaveLength(1);
    expect(tokenAuth[0].secretMatched).toBe(true);
    expect(['basic', 'post']).toContain(tokenAuth[0].method);

    // Custody: keychain yes, data.json no.
    const probe = new OAuthTokenStore(host.secretStorage, () => Promise.reject(new Error('no refresh')));
    expect(probe.getClientSecret('bankrate')).toBe('m2m-secret');
    expect(JSON.stringify(settings)).not.toContain('m2m-secret');
    expect([...raw.values()]).toContain('m2m-secret');

    // No refresh token, yet connected: the secret is the renewal material.
    expect(settings.oauthMcpServers.bankrate).toMatchObject({ grantType: 'client_credentials', audience: 'bankrate-api' });
    expect(settings.oauthMcpState.bankrate).toMatchObject({ status: 'connected', hasRefreshToken: false, grantType: 'client_credentials' });

    const config = reg.serversForThread('thread-1').bankrate as { url: string; headers: Record<string, string> };
    expect((await callProxy(config, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);
  }, 15_000);

  /**
   * The failure this grant is most prone to: with no refresh token, a naive
   * implementation either hands back a dead access token forever or calls the
   * refresh grant with nothing to present. It must re-mint from the secret.
   */
  it('re-mints a token from the client secret when the access token goes stale, never using the refresh grant', async () => {
    const { as, upstream } = await setupServers();
    as.requireClientSecret = true;
    as.issuedClientSecrets.set('m2m-client', 'm2m-secret');
    const { registry: reg } = registry(forbidBrowser().open);

    expect((await reg.registerServer({
      name: 'bankrate', url: upstream.baseUrl, grantType: 'client_credentials', clientId: 'm2m-client', clientSecret: 'm2m-secret',
    })).success).toBe(true);

    const config = reg.serversForThread('thread-1').bankrate as { url: string; headers: Record<string, string> };
    upstream.forceUnauthorizedOnce = true;
    expect((await callProxy(config, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);

    expect(as.refreshGrantHits).toBe(0);
    expect(as.clientCredentialsGrantHits).toBe(2);
  }, 15_000);

  it('rebuilds after a restart from the keychain secret alone, with no stored refresh token', async () => {
    const { as, upstream } = await setupServers();
    as.requireClientSecret = true;
    as.issuedClientSecrets.set('m2m-client', 'm2m-secret');
    const { registry: reg, settings, host } = registry(forbidBrowser().open);

    expect((await reg.registerServer({
      name: 'bankrate', url: upstream.baseUrl, grantType: 'client_credentials', clientId: 'm2m-client', clientSecret: 'm2m-secret', audience: 'bankrate-api',
    })).success).toBe(true);
    reg.close();

    const restarted = new OAuthMcpRegistry(host);
    activeRegistries.push(restarted);
    await restarted.configure();
    activeRegistrations.push({ registry: restarted, name: 'bankrate' });

    expect(settings.oauthMcpState.bankrate).toMatchObject({ status: 'connected', hasClientSecret: true, grantType: 'client_credentials' });

    const config = restarted.serversForThread('thread-1').bankrate as { url: string; headers: Record<string, string> };
    upstream.forceUnauthorizedOnce = true;
    expect((await callProxy(config, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);
    expect(as.refreshGrantHits).toBe(0);
    expect(as.clientCredentialsGrantHits).toBe(2);
  }, 15_000);

  it('fails the registration, stores nothing, and keeps no secret when the credentials are wrong', async () => {
    const { as, upstream } = await setupServers();
    as.requireClientSecret = true;
    as.issuedClientSecrets.set('m2m-client', 'm2m-secret');
    const { registry: reg, settings, host } = registry(forbidBrowser().open);

    const result = await reg.registerServer({
      name: 'bankrate', url: upstream.baseUrl, grantType: 'client_credentials', clientId: 'm2m-client', clientSecret: 'wrong-secret',
    });

    expect(result).toMatchObject({ success: false, status: 'failed' });
    expect(settings.oauthMcpServers.bankrate).toBeUndefined();
    const probe = new OAuthTokenStore(host.secretStorage, () => Promise.reject(new Error('no refresh')));
    expect(probe.getClientSecret('bankrate')).toBeUndefined();
  }, 15_000);
});

// ── Scenario 8: unregister while a thread holds a capability token ─────────

describe('OAuth MCP broker integration — unregister while in use', () => {
  it('fails cleanly (connection refused) on the next tool call after disconnect, rather than hanging or silently succeeding', async () => {
    const { upstream } = await setupServers();
    const { registry: reg } = registry();

    const result = await reg.registerServer({ name: 'vercel', url: upstream.baseUrl });
    expect(result.success).toBe(true);
    const config = reg.serversForThread('thread-1').vercel as { url: string; headers: Record<string, string> };
    expect((await callProxy(config, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);

    await reg.disconnect('vercel');

    await expect(callProxy(config, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).rejects.toThrow();
  });
});

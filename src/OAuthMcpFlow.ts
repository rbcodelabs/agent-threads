/**
 * OAuth 2.1 + PKCE broker for one OAuth-gated remote MCP server: discovery,
 * Dynamic Client Registration (RFC 7591), the authorization-code+PKCE
 * consent round-trip, refresh, and revocation.
 *
 * Uses `@modelcontextprotocol/sdk`'s client auth helpers for discovery, DCR,
 * and token exchange/refresh (RFC 9728 / RFC 8414 / RFC 7591 are all
 * SDK-covered — no reason to hand-roll them). PKCE generation and the
 * authorization-URL/callback-server plumbing are implemented directly here:
 * the SDK's own `startAuthorization()` generates and owns its own PKCE
 * verifier internally with no way to inject one, which conflicts with this
 * module needing directly testable PKCE generation (known S256 vectors,
 * fake-timer-driven callback timeout tests). There is no SDK client-side
 * helper for RFC 7009 revocation either (only server-side schemas ship), so
 * revoke() performs that POST directly, reusing the SDK's `parseErrorResponse`
 * for consistent error shaping.
 *
 * Deliberately host-agnostic: `openUrl` is injected (wired to `host_open_url`
 * by the caller in a later stage) and tokens are handed to an injected
 * `OAuthTokenStoreLike` rather than touching keychain APIs here.
 */

import { createHash, randomBytes } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  parseErrorResponse,
  refreshAuthorization,
  registerClient as sdkRegisterClient,
  type OAuthServerInfo,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { AuthorizationServerMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { checkResourceAllowed, resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import type { TokenSet } from './OAuthTokenStore';
import { parseRedirectUri, type ParsedRedirectUri } from './mcpServerStore';

/** Result of AS discovery (RFC 9728 protected-resource metadata + RFC 8414/OIDC AS metadata). */
export type OAuthASMetadata = OAuthServerInfo;

/**
 * RFC 8707 resource indicator for this AS, or `undefined` when the MCP server
 * publishes no RFC 9728 protected-resource metadata.
 *
 * Mirrors the SDK's `selectResourceURL()` policy — only send `resource` when
 * protected-resource metadata is actually present, and prefer the `resource`
 * the server itself advertises over one derived from the URL we dialled. The
 * SDK helper is not reused directly because it requires a full
 * `OAuthClientProvider`, which this module deliberately does not implement.
 *
 * Servers differ on how much they care: Vercel's MCP server ignores the
 * parameter, while v0 (`https://v0.app/api/mcp`) hard-rejects any authorization
 * request that omits it with `400 invalid_target — resource must be
 * https://v0.app/api/mcp`. Sending it whenever metadata advertises it satisfies
 * both, and is what the MCP authorization spec requires of clients.
 *
 * The audience is validated once at discovery (see `discoverAS`), so callers
 * here can trust `resourceMetadata.resource`.
 */
export function resourceIndicatorFor(asMetadata: OAuthASMetadata): URL | undefined {
  const resource = asMetadata.resourceMetadata?.resource;
  return resource === undefined ? undefined : new URL(resource);
}

export interface OAuthTokenStoreLike {
  store(serverName: string, tokens: TokenSet): void | Promise<void>;
  getClientId(serverName: string): string | undefined | Promise<string | undefined>;
  /** `client_secret` for a confidential client; `undefined` for the usual public+PKCE client. */
  getClientSecret(serverName: string): string | undefined | Promise<string | undefined>;
  getCurrentTokens(serverName: string): TokenSet | undefined | Promise<TokenSet | undefined>;
  clear(serverName: string): void | Promise<void>;
}

/**
 * Client credentials for one token-endpoint call.
 *
 * `clientSecret` is almost always absent: this plugin registers public clients
 * that authenticate with PKCE alone. When it is present the SDK picks the
 * concrete method (`client_secret_basic`, falling back to `client_secret_post`)
 * from the AS's advertised `token_endpoint_auth_methods_supported` — see
 * `applyClientAuthentication` in `@modelcontextprotocol/sdk/client/auth.js`. We
 * deliberately don't pin a method ourselves, so an AS that supports only one of
 * the two still works.
 */
function clientInformationFor(clientId: string, clientSecret?: string): { client_id: string; client_secret?: string } {
  return clientSecret === undefined ? { client_id: clientId } : { client_id: clientId, client_secret: clientSecret };
}

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

type FinishResult = { ok: true; tokens: TokenSet } | { ok: false; error: Error };

/** RFC 7636 S256 code challenge for a given verifier. Split out from generatePkcePair so it's testable against known vectors. */
export function pkceChallengeForVerifier(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceChallengeForVerifier(verifier) };
}

function toTokenSet(tokens: OAuthTokens): TokenSet {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_in !== undefined ? Date.now() + tokens.expires_in * 1000 : undefined,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * The one page a user ever sees from this plugin's local callback server: the
 * tab the authorization server redirects back to after consent.
 *
 * `<meta charset>` is not optional here. Without it the browser decodes this
 * UTF-8 string as Latin-1 and the em dash in "Authorization complete" renders
 * as `â€”`. The Content-Type header sent alongside it also carries the charset,
 * since the header wins over the meta tag when both are present.
 *
 * Everything is inline — no fonts, no stylesheets, no images. The page is
 * served once from 127.0.0.1 on an ephemeral port and the server is torn down
 * immediately after, so any external reference would race the shutdown.
 */
function callbackPage(opts: { variant: 'success' | 'error'; title: string; detail?: string }): string {
  const accent = opts.variant === 'success' ? '#16a34a' : '#dc2626';
  const icon = opts.variant === 'success'
    ? '<path d="M20 6 9 17l-5-5"/>'
    : '<path d="M12 8v5"/><path d="M12 16h.01"/><circle cx="12" cy="12" r="9"/>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
    background: #f6f7f9; color: #1f2328;
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  .card {
    width: 100%; max-width: 420px; padding: 32px; text-align: center;
    background: #fff; border: 1px solid rgba(0,0,0,.08); border-radius: 14px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.06);
  }
  .badge {
    width: 48px; height: 48px; margin: 0 auto 18px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 50%; background: ${accent}1a; color: ${accent};
  }
  svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 2.25; stroke-linecap: round; stroke-linejoin: round; }
  h1 { margin: 0 0 8px; font-size: 17px; font-weight: 600; letter-spacing: -.01em; }
  p { margin: 0; font-size: 14px; color: #656d76; overflow-wrap: anywhere; }
  .hint { margin-top: 20px; font-size: 12.5px; color: #8b949e; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181d; color: #e6edf3; }
    .card { background: #1c1f26; border-color: rgba(255,255,255,.09); box-shadow: none; }
    p { color: #9198a1; }
    .hint { color: #6e7681; }
  }
</style>
</head>
<body>
  <main class="card" role="status">
    <div class="badge" aria-hidden="true"><svg viewBox="0 0 24 24">${icon}</svg></div>
    <h1>${escapeHtml(opts.title)}</h1>
    ${opts.detail ? `<p>${escapeHtml(opts.detail)}</p>` : ''}
    <p class="hint">You can close this tab and return to Agent Threads.</p>
  </main>
  <script>
    // Only works for script-opened windows, so the hint above stands either way.
    setTimeout(function () { window.close(); }, 1200);
  </script>
</body>
</html>`;
}

/** Content-Type for the callback page. The charset must be explicit — see callbackPage. */
const CALLBACK_CONTENT_TYPE = 'text/html; charset=utf-8';

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export class OAuthMcpFlow {
  constructor(
    private readonly tokenStore: OAuthTokenStoreLike,
    private readonly openUrl: (url: string) => Promise<unknown>,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly callbackTimeoutMs = CALLBACK_TIMEOUT_MS,
  ) {}

  /**
   * RFC 9728 protected-resource discovery -> RFC 8414/OIDC AS metadata discovery, combined by the SDK.
   *
   * `fetchFn` is mandatory here rather than left to the SDK's `fetch` default:
   * the renderer's origin is `file://`, from which Chromium blocks every
   * cross-origin fetch, and the SDK turns that failure into `undefined`
   * metadata instead of an error (see src/requestUrlFetch.ts).
   */
  async discoverAS(serverUrl: string): Promise<OAuthASMetadata> {
    const info = await discoverOAuthServerInfo(serverUrl, { fetchFn: this.fetchFn });

    // Audience check for the RFC 8707 resource indicator derived from this
    // metadata. Protected-resource metadata is fetched from the MCP server's own
    // well-known endpoint, but it is still server-controlled input naming the
    // audience our access token will be minted for: an unvalidated `resource`
    // pointing at an unrelated origin is an audience-confusion vector. Checking
    // here — the one place the dialled server URL and the metadata are both in
    // hand — means `authorize()` and `refresh()` can use the value directly.
    const resource = info.resourceMetadata?.resource;
    if (resource !== undefined) {
      const requestedResource = resourceUrlFromServerUrl(serverUrl);
      if (!checkResourceAllowed({ requestedResource, configuredResource: resource })) {
        throw new Error(
          `MCP server "${serverUrl}" advertises protected-resource metadata for "${resource}", which does not cover it; refusing to request a token for a different audience.`,
        );
      }
    }
    return info;
  }

  /**
   * RFC 7591 Dynamic Client Registration. Returns the issued client_id, plus a
   * `client_secret` when the authorization server issued one.
   *
   * This method takes a bare registration endpoint rather than a server name (matching the
   * plan's signature), so it has no key to store the credentials under — the caller persists them
   * via `tokenStore.storeClientId`/`storeClientSecret` once it knows which server this was for.
   *
   * We still request `token_endpoint_auth_method: 'none'`, so the overwhelmingly
   * common outcome is a public client with no secret. But RFC 7591 §3.2.1 lets
   * the AS return a `client_secret` regardless of what was requested, and some
   * do; dropping it silently then produced an `invalid_client` failure at the
   * token exchange that looked like a consent problem rather than a discarded
   * credential. Capturing it costs nothing when it's absent.
   */
  async registerClient(
    registrationEndpoint: string,
    redirectUri: string,
    scopes?: string,
  ): Promise<{ clientId: string; clientSecret?: string }> {
    // The SDK's registerClient() only reads `metadata.registration_endpoint` when metadata is
    // supplied (see its implementation) — the other required AuthorizationServerMetadata fields
    // below are unused placeholders needed only to satisfy a type that models a full discovered
    // AS document, not a bare registration endpoint URL.
    const metadata: AuthorizationServerMetadata = {
      issuer: registrationEndpoint,
      authorization_endpoint: registrationEndpoint,
      token_endpoint: registrationEndpoint,
      response_types_supported: ['code'],
      registration_endpoint: registrationEndpoint,
    };
    const info = await sdkRegisterClient(registrationEndpoint, {
      fetchFn: this.fetchFn,
      metadata,
      clientMetadata: {
        redirect_uris: [redirectUri],
        client_name: 'Agent Threads',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      scope: scopes,
    });
    return { clientId: info.client_id, clientSecret: info.client_secret };
  }

  /**
   * Full PKCE authorization-code flow: starts a local callback server on an ephemeral port,
   * opens the consent URL via the injected `openUrl`, waits for the callback (validating
   * `state`), exchanges the code for tokens, and stores them. Rejects (after cleaning up the
   * callback server either way) on denial, state mismatch, exchange failure, or a 5-minute timeout.
   */
  async authorize(params: {
    serverName: string;
    clientId: string;
    /**
     * `client_secret` for a confidential client. Sent only on the token
     * exchange, never on the authorization request — the authorization URL ends
     * up in a browser address bar and in AS access logs, so a secret there would
     * be leaked by construction. PKCE is still used either way; a secret
     * supplements it rather than replacing it.
     */
    clientSecret?: string;
    asMetadata: OAuthASMetadata;
    scopes?: string;
    /**
     * Use this exact loopback URI as the OAuth callback instead of an ephemeral
     * `127.0.0.1` port. Required by providers whose registered OAuth app expects
     * one exact redirect_uri rather than relying on RFC 8252 §7.3's "any port"
     * loopback allowance — Slack's MCP server registers
     * `http://localhost:3118/callback`.
     *
     * Host, port AND path all come from this URI. In particular the URI is used
     * verbatim in both the authorization request and the token exchange: OAuth
     * redirect_uri validation is exact string matching, so rebuilding it from
     * the bound socket's address would turn a `localhost` URI back into
     * `127.0.0.1` and get it rejected.
     */
    redirectUri?: string;
  }): Promise<TokenSet> {
    const { verifier, challenge } = generatePkcePair();
    const state = randomBytes(16).toString('hex');

    // Parsed once up front so a malformed URI fails before a listener is opened.
    // The schema (mcpRegistrationSchema) is the real validation boundary; this
    // parse exists to extract bind host/port/path and to fail loudly rather than
    // bind something unintended if a caller bypassed that schema.
    let pinned: ParsedRedirectUri | undefined;
    if (params.redirectUri !== undefined) {
      const result = parseRedirectUri(params.redirectUri);
      if (!result.ok) throw new Error(`Invalid OAuth redirectUri "${params.redirectUri}": ${result.error}`);
      pinned = result.parsed;
    }

    return new Promise<TokenSet>((resolve, reject) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let redirectUri = '';
      const callbackPath = pinned?.pathname ?? '/callback';

      const finish = (result: FinishResult): void => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        server.close();
        if (result.ok) resolve(result.tokens); else reject(result.error);
      };

      const server: Server = createServer((req, res) => {
        void this.handleCallback(req, res, { ...params, redirectUri, callbackPath, verifier, expectedState: state }, finish);
      });

      server.on('error', (err) => {
        const cause = asError(err);
        // A pinned host/port can fail to bind (e.g. EADDRINUSE because something
        // else already holds it — realistic for 3118, which Claude Code/Claude
        // Desktop also bind for their own Slack integration); surface the address
        // and that it may be in use rather than a bare "EADDRINUSE" with no
        // actionable context.
        const error = pinned
          ? new Error(`OAuth callback server could not bind ${pinned.hostname}:${pinned.port} (the port may already be in use): ${cause.message}`)
          : cause;
        finish({ ok: false, error });
      });

      // Bind the hostname parsed from the URI, never a hardcoded 127.0.0.1: on
      // macOS `localhost` commonly resolves to ::1 first, so binding 127.0.0.1
      // for a `localhost` URI would leave the browser connecting over IPv6 to a
      // port nothing is listening on — the callback then fails with
      // connection-refused *after* the user has already consented.
      server.listen(pinned?.port ?? 0, pinned?.hostname ?? '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          finish({ ok: false, error: new Error('OAuth callback server failed to bind a port.') });
          return;
        }
        // Verbatim when pinned — see the redirectUri doc comment above.
        redirectUri = params.redirectUri ?? `http://127.0.0.1:${address.port}/callback`;

        const authorizationEndpoint = params.asMetadata.authorizationServerMetadata?.authorization_endpoint
          ?? `${params.asMetadata.authorizationServerUrl.replace(/\/+$/, '')}/authorize`;
        const authorizationUrl = new URL(authorizationEndpoint);
        authorizationUrl.searchParams.set('response_type', 'code');
        authorizationUrl.searchParams.set('client_id', params.clientId);
        authorizationUrl.searchParams.set('redirect_uri', redirectUri);
        authorizationUrl.searchParams.set('code_challenge', challenge);
        authorizationUrl.searchParams.set('code_challenge_method', 'S256');
        authorizationUrl.searchParams.set('state', state);
        if (params.scopes) authorizationUrl.searchParams.set('scope', params.scopes);
        // RFC 8707. Must also be repeated on the token exchange below, with an
        // identical value — see handleCallback().
        const resource = resourceIndicatorFor(params.asMetadata);
        if (resource) authorizationUrl.searchParams.set('resource', resource.href);

        timeoutHandle = setTimeout(
          () => finish({ ok: false, error: new Error('OAuth authorization timed out waiting for consent.') }),
          this.callbackTimeoutMs,
        );

        Promise.resolve(this.openUrl(authorizationUrl.toString()))
          .catch((err) => finish({ ok: false, error: asError(err) }));
      });
    });
  }

  private async handleCallback(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: { serverName: string; clientId: string; clientSecret?: string; asMetadata: OAuthASMetadata; redirectUri: string; callbackPath: string; verifier: string; expectedState: string },
    finish: (result: FinishResult) => void,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== ctx.callbackPath) {
      res.writeHead(404).end();
      return;
    }

    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');

    if (error) {
      res.writeHead(200, { 'Content-Type': CALLBACK_CONTENT_TYPE }).end(callbackPage({
        variant: 'error',
        title: 'Authorization denied',
        detail: `The authorization server reported: ${error}`,
      }));
      finish({ ok: false, error: new Error(`OAuth authorization was denied: ${error}`) });
      return;
    }
    if (!code || returnedState !== ctx.expectedState) {
      res.writeHead(400, { 'Content-Type': CALLBACK_CONTENT_TYPE }).end(callbackPage({
        variant: 'error',
        title: 'Invalid authorization response',
        detail: 'The redirect was missing its authorization code, or its state did not match this request.',
      }));
      finish({ ok: false, error: new Error('OAuth callback state mismatch or missing authorization code.') });
      return;
    }

    try {
      const tokens = await exchangeAuthorization(ctx.asMetadata.authorizationServerUrl, {
        fetchFn: this.fetchFn,
        metadata: ctx.asMetadata.authorizationServerMetadata,
        clientInformation: clientInformationFor(ctx.clientId, ctx.clientSecret),
        authorizationCode: code,
        codeVerifier: ctx.verifier,
        redirectUri: ctx.redirectUri,
        // RFC 8707 §2: the token request repeats the authorization request's
        // resource. An AS that pinned the audience at consent will reject the
        // exchange outright if it goes missing here.
        resource: resourceIndicatorFor(ctx.asMetadata),
      });
      const tokenSet = toTokenSet(tokens);
      await this.tokenStore.store(ctx.serverName, tokenSet);
      res.writeHead(200, { 'Content-Type': CALLBACK_CONTENT_TYPE }).end(callbackPage({
        variant: 'success',
        title: 'Authorization complete',
        detail: `${ctx.serverName} is connected.`,
      }));
      finish({ ok: true, tokens: tokenSet });
    } catch (err) {
      res.writeHead(502, { 'Content-Type': CALLBACK_CONTENT_TYPE }).end(callbackPage({
        variant: 'error',
        title: 'Token exchange failed',
        detail: 'The authorization server rejected the request to exchange the code for tokens.',
      }));
      finish({ ok: false, error: asError(err) });
    }
  }

  /** Refresh via the AS's token endpoint, using the client credentials and refresh token already on file. */
  async refresh(serverName: string, asMetadata: OAuthASMetadata): Promise<TokenSet> {
    const current = await this.tokenStore.getCurrentTokens(serverName);
    if (!current?.refreshToken) throw new Error(`No refresh token available for "${serverName}"; re-authorization is required.`);
    const clientId = await this.tokenStore.getClientId(serverName);
    if (!clientId) throw new Error(`No client_id stored for "${serverName}"; re-authorization is required.`);
    // A confidential client must re-authenticate on every token-endpoint call,
    // not just the first: an AS that required client_secret at the exchange
    // rejects a bare refresh with `invalid_client`, which surfaces as a
    // spontaneous logout once the access token expires rather than at setup.
    const clientSecret = await this.tokenStore.getClientSecret(serverName);

    const tokens = await refreshAuthorization(asMetadata.authorizationServerUrl, {
      fetchFn: this.fetchFn,
      metadata: asMetadata.authorizationServerMetadata,
      clientInformation: clientInformationFor(clientId, clientSecret),
      refreshToken: current.refreshToken,
      // Keeps the refreshed access token scoped to the same audience the
      // original grant was issued for.
      resource: resourceIndicatorFor(asMetadata),
    });
    const tokenSet = toTokenSet(tokens);
    await this.tokenStore.store(serverName, tokenSet);
    return tokenSet;
  }

  /** RFC 7009 revocation, best-effort — an AS that rejects revocation still gets its local state cleared. */
  async revoke(serverName: string, asMetadata: OAuthASMetadata): Promise<void> {
    // revocation_endpoint is only present on the OAuthMetadata (RFC 8414) arm of the
    // AuthorizationServerMetadata union, not the plain OpenID Connect discovery arm.
    const asMeta = asMetadata.authorizationServerMetadata;
    const revocationEndpoint = asMeta && 'revocation_endpoint' in asMeta ? asMeta.revocation_endpoint : undefined;
    const current = await this.tokenStore.getCurrentTokens(serverName);
    const clientId = await this.tokenStore.getClientId(serverName);
    // RFC 7009 §2.1: a confidential client authenticates to the revocation
    // endpoint the same way it does to the token endpoint. Omitting the secret
    // makes revocation fail silently (it's best-effort below), leaving a live
    // refresh token on the AS after the user thought they had disconnected.
    const clientSecret = await this.tokenStore.getClientSecret(serverName);

    if (revocationEndpoint && clientId && current) {
      const candidates: Array<[string | undefined, string]> = [
        [current.refreshToken, 'refresh_token'],
        [current.accessToken, 'access_token'],
      ];
      for (const [token, tokenTypeHint] of candidates) {
        if (!token) continue;
        try {
          const response = await this.fetchFn(revocationEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              token,
              token_type_hint: tokenTypeHint,
              client_id: clientId,
              ...(clientSecret === undefined ? {} : { client_secret: clientSecret }),
            }),
          });
          if (!response.ok) throw await parseErrorResponse(response);
        } catch {
          // Best-effort: an unreachable or uncooperative AS shouldn't block clearing local state.
        }
      }
    }

    await this.tokenStore.clear(serverName);
  }
}

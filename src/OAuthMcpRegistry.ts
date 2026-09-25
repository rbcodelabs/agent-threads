/**
 * Composition root for OAuth-gated MCP servers: owns one
 * `OAuthMcpFlow` + `OAuthTokenStore` + `OAuthMcpProxy` trio per registered
 * `oauth`-type server, drives the `mcp_register_server` consent flow end to
 * end, and exposes the running proxies to `ThreadManager.mcpServerFactory`
 * exactly like `GoogleWorkspaceMcp` does for Google's toolset.
 *
 * One instance per plugin. Injected `host` rather than reaching for `app`
 * globals, matching `GoogleWorkspaceMcp`'s constructor-injection style, so
 * this class is unit-testable without an Obsidian host.
 *
 * Persistence split, mirroring `OAuthMcpState`'s own doc comment: nonsecret
 * config/status lives in `host.getSettings()` (backed by data.json);
 * access/refresh tokens, the DCR-issued client_id and any confidential-client
 * client_secret live only in the OS keychain via `OAuthTokenStore` — never here,
 * never in data.json, which records only a `hasClientSecret` flag.
 */

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { OAuthMcpFlow, type OAuthASMetadata } from './OAuthMcpFlow';
import { OAuthMcpProxy, type ToolFilter } from './OAuthMcpProxy';
import { OAuthTokenStore, type SecretStorageLike, type TokenSet } from './OAuthTokenStore';
import { createRequestUrlFetch } from './requestUrlFetch';
import type { McpRegistrationResult } from './mcpServerStore';
import type { OAuthMcpState, StoredOAuthMcpServer } from './types';

/** Flattened `mcp_register_server` input for an `oauth`-type entry (see `mcpRegistrationSchema`'s oauth variant). */
export interface OAuthRegistrationEntry {
  name: string;
  url: string;
  scopes?: string;
  tools?: ToolFilter;
  clientId?: string;
  /**
   * Resolved `client_secret` literal for a confidential client, or `undefined`
   * for the usual public+PKCE client.
   *
   * Already resolved by the time it arrives here — callers differ in how:
   * `main.ts` expands the `${NAME}` placeholder that `mcpRegistrationSchema`
   * requires on the tool path, while the Settings modal passes the password
   * field's value directly and never puts it in a schema-validated entry. This
   * class only ever sees the literal, and hands it straight to the keychain.
   */
  clientSecret?: string;
  authorizationServerUrl?: string;
  redirectUri?: string;
  /**
   * Which grant to use. Omitted means `authorization_code` — the interactive
   * PKCE flow, so existing callers are unaffected.
   *
   * `client_credentials` skips the browser leg entirely: no PKCE, no loopback
   * listener, no consent screen. It requires `clientId` and `clientSecret`,
   * since a machine-to-machine client cannot be public and cannot be registered
   * on the fly without a redirect URI.
   */
  grantType?: 'authorization_code' | 'client_credentials';
  /** `audience` parameter on the token request (Auth0 API identifier). Nonsecret. */
  audience?: string;
}

export interface OAuthMcpRegistryHost {
  getSettings: () => { oauthMcpServers: Record<string, StoredOAuthMcpServer>; oauthMcpState: Record<string, OAuthMcpState> };
  save: () => Promise<void>;
  secretStorage: SecretStorageLike;
  openUrl: (url: string) => Promise<unknown>;
  /**
   * HTTP client for authorization-server traffic. Defaults to the
   * `requestUrl`-backed adapter, which is the only thing that works in the
   * renderer (`file://` origin blocks cross-origin fetch). Tests inject a stub.
   */
  fetchFn?: typeof fetch;
}

interface Connection {
  flow: OAuthMcpFlow;
  tokenStore: OAuthTokenStore;
  proxy: OAuthMcpProxy;
  asMetadata: OAuthASMetadata;
}

/**
 * Everything the token store needs to renew a token set on its own, once the
 * interactive registration (or plugin-load rebuild) is over. Held in a box
 * rather than passed per call because renewal fires from a proxy request or a
 * background timer, long after the call that established the connection.
 */
interface GrantConfig {
  grantType: 'authorization_code' | 'client_credentials';
  clientId: string;
  scopes?: string;
  audience?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function portOf(proxy: OAuthMcpProxy): number {
  try { return Number(new URL(proxy.url).port); } catch { return 0; }
}

/** `revocation_endpoint` is only on the RFC 8414 (OAuthMetadata) arm of the AS metadata union, not plain OIDC discovery. */
function revocationEndpointOf(asMetadata: OAuthASMetadata): string | undefined {
  const meta = asMetadata.authorizationServerMetadata;
  return meta && 'revocation_endpoint' in meta ? meta.revocation_endpoint : undefined;
}

export class OAuthMcpRegistry {
  private connections = new Map<string, Connection>();

  constructor(private readonly host: OAuthMcpRegistryHost) {}

  /**
   * Builds a fresh `OAuthMcpFlow`/`OAuthTokenStore` pair for `serverName`. The
   * token store's `refreshFn` closes over a mutable `asMetadata` box because,
   * for the `configure()` rebuild path, discovery (which produces
   * `asMetadata`) happens after the store needs to exist conceptually — in
   * practice both callers assign `asMetadata` before any refresh can actually
   * fire, since refreshes only ever happen later, in response to a real
   * proxy request.
   *
   * `setGrant` is a second such box, for the same reason plus one more: the
   * grant's `clientId` may not exist yet at construction time (DCR mints it, and
   * `configure()` reads it back out of the keychain), so it cannot be a
   * constructor argument. Leaving it unset keeps the historical behavior —
   * renewal via the authorization-code refresh token.
   */
  private buildPair(serverName: string): {
    flow: OAuthMcpFlow;
    tokenStore: OAuthTokenStore;
    setAsMetadata: (m: OAuthASMetadata) => void;
    setGrant: (g: GrantConfig) => void;
  } {
    let asMetadata: OAuthASMetadata | undefined;
    let grant: GrantConfig | undefined;
    let flow: OAuthMcpFlow;
    const tokenStore: OAuthTokenStore = new OAuthTokenStore(
      this.host.secretStorage,
      (name: string): Promise<TokenSet> => {
        if (!asMetadata) return Promise.reject(new Error(`No cached authorization-server metadata for "${name}"; re-authorize in Settings.`));
        // A client_credentials server has no refresh token to present, so
        // "renewal" means minting a brand-new token from the client's own
        // credentials — the same call that established the connection.
        if (grant?.grantType === 'client_credentials') {
          const clientSecret = tokenStore.getClientSecret(name);
          if (!clientSecret) {
            return Promise.reject(new Error(
              `No client secret in the keychain for "${name}", so its token cannot be renewed. Reconnect it in Settings.`,
            ));
          }
          return flow.clientCredentials({
            serverName: name,
            clientId: grant.clientId,
            clientSecret,
            asMetadata,
            scopes: grant.scopes,
            audience: grant.audience,
          });
        }
        return flow.refresh(name, asMetadata);
      },
      () => grant?.grantType === 'client_credentials',
    );
    // Must be the requestUrl-backed fetch, not the renderer's: see
    // src/requestUrlFetch.ts. `this.host.fetchFn` lets tests inject a stub.
    flow = new OAuthMcpFlow(tokenStore, this.host.openUrl, this.host.fetchFn ?? createRequestUrlFetch());
    return {
      flow,
      tokenStore,
      setAsMetadata: (m: OAuthASMetadata) => { asMetadata = m; },
      setGrant: (g: GrantConfig) => { grant = g; },
    };
  }

  private buildState(name: string, clientId: string, hasClientSecret: boolean, asMetadata: OAuthASMetadata, proxy: OAuthMcpProxy, tokens: TokenSet, status: OAuthMcpState['status']): OAuthMcpState {
    return {
      serverName: name,
      clientId,
      hasClientSecret,
      asMetadataUrl: asMetadata.authorizationServerUrl,
      proxyPort: portOf(proxy),
      status,
      accessTokenExpiresAt: tokens.expiresAt,
      hasRefreshToken: !!tokens.refreshToken,
      revocationEndpoint: revocationEndpointOf(asMetadata),
      tokenEndpoint: asMetadata.authorizationServerMetadata?.token_endpoint ?? '',
    };
  }

  /**
   * Called once on plugin load. Rebuilds the flow/token-store/proxy trio for
   * every configured server that still has a stored access or refresh token,
   * and starts its proxy. Never throws: a single server's rebuild failure is
   * recorded as that server's `'error'` state and every other server is still
   * attempted.
   *
   * Deviation from `OAuthMcpState.asMetadataUrl`'s doc comment ("cached to
   * skip re-discovery"): the full `OAuthASMetadata` object (endpoints,
   * capabilities) that `OAuthMcpFlow.refresh()`/`authorize()` need is never
   * persisted — only a few derived, nonsecret fields are (by design, per
   * `OAuthMcpState`'s own doc comment: it "only tracks enough to render
   * connection status ... without ever touching a secret value"). So this
   * rebuild always re-runs discovery rather than skipping it; `asMetadataUrl`
   * remains informational (Settings UI / debugging) rather than a discovery
   * cache key.
   */
  async configure(): Promise<void> {
    const settings = this.host.getSettings();
    const entries = Object.entries(settings.oauthMcpServers ?? {});
    let dirty = false;

    for (const [name, entry] of entries) {
      try {
        // Throwaway store: only used to check whether there's anything to rebuild,
        // before committing to a real discovery round-trip for this server.
        const probe = new OAuthTokenStore(this.host.secretStorage, () => Promise.reject(new Error('probe store does not refresh')));
        const tokens = probe.getCurrentTokens(name);
        if (!tokens) continue; // Never authorized (or already cleared) — nothing to rebuild.

        const { flow, tokenStore, setAsMetadata, setGrant } = this.buildPair(name);
        const asMetadata = await flow.discoverAS(entry.authorizationServerUrl ?? entry.url);
        setAsMetadata(asMetadata);
        setGrant({
          grantType: entry.grantType ?? 'authorization_code',
          clientId: tokenStore.getClientId(name) ?? entry.clientId ?? '',
          scopes: entry.scopes,
          audience: entry.audience,
        });

        const proxy = new OAuthMcpProxy(name, entry.url, {
          getAccessToken: (n) => tokenStore.getAccessToken(n),
          refresh: (n) => tokenStore.refresh(n),
        }, entry.tools);
        await proxy.start();

        const clientId = tokenStore.getClientId(name) ?? entry.clientId ?? '';
        const accessExpired = tokens.expiresAt !== undefined && tokens.expiresAt <= Date.now();
        // A confidential client whose keychain secret has gone missing (keychain
        // reset, vault copied to another machine) can still serve requests from the
        // access token on hand, but every refresh from here will fail
        // `invalid_client`. Flag it now rather than letting it read as connected
        // until the token expires and the failure surfaces as a mystery logout.
        const storedSecret = tokenStore.getClientSecret(name);
        const secretMissing = entry.hasClientSecret === true && storedSecret === undefined;
        // An expired access token is only a problem if nothing can renew it. The
        // authorization-code grant needs a refresh token for that;
        // client_credentials needs only the secret it already has, so an expired
        // token there is routine and self-healing — reporting it as 'needs-auth'
        // would point the user at a consent screen that does not exist.
        const canRenew = entry.grantType === 'client_credentials'
          ? storedSecret !== undefined
          : !!tokens.refreshToken;
        const status: OAuthMcpState['status'] = secretMissing
          ? 'needs-auth'
          : (!accessExpired || canRenew) ? 'connected' : 'needs-auth';

        this.connections.set(name, { flow, tokenStore, proxy, asMetadata });
        settings.oauthMcpState[name] = {
          ...this.buildState(name, clientId, storedSecret !== undefined, asMetadata, proxy, tokens, status),
          ...(entry.grantType ? { grantType: entry.grantType } : {}),
          ...(secretMissing
            ? { errorMessage: `The client secret for "${name}" is no longer in the keychain. Reconnect it in Settings to restore token refresh.` }
            : {}),
        };
        dirty = true;
      } catch (err) {
        console.error(`[OAuthMcpRegistry] Failed to reconnect OAuth MCP server "${name}":`, err);
        const previous = settings.oauthMcpState[name];
        settings.oauthMcpState[name] = {
          serverName: name,
          clientId: previous?.clientId ?? entry.clientId ?? '',
          hasClientSecret: previous?.hasClientSecret ?? entry.hasClientSecret ?? false,
          ...(entry.grantType ? { grantType: entry.grantType } : {}),
          asMetadataUrl: previous?.asMetadataUrl ?? entry.authorizationServerUrl ?? '',
          proxyPort: 0,
          status: 'error',
          errorMessage: errorMessage(err),
          accessTokenExpiresAt: previous?.accessTokenExpiresAt,
          hasRefreshToken: previous?.hasRefreshToken ?? false,
          revocationEndpoint: previous?.revocationEndpoint,
          tokenEndpoint: previous?.tokenEndpoint ?? '',
        };
        dirty = true;
      }
    }

    if (dirty) {
      try { await this.host.save(); } catch (err) { console.error('[OAuthMcpRegistry] Could not save state after configure():', err); }
    }
  }

  /**
   * Every running proxy, keyed by server name, ready to merge into a thread's
   * MCP servers.
   *
   * Called once per turn (via `ThreadManager.buildThreadSessionOptions`), so it
   * must be idempotent for a given thread — see `capabilityTokenFor` for why
   * handing back a fresh token here would 403 every already-running session.
   */
  serversForThread(threadId: string): Record<string, McpServerConfig> {
    const result: Record<string, McpServerConfig> = {};
    for (const [name, conn] of this.connections) {
      result[name] = {
        type: 'http',
        url: conn.proxy.url,
        headers: { 'X-Capability-Token': conn.proxy.capabilityTokenFor(threadId) },
      } as McpServerConfig;
    }
    return result;
  }

  /** Cleanup sweep, called from the same manager-event subscription that drives `GoogleWorkspaceMcp.retainThreads`. */
  retainThreads(activeThreadIds: Set<string>): void {
    for (const conn of this.connections.values()) conn.proxy.retainThreads(activeThreadIds);
  }

  /**
   * Full registration flow: discovery, DCR (unless `clientId` is supplied),
   * interactive consent via the injected `openUrl`, then persistence and
   * proxy start. Any failure along the way leaves no partial
   * `oauthMcpServers`/`oauthMcpState` entry and no stray running proxy.
   *
   * With `grantType: 'client_credentials'` the consent leg is replaced by a
   * single token request; DCR is unreachable (the grant requires a `clientId`),
   * and nothing opens a browser.
   */
  async registerServer(entry: OAuthRegistrationEntry): Promise<McpRegistrationResult> {
    const settings = this.host.getSettings();
    if (Object.prototype.hasOwnProperty.call(settings.oauthMcpServers ?? {}, entry.name) || this.connections.has(entry.name)) {
      return { success: false, status: 'conflict', message: `An MCP server named "${entry.name}" already exists.` };
    }

    const grantType = entry.grantType ?? 'authorization_code';
    // Enforced here rather than in `mcpRegistrationSchema` because the Settings
    // modal keeps the typed literal out of the entry it validates — see the
    // matching comment in mcpServerStore.ts. Both entry points reach this line,
    // and this is the only place holding the resolved secret, so it is the one
    // place the rule can actually be checked. Failing before any network call
    // also turns Auth0's opaque "access_denied: Unauthorized" into a named field.
    if (grantType === 'client_credentials') {
      if (!entry.clientId) {
        return { success: false, status: 'failed', message: `"${entry.name}" uses the client_credentials grant, which requires a client ID: there is no browser leg, so the client cannot be registered on the fly.` };
      }
      if (!entry.clientSecret) {
        return { success: false, status: 'failed', message: `"${entry.name}" uses the client_credentials grant, which requires a client secret — a machine-to-machine client cannot be public.` };
      }
    }

    const { flow, tokenStore, setAsMetadata, setGrant } = this.buildPair(entry.name);

    let asMetadata: OAuthASMetadata;
    try {
      // Known gap: OAuthMcpFlow.discoverAS(serverUrl) takes a single URL — there is
      // no separate "trust this AS metadata directly" entry point on OAuthMcpFlow.
      // Per this stage's brief, we don't add new API surface to that file; instead,
      // when the caller already knows the authorization server (authorizationServerUrl),
      // we discover against that URL directly rather than the resource URL. This still
      // performs a discovery round-trip (it does not literally skip discovery), which is
      // the closest fit to the requested behavior given discoverAS's current signature.
      asMetadata = await flow.discoverAS(entry.authorizationServerUrl ?? entry.url);
    } catch (err) {
      return { success: false, status: 'failed', message: `OAuth discovery failed for "${entry.name}": ${errorMessage(err)}` };
    }
    setAsMetadata(asMetadata);

    // When the caller names no scopes, fall back to the ones the *resource*
    // advertises in its RFC 9728 metadata. Without this the authorization
    // request carries no `scope` parameter at all and the AS falls back to its
    // own default grant — which for Atlassian is identity-only, producing a
    // token that authenticates fine (`atlassianUserInfo` works) but 401s every
    // real API call with "scope does not match". A silent, very confusing
    // failure that lands *after* a successful-looking consent.
    //
    // `scopes_supported` is the only machine-readable statement of what the
    // resource needs: Atlassian's AS metadata omits it entirely (null), so the
    // resource half of discovery is the sole source. The SDK already returns it
    // on `OAuthServerInfo.resourceMetadata`, so nothing new is fetched here.
    //
    // Caveat worth knowing: this requests everything the resource advertises,
    // which can exceed what a given user actually wants granted (Atlassian
    // lists 22, spanning Jira, Confluence and Compass). Pass `scopes`
    // explicitly to request least privilege — an explicit value always wins.
    const advertisedScopes = asMetadata.resourceMetadata?.scopes_supported;
    const effectiveScopes = entry.scopes
      ?? (Array.isArray(advertisedScopes) && advertisedScopes.length > 0 ? advertisedScopes.join(' ') : undefined);
    if (!entry.scopes && effectiveScopes) {
      console.log(`[OAuthMcpRegistry] No scopes given for "${entry.name}"; requesting the ${advertisedScopes?.length} advertised by the resource: ${effectiveScopes}`);
    }

    let clientId = entry.clientId;
    // A caller-supplied secret wins; DCR may also issue one below, in which case
    // the AS's value is authoritative for the client it just created.
    let clientSecret = entry.clientSecret;
    if (!clientId) {
      const registrationEndpoint = asMetadata.authorizationServerMetadata?.registration_endpoint;
      if (!registrationEndpoint) {
        return { success: false, status: 'failed', message: `"${entry.name}"'s authorization server does not support Dynamic Client Registration and no clientId was supplied.` };
      }
      try {
        // Resolved gap (previously: "OAuthMcpFlow.authorize() always binds a fresh
        // ephemeral port..."). When the caller supplies `entry.redirectUri` (e.g.
        // Slack, whose registered app expects exactly `http://localhost:3118/callback`),
        // we register that exact string here and pass the same string through to
        // `flow.authorize()` below, so the AS sees an identical redirect_uri on both
        // the DCR registration and the actual authorization request. redirect_uri
        // validation is exact string matching — host and path matter as much as the
        // port, which is why this is a full URI rather than just a port number.
        //
        // When `redirectUri` is omitted, we still register a portless loopback
        // redirect URI, relying on RFC 8252 §7.3 ("the authorization server MUST
        // allow any port to be specified at the time of the request" for loopback
        // IP redirect URIs) so the AS accepts whatever ephemeral port `authorize()`
        // ends up binding. An AS that instead enforces exact redirect_uri matching
        // without a caller-supplied `redirectUri` will reject the later
        // `authorize()` callback — that's the case this option exists to fix.
        const redirectUri = entry.redirectUri ?? 'http://127.0.0.1/callback';
        const registered = await flow.registerClient(registrationEndpoint, redirectUri, effectiveScopes);
        clientId = registered.clientId;
        // We asked for a public client, but RFC 7591 §3.2.1 permits the AS to
        // issue a secret anyway — see registerClient(). Prefer it over anything
        // the caller passed, since it belongs to this freshly created client.
        if (registered.clientSecret !== undefined) clientSecret = registered.clientSecret;
      } catch (err) {
        return { success: false, status: 'failed', message: `Dynamic Client Registration failed for "${entry.name}": ${errorMessage(err)}` };
      }
    }
    tokenStore.storeClientId(entry.name, clientId);
    // Stored before authorize() because the token exchange at the end of that
    // round-trip reads the secret back from the store on the refresh path; the
    // `tokenStore.clear()` in every failure branch below wipes it again.
    if (clientSecret !== undefined) tokenStore.storeClientSecret(entry.name, clientSecret);

    // Set before the first token call so a renewal triggered by an early proxy
    // request cannot fall through to the authorization-code refresh path.
    setGrant({ grantType, clientId, scopes: effectiveScopes, audience: entry.audience });

    let tokens: TokenSet;
    if (grantType === 'client_credentials') {
      try {
        // clientSecret is non-undefined here: the guard at the top of this method
        // rejects a client_credentials entry without one, and the DCR block above
        // is unreachable for this grant (it requires clientId).
        tokens = await flow.clientCredentials({
          serverName: entry.name,
          clientId,
          clientSecret: clientSecret!,
          asMetadata,
          scopes: effectiveScopes,
          audience: entry.audience,
        });
      } catch (err) {
        tokenStore.clear(entry.name);
        // No 'cancelled' status is possible: there is no user in this flow to
        // decline anything, so every failure is a configuration or network fault.
        return { success: false, status: 'failed', message: `Client-credentials token request failed for "${entry.name}": ${errorMessage(err)}` };
      }
    } else {
      try {
        tokens = await flow.authorize({ serverName: entry.name, clientId, clientSecret, asMetadata, scopes: effectiveScopes, redirectUri: entry.redirectUri, audience: entry.audience });
      } catch (err) {
        tokenStore.clear(entry.name);
        const message = errorMessage(err);
        const cancelled = /denied/i.test(message);
        return { success: false, status: cancelled ? 'cancelled' : 'failed', message: `OAuth authorization ${cancelled ? 'was denied' : 'failed'} for "${entry.name}": ${message}` };
      }
    }

    const proxy = new OAuthMcpProxy(entry.name, entry.url, {
      getAccessToken: (n) => tokenStore.getAccessToken(n),
      refresh: (n) => tokenStore.refresh(n),
    }, entry.tools);
    try {
      await proxy.start();
    } catch (err) {
      tokenStore.clear(entry.name);
      return { success: false, status: 'failed', message: `Could not start the local proxy for "${entry.name}": ${errorMessage(err)}` };
    }

    const storedEntry: StoredOAuthMcpServer = {
      url: entry.url,
      // Persist what was actually requested, not what was passed in, so a later
      // reconnect/re-register reproduces this grant instead of silently
      // re-deriving a different one if the resource changes its advertisement.
      scopes: effectiveScopes,
      tools: entry.tools,
      clientId,
      // The flag, never the secret — that stays in the keychain. See
      // StoredOAuthMcpServer.hasClientSecret.
      ...(clientSecret !== undefined ? { hasClientSecret: true } : {}),
      authorizationServerUrl: entry.authorizationServerUrl,
      redirectUri: entry.redirectUri,
      // Only persisted when non-default, so an authorization-code entry written
      // now is byte-identical to one written before this grant existed.
      ...(entry.grantType ? { grantType: entry.grantType } : {}),
      ...(entry.audience !== undefined ? { audience: entry.audience } : {}),
    };
    settings.oauthMcpServers[entry.name] = storedEntry;
    settings.oauthMcpState[entry.name] = {
      ...this.buildState(entry.name, clientId, clientSecret !== undefined, asMetadata, proxy, tokens, 'connected'),
      ...(entry.grantType ? { grantType: entry.grantType } : {}),
    };

    try {
      await this.host.save();
    } catch (err) {
      delete settings.oauthMcpServers[entry.name];
      delete settings.oauthMcpState[entry.name];
      await proxy.stop();
      tokenStore.clear(entry.name);
      return { success: false, status: 'failed', message: `OAuth registration for "${entry.name}" could not be saved: ${errorMessage(err)}` };
    }

    this.connections.set(entry.name, { flow, tokenStore, proxy, asMetadata });
    return { success: true, status: 'registered', message: `"${entry.name}" connected. New threads can now use it.` };
  }

  /** Revokes, stops the proxy, and clears both settings and keychain state for one server. */
  async disconnect(name: string): Promise<void> {
    const settings = this.host.getSettings();
    const conn = this.connections.get(name);
    if (conn) {
      try { await conn.flow.revoke(name, conn.asMetadata); }
      catch (err) { console.error(`[OAuthMcpRegistry] Revocation failed for "${name}" (clearing local state anyway):`, err); }
      await conn.proxy.stop();
      this.connections.delete(name);
    } else {
      // No live connection (e.g. it never successfully reconnected in configure()) —
      // still clear any keychain state directly so a stale entry can't relink silently.
      new OAuthTokenStore(this.host.secretStorage, () => Promise.reject(new Error('disconnect does not refresh'))).clear(name);
    }
    delete settings.oauthMcpServers[name];
    delete settings.oauthMcpState[name];
    await this.host.save();
  }

  /** Current status for the Settings UI. */
  status(name: string): OAuthMcpState | undefined {
    return this.host.getSettings().oauthMcpState[name];
  }

  /** Plugin unload: stop every proxy. Mirrors `GoogleWorkspaceMcp.close()` — fire-and-forget, not awaited. */
  close(): void {
    for (const conn of this.connections.values()) void conn.proxy.stop();
    this.connections.clear();
  }
}

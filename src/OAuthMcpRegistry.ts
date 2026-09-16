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
 * access/refresh tokens and the DCR-issued client_id live only in the OS
 * keychain via `OAuthTokenStore` — never here, never in data.json.
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
  authorizationServerUrl?: string;
  redirectUri?: string;
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
   */
  private buildPair(serverName: string): { flow: OAuthMcpFlow; tokenStore: OAuthTokenStore; setAsMetadata: (m: OAuthASMetadata) => void } {
    let asMetadata: OAuthASMetadata | undefined;
    let flow: OAuthMcpFlow;
    const tokenStore: OAuthTokenStore = new OAuthTokenStore(this.host.secretStorage, (name: string): Promise<TokenSet> => {
      if (!asMetadata) return Promise.reject(new Error(`No cached authorization-server metadata for "${name}"; re-authorize in Settings.`));
      return flow.refresh(name, asMetadata);
    });
    // Must be the requestUrl-backed fetch, not the renderer's: see
    // src/requestUrlFetch.ts. `this.host.fetchFn` lets tests inject a stub.
    flow = new OAuthMcpFlow(tokenStore, this.host.openUrl, this.host.fetchFn ?? createRequestUrlFetch());
    return { flow, tokenStore, setAsMetadata: (m: OAuthASMetadata) => { asMetadata = m; } };
  }

  private buildState(name: string, clientId: string, asMetadata: OAuthASMetadata, proxy: OAuthMcpProxy, tokens: TokenSet, status: OAuthMcpState['status']): OAuthMcpState {
    return {
      serverName: name,
      clientId,
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

        const { flow, tokenStore, setAsMetadata } = this.buildPair(name);
        const asMetadata = await flow.discoverAS(entry.authorizationServerUrl ?? entry.url);
        setAsMetadata(asMetadata);

        const proxy = new OAuthMcpProxy(name, entry.url, {
          getAccessToken: (n) => tokenStore.getAccessToken(n),
          refresh: (n) => tokenStore.refresh(n),
        }, entry.tools);
        await proxy.start();

        const clientId = tokenStore.getClientId(name) ?? entry.clientId ?? '';
        const accessExpired = tokens.expiresAt !== undefined && tokens.expiresAt <= Date.now();
        const status: OAuthMcpState['status'] = (!accessExpired || tokens.refreshToken) ? 'connected' : 'needs-auth';

        this.connections.set(name, { flow, tokenStore, proxy, asMetadata });
        settings.oauthMcpState[name] = this.buildState(name, clientId, asMetadata, proxy, tokens, status);
        dirty = true;
      } catch (err) {
        console.error(`[OAuthMcpRegistry] Failed to reconnect OAuth MCP server "${name}":`, err);
        const previous = settings.oauthMcpState[name];
        settings.oauthMcpState[name] = {
          serverName: name,
          clientId: previous?.clientId ?? entry.clientId ?? '',
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
   */
  async registerServer(entry: OAuthRegistrationEntry): Promise<McpRegistrationResult> {
    const settings = this.host.getSettings();
    if (Object.prototype.hasOwnProperty.call(settings.oauthMcpServers ?? {}, entry.name) || this.connections.has(entry.name)) {
      return { success: false, status: 'conflict', message: `An MCP server named "${entry.name}" already exists.` };
    }

    const { flow, tokenStore, setAsMetadata } = this.buildPair(entry.name);

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

    let clientId = entry.clientId;
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
        clientId = await flow.registerClient(registrationEndpoint, redirectUri, entry.scopes);
      } catch (err) {
        return { success: false, status: 'failed', message: `Dynamic Client Registration failed for "${entry.name}": ${errorMessage(err)}` };
      }
    }
    tokenStore.storeClientId(entry.name, clientId);

    let tokens: TokenSet;
    try {
      tokens = await flow.authorize({ serverName: entry.name, clientId, asMetadata, scopes: entry.scopes, redirectUri: entry.redirectUri });
    } catch (err) {
      tokenStore.clear(entry.name);
      const message = errorMessage(err);
      const cancelled = /denied/i.test(message);
      return { success: false, status: cancelled ? 'cancelled' : 'failed', message: `OAuth authorization ${cancelled ? 'was denied' : 'failed'} for "${entry.name}": ${message}` };
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
      scopes: entry.scopes,
      tools: entry.tools,
      clientId,
      authorizationServerUrl: entry.authorizationServerUrl,
      redirectUri: entry.redirectUri,
    };
    settings.oauthMcpServers[entry.name] = storedEntry;
    settings.oauthMcpState[entry.name] = this.buildState(entry.name, clientId, asMetadata, proxy, tokens, 'connected');

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

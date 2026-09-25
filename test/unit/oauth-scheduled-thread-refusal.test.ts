/**
 * `ClaudeThreadsPlugin.registerExternalMcpServer()` (src/main.ts, ~line 2109)
 * refuses to register ANY `oauth`-type MCP server — regardless of `grantType`
 * — when the caller is not interactive. That guard exists because OAuth
 * registration grants tools to every future thread, and a scheduled/cron
 * thread has no human present to confirm that, even for `client_credentials`,
 * which opens no consent screen and needs nobody present for the token
 * request itself (see the comment directly above the guard in main.ts).
 *
 * `mcp-registration.test.ts` covers the equivalent `interactive:false`
 * refusal for the non-oauth (`createMcpRegistration`) path
 * ("cancels without changes and rejects unavailable or scheduled
 * confirmation"); this file is the oauth-path parallel, covering both grant
 * types so a future change that exempts `client_credentials` from the guard
 * (plausible, since it needs no browser) doesn't silently reopen the gap the
 * comment in main.ts explains.
 *
 * Constructed the same way as save-settings-race.test.ts: a minimal instance
 * via Object.create(ClaudeThreadsPlugin.prototype), bypassing Obsidian's
 * Plugin constructor, with only the fields this code path touches set.
 */
import { describe, expect, it, vi } from 'vitest';
import ClaudeThreadsPlugin from '../../src/main';

function makePlugin() {
  const plugin = Object.create(ClaudeThreadsPlugin.prototype) as ClaudeThreadsPlugin;
  const registerServer = vi.fn(async () => ({ success: true, status: 'registered' as const, message: 'ok' }));
  // Present so a bug that skipped the interactive guard would be caught by
  // "registerServer was never called" rather than by a crash reaching for a
  // missing dependency, which would pass for the wrong reason.
  (plugin as unknown as { oauthMcpRegistry: { registerServer: typeof registerServer } }).oauthMcpRegistry = { registerServer };
  // Only reached by the interactive "control" case below (a client_credentials
  // clientSecret placeholder is resolved via secretStorage before reaching
  // oauthMcpRegistry.registerServer) — the refused/non-interactive cases return
  // before touching it, but it's cheap to provide unconditionally.
  (plugin as unknown as { app: { secretStorage: { getSecret: (key: string) => string } } }).app = {
    secretStorage: { getSecret: () => 'resolved-secret-value' },
  };
  return { plugin, registerServer };
}

/** Calls the private dispatcher the same way both real callers do. */
function registerExternal(plugin: ClaudeThreadsPlugin, input: unknown, interactive: boolean) {
  return (plugin as unknown as { registerExternalMcpServer(input: unknown, interactive: boolean): Promise<{ success: boolean; status?: string; message: string }> })
    .registerExternalMcpServer(input, interactive);
}

describe('registerExternalMcpServer — scheduled-thread refusal for oauth servers', () => {
  it('refuses an authorization_code oauth registration from a non-interactive (scheduled) caller', async () => {
    const { plugin, registerServer } = makePlugin();

    const result = await registerExternal(plugin, { name: 'vercel', type: 'oauth', url: 'https://mcp.vercel.com/' }, false);

    expect(result).toMatchObject({
      success: false,
      status: 'unavailable',
      message: 'Interactive host confirmation is unavailable. Register this server from an interactive thread.',
    });
    expect(registerServer).not.toHaveBeenCalled();
  });

  /**
   * The new coverage: client_credentials opens no browser and needs no human
   * to complete its own token request, which is exactly the reasoning a
   * future change might use to exempt it from this guard. It must still be
   * refused, because what the guard protects is host confirmation of a new
   * MCP server being granted to every future thread, not the token request.
   */
  it('refuses a client_credentials oauth registration from a non-interactive (scheduled) caller too', async () => {
    const { plugin, registerServer } = makePlugin();

    const result = await registerExternal(plugin, {
      name: 'bankrate',
      type: 'oauth',
      url: 'https://products-mcp.bankrate.com/mcp',
      grantType: 'client_credentials',
      clientId: 'm2m-client',
      clientSecret: '${BANKRATE_CLIENT_SECRET}',
      audience: 'bankrate-api',
    }, false);

    expect(result).toMatchObject({
      success: false,
      status: 'unavailable',
      message: 'Interactive host confirmation is unavailable. Register this server from an interactive thread.',
    });
    expect(registerServer).not.toHaveBeenCalled();
  });

  it('allows an interactive caller through to the registry for both grant types (control)', async () => {
    const { plugin, registerServer } = makePlugin();

    const authCode = await registerExternal(plugin, { name: 'vercel', type: 'oauth', url: 'https://mcp.vercel.com/' }, true);
    expect(authCode).toMatchObject({ success: true, status: 'registered' });

    const clientCreds = await registerExternal(plugin, {
      name: 'bankrate',
      type: 'oauth',
      url: 'https://products-mcp.bankrate.com/mcp',
      grantType: 'client_credentials',
      clientId: 'm2m-client',
      clientSecret: '${BANKRATE_CLIENT_SECRET}',
    }, true);
    expect(clientCreds).toMatchObject({ success: true, status: 'registered' });

    expect(registerServer).toHaveBeenCalledTimes(2);
  });
});

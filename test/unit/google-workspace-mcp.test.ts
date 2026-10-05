import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleWorkspaceMcp } from '../../src/GoogleWorkspaceMcp';
import { codexMcpServers } from '../../src/CodexSession';
import { mergeMcpServers } from '../../src/mcpServerMerge';

const instances: GoogleWorkspaceMcp[] = [];
afterEach(() => instances.forEach(instance => instance.close()));
function setup(tokenTimeoutMs = 30_000) {
  let tokens = { accessToken: 'GOOGLE_SECRET', refreshToken: 'REFRESH_SECRET', expiresAt: Date.now() + 3600000 };
  const plugin = { settings: { authProxyUrl: 'https://auth.example.com' }, tokenStore: {
    supportsConnectionGuard: true,
    get: () => tokens,
    getValidAccessToken: vi.fn(async () => tokens.accessToken),
  } };
  const fetchUpstream = vi.fn(async () => new Response('{"jsonrpc":"2.0","result":{"tools":[{"name":"vendor_write"}]}}', { headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-1' } }));
  const proxy = new GoogleWorkspaceMcp(() => plugin, fetchUpstream, tokenTimeoutMs);
  instances.push(proxy);
  return { plugin, proxy, fetchUpstream, setTokens: (value: typeof tokens) => { tokens = value; } };
}
async function call(config: { url: string; headers: Record<string, string> }, extra: RequestInit = {}) {
  return fetch(config.url, { method: 'POST', headers: { ...config.headers, 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-03-26' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', ...extra });
}
describe('Google Workspace MCP connection', () => {
  it('routes Gmail and Calendar to their vendor hosts and explains scope failures', async () => {
    const f = setup(); await f.proxy.configure({ gmail: true, calendar: true });
    const servers = f.proxy.serversForThread('thread');
    expect(Object.keys(servers)).toEqual(['google-gmail', 'google-calendar']);
    expect((await call(servers['google-gmail'])).status).toBe(200);
    expect(f.fetchUpstream).toHaveBeenLastCalledWith('https://gmailmcp.googleapis.com/mcp/v1', expect.anything());
    expect((await call(servers['google-calendar'])).status).toBe(200);
    expect(f.fetchUpstream).toHaveBeenLastCalledWith('https://calendarmcp.googleapis.com/mcp/v1', expect.anything());
    expect(f.proxy.status()).toContain('reconnect your account in Google Docs Sync');
  });
  it('omits the scope hint when only the original services are enabled', async () => {
    const f = setup(); await f.proxy.configure({ docs: true });
    expect(f.proxy.status()).not.toContain('Gmail');
  });
  it('exposes all selected vendor servers with opaque local credentials and untouched payloads', async () => {
    const f = setup(); await f.proxy.configure({ docs: true, drive: true, sheets: true, slides: true });
    const servers = f.proxy.serversForThread('thread');
    expect(Object.keys(servers)).toEqual(['google-docs', 'google-drive', 'google-drive-files', 'google-sheets', 'google-slides']);
    expect(JSON.stringify(servers)).not.toContain('SECRET');
    const res = await call(servers['google-sheets']);
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBe('session-1');
    expect(await res.text()).toContain('vendor_write');
    expect(f.fetchUpstream).toHaveBeenCalledWith('https://sheetsmcp.googleapis.com/mcp/v1', expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer GOOGLE_SECRET' }) }));
  });
  it('does not start or expose services before opt-in and a compatible connection', async () => {
    const f = setup(); expect(f.proxy.serversForThread('thread')).toEqual({});
    f.plugin.tokenStore.supportsConnectionGuard = false;
    await f.proxy.configure({ docs: true });
    expect(f.proxy.serversForThread('thread')).toEqual({});
    expect(f.proxy.status()).toContain('Update Google Docs Sync');
  });
  it('refreshes per request but preserves thread capabilities across calls', async () => {
    const f = setup(); await f.proxy.configure({ docs: true });
    const config = f.proxy.serversForThread('thread')['google-docs'];
    await call(config);
    f.setTokens({ accessToken: 'NEW_ACCESS', refreshToken: 'REFRESH_SECRET', expiresAt: Date.now() + 3600000 });
    await call(config);
    expect(f.plugin.tokenStore.getValidAccessToken).toHaveBeenCalledTimes(2);
    expect(f.proxy.serversForThread('thread')['google-docs']).toEqual(config);
  });
  it('exposes stable SDK bridge configs for VM-routed Claude while preserving host configs', async () => {
    const f = setup(); await f.proxy.configure({ docs: true, drive: true });
    const first = f.proxy.vmServersForThread('thread');
    const second = f.proxy.vmServersForThread('thread');
    expect(Object.keys(first)).toEqual(['google-docs', 'google-drive', 'google-drive-files']);
    expect(first['google-docs']).toMatchObject({ type: 'sdk', name: 'google-docs', instance: expect.any(Object) });
    expect(second['google-docs']).toBe(first['google-docs']);
    expect(f.proxy.serversForThread('thread')['google-docs']).toMatchObject({ type: 'http' });
  });
  it('revokes old threads on reconnect and never silently rebinds them', async () => {
    const f = setup(); await f.proxy.configure({ docs: true });
    const config = f.proxy.serversForThread('thread')['google-docs'];
    f.setTokens({ accessToken: 'NEW_ACCOUNT', refreshToken: 'NEW_REFRESH', expiresAt: Date.now() + 3600000 });
    expect((await call(config)).status).toBe(409);
    expect(f.proxy.serversForThread('thread')).toEqual({});
    expect(f.proxy.serversForThread('new-thread')['google-docs']).toBeDefined();
    expect(f.fetchUpstream).not.toHaveBeenCalled();
  });
  it('revokes disabled service capabilities even after re-enabling', async () => {
    const f = setup(); await f.proxy.configure({ docs: true });
    const config = f.proxy.serversForThread('thread')['google-docs'];
    await f.proxy.configure({ docs: false }); await f.proxy.configure({ docs: true });
    expect((await call(config)).status).toBe(409);
    expect(f.proxy.serversForThread('thread')).toEqual({});
  });
  it('rejects arbitrary paths, browser origins and missing capabilities before token access', async () => {
    const f = setup(); await f.proxy.configure({ docs: true });
    const config = f.proxy.serversForThread('thread')['google-docs'];
    expect((await call({ ...config, url: config.url + '?url=https://evil.example.com' })).status).toBe(404);
    expect((await call(config, { headers: { ...config.headers, Origin: 'https://evil.example.com' } })).status).toBe(403);
    expect((await call(config, { headers: {} })).status).toBe(401);
    expect(f.plugin.tokenStore.getValidAccessToken).not.toHaveBeenCalled();
  });
  it('sanitizes credential refresh failures', async () => {
    const f = setup(); await f.proxy.configure({ docs: true });
    f.plugin.tokenStore.getValidAccessToken.mockRejectedValue(new Error('SECRET_TOKEN'));
    const res = await call(f.proxy.serversForThread('thread')['google-docs']);
    expect(res.status).toBe(502); expect(await res.text()).not.toContain('SECRET_TOKEN');
  });
  it('passes the same vendor and local-transfer configurations to Claude and Codex adapters', async () => {
    const f = setup(); await f.proxy.configure({ docs: true, drive: true, sheets: true, slides: true });
    const servers = mergeMcpServers({ claude_threads: { type: 'sdk' as const, name: 'threads', instance: {} as never } }, f.proxy.serversForThread('thread'));
    const codex = codexMcpServers(servers);
    expect(Object.keys(codex)).toEqual(['google-docs', 'google-drive', 'google-drive-files', 'google-sheets', 'google-slides']);
    for (const service of ['docs', 'drive', 'drive-files', 'sheets', 'slides']) {
      const server = servers[`google-${service}`] as { url: string; headers: Record<string, string> };
      expect(codex[`google-${service}`]).toEqual({ url: server.url, http_headers: server.headers });
    }
  });
  it.each(['GET', 'DELETE'])('preserves %s and MCP session headers', async (method) => {
    const f = setup(); await f.proxy.configure({ docs: true });
    f.fetchUpstream.mockImplementation(async () => new Response(null, { status: 204 }));
    const config = f.proxy.serversForThread('thread')['google-docs'];
    const res = await call(config, { method, body: undefined, headers: { ...config.headers, 'Mcp-Session-Id': 'session', 'Last-Event-ID': 'event' } });
    expect(res.status).toBe(204);
    expect(f.fetchUpstream).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method, body: undefined, headers: expect.objectContaining({ 'mcp-session-id': 'session', 'last-event-id': 'event' }) }));
  });
  it('preserves SSE bytes and strips redirect/cookie headers', async () => {
    const f = setup(); await f.proxy.configure({ docs: true });
    f.fetchUpstream.mockImplementation(async () => new Response('event: message\ndata: {"result":{"isError":true}}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream', Location: 'https://evil.example.com', 'Set-Cookie': 'secret=value' } }));
    const res = await call(f.proxy.serversForThread('thread')['google-docs']);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.has('set-cookie')).toBe(false); expect(res.headers.has('location')).toBe(false);
    expect(await res.text()).toBe('event: message\ndata: {"result":{"isError":true}}\n\n');
  });
  it('preserves Google access errors and retry headers without interpreting tool operations', async () => {
    const f = setup(); await f.proxy.configure({ drive: true });
    f.fetchUpstream.mockImplementation(async () => new Response('{"result":{"isError":true}}', { status: 403, headers: { 'Retry-After': '60' } }));
    const res = await call(f.proxy.serversForThread('thread')['google-drive']);
    expect(res.status).toBe(403); expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.text()).toBe('{"result":{"isError":true}}');
  });
  it('revokes on refresh-token rotation before forwarding a request', async () => {
    const f = setup(); await f.proxy.configure({ docs: true });
    f.plugin.tokenStore.getValidAccessToken.mockImplementation(async () => {
      f.setTokens({ accessToken: 'ROTATED', refreshToken: 'ROTATED_REFRESH', expiresAt: 1 }); return 'ROTATED';
    });
    expect((await call(f.proxy.serversForThread('thread')['google-docs'])).status).toBe(409);
    expect(f.fetchUpstream).not.toHaveBeenCalled();
    expect(f.proxy.status()).toContain('changed');
    f.proxy.serversForThread('new-thread');
    expect(f.proxy.status()).toContain('Connected through');
  });
  it('revokes removed threads and closes the listener on unload', async () => {
    const f = setup(); await f.proxy.configure({ docs: true });
    const config = f.proxy.serversForThread('thread')['google-docs'];
    f.proxy.retainThreads(new Set()); expect((await call(config)).status).toBe(401);
    f.proxy.close(); await expect(call(config)).rejects.toThrow();
  });
  it('bounds a hung peer token getter so later requests can proceed', async () => {
    const f = setup(15); await f.proxy.configure({ docs: true });
    f.plugin.tokenStore.getValidAccessToken.mockImplementationOnce(() => new Promise(() => {}));
    const config = f.proxy.serversForThread('thread')['google-docs'];
    expect((await call(config)).status).toBe(502);
    expect((await call(config)).status).toBe(200);
  });
  it('persists identity before forwarding and refuses a changed account after reload', async () => {
    const f = setup();
    const persistence = { bindings: {}, save: vi.fn(async () => {}) };
    const first = new GoogleWorkspaceMcp(() => f.plugin, f.fetchUpstream, 30000, persistence); instances.push(first);
    await first.configure({ docs: true });
    expect((await call(first.serversForThread('thread')['google-docs'])).status).toBe(200);
    expect(persistence.save).toHaveBeenCalled();
    expect(JSON.stringify(persistence.bindings)).not.toContain('SECRET');
    first.close();
    f.setTokens({ accessToken: 'SECOND', refreshToken: 'SECOND_REFRESH', expiresAt: 1 });
    const second = new GoogleWorkspaceMcp(() => f.plugin, f.fetchUpstream, 30000, persistence); instances.push(second);
    await second.configure({ docs: true });
    expect(second.serversForThread('thread')).toEqual({});
    expect(second.serversForThread('new-thread')['google-docs']).toBeDefined();
  });
  it('fails closed if initial binding cannot be persisted', async () => {
    const f = setup();
    const proxy = new GoogleWorkspaceMcp(() => f.plugin, f.fetchUpstream, 30000, { bindings: {}, save: async () => { throw new Error('disk failure'); } }); instances.push(proxy);
    await proxy.configure({ docs: true });
    expect((await call(proxy.serversForThread('thread')['google-docs'])).status).toBe(502);
    expect(f.fetchUpstream).not.toHaveBeenCalled();
  });
  it('keeps the same connection and initial service selection after reload', async () => {
    const f = setup(); const persistence = { bindings: {}, save: async () => {} };
    const first = new GoogleWorkspaceMcp(() => f.plugin, f.fetchUpstream, 30000, persistence); instances.push(first);
    await first.configure({ docs: true }); const prior = first.serversForThread('thread')['google-docs'];
    await call(prior); first.close();
    const second = new GoogleWorkspaceMcp(() => f.plugin, f.fetchUpstream, 30000, persistence); instances.push(second);
    await second.configure({ docs: true, slides: true }); const servers = second.serversForThread('thread');
    expect(Object.keys(servers)).toEqual(['google-docs']); expect(servers['google-docs'].headers).not.toEqual(prior.headers);
    expect((await call(servers['google-docs'])).status).toBe(200);
  });
  it('contains storage failures while disabling instead of failing plugin startup', async () => {
    const f = setup(); const persistence = { bindings: { thread: { fingerprint: 'old', services: ['docs' as const] } }, save: async () => { throw new Error('storage'); } };
    const proxy = new GoogleWorkspaceMcp(() => f.plugin, f.fetchUpstream, 30000, persistence); instances.push(proxy);
    await expect(proxy.configure({ docs: false })).resolves.toBeUndefined();
    expect(proxy.status()).toContain('could not be saved');
  });
  it('does not forward a queued request after its thread is removed', async () => {
    const f = setup(); await f.proxy.configure({ docs: true });
    let release!: (token: string) => void;
    f.plugin.tokenStore.getValidAccessToken.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = call(f.proxy.serversForThread('thread')['google-docs']);
    await vi.waitFor(() => expect(release).toBeDefined());
    f.proxy.retainThreads(new Set()); release('GOOGLE_SECRET');
    expect((await pending).status).toBe(409); expect(f.fetchUpstream).not.toHaveBeenCalled();
  });
});

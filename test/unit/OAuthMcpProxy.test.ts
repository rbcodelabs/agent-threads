import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuthMcpProxy, type ProxyTokenStore, type ToolFilter } from '../../src/OAuthMcpProxy';

interface UpstreamResponse {
  status: number;
  headers: Headers;
  body: AsyncIterable<Uint8Array> | null;
}
type Upstream = (url: string, options: { method?: string; headers: Record<string, string>; body?: Buffer; signal?: AbortSignal }) => Promise<UpstreamResponse>;

const instances: OAuthMcpProxy[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map((p) => p.stop())); });

function jsonUpstream(payload: unknown, status = 200): Upstream {
  return vi.fn(async () => ({
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: (async function* () { yield Buffer.from(JSON.stringify(payload)); })(),
  }));
}

function setup(opts: { toolFilter?: ToolFilter; upstream?: Upstream; accessToken?: string | null } = {}) {
  let accessToken: string | null = opts.accessToken !== undefined ? opts.accessToken : 'token-1';
  const getAccessToken = vi.fn(async () => accessToken);
  const refresh = vi.fn(async () => { accessToken = 'token-2'; });
  const tokenStore: ProxyTokenStore = { getAccessToken, refresh };
  const upstream = opts.upstream ?? jsonUpstream({ jsonrpc: '2.0', result: { tools: [{ name: 'a' }, { name: 'b' }] } });
  const proxy = new OAuthMcpProxy('vercel', 'https://mcp.vercel.com/', tokenStore, opts.toolFilter, upstream);
  instances.push(proxy);
  return { proxy, tokenStore, upstream, getAccessToken, refresh, setAccessToken: (v: string | null) => { accessToken = v; } };
}

describe('OAuthMcpProxy — capability tokens', () => {
  it('rejects a request with no capability token', async () => {
    const { proxy } = setup();
    await proxy.start();
    const res = await fetch(proxy.url, { method: 'POST', body: '{}' });
    expect(res.status).toBe(403);
  });

  it('rejects a request with an unrecognized capability token', async () => {
    const { proxy } = setup();
    await proxy.start();
    const res = await fetch(proxy.url, { method: 'POST', headers: { 'x-capability-token': 'not-a-real-token' }, body: '{}' });
    expect(res.status).toBe(403);
  });

  it('accepts a request with a minted capability token, and rejects it again after revocation', async () => {
    const { proxy } = setup();
    await proxy.start();
    const token = proxy.capabilityTokenFor('thread-1');
    const ok = await fetch(proxy.url, { method: 'POST', headers: { 'x-capability-token': token }, body: '{}' });
    expect(ok.status).toBe(200);

    proxy.revokeCapabilityToken('thread-1');
    const after = await fetch(proxy.url, { method: 'POST', headers: { 'x-capability-token': token }, body: '{}' });
    expect(after.status).toBe(403);
  });

  // The second-turn 403. ThreadManager rebuilds a thread's session options on
  // every turn, which calls back in here, but a resumed session keeps the
  // headers its Query was spawned with. If this handed back a fresh token the
  // already-running MCP client's token would be evicted and every tool call
  // from turn 2 onward would fail with "Invalid or missing capability token."
  it('keeps a live token valid when the same thread asks for its token again', async () => {
    const { proxy } = setup();
    await proxy.start();
    const turn1 = proxy.capabilityTokenFor('thread-1');

    const turn2 = proxy.capabilityTokenFor('thread-1');
    expect(turn2).toBe(turn1);

    // The token the running session is still presenting must keep working.
    const res = await fetch(proxy.url, { method: 'POST', headers: { 'x-capability-token': turn1 }, body: '{}' });
    expect(res.status).toBe(200);
  });

  it('stays stable across many turns without accumulating tokens', async () => {
    const { proxy } = setup();
    await proxy.start();
    const tokens = new Set(Array.from({ length: 10 }, () => proxy.capabilityTokenFor('thread-1')));
    expect(tokens.size).toBe(1);

    // One entry, so a single revoke still fully de-authorizes the thread —
    // rotation would have orphaned nine unreachable-but-live map entries.
    proxy.revokeCapabilityToken('thread-1');
    const res = await fetch(proxy.url, { method: 'POST', headers: { 'x-capability-token': [...tokens][0] }, body: '{}' });
    expect(res.status).toBe(403);
  });

  it('issues distinct tokens to different threads', async () => {
    const { proxy } = setup();
    await proxy.start();
    expect(proxy.capabilityTokenFor('thread-1')).not.toBe(proxy.capabilityTokenFor('thread-2'));
  });

  it('mints a fresh token after revocation rather than resurrecting the old one', async () => {
    const { proxy } = setup();
    await proxy.start();
    const first = proxy.capabilityTokenFor('thread-1');
    proxy.revokeCapabilityToken('thread-1');
    const second = proxy.capabilityTokenFor('thread-1');

    expect(second).not.toBe(first);
    const stale = await fetch(proxy.url, { method: 'POST', headers: { 'x-capability-token': first }, body: '{}' });
    expect(stale.status).toBe(403);
    const fresh = await fetch(proxy.url, { method: 'POST', headers: { 'x-capability-token': second }, body: '{}' });
    expect(fresh.status).toBe(200);
  });

  it('returns 401 with a structured MCP error when no access token is available', async () => {
    const { proxy } = setup({ accessToken: null });
    await proxy.start();
    const token = proxy.capabilityTokenFor('thread-1');
    const res = await fetch(proxy.url, { method: 'POST', headers: { 'x-capability-token': token }, body: '{}' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32001 } });
  });
});

describe('OAuthMcpProxy — tool filtering', () => {
  it('filters a tools/list response by an allow list', async () => {
    const { proxy } = setup({ toolFilter: { allow: ['a'] } });
    await proxy.start();
    const token = proxy.capabilityTokenFor('thread-1');
    const res = await fetch(proxy.url, {
      method: 'POST', headers: { 'x-capability-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const body = await res.json();
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(['a']);
  });

  it('filters a tools/list response by a deny list', async () => {
    const { proxy } = setup({ toolFilter: { deny: ['a'] } });
    await proxy.start();
    const token = proxy.capabilityTokenFor('thread-1');
    const res = await fetch(proxy.url, {
      method: 'POST', headers: { 'x-capability-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const body = await res.json();
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(['b']);
  });

  it('passes tools/list through unfiltered with no toolFilter configured', async () => {
    const { proxy } = setup();
    await proxy.start();
    const token = proxy.capabilityTokenFor('thread-1');
    const res = await fetch(proxy.url, {
      method: 'POST', headers: { 'x-capability-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const body = await res.json();
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(['a', 'b']);
  });

  it('blocks a denied tools/call with a -32601 MCP error, matching the request id, without contacting upstream', async () => {
    const { proxy, upstream } = setup({ toolFilter: { deny: ['buy_pro'] } });
    await proxy.start();
    const token = proxy.capabilityTokenFor('thread-1');
    const res = await fetch(proxy.url, {
      method: 'POST', headers: { 'x-capability-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'buy_pro' } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32601, message: expect.stringContaining('buy_pro') } });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('lets a non-denied tools/call through to upstream', async () => {
    const upstream = jsonUpstream({ jsonrpc: '2.0', id: 9, result: { ok: true } });
    const { proxy } = setup({ toolFilter: { deny: ['buy_pro'] }, upstream });
    await proxy.start();
    const token = proxy.capabilityTokenFor('thread-1');
    const res = await fetch(proxy.url, {
      method: 'POST', headers: { 'x-capability-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'list_projects' } }),
    });
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('allows an allow-listed tools/call through and blocks a non-listed one', async () => {
    const upstream = jsonUpstream({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    const { proxy } = setup({ toolFilter: { allow: ['list_projects'] }, upstream });
    await proxy.start();
    const token = proxy.capabilityTokenFor('thread-1');
    const call = (name: string) => fetch(proxy.url, {
      method: 'POST', headers: { 'x-capability-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } }),
    });
    expect((await call('list_projects')).status).toBe(200);
    const blocked = await call('buy_pro');
    expect((await blocked.json()).error.code).toBe(-32601);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

describe('OAuthMcpProxy — 401 refresh-and-retry', () => {
  it('refreshes once and retries once on an upstream 401', async () => {
    let calls = 0;
    const upstream: Upstream = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { status: 401, headers: new Headers(), body: null };
      return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: (async function* () { yield Buffer.from('{"jsonrpc":"2.0","result":{}}'); })() };
    });
    const { proxy, refresh } = setup({ upstream });
    await proxy.start();
    const token = proxy.capabilityTokenFor('thread-1');
    const res = await fetch(proxy.url, { method: 'POST', headers: { 'x-capability-token': token }, body: '{}' });
    expect(res.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('does not retry more than once when the retry also 401s', async () => {
    const upstream: Upstream = vi.fn(async () => ({ status: 401, headers: new Headers(), body: null }));
    const { proxy, refresh } = setup({ upstream });
    await proxy.start();
    const token = proxy.capabilityTokenFor('thread-1');
    const res = await fetch(proxy.url, { method: 'POST', headers: { 'x-capability-token': token }, body: '{}' });
    expect(res.status).toBe(401);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('forwards the refreshed token on retry', async () => {
    const seenTokens: string[] = [];
    const upstream: Upstream = vi.fn(async (_url, options) => {
      seenTokens.push(options.headers.Authorization);
      if (seenTokens.length === 1) return { status: 401, headers: new Headers(), body: null };
      return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: (async function* () { yield Buffer.from('{}'); })() };
    });
    const { proxy } = setup({ upstream, accessToken: 'stale-token' });
    await proxy.start();
    const token = proxy.capabilityTokenFor('thread-1');
    await fetch(proxy.url, { method: 'POST', headers: { 'x-capability-token': token }, body: '{}' });
    expect(seenTokens).toEqual(['Bearer stale-token', 'Bearer token-2']);
  });
});

describe('OAuthMcpProxy — SSE pass-through', () => {
  it('streams an SSE response chunk by chunk instead of buffering the full body', async () => {
    const parts = ['event: message\ndata: {"n":1}\n\n', 'event: message\ndata: {"n":2}\n\n'];
    const upstream: Upstream = vi.fn(async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: (async function* () {
        for (const part of parts) {
          yield Buffer.from(part);
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      })(),
    }));
    const { proxy } = setup({ upstream });
    await proxy.start();
    const token = proxy.capabilityTokenFor('thread-1');

    const res = await fetch(proxy.url, { method: 'POST', headers: { 'x-capability-token': token }, body: '{}' });
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const arrivals: number[] = [];
    let received = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arrivals.push(Date.now());
      received += decoder.decode(value);
    }

    expect(received).toBe(parts.join(''));
    // Proves the response was actually streamed rather than buffered and sent as one
    // chunk at the end: at least two separate arrivals, spaced out by real time.
    expect(arrivals.length).toBeGreaterThanOrEqual(2);
    expect(arrivals[arrivals.length - 1] - arrivals[0]).toBeGreaterThanOrEqual(25);
  }, 10_000);

  it('does not apply tools/list filtering to an SSE response even if requested', async () => {
    const upstream: Upstream = vi.fn(async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: (async function* () { yield Buffer.from('event: message\ndata: {"result":{"tools":[{"name":"a"},{"name":"b"}]}}\n\n'); })(),
    }));
    const { proxy } = setup({ toolFilter: { deny: ['a'] }, upstream });
    await proxy.start();
    const token = proxy.capabilityTokenFor('thread-1');
    const res = await fetch(proxy.url, {
      method: 'POST', headers: { 'x-capability-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const text = await res.text();
    expect(text).toContain('"name":"a"');
    expect(text).toContain('"name":"b"');
  });
});

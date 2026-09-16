import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuthMcpProxy, type ProxyTokenStore } from '../../src/OAuthMcpProxy';

interface UpstreamResponse {
  status: number;
  headers: Headers;
  body: AsyncIterable<Uint8Array> | null;
}
type Upstream = (url: string, options: { method?: string; headers: Record<string, string>; body?: Buffer; signal?: AbortSignal }) => Promise<UpstreamResponse>;

const instances: OAuthMcpProxy[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map((p) => p.stop())); });

/** Stub upstream — a fixed 200 JSON body, never touching the real network. */
const stubUpstream: Upstream = vi.fn(async () => ({
  status: 200,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: (async function* () { yield Buffer.from(JSON.stringify({ jsonrpc: '2.0', result: {} })); })(),
}));

function setup() {
  const tokenStore: ProxyTokenStore = {
    getAccessToken: vi.fn(async () => 'token-1'),
    refresh: vi.fn(async () => {}),
  };
  const proxy = new OAuthMcpProxy('vercel', 'https://mcp.vercel.com/', tokenStore, undefined, stubUpstream);
  instances.push(proxy);
  return proxy;
}

async function requestWith(proxy: OAuthMcpProxy, token: string): Promise<number> {
  const res = await fetch(proxy.url, { method: 'POST', headers: { 'x-capability-token': token }, body: '{}' });
  return res.status;
}

describe('OAuthMcpProxy — retainThreads', () => {
  it('revokes capability tokens for threads outside the active set', async () => {
    const proxy = setup();
    await proxy.start();
    const staleToken = proxy.capabilityTokenFor('thread-stale');

    proxy.retainThreads(new Set(['thread-other']));

    expect(await requestWith(proxy, staleToken)).toBe(403);
  });

  it('leaves capability tokens for threads inside the active set untouched', async () => {
    const proxy = setup();
    await proxy.start();
    const keptToken = proxy.capabilityTokenFor('thread-kept');
    const staleToken = proxy.capabilityTokenFor('thread-stale');

    proxy.retainThreads(new Set(['thread-kept']));

    expect(await requestWith(proxy, keptToken)).toBe(200);
    expect(await requestWith(proxy, staleToken)).toBe(403);
  });

  it('is a no-op when every current thread is retained', async () => {
    const proxy = setup();
    await proxy.start();
    const token = proxy.capabilityTokenFor('thread-1');

    proxy.retainThreads(new Set(['thread-1', 'thread-2']));

    expect(await requestWith(proxy, token)).toBe(200);
  });

  it('handles an empty proxy (no minted tokens) without throwing', async () => {
    const proxy = setup();
    await proxy.start();
    expect(() => proxy.retainThreads(new Set())).not.toThrow();
  });
});

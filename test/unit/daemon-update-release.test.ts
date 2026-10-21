import { describe, expect, it } from 'vitest';
import { compareVersions, isMajorBump, isNewerVersion, parseStableVersion } from '../../daemon/update/semver';
import {
  getChecked, githubReleases, isAllowedUrl, retryAfterMs, selectRelease, UpdateError,
  type FetchLike, type FetchResponse,
} from '../../daemon/update/release';

const asset = (tag: string, name: string) => ({ name, browser_download_url: `https://github.com/rbcodelabs/agent-threads/releases/download/${tag}/${name}` });
const release = (tag: string, extra: Record<string, unknown> = {}, assets = ['agent-threads.cjs', 'agent-threads.cjs.sha256']) => ({
  tag_name: tag, draft: false, prerelease: false, assets: assets.map((a) => asset(tag, a)), ...extra,
});

function res(status: number, body = '', headers: Record<string, string> = {}): FetchResponse {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (n) => h[n.toLowerCase()] ?? null },
    arrayBuffer: async () => { const b = Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer; },
  };
}

describe('versions', () => {
  it('parses stable versions only', () => {
    expect(parseStableVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseStableVersion('0.68.2')).toEqual({ major: 0, minor: 68, patch: 2 });
    for (const bad of ['dev', '1.2', '1.2.3-rc.1', 'v1.2.3+build', '1.2.3.4', '']) expect(parseStableVersion(bad)).toBeNull();
  });
  it('compares numerically, not as strings', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('v0.68.2', '0.68.2')).toBe(0);
    expect(() => compareVersions('dev', '1.0.0')).toThrow();
  });
  it('never calls an older, equal or unparseable version newer (no downgrade)', () => {
    expect(isNewerVersion('0.68.3', '0.68.2')).toBe(true);
    expect(isNewerVersion('0.68.1', '0.68.2')).toBe(false);
    expect(isNewerVersion('0.68.2', '0.68.2')).toBe(false);
    expect(isNewerVersion('0.69.0', 'dev')).toBe(false);
  });
  it('flags a major bump', () => {
    expect(isMajorBump('1.0.0', '0.68.2')).toBe(true);
    expect(isMajorBump('0.69.0', '0.68.2')).toBe(false);
  });
});

describe('selectRelease', () => {
  it('picks the highest stable release regardless of list order', () => {
    expect(selectRelease([release('v0.68.3'), release('v0.70.0'), release('v0.69.0')])?.version).toBe('0.70.0');
  });
  it('ignores drafts, pre-releases, odd tags and releases missing an asset', () => {
    const picked = selectRelease([
      release('v0.99.0', { draft: true }),
      release('v0.98.0', { prerelease: true }),
      release('v0.97.0-rc.1'),
      release('nightly'),
      release('v0.96.0', {}, ['agent-threads.cjs']),
      release('v0.95.0', {}, ['agent-threads.cjs.sha256']),
      release('v0.69.1'),
    ]);
    expect(picked).toMatchObject({ version: '0.69.1', tag: 'v0.69.1' });
  });
  it('refuses asset URLs that are not the repository release URLs', () => {
    const evil = release('v0.70.0');
    evil.assets[0].browser_download_url = 'https://evil.example/agent-threads.cjs';
    expect(selectRelease([evil])).toBeNull();
    const other = release('v0.70.0');
    other.assets[1].browser_download_url = 'https://github.com/someone-else/agent-threads/releases/download/v0.70.0/agent-threads.cjs.sha256';
    expect(selectRelease([other])).toBeNull();
  });
  it('tolerates garbage', () => {
    expect(selectRelease(null)).toBeNull();
    expect(selectRelease([null, 3, {}, { tag_name: 5 }])).toBeNull();
  });
});

describe('URL pinning', () => {
  it('allows https GitHub hosts only', () => {
    for (const ok of ['https://github.com/a/b', 'https://api.github.com/repos/x', 'https://objects.githubusercontent.com/z', 'https://release-assets.githubusercontent.com/z']) expect(isAllowedUrl(ok), ok).toBe(true);
    for (const bad of ['http://github.com/a', 'https://github.com.evil.example/a', 'https://evilgithub.com/a', 'https://user:pw@github.com/a', 'https://github.com:8443/a', 'ftp://github.com/a', 'not a url']) expect(isAllowedUrl(bad), bad).toBe(false);
  });
  it('follows redirects only to allowed hosts, and checks every hop', async () => {
    const seen: string[] = [];
    const ok: FetchLike = async (url) => {
      seen.push(url);
      if (url.startsWith('https://github.com/')) return res(302, '', { location: 'https://objects.githubusercontent.com/blob' });
      return res(200, 'payload');
    };
    const { body } = await getChecked('https://github.com/x/y', { fetch: ok, timeoutMs: 1000, maxBytes: 100 });
    expect(body?.toString()).toBe('payload');
    expect(seen).toEqual(['https://github.com/x/y', 'https://objects.githubusercontent.com/blob']);

    const bad: FetchLike = async () => res(302, '', { location: 'https://evil.example/blob' });
    await expect(getChecked('https://github.com/x/y', { fetch: bad, timeoutMs: 1000, maxBytes: 100 })).rejects.toThrow(/only HTTPS to GitHub/);
    const loop: FetchLike = async () => res(302, '', { location: 'https://github.com/again' });
    await expect(getChecked('https://github.com/x/y', { fetch: loop, timeoutMs: 1000, maxBytes: 100 })).rejects.toThrow(/too many redirects/);
  });
  it('enforces the size cap, declared and actual', async () => {
    await expect(getChecked('https://github.com/a', { fetch: async () => res(200, 'x', { 'content-length': '999' }), timeoutMs: 1000, maxBytes: 10 })).rejects.toThrow(/limit/);
    await expect(getChecked('https://github.com/a', { fetch: async () => res(200, 'x'.repeat(20)), timeoutMs: 1000, maxBytes: 10 })).rejects.toThrow(/limit/);
  });
  it('sends no credentials', async () => {
    let headers: Record<string, string> | undefined;
    await getChecked('https://github.com/a', { fetch: async (_u, init) => { headers = init.headers; return res(200, 'x'); }, timeoutMs: 1000, maxBytes: 10 });
    expect(Object.keys(headers ?? {}).map((k) => k.toLowerCase())).not.toContain('authorization');
  });
});

describe('rate limits', () => {
  it('reads Retry-After and the rate-limit reset', () => {
    expect(retryAfterMs(res(429, '', { 'retry-after': '90' }))).toBe(90_000);
    expect(retryAfterMs(res(403, '', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000' }), 1_000_000)).toBe(1_000_000);
    expect(retryAfterMs(res(403, '', { 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '2000' }), 1_000_000)).toBeUndefined();
  });
  it('turns a 403 into an UpdateError carrying the wait', async () => {
    const src = githubReleases({ fetch: async () => res(403, '', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) }) });
    const err = await src.latest().catch((e) => e);
    expect(err).toBeInstanceOf(UpdateError);
    expect(err.retryAfterMs).toBeGreaterThan(500_000);
  });
});

describe('githubReleases', () => {
  it('uses the ETag, and a 304 returns the previous answer', async () => {
    const sent: Array<Record<string, string> | undefined> = [];
    const fetch: FetchLike = async (_u, init) => {
      sent.push(init.headers);
      return sent.length === 1 ? res(200, JSON.stringify([release('v0.70.0')]), { etag: 'W/"abc"' }) : res(304);
    };
    const src = githubReleases({ fetch });
    expect((await src.latest())?.version).toBe('0.70.0');
    expect((await src.latest())?.version).toBe('0.70.0');
    expect(sent[1]?.['if-none-match']).toBe('W/"abc"');
  });
  it('reports non-JSON as a check failure', async () => {
    await expect(githubReleases({ fetch: async () => res(200, '<html>') }).latest()).rejects.toThrow(/not JSON/);
  });
});

/**
 * Finding and downloading a release, with the network and the clock injected.
 *
 * Only HTTPS to GitHub hosts is ever contacted, redirects included (every hop is checked): the API and github.com,
 * and `*.githubusercontent.com` where release assets are served from. No token is sent: the repository is public.
 */
import { compareVersions, parseStableVersion } from './semver';

export const RELEASE_REPO = 'rbcodelabs/agent-threads';
export const BUNDLE_ASSET = 'agent-threads.cjs';
export const CHECKSUM_ASSET = 'agent-threads.cjs.sha256';
export const RELEASES_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=20`;

/** The slice of `Response` we use, so a test can hand back a plain object. */
export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface FetchInit { headers?: Record<string, string>; redirect: 'manual'; signal?: AbortSignal }
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

export interface LatestRelease {
  version: string;
  tag: string;
  bundleUrl: string;
  checksumUrl: string;
}

export type UpdateStage = 'check' | 'download' | 'checksum' | 'sanity' | 'apply' | 'held';

/** A failed step. `retryAfterMs` is set when GitHub told us when to come back (rate limit). */
export class UpdateError extends Error {
  constructor(readonly stage: UpdateStage, message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'UpdateError';
  }
}

/** Not a failure: this release exists but must not be applied automatically (protocol change, major bump). */
export class UpdateHeld extends UpdateError {
  constructor(readonly version: string, readonly reason: string) {
    super('held', reason);
    this.name = 'UpdateHeld';
  }
}

export function isAllowedUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const h = u.hostname.toLowerCase();
  return h === 'github.com' || h === 'api.github.com' || h.endsWith('.githubusercontent.com');
}

const MAX_REDIRECTS = 5;

export interface GetOptions {
  fetch: FetchLike;
  timeoutMs: number;
  maxBytes: number;
  stage?: UpdateStage;
  headers?: Record<string, string>;
}

/** GET with manual redirects (each hop allow-listed) and a body cap. Returns the final non-redirect response. */
export async function getChecked(url: string, o: GetOptions): Promise<{ res: FetchResponse; body: Buffer | null }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedUrl(current)) throw new UpdateError(o.stage ?? 'download', `refusing to contact ${current}: only HTTPS to GitHub hosts is allowed`);
    let res: FetchResponse;
    try {
      res = await o.fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs), headers: { 'user-agent': 'agent-threads-updater', ...o.headers } });
    } catch (err) {
      throw new UpdateError(o.stage ?? 'download', `request to ${new URL(current).host} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const loc = res.headers.get('location');
      if (!loc) throw new UpdateError(o.stage ?? 'download', `redirect without a location from ${new URL(current).host}`);
      current = new URL(loc, current).toString();
      continue;
    }
    if (res.status === 304) return { res, body: null };
    if (res.status === 403 || res.status === 429) throw new UpdateError(o.stage ?? 'download', `GitHub refused the request (HTTP ${res.status}, rate limit?)`, retryAfterMs(res));
    if (res.status < 200 || res.status >= 300) throw new UpdateError(o.stage ?? 'download', `HTTP ${res.status} from ${new URL(current).host}`);
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > o.maxBytes) throw new UpdateError(o.stage ?? 'download', `response is ${declared} bytes, over the ${o.maxBytes} byte limit`);
    let body: Buffer;
    try { body = Buffer.from(await res.arrayBuffer()); } catch (err) {
      throw new UpdateError(o.stage ?? 'download', `reading the response failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (body.length > o.maxBytes) throw new UpdateError(o.stage ?? 'download', `response is over the ${o.maxBytes} byte limit`);
    return { res, body };
  }
  throw new UpdateError(o.stage ?? 'download', `too many redirects from ${url}`);
}

/** Milliseconds GitHub asked us to wait: `Retry-After`, or until `X-RateLimit-Reset` when the quota is spent. */
export function retryAfterMs(res: FetchResponse, now: number = Date.now()): number | undefined {
  const ra = Number(res.headers.get('retry-after') ?? '');
  if (Number.isFinite(ra) && ra > 0) return ra * 1000;
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset') ?? '');
    if (Number.isFinite(reset) && reset * 1000 > now) return reset * 1000 - now;
  }
  return undefined;
}

interface RawAsset { name?: unknown; browser_download_url?: unknown }
interface RawRelease { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown }

const assetUrlFor = (tag: string, name: string) => `https://github.com/${RELEASE_REPO}/releases/download/${tag}/${name}`;

/**
 * The newest stable release that publishes both the bundle and its checksum. Drafts, pre-releases, tags that are not
 * plain `vX.Y.Z` and releases missing an asset are ignored; asset URLs must be the repository's own release URLs.
 * Highest version wins regardless of the order GitHub lists them in.
 */
export function selectRelease(releases: unknown): LatestRelease | null {
  if (!Array.isArray(releases)) return null;
  let best: LatestRelease | null = null;
  for (const r of releases as RawRelease[]) {
    if (!r || typeof r !== 'object' || r.draft === true || r.prerelease === true) continue;
    if (typeof r.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(r.tag_name) || !parseStableVersion(r.tag_name)) continue;
    const assets = Array.isArray(r.assets) ? (r.assets as RawAsset[]) : [];
    const url = (name: string): string | null => {
      const a = assets.find((x) => x && x.name === name);
      const u = a && typeof a.browser_download_url === 'string' ? a.browser_download_url : null;
      return u !== null && u === assetUrlFor(r.tag_name as string, name) ? u : null;
    };
    const bundleUrl = url(BUNDLE_ASSET);
    const checksumUrl = url(CHECKSUM_ASSET);
    if (!bundleUrl || !checksumUrl) continue;
    const version = r.tag_name.slice(1);
    if (!best || compareVersions(version, best.version) > 0) best = { version, tag: r.tag_name, bundleUrl, checksumUrl };
  }
  return best;
}

export interface ReleaseSource {
  /** `null` = no usable stable release. A conditional request that came back unchanged returns the previous answer. */
  latest(): Promise<LatestRelease | null>;
}

/** GitHub's releases list, with an ETag so an unchanged answer (HTTP 304) does not count against the rate limit. */
export function githubReleases(o: { fetch: FetchLike; timeoutMs?: number }): ReleaseSource {
  let etag: string | undefined;
  let cached: LatestRelease | null = null;
  return {
    async latest() {
      const { res, body } = await getChecked(RELEASES_URL, {
        fetch: o.fetch, timeoutMs: o.timeoutMs ?? 15_000, maxBytes: 4 * 1024 * 1024, stage: 'check',
        headers: { accept: 'application/vnd.github+json', ...(etag ? { 'if-none-match': etag } : {}) },
      });
      if (res.status === 304 || body === null) return cached;
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString('utf8')); } catch { throw new UpdateError('check', 'GitHub returned something that is not JSON'); }
      cached = selectRelease(parsed);
      etag = res.headers.get('etag') ?? undefined;
      return cached;
    },
  };
}

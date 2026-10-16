/**
 * Host seam: simple HTTP GET.
 *
 * Core code (skills marketplace lookups) must not import `requestUrl` from
 * `obsidian`. It takes an `HttpFetch` instead; the plugin passes the Obsidian
 * implementation (`obsidianHttpFetch` in `./obsidianHost`), a daemon can pass
 * one backed by global `fetch`.
 *
 * The shape is the subset of Obsidian's `RequestUrlResponse` that core reads,
 * so the plugin implementation can return `requestUrl`'s response unchanged.
 */
export interface HttpResponse {
  status: number;
  text: string;
  /** Parsed body. May throw if the body is not JSON (a getter in Obsidian). */
  readonly json: unknown;
}

export interface HttpGetOptions {
  /**
   * When false, non-2xx statuses are returned instead of thrown. Matches the
   * `throw` flag of Obsidian's `requestUrl`; omitted means the host default
   * (throw on 4xx/5xx).
   */
  throw?: boolean;
}

export interface HttpFetch {
  get(url: string, options?: HttpGetOptions): Promise<HttpResponse>;
}

/**
 * Devtools-style observation for the agent browser: console log, network log,
 * and (opt-in) JavaScript evaluation.
 *
 * Where each signal comes from, and why:
 *
 *  - Console: the `<webview>` tag's `console-message` event, buffered on the
 *    HOST by `ConsoleBuffer`. That makes it independent of the page's JS world,
 *    so a page cannot rewrite `console` to hide its own output, and uncaught
 *    exceptions and unhandled rejections (which Chromium logs to the console)
 *    arrive through the same path with no injected hook.
 *  - Network: the `<webview>` tag exposes no request events (webRequest is
 *    main-process only), so a hook is injected into the page. It wraps `fetch`
 *    and `XMLHttpRequest`, observes Resource Timing for everything else, and
 *    listens for element load errors. It lives in the page's own JS world, so a
 *    hostile page can tamper with it; every value read back is therefore
 *    validated and treated as untrusted. Limits are documented on
 *    `buildNetworkHookSource`.
 *  - Eval: `buildEvalScript`, run through the guest's ordinary timeout wrapper.
 *
 * Request and response headers and bodies are never recorded. URLs have
 * credentials stripped and sensitive-looking query values redacted before they
 * reach the agent.
 *
 * Pure and dependency-light so every rule is directly testable.
 */

import {
  DEFAULT_DEVTOOLS_LIMIT,
  MAX_CONSOLE_ENTRIES,
  MAX_CONSOLE_MESSAGE_CHARS,
  MAX_DEVTOOLS_LIMIT,
  MAX_EVAL_RESULT_CHARS,
  MAX_NETWORK_ENTRIES,
  MAX_NETWORK_URL_CHARS,
  evaluateUrl,
  type UrlPolicyOptions,
} from './agentBrowserPolicy';

// ── Shared ───────────────────────────────────────────────────────────────────

/** Clamp a caller-supplied `limit` into 1..MAX_DEVTOOLS_LIMIT (default when absent or non-finite). */
export function clampDevtoolsLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_DEVTOOLS_LIMIT;
  return Math.min(MAX_DEVTOOLS_LIMIT, Math.max(1, Math.floor(value)));
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [+${text.length - max} chars]`;
}

// ── Console ──────────────────────────────────────────────────────────────────

export type ConsoleLevel = 'debug' | 'info' | 'warning' | 'error';

const LEVEL_RANK: Record<ConsoleLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 };

/** Electron's `console-message` levels 0..3 are verbose, info, warning, error. */
const LEVEL_BY_NUMBER: ConsoleLevel[] = ['debug', 'info', 'warning', 'error'];

export interface ConsoleEntry {
  level: ConsoleLevel;
  text: string;
  timestamp: string;
  /** Script or page that logged it (`sourceId`), when Chromium reports one. */
  source: string;
  line: number;
}

/** Shape of the `console-message` event, as far as we rely on it. */
export interface RawConsoleMessage {
  level?: unknown;
  message?: unknown;
  line?: unknown;
  sourceId?: unknown;
}

export interface ConsoleReadOptions {
  /** Minimum severity to return. Default: everything. */
  level?: ConsoleLevel;
  limit?: number;
  /** Empty the buffer after reading. */
  clear?: boolean;
}

export interface ConsoleReadResult {
  entries: ConsoleEntry[];
  /** Entries matching the level filter, before `limit`. */
  matched: number;
  /** Entries currently held. */
  buffered: number;
  /** Entries lost to the ring bound since the last clear/navigation. */
  dropped: number;
}

/** Bounded ring of console messages. Newest entries win; reset on navigation. */
export class ConsoleBuffer {
  private entries: ConsoleEntry[] = [];
  private droppedCount = 0;

  constructor(
    private readonly maxEntries = MAX_CONSOLE_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  push(raw: RawConsoleMessage): void {
    const levelIndex = typeof raw.level === 'number' && Number.isInteger(raw.level) ? raw.level : 1;
    const level = LEVEL_BY_NUMBER[Math.min(3, Math.max(0, levelIndex))];
    const message = typeof raw.message === 'string' ? raw.message : String(raw.message ?? '');
    this.entries.push({
      level,
      text: cut(message, MAX_CONSOLE_MESSAGE_CHARS),
      timestamp: new Date(this.now()).toISOString(),
      source: typeof raw.sourceId === 'string' ? cut(raw.sourceId, MAX_NETWORK_URL_CHARS) : '',
      line: typeof raw.line === 'number' && Number.isFinite(raw.line) ? Math.max(0, Math.floor(raw.line)) : 0,
    });
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
      this.droppedCount += 1;
    }
  }

  clear(): void {
    this.entries = [];
    this.droppedCount = 0;
  }

  get size(): number {
    return this.entries.length;
  }

  read(options: ConsoleReadOptions = {}): ConsoleReadResult {
    const min = options.level ? LEVEL_RANK[options.level] ?? 0 : 0;
    const matching = this.entries.filter((e) => LEVEL_RANK[e.level] >= min);
    const limit = clampDevtoolsLimit(options.limit);
    const result: ConsoleReadResult = {
      // The most recent `limit` entries, still in chronological order.
      entries: matching.slice(-limit),
      matched: matching.length,
      buffered: this.entries.length,
      dropped: this.droppedCount,
    };
    if (options.clear) this.clear();
    return result;
  }
}

// ── Network ──────────────────────────────────────────────────────────────────

/** Query parameter names whose values are masked in logged URLs. */
const SENSITIVE_PARAM = /(token|secret|password|passwd|pwd|auth|session|sess|sig|signature|key|credential|code|jwt|bearer|cookie|otp|nonce)/i;

/**
 * Make a URL safe to show the agent: no userinfo, no fragment, sensitive query
 * values masked, length capped. Unparseable input is capped and returned as-is
 * (it is already page-supplied data and is framed as untrusted).
 */
export function redactUrl(raw: string): string {
  let text = String(raw);
  try {
    const url = new URL(text);
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...new Set(url.searchParams.keys())]) {
      if (SENSITIVE_PARAM.test(key)) url.searchParams.set(key, '[redacted]');
    }
    text = url.toString();
  } catch {
    /* not an absolute URL; fall through to the cap */
  }
  return cut(text, MAX_NETWORK_URL_CHARS);
}

export interface NetworkEntry {
  timestamp: string;
  /** `fetch`, `xhr`, `document`, or a Resource Timing initiator such as `img` / `script` / `css`. */
  type: string;
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  /** Bytes, when the browser reports them (Content-Length or Resource Timing). Often absent cross-origin. */
  sizeBytes?: number;
  /** Network-level failure: no response was received. An HTTP 4xx/5xx is NOT `failed`; see `status`. */
  failed: boolean;
  error?: string;
}

export interface NetworkReadOptions {
  /** Case-insensitive substring match against the (redacted) URL. */
  filter?: string;
  limit?: number;
  /** Only network failures and HTTP status >= 400. */
  failedOnly?: boolean;
}

export interface NetworkReadResult {
  entries: NetworkEntry[];
  matched: number;
  buffered: number;
  dropped: number;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

/**
 * Validate what the in-page hook returned. The page controls that object, so
 * every field is re-typed and re-capped here rather than trusted.
 */
export function normalizeNetworkEntries(raw: unknown, now: () => number = Date.now): NetworkEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: NetworkEntry[] = [];
  for (const item of raw.slice(0, MAX_NETWORK_ENTRIES)) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.url !== 'string' || !e.url) continue;
    const t = finiteNonNegative(e.t) ?? now();
    const entry: NetworkEntry = {
      timestamp: new Date(t).toISOString(),
      type: typeof e.type === 'string' ? e.type.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'other' : 'other',
      method: typeof e.method === 'string' ? e.method.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 12) || 'GET' : 'GET',
      url: redactUrl(e.url),
      failed: e.failed === true,
    };
    const status = finiteNonNegative(e.status);
    if (status !== undefined && status > 0) entry.status = status;
    const duration = finiteNonNegative(e.duration);
    if (duration !== undefined) entry.durationMs = duration;
    const size = finiteNonNegative(e.size);
    if (size !== undefined) entry.sizeBytes = size;
    if (typeof e.error === 'string' && e.error) entry.error = cut(e.error, 200);
    out.push(entry);
  }
  // Resource Timing entries are delivered in batches, so order by start time.
  return out.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
}

/** Apply filter / failedOnly / limit to normalized entries (most recent `limit` win). */
export function selectNetworkEntries(
  entries: NetworkEntry[],
  options: NetworkReadOptions = {},
  dropped = 0,
): NetworkReadResult {
  const needle = options.filter?.trim().toLowerCase();
  const matching = entries.filter((e) => {
    if (needle && !e.url.toLowerCase().includes(needle)) return false;
    if (options.failedOnly && !(e.failed || (e.status !== undefined && e.status >= 400))) return false;
    return true;
  });
  return {
    entries: matching.slice(-clampDevtoolsLimit(options.limit)),
    matched: matching.length,
    buffered: entries.length,
    dropped,
  };
}

/**
 * Source for the in-page network hook. Idempotent: state lives on a
 * non-enumerable `window[key]` property and a second run is a no-op.
 *
 * Limits, by construction:
 *  - `fetch` / XHR calls made BEFORE the hook is installed (it is installed at
 *    `dom-ready`, so inline scripts that fire requests during parsing can beat
 *    it) are recovered from Resource Timing instead, without method or error
 *    detail.
 *  - Resource Timing reports status only for same-origin or `Timing-Allow-Origin`
 *    responses, and sizes likewise; those fields are simply absent otherwise.
 *  - A request that fails before a response (DNS, refused, blocked) shows as
 *    `failed` for fetch / XHR / element loads, but a failed navigation of the
 *    top frame is not visible to a page script at all.
 *  - Only the top frame is hooked. WebSocket traffic is not logged.
 *  - The ring lives in the page and resets when the document does.
 *  - Headers and bodies are never read. `Content-Length` is read for size only.
 */
export function buildNetworkHookSource(key: string): string {
  return `
    var KEY = ${JSON.stringify(key)};
    var MAX = ${MAX_NETWORK_ENTRIES};
    var MAXURL = ${MAX_NETWORK_URL_CHARS};
    var st = window[KEY];
    if (!st) {
      st = { entries: [], dropped: 0, installed: false, installedAt: 0 };
      try { Object.defineProperty(window, KEY, { value: st, enumerable: false, configurable: true }); }
      catch (e) { window[KEY] = st; }
    }
    function cut(s, n) { s = String(s); return s.length > n ? s.slice(0, n) : s; }
    function abs(u) { try { return new URL(String(u), location.href).href; } catch (e) { return String(u); } }
    function push(rec) {
      if (st.entries.length >= MAX) { st.entries.shift(); st.dropped++; }
      st.entries.push(rec);
    }
    function sizeOf(getter) {
      try { var v = getter(); if (v != null && v !== '' && isFinite(+v)) return +v; } catch (e) {}
      return undefined;
    }
    if (!st.installed) {
      st.installed = true;
      st.installedAt = (typeof performance !== 'undefined' && performance.timeOrigin)
        ? performance.timeOrigin + performance.now() : Date.now();

      if (typeof window.fetch === 'function') {
        var origFetch = window.fetch;
        window.fetch = function (input, init) {
          var t0 = Date.now(), p0 = performance.now(), method = 'GET', url = '';
          try {
            if (input && typeof input === 'object' && 'url' in input) { url = input.url; method = input.method || method; }
            else url = String(input);
            if (init && init.method) method = init.method;
          } catch (e) {}
          var rec = { t: t0, type: 'fetch', method: String(method).toUpperCase(), url: cut(abs(url), MAXURL) };
          var p;
          try { p = origFetch.apply(this, arguments); }
          catch (err) { rec.failed = true; rec.error = cut(err && err.message || err, 200); rec.duration = 0; push(rec); throw err; }
          return p.then(function (res) {
            rec.status = res.status; rec.duration = Math.round(performance.now() - p0);
            rec.size = sizeOf(function () { return res.headers.get('content-length'); });
            push(rec); return res;
          }, function (err) {
            rec.failed = true; rec.error = cut(err && err.message || err, 200);
            rec.duration = Math.round(performance.now() - p0); push(rec); throw err;
          });
        };
      }

      if (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype) {
        var origOpen = XMLHttpRequest.prototype.open, origSend = XMLHttpRequest.prototype.send;
        var metas = typeof WeakMap === 'function' ? new WeakMap() : null;
        XMLHttpRequest.prototype.open = function (method, url) {
          if (metas) { try { metas.set(this, { method: String(method).toUpperCase(), url: abs(url) }); } catch (e) {} }
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function () {
          var xhr = this, meta = metas && metas.get(xhr), t0 = Date.now(), p0 = performance.now();
          if (meta) {
            xhr.addEventListener('loadend', function () {
              var failed = xhr.status === 0;
              push({
                t: t0, type: 'xhr', method: meta.method, url: cut(meta.url, MAXURL),
                status: xhr.status || undefined, duration: Math.round(performance.now() - p0),
                size: sizeOf(function () { return xhr.getResponseHeader('content-length'); }),
                failed: failed, error: failed ? 'request failed or was aborted' : undefined
              });
            });
          }
          return origSend.apply(this, arguments);
        };
      }

      if (typeof PerformanceObserver === 'function') {
        try {
          new PerformanceObserver(function (list) {
            list.getEntries().forEach(function (en) {
              var it = en.initiatorType || 'resource';
              var start = (performance.timeOrigin || 0) + en.startTime;
              // fetch/XHR started after install were recorded by the wrappers above.
              if ((it === 'fetch' || it === 'xmlhttprequest') && start >= st.installedAt) return;
              push({
                t: Math.round(start), type: it === 'xmlhttprequest' ? 'xhr' : it, method: 'GET',
                url: cut(String(en.name), MAXURL),
                status: en.responseStatus > 0 ? en.responseStatus : undefined,
                duration: Math.round(en.duration),
                size: en.transferSize > 0 ? en.transferSize : (en.encodedBodySize > 0 ? en.encodedBodySize : undefined)
              });
            });
          }).observe({ type: 'resource', buffered: true });
        } catch (e) {}
      }

      window.addEventListener('error', function (ev) {
        var t = ev && ev.target;
        if (!t || t === window || !t.tagName) return;
        var tag = String(t.tagName).toLowerCase();
        if (tag !== 'img' && tag !== 'script' && tag !== 'link' && tag !== 'video' && tag !== 'audio' && tag !== 'source') return;
        var u = t.currentSrc || t.src || t.href;
        if (!u) return;
        push({ t: Date.now(), type: tag === 'link' ? 'css' : tag, method: 'GET', url: cut(abs(u), MAXURL), failed: true, error: 'failed to load' });
      }, true);
    }
  `;
}

/** Install-only script, run at `dom-ready` so history exists before anyone asks for it. */
export function buildNetworkInstallScript(key: string): string {
  return `(function () { ${buildNetworkHookSource(key)} return true; })()`;
}

export interface RawNetworkLog {
  url: string;
  origin: string;
  dropped: number;
  entries: unknown[];
}

/** Install if needed, then return (a copy of) the ring plus the main document, optionally clearing. */
export function buildNetworkReadScript(key: string, clear: boolean): string {
  return `(function () {
    ${buildNetworkHookSource(key)}
    var list = st.entries.slice();
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      if (nav) {
        list.push({
          t: Math.round((performance.timeOrigin || 0) + nav.startTime), type: 'document', method: 'GET',
          url: cut(location.href, MAXURL), status: nav.responseStatus > 0 ? nav.responseStatus : undefined,
          duration: Math.round(nav.duration),
          size: nav.transferSize > 0 ? nav.transferSize : undefined
        });
      }
    } catch (e) {}
    var out = { url: location.href, origin: location.origin, dropped: st.dropped, entries: list };
    if (${clear ? 'true' : 'false'}) { st.entries.length = 0; st.dropped = 0; }
    return out;
  })()`;
}

// ── Eval ─────────────────────────────────────────────────────────────────────

export type RawEvalResult =
  | { ok: true; type: string; json: string; truncated: boolean; url: string; origin: string }
  | { ok: false; name: string; message: string; url: string; origin: string };

/**
 * Evaluate `expression` in the page and return a JSON-serializable, size-capped
 * description of the value.
 *
 * Runs through indirect eval so the expression sees page globals, not this
 * wrapper's locals. A returned Promise is awaited (the guest's script timeout
 * bounds it). Values JSON cannot represent are described rather than dropped:
 * `undefined`, functions, symbols, bigints, DOM nodes, errors and cycles all
 * have an explicit textual form so the agent is not told `null` for a thing
 * that was not null. The cap is applied inside the page so an enormous value
 * never crosses the bridge.
 */
export function buildEvalScript(expression: string): string {
  return `(async function () {
    var MAX = ${MAX_EVAL_RESULT_CHARS};
    function meta() { return { url: location.href, origin: location.origin }; }
    function describe(v, seen, depth) {
      if (v === undefined) return { $undefined: true };
      if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
      if (typeof v === 'number') return isFinite(v) ? v : { $number: String(v) };
      if (typeof v === 'bigint') return { $bigint: v.toString() };
      if (typeof v === 'symbol') return { $symbol: String(v) };
      if (typeof v === 'function') return { $function: v.name || '(anonymous)' };
      if (v instanceof Error) return { $error: (v.name || 'Error') + ': ' + v.message };
      if (typeof Node !== 'undefined' && v instanceof Node) {
        return { $node: v.nodeName + (v.id ? '#' + v.id : '') + (v.className && typeof v.className === 'string' ? '.' + v.className.trim().split(/\\s+/).join('.') : '') };
      }
      if (seen.indexOf(v) !== -1) return { $circular: true };
      if (depth >= 6) return { $depth: Array.isArray(v) ? 'Array(' + v.length + ')' : 'Object' };
      seen.push(v);
      var out;
      if (Array.isArray(v)) {
        out = v.slice(0, 200).map(function (x) { return describe(x, seen, depth + 1); });
        if (v.length > 200) out.push({ $more: v.length - 200 });
      } else if (v instanceof Date) {
        out = { $date: isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString() };
      } else if (v instanceof Map || v instanceof Set) {
        out = { $collection: Object.prototype.toString.call(v).slice(8, -1), size: v.size, entries: describe(Array.from(v).slice(0, 100), seen, depth + 1) };
      } else {
        out = {};
        var keys = Object.keys(v), n = 0;
        for (var i = 0; i < keys.length && n < 200; i++, n++) {
          try { out[keys[i]] = describe(v[keys[i]], seen, depth + 1); } catch (e) { out[keys[i]] = { $error: 'unreadable' }; }
        }
        if (keys.length > 200) out.$more = keys.length - 200;
      }
      seen.pop();
      return out;
    }
    try {
      var value = (0, eval)(${JSON.stringify(expression)});
      if (value && typeof value.then === 'function') value = await value;
      var json = JSON.stringify(describe(value, [], 0));
      if (json === undefined) json = 'null';
      var m = meta();
      var truncated = json.length > MAX;
      return { ok: true, type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
               json: truncated ? json.slice(0, MAX) : json, truncated: truncated, url: m.url, origin: m.origin };
    } catch (err) {
      var m2 = meta();
      return { ok: false, name: String(err && err.name || 'Error').slice(0, 100),
               message: String(err && err.message !== undefined ? err.message : err).slice(0, 2000), url: m2.url, origin: m2.origin };
    }
  })()`;
}

/**
 * Find absolute URLs written literally in an expression and apply navigation
 * policy to them. Returns the first refusal reason, or null.
 *
 * This is a tripwire, not a boundary: it catches `fetch('http://169.254.169.254/…')`
 * but not a URL assembled at run time. The same is true of any script the page
 * itself runs. It exists so the obvious bypass of the private-network setting
 * (and the always-blocked metadata endpoints) is refused rather than silently
 * performed on the agent's behalf. Navigations started from the page are still
 * caught by the guest's own did-start-navigation check.
 */
export function findPolicyViolationInExpression(expression: string, policy: UrlPolicyOptions): string | null {
  const literal = /\b([a-z][a-z0-9+.-]*):\/\/[^\s'"`<>)\\]+/gi;
  for (const match of expression.matchAll(literal)) {
    const scheme = match[1].toLowerCase();
    const candidate = scheme === 'ws' ? `http://${match[0].slice(5)}` : scheme === 'wss' ? `https://${match[0].slice(6)}` : match[0];
    const decision = evaluateUrl(candidate, policy);
    if (!decision.allowed) return `The expression references ${match[0]}: ${decision.reason}`;
  }
  return null;
}

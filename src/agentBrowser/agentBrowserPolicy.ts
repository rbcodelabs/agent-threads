/**
 * Caps, budgets, and URL policy for the in-app agent browser.
 *
 * Pure by design: no imports, no DOM, no I/O, so every number here is
 * unit-testable and the module is safe to pull into any bundle. The values are
 * the whole point of the feature — the capability it enables is easy, and the
 * reason the previous approach (an external CLI spawning its own Chrome)
 * destabilised the machine is that nothing bounded it. Each constant carries
 * the reasoning for its value so a future change is a decision rather than a
 * tweak.
 */

// ── Pool shape ───────────────────────────────────────────────────────────────

/**
 * One guest per thread, always.
 *
 * This is what makes reclamation a total function of `threadId`: when a thread
 * is deleted, archived, or the plugin unloads, there is exactly one element to
 * remove and no bookkeeping that can disagree with reality. Multi-tab work
 * becomes multi-thread work, which the plugin already reclaims correctly.
 */
export const MAX_GUESTS_PER_THREAD = 1;

/**
 * Default ceiling on live guests across all threads.
 *
 * A cap of 1 would serialize every thread behind one browser and turn ordinary
 * concurrent use into queue timeouts. 2 lets one thread work while another
 * queues, and bounds discretionary process growth at +2 sandboxed renderers on
 * top of Geode's own renderer, GPU process, utility processes, and Web Viewer.
 */
export const DEFAULT_MAX_GUESTS = 2;

/** Hard clamp on the user-configurable cap. */
export const ABSOLUTE_MAX_GUESTS = 4;

/** Lower clamp — 0 would silently disable the feature while it looks enabled. */
export const MIN_MAX_GUESTS = 1;

/**
 * Clamp a user-supplied cap into the supported range.
 * Non-finite input falls back to the default rather than throwing: a corrupt
 * setting must never prevent the plugin from loading.
 */
export function clampMaxGuests(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_GUESTS;
  return Math.min(ABSOLUTE_MAX_GUESTS, Math.max(MIN_MAX_GUESTS, Math.floor(value)));
}

// ── Lifetime ─────────────────────────────────────────────────────────────────

/**
 * Destroy a guest after this long with no operations.
 *
 * ADR-0002 §3 proposes 10 minutes for an idle `HarnessSession`. A browser guest
 * is an entire sandboxed renderer process rather than a paused subprocess, so it
 * gets half that. Agent turn latency is seconds to tens of seconds, so 5 minutes
 * never interrupts real work, and a user who walked away reclaims the process
 * within a coffee break.
 */
export const IDLE_REAP_MS = 5 * 60_000;

/**
 * Recycle a guest once it reaches this age regardless of activity.
 *
 * Idle reaping never fires against an agent polling a page every 60 seconds, so
 * without a hard ceiling a guest can live indefinitely and accumulate renderer
 * memory that no GC inside the page reaches. This is the only bound on age.
 */
export const HARD_TTL_MS = 30 * 60_000;

/** Reaper cadence. Cheap, and bounds worst-case over-retention to reap + 30s. */
export const REAPER_TICK_MS = 30_000;

// ── Per-guest budgets ────────────────────────────────────────────────────────
// Recycling the process is the only way to reclaim leaked page memory, so each
// budget is an upper bound on how much work one renderer does before replacement.

/** Navigations before recycle. */
export const NAV_BUDGET = 200;
/** Injected-script executions before recycle. Bounds a runaway agent loop. */
export const SCRIPT_BUDGET = 2_000;
/** Screenshots before recycle. capturePage is the most expensive operation. */
export const CAPTURE_BUDGET = 100;

// ── Timeouts ─────────────────────────────────────────────────────────────────
// Mandatory, not defensive polish. `executeJavaScript` against a hung guest
// never rejects on its own; without racing a timer a single hostile page hangs
// the agent's turn forever.

export const DOM_READY_TIMEOUT_MS = 15_000;
export const NAV_TIMEOUT_MS = 30_000;
export const SCRIPT_TIMEOUT_MS = 10_000;
export const CAPTURE_TIMEOUT_MS = 15_000;

/** Max operations queued against one guest before new work is refused. */
export const OP_QUEUE_DEPTH = 8;
/** A queued operation that waits longer than this has lost its caller's turn. */
export const QUEUE_WAIT_MS = 30_000;

/**
 * Treat a guest that stops responding as dead after this long.
 * A hung guest holds a renderer process and its file descriptors indefinitely,
 * which is a leak whether or not the bookkeeping calls it one.
 */
export const UNRESPONSIVE_GRACE_MS = 30_000;

// ── Crash containment ────────────────────────────────────────────────────────

/** Two crashes inside this window trips the breaker for a thread. */
export const CRASH_BREAKER_WINDOW_MS = 60_000;
/** How long creation stays refused for that thread once tripped. */
export const CRASH_BREAKER_COOLDOWN_MS = 5 * 60_000;
/** Crashes within the window required to trip. */
export const CRASH_BREAKER_THRESHOLD = 2;

/**
 * Creation rate limits.
 *
 * A create/destroy thrash loop churns file descriptors just as badly as a steady
 * leak, even while the steady-state guest count sits at 2.
 */
export const MAX_CREATES_PER_MINUTE = 20;
export const MIN_CREATE_INTERVAL_MS = 1_000;

// ── File-descriptor pressure ─────────────────────────────────────────────────

/**
 * Matches Geode's own `FD_PRESSURE_RATIO` in `src/main/crash-diagnostics.ts`.
 * A `<webview>` guest is the only sandboxed renderer in Geode and needs a spare
 * descriptor at launch to receive its seatbelt policy; without one it dies as a
 * bare "crashed (exit code 6)".
 */
export const FD_RED = 0.85;

/**
 * Creation stays blocked until pressure falls back below this.
 *
 * A single threshold flaps: it admits at 0.849, the new guest pushes the ratio
 * to 0.86, the guest is reaped, the ratio drops, and it admits again — burning
 * descriptors faster than a steady leak would. The gap between RED and GREEN is
 * the entire point.
 */
export const FD_GREEN = 0.75;

/** An FD reading older than this is not trusted for an admission decision. */
export const FD_PROBE_CACHE_MS = 2_000;

// ── Guest viewport ───────────────────────────────────────────────────────────

/**
 * The guest is positioned off-screen rather than hidden.
 *
 * Chromium does not paint `display:none`, zero-size, or `visibility:hidden`
 * subtrees, so a genuinely hidden guest returns blank screenshots, and an
 * occluded one is background-throttled until its timers stall. Off-screen at a
 * real size keeps it painting and keeps its clocks running.
 */
export const GUEST_WIDTH = 1280;
export const GUEST_HEIGHT = 800;

// ── URL policy ───────────────────────────────────────────────────────────────

export type UrlDecision =
  | { allowed: true; url: string }
  | { allowed: false; reason: string };

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Loopback is allowed by default: testing a local dev server is the main use. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * Strip the brackets IPv6 hosts carry in a URL, and lowercase, so the range
 * checks below see a bare address.
 */
function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/**
 * Cloud instance-metadata endpoints. Always denied, with no setting to permit
 * them: an agent reading an attacker-controlled page must never be talked into
 * fetching instance credentials, and no legitimate automation target lives here.
 */
function isLinkLocal(hostname: string): boolean {
  return /^169\.254\./.test(hostname) || /^fe80:/i.test(hostname);
}

/** RFC1918 and friends — permitted only when the user opts in. */
function isPrivateNetwork(hostname: string): boolean {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return false; // handled separately
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  if (/^127\./.test(hostname)) return true;
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
  // Unique-local IPv6.
  if (/^f[cd][0-9a-f]{2}:/i.test(hostname)) return true;
  return false;
}

export interface UrlPolicyOptions {
  /** Permit RFC1918 / .local targets. Never permits link-local metadata IPs. */
  allowPrivateNetwork?: boolean;
}

/**
 * Decide whether the agent may navigate to `input`.
 *
 * Applied before every navigation the plugin initiates. It cannot guard a
 * redirect the page performs itself — `will-navigate` on the `<webview>` tag is
 * not cancelable from the renderer — so a guest additionally aborts and reports
 * a policy violation after the fact. See gap G2 in the plan.
 */
export function evaluateUrl(input: string, options: UrlPolicyOptions = {}): UrlDecision {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return { allowed: false, reason: 'No URL was supplied.' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { allowed: false, reason: `Not a valid absolute URL: ${trimmed}` };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      allowed: false,
      reason:
        `The ${parsed.protocol} scheme is not allowed. The agent browser only ` +
        `navigates to http: and https: URLs.`,
    };
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) return { allowed: false, reason: 'URL has no host.' };

  if (isLinkLocal(hostname)) {
    return {
      allowed: false,
      reason:
        `${hostname} is a link-local address used for cloud instance metadata. ` +
        `It is never reachable from the agent browser.`,
    };
  }

  if (!LOOPBACK_HOSTNAMES.has(hostname) && isPrivateNetwork(hostname) && !options.allowPrivateNetwork) {
    return {
      allowed: false,
      reason:
        `${hostname} is on a private network. Enable "Allow private network ` +
        `access" in the agent browser settings to permit this.`,
    };
  }

  return { allowed: true, url: parsed.toString() };
}

/**
 * The blank page every guest starts on. Never routed through `evaluateUrl` —
 * it is the plugin's own bootstrap target, not an agent-chosen destination.
 */
export const BOOTSTRAP_URL = 'about:blank';

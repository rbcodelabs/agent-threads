/**
 * loopbackUrl.ts — loopback URL helpers shared by the browser tools and the local daemon's port forwarder
 * (src/localDaemon/portForward.ts). Pure: no Node built-ins, no daemon imports.
 *
 * A thread on the managed local daemon runs in a container where `localhost` is the container, while the browser
 * tools run on this Mac. These helpers recognise such a URL and describe how it was rewritten.
 */

/** Thrown for failures the agent can act on. `message` says what is wrong; `hint` says what to do. */
export class DaemonLoopbackError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = 'DaemonLoopbackError';
    this.hint = hint;
  }
}

export type DaemonUrlResolution =
  | { kind: 'passthrough' }
  | { kind: 'forwarded'; url: string; requestedUrl: string; hostPort: number; guestPort: number; note: string };

// ── URL handling ─────────────────────────────────────────────────────────────

export interface ParsedLoopbackUrl {
  url: URL;
  port: number;
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  return /^127(\.\d{1,3}){3}$/.test(h);
}

/** The URL and effective port when `input` is an http(s) URL addressing the local machine; otherwise null. */
export function parseLoopbackHttpUrl(input: string): ParsedLoopbackUrl | null {
  let url: URL;
  try {
    url = new URL((input ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!isLoopbackHostname(url.hostname)) return null;
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return { url, port };
}

/** Same URL with host 127.0.0.1 and the forwarded host port. Credentials are dropped. */
export function rewriteToHostPort(parsed: ParsedLoopbackUrl, hostPort: number): string {
  const u = new URL(parsed.url.toString());
  u.hostname = '127.0.0.1';
  u.port = String(hostPort);
  u.username = '';
  u.password = '';
  return u.toString();
}

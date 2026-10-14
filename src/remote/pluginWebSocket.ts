/**
 * The WebSocket the plugin hands to `DaemonClient`.
 *
 * Desktop (Geode / Obsidian, Node available): the bundled `ws` package, NOT the
 * renderer's global `WebSocket`. Geode's renderer ships
 * `Content-Security-Policy: default-src 'self'` with no `connect-src`, which
 * blocks every ws:// and wss:// connection to another host (measured against a
 * Tailscale daemon, see docs/remote-daemon.md). Node's `ws` does not go through
 * the page's CSP, sends no `Origin` header (so the daemon's origin allowlist is
 * not involved) and works for both ws:// and wss://.
 *
 * Mobile (no Node): the global `WebSocket`.
 *
 * `ws` is required lazily so a host without Node never evaluates it.
 */
import type { WebSocketFactory, WebSocketLike } from './DaemonClient';

export function createPluginWebSocketFactory(): WebSocketFactory {
  return (url: string): WebSocketLike => {
    const hasNode = typeof process !== 'undefined' && typeof process.versions?.node === 'string';
    if (hasNode) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('ws') as typeof import('ws') & { WebSocket?: typeof import('ws').WebSocket };
      const WS = (mod.WebSocket ?? mod) as typeof import('ws').WebSocket;
      return new WS(url, { handshakeTimeout: 10_000, perMessageDeflate: false }) as unknown as WebSocketLike;
    }
    return new WebSocket(url) as unknown as WebSocketLike;
  };
}

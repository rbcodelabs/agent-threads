/**
 * mobilePairing.ts
 *
 * Pure, dependency-free helpers for the room-id pairing flow, shared by the
 * desktop PairingModal and the dedicated mobile entry (mobile-main.ts).
 *
 * Mobile-safe: no imports, no Node built-ins. Anything added here ships in
 * dist/main.mobile.js, so keep it that way.
 *
 * The room id is a bearer secret (ADR-0008: the room-id relay is a prototype).
 * Nothing in this file logs it.
 */

/** Deep-link scheme a phone should use to open this plugin's pair handler. */
export type PairingScheme = 'obsidian' | 'geode';

export const DEFAULT_RELAY_URL = 'wss://claude-threads-relay.rbcodelabs.workers.dev';

/**
 * Which scheme the *desktop host* wants phones to scan. Geode exposes
 * `window.geode.host = { name: 'geode', protocolScheme: 'geode' }` (the same
 * marker gdocs-sync keys off); real Obsidian has no `window.geode`.
 * Older Geode builds without `host` still expose `window.geode`, so that alone
 * is treated as Geode.
 */
export function detectPairingScheme(hostWindow: object | undefined): PairingScheme {
  const geode = (hostWindow as { geode?: unknown } | undefined)?.geode as { host?: { protocolScheme?: unknown } } | undefined;
  if (!geode) return 'obsidian';
  return geode.host?.protocolScheme === 'obsidian' ? 'obsidian' : 'geode';
}

export function buildPairingUrl(scheme: PairingScheme, roomId: string, relayUrl: string): string {
  return `${scheme}://pair?roomId=${encodeURIComponent(roomId)}&relay=${encodeURIComponent(relayUrl)}`;
}

/** Format a 32-char hex room id as XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX. */
export function formatRoomIdAsCode(roomId: string): string {
  const groups: string[] = [];
  for (let i = 0; i < 32; i += 8) groups.push(roomId.slice(i, i + 8).toUpperCase());
  return groups.join('-');
}

/**
 * Accept a pasted pairing code: the formatted code, raw hex, or a full
 * pairing URL (obsidian:// or geode://). Returns the room id and, for a URL,
 * the relay it named. Returns null when nothing valid is found.
 */
export function parsePairingInput(input: string): { roomId: string; relayUrl?: string } | null {
  const text = input.trim();
  if (!text) return null;
  const urlMatch = /^[a-z][a-z0-9+.-]*:\/\/pair\?(.*)$/i.exec(text);
  if (urlMatch) {
    const params = new URLSearchParams(urlMatch[1]);
    const roomId = normalizeRoomId(params.get('roomId') ?? '');
    if (!roomId) return null;
    const relay = params.get('relay');
    return relay ? { roomId, relayUrl: relay } : { roomId };
  }
  const roomId = normalizeRoomId(text);
  return roomId ? { roomId } : null;
}

export function normalizeRoomId(value: string): string | null {
  const raw = value.replace(/-/g, '').trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(raw) ? raw : null;
}

/** Relay must be a websocket URL; anything else would be a downgrade/injection vector. */
export function isValidRelayUrl(value: string): boolean {
  return /^wss?:\/\/[^\s]+$/i.test(value);
}

/**
 * Reconnect ladder shared by every WebSocket client in the plugin
 * (`RelayClient` for the mobile relay, `DaemonClient` for remote daemons):
 * 1s, 2s, 4s, 8s, 16s, then 30s for as long as it keeps failing.
 */
export const RECONNECT_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000, 30000];

export function backoffDelay(attempt: number, ladder: readonly number[] = RECONNECT_BACKOFF_MS): number {
  return ladder[Math.min(Math.max(attempt, 0), ladder.length - 1)];
}

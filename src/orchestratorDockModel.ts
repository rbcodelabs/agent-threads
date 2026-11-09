import type { ConnectionState } from './remote/DaemonClient';

// SPIKE (S3): pure dock-state derivation. Not wired to any view.
export type DockState = 'none' | 'idle' | 'working' | 'attention' | 'offline' | 'error';

export interface DockStateInput {
  /** settings.orchestratorThreadId */
  orchestratorId: string | undefined;
  /** manager.getThread(orchestratorId) -- undefined when the stored id is stale (deleted). */
  thread: { status?: string; lastError?: string; authRequired?: unknown; remote?: { daemonId: string } } | undefined;
  /** manager.isRunning(id) */
  isRunning: boolean;
  /** daemonRegistry.stateOf(thread.remote.daemonId); only read when thread.remote is set. */
  daemon: ConnectionState | undefined;
  /** awaiting-you items across the board (attentionItems().length) */
  needsYouCount: number;
  /** unseen orchestrator reply (unreadState) */
  hasUnreadReply: boolean;
}

const DAEMON_DOWN = new Set(['unreachable', 'closed', 'incompatible', 'unauthorized']);

export function deriveDockState(i: DockStateInput): DockState {
  if (!i.orchestratorId || !i.thread) return 'none';
  // connecting/reconnecting/idle are transient: connectionPill treats them as pending/warn, and a running
  // turn continues on the daemon, so they must not flip the dock to offline.
  if (i.thread.remote && i.daemon && DAEMON_DOWN.has(i.daemon.status)) return 'offline';
  if (!i.isRunning && (i.thread.lastError || i.thread.authRequired || i.thread.status === 'error')) return 'error';
  if (i.needsYouCount > 0 || i.hasUnreadReply) return 'attention';
  if (i.isRunning) return 'working';
  return 'idle';
}

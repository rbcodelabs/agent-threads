/**
 * "Run on: This computer / <daemon>" choice made at thread creation (the
 * dispatch send-button menu, next to Run in Container/Host). Pure logic so the
 * picker, the dashboards that forward its result, and the tests agree.
 */
import type { RemoteDaemonConfig } from '../types';

/** What a surface forwards to `dispatchNewThread` when the user picked a daemon. */
export interface RunOnRemote {
  daemonId: string;
  /** Absolute folder on the daemon's machine. */
  cwd: string;
}

export interface RunOnSelection {
  /** Undefined = this computer. */
  daemonId?: string;
  /** Folder typed for the daemon; ignored for this computer. */
  cwd?: string;
}

export type RunOnResult =
  | { ok: true; remote?: RunOnRemote }
  | { ok: false; reason: string };

export function normalizeRemoteCwd(input: string): { ok: true; cwd: string } | { ok: false; reason: string } {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: 'Enter the folder on the remote machine to work in.' };
  if (!raw.startsWith('/')) return { ok: false, reason: 'Use an absolute path on the remote machine (it starts with "/").' };
  if (/[\0\n\r]/.test(raw)) return { ok: false, reason: 'That path contains characters a folder cannot have.' };
  const collapsed = raw.replace(/\/{2,}/g, '/');
  const cwd = collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
  return { ok: true, cwd };
}

/**
 * Resolve the picker state at send time. A daemon that has since been removed
 * from Settings is an error, never a silent fall back to running locally.
 */
export function resolveRunOn(selection: RunOnSelection, daemons: readonly RemoteDaemonConfig[]): RunOnResult {
  if (!selection.daemonId) return { ok: true };
  const daemon = daemons.find((d) => d.id === selection.daemonId);
  if (!daemon) return { ok: false, reason: 'The selected remote daemon is no longer configured. Choose "This computer" or re-add it in Settings.' };
  const cwd = normalizeRemoteCwd(selection.cwd ?? daemon.defaultCwdRoot ?? '');
  if (!cwd.ok) return cwd;
  return { ok: true, remote: { daemonId: daemon.id, cwd: cwd.cwd } };
}

/** Send-button label fragment, e.g. ` on my-server`. */
export function runOnSuffix(selection: RunOnSelection, daemons: readonly RemoteDaemonConfig[]): string {
  if (!selection.daemonId) return '';
  const daemon = daemons.find((d) => d.id === selection.daemonId);
  return daemon ? ` on ${daemon.name}` : '';
}

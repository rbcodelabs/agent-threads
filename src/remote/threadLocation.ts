/**
 * Presentation helpers for where a thread runs. Pure so the views, the
 * dashboards and the screenshot harness share one wording.
 */
import type { Thread } from '../types';

export type DaemonNameResolver = (daemonId: string) => string;

/** `claude-box` for a remote thread, undefined for a local one. */
export function remoteHostName(thread: Pick<Thread, 'remote'>, nameOf?: DaemonNameResolver): string | undefined {
  if (!thread.remote) return undefined;
  return nameOf ? nameOf(thread.remote.daemonId) : thread.remote.daemonId;
}

/** `claude-box:/srv/workspaces/x`: a path on another machine, spelled so nobody mistakes it for a local one. */
export function remoteCwdLabel(thread: Pick<Thread, 'remote' | 'cwd'>, nameOf?: DaemonNameResolver): string | undefined {
  const host = remoteHostName(thread, nameOf);
  return host === undefined ? undefined : `${host}:${thread.remote!.remoteCwd}`;
}

/** The dashboard / kanban cwd label: `host:/path` for remote threads, otherwise the caller's local label. */
export function threadCwdLabel(
  thread: Pick<Thread, 'remote' | 'cwd'>,
  localLabel: () => string,
  nameOf?: DaemonNameResolver,
): string {
  return remoteCwdLabel(thread, nameOf) ?? localLabel();
}

/** Grouping identity for boards: remote threads group by daemon + folder, never by a local git walk. */
export function remoteGroup(
  thread: Pick<Thread, 'remote' | 'cwd'>,
  nameOf?: DaemonNameResolver,
): { key: string; label: string } | undefined {
  if (!thread.remote) return undefined;
  const folder = thread.remote.remoteCwd.replace(/\/+$/, '');
  const base = folder.slice(folder.lastIndexOf('/') + 1) || folder || '/';
  return { key: `remote:${thread.remote.daemonId}:${folder}`, label: `${remoteHostName(thread, nameOf)} · ${base}` };
}

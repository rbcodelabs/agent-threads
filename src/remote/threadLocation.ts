/**
 * Presentation helpers for where a thread runs. Pure so the views, the
 * dashboards and the screenshot harness share one wording.
 */
import type { Thread } from '../types';

export type DaemonNameResolver = (daemonId: string) => string;

/** `my-server` for a remote thread, undefined for a local one. */
export function remoteHostName(thread: Pick<Thread, 'remote'>, nameOf?: DaemonNameResolver): string | undefined {
  if (!thread.remote) return undefined;
  return nameOf ? nameOf(thread.remote.daemonId) : thread.remote.daemonId;
}

/**
 * Why a thread cannot be forked, or undefined when it can. A fork creates a LOCAL thread in the same `cwd`; for
 * a remote thread that `cwd` is a path on another machine, so the fork would run locally in a folder that does not
 * exist (or worse, a different one that does). Until a fork can carry the remote marker, it is refused.
 */
export function forkBlockedReason(thread: Pick<Thread, 'remote'>, nameOf?: DaemonNameResolver): string | undefined {
  if (!thread.remote) return undefined;
  const host = remoteHostName(thread, nameOf);
  return `Forking is not available for remote threads yet (this one runs on ${host}). Start a new thread on ${host} and paste what you need.`;
}

/** `my-server:/srv/workspaces/x`: a path on another machine, spelled so nobody mistakes it for a local one. */
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

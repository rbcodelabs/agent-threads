/**
 * Where the Run on picker gets a daemon's folders from: the advertised
 * workspaces and subfolder listings over the daemon's live connection. Failures
 * are values, not exceptions, so the picker can fall back to a text field with
 * an honest reason ("too old", "unreachable").
 */
import type { PathListReply, WorkspaceInfo } from '../protocol';
import { fetchSubfolders, fetchWorkspaces } from './DaemonClient';
import type { RemoteDaemonResolver } from './DaemonRegistry';

export type FolderLoad<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'unsupported' | 'error'; detail: string };

export interface RemoteFolderSource {
  workspaces(daemonId: string): Promise<FolderLoad<WorkspaceInfo[]>>;
  subfolders(daemonId: string, path: string): Promise<FolderLoad<PathListReply>>;
}

const CACHE_MS = 30_000;

export function createRemoteFolderSource(resolver: RemoteDaemonResolver, now: () => number = Date.now): RemoteFolderSource {
  const cache = new Map<string, { at: number; value: WorkspaceInfo[] }>();
  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  return {
    async workspaces(daemonId) {
      const hit = cache.get(daemonId);
      if (hit && now() - hit.at < CACHE_MS) return { ok: true, value: hit.value };
      const client = resolver.clientFor(daemonId);
      if (!client) return { ok: false, reason: 'error', detail: 'This daemon is no longer configured.' };
      try {
        const value = await fetchWorkspaces(client);
        if (!value) return { ok: false, reason: 'unsupported', detail: 'This daemon is too old to list its folders.' };
        cache.set(daemonId, { at: now(), value });
        return { ok: true, value };
      } catch (e) {
        return { ok: false, reason: 'error', detail: errText(e) };
      }
    },
    async subfolders(daemonId, path) {
      const client = resolver.clientFor(daemonId);
      if (!client) return { ok: false, reason: 'error', detail: 'This daemon is no longer configured.' };
      try {
        const value = await fetchSubfolders(client, path);
        if (!value) return { ok: false, reason: 'unsupported', detail: 'This daemon is too old to browse folders.' };
        return { ok: true, value };
      } catch (e) {
        return { ok: false, reason: 'error', detail: errText(e) };
      }
    },
  };
}

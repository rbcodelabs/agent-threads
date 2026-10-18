/**
 * Sync conflict tools (Geode `app.sync`): list and inspect are read-only; resolve mutates the vault and is never
 * pre-approved (see toolNameUtils.ts), so every call asks the user. Agents propose, the user approves.
 * Canonical-only names (no legacy `obsidian_` alias), routed in the `vault` domain.
 */

import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk/browser';
import { normalizePath } from 'obsidian';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { App } from 'obsidian';

type ToolDef = SdkMcpToolDefinition<any>;

export interface SyncConflictRecord {
  id: string;
  path: string;
  conflictPath?: string;
  remoteRevision?: string;
  [key: string]: unknown;
}

export interface GeodeSyncApi {
  listConflicts(): Promise<SyncConflictRecord[]>;
  resolveConflict(id: string, resolution: 'keep-local' | 'accept-remote'): Promise<void>;
  /** Append-only providers only (Geode plugin-sync-api). */
  describeHistoryConflict?(entityId: string): Promise<unknown>;
  readHistoryConflictText?(entityId: string, choice: { kind: 'current' } | { kind: 'version'; recordId: string }): Promise<string>;
  resolveHistoryConflict?(resolution: {
    entityId: string;
    heads: string[];
    choice: { kind: 'current' } | { kind: 'version'; recordId: string };
  }): Promise<unknown>;
}

/** History conflict ids are JSON.stringify([entityId, heads]). */
function parseHistoryId(id: string): { entityId: string; heads: string[] } | null {
  try {
    const [entityId, heads] = JSON.parse(id) as [unknown, unknown];
    return typeof entityId === 'string' && Array.isArray(heads) ? { entityId, heads: heads as string[] } : null;
  } catch {
    return null;
  }
}

export interface SyncToolsPort {
  app: Pick<App, 'vault'>;
}

interface AdapterLike {
  exists(p: string): Promise<boolean> | boolean;
  read?(p: string): Promise<string>;
  write?(p: string, data: string): Promise<void>;
  getBasePath?(): string;
  basePath?: string;
}

function fullPath(adapter: AdapterLike, p: string): string {
  const base = adapter.getBasePath?.() ?? adapter.basePath;
  if (!base) throw new Error('Cannot read vault files: adapter has no read() and no base path.');
  return `${base}/${p}`;
}

const MAX_CONTENT_CHARS = 100_000;

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error }) }], isError: true });

/** Line diff (LCS). Returns `-`/`+`/` ` prefixed lines; huge inputs fall back to a note. */
export function lineDiff(local: string, remote: string): string {
  const a = local.split('\n');
  const b = remote.split('\n');
  if (a.length * b.length > 4_000_000) return '(files too large to diff; compare local and remote directly)';
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out.join('\n');
}

export function createSyncTools(port: SyncToolsPort): Record<string, ToolDef> {
  const { app } = port;

  const getSync = (): GeodeSyncApi | null => {
    const sync = (app as unknown as { sync?: Partial<GeodeSyncApi> }).sync;
    return sync && typeof sync.listConflicts === 'function' && typeof sync.resolveConflict === 'function'
      ? (sync as GeodeSyncApi)
      : null;
  };
  const NO_SYNC = 'Geode sync is not available in this host (app.sync missing).';

  const readIfExists = async (p: string): Promise<string | null> => {
    const np = normalizePath(p);
    const adapter = app.vault.adapter as unknown as AdapterLike;
    if (!(await adapter.exists(np))) return null;
    // Geode's adapter has exists()/getBasePath() but no read(): go through the filesystem.
    if (typeof adapter.read === 'function') return adapter.read(np);
    return (require('fs') as typeof import('fs')).promises.readFile(fullPath(adapter, np), 'utf8');
  };
  const writeLocal = async (p: string, content: string): Promise<void> => {
    const np = normalizePath(p);
    const vault = app.vault as unknown as {
      getAbstractFileByPath?: (path: string) => unknown;
      modify?: (file: unknown, data: string) => Promise<void>;
    };
    const file = vault.getAbstractFileByPath?.(np);
    // The local file is indexed, so modify() lets the sync engine see an ordinary local edit.
    if (file && typeof vault.modify === 'function') return vault.modify(file, content);
    const adapter = app.vault.adapter as unknown as AdapterLike;
    if (typeof adapter.write === 'function') return adapter.write(np, content);
    await (require('fs') as typeof import('fs')).promises.writeFile(fullPath(adapter, np), content, 'utf8');
  };
  const clip = (s: string | null) =>
    s !== null && s.length > MAX_CONTENT_CHARS ? `${s.slice(0, MAX_CONTENT_CHARS)}\n…[truncated]` : s;

  const listTool = tool(
    'sync_list_conflicts',
    'Lists unresolved Geode sync conflicts. Each has an id, the vault path, and a kind: "sibling" (a .sync-conflict-<timestamp> copy exists next to the file) or "history" (concurrent heads in append-only history).',
    {},
    async () => {
      try {
        const sync = getSync();
        if (!sync) return fail(NO_SYNC);
        const conflicts = await sync.listConflicts();
        return ok(conflicts.map((c) => ({ ...c, kind: c.conflictPath ? 'sibling' : 'history' })));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const inspectTool = tool(
    'sync_inspect_conflict',
    'Inspects one sync conflict. Sibling conflicts return local content, remote content and a line diff ("-" local only, "+" remote only). History conflicts return the head metadata Geode exposes (record IDs, device, size, deleted flag).',
    { id: z.string().describe('Conflict id from sync_list_conflicts') },
    async (args) => {
      try {
        const sync = getSync();
        if (!sync) return fail(NO_SYNC);
        const conflict = (await sync.listConflicts()).find((c) => c.id === args.id);
        if (!conflict) return fail(`Conflict not found: ${args.id}`);
        if (!conflict.conflictPath) {
          const hid = parseHistoryId(conflict.id);
          if (!hid || !sync.describeHistoryConflict) {
            return ok({ kind: 'history', conflict, note: 'This Geode build cannot describe history conflicts; the user resolves it in Settings → Sync.' });
          }
          const comparison = (await sync.describeHistoryConflict(hid.entityId)) as {
            comparable?: boolean;
            heads?: Array<{ recordId: string; deleted?: boolean }>;
          };
          let local: string | null = null;
          const versions: Array<{ recordId: string; text: string | null }> = [];
          if (comparison.comparable && sync.readHistoryConflictText) {
            local = clip(await sync.readHistoryConflictText(hid.entityId, { kind: 'current' }).catch(() => null));
            for (const h of comparison.heads ?? []) {
              const text = h.deleted ? null : await sync.readHistoryConflictText(hid.entityId, { kind: 'version', recordId: h.recordId }).catch(() => null);
              versions.push({ recordId: h.recordId, text: clip(text) });
            }
          }
          return ok({
            kind: 'history',
            conflict,
            comparison,
            local,
            versions: versions.map((v) => ({ ...v, diffFromLocal: local !== null && v.text !== null ? lineDiff(local, v.text) : null })),
            note: 'To resolve: keep-local, or pass recordId of one displayed version with accept-remote.',
          });
        }
        const local = await readIfExists(conflict.path);
        const remote = await readIfExists(conflict.conflictPath);
        return ok({
          kind: 'sibling',
          conflict,
          localExists: local !== null,
          remoteExists: remote !== null,
          local: clip(local),
          remote: clip(remote),
          diff: local !== null && remote !== null ? lineDiff(local, remote) : null,
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const resolveTool = tool(
    'sync_resolve_conflict',
    'Resolves a sync conflict. Requires user approval on every call: explain the proposed resolution first. "keep-local" keeps the local file; "accept-remote" takes the remote version. To apply a merge, pass mergedContent: it is written to the file, then resolved as keep-local. Remote copies stay available for recovery.',
    {
      id: z.string().describe('Conflict id from sync_list_conflicts'),
      resolution: z.enum(['keep-local', 'accept-remote']).describe('Which side wins (ignored in favour of keep-local when mergedContent is given)'),
      recordId: z.string().optional().describe('History conflicts: the record id of the version to accept (from sync_inspect_conflict)'),
      mergedContent: z.string().optional().describe('Full merged file content to write before resolving as keep-local'),
    },
    async (args) => {
      try {
        const sync = getSync();
        if (!sync) return fail(NO_SYNC);
        const conflict = (await sync.listConflicts()).find((c) => c.id === args.id);
        if (!conflict) return fail(`Conflict not found: ${args.id}`);
        if (!conflict.conflictPath) {
          const hid = parseHistoryId(conflict.id);
          if (!hid || !sync.resolveHistoryConflict) return fail('This Geode build cannot resolve history conflicts; resolve it in Settings → Sync.');
          if (args.mergedContent !== undefined) return fail('mergedContent is only supported for sibling conflicts.');
          if (args.resolution === 'accept-remote' && !args.recordId) return fail('History conflicts need recordId to accept a version (see sync_inspect_conflict).');
          if (args.recordId && !hid.heads.includes(args.recordId)) return fail('recordId is not one of this conflict\'s versions.');
          await sync.resolveHistoryConflict({
            entityId: hid.entityId,
            heads: hid.heads,
            choice: args.resolution === 'accept-remote' ? { kind: 'version', recordId: args.recordId! } : { kind: 'current' },
          });
          return ok({ resolved: true, id: args.id, resolution: args.resolution, recordId: args.recordId ?? null });
        }
        let resolution = args.resolution;
        if (args.mergedContent !== undefined) {
          if (!conflict.conflictPath) return fail('mergedContent is only supported for sibling conflicts.');
          await writeLocal(conflict.path, args.mergedContent);
          resolution = 'keep-local';
        }
        await sync.resolveConflict(args.id, resolution);
        return ok({ resolved: true, id: args.id, resolution, mergedWritten: args.mergedContent !== undefined });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return {
    sync_list_conflicts: listTool as ToolDef,
    sync_inspect_conflict: inspectTool as unknown as ToolDef,
    sync_resolve_conflict: resolveTool as unknown as ToolDef,
  };
}

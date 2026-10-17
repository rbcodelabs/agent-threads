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
}

export interface SyncToolsPort {
  app: Pick<App, 'vault'>;
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
  const adapter = app.vault.adapter;

  const getSync = (): GeodeSyncApi | null => {
    const sync = (app as unknown as { sync?: Partial<GeodeSyncApi> }).sync;
    return sync && typeof sync.listConflicts === 'function' && typeof sync.resolveConflict === 'function'
      ? (sync as GeodeSyncApi)
      : null;
  };
  const NO_SYNC = 'Geode sync is not available in this host (app.sync missing).';

  const readIfExists = async (p: string): Promise<string | null> => {
    const np = normalizePath(p);
    return (await adapter.exists(np)) ? adapter.read(np) : null;
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
          return ok({
            kind: 'history',
            conflict,
            note: 'History conflict: only head metadata is available. Propose a resolution to the user; they resolve it in Settings → Sync.',
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
      mergedContent: z.string().optional().describe('Full merged file content to write before resolving as keep-local'),
    },
    async (args) => {
      try {
        const sync = getSync();
        if (!sync) return fail(NO_SYNC);
        const conflict = (await sync.listConflicts()).find((c) => c.id === args.id);
        if (!conflict) return fail(`Conflict not found: ${args.id}`);
        let resolution = args.resolution;
        if (args.mergedContent !== undefined) {
          if (!conflict.conflictPath) return fail('mergedContent is only supported for sibling conflicts.');
          await adapter.write(normalizePath(conflict.path), args.mergedContent);
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
    sync_list_conflicts: listTool,
    sync_inspect_conflict: inspectTool,
    sync_resolve_conflict: resolveTool,
  };
}

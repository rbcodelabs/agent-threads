/**
 * Vault tools: search, links, metadata, listing, Obsidian Sync history and Vault Bridges.
 * Moved verbatim out of ObsidianTools.ts (one factory over a narrow port); see toolRouting.ts for where each runs.
 */

import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk/browser';
import { TFile, normalizePath } from 'obsidian';
import path from 'path';
import { tokenizeQuery, findBestExcerpt } from '../searchUtils';
import { createSyncTools } from './sync';
import { listVault, vaultListSource } from '../vaultList';
import type { ObsidianMcpServerOptions } from '../ObsidianTools';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { App } from 'obsidian';

type ToolDef = SdkMcpToolDefinition<any>;

export interface VaultToolsPort {
  app: Pick<App, 'metadataCache' | 'vault'>;
  options: Pick<ObsidianMcpServerOptions, never>;
}

const pathSchema = { path: z.string().describe('Vault-relative path of the file') };

const navigateToFileSchema = {
  path: z.string().describe('Vault-relative path of the file to open'),
  newLeaf: z.boolean().optional().describe('If true, open in a new tab'),
};
const vaultListSchema = {
  path: z.string().optional().describe('Vault-relative folder to list. Omit (or "") for the vault root. Absolute paths and ".." are rejected.'),
  recursive: z.boolean().optional().describe('List subfolders too (default false).'),
  limit: z.number().int().positive().optional().describe('Maximum entries to return (default 500, max 2000).'),
};
const searchVaultSchema = {
  query: z.string().describe('Search string to match against file paths and content'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of results to return (default 20)'),
};
const addVaultBridgeSchema = {
  name: z.string().describe('Human-readable label for the bridge (e.g. "Agentic PM Playbook")'),
  repoPath: z.string().describe('Absolute local path to the git repository root'),
  vaultPath: z
    .string()
    .describe('Vault-relative destination path (e.g. "Playbooks/Agentic PM Playbook")'),
  sourcePath: z
    .string()
    .optional()
    .describe('Subfolder within the repo to copy. Omit to sync the whole repo.'),
  branch: z.string().optional().describe('Git branch to pull from. Defaults to "main".'),
  autoSync: z
    .boolean()
    .optional()
    .describe('Pull this bridge when the host app opens. Defaults to true.'),
  syncNow: z
    .boolean()
    .optional()
    .describe('Immediately sync after adding. Defaults to false.'),
};

export function createVaultTools(port: VaultToolsPort): Record<string, ToolDef> {
  const { app, options } = port;
  const boundSearchVault = tool(
    'obsidian_search_vault',
    'Searches markdown files in the vault by filename and content. Tokenizes multi-word queries so each term is matched independently — partial matches across scattered words are found. Returns results ranked by relevance score (filename hits weighted 10x) with a ~300-char excerpt from the densest matching region.',
    searchVaultSchema,
    async (args, _extra) => {
      try {
        const { query, limit = 20 } = args;

        const terms = tokenizeQuery(query);
        if (terms.length === 0) {
          return { content: [{ type: 'text' as const, text: JSON.stringify([]) }] };
        }

        const files = app.vault.getMarkdownFiles();
        const scored: Array<{
          path: string;
          matchType: 'filename' | 'content';
          score: number;
          excerpt?: string;
        }> = [];

        for (const file of files) {
          const pathLower = file.path.toLowerCase();

          // Filename score: 10 points per matching term (weighted above content hits)
          let filenameScore = 0;
          for (const term of terms) {
            if (pathLower.includes(term)) filenameScore += 10;
          }

          // Content score: count total occurrences of each term across the file
          let contentScore = 0;
          let excerpt: string | undefined;
          try {
            const content = await app.vault.cachedRead(file);
            const contentLower = content.toLowerCase();
            for (const term of terms) {
              let idx = contentLower.indexOf(term);
              while (idx !== -1) {
                contentScore++;
                idx = contentLower.indexOf(term, idx + 1);
              }
            }
            if (contentScore > 0) {
              excerpt = findBestExcerpt(content, contentLower, terms);
            }
          } catch {
            // Skip unreadable files
          }

          const totalScore = filenameScore + contentScore;
          if (totalScore > 0) {
            scored.push({
              path: file.path,
              matchType: filenameScore > 0 ? 'filename' : 'content',
              score: totalScore,
              excerpt,
            });
          }
        }

        scored.sort((a, b) => b.score - a.score);
        const results = scored.slice(0, limit).map(({ path, matchType, score, excerpt }) => ({
          path,
          matchType,
          score,
          ...(excerpt ? { excerpt } : {}),
        }));

        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundGetBacklinks = tool(
    'obsidian_get_backlinks',
    'Returns all notes that link to the specified file (backlinks), with the source path and original link text.',
    pathSchema,
    async (args, _extra) => {
      try {
        const abstract = app.vault.getAbstractFileByPath(normalizePath(args.path));
        if (!(abstract instanceof TFile)) {
          return {
            content: [{ type: 'text' as const, text: `Error: File not found: ${args.path}` }],
            isError: true,
          };
        }

        type BacklinksCache = {
          getBacklinksForFile: (file: TFile) => {
            data: {
              forEach: (
                cb: (refs: Array<{ original: string }>, sourcePath: string) => void,
              ) => void;
            };
          };
        };
        const backlinksObj = (app.metadataCache as unknown as BacklinksCache).getBacklinksForFile(abstract);
        const results: Array<{ sourcePath: string; linkTexts: string[] }> = [];

        backlinksObj.data.forEach((refs, sourcePath) => {
          results.push({ sourcePath, linkTexts: refs.map((r) => r.original) });
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundGetOutgoingLinks = tool(
    'obsidian_get_outgoing_links',
    'Returns all wikilinks and markdown links that a note makes to other files, with display text and resolved vault paths.',
    pathSchema,
    async (args, _extra) => {
      try {
        const abstract = app.vault.getAbstractFileByPath(normalizePath(args.path));
        if (!(abstract instanceof TFile)) {
          return {
            content: [{ type: 'text' as const, text: `Error: File not found: ${args.path}` }],
            isError: true,
          };
        }

        const cache = app.metadataCache.getFileCache(abstract);
        const links = (cache?.links ?? []).map((linkRef) => ({
          link: linkRef.link,
          displayText: linkRef.displayText ?? linkRef.link,
          resolvedPath:
            app.metadataCache.getFirstLinkpathDest(linkRef.link, args.path)?.path ?? null,
        }));

        return { content: [{ type: 'text' as const, text: JSON.stringify(links, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundGetNoteMetadata = tool(
    'obsidian_get_note_metadata',
    'Returns the full metadata cache entry for a note: frontmatter, tags, wikilinks, and headings.',
    pathSchema,
    async (args, _extra) => {
      try {
        const abstract = app.vault.getAbstractFileByPath(normalizePath(args.path));
        if (!(abstract instanceof TFile)) {
          return {
            content: [{ type: 'text' as const, text: `Error: File not found: ${args.path}` }],
            isError: true,
          };
        }

        const cache = app.metadataCache.getFileCache(abstract);
        const links = (cache?.links ?? []).map((linkRef) => ({
          link: linkRef.link,
          displayText: linkRef.displayText ?? linkRef.link,
          resolvedPath:
            app.metadataCache.getFirstLinkpathDest(linkRef.link, args.path)?.path ?? null,
        }));

        const result = {
          path: args.path,
          frontmatter: cache?.frontmatter ?? null,
          tags: (cache?.tags ?? []).map((t) => t.tag),
          links,
          headings: (cache?.headings ?? []).map((h) => ({ level: h.level, heading: h.heading })),
        };

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundVaultList = tool(
    'vault_list',
    'Lists a vault folder (read-only; no shell). Returns { path, entries: [{ path, type: "file"|"folder", size?, mtime? }], truncated }, with vault-relative paths sorted by path. `path` is a vault-relative folder (default: vault root); absolute paths and ".." are rejected. `recursive` walks subfolders (default false). `limit` caps entries (default 500, max 2000); `truncated` is true when more exist. The host config folder (e.g. .obsidian) is skipped unless you list it explicitly. Use this instead of ls/find.',
    vaultListSchema,
    async (args, _extra) => {
      try {
        // Obsidian's adapter implements list(); Geode's does not, so fall back to
        // the vault's file tree there (see vaultListSource).
        const result = await listVault(vaultListSource(app.vault as unknown as Parameters<typeof vaultListSource>[0]), {
          path: args.path,
          recursive: args.recursive,
          limit: args.limit,
          configDir: app.vault.configDir,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // ── Obsidian Sync version history tools ──────────────────────────────────
  // These reach into the internal sync plugin to expose file version history
  // and restore capability as MCP tools so Claude can help recover files.

  type SyncVersion = {
    uid: number;
    ts: number;    // Unix timestamp in milliseconds
    size: number;
    device: string;
    folder: string;
    extension: string;
  };

  type ObsidianSyncPlugin = {
    // Return type is unknown — Obsidian Sync's internal API may return a raw array
    // OR a wrapped object (e.g. { versions: [...] }). Use parseSyncHistory() to normalise.
    getHistory(file: TFile): Promise<unknown>;
    // downloadVersion / restoreVersion / similar — name is undocumented.
    // Use findDownloadMethod() to locate it at runtime.
    [key: string]: unknown;
  };

  function getSyncPlugin(): ObsidianSyncPlugin | null {
    const internal = (app as unknown as {
      internalPlugins?: { plugins?: Record<string, { instance?: unknown; enabled?: boolean }> };
    }).internalPlugins;
    const plugin = internal?.plugins?.['sync'];
    if (!plugin?.enabled) return null;
    return plugin.instance as ObsidianSyncPlugin ?? null;
  }

  /**
   * Normalise whatever getHistory() returns into a SyncVersion array.
   * The Obsidian Sync internal API is undocumented; it may return a raw array
   * or a wrapped object like { versions: [...] } or { items: [...] }.
   * Returns { versions, raw } so callers can surface the raw shape on failure.
   */
  function parseSyncHistory(raw: unknown): { versions: SyncVersion[]; raw: unknown } {
    if (Array.isArray(raw)) return { versions: raw as SyncVersion[], raw };
    if (raw && typeof raw === 'object') {
      for (const key of ['versions', 'items', 'history', 'data']) {
        const candidate = (raw as Record<string, unknown>)[key];
        if (Array.isArray(candidate)) return { versions: candidate as SyncVersion[], raw };
      }
    }
    return { versions: [], raw };
  }

  /**
   * Find the restore/download method on the Sync plugin instance by trying known
   * candidate names. Returns { name, fn } if found, or { availableMethods } for
   * debugging when none match.
   */
  function findRestoreMethod(sync: ObsidianSyncPlugin): (
    | { name: string; fn: (...args: unknown[]) => Promise<unknown> }
    | { availableMethods: string[] }
  ) {
    const candidates = ['restoreVersion', 'downloadVersion', 'downloadFile', 'restore', 'getVersion'];
    for (const name of candidates) {
      if (typeof sync[name] === 'function') {
        return { name, fn: (sync[name] as (...args: unknown[]) => Promise<unknown>).bind(sync) };
      }
    }
    const availableMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(sync))
      .concat(Object.keys(sync))
      .filter((k) => typeof sync[k] === 'function');
    return { availableMethods };
  }

  const boundGetFileHistory = tool(
    'obsidian_get_file_history',
    [
      'Returns the Obsidian Sync version history for a file.',
      'Each entry includes a uid (version ID for use with vault_restore_file_version), ISO timestamp, file size in bytes, and the device that saved it.',
      'Requires Obsidian Sync to be active and the file to be synced.',
    ].join(' '),
    { path: z.string().describe('Vault-relative path of the file') },
    async (args, _extra) => {
      try {
        const file = app.vault.getAbstractFileByPath(normalizePath(args.path));
        if (!(file instanceof TFile)) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `File not found: ${args.path}` }) }],
            isError: true,
          };
        }
        const sync = getSyncPlugin();
        if (!sync) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Obsidian Sync is not available or not enabled.' }) }],
            isError: true,
          };
        }
        const raw = await sync.getHistory(file);
        const { versions, raw: rawShape } = parseSyncHistory(raw);
        if (versions.length === 0 && rawShape !== null) {
          // Surface the actual response shape so callers can report it
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'Obsidian Sync returned an unrecognised history shape. Please report this.',
              raw: rawShape,
            }) }],
            isError: true,
          };
        }
        // Extract only known primitives — raw version objects may have circular refs.
        const entries = versions.map((v) => ({
          uid: v.uid,
          date: new Date(v.ts).toISOString(),
          ts: v.ts,
          size: v.size,
          device: String(v.device ?? ''),
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(entries, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundRestoreFileVersion = tool(
    'obsidian_restore_file_version',
    [
      'Restores a specific version of a file from Obsidian Sync history, overwriting the current content.',
      'Use vault_get_file_history first to find the uid of the version to restore.',
      'The current file content is preserved in sync history before the restore.',
      'Requires Obsidian Sync to be active.',
    ].join(' '),
    {
      path: z.string().describe('Vault-relative path of the file to restore'),
      uid: z.number().int().describe('Version UID from vault_get_file_history to restore'),
    },
    async (args, _extra) => {
      try {
        const file = app.vault.getAbstractFileByPath(normalizePath(args.path));
        if (!(file instanceof TFile)) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `File not found: ${args.path}` }) }],
            isError: true,
          };
        }
        const sync = getSyncPlugin();
        if (!sync) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Obsidian Sync is not available or not enabled.' }) }],
            isError: true,
          };
        }
        const { versions: history, raw: rawShape } = parseSyncHistory(await sync.getHistory(file));
        if (history.length === 0 && rawShape !== null) {
          // rawShape may be circular — only surface its keys, never the value itself
          const shapeKeys = rawShape && typeof rawShape === 'object'
            ? Object.keys(rawShape as object)
            : [typeof rawShape];
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'Obsidian Sync returned an unrecognised history shape. Please report this.',
              shapeKeys,
            }) }],
            isError: true,
          };
        }
        const version = history.find((v) => v.uid === args.uid);
        if (!version) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `Version uid ${args.uid} not found in history for ${args.path}. Use vault_get_file_history to list available versions.` }) }],
            isError: true,
          };
        }
        // Extract only known primitive fields before any JSON.stringify — the raw
        // version objects from the Sync API may carry extra properties with circular refs.
        const safeVersion = {
          uid: version.uid,
          ts: version.ts,
          size: version.size,
          device: String(version.device ?? ''),
        };

        const downloadResult = findRestoreMethod(sync);
        if ('availableMethods' in downloadResult) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'Could not find a restore method on the Obsidian Sync plugin. Please report the available methods.',
              availableMethods: downloadResult.availableMethods,
            }) }],
            isError: true,
          };
        }
        // restoreVersion() calls JSON.stringify on the version object internally.
        // The version objects from Obsidian Sync contain RxJS observable state
        // (t._closed[0].e circular chain) that JSON.stringify cannot handle.
        // Workaround: temporarily replace JSON.stringify with a circular-safe
        // version for the duration of the restoreVersion call, then restore it.
        const _origStringify = JSON.stringify;
        JSON.stringify = function(value: unknown, replacer?: unknown, space?: unknown): string {
          const seen = new WeakSet<object>();
          function safeReplacer(key: string, val: unknown): unknown {
            if (val !== null && typeof val === 'object') {
              if (seen.has(val as object)) return '[Circular]';
              seen.add(val as object);
            }
            return typeof replacer === 'function'
              ? (replacer as (k: string, v: unknown) => unknown)(key, val)
              : val;
          }
          return _origStringify.call(JSON, value, safeReplacer as never, space as never);
        };

        // Try argument shapes in order — the correct signature is undocumented.
        // restoreVersion(uid) is the winner: it restores the file as a side effect
        // and returns undefined. We must NOT call vault.modify afterwards.
        const argShapes: Array<{ label: string; args: unknown[] }> = [
          { label: '(uid)',           args: [version.uid] },
          { label: '(file, uid)',     args: [file, version.uid] },
          { label: '(file, version)', args: [file, version] },
        ];

        let succeeded = false;
        let downloaded: unknown;
        let lastErr = '';
        try {
          for (const shape of argShapes) {
            try {
              downloaded = await downloadResult.fn(...shape.args);
              succeeded = true;
              break;
            } catch (dlErr: unknown) {
              lastErr = dlErr instanceof Error ? dlErr.message : String(dlErr);
            }
          }
        } finally {
          JSON.stringify = _origStringify;
        }

        if (!succeeded) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `All restore attempts failed. Last error: ${lastErr}` }) }],
            isError: true,
          };
        }

        // If the method returned a string, it's the file content and we write it ourselves.
        // If it returned undefined/null, restoreVersion handled the write as a side effect.
        if (typeof downloaded === 'string' && downloaded.length > 0) {
          await app.vault.modify(file, downloaded);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              path: args.path,
              restoredUid: safeVersion.uid,
              restoredDate: new Date(safeVersion.ts).toISOString(),
              device: safeVersion.device,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // ── Vault Bridges tools ───────────────────────────────────────────────────
  // These reach into the vault-bridges plugin API (if installed) so agents can
  // inspect and configure bridges without editing data.json or restarting the host.

  type VaultBridgesPlugin = {
    api: {
      getBridges(): Array<{
        id: string;
        name: string;
        repoPath: string;
        sourcePath: string;
        vaultPath: string;
        branch: string;
        autoSync: boolean;
        status: string;
        lastSynced?: string;
        lastPulled?: string;
        lastPushed?: string;
        isDirty?: boolean;
        lastError?: string;
      }>;
      addBridge(options: {
        name: string;
        repoPath: string;
        vaultPath: string;
        sourcePath?: string;
        branch?: string;
        autoSync?: boolean;
        syncNow?: boolean;
      }): Promise<{ id: string; name: string; repoPath: string; vaultPath: string; branch: string; status: string }>;
    };
  };

  function getVaultBridgesPlugin(): VaultBridgesPlugin | null {
    return (app as unknown as { plugins: { plugins: Record<string, unknown> } })
      .plugins?.plugins?.['vault-bridges'] as VaultBridgesPlugin | null ?? null;
  }

  const boundListVaultBridges = tool(
    'obsidian_list_vault_bridges',
    'Returns all configured Vault Bridges. Use this before adding a bridge to avoid duplicates. Returns an empty array if the vault-bridges plugin is not installed.',
    {},
    async (_args, _extra) => {
      try {
        const vb = getVaultBridgesPlugin();
        if (!vb) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'vault-bridges plugin is not installed or not enabled.' }),
            }],
            isError: true,
          };
        }
        const bridges = vb.api.getBridges();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(bridges, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  const boundAddVaultBridge = tool(
    'obsidian_add_vault_bridge',
    [
      'Adds a new Vault Bridge (a live link between a local git repo and a vault folder).',
      'If a bridge with the same repoPath + vaultPath already exists, the existing bridge is returned without creating a duplicate.',
      'Call vault_list_bridges first to check what is already configured.',
      'Requires the vault-bridges plugin to be installed and enabled.',
    ].join(' '),
    addVaultBridgeSchema,
    async (args, _extra) => {
      try {
        const vb = getVaultBridgesPlugin();
        if (!vb) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'vault-bridges plugin is not installed or not enabled.' }),
            }],
            isError: true,
          };
        }
        const bridge = await vb.api.addBridge({
          name: args.name,
          repoPath: args.repoPath,
          vaultPath: args.vaultPath,
          sourcePath: args.sourcePath,
          branch: args.branch,
          autoSync: args.autoSync,
          syncNow: args.syncNow,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(bridge, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );


  const toolDefs: Array<ToolDef | undefined> = [
    boundSearchVault as ToolDef | undefined,
    boundGetBacklinks as ToolDef | undefined,
    boundGetOutgoingLinks as ToolDef | undefined,
    boundGetNoteMetadata as ToolDef | undefined,
    boundVaultList as ToolDef | undefined,
    boundGetFileHistory as ToolDef | undefined,
    boundRestoreFileVersion as ToolDef | undefined,
    boundListVaultBridges as ToolDef | undefined,
    boundAddVaultBridge as ToolDef | undefined,
  ];
  const toolNames = [
    'obsidian_search_vault',
    'obsidian_get_backlinks',
    'obsidian_get_outgoing_links',
    'obsidian_get_note_metadata',
    'vault_list',
    'obsidian_get_file_history',
    'obsidian_restore_file_version',
    'obsidian_list_vault_bridges',
    'obsidian_add_vault_bridge',
  ];
  return {
    ...Object.fromEntries(toolNames.flatMap((name, i): Array<[string, ToolDef]> => (toolDefs[i] ? [[name, toolDefs[i]!]] : []))),
    ...createSyncTools({ app }),
  };
}

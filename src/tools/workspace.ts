/**
 * Workspace and host-UI tools: open tabs, active file, navigate, insert at cursor, command palette, Web Viewer, document watches.
 * Moved verbatim out of ObsidianTools.ts (one factory over a narrow port); see toolRouting.ts for where each runs.
 */

import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk/browser';
import { TFile, normalizePath } from 'obsidian';
import path from 'path';
import type { ObsidianMcpServerOptions } from '../ObsidianTools';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { App } from 'obsidian';

type ToolDef = SdkMcpToolDefinition<any>;

export interface WorkspaceToolsPort {
  app: Pick<App, 'vault' | 'workspace'>;
  options: Pick<ObsidianMcpServerOptions, 'onListWatchedDocuments' | 'onUnwatchDocument' | 'onWatchDocument' | 'openContextualFile' | 'openContextualUrl'>;
}

const navigateToFileSchema = {
  path: z.string().describe('Vault-relative path of the file to open'),
  newLeaf: z.boolean().optional().describe('If true, open in a new tab'),
};
const insertAtCursorSchema = {
  text: z.string().describe('Text to insert at the current cursor position in the active editor'),
};
const listCommandsSchema = {
  query: z
    .string()
    .optional()
    .describe(
      'Optional filter — returns only commands whose name or ID contains this string (case-insensitive)',
    ),
};
const executeCommandSchema = {
  commandId: z
    .string()
    .describe(
      'The command ID to execute (e.g. "editor:toggle-bold", "obsidian-git:push"). Use host_list_commands to discover available IDs.',
    ),
};

export function createWorkspaceTools(port: WorkspaceToolsPort): Record<string, ToolDef> {
  const { app, options } = port;
  const boundGetOpenTabs = tool(
    'obsidian_get_open_tabs',
    'Returns all open tabs in the Obsidian workspace with their path, title, type, and whether they are the active tab.',
    {},
    async (_args, _extra) => {
      try {
        const activeFile = app.workspace.getActiveFile();
        const tabs: Array<{ path: string; title: string; type: string; isActive: boolean }> = [];

        app.workspace.iterateAllLeaves((leaf) => {
          const view = leaf.view as unknown as Record<string, unknown>;
          const file = view?.file;
          if (file instanceof TFile) {
            tabs.push({
              path: file.path,
              title: file.basename,
              type: leaf.view.getViewType(),
              isActive: file.path === activeFile?.path,
            });
          }
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(tabs, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundGetActiveFile = tool(
    'obsidian_get_active_file',
    'Returns metadata for the currently active file in Obsidian (path, basename, extension, mtime, ctime, size), or null if nothing is open.',
    {},
    async (_args, _extra) => {
      try {
        const file = app.workspace.getActiveFile();
        if (!file) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(null) }] };
        }
        const result = {
          path: file.path,
          basename: file.basename,
          extension: file.extension,
          mtime: file.stat.mtime,
          ctime: file.stat.ctime,
          size: file.stat.size,
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundNavigateToFile = tool(
    'obsidian_navigate_to_file',
    'Opens a file in Obsidian by its vault-relative path. Optionally opens it in a new tab.',
    navigateToFileSchema,
    async (args, _extra) => {
      try {
        const abstract = app.vault.getAbstractFileByPath(normalizePath(args.path));
        if (!(abstract instanceof TFile)) {
          return {
            content: [{ type: 'text' as const, text: `Error: File not found: ${args.path}` }],
            isError: true,
          };
        }
        const handledContextually = await options.openContextualFile?.(abstract, args.newLeaf ?? false) ?? false;
        if (!handledContextually) {
          const leaf = app.workspace.getLeaf(args.newLeaf ? 'tab' : false);
          await leaf.openFile(abstract);
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true }, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: msg }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );

  const boundInsertAtCursor = tool(
    'obsidian_insert_at_cursor',
    'Inserts text at the cursor position in the currently active Obsidian editor, replacing any current selection.',
    insertAtCursorSchema,
    async (args, _extra) => {
      try {
        const editor = app.workspace.activeEditor?.editor;
        if (!editor) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: 'No active editor' }, null, 2),
              },
            ],
            isError: true,
          };
        }
        editor.replaceSelection(args.text);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true }, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: msg }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );

  const boundWatchDocument = tool(
    'watch_document',
    [
      'Watches a vault document and alerts this thread whenever its content changes — any edit triggers the alert, not just comments.',
      'The watch is owned by this thread only; another thread watching the same path is entirely independent (no dedup/merge).',
      'Re-watching a path this thread already watches (including a previously disabled watch) re-enables it instead of creating a duplicate.',
    ].join(' '),
    { path: z.string().describe('Vault-relative path of the document to watch') },
    async (args, _extra) => {
      try {
        if (!options.onWatchDocument) throw new Error('Document watching is unavailable in this host.');
        const result = await options.onWatchDocument(args.path);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }], isError: true };
      }
    },
  );

  const boundUnwatchDocument = tool(
    'unwatch_document',
    'Removes this thread\'s own watch(es) matching the given path and/or id. Never removes a watch owned by another thread on the same path. Provide at least one of path or id.',
    {
      path: z.string().optional().describe('Vault-relative path of a document this thread is watching'),
      id: z.string().optional().describe('ID of a specific watch, as returned by watch_document or list_watched_documents'),
    },
    async (args, _extra) => {
      try {
        if (!args.path && !args.id) throw new Error('Provide at least one of path or id.');
        if (!options.onUnwatchDocument) throw new Error('Document watching is unavailable in this host.');
        const result = await options.onUnwatchDocument({ path: args.path, id: args.id });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }], isError: true };
      }
    },
  );

  const boundListWatchedDocuments = tool(
    'list_watched_documents',
    'Returns this thread\'s own watched documents: id, path, createdAt, lastAlertedAt.',
    {},
    async (_args, _extra) => {
      try {
        const result = options.onListWatchedDocuments?.() ?? [];
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // ── Command tools ─────────────────────────────────────────────────────────────
  // Obsidian's command registry is not in the official TS types; cast via unknown.
  type ObsidianCommandsRegistry = {
    commands: Record<string, { id: string; name: string }>;
    executeCommandById: (id: string) => boolean;
  };

  const boundListCommands = tool(
    'obsidian_list_commands',
    'Returns all registered host commands with their ID and name, sorted alphabetically by ID. Optionally filter by a query string. Use this to discover command IDs before calling host_execute_command.',
    listCommandsSchema,
    async (args, _extra) => {
      try {
        const registry = (app as unknown as { commands: ObsidianCommandsRegistry }).commands;
        const all = Object.values(registry.commands);
        const { query } = args;
        const filtered = query
          ? all.filter(
              (cmd) =>
                cmd.id.toLowerCase().includes(query.toLowerCase()) ||
                cmd.name.toLowerCase().includes(query.toLowerCase()),
            )
          : all;
        filtered.sort((a, b) => a.id.localeCompare(b.id));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(filtered, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundExecuteCommand = tool(
    'obsidian_execute_command',
    'Executes a host command by its ID (e.g. "obsidian-git:push", "editor:toggle-bold"). Use host_list_commands to discover available command IDs. Returns success or failure.',
    executeCommandSchema,
    async (args, _extra) => {
      try {
        const registry = (app as unknown as { commands: ObsidianCommandsRegistry }).commands;
        if (!(args.commandId in registry.commands)) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Unknown command: "${args.commandId}". Use host_list_commands to see available commands.`,
              }, null, 2),
            }],
            isError: true,
          };
        }
        const ok = registry.executeCommandById(args.commandId);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: ok, commandId: args.commandId }, null, 2),
          }],
          ...(ok ? {} : { isError: true }),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }, null, 2) }],
          isError: true,
        };
      }
    },
  );

  // ── Web Viewer tool ───────────────────────────────────────────────────────────
  // Opens a URL directly in Obsidian's built-in Web Viewer panel.
  // Falls back to the system browser if the webviewer view type is unavailable
  // (e.g. on mobile or if the core plugin is disabled).

  const boundOpenUrl = tool(
    'obsidian_open_url',
    [
      'Opens a URL in the Obsidian Web Viewer panel.',
      'Reuses an existing webviewer tab if one is open; otherwise opens the URL in a new tab.',
      'Use this to open local dev servers (e.g. http://localhost:8765/), web pages, or HTML files served over HTTP.',
      'Falls back to the system browser if the Web Viewer core plugin is not available.',
    ].join(' '),
    {
      url: z.string().describe('The URL to open (e.g. "http://localhost:8765/index.html")'),
      newTab: z.boolean().optional().describe('Force opening in a new tab even if a webviewer tab is already open (default: false)'),
    },
    async (args, _extra) => {
      try {
        const { url, newTab = false } = args;

        const contextualResult = await options.openContextualUrl?.(url, newTab) ?? false;
        if (contextualResult) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: true, url, reusedTab: contextualResult.reusedTab }, null, 2),
            }],
          };
        }

        // Try to find an existing webviewer leaf to reuse
        const existing = app.workspace.getLeavesOfType('webviewer');
        let leaf = (!newTab && existing.length > 0) ? existing[0] : null;

        if (!leaf) {
          // Open a new split/tab — use 'tab' to keep it non-destructive
          leaf = app.workspace.getLeaf('tab');
        }

        // Reveal the leaf so it's visible
        app.workspace.revealLeaf(leaf);

        // Set the webviewer view state with the URL
        await leaf.setViewState({
          type: 'webviewer',
          active: true,
          state: { url },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, url, reusedTab: !newTab && existing.length > 0 }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            success: false,
            error: msg,
          }, null, 2) }],
          isError: true,
        };
      }
    },
  );


  const toolDefs: Array<ToolDef | undefined> = [
    boundGetOpenTabs as ToolDef | undefined,
    boundGetActiveFile as ToolDef | undefined,
    boundNavigateToFile as ToolDef | undefined,
    boundInsertAtCursor as ToolDef | undefined,
    boundWatchDocument as ToolDef | undefined,
    boundUnwatchDocument as ToolDef | undefined,
    boundListWatchedDocuments as ToolDef | undefined,
    boundListCommands as ToolDef | undefined,
    boundExecuteCommand as ToolDef | undefined,
    boundOpenUrl as ToolDef | undefined,
  ];
  const toolNames = [
    'obsidian_get_open_tabs',
    'obsidian_get_active_file',
    'obsidian_navigate_to_file',
    'obsidian_insert_at_cursor',
    'watch_document',
    'unwatch_document',
    'list_watched_documents',
    'obsidian_list_commands',
    'obsidian_execute_command',
    'obsidian_open_url',
  ];
  return Object.fromEntries(toolNames.flatMap((name, i): Array<[string, ToolDef]> => (toolDefs[i] ? [[name, toolDefs[i]!]] : [])));
}

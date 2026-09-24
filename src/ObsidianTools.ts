import { z } from 'zod';
// Import from the browser entry point to avoid Node.js-only APIs (e.g. setTimeout().unref())
// that crash in Electron's renderer context.
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk/browser';
import { mcpRegistrationSchema, type McpRegistrationResult } from './mcpServerStore';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessDynamicTool } from './HarnessSession';
import { App, TFile, normalizePath } from 'obsidian';
import type { ScheduledItem } from './types';
import type { SchedulerItemPatch } from './Scheduler';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { tokenizeQuery, findBestExcerpt } from './searchUtils';
import { execFileSync } from 'child_process';
import { secretStorageKey } from './secretUtils';
import { AGENT_BROWSER_READ_ONLY_TOOL_NAMES, createAgentBrowserTools } from './agentBrowser/agentBrowserTools';
import type { ThreadBrowser } from './agentBrowser/ThreadBrowser';
import { resolveWorktreeRoot, worktreePathFor } from './worktreePaths';
import { bindAgentTool } from './AgentToolContributions';
import {
  SandboxVmManager,
  VM_NETWORK_MODES,
  VM_WORKDIR,
  containerNameForThread,
  isVmNetworkMode,
  resolveExecTimeoutSeconds,
  resolveVmImage,
  resolveVmNetwork,
  type VmCommandRunner,
} from './sandboxVm';
import type {
  InstalledSkillInfo,
  MarketplaceSkill,
  SkillDetailResult,
  SkillSourceListItem,
  SourceUpdateCheckResult,
  InstallSkillParams,
} from './skillManager';
import { LEGACY_MCP_SERVER_NAME } from './productIdentity';

// Reusable Zod schemas for tools that take a file path
const pathSchema = { path: z.string().describe('Vault-relative path of the file') };

const navigateToFileSchema = {
  path: z.string().describe('Vault-relative path of the file to open'),
  newLeaf: z.boolean().optional().describe('If true, open in a new tab'),
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

// ── Thread-state snapshot types ───────────────────────────────────────────────
// Plain data types used by the thread-coordination tools below.
// These are intentionally decoupled from ThreadManager internals so this file
// stays self-contained and can be used in isolation (e.g. tests).

export type UiStatus = 'working' | 'new' | 'reviewed' | 'failed' | 'ready';

/**
 * Returns the Agents List UI bucket label for a thread.
 *
 * Mirrors the exact bucketing logic in AgentDashboard.render():
 *   - working  — thread is actively running, OR has no active foreground
 *                turn but still has an outstanding background task (a
 *                `run_in_background: true` Agent call or Workflow-tool task
 *                that hasn't reported completion yet — see ThreadManager's
 *                `hasActiveBackgroundTasks`)
 *   - failed   — idle, lastError is set
 *   - new      — idle, has messages, not yet reviewed
 *   - reviewed — idle, has messages, reviewed by user
 *   - ready    — idle, no messages, no error
 *
 * Note: the Kanban view has an additional "Awaiting" sub-state (running +
 * pending permission). Those threads appear here as 'working'.
 */
export function computeUiStatus(params: {
  isRunning: boolean;
  hasActiveBackgroundTasks?: boolean;
  lastError?: string;
  messageCount: number;
  reviewed?: boolean;
}): UiStatus {
  if (params.isRunning || params.hasActiveBackgroundTasks) return 'working';
  if (params.lastError) return 'failed';
  if (params.messageCount > 0) return params.reviewed ? 'reviewed' : 'new';
  return 'ready';
}

export interface ThreadSnapshot {
  id: string;
  title: string;
  /**
   * Internal lifecycle status (waiting | active | error | archived).
   * @deprecated Prefer `uiStatus` for display logic — it matches the Agents List UI labels.
   * Use `isRunning` to check whether Claude is actively processing.
   */
  status: string;
  /**
   * The Agents List UI bucket this thread belongs to.
   * One of: 'working' | 'new' | 'reviewed' | 'failed' | 'ready'
   */
  uiStatus: UiStatus;
  /** True while Claude is actively processing a request on this thread */
  isRunning: boolean;
  /** Error message if the thread is in the Failed state, undefined otherwise */
  lastError?: string;
  /** True if the user has opened and reviewed this thread's completed output */
  reviewed?: boolean;
  projectId?: string;
  cwd?: string;
  /** Git root of the origin repo a worktree cwd was cut from, if `cwd` is a worktree. See Thread.originRepoPath. */
  originRepoPath?: string;
  /** Display-only project name for legacy orphaned threads with no other way to resolve one. See Thread.projectNameOverride. */
  projectNameOverride?: string;
  /** URL of the most recent GitHub PR opened during this thread, if any (e.g. https://github.com/owner/repo/pull/42) */
  prUrl?: string;
  /** ID of the scheduled item (cron) whose fire() created this thread, if any. */
  scheduledItemId?: string;
  /** Name of the scheduled item at the time this thread was created, if any. */
  scheduledItemName?: string;
  updatedAt: number;
  /** Number of non-compact messages */
  messageCount: number;
  /** Vault-relative path to the thread's raw JSONL conversation log, if raw logging is enabled. Read it with obsidian_get_thread_log. */
  rawLogPath?: string;
  /**
   * Orchestrator tracking notes for this thread (inferred goal, status, last-reviewed
   * cursor), written via obsidian_set_thread_notes. Never injected into any session's
   * context — visible here purely so the orchestrator can read back its own prior notes.
   */
  managerNotes?: string;
  managerNotesSourceThreadId?: string;
  managerNotesUpdatedAt?: number;
  /** An AI-proposed reply awaiting human approval, set via obsidian_set_thread_proposed_reply. */
  proposedReply?: { text: string; generatedAt: number; sourceThreadId?: string };
}

export interface ThreadMessageSnapshot {
  id: string;
  /** 'user' | 'assistant' */
  role: string;
  content: string;
  timestamp: number;
}

export interface ThreadDetail extends ThreadSnapshot {
  messages: ThreadMessageSnapshot[];
}

export interface ProjectSnapshot {
  id: string;
  name: string;
  description?: string;
  vaultFolder?: string;
  cwdOverride?: string;
  effectiveCwd: string;
  orchestratorThreadId?: string;
}

export interface ProjectUpdatePatch {
  name?: string;
  description?: string;
  cwdOverride?: string;
}

// ── Vault Bridge schema ───────────────────────────────────────────────────────

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

// ── Factory ──────────────────────────────────────────────────────────────────

export interface ObsidianMcpServerOptions {
  /**
   * Agent tools contributed by peers through `extensions.registerAgentTool`,
   * already bound to this thread by the host (ADR-0008).
   *
   * The factory only installs them. It never sees a contribution, an owner or
   * the registry — binding and thread-id injection happen before this point,
   * which is what lets a peer contribute a tool without reaching the factory.
   */
  contributedTools?: readonly import('./AgentToolContributions').BoundAgentTool[];
  onRegisterMcpServer?: (input: unknown) => Promise<McpRegistrationResult>;
  /** Route agent-triggered file navigation through the host's contextual panel policy. */
  openContextualFile?: (file: TFile, newLeaf: boolean) => Promise<boolean>;
  /** Route agent-triggered Web Viewer navigation through the contextual panel policy. */
  openContextualUrl?: (url: string, newTab: boolean) => Promise<false | { reusedTab: boolean }>;
  /**
   * Called when the agent requests a working-directory change. Receives the
   * resolved absolute path.
   *
   * `originRepoPath` is the git root a worktree was created from, passed only
   * by `enter_worktree`/`exit_worktree`:
   *  - `enter_worktree` passes the origin repo's git root, to be persisted on
   *    the thread so its project name (and repair routing) survive the
   *    worktree directory being deleted later.
   *  - `exit_worktree` passes `null` to clear it once back in the origin repo.
   *  - Plain `set_working_directory` calls omit the argument entirely
   *    (`undefined`) — callers should leave any existing value untouched in
   *    that case, distinct from an explicit `null` clear.
   */
  onSetCwd?: (path: string, originRepoPath?: string | null) => void;
  /**
   * Called when the agent schedules a wakeup. delayMs is the delay in milliseconds.
   * Backed by a durable one-shot Scheduler item (survives plugin reload/restart/sleep,
   * same as the Cron tools) — awaited so the tool call doesn't resolve "success" before
   * the wake-up is actually persisted to disk.
   */
  onScheduleWakeup?: (delayMs: number, prompt: string, reason: string) => Promise<void>;
  /**
   * Returns the configured root directory for worktrees created by
   * `enter_worktree`. Undefined/blank falls back to `~/.geode/worktrees`.
   *
   * Read lazily (rather than captured at construction) so a settings change
   * takes effect on the next tool call instead of requiring a session restart.
   */
  getWorktreeRoot?: () => string | undefined;
  /**
   * Returns the configured container image for `enter_vm`. Undefined/blank
   * falls back to `claude-threads-coding:1`. Read lazily for the same reason as
   * {@link getWorktreeRoot}.
   */
  getVmImage?: () => string | undefined;
  /**
   * Returns the configured default network mode for `enter_vm` when the call
   * does not pass one. Anything unrecognised falls back to `'default'`
   * (full egress). Read lazily for the same reason as {@link getWorktreeRoot}.
   */
  getVmDefaultNetwork?: () => string | undefined;
  /**
   * Overrides how sandbox VM commands are executed. Tests inject a fake so
   * command construction and lifecycle transitions are exercised without a
   * macOS 26 container runtime.
   */
  vmCommandRunner?: VmCommandRunner;
  /** Creates a persistent thread and queues its initial prompt. */
  createThread?: (params: {
    prompt: string;
    title?: string;
    cwd?: string;
    projectId?: string | null;
    elevatedProjectId?: string;
  }) => Promise<{ threadId: string; title: string }>;
  /**
   * Initial effective cwd for this session. Pre-seeds the in-session cwd tracker so
   * enter_worktree knows which repo to operate on from the first turn.
   */
  initialCwd?: string;
  /** ID of the current thread. Used by obsidian_get_current_thread. */
  threadId?: string;
  /** Returns the ID of the thread running the bundled orchestrator skill, if one has been created. */
  getOrchestratorThreadId?: () => string | undefined;
  /** Returns whether a thread is any referenced portfolio or Project orchestrator. */
  isOrchestratorThread?: (threadId: string) => boolean;
  /** Returns full detail (metadata + messages) for a thread by ID. */
  getThreadDetail?: (id: string) => ThreadDetail | undefined;
  /** Opens and focuses a thread by ID through the host UI. */
  openThread?: (id: string) => Promise<void>;
  /** Returns metadata snapshots for all threads. */
  getAllThreads?: () => ThreadSnapshot[];
  /** Central coordination boundary. False must be reported without target disclosure. */
  authorizeThread?: (threadId: string, elevatedProjectId: string | undefined, operation: 'read' | 'write' | 'notes') => boolean;
  /**
   * Authorizes the requested destination Project for reassignment. `targetThreadId` lets
   * the implementation detect self-assignment, which an unassigned thread is allowed to do
   * even though it may not move any other thread into a Project. Omitted for call sites
   * (like updating a Project's own settings) where the self-assignment carve-out must
   * never apply.
   */
  authorizeProjectDestination?: (
    projectId: string | undefined,
    elevatedProjectId: string | undefined,
    targetThreadId?: string,
  ) => boolean;
  /**
   * Reads parsed entries from a thread's raw JSONL conversation log, filtered
   * by `type` and tailed to the most recent `limit` entries. Resolves null if
   * no log exists for the thread (raw logging disabled or no events yet).
   */
  readThreadLog?: (
    id: string,
    opts: { limit?: number; type?: string },
  ) => Promise<{ path: string; total: number; returned: number; entries: unknown[] } | null>;
  /** Returns all projects. */
  getAllProjects?: () => ProjectSnapshot[];
  /** Creates a new project and persists it. Returns the created project snapshot. */
  createProject?: (name: string, vaultFolder: string, description?: string, cwdOverride?: string) => ProjectSnapshot;
  /** Updates editable Project settings, persists them, and returns the durable snapshot. */
  updateProject?: (projectId: string, patch: ProjectUpdatePatch) => Promise<ProjectSnapshot>;
  /** Assigns or clears the project on a thread. Pass null to detach. */
  setThreadProject?: (threadId: string, projectId: string | null, alignCwd?: boolean) => void;
  /** Returns true if the given thread is currently processing a request. */
  isThreadRunning?: (id: string) => boolean;
  /** Sends a message to a thread, triggering Claude to process it. */
  sendMessageToThread?: (id: string, message: string) => Promise<void>;
  /**
   * Archives a thread: saves it to the vault (if vault persistence is enabled)
   * then removes it from memory. Scheduled current-thread requests are deferred
   * through requestDeferredArchive; other current threads are rejected.
   */
  archiveThread?: (id: string) => Promise<void>;
  /** Requests that the current scheduled thread be archived after its run settles. */
  requestDeferredArchive?: (id: string) => void;
  /** Sets (or clears, with an empty string) a thread's orchestrator tracking notes. */
  setThreadNotes?: (threadId: string, notes: string) => void;
  /** Sets an AI-proposed reply awaiting human approval on a thread. */
  setThreadProposedReply?: (threadId: string, text: string) => void;
  /** Clears a thread's pending proposed reply, if any. */
  clearThreadProposedReply?: (threadId: string) => void;
  onCronCreate?: (params: CronCreateParams) => Promise<ScheduledItem>;
  onCronList?: () => ScheduledItem[];
  onCronUpdate?: (id: string, patch: CronUpdatePatch) => Promise<ScheduledItem>;
  onCronDelete?: (id: string) => Promise<void>;
  /**
   * Called when the agent uses the `request_secret` tool to ask the user for a
   * credential at runtime. Implementations should open a modal, collect the
   * value, write it to the OS keychain under `ct-secret-<secretName>`, and
   * resolve with true if the user saved the value or false if they cancelled.
   * When `force` is true the modal should clarify that the existing value will be replaced.
   */
  onRequestSecret?: (secretName: string, reason: string, force?: boolean) => Promise<boolean>;
  /**
   * When false, the obsidian_open_url tool is excluded from the MCP server.
   * Should be false when the Web Viewer core plugin is disabled or the user
   * has opted out in settings. Defaults to true.
   */
  enableOpenUrl?: boolean;
  /**
   * This thread's in-app browser, or undefined when unavailable — on mobile, on
   * a host without process diagnostics, or with the feature switched off.
   *
   * Presence is the gate: when absent the browser_* tools are not registered at
   * all rather than registered and always failing. A tool that can only refuse
   * still costs context on every turn and invites the model to keep retrying it.
   */
  browser?: ThreadBrowser;
  /** Returns every visible skill — vault-installed and read-only ~/.claude/skills entries alike (content omitted — use onSkillsGet for a specific skill's full SKILL.md). */
  onSkillsListInstalled?: () => Promise<Array<Omit<InstalledSkillInfo, 'content'>>>;
  /** Searches the skills.sh marketplace registry for the given query. */
  onSkillsSearch?: (query: string, limit?: number) => Promise<MarketplaceSkill[]>;
  /** Returns full detail for one skill, installed or not, by name or marketplace slug ("owner/repo/skill-id"). */
  onSkillsGet?: (identifier: string) => Promise<SkillDetailResult>;
  /** Lists configured skill sources (GitHub/local), plus the built-in skills.sh registry. */
  onSkillsListSources?: () => SkillSourceListItem[];
  /** Checks every configured GitHub-type skill source for how many commits behind origin it is. */
  onSkillsCheckUpdates?: () => Promise<SourceUpdateCheckResult[]>;
  /** Installs a skill from the marketplace (as returned by onSkillsSearch) into the vault's skills folder. */
  onSkillsInstall?: (params: InstallSkillParams) => Promise<{ name: string; targetDir: string }>;
  /** Uninstalls (deletes) a vault-installed skill by name. Rejects for read-only ~/.claude/skills entries. */
  onSkillsUninstall?: (name: string) => Promise<{ skillPath: string }>;
  /** Pulls the latest commits for a configured GitHub-type skill source by its source id. */
  onSkillsUpdate?: (sourceId: string) => Promise<{ behindCount: number; lastFetched: number }>;
  onSkillsCreateLocal?: (params: { skillId: string; skillMd: string; files?: Array<{ path: string; encoding: 'utf8' | 'base64'; content: string }> }) => Promise<unknown>;
  onSkillsUpdateLocal?: (params: { skillId: string; files?: Array<{ path: string; encoding: 'utf8' | 'base64'; content: string }>; deleteFiles?: string[] }) => Promise<unknown>;
  /**
   * Creates (or re-enables) a watch on a vault document, owned by the calling
   * thread, and primes its change-detection stamp so watching itself never
   * counts as a change.
   */
  onWatchDocument?: (path: string) => Promise<{ id: string; path: string }>;
  /**
   * Removes the calling thread's own watch(es) matching `path` and/or `id`.
   * Never removes a watch owned by another thread on the same path.
   */
  onUnwatchDocument?: (opts: { path?: string; id?: string }) => Promise<{ removed: number }>;
  /** Returns the calling thread's own watched documents. */
  onListWatchedDocuments?: () => Array<{ id: string; path: string; createdAt: number; lastAlertedAt?: number }>;
}

export interface CronCreateParams {
  name: string;
  prompt: string;
  schedule: import('./types').ScheduledItemSchedule;
  enabled: boolean;
  cwd?: string;
  projectId?: string;
  gate?: import('./types').ScheduledItem['gate'];
}

export type CronUpdatePatch = SchedulerItemPatch;

/**
 * Creates MCP tool surfaces bound to the host's Obsidian-compatible App API.
 */
export type ObsidianMcpServerWithHarnessTools = McpSdkServerConfigWithInstance & {
  harnessTools?: HarnessDynamicTool[];
};

/**
 * A type alias, not an interface, on purpose: callers spread this into a
 * `Record<string, McpServerConfig>`, and only type aliases get TypeScript's
 * implicit index signature.
 */
export type McpToolSurfaces = {
  claude_threads: ObsidianMcpServerWithHarnessTools;
  obsidian: ObsidianMcpServerWithHarnessTools;
};

/**
 * Internal shape. `builtInToolNames` is deliberately *not* on what
 * `createClaudeThreadsMcpServers` returns: callers spread that result straight
 * into a `Record<string, McpServerConfig>`, so an extra key there would be
 * handed to the SDK as a malformed MCP server.
 */
type McpToolSurfacesInternal = McpToolSurfaces & {
  builtInToolNames: readonly string[];
};

function createMcpToolSurfaces(app: App, options: ObsidianMcpServerOptions = {}): McpToolSurfacesInternal {
  // ── In-session cwd tracking ────────────────────────────────────────────────
  // Unlike cwdAtStart in ThreadManager (which is frozen in the subprocess),
  // effectiveCwd is updated immediately by set_working_directory so worktree
  // tools always operate on the right repo within the same turn.
  let effectiveCwd = options.initialCwd ?? '';

  // worktreePath → originalGitRoot, for tracking active worktrees this session.
  const activeWorktrees = new Map<string, string>();

  // Sandbox VM container names are derived from the thread ID so a container
  // survives a plugin reload and can still be found. When no thread ID was
  // supplied (ad-hoc/test surfaces) fall back to a per-session random ID: two
  // such sessions must not collide on one container.
  const fallbackVmSessionId = crypto.randomUUID();

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

  const boundScheduleWakeup = tool(
    'ScheduleWakeup',
    [
      'Schedules a wakeup to resume this conversation after a delay.',
      'When the timer fires, the prompt is injected as a new user message into the same thread, waking the conversation back up.',
      'Use for polling CI status, waiting for deploys to finish, or self-pacing loop work.',
      'The reason field is a human-readable label shown in logs and UI.',
    ].join(' '),
    {
      delaySeconds: z.number().describe('Seconds to wait before waking up'),
      prompt: z.string().describe('The message to inject as a user message when the timer fires'),
      reason: z.string().describe('Human-readable reason for the wakeup (for display/logging)'),
    },
    async (args, _extra) => {
      try {
        await options.onScheduleWakeup?.(args.delaySeconds * 1000, args.prompt, args.reason);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Wakeup scheduled in ${args.delaySeconds}s — ${args.reason}`,
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
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

  const boundSetWorkingDirectory = tool(
    'set_working_directory',
    [
      'Changes the working directory for this Claude session. Use this when you need to switch context to a different repository or project folder. Accepts an absolute path; ~ is expanded to the home directory.',
      'The change takes effect on the next turn — the current query continues in the original directory. Returns the resolved absolute path on success.',
    ].join(' '),
    {
      path: z.string().describe('Absolute filesystem path to set as the new working directory (~ is expanded)'),
    },
    async (args, _extra) => {
      try {
        const resolved = args.path.replace(/^~(?=\/|$)/, os.homedir());

        if (!fs.existsSync(resolved)) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `Path does not exist: ${resolved}` }) }],
            isError: true,
          };
        }

        if (!fs.statSync(resolved).isDirectory()) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `Not a directory: ${resolved}` }) }],
            isError: true,
          };
        }

        // Update both the persisted cwd (for next session) and the in-session
        // effective cwd (used immediately by obsidian_enter_worktree).
        effectiveCwd = resolved;
        options.onSetCwd?.(resolved);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, cwd: resolved }) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  // ── Worktree tools ──────────────────────────────────────────────────────────
  // The SDK's built-in EnterWorktree / ExitWorktree tools use the frozen
  // OS-level subprocess cwd (set at session start), so they always operate on
  // whatever repo was active when the thread was created — usually the vault
  // root.  These MCP versions read effectiveCwd instead, which is updated
  // immediately whenever set_working_directory is called.
  //
  // ClaudeSession wires Options.toolAliases so that any EnterWorktree /
  // ExitWorktree call the model emits is automatically routed here — callers
  // can use either name.

  const boundEnterWorktree = tool(
    'enter_worktree',
    [
      'Creates a new git worktree for the repo at the current effective working directory and switches this session to use it.',
      'The worktree is an isolated copy of the repo on a new branch — changes there do not affect the main checkout.',
      'After this call the session cwd is updated to the worktree path (takes effect next turn).',
      'Use exit_worktree to remove the worktree and restore the original repo path.',
    ].join(' '),
    {
      branch: z.string().optional().describe(
        'Branch name to create in the worktree. Auto-generated as claude/<timestamp> if omitted.',
      ),
      baseBranch: z.string().optional().describe(
        'Base branch or commit to start from. Defaults to HEAD.',
      ),
      repoPath: z.string().optional().describe(
        'Override which git repo to use. Defaults to the current effective working directory.',
      ),
      worktreeRoot: z.string().optional().describe(
        'Override the directory worktrees are created under. Defaults to the configured worktree location (~/.geode/worktrees). Must be durable storage — a temp dir is cleared on reboot, taking any uncommitted work with it.',
      ),
    },
    async (args, _extra) => {
      try {
        const path = require('path') as typeof import('path');

        const repoPath = args.repoPath ?? effectiveCwd;
        if (!repoPath) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'No working directory set. Call set_working_directory first.' }) }],
            isError: true,
          };
        }

        // Resolve the git root (handles cases where repoPath is a subdirectory)
        let gitRoot: string;
        try {
          gitRoot = execFileSync('git', ['-C', repoPath, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
        } catch {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `Not a git repository: ${repoPath}` }) }],
            isError: true,
          };
        }

        const branchName = args.branch ?? `claude/${Date.now()}`;

        // Worktrees go under a durable, app-owned root — NOT os.tmpdir(). macOS
        // clears $TMPDIR on reboot, which silently destroyed worktrees and any
        // uncommitted work in them. See src/worktreePaths.ts for the full rationale.
        const worktreeRoot = resolveWorktreeRoot(args.worktreeRoot ?? options.getWorktreeRoot?.());
        let rawWorktreePath = worktreePathFor(worktreeRoot, gitRoot, branchName);
        // Two worktrees off the same branch name would collide; git refuses to
        // create into a non-empty directory, so disambiguate rather than fail.
        if (fs.existsSync(rawWorktreePath)) {
          rawWorktreePath = `${rawWorktreePath}-${crypto.randomUUID().slice(0, 8)}`;
        }
        fs.mkdirSync(path.dirname(rawWorktreePath), { recursive: true });

        // git worktree add <path> -b <branch> [<base>]
        const gitArgs = ['worktree', 'add', rawWorktreePath, '-b', branchName];
        if (args.baseBranch) gitArgs.push(args.baseBranch);

        try {
          execFileSync('git', gitArgs, { cwd: gitRoot, encoding: 'utf8' });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `git worktree add failed: ${msg}` }) }],
            isError: true,
          };
        }

        // The worktree root may resolve through a symlink (notably the legacy
        // os.tmpdir() layout on macOS, /var/folders/... -> /private/var/folders/...,
        // but also any user-configured root behind one). The Read/Write/Edit tool
        // sandbox checks the canonical resolved path, while Bash tolerates the symlink form
        // — so leaving this uncanonicalized causes Edit/Write (but not Bash) to fail with
        // spurious "Stream closed" / permission errors for the rest of the worktree session.
        // Resolve to the real path now that `git worktree add` has actually created the
        // directory (realpathSync requires the path to exist).
        const worktreePath = fs.realpathSync(rawWorktreePath);

        activeWorktrees.set(worktreePath, gitRoot);
        effectiveCwd = worktreePath;
        // Persist gitRoot alongside the new cwd so the thread's project name
        // (Kanban grouping) and repair routing survive this worktree
        // directory being deleted later — see Thread.originRepoPath.
        options.onSetCwd?.(worktreePath, gitRoot);

        // Notify other plugins (e.g. Vault Bridges auto-flip) that this
        // session moved into a worktree. Fire-and-forget: listeners must
        // never break the tool result.
        try {
          (app.workspace as unknown as { trigger: (name: string, payload: unknown) => void }).trigger(
            'claude-threads:worktree-changed',
            { repoPath: gitRoot, worktreePath, branch: branchName },
          );
        } catch (e) {
          console.error('claude-threads: worktree-changed listener threw:', e);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              worktreePath,
              branch: branchName,
              gitRoot,
              message: 'Worktree created. Send any follow-up message to continue in the worktree.',
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }],
          isError: true,
        };
      }
    },
  );

  const boundExitWorktree = tool(
    'exit_worktree',
    [
      'Removes a git worktree created by enter_worktree and restores the session working directory to the original repo root.',
      'If no path is provided, removes the current effective working directory if it is a tracked worktree.',
    ].join(' '),
    {
      worktreePath: z.string().optional().describe(
        'Absolute path of the worktree to remove. Defaults to the current effective working directory.',
      ),
      force: z.boolean().optional().describe(
        'Force removal even if the worktree has uncommitted changes (default: false).',
      ),
    },
    async (args, _extra) => {
      try {
        const targetPath = args.worktreePath ?? effectiveCwd;
        const originalRepo = activeWorktrees.get(targetPath);

        if (!originalRepo) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `No tracked worktree at: ${targetPath}. Use \`git worktree remove\` manually if needed.`,
              }),
            }],
            isError: true,
          };
        }

        const removeArgs = ['worktree', 'remove', targetPath];
        if (args.force) removeArgs.push('--force');

        try {
          execFileSync('git', removeArgs, { cwd: originalRepo, encoding: 'utf8' });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `git worktree remove failed: ${msg}` }) }],
            isError: true,
          };
        }

        activeWorktrees.delete(targetPath);
        effectiveCwd = originalRepo;
        // Back in the origin repo itself — clear originRepoPath explicitly
        // (cwd now resolves its own project name via the normal git walk).
        options.onSetCwd?.(originalRepo, null);

        // Notify other plugins (e.g. Vault Bridges auto-flip) that this
        // session left its worktree and the directory was removed.
        try {
          (app.workspace as unknown as { trigger: (name: string, payload: unknown) => void }).trigger(
            'claude-threads:worktree-changed',
            { repoPath: originalRepo, worktreePath: null, removedWorktreePath: targetPath },
          );
        } catch (e) {
          console.error('claude-threads: worktree-changed listener threw:', e);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              removedWorktree: targetPath,
              restoredCwd: originalRepo,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // ── Sandbox VM tools ────────────────────────────────────────────────────────
  // A sandboxed VM for running COMMANDS only. Read/Write/Edit/Bash keep running
  // on the host, so the thread's working directory is bind-mounted into the
  // guest at /work rather than copied — file edits stay on the host and are
  // visible inside the VM immediately, with no sync step and no divergence.
  //
  // Backed by Apple's `container` CLI (macOS 26+, Apple silicon), where each
  // container is its own lightweight VM with a separate kernel and no view of
  // the host filesystem beyond that mount. See src/sandboxVm.ts for the full
  // rationale, and sandbox/Dockerfile for the image.
  //
  // The container name is derived deterministically from the thread ID, so a
  // container started before a plugin reload can still be found and cleaned up
  // afterwards without persisting anything on the Thread.

  const vmManager = new SandboxVmManager({
    containerName: () => containerNameForThread(options.threadId ?? fallbackVmSessionId),
    run: options.vmCommandRunner,
  });

  const vmErrorResult = (error: string) => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error }) }],
    isError: true,
  });

  const boundEnterVm = tool(
    'enter_vm',
    [
      'Starts a sandboxed Linux VM for this thread and bind-mounts the current effective working directory into it at /work.',
      'File editing stays on the host — use vm_exec to run commands inside the VM, where the container has its own kernel and cannot see the rest of the host filesystem.',
      'Requires Apple\'s container runtime (macOS 26+ on Apple silicon); desktop only.',
      'Use exit_vm to stop and remove the VM.',
    ].join(' '),
    {
      image: z.string().optional().describe(
        'Container image to start. Defaults to the configured sandbox VM image (claude-threads-coding:1), built from sandbox/Dockerfile.',
      ),
      network: z.enum(VM_NETWORK_MODES as unknown as [string, ...string[]]).optional().describe(
        'Network isolation: "default" = full egress (npm install, git remotes and web all work), "internal" = no internet but host and shared-network peers remain reachable, "none" = no network at all. Defaults to the configured setting, which ships as "default".',
      ),
      mountPath: z.string().optional().describe(
        'Absolute host directory to mount at /work. Defaults to the current effective working directory.',
      ),
    },
    async (args, _extra) => {
      try {
        const mountPath = args.mountPath ?? effectiveCwd;
        // Native harnesses invoke handlers directly, without SDK Zod parsing.
        // An invalid requested isolation mode must never silently enable egress.
        if (args.network !== undefined && !isVmNetworkMode(args.network)) {
          return vmErrorResult('network must be default, internal, or none.');
        }
        if (!mountPath) {
          return vmErrorResult('No working directory set. Call set_working_directory first, or pass mountPath.');
        }
        if (!path.isAbsolute(mountPath)) {
          return vmErrorResult(`mountPath must be an absolute path: ${mountPath}`);
        }
        // Checked on the host before starting anything: `container run` with a
        // nonexistent --volume source fails deep in the runtime with a message
        // that does not name the path.
        if (!fs.existsSync(mountPath) || !fs.statSync(mountPath).isDirectory()) {
          return vmErrorResult(`mountPath is not an existing directory: ${mountPath}`);
        }

        const result = await vmManager.enter({
          image: resolveVmImage(args.image, options.getVmImage?.()),
          mountPath,
          network: resolveVmNetwork(args.network, options.getVmDefaultNetwork?.()),
        });
        if (!result.success) return vmErrorResult(result.error);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              containerName: result.containerName,
              image: result.image,
              mountedFrom: result.mountedFrom,
              network: result.network,
              containerWorkdir: VM_WORKDIR,
              message: `Sandbox VM running. ${result.mountedFrom} is mounted at ${VM_WORKDIR}. Run commands with vm_exec; keep editing files with the normal file tools on the host.`,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return vmErrorResult(msg);
      }
    },
  );

  const boundVmExec = tool(
    'vm_exec',
    [
      'Runs a shell command inside this thread\'s sandboxed VM, with the working directory set to /work (the bind-mounted host directory).',
      'Call enter_vm first.',
      'Returns the exit code plus stdout and stderr; a non-zero exit code is reported as a normal result, not an error.',
      'Very long output is truncated with an explicit marker.',
    ].join(' '),
    {
      command: z.string().min(1).describe(
        'Shell command to run inside the VM. Executed with `bash -lc` from /work.',
      ),
      timeoutSeconds: z.number().optional().describe(
        'Guest command deadline in seconds, followed by a five-second kill grace. Defaults to 300, capped at 3600. Requires GNU timeout in the image; timeout normally returns exit code 124.',
      ),
    },
    async (args, _extra) => {
      try {
        const result = await vmManager.execCommand({
          command: args.command,
          timeoutSeconds: resolveExecTimeoutSeconds(args.timeoutSeconds),
        });
        if (!result.success) return vmErrorResult(result.error);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return vmErrorResult(msg);
      }
    },
  );

  const boundExitVm = tool(
    'exit_vm',
    [
      'Stops and removes this thread\'s sandboxed VM.',
      'The bind-mounted host directory and everything written into it is untouched — only the VM\'s own ephemeral root filesystem goes away.',
    ].join(' '),
    {
      force: z.boolean().optional().describe(
        'Kill the VM immediately instead of stopping it gracefully first (default: false).',
      ),
    },
    async (args, _extra) => {
      try {
        const result = await vmManager.exit({ force: args.force });
        if (!result.success) return vmErrorResult(result.error);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              removedContainer: result.removedContainer,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return vmErrorResult(msg);
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
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }, null, 2) }],
          isError: true,
        };
      }
    },
  );

  const boundCreateThread = tool(
    'threads_create',
    [
      'Creates a new persistent thread and immediately queues its initial prompt.',
      'The new thread inherits the current thread\'s working directory and project when those fields are omitted.',
      'Pass projectId: null to create the thread without a project.',
      'Returns as soon as the prompt is queued; use threads_wait to wait for its response.',
    ].join(' '),
    {
      prompt: z.string().trim().min(1).describe('The initial prompt to queue in the new thread'),
      title: z.string().min(1).optional().describe('Optional title for the new thread'),
      cwd: z.string().min(1).optional().describe('Optional working directory override'),
      projectId: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Optional project ID override. Omit to inherit the current project; pass null to create without a project.',
        ),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit Project elevation for this creation.'),
    },
    async (args, _extra) => {
      if (!options.createThread) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'createThread is not available in this context.' }) }],
          isError: true,
        };
      }
      try {
        const result = await options.createThread(args);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // ── Thread-coordination tools ────────────────────────────────────────────────

  const boundGetCurrentThread = tool(
    'obsidian_get_current_thread',
    'Returns metadata about the current thread: id, title, status, uiStatus, isRunning, project, cwd, prUrl, scheduledItemId, scheduledItemName, rawLogPath, and message count. Useful for understanding your own context before coordinating with other threads. uiStatus matches the Agents List UI labels (working | new | reviewed | failed | ready). prUrl is the URL of the most recent GitHub PR opened in this thread, if any. scheduledItemId/scheduledItemName identify the cron item that created this thread, if it was created by one. rawLogPath is the vault-relative path to the raw JSONL conversation log (read it with threads_get_log).',
    {},
    async (_args, _extra) => {
      try {
        const { threadId } = options;
        if (!threadId || !options.getThreadDetail) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Thread state not available in this context.' }) }], isError: true };
        }
        const detail = options.getThreadDetail(threadId);
        if (!detail) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Current thread not found: ${threadId}` }) }], isError: true };
        }
        const { messages: _msgs, ...meta } = detail;
        return { content: [{ type: 'text' as const, text: JSON.stringify(meta, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundListThreads = tool(
    'obsidian_list_threads',
    'Returns all threads with their id, title, status, uiStatus, isRunning flag, project, cwd, prUrl, scheduledItemId, scheduledItemName, rawLogPath, updatedAt, and message count. Use this to discover other running threads before coordinating with them. uiStatus matches the Agents List UI labels (working | new | reviewed | failed | ready). prUrl is the URL of the most recent GitHub PR opened in that thread, if any — useful for matching threads to PRs without reading message history. scheduledItemId/scheduledItemName identify the cron item that created a thread, if it was created by one. rawLogPath is the vault-relative path to the thread\'s raw JSONL conversation log (read it with threads_get_log).',
    { projectId: z.string().optional().describe('Portfolio orchestrator only: explicitly elevate this call into one Project.') },
    async (args, _extra) => {
      try {
        if (!options.getAllThreads) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Thread state not available in this context.' }) }], isError: true };
        }
        const threads = options.getAllThreads().filter(thread => options.authorizeThread?.(thread.id, args.projectId, 'read') ?? true);
        return { content: [{ type: 'text' as const, text: JSON.stringify(threads, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundListProjects = tool(
    'obsidian_list_projects',
    'Returns all projects with their id, name, description, vaultFolder, cwdOverride, and resolved effectiveCwd. Projects focus working context but do not restrict the broader vault or configured tool roster.',
    {},
    async (_args, _extra) => {
      try {
        if (!options.getAllProjects) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Project state not available in this context.' }) }], isError: true };
        }
        const projects = options.getAllProjects();
        return { content: [{ type: 'text' as const, text: JSON.stringify(projects, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundCreateProject = tool(
    'obsidian_create_project',
    'Creates a new project with the given name and vault folder. Returns the created project snapshot including its id. Capture the returned id — it is the projectId used by CronCreate, threads_set_project, and other project-aware APIs.',
    {
      name: z.string().describe('Human-readable project name (e.g. "Golden Wealth", "HipTrip", "Personal")'),
      vaultFolder: z
        .string()
        .describe(
          'Vault-relative folder path for this project (e.g. "Projects/GoldenWealth"). Claude threads in this project will default to this folder as their working context.',
        ),
      description: z.string().optional().describe('Optional one-line description of the project'),
      cwdOverride: z
        .string()
        .optional()
        .describe(
          'Optional absolute filesystem path to use as the working directory instead of deriving it from vaultFolder + vault root',
        ),
    },
    async (args, _extra) => {
      try {
        if (!options.createProject) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'createProject is not available in this context.' }) }], isError: true };
        }
        const project = options.createProject(args.name, args.vaultFolder, args.description, args.cwdOverride);
        return { content: [{ type: 'text' as const, text: JSON.stringify(project, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundUpdateProject = tool(
    'obsidian_update_project',
    'Updates a Project name, context description, or working-directory override. Omitted fields are preserved; null clears description or cwdOverride. Existing threads keep their current cwd and live session. New Project threads and dynamic schedules use the updated effective cwd.',
    {
      projectId: z.string().trim().min(1).describe('ID of the Project to update'),
      name: z.string().optional().describe('New human-readable Project name; trimmed and must not be blank'),
      description: z.string().nullable().optional().describe('New Project context description; null clears it'),
      cwdOverride: z.string().nullable().optional().describe('New absolute filesystem cwd; null restores the vault-derived cwd'),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit matching Project elevation for this call.'),
    },
    async (args, _extra) => {
      try {
        if (!options.updateProject) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'updateProject is not available in this context.' }) }], isError: true };
        }
        if (options.authorizeProjectDestination && !options.authorizeProjectDestination(args.projectId, args.elevatedProjectId)) {
          throw new Error('Target is outside coordination scope.');
        }
        const hasName = args.name !== undefined;
        const hasDescription = args.description !== undefined;
        const hasCwdOverride = args.cwdOverride !== undefined;
        if (!hasName && !hasDescription && !hasCwdOverride) throw new Error('At least one editable field is required.');

        const patch: ProjectUpdatePatch = {};
        if (hasName) {
          const name = args.name!.trim();
          if (!name) throw new Error('Project name must not be blank.');
          patch.name = name;
        }
        if (hasDescription) patch.description = args.description ?? undefined;
        if (hasCwdOverride) {
          if (args.cwdOverride === null) {
            patch.cwdOverride = undefined;
          } else {
            const cwdOverride = args.cwdOverride!.trim();
            if (!cwdOverride) throw new Error('cwdOverride must not be blank; pass null to clear it.');
            if (!path.posix.isAbsolute(cwdOverride) && !path.win32.isAbsolute(cwdOverride)) throw new Error('cwdOverride must be an absolute filesystem path.');
            patch.cwdOverride = cwdOverride;
          }
        }
        const project = await options.updateProject(args.projectId, patch);
        return { content: [{ type: 'text' as const, text: JSON.stringify(project, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundSetThreadProject = tool(
    'obsidian_set_thread_project',
    'Assigns a thread to a project or clears its project assignment. Call threads_list_projects first to get a valid projectId. By default only association changes; pass alignCwd: true with a non-null Project to switch cwd safely on the next turn. Detaching never relocates the thread.',
    {
      threadId: z.string().describe('ID of the thread to update'),
      projectId: z
        .string()
        .nullable()
        .describe('Project ID to assign to the thread, or null to clear the project assignment'),
      alignCwd: z.boolean().optional().describe('Also switch the thread to the Project cwd and start a fresh session on the next turn. Defaults to false.'),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit Project elevation for this call.'),
    },
    async (args, _extra) => {
      try {
        if (!options.setThreadProject) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'setThreadProject is not available in this context.' }) }], isError: true };
        }
        if (options.authorizeThread && !options.authorizeThread(args.threadId, args.elevatedProjectId, 'write')) throw new Error('Target is outside coordination scope.');
        if (options.authorizeProjectDestination && !options.authorizeProjectDestination(args.projectId ?? undefined, args.elevatedProjectId, args.threadId)) throw new Error('Destination Project is outside coordination scope.');
        options.setThreadProject(args.threadId, args.projectId, args.alignCwd ?? false);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, threadId: args.threadId, projectId: args.projectId }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundGetThreadMessages = tool(
    'obsidian_get_thread_messages',
    'Returns the live message history of any thread by ID. Use limit to get just the most recent N messages (default 20). Useful for reading what another thread has done or decided before coordinating.',
    {
      threadId: z.string().describe('ID of the thread to read'),
      limit: z.number().int().positive().optional().describe('Return only the last N messages (default 20)'),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit Project elevation for this call.'),
    },
    async (args, _extra) => {
      try {
        if (!options.getThreadDetail) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Thread state not available in this context.' }) }], isError: true };
        }
        if (options.authorizeThread && !options.authorizeThread(args.threadId, args.elevatedProjectId, 'read')) throw new Error('Target is outside coordination scope.');
        const detail = options.getThreadDetail(args.threadId);
        if (!detail) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Thread not found: ${args.threadId}` }) }], isError: true };
        }
        const limit = args.limit ?? 20;
        const messages = detail.messages.slice(-limit);
        return { content: [{ type: 'text' as const, text: JSON.stringify(messages, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundOpenThread = tool(
    'obsidian_open_thread',
    'Opens and focuses a thread by its exact ID. A successful open marks the thread reviewed and persists the active selection.',
    {
      threadId: z.string().describe('ID of the thread to open'),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit Project elevation for this call.'),
    },
    async (args, _extra) => {
      try {
        if (!options.openThread) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Thread navigation is not available in this context.' }) }], isError: true };
        }
        if (options.authorizeThread && !options.authorizeThread(args.threadId, args.elevatedProjectId, 'read')) throw new Error('Target is outside coordination scope.');
        const detail = options.getThreadDetail?.(args.threadId);
        if (!detail) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Thread not found: ${args.threadId}` }) }], isError: true };
        }
        await options.openThread(args.threadId);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, threadId: args.threadId }) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundGetThreadLog = tool(
    'obsidian_get_thread_log',
    'Returns parsed entries from a thread\'s raw JSONL conversation log: tool calls, completed outputs, assistant messages, result events, system events, and a synthetic session_start marker. Each entry is an envelope { ts, threadId, sessionId, type, event }. Completed protocol events are preserved; token deltas are omitted. Codex diff snapshots are coalesced per thread/turn (up to 512 KiB); command and plan deltas retain bounded 64 KiB diagnostic tails when needed. Synthetic codex/log/compacted events identify source, reason, tail, and original/retained/omitted byte counts. Pending updates flush at completion, session shutdown, or memory limits, so this is not a verbatim stream and pending events may be absent while running or after a host crash. Use this for more detail than threads_get_messages. Results are filtered by type (if given) and tailed to the most recent N entries (default 100). The returned `path` is the absolute log file path for all stored entries. Defaults to the current thread when threadId is omitted.',
    {
      threadId: z.string().optional().describe('ID of the thread whose log to read. Defaults to the current thread.'),
      limit: z.number().int().nonnegative().optional().describe('Return only the most recent N entries (default 100). Pass 0 for all entries. Type filtering is applied before tailing.'),
      type: z.string().optional().describe('Only return entries with this envelope type, e.g. "assistant", "user", "result", "system", "session_start", "tool_use_summary".'),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit Project elevation for this call.'),
    },
    async (args, _extra) => {
      try {
        if (!options.readThreadLog) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Raw log access not available in this context.' }) }], isError: true };
        }
        const threadId = args.threadId ?? options.threadId;
        if (!threadId) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No threadId provided and no current thread in context.' }) }], isError: true };
        }
        if (options.authorizeThread && !options.authorizeThread(threadId, args.elevatedProjectId, 'read')) throw new Error('Target is outside coordination scope.');
        const result = await options.readThreadLog(threadId, { limit: args.limit, type: args.type });
        if (!result) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `No raw log found for thread: ${threadId}. Raw logging may be disabled, or the thread has not produced any events yet.` }) }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundWaitForThread = tool(
    'obsidian_wait_for_thread',
    'Blocks until the specified thread finishes processing its current request (isRunning becomes false), then returns. Returns immediately if the thread is already idle. Use after threads_send_message to wait for a response before reading results.',
    {
      threadId: z.string().describe('ID of the thread to wait for'),
      timeoutSeconds: z.number().optional().describe('Maximum seconds to wait before giving up (default 120)'),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit Project elevation for this call.'),
    },
    async (args, _extra) => {
      try {
        if (!options.isThreadRunning) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Thread state not available in this context.' }) }], isError: true };
        }
        if (options.authorizeThread && !options.authorizeThread(args.threadId, args.elevatedProjectId, 'read')) throw new Error('Target is outside coordination scope.');
        const timeoutMs = Math.min((args.timeoutSeconds ?? 120) * 1000, 600_000);
        const start = Date.now();
        const pollMs = 1_000;

        while (options.isThreadRunning(args.threadId)) {
          const elapsed = Date.now() - start;
          if (elapsed >= timeoutMs) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ done: false, timedOut: true, elapsedSeconds: Math.round(elapsed / 1000) }) }],
              isError: true,
            };
          }
          await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ done: true, elapsedSeconds: Math.round((Date.now() - start) / 1000) }) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundSendMessageToThread = tool(
    'obsidian_send_message_to_thread',
    'Sends a user message to another thread, triggering Claude to process it. The call returns as soon as the message is queued — use threads_wait to block until the response is ready. Cannot send to the current thread.',
    {
      threadId: z.string().describe('ID of the thread to send the message to'),
      message: z.string().describe('The message text to send'),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit Project elevation for this call.'),
    },
    async (args, _extra) => {
      try {
        if (!options.sendMessageToThread) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Thread messaging not available in this context.' }) }], isError: true };
        }
        if (args.threadId === options.threadId) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Cannot send a message to the current thread.' }) }], isError: true };
        }
        if (options.authorizeThread && !options.authorizeThread(args.threadId, args.elevatedProjectId, 'write')) throw new Error('Target is outside coordination scope.');
        await options.sendMessageToThread(args.threadId, args.message);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, threadId: args.threadId }) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundArchiveThread = tool(
    'obsidian_archive_thread',
    [
      'Archives a thread by ID — saves it to the vault (if vault persistence is enabled) then removes it from memory.',
      'Use this to close out completed threads, e.g. after merging PRs or finishing release management.',
      'A scheduled thread may archive itself; that archive is deferred until its current run settles.',
      'Other current threads cannot archive themselves.',
      'Archiving the Thread Orchestrator (the thread tracked in settings.orchestratorThreadId) requires confirm: true.',
    ].join(' '),
    {
      threadId: z.string().describe('ID of the thread to archive'),
      confirm: z.boolean().optional().describe('Must be true to archive the orchestrator thread (the thread tracked in settings.orchestratorThreadId). Not required for any other thread.'),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit Project elevation for this call.'),
    },
    async (args, _extra) => {
      try {
        if (!options.archiveThread) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Thread archiving not available in this context.' }) }], isError: true };
        }
        if (options.authorizeThread && !options.authorizeThread(args.threadId, args.elevatedProjectId, 'write')) throw new Error('Target is outside coordination scope.');
        if (args.threadId === options.threadId) {
          if ((options.isOrchestratorThread?.(args.threadId) ?? args.threadId === options.getOrchestratorThreadId?.()) && !args.confirm) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'This is the Thread Orchestrator. Pass confirm: true to archive it anyway — doing so stops automatic thread review until "Open Thread Orchestrator" is run again.' }) }], isError: true };
          }
          const currentThread = options.getThreadDetail?.(args.threadId);
          if (currentThread?.scheduledItemId && options.requestDeferredArchive) {
            options.requestDeferredArchive(args.threadId);
            return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, archivedThreadId: args.threadId, deferred: true }) }] };
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Cannot archive the current thread.' }) }], isError: true };
        }
        if ((options.isOrchestratorThread?.(args.threadId) ?? args.threadId === options.getOrchestratorThreadId?.()) && !args.confirm) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'This is the Thread Orchestrator. Pass confirm: true to archive it anyway — doing so stops automatic thread review until "Open Thread Orchestrator" is run again.' }) }], isError: true };
        }
        await options.archiveThread(args.threadId);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, archivedThreadId: args.threadId }) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }], isError: true };
      }
    },
  );

  // ── Thread-orchestrator tools ────────────────────────────────────────────────
  // Support the bundled thread-orchestrator skill: tracking notes + a proposed
  // reply awaiting human approval. No tool here ever sends a message — approval
  // is always a human clicking Approve & Send in ThreadsView.

  const boundSetThreadNotes = tool(
    'obsidian_set_thread_notes',
    [
      'Sets (overwrites) a thread\'s orchestrator tracking notes — free-form text for',
      'inferred goal, status, and a last-reviewed cursor. Visible in the UI but never',
      'injected into any session\'s context. Pass an empty string to clear.',
    ].join(' '),
    {
      threadId: z.string().describe('ID of the thread to annotate'),
      notes: z.string().describe('Tracking notes text. Pass an empty string to clear existing notes.'),
      elevatedProjectId: z.string().optional().describe('Reserved for explicit portfolio reads; portfolio elevation cannot write Project notes.'),
    },
    async (args, _extra) => {
      try {
        if (!options.setThreadNotes) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'setThreadNotes is not available in this context.' }) }], isError: true };
        }
        if (options.authorizeThread && !options.authorizeThread(args.threadId, args.elevatedProjectId, 'notes')) throw new Error('Target is outside coordination scope.');
        options.setThreadNotes(args.threadId, args.notes);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, threadId: args.threadId }) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundSetThreadProposedReply = tool(
    'obsidian_set_thread_proposed_reply',
    [
      'Sets an AI-proposed next message for a thread, awaiting human approval. Rendered as a',
      'banner in ThreadsView with Approve & Send / Edit / Discard actions — nothing is ever sent',
      'automatically. Distinct from the thread\'s own unsent compose-box draft. Cannot target the',
      'current thread (an orchestrator should never propose a reply to itself).',
    ].join(' '),
    {
      threadId: z.string().describe('ID of the thread to propose a reply for'),
      text: z.string().describe('The proposed reply text'),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit Project elevation for this call.'),
    },
    async (args, _extra) => {
      try {
        if (!options.setThreadProposedReply) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'setThreadProposedReply is not available in this context.' }) }], isError: true };
        }
        if (args.threadId === options.threadId) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Cannot set a proposed reply on the current thread.' }) }], isError: true };
        }
        if (options.authorizeThread && !options.authorizeThread(args.threadId, args.elevatedProjectId, 'write')) throw new Error('Target is outside coordination scope.');
        options.setThreadProposedReply(args.threadId, args.text);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, threadId: args.threadId }) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundClearThreadProposedReply = tool(
    'obsidian_clear_thread_proposed_reply',
    'Clears a thread\'s pending proposed reply, if any, without sending it. Use this when a prior proposal is stale or no longer relevant.',
    {
      threadId: z.string().describe('ID of the thread to clear the proposed reply on'),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit Project elevation for this call.'),
    },
    async (args, _extra) => {
      try {
        if (!options.clearThreadProposedReply) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'clearThreadProposedReply is not available in this context.' }) }], isError: true };
        }
        if (options.authorizeThread && !options.authorizeThread(args.threadId, args.elevatedProjectId, 'write')) throw new Error('Target is outside coordination scope.');
        options.clearThreadProposedReply(args.threadId);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, threadId: args.threadId }) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
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

  // ── Cron / Scheduler tools ────────────────────────────────────────────────

  const boundCronCreate = tool(
    'CronCreate',
    "Creates a new scheduled item that fires a prompt into a new thread on a recurring schedule. Use scheduleType 'interval' for every-N-seconds, 'daily' for once per day at a specific time, 'weekly' for specific days of the week. Optionally scope it to a local-time active-hours window (e.g. business hours) with activeHoursStart/activeHoursEnd so cycles outside that window are skipped automatically — no thread created, no message sent — instead of firing a thread just to check the clock and bail. Optionally add a deterministic gate command (gateCommand) that runs before each cycle fires: exit 0 fires the agent, exit 1 deliberately skips an empty queue, exit 75 reports an indeterminate evaluation and honors gateFailOpen, and other clean non-zero exits preserve deliberate-skip behavior. On a fire, the gate's stdout is fed into the prompt — it replaces a {{gateOutput}} placeholder if present, otherwise it's appended as a 'Gate output:' block. The gate env includes this item's project-scoped keychain secrets (plus any global ones) plus CRON_LAST_RUN_MS, CRON_ITEM_ID, and CRON_ITEM_NAME.",
    {
      name: z.string().describe('Human-readable name for this scheduled task'),
      prompt: z.string().describe('The prompt to send when this item fires. May contain a {{gateOutput}} placeholder that is replaced with the gate command stdout on a fire.'),
      scheduleType: z.enum(['interval', 'daily', 'weekly']).describe("Schedule type: 'interval', 'daily', or 'weekly'"),
      intervalSeconds: z.number().optional().describe("Required for 'interval': seconds between runs (e.g. 3600 = hourly)"),
      timeOfDay: z.string().optional().describe("HH:MM time string, required for 'daily' and 'weekly'"),
      daysOfWeek: z.array(z.number().int().min(0).max(6)).optional().describe("For 'weekly': day numbers 0=Sun through 6=Sat"),
      cwd: z.string().optional().describe('Working directory override for spawned threads'),
      projectId: z.string().optional().describe('Project ID to assign to new threads'),
      gateCommand: z
        .string()
        .optional()
        .describe(
          "Optional deterministic pre-check shell command run before each cycle fires (runs in the item's cwd). Exit 0 = fire; exit 1 = deliberate empty-queue skip; exit 75 = indeterminate and honors gateFailOpen; other clean non-zero exits preserve deliberate-skip behavior. On a fire, stdout is interpolated into the prompt ({{gateOutput}} placeholder, else appended). Env includes this item's project-scoped keychain secrets (plus any global ones) and CRON_LAST_RUN_MS/CRON_ITEM_ID/CRON_ITEM_NAME. Desktop only.",
        ),
      gateTimeoutSeconds: z
        .number()
        .optional()
        .describe('Max seconds the gate command may run before it is killed. Defaults to 30, capped at 120.'),
      gateFailOpen: z
        .boolean()
        .optional()
        .describe(
          'When the gate cannot be evaluated (exit 75, timeout, or spawn failure such as command-not-found), whether to fire anyway. Defaults to true so a broken check never silently stops a real cron. Other clean non-zero exits are deliberate skips regardless of this flag.',
        ),
      activeHoursStart: z
        .string()
        .optional()
        .describe(
          "Optional HH:MM local time — only fire at/after this time each day (e.g. '07:00'). Must be provided together with activeHoursEnd. Cycles due outside [activeHoursStart, activeHoursEnd) are skipped entirely (no thread created).",
        ),
      activeHoursEnd: z
        .string()
        .optional()
        .describe(
          "Optional HH:MM local time — only fire before this time each day (e.g. '22:00'). Must be provided together with activeHoursStart. Supports overnight windows where start > end (e.g. 22:00-06:00).",
        ),
    },
    async (args, _extra) => {
      try {
        if (!options.onCronCreate) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'CronCreate is not available in this context.' }) }], isError: true };
        }
        if ((args.activeHoursStart !== undefined) !== (args.activeHoursEnd !== undefined)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: 'activeHoursStart and activeHoursEnd must both be provided together, or both omitted.' }),
              },
            ],
            isError: true,
          };
        }
        const item = await options.onCronCreate({
          name: args.name,
          prompt: args.prompt,
          schedule: {
            type: args.scheduleType,
            intervalSeconds: args.intervalSeconds,
            timeOfDay: args.timeOfDay,
            daysOfWeek: args.daysOfWeek,
            activeHours:
              args.activeHoursStart !== undefined && args.activeHoursEnd !== undefined
                ? { start: args.activeHoursStart, end: args.activeHoursEnd }
                : undefined,
          },
          enabled: true,
          cwd: args.cwd,
          projectId: args.projectId,
          gate: args.gateCommand
            ? { command: args.gateCommand, timeoutSeconds: args.gateTimeoutSeconds, failOpen: args.gateFailOpen }
            : undefined,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(item, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundCronList = tool(
    'CronList',
    'Returns all scheduled items with their id, name, prompt, schedule, enabled state, and last/next run times.',
    {},
    async (_args, _extra) => {
      try {
        if (!options.onCronList) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'CronList is not available in this context.' }) }], isError: true };
        }
        const items = options.onCronList().map((item) => {
          const {
            _scheduleRevision: _revision,
            _scheduleClaimToken: _claimToken,
            _scheduleClaimDueAt: _claimDueAt,
            _scheduleClaimRevision: _claimRevision,
            ...publicItem
          } = item;
          return publicItem;
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundCronUpdate = tool(
    'CronUpdate',
    'Updates an existing scheduled item. Only provided fields are changed. To pause/resume a schedule set enabled to false/true. Use activeHoursStart/activeHoursEnd to set or change the local-time window this item is allowed to fire in (cycles outside it are skipped automatically); use clearActiveHours to remove that restriction entirely. Use gateCommand/gateTimeoutSeconds/gateFailOpen to set or change the deterministic pre-check that runs before each cycle fires (exit 0 = fire; exit 1 = deliberate empty-queue skip; exit 75 = indeterminate and honors gateFailOpen; other clean non-zero exits preserve deliberate-skip behavior; stdout is interpolated into the prompt via {{gateOutput}}); use clearGate to remove the gate entirely.',
    {
      id: z.string().describe('ID of the scheduled item to update'),
      name: z.string().optional().describe('New human-readable name'),
      prompt: z.string().optional().describe('New prompt text'),
      enabled: z.boolean().optional().describe('Set to false to pause, true to resume'),
      intervalSeconds: z.number().optional().describe("New interval in seconds (for 'interval' type)"),
      timeOfDay: z.string().optional().describe("New HH:MM time (for 'daily' and 'weekly')"),
      daysOfWeek: z.array(z.number().int().min(0).max(6)).optional().describe("New days of week (for 'weekly')"),
      cwd: z.string().optional().describe('New working directory override'),
      projectId: z.string().optional().describe('New project ID'),
      gateCommand: z
        .string()
        .optional()
        .describe(
          "New deterministic pre-check shell command run before each cycle fires. Exit 0 = fire; exit 1 = deliberate empty-queue skip; exit 75 = indeterminate and honors gateFailOpen; other clean non-zero exits preserve deliberate-skip behavior. On a fire, stdout is interpolated into the prompt via {{gateOutput}} (else appended). Env includes this item's project-scoped keychain secrets (plus any global ones) and CRON_LAST_RUN_MS/CRON_ITEM_ID/CRON_ITEM_NAME. Desktop only.",
        ),
      gateTimeoutSeconds: z
        .number()
        .optional()
        .describe('New max seconds the gate command may run before it is killed (default 30, capped at 120). Only applied when a gate command is or becomes set.'),
      gateFailOpen: z
        .boolean()
        .optional()
        .describe('New fail-open behavior: when the gate cannot be evaluated (exit 75, timeout, or spawn failure), whether to fire anyway (default true). Only applied when a gate command is or becomes set.'),
      clearGate: z.boolean().optional().describe('Set to true to remove the gate entirely, so this item fires every cycle without a pre-check.'),
      activeHoursStart: z
        .string()
        .optional()
        .describe(
          'New HH:MM start time for the active-hours window. If the item has no existing window, activeHoursEnd must also be provided (in this call or a previous one).',
        ),
      activeHoursEnd: z
        .string()
        .optional()
        .describe(
          'New HH:MM end time for the active-hours window. If the item has no existing window, activeHoursStart must also be provided.',
        ),
      clearActiveHours: z.boolean().optional().describe('Set to true to remove the active-hours restriction entirely, so this item fires on its normal schedule at any time of day.'),
    },
    async (args, _extra) => {
      try {
        if (!options.onCronUpdate) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'CronUpdate is not available in this context.' }) }], isError: true };
        }
        const { id, name, prompt, enabled, intervalSeconds, timeOfDay, daysOfWeek, cwd, projectId, activeHoursStart, activeHoursEnd, clearActiveHours, gateCommand, gateTimeoutSeconds, gateFailOpen, clearGate } = args;
        const patch: CronUpdatePatch = {};
        if (name !== undefined) patch.name = name;
        if (prompt !== undefined) patch.prompt = prompt;
        if (enabled !== undefined) patch.enabled = enabled;
        if (intervalSeconds !== undefined || timeOfDay !== undefined || daysOfWeek !== undefined) {
          patch.schedule = { ...patch.schedule };
          if (intervalSeconds !== undefined) patch.schedule.intervalSeconds = intervalSeconds;
          if (timeOfDay !== undefined) patch.schedule.timeOfDay = timeOfDay;
          if (daysOfWeek !== undefined) patch.schedule.daysOfWeek = daysOfWeek;
        }
        if (clearActiveHours) {
          patch.schedule = { ...patch.schedule, activeHours: undefined };
        } else if (activeHoursStart !== undefined || activeHoursEnd !== undefined) {
          // activeHours is a nested object, so — unlike the flat sub-fields
          // above — a partial update (only start or only end) needs the
          // other side filled in from the existing item, since Scheduler's
          // merge is a shallow spread over `schedule` and would otherwise
          // clobber the untouched side.
          const existing = options.onCronList?.().find((i) => i.id === id);
          const existingActiveHours = existing?.schedule.activeHours;
          const start = activeHoursStart ?? existingActiveHours?.start;
          const end = activeHoursEnd ?? existingActiveHours?.end;
          if (!start || !end) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error:
                      'Cannot set only one of activeHoursStart/activeHoursEnd when the item has no existing active-hours window to fill in the other side. Provide both.',
                  }),
                },
              ],
              isError: true,
            };
          }
          patch.schedule = { ...patch.schedule, activeHours: { start, end } };
        }
        if (clearGate) {
          // gate is a top-level field (not nested under schedule), so clearing
          // it is a plain patch.gate = undefined — no schedule interaction.
          patch.gate = undefined;
        } else if (gateCommand !== undefined || gateTimeoutSeconds !== undefined || gateFailOpen !== undefined) {
          // Like the activeHours branch above, gate is an object, so a partial
          // update (e.g. only changing the timeout) needs the other sub-fields
          // filled in from the existing item — updateItem replaces the whole
          // gate object via a shallow spread and would otherwise drop them.
          const existing = options.onCronList?.().find((i) => i.id === id);
          const existingGate = existing?.gate;
          const command = gateCommand ?? existingGate?.command;
          if (!command) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error:
                      'Cannot set gateTimeoutSeconds/gateFailOpen without a gate command. Provide gateCommand, or the item must already have a gate.',
                  }),
                },
              ],
              isError: true,
            };
          }
          patch.gate = {
            command,
            timeoutSeconds: gateTimeoutSeconds ?? existingGate?.timeoutSeconds,
            failOpen: gateFailOpen ?? existingGate?.failOpen,
          };
        }
        if (cwd !== undefined) patch.cwd = cwd;
        if (projectId !== undefined) patch.projectId = projectId;
        const item = await options.onCronUpdate(id, patch);
        return { content: [{ type: 'text' as const, text: JSON.stringify(item, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundCronDelete = tool(
    'CronDelete',
    'Permanently deletes a scheduled item by ID.',
    {
      id: z.string().describe('ID of the scheduled item to delete'),
    },
    async (args, _extra) => {
      try {
        if (!options.onCronDelete) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'CronDelete is not available in this context.' }) }], isError: true };
        }
        await options.onCronDelete(args.id);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, deletedId: args.id }) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  // ── Skills Manager tools ──────────────────────────────────────────────────
  // Expose the same view/search/install/uninstall/update capabilities as the
  // Skills Manager UI (SkillsManagerView.ts) so any agent can manage skill
  // packages, not just a human clicking around. All logic lives in
  // skillManager.ts; these handlers are thin adapters over the onSkillsXxx
  // callbacks, mirroring the Cron tools above.

  const boundSkillsListInstalled = tool(
    'skills_list_installed',
    "Lists skills with name, description, path, qualified identifier, and origin: local (authored), vault (installed), or home (read-only). isEditable/isRemovable describe supported operations. Use the returned identifier with skills_get and skills_uninstall to distinguish duplicate names. Newly authored skills become available in new sessions.",
    {},
    async (_args, _extra) => {
      try {
        if (!options.onSkillsListInstalled) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'skills_list_installed is not available in this context.' }) }], isError: true };
        }
        const skills = await options.onSkillsListInstalled();
        return { content: [{ type: 'text' as const, text: JSON.stringify(skills, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  const boundSkillsSearch = tool(
    'skills_search',
    'Searches the skills.sh marketplace registry for installable skills matching a query. Returns each match\'s name, slug, GitHub source, install count, and whether it is already installed locally.',
    {
      query: z.string().describe('Search query, e.g. a skill name or keyword'),
      limit: z.number().int().positive().optional().describe('Maximum number of results to return (default 15)'),
    },
    async (args, _extra) => {
      try {
        if (!options.onSkillsSearch) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'skills_search is not available in this context.' }) }], isError: true };
        }
        const results = await options.onSkillsSearch(args.query, args.limit);
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  const boundSkillsGet = tool(
    'skills_get',
    'Returns full detail for one skill, whether installed or not. Pass an installed skill\'s name, or a marketplace slug in "owner/repo/skill-id" form (as returned by skills_search). Installed skills include their full SKILL.md content.',
    {
      identifier: z.string().describe('An installed skill\'s name, or a marketplace slug like "owner/repo/skill-id"'),
    },
    async (args, _extra) => {
      try {
        if (!options.onSkillsGet) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'skills_get is not available in this context.' }) }], isError: true };
        }
        const detail = await options.onSkillsGet(args.identifier);
        return { content: [{ type: 'text' as const, text: JSON.stringify(detail, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  const boundSkillsListSources = tool(
    'skills_list_sources',
    'Lists configured skill sources (GitHub-cloned or local-path plugin sources), plus the built-in skills.sh registry, with their id, name, type, and (for GitHub sources) staleness info.',
    {},
    async (_args, _extra) => {
      try {
        if (!options.onSkillsListSources) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'skills_list_sources is not available in this context.' }) }], isError: true };
        }
        const sources = options.onSkillsListSources();
        return { content: [{ type: 'text' as const, text: JSON.stringify(sources, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  const boundSkillsCheckUpdates = tool(
    'skills_check_updates',
    'Checks every configured GitHub-type skill source for upstream commits it is behind (runs `git fetch` + counts). Returns each source\'s id, name, and either its new behindCount/lastFetched or an error if the check failed.',
    {},
    async (_args, _extra) => {
      try {
        if (!options.onSkillsCheckUpdates) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'skills_check_updates is not available in this context.' }) }], isError: true };
        }
        const results = await options.onSkillsCheckUpdates();
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  const boundSkillsInstall = tool(
    'skills_install',
    "Installs a skill from the skills.sh marketplace into the vault's own skills folder (<vault>/<plugin-dir>/skills/). Never writes to ~/.claude/. Pass the slug/skillId/source/name exactly as returned by skills_search for the skill you want to install.",
    {
      slug: z.string().describe('Full skills.sh id, e.g. "owner/repo/skill-name" (from skills_search results)'),
      skillId: z.string().describe('Bare skill folder name — the install directory basename (from skills_search results)'),
      source: z.string().describe('GitHub "owner/repo" the skill is hosted in (from skills_search results)'),
      name: z.string().describe('Human-readable skill name (from skills_search results)'),
    },
    async (args, _extra) => {
      try {
        if (!options.onSkillsInstall) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'skills_install is not available in this context.' }) }], isError: true };
        }
        const result = await options.onSkillsInstall({
          slug: args.slug,
          skillId: args.skillId,
          source: args.source,
          name: args.name,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  const localFileSchema = z.object({
    path: z.string().describe('Package-relative file path'),
    encoding: z.enum(['utf8', 'base64']),
    content: z.string(),
  });
  const boundSkillsCreateLocal = tool(
    'skills_create_local',
    'Creates a new authored skill in the configured vault folder (default Skills/). Supply a safe skillId, complete SKILL.md with name and description frontmatter, and optional supporting files. Rejects existing packages. Available to newly started sessions; active sessions are not restarted.',
    { skillId: z.string(), skillMd: z.string(), files: z.array(localFileSchema).optional() },
    async args => {
      try {
        if (!options.onSkillsCreateLocal) throw new Error('skills_create_local is not available in this context.');
        return { content: [{ type: 'text' as const, text: JSON.stringify(await options.onSkillsCreateLocal(args)) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error) }) }], isError: true };
      }
    },
  );
  const boundSkillsUpdateLocal = tool(
    'skills_update_local',
    'Patches an existing authored skill in the configured vault folder. Omitted files are preserved; only deleteFiles entries are removed. SKILL.md may be replaced but never deleted. Does not edit installed or external-source packages. Available in newly started sessions. skills_update separately pulls GitHub sources.',
    { skillId: z.string(), files: z.array(localFileSchema).optional(), deleteFiles: z.array(z.string()).optional() },
    async args => {
      try {
        if (!options.onSkillsUpdateLocal) throw new Error('skills_update_local is not available in this context.');
        return { content: [{ type: 'text' as const, text: JSON.stringify(await options.onSkillsUpdateLocal(args)) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error) }) }], isError: true };
      }
    },
  );

  const boundSkillsUninstall = tool(
    'skills_uninstall',
    'Permanently deletes an installed or authored vault skill. Pass a qualified identifier from skills_list_installed, such as local:meeting-notes, in name. Ambiguous names involving authored skills are rejected. Home skills remain read-only.',
    {
      name: z.string().describe('Name of the skill to uninstall (as returned by skills_list_installed, where isRemovable is true)'),
    },
    async (args, _extra) => {
      try {
        if (!options.onSkillsUninstall) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'skills_uninstall is not available in this context.' }) }], isError: true };
        }
        const result = await options.onSkillsUninstall(args.name);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, ...result }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  const boundSkillsUpdate = tool(
    'skills_update',
    'Pulls the latest commits for a configured GitHub-type skill source (`git pull` on its local clone), refreshing every skill it provides. Pass the source id from skills_list_sources — not "registry" (skills.sh has no single-source update; reinstall individual skills instead).',
    {
      sourceId: z.string().describe('id of the GitHub-type skill source to update, from skills_list_sources'),
    },
    async (args, _extra) => {
      try {
        if (!options.onSkillsUpdate) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'skills_update is not available in this context.' }) }], isError: true };
        }
        const result = await options.onSkillsUpdate(args.sourceId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  // ── Secret request tool ──────────────────────────────────────────────────
  // Lets agents ask the user for a credential at runtime without that credential
  // ever appearing in the conversation. The value is stored in the OS keychain
  // and injected into future sessions via secretEnvResolver.

  const boundRegisterMcpServer = tool(
    'mcp_register_server',
    'Register a global external MCP server (stdio, HTTP, SSE, or OAuth). Choose the transport before anything else: if the server requires its own sign-in — Vercel, Figma, Linear, Notion and most hosted vendor MCP servers do — use type "oauth" and the plugin brokers OAuth 2.1 + PKCE for you, opening a consent screen in the Web Viewer. Registering such a server as "http" appears to succeed but produces a server that cannot authenticate. Reserve "http"/"sse" for endpoints needing no sign-in or a static ${NAME} header, and "stdio" for a local command. Requires a separate host confirmation even when tool approvals are bypassed. Creates only: identical retries are unchanged, conflicting names are rejected. Saved settings apply to newly initialized sessions, not the calling session. Use ${NAME} placeholders for every credential and request_secret to store values; all other literals must be nonsecret. No stdio/http/sse server is launched or contacted during registration; an oauth registration does contact the server to discover its authorization metadata. Scheduled threads cannot prompt for confirmation.',
    mcpRegistrationSchema.shape,
    async (args) => {
      // The direct Codex adapter bypasses SDK schema parsing.
      const parsed = mcpRegistrationSchema.safeParse(args);
      let result: McpRegistrationResult;
      if (!parsed.success) result = { success: false, status: 'invalid', message: 'Invalid MCP configuration. Use credential placeholders and request_secret; check name, transport and fields.' };
      else if (!options.onRegisterMcpServer) result = { success: false, status: 'unavailable', message: 'Host MCP registration is unavailable in this context.' };
      else {
        try { result = await options.onRegisterMcpServer(parsed.data); }
        catch { result = { success: false, status: 'failed', message: 'MCP registration failed. No credential or configuration details are returned.' }; }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], ...(!result.success ? { isError: true } : {}) };
    },
    { alwaysLoad: true },
  );

  const boundRequestSecret = tool(
    'request_secret',
    [
      'Ask the user to provide a secret (API key, token, password) and store it securely in the OS keychain.',
      'Use this when a skill or workflow needs a credential that hasn\'t been configured yet.',
      'The secret is stored under the name you provide and injected into future sessions as an environment variable.',
      'Returns {success: true, secretName, alreadyExisted: boolean} on success, or {success: false, reason} if the user cancelled.',
      'IMPORTANT: never ask the user to paste a secret directly into the conversation — always use this tool.',
      'Use force: true to re-prompt the user even when a secret with this name already exists — useful when a token has been rotated or a stale keychain entry needs replacing.',
    ].join(' '),
    {
      secretName: z.string().describe(
        'The environment variable name for this secret (e.g. LINEAR_API_KEY, JIRA_API_TOKEN). Will be uppercased and sanitized to A-Z0-9_.',
      ),
      reason: z.string().describe(
        'A short, plain-language explanation of why this secret is needed (e.g. "to list your Linear issues"). Shown to the user in the prompt.',
      ),
      force: z.boolean().optional().describe(
        'If true, always prompt the user even if a secret with this name already exists. Use when replacing a stale or invalid token.',
      ),
    },
    async (args, _extra) => {
      const varName = args.secretName.toUpperCase().replace(/[^A-Z0-9_]/g, '_');

      // If the secret is already stored and force is not set, return immediately without prompting.
      if (!args.force) {
        const existing = app.secretStorage.getSecret(secretStorageKey(varName));
        if (existing) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: true, secretName: varName, alreadyExisted: true }),
            }],
          };
        }
      }

      if (!options.onRequestSecret) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, reason: 'Secret request UI is not available in this context.' }),
          }],
          isError: true,
        };
      }

      const saved = await options.onRequestSecret(varName, args.reason, !!args.force);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: saved, secretName: varName, alreadyExisted: false }),
        }],
        ...(saved ? {} : { isError: true }),
      };
    },
    { alwaysLoad: true },
  );

  const tools: SdkMcpToolDefinition<any>[] = [
      boundGetOpenTabs,
      boundGetActiveFile,
      boundNavigateToFile,
      boundSearchVault,
      boundGetBacklinks,
      boundGetOutgoingLinks,
      boundInsertAtCursor,
      boundGetNoteMetadata,
      boundSetWorkingDirectory,
      boundScheduleWakeup,
      boundWatchDocument,
      boundUnwatchDocument,
      boundListWatchedDocuments,
      boundEnterWorktree,
      boundExitWorktree,
      boundEnterVm,
      boundVmExec,
      boundExitVm,
      boundListCommands,
      boundExecuteCommand,
      ...(options.enableOpenUrl !== false ? [boundOpenUrl] : []),
      ...(options.browser ? createAgentBrowserTools(options.browser) : []),
      boundCreateThread,
      boundGetCurrentThread,
      boundListThreads,
      boundListProjects,
      boundCreateProject,
      boundUpdateProject,
      boundSetThreadProject,
      boundGetThreadMessages,
      boundOpenThread,
      boundGetThreadLog,
      boundWaitForThread,
      boundSendMessageToThread,
      boundArchiveThread,
      boundSetThreadNotes,
      boundSetThreadProposedReply,
      boundClearThreadProposedReply,
      boundListVaultBridges,
      boundAddVaultBridge,
      boundGetFileHistory,
      boundRestoreFileVersion,
      boundCronCreate,
      boundCronList,
      boundCronUpdate,
      boundCronDelete,
      boundRequestSecret,
      boundRegisterMcpServer,
      boundSkillsListInstalled,
      boundSkillsSearch,
      boundSkillsGet,
      boundSkillsListSources,
      boundSkillsCheckUpdates,
      boundSkillsInstall,
      boundSkillsCreateLocal,
      boundSkillsUpdateLocal,
      boundSkillsUninstall,
      boundSkillsUpdate,
    ];

  // --- contributed agent tools (ADR-0008) ----------------------------------
  // Peers contribute through `extensions.registerAgentTool`; the host binds
  // each one to this thread and appends it here. Contributions are appended
  // *after* the built-ins and filtered against them, so a contribution can
  // never displace a built-in even if the registry's collision check were
  // bypassed. The registry rejects such a name first; this is defence in depth
  // on the path where a mistake would reach every thread on both harnesses.
  // Both spellings of every built-in. The definitions here carry their
  // *legacy* names; the canonical rename happens further down, so checking
  // only `definition.name` would let a contribution called `vault_search`
  // through and land it twice on the canonical server.
  const builtInNames = new Set(tools.flatMap(definition =>
    [definition.name, LEGACY_TO_CANONICAL_TOOL_NAMES[definition.name] ?? definition.name]));
  const contributions = [...(options.contributedTools ?? [])];
  const contributedTools = contributions
    .filter(binding => !builtInNames.has(binding.name))
    .map(binding => tool(
      binding.name,
      binding.description,
      binding.inputSchema,
      async (args: Record<string, unknown>) => {
        const result = await binding.invoke(args ?? {});
        // Copied onto a mutable array: the contract hands back a readonly
        // result, and the SDK's CallToolResult is mutable.
        return { content: [...result.content], ...(result.isError ? { isError: true } : {}) };
      },
      { alwaysLoad: binding.alwaysLoad },
    ));
  tools.push(...contributedTools);
  const contributedReadOnlyNames = contributions
    .filter(binding => !builtInNames.has(binding.name) && !binding.requiresApproval)
    .map(binding => binding.name);

  const legacyTools = tools.map(toDeprecatedLegacyToolDefinition);
  const legacyServer = createSdkMcpServer({
    name: 'obsidian',
    tools: legacyTools,
    alwaysLoad: true,
  });
  const canonicalTools = tools.map(toCanonicalToolDefinition);
  const canonicalServer = createSdkMcpServer({
    name: LEGACY_MCP_SERVER_NAME,
    tools: canonicalTools,
    alwaysLoad: true,
  });
  return {
    claude_threads: Object.assign(canonicalServer, { harnessTools: toHarnessDynamicTools(canonicalTools, contributedReadOnlyNames) }),
    obsidian: Object.assign(legacyServer, { harnessTools: toHarnessDynamicTools(legacyTools, contributedReadOnlyNames) }),
    // Canonical *and* legacy built-in names, so the contribution registry can
    // reject a name that would shadow either. Captured before contributions
    // were appended, so a contributed tool never counts as a built-in — which
    // is what lets the design tool contribute its own name.
    builtInToolNames: Object.freeze([...builtInNames]),
  };
}

/** Canonical and compatibility MCP surfaces, backed by identical handlers and schemas. */
export function createClaudeThreadsMcpServers(
  app: App,
  options: ObsidianMcpServerOptions = {},
): McpToolSurfaces {
  const { claude_threads, obsidian } = createMcpToolSurfaces(app, options);
  return { claude_threads, obsidian };
}

/**
 * Built-in tool names on both the canonical and deprecated-alias servers,
 * excluding anything contributed. This is what the contribution registry
 * checks a new tool name against, so a peer cannot shadow a built-in.
 */
export function builtInMcpToolNames(app: App, options: ObsidianMcpServerOptions = {}): readonly string[] {
  return createMcpToolSurfaces(app, options).builtInToolNames;
}

/** @deprecated Use createClaudeThreadsMcpServers().obsidian only for compatibility tests/callers. */
export function createObsidianMcpServer(app: App, options: ObsidianMcpServerOptions = {}): ObsidianMcpServerWithHarnessTools {
  return createMcpToolSurfaces(app, options).obsidian;
}

export const LEGACY_TO_CANONICAL_TOOL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  obsidian_search_vault: 'vault_search',
  obsidian_get_note_metadata: 'vault_get_note_metadata',
  obsidian_get_backlinks: 'vault_get_backlinks',
  obsidian_get_outgoing_links: 'vault_get_outgoing_links',
  obsidian_get_file_history: 'vault_get_file_history',
  obsidian_restore_file_version: 'vault_restore_file_version',
  obsidian_list_vault_bridges: 'vault_list_bridges',
  obsidian_add_vault_bridge: 'vault_add_bridge',
  obsidian_get_active_file: 'workspace_get_active_file',
  obsidian_get_open_tabs: 'workspace_get_open_tabs',
  obsidian_navigate_to_file: 'workspace_navigate_to_file',
  obsidian_insert_at_cursor: 'workspace_insert_at_cursor',
  obsidian_list_commands: 'host_list_commands',
  obsidian_execute_command: 'host_execute_command',
  obsidian_open_url: 'host_open_url',
  obsidian_get_current_thread: 'threads_get_current',
  obsidian_list_threads: 'threads_list',
  obsidian_list_projects: 'threads_list_projects',
  obsidian_create_project: 'threads_create_project',
  obsidian_update_project: 'threads_update_project',
  obsidian_set_thread_project: 'threads_set_project',
  obsidian_get_thread_messages: 'threads_get_messages',
  obsidian_open_thread: 'threads_open',
  obsidian_get_thread_log: 'threads_get_log',
  obsidian_wait_for_thread: 'threads_wait',
  obsidian_send_message_to_thread: 'threads_send_message',
  obsidian_archive_thread: 'threads_archive',
  obsidian_set_thread_notes: 'threads_set_notes',
  obsidian_set_thread_proposed_reply: 'threads_set_proposed_reply',
  obsidian_clear_thread_proposed_reply: 'threads_clear_proposed_reply',
});

const CANONICAL_DESCRIPTION_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  workspace_get_open_tabs: 'Returns all open tabs in the host workspace with their path, title, type, and active state.',
  workspace_get_active_file: 'Returns metadata for the currently active file in the host workspace, or null if nothing is open.',
  workspace_navigate_to_file: 'Opens a vault file in the host workspace, optionally in a new tab.',
  workspace_insert_at_cursor: 'Inserts text at the cursor in the active editor, replacing the current selection.',
  host_list_commands: 'Returns registered host commands with their ID and name, sorted by ID. Optionally filters by query. Use this before host_execute_command.',
  host_execute_command: 'Executes a host command by ID. Use host_list_commands to discover available IDs. Third-party command IDs remain unchanged.',
  host_open_url: 'Opens a URL in the host Web Viewer, reusing an existing tab by default and falling back to the system browser when unavailable.',
});

function toCanonicalToolDefinition(definition: SdkMcpToolDefinition<any>): SdkMcpToolDefinition<any> {
  const name = LEGACY_TO_CANONICAL_TOOL_NAMES[definition.name] ?? definition.name;
  if (name === definition.name) return definition;
  const description = CANONICAL_DESCRIPTION_OVERRIDES[name] ?? definition.description
    .replace(/\bObsidian workspace\b/g, 'host workspace')
    .replace(/\bObsidian commands\b/g, 'host commands')
    .replace(/\bObsidian command\b/g, 'host command')
    .replace(/obsidian_([a-z_]+)/g, (legacy) => LEGACY_TO_CANONICAL_TOOL_NAMES[legacy] ?? legacy);
  return tool(name, description, definition.inputSchema, definition.handler, { alwaysLoad: true });
}

function toDeprecatedLegacyToolDefinition(definition: SdkMcpToolDefinition<any>): SdkMcpToolDefinition<any> {
  if (!LEGACY_TO_CANONICAL_TOOL_NAMES[definition.name]) return definition;
  const canonicalName = LEGACY_TO_CANONICAL_TOOL_NAMES[definition.name];
  return tool(
    definition.name,
    `Deprecated compatibility alias; use ${canonicalName} on the claude_threads server. ${definition.description}`,
    definition.inputSchema,
    definition.handler,
    { alwaysLoad: true },
  );
}

/** A tool-result content block, as loosely as a harness has to treat one. */
type ToolResultContentBlock = { type: string; text?: string } & Record<string, unknown>;

/**
 * Render one image content block as a short placeholder, e.g.
 * `[image: image/png, 124kB]`.
 *
 * Accepts both shapes seen in the wild: the Anthropic block
 * (`{ source: { media_type, data } }`) and the MCP block
 * (`{ data, mimeType }`).
 */
function imagePlaceholder(item: ToolResultContentBlock): string {
  const source = item.source as { media_type?: unknown; data?: unknown } | undefined;
  const mediaType =
    (typeof item.mimeType === 'string' && item.mimeType)
    || (typeof source?.media_type === 'string' && source.media_type)
    || 'image';
  const base64 =
    (typeof item.data === 'string' && item.data)
    || (typeof source?.data === 'string' && source.data)
    || '';
  if (!base64) return `[image: ${mediaType}]`;
  // base64 encodes 3 bytes per 4 characters.
  const kb = Math.max(1, Math.round((base64.length * 3) / 4 / 1024));
  return `[image: ${mediaType}, ${kb}kB]`;
}

/**
 * Flatten an MCP tool result's content blocks into the single plain-text
 * payload a native harness (e.g. Codex) expects.
 *
 * Image blocks become a short placeholder rather than being serialized. A
 * screenshot is multiple megabytes of base64, and dropping that verbatim into
 * a harness context window burns the budget and tells the model nothing.
 *
 * This has to live in the adapter, not in the tool handlers, because
 * `toHarnessDynamicTools` invokes `toolDefinition.handler` directly. A handler
 * has no way to know it is being called on the harness path rather than over
 * MCP, where the image block is the whole point.
 *
 * Exported for tests.
 */
export function harnessTextFromToolContent(content: readonly ToolResultContentBlock[]): string {
  return content
    .map((item) => {
      if (item.type === 'text') return typeof item.text === 'string' ? item.text : '';
      if (item.type === 'image') return imagePlaceholder(item);
      return JSON.stringify(item);
    })
    .join('\n');
}

/**
 * Adapts built-in MCP definitions to host-native tool calls.
 *
 * Exported for tests (see test/unit/host-tool-harness-image-adapter.test.ts).
 */
export function toHarnessDynamicTools(
  tools: SdkMcpToolDefinition<any>[],
  /**
   * Contributed tools that declared `requiresApproval: false`. Contributions
   * default to requiring approval, so this stays empty unless a peer opts out
   * for a genuinely read-only tool.
   */
  contributedReadOnlyNames: readonly string[] = [],
): HarnessDynamicTool[] {
  // Reuse the canonical MCP definitions for every harness. The conservative
  // read-only set bypasses prompts; every other operation is presented through
  // the same SessionCallbacks.onPermissionRequest UI Claude already uses.
  const legacyReadOnlyToolNames = [
    'obsidian_get_open_tabs', 'obsidian_get_active_file', 'obsidian_search_vault',
    'obsidian_get_backlinks', 'obsidian_get_outgoing_links', 'obsidian_get_note_metadata',
    'obsidian_list_commands', 'obsidian_get_current_thread', 'obsidian_list_threads',
    'obsidian_list_projects', 'obsidian_get_thread_messages', 'obsidian_get_thread_log',
    'obsidian_list_vault_bridges', 'obsidian_get_file_history', 'CronList',
    'skills_list_installed', 'skills_search', 'skills_get', 'skills_list_sources',
    'skills_check_updates',
  ];
  const readOnlyToolNames = new Set([
    ...legacyReadOnlyToolNames,
    ...legacyReadOnlyToolNames.map(name => LEGACY_TO_CANONICAL_TOOL_NAMES[name] ?? name),
    // Observing a page is read-only; navigating to one and clicking things is
    // not, so only the inspection half bypasses the prompt.
    ...AGENT_BROWSER_READ_ONLY_TOOL_NAMES,
    ...contributedReadOnlyNames,
  ]);
  return tools.map((toolDefinition) => ({
    name: toolDefinition.name,
    description: toolDefinition.description,
    inputSchema: z.toJSONSchema(z.object(toolDefinition.inputSchema)) as Record<string, unknown>,
    requiresApproval: !readOnlyToolNames.has(toolDefinition.name),
    async invoke(args: Record<string, unknown>) {
      try {
        const result = await toolDefinition.handler(args as never, {});
        const text = harnessTextFromToolContent(result.content as ToolResultContentBlock[]);
        return { success: !result.isError, text };
      } catch (error) {
        return { success: false, text: error instanceof Error ? error.message : String(error) };
      }
    },
  }));
}

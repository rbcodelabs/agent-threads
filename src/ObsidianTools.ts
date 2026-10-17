import { z } from 'zod';
// Import from the browser entry point to avoid Node.js-only APIs (e.g. setTimeout().unref())
// that crash in Electron's renderer context.
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk/browser';
import { type McpRegistrationResult } from './mcpServerStore';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessDynamicTool } from './HarnessSession';
import { App, TFile } from 'obsidian';
import type { ScheduledItem } from './types';
import type { SchedulerItemPatch } from './Scheduler';
import path from 'path';
import type { ThreadBrowser } from './agentBrowser/ThreadBrowser';
import { type GithubCredentialBroker } from './githubCredentials';
import type { InstalledSkillInfo, MarketplaceSkill, SkillDetailResult, SkillSourceListItem, SourceUpdateCheckResult, InstallSkillParams } from './skillManager';
import { LEGACY_MCP_SERVER_NAME } from './productIdentity';
import { AGENT_BROWSER_READ_ONLY_TOOL_NAMES, createAgentBrowserTools } from './agentBrowser/agentBrowserTools';
import { createCwdTracker } from './tools/cwdTracker';
import { createMiscTools } from './tools/misc';
import { createScheduleTools } from './tools/schedule';
import { createSkillsTools } from './tools/skills';
import { createThreadTools } from './tools/threads';
import { createVaultTools } from './tools/vault';
import { createWorkspaceTools } from './tools/workspace';
import { createWorktreeTools } from './tools/worktree';
import { BUILT_IN_TOOL_ORDER, LEGACY_TO_CANONICAL_TOOL_NAMES } from './tools/toolNames';

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
  overviewPath?: string;
  cwdOverride?: string;
  effectiveCwd: string;
  orchestratorThreadId?: string;
}

export interface ProjectUpdatePatch {
  name?: string;
  description?: string;
  cwdOverride?: string;
  overviewPath?: string;
}

// ── Vault Bridge schema ───────────────────────────────────────────────────────

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
   * Refuses a working directory before it is adopted (throws with the reason). Absent on the plugin; a daemon
   * sets it so `set_working_directory` / `enter_worktree` cannot move a session outside its workspaces.
   */
  validateCwd?: (path: string) => void;
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
  /** Geode GitHub connection broker; undefined on Obsidian / older Geode. */
  githubBroker?: GithubCredentialBroker;
  /** Read lazily: the "Use Geode GitHub connection" setting. */
  isGithubConnectionEnabled?: () => boolean;
  /** Read lazily: optional commit-email override. */
  getGithubCommitEmail?: () => string | undefined;
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
  createProject?: (name: string, vaultFolder: string, description?: string, cwdOverride?: string, overviewPath?: string) => ProjectSnapshot;
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
   * A thread-aware implementation should also flag the calling thread's live
   * session for restart on success, so the new secret becomes available to
   * that same thread starting its next turn rather than only in future sessions.
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
  // the effective cwd is updated immediately by set_working_directory so
  // worktree tools always operate on the right repo within the same turn.
  // Shared by the worktree tools (see tools/cwdTracker.ts).
  const cwd = createCwdTracker(options.initialCwd ?? '');

  // Domain modules (src/tools/*): each is a factory over a narrow port and
  // returns its tools keyed by their legacy name. The handlers were moved
  // verbatim; `toolRouting.ts` classifies every name by domain.
  const domainTools: Record<string, SdkMcpToolDefinition<any>> = {
    ...createWorkspaceTools({ app, options }),
    ...createVaultTools({ app, options }),
    ...createScheduleTools({ options }),
    ...createWorktreeTools({
      cwd,
      options,
      // Notify other plugins (e.g. Vault Bridges auto-flip) that the session moved into or out of a worktree.
      // Fire-and-forget: listeners must never break the tool result.
      onWorktreeChanged: (payload: Record<string, unknown>) => {
        try {
          (app.workspace as unknown as { trigger: (name: string, payload: unknown) => void }).trigger('claude-threads:worktree-changed', payload);
        } catch (e) {
          console.error('claude-threads: worktree-changed listener threw:', e);
        }
      },
    }),
    ...createThreadTools({ options }),
    ...createSkillsTools({ options }),
    ...createMiscTools({ app, cwd, options }),
  };

  const tools: SdkMcpToolDefinition<any>[] = [];
  const used = new Set<string>();
  const take = (name: string): SdkMcpToolDefinition<any>[] => {
    const def = domainTools[name];
    if (!def) return [];
    used.add(name);
    return [def];
  };
  for (const name of BUILT_IN_TOOL_ORDER) {
    tools.push(...take(name));
    // Registered conditionally in the original roster, in this position.
    if (name === 'obsidian_execute_command' && options.enableOpenUrl !== false) tools.push(...take('obsidian_open_url'));
    if (name === 'obsidian_execute_command' && options.browser) tools.push(...createAgentBrowserTools(options.browser));
  }
  // A tool a domain module defines but the roster does not list would silently vanish.
  const unlisted = Object.keys(domainTools).filter((name) => !used.has(name) && name !== 'obsidian_open_url');
  if (unlisted.length > 0) throw new Error(`ObsidianTools: tool(s) missing from BUILT_IN_TOOL_ORDER: ${unlisted.join(', ')}`);

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

  const exposedTools = tools;
  const legacyTools = exposedTools.map(toDeprecatedLegacyToolDefinition);
  const legacyServer = createSdkMcpServer({
    name: 'obsidian',
    tools: legacyTools,
    alwaysLoad: true,
  });
  const canonicalTools = exposedTools.map(toCanonicalToolDefinition);
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

export { LEGACY_TO_CANONICAL_TOOL_NAMES };

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
    'obsidian_list_vault_bridges', 'obsidian_get_file_history', 'CronList', 'vault_list',
    'skills_list_installed', 'skills_search', 'skills_get', 'skills_list_sources',
    'skills_check_updates', 'github_list_access', 'github_check_repo',
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
    async invokeContent(args: Record<string, unknown>) {
      try {
        const result = await toolDefinition.handler(args as never, {});
        return { success: !result.isError, content: result.content as Array<Record<string, unknown>> };
      } catch (error) {
        return { success: false, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
      }
    },
  }));
}

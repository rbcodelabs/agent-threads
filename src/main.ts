import { Plugin, WorkspaceLeaf, App, FileSystemAdapter, addIcon, Notice, Platform, normalizePath, TFile, Modal, type EventRef, type Menu } from 'obsidian';
import { createClaudeThreadsApiV1, type ClaudeThreadsApiService, type ClaudeThreadsApiV1, type CreateThreadInput, type OrchestratorSnapshot, type OrchestratorTarget } from './PublicApi';
import { createConstrainedQueryRunner } from './ConstrainedRun';
import { ArtifactProviderRegistry, toArtifactRef } from './ArtifactContributions';
import { createDesignArtifactContribution, DESIGN_PROVIDER_OWNER, previewDesignArtifact } from './designArtifactProvider';
export { createClaudeThreadsApiV1 } from './PublicApi';
export type { ClaudeThreadsApiV1 } from './PublicApi';
// Desktop-only modules: type-only imports so their module-level code never runs on mobile.
// Obsidian Mobile's require() returns null for Node.js built-ins; those modules call
// require('fs') / require('child_process') etc. at the top level, which would crash.
// The actual classes are loaded via lazy require() inside onloadDesktop() instead.
import type { ThreadsView } from './ThreadsView';
import type { AgentDashboard } from './AgentDashboard';
import type { KanbanView } from './KanbanView';
import type { ThreadManager } from './ThreadManager';
import type { VaultPersistence } from './VaultPersistence';
import type { InProcessSummarizer } from './InProcessSummarizer';
import type { WakeLockService } from './WakeLockService';
import type { createClaudeThreadsMcpServers, ProjectSnapshot, ProjectUpdatePatch } from './ObsidianTools';
import type { ContextPanelController } from './ContextPanelController';
import { detectHostName } from './hostEnvironment';
import { DOCUMENT_CHAT_LABEL, isChattableDocument } from './documentChat';
import {
  HandoffDebouncer,
  WEB_VIEWER_EVENT_NAME,
  handleWebViewerEvent,
  type HandoffHost,
} from './compassHandoff';
import { isWatchableDocument, watchMenuLabel } from './documentWatch';
import { mergeMcpServers } from './mcpServerMerge';
import { createMcpRegistration, mcpRegistrationSchema, type McpRegistrationResult } from './mcpServerStore';
import { McpRegistrationModal } from './confirmModal';
import { openOAuthConsentUrl, type ExternalShellLike } from './linkUtils';
import type { SkillsManagerView } from './SkillsManagerView';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
// Shared / mobile-safe modules (no Node.js built-in calls at module level)
import {
  type PluginSettings,
  DEFAULT_SETTINGS,
  effectiveExtraEnv,
  parseExtraEnv,
  type Project,
  type ImageAttachment,
  type ScheduledItem,
  type WatchedDocument,
} from './types';
import { serializeThreadForSave } from './imageExternalization';
import { selectIdleThreadsForArchive } from './autoArchive';
import { createDeferredThreadArchiver } from './deferredThreadArchive';
import { getVaultBridgesAPI, findBridgesForFiles, type BridgeInfo } from './bridgeUtils';
import { execEnv } from './dashboardUtils';
import { createGateRunner, makeGateEnvironment, type GateExec } from './gateRunner';
import { ClaudeThreadsSettingTab, isWebViewerEnabled, RequestSecretModal } from './SettingsTab';
import { RelayClient } from './RelayClient';
import { MobileThreadStore } from './MobileThreadStore';
import { MobileView, MOBILE_VIEW_TYPE } from './MobileView';
import { setDebugLogging, debugLog, getLogRing } from './logger';
import { telemetry, buildDiagnosticsReport, type DiagnosticsInput } from './telemetry';
import { secretStorageKey, isSecretVisibleToProject, pruneSecretEnvScopesForProject } from './secretUtils';
import { scheduleVaultThreadRecovery } from './vaultThreadRecovery';
import { resolveProjectVaultRoot } from './projectPaths';
import { assertProposalOwnership, authorizeProjectAssignment, authorizeThreadAccess, canWriteManagerNotes, repairStaleProjectOrchestrators, resolveCoordinationRole } from './coordinationScope';
import {
  sharedPersistenceWriterFence,
  type PersistenceWriterToken,
} from './PersistenceWriterFence';
import { DIAGNOSTICS_FOLDER, mergePersistedSettings, selectWelcomeGuidePath } from './productIdentity';

// View-type string constants. Must match the values exported by each view module.
// Defined here as literals so both desktop and mobile code can reference them without
// triggering a static import of the desktop-only view modules.
const VIEW_TYPE = 'claude-threads:chat';
const AGENT_VIEW_TYPE = 'claude-threads:agents';
const KANBAN_VIEW_TYPE = 'claude-threads:kanban';
const SKILLS_VIEW_TYPE = 'claude-threads:skills';
// Literal rather than an import: main.ts is bundle-init on every platform, and
// value-importing the view would drag its module into eager scope.
// Kept in sync with AGENT_BROWSER_VIEW_TYPE in agentBrowser/AgentBrowserPreviewView.ts.
const AGENT_BROWSER_VIEW_TYPE = 'claude-threads:browser-preview';

interface AgentThreadCreateParams {
  prompt: string;
  title?: string;
  cwd?: string;
  projectId?: string | null;
  elevatedProjectId?: string;
}

/** Builds the host callback behind the agent-facing threads_create tool. */
export function createAgentThreadCallback(deps: {
  sourceThreadId: string;
  getThread: (id: string) => { cwd?: string; projectId?: string } | undefined;
  createThread: (title: string, cwd?: string, projectId?: string) => { id: string; title: string };
  saveSettings: () => Promise<void>;
  sendMessage: (id: string, prompt: string) => Promise<void>;
  authorizeProject?: (projectId: string | undefined, elevatedProjectId?: string) => boolean;
}): (params: AgentThreadCreateParams) => Promise<{ threadId: string; title: string }> {
  return async ({ prompt, title, cwd, projectId, elevatedProjectId }) => {
    const sourceThread = deps.getThread(deps.sourceThreadId);
    const resolvedTitle = title ?? prompt.trim().split('\n')[0]!.slice(0, 80);
    const resolvedProjectId = projectId === undefined ? sourceThread?.projectId : projectId ?? undefined;
    if (deps.authorizeProject && !deps.authorizeProject(resolvedProjectId, elevatedProjectId)) {
      throw new Error('Requested Project is outside coordination scope.');
    }
    const createdThread = deps.createThread(
      resolvedTitle,
      cwd ?? sourceThread?.cwd,
      resolvedProjectId,
    );
    await deps.saveSettings();
    void deps.sendMessage(createdThread.id, prompt);
    return { threadId: createdThread.id, title: createdThread.title };
  };
}

/** Builds the persistence boundary behind the agent-facing Project update tool. */
export function createAgentProjectUpdateCallback(deps: {
  getProject: (id: string) => Project | undefined;
  updateProject: (id: string, patch: ProjectUpdatePatch) => Project;
  getProjectCwd: (project: Project) => string;
  saveSettings: () => Promise<void>;
}): (projectId: string, patch: ProjectUpdatePatch) => Promise<ProjectSnapshot> {
  let transactionQueue: Promise<void> = Promise.resolve();
  const runUpdate = async (projectId: string, patch: ProjectUpdatePatch): Promise<ProjectSnapshot> => {
    const current = deps.getProject(projectId);
    if (!current) throw new Error(`Project not found: ${projectId}`);
    const patchKeys = Object.keys(patch) as Array<keyof ProjectUpdatePatch>;
    const changed = patchKeys
      .some(key => current[key] !== patch[key]);
    if (!changed) throw new Error('Update does not change Project settings.');
    const previous: ProjectUpdatePatch = {};
    for (const key of patchKeys) previous[key] = current[key];
    const updated = deps.updateProject(projectId, patch);
    const applied: ProjectUpdatePatch = {};
    for (const key of patchKeys) applied[key] = updated[key];
    try {
      await deps.saveSettings();
    } catch (error) {
      const latest = deps.getProject(projectId);
      const rollback: ProjectUpdatePatch = {};
      if (latest) {
        for (const key of patchKeys) {
          if (latest[key] === applied[key]) rollback[key] = previous[key];
        }
      }
      if (Object.keys(rollback).length > 0) deps.updateProject(projectId, rollback);
      throw error;
    }
    return {
      id: updated.id,
      name: updated.name,
      description: updated.description,
      vaultFolder: updated.vaultFolder,
      cwdOverride: updated.cwdOverride,
      effectiveCwd: deps.getProjectCwd(updated),
      orchestratorThreadId: updated.orchestratorThreadId,
    };
  };
  return (projectId, patch) => {
    const transaction = transactionQueue.then(() => runUpdate(projectId, patch));
    transactionQueue = transaction.then(() => undefined, () => undefined);
    return transaction;
  };
}

// Welcome guide content — written to vault on first install
const WELCOME_GUIDE = `# Getting Started with Agent Threads

Welcome! Agent Threads turns Obsidian into a multi-agent workspace powered by Claude Code and OpenAI Codex.

## The three panels

| Panel | Location | What it does |
|---|---|---|
| **Chat** | Left sidebar | Full conversation history for each thread |
| **Agents List** | Right sidebar | Dispatch tasks, track running agents, review results |
| **This guide** | Center | You're reading it — save it anywhere in your vault |

Reopen the panels any time from the ribbon icons (left edge of the window) or via the command palette (\`Cmd+P\`).

## Starting your first task

1. Click the **Agents List** ribbon icon or press \`Cmd+P\` → "Open Agents List"
2. Type a task in the **dispatch box** at the top — e.g. \`Summarize the README in my project folder\`
3. Hit **Enter** — your selected agent starts a new thread and begins working
4. Watch progress in the Agents List; click any thread row to open the full conversation in Chat

## Tips

- **Projects**: Group threads by folder. Create a project in the Agents List to scope Claude's working directory.
- **Permission mode**: Set to "Accept Edits" in Settings → Agent Threads to let your agent edit files without prompting.
- **Multiple threads**: Run several agents in parallel — each gets its own row in the Agents List.
- **Keyboard shortcuts**: \`Cmd+]\` / \`Cmd+[\` to cycle threads in Chat; \`Cmd+1–9\` to jump to a specific thread.
- **Interrupt**: Use "Interrupt active thread" from the command palette to stop a running agent mid-task.

## Settings

Open **Settings → Agent Threads** to configure:
- Claude binary path (auto-detected from Homebrew/PATH)
- Default working directory
- Vault folder for saving thread notes
- Summarization and auto-compact options
- Remote access (pair with Obsidian Mobile)
`;

// Electron renderer uses Chromium's AbortSignal which is missing Node.js's internal
// Symbol.for('nodejs.event_target') marker. Node's isEventTarget() checks
// obj?.constructor?.[kIsNodeEventTarget], i.e. AbortSignal[symbol] (the constructor,
// not the prototype), causing ERR_INVALID_ARG_TYPE when events.once(signal, 'abort') is called.
// Desktop/Electron only — mobile does not need this patch.
if (!Platform.isMobile) {
  const kNodeEventTarget = Symbol.for('nodejs.event_target');
  if (!(AbortSignal as unknown as Record<symbol, unknown>)[kNodeEventTarget]) {
    Object.defineProperty(AbortSignal, kNodeEventTarget, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }
}

/**
 * A scheduled ScheduleWakeup entry awaiting fire, tracked per thread. Backed
 * by a durable one-shot Scheduler item (schedule.type 'once', origin
 * 'wakeup') rather than a volatile in-memory timer — see
 * ClaudeThreadsPlugin.getPendingWakeups, which derives these from
 * this.scheduler.listItems() so they survive a plugin reload/restart.
 */
export interface PendingWakeup {
  /** Wall-clock epoch ms at which the wake-up will fire. Drives the UI countdown. */
  fireAt: number;
  /** Agent-supplied reason for the wake-up, surfaced in the dashboard and banner. */
  reason: string;
}

/**
 * Persist AgentRun snapshots as they change, rather than waiting for the
 * owning turn to settle. This is deliberately a small exported seam so the
 * crash-recovery contract can be covered without constructing an Obsidian App.
 */
export function subscribeAgentRunPersistence(
  manager: Pick<ThreadManager, 'subscribe'>,
  persist: () => void,
): () => void {
  return manager.subscribe((_threadId, event) => {
    if (event.type === 'agent_runs_changed') persist();
  });
}

export default class ClaudeThreadsPlugin extends Plugin {
  /** Stable peer-plugin entry point. Its v1 generation is revoked on unload. */
  api!: { readonly v1: ClaudeThreadsApiV1 };
  settings!: PluginSettings;
  manager!: ThreadManager;
  persistence!: VaultPersistence;
  inProcessSummarizer!: InProcessSummarizer;
  wakeLock!: WakeLockService;
  scheduler!: import('./Scheduler').Scheduler;
  statusLine: import('./StatusLineService').StatusLineService | null = null;
  gitDiff: import('./GitDiffService').GitDiffService | null = null;
  orchestratorWakeup: import('./OrchestratorWakeup').OrchestratorWakeup | null = null;
  documentWatch: import('./DocumentWatchService').DocumentWatchService | null = null;
  agentBrowser: import('./agentBrowser/AgentBrowserPool').AgentBrowserPool | null = null;
  contextPanel!: ContextPanelController;
  googleWorkspaceMcp?: import('./GoogleWorkspaceMcp').GoogleWorkspaceMcp;
  oauthMcpRegistry?: import('./OAuthMcpRegistry').OAuthMcpRegistry;
  /**
   * Collapses a double-clicked Compass "Send to Agent" into one thread. Owned
   * by the plugin instance so it is discarded with the plugin on unload — a
   * module-level singleton would survive a disable/enable cycle and keep
   * suppressing handoffs the freshly-enabled plugin has never seen.
   */
  private readonly compassHandoffDebouncer = new HandoffDebouncer();
  /**
   * Shared MCP-registration state, promoted from `onloadDesktop()` locals so
   * both the agent-tool factory (per-thread) and the peer-plugin public API
   * (`initializePublicApi()`, no calling thread) can drive the exact same
   * confirm-then-save transaction and host-availability guard.
   */
  private mcpRegistrationModals = new Set<McpRegistrationModal>();
  private mcpRegistrationAvailable = true;
  private registerMcpServerFn?: ReturnType<typeof createMcpRegistration>;

  /**
   * MCP-server warnings already shown as a Notice this plugin load, so a
   * persistent misconfiguration doesn't re-notify on every single thread start.
   *
   * Deliberately not cleared on saveSettings(): that is the plugin's general
   * persistence path (threads, projects, scheduler state), so clearing there
   * would re-arm the notice several times a minute. Each distinct message is
   * shown once per load; the durable surface is Settings → MCP, which
   * recomputes the warning every time the tab is drawn.
   */
  private reportedMcpWarnings = new Set<string>();

  // Remote access (desktop and mobile)
  relayClient: RelayClient | null = null;
  mobileStore: MobileThreadStore | null = null;

  /**
   * Models discovered from the Claude Code CLI via the SDK capabilities query.
   * Populated after the first session starts; used by SettingsTab to build
   * dynamic model dropdowns. Deduplicated by model value across sessions.
   */
  discoveredModels: import('@anthropic-ai/claude-agent-sdk').ModelInfo[] = [];
  /** Model catalogs are distinct: a Codex model ID must never populate a Claude picker (or vice versa). */
  discoveredModelsByHarness: Record<'claude' | 'codex', import('@anthropic-ai/claude-agent-sdk').ModelInfo[]> = {
    claude: [],
    codex: [],
  };


  // Tracks background-task-monitor timeout IDs keyed by threadId (one timer per thread at a time).
  private pendingBgTaskTimers = new Map<string, number>();
  private persistenceWriterToken?: PersistenceWriterToken;
  private publicApiService?: ClaudeThreadsApiService;
  /**
   * Host-owned artifact provider registry. Built-in Design registers into it
   * through the public `extensions.registerArtifactProvider` surface, exactly
   * as a peer plugin would (ADR-0008).
   */
  readonly artifactProviders = new ArtifactProviderRegistry();

  /** Maximum number of poll attempts per thread before giving up on background task monitoring. */
  private static readonly BG_TASK_MAX_POLLS = 10;
  /** How long to wait between background task poll attempts. */
  private static readonly BG_TASK_POLL_INTERVAL_MS = 30_000;

  async onload(): Promise<void> {
    // Claim persistence before any awaited startup work. Obsidian may construct
    // this generation before the prior instance's async onunload has finished.
    const fence = sharedPersistenceWriterFence();
    this.persistenceWriterToken = fence.claim();
    await fence.drain();
    // Register icons that may not be in Obsidian's internal Lucide subset
    addIcon('send', '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>');
    addIcon('square', '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>');
    addIcon('wrench', '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>');
    // git-branch is in Obsidian's built-in Lucide subset — no custom registration needed.
    // (Registering it here with 24×24 paths in a 100×100 viewBox would make it invisible.)
    addIcon('play', '<polygon points="6 3 20 12 6 21 6 3"/>');
    addIcon('check-circle', '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>');
    addIcon('alert-circle', '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>');
    addIcon('brain-circuit', '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/>');

    await this.loadSettings();

    // Apply debug logging preference before any subsystems start.
    setDebugLogging(this.settings.debugLogging ?? false);

    // Apply the local-only telemetry preference. Counter bumps and the perf
    // sampler are gated on this (and on desktop). Sampler wiring happens later in
    // onloadDesktop() once the workspace views exist.
    telemetry.setEnabled(this.settings.telemetryEnabled ?? true);

    // Enable SDK verbose debug logging when debug mode is on.
    // The SDK checks process.env.DEBUG_SDK lazily via a memoized fn — set it before any SDK call.
    // Desktop only: process.env is a Node.js global not available on mobile.
    if (!Platform.isMobile && this.settings.debugLogging && !process.env.DEBUG_SDK) {
      process.env.DEBUG_SDK = '1';
      process.env.CLAUDE_CODE_DEBUG_LOGS_DIR = `${process.env.HOME}/.claude/debug/claude-threads`;
      debugLog('[ClaudeThreads] SDK debug logging enabled → ~/.claude/debug/claude-threads/');
    }

    if (Platform.isMobile) {
      try {
        await this.onloadMobile();
      } catch (err) {
        console.error('[ClaudeThreads] Mobile initialization failed:', err);
        new Notice('Agent Threads failed to load on mobile. Check the developer console for details.');
      }
    } else {
      await this.onloadDesktop();
    }

    // Diagnostics command (both platforms). Desktop-gated inside the handler so
    // it's discoverable on mobile but shows a "desktop only" Notice there.
    this.addCommand({
      id: 'generate-diagnostics-report',
      name: 'Generate diagnostics report',
      callback: () => {
        void this.runDiagnosticsReport();
      },
    });

    // Settings tab (both platforms)
    this.addSettingTab(new ClaudeThreadsSettingTab(this.app, this));
  }

  private async onloadDesktop(): Promise<void> {
    // Lazy-load desktop-only modules. Because these are declared as `import type`
    // at the top of the file, esbuild does not run their module-level code until
    // the require() below is first called — which only happens on desktop.
    // (On mobile we never reach this function, so Node.js built-ins are never required.)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ThreadsView } = require('./ThreadsView') as typeof import('./ThreadsView');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AgentDashboard } = require('./AgentDashboard') as typeof import('./AgentDashboard');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { KanbanView } = require('./KanbanView') as typeof import('./KanbanView');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ThreadManager } = require('./ThreadManager') as typeof import('./ThreadManager');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { VaultPersistence } = require('./VaultPersistence') as typeof import('./VaultPersistence');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { InProcessSummarizer } = require('./InProcessSummarizer') as typeof import('./InProcessSummarizer');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { WakeLockService } = require('./WakeLockService') as typeof import('./WakeLockService');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Scheduler } = require('./Scheduler') as typeof import('./Scheduler');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createClaudeThreadsMcpServers, computeUiStatus } = require('./ObsidianTools') as typeof import('./ObsidianTools');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SkillsManagerView } = require('./SkillsManagerView') as typeof import('./SkillsManagerView');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ContextPanelController } = require('./ContextPanelController') as typeof import('./ContextPanelController');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const skillManager = require('./skillManager') as typeof import('./skillManager');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { StatusLineService } = require('./StatusLineService') as typeof import('./StatusLineService');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { GitDiffService } = require('./GitDiffService') as typeof import('./GitDiffService');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolveMcpServers } = require('./mcpServerStore') as typeof import('./mcpServerStore');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const skillPaths = require('./skillPaths') as typeof import('./skillPaths');

    const { GoogleWorkspaceMcp } = require('./GoogleWorkspaceMcp') as typeof import('./GoogleWorkspaceMcp');
    this.settings.googleWorkspaceBindings ??= {};
    this.googleWorkspaceMcp = new GoogleWorkspaceMcp(() =>
      (this.app as unknown as { plugins?: { getPlugin(id: string): unknown } }).plugins?.getPlugin('obsidian-gdocs-sync'), undefined, undefined,
      { bindings: this.settings.googleWorkspaceBindings, save: () => this.saveSettings() });
    await this.googleWorkspaceMcp.configure(this.settings.googleWorkspaceMcp ?? {});
    this.register(() => this.googleWorkspaceMcp?.close());

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { OAuthMcpRegistry } = require('./OAuthMcpRegistry') as typeof import('./OAuthMcpRegistry');
    this.settings.oauthMcpServers ??= {};
    this.settings.oauthMcpState ??= {};
    this.oauthMcpRegistry = new OAuthMcpRegistry({
      getSettings: () => this.settings,
      save: () => this.saveSettings(),
      secretStorage: this.app.secretStorage,
      // Consent goes to the SYSTEM browser, deliberately NOT the in-app Web
      // Viewer: registration runs behind a modal confirmation dialog, so an
      // in-app tab would render behind it and be unclickable, and consent
      // usually needs the SSO session / passkey / password manager that only
      // exists in the real browser. See openOAuthConsentUrl for the full
      // rationale and why the 127.0.0.1 callback still works.
      openUrl: async (url: string) => {
        const target = await openOAuthConsentUrl(url, {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          resolveShell: () => (require('electron') as { shell?: ExternalShellLike }).shell,
          fallbackOpen: (u) => { window.open(u, '_blank'); },
        });
        return { target };
      },
    });
    await this.oauthMcpRegistry.configure();
    this.register(() => this.oauthMcpRegistry?.close());

    // Resolve the skill roots before anything reads them. Everything the plugin
    // installs goes under <vault>/<plugin-dir>/skills/; ~/.claude/ is scanned
    // but never written. Hoisted above migrateGithubSourcesIntoVault() below,
    // which reuses the same containment predicate.
    {
      const adapter = this.app.vault.adapter;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const osNode = require('os') as typeof import('os');
      const vaultRoot = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : '';
      skillPaths.setSkillRoots(
        { ...skillPaths.computeSkillRoots(vaultRoot, this.manifest?.dir ?? '', osNode.homedir()), localRoot: this.getLocalSkillsRoot() },
      );
    }

    this.detectClaudeBinary();
    this.detectCodexBinary();
    this.migrateGithubSourcesIntoVault();
    this.scheduleGithubSourceClonePass();

    this.manager = new ThreadManager(this.settings);
    this.contextPanel = new ContextPanelController(this.app, () =>
      this.app.workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null,
      () => this.settings.conversationCompanionMarker,
      async (marker) => {
        if (marker) this.settings.conversationCompanionMarker = marker;
        else delete this.settings.conversationCompanionMarker;
        await this.saveSettings();
      },
    );
    this.register(() => { void this.contextPanel.dispose(); });
    const deferredThreadArchiver = createDeferredThreadArchiver(
      this.manager,
      async (id) => {
        await this.archiveThreadById(id);
        await this.saveSettings();
      },
    );
    this.register(() => deferredThreadArchiver.dispose());
    this.manager.hostName = detectHostName(window as unknown as { geode?: unknown });
    // One callback instance means one transaction queue across every per-thread
    // MCP server. Project updates from separate threads cannot overlap saves or
    // rollbacks against the shared manager state.
    const updateProjectFromAgent = createAgentProjectUpdateCallback({
      getProject: id => this.manager.getProject(id),
      updateProject: (id, patch) => this.manager.updateProject(id, patch),
      getProjectCwd: project => this.manager.getProjectCwd(project),
      saveSettings: () => this.saveSettings(),
    });
    // Use a per-thread factory so the set_working_directory tool can close over the
    // correct threadId without shared mutable state across concurrent sessions.
    this.register(() => {
      this.mcpRegistrationAvailable = false;
      for (const modal of this.mcpRegistrationModals) modal.close();
    });
    this.registerMcpServerFn = createMcpRegistration({
      getSettings: () => this.settings,
      save: () => this.saveSettings(),
      confirm: entry => new Promise<boolean>((resolve, reject) => {
        if (!this.mcpRegistrationAvailable) { reject(new Error('Host unavailable')); return; }
        const modal = new McpRegistrationModal(this.app, entry, accepted => {
          this.mcpRegistrationModals.delete(modal);
          resolve(accepted);
        });
        this.mcpRegistrationModals.add(modal);
        try { modal.open(); }
        catch (error) { this.mcpRegistrationModals.delete(modal); reject(error); }
      }),
    });
    this.manager.mcpServerFactory = (threadId: string, initialCwd: string) => {
      try {
        const mcpServers = createClaudeThreadsMcpServers(this.app, {
          onEnterDesignMode: brief => this.enterDesignMode(threadId, brief),
          onWatchDocument: path => this.watchDocument(threadId, path),
          onUnwatchDocument: opts => this.unwatchDocument(threadId, opts),
          onListWatchedDocuments: () => this.listWatchedDocuments(threadId),
          onRegisterMcpServer: input => {
            const caller = this.manager.getThread(threadId);
            const interactive = this.mcpRegistrationAvailable && !!caller && !caller.scheduledItemId;
            return this.registerExternalMcpServer(input, interactive);
          },
          enableOpenUrl: (this.settings.enableWebViewerTool ?? true) && isWebViewerEnabled(this.app),
          // Undefined when the pool is off or the host cannot support guests, in
          // which case the browser_* tools are not registered at all. `capable`
          // is checked here rather than inside the tools so an unsupported host
          // costs nothing per turn instead of advertising tools that only refuse.
          browser: this.agentBrowser?.capable ? this.createThreadBrowser(threadId) : undefined,
          openContextualFile: async (file) => {
            if (!this.isConversationFirst()) return false;
            await this.contextPanel.openFile(file);
            return true;
          },
          openContextualUrl: async (url) => {
            if (!this.isConversationFirst()) return false;
            const reusedTab = await this.contextPanel.setViewState({
              type: 'webviewer', active: true, state: { url },
            });
            return { reusedTab };
          },
          initialCwd,
          onSetCwd: (newCwd: string, originRepoPath?: string | null) => {
            this.manager.setThreadCwd(threadId, newCwd, originRepoPath);
            this.saveSettings().catch(console.error);
          },
          // Read lazily so changing the setting takes effect on the next
          // enter_worktree call rather than requiring a session restart.
          getWorktreeRoot: () => this.settings.worktreeRoot,
          onScheduleWakeup: async (delayMs: number, prompt: string, reason: string) => {
            // Durable one-shot Scheduler item instead of a bare window.setTimeout:
            // the old implementation tracked wake-ups only in an in-memory Map
            // that onunload() wiped on every plugin reload/restart/quit, and a
            // Mac sleep could drop the timer entirely with no record it ever
            // existed. Routing through the same Scheduler that backs the Cron
            // tools means this item is persisted to disk immediately, survives
            // a reload, and — if the fire time is missed entirely (app closed,
            // machine asleep) — still catches up shortly after the next load
            // instead of silently vanishing. See Scheduler.fire()'s 'once'
            // branch: it self-deletes after firing instead of rearming, and
            // getPendingWakeups/hasPendingWakeup/cancelWakeups below read this
            // same durable state rather than a separate volatile registry.
            const sourceThread = this.manager.getThread(threadId);
            await this.scheduler.createItem({
              name: `Wakeup: ${reason}`,
              prompt,
              schedule: { type: 'once', fireAt: Date.now() + delayMs },
              enabled: true,
              targetThreadId: threadId,
              cwd: sourceThread?.cwd,
              projectId: sourceThread?.projectId,
              origin: 'wakeup',
            });
            this.manager.notifyWakeupChanged(threadId);
            debugLog(`[ClaudeThreads] ScheduleWakeup registered for thread ${threadId} in ${delayMs}ms — ${reason}`);
          },
          createThread: createAgentThreadCallback({
            sourceThreadId: threadId,
            getThread: id => this.manager.getThread(id),
            createThread: (title, cwd, projectId) => this.manager.createThread(title, cwd, projectId),
            saveSettings: () => this.saveSettings(),
            sendMessage: (id, prompt) => this.manager.sendMessage(id, prompt),
            authorizeProject: (projectId, elevatedProjectId) => {
              const caller = this.manager.getThread(threadId);
              if (!caller) return false;
              const role = resolveCoordinationRole(threadId, this.settings.orchestratorThreadId, caller.projectId, this.manager.getProjects());
              return authorizeThreadAccess(role, projectId, elevatedProjectId);
            },
          }),
          threadId,
          getOrchestratorThreadId: () => this.settings.orchestratorThreadId,
          isOrchestratorThread: (id) => id === this.settings.orchestratorThreadId || this.manager.getProjects().some(project => project.orchestratorThreadId === id),
          authorizeThread: (targetId, elevatedProjectId, operation) => {
            const caller = this.manager.getThread(threadId);
            const target = this.manager.getThread(targetId);
            if (!caller || !target) return false;
            const role = resolveCoordinationRole(threadId, this.settings.orchestratorThreadId, caller.projectId, this.manager.getProjects());
            if (operation === 'notes') return canWriteManagerNotes(role, target.projectId);
            return authorizeThreadAccess(role, target.projectId, elevatedProjectId);
          },
          authorizeProjectDestination: (projectId, elevatedProjectId, targetThreadId) => {
            const caller = this.manager.getThread(threadId);
            if (!caller) return false;
            const role = resolveCoordinationRole(threadId, this.settings.orchestratorThreadId, caller.projectId, this.manager.getProjects());
            return authorizeProjectAssignment(role, projectId, { isSelf: targetThreadId === threadId, elevatedProjectId });
          },
          getThreadDetail: (id: string) => {
            const t = this.manager.getThread(id);
            if (!t) return undefined;
            const nonCompact = t.messages.filter((m: { role: string }) => m.role !== 'compact');
            const isRunning = this.manager.isRunning(id);
            return {
              id: t.id,
              title: t.title,
              status: t.status ?? 'waiting',
              uiStatus: computeUiStatus({
                isRunning,
                hasActiveBackgroundTasks: this.manager.hasActiveBackgroundTasks(id),
                lastError: t.lastError,
                messageCount: nonCompact.length,
                reviewed: t.reviewed,
              }),
              isRunning,
              lastError: t.lastError,
              reviewed: t.reviewed,
              projectId: t.projectId,
              cwd: t.cwd,
              originRepoPath: t.originRepoPath,
              projectNameOverride: t.projectNameOverride,
              prUrl: t.prUrl,
              scheduledItemId: t.scheduledItemId,
              scheduledItemName: t.scheduledItemName,
              updatedAt: t.updatedAt,
              messageCount: nonCompact.length,
              rawLogPath: t.rawLogPath,
              managerNotes: t.managerNotes,
              managerNotesSourceThreadId: t.managerNotesSourceThreadId,
              managerNotesUpdatedAt: t.managerNotesUpdatedAt,
              proposedReply: t.proposedReply,
              messages: nonCompact.map((m: { id: string; role: string; content: string; timestamp: number }) => ({
                id: m.id,
                role: m.role,
                content: m.content,
                timestamp: m.timestamp,
              })),
            };
          },
          openThread: (id: string) => this.openThreadInChatView(id),
          getAllThreads: () => this.manager.getThreads().map((t: { id: string; title: string; status?: string; lastError?: string; reviewed?: boolean; projectId?: string; cwd?: string; originRepoPath?: string; projectNameOverride?: string; prUrl?: string; scheduledItemId?: string; scheduledItemName?: string; updatedAt: number; rawLogPath?: string; managerNotes?: string; proposedReply?: { text: string; generatedAt: number; sourceThreadId?: string }; messages: Array<{ role: string }> }) => {
            const isRunning = this.manager.isRunning(t.id);
            const messageCount = t.messages.filter((m: { role: string }) => m.role !== 'compact').length;
            return {
              id: t.id,
              title: t.title,
              status: t.status ?? 'waiting',
              uiStatus: computeUiStatus({
                isRunning,
                hasActiveBackgroundTasks: this.manager.hasActiveBackgroundTasks(t.id),
                lastError: t.lastError,
                messageCount,
                reviewed: t.reviewed,
              }),
              isRunning,
              lastError: t.lastError,
              reviewed: t.reviewed,
              projectId: t.projectId,
              cwd: t.cwd,
              originRepoPath: t.originRepoPath,
              projectNameOverride: t.projectNameOverride,
              prUrl: t.prUrl,
              scheduledItemId: t.scheduledItemId,
              scheduledItemName: t.scheduledItemName,
              updatedAt: t.updatedAt,
              messageCount,
              rawLogPath: t.rawLogPath,
              managerNotes: t.managerNotes,
              managerNotesSourceThreadId: (t as typeof t & { managerNotesSourceThreadId?: string }).managerNotesSourceThreadId,
              managerNotesUpdatedAt: (t as typeof t & { managerNotesUpdatedAt?: number }).managerNotesUpdatedAt,
              proposedReply: t.proposedReply,
            };
          }),
          getAllProjects: () => this.manager.getProjects().map((p: Project) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            vaultFolder: p.vaultFolder,
            cwdOverride: p.cwdOverride,
            effectiveCwd: this.manager.getProjectCwd(p),
            orchestratorThreadId: p.orchestratorThreadId,
          })),
          createProject: (name, vaultFolder, description, cwdOverride) => {
            const p = this.manager.createProject(name, vaultFolder, description, cwdOverride);
            this.saveSettings().catch(console.error);
            return { id: p.id, name: p.name, description: p.description, vaultFolder: p.vaultFolder, cwdOverride: p.cwdOverride, effectiveCwd: this.manager.getProjectCwd(p) };
          },
          updateProject: updateProjectFromAgent,
          setThreadProject: (threadId, projectId, alignCwd) => {
            this.manager.setThreadProject(threadId, projectId, alignCwd);
            this.saveSettings().catch(console.error);
          },
          readThreadLog: (id: string, opts: { limit?: number; type?: string }) => this.manager.readRawLog(id, opts),
          isThreadRunning: (id: string) => this.manager.isRunning(id),
          sendMessageToThread: (id: string, message: string) => this.manager.sendMessage(id, message),
          archiveThread: async (id: string) => {
            await this.archiveThreadById(id);
            await this.saveSettings();
          },
          requestDeferredArchive: (id: string) => deferredThreadArchiver.request(id),
          setThreadNotes: (id: string, notes: string) => {
            const thread = this.manager.getThread(id);
            if (!thread) throw new Error(`Thread not found: ${id}`);
            if (notes) {
              thread.managerNotes = notes;
              thread.managerNotesSourceThreadId = threadId;
              thread.managerNotesUpdatedAt = Date.now();
            } else {
              delete thread.managerNotes;
              delete thread.managerNotesSourceThreadId;
              delete thread.managerNotesUpdatedAt;
            }
            this.manager.notifyManagerNotesChanged(id);
            this.saveSettings().catch(console.error);
          },
          setThreadProposedReply: (id: string, text: string) => {
            const thread = this.manager.getThread(id);
            if (!thread) throw new Error(`Thread not found: ${id}`);
            assertProposalOwnership(thread.proposedReply, threadId);
            thread.proposedReply = { text, generatedAt: Date.now(), sourceThreadId: threadId };
            this.manager.notifyProposedReplyChanged(id);
            this.saveSettings().catch(console.error);
          },
          clearThreadProposedReply: (id: string) => {
            const thread = this.manager.getThread(id);
            if (!thread) throw new Error(`Thread not found: ${id}`);
            delete thread.proposedReply;
            this.manager.notifyProposedReplyChanged(id);
            this.saveSettings().catch(console.error);
          },
          onCronCreate: (params) => this.scheduler.createItem(params),
          onCronList: () => this.scheduler.listItems(),
          onCronUpdate: (id, patch) => this.scheduler.updateItem(id, patch),
          onCronDelete: (id) => this.scheduler.deleteItem(id),
          onSkillsListInstalled: async () => {
            const skills = await skillManager.listInstalledSkills(this.settings.skillSources ?? [], this.getManagedSkillRoots());
            return skills.map(({ content: _content, ...rest }) => rest);
          },
          onSkillsSearch: async (query, limit) => {
            const installed = await skillManager.listInstalledSkills(this.settings.skillSources ?? [], this.getManagedSkillRoots());
            return skillManager.searchMarketplaceSkills(query, limit ?? 15, installed);
          },
          onSkillsGet: (identifier) => skillManager.getSkillDetail(identifier, this.settings.skillSources ?? [], this.getManagedSkillRoots()),
          onSkillsListSources: () => skillManager.listSkillSources(this.settings.skillSources ?? []),
          onSkillsCheckUpdates: async () => {
            const results = await skillManager.checkAllSourcesForUpdates(this.settings.skillSources ?? []);
            let changed = false;
            for (const result of results) {
              if (result.error) continue;
              const source = (this.settings.skillSources ?? []).find((s) => s.id === result.id);
              if (!source) continue;
              source.behindCount = result.behindCount;
              source.lastFetched = result.lastFetched;
              changed = true;
            }
            if (changed) await this.saveSettings();
            return results;
          },
          // Agent-driven installs land in the vault like UI installs do. The
          // uninstall guard lives in skillManager (not here) because
          // ObsidianTools already converts a rejection into { error, isError }.
          onSkillsInstall: (params) => skillManager.installSkillFromMarketplace(params, {
            installRoot: this.getPluginSkillsRoot(),
          }),
          onSkillsCreateLocal: params => {
            const { createLocalSkill } = require('./localSkills') as typeof import('./localSkills');
            return createLocalSkill(this.getLocalSkillsRoot(), params);
          },
          onSkillsUpdateLocal: params => {
            const { updateLocalSkill } = require('./localSkills') as typeof import('./localSkills');
            return updateLocalSkill(this.getLocalSkillsRoot(), params);
          },
          onSkillsUninstall: (name) => skillManager.uninstallSkillByName(name, this.settings.skillSources ?? [], this.getManagedSkillRoots()),
          onSkillsUpdate: async (sourceId) => {
            const source = (this.settings.skillSources ?? []).find((s) => s.id === sourceId);
            if (!source) {
              throw new Error(`No skill source configured with id "${sourceId}"`);
            }
            const result = await skillManager.pullGithubSourceUpdates(source);
            source.behindCount = result.behindCount;
            source.lastFetched = result.lastFetched;
            await this.saveSettings();
            return result;
          },
          onRequestSecret: (secretName: string, reason: string, force?: boolean) =>
            this.requestSecretFromUser(secretName, reason, force),
        });
        const mcpDebug = Object.fromEntries(Object.entries(mcpServers).map(([key, server]) => [key, {
          type: (server as unknown as Record<string, unknown>).type,
          name: (server as unknown as Record<string, unknown>).name,
          hasInstance: 'instance' in server,
        }]));
        debugLog(`[ClaudeThreads] Built-in MCP servers created for thread ${threadId}:`, mcpDebug);

        // Merge the user's own external MCP servers (Settings → MCP, stored in
        // this plugin's data.json) so every thread — including scheduled and
        // looped ones — gets the same roster. ThreadManager feeds this single
        // result to BOTH harnesses: `claude.mcpServers` for the Agent SDK and,
        // after shape translation, `codex.mcpServers` for the Codex app-server.
        //
        // Secrets from the OS keychain expand the ${VAR_NAME} placeholders in
        // those configs. A server whose placeholders don't resolve is dropped
        // rather than injected with blanks — see resolveMcpServers.
        const projectId = this.manager.getThread(threadId)?.projectId;
        const resolvedSecrets = this.manager.secretEnvResolver?.(projectId) ?? {};
        const { servers: externalMcps, warnings } = resolveMcpServers(
          this.settings.mcpServers,
          { ...(process.env as Record<string, string>), ...resolvedSecrets },
        );
        const externalCount = Object.keys(externalMcps).length;
        if (externalCount > 0) {
          debugLog(`[ClaudeThreads] Merging ${externalCount} external MCP server(s) from plugin settings:`, Object.keys(externalMcps));
        }
        this.reportMcpWarnings(warnings);

        const googleMcps = this.googleWorkspaceMcp?.serversForThread(threadId) ?? {};
        if (Object.values(this.settings.googleWorkspaceMcp ?? {}).some(Boolean) && !Object.keys(googleMcps).length) {
          this.reportMcpWarnings([this.googleWorkspaceMcp?.status() ?? 'Google Workspace is unavailable. Check Settings → MCP.']);
        }
        const oauthMcps = this.oauthMcpRegistry?.serversForThread(threadId) ?? {};
        return mergeMcpServers<import('@anthropic-ai/claude-agent-sdk').McpServerConfig>(
          mergeMcpServers<import('@anthropic-ai/claude-agent-sdk').McpServerConfig>(
            mergeMcpServers<import('@anthropic-ai/claude-agent-sdk').McpServerConfig>(mcpServers, googleMcps), externalMcps), oauthMcps);
      } catch (err) {
        console.error('[ClaudeThreads] Failed to create built-in MCP servers:', err);
        return {} as Record<string, McpServerConfig>;
      }
    };
    // Project vaultFolder paths are anchored to the vault itself. defaultCwd may
    // intentionally point at a repository outside the vault and must not affect
    // that derivation.
    this.manager.vaultRoot = resolveProjectVaultRoot(this.app.vault.adapter);
    // App handle for AttachmentWriter (writes image files through the vault API).
    this.manager.app = this.app;
    // Absolute path to this plugin's installed dist/ dir, used to resolve the
    // bundled thread-orchestrator skill (see ThreadManager.buildSessionOptions()).
    {
      const adapter = this.app.vault.adapter;
      if (adapter instanceof FileSystemAdapter) {
        this.manager.pluginResourceDir = require('path').join(adapter.getBasePath(), this.manifest.dir!);
      }
    }
    // Resolve secret env vars from the OS keychain at session start. Values are
    // never stored in settings — only the key names live in data.json.
    this.manager.secretEnvResolver = (projectId?: string) => {
      const result: Record<string, string> = {};
      for (const varName of this.settings.secretEnvKeys ?? []) {
        if (!isSecretVisibleToProject(this.settings.secretEnvScopes, varName, projectId)) continue;
        const val = this.app.secretStorage.getSecret(secretStorageKey(varName));
        if (val) result[varName] = val;
      }
      return result;
    };
    this.persistence = new VaultPersistence(this.app, this.settings.vaultFolder);
    this.inProcessSummarizer = new InProcessSummarizer();

    // Wake lock — keep computer awake while sessions are processing
    this.wakeLock = new WakeLockService({ enabled: this.settings.wakeLockEnabled });
    const statusBarItem = this.addStatusBarItem();
    statusBarItem.style.display = 'none';
    statusBarItem.setText('☕');
    statusBarItem.title = 'Agent Threads: keeping computer awake during active sessions';
    this.wakeLock.onChange((isActive) => {
      statusBarItem.style.display = isActive ? 'inline-block' : 'none';
    });
    const unsubWakeLock = this.manager.subscribe((_threadId, event) => {
      if (event.type === 'streaming_start') {
        this.wakeLock.acquire();
      } else if (event.type === 'done' || event.type === 'error') {
        this.wakeLock.release();
      }
    });
    this.register(unsubWakeLock);

    // Persist status changes to vault for all threads (including background ones
    // not covered by the per-view save on 'message').
    const unsubStatus = this.manager.subscribe((threadId, event) => {
      if (!this.settings.saveThreadsToVault) return;
      if (event.type !== 'done' && event.type !== 'error') return;
      const thread = this.manager.getThread(threadId);
      if (thread) {
        this.persistence?.saveThread(thread).catch(console.error);
      }
    });
    this.register(unsubStatus);
    this.register(this.manager.subscribe(() => {
      this.googleWorkspaceMcp?.retainThreads(new Set(this.manager.getThreads().filter(thread => thread.status !== 'archived').map(thread => thread.id)));
      this.oauthMcpRegistry?.retainThreads(new Set(this.manager.getThreads().filter(thread => thread.status !== 'archived').map(thread => thread.id)));
    }));

    // AgentRun state is a crash-recovery record, so persist every lifecycle
    // projection while the parent turn is still active. Waiting for done/error
    // would lose in-flight agents if Obsidian or the host process exits.
    const unsubAgentRuns = subscribeAgentRunPersistence(this.manager, () => {
      this.saveSettings().catch(console.error);
    });
    this.register(unsubAgentRuns);

    // Persist cwd repairs to data.json. repairStaleCwds() (called below at load
    // time) already calls saveSettings() directly, but the session-start safety-net
    // in ThreadManager also emits cwd_changed — catch those here so the repaired
    // path survives the next plugin reload.
    const unsubCwdRepair = this.manager.subscribe((_threadId, event) => {
      if (event.type === 'cwd_changed') {
        this.saveSettings().catch(console.error);
      }
    });
    this.register(unsubCwdRepair);

    // Persist pending plan text so the plan card survives a reload/crash.
    const unsubPendingPlan = this.manager.subscribe((_threadId, event) => {
      if (event.type === 'pending_plan_changed' || event.type === 'permission_mode_changed') {
        this.saveSettings().catch(console.error);
      }
    });
    this.register(unsubPendingPlan);

    // Background task monitoring: when a session ends with unresolved background
    // tasks, schedule an automatic poll to check completion.
    const unsubBgTasks = this.manager.subscribe((threadId, event) => {
      if (event.type === 'background_tasks_pending') {
        this.scheduleBgTaskPoll(threadId, event.tasks);
      } else if (event.type === 'task_notification') {
        // A background task resolved. If no tasks remain, cancel the poll timer.
        const remaining = this.manager.getPendingBackgroundTasks(threadId);
        if (remaining.length === 0) {
          this.cancelBgTaskPoll(threadId);
        }
        // Append a persisted notice message to the thread's transcript when the
        // notification arrives on an idle thread (the ThreadsView task-pill
        // handles it when the thread is actively streaming). Persisting it into
        // thread.messages means it survives reload and scroll-back, instead of a
        // transient global toast.
        if (!this.manager.isRunning(threadId)) {
          this.manager.addNoticeMessage(threadId, event.status, event.summary);
        }
        // Persist the updated (cleared) pending task list.
        this.saveSettings().catch(console.error);
      }
    });
    this.register(unsubBgTasks);

    // Bridge-aware repo edits: when a turn writes files that live inside a
    // Vault Bridge's source repo (rather than the synced vault copy), trigger
    // a bridge pull at end of turn so the vault copies refresh immediately.
    const pendingBridgeEdits = new Map<string, Set<string>>();
    const bridgeSyncsInFlight = new Set<string>();
    const unsubBridgeSync = this.manager.subscribe((threadId, event) => {
      if (event.type === 'tool_use') {
        if (event.record.name === 'Write' || event.record.name === 'Edit') {
          const filePath = event.record.summary.replace(/^[^:]+: /, '');
          if (filePath) {
            let set = pendingBridgeEdits.get(threadId);
            if (!set) {
              set = new Set();
              pendingBridgeEdits.set(threadId, set);
            }
            set.add(filePath);
          }
        }
        return;
      }
      if (event.type !== 'done' && event.type !== 'error') return;
      const files = pendingBridgeEdits.get(threadId);
      pendingBridgeEdits.delete(threadId);
      if (!files || files.size === 0) return;
      const api = getVaultBridgesAPI(this.app);
      if (!api) return;
      let bridges: BridgeInfo[];
      try {
        bridges = api.getBridges();
      } catch (err) {
        console.error('[Agent Threads] could not read vault bridges:', err);
        return;
      }
      for (const bridge of findBridgesForFiles(files, bridges)) {
        if (bridgeSyncsInFlight.has(bridge.id)) continue;
        bridgeSyncsInFlight.add(bridge.id);
        api
          .syncBridge(bridge.id)
          .then(() => new Notice(`Vault bridge pulled: ${bridge.name}`))
          .catch((err: unknown) => {
            console.error('[Agent Threads] bridge sync failed:', err);
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Vault bridge sync failed: ${bridge.name}: ${msg}`, 8000);
          })
          .finally(() => bridgeSyncsInFlight.delete(bridge.id));
      }
    });
    this.register(unsubBridgeSync);

    // Load persisted projects + threads
    this.manager.loadProjects(this.settings.projects ?? []);
    const savedThreads = this.settings.threads ?? [];
    this.manager.loadThreads(savedThreads);
    const repairedOrchestrators = repairStaleProjectOrchestrators(
      this.manager.getProjects(),
      id => this.manager.getThread(id)?.projectId,
      this.settings.scheduledItems ?? (this.settings.scheduledItems = []),
      this.settings.orchestratorThreadId,
    );
    if (repairedOrchestrators) this.manager.loadProjects(this.manager.getProjects());

    // Initialize the built-in scheduler
    this.scheduler = new Scheduler({
      getItems: () => this.settings.scheduledItems ?? [],
      saveItem: async (item) => {
        if (!this.settings.scheduledItems) this.settings.scheduledItems = [];
        const idx = this.settings.scheduledItems.findIndex((i) => i.id === item.id);
        if (idx >= 0) this.settings.scheduledItems[idx] = item;
        else this.settings.scheduledItems.push(item);
        await this.saveSettings();
      },
      removeItem: async (id) => {
        this.settings.scheduledItems = (this.settings.scheduledItems ?? []).filter((i) => i.id !== id);
        await this.saveSettings();
      },
      saveItems: async (items) => {
        const previous = this.settings.scheduledItems;
        this.settings.scheduledItems = items;
        try {
          await this.saveSettings();
        } catch (error) {
          this.settings.scheduledItems = previous;
          throw error;
        }
      },
      createThread: (title, cwd, projectId, scheduledItemId) => {
        const thread = this.manager.createThread(title, cwd, projectId);
        // Scheduled sessions should not block on permission prompts. When the
        // global permissionMode is 'default' (ask every time), override to
        // 'dontAsk' so unattended runs complete without hanging.
        if (!thread.permissionMode && this.settings.permissionMode === 'default') {
          thread.permissionMode = 'dontAsk';
        }
        // Record the scheduled item that created this thread, for the
        // "Scheduled: <name>" footer pill. Captured once at creation time —
        // not kept in sync with later renames of the scheduled item.
        if (scheduledItemId) {
          thread.scheduledItemId = scheduledItemId;
          thread.scheduledItemName = (this.settings.scheduledItems ?? []).find(
            (i) => i.id === scheduledItemId
          )?.name;
        }
        return thread;
      },
      sendMessage: (threadId, prompt) => this.manager.sendMessage(threadId, prompt),
      getDefaultCwd: () => this.getEffectiveCwd(),
      getProjectCwd: (projectId) => {
        const project = this.manager.getProject(projectId);
        return project ? this.manager.getProjectCwd(project) : undefined;
      },
      threadExists: (threadId) => !!this.manager.getThread(threadId),
      isThreadBusy: (threadId) => this.manager.isRunning(threadId),
      onOrchestratorHeartbeatStale: () => console.warn('[ClaudeThreads] Orchestrator heartbeat target missing — run "Open Thread Orchestrator" to recreate it.'),
      // Resolve the PATH-augmented base env and keychain values once per gate
      // evaluation. The bundle is passed only to the subprocess and diagnostic
      // redactor; Scheduler never stores it on a scheduled item.
      getGateBaseEnv: Platform.isMobile
        ? undefined
        : (projectId?: string) => makeGateEnvironment(execEnv(), this.manager.secretEnvResolver?.(projectId) ?? {}),
      // Deterministic gate runner (desktop only). Resolves — never rejects —
      // classifying the outcome so fire()'s fail-open logic can distinguish a
      // deliberate skip from exit 75, a timeout, or a spawn failure
      // (could-not-evaluate). Mirrors the StatusLineService exec wiring.
      runGate: Platform.isMobile
        ? undefined
        : (() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const childProcess = require('child_process') as typeof import('child_process');
            return createGateRunner(childProcess.exec as GateExec);
          })(),
    });
    this.scheduler.start(this.settings.scheduledItems ?? []);
    if (repairedOrchestrators) await this.saveSettings();

    // Status-line service: polls statusLineCommand per thread cwd so every
    // thread's footer pills + derived prUrl stay fresh (desktop only).
    {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const childProcess = require('child_process') as typeof import('child_process');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const osMod = require('os') as typeof import('os');
      this.statusLine = new StatusLineService(
        this.manager,
        () => ({
          statusLineCommand: this.settings.statusLineCommand,
          statusLineIntervalMs: this.settings.statusLineIntervalMs,
          provider: this.settings.provider,
        }),
        {
          exec: childProcess.exec,
          now: () => Date.now(),
          homedir: () => osMod.homedir(),
          isMobile: Platform.isMobile,
          getDefaultCwd: () => this.getEffectiveCwd(),
          // Idle-pause interval polls when no relevant view is open and nothing runs;
          // event-triggered polls (done/cwd_changed/focus) still fire.
          shouldPoll: () => {
            const ws = this.app.workspace;
            const anyViewOpen =
              ws.getLeavesOfType(VIEW_TYPE).length > 0 ||
              ws.getLeavesOfType(AGENT_VIEW_TYPE).length > 0 ||
              ws.getLeavesOfType(KANBAN_VIEW_TYPE).length > 0;
            const anyRunning = this.manager.getThreads().some((t) => this.manager.isRunning(t.id));
            return anyViewOpen || anyRunning;
          },
        },
      );
      this.statusLine.start();
    }

    // Git diff service: computes native git plumbing (branch/base/diff-stat) per
    // thread cwd so the git diff bar + Create PR button stay fresh (desktop only).
    // No arbitrary user command here — fixed `git` subcommands via execFile.
    {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const childProcess = require('child_process') as typeof import('child_process');
      this.gitDiff = new GitDiffService(
        this.manager,
        {
          execFile: childProcess.execFile,
          now: () => Date.now(),
          isMobile: Platform.isMobile,
          getDefaultCwd: () => this.getEffectiveCwd(),
          // Idle-pause interval polls when no relevant view is open and nothing runs;
          // event-triggered polls (done/cwd_changed/focus) still fire.
          shouldPoll: () => {
            const ws = this.app.workspace;
            const anyViewOpen =
              ws.getLeavesOfType(VIEW_TYPE).length > 0 ||
              ws.getLeavesOfType(AGENT_VIEW_TYPE).length > 0 ||
              ws.getLeavesOfType(KANBAN_VIEW_TYPE).length > 0;
            const anyRunning = this.manager.getThreads().some((t) => this.manager.isRunning(t.id));
            return anyViewOpen || anyRunning;
          },
        },
      );
      this.gitDiff.start();
    }

    // Telemetry perf sampler (desktop only, self-gated on Platform.isMobile and the
    // telemetry-enabled setting). Samples renderer CPU/mem only while a plugin view
    // is open, mirroring the status-line/git-diff shouldPoll predicate.
    telemetry.init({
      isViewOpen: () => {
        const ws = this.app.workspace;
        return (
          ws.getLeavesOfType(VIEW_TYPE).length > 0 ||
          ws.getLeavesOfType(AGENT_VIEW_TYPE).length > 0 ||
          ws.getLeavesOfType(KANBAN_VIEW_TYPE).length > 0
        );
      },
    });

    // Event-driven wake-up: pings the thread-orchestrator thread shortly after
    // any other thread finishes a turn, so it feels continuously running
    // rather than polling on a fixed schedule. The heartbeat CronCreate item
    // set up in ensureOrchestratorThread() is a backstop for missed events
    // only — this is the primary trigger. See OrchestratorWakeup.ts.
    {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { OrchestratorWakeup } = require('./OrchestratorWakeup') as typeof import('./OrchestratorWakeup');
      this.orchestratorWakeup = new OrchestratorWakeup(this.manager, {
        resolveBucket: (threadId) => {
          const thread = this.manager.getThread(threadId);
          if (!thread) return undefined;
          if (threadId === this.settings.orchestratorThreadId) return undefined;
          if (!thread.projectId) return 'portfolio';
          const project = this.manager.getProject(thread.projectId);
          if (project?.orchestratorThreadId === threadId) return 'portfolio';
          if (project?.orchestratorEnabled === false) return undefined;
          return `project:${thread.projectId}`;
        },
        resolveTarget: async (bucket, isCurrent) => {
          if (bucket === 'portfolio') return this.settings.orchestratorThreadId;
          if (!bucket.startsWith('project:')) return undefined;
          const projectId = bucket.slice('project:'.length);
          if (this.manager.getProject(projectId)?.orchestratorEnabled === false) return undefined;
          try {
            return await this.ensureProjectOrchestratorThread(projectId, false, isCurrent);
          } catch (error) {
            console.warn(`[ClaudeThreads] Project orchestrator creation failed for ${bucket}:`, error);
            if (this.manager.getProject(projectId)?.orchestratorEnabled === false) return undefined;
            return this.settings.orchestratorThreadId
              ? { threadId: this.settings.orchestratorThreadId, summaryOnly: true as const }
              : undefined;
          }
        },
        threadExists: (id) => !!this.manager.getThread(id),
        sendMessage: (id, text) => this.manager.sendMessage(id, text),
        onWarn: (message) => console.warn(`[ClaudeThreads] ${message}`),
        onError: (err) => console.error('[ClaudeThreads] Orchestrator wake-up sendMessage failed:', err),
      });
      this.orchestratorWakeup.start();
      this.register(() => this.orchestratorWakeup?.stop());
    }

    // Document watch service: alerts the owning thread whenever a watched vault
    // document's content changes. Works on both desktop and mobile — vault.on()
    // events don't require child_process, unlike the desktop-only services above.
    {
      const { DocumentWatchService } = require('./DocumentWatchService') as typeof import('./DocumentWatchService');
      this.documentWatch = new DocumentWatchService({
        app: this.app,
        getWatches: () => this.settings.watchedDocuments ?? [],
        saveWatches: async (next) => {
          this.settings.watchedDocuments = next;
          await this.saveSettings();
        },
        sendMessage: (id, text) => this.manager.sendMessage(id, text),
        getThread: (id) => this.manager.getThread(id),
        onError: (err) => console.error('[ClaudeThreads] Document watch alert failed:', err),
      });
      this.documentWatch.start();
      this.register(() => this.documentWatch?.stop());
    }

    // Agent browser pool: owns every in-app browser guest and, more importantly,
    // reclaims them. Each guest is a sandboxed renderer process, so the failure
    // mode of getting this wrong is not a stale record but an app that slowly
    // runs the machine out of file descriptors — which is exactly what the
    // external browser CLI this replaces used to do.
    //
    // Desktop-only by construction: the pool refuses to create anything unless
    // the host exposes FD diagnostics, which only Geode desktop does.
    if (this.settings.enableAgentBrowser) {
      const { AgentBrowserPool } = require('./agentBrowser/AgentBrowserPool') as typeof import('./agentBrowser/AgentBrowserPool');
      this.agentBrowser = new AgentBrowserPool({
        doc: document,
        hostWindow: window,
        getMaxGuests: () => this.settings.agentBrowserMaxGuests ?? 2,
        getUrlPolicy: () => ({ allowPrivateNetwork: this.settings.agentBrowserAllowPrivateNetwork ?? false }),
        notify: (message) => { new Notice(message); },
        log: (message, meta) => { debugLog(message, meta); },
      });
      this.agentBrowser.start();

      // Teardown goes through register() rather than onunload(): register
      // callbacks run synchronously inside Component.unload(), whereas
      // onunload() is not awaited and already sits behind an up-to-10s
      // gracefulShutdown wait. A guest must not survive that long past unload.
      this.register(() => this.agentBrowser?.destroy());

      // A deleted thread's guest goes with it. emit() dispatches to listeners
      // synchronously, so this reclaims inside deleteThread's own call stack.
      this.register(this.manager.subscribe((threadId, event) => {
        if (event.type === 'thread_deleted') {
          this.agentBrowser?.destroyForThread(threadId, 'thread-delete');
        }
      }));

      // Last-ditch: a page teardown that skips plugin unload entirely.
      this.registerDomEvent(window, 'pagehide', () => {
        this.agentBrowser?.destroyAll('unload');
      });

      // Preview pane. Registered with the pool rather than unconditionally, so
      // the view type simply does not exist when the feature is off.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AgentBrowserPreviewView } = require('./agentBrowser/AgentBrowserPreviewView') as typeof import('./agentBrowser/AgentBrowserPreviewView');
      this.registerView(
        AGENT_BROWSER_VIEW_TYPE,
        (leaf) => new AgentBrowserPreviewView(leaf, () => this.agentBrowser),
      );
      this.addCommand({
        id: 'open-agent-browser-preview',
        name: 'Open Agent Browser',
        callback: () => { void this.activateAgentBrowserView(); },
      });
    }

    // Repair any threads whose cwd points to a deleted worktree — removed by
    // exit_worktree, the worktree-cleanup skill, the Agent tool's auto-cleanup, or
    // (for legacy os.tmpdir()/claude-worktrees/ paths) wiped by an OS reboot.
    // When that happens outside the plugin, the persisted cwd becomes a dangling path
    // that causes a misleading "binary not found" ENOENT on the next message send.
    {
      const repairedCount = this.manager.repairStaleCwds();
      if (repairedCount > 0) {
        console.log(`[ClaudeThreads] Repaired ${repairedCount} thread(s) with stale working director${repairedCount === 1 ? 'y' : 'ies'}`);
        await this.saveSettings();
      }
    }

    // One-time backfill for threads orphaned before Thread.originRepoPath existed:
    // their worktree cwd was already unrecoverable, so repairStaleCwds() above can't
    // restore a project name either. Recover a display-only label from the thread's
    // PR URL instead (see backfillLegacyProjectNames() doc comment).
    {
      const backfilledCount = this.manager.backfillLegacyProjectNames();
      if (backfilledCount > 0) {
        console.log(`[ClaudeThreads] Backfilled project name for ${backfilledCount} legacy thread(s)`);
        await this.saveSettings();
      }
    }

    // Archive orphaned vault notes FIRST — before crash recovery runs.
    //
    // Notes with status:waiting that are not in data.json would be incorrectly
    // treated as "crashed" threads and resurrected if crash recovery ran first.
    // Common cause: closeThread's async vault save didn't finish before a quick
    // Obsidian restart, leaving the note with status:waiting even though the thread
    // was deliberately closed.
    //
    // By running the orphan scan synchronously first we ensure every stale
    // status:waiting note is flipped to archived before crash recovery even looks.
    // The scan uses the metadata cache for a fast pre-check (zero extra disk reads
    // for already-archived notes or notes belonging to known active threads).
    //
    // Skip once the scan has completed — the flag is reset any time crash recovery
    // loads threads so we always re-scan after a genuine data.json loss.
    if (this.settings.saveThreadsToVault && !this.settings.orphanArchiveScanComplete) {
      const activeIds = new Set(this.manager.getThreads().map((t) => t.id));
      try {
        const n = await this.persistence.archiveOrphanedNotes(activeIds);
        if (n > 0) console.log(`[ClaudeThreads] Archived ${n} orphaned thread note(s)`);
      } catch (err) {
        console.error('[ClaudeThreads] Failed to archive orphaned notes:', err);
      }
      this.settings.orphanArchiveScanComplete = true;
      await this.saveSettings();
    }

    // Crash recovery: data.json is canonical during normal startup. If it was
    // cleared, recover missing threads only from versioned JSON sidecars stored
    // beside vault notes. The Markdown body is presentation-only and is never
    // parsed back into live thread state.
    //
    // Important guards:
    //   - Skip threads whose vault note is already marked `archived` — those were
    //     deliberately closed by the user and must not be resurrected on reload.
    //     The orphan scan above ensures stale status:waiting notes are archived
    //     before we reach this point.
    //   - Reset `active` status to `waiting` — the SDK session is gone after any
    //     reload so there's nothing to resume; showing them as running would be wrong.
    //
    // Legacy notes without a supported sidecar remain readable archives but are
    // not guessed back into live state; canonical data.json remains available
    // when present, and raw JSONL remains an audit log rather than a prose parser.
    if (this.settings.saveThreadsToVault) {
      const knownIds = new Set(this.manager.getThreads().map((t) => t.id));
      const vaultFolder = this.settings.vaultFolder;
      const hasUnknownThreads = this.app.vault.getMarkdownFiles()
        .filter((f) => f.path.startsWith(vaultFolder + '/'))
        .some((f) => {
          const tid = this.app.metadataCache.getFileCache(f)?.frontmatter?.['thread_id'];
          return tid && !knownIds.has(String(tid));
        });

      if (hasUnknownThreads) {
        scheduleVaultThreadRecovery({
          knownIds,
          loadAllThreads: () => this.persistence.loadAllThreads(),
          // Emit one batch event after every recovered thread is in memory so
          // already-open views refresh once, rather than once per thread.
          loadRecoveredThreads: (threads) => this.manager.loadThreads(threads, true),
          markOrphanArchiveScanIncomplete: () => {
            this.settings.orphanArchiveScanComplete = false;
          },
          // Persist recovered state durably, but never hold up plugin startup.
          saveSettings: () => this.saveSettings(),
          logRecovered: (count) => console.log(`[ClaudeThreads] Recovered ${count} thread(s) from vault notes`),
          logError: (err) => console.error('[ClaudeThreads] Failed to recover threads from vault:', err),
        });
      }
    }

    // One-time image-externalization backfill (ADR-0003, PR 1). Walk every loaded
    // thread's inline image bytes, write each to a vault attachment file, and set
    // its `path`. Desktop-only, idempotent, crash-safe: the file is written before
    // `path` is set, so a crash just retries next launch. The saveSettings() below
    // is the write that actually shrinks data.json, because serializeThreadForSave
    // now drops base64 for any path-backed image. Never deletes base64
    // destructively. It only leaves data.json via the serialize strip.
    if (!this.settings.imageExternalizationComplete) {
      const adapter = this.app.vault.adapter;
      if (adapter instanceof FileSystemAdapter) {
        try {
          const n = await this.manager.backfillExternalizeImages();
          if (n > 0) console.log(`[ClaudeThreads] Externalized ${n} inline image(s) out of data.json`);
        } catch (err) {
          console.error('[ClaudeThreads] Image externalization backfill failed:', err);
        }
        this.settings.imageExternalizationComplete = true;
        await this.saveSettings();
      }
    }

    // Auto-archive idle `waiting` threads so finished threads stop accumulating
    // in data.json (archival was manual-only before). Run once at startup and on
    // a low-frequency interval so long-running desktop sessions still sweep. This
    // is placed AFTER the image-externalization backfill on purpose: the backfill
    // sets each image's `path`, and the archived note only embeds path-backed
    // images, so running it first means a first-launch sweep still produces notes
    // with working image embeds. The sweep self-guards when disabled.
    await this.sweepIdleThreads();
    const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
    this.registerInterval(
      window.setInterval(() => {
        void this.sweepIdleThreads();
      }, SWEEP_INTERVAL_MS),
    );

    // Resume background task monitoring for any threads that still had pending
    // tasks when the plugin was last unloaded (e.g. Obsidian restart mid-task).
    for (const thread of this.manager.getThreads()) {
      const pending = this.manager.getPendingBackgroundTasks(thread.id);
      if (pending.length > 0) {
        debugLog(`[ClaudeThreads] Resuming bg task monitoring for thread ${thread.id} (${pending.length} task(s) pending)`);
        this.scheduleBgTaskPoll(thread.id, pending);
      }
    }

    // Register the views
    this.registerView(VIEW_TYPE, (leaf) => new ThreadsView(leaf, this));
    this.registerView(AGENT_VIEW_TYPE, (leaf) => new AgentDashboard(leaf, this));
    this.registerView(KANBAN_VIEW_TYPE, (leaf) => new KanbanView(leaf, this));
    this.registerView(SKILLS_VIEW_TYPE, (leaf) => new SkillsManagerView(leaf, this));

    // Pause infinite spinner/pulse CSS animations while the window is hidden
    // (minimized, occluded, or backgrounded) — see the .ct-app-hidden rule in
    // styles.css. Prevents WindowServer from compositing frames nobody sees.
    const handleVisibilityChange = () => {
      document.body.classList.toggle('ct-app-hidden', document.hidden);
    };
    this.registerDomEvent(document, 'visibilitychange', handleVisibilityChange);
    handleVisibilityChange(); // set initial state on load

    // Ribbon icons
    this.addRibbonIcon('message-square', 'Agent Threads', () => {
      this.activateView();
    });
    this.addRibbonIcon('list', 'Agents List', () => {
      this.activateAgentView();
    });
    this.addRibbonIcon('kanban', 'Agent Board', () => {
      this.activateKanbanView();
    });
    this.addRibbonIcon('puzzle', 'Skills Manager', () => {
      this.activateSkillsView();
    });

    // Commands
    this.addCommand({
      id: 'open-claude-threads',
      name: 'Open Agent Threads',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'open-agent-dashboard',
      name: 'Open Agents List',
      callback: () => this.activateAgentView(),
    });

    this.addCommand({
      id: 'open-kanban-board',
      name: 'Open Agent Board',
      callback: () => this.activateKanbanView(),
    });

    this.addCommand({
      id: 'open-skills-manager',
      name: 'Open Skills Manager',
      callback: () => this.activateSkillsView(),
    });

    this.addCommand({
      id: 'new-claude-thread',
      name: 'New Claude Thread',
      callback: async () => {
        await this.activateAgentView();
        this.getAgentDashboard()?.focusDispatchInput();
      },
    });

    this.addCommand({
      id: 'next-claude-thread',
      name: 'Next Claude Thread',
      callback: () => this.getView()?.navigateTab(1),
    });

    this.addCommand({
      id: 'prev-claude-thread',
      name: 'Previous Claude Thread',
      callback: () => this.getView()?.navigateTab(-1),
    });

    for (let i = 1; i <= 9; i++) {
      const n = i;
      this.addCommand({
        id: `claude-thread-${n}`,
        name: `Switch to Claude Thread ${n}`,
        callback: () => this.getView()?.switchToTabIndex(n - 1),
      });
    }

    this.addCommand({
      id: 'jump-to-latest-unreviewed',
      name: 'Jump to latest unreviewed completed agent',
      callback: () => {
        const dashboard = this.getAgentDashboard();
        if (dashboard) {
          dashboard.jumpToLatestUnreviewed();
        } else {
          // Dashboard not open — open it then jump
          this.activateAgentView().then(() => {
            this.getAgentDashboard()?.jumpToLatestUnreviewed();
          });
        }
      },
    });

    this.addCommand({
      id: 'fork-claude-thread',
      name: 'Fork current Claude thread',
      callback: async () => {
        await this.activateView();
        const view = this.getView();
        const threadId = view?.getActiveThreadId();
        if (view && threadId) view.forkThread(threadId);
      },
    });

    this.addCommand({
      id: 'interrupt-active-thread',
      name: 'Interrupt active thread',
      callback: async () => {
        const threadId = this.getView()?.getActiveThreadId();
        if (threadId) {
          await this.manager.interrupt(threadId);
        }
      },
    });

    this.addCommand({
      id: 'summarize-active-thread',
      name: 'Summarize active thread',
      callback: async () => {
        await this.activateView();
        const view = this.getView();
        const threadId = view?.getActiveThreadId();
        if (view && threadId && this.settings.summarizationEnabled) {
          await view.summarizeThread(threadId);
        } else if (!this.settings.summarizationEnabled) {
          new Notice('Thread summarization is disabled. Enable it in Settings > Agent Threads > Summarization.');
        }
      },
    });

    // ── "Chat about this document" ──────────────────────────────────────────
    // Three entry points, one handler: file-explorer right-click, in-editor
    // right-click, and a command-palette entry gated on an active markdown file.
    this.addCommand({
      id: 'chat-about-active-document',
      name: DOCUMENT_CHAT_LABEL,
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!isChattableDocument(file)) return false;
        if (!checking) void this.startDocumentChat(file as TFile);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile) || !isChattableDocument(file)) return;
        this.addDocumentChatMenuItem(menu, file);
      }),
    );

    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, _editor, info) => {
        const file = info.file;
        if (!file || !isChattableDocument(file)) return;
        this.addDocumentChatMenuItem(menu, file);
      }),
    );

    // ── "Watch with active thread" ──────────────────────────────────────────
    // Same three-entry-point pattern as "Chat about this document", funneled
    // through one shared handler (toggleDocumentWatch). Unlike document chat,
    // watching needs an already-open thread to own the alert — there is
    // nothing to create the watch's target from, so a missing active thread
    // is a Notice rather than a new-thread dispatch.
    this.addCommand({
      id: 'watch-active-document',
      name: 'Watch or stop watching this document with the active thread',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!isWatchableDocument(file)) return false;
        if (!checking) void this.toggleDocumentWatch(file as TFile);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile) || !isWatchableDocument(file)) return;
        this.addDocumentWatchMenuItem(menu, file);
      }),
    );

    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, _editor, info) => {
        const file = info.file;
        if (!file || !isWatchableDocument(file)) return;
        this.addDocumentWatchMenuItem(menu, file);
      }),
    );

    // ── Compass "Send to Agent" receiver ───────────────────────────────────
    // Desktop-only by construction: the Web Viewer bridge exists only in
    // desktop Geode, so this lives in onloadDesktop() rather than the shared
    // onload(). Obsidian's Workspace typings don't know `web-viewer:event`
    // (it's Geode-specific), hence the cast — kept to the `on()` call itself so
    // the handler body stays typed. Subscribing to an event the host never
    // fires is harmless, which is exactly what happens under plain Obsidian.
    this.registerEvent(
      (this.app.workspace.on as unknown as (
        name: string,
        callback: (ev: unknown) => void,
      ) => EventRef)(WEB_VIEWER_EVENT_NAME, (ev: unknown) => {
        void handleWebViewerEvent(ev, this.compassHandoffHost(), this.compassHandoffDebouncer);
      }),
    );

    this.addCommand({
      id: 'open-thread-orchestrator',
      name: 'Open Portfolio Orchestrator',
      callback: async () => {
        await this.ensureOrchestratorThread();
      },
    });

    this.addCommand({
      id: 'reload-plugin-safely',
      name: 'Reload plugin (safe)',
      callback: async () => {
        if (!this.manager) {
          await this.safeReloadPlugin();
          return;
        }
        const running = this.manager.getRunningThreads();
        if (running.length === 0) {
          await this.safeReloadPlugin();
          return;
        }
        new ActiveThreadsReloadModal(this.app, running, async (action) => {
          if (action === 'cancel') return;
          if (action === 'graceful') {
            new Notice(
              `Interrupting ${running.length} thread${running.length === 1 ? '' : 's'}… waiting up to 30 s.`,
              32_000,
            );
            await this.manager!.gracefulShutdown(30_000);
          }
          await this.safeReloadPlugin();
        }).open();
      },
    });

    // Initialize relay client if remote access is enabled
    this.initDesktopRelayClient();

    // Publish only after every execution dependency (persistence, scheduler,
    // views, and relay hooks) is ready. Workspace events are synchronous, so a
    // peer may call the API from its api-ready handler immediately.
    this.initializePublicApi();

    // First-run onboarding: auto-open panels + welcome guide for brand-new installs.
    // Migration guard: if the user already has threads they're upgrading from a prior
    // version — mark hasSeenWelcome silently rather than hijacking their layout.
    if (!this.settings.hasSeenWelcome) {
      if (this.settings.threads.length === 0) {
        this.app.workspace.onLayoutReady(() => {
          this.firstRunSetup().catch(console.error);
        });
      } else {
        // Existing user upgrading — skip onboarding, just flip the flag
        this.settings.hasSeenWelcome = true;
        this.saveSettings().catch(console.error);
      }
    }
  }

  private async firstRunSetup(): Promise<void> {
    const { workspace, vault } = this.app;

    // 1. Write welcome guide to vault
    const selectedGuide = selectWelcomeGuidePath(
      this.settings.vaultFolder,
      path => Boolean(vault.getAbstractFileByPath(normalizePath(path))),
    );
    const guidePath = normalizePath(selectedGuide.path);
    try {
      if (selectedGuide.shouldCreate) {
        const folderPath = normalizePath(this.settings.vaultFolder);
        if (!vault.getAbstractFileByPath(folderPath)) {
          await vault.createFolder(folderPath);
        }
        await vault.create(guidePath, WELCOME_GUIDE);
      }
    } catch (err) {
      console.error('[ClaudeThreads] Failed to create welcome guide:', err);
    }

    // 2. Open chat according to the desktop-aware placement policy.
    try {
      if (this.isConversationFirst()) {
        await this.activateView();
      } else if (!workspace.getLeavesOfType(VIEW_TYPE)[0]) {
        const chatLeaf = workspace.getLeftLeaf(false) as WorkspaceLeaf;
        await chatLeaf.setViewState({ type: VIEW_TYPE, active: false });
      }
    } catch (err) {
      console.error('[ClaudeThreads] Failed to open chat in left sidebar:', err);
    }

    // 3. Open welcome guide in the CENTER editor
    try {
      const guideFile = vault.getAbstractFileByPath(guidePath);
      if (guideFile instanceof TFile) {
        if (this.isConversationFirst()) {
          await this.contextPanel.openFile(guideFile);
        } else {
          const centerLeaf = workspace.getLeaf('tab');
          await centerLeaf.openFile(guideFile);
          workspace.revealLeaf(centerLeaf);
        }
      }
    } catch (err) {
      console.error('[ClaudeThreads] Failed to open welcome guide:', err);
    }

    // 4. Open the Agents List in the RIGHT sidebar
    try {
      const existingDash = workspace.getLeavesOfType(AGENT_VIEW_TYPE)[0];
      if (!existingDash) {
        const dashLeaf = workspace.getRightLeaf(false) as WorkspaceLeaf;
        await dashLeaf.setViewState({ type: AGENT_VIEW_TYPE, active: true });
        workspace.revealLeaf(dashLeaf);
      } else {
        workspace.revealLeaf(existingDash);
      }
    } catch (err) {
      console.error('[ClaudeThreads] Failed to open Agents List:', err);
    }

    // 5. Welcome notice
    new Notice('Welcome to Agent Threads! Check the guide to get started.');

    // 6. Persist the flag so this never fires again
    this.settings.hasSeenWelcome = true;
    await this.saveSettings();
  }

  private async onloadMobile(): Promise<void> {
    // Mobile path: register MobileView, connect to relay if configured

    this.registerView(
      MOBILE_VIEW_TYPE,
      (leaf) => new MobileView(leaf, this.relayClient, this.mobileStore),
    );

    this.addRibbonIcon('smartphone', 'Agent Threads (Mobile)', () => {
      this.activateMobileView();
    });

    // Register URI handler for obsidian://pair?roomId=...&relay=...
    // Triggered when the user scans the QR code on desktop (camera opens the deep link).
    this.registerObsidianProtocolHandler('pair', async (params) => {
      const roomId = params['roomId'];
      const relayUrl = params['relay'] ?? this.settings.remoteAccess.relayUrl;
      if (!roomId) {
        new Notice('Invalid pairing link: missing roomId');
        return;
      }
      this.settings.remoteAccess.roomId = roomId;
      this.settings.remoteAccess.relayUrl = relayUrl;
      this.settings.remoteAccess.enabled = true;
      await this.saveSettings();
      this.initMobileRelayClient();
      new Notice('Paired with desktop successfully');
      await this.activateMobileView();
    });

    // Connect if already configured
    if (this.settings.remoteAccess.roomId) {
      this.initMobileRelayClient();
    }
  }

  initDesktopRelayClient(): void {
    const ra = this.settings.remoteAccess;
    if (!ra.enabled || !ra.roomId) return;

    this.relayClient?.disconnect();
    this.relayClient = new RelayClient('desktop', ra.relayUrl, ra.roomId, this.manager);

    // Provide expiry getter so RelayClient can gate first-time joins.
    this.relayClient.getPairingExpiresAt = () => this.settings.remoteAccess.pairingExpiresAt;

    // Once the first successful join completes, mark pairing done so reconnects
    // are always allowed (expiry only guards the initial QR scan window).
    this.relayClient.onPairingComplete = () => {
      this.settings.remoteAccess.pairingExpiresAt = null;
      this.saveSettings().catch(console.error);
    };

    // 3.11 — When mobile sends Always Allow, persist the tool name to settings.
    this.relayClient.onAlwaysAllowTool = (toolName: string) => {
      if (!this.settings.alwaysAllowedTools.includes(toolName)) {
        this.settings.alwaysAllowedTools.push(toolName);
        this.saveSettings().catch(console.error);
      }
    };

    this.relayClient.connect();

    // Keep the relay client informed of the active thread
    const unsub = this.manager.subscribe((threadId, event) => {
      if (event.type === 'active_thread_changed') {
        this.relayClient?.setActiveThreadId(threadId);
      }
    });
    this.register(unsub);
  }

  initMobileRelayClient(): void {
    const ra = this.settings.remoteAccess;
    if (!ra.roomId) return;

    this.relayClient?.disconnect();
    this.mobileStore = new MobileThreadStore();
    this.relayClient = new RelayClient('mobile', ra.relayUrl, ra.roomId);

    const unsub = this.relayClient.onFrame((frame) => {
      this.mobileStore!.applyFrame(frame);
    });
    this.register(unsub);

    this.relayClient.connect();
  }

  async activateMobileView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(MOBILE_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) as WorkspaceLeaf;
      await leaf.setViewState({ type: MOBILE_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  getPluginResourceUrl(): string {
    // Returns an app:// URL pointing to our plugin dist directory,
    // where we copy the .wasm files at build time.
    return this.app.vault.adapter.getResourcePath(
      `${this.manifest.dir}/`,
    );
  }

  /**
   * One-time migration: move skill-source clones from the old global location
   * (~/.claude/skill-sources/<id>) into the vault-local plugin folder
   * (<vault>/.obsidian/plugins/claude-threads/skill-sources/<id>).
   * Safe to call on every load — skips sources whose clonePath already points
   * inside the vault, or whose old path no longer exists.
   */
  private migrateGithubSourcesIntoVault(): void {
    const sources = this.settings.skillSources ?? [];
    const githubSources = sources.filter(s => s.type === 'github' && s.clonePath);
    if (githubSources.length === 0) return;

    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const vaultRoot = adapter.getBasePath();
    const vaultLocal = require('path').join(vaultRoot, this.manifest.dir!, 'skill-sources');
    const fs = require('fs') as typeof import('fs');

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isInsideRoot } = require('./skillPaths') as typeof import('./skillPaths');

    let changed = false;
    for (const source of githubSources) {
      const oldPath = source.clonePath!;
      // Already vault-local — nothing to do. Uses isInsideRoot rather than a
      // bare startsWith, which would also skip a clone in a sibling directory
      // that merely shares the prefix (e.g. "<vaultLocal>-backup/<id>").
      if (isInsideRoot(oldPath, vaultLocal)) continue;
      // Old clone must exist on disk to be moveable
      if (!fs.existsSync(oldPath)) continue;

      const newPath = require('path').join(vaultLocal, source.id);
      try {
        fs.mkdirSync(vaultLocal, { recursive: true });
        fs.renameSync(oldPath, newPath);
        source.clonePath = newPath;
        changed = true;
      } catch (err) {
        console.warn('[ClaudeThreads] skill-source migration failed for', source.name, err);
      }
    }

    if (changed) {
      this.saveSettings().catch(err =>
        console.error('[ClaudeThreads] failed to save settings after skill-source migration', err),
      );
    }
  }

  /**
   * Materialize declared GitHub skill sources that have no clone on disk yet.
   *
   * Until now a source was only ever cloned as a side effect of the "add source"
   * UI action, and nothing checked whether `clonePath` still existed — so a
   * source *declared* in `data.json` (e.g. a vault whose settings are committed
   * to a config repo) was silently dead: its skills never appeared, with no
   * error. This pass closes that gap, and lets a declared source omit both `id`
   * and `clonePath`, which `ensureGithubSourcesCloned` derives.
   *
   * **Call site: `onLayoutReady`, not awaited.** Everything else here runs
   * inline in `onloadDesktop`, but this is the one startup step that touches the
   * network. Awaiting it in the load path would let a slow or unreachable remote
   * hold up plugin load — the plane-mode failure mode — so it is scheduled after
   * layout and deliberately not awaited. `git clone` itself runs via async
   * `execFile`, so it never blocks the main thread either. Scheduling it here
   * (rather than earlier) also guarantees it observes the results of
   * `migrateGithubSourcesIntoVault()` above, which runs synchronously first.
   *
   * Consequence worth knowing: a thread started in the first moments of a
   * first-ever launch may not see a source that is still cloning. The next
   * session picks it up, since skill plugins are rebuilt per session.
   */
  private scheduleGithubSourceClonePass(): void {
    const sources = this.settings.skillSources ?? [];
    if (!sources.some(s => s.type === 'github')) return;

    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter) || !this.manifest?.dir) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pathNode = require('path') as typeof import('path');
    const cloneBase = pathNode.join(adapter.getBasePath(), this.manifest.dir, 'skill-sources');

    this.app.workspace.onLayoutReady(() => {
      void (async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { ensureGithubSourcesCloned } = require('./skillManager') as typeof import('./skillManager');
          const result = await ensureGithubSourcesCloned(sources, cloneBase);
          for (const failure of result.failed) {
            console.warn(
              `[ClaudeThreads] skill source "${failure.name}" could not be cloned — skipping it: ${failure.error}`,
            );
          }
          if (result.cloned.length > 0) {
            const names = result.cloned.map(c => c.name).join(', ');
            new Notice(
              `Cloned ${result.cloned.length} declared skill source${result.cloned.length === 1 ? '' : 's'}: ${names}`,
              8000,
            );
          }
          if (result.changed) await this.saveSettings();
        } catch (err) {
          // Defensive: ensureGithubSourcesCloned isolates per-source failures
          // itself, so reaching here means something unexpected. Still swallowed —
          // no skill-source problem should ever surface as a broken plugin load.
          console.error('[ClaudeThreads] skill-source auto-clone pass failed', err);
        }
      })();
    });
  }

  getEffectiveCwd(): string {
    if (this.settings.defaultCwd) return this.settings.defaultCwd;
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    return '';
  }

  /**
   * Absolute path to the vault-local skills folder
   * (`<vault>/<plugin-dir>/skills`) — the ONLY directory this plugin installs
   * skills into. `~/.claude/skills` is read-only and never a fallback.
   *
   * Returns `''` when it cannot be resolved (mobile, or any adapter that is not
   * a `FileSystemAdapter`). Callers must treat `''` as "installs unavailable"
   * and surface that to the user rather than writing somewhere else.
   *
   * `this.manifest?.dir` is optional-chained because the screenshot harness
   * mounts views against a mock plugin object with no `manifest`.
   */
  /**
   * Surface MCP servers that were refused at session start.
   *
   * Deduped for the life of the plugin load: the server factory runs on every
   * thread start, and a persistent misconfiguration would otherwise fire a
   * Notice every time. Each distinct message is shown once, then only logged.
   */
  private reportMcpWarnings(warnings: string[]): void {
    if (warnings.length === 0) return;
    // Tests build this class without running field initializers.
    this.reportedMcpWarnings ??= new Set<string>();
    for (const warning of warnings) {
      console.warn(`[ClaudeThreads] ${warning}`);
      if (this.reportedMcpWarnings.has(warning)) continue;
      this.reportedMcpWarnings.add(warning);
      new Notice(warning, 10000);
    }
  }

  /**
   * The single MCP-server registration dispatcher, shared by the agent-facing
   * `mcp_register_server` tool (via `onRegisterMcpServer` in the per-thread MCP
   * factory) and the peer-plugin `api.v1.mcp.register` method. Both callers pass
   * through the exact same interactive-confirmation guard and, for `oauth`,
   * the same `OAuthMcpRegistry` consent flow — there is no separate silent path.
   */
  private async registerExternalMcpServer(input: unknown, interactive: boolean): Promise<McpRegistrationResult> {
    const parsed = mcpRegistrationSchema.safeParse(input);
    // The OAuth consent round-trip needs an interactive human even more than a
    // static server registration does, so it shares the exact same guard.
    if (parsed.success && parsed.data.type === 'oauth') {
      if (!interactive) {
        return { success: false, status: 'unavailable', message: 'Interactive host confirmation is unavailable. Register this server from an interactive thread.' };
      }
      if (!this.oauthMcpRegistry) {
        return { success: false, status: 'unavailable', message: 'OAuth MCP registration is unavailable in this context.' };
      }
      const data = parsed.data;
      // Guaranteed non-empty for an oauth entry by mcpRegistrationSchema's superRefine.
      return this.oauthMcpRegistry.registerServer({
        name: data.name,
        url: data.url ?? '',
        scopes: data.scopes,
        tools: data.tools,
        clientId: data.clientId,
        authorizationServerUrl: data.authorizationServerUrl,
        redirectUri: data.redirectUri,
      });
    }
    if (!this.registerMcpServerFn) {
      return { success: false, status: 'unavailable', message: 'MCP registration is unavailable in this context.' };
    }
    return this.registerMcpServerFn(input, interactive);
  }

  /**
   * Shared secret-request dispatcher, used by both the agent-facing
   * `request_secret` tool (`onRequestSecret`) and the peer-plugin
   * `api.v1.mcp.requestSecret` method. Always shows the same host modal.
   */
  private requestSecretFromUser(secretName: string, reason: string, force?: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      new RequestSecretModal(this.app, secretName, reason, async (saved) => {
        if (saved) {
          if (!this.settings.secretEnvKeys.includes(secretName)) {
            this.settings.secretEnvKeys.push(secretName);
            await this.saveSettings();
          }
        }
        resolve(saved);
      }, force).open();
    });
  }

  getPluginSkillsRoot(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return '';
    const dir = this.manifest?.dir;
    if (!dir) return '';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pathNode = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { pluginSkillsRootFrom } = require('./skillPaths') as typeof import('./skillPaths');
    return pluginSkillsRootFrom(pathNode.join(adapter.getBasePath(), dir));
  }

  getLocalSkillsRoot(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return '';
    const { resolveLocalSkillsRoot, externalSkillRoots } = require('./localSkills') as typeof import('./localSkills');
    try { return resolveLocalSkillsRoot(adapter.getBasePath(), this.settings.localSkillsFolder ?? 'Skills', externalSkillRoots(this.settings.skillSources)); }
    catch (error) { console.warn('[ClaudeThreads] Local skills unavailable:', error); return ''; }
  }

  getManagedSkillRoots(): import('./skillPaths').SkillRoots {
    const { getSkillRoots } = require('./skillPaths') as typeof import('./skillPaths');
    return { ...getSkillRoots(), localRoot: this.getLocalSkillsRoot() };
  }

  createLocalSkill(params: import('./localSkills').CreateLocalSkillInput) {
    const { createLocalSkill } = require('./localSkills') as typeof import('./localSkills');
    return createLocalSkill(this.getLocalSkillsRoot(), params);
  }

  updateLocalSkill(params: import('./localSkills').UpdateLocalSkillInput) {
    const { updateLocalSkill } = require('./localSkills') as typeof import('./localSkills');
    return updateLocalSkill(this.getLocalSkillsRoot(), params);
  }

  async setLocalSkillsFolder(folder: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error('Local skills require a desktop filesystem vault.');
    const { resolveLocalSkillsRoot, externalSkillRoots } = require('./localSkills') as typeof import('./localSkills');
    const localRoot = resolveLocalSkillsRoot(adapter.getBasePath(), folder, externalSkillRoots(this.settings.skillSources));
    const previous = this.settings.localSkillsFolder;
    this.settings.localSkillsFolder = folder;
    try { await this.saveSettings(); }
    catch (error) { this.settings.localSkillsFolder = previous; throw error; }
    const { getSkillRoots, setSkillRoots } = require('./skillPaths') as typeof import('./skillPaths');
    setSkillRoots({ ...getSkillRoots(), localRoot });
  }

  /**
   * Pending ScheduleWakeup entries for a thread, soonest-to-fire first. Reads
   * live off the durable Scheduler (schedule.type 'once', origin 'wakeup',
   * targetThreadId === threadId) rather than a separate in-memory registry,
   * so this reflects on-disk state that survives a plugin reload — not a
   * volatile timer list that a restart could silently wipe.
   * Returns an empty array when the thread has none.
   */
  getPendingWakeups(threadId: string): PendingWakeup[] {
    return this.scheduler
      .listItems()
      .filter((i) => i.origin === 'wakeup' && i.enabled && i.targetThreadId === threadId)
      .map((i) => ({ fireAt: i.nextRun ?? Date.now(), reason: i.name.replace(/^Wakeup: /, '') }))
      .sort((a, b) => a.fireAt - b.fireAt);
  }

  /** Whether a thread has at least one scheduled wake-up awaiting fire. */
  hasPendingWakeup(threadId: string): boolean {
    return this.getPendingWakeups(threadId).length > 0;
  }

  /**
   * Cancel all pending wake-ups for a thread (user clicked "Cancel"). Deletes
   * the underlying Scheduler items — removed from disk, not just from
   * memory — and notifies the views so the waiting indicator disappears.
   */
  cancelWakeups(threadId: string): void {
    const items = this.scheduler
      .listItems()
      .filter((i) => i.origin === 'wakeup' && i.enabled && i.targetThreadId === threadId);
    if (items.length === 0) return;
    for (const item of items) {
      this.scheduler.deleteItem(item.id).catch((err) => {
        console.error(`[ClaudeThreads] Failed to cancel wake-up ${item.id} for thread ${threadId}:`, err);
      });
    }
    this.manager.notifyWakeupChanged(threadId);
    debugLog(`[ClaudeThreads] Cancelled ${items.length} pending wake-up(s) for thread ${threadId}`);
  }

  async onunload(): Promise<void> {
    // Revoke peer references before asynchronous shutdown begins. Obsidian does
    // not await plugin onunload hooks, so delaying this would leave a stale
    // generation callable while sessions are draining.
    this.revokePublicApi();

    // Stop scheduler timers FIRST, before anything else — including before the
    // graceful-shutdown wait below. Obsidian's Component.unload() does not await
    // onunload(), so a reload can construct a brand-new Scheduler (with its own
    // armed timers) while this instance is still stuck in the up-to-10s
    // gracefulShutdown wait. If we destroyed the old scheduler only after that
    // wait, both instances' timers would be live simultaneously and could each
    // independently fire the same due item. Destroying synchronously here closes
    // that race window immediately, regardless of how long thread shutdown takes.
    this.scheduler?.destroy();
    // Same reasoning as the scheduler: every agent browser guest is a live
    // renderer process, and this must not wait for the gracefulShutdown poll
    // below. register() already covers the normal unload path; this is the
    // belt-and-braces call for teardown orders that reach onunload() first.
    // destroy() is idempotent, so running twice is free.
    this.agentBrowser?.destroy();
    this.googleWorkspaceMcp?.close();
    this.oauthMcpRegistry?.close();

    // ── Safe-reload guard ────────────────────────────────────────────────────
    // If any agent threads are actively running, interrupt them and wait up to
    // 10 seconds for clean shutdown before forcibly closing sessions.
    // Note: Obsidian's Component.unload() does not await onunload(), so this
    // best-effort wait runs on the microtask queue after Obsidian's own cleanup
    // starts — but sessions receive their interrupt signal synchronously before
    // that, giving them maximum time to shut down cleanly.
    if (this.manager) {
      const runningThreads = this.manager.getRunningThreads();
      if (runningThreads.length > 0) {
        const names = runningThreads.map((t) => `"${t.title}"`).join(', ');
        const s = runningThreads.length === 1 ? '' : 's';
        new Notice(
          `Agent Threads: interrupting ${runningThreads.length} active thread${s} (${names}). Waiting up to 10 s for clean shutdown…`,
          12_000,
        );
        console.warn(`[ClaudeThreads] Plugin unloading with ${runningThreads.length} active thread${s}: ${names}`);
        const { timedOut } = await this.manager.gracefulShutdown(10_000);
        if (timedOut) {
          console.warn('[ClaudeThreads] Graceful shutdown timed out — forcing session close.');
          new Notice('Agent Threads: some threads did not stop in time and were force-closed.', 6_000);
        }
      }
    }

    this.relayClient?.disconnect();
    this.wakeLock?.destroy();
    this.statusLine?.stop();
    this.gitDiff?.stop();
    this.documentWatch?.stop();
    telemetry.dispose();
    this.manager?.destroy();

    // Note: pending ScheduleWakeup entries are now durable Scheduler items
    // (schedule.type 'once', origin 'wakeup') persisted to disk — they must
    // NOT be cancelled/deleted here. this.scheduler.destroy() above already
    // stopped their in-memory timers; the items themselves stay on disk so
    // the next onload() rearms them (or catches them up immediately if their
    // fireAt already passed while the plugin was unloaded/reloaded/asleep).
    // Deleting them here would silently drop wake-ups on every plugin
    // reload — exactly the bug this durability fix removes.

    // Cancel background task poll timers.
    for (const id of this.pendingBgTaskTimers.values()) {
      window.clearTimeout(id);
    }
    this.pendingBgTaskTimers.clear();

    // Persist thread state to data.json
    await this.saveSettings();

    // Also flush all non-archived threads to vault notes so crash recovery
    // always sees fresh content.  The per-event saves (on 'done') are
    // fire-and-forget and may not complete before the plugin unloads; this
    // catch-all guarantees vault notes are consistent with data.json.
    if (this.persistence && this.settings.saveThreadsToVault && this.manager) {
      const threads = this.manager.getThreads().filter((t) => t.status !== 'archived');
      await Promise.all(threads.map((t) => this.persistence!.saveThread(t).catch(console.error)));
    }
  }

  initializePublicApi(): void {
    this.revokePublicApi();
    const service = createClaudeThreadsApiV1({
      getThreads: () => this.manager.getThreads(),
      getThread: (id) => this.manager.getThread(id),
      isRunning: (id) => this.manager.isRunning(id),
      createThread: async (input: CreateThreadInput) => {
        const project = input.projectId ? this.manager.getProject(input.projectId) : undefined;
        if (input.projectId && !project) throw new Error(`Project not found: ${input.projectId}`);
        const cwd = input.cwd ?? (project ? this.manager.getProjectCwd(project) : this.getEffectiveCwd());
        const thread = this.manager.createThread(input.title?.trim() || 'New Thread', cwd, project?.id, input.agentHarness, {
          origin: input.origin, externalJobId: input.externalJobId, ephemeral: input.ephemeral, background: input.background,
        });
        await this.saveSettings();
        return thread;
      },
      sendMessage: (id, prompt) => this.manager.sendMessage(id, prompt),
      interruptThread: (id) => this.manager.interrupt(id),
      getTraceMetadata: (id) => this.manager.getRawLogTraceMetadata(id),
      readTraceChunk: (id, options) => this.manager.readRawLogTraceChunk(id, options),
      getRegisteredSkillNames: async () => {
        const { listInstalledSkills } = require('./skillManager') as typeof import('./skillManager');
        return (await listInstalledSkills(this.settings.skillSources ?? [])).map(skill => skill.name);
      },
      getRedactionSecrets: () => this.collectSecretValues(),
      getPublicState: () => this.settings.publicApiState,
      savePublicState: async (state) => { this.settings.publicApiState = state; await this.saveSettings(); },
      runConstrainedQuery: createConstrainedQueryRunner(() => this.settings, undefined, () => this.manager.secretEnvResolver?.() ?? {}),
      openThread: (id) => this.openThreadInChatView(id),
      subscribe: (listener) => this.manager.subscribe(listener),
      listOrchestrators: () => this.listPublicOrchestrators(),
      resolveOrchestrator: (target) => this.resolvePublicOrchestrator(target),
      triggerHostEvent: (name, payload) => {
        const workspace = this.app.workspace as unknown as { trigger(event: string, payload: unknown): void };
        workspace.trigger(name, payload);
      },
      // Peer-plugin calls have no calling thread or scheduled-item concept, so
      // "interactive" here is just "is the plugin still loaded" — never gated on
      // thread state the way the agent-tool path is. The confirmation modal (or,
      // for oauth, the OAuthMcpRegistry consent flow) is still always shown;
      // see registerExternalMcpServer.
      registerMcpServer: (input) => this.registerExternalMcpServer(input, this.mcpRegistrationAvailable),
      requestSecret: (secretName, reason, force) => this.requestSecretFromUser(secretName, reason, force),
      hasSecret: (name) => !!this.app.secretStorage.getSecret(secretStorageKey(name)),
      artifactProviders: this.artifactProviders,
    });
    this.publicApiService = service;
    this.api = Object.freeze({ v1: service.api });
    service.start();
    // Built-in Design is the reference consumer of the contribution API: it
    // takes the same public path, with the same peer identity, that a
    // third-party plugin would. Nothing pre-seeds the registry.
    const registration = service.api.extensions.registerArtifactProvider(
      DESIGN_PROVIDER_OWNER,
      createDesignArtifactContribution(),
    );
    if (!registration.success) {
      console.error(`[ClaudeThreads] Built-in design artifact provider was refused: ${registration.message}`);
    }
  }

  revokePublicApi(): void {
    this.publicApiService?.stop();
    this.publicApiService = undefined;
  }

  private listPublicOrchestrators(): OrchestratorSnapshot[] {
    const result: OrchestratorSnapshot[] = [];
    const portfolioId = this.settings.orchestratorThreadId;
    const portfolio = portfolioId ? this.manager.getThread(portfolioId) : undefined;
    if (portfolio) result.push({ id: 'portfolio', kind: 'portfolio', threadId: portfolio.id, title: portfolio.title });
    for (const project of this.manager.getProjects()) {
      const thread = project.orchestratorThreadId ? this.manager.getThread(project.orchestratorThreadId) : undefined;
      if (thread) result.push({ id: `project:${project.id}`, kind: 'project', projectId: project.id, threadId: thread.id, title: thread.title });
    }
    return result;
  }

  private async resolvePublicOrchestrator(target: OrchestratorTarget): Promise<string | null> {
    if (target.id === 'portfolio') {
      await this.ensureOrchestratorThread();
      return this.settings.orchestratorThreadId ?? null;
    }
    if (!target.id.startsWith('project:')) return null;
    const projectId = target.id.slice('project:'.length);
    if (!projectId || !this.manager.getProject(projectId)) return null;
    return (await this.ensureProjectOrchestratorThread(projectId, false)) ?? null;
  }

  // ── Auto-archive idle threads ────────────────────────────────────────────────

  /**
   * The single archive eviction path, shared by the manual `archiveThread` MCP
   * handler and the automatic idle sweep so there is exactly one implementation.
   * Writes the thread to its markdown note (when vault persistence is on), then
   * removes it from the live thread map so it stops being serialized into
   * data.json. Does NOT call saveSettings. Each caller persists once (the sweep
   * saves once after its whole loop rather than per thread).
   */
  async archiveThreadById(id: string, onlyIfHasMessages = false): Promise<void> {
    const thread = this.manager.getThread(id);
    if (!thread) throw new Error(`Thread not found: ${id}`);
    const originalSnapshot = { ...thread };
    const project = this.manager.getProjects().find(candidate => candidate.orchestratorThreadId === id);
    const priorProjectEnabled = project?.orchestratorEnabled;
    if (project) {
      // This must happen before vault persistence: that write is asynchronous,
      // and a completion notification may otherwise recreate the orchestrator.
      this.manager.updateProject(project.id, { orchestratorEnabled: false, orchestratorThreadId: undefined });
      this.orchestratorWakeup?.invalidateBucket(`project:${project.id}`);
    }
    const shouldPersist = !onlyIfHasMessages || thread.messages.some(message => message.role !== 'compact' && message.role !== 'notice');
    const persistedArchive = shouldPersist && this.settings.saveThreadsToVault && this.persistence;
    if (persistedArchive) {
      try {
        await this.persistence!.saveThread({ ...originalSnapshot, status: 'archived' });
      } catch (error) {
        if (project) this.manager.updateProject(project.id, { orchestratorEnabled: priorProjectEnabled ?? true, orchestratorThreadId: id });
        throw error;
      }
    }
    try {
      await this.retireOrchestratorThread(id, project ? { projectId: project.id, priorEnabled: priorProjectEnabled ?? true } : undefined);
    } catch (error) {
      if (persistedArchive) await this.persistence!.saveThread(originalSnapshot).catch(rollbackError => {
        console.error('[ClaudeThreads] Failed to restore live thread note after orchestrator retirement failure:', rollbackError);
      });
      throw error;
    }
    this.manager.deleteThread(id);
  }

  async retireOrchestratorThread(
    threadId: string,
    prepared?: { projectId: string; priorEnabled: boolean },
  ): Promise<void> {
    const project = prepared
      ? this.manager.getProject(prepared.projectId)
      : this.manager.getProjects().find(candidate => candidate.orchestratorThreadId === threadId);
    const isPortfolio = this.settings.orchestratorThreadId === threadId;
    if (!project && !isPortfolio) return;
    const heartbeats = (this.settings.scheduledItems ?? []).filter(item => item.isOrchestratorHeartbeat && item.targetThreadId === threadId);
    const deleted: ScheduledItem[] = [];
    const wasProjectEnabled = prepared?.priorEnabled ?? project?.orchestratorEnabled;
    if (project && !prepared) {
      // Disable and invalidate synchronously so no debounce or in-flight target
      // resolution can recreate/message this orchestrator while cleanup awaits.
      this.manager.updateProject(project.id, { orchestratorEnabled: false, orchestratorThreadId: undefined });
      this.orchestratorWakeup?.invalidateBucket(`project:${project.id}`);
    }
    try {
      for (const item of heartbeats) {
        await this.scheduler.deleteItem(item.id);
        deleted.push(item);
      }
      if (!project) this.settings.orchestratorThreadId = undefined;
      await this.saveSettings();
    } catch (error) {
      if (project) this.manager.updateProject(project.id, { orchestratorEnabled: wasProjectEnabled ?? true, orchestratorThreadId: threadId });
      else this.settings.orchestratorThreadId = threadId;
      for (const item of deleted) await this.scheduler.createItem(item).catch(console.error);
      throw error;
    }
  }

  /**
   * Archive threads that have sat idle in the `waiting` state past
   * `autoArchiveIdleDays`. Reuses `archiveThreadById` (the manual-archive path)
   * so archived threads are written to their note with images embedded and then
   * evicted from data.json. Runs once at startup and on a 6-hour interval.
   *
   * No-ops on mobile (no `manager`) or when the setting is `0`/falsy. Selection
   * is delegated to the pure predicate in autoArchive.ts, which also excludes the
   * orchestrator thread and any thread with a pending plan/question.
   */
  async sweepIdleThreads(): Promise<void> {
    if (!this.manager) return;
    const days = this.settings.autoArchiveIdleDays;
    if (!days || days <= 0) return;

    const candidates = selectIdleThreadsForArchive(this.manager.getThreads(), {
      autoArchiveIdleDays: days,
      now: Date.now(),
      orchestratorThreadId: this.settings.orchestratorThreadId,
      orchestratorThreadIds: [this.settings.orchestratorThreadId, ...this.manager.getProjects().map(project => project.orchestratorThreadId)].filter((id): id is string => !!id),
    });
    if (candidates.length === 0) return;

    let archived = 0;
    for (const thread of candidates) {
      try {
        await this.archiveThreadById(thread.id);
        archived++;
      } catch (err) {
        console.error(`[ClaudeThreads] Auto-archive failed for thread ${thread.id}:`, err);
      }
    }
    if (archived > 0) {
      console.log(`[ClaudeThreads] Auto-archived ${archived} idle thread(s) (idle > ${days}d)`);
      await this.saveSettings();
    }
  }

  // ── Background task monitoring ───────────────────────────────────────────────

  /**
   * Schedule a poll for pending background tasks. Fires after BG_TASK_POLL_INTERVAL_MS,
   * then resumes the thread with a lightweight monitor prompt that asks Claude to check
   * task status via TaskOutput/Monitor and report or re-schedule as needed.
   *
   * Only one timer is active per thread at a time. If a timer already exists it is
   * cancelled before the new one is registered.
   */
  private scheduleBgTaskPoll(threadId: string, tasks: import('./types').PendingBackgroundTask[]): void {
    this.cancelBgTaskPoll(threadId);

    // Filter to tasks that haven't exceeded the poll limit.
    const activeTasks = tasks.filter(t => t.pollCount < ClaudeThreadsPlugin.BG_TASK_MAX_POLLS);
    if (activeTasks.length === 0) {
      console.warn(`[ClaudeThreads] Background task polling gave up for thread ${threadId} after ${ClaudeThreadsPlugin.BG_TASK_MAX_POLLS} attempts`);
      new Notice(
        `Background task check timed out after ${ClaudeThreadsPlugin.BG_TASK_MAX_POLLS} attempts. Resume the thread manually to check status.`,
        10_000,
      );
      this.manager.clearAllPendingBackgroundTasks(threadId);
      this.saveSettings().catch(console.error);
      return;
    }

    const elapsed = (taskMs: number) => {
      const secs = Math.round((Date.now() - taskMs) / 1000);
      return secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`;
    };
    const taskList = activeTasks
      .map(t => `- ${t.description} (running for ${elapsed(t.startedAt)})`)
      .join('\n');
    const pollPrompt =
      `[Background Monitor] The following background task(s) were started in this session and ` +
      `may still be running:\n${taskList}\n\n` +
      `Please check each task's status using TaskOutput or Monitor. ` +
      `If a task has completed or failed, report the result. ` +
      `If tasks are still running, use ScheduleWakeup to check again in 30 seconds.`;

    const id = window.setTimeout(async () => {
      this.pendingBgTaskTimers.delete(threadId);
      try {
        if (!this.manager.getThread(threadId)) {
          debugLog(`[ClaudeThreads] Bg task poll skipped — thread ${threadId} no longer exists`);
          return;
        }
        this.manager.incrementPendingTaskPollCount(threadId);
        await this.manager.sendMessage(threadId, pollPrompt);
      } catch (err) {
        console.error(`[ClaudeThreads] Background task poll failed for thread ${threadId}:`, err);
      }
    }, ClaudeThreadsPlugin.BG_TASK_POLL_INTERVAL_MS) as unknown as number;

    this.pendingBgTaskTimers.set(threadId, id);
    debugLog(
      `[ClaudeThreads] Background task poll scheduled for thread ${threadId} ` +
      `in ${ClaudeThreadsPlugin.BG_TASK_POLL_INTERVAL_MS / 1000}s (${activeTasks.length} task(s))`,
    );
  }

  private cancelBgTaskPoll(threadId: string): void {
    const id = this.pendingBgTaskTimers.get(threadId);
    if (id !== undefined) {
      window.clearTimeout(id);
      this.pendingBgTaskTimers.delete(threadId);
    }
  }

  private detectClaudeBinary(): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    if (this.settings.claudeBinaryPath && fs.existsSync(this.settings.claudeBinaryPath)) {
      return;
    }
    const candidates = [
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      `${process.env.HOME}/.local/bin/claude`,
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        this.settings.claudeBinaryPath = p;
        return;
      }
    }
    console.warn('[Agent Threads] claude binary not found, using "claude" from PATH');
    this.settings.claudeBinaryPath = 'claude';
  }

  private detectCodexBinary(): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    if (this.settings.codexBinaryPath && fs.existsSync(this.settings.codexBinaryPath)) return;
    for (const candidate of [
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      `${process.env.HOME}/.local/bin/codex`,
    ]) {
      if (fs.existsSync(candidate)) {
        this.settings.codexBinaryPath = candidate;
        return;
      }
    }
    // `codex` on PATH is the CLI's documented/default invocation.
    this.settings.codexBinaryPath = 'codex';
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | undefined;
    if (this.isConversationFirst()) {
      // Loaded lazily with the desktop view modules; mobile never reaches here.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const {
        activateConversationFirstChat,
        planConversationFirstChat,
      } = require('./conversationFirstPlacement') as typeof import('./conversationFirstPlacement');
      const plan = planConversationFirstChat(workspace.getLeavesOfType(VIEW_TYPE));
      leaf = await activateConversationFirstChat(
        plan,
        () => workspace.getLeaf('tab'),
        VIEW_TYPE,
      );
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { planClassicChat } = require('./conversationFirstPlacement') as typeof import('./conversationFirstPlacement');
      const chatLeaves = workspace.getLeavesOfType(VIEW_TYPE);
      const plan = planClassicChat(chatLeaves);
      leaf = plan.keep ?? undefined;
      if (leaf) {
        for (const duplicate of plan.detach) duplicate.detach();
      } else if (chatLeaves.length > 0) {
        const { activateChatPlacement } = require('./conversationFirstPlacement') as typeof import('./conversationFirstPlacement');
        leaf = await activateChatPlacement(plan, () => workspace.getRightLeaf(true), VIEW_TYPE, 'classic');
      } else {
        leaf = workspace.getRightLeaf(false) as WorkspaceLeaf;
        await leaf.setViewState({ type: VIEW_TYPE, active: true, state: { conversationPlacement: 'classic' } });
      }
    }
    workspace.revealLeaf(leaf);
  }

  isConversationFirst(): boolean {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isConversationFirstPlacement } = require('./conversationFirstPlacement') as typeof import('./conversationFirstPlacement');
    return isConversationFirstPlacement(this.settings.threadViewPlacement, Platform.isMobile);
  }

  /**
   * Stored secret values, for redaction and for refusing to type a credential
   * into a web page. Synchronous because `secretStorage.getSecret` is.
   */
  collectSecretValues(): string[] {
    return [
      ...(this.settings.secretEnvKeys ?? []).map((name) => this.app.secretStorage.getSecret(secretStorageKey(name))),
      ...Object.entries(parseExtraEnv(effectiveExtraEnv(this.settings)))
        .filter(([name]) => /(?:token|secret|key|password)/i.test(name))
        .map(([, value]) => value),
    ].filter((value): value is string => Boolean(value));
  }

  /**
   * Per-thread handle on the agent browser.
   *
   * Built fresh for each MCP session rather than cached on the plugin: element
   * refs belong to a page and a snapshot generation, so a restarted session
   * starting without them is correct — it forces a fresh snapshot instead of
   * letting the agent act on refs whose page may have changed underneath it.
   */
  private createThreadBrowser(threadId: string): import('./agentBrowser/ThreadBrowser').ThreadBrowser | undefined {
    if (!this.agentBrowser) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ThreadBrowser } = require('./agentBrowser/ThreadBrowser') as typeof import('./agentBrowser/ThreadBrowser');
    return new ThreadBrowser({
      threadId,
      pool: this.agentBrowser,
      getSecrets: () => this.collectSecretValues(),
    });
  }

  async activateAgentView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(AGENT_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) as WorkspaceLeaf;
      await leaf.setViewState({ type: AGENT_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async activateKanbanView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(KANBAN_VIEW_TYPE)[0];
    if (!leaf) {
      // Open kanban as a new tab in the main area (it's a wide board)
      leaf = workspace.getLeaf('tab') as WorkspaceLeaf;
      await leaf.setViewState({ type: KANBAN_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async activateSkillsView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(SKILLS_VIEW_TYPE)[0];
    if (!leaf) {
      // In conversation-first mode the main area holds the conversation, so
      // route to the right sidebar like activateAgentView(). In classic mode
      // the main area is free for editing, so a tab still makes sense.
      leaf = (this.isConversationFirst() ? workspace.getRightLeaf(false) : workspace.getLeaf('tab')) as WorkspaceLeaf;
      await leaf.setViewState({ type: SKILLS_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  /**
   * Show the agent browser preview, in the right sidebar.
   *
   * Always a sidebar leaf rather than a main-area tab: this is something you
   * glance at while the agent works, and putting it in the main area would mean
   * it competes with the conversation for the space you are actually reading.
   */
  async activateAgentBrowserView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(AGENT_BROWSER_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) as WorkspaceLeaf;
      await leaf.setViewState({ type: AGENT_BROWSER_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async openThreadInChatView(threadId: string): Promise<void> {
    await this.activateView();
    const view = this.getView();
    await view?.focusThread(threadId);
  }

  async openAgentTeamInChatView(threadId: string): Promise<void> {
    await this.openThreadInChatView(threadId);
    this.getView()?.openAgentTeamPicker();
  }

  /**
   * Creates the persistent thread-orchestrator thread if none is set yet (or if
   * the previously stored one no longer exists), then opens it. Also ensures a
   * 60-minute heartbeat cron item targets it — a resilience backstop for the
   * event-driven wake-up subscriber below, not the primary trigger.
   */
  async ensureOrchestratorThread(): Promise<void> {
    const staleThreadId = this.settings.orchestratorThreadId;
    let threadId = staleThreadId;
    if (!threadId || !this.manager.getThread(threadId)) {
      const thread = this.manager.createThread('Portfolio Orchestrator', this.getEffectiveCwd());
      threadId = thread.id;
      this.settings.orchestratorThreadId = threadId;
      await this.saveSettings();

      // Clean up any heartbeat items still targeting the stale/orphaned
      // orchestrator thread (e.g. it was deleted/archived out from under us)
      // so they don't keep firing into a thread that no longer exists.
      if (staleThreadId) {
        const stale = (this.settings.scheduledItems ?? [])
          .filter((item) => item.isOrchestratorHeartbeat && item.targetThreadId === staleThreadId);
        for (const item of stale) await this.scheduler.deleteItem(item.id);
      }
    }

    // Idempotent: only create the heartbeat once per orchestrator thread.
    const hasHeartbeat = (this.settings.scheduledItems ?? []).some(
      (item) => item.targetThreadId === threadId,
    );
    if (!hasHeartbeat) {
      this.scheduler.createItem({
        name: 'Portfolio Orchestrator Heartbeat',
        prompt: 'Heartbeat: reconcile activity missed by targeted event reviews across all threads. Do not reopen concluded work whose updatedAt is unchanged.',
        schedule: { type: 'interval', intervalSeconds: 3600 },
        enabled: true,
        targetThreadId: threadId,
        isOrchestratorHeartbeat: true,
      });
    }

    await this.openThreadInChatView(threadId);
  }

  async ensureProjectOrchestratorThread(
    projectId: string,
    open = true,
    isCurrent: () => boolean = () => true,
  ): Promise<string | undefined> {
    const project = this.manager.getProject(projectId);
    if (!project) return undefined;
    if (open && project.orchestratorEnabled === false) {
      this.manager.updateProject(projectId, { orchestratorEnabled: true });
      await this.saveSettings();
    } else if (!open && project.orchestratorEnabled === false) {
      return undefined;
    }
    if (!isCurrent()) return undefined;
    let threadId = project.orchestratorThreadId;
    if (!threadId || !this.manager.getThread(threadId)?.projectId || this.manager.getThread(threadId)?.projectId !== projectId) {
      const thread = this.manager.createThread(
        `${project.name} Orchestrator`,
        this.manager.getProjectCwd(project),
        projectId,
        this.settings.agentHarness,
      );
      threadId = thread.id;
      this.manager.updateProject(projectId, { orchestratorThreadId: threadId });
      await this.saveSettings();
      if (!isCurrent()) return undefined;
    }
    const hasHeartbeat = (this.settings.scheduledItems ?? []).some(item => item.isOrchestratorHeartbeat && item.targetThreadId === threadId);
    if (!hasHeartbeat) {
      if (!isCurrent()) return undefined;
      await this.scheduler.createItem({
        name: `${project.name} Orchestrator Heartbeat`,
        prompt: 'Heartbeat: reconcile Project activity missed by targeted event reviews. Do not reopen concluded work whose updatedAt is unchanged.',
        schedule: { type: 'interval', intervalSeconds: 3600 },
        enabled: true,
        targetThreadId: threadId,
        projectId,
        isOrchestratorHeartbeat: true,
      });
    }
    if (open) await this.openThreadInChatView(threadId);
    return threadId;
  }

  async deleteProject(projectId: string): Promise<void> {
    const project = this.manager.getProject(projectId);
    if (!project) return;
    const effectiveCwd = this.manager.getProjectCwd(project);
    await this.scheduler.detachProject(projectId, effectiveCwd);
    this.manager.deleteProject(projectId);
    this.settings.secretEnvScopes = pruneSecretEnvScopesForProject(this.settings.secretEnvScopes, projectId);
    await this.saveSettings();
  }

  async dispatchNewThread(
    text: string,
    images?: ImageAttachment[],
    titleHint?: string,
    opts?: {
      /** Model override applied before the first message (/model prefix). */
      model?: string;
      /** Persistent goal set on the new thread (/goal prefix). */
      goal?: string;
      /** Recurring loop registered on the new thread (/loop prefix). The
       * loop re-sends `text` every intervalSeconds; the first iteration is
       * the dispatch itself. */
      loop?: { intervalSeconds: number };
      /** Harness override selected at kickoff; does not change Settings. */
      agentHarness?: 'claude' | 'codex';
      /** Project selected by a dispatch surface. Omit for deliberate Unassigned. */
      projectId?: string;
    },
  ): Promise<string> {
    const rawTitle = titleHint ?? text;
    const title = rawTitle.trim()
      ? rawTitle.slice(0, 50).split('\n')[0].trim()
      : (images && images.length > 0 ? `Image task (${images.length} image${images.length > 1 ? 's' : ''})` : 'New Thread');
    const project = opts?.projectId ? this.manager.getProject(opts.projectId) : undefined;
    if (opts?.projectId && !project) throw new Error(`Project not found: ${opts.projectId}`);
    const cwd = project ? this.manager.getProjectCwd(project) : this.getEffectiveCwd();
    const thread = this.manager.createThread(title, cwd, project?.id, opts?.agentHarness);
    if (opts?.model) this.manager.setThreadModel(thread.id, opts.model);
    const goalRevision = opts?.goal ? this.manager.setThreadGoal(thread.id, opts.goal) : undefined;
    if (opts?.loop) {
      await this.scheduler.createItem({
        name: `Loop: ${text.slice(0, 40)}`,
        prompt: text,
        schedule: { type: 'interval', intervalSeconds: opts.loop.intervalSeconds },
        enabled: true,
        cwd: thread.cwd,
        projectId: thread.projectId,
        targetThreadId: thread.id,
      });
    }
    await this.saveSettings();
    if (goalRevision !== undefined) this.manager.commitThreadGoal(thread.id, goalRevision);
    // Fire and forget — dashboard will show the running row via subscription
    this.manager.sendMessage(thread.id, text, images).catch(console.error);
    return thread.id;
  }

  /** Caller-bound design entry; the composer shares preparation but owns its next turn. */
  async enterDesignMode(threadId: string, brief: string, fromComposer = false): Promise<import('./designArtifact').DesignModeResult> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error('Design artifacts require a desktop vault with local filesystem access.');
    }
    const { enterDesignMode, assertDesignWriteAllowed } = await import('./designArtifact');
    return enterDesignMode(threadId, adapter.getBasePath(), brief, {
      getThread: id => this.manager.getThread(id),
      assertWritable: thread => {
        if (!fromComposer) assertDesignWriteAllowed(thread, this.settings.permissionMode);
      },
      saveSettings: () => this.saveSettings(),
      openThread: id => this.openThreadInChatView(id),
      openPreview: async artifact => {
        const view = this.getView();
        if (!view) throw new Error('Agent Threads view is unavailable.');
        view.refreshArtifactCard();
        const preview = await previewDesignArtifact(artifact, view.artifactActionHost(threadId, toArtifactRef(artifact)));
        if (preview.status !== 'opened') new Notice(preview.warning);
        return preview;
      },
    });
  }

  /**
   * Creates (or re-enables) a watch on `path`, owned by `threadId`. Resolves
   * the path the same way `obsidian_navigate_to_file` does. Primes the
   * watch's change-detection stamp immediately so watching itself never
   * counts as a change. Single source of truth for the watch_document MCP
   * tool and the "Watch with active thread" menu item.
   */
  async watchDocument(threadId: string, path: string): Promise<{ id: string; path: string }> {
    const abstract = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(abstract instanceof TFile)) throw new Error(`File not found: ${path}`);

    const existing = this.settings.watchedDocuments.find(
      (w) => w.threadId === threadId && w.path === abstract.path,
    );
    if (existing) {
      existing.enabled = true;
      this.documentWatch?.primeWatch(existing);
      await this.saveSettings();
      return { id: existing.id, path: existing.path };
    }

    const watch: WatchedDocument = {
      id: crypto.randomUUID(),
      path: abstract.path,
      threadId,
      enabled: true,
      createdAt: Date.now(),
    };
    this.documentWatch?.primeWatch(watch);
    this.settings.watchedDocuments.push(watch);
    await this.saveSettings();
    return { id: watch.id, path: watch.path };
  }

  /**
   * Removes `threadId`'s own watch(es) matching `path` and/or `id`. Never
   * removes a watch owned by another thread on the same path. Single source
   * of truth for the unwatch_document MCP tool, the settings tab's unwatch
   * button, and the "Stop watching this document" menu item.
   */
  async unwatchDocument(threadId: string, opts: { path?: string; id?: string }): Promise<{ removed: number }> {
    const normalizedPath = opts.path ? normalizePath(opts.path) : undefined;
    const before = this.settings.watchedDocuments.length;
    this.settings.watchedDocuments = this.settings.watchedDocuments.filter((w) => {
      if (w.threadId !== threadId) return true;
      if (opts.id && w.id === opts.id) return false;
      if (normalizedPath && w.path === normalizedPath) return false;
      return true;
    });
    const removed = before - this.settings.watchedDocuments.length;
    if (removed > 0) await this.saveSettings();
    return { removed };
  }

  /** Returns `threadId`'s own watched documents. */
  listWatchedDocuments(threadId: string): Array<{ id: string; path: string; createdAt: number; lastAlertedAt?: number }> {
    return this.settings.watchedDocuments
      .filter((w) => w.threadId === threadId)
      .map(({ id, path, createdAt, lastAlertedAt }) => ({ id, path, createdAt, lastAlertedAt }));
  }

  /** Creates a new thread whose first turn uses the native static-artifact workflow. */
  async dispatchNewDesignThread(brief: string, agentHarness?: 'claude' | 'codex'): Promise<string> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error('Design artifacts require a desktop vault with local filesystem access.');
    }

    const { dispatchDesignThread } = require('./designArtifact') as typeof import('./designArtifact');
    // The dispatch owns thread creation, so the artifact host below can only
    // be bound to the new thread once it exists.
    let dispatchedThreadId = '';
    return dispatchDesignThread(
      brief,
      agentHarness,
      adapter.getBasePath(),
      {
        createThread: (title, harness) => {
          const thread = this.manager.createThread(title, this.getEffectiveCwd(), undefined, harness);
          dispatchedThreadId = thread.id;
          return thread;
        },
        deleteThread: (threadId) => this.manager.deleteThread(threadId),
        getActiveThreadId: () => this.getActiveThreadId(),
        restoreActiveThread: async (threadId) => {
          const view = this.getView();
          if (view) await view.restoreThreadSelection(threadId);
        },
        saveSettings: () => this.saveSettings(),
        sendMessage: (threadId, message) => this.manager.sendMessage(threadId, message),
        openThread: (threadId) => this.openThreadInChatView(threadId),
        openPreview: async (artifact) => {
          const view = this.getView();
          if (!view) throw new Error('Agent Threads view is unavailable.');
          const preview = await previewDesignArtifact(
            artifact,
            view.artifactActionHost(dispatchedThreadId, toArtifactRef(artifact)),
          );
          if (preview.status !== 'opened') new Notice(preview.warning);
        },
        onSendError: (error) => {
          const message = error instanceof Error ? error.message : String(error);
          new Notice(`Failed to start design turn: ${message}`);
        },
      },
    );
  }

  getActiveThreadId(): string | null {
    return this.getView()?.getActiveThreadId() ?? null;
  }

  getView(): ThreadsView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const view = leaf?.view;
    // Guard against half-initialised or mismatched view objects (can occur during
    // workspace restore when the leaf exists but the view class hasn't fully loaded).
    if (!view || typeof (view as any).getActiveThreadId !== 'function') return null;
    return view as ThreadsView;
  }

  /** Add the shared "Chat about this document" item to a context menu. */
  private addDocumentChatMenuItem(menu: Menu, file: TFile): void {
    menu.addItem(item => item
      .setTitle(DOCUMENT_CHAT_LABEL)
      .setIcon('message-square')
      .onClick(() => { void this.startDocumentChat(file); }));
  }

  /**
   * Single handler behind all three "Chat about this document" entry points:
   * open the Agents List and seed its dispatch composer with an `@[[doc]]`
   * mention. Submitting the composer is what creates the new thread, so the
   * user gets to type the actual question first.
   */
  async startDocumentChat(file: TFile): Promise<void> {
    await this.activateAgentView();
    const dashboard = this.getAgentDashboard();
    if (!dashboard) {
      new Notice('Could not open the Agents List to chat about this document.');
      return;
    }
    dashboard.seedDocumentChat(file.basename);
  }

  /**
   * Host adapter for the Compass "Send to Agent" receiver.
   *
   * Built per event rather than cached so it always reads current plugin state
   * (`this.manager` is assigned partway through `onloadDesktop`).
   *
   * Surfacing goes through `openThreadInChatView` — the same path the
   * orchestrator threads, the design flow and the dashboard's triage jump all
   * use — rather than `contextPanel`. `contextPanel` owns a *companion* leaf
   * that renders a file or a webviewer URL beside an already-open chat leaf; it
   * has no way to display a thread, and it throws outright when chat isn't
   * open. Handing it a thread id would be a new code path, not the existing one.
   */
  private compassHandoffHost(): HandoffHost {
    return {
      isReady: () => !!this.manager,
      dispatchThread: (prompt, titleHint) => this.dispatchNewThread(prompt, undefined, titleHint),
      surfaceThread: (threadId) => this.openThreadInChatView(threadId),
      notify: (message) => { new Notice(message); },
    };
  }

  getAgentDashboard(): AgentDashboard | null {
    const leaf = this.app.workspace.getLeavesOfType(AGENT_VIEW_TYPE)[0];
    const view = leaf?.view;
    if (!view || typeof (view as any).focusDispatchInput !== 'function') return null;
    return view as AgentDashboard;
  }

  /** Add the shared "Watch with active thread" / "Stop watching this document" item to a context menu. */
  private addDocumentWatchMenuItem(menu: Menu, file: TFile): void {
    const activeThreadId = this.getActiveThreadId();
    const isCurrentlyWatched = !!activeThreadId && this.settings.watchedDocuments.some(
      (w) => w.threadId === activeThreadId && w.path === file.path && w.enabled,
    );
    menu.addItem(item => item
      .setTitle(watchMenuLabel(isCurrentlyWatched))
      .setIcon(isCurrentlyWatched ? 'eye-off' : 'eye')
      .onClick(() => { void this.toggleDocumentWatch(file); }));
  }

  /**
   * Single handler behind all three "Watch with active thread" entry points.
   * Unlike "Chat about this document" (which always starts a new thread),
   * a watch needs an existing thread to own its alerts — there's no draft to
   * seed and submit later, so a missing active thread is a Notice, not a
   * new-thread dispatch.
   */
  async toggleDocumentWatch(file: TFile): Promise<void> {
    const threadId = this.getActiveThreadId();
    if (!threadId) {
      new Notice('Open or start a thread first to watch this document.');
      return;
    }
    const existing = this.settings.watchedDocuments.find(
      (w) => w.threadId === threadId && w.path === file.path && w.enabled,
    );
    if (existing) {
      await this.unwatchDocument(threadId, { id: existing.id });
      new Notice(`Stopped watching "${file.basename}".`);
    } else {
      await this.watchDocument(threadId, file.path);
      new Notice(`Watching "${file.basename}" — this thread will be alerted on changes.`);
    }
  }

  /**
   * Assemble the local-only, redacted diagnostics bundle, copy the markdown to the
   * clipboard, and save both .md + .json into `agent-threads-diagnostics/` in the
   * vault root. Desktop-only; on mobile it shows a "desktop only" Notice and returns.
   * All host/OS access is behind the desktop guard + lazy require (mobile-safe).
   */
  async runDiagnosticsReport(): Promise<void> {
    if (Platform.isMobile) {
      new Notice('Diagnostics report is desktop only.');
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const os = require('os') as typeof import('os');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs') as typeof import('fs');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pathMod = require('path') as typeof import('path');

      const snap = telemetry.snapshot();

      // data.json size (best-effort; only meaningful off a real filesystem).
      let dataJsonSize = 0;
      try {
        const adapter = this.app.vault.adapter;
        if (adapter instanceof FileSystemAdapter) {
          const dataPath = pathMod.join(adapter.getBasePath(), this.manifest.dir!, 'data.json');
          dataJsonSize = fs.statSync(dataPath).size;
        }
      } catch {
        /* best-effort */
      }

      const total = this.manager ? this.manager.getThreads().length : 0;
      const running = this.manager ? this.manager.getRunningThreads().length : 0;

      // Host detection: Geode exposes window.geode; otherwise assume Obsidian.
      const hostApp = detectHostName(window as unknown as { geode?: unknown }).toLowerCase();
      const hostVersion =
        (this.app as unknown as { appVersion?: string }).appVersion ??
        (globalThis as unknown as { apiVersion?: string }).apiVersion ??
        '';

      const input: DiagnosticsInput = {
        pluginVersion: this.manifest.version,
        host: {
          app: hostApp,
          version: String(hostVersion),
          platform: process.platform,
          arch: process.arch,
        },
        system: {
          cpuCount: os.cpus().length,
          totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
          loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
        },
        vault: {
          fileCount: this.app.vault.getFiles().length,
          dataJsonSizeBytes: dataJsonSize,
        },
        threads: { total, running },
        counters: snap.counters,
        perfSamples: snap.perfSamples,
        longtask: snap.longtask,
        logEntries: getLogRing(200),
        homedir: os.homedir(),
        generatedAt: Date.now(),
      };

      const { markdown, json } = buildDiagnosticsReport(input);

      // Save .md + .json to agent-threads-diagnostics/ in the vault root.
      const folder = DIAGNOSTICS_FOLDER;
      if (!this.app.vault.getAbstractFileByPath(folder)) {
        await this.app.vault.createFolder(folder).catch(() => {});
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const mdPath = `${folder}/diagnostics-${stamp}.md`;
      const jsonPath = `${folder}/diagnostics-${stamp}.json`;
      await this.app.vault.create(mdPath, markdown);
      await this.app.vault.create(jsonPath, json);

      // Primary UX: copy the markdown to the clipboard for pasting into an issue.
      try {
        await navigator.clipboard.writeText(markdown);
      } catch {
        /* clipboard may be unavailable in some hosts */
      }

      new Notice(`Diagnostics copied to clipboard and saved to ${mdPath}`, 8000);
    } catch (err) {
      console.error('[ClaudeThreads] Failed to generate diagnostics report:', err);
      new Notice('Failed to generate diagnostics report. See console for details.', 6000);
    }
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = mergePersistedSettings(DEFAULT_SETTINGS, data);
    const { sanitizeConversationCompanionSettings } = require('./conversationFirstPlacement') as typeof import('./conversationFirstPlacement');
    sanitizeConversationCompanionSettings(this.settings as unknown as Record<string, unknown>);
    // Migrate old WebLLM model IDs to claude alias
    if (this.settings.inprocessModel.includes('-MLC') || this.settings.inprocessModel.includes('/')) {
      this.settings.inprocessModel = 'haiku';
    }
    // Ensure projects array exists for older data
    this.settings.projects = this.settings.projects ?? [];
    // Ensure secretEnvKeys array exists for installs predating this feature
    this.settings.secretEnvKeys = this.settings.secretEnvKeys ?? [];
    // Ensure mcpServers map exists for installs predating this feature. There is
    // deliberately no import from ~/.claude/settings.json here: the plugin does
    // not read that file at all any more.
    this.settings.mcpServers = this.settings.mcpServers ?? {};
    // Ensure oauthMcpServers/oauthMcpState maps exist for installs predating this feature.
    this.settings.oauthMcpServers = this.settings.oauthMcpServers ?? {};
    this.settings.oauthMcpState = this.settings.oauthMcpState ?? {};
    // Ensure scheduledItems array exists for installs predating this feature
    this.settings.scheduledItems = this.settings.scheduledItems ?? [];
    // Ensure watchedDocuments array exists for installs predating this feature
    this.settings.watchedDocuments = this.settings.watchedDocuments ?? [];
    // Ensure remoteAccess block exists for installs predating this feature
    this.settings.remoteAccess = Object.assign({}, DEFAULT_SETTINGS.remoteAccess, this.settings.remoteAccess ?? {});
    // Default local telemetry ON for installs predating this feature (local-only).
    this.settings.telemetryEnabled = this.settings.telemetryEnabled ?? true;
    // Migrate pre-v0.15 "Opus escalation" settings to the generic escalation
    // settings (escalationEnabled/escalationKeyword/escalationModel). The old
    // '/opus' default keyword becomes '/escalate'; custom keywords are kept.
    {
      const legacy = (data ?? {}) as Record<string, unknown>;
      if (legacy.escalationEnabled === undefined && typeof legacy.opusEscalationEnabled === 'boolean') {
        this.settings.escalationEnabled = legacy.opusEscalationEnabled;
      }
      if (legacy.escalationKeyword === undefined && typeof legacy.opusEscalationKeyword === 'string') {
        this.settings.escalationKeyword =
          legacy.opusEscalationKeyword === '/opus' ? '/escalate' : legacy.opusEscalationKeyword;
      }
      // Drop the legacy keys (carried onto settings by Object.assign) so they
      // disappear from data.json on the next save.
      delete (this.settings as unknown as Record<string, unknown>).opusEscalationEnabled;
      delete (this.settings as unknown as Record<string, unknown>).opusEscalationKeyword;
    }
    // Clear any garbage written by the SecretComponent picker (stores key names, not values)
    const storedKey = this.app.secretStorage.getSecret('openai-api-key');
    if (storedKey && !storedKey.startsWith('sk-')) {
      this.app.secretStorage.setSecret('openai-api-key', '');
    }
  }

  /**
   * Reload this plugin via Obsidian's internal plugin API.
   * Equivalent to toggling the plugin off and on in Settings › Community Plugins.
   */
  async safeReloadPlugin(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugins = (this.app as any).plugins as {
      disablePlugin: (id: string) => Promise<void>;
      enablePlugin: (id: string) => Promise<void>;
    } | undefined;
    if (!plugins) {
      new Notice('Unable to reload: Obsidian plugin API not available.', 4_000);
      return;
    }
    const id = this.manifest.id;
    // The host does not await onunload(). Flush while this generation still
    // owns the writer lease, then hand control to disable/enable.
    await this.saveSettings();
    await plugins.disablePlugin(id);
    await plugins.enablePlugin(id);
  }

  // Serializes all saveSettings() callers through a single in-flight
  // data.json write. Without this, concurrent callers (~106 call sites,
  // many fire-and-forget — autosaves, task notifications, cwd changes,
  // explicit archives, etc.) can race: whichever disk write finishes LAST
  // wins, even if it started earlier. A slow background save that began
  // before a thread was archived can complete AFTER the correct
  // post-archive write and silently clobber it back to stale state —
  // resurrecting a "closed" thread. (Log-verified: 18 threads manually
  // archived on 2026-07-12 were all 18 found back in `waiting` state on
  // 2026-07-14.) The self-draining loop below guarantees only one write is
  // ever in flight, and that every write reflects the freshest manager
  // state at write time, not call time — so a caller that stacks up behind
  // an in-flight write is never lost, just coalesced into the next pass.
  private savePromise: Promise<void> | null = null;
  private saveAgainRequested = false;
  // Each caller waits only for the first write that includes the state visible
  // when it requested a save. A later coalesced pass cannot revoke that commit.
  private saveRequestedGeneration = 0;
  private saveCommittedGeneration = 0;
  private saveWaiters: Array<{
    generation: number;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  async saveSettings(): Promise<void> {
    // Telemetry: every save request (many coalesce into one disk write below).
    telemetry.recordSaveRequested();
    const generation = (this.saveRequestedGeneration ?? 0) + 1;
    this.saveRequestedGeneration = generation;
    const acknowledged = new Promise<void>((resolve, reject) => {
      (this.saveWaiters ??= []).push({ generation, resolve, reject });
    });
    if (this.savePromise) {
      this.saveAgainRequested = true;
      return acknowledged;
    }
    this.savePromise = this.runSaveLoop();
    return acknowledged;
  }

  private async runSaveLoop(): Promise<void> {
    try {
      do {
        this.saveAgainRequested = false;
        const passGeneration = this.saveRequestedGeneration;
        // Persist projects + thread state (without streaming content)
        // manager is null on mobile — skip thread persistence there
        if (this.manager) {
          this.settings.projects = this.manager.getProjects();
          // Produce data.json-safe copies: strip ephemeral statusTags (re-derived
          // each poll) and drop base64/data from any image already externalized to
          // a `path` file. The live in-memory threads are never mutated.
          this.settings.threads = this.manager.getThreads().map(serializeThreadForSave);
        }
        await this.saveDataAtomic();
        // Telemetry: an actual disk write (measures coalescing effectiveness vs.
        // savesRequested).
        telemetry.recordSaveWritten();
        this.saveCommittedGeneration = passGeneration;
        const committed = this.saveWaiters.filter(waiter => waiter.generation <= passGeneration);
        this.saveWaiters = this.saveWaiters.filter(waiter => waiter.generation > passGeneration);
        for (const waiter of committed) waiter.resolve();
      } while (this.saveAgainRequested || (this.saveCommittedGeneration ?? 0) < this.saveRequestedGeneration);
    } catch (error) {
      const uncommitted = this.saveWaiters;
      this.saveWaiters = [];
      for (const waiter of uncommitted) waiter.reject(error);
    } finally {
      this.savePromise = null;
    }
  }

  /**
   * Atomic replacement for Obsidian's non-atomic saveData (ADR-0003, PR 1).
   * Obsidian's saveData rewrites data.json in place, so any external reader
   * (Obsidian Sync, a backup job, a script) can catch it mid-write and get a
   * torn "Unterminated string" read, the corruption vector behind the 17MB
   * machine. On desktop we write the same JSON to a sibling `.tmp` and
   * atomically rename it over data.json (rename is atomic on one filesystem),
   * so a reader sees either the whole old file or the whole new one, never a
   * partial one. The path and format are identical to what saveData would
   * write and what loadData() reads.
   *
   * Off a FileSystemAdapter (mobile) there is no filesystem to rename on, so we
   * fall back to the unchanged Obsidian saveData. The existing single-in-flight
   * savePromise coalescing guarantees only one writer runs at a time.
   */
  private async saveDataAtomic(): Promise<void> {
    const fence = sharedPersistenceWriterFence();
    const token = this.persistenceWriterToken ??= fence.claim();
    await fence.write(token, () => this.writeDataAtomicUnfenced());
  }

  private async writeDataAtomicUnfenced(): Promise<void> {
    // Only the desktop FileSystemAdapter can do a temp-file + rename. Anything
    // else (mobile, or an instance not fully wired to an App) falls back to
    // Obsidian's own saveData (same write path as before this change).
    const adapter = this.app?.vault?.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      await this.saveData(this.settings);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pathMod = require('path') as typeof import('path');
    const dataPath = pathMod.join(adapter.getBasePath(), this.manifest.dir!, 'data.json');
    const tmpPath = `${dataPath}.tmp`;
    const json = JSON.stringify(this.settings);
    await fs.promises.writeFile(tmpPath, json, 'utf8');
    await fs.promises.rename(tmpPath, dataPath);
  }
}

// ── Safe-Reload Modal ──────────────────────────────────────────────────────────

type ReloadAction = 'cancel' | 'force' | 'graceful';

/**
 * Shown when the user invokes "Reload plugin (safe)" while agent threads are
 * actively running.  Presents the thread list and three choices:
 *
 *  • Cancel          — dismiss, do nothing
 *  • Interrupt & Reload — interrupt all sessions (up to 30 s) then reload
 *  • Force Reload     — reload immediately, killing active threads
 */
class ActiveThreadsReloadModal extends Modal {
  private threads: import('./types').Thread[];
  private onAction: (action: ReloadAction) => Promise<void>;

  constructor(
    app: App,
    threads: import('./types').Thread[],
    onAction: (action: ReloadAction) => Promise<void>,
  ) {
    super(app);
    this.threads = threads;
    this.onAction = onAction;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('ct-safe-reload-modal');

    contentEl.createEl('h2', { text: 'Active threads detected' });

    const s = this.threads.length === 1 ? '' : 's';
    contentEl.createEl('p', {
      text: `${this.threads.length} thread${s} ${this.threads.length === 1 ? 'is' : 'are'} currently running. Reloading the plugin will kill ${this.threads.length === 1 ? 'it' : 'them'} immediately unless you interrupt first.`,
    });

    const list = contentEl.createEl('ul', { cls: 'ct-safe-reload-thread-list' });
    for (const t of this.threads) {
      list.createEl('li', { text: t.title });
    }

    const btnRow = contentEl.createEl('div', { cls: 'ct-safe-reload-btns' });

    const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      this.close();
      this.onAction('cancel').catch(console.error);
    });

    const gracefulBtn = btnRow.createEl('button', {
      text: 'Interrupt & Reload',
      cls: 'mod-cta',
    });
    gracefulBtn.addEventListener('click', () => {
      this.close();
      this.onAction('graceful').catch(console.error);
    });

    const forceBtn = btnRow.createEl('button', {
      text: 'Force Reload',
      cls: 'mod-warning',
    });
    forceBtn.addEventListener('click', () => {
      this.close();
      this.onAction('force').catch(console.error);
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

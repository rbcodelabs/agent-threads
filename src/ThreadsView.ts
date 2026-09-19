import { ItemView, WorkspaceLeaf, Modal, Menu, setIcon, setTooltip, Notice, sanitizeHTMLToDom, App, FileSystemAdapter, TFile, Platform } from 'obsidian';
import { hasVisibleDirectViewHeader } from './headerPresentation';
import type { ViewStateResult } from 'obsidian';
import { marked } from 'marked';
import { effectiveExtraEnv } from './types';
import { parseLoopArgs, formatLoopInterval } from './loopUtils';
import { THREAD_BUILTIN_COMMANDS, THREAD_ARG_COMPLETIONS, MODEL_ALIASES, goalKickoffMessage, resolveCreatePrMessage, escalationCommand } from './slashCommands';
import { isSetAsGoalEligible } from './goalContext';
import { buildComparePrUrl, gitDiffBarVisible, prButtonLabel, prUrlMatchesRepo } from './gitDiffUtils';
import type { Thread, ChatMessage, ToolCallRecord, AskQuestion, ImageAttachment, DesignArtifact } from './types';
import type { ThreadManager, ThreadEvent } from './ThreadManager';
import type { SummarizeResult } from './InProcessSummarizer';
import { shouldAutoSummarize, isUsableTitle } from './summarization';
import path from 'path';
import os from 'os';
import * as fsp from 'fs/promises';
import type ClaudeThreadsPlugin from './main';
import { isDefaultThreadTitle } from './thread-title-utils';
import { formatToolName, getToolIcon } from './ClaudeSession';
import { isTrustedBuiltInTool } from './toolNameUtils';
import { groupToolCalls, liveToolGroupKey, mergeAdjacentToolOnlyMessages, ACTIVITY_LABELS, smoothToolGroups, pickCurrentTool, shouldWrapOuter, type ToolCallGroup } from './toolNameUtils';
import { DispatchInput, type ExtraSkillDir } from './DispatchInput';
import { buildComposerContextLabel, formatWakeupCountdown, isAwsSsoError, extractAwsProfile, resolveAwsBinary, awsExecEnv, splitErrorMessage } from './dashboardUtils';
import { getVaultBridgesAPI, mapToVaultPath, type BridgeInfo } from './bridgeUtils';
import { resolveTagIcon, planFooter, derivePrUrl } from './statusLine';
import { isWebViewerEnabled } from './SettingsTab';
import { ContextPanelViewError } from './ContextPanelController';
import { classifyRenderedMarkdownLink, isOsAbsoluteHref, openLocalFileViaHost, openUrlPreferringWebViewer, resolveAbsoluteVaultHref } from './linkUtils';
import type { StatusTag } from './types';
import { appendOrchestratorBadge } from './orchestrator-badge';
import { promptConfirm } from './confirmModal';
import { describeOrchestratorThread, isOrchestratorThread, orchestratorWarning, type OrchestratorContext } from './orchestratorThreads';
import { partitionThreads } from './threadRowState';
import { agentLabel, buildAgentBreadcrumbs, summarizeAgentTeam } from './agentRuns/agentTreeModel';
import { renderAgentPopoverTree } from './agentRuns/renderAgentPopoverTree';
import { renderAgentActivity } from './agentRuns/renderAgentActivity';
import { toArtifactRef } from './ArtifactContributions';
import type {
  ArtifactActionHost, ArtifactPresentation, ArtifactViewPlacement, ThreadArtifactRef,
} from './ArtifactContributions';
import { extractVisualizeMarkers } from './visualizeMarker';
import { VisualizeMountManager, resolveVisualizeTokens, toFileUrl, type VisualizeFs } from './visualizeRenderer';
import { deleteScheduledActivity, scheduledActivityForThread, scheduledActivitySummary, type ScheduledActivity } from './scheduledActivity';
import { ConversationViewPlacementState, resolveHostRestoredActiveThread } from './conversationFirstPlacement';

export const VIEW_TYPE = 'claude-threads:chat';

// Rendering a streamed response means repeatedly parsing all text received so
// far and replacing the bubble's DOM. Keep this comfortably below the display
// refresh rate: at 80ms, a long response could trigger 12.5 complete Markdown
// parses (plus DOM rebuilds) per second.
const STREAMING_RENDER_INTERVAL_MS = 250;

export class ThreadsView extends ItemView {
  private plugin: ClaudeThreadsPlugin;
  private manager: ThreadManager;
  private activeThreadId: string | null = null;
  private readonly conversationPlacement = new ConversationViewPlacementState();
  private streamingEl: HTMLElement | null = null;
  private streamingContentEl: HTMLElement | null = null;
  private streamingContent = '';
  /**
   * Owns every inline `visualize` card in this view: one IntersectionObserver
   * and one `message` listener shared by all of them. Created with the message
   * scroller in buildUI(), torn down in onClose().
   */
  private visualizeManager: VisualizeMountManager | null = null;
  private streamingRenderTimer: ReturnType<typeof setTimeout> | null = null;
  /** A render is queued whenever new streamed text arrives. */
  private streamingRenderDirty = false;
  /** Prevent async Markdown parses from overlapping on long responses. */
  private streamingRenderInFlight = false;
  /** Invalidates an async render after its streaming bubble has been removed. */
  private streamingRenderGeneration = 0;
  // Lazily-created wrapper for the live (in-progress) turn's tool-call pills/groups.
  // Only created the first time there's an actual tool call to show (see
  // ensureStreamingToolsEl) — .ct-tools carries a non-zero margin-bottom, so
  // creating it unconditionally would shift layout for turns with no tool calls.
  private streamingToolsEl: HTMLElement | null = null;
  // Debounce timer for rebuilding the live tool-call list, mirroring
  // streamingRenderTimer's 80ms batching for streamed text tokens (see
  // scheduleLiveToolsRender).
  private liveToolsRenderTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;

  // DOM refs
  private rootEl!: HTMLElement;
  private tabBar!: HTMLElement;
  private titleEl!: HTMLButtonElement;
  private titleRowEl!: HTMLElement;
  private titleTextEl!: HTMLSpanElement;
  private mainEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputRowEl!: HTMLElement;

  // ── Sub-agent surfaces ────────────────────────────────────────────────────
  /** Always-visible status pill in the composer footer; hidden when no agents exist. */
  private agentPillEl: HTMLElement | null = null;
  /**
   * The agent-tree popover. Anchored to .ct-panel-wrapper rather than the footer,
   * because .ct-input-footer carries `overflow: hidden` from the collapsible rule
   * and would clip anything drawn above the composer.
   */
  private agentPopoverEl: HTMLElement | null = null;
  private agentPopoverOutsideHandler: ((e: MouseEvent) => void) | null = null;
  private schedulePillEl: HTMLButtonElement | null = null;
  private schedulePopoverEl: HTMLElement | null = null;
  private schedulePopoverOutsideHandler: ((e: MouseEvent) => void) | null = null;
  private schedulePopoverOutsideTimer: ReturnType<typeof setTimeout> | null = null;
  /** Timeline body of the in-place child activity view, refreshed live. */
  private agentViewBodyEl: HTMLElement | null = null;
  /** Remembered scroll offsets, keyed "<threadId>:main" or "<threadId>:<agentRunId>". */
  private agentScroll: Map<string, number> = new Map();
  /** One-shot scroll target consumed by the next main-conversation render. */
  private pendingMainScroll: number | null = null;
  private moreBtn!: HTMLButtonElement;
  private statusRailEl!: HTMLElement;
  private queueRowsEl!: HTMLElement;
  private activeWorkCardEl: HTMLElement | null = null;
  private rateLimitCardEl: HTMLElement | null = null;
  private editedFilesEl!: HTMLElement;
  private artifactCardEl!: HTMLElement;
  /** Small badge shown in the title bar when the active thread is ephemeral. */
  private ephemeralBadgeEl!: HTMLSpanElement;
  /** Models discovered from the active session via supportedModels(). */
  private discoveredModels: import('@anthropic-ai/claude-agent-sdk').ModelInfo[] = [];
  /** Agents discovered from the active session via supportedAgents(). */
  private discoveredAgents: import('@anthropic-ai/claude-agent-sdk').AgentInfo[] = [];

  // Shared dispatch input component
  private dispatchInput!: DispatchInput;

  // Files edited in the active thread (rebuilt on thread switch, updated live)
  private editedFilesSet: Set<string> = new Set();
  // Files where the user modified the proposed content in the permission dialog
  private userModifiedFilesSet: Set<string> = new Set();

  // Debounce timer for persisting per-thread drafts to settings
  private draftSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // Active subagent task pills: taskId → pill element
  private taskPills: Map<string, HTMLElement> = new Map();

  // Active tool pills by tool_use_id for elapsed-time updates from tool_progress events
  private toolPillsByUseId: Map<string, HTMLElement> = new Map();

  // Task start times for elapsed-time display: taskId → epoch ms
  private taskStartTimes: Map<string, number> = new Map();

  // Workflow progress state
  private activeWorkflowTaskId: string | null = null;
  private workflowBlockEl: HTMLElement | null = null;
  private workflowPhaseEl: HTMLElement | null = null;
  private workflowAgentRows: Map<string, HTMLElement> = new Map();

  // Whether the current streaming element was created as a "sub-agent waiting"
  // placeholder (no real token content yet). Used to decide whether to keep it
  // alive when a message commits with an Agent tool call.
  private subagentWaiting = false;

  // The user-message bubble we just inserted, so we can remove it on interrupt
  private pendingUserEl: HTMLElement | null = null;

  // The raw typed text from the last send per thread, so we can restore it on interrupt.
  // Keyed by thread ID so switching between threads doesn't cross-contaminate drafts.
  private lastSentTexts: Map<string, string> = new Map();

  // Inline permission cards waiting for user response (threadId -> card state)
  private pendingPermissions: Map<string, {
    toolName: string;
    detail: string;
    resolve: (allow: boolean) => void;
    cardEl: HTMLElement | null;
  }> = new Map();

  // Inline question cards (AskUserQuestion) waiting for user response (threadId -> card state)
  private pendingQuestions: Map<string, {
    questions: AskQuestion[];
    resolve: (answers: Record<string, string>) => void;
    cardEl: HTMLElement | null;
  }> = new Map();

  // Context footer (status line below input)
  private contextFooterEl!: HTMLElement;

  // Git diff bar (branch + diff stat + Create PR split button), shown above
  // the compose box whenever the active thread's cwd is a git repo on a
  // non-base branch. Unlike contextFooterEl, this is NOT nested inside
  // ct-panel-context, so it does not inherit the hover/focus-only collapse
  // behavior — it stays visible at rest, like the input row itself.
  private gitDiffBarEl!: HTMLElement;

  // Live countdown for the scheduled-activity pill and its open popover.
  private wakeupCountdownTimer: ReturnType<typeof setInterval> | null = null;
  // Lightweight sweep that pauses the open thread's spinners once it is
  // `isRunning` but wedged (no progress for STALE_MS) — see refreshStale.
  private staleInterval: ReturnType<typeof setInterval> | null = null;

  // (status rail state tracked via activeWorkCardEl / rateLimitCardEl / toastEl fields above)

  // Project filtering
  private activeProjectId: string | null = null;
  private projectBar!: HTMLElement;

  // Slash command autocomplete
  // New-thread button
  private newThreadBtn!: HTMLButtonElement;
  // Close/archive current thread button
  private closeThreadBtn!: HTMLButtonElement;

  // Thread switcher inline panel
  private switcherPanelEl: HTMLElement | null = null;
  private switcherTriggerEl: HTMLElement | null = null;
  private switcherOutsideHandler: ((e: MouseEvent) => void) | null = null;
  private switcherOutsideTimer: ReturnType<typeof setTimeout> | null = null;
  private nativeHeaderMode = false;
  private nativeSwitchActionEl: HTMLElement | null = null;
  private nativeRenameActionEl: HTMLElement | null = null;
  private nativeManagerNotesActionEl: HTMLElement | null = null;
  private nativeNewThreadActionEl: HTMLElement | null = null;
  private nativeCloseThreadActionEl: HTMLElement | null = null;
  private headerSyncFrame: number | null = null;

  // Summary peek banner (shown on tab reactivation)
  private summaryBannerEl: HTMLElement | null = null;
  private summaryBannerTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly BANNER_IDLE_THRESHOLD_MS = 60_000;  // show only after 1 min away
  private static readonly BANNER_AUTO_DISMISS_MS   = 10_000;  // auto-hide after 10 sec

  // Compressed view state
  private compressedView = false;
  // Maps message id → summary text span, for async DOM updates after summary generation
  private summaryTextEls: Map<string, HTMLElement> = new Map();
  // Cache for group summaries (consecutive assistant turns between user messages).
  // Key = ':'-joined message IDs of the group. In-memory only; regenerates on reload.
  private groupSummaryCache: Map<string, string> = new Map();
  // Expand/collapse state for tool-call groups (see renderToolGroup), keyed by
  // ':'-joined toolUseId/timestamp of the group's tools. In-memory only —
  // cleared alongside groupSummaryCache so state doesn't leak across threads.
  private expandedToolGroups: Set<string> = new Set();
  // Expand/collapse state for LIVE (in-progress) tool-call groups, keyed by
  // liveToolGroupKey (firstToolUseId:activityKind) rather than toolGroupKey's
  // full toolUseId list — a live group's tool list keeps growing as more calls
  // arrive, so its member list isn't a stable key, but the first call's id is
  // (groupToolCalls only ever extends a run at the tail, never reinterprets an
  // earlier boundary). Cleared alongside expandedToolGroups.
  private liveExpandedToolGroups: Set<string> = new Set();
  // Expand/collapse state for the second-tier "outer wrap" that kicks in when
  // a tool-call list is still too long after smoothToolGroups (see
  // renderOuterToolWrap/shouldWrapOuter). Keyed by outerToolWrapKey (a
  // toolGroupKey hash of the FULL flat tool list, not the grouped entries).
  // Cleared alongside expandedToolGroups.
  private expandedOuterToolWrap: Set<string> = new Set();
  // LIVE counterpart to expandedOuterToolWrap, keyed by outerLiveToolWrapKey
  // (liveToolGroupKey of the full flat tool list) for the same reason
  // liveExpandedToolGroups exists — the tool list keeps growing mid-turn, so
  // a stable-hash key would re-collapse it on every extension. Cleared
  // alongside liveExpandedToolGroups.
  private liveExpandedOuterToolWrap: Set<string> = new Set();
  // Tracks the most recently appended row (post-merge, see
  // mergeAdjacentToolOnlyMessages) in the live 'message' event handler, so a
  // subsequent tool-only step in the SAME run can extend that row's tools
  // in-place instead of fragmenting into a new `.ct-message`. Reset to null
  // whenever a 'compact' divider is appended (a hard run boundary), and
  // re-seeded by renderMessages() when restoring a thread that is still
  // actively running (see the isRunning branch at the end of renderMessages).
  private lastAppendedRowId: string | null = null;
  private lastAppendedRowEl: HTMLElement | null = null;
  // Serial queue for compress-view summary generation — prevents spawning N concurrent Claude processes.
  // Incrementing summaryGeneration acts as a cancellation token: queued jobs check it before starting
  // and discard their results if the view has been toggled/navigated away since they were enqueued.
  private summaryQueue: Promise<void> = Promise.resolve();
  private summaryGeneration = 0;
  /**
   * Thread IDs with an auto-summarize call in flight. Prevents a fast
   * follow-up turn from stacking a second concurrent `claude` subprocess on
   * the same thread. Cleared in a `.finally()`.
   */
  private summarizeInFlight: Set<string> = new Set();

  // Per-thread streaming buffers. Accumulates tokens and tool calls for every
  // running thread (active or background) so the streaming UI can be fully
  // restored when the user switches back to a thread that is still in progress.
  // Cleared on 'message' or 'done' for the corresponding thread.
  private streamingBuffers: Map<string, { content: string; tools: ToolCallRecord[]; subagentLabel?: string }> = new Map();

  // Per-thread escalated-turn model. Set when a turn starts with the escalation
  // keyword and cleared when the turn ends, so the model button can show a
  // persistent indicator for the whole escalated turn (surviving thread switches
  // and clearing correctly even when the turn ends on a background thread).
  private escalatedTurnModels: Map<string, string> = new Map();

  private floatingPanelEl!: HTMLElement;

  // Task list card (Claude Code's TodoWrite/TaskCreate checklist)
  private taskCardEl: HTMLElement | null = null;
  private taskCardCollapsed = false;
  /** Thread IDs whose task card has been auto-dismissed after all tasks completed. */
  private taskCardDismissed = new Set<string>();

  // Thread-orchestrator UI: proposed replies render inline in the conversation
  // flow (see renderProposedReplyCard) rather than via a dedicated element
  // reference, plus a collapsible Manager Notes panel in the thread header.
  private managerNotesToggleEl: HTMLElement | null = null;
  private managerNotesPanelEl: HTMLElement | null = null;
  private managerNotesCollapsed = true;

  // Ordered list for the footer permission-mode picker menu.
  // `value: undefined` means "use the global default" (clears the per-thread override).
  private static readonly PERMISSION_MODE_OPTIONS: Array<{ label: string; value: import('./types').PluginSettings['permissionMode'] | undefined }> = [
    { label: 'Global default', value: undefined },
    { label: 'Prompt for permissions', value: 'default' },
    { label: 'Accept edits automatically', value: 'acceptEdits' },
    { label: 'Bypass all permissions', value: 'bypassPermissions' },
    { label: 'Plan only (read & propose, no execute)', value: 'plan' },
    { label: 'Silent deny (CI/cron)', value: 'dontAsk' },
    { label: 'Auto-approve', value: 'auto' },
  ];

  // Ordered list for the footer model switcher menu. `value: undefined` means
  // "use the global default" (clears the per-thread override).
  private static readonly CLAUDE_MODEL_OPTIONS: Array<{ label: string; value: string | undefined }> = [
    { label: 'Default', value: undefined },
    { label: 'Opus', value: 'opus' },
    { label: 'Sonnet', value: 'sonnet' },
    { label: 'Haiku', value: 'haiku' },
    { label: 'Fable', value: 'fable' },
  ];

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeThreadsPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.manager = plugin.manager;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    if (this.activeThreadId) {
      const thread = this.manager.getThread(this.activeThreadId);
      if (thread) return thread.title;
    }
    return 'Agent Threads';
  }

  /** Force Obsidian to re-read getDisplayText() and repaint the workspace tab header. */
  private refreshLeafHeader(): void {
    (this.leaf as any).updateHeader();
  }

  getIcon(): string {
    return 'message-square';
  }

  onPaneMenu(menu: Menu, _source: string): void {
    const id = this.activeThreadId;
    if (!id || !this.manager.getThread(id)) return;
    menu.addItem((item) => item.setTitle('Rename thread').setIcon('pencil')
      .onClick(() => this.renameThread(id)));
  }

  getState(): Record<string, unknown> {
    return {
      ...super.getState(),
      ...this.conversationPlacement.serialize(this.activeThreadId),
    };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    this.conversationPlacement.apply(state);
    const incoming = (state as { activeThreadId?: unknown } | null)?.activeThreadId;
    const activeThreadId = resolveHostRestoredActiveThread(
      this.activeThreadId,
      typeof incoming === 'string' ? incoming : null,
      this.plugin.settings.activeThreadId,
      (id) => Boolean(this.manager.getThread(id)),
    );
    if (!activeThreadId) return;
    this.activeThreadId = activeThreadId;
    if (this.rootEl) await this.setActiveThread(activeThreadId);
  }

  async onOpen(): Promise<void> {
    this.buildUI();
    this.createNativeHeaderActions();
    // Delegate within the view so host title refreshes cannot detach the handler.
    this.registerDomEvent(this.containerEl, 'dblclick', (event) => {
      const title = this.containerEl.querySelector(':scope > .view-header .view-header-title');
      if (this.nativeHeaderMode && title?.contains(event.target as Node)) {
        event.preventDefault();
        event.stopPropagation();
        if (this.activeThreadId) this.renameThread(this.activeThreadId);
      }
    });
    this.syncHeaderMode();
    this.registerEvent(this.app.workspace.on('layout-change', () => {
      if (this.headerSyncFrame !== null) cancelAnimationFrame(this.headerSyncFrame);
      this.headerSyncFrame = requestAnimationFrame(() => {
        this.headerSyncFrame = null;
        this.syncHeaderMode();
      });
    }));
    this.registerEvent(this.app.workspace.on('css-change', () => this.syncHeaderMode()));

    this.manager.permissionHandler = (threadId, toolName, detail) => {
      // First-party host tools are always trusted; classification is an explicit
      // capability allowlist, not a forgeable naming-prefix convention.
      if (isTrustedBuiltInTool(toolName)) return Promise.resolve(true);
      if (this.plugin.settings.alwaysAllowedTools.includes(toolName)) return Promise.resolve(true);

      return new Promise((resolve) => {
        let resolved = false;
        const done = (allow: boolean) => {
          if (resolved) return;
          resolved = true;
          const pending = this.pendingPermissions.get(threadId);
          if (pending?.cardEl) pending.cardEl.remove();
          this.pendingPermissions.delete(threadId);
          resolve(allow);
        };

        // Register with ThreadManager so AgentDashboard can also resolve this
        this.manager.registerPermissionResolver(threadId, done);

        // Render card immediately if this is the active thread; otherwise store for later
        if (threadId === this.activeThreadId) {
          const cardEl = this.renderPermissionCard(toolName, detail, done);
          this.pendingPermissions.set(threadId, { toolName, detail, resolve: done, cardEl });
          this.scrollToBottom();
        } else {
          this.pendingPermissions.set(threadId, { toolName, detail, resolve: done, cardEl: null });
        }
      });
    };

    this.manager.questionHandler = (threadId, questions: AskQuestion[]) =>
      new Promise((resolve) => {
        let resolved = false;
        const done = (answers: Record<string, string>) => {
          if (resolved) return;
          resolved = true;
          const pending = this.pendingQuestions.get(threadId);
          if (pending?.cardEl) pending.cardEl.remove();
          this.pendingQuestions.delete(threadId);
          resolve(answers);
        };

        // Register with ThreadManager so AgentDashboard can also resolve this
        this.manager.registerQuestionResolver(threadId, done);

        // Render card immediately if this is the active thread; otherwise store for later
        if (threadId === this.activeThreadId) {
          const cardEl = this.renderQuestionCard(questions, done);
          this.pendingQuestions.set(threadId, { questions, resolve: done, cardEl });
          this.scrollToBottom();
        } else {
          this.pendingQuestions.set(threadId, { questions, resolve: done, cardEl: null });
        }

        // pending_question_changed is emitted just before questionHandler is
        // entered, so hasPendingQuestion() was still false when that event was
        // rendered. Refresh once the resolver is registered to expose Send.
        if (threadId === this.activeThreadId) {
          this.setRunningState(this.manager.isRunning(threadId));
        }
      });

    this.manager.openNewTabHandler = async (title?: string, initialPrompt?: string) => {
      let cwd = this.plugin.getEffectiveCwd();
      let projectId: string | undefined;
      if (this.activeProjectId) {
        const project = this.manager.getProject(this.activeProjectId);
        if (project) { cwd = this.manager.getProjectCwd(project); projectId = project.id; }
      }
      const thread = this.manager.createThread(title ?? `Thread ${this.manager.getThreads().length + 1}`, cwd, projectId);
      await this.plugin.saveSettings();
      this.renderProjectBar();
      void this.setActiveThread(thread.id);
      if (initialPrompt) {
        this.dispatchInput?.setValue(initialPrompt);
      }
      return { threadId: thread.id, title: thread.title };
    };

    this.unsubscribe = this.manager.subscribe((threadId, event) => {
      this.handleThreadListEvent(threadId, event);
      // Save whenever any thread's persistent state changes, not just the active one.
      // Without this, messages on background threads are never written to disk and
      // are lost on reload.
      if (event.type === 'message' || event.type === 'done' || event.type === 'compact') {
        void this.plugin.saveSettings();
      }
      // Keep project badge counts up to date
      if (event.type === 'thread_created' || event.type === 'thread_deleted') {
        this.renderProjectBar();
      }
      // Drop remembered scroll offsets for a thread that no longer exists.
      if (event.type === 'thread_deleted') {
        for (const key of [...this.agentScroll.keys()]) {
          if (key.startsWith(`${threadId}:`)) this.agentScroll.delete(key);
        }
      }
      // Maintain a per-thread streaming buffer for ALL threads so we can restore
      // the live streaming UI when switching back to a thread still in progress.
      if (event.type === 'streaming_start') {
        this.streamingBuffers.set(threadId, { content: '', tools: [] });
      } else if (event.type === 'token') {
        let buf = this.streamingBuffers.get(threadId);
        if (!buf) { buf = { content: '', tools: [] }; this.streamingBuffers.set(threadId, buf); }
        buf.content += event.text;
        // Once real tokens arrive, clear the sub-agent placeholder label —
        // the token content will replace it when the thread is restored.
        if (buf.subagentLabel) buf.subagentLabel = undefined;
      } else if (event.type === 'tool_use') {
        let buf = this.streamingBuffers.get(threadId);
        if (!buf) { buf = { content: '', tools: [] }; this.streamingBuffers.set(threadId, buf); }
        buf.tools.push(event.record);
      } else if (event.type === 'message') {
        // If the message invoked the Agent tool, keep the buffer alive for the
        // sub-agent phase (don't delete it). Reset content/tools and mark it as
        // a sub-agent waiting state so restoring the view shows the right label.
        const hasAgentCall = event.message.toolCalls?.some(t => t.name === 'Agent');
        if (hasAgentCall) {
          const buf: { content: string; tools: ToolCallRecord[]; subagentLabel?: string } =
            { content: '', tools: [], subagentLabel: 'Sub-agent working' };
          this.streamingBuffers.set(threadId, buf);
        } else {
          this.streamingBuffers.delete(threadId);
        }
      } else if (event.type === 'task_started') {
        let buf = this.streamingBuffers.get(threadId);
        if (!buf) { buf = { content: '', tools: [] }; this.streamingBuffers.set(threadId, buf); }
        if (event.taskType === 'local_workflow') {
          buf.subagentLabel = `Workflow: ${event.workflowName ?? event.description}`;
        } else if (!buf.subagentLabel?.startsWith('Workflow:')) {
          // Don't overwrite a workflow label with individual agent labels
          const kind = event.skipTranscript ? 'Background' : 'Sub-agent';
          buf.subagentLabel = `${kind}: ${event.description}`;
        }
      } else if (event.type === 'done') {
        this.streamingBuffers.delete(threadId);
      }
      // Track escalated turns for ALL threads (active or background) so the
      // model button reflects the escalation for the whole turn and clears
      // even when the turn ends on a non-active thread.
      if (event.type === 'escalated') {
        this.escalatedTurnModels.set(threadId, event.model);
      } else if (event.type === 'done' || event.type === 'error' || event.type === 'interrupted') {
        this.clearEscalatedTurn(threadId);
      }
      // Auto-summarize runs for ALL completing threads, not just the active one.
      // Keeping this outside the activeThreadId guard covers the case where the
      // user switches away from a thread (or dispatches from Kanban) while it's
      // running — the response lands on a non-active thread and would otherwise
      // never be summarized.
      //
      // Triggered on `done` (one per completed user turn), NOT on `message`.
      // `message` is emitted for every assistant SDK message inside the agentic
      // loop — including tool-only messages with no text and every sub-agent
      // step — which fired the summarizer ~58x per turn and spawned a `claude`
      // subprocess each time. Tradeoff: a turn ending in `error` or
      // `interrupted` no longer titles the thread; the next completed turn does.
      if (event.type === 'done') {
        const summarizeThread = this.manager.getThread(threadId);
        if (summarizeThread && shouldAutoSummarize({
          summarizationEnabled: this.plugin.settings.summarizationEnabled,
          autoSummarize: this.plugin.settings.autoSummarize,
          titleUserSet: summarizeThread.titleUserSet,
          inFlight: this.summarizeInFlight.has(threadId),
          messages: summarizeThread.messages,
          lastSummarizedAt: summarizeThread.lastSummarizedAt,
        })) {
          this.summarizeInFlight.add(threadId);
          // Capture the cursor BEFORE the call, not after it resolves: every
          // message in the transcript has a timestamp <= this, and anything
          // that arrives while the summarizer is running stays newer than it
          // and so still counts as new content on the next turn.
          const summarizedThrough = Date.now();
          this.runSummarize(summarizeThread.messages, summarizeThread).then((result) => {
            // Empty strings mean "no update" — never overwrite good state with them.
            const summaryChanged = Boolean(result.summary);
            const titleChanged = Boolean(result.title) && isUsableTitle(result.title);
            if (summaryChanged) summarizeThread.summary = result.summary;
            // Advance the cursor on any successful pass so the next turn sends
            // only its own delta, even when the model reported no change.
            summarizeThread.lastSummarizedAt = summarizedThrough;
            if (titleChanged) this.applyAutoTitle(summarizeThread.id, result.title);
            this.plugin.saveSettings();
            // Re-save the vault note so the title update lands immediately and any
            // stale note from the old title (e.g. "2025-06-03-thread-1.md") is
            // cleaned up right away rather than waiting for the next session.
            if (this.plugin.settings.saveThreadsToVault && this.plugin.persistence) {
              this.plugin.persistence.saveThread(summarizeThread).catch(console.error);
            }
            // Notify all views (Kanban, Dashboard) that the summary changed so they re-render.
            this.manager.notifySummaryUpdated(summarizeThread.id);
            if (this.activeThreadId === summarizeThread.id) {
              this.renderTitleBar();
              this.renderThreadInfo();
              this.refreshLeafHeader();
            }
          }).catch((err: unknown) => {
            console.warn('[claude-threads] auto-summarize failed:', err);
          }).finally(() => {
            this.summarizeInFlight.delete(threadId);
          });
        }
      }
      if (threadId === this.activeThreadId) {
        this.handleEvent(event);
      }
    });

    const threads = this.manager.getThreads();
    if (threads.length > 0) {
      // Respect a pre-set activeThreadId (e.g. focusThread called before buildUI in a race),
      // otherwise default to the most recently created thread rather than the oldest.
      const { resolvePersistedActiveThread } = require('./conversationFirstPlacement') as typeof import('./conversationFirstPlacement');
      const targetId = resolvePersistedActiveThread(
        this.activeThreadId,
        this.plugin.settings.activeThreadId,
        (id) => Boolean(this.manager.getThread(id)),
        threads[threads.length - 1].id,
      );
      void this.setActiveThread(targetId);
    } else {
      const thread = this.manager.createThread('Thread 1', this.plugin.getEffectiveCwd());
      await this.plugin.saveSettings();
      void this.setActiveThread(thread.id);
    }

    this.renderProjectBar();
    this.renderTitleBar();

    // Render the status footer from the active thread's current tags. The
    // StatusLineService (owned by main.ts) keeps statusTags fresh in the background.
    this.renderStatusFooter();

    this.staleInterval = setInterval(() => this.refreshStale(), 15_000);
  }

  /**
   * Pauses the open thread's live spinners (streaming thinking-dot/cursor/tool
   * dots and the status-rail card) once it has been `isRunning` with no
   * progress for STALE_MS. Toggled on the streaming + status-rail containers so
   * the descendant `.ct-stale` rules in styles.css apply. Scoped to the single
   * active thread — the switcher panel's own rows are unaffected.
   */
  private refreshStale(): void {
    const stale = this.activeThreadId ? this.manager.isRunStale(this.activeThreadId) : false;
    this.streamingEl?.toggleClass('ct-stale', stale);
    this.statusRailEl?.toggleClass('ct-stale', stale);
  }

  /** Refresh list-derived chrome after a batch of threads enters memory. */
  private handleThreadListEvent(threadId: string, event: ThreadEvent): void {
    if (event.type === 'threads_loaded' || event.type === 'projects_changed') {
      this.renderProjectBar();
      if (event.type === 'projects_changed') this.renderComposerContext();
    }
    if (event.type === 'thread_deleted') this.repairSelectionAfterDelete(threadId);
  }

  /**
   * Keep the chat view off a thread ThreadManager has already dropped.
   *
   * Archiving happens from more places than `closeThread()`: the Agents List and
   * Kanban right-click menus, the MCP `archiveThread` handler, and the idle
   * sweep all reach `deleteThread()` directly. Repairing the selection here —
   * on the event every one of those paths emits — covers all of them at once.
   * Without it `activeThreadId` keeps pointing at the deleted thread, which is
   * not merely cosmetic: `handleSendFromDispatch()` only guards against a *null*
   * id, so the next send reaches `ThreadManager.sendMessage()` and throws
   * `Thread not found` while the dead conversation is still rendered as live.
   *
   * `deleteThread()` removes the thread from its map *before* emitting, so
   * `getThreads()` here already excludes it.
   */
  private repairSelectionAfterDelete(deletedId: string): void {
    if (!this.titleEl) return; // buildUI hasn't run yet; nothing to repair or re-render
    if (this.activeThreadId !== deletedId) {
      // Not our thread, but the switcher/tab chrome lists it — refresh the label row.
      this.renderTitleBar();
      return;
    }
    const remaining = this.manager.getThreads();
    if (remaining.length > 0) {
      void this.setActiveThread(remaining[0].id);
      return;
    }
    this.activeThreadId = null;
    this.renderTitleBar();
    void this.renderMessages();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.stopWakeupCountdown();
    if (this.staleInterval) clearInterval(this.staleInterval);
    if (this.headerSyncFrame !== null) cancelAnimationFrame(this.headerSyncFrame);
    this.headerSyncFrame = null;
    // Both popovers register a capture-phase document listener; leaving either
    // attached leaks a handler that outlives the view.
    this.closeSwitcherPanel();
    this.closeAgentPopover();
    this.closeSchedulePopover();
    this.agentScroll.clear();
    this.dispatchInput?.destroy();
    // Leaves an IntersectionObserver and a window-level message listener
    // attached if skipped.
    this.visualizeManager?.detach();
    this.visualizeManager = null;
  }

  /**
   * Dependency seam for the inline visualization renderer: filesystem access,
   * theme resolution, and link opening, all injected so the renderer itself
   * stays free of Node built-ins and Obsidian workspace calls.
   */
  private buildVisualizeHost(): ConstructorParameters<typeof VisualizeMountManager>[1] {
    const fileFs: VisualizeFs = {
      stat: (target) => fsp.stat(target),
      readFile: (target, encoding) => fsp.readFile(target, encoding),
      mkdir: (target, options) => fsp.mkdir(target, options),
      writeFile: (target, data, encoding) => fsp.writeFile(target, data, encoding),
      tmpDir: () => os.tmpdir(),
    };
    return {
      fs: fileFs,
      resolveTokens: () => resolveVisualizeTokens(this.rootEl ?? this.containerEl),
      theme: () => (document.body.classList.contains('theme-dark') ? 'dark' : 'light'),
      openUrl: (url) => this.openLink(url),
      notify: (message) => new Notice(message),
      leafHeight: () => this.messagesEl?.clientHeight || 0,
    };
  }

  private buildUI(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    this.rootEl = root;
    root.empty();
    root.addClass('ct-root');
    root.toggleClass('ct-mobile', Platform.isMobile);
    root.setAttribute('data-density', this.plugin.settings.layoutDensity ?? 'comfortable');

    const titleRow = root.createDiv('ct-title-row');
    this.titleRowEl = titleRow;
    this.titleEl = titleRow.createEl('button', { cls: 'ct-title-btn', attr: { title: 'Switch thread' } });
    const titleIcon = this.titleEl.createSpan('ct-title-icon');
    setIcon(titleIcon, 'message-square');
    this.titleTextEl = this.titleEl.createSpan({ cls: 'ct-title-text', text: 'Agent Threads' });
    const chevronEl = this.titleEl.createSpan('ct-title-chevron');
    setIcon(chevronEl, 'chevron-down');
    this.titleEl.addEventListener('click', (e) => this.openThreadSwitcher(e));
    this.titleEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (this.activeThreadId) this.renameThread(this.activeThreadId);
    });
    this.ephemeralBadgeEl = titleRow.createSpan({ cls: 'ct-ephemeral-badge ct-hidden', text: 'ephemeral' });

    this.managerNotesToggleEl = titleRow.createEl('button', {
      cls: 'ct-manager-notes-toggle ct-hidden',
      attr: { title: 'Manager notes' },
    });
    setIcon(this.managerNotesToggleEl, 'sticky-note');
    this.managerNotesToggleEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.managerNotesCollapsed = !this.managerNotesCollapsed;
      this.renderManagerNotesPanel();
    });

    this.newThreadBtn = titleRow.createEl('button', { cls: 'ct-tab-new', attr: { title: 'New thread' } });
    setIcon(this.newThreadBtn, 'square-pen');
    this.newThreadBtn.addEventListener('click', (e) => this.openNewThread(e));
    this.closeThreadBtn = titleRow.createEl('button', { cls: 'ct-title-close', attr: { title: 'Close thread' } });
    setIcon(this.closeThreadBtn, 'x');
    this.closeThreadBtn.addEventListener('click', () => {
      if (this.activeThreadId) this.closeThread(this.activeThreadId).catch(console.error);
    });

    this.mainEl = root.createDiv('ct-main');
    this.messagesEl = this.mainEl.createDiv('ct-messages');
    this.visualizeManager?.detach();
    this.visualizeManager = new VisualizeMountManager(this.messagesEl, this.buildVisualizeHost());
    this.visualizeManager.attach();

    const panelWrapper = this.mainEl.createDiv('ct-panel-wrapper');
    const floatingPanel = panelWrapper.createDiv('ct-floating-panel ct-panel-collapsible');
    this.floatingPanelEl = floatingPanel;
    const panelContext = floatingPanel.createDiv('ct-panel-context');

    this.managerNotesPanelEl = panelContext.createDiv('ct-manager-notes-panel ct-hidden');
    this.statusRailEl = panelContext.createDiv('ct-status-rail');
    this.queueRowsEl = panelContext.createDiv('ct-queue-rows ct-hidden');
    this.taskCardEl = panelContext.createDiv('ct-task-card ct-hidden');
    this.artifactCardEl = panelContext.createDiv('ct-artifact-card ct-hidden');
    this.editedFilesEl = panelContext.createDiv('ct-edited-files ct-hidden');

    this.gitDiffBarEl = floatingPanel.createDiv('ct-git-diff-bar ct-hidden');

    this.inputRowEl = floatingPanel.createDiv('ct-input-row');

    // Compute skill dirs from every configured plugin source plus the vault
    // skills root, so they appear in /command autocomplete immediately, without
    // waiting for commands_changed from the first session message. These must
    // mirror what ThreadManager registers in opts.plugins — including the
    // namespace each one ends up under — or autocomplete offers names the
    // session cannot resolve.
    const extraSkillDirs: ExtraSkillDir[] = [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getSkillsDirForSource } = require('./claudeSettings') as typeof import('./claudeSettings');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { expandHome, VAULT_SKILLS_PLUGIN_NAME } = require('./skillPaths') as typeof import('./skillPaths');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const osNode = require('os') as typeof import('os');
      for (const src of (this.plugin.settings.skillSources ?? [])) {
        // No prefix: source skills register as one local plugin each, which
        // the SDK names after the skill itself.
        if (src.type === 'github' && src.clonePath) {
          extraSkillDirs.push({ dir: getSkillsDirForSource(src.clonePath) });
        } else if (src.type === 'local' && src.skillsPath) {
          extraSkillDirs.push({ dir: expandHome(src.skillsPath, osNode.homedir()) });
        }
      }
      const vaultSkillsRoot = this.plugin.getPluginSkillsRoot();
      const localSkillsRoot = this.plugin.getLocalSkillsRoot();
      if (localSkillsRoot) extraSkillDirs.push({ dir: localSkillsRoot, prefix: 'local' });
      if (vaultSkillsRoot) {
        extraSkillDirs.push({ dir: vaultSkillsRoot, prefix: VAULT_SKILLS_PLUGIN_NAME });
      }
    } catch { /* ignore */ }

    this.dispatchInput = new DispatchInput({
      app: this.app,
      placeholder: this.plugin.settings.agentHarness === 'codex' ? 'Message Codex' : 'Message Claude',
      inputCls: 'ct-input',
      sendBtnText: '↵',
      sendBtnTitle: 'Send message',
      showStopBtn: true,
      onStop: () => this.stopMessage(),
      showThisMention: true,
      showContextChip: true,
      onContextClick: (event) => this.toggleComposerContextMenu(event),
      captureLongPaste: true,
      builtinCommands: () => {
        const esc = escalationCommand(this.plugin.settings);
        return esc ? [...THREAD_BUILTIN_COMMANDS, esc] : THREAD_BUILTIN_COMMANDS;
      },
      argCompletions: THREAD_ARG_COMPLETIONS,
      extraSkillDirs,
      onInput: () => this.scheduleDraftSave(),
      onChipChange: () => this.scheduleDraftSave(),
      appendFooterMetadata: (container) => {
        this.schedulePillEl = container.createEl('button', {
          cls: 'ct-schedule-pill ct-hidden',
          attr: {
            type: 'button',
            title: 'View scheduled activity',
            'aria-label': 'View scheduled activity',
            'aria-haspopup': 'dialog',
            'aria-expanded': 'false',
          },
        });
        const scheduleIcon = this.schedulePillEl.createSpan('ct-schedule-pill-icon');
        setIcon(scheduleIcon, 'clock-3');
        this.schedulePillEl.createSpan('ct-schedule-pill-text');
        const chevron = this.schedulePillEl.createSpan('ct-schedule-pill-chevron');
        setIcon(chevron, 'chevron-up');
        this.schedulePillEl.addEventListener('click', (event) => {
          event.stopPropagation();
          this.toggleSchedulePopover();
        });
        this.renderScheduledActivity();

        // Deliberately NOT .ct-footer-pill: that class belongs to the status-line
        // pills in .ct-context-footer, and several tests locate it unqualified.
        // This mirrors its visual language in CSS instead of sharing the class.
        this.agentPillEl = container.createEl('button', {
          cls: 'ct-agent-pill ct-hidden',
          attr: { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
        });
        const pillIcon = this.agentPillEl.createSpan('ct-agent-pill-icon');
        setIcon(pillIcon, 'users');
        this.agentPillEl.createSpan('ct-agent-pill-text');
        this.agentPillEl.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleAgentPopover();
        });
        this.renderAgentPill();
      },
      appendFooterActions: (container) => {
        this.moreBtn = container.createEl('button', {
          cls: 'ct-more-btn ct-thread-more-btn',
          attr: { title: 'More actions' },
        });
        setIcon(this.moreBtn, 'menu');
        this.moreBtn.addEventListener('click', (e) => this.toggleMoreMenu(e));
      },
      onSend: async ({ text, images, attachment }) => {
        await this.handleSendFromDispatch(text, images, attachment);
      },
      getPttKey: () => this.plugin.settings.pttKey ?? '',
    });
    this.dispatchInput.mount(this.inputRowEl);

    this.contextFooterEl = panelContext.createDiv('ct-context-footer ct-hidden');

    // No ResizeObserver needed — the panel is an in-flow flex child (ct-panel-wrapper),
    // so the browser automatically shrinks ct-messages to make room. No CSS variable sync required.
  }

  private renderProjectBar(): void {
    if (!this.projectBar) return; // project bar removed from UI; kept for compat
    this.projectBar.empty();
    const projects = this.manager.getProjects();

    // "All" pill
    const allPill = this.projectBar.createEl('button', {
      cls: `ct-project-pill ${this.activeProjectId === null ? 'ct-project-pill-active' : ''}`,
      text: 'All',
    });
    allPill.addEventListener('click', () => {
      this.activeProjectId = null;
      this.renderProjectBar();
      this.renderTitleBar();
    });

    for (const project of projects) {
      const pill = this.projectBar.createEl('button', {
        cls: `ct-project-pill ${this.activeProjectId === project.id ? 'ct-project-pill-active' : ''}`,
      });
      pill.createSpan({ cls: 'ct-project-pill-icon', text: '📁' });
      pill.createSpan({ cls: 'ct-project-pill-name', text: project.name });

      const threadCount = this.manager.getThreadsByProject(project.id).length;
      if (threadCount > 0) {
        pill.createSpan({ cls: 'ct-project-pill-count', text: String(threadCount) });
      }

      pill.setAttribute('title', project.vaultFolder + (project.description ? '\n' + project.description : ''));

      pill.addEventListener('click', () => {
        this.activeProjectId = project.id;
        this.renderProjectBar();
        this.renderTitleBar();
        // If the current active thread isn't in this project, switch to first project thread
        const currentThread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;
        if (!currentThread || currentThread.projectId !== project.id) {
          const projectThreads = this.manager.getThreadsByProject(project.id);
          if (projectThreads.length > 0) {
            void this.setActiveThread(projectThreads[0].id);
          }
        }
      });
    }

    // Only show the bar if there are projects
    if (projects.length === 0) {
      this.projectBar.addClass('ct-hidden');
    } else {
      this.projectBar.removeClass('ct-hidden');
    }
  }

  private renderTitleBar(): void {
    if (!this.titleTextEl) return;
    const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;
    this.titleTextEl.textContent = thread?.title ?? 'Agent Threads';

    // Show the ephemeral badge when the active thread is marked ephemeral
    if (this.ephemeralBadgeEl) {
      this.ephemeralBadgeEl.toggleClass('ct-hidden', !thread?.ephemeral);
    }

    const threads = this.manager.getThreads();
    const hasRunning = threads.some(t => t.id !== this.activeThreadId && this.manager.isRunning(t.id));
    this.titleEl.classList.toggle('ct-title-has-background', hasRunning);
    this.nativeSwitchActionEl?.classList.toggle('ct-title-has-background', hasRunning);
    this.nativeSwitchActionEl?.classList.toggle('ct-native-switch-ephemeral', Boolean(thread?.ephemeral));
    if (this.nativeSwitchActionEl) {
      const details = [thread?.ephemeral ? 'ephemeral thread' : '', hasRunning ? 'background thread running' : '']
        .filter(Boolean)
        .join(', ');
      setTooltip(this.nativeSwitchActionEl, details ? `Switch thread — ${details}` : 'Switch thread');
      this.nativeSwitchActionEl.setAttribute('aria-label', details ? `Switch thread — ${details}` : 'Switch thread');
    }

    // Hide close button when there is only one thread (nothing to switch to)
    if (this.closeThreadBtn) {
      this.closeThreadBtn.classList.toggle('ct-hidden', threads.length <= 1);
    }
    this.nativeCloseThreadActionEl?.classList.toggle('ct-hidden', threads.length <= 1);
  }

  private createNativeHeaderActions(): void {
    if (this.nativeSwitchActionEl) return;
    this.nativeSwitchActionEl = this.addAction('message-square', 'Switch thread', (event) => this.openThreadSwitcher(event));
    this.nativeSwitchActionEl.addClass('ct-native-switch-action');
    this.nativeRenameActionEl = this.addAction('pencil', 'Rename thread', () => {
      if (this.activeThreadId) this.renameThread(this.activeThreadId);
    });
    this.nativeManagerNotesActionEl = this.addAction('sticky-note', 'Manager notes', (event) => {
      event.stopPropagation();
      this.managerNotesCollapsed = !this.managerNotesCollapsed;
      this.renderManagerNotesPanel();
    });
    this.nativeNewThreadActionEl = this.addAction('square-pen', 'New thread', (event) => this.openNewThread(event));
    this.nativeCloseThreadActionEl = this.addAction('x', 'Close thread', () => {
      if (this.activeThreadId) this.closeThread(this.activeThreadId).catch(console.error);
    });
  }

  private syncHeaderMode(): void {
    const useNativeHeader = !Platform.isMobile && hasVisibleDirectViewHeader(this.containerEl);
    if (useNativeHeader !== this.nativeHeaderMode) this.closeSwitcherPanel();
    this.nativeHeaderMode = useNativeHeader;
    this.rootEl?.toggleClass('ct-native-header-mode', useNativeHeader);
    this.titleRowEl?.toggleClass('ct-hidden', useNativeHeader);
    for (const action of [
      this.nativeSwitchActionEl,
      this.nativeRenameActionEl,
      this.nativeManagerNotesActionEl,
      this.nativeNewThreadActionEl,
      this.nativeCloseThreadActionEl,
    ]) action?.toggleClass('ct-hidden-by-placement', !useNativeHeader);
    this.renderTitleBar();
    this.renderManagerNotesPanel();
    if (useNativeHeader) this.refreshLeafHeader();
  }


  focusThread(id: string): Promise<void> {
    return this.setActiveThread(id);
  }

  /** Restore a valid selection after a provisional dispatch thread is rolled back. */
  async restoreThreadSelection(preferredId: string | null): Promise<void> {
    const targetId = preferredId && this.manager.getThread(preferredId)
      ? preferredId
      : this.manager.getThreads()[0]?.id ?? null;
    if (targetId) {
      await this.setActiveThread(targetId);
      return;
    }

    this.activeThreadId = null;
    this.plugin.settings.activeThreadId = undefined;
    this.app.workspace.requestSaveLayout?.();
    await this.plugin.saveSettings();
    if (!this.titleEl) return;
    this.renderTitleBar();
    await this.renderMessages();
    this.setRunningState(false);
    this.dispatchInput?.setValue('');
    this.dispatchInput?.clearAttachments();
    this.refreshLeafHeader();
  }

  /** Update the density data-attribute live when the user changes the setting. */
  applyDensity(): void {
    if (this.rootEl) {
      this.rootEl.setAttribute('data-density', this.plugin.settings.layoutDensity ?? 'comfortable');
    }
  }


  getActiveThreadId(): string | null {
    return this.activeThreadId;
  }

  /** Snapshot the current input box state into the given thread object. */
  private saveDraftToThread(threadId: string | null): void {
    if (!threadId || !this.dispatchInput) return;
    const thread = this.manager.getThread(threadId);
    if (!thread) return;
    const text = this.dispatchInput.getValue();
    const attachment = this.dispatchInput.getPendingAttachment();
    const images = this.dispatchInput.getPendingImages();
    const hasContent = text.length > 0 || attachment !== null || images.length > 0;
    if (hasContent) {
      thread.draft = { text, attachment, images };
    } else {
      delete thread.draft;
    }
  }

  /** Restore the input box state from a thread's saved draft (or clear it). */
  private restoreDraftFromThread(threadId: string): void {
    if (!this.dispatchInput) return;
    const thread = this.manager.getThread(threadId);
    const draft = thread?.draft;
    this.dispatchInput.setValue(draft?.text ?? '');
    this.dispatchInput.setPendingAttachment(draft?.attachment ?? null);
    this.dispatchInput.setPendingImages(draft ? [...draft.images] : []);
  }

  /**
   * Debounce-save the active thread's draft to plugin settings so it survives
   * a plugin reload. Fires 1.5 s after the last keystroke or attachment change.
   */
  private scheduleDraftSave(): void {
    if (this.draftSaveTimer !== null) clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = setTimeout(() => {
      this.draftSaveTimer = null;
      this.saveDraftToThread(this.activeThreadId);
      this.plugin.saveSettings();
    }, 1500);
  }

  private async setActiveThread(id: string): Promise<void> {
    this.closeSwitcherPanel();
    this.closeAgentPopover();
    this.closeSchedulePopover();
    this.rememberAgentScroll();
    const previousId = this.activeThreadId;

    // Mark the thread as reviewed when the user explicitly opens it.
    // This covers all entry paths: switcher dropdown clicks, focusThread()
    // calls (including programmatic callers like obsidian-voice), keyboard
    // navigation, and openThreadInChatView().
    const threadToReview = this.manager.getThread(id);
    if (threadToReview && !threadToReview.reviewed) {
      threadToReview.reviewed = true;
      this.plugin.saveSettings();
    }

    // Persist the draft for the thread we're leaving before switching
    this.saveDraftToThread(this.activeThreadId);
    this.activeThreadId = id;
    const { persistActiveThreadSelection } = require('./conversationFirstPlacement') as typeof import('./conversationFirstPlacement');
    void persistActiveThreadSelection(
      this.app.workspace,
      this.plugin.settings,
      () => this.plugin.saveSettings(),
      id,
    ).catch(console.error);
    this.summaryGeneration++; // cancel any queued summary jobs from the previous thread
    this.groupSummaryCache.clear();
    this.expandedToolGroups.clear();
    this.liveExpandedToolGroups.clear();
    this.expandedOuterToolWrap.clear();
    this.liveExpandedOuterToolWrap.clear();
    if (!this.titleEl) return; // buildUI hasn't run yet; onOpen will call us again with the right id
    this.manager.notifyActiveThreadChanged(id);
    this.renderTitleBar();
    this.renderThreadInfo();
    await this.renderMessages();
    this.setRunningState(this.manager.isRunning(id));
    this.renderComposerContext();
    this.applyComposerPlaceholder();
    this.restorePendingPlanCard();
    this.restorePendingQuestionCard();
    // renderMessages() just wiped messagesEl, so re-anchor a proposed reply
    // that was set on this thread while it was in the background.
    this.renderProposedReplyCard();
    this.syncEditedFiles();
    this.refreshLeafHeader();
    // Restore draft for the thread we just switched to
    this.restoreDraftFromThread(id);
    // Re-render the footer for the new thread and kick a fresh poll for its cwd.
    this.renderStatusFooter();
    this.plugin.statusLine?.pokeThread(id);
    this.renderGitDiffBar();
    this.plugin.gitDiff?.pokeThread(id);

    // Show the context recap banner when switching back to a thread after being away
    this.maybeShowSummaryBanner(id, previousId, undefined);
  }

  // ---------------------------------------------------------------------------
  // Summary peek banner
  // ---------------------------------------------------------------------------

  private maybeShowSummaryBanner(
    threadId: string,
    previousId: string | null,
    priorAccessTime: number | undefined,
  ): void {
    this.hideSummaryBanner(true); // clear any stale banner immediately

    // Only fire when genuinely switching between two different threads
    if (!previousId || previousId === threadId) return;

    const thread = this.manager.getThread(threadId);
    if (!thread) return;

    const summary = thread.summary || thread.recap;
    if (!summary) return;

    // Skip if the user was just here — only show when returning after a real break
    const elapsed = priorAccessTime !== undefined ? Date.now() - priorAccessTime : Infinity;
    if (elapsed < ThreadsView.BANNER_IDLE_THRESHOLD_MS) return;

    this.showSummaryBanner(thread, summary);
  }

  private showSummaryBanner(thread: Thread, summary: string): void {
    const banner = this.mainEl.createDiv('ct-summary-banner');
    this.summaryBannerEl = banner;

    const header = banner.createDiv('ct-summary-banner-header');
    header.createSpan({ cls: 'ct-summary-banner-label', text: '↺ Context' });
    header.createSpan({
      cls: 'ct-summary-banner-time',
      text: `Last active ${this.formatTimeAgo(thread.updatedAt)}`,
    });

    const closeBtn = header.createEl('button', {
      cls: 'ct-summary-banner-close',
      text: '×',
      attr: { title: 'Dismiss' },
    });
    closeBtn.addEventListener('click', () => this.hideSummaryBanner(false));

    banner.createEl('p', { cls: 'ct-summary-banner-text', text: summary });

    // Auto-dismiss after the configured delay
    this.summaryBannerTimer = setTimeout(
      () => this.hideSummaryBanner(false),
      ThreadsView.BANNER_AUTO_DISMISS_MS,
    );
  }

  private hideSummaryBanner(immediate: boolean): void {
    if (this.summaryBannerTimer !== null) {
      clearTimeout(this.summaryBannerTimer);
      this.summaryBannerTimer = null;
    }
    if (!this.summaryBannerEl) return;
    const el = this.summaryBannerEl;
    this.summaryBannerEl = null;

    if (immediate) {
      el.remove();
      return;
    }

    // Animate out then remove
    el.addClass('ct-summary-banner-out');
    setTimeout(() => el.remove(), 300);
  }

  private formatTimeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    return `${days}d ago`;
  }

  /** Formats a UNIX-ms timestamp as a short wall-clock time, e.g. "3:45 PM".
   *  If the timestamp is from a different calendar day, prefixes the date: "May 27, 3:45 PM". */
  private formatShortTime(timestamp: number): string {
    const d = new Date(timestamp);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return time;
    const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `${date}, ${time}`;
  }

  // ---------------------------------------------------------------------------
  // Context footer (status line)
  // ---------------------------------------------------------------------------

  /**
   * Render the active thread's status-line pills from its `statusTags` (kept
   * fresh by StatusLineService). A sticky `prUrl` with no live PR tag still
   * renders a leading PR pill, preserving the "PR pill always first" behavior.
   *
   * DEDUPE: when the git diff bar is visible it already shows this thread's
   * branch, diff stat, and a PR button labelled with the PR number — so any
   * footer 'pr'/'branch' pill would restate the row directly below it. Those
   * kinds are dropped here in that case, from BOTH the synthesized sticky-prUrl
   * pill and the script-provided statusTags (a user's status-line command has
   * no idea what the native bar is rendering, so the plugin has to arbitrate).
   * Once the bar hides — PR merged, back on the base branch — the suppression
   * lifts and the footer PR pill becomes the only surface for that PR again.
   */
  renderStatusFooter(): void {
    const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;
    const prUrl = thread?.prUrl;

    // The bar owns branch + PR identity whenever it's on screen.
    const { tags, showPrPill } = planFooter({
      tags: thread?.statusTags ?? [],
      prUrl,
      barShowsGitInfo: gitDiffBarVisible(thread?.gitDiff),
      prRepoMatches: prUrlMatchesRepo(prUrl, thread?.gitDiff?.ownerRepo),
    });

    this.contextFooterEl.empty();

    // Synthesized leading PR pill from sticky prUrl when the live tags don't
    // include a PR tag (e.g. legacy persisted prUrl, or the PR has merged).
    if (showPrPill) {
      const prNumMatch = prUrl!.match(/\/pull\/(\d+)/);
      const label = prNumMatch ? `PR #${prNumMatch[1]}` : 'Open PR';
      this.renderFooterPill({ label, url: prUrl!, icon: 'git-pull-request', kind: 'pr' }, 'ct-footer-pill-pr');
    }

    for (const tag of tags) {
      this.renderFooterPill(tag, tag.kind === 'pr' ? 'ct-footer-pill-pr' : undefined);
    }

    // Synthesized "Scheduled: <name>" pill: shown when this thread was
    // created by a cron fire (Scheduler.createThread), independent of
    // statusTags/activeLoops — this is origin metadata, not a live loop.
    const hasScheduledOrigin = !!(thread?.scheduledItemId && thread.scheduledItemName);
    if (hasScheduledOrigin) {
      this.renderFooterPill({
        label: `Scheduled: ${thread!.scheduledItemName}`,
        icon: 'clock',
        kind: 'scheduled',
      });
    }

    // Mirrors what was actually rendered above: a prUrl that got deduped away
    // must not keep an otherwise-empty footer on screen as a blank strip.
    const empty = !showPrPill && tags.length === 0 && !hasScheduledOrigin;
    this.contextFooterEl.toggleClass('ct-hidden', empty);
  }

  /**
   * Render the git diff bar (branch + diff stat + Create PR split button) for
   * the active thread, populated by GitDiffService. Hidden when the thread has
   * no gitDiff info yet, its cwd isn't a git repo, its branch can't be resolved
   * (e.g. detached HEAD), or it's already sitting on the base/default branch
   * (nothing to open a PR against).
   *
   * The PR shown here comes from the LIVE status tags, not the thread's sticky
   * `prUrl`. This bar is branch-scoped UI — it sits next to the branch name, so
   * labelling it with a PR asserts "this branch's PR". Only the live tag can
   * back that claim: the status-line script derives it from a branch-scoped
   * `gh pr view "$branch"` on every poll, so it disappears the moment the branch
   * has no PR. `thread.prUrl` is thread-scoped *history* — deliberately sticky,
   * so it survives both a branch switch and a `set_working_directory` into a
   * different repo entirely (observed: threads carrying a `geode` PR while
   * sitting in the `obsidian-claude-threads` worktree). It stays sticky for the
   * Kanban chip, `backfillLegacyProjectNames`, and archive-on-merge — it just
   * must not drive this button. Safe against transient script failures because
   * StatusLineService leaves the previous tags intact on exec error.
   */
  renderGitDiffBar(): void {
    const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;
    const gitDiff = thread?.gitDiff;
    const prUrl = derivePrUrl(thread?.statusTags ?? []);

    this.gitDiffBarEl.empty();

    if (!gitDiffBarVisible(gitDiff)) {
      this.gitDiffBarEl.addClass('ct-hidden');
      return;
    }
    this.gitDiffBarEl.removeClass('ct-hidden');

    const branchGroup = this.gitDiffBarEl.createDiv('ct-git-diff-branch');
    const iconEl = branchGroup.createSpan('ct-git-diff-branch-icon');
    setIcon(iconEl, 'git-branch');
    const repoName = thread?.cwd ? path.basename(thread.cwd) : '';
    if (repoName) {
      branchGroup.createSpan({ cls: 'ct-git-diff-repo', text: repoName });
    }
    branchGroup.createSpan({ cls: 'ct-git-diff-branch-name', text: gitDiff.branch, title: gitDiff.branch });

    const insertions = gitDiff.insertions ?? 0;
    const deletions = gitDiff.deletions ?? 0;
    if (insertions > 0 || deletions > 0) {
      const statEl = this.gitDiffBarEl.createDiv('ct-git-diff-stat');
      if (insertions > 0) {
        statEl.createSpan({ cls: 'ct-git-diff-stat-add', text: `+${insertions}` });
      }
      if (deletions > 0) {
        statEl.createSpan({ cls: 'ct-git-diff-stat-del', text: `-${deletions}` });
      }
    }

    const actions = this.gitDiffBarEl.createDiv('ct-git-diff-actions');
    // Label carries the PR number ("PR #121") when we have one — this bar is the
    // single surface for PR identity, so renderStatusFooter suppresses its own
    // PR pill whenever this bar is visible (see the dedupe note there).
    const createBtn = actions.createEl('button', {
      cls: 'ct-git-diff-create-btn',
      text: prButtonLabel(prUrl),
      attr: prUrl ? { title: prUrl } : {},
    });
    createBtn.addEventListener('click', () => {
      if (prUrl) {
        this.openLink(prUrl);
      } else {
        void this.handleSendFromDispatch('/create-pr', [], null);
      }
    });
    const dropdownBtn = actions.createEl('button', {
      cls: 'ct-git-diff-dropdown-btn',
      attr: { title: 'PR options' },
    });
    setIcon(dropdownBtn, 'chevron-down');
    dropdownBtn.addEventListener('click', (e) => this.openCreatePrMenu(e, gitDiff, prUrl));
  }

  /** Dropdown for the git diff bar's split button: [View PR /] Create PR / Create draft PR / Manually create PR. */
  private openCreatePrMenu(event: MouseEvent, gitDiff: import('./types').GitDiffInfo, prUrl?: string): void {
    const menu = new Menu();
    if (prUrl) {
      menu.addItem(item =>
        item
          .setTitle('View PR')
          .setIcon('git-pull-request')
          .onClick(() => { this.openLink(prUrl); })
      );
    }
    menu.addItem(item =>
      item
        .setTitle('Create PR')
        .setIcon('git-pull-request')
        .onClick(() => { void this.handleSendFromDispatch('/create-pr', [], null); })
    );
    menu.addItem(item =>
      item
        .setTitle('Create draft PR')
        .setIcon('git-pull-request-draft')
        .onClick(() => { void this.handleSendFromDispatch('/create-pr --draft', [], null); })
    );
    menu.addItem(item => {
      item
        .setTitle('Manually create PR')
        .setIcon('external-link')
        .onClick(() => {
          if (!gitDiff.ownerRepo || !gitDiff.branch || !gitDiff.baseBranch) {
            new Notice('Could not determine the GitHub repo for this branch (no GitHub origin remote found).');
            return;
          }
          const url = buildComparePrUrl(gitDiff.ownerRepo.owner, gitDiff.ownerRepo.repo, gitDiff.baseBranch, gitDiff.branch);
          this.openLink(url);
        });
      if (!gitDiff.ownerRepo) item.setDisabled(true);
    });
    menu.showAtMouseEvent(event);
  }

  /** Render a single status pill (icon + label, link if the tag has a url). */
  private renderFooterPill(tag: StatusTag, extraCls?: string): void {
    const pill = this.contextFooterEl.createDiv('ct-footer-pill' + (extraCls ? ' ' + extraCls : ''));
    const iconEl = pill.createSpan('ct-footer-pill-icon');
    setIcon(iconEl, resolveTagIcon(tag));

    const toneCls =
      tag.tone === 'warn' ? ' ct-footer-pill-warn' :
      tag.tone === 'error' ? ' ct-footer-pill-error' : '';

    if (tag.url) {
      const url = tag.url;
      const link = pill.createEl('a', { cls: 'ct-footer-pill-text ct-footer-link' + toneCls, text: tag.label });
      link.href = url;
      link.title = url;
      link.addEventListener('click', (e) => {
        e.preventDefault();
        // Cmd-click (Mac) / Ctrl-click (other) forces the system browser even
        // when the Web Viewer is enabled — matching Obsidian's "open in default
        // app" modifier convention.
        this.openLink(url, e.metaKey || e.ctrlKey);
      });
    } else {
      pill.createSpan({ cls: 'ct-footer-pill-text' + toneCls, text: tag.label });
    }
  }

  /**
   * Open a URL from a status pill — in the Web Viewer when enabled, else the
   * system browser. When `forceExternal` is set (Cmd/Ctrl-click), always use the
   * system browser. See {@link openUrlPreferringWebViewer}.
   */
  private async openLink(url: string, forceExternal = false): Promise<void> {
    let webViewerEnabled = !forceExternal && isWebViewerEnabled(this.app);
    if (webViewerEnabled && this.plugin.isConversationFirst()) {
      try {
        await this.plugin.contextPanel.setViewStateInNewTab({ type: 'webviewer', active: true, state: { url } });
        return;
      } catch (error) {
        if (error instanceof ContextPanelViewError) webViewerEnabled = false;
        else {
          new Notice(`Could not open contextual link: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
      }
    }
    openUrlPreferringWebViewer(this.app, url, {
      webViewerEnabled,
      openExternal: (u) => {
        const { shell } = require('electron') as { shell: { openExternal: (url: string) => void } };
        shell.openExternal(u);
      },
    });
  }

  /** Called from settings when the command changes: restart the service + re-render. */
  updateStatusLineCommand(): void {
    this.plugin.statusLine?.restart();
    this.renderStatusFooter();
  }

  /** Rebuild the edited-files set from saved thread state for the active thread. */
  private syncEditedFiles(): void {
    this.editedFilesSet.clear();
    this.userModifiedFilesSet.clear();
    const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;
    if (thread) {
      if (thread.editedFiles && thread.editedFiles.length > 0) {
        // Preferred path: dedicated field populated by ThreadManager on every tool use.
        for (const filePath of thread.editedFiles) {
          this.editedFilesSet.add(filePath);
        }
      } else {
        // Fallback for older threads that were saved before editedFiles was introduced.
        for (const msg of thread.messages) {
          for (const tool of msg.toolCalls ?? []) {
            if (tool.name === 'Write' || tool.name === 'Edit') {
              const filePath = tool.summary.replace(/^[^:]+: /, '');
              if (filePath) this.editedFilesSet.add(filePath);
            }
          }
        }
      }
      for (const filePath of thread.userModifiedFiles ?? []) {
        this.userModifiedFilesSet.add(filePath);
      }
    }
    this.renderEditedFilesCard();
    this.renderArtifactCard();
  }

  /**
   * The artifact the card currently represents, adapted at read time. Records
   * persisted before providers existed carry no `providerId`; nothing on disk
   * is rewritten (ADR-0010).
   */
  private activeArtifact(): { threadId: string; ref: ThreadArtifactRef } | null {
    const threadId = this.activeThreadId;
    const thread = threadId ? this.manager.getThread(threadId) : null;
    const record = thread?.artifacts?.[0];
    return record && threadId ? { threadId, ref: toArtifactRef(record) } : null;
  }

  /**
   * Persisted artifact actions stay visible independently of edited-file
   * history. The card is entirely generic: title, subtitle and actions come
   * from whatever provider owns the artifact, and clicks dispatch by action
   * id. The host never inspects an artifact's provider data.
   */
  private renderArtifactCard(): void {
    this.artifactCardEl.empty();
    const active = this.activeArtifact();
    if (!active) {
      this.artifactCardEl.addClass('ct-hidden');
      return;
    }
    this.artifactCardEl.removeClass('ct-hidden');
    const { threadId, ref } = active;

    // An uninstalled or faulty provider degrades to an explanatory card.
    // Prior work must never vanish or throw because a plugin went away.
    const described = this.plugin.artifactProviders.present(ref);
    const presentation: ArtifactPresentation = described.status === 'ok' ? described.presentation : {
      title: ref.title,
      subtitle: described.status === 'missing-provider'
        ? `Unavailable — no plugin provides "${ref.providerId}"`
        : `Unavailable — "${ref.providerId}" could not describe this artifact`,
      actions: [],
    };

    const icon = this.artifactCardEl.createSpan('ct-artifact-card-icon');
    setIcon(icon, presentation.icon ?? 'panels-top-left');
    const copy = this.artifactCardEl.createDiv('ct-artifact-card-copy');
    copy.createDiv({ cls: 'ct-artifact-card-title', text: presentation.title });
    if (presentation.subtitle) copy.createDiv({ cls: 'ct-artifact-card-meta', text: presentation.subtitle });

    const actions = this.artifactCardEl.createDiv('ct-artifact-card-actions');
    for (const action of presentation.actions) {
      const primary = action.variant === 'primary';
      const button = actions.createEl('button', {
        cls: `ct-artifact-action ${primary ? 'ct-artifact-action-primary' : 'ct-artifact-action-secondary'}`,
      });
      const iconEl = button.createSpan('ct-artifact-action-icon');
      setIcon(iconEl, action.icon ?? 'circle');
      if (primary && action.shortLabel) button.createSpan({ cls: 'ct-artifact-action-label', text: action.shortLabel });
      button.setAttribute('aria-label', action.label);
      button.setAttribute('title', action.tooltip ?? action.label);
      button.addEventListener('click', () => { void this.invokeArtifactAction(threadId, ref, action.id); });
    }
  }

  refreshArtifactCard(): void {
    this.renderArtifactCard();
  }

  private async invokeArtifactAction(threadId: string, ref: ThreadArtifactRef, actionId: string): Promise<void> {
    const result = await this.plugin.artifactProviders.invoke(actionId, ref, this.artifactActionHost(threadId, ref));
    if (result.message) new Notice(result.message);
    this.renderArtifactCard();
  }

  /**
   * Capabilities lent to a provider for the duration of one action. A provider
   * never receives this view, a workspace leaf, or a DOM node — only these
   * three brokered operations.
   */
  artifactActionHost(threadId: string, ref: ThreadArtifactRef): ArtifactActionHost {
    return {
      openView: (state) => this.openArtifactView(state),
      revealInFolder: (target) => this.revealArtifactPath(target),
      updateArtifact: async (patch) => {
        const record = this.manager.getThread(threadId)?.artifacts?.find((candidate) => candidate.id === ref.id);
        if (!record) return;
        if (patch.title !== undefined) record.title = patch.title;
        if (patch.data && typeof patch.data === 'object') {
          const writable = record as unknown as Record<string, unknown>;
          for (const [key, value] of Object.entries(patch.data as Record<string, unknown>)) {
            // Host-owned identity is not writable by the provider.
            if (key === 'id' || key === 'kind' || key === 'providerId' || key === 'schemaVersion' || key === 'createdAt') continue;
            writable[key] = value;
          }
        }
        await this.plugin.saveSettings();
      },
    };
  }

  /**
   * Places a host view on the provider's behalf and reports where it landed.
   * Conversation-first policy and context-panel leaf ownership are host
   * internals a peer cannot see, so the decision stays here.
   */
  async openArtifactView(request: { type: string; state?: Record<string, unknown> }): Promise<ArtifactViewPlacement> {
    try {
      if (this.plugin.isConversationFirst()) {
        await this.plugin.contextPanel.setViewState({ type: request.type, active: true, state: request.state });
        if (this.plugin.contextPanel.getLeaf().getViewState().type !== request.type) {
          throw new Error('The host substituted another view.');
        }
        return 'context-panel';
      }
      const existing = this.app.workspace.getLeavesOfType(request.type);
      const matches = (candidate: WorkspaceLeaf) => {
        const current = candidate.getViewState().state as Record<string, unknown> | undefined;
        return Object.entries(request.state ?? {}).every(([key, value]) => current?.[key] === value);
      };
      const leaf = existing.find(matches) ?? existing[0] ?? this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: request.type, active: true, state: request.state });
      if (leaf.getViewState().type !== request.type) throw new Error('The host substituted another view.');
      await this.app.workspace.revealLeaf(leaf);
      return 'tab';
    } catch {
      return 'unavailable';
    }
  }

  /** Reveals a local path in the OS file manager; false when unsupported. */
  async revealArtifactPath(target: string): Promise<boolean> {
    try {
      const { shell } = require('electron') as { shell: { showItemInFolder: (path: string) => void } };
      shell.showItemInFolder(target);
      return true;
    } catch {
      return false;
    }
  }

  // Switch to icon-only chips above this file count to keep the row compact
  private static readonly COMPACT_THRESHOLD = 8;

  /** Configured vault bridges, or [] if the vault-bridges plugin isn't installed. */
  private getBridges(): BridgeInfo[] {
    try {
      return getVaultBridgesAPI(this.app)?.getBridges() ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Vault-relative path for an absolute file path: directly when the file lives
   * inside the vault, via bridge mapping when it lives in a bridged repo.
   * Returns null for files Obsidian cannot open.
   */
  private toVaultRelPath(filePath: string, bridges: BridgeInfo[]): string | null {
    const adapter = this.app.vault.adapter as { basePath?: string };
    const vaultBase = adapter.basePath ?? '';
    if (vaultBase && filePath.startsWith(vaultBase + path.sep)) {
      return filePath.slice(vaultBase.length + 1);
    }
    return mapToVaultPath(filePath, bridges)?.vaultRelPath ?? null;
  }

  /** Render (or hide) the edited-files card below the chat area. */
  private renderEditedFilesCard(): void {
    this.editedFilesEl.empty();
    if (this.editedFilesSet.size === 0) {
      this.editedFilesEl.addClass('ct-hidden');
      return;
    }
    this.editedFilesEl.removeClass('ct-hidden');

    const iconOnly = this.editedFilesSet.size > ThreadsView.COMPACT_THRESHOLD;
    const list = this.editedFilesEl.createDiv('ct-edited-files-list');

    // Vault files first (most-recently-edited within each group), then non-vault files.
    // Repo files mirrored into the vault by a bridge count as vault files since
    // their synced copy opens inside Obsidian.
    const bridges = this.getBridges();
    const reversed = [...this.editedFilesSet].reverse();
    const relByPath = new Map<string, string | null>();
    for (const f of reversed) relByPath.set(f, this.toVaultRelPath(f, bridges));
    const vaultFiles = reversed.filter(f => relByPath.get(f) != null);
    const nonVaultFiles = reversed.filter(f => relByPath.get(f) == null);
    const files = [...vaultFiles, ...nonVaultFiles];
    for (let i = 0; i < files.length; i++) {
      const filePath = files[i];
      const rel = relByPath.get(filePath) ?? null;
      const isVaultFile = rel != null;
      // Tooltip shows vault-relative path for vault files, full path for external files.
      const tooltipPath = rel ?? filePath;
      const showFull = !iconOnly || i < 3;
      const chip = list.createDiv({
        cls: showFull ? 'ct-edited-file-chip' : 'ct-edited-file-chip ct-edited-file-chip--icon-only',
      });
      const fileIcon = chip.createSpan('ct-edited-file-chip-icon');
      // Vault files get file-edit; external files get link to signal they're outside the vault.
      setIcon(fileIcon, isVaultFile ? 'file-edit' : 'link');
      if (showFull) {
        chip.createSpan({ cls: 'ct-edited-file-chip-name', text: path.basename(filePath) });
      }
      if (this.userModifiedFilesSet.has(filePath)) {
        chip.createSpan({ cls: 'ct-edited-file-chip-modified', text: '✎', attr: { title: 'You modified this file' } });
      }
      setTooltip(chip, tooltipPath);
      chip.addEventListener('click', () => this.openEditedFile(filePath));
    }

    // Focus button as a small icon chip at the end of the list
    const focusLabel = this.plugin.isConversationFirst() ? 'Open edited files in companion' : 'Open only these files';
    const focusChip = list.createDiv({ cls: 'ct-edited-file-chip ct-focus-files-chip', attr: { title: focusLabel } });
    setTooltip(focusChip, focusLabel);
    const focusIcon = focusChip.createSpan('ct-edited-file-chip-icon');
    setIcon(focusIcon, 'focus');
    focusChip.addEventListener('click', (e) => { e.stopPropagation(); this.focusEditedFiles(); });
  }

  /** Close all markdown tabs and reopen only the files edited in this thread. */
  private async focusEditedFiles(): Promise<void> {
    const workspace = this.app.workspace;
    const bridges = this.getBridges();
    const relPaths: string[] = [];
    for (const filePath of this.editedFilesSet) {
      const rel = this.toVaultRelPath(filePath, bridges);
      if (rel) relPaths.push(rel);
    }

    if (relPaths.length === 0) {
      new Notice('No vault files to focus.');
      return;
    }

    if (this.plugin.isConversationFirst()) {
      const { formatCompanionEditedFilesNotice, resolveFinalCompanionFile } = require('./conversationFirstPlacement') as typeof import('./conversationFirstPlacement');
      const resolved = resolveFinalCompanionFile(relPaths, (relPath) =>
        this.app.vault.getAbstractFileByPath(relPath),
        (candidate) => candidate instanceof TFile,
      );
      if (resolved) await this.plugin.contextPanel.openFile(resolved.file as TFile);
      new Notice(formatCompanionEditedFilesNotice(resolved?.path ?? '', resolved?.validCount ?? 0));
      return;
    }

    // Close all existing markdown leaves
    const leavesToDetach: any[] = [];
    workspace.iterateAllLeaves((leaf: any) => {
      if (leaf.view?.getViewType() === 'markdown') leavesToDetach.push(leaf);
    });
    for (const leaf of leavesToDetach) leaf.detach();

    // Open each file in a new tab
    for (let i = 0; i < relPaths.length; i++) {
      const file = this.app.vault.getAbstractFileByPath(relPaths[i]);
      if (!file) continue;
      const leaf = workspace.getLeaf(i === 0 ? false : 'tab');
      await (leaf as any).openFile(file);
    }

    new Notice(`Focused ${relPaths.length} file${relPaths.length === 1 ? '' : 's'}`);
  }

  /** Open HTML in the Web Viewer when available; otherwise use vault, host, or OS routing. */
  private async openEditedFile(filePath: string): Promise<void> {
    try {
      if (/\.html?$/i.test(filePath) && isWebViewerEnabled(this.app)) {
        this.openLink(toFileUrl(filePath));
        return;
      }

      const adapter = this.app.vault.adapter as { basePath?: string };
      const vaultBase = adapter.basePath ?? '';
      if (vaultBase && filePath.startsWith(vaultBase + path.sep)) {
        const rel = filePath.slice(vaultBase.length + 1);
        const file = this.app.vault.getAbstractFileByPath(rel);
        if (file) {
          if (this.plugin.isConversationFirst()) {
            await this.plugin.contextPanel.openFile(file as import('obsidian').TFile);
          } else {
            const leaf = this.app.workspace.getLeaf(false);
            await (leaf as any).openFile(file);
          }
          return;
        }
      }
      // Repo file mirrored into the vault by a bridge: open the synced vault copy.
      const match = mapToVaultPath(filePath, this.getBridges());
      if (match) {
        const file = this.app.vault.getAbstractFileByPath(match.vaultRelPath);
        if (file) {
          if (this.plugin.isConversationFirst()) {
            await this.plugin.contextPanel.openFile(file as import('obsidian').TFile);
          } else {
            const leaf = this.app.workspace.getLeaf(false);
            await (leaf as any).openFile(file);
          }
          return;
        }
      }
      // Outside the vault. Give the host first refusal: Geode can open a file
      // that sits inside a Project folder the user attached read-only, and
      // going straight to the OS would silently ignore that grant.
      if (await openLocalFileViaHost(this.app, filePath)) return;
      // No host routing (Obsidian) — open with the OS default application.
      const { shell } = require('electron') as { shell: { openPath: (p: string) => Promise<string> } };
      await shell.openPath(filePath);
    } catch (err) {
      new Notice(`Could not open file: ${(err as Error).message}`);
    }
  }

  private renderComposerContext(): void {
    const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;
    const project = thread?.projectId ? this.manager.getProject(thread.projectId) : null;
    const cwd = thread?.cwd || this.plugin.getEffectiveCwd() || os.homedir();
    const label = buildComposerContextLabel(project?.name, cwd);
    const tooltip = project
      ? `Project: ${project.name}. Working directory: ${cwd}`
      : `Working directory: ${cwd}`;
    this.dispatchInput?.setContext(label, tooltip);
  }

  private renderThreadInfo(): void {
    if (!this.activeThreadId) return;
    const thread = this.manager.getThread(this.activeThreadId);
    if (!thread) return;

    this.renderComposerContext();
    this.renderTaskCard();

    // Re-render queue rows in case the thread changed.
    this.renderQueueRows();

    this.renderScheduledActivity();
    this.renderStatusFooter();

    // Thread-orchestrator UI depends on the active thread — refresh on every switch.
    this.renderManagerNotesPanel();
    // Runs before renderMessages() in setActiveThread()'s call path, so its
    // work gets wiped by messagesEl.empty() there — harmless given the
    // idempotency guard in renderProposedReplyCard, and still needed for the
    // other call sites of renderThreadInfo() that aren't preceded by a wipe.
    this.renderProposedReplyCard();
  }

  /**
   * Renders the Claude Code task list as a checklist card pinned above the
   * input panel: completed tasks struck through, the in-progress task bolded
   * with an accent marker, matching the CLI's task view.
   */
  private renderTaskCard(): void {
    if (!this.taskCardEl) return;
    const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : undefined;
    const tasks = thread?.tasks ?? [];
    this.taskCardEl.empty();
    if (tasks.length === 0) {
      this.taskCardEl.addClass('ct-hidden');
      return;
    }
    const allDone = tasks.every(t => t.status === 'completed');
    // If tasks exist but are no longer all done, clear the dismissed flag so the
    // card reappears (e.g. Claude creates new tasks on the next turn).
    if (!allDone && this.activeThreadId) this.taskCardDismissed.delete(this.activeThreadId);
    // Auto-hide after all tasks complete: card dismissed by user moving on.
    if (allDone && this.activeThreadId && this.taskCardDismissed.has(this.activeThreadId)) {
      this.taskCardEl.addClass('ct-hidden');
      return;
    }
    this.taskCardEl.removeClass('ct-hidden');

    const done = tasks.filter(t => t.status === 'completed').length;
    const inProgress = tasks.filter(t => t.status === 'in_progress').length;
    const open = tasks.length - done - inProgress;

    const header = this.taskCardEl.createDiv('ct-task-card-header');
    const chevronEl = header.createSpan({ cls: 'ct-task-card-chevron' });
    setIcon(chevronEl, this.taskCardCollapsed ? 'chevron-right' : 'chevron-down');
    header.createSpan({
      cls: 'ct-task-card-title',
      text: `${tasks.length} task${tasks.length === 1 ? '' : 's'}`,
    });
    header.createSpan({
      cls: 'ct-task-card-counts',
      text: `(${done} done, ${inProgress} in progress, ${open} open)`,
    });
    header.addEventListener('click', () => {
      this.taskCardCollapsed = !this.taskCardCollapsed;
      this.renderTaskCard();
    });

    if (this.taskCardCollapsed) return;
    const list = this.taskCardEl.createDiv('ct-task-card-list');
    for (const task of tasks) {
      const row = list.createDiv(`ct-task-row ct-task-row-${task.status}`);
      const iconEl = row.createSpan({ cls: 'ct-task-row-icon' });
      setIcon(iconEl, task.status === 'completed' ? 'circle-check' : task.status === 'in_progress' ? 'loader-circle' : 'circle');
      row.createSpan({ cls: 'ct-task-row-text', text: task.content });
    }
  }

  /**
   * Shows/hides the Manager Notes toggle button in the title row and (when
   * expanded) the collapsible panel below it, driven by the active thread's
   * managerNotes field. Written by the thread-orchestrator skill via
   * obsidian_set_thread_notes — read-only display here, never user-editable,
   * and never injected into any session's context (see ThreadManager.ts).
   */
  private renderManagerNotesPanel(): void {
    if (!this.managerNotesToggleEl || !this.managerNotesPanelEl) return;
    const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;
    const notes = thread?.managerNotes;

    this.managerNotesToggleEl.toggleClass('ct-hidden', !notes);
    this.nativeManagerNotesActionEl?.toggleClass('ct-hidden', !notes);

    this.managerNotesPanelEl.empty();
    if (!notes || this.managerNotesCollapsed) {
      this.managerNotesPanelEl.addClass('ct-hidden');
      return;
    }
    this.managerNotesPanelEl.removeClass('ct-hidden');

    const header = this.managerNotesPanelEl.createDiv('ct-manager-notes-header');
    header.createSpan({ cls: 'ct-manager-notes-title', text: 'Manager Notes' });
    const closeBtn = header.createEl('button', {
      cls: 'ct-manager-notes-close',
      text: '\u00d7',
      attr: { title: 'Collapse' },
    });
    closeBtn.addEventListener('click', () => {
      this.managerNotesCollapsed = true;
      this.renderManagerNotesPanel();
    });

    const expectedOwner = thread.projectId
      ? this.manager.getProject(thread.projectId)?.orchestratorThreadId
      : this.plugin.settings.orchestratorThreadId;
    const source = thread.managerNotesSourceThreadId;
    const sourceTitle = source ? this.manager.getThread(source)?.title ?? source : 'Legacy source unknown';
    const updated = thread.managerNotesUpdatedAt ? new Date(thread.managerNotesUpdatedAt).toLocaleString() : 'Legacy timestamp unknown';
    const stale = !!source && source !== expectedOwner;
    this.managerNotesPanelEl.createDiv({
      cls: `ct-manager-notes-provenance${stale ? ' ct-manager-notes-stale' : ''}`,
      text: `${stale ? 'Stale ownership · ' : ''}${sourceTitle} · ${updated}`,
    });
    this.managerNotesPanelEl.createEl('pre', { cls: 'ct-manager-notes-text', text: notes });
  }

  /**
   * Renders the proposed-reply card inline in the conversation flow — a direct
   * child of `messagesEl`, mirroring renderPlanCard/renderQuestionCard — when
   * the active thread has an AI-proposed reply awaiting approval
   * (thread.proposedReply, set by the thread-orchestrator skill via
   * obsidian_set_thread_proposed_reply). Approve & Send is the ONLY path that
   * ever sends it — nothing in this file (or anywhere else) sends a proposed
   * reply automatically. The proposedReply is cleared as soon as the user acts
   * (approve/edit/discard) rather than waiting for the send to complete, so a
   * long-running turn can't leave a stale card where a second click would
   * trigger a duplicate send.
   *
   * This used to render into a small `<div class="ct-proposed-reply-banner">`
   * inside the docked floating panel, which collapses to a sliver whenever the
   * mouse isn't over it — unusable for anything but the shortest replies.
   * Unlike a plan or question card, a proposed reply isn't scoped to "this
   * turn" (another thread's orchestrator can stage one at any time), so it's
   * anchored straight to `this.messagesEl` rather than via `cardContainer()`.
   *
   * Idempotency guard: this method is called both on real proposal changes
   * (the 'proposed_reply_changed' event) and from renderThreadInfo(), which
   * itself fires on lots of unrelated refreshes (cwd/project/permission-mode
   * changes, etc). Each card is tagged with the proposal's `generatedAt`
   * timestamp; if a card already showing that exact proposal exists, this is
   * a no-op — otherwise every one of those unrelated refreshes would rebuild
   * the card and yank the scroll position.
   */
  private renderProposedReplyCard(): void {
    const threadId = this.activeThreadId;
    const thread = threadId ? this.manager.getThread(threadId) : null;
    const proposed = thread?.proposedReply;

    const existing = this.messagesEl.querySelector<HTMLElement>('.ct-proposed-reply-card');
    if (!threadId || !thread || !proposed) {
      existing?.remove();
      return;
    }

    if (existing && existing.dataset.generatedAt === String(proposed.generatedAt)) {
      // Already showing this exact proposal — nothing to do.
      return;
    }
    existing?.remove();

    const card = this.messagesEl.createDiv('ct-proposed-reply-card');
    card.dataset.generatedAt = String(proposed.generatedAt);

    const header = card.createDiv('ct-proposed-reply-header');
    const iconEl = header.createSpan('ct-proposed-reply-icon');
    setIcon(iconEl, 'reply');
    header.createSpan({ cls: 'ct-proposed-reply-label', text: 'Proposed reply' });

    const bodyEl = card.createDiv('ct-proposed-reply-body');
    const mdEl = bodyEl.createDiv('ct-proposed-reply-md');
    // renderMarkdown is async — fire-and-forget; content fills in immediately
    this.renderMarkdown(proposed.text, mdEl).catch(() => {
      mdEl.setText(proposed.text);
    });

    const actions = card.createDiv('ct-proposed-reply-actions');

    const clearProposedReply = (id: string) => {
      const t = this.manager.getThread(id);
      if (!t) return;
      delete t.proposedReply;
      this.manager.notifyProposedReplyChanged(id);
      void this.plugin.saveSettings();
    };

    const editBtn = actions.createEl('button', { cls: 'ct-proposed-reply-edit', text: 'Edit' });
    editBtn.addEventListener('click', () => {
      const t = this.manager.getThread(threadId);
      const text = t?.proposedReply?.text;
      if (!text) return;
      clearProposedReply(threadId);
      if (threadId === this.activeThreadId) {
        this.dispatchInput?.setValue(text);
      }
    });

    const discardBtn = actions.createEl('button', { cls: 'ct-proposed-reply-discard', text: 'Discard' });
    discardBtn.addEventListener('click', () => {
      clearProposedReply(threadId);
    });

    // Last, with margin-left: auto in CSS, so Edit/Discard sit left and
    // Approve is pushed right — matching the plan card's action-bar convention.
    const approveBtn = actions.createEl('button', { cls: 'ct-proposed-reply-approve', text: 'Approve & Send' });
    approveBtn.addEventListener('click', async () => {
      const t = this.manager.getThread(threadId);
      const text = t?.proposedReply?.text;
      if (!text) return;
      clearProposedReply(threadId);
      try {
        await this.manager.sendMessage(threadId, text);
      } catch (err) {
        console.error('[claude-threads] failed to send approved proposed reply:', err);
        new Notice('Failed to send the approved reply — see console for details.');
      }
    });

    this.scrollToBottom();
  }

  private toggleMoreMenu(event: MouseEvent): void {
    const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;
    if (!thread) return;

    const menu = new Menu();
    menu.addItem(item => item
      .setTitle(`Model: ${this.currentModelLabel()}`)
      .setIcon('cpu')
      .onClick(() => this.toggleModelMenu(event))
    );
    menu.addItem(item => item
      .setTitle(`Permissions: ${this.currentPermissionLabel()}`)
      .setIcon('shield')
      .onClick(() => this.togglePermissionModeMenu(event))
    );
    menu.addSeparator();
    menu.addItem(item =>
      item
        .setTitle(this.compressedView ? 'Expand view' : 'Compress view')
        .setIcon(this.compressedView ? 'maximize-2' : 'minimize-2')
        .onClick(() => this.toggleCompressView())
    );
    menu.addSeparator();
    menu.addItem(item =>
      item
        .setTitle('Summarize thread')
        .setIcon('brain-circuit')
        .onClick(() => this.summarizeThread(thread.id))
    );
    menu.addItem(item =>
      item
        .setTitle('Fork conversation')
        .setIcon('git-branch')
        .onClick(() => this.forkThread(thread.id))
    );
    // Orchestrator threads are pinned to their scope by ThreadManager.setThreadProject,
    // so offering the move would only ever produce an error notice.
    if (this.canMoveToProject(thread.id)) {
      menu.addSeparator();
      menu.addItem(item =>
        item
          .setTitle('Move to Project…')
          .setIcon('folder')
          .onClick(() => this.openMoveToProjectMenu(event, thread.id))
      );
    }
    menu.showAtMouseEvent(event);
  }

  private toggleComposerContextMenu(event: MouseEvent): void {
    const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;
    if (!thread) return;
    const project = thread.projectId ? this.manager.getProject(thread.projectId) : null;
    const cwd = thread.cwd || this.plugin.getEffectiveCwd() || os.homedir();
    const menu = new Menu();
    menu.addItem(item => item.setTitle(`Project: ${project?.name ?? 'No project'}`).setIcon('folder'));
    menu.addItem(item => item.setTitle(`Working directory: ${cwd}`).setIcon('folder-open'));
    if (this.canMoveToProject(thread.id)) {
      menu.addSeparator();
      menu.addItem(item => item
        .setTitle('Change project…')
        .setIcon('folder-cog')
        .onClick(() => this.openMoveToProjectMenu(event, thread.id))
      );
    }
    menu.showAtMouseEvent(event);
  }

  /** Settings + live Projects, in the shape the orchestrator helpers expect. */
  private orchestratorContext(): OrchestratorContext {
    return {
      portfolioThreadId: this.plugin.settings.orchestratorThreadId,
      projects: this.manager.getProjects(),
    };
  }

  /**
   * False for the Portfolio orchestrator and for any thread that owns a Project —
   * `ThreadManager.setThreadProject` always throws for those.
   */
  private canMoveToProject(threadId: string): boolean {
    return !isOrchestratorThread(threadId, this.orchestratorContext());
  }

  /**
   * Second-level Project picker for `Move to Project…`. Opened as a separate Menu at the
   * same mouse event rather than `MenuItem.setSubmenu()`, which is absent from the pinned
   * obsidian typings and from the 1.0.0 minAppVersion this plugin supports.
   */
  private openMoveToProjectMenu(event: MouseEvent, threadId: string): void {
    const thread = this.manager.getThread(threadId);
    if (!thread) return;
    const menu = new Menu();
    menu.addItem(item =>
      item
        .setTitle('(No project)')
        .setChecked(!thread.projectId)
        .onClick(() => this.moveThreadToProject(threadId, null))
    );
    for (const project of this.manager.getProjects()) {
      menu.addItem(item =>
        item
          .setTitle(project.name)
          .setIcon('folder')
          .setChecked(thread.projectId === project.id)
          .onClick(() => this.moveThreadToProject(threadId, project.id))
      );
    }
    menu.showAtMouseEvent(event);
  }

  /**
   * Applies a Project move from the ⋯ menu. Uses alignCwd so the thread lands in the
   * Project's working directory, which also starts a fresh session — announced in the
   * Notice rather than happening silently. Detach ignores alignCwd by design.
   */
  private async moveThreadToProject(threadId: string, projectId: string | null): Promise<void> {
    try {
      this.manager.setThreadProject(threadId, projectId, true);
      await this.plugin.saveSettings();
      if (threadId === this.activeThreadId) {
        this.renderComposerContext();
      }
      const project = projectId ? this.manager.getProject(projectId) : null;
      new Notice(
        project
          ? `Moved to ${project.name}. Working directory switched to the Project folder; the next message starts a new session.`
          : 'Removed from Project. Working directory is unchanged.',
      );
    } catch (err: unknown) {
      new Notice(err instanceof Error ? err.message : String(err));
    }
  }

  /** Returns the model active for the current thread, or undefined for the global default. */
  private currentModel(): string | undefined {
    const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;
    return thread?.model ?? undefined;
  }

  private currentModelLabel(): string {
    const escalated = this.activeThreadId
      ? this.escalatedTurnModels.get(this.activeThreadId)
      : undefined;
    if (escalated) return `${escalated} (this turn)`;
    const model = this.currentModel();
    if (!model) return 'Default';
    const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;
    const options = thread?.agentHarness === 'codex'
      ? this.plugin.discoveredModelsByHarness.codex.map((m) => ({ label: m.displayName, value: m.value }))
      : ThreadsView.CLAUDE_MODEL_OPTIONS;
    return options.find(option => option.value === model)?.label ?? model;
  }

  /**
   * Clears the escalated-turn marker for a thread at turn end and refreshes
   * the model button when that thread is the active one.
   */
  private clearEscalatedTurn(threadId: string): void {
    if (!this.escalatedTurnModels.delete(threadId)) return;
    // The value is read when the actions menu next opens.
  }

  private toggleModelMenu(event: MouseEvent): void {
    if (!this.activeThreadId) return;
    const current = this.currentModel();
    const menu = new Menu();
    const thread = this.manager.getThread(this.activeThreadId);
    const options = thread?.agentHarness === 'codex'
      ? [{ label: 'Default', value: undefined }, ...this.plugin.discoveredModelsByHarness.codex.map((m) => ({ label: m.displayName, value: m.value }))]
      : ThreadsView.CLAUDE_MODEL_OPTIONS;
    for (const opt of options) {
      menu.addItem(item => {
        item
          .setTitle(opt.label)
          .setChecked(current === opt.value)
          .onClick(async () => {
            if (!this.activeThreadId) return;
            this.manager.setThreadModel(this.activeThreadId, opt.value);
            await this.plugin.saveSettings();
            this.renderThreadInfo();
          });
      });
    }
    menu.showAtMouseEvent(event);
  }

  private currentPermissionMode(): import('./types').PluginSettings['permissionMode'] | undefined {
    const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;
    return thread?.permissionMode ?? undefined;
  }

  private currentPermissionLabel(): string {
    const mode = this.currentPermissionMode();
    const opt = ThreadsView.PERMISSION_MODE_OPTIONS.find(o => o.value === mode);
    return opt?.label ?? 'Global default';
  }

  private togglePermissionModeMenu(event: MouseEvent): void {
    if (!this.activeThreadId) return;
    const current = this.currentPermissionMode();
    const menu = new Menu();
    for (const opt of ThreadsView.PERMISSION_MODE_OPTIONS) {
      menu.addItem(item => {
        item
          .setTitle(opt.label)
          .setChecked(current === opt.value)
          .onClick(async () => {
            if (!this.activeThreadId) return;
            this.manager.setThreadPermissionMode(this.activeThreadId, opt.value);
            await this.plugin.saveSettings();
            this.renderThreadInfo();
          });
      });
    }
    menu.showAtMouseEvent(event);
  }

  private toggleCompressView(): void {
    this.compressedView = !this.compressedView;
    this.summaryGeneration++; // cancel any queued summary jobs from the previous render
    this.summaryTextEls.clear();
    this.groupSummaryCache.clear();
    this.expandedToolGroups.clear();
    this.liveExpandedToolGroups.clear();
    this.expandedOuterToolWrap.clear();
    this.liveExpandedOuterToolWrap.clear();
    void this.renderMessages();
  }

  private async runSummarize(
    messages: ChatMessage[],
    thread?: Thread,
    onProgress?: (s: string) => void,
  ): Promise<SummarizeResult> {
    return this.plugin.inProcessSummarizer.summarize(
      messages,
      this.plugin.settings.claudeBinaryPath,
      this.plugin.settings.inprocessModel,
      effectiveExtraEnv(this.plugin.settings),
      onProgress,
      thread?.summary,
      thread?.lastSummarizedAt,
      thread?.title,
    );
  }

  private generateMessageSummary(msg: ChatMessage): void {
    if (msg.summary) return;
    // Capture the current generation so we can detect stale jobs after awaiting.
    const gen = this.summaryGeneration;
    // Chain onto the serial queue — only ONE summarizeMessage() call runs at a time, no matter
    // how many messages need summaries. Each job checks `gen` before starting and after the
    // async call so that toggling compress-off (or switching threads) discards pending work.
    this.summaryQueue = this.summaryQueue.then(async () => {
      if (gen !== this.summaryGeneration) return; // view was toggled or thread changed — skip
      if (msg.summary) return; // already summarised by an earlier job in the queue
      try {
        const summary = await this.plugin.inProcessSummarizer.summarizeMessage(
          msg.content,
          this.plugin.settings.claudeBinaryPath,
          this.plugin.settings.inprocessModel,
          effectiveExtraEnv(this.plugin.settings),
        );
        if (gen !== this.summaryGeneration) return; // stale after the async call — discard
        if (!summary) return; // empty content — nothing was summarized, leave the row alone
        msg.summary = summary;
        await this.plugin.saveSettings();
        // Update the DOM span if still visible
        const el = this.summaryTextEls.get(msg.id);
        if (el) el.textContent = summary;
      } catch (err) {
        if (gen !== this.summaryGeneration) return;
        console.error('[Agent Threads] message summary error:', err);
        const el = this.summaryTextEls.get(msg.id);
        if (el) el.textContent = msg.content.slice(0, 120) + '…';
      }
    });
  }

  private async renderMarkdown(
    markdown: string,
    el: HTMLElement,
    options: { streaming?: boolean } = {},
  ): Promise<void> {
    // Codex's `visualize` skill puts a wrapped content reference on its own line
    // where an inline visual belongs. Rewrite those lines into anchor
    // placeholders here, before marked runs, so the markdown is parsed exactly
    // once — splitting into segments and parsing each would break ordered-list
    // numbering, reference links, and footnotes that span a marker.
    const visualize = this.plugin.settings.enableInlineVisualizations !== false
      ? extractVisualizeMarkers(markdown, { streaming: options.streaming })
      : { text: markdown, markers: [] };

    // Pre-process [[wikilinks]] and [[target|alias]] into inline HTML anchors
    // before handing off to marked. marked passes inline HTML through unchanged,
    // so GFM table parsing (and all other markdown features) work correctly.
    // This replaces the previous MarkdownRenderer.render() approach which did not
    // render GFM pipe tables in this non-document context.
    const processed = visualize.text.replace(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_match, target: string, alias?: string) => {
        const label = (alias ?? target.split('/').pop() ?? target).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c] ?? c));
        const escapedTarget = target.replace(/"/g, '&quot;');
        return `<a class="internal-link" data-href="${escapedTarget}" href="#">${label}</a>`;
      },
    );
    el.appendChild(sanitizeHTMLToDom(await marked.parse(processed)));
    // Swap the placeholders for live cards. Iframes mount only on settled
    // messages — during streaming the marker renders as inert card chrome, so
    // a frame is never rebuilt on every token.
    this.visualizeManager?.hydrate(el, visualize.markers, { interactive: !options.streaming });
    // Wrap tables in a scrollable container so wide tables don't overflow.
    el.querySelectorAll<HTMLTableElement>('table').forEach((table) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'ct-table-scroll';
      table.parentNode?.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    });
    // Wire up click handlers for [[wikilink]] anchors.
    el.querySelectorAll<HTMLAnchorElement>('a.internal-link').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const href = a.getAttribute('data-href') ?? a.getAttribute('href') ?? '';
        // Both placements resolve against the thread's own note, so a wikilink
        // lands on the same target regardless of where the conversation is
        // docked — and matches the plain-markdown-link handler below.
        const sourcePath = this.activeThreadId ? this.manager.getThread(this.activeThreadId)?.noteFile ?? '' : '';
        if (this.plugin.isConversationFirst()) {
          void this.plugin.contextPanel.openLinkText(href, sourcePath);
        } else {
          void this.app.workspace.openLinkText(href, sourcePath, false);
        }
      });
    });
    // marked renders ordinary `[label](path.md#heading)` links without the
    // custom wikilink class. Intercept only relative/vault-shaped hrefs;
    // protocols and same-page anchors retain the browser/host's standard
    // behavior. Some hrefs are OS-absolute paths that happen to fall under the
    // vault root (e.g. a fragment written from outside Obsidian) — resolve
    // those to a vault-relative path before handing them to the open calls,
    // which expect vault linktext, not filesystem paths.
    el.querySelectorAll<HTMLAnchorElement>('a:not(.internal-link):not(.ct-visualize-slot)').forEach((a) => {
      const href = a.getAttribute('href') ?? '';
      if (classifyRenderedMarkdownLink(href) !== 'vault') return;
      const absolute = isOsAbsoluteHref(href);
      a.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        // Resolved on click, not at render: an agent frequently writes a file
        // and links to it in the same turn, so the vault copy may only appear
        // (or finish syncing) after this message was rendered. Probing here
        // means the link starts working as soon as the target exists.
        //
        // Only absolute paths need rewriting; marked percent-encodes the hrefs
        // it emits, which resolveAbsoluteVaultHref accounts for when probing.
        // An ordinary relative href is forwarded untouched — the open calls
        // parse the `#subpath` and do their own decoding, so decoding it here
        // would both double-decode and strip that responsibility from its
        // rightful owner.
        const resolved = resolveAbsoluteVaultHref(href, (p) => !!this.app.vault.getAbstractFileByPath(p));
        // An absolute filesystem path we could not map into the vault is NOT
        // vault linktext. Forwarding it would ask the host to open an
        // unresolved link, which can create a stray note named after the
        // path — the same hazard linkifyBridgePaths guards against below.
        if (absolute && !resolved) {
          new Notice('That link points outside this vault.');
          return;
        }
        const target = resolved ?? href;
        const sourcePath = this.activeThreadId ? this.manager.getThread(this.activeThreadId)?.noteFile ?? '' : '';
        if (this.plugin.isConversationFirst()) {
          void this.plugin.contextPanel.openLinkText(target, sourcePath);
        } else {
          void this.app.workspace.openLinkText(target, sourcePath, false);
        }
      });
    });
    // http(s) links get no listener above (classifyRenderedMarkdownLink calls
    // them 'external'), so they fall through to the host's default anchor
    // click behavior. That default does not know about conversation-first
    // placement: it does not route through the Web Viewer's destination-leaf
    // logic, so the page can open in the wrong tab (or the system browser)
    // instead of the adjacent context panel. Wire these through the same
    // openLink() the footer pills use, which already branches correctly.
    // Only http(s) is intercepted — mailto:, obsidian:, and other
    // custom-protocol links keep the host/OS's own handler.
    el.querySelectorAll<HTMLAnchorElement>('a:not(.internal-link):not(.ct-visualize-slot)').forEach((a) => {
      const href = a.getAttribute('href') ?? '';
      if (classifyRenderedMarkdownLink(href) !== 'external') return;
      if (!/^https?:\/\//i.test(href.trim())) return;
      a.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        // Cmd-click (Mac) / Ctrl-click (other) forces the system browser even
        // when the Web Viewer is enabled — matching the footer pill and
        // Obsidian's own "open in default app" modifier convention.
        this.openLink(href, event.metaKey || event.ctrlKey);
      });
    });
    this.linkifyBridgePaths(el);
  }

  /**
   * Convert absolute file paths that fall inside a configured Vault Bridge's
   * source repo into clickable internal links targeting the synced vault copy.
   * Walks rendered text nodes (including inline code, excluding <pre> blocks
   * and existing anchors) so markdown structure is never disturbed. Only paths
   * whose vault copy actually exists are linkified, so clicking can never
   * create a stray note.
   */
  private linkifyBridgePaths(root: HTMLElement): void {
    const bridges = this.getBridges();
    if (bridges.length === 0) return;

    // One regex matching any bridge root prefix followed by a path tail.
    // Longer prefixes first so nested roots resolve to the deepest match.
    const prefixes = new Set<string>();
    for (const b of bridges) {
      for (const base of [b.repoPath, b.activeWorktreePath]) {
        if (base) prefixes.add(base.replace(/\\/g, '/').replace(/\/+$/, ''));
      }
    }
    if (prefixes.size === 0) return;
    const escaped = [...prefixes]
      .sort((a, b) => b.length - a.length)
      .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pathRe = new RegExp(`(?:${escaped.join('|')})(?:/[^\\s)\\]}"'\`<>:]+)+`, 'g');

    // Collect text nodes first; mutating the tree during the walk is unsafe.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = (node as Text).parentElement;
        if (!parent || parent.closest('pre, a')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const textNodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n as Text);

    for (const tn of textNodes) {
      const text = tn.textContent ?? '';
      let last = 0;
      let frag: DocumentFragment | null = null;
      pathRe.lastIndex = 0;
      for (let m = pathRe.exec(text); m; m = pathRe.exec(text)) {
        // Trim trailing sentence punctuation picked up by the greedy tail.
        const matchText = m[0].replace(/[.,;:!?]+$/, '');
        const mapped = mapToVaultPath(matchText, bridges);
        if (!mapped || !this.app.vault.getAbstractFileByPath(mapped.vaultRelPath)) continue;
        if (!frag) frag = document.createDocumentFragment();
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const a = document.createElement('a');
        a.className = 'internal-link';
        a.setAttribute('data-href', mapped.vaultRelPath);
        a.setAttribute('href', '#');
        a.textContent = matchText;
        setTooltip(a, mapped.vaultRelPath);
        a.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (this.plugin.isConversationFirst()) {
            void this.plugin.contextPanel.openLinkText(mapped.vaultRelPath);
          } else {
            void this.app.workspace.openLinkText(mapped.vaultRelPath, '', false);
          }
        });
        frag.appendChild(a);
        last = m.index + matchText.length;
      }
      if (frag) {
        frag.appendChild(document.createTextNode(text.slice(last)));
        tn.replaceWith(frag);
      }
    }
  }

  /**
   * Render a run of consecutive assistant messages as a single collapsible block.
   * A single-message group falls through to the normal appendMessage path so that
   * the existing per-message summary/expand logic is reused.
   */
  private async appendAssistantGroup(group: ChatMessage[]): Promise<HTMLElement | null> {
    if (group.length === 0) return null;
    if (group.length === 1) {
      // Single message — reuse normal compressed rendering
      return await this.appendMessage(group[0]);
    }

    const groupKey = group.map(m => m.id).join(':');
    const cachedSummary = this.groupSummaryCache.get(groupKey);

    const el = this.messagesEl.createDiv('ct-message ct-message-assistant ct-message-compressed');

    const content = el.createDiv('ct-message-content');
    const collapsedRow = content.createDiv('ct-compressed-row');
    const summaryTextEl = collapsedRow.createSpan({
      cls: 'ct-compressed-summary',
      text: cachedSummary ?? 'Summarizing…',
    });

    // Expand button is inside collapsedRow so it sits inline with the summary text
    const expandBtn = collapsedRow.createEl('button', { cls: 'ct-expand-btn', attr: { title: 'Expand' } });
    setIcon(expandBtn, 'chevron-down');

    // Full content (hidden) — render each sub-message with its tool calls
    const fullContent = content.createDiv('ct-full-content ct-hidden');
    let lastMsgEl: HTMLElement | null = null;
    for (const msg of group) {
      const msgEl = fullContent.createDiv('ct-message ct-message-assistant');
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        this.renderToolCalls(msgEl, msg.toolCalls);
      }
      const msgContent = msgEl.createDiv('ct-message-content');
      await this.renderMarkdown(msg.content, msgContent);
      lastMsgEl = msgEl;
    }

    let expanded = false;
    expandBtn.addEventListener('click', () => {
      expanded = !expanded;
      if (expanded) {
        summaryTextEl.addClass('ct-hidden');
        fullContent.removeClass('ct-hidden');
      } else {
        summaryTextEl.removeClass('ct-hidden');
        fullContent.addClass('ct-hidden');
      }
      setIcon(expandBtn, expanded ? 'chevron-up' : 'chevron-down');
    });

    // Enqueue group summary generation if not yet cached
    if (!cachedSummary) {
      this.generateGroupSummary(group, groupKey, summaryTextEl);
    }

    return lastMsgEl;
  }

  /** Generate a single summary for a group of consecutive assistant messages. */
  private generateGroupSummary(group: ChatMessage[], groupKey: string, el: HTMLElement): void {
    const gen = this.summaryGeneration;
    this.summaryQueue = this.summaryQueue.then(async () => {
      if (gen !== this.summaryGeneration) return;
      const already = this.groupSummaryCache.get(groupKey);
      if (already) { el.textContent = already; return; }
      try {
        // Concatenate all turns into one block so the summarizer sees the full run
        const combined = group.map(m => m.content).join('\n\n');
        const summary = await this.plugin.inProcessSummarizer.summarizeMessage(
          combined,
          this.plugin.settings.claudeBinaryPath,
          this.plugin.settings.inprocessModel,
          effectiveExtraEnv(this.plugin.settings),
        );
        if (gen !== this.summaryGeneration) return;
        if (!summary) return; // empty content — nothing was summarized, leave the row alone
        this.groupSummaryCache.set(groupKey, summary);
        el.textContent = summary;
      } catch (err) {
        if (gen !== this.summaryGeneration) return;
        console.error('[Agent Threads] group summary error:', err);
        // Fall back to last message's content truncated
        el.textContent = group[group.length - 1].content.slice(0, 120) + '…';
      }
    });
  }

  async summarizeThread(threadId: string): Promise<void> {
    const thread = this.manager.getThread(threadId);
    if (!thread || thread.messages.length === 0) return;

    this.moreBtn.disabled = true;
    setIcon(this.moreBtn, 'loader');
    this.moreBtn.addClass('ct-summarize-spinning');

    const onProgress = (status: string) => {
      this.showStatusCard('active', status);
    };

    try {
      // Cursor captured before the call — see the auto path for why.
      const summarizedThrough = Date.now();
      const result = await this.runSummarize(thread.messages, thread, onProgress);
      // An empty string means "no update" (empty transcript, NO_SUMMARY
      // sentinel, or an unparseable response) — assigning it unconditionally
      // would blank a perfectly good existing summary.
      const summaryChanged = Boolean(result.summary);
      const titleChanged = Boolean(result.title) && isUsableTitle(result.title);
      if (summaryChanged) thread.summary = result.summary;
      thread.lastSummarizedAt = summarizedThrough;
      // Manual summarize always applies the new title; auto-summarize (after each
      // completed turn) uses applyAutoTitle which guards against overwriting a
      // user-set name.
      if (titleChanged) this.manager.renameThread(thread.id, result.title);
      if (!summaryChanged && !titleChanged) {
        new Notice('Nothing new to summarize — summary left unchanged.', 5000);
      }
      await this.plugin.saveSettings();
      this.clearStatusCard('active');
      this.moreBtn.removeClass('ct-summarize-spinning');
      setIcon(this.moreBtn, 'menu');
      this.moreBtn.disabled = false;
      this.renderTitleBar();
      this.renderThreadInfo();
      this.refreshLeafHeader();
      // Refresh the Agent Dashboard so the new summary appears there immediately
      this.plugin.getAgentDashboard()?.render();
    } catch (err) {
      console.error('[Agent Threads] summarize error:', err);
      this.clearStatusCard('active');
      this.moreBtn.removeClass('ct-summarize-spinning');
      setIcon(this.moreBtn, 'menu');
      this.moreBtn.disabled = false;
      new Notice(`Summarization failed: ${(err as Error).message}`, 8000);
    }
  }

  async forkThread(threadId: string, initialFocus?: string): Promise<void> {
    const thread = this.manager.getThread(threadId);
    if (!thread || thread.messages.filter(m => m.role !== 'compact' && m.role !== 'notice').length === 0) {
      new Notice('Nothing to fork — thread has no messages yet.');
      return;
    }

    new ForkModal(this.app, this.plugin, thread, async (prompt: string) => {
      const forkedThread = this.manager.createThread(
        `Fork: ${thread.title.slice(0, 40)}`,
        thread.cwd,
        thread.projectId,
      );
      await this.plugin.saveSettings();
      void this.setActiveThread(forkedThread.id);
      // Fire-and-forget: switch to the new thread and close the modal immediately
      // without waiting for Claude's response. The first message appears as the
      // thread loads, giving instant feedback instead of a frozen "Opening..." state.
      void this.manager.sendMessage(forkedThread.id, prompt);
    }, initialFocus).open();
  }

  private createStreamingEl(label = 'Claude is thinking'): void {
    this.streamingEl = this.messagesEl.createDiv('ct-message ct-message-assistant ct-streaming');
    this.streamingContentEl = this.streamingEl.createDiv('ct-message-content');
    this.streamingContentEl.createSpan({ cls: 'ct-thinking-spinner', attr: { 'aria-label': label } });
    this.streamingContentEl.createSpan({ cls: 'ct-cursor' });
    // Fresh streamingEl — any previous tools wrapper is gone with it (or about
    // to be replayed via renderLiveToolCalls if buf.tools carries anything over).
    this.streamingToolsEl = null;
  }

  /**
   * Lazily creates (or returns the existing) `.ct-tools` wrapper inside the
   * current streamingEl, inserted as the FIRST child so live tool calls sit
   * above the streamed text — matching the finalized layout (renderToolCalls
   * is always called before the `.ct-message-content` div in appendMessage),
   * which avoids a visual jump when the turn settles.
   *
   * Must stay lazy: `.ct-tools` carries `margin-bottom: 6px` even when empty,
   * so creating it unconditionally on every streaming turn (even ones with no
   * tool calls) would shift the layout of turns that never call a tool — a
   * real regression caught in an earlier pass at this feature.
   */
  private ensureStreamingToolsEl(): HTMLElement {
    if (this.streamingToolsEl && this.streamingToolsEl.isConnected) return this.streamingToolsEl;
    const wrapper = document.createElement('div');
    wrapper.className = 'ct-tools';
    this.streamingEl!.prepend(wrapper);
    this.streamingToolsEl = wrapper;
    return wrapper;
  }

  /**
   * Resolve an <img> src for a message image (ADR-0003, PR 1). When the image
   * has been externalized to a vault file (`path` set) and we're on desktop,
   * use the synchronous `app://` resource URL so the render stays synchronous
   * and doesn't depend on the inline base64 (which is stripped from data.json
   * after a restart). Otherwise fall back to the inline base64 data URL,
   * including on mobile, where a desktop attachment path can't be resolved.
   */
  private imageSrc(ref: { path?: string; mediaType: string }, inlineData: string | undefined): string {
    if (ref.path) {
      const adapter = this.app.vault.adapter;
      if (adapter instanceof FileSystemAdapter) {
        try {
          return adapter.getResourcePath(ref.path);
        } catch {
          // Fall through to base64 if the path can't be resolved.
        }
      }
    }
    return `data:${ref.mediaType};base64,${inlineData ?? ''}`;
  }

  private async renderMessages(): Promise<void> {
    this.messagesEl.empty();
    this.messagesEl.removeClass('ct-messages-agent-view');
    this.agentViewBodyEl = null;
    this.clearStreamingState();
    this.streamingEl = null;

    if (!this.activeThreadId) return;
    const thread = this.manager.getThread(this.activeThreadId);
    if (!thread) return;
    this.renderAgentPill();

    // A selected sub-agent takes over the message pane entirely. The composer
    // below stays live; only its placeholder changes.
    const agentViewId = this.resolveAgentViewId();
    if (agentViewId) {
      this.renderAgentConversation(agentViewId);
      this.setRunningState(this.manager.isRunning(this.activeThreadId));
      return;
    }

    if (thread.messages.length === 0) {
      const empty = this.messagesEl.createDiv('ct-empty');
      const iconEl = empty.createDiv('ct-empty-icon');
      setIcon(iconEl, 'message-square');
      empty.createEl('p', { cls: 'ct-empty-title', text: 'Ask Claude anything' });
      const cwdEl = empty.createDiv('ct-empty-sub');
      const folderIcon = cwdEl.createSpan('ct-empty-sub-icon');
      setIcon(folderIcon, 'folder');
      cwdEl.createSpan({ text: thread.cwd || os.homedir() });
      empty.createEl('p', { cls: 'ct-empty-hint', text: 'Enter to send · Shift+Enter for newline' });
      return;
    }

    // Re-merge adjacent tool-only assistant messages (one per real SDK turn,
    // see mergeAdjacentToolOnlyMessages doc comment) into single rows so the
    // finalized-message rendering path below has multi-call arrays to group
    // via groupToolCalls() again, instead of fragmenting into one `.ct-message`
    // per raw persisted turn. Purely a view-layer transform — thread.messages
    // itself is untouched.
    const rows = mergeAdjacentToolOnlyMessages(thread.messages);
    let lastRenderedRowEl: HTMLElement | null = null;

    if (this.compressedView) {
      // In compressed view, consecutive assistant rows (between user/compact turns)
      // are grouped into a single collapsible block so agentic runs collapse as one unit.
      let i = 0;
      while (i < rows.length) {
        const msg = rows[i];
        if (msg.role === 'assistant') {
          const group: ChatMessage[] = [];
          while (i < rows.length && rows[i].role === 'assistant') {
            group.push(rows[i++]);
          }
          lastRenderedRowEl = await this.appendAssistantGroup(group);
        } else {
          lastRenderedRowEl = await this.appendMessage(msg);
          i++;
        }
      }
    } else {
      for (const msg of rows) {
        lastRenderedRowEl = await this.appendMessage(msg);
      }
    }

    const streamingBuffer = this.streamingBuffers.get(this.activeThreadId);
    // A buffered token/tool event is also evidence of a live turn. The session
    // registry can briefly report idle while a view switch is in flight, and
    // gating solely on isRunning() would drop that turn's restored tool UI.
    if (this.manager.isRunning(this.activeThreadId) || streamingBuffer) {
      // The tail row (post-merge) may still be an open, growing run — seed the
      // in-place-extension tracking fields so the next live 'message' event
      // recognizes it as "extend this row" rather than fragmenting a fresh one.
      // See the case 'message' handler in handleEvent().
      const lastRow = rows[rows.length - 1];
      if (lastRow && lastRenderedRowEl) {
        this.lastAppendedRowId = lastRow.id;
        this.lastAppendedRowEl = lastRenderedRowEl;
      }
      const buf = streamingBuffer;
      // Use the sub-agent label if the thread is waiting on a sub-agent, otherwise
      // the default "Claude is thinking" placeholder.
      this.createStreamingEl(buf?.subagentLabel ?? 'Claude is thinking');
      // Restore streaming content and tool calls accumulated while this thread
      // was running in the background (user was viewing a different thread).
      if (buf) {
        // Route through the same live-render function the active-thread event
        // handlers use, so the restored view is pixel-for-pixel identical to
        // what it would look like had the user never switched away — same
        // grouping, same chronological order, same pending/active styling.
        if (buf.tools.length > 0) this.renderLiveToolCalls(buf.tools);
        // Restore accumulated text and re-render it into the streaming bubble.
        if (buf.content) {
          this.streamingContent = buf.content;
          this.scheduleStreamingRender();
        }
      }
    }

    // Re-render any pending permission card that was created while viewing another thread
    const pendingPerm = this.pendingPermissions.get(this.activeThreadId!);
    if (pendingPerm && !pendingPerm.cardEl?.isConnected) {
      const cardEl = this.renderPermissionCard(pendingPerm.toolName, pendingPerm.detail, pendingPerm.resolve);
      pendingPerm.cardEl = cardEl;
    }

    // Re-render any pending question card that was created while viewing another thread
    const pendingQ = this.pendingQuestions.get(this.activeThreadId!);
    if (pendingQ && !pendingQ.cardEl?.isConnected) {
      const cardEl = this.renderQuestionCard(pendingQ.questions, pendingQ.resolve);
      pendingQ.cardEl = cardEl;
    }

    // Returning from a child agent view restores where the user left the
    // conversation; every other render still lands at the bottom.
    if (this.pendingMainScroll !== null) {
      const target = this.pendingMainScroll;
      this.pendingMainScroll = null;
      requestAnimationFrame(() => { this.messagesEl.scrollTop = target; });
    } else {
      this.scrollToBottom();
    }
    this.setRunningState(this.manager.isRunning(this.activeThreadId));
  }

  // ── Sub-agent pill, popover and in-place activity view ────────────────────

  /**
   * Refreshes the composer-footer pill. The pill is the only always-visible
   * agent surface: `.ct-hidden` while a thread has no sub-agents, and while it is
   * visible a `:has()` rule in styles.css pins the otherwise hover-only footer
   * open so agent status never hides behind a hover.
   */
  private renderAgentPill(): void {
    if (!this.agentPillEl) return;
    const runs = this.activeThreadId ? this.manager.getAgentRuns(this.activeThreadId) : [];
    const summary = summarizeAgentTeam(runs);

    this.agentPillEl.toggleClass('ct-hidden', summary.total === 0);
    const textEl = this.agentPillEl.querySelector('.ct-agent-pill-text');
    if (textEl) textEl.textContent = summary.label;
    for (const tone of ['active', 'failed', 'done', 'idle']) {
      this.agentPillEl.toggleClass(`ct-agent-pill-${tone}`, tone === summary.tone);
    }
    setTooltip(this.agentPillEl, summary.total === 0 ? 'No sub-agents' : `${summary.label} — open the sub-agent list`);
    if (summary.total === 0) this.closeAgentPopover();
  }

  private toggleAgentPopover(): void {
    if (this.agentPopoverEl) {
      this.closeAgentPopover();
      this.agentPillEl?.focus();
      return;
    }
    this.openAgentPopover();
  }

  /**
   * Opens the agent tree above the composer.
   *
   * The host is `.ct-panel-wrapper`, deliberately NOT `.ct-input-footer`: the
   * footer is the element the collapsible rule gives `overflow: hidden`, so a
   * popover parented there would be clipped to a 50px strip.
   */
  private openAgentPopover(): void {
    if (!this.activeThreadId || !this.agentPillEl) return;
    const wrapper = this.mainEl?.querySelector('.ct-panel-wrapper') as HTMLElement | null;
    if (!wrapper) return;

    const popover = wrapper.createDiv('ct-agent-popover');
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', 'Sub-agents in this thread');
    this.agentPopoverEl = popover;
    this.agentPillEl.setAttribute('aria-expanded', 'true');

    const header = popover.createDiv('ct-agent-popover-header');
    header.createSpan({ cls: 'ct-agent-popover-title', text: 'Sub-agents' });
    const closeBtn = header.createEl('button', {
      cls: 'ct-agent-popover-close',
      attr: { type: 'button', 'aria-label': 'Close sub-agent list' },
    });
    setIcon(closeBtn, 'x');
    closeBtn.addEventListener('click', () => {
      this.closeAgentPopover();
      this.agentPillEl?.focus();
    });

    popover.createDiv('ct-agent-popover-list');
    this.renderAgentPopoverList();

    popover.addEventListener('keydown', (e) => this.onAgentPopoverKeyDown(e));

    // Move focus into the list so arrow keys work without a second click.
    (popover.querySelector('.ct-agent-row-button') as HTMLElement | null)?.focus();

    // Outside-click dismissal, registered next tick so the click that opened the
    // popover does not immediately close it again (mirrors openThreadSwitcher).
    setTimeout(() => {
      const outsideHandler = (e: MouseEvent) => {
        if (!popover.contains(e.target as Node) && !this.agentPillEl?.contains(e.target as Node)) {
          this.closeAgentPopover();
        }
      };
      this.agentPopoverOutsideHandler = outsideHandler;
      document.addEventListener('mousedown', outsideHandler, true);
    }, 0);
  }

  /** Open the native team picker without changing the current agent selection. */
  public openAgentTeamPicker(): void {
    if (!this.agentPopoverEl) this.openAgentPopover();
  }

  /** Escape closes; Up/Down/Home/End move roving focus through the agent rows. */
  private onAgentPopoverKeyDown(e: KeyboardEvent): void {
    const popover = this.agentPopoverEl;
    if (!popover) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.closeAgentPopover();
      this.agentPillEl?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const buttons = [...popover.querySelectorAll<HTMLButtonElement>('.ct-agent-row-button')];
    if (!buttons.length) return;
    e.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    else if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % buttons.length;
    else next = current < 0 ? buttons.length - 1 : (current - 1 + buttons.length) % buttons.length;
    buttons[next].focus();
  }

  /** Repaints the popover's tree in place, so live updates don't close it. */
  private renderAgentPopoverList(): void {
    const list = this.agentPopoverEl?.querySelector('.ct-agent-popover-list') as HTMLElement | null;
    if (!list || !this.activeThreadId) return;
    renderAgentPopoverTree(
      list,
      this.manager.getAgentRuns(this.activeThreadId),
      id => { void this.enterAgentView(id); },
      this.currentAgentViewId(),
    );
  }

  private closeAgentPopover(): void {
    this.agentPopoverEl?.remove();
    this.agentPopoverEl = null;
    if (this.agentPopoverOutsideHandler) {
      document.removeEventListener('mousedown', this.agentPopoverOutsideHandler, true);
      this.agentPopoverOutsideHandler = null;
    }
    this.agentPillEl?.setAttribute('aria-expanded', 'false');
  }

  /** The selected agent id, but only when it still matches a live run. No side effects. */
  private currentAgentViewId(): string | undefined {
    if (!this.activeThreadId) return undefined;
    const selected = this.manager.getSelectedAgentRun(this.activeThreadId);
    if (!selected) return undefined;
    return this.manager.getAgentRuns(this.activeThreadId).some(r => r.id === selected) ? selected : undefined;
  }

  /**
   * Same as currentAgentViewId, but self-heals a stale selection so a thread whose
   * runs were pruned can never get stuck showing an empty child view.
   */
  private resolveAgentViewId(): string | undefined {
    if (!this.activeThreadId) return undefined;
    if (!this.manager.getSelectedAgentRun(this.activeThreadId)) return undefined;
    const live = this.currentAgentViewId();
    if (!live) this.manager.clearSelectedAgentRun(this.activeThreadId);
    return live;
  }

  private agentScrollKey(): string | null {
    if (!this.activeThreadId) return null;
    return `${this.activeThreadId}:${this.currentAgentViewId() ?? 'main'}`;
  }

  /** Stashes the current scroll offset before navigating into or out of a child view. */
  private rememberAgentScroll(): void {
    const key = this.agentScrollKey();
    if (!key || !this.messagesEl) return;
    this.agentScroll.set(key, this.messagesEl.scrollTop);
  }

  private async enterAgentView(agentRunId: string): Promise<void> {
    if (!this.activeThreadId) return;
    this.rememberAgentScroll();
    this.closeAgentPopover();
    this.manager.selectAgentRun(this.activeThreadId, agentRunId);
    await this.renderMessages();
    this.applyComposerPlaceholder();
  }

  /** Returns the message pane to the real conversation. No-op when already there. */
  private async exitAgentView(): Promise<void> {
    if (!this.activeThreadId) return;
    if (!this.manager.getSelectedAgentRun(this.activeThreadId)) return;
    this.rememberAgentScroll();
    this.manager.clearSelectedAgentRun(this.activeThreadId);
    this.pendingMainScroll = this.agentScroll.get(`${this.activeThreadId}:main`) ?? null;
    await this.renderMessages();
    this.applyComposerPlaceholder();
  }

  /**
   * Renders one agent's activity into the message pane, behind a sticky header
   * whose breadcrumbs walk back to the real conversation.
   */
  private renderAgentConversation(agentRunId: string): void {
    if (!this.activeThreadId) return;
    const runs = this.manager.getAgentRuns(this.activeThreadId);
    const run = runs.find(r => r.id === agentRunId);
    if (!run) return;

    this.messagesEl.addClass('ct-messages-agent-view');

    const header = this.messagesEl.createDiv('ct-agent-view-header');
    const crumbs = header.createDiv({ cls: 'ct-agent-crumbs', attr: { 'aria-label': 'Agent breadcrumb' } });
    const mainCrumb = crumbs.createEl('button', {
      cls: 'ct-agent-crumb',
      text: 'Main conversation',
      attr: { type: 'button' },
    });
    mainCrumb.addEventListener('click', () => { void this.exitAgentView(); });

    const chain = buildAgentBreadcrumbs(runs, agentRunId);
    chain.forEach((node, index) => {
      crumbs.createSpan({ cls: 'ct-agent-crumb-sep', text: '›' });
      if (index === chain.length - 1) {
        crumbs.createSpan({
          cls: 'ct-agent-crumb ct-agent-crumb-current',
          text: agentLabel(node),
          attr: { 'aria-current': 'page' },
        });
      } else {
        const crumb = crumbs.createEl('button', { cls: 'ct-agent-crumb', text: agentLabel(node), attr: { type: 'button' } });
        crumb.addEventListener('click', () => { void this.enterAgentView(node.id); });
      }
    });

    const closeBtn = header.createEl('button', {
      cls: 'ct-agent-view-close',
      attr: { type: 'button', 'aria-label': 'Back to the main conversation', title: 'Back to the main conversation' },
    });
    setIcon(closeBtn, 'x');
    closeBtn.addEventListener('click', () => { void this.exitAgentView(); });

    const body = this.messagesEl.createDiv('ct-agent-view-body');
    this.agentViewBodyEl = body;
    renderAgentActivity(body, run);

    const remembered = this.agentScroll.get(`${this.activeThreadId}:${agentRunId}`);
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = remembered ?? this.messagesEl.scrollHeight;
    });
  }

  /**
   * Repaints the open child view in place on `agent_runs_changed`, keeping the
   * scroll position unless the user is already parked at the tail. Without the
   * 40px stick check, every live event would yank a user who scrolled up to read
   * an earlier step straight back to the bottom.
   */
  private refreshAgentActivityView(): void {
    const body = this.agentViewBodyEl;
    if (!body || !body.isConnected || !this.activeThreadId) return;
    const id = this.currentAgentViewId();
    if (!id) { void this.renderMessages(); return; }
    const run = this.manager.getAgentRuns(this.activeThreadId).find(r => r.id === id);
    if (!run) return;
    const scroller = this.messagesEl;
    const stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 40;
    renderAgentActivity(body, run);
    if (stick) requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
  }

  /** Composer placeholder, flagged when a send would bounce out of a child view. */
  private applyComposerPlaceholder(): void {
    if (!this.dispatchInput) return;
    const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;
    const base = thread?.agentHarness === 'codex' ? 'Message Codex' : 'Message Claude';
    // Kept short: a long placeholder wraps and clips in a narrow side panel.
    this.dispatchInput.setPlaceholder(
      this.currentAgentViewId() ? `${base} (main conversation)` : base,
    );
  }

  private async appendMessage(msg: ChatMessage): Promise<HTMLElement | null> {
    if (msg.role === 'compact') {
      const divider = this.messagesEl.createDiv('ct-compact-divider');
      const label = msg.compactTrigger === 'manual' ? 'Context compacted' : 'Context auto-compacted';
      divider.createSpan({ cls: 'ct-compact-label', text: label });
      if (msg.preTokens && msg.preTokens > 0) {
        divider.createSpan({ cls: 'ct-compact-tokens', text: `${(msg.preTokens / 1000).toFixed(0)}k tokens` });
      }
      return null;
    }

    if (msg.role === 'notice') {
      const row = this.messagesEl.createDiv('ct-notice-row');
      const iconEl = row.createSpan('ct-notice-icon');
      setIcon(iconEl, msg.noticeStatus === 'completed' ? 'check-circle' : 'x-circle');
      row.createSpan({ cls: 'ct-notice-text', text: msg.content });
      return null;
    }

    const el = this.messagesEl.createDiv(`ct-message ct-message-${msg.role}`);
    if (msg.role === 'user') this.attachSetAsGoalMenu(el, msg);

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      this.renderToolCalls(el, msg.toolCalls);
    }

    if (msg.toolResultImages && msg.toolResultImages.length > 0) {
      const imgWrap = el.createDiv('ct-tool-result-images');
      for (const img of msg.toolResultImages) {
        imgWrap.createEl('img', {
          attr: {
            src: this.imageSrc(img, img.data),
            style: 'max-width:100%;border-radius:4px;margin-bottom:6px;display:block;',
          },
        });
      }
    }

    const content = el.createDiv('ct-message-content');
    if (msg.role === 'assistant') {
      if (this.compressedView) {
        el.addClass('ct-message-compressed');
        // Collapsed row: summary text + expand button inline
        const collapsedRow = content.createDiv('ct-compressed-row');
        const summaryTextEl = collapsedRow.createSpan({
          cls: 'ct-compressed-summary',
          text: msg.summary ?? 'Summarizing…',
        });
        this.summaryTextEls.set(msg.id, summaryTextEl);

        // Expand button is inside collapsedRow so it sits inline with the summary text
        const expandBtn = collapsedRow.createEl('button', { cls: 'ct-expand-btn', attr: { title: 'Expand' } });
        setIcon(expandBtn, 'chevron-down');

        // Full content (hidden by default)
        const fullContent = content.createDiv('ct-full-content ct-hidden');
        await this.renderMarkdown(msg.content, fullContent);

        let expanded = false;
        expandBtn.addEventListener('click', () => {
          expanded = !expanded;
          if (expanded) {
            summaryTextEl.addClass('ct-hidden');
            fullContent.removeClass('ct-hidden');
          } else {
            summaryTextEl.removeClass('ct-hidden');
            fullContent.addClass('ct-hidden');
          }
          setIcon(expandBtn, expanded ? 'chevron-up' : 'chevron-down');
        });

        // Enqueue lazy summary generation if not cached (serial — never concurrent)
        if (!msg.summary) {
          this.generateMessageSummary(msg);
        }
      } else {
        await this.renderMarkdown(msg.content, content);
      }
      // Only render the copy button when there is actual text to copy. Desktop
      // hides this button by default (opacity: 0, revealed on hover), so an
      // empty-content tool-only turn is cosmetically harmless today, but guard
      // it anyway for correctness/consistency and so it doesn't regress if the
      // hover-hide CSS ever changes (see the mobile equivalent above).
      if (msg.content && msg.content.trim().length > 0) {
        const copyBtn = el.createEl('button', { cls: 'ct-copy-btn', attr: { title: 'Copy response' } });
        setIcon(copyBtn, 'copy');
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(msg.content);
          setIcon(copyBtn, 'check');
          setTimeout(() => setIcon(copyBtn, 'copy'), 1500);
        });
      }
    } else {
      content.createEl('p', { text: msg.content });
      // Render image thumbnails attached to user messages (e.g. sent from
      // the dispatch box or conversation input). The live-streaming path
      // renders these via the 'sending' event; this covers the renderMessages()
      // path (thread switch, initial load, view rebuild).
      if (msg.images && msg.images.length > 0) {
        const imgRow = content.createDiv('ct-message-images');
        for (const img of msg.images) {
          const thumb = imgRow.createEl('img', { cls: 'ct-message-img-thumb' });
          thumb.src = this.imageSrc(img, img.base64);
          thumb.title = img.name;
        }
      }
    }

    // Show the footer row only for:
    //  - user messages (always — marks when the user sent)
    //  - assistant messages that carry a cost (the terminal message of a turn)
    // Intermediate assistant messages in a multi-step response have no cost
    // and get no footer, keeping the view clean.
    const hasCost = !!msg.cost && msg.cost > 0;
    if (msg.role === 'user' || hasCost) {
      const footer = el.createDiv('ct-message-footer');
      footer.createSpan({ cls: 'ct-message-ts', text: this.formatShortTime(msg.timestamp) });
      if (hasCost) {
        footer.createSpan({ cls: 'ct-cost', text: `$${msg.cost!.toFixed(4)}` });
      }
    }

    return el;
  }

  /**
   * Render a single tool call as a `.ct-tool-pill` into `wrapper`. Shared by
   * the finalized flat (ungrouped) path, renderToolGroup's expanded body, and
   * the live-streaming path (renderLiveToolCalls) so isolated calls, grouped
   * calls, and in-progress calls all look identical. Returns the created pill
   * so live-rendering can register it in toolPillsByUseId for tool_progress
   * heartbeat updates.
   */
  private renderToolPill(wrapper: HTMLElement, tool: ToolCallRecord): HTMLElement {
    const pill = wrapper.createDiv('ct-tool-pill');
    if (tool.status === 'error') pill.addClass('ct-tool-error');
    else if (tool.status === 'success') pill.addClass('ct-tool-success');
    else if (tool.status === 'pending') pill.addClass('ct-tool-active');
    const iconEl = pill.createSpan({ cls: 'ct-tool-pill-icon' });
    setIcon(iconEl, getToolIcon(tool.name));
    pill.createSpan({ cls: 'ct-tool-pill-name', text: formatToolName(tool.name) });
    if (tool.summary) pill.createSpan({ cls: 'ct-tool-pill-text', text: tool.summary });
    if (tool.timestamp) {
      pill.createSpan({ cls: 'ct-tool-pill-ts', text: this.formatShortTime(tool.timestamp) });
    }
    return pill;
  }

  /** Deterministic key for a FINALIZED tool-call group's expand/collapse state. */
  private toolGroupKey(tools: ToolCallRecord[]): string {
    return tools.map(t => t.toolUseId ?? t.timestamp ?? '').join(':');
  }

  /**
   * Deterministic key for a FINALIZED outer-wrap's expand/collapse state.
   * Thin wrapper over toolGroupKey — hashes the FULL flat tool list (not the
   * post-smoothing grouped entries), matching toolGroupKey's own convention.
   */
  private outerToolWrapKey(tools: ToolCallRecord[]): string {
    return this.toolGroupKey(tools);
  }

  /**
   * LIVE counterpart to outerToolWrapKey — thin wrapper over liveToolGroupKey
   * for the same "member list keeps growing mid-turn" reason liveToolGroupKey
   * exists at the group level (see that function's doc comment).
   */
  private outerLiveToolWrapKey(tools: ToolCallRecord[]): string {
    return liveToolGroupKey(tools); // already imported from toolNameUtils
  }

  /**
   * @param opts.live When true, groups are keyed/expand-tracked the same way
   *   the live-streaming path (renderLiveToolCalls) does — via liveToolGroupKey
   *   + liveExpandedToolGroups instead of the stable id-hash keying used by
   *   default. Needed by the R3 in-place tail-row rebuild: that row's member
   *   list keeps growing as the still-open run receives more tool-only steps,
   *   so a stable-hash key would change on every extension and silently
   *   re-collapse a group the user had expanded. Only that call site should
   *   pass `live: true` — first-time append of a settled row and the full
   *   renderMessages() rebuild both keep the default (stable) keying.
   */
  private renderToolCalls(parent: HTMLElement, tools: ToolCallRecord[], opts?: { live?: boolean }): HTMLElement {
    const wrapper = parent.createDiv('ct-tools');
    this.populateToolCallsWrapper(wrapper, tools, { live: opts?.live ?? false });
    return wrapper;
  }

  /**
   * Renders one layer of tool-call entries (singles and groups) into
   * `container` — the exact per-entry loop shared by the flat (non-wrapped)
   * render path AND the expanded body of the outer wrap (renderOuterToolWrap),
   * so the two structurally match. `opts.onPillRendered` is threaded through
   * to renderToolGroup so live-mode pill registration (toolPillsByUseId, for
   * per-pill tool_progress heartbeat updates) keeps working even when a group
   * ends up nested inside the outer wrap.
   */
  private renderGroupedEntries(
    container: HTMLElement,
    grouped: ToolCallGroup[],
    opts: { live: boolean; onPillRendered?: (tool: ToolCallRecord, pill: HTMLElement) => void },
  ): void {
    for (const entry of grouped) {
      if (entry.kind === 'single') {
        const pill = this.renderToolPill(container, entry.tool);
        opts.onPillRendered?.(entry.tool, pill);
      } else if (opts.live) {
        this.renderToolGroup(container, entry, {
          keyOverride: liveToolGroupKey(entry.tools),
          expandedSet: this.liveExpandedToolGroups,
          onPillRendered: opts.onPillRendered,
        });
      } else {
        this.renderToolGroup(container, entry);
      }
    }
  }

  /**
   * Second collapsible tier, wrapping the ENTIRE post-smoothing entry list
   * when it's still too long to render flat (see shouldWrapOuter). Mirrors
   * renderToolGroup's collapse/expand pattern one level up: collapsed by
   * default, auto-expands through BOTH tiers if any descendant tool errored,
   * and — while live — shows a live-updating "currently executing tool"
   * header instead of a static count so a long collapsed run doesn't read as
   * frozen.
   */
  private renderOuterToolWrap(
    wrapper: HTMLElement,
    tools: ToolCallRecord[],
    grouped: ToolCallGroup[],
    opts: { live: boolean; onPillRendered?: (tool: ToolCallRecord, pill: HTMLElement) => void },
  ): void {
    const hasError = tools.some(t => t.status === 'error');
    const hasPending = tools.some(t => t.status === 'pending');

    const groupEl = wrapper.createDiv('ct-tool-outer-wrap');
    const headerRow = groupEl.createDiv('ct-tool-outer-wrap-header ct-compressed-row');
    if (hasError) headerRow.addClass('ct-tool-error');

    if (opts.live && hasPending) {
      headerRow.addClass('ct-tool-active');
      const current = pickCurrentTool(tools);
      const summaryEl = headerRow.createSpan({ cls: 'ct-tool-outer-wrap-live-summary' });
      if (current) {
        const iconEl = summaryEl.createSpan({ cls: 'ct-tool-pill-icon' });
        setIcon(iconEl, getToolIcon(current.name));
        summaryEl.createSpan({ cls: 'ct-tool-pill-name', text: formatToolName(current.name) });
        if (current.summary) summaryEl.createSpan({ cls: 'ct-tool-pill-text', text: current.summary });
      }
    } else {
      // 'list-tree' reads as "a nested list of steps," matching what the
      // outer wrap actually contains (a list of groups, each a list of pills).
      const iconEl = headerRow.createSpan({ cls: 'ct-tool-pill-icon' });
      setIcon(iconEl, 'list-tree');
      headerRow.createSpan({
        cls: 'ct-compressed-summary',
        text: `${tools.length} tool calls, ${grouped.length} steps`,
      });
    }

    const expandBtn = headerRow.createEl('button', { cls: 'ct-expand-btn', attr: { title: 'Expand' } });

    const fullContent = groupEl.createDiv('ct-full-content');
    this.renderGroupedEntries(fullContent, grouped, opts);

    const expandedSet = opts.live ? this.liveExpandedOuterToolWrap : this.expandedOuterToolWrap;
    const key = opts.live ? this.outerLiveToolWrapKey(tools) : this.outerToolWrapKey(tools);
    let expanded = hasError || expandedSet.has(key);
    if (!expanded) fullContent.addClass('ct-hidden');
    setIcon(expandBtn, expanded ? 'chevron-up' : 'chevron-down');

    expandBtn.addEventListener('click', () => {
      expanded = !expanded;
      if (expanded) {
        fullContent.removeClass('ct-hidden');
        expandedSet.add(key);
      } else {
        fullContent.addClass('ct-hidden');
        expandedSet.delete(key);
      }
      setIcon(expandBtn, expanded ? 'chevron-up' : 'chevron-down');
    });
  }

  /**
   * The one place "smooth + decide + render" policy for a tool-call list
   * lives. Groups the raw tools, smooths short off-kind interruptions back
   * into their surrounding groups, then either renders flat (the common
   * case) or wraps the whole list in a second collapsible tier once it's
   * still too long after smoothing (see shouldWrapOuter/OUTER_WRAP_ENTRY_THRESHOLD).
   */
  private populateToolCallsWrapper(
    wrapper: HTMLElement,
    tools: ToolCallRecord[],
    opts: { live: boolean; onPillRendered?: (tool: ToolCallRecord, pill: HTMLElement) => void },
  ): void {
    const grouped = smoothToolGroups(groupToolCalls(tools));
    if (shouldWrapOuter(grouped)) {
      this.renderOuterToolWrap(wrapper, tools, grouped, opts);
    } else {
      this.renderGroupedEntries(wrapper, grouped, opts);
    }
  }

  /**
   * Rebuilds the `.ct-tools` child of an already-rendered row element in
   * place, given the row's freshly-merged toolCalls array. Used by the case
   * 'message' handler in handleEvent() to extend the currently-open tail row
   * of a live tool-only run without tearing down and recreating the whole
   * `.ct-message` (which would lose scroll position / cause a visible flash
   * on every step). Passes `{ live: true }` so a group the user expanded
   * mid-run stays expanded as it grows (see renderToolCalls' doc comment).
   */
  private rebuildRowToolsInPlace(rowEl: HTMLElement, toolCalls: ToolCallRecord[]): void {
    const existing = rowEl.querySelector(':scope > .ct-tools');
    existing?.remove();
    if (!toolCalls || toolCalls.length === 0) return;
    const wrapper = this.renderToolCalls(rowEl, toolCalls, { live: true });
    // renderToolCalls appends via createDiv (last child) — move it to the
    // front so tools stay above the message content, matching the layout
    // appendMessage produces when a row is first created.
    rowEl.prepend(wrapper);
  }

  /**
   * Render a run of 2+ consecutive same-activity tool calls as a collapsible
   * section, mirroring appendAssistantGroup's collapse/expand pattern and CSS
   * classes. Auto-expands (and visually flags) if any tool in the group errored,
   * so failures are never hidden behind a collapsed group.
   *
   * Shared by the finalized view (default opts) and the live-streaming view
   * (renderLiveToolCalls passes a stable liveToolGroupKey + a dedicated
   * expand-state set + a callback to register pending pills for tool_progress
   * heartbeat lookups).
   */
  private renderToolGroup(
    wrapper: HTMLElement,
    entry: Extract<ToolCallGroup, { kind: 'group' }>,
    opts?: {
      keyOverride?: string;
      expandedSet?: Set<string>;
      onPillRendered?: (tool: ToolCallRecord, pill: HTMLElement) => void;
    },
  ): void {
    const { activityKind, tools } = entry;
    const hasError = tools.some(t => t.status === 'error');
    const hasPending = tools.some(t => t.status === 'pending');
    const expandedSet = opts?.expandedSet ?? this.expandedToolGroups;
    const groupKey = opts?.keyOverride ?? this.toolGroupKey(tools);

    const groupEl = wrapper.createDiv('ct-tool-group');
    const headerRow = groupEl.createDiv('ct-tool-group-header ct-compressed-row');
    // Flag on the header (which owns the border-left) so ct-tool-error's
    // border-left-color override and icon-tint rule both take visible effect.
    if (hasError) headerRow.addClass('ct-tool-error');
    // "Still running" affordance — reuses the same ct-tool-active convention
    // as an individual pending pill (pulsing left border + icon tint; the
    // group-header-specific pulsing dot on .ct-compressed-summary is added in
    // styles.css). Does NOT force-expand — only an error does that — so a
    // long run of successful same-kind calls stays collapsed while live.
    if (hasPending) headerRow.addClass('ct-tool-active');

    const iconEl = headerRow.createSpan({ cls: 'ct-tool-pill-icon' });
    setIcon(iconEl, getToolIcon(tools[0].name));

    headerRow.createSpan({
      cls: 'ct-compressed-summary',
      text: `${ACTIVITY_LABELS[activityKind]} (${tools.length})`,
    });

    const expandBtn = headerRow.createEl('button', { cls: 'ct-expand-btn', attr: { title: 'Expand' } });

    const fullContent = groupEl.createDiv('ct-full-content');
    for (const tool of tools) {
      const pill = this.renderToolPill(fullContent, tool);
      opts?.onPillRendered?.(tool, pill);
    }

    let expanded = hasError || expandedSet.has(groupKey);
    if (!expanded) fullContent.addClass('ct-hidden');
    setIcon(expandBtn, expanded ? 'chevron-up' : 'chevron-down');

    expandBtn.addEventListener('click', () => {
      expanded = !expanded;
      if (expanded) {
        fullContent.removeClass('ct-hidden');
        expandedSet.add(groupKey);
      } else {
        fullContent.addClass('ct-hidden');
        expandedSet.delete(groupKey);
      }
      setIcon(expandBtn, expanded ? 'chevron-up' : 'chevron-down');
    });
  }

  /**
   * Live-rendering counterpart to renderToolCalls: rebuilds the entire
   * `.ct-tools` wrapper for the in-progress turn from `tools` (the turn's
   * accumulated ToolCallRecord[], i.e. streamingBuffers.get(id).tools) every
   * time it's called. Reuses groupToolCalls()/renderToolPill()/renderToolGroup()
   * so the live view collapses same-kind runs exactly like the finalized view
   * — no separate rendering logic to keep in sync, and no visual jump when the
   * turn settles and appendMessage() takes over.
   *
   * Called from the debounced scheduleLiveToolsRender() (tool_use/tool_result_status)
   * and from renderMessages()'s restore-on-switch path. Not called on every
   * single event directly — callers debounce or call it once per render pass.
   */
  private renderLiveToolCalls(tools: ToolCallRecord[]): void {
    if (!this.streamingEl) return;
    // Skip the Agent tool call itself — the task_started event renders its
    // own "sub-agent working" pill carrying the same info (matches the old
    // isAgentCall skip in the tool_use handler).
    const visible = tools.filter(t => t.name !== 'Agent');
    this.toolPillsByUseId.clear();
    if (visible.length === 0) {
      // Nothing to show (e.g. the only call so far was Agent) — don't leave a
      // zero-item .ct-tools wrapper around (it has a non-zero margin-bottom).
      if (this.streamingToolsEl) {
        this.streamingToolsEl.remove();
        this.streamingToolsEl = null;
      }
      return;
    }
    const wrapper = this.ensureStreamingToolsEl();
    wrapper.empty();
    this.populateToolCallsWrapper(wrapper, visible, {
      live: true,
      onPillRendered: (tool, pill) => {
        if (tool.status === 'pending' && tool.toolUseId) {
          this.toolPillsByUseId.set(tool.toolUseId, pill);
        }
      },
    });
  }

  /**
   * Debounces a full rebuild of the live tool-call list, mirroring
   * scheduleStreamingRender's 80ms batching for streamed text tokens. Batches
   * fast bursts of tool_use/tool_result_status events into a single DOM
   * rebuild instead of one mutation per event.
   */
  private scheduleLiveToolsRender(): void {
    if (this.liveToolsRenderTimer !== null) clearTimeout(this.liveToolsRenderTimer);
    this.liveToolsRenderTimer = setTimeout(() => {
      this.liveToolsRenderTimer = null;
      if (!this.activeThreadId) return;
      const buf = this.streamingBuffers.get(this.activeThreadId);
      this.renderLiveToolCalls(buf?.tools ?? []);
      this.scrollToBottom();
    }, 80);
  }

  /**
   * Anchor point for inline cards (permission, question, plan, elicitation,
   * context usage, tool-result images): the active streaming element so the
   * card sits visually inside the current response turn, falling back to
   * messagesEl.
   *
   * `streamingEl` is cleared to null once a turn finalizes, but a reference
   * to it can still be held by an async callback (e.g. `onPlanReady` firing
   * after the assistant message that triggered it has already finalized and
   * been removed from the DOM). Checking `isConnected` catches that stale-
   * but-non-null case — without it the card would render into a detached
   * node and never become visible.
   */
  private cardContainer(): HTMLElement {
    return this.streamingEl?.isConnected ? this.streamingEl : this.messagesEl;
  }

  private renderPermissionCard(toolName: string, detail: string, done: (allow: boolean) => void): HTMLElement {
    // Anchor inside the active streaming element so the card sits visually
    // inside the current response turn rather than floating as a sibling that
    // can overlap the tool-pill list above it.
    const container = this.cardContainer();
    const card = container.createDiv('ct-permission-card');

    const header = card.createDiv('ct-permission-header');
    const iconEl = header.createSpan('ct-permission-icon');
    setIcon(iconEl, 'shield-alert');
    header.createSpan({ cls: 'ct-permission-label', text: 'Permission request' });

    const body = card.createDiv('ct-permission-body');
    body.createEl('code', { cls: 'ct-permission-tool', text: formatToolName(toolName) });
    if (detail) {
      body.createEl('p', { cls: 'ct-permission-detail', text: detail });
    }

    const actions = card.createDiv('ct-permission-actions');
    actions.createEl('button', { text: 'Deny', cls: 'ct-permission-btn ct-permission-deny' })
      .addEventListener('click', () => done(false));
    actions.createEl('button', { text: 'Allow', cls: 'ct-permission-btn ct-permission-allow' })
      .addEventListener('click', () => done(true));
    actions.createEl('button', { text: 'Always Allow', cls: 'ct-permission-btn ct-permission-always' })
      .addEventListener('click', async () => {
        this.plugin.settings.alwaysAllowedTools.push(toolName);
        await this.plugin.saveSettings();
        done(true);
      });

    return card;
  }

  /**
   * Makes an entire question-option row clickable, not just the tiny radio/checkbox
   * input inside it. Native <label for> association can't be used here because the
   * label doesn't span the full row (it only wraps its own text), so instead we
   * listen on the row and forward the click to the input — except when the click
   * already landed on the input itself, where the browser's native toggle behavior
   * (and radio-group exclusivity) applies and must not be double-handled.
   */
  private bindQuestionRowClick(row: HTMLElement, inputEl: HTMLInputElement): void {
    row.addEventListener('click', (e) => {
      if (e.target === inputEl) return;
      if (inputEl.type === 'checkbox') {
        inputEl.checked = !inputEl.checked;
      } else {
        inputEl.checked = true;
      }
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  /**
   * Renders the inline question card shown when Claude calls AskUserQuestion.
   * The card is anchored to the current streaming element (or messagesEl) so it
   * sits visually inside the current response turn, mirroring renderPermissionCard
   * and renderPlanCard. Unlike the old modal, there is no "close" gesture — only
   * an explicit Submit button resolves the answers.
   */
  private renderQuestionCard(
    questions: AskQuestion[],
    done: (answers: Record<string, string>) => void,
  ): HTMLElement {
    const container = this.cardContainer();
    const card = container.createDiv('ct-question-card');

    const header = card.createDiv('ct-question-card-header');
    const iconEl = header.createSpan('ct-question-card-icon');
    setIcon(iconEl, 'help-circle');
    const source = questions.some((question) => question.source === 'codex') ? 'Codex' : 'Claude';
    header.createSpan({ cls: 'ct-question-card-label', text: `${source} needs your input` });

    const body = card.createDiv('ct-question-card-body');

    // Track each question's option inputs (plus the always-present "Other" input
    // and its text field) so Submit can read the final selection straight from the
    // DOM, rather than juggling incremental change-event bookkeeping across two
    // input flavors (fixed options vs. free text).
    const questionInputs: Array<{
      question: AskQuestion;
      optionInputs: HTMLInputElement[];
      otherInput?: HTMLInputElement;
      otherText?: HTMLInputElement;
    }> = [];

    for (const q of questions) {
      const qEl = body.createDiv({ cls: 'ct-question' });
      if (q.header) qEl.createEl('h3', { cls: 'ct-question-header', text: q.header });
      qEl.createEl('p', { cls: 'ct-question-text', text: q.question });

      const optionsEl = qEl.createDiv({ cls: 'ct-question-options' });
      const optionInputs: HTMLInputElement[] = [];
      for (const opt of q.options) {
        const row = optionsEl.createDiv({ cls: 'ct-question-option' });
        const inputEl = row.createEl('input', {
          attr: { type: q.multiSelect ? 'checkbox' : 'radio', name: q.question, value: opt.label },
        }) as HTMLInputElement;
        const labelEl = row.createEl('label', { cls: 'ct-question-option-label' });
        labelEl.createSpan({ cls: 'ct-question-opt-name', text: opt.label });
        if (opt.description) {
          labelEl.createSpan({ cls: 'ct-question-opt-desc', text: opt.description });
        }
        this.bindQuestionRowClick(row, inputEl);
        optionInputs.push(inputEl);
      }

      let otherInput: HTMLInputElement | undefined;
      let otherText: HTMLInputElement | undefined;
      if (q.allowOther !== false) {
        const otherRow = optionsEl.createDiv({ cls: 'ct-question-option ct-question-option-other' });
        otherInput = otherRow.createEl('input', {
          attr: { type: q.multiSelect ? 'checkbox' : 'radio', name: q.question, value: '__other__' },
        }) as HTMLInputElement;
        this.bindQuestionRowClick(otherRow, otherInput);
        const otherLabelEl = otherRow.createEl('label', { cls: 'ct-question-option-label' });
        otherLabelEl.createSpan({ cls: 'ct-question-opt-name', text: q.options.length > 0 ? 'Other' : 'Answer' });
        otherText = otherLabelEl.createEl('input', {
          cls: 'ct-question-other-text',
          attr: {
            type: q.isSecret ? 'password' : 'text',
            placeholder: q.isSecret ? 'Enter secret…' : 'Type your own answer…',
            autocomplete: q.isSecret ? 'off' : 'on',
          },
        }) as HTMLInputElement;
        otherText.addEventListener('input', () => {
          if (otherInput && !otherInput.checked) otherInput.checked = true;
        });
        otherText.addEventListener('click', (e) => e.stopPropagation());
      }

      questionInputs.push({ question: q, optionInputs, otherInput, otherText });
    }

    const actions = card.createDiv('ct-question-card-actions');
    const submitBtn = actions.createEl('button', { text: 'Submit', cls: 'ct-question-card-submit' });
    submitBtn.addEventListener('click', () => {
      const result: Record<string, string> = {};
      for (const { question, optionInputs, otherInput, otherText } of questionInputs) {
        const values: string[] = [];
        for (const input of optionInputs) {
          if (input.checked) values.push(input.value);
        }
        if (otherInput?.checked) {
          const text = otherText?.value.trim();
          if (text) values.push(text);
        }
        result[question.id ?? question.question] = values.join(',');
      }
      card.remove();
      done(result);
    });

    this.scrollToBottom();
    return card;
  }

  /**
   * Renders the plan approval card shown when Claude calls ExitPlanMode.
   * The card is anchored to the current streaming element (or messagesEl) so it
   * sits visually inside the current response turn.
   * Approve proceeds with implementation; Reject cancels the session with interrupt.
   * Edit opens a textarea pre-populated with the plan so the user can revise it.
   */
  private renderPlanCard(
    planText: string,
    approve: (editedPlan?: string) => void,
    reject: () => boolean,
  ): HTMLElement {
    const container = this.cardContainer();
    const card = container.createDiv('ct-plan-card');

    const header = card.createDiv('ct-plan-header');
    const iconEl = header.createSpan('ct-plan-icon');
    setIcon(iconEl, 'map');
    header.createSpan({ cls: 'ct-plan-label', text: 'Plan ready' });

    // Body: rendered markdown by default; Edit toggles to a textarea.
    const bodyEl = card.createDiv('ct-plan-body');
    const mdEl = bodyEl.createDiv('ct-plan-md');
    // renderMarkdown is async — fire-and-forget; content fills in immediately
    this.renderMarkdown(planText, mdEl).catch(() => {
      mdEl.setText(planText);
    });

    let editing = false;
    let textarea: HTMLTextAreaElement | null = null;

    const actions = card.createDiv('ct-plan-actions');

    // Snapshot thread ID at card-creation time so the async reject handler
    // targets the right thread even if the active selection changes.
    const rejectThreadId = this.activeThreadId;
    const rejectBtn = actions.createEl('button', { text: 'Reject', cls: 'ct-plan-btn ct-plan-reject' });
    rejectBtn.addEventListener('click', () => {
      card.remove();
      const hadFeedback = reject();
      // Inject a follow-up turn so Claude acknowledges the rejection and offers
      // to revise. sendMessage() queues automatically while the session is still
      // active and fires as a new turn once the denial response lands.
      if (rejectThreadId && !hadFeedback) {
        void this.manager.sendMessage(
          rejectThreadId,
          'I rejected the plan. Please ask what changes I\'d like, or suggest alternative approaches.',
        );
      }
    });

    const editBtn = actions.createEl('button', { text: 'Edit', cls: 'ct-plan-btn ct-plan-edit' });
    editBtn.addEventListener('click', () => {
      editing = !editing;
      if (editing) {
        mdEl.style.display = 'none';
        textarea = bodyEl.createEl('textarea', { cls: 'ct-plan-textarea' });
        textarea.value = planText;
        textarea.focus();
        editBtn.setText('Cancel');
      } else {
        textarea?.remove();
        textarea = null;
        mdEl.style.display = '';
        editBtn.setText('Edit');
      }
    });

    const approveBtn = actions.createEl('button', { text: 'Approve', cls: 'ct-plan-btn ct-plan-approve' });
    approveBtn.addEventListener('click', () => {
      const edited = editing && textarea ? textarea.value : undefined;
      card.remove();
      approve(edited !== undefined && edited !== planText ? edited : undefined);
    });

    this.scrollToBottom();
    return card;
  }

  /**
   * Re-renders the plan card when focusing a thread that has a pendingPlan.
   *
   * Two paths:
   *  - Live session waiting: the session is still running and blocked on the
   *    canUseTool promise. We use the stored approve/reject resolvers from
   *    ThreadManager so the card can still resolve the live callback even though
   *    the original plan_ready event was fired before the user switched threads.
   *  - Post-crash restore: the session is gone. Buttons dispatch via sendMessage
   *    to start a new session turn.
   *
   * Safe to call repeatedly — no-ops if the card is already visible or there is
   * no pending plan for the active thread.
   */
  private restorePendingPlanCard(): void {
    if (!this.activeThreadId) return;
    const thread = this.manager.getThread(this.activeThreadId);
    // Explicit undefined check — pendingPlan is a string, so a falsy check
    // here would treat an (unlikely but possible) empty-string plan as absent.
    if (thread?.pendingPlan === undefined) return;
    // Avoid duplicating the card if it's already visible.
    if (this.messagesEl.querySelector('.ct-plan-card')) return;

    const planText = thread.pendingPlan;
    const threadId = this.activeThreadId;

    // Check if a live session is still waiting on this plan (user switched
    // threads mid-session). If so, use the stored resolvers so the card can
    // resolve the canUseTool promise directly — sendMessage won't work here
    // because the session is blocked, not done.
    const liveResolvers = this.manager.getPendingPlanResolvers(threadId);
    if (liveResolvers) {
      // Live path: wire directly to the existing wrapped callbacks.
      this.renderPlanCard(planText, liveResolvers.approve, liveResolvers.reject);
      return;
    }

    // Post-crash / post-reload path: no live session. Dispatch via sendMessage.
    const clearPlan = () => {
      this.manager.setThreadPendingPlan(threadId, undefined);
      void this.plugin.saveSettings();
    };

    this.renderPlanCard(
      planText,
      (editedPlan) => {
        clearPlan();
        const effectivePlan = editedPlan ?? planText;
        const msg = editedPlan && editedPlan !== planText
          ? `Plan approved with edits. Please proceed with implementation:\n\n${effectivePlan}`
          : `Plan approved. Please proceed with implementation:\n\n${effectivePlan}`;
        void this.manager.sendMessage(threadId, msg);
      },
      () => {
        // Reject: just clear the persisted plan. The follow-up sendMessage is
        // injected by renderPlanCard's reject button handler (same as live path).
        clearPlan();
        return false;
      },
    );
  }

  /**
   * Re-renders the question card when focusing a thread that has pendingQuestions.
   *
   * Two paths, mirroring restorePendingPlanCard():
   *  - Live session waiting: the session is still running and blocked on the
   *    AskUserQuestion promise. We use the stored resolver from ThreadManager so
   *    the card can still resolve the live callback even though the original
   *    question_ready event was fired before the user switched threads.
   *  - Post-crash restore: the session is gone. Submit dispatches a fresh turn
   *    via sendMessage with the answers formatted as a message.
   *
   * Safe to call repeatedly — no-ops if the card is already visible or there is
   * no pending question for the active thread.
   */
  private restorePendingQuestionCard(): void {
    if (!this.activeThreadId) return;
    // If ThreadsView already has an in-memory pendingQuestions entry for this
    // thread, the question was raised while the thread was in the background
    // and renderMessages() (awaited earlier in the same setActiveThread() call,
    // so it has fully finished appending history by the time we get here)
    // already owns rendering that card via the live resolve callback.
    // Rendering here too would race it and produce a duplicate card, since
    // that path doesn't update this method's view of the world.
    if (this.pendingQuestions.has(this.activeThreadId)) return;
    const thread = this.manager.getThread(this.activeThreadId);
    if (!thread?.pendingQuestions) return;
    // Avoid duplicating the card if it's already visible.
    if (this.messagesEl.querySelector('.ct-question-card')) return;

    const questions = thread.pendingQuestions;
    const threadId = this.activeThreadId;

    // Check if a live session is still waiting on this question (user switched
    // threads mid-session). If so, use the stored resolver so the card can
    // resolve the live promise directly — sendMessage won't work here because
    // the session is blocked, not done.
    const liveResolver = this.manager.getPendingQuestionResolver(threadId);
    if (liveResolver) {
      this.renderQuestionCard(questions, liveResolver);
      return;
    }

    // Post-crash / post-reload path: no live session. Dispatch via sendMessage.
    this.renderQuestionCard(questions, (result) => {
      this.manager.setThreadPendingQuestions(threadId, undefined);
      void this.plugin.saveSettings();
      if (questions.some((question) => question.isSecret)) {
        // A restored card has no live provider request to answer. Never turn a
        // secret into an ordinary persisted chat message; ask Codex to issue a
        // fresh request so the value can travel only in the protocol response.
        void this.manager.sendMessage(
          threadId,
          'A secret input request expired when the session reloaded. Please request the secret again with request_user_input; do not ask me to send it in chat.',
        );
        return;
      }
      const formatted = questions
        .map((question) => `${question.question}: ${result[question.id ?? question.question] ?? ''}`)
        .join('\n');
      void this.manager.sendMessage(threadId, formatted);
    });
  }

  /**
   * Renders a URL-mode elicitation card. Opens the URL in the system browser
   * and shows a "Waiting for authentication..." card. When the signal fires
   * (session interrupted) the card resolves with cancel.
   */
  private renderElicitationUrlCard(
    req: import('@anthropic-ai/claude-agent-sdk').ElicitationRequest,
    signal: AbortSignal,
    respond: (r: import('@anthropic-ai/claude-agent-sdk').ElicitationResult) => void,
  ): void {
    const container = this.cardContainer();
    const card = container.createDiv('ct-elicitation-card');

    const header = card.createDiv('ct-elicitation-header');
    const iconEl = header.createSpan('ct-elicitation-icon');
    setIcon(iconEl, 'external-link');
    header.createSpan({ cls: 'ct-elicitation-label', text: req.title ?? `${req.serverName}: authentication` });

    const body = card.createDiv('ct-elicitation-body');
    if (req.message) body.createEl('p', { cls: 'ct-elicitation-message', text: req.message });
    if (req.description) body.createEl('p', { cls: 'ct-elicitation-desc', text: req.description });

    const actions = card.createDiv('ct-elicitation-actions');
    const openBtn = actions.createEl('button', { text: 'Open in browser', cls: 'ct-elicitation-btn ct-elicitation-open' });
    openBtn.addEventListener('click', () => {
      // Use Obsidian's electron shell or fall back to window.open for mobile
      const electron = (window as unknown as Record<string, unknown>).electron as { shell?: { openExternal?: (url: string) => void } } | undefined;
      if (electron?.shell?.openExternal) {
        electron.shell.openExternal(req.url!);
      } else {
        window.open(req.url!, '_blank');
      }
    });
    const waitEl = body.createEl('p', { cls: 'ct-elicitation-waiting', text: 'Waiting for authentication...' });
    actions.createEl('button', { text: 'Cancel', cls: 'ct-elicitation-btn ct-elicitation-cancel' })
      .addEventListener('click', () => {
        card.remove();
        respond({ action: 'cancel' });
      });

    // Auto-resolve cancel when the session is interrupted
    signal.addEventListener('abort', () => {
      card.remove();
      respond({ action: 'cancel' });
    }, { once: true });

    void waitEl; // referenced but only for display
    this.scrollToBottom();
  }

  /**
   * Renders a form-mode elicitation card. Builds input fields from requestedSchema
   * (JSON Schema object with properties). When submitted, resolves with accept +
   * the collected field values.
   */
  private renderElicitationFormCard(
    req: import('@anthropic-ai/claude-agent-sdk').ElicitationRequest,
    signal: AbortSignal,
    respond: (r: import('@anthropic-ai/claude-agent-sdk').ElicitationResult) => void,
  ): void {
    const container = this.cardContainer();
    const card = container.createDiv('ct-elicitation-card');

    const header = card.createDiv('ct-elicitation-header');
    const iconEl = header.createSpan('ct-elicitation-icon');
    setIcon(iconEl, 'form-input');
    header.createSpan({ cls: 'ct-elicitation-label', text: req.title ?? `${req.serverName}: input required` });

    const body = card.createDiv('ct-elicitation-body');
    if (req.message) body.createEl('p', { cls: 'ct-elicitation-message', text: req.message });
    if (req.description) body.createEl('p', { cls: 'ct-elicitation-desc', text: req.description });

    // Build input fields from requestedSchema.properties
    const inputs: Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement> = new Map();
    const schema = req.requestedSchema as { properties?: Record<string, { type?: string; title?: string; description?: string; enum?: string[] }> } | undefined;
    const props = schema?.properties ?? {};
    for (const [key, def] of Object.entries(props)) {
      const fieldRow = body.createDiv('ct-elicitation-field');
      const label = fieldRow.createEl('label', { cls: 'ct-elicitation-field-label' });
      label.textContent = def.title ?? key;

      if (def.enum && def.enum.length > 0) {
        const sel = fieldRow.createEl('select', { cls: 'ct-elicitation-field-input' });
        for (const opt of def.enum) {
          sel.createEl('option', { value: opt, text: opt });
        }
        inputs.set(key, sel);
      } else if (def.type === 'string') {
        const inp = fieldRow.createEl('input', { cls: 'ct-elicitation-field-input', attr: { type: 'text' } });
        inputs.set(key, inp);
      } else {
        const inp = fieldRow.createEl('input', { cls: 'ct-elicitation-field-input', attr: { type: 'text' } });
        inputs.set(key, inp);
      }
      if (def.description) {
        fieldRow.createEl('small', { cls: 'ct-elicitation-field-desc', text: def.description });
      }
    }

    const actions = card.createDiv('ct-elicitation-actions');
    actions.createEl('button', { text: 'Cancel', cls: 'ct-elicitation-btn ct-elicitation-cancel' })
      .addEventListener('click', () => {
        card.remove();
        respond({ action: 'cancel' });
      });
    actions.createEl('button', { text: 'Submit', cls: 'ct-elicitation-btn ct-elicitation-submit' })
      .addEventListener('click', () => {
        const content: Record<string, string> = {};
        for (const [key, el] of inputs) {
          content[key] = el.value;
        }
        card.remove();
        respond({ action: 'accept', content });
      });

    // Auto-resolve cancel when the session is interrupted
    signal.addEventListener('abort', () => {
      card.remove();
      respond({ action: 'cancel' });
    }, { once: true });

    this.scrollToBottom();
  }

  /**
   * Renders a context usage breakdown card in the message stream.
   * Shown in response to the /context slash command.
   */
  private renderContextUsageCard(
    usage: import('@anthropic-ai/claude-agent-sdk').SDKControlGetContextUsageResponse,
  ): void {
    const container = this.cardContainer();
    const card = container.createDiv('ct-context-usage-card');

    const header = card.createDiv('ct-context-usage-header');
    const iconEl = header.createSpan('ct-context-usage-icon');
    setIcon(iconEl, 'layers');
    header.createSpan({ cls: 'ct-context-usage-title', text: 'Context usage' });
    const pct = usage.percentage.toFixed(1);
    header.createSpan({
      cls: 'ct-context-usage-pct',
      text: `${usage.totalTokens.toLocaleString()} / ${usage.maxTokens.toLocaleString()} tokens (${pct}%)`,
    });

    const bar = card.createDiv('ct-context-usage-bar');
    let offset = 0;
    for (const cat of usage.categories) {
      if (cat.tokens <= 0) continue;
      const catPct = (cat.tokens / usage.maxTokens) * 100;
      const seg = bar.createDiv('ct-context-usage-seg');
      seg.style.width = `${catPct}%`;
      seg.style.backgroundColor = cat.color;
      seg.title = `${cat.name}: ${cat.tokens.toLocaleString()}`;
      offset += catPct;
    }
    void offset; // suppress unused warning

    const list = card.createDiv('ct-context-usage-list');
    for (const cat of usage.categories) {
      if (cat.tokens <= 0) continue;
      const row = list.createDiv('ct-context-usage-row');
      const dot = row.createSpan('ct-context-usage-dot');
      dot.style.backgroundColor = cat.color;
      row.createSpan({ cls: 'ct-context-usage-name', text: cat.name });
      row.createSpan({
        cls: 'ct-context-usage-tokens',
        text: `${cat.tokens.toLocaleString()} tokens`,
      });
    }

    // Show available agents from last capabilities discovery
    if (this.discoveredAgents.length > 0) {
      const agentSection = card.createDiv('ct-context-usage-agents');
      agentSection.createEl('h4', { cls: 'ct-context-usage-section-title', text: 'Available agents' });
      for (const agent of this.discoveredAgents) {
        const row = agentSection.createDiv('ct-context-usage-agent-row');
        row.createSpan({ cls: 'ct-context-usage-agent-name', text: agent.name });
        if (agent.description) {
          row.createSpan({ cls: 'ct-context-usage-agent-desc', text: agent.description });
        }
      }
    }

    this.scrollToBottom();
  }

  /** Renders provider-neutral token, quota, and account usage without implying parity. */
  private renderUsageCard(usage: import('./Usage').UsageSnapshot): void {
    const container = this.cardContainer();
    const card = container.createDiv('ct-usage-card');
    const header = card.createDiv('ct-usage-header');
    const iconEl = header.createSpan('ct-usage-icon');
    setIcon(iconEl, 'gauge');
    header.createSpan({ cls: 'ct-usage-title', text: 'Usage' });
    header.createSpan({ cls: 'ct-usage-provider', text: usage.provider === 'claude' ? 'Claude' : 'Codex' });

    const tokenSection = card.createDiv('ct-usage-section');
    tokenSection.createEl('h4', { text: 'Tokens' });
    const tokens = usage.tokens;
    if (tokens && Object.values(tokens).some(value => value !== undefined)) {
      const total = tokens.total ?? (tokens.input ?? 0) + (tokens.output ?? 0);
      tokenSection.createDiv({ cls: 'ct-usage-primary', text: `${total.toLocaleString()} thread/session tokens` });
      const details = [
        tokens.input !== undefined ? `${tokens.input.toLocaleString()} input` : '',
        tokens.output !== undefined ? `${tokens.output.toLocaleString()} output` : '',
        tokens.cachedInput !== undefined ? `${tokens.cachedInput.toLocaleString()} cached` : '',
        tokens.reasoning !== undefined ? `${tokens.reasoning.toLocaleString()} reasoning` : '',
      ].filter(Boolean);
      if (details.length) tokenSection.createDiv({ cls: 'ct-usage-muted', text: details.join(' · ') });
      if (usage.lastTurnTokens?.total !== undefined) {
        tokenSection.createDiv({ cls: 'ct-usage-muted', text: `Last turn: ${usage.lastTurnTokens.total.toLocaleString()} tokens` });
      }
    } else {
      tokenSection.createDiv({ cls: 'ct-usage-muted', text: 'Token totals are not available yet.' });
    }
    if (usage.estimatedCostUsd !== undefined) {
      tokenSection.createDiv({ cls: 'ct-usage-muted', text: `Estimated cost: $${usage.estimatedCostUsd.toFixed(4)}` });
    }

    const quotaSection = card.createDiv('ct-usage-section');
    quotaSection.createEl('h4', { text: 'Quota windows' });
    if (usage.quotaWindows.length === 0) {
      quotaSection.createDiv({ cls: 'ct-usage-muted', text: usage.provider === 'claude'
        ? 'No quota event has been received in this session yet.'
        : 'Quota information is unavailable.' });
    }
    for (const window of usage.quotaWindows) {
      const row = quotaSection.createDiv('ct-usage-quota');
      const top = row.createDiv('ct-usage-quota-top');
      top.createSpan({ text: window.label });
      top.createSpan({ text: window.usedPercent === undefined ? '—' : `${window.usedPercent.toFixed(0)}% used` });
      if (window.usedPercent !== undefined) {
        const bar = row.createDiv('ct-usage-bar');
        const fill = bar.createDiv('ct-usage-bar-fill');
        fill.style.width = `${Math.max(0, Math.min(100, window.usedPercent))}%`;
        if (window.usedPercent >= 100) fill.addClass('ct-usage-bar-exhausted');
        else if (window.usedPercent >= 80) fill.addClass('ct-usage-bar-warning');
      }
      if (window.resetsAt) row.createDiv({ cls: 'ct-usage-muted', text: `Resets ${new Date(window.resetsAt).toLocaleString()}` });
    }

    const account = card.createDiv('ct-usage-section');
    account.createEl('h4', { text: 'Account activity' });
    if (usage.provider === 'claude') {
      account.createDiv({ cls: 'ct-usage-muted', text: 'Account activity is not exposed by the Claude SDK.' });
    } else if (usage.accountUsageUnavailable) {
      account.createDiv({ cls: 'ct-usage-muted', text: `Unavailable: ${usage.accountUsageUnavailable}` });
    } else if (usage.accountUsage != null) {
      const activity = usage.accountUsage;
      const metrics = account.createDiv('ct-usage-account-metrics');
      const addMetric = (value: number | undefined, label: string) => {
        if (value !== undefined) metrics.createDiv({ cls: 'ct-usage-account-metric', text: `${value.toLocaleString()} ${label}` });
      };
      addMetric(activity.lifetimeTokens, 'lifetime tokens');
      addMetric(activity.peakDailyTokens, 'peak daily tokens');
      addMetric(activity.currentStreakDays, 'day current streak');
      addMetric(activity.longestStreakDays, 'day longest streak');
      if (activity.longestRunningTurnSeconds !== undefined) {
        metrics.createDiv({ cls: 'ct-usage-account-metric', text: `${activity.longestRunningTurnSeconds.toLocaleString()}s longest turn` });
      }
      if (activity.daily.length > 0) {
        const daily = account.createDiv('ct-usage-daily');
        for (const bucket of activity.daily.slice(-7).reverse()) {
          const row = daily.createDiv('ct-usage-daily-row');
          const parsed = new Date(`${bucket.date}T00:00:00`);
          row.createSpan({ text: Number.isNaN(parsed.getTime()) ? bucket.date : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) });
          row.createSpan({ text: `${bucket.tokens.toLocaleString()} tokens` });
        }
      }
    } else {
      account.createDiv({ cls: 'ct-usage-muted', text: 'No account activity was returned.' });
    }
    card.createDiv({ cls: 'ct-usage-freshness', text: `Updated ${new Date(usage.updatedAt).toLocaleTimeString()}` });
    this.scrollToBottom();
  }

  private clearStreamingState(): void {
    if (this.streamingRenderTimer !== null) {
      clearTimeout(this.streamingRenderTimer);
      this.streamingRenderTimer = null;
    }
    if (this.liveToolsRenderTimer !== null) {
      clearTimeout(this.liveToolsRenderTimer);
      this.liveToolsRenderTimer = null;
    }
    this.streamingRenderGeneration++;
    this.streamingRenderDirty = false;
    this.streamingContent = '';
    this.streamingContentEl = null;
    this.streamingToolsEl = null;
  }

  private scheduleStreamingRender(): void {
    this.streamingRenderDirty = true;
    if (this.streamingRenderTimer !== null || this.streamingRenderInFlight) return;
    this.streamingRenderTimer = setTimeout(() => {
      this.streamingRenderTimer = null;
      void this.renderStreamingContent();
    }, STREAMING_RENDER_INTERVAL_MS);
  }

  private async renderStreamingContent(): Promise<void> {
    if (this.streamingRenderInFlight || !this.streamingRenderDirty || !this.streamingEl || !this.streamingContentEl) return;
    this.streamingRenderDirty = false;
    this.streamingRenderInFlight = true;
    const generation = this.streamingRenderGeneration;
    const contentEl = this.streamingContentEl;
    const content = this.streamingContent;
    try {
      contentEl.empty();
      await this.renderMarkdown(content, contentEl, { streaming: true });
      // The user may have switched threads or the turn may have completed
      // while marked.parse() was pending. Never update or scroll a stale view.
      if (generation !== this.streamingRenderGeneration || contentEl !== this.streamingContentEl) return;
      // Keep cursor inside the bubble after each re-render.
      contentEl.createSpan({ cls: 'ct-cursor' });
      this.scrollToBottom();
    } finally {
      this.streamingRenderInFlight = false;
      // Tokens that arrived during the async parse are rendered in the next
      // throttled pass, rather than starting a competing full DOM rebuild.
      if (this.streamingRenderDirty) this.scheduleStreamingRender();
    }
  }

  private handleEvent(event: ThreadEvent): void {
    switch (event.type) {
      case 'wakeup_changed': {
        // A wake-up was registered, fired, or cancelled on the active thread.
        this.renderScheduledActivity();
        break;
      }

      case 'manager_notes_changed': {
        this.renderManagerNotesPanel();
        break;
      }

      case 'proposed_reply_changed': {
        this.renderProposedReplyCard();
        break;
      }

      case 'run_state_settled': {
        // The session generation has fully unwound and isRunning() has reached
        // its final settled value — re-check banners that gate on isRunning()
        // so they don't stay stale until an unrelated re-render forces them.
        this.renderScheduledActivity();
        break;
      }

      case 'user_message_added': {
        // Auto-dismiss the task card if all tasks completed on the previous turn.
        // This hides the checklist the moment the user moves on, rather than
        // immediately when the last task is ticked — giving them a chance to review.
        if (this.activeThreadId) {
          const tasks = this.manager.getThread(this.activeThreadId)?.tasks ?? [];
          if (tasks.length > 0 && tasks.every(t => t.status === 'completed')) {
            this.taskCardDismissed.add(this.activeThreadId);
            this.renderTaskCard();
          }
        }
        // Only create the bubble when the message came from an external caller
        // (e.g. the voice plugin). When the message originates from the input box,
        // handleSendMessage() already inserted the bubble synchronously before
        // calling sendMessage(), so pendingUserEl is already set — skip it here
        // to avoid a duplicate.
        let liveUserEl = this.pendingUserEl;
        if (!liveUserEl || (liveUserEl.dataset.messageId && liveUserEl.dataset.messageId !== event.message.id)) {
          // Same empty-state cleanup as handleSendFromDispatch for external callers
          this.messagesEl.querySelector('.ct-empty')?.remove();
          liveUserEl = this.messagesEl.createDiv('ct-message ct-message-user');
          this.pendingUserEl = liveUserEl;
          const content = liveUserEl.createDiv('ct-message-content');
          content.createEl('p', { text: event.message.content });
          if (event.message.images && event.message.images.length > 0) {
            const imgRow = content.createDiv('ct-message-images');
            for (const img of event.message.images) {
              const thumb = imgRow.createEl('img', { cls: 'ct-message-img-thumb' });
              thumb.src = this.imageSrc(img, img.base64);
              thumb.title = img.name;
            }
          }
          this.scrollToBottom();
        }
        // The composer creates its optimistic bubble before ThreadManager has
        // assigned the canonical ChatMessage. Bind the menu only now, once we
        // have that stable id/content. External live messages take the same
        // path through the element created just above.
        if (liveUserEl) this.attachSetAsGoalMenu(liveUserEl, event.message);
        break;
      }

      case 'streaming_start': {
        this.streamingContent = '';
        if (!this.streamingEl) {
          this.createStreamingEl();
        }
        this.setRunningState(true);
        this.scrollToBottom();
        break;
      }

      case 'pending_question_changed': {
        // While AskUserQuestion is waiting, keep Send available alongside
        // Stop so a typed response can act as a free-form answer. When the
        // answer resolves, return to the normal running (Stop-only) state.
        this.setRunningState(this.manager.isRunning(this.activeThreadId!));
        break;
      }

      case 'escalated': {
        this.showModelEscalationTip(`⚡ Using ${event.model} for this turn`);
        break;
      }

      case 'token': {
        if (!this.streamingEl) {
          this.createStreamingEl();
        }
        this.streamingContent += event.text;
        this.scheduleStreamingRender();
        break;
      }

      case 'tool_use': {
        // Self-heal a missing streamingEl (mirrors 'token'/'streaming_start'/
        // 'task_started'): a prior 'message' case may have nulled it, and if
        // this turn is tool-call-only (no prose before it), nothing else
        // would recreate it before we need to render into it. See #318.
        if (!this.streamingEl) this.createStreamingEl();
        // The cross-thread subscribe listener above (outside the activeThreadId
        // guard) has already pushed event.record onto
        // streamingBuffers.get(threadId).tools by the time this fires. Debounce
        // a full rebuild of the live tool-call list from that buffer instead of
        // mutating the DOM per event — this is what collapses fast bursts of
        // same-kind calls into a single group live, not just after the fact.
        // renderLiveToolCalls itself filters out the Agent tool call (the
        // task_started event renders its own "sub-agent" pill for that).
        this.scheduleLiveToolsRender();
        if (event.record.name === 'Write' || event.record.name === 'Edit') {
          const filePath = event.record.summary.replace(/^[^:]+: /, '');
          if (filePath) {
            // Delete before re-adding so the file moves to the end (most recent)
            this.editedFilesSet.delete(filePath);
            this.editedFilesSet.add(filePath);
            this.renderEditedFilesCard();
          }
        }
        break;
      }

      case 'message': {
        this.pendingUserEl = null; // assistant responded — user message is committed
        this.clearStreamingState();
        if (this.streamingEl) {
          this.streamingEl.remove();
          this.streamingEl = null;
          this.streamingContentEl = null;
        }
        // ThreadManager.onMessage has already pushed event.message onto
        // thread.messages by the time this fires. Recompute the merged rows
        // and either extend the still-open tail row in place (this event is
        // just another tool-only step in the same run) or append a new row —
        // see mergeAdjacentToolOnlyMessages/rebuildRowToolsInPlace.
        const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : undefined;
        const rows = thread ? mergeAdjacentToolOnlyMessages(thread.messages) : [];
        const newRow = rows[rows.length - 1];
        if (
          newRow &&
          newRow.id === this.lastAppendedRowId &&
          this.lastAppendedRowEl &&
          this.lastAppendedRowEl.isConnected
        ) {
          this.rebuildRowToolsInPlace(this.lastAppendedRowEl, newRow.toolCalls ?? []);
          this.scrollToBottom();
        } else if (newRow) {
          this.appendMessage(newRow).then((el) => {
            if (el) {
              this.lastAppendedRowId = newRow.id;
              this.lastAppendedRowEl = el;
            }
            this.scrollToBottom();
          });
        }
        this.scrollToBottom();
        // If this message invoked the Agent tool, create a "Sub-agent working…"
        // placeholder immediately so there's a visible indicator while the
        // sub-agent runs. task_started will prepend its pill to this element
        // if/when it fires; if it never fires the placeholder stays until done.
        const hasAgentCall = event.message.toolCalls?.some(t => t.name === 'Agent');
        if (hasAgentCall) {
          this.subagentWaiting = true;
          this.createStreamingEl('Sub-agent working');
          this.scrollToBottom();
        } else {
          this.subagentWaiting = false;
        }
        this.plugin.saveSettings();
        // Note: auto-summarize is handled in the outer event listener (above the
        // activeThreadId guard) so it fires for all threads, not just the active one.
        if (this.plugin.settings.saveThreadsToVault && this.activeThreadId) {
          const thread = this.manager.getThread(this.activeThreadId);
          if (thread) {
            this.plugin.persistence?.saveThread(thread).catch(console.error);
          }
        }
        break;
      }

      case 'recap': {
        this.renderThreadInfo();
        break;
      }

      // Only reaches here for the active thread — handleEvent is called behind
      // the `threadId === this.activeThreadId` guard in onOpen. The event itself
      // also fires for background threads (ThreadManager.persistAgentRuns), and
      // a busy background thread would otherwise thrash the foreground UI.
      case 'agent_runs_changed': {
        this.renderAgentPill();
        this.renderAgentPopoverList();
        this.refreshAgentActivityView();
        break;
      }

      case 'queued': {
        this.renderQueueRows();
        break;
      }

      case 'dequeued': {
        // Re-render queue rows immediately so the dequeued item disappears from
        // the list without waiting for the subsequent streaming_start event.
        this.renderQueueRows();
        const userEl = this.messagesEl.createDiv('ct-message ct-message-user');
        this.pendingUserEl = userEl; // prevent the subsequent 'send' event from creating a duplicate bubble
        const dqContent = userEl.createDiv('ct-message-content');
        if (event.text) dqContent.createEl('p', { text: event.text });
        if (event.images && event.images.length > 0) {
          const imgRow = dqContent.createDiv('ct-message-images');
          for (const img of event.images) {
            const thumb = imgRow.createEl('img', { cls: 'ct-message-img-thumb' });
            thumb.src = this.imageSrc(img, img.base64);
            thumb.title = img.name;
          }
        }
        this.scrollToBottom();
        break;
      }

      case 'done': {
        this.pendingUserEl = null;
        if (this.streamingEl) {
          this.streamingEl.remove();
          this.streamingEl = null;
          this.streamingContentEl = null;
          this.clearStreamingState();
        }
        this.taskPills.clear();
        this.taskStartTimes.clear();
        this.toolPillsByUseId.clear();
        this.subagentWaiting = false;
        this.activeWorkflowTaskId = null;
        this.workflowBlockEl = null;
        this.workflowPhaseEl = null;
        this.workflowAgentRows.clear();
        // Message completed normally — discard the saved sent text so it can't
        // bleed into another thread if the user later stops a different thread.
        if (this.activeThreadId) this.lastSentTexts.delete(this.activeThreadId);
        this.setRunningState(false);
        break;
      }

      case 'interrupted': {
        // Roll back the user message bubble that was never processed
        if (this.pendingUserEl) {
          this.pendingUserEl.remove();
          this.pendingUserEl = null;
        }
        if (this.streamingEl) {
          this.streamingEl.remove();
          this.streamingEl = null;
          this.streamingContentEl = null;
          this.clearStreamingState();
        }
        this.taskPills.clear();
        this.taskStartTimes.clear();
        this.toolPillsByUseId.clear();
        this.subagentWaiting = false;
        this.activeWorkflowTaskId = null;
        this.workflowBlockEl = null;
        this.workflowPhaseEl = null;
        this.workflowAgentRows.clear();
        // Restore the sent message so the user can edit and re-send
        const lastSent = this.activeThreadId ? this.lastSentTexts.get(this.activeThreadId) : undefined;
        if (lastSent) {
          this.dispatchInput?.setValue(lastSent);
          this.lastSentTexts.delete(this.activeThreadId!);
        }
        this.setRunningState(false);
        break;
      }

      case 'cwd_changed': {
        this.renderThreadInfo();
        break;
      }

      case 'project_changed': {
        this.renderProjectBar();
        this.renderComposerContext();
        this.renderThreadInfo();
        break;
      }

      case 'permission_mode_changed': {
        this.renderThreadInfo();
        break;
      }

      case 'plan_transition_error': {
        new Notice(event.error.message, 5_000);
        this.restorePendingPlanCard();
        break;
      }

      case 'status': {
        if (event.status === 'compacting') {
          this.showStatusCard('active', 'Compacting context…');
        } else if (event.status === null) {
          this.clearStatusCard('active');
        }
        break;
      }

      case 'status_tags': {
        this.renderStatusFooter();
        // A status-tag update can change the thread's sticky prUrl, which the
        // git diff bar's primary button also reflects (Create PR → View PR).
        this.renderGitDiffBar();
        break;
      }

      case 'git_diff': {
        this.renderGitDiffBar();
        // The footer suppresses its pr/branch pills while the bar is visible, so
        // a git_diff update that shows/hides the bar must re-render it too —
        // otherwise the deduped pill stays gone after the bar disappears (or
        // lingers as a duplicate after it appears).
        this.renderStatusFooter();
        break;
      }

      case 'compact': {
        this.appendMessage(event.message).then(() => this.scrollToBottom());
        this.plugin.saveSettings();
        // A compact divider is a hard run boundary — not strictly required
        // since it also changes the next merged row's id (mergeAdjacentToolOnlyMessages
        // never merges across a role: 'compact' message), but reset for hygiene.
        this.lastAppendedRowId = null;
        this.lastAppendedRowEl = null;
        break;
      }

      case 'task_started': {
        if (!this.streamingEl) this.createStreamingEl('Sub-agent working');
        this.subagentWaiting = false;
        this.taskStartTimes.set(event.taskId, Date.now());

        if (event.taskType === 'local_workflow') {
          // Workflow orchestrator — render a structured block
          this.activeWorkflowTaskId = event.taskId;
          this.workflowAgentRows.clear();

          const block = document.createElement('div');
          block.className = 'ct-workflow-block';

          const header = document.createElement('div');
          header.className = 'ct-workflow-header';
          const iconEl = document.createElement('span');
          iconEl.className = 'ct-workflow-icon';
          setIcon(iconEl, 'git-fork');
          const nameEl = document.createElement('span');
          nameEl.className = 'ct-workflow-name';
          nameEl.textContent = event.workflowName ?? event.description;
          const phaseEl = document.createElement('span');
          phaseEl.className = 'ct-workflow-phase';
          this.workflowPhaseEl = phaseEl;
          header.append(iconEl, nameEl, phaseEl);

          const agentList = document.createElement('div');
          agentList.className = 'ct-workflow-agents';

          block.append(header, agentList);
          this.workflowBlockEl = block;
          this.streamingEl!.appendChild(block);
          this.taskPills.set(event.taskId, block);
          this.scrollToBottom();

        } else if (this.activeWorkflowTaskId !== null) {
          // Sub-agent within active workflow — add a row to the workflow block
          const agentList = this.workflowBlockEl?.querySelector<HTMLElement>('.ct-workflow-agents');
          if (agentList) {
            const row = document.createElement('div');
            row.className = 'ct-workflow-agent-row ct-workflow-agent-running';
            const dotEl = document.createElement('span');
            dotEl.className = 'ct-workflow-agent-dot';
            setIcon(dotEl, 'loader');
            const descEl = document.createElement('span');
            descEl.className = 'ct-workflow-agent-desc';
            descEl.textContent = event.description;
            row.append(dotEl, descEl);
            agentList.appendChild(row);
            this.taskPills.set(event.taskId, row);
            this.workflowAgentRows.set(event.taskId, row);
            this.scrollToBottom();
          }
        } else {
          // Regular (non-workflow) sub-agent — existing pill behavior
          const taskPill = document.createElement('div');
          taskPill.className = 'ct-tool-pill ct-tool-active ct-task-pill';
          const taskIconEl = document.createElement('span');
          taskIconEl.className = 'ct-tool-pill-icon';
          setIcon(taskIconEl, event.skipTranscript ? 'layers' : 'bot');
          const taskBadge = document.createElement('span');
          taskBadge.className = 'ct-tool-pill-name';
          taskBadge.textContent = event.skipTranscript ? 'background' : 'sub-agent';
          const taskLabel = document.createElement('span');
          taskLabel.className = 'ct-tool-pill-text';
          taskLabel.textContent = event.description;
          taskPill.append(taskIconEl, taskBadge, taskLabel);
          this.streamingEl!.prepend(taskPill);
          this.taskPills.set(event.taskId, taskPill);
          this.scrollToBottom();
        }
        break;
      }

      case 'task_progress': {
        if (event.taskId === this.activeWorkflowTaskId) {
          // Progress on the workflow itself — update phase label
          if (this.workflowPhaseEl) {
            this.workflowPhaseEl.textContent = event.description ? ` · ${event.description}` : '';
          }
        } else {
          const progressEl = this.taskPills.get(event.taskId);
          if (progressEl) {
            const startedAt = this.taskStartTimes.get(event.taskId);
            const elapsedSec = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
            const elapsedStr = elapsedSec >= 60
              ? `${Math.floor(elapsedSec / 60)}m${elapsedSec % 60}s`
              : elapsedSec > 0 ? `${elapsedSec}s` : '';
            const toolSuffix = event.lastToolName ? ` · ${event.lastToolName}` : '';
            const timeSuffix = elapsedStr ? ` (${elapsedStr})` : '';
            const text = event.description + toolSuffix + timeSuffix;

            if (this.workflowAgentRows.has(event.taskId)) {
              // Workflow sub-agent row
              const descEl = progressEl.querySelector('.ct-workflow-agent-desc');
              if (descEl) descEl.textContent = text;
            } else {
              // Regular pill
              const label = progressEl.querySelector('.ct-tool-pill-text');
              if (label) label.textContent = text;
            }
          }
        }
        break;
      }

      case 'task_notification': {
        if (event.taskId === this.activeWorkflowTaskId) {
          // Workflow orchestrator finished
          if (this.workflowBlockEl) {
            if (event.status === 'completed') {
              this.workflowBlockEl.classList.add('ct-workflow-done');
              if (this.workflowPhaseEl) this.workflowPhaseEl.textContent = ' · Done';
            } else {
              this.workflowBlockEl.classList.add('ct-workflow-failed');
              if (this.workflowPhaseEl) this.workflowPhaseEl.textContent = ' · Failed';
            }
          }
          this.taskPills.delete(event.taskId);
          this.taskStartTimes.delete(event.taskId);
          this.activeWorkflowTaskId = null;
          this.workflowBlockEl = null;
          this.workflowPhaseEl = null;
        } else {
          const notifEl = this.taskPills.get(event.taskId);
          if (notifEl) {
            if (this.workflowAgentRows.has(event.taskId)) {
              // Workflow sub-agent row
              notifEl.classList.remove('ct-workflow-agent-running');
              const dotEl = notifEl.querySelector<HTMLElement>('.ct-workflow-agent-dot');
              const descEl = notifEl.querySelector('.ct-workflow-agent-desc');
              if (event.status === 'completed') {
                notifEl.classList.add('ct-workflow-agent-done');
                if (dotEl) setIcon(dotEl, 'check');
              } else {
                notifEl.classList.add('ct-workflow-agent-failed');
                if (dotEl) setIcon(dotEl, 'x');
              }
              if (descEl) descEl.textContent = event.summary;
              this.workflowAgentRows.delete(event.taskId);
            } else {
              // Regular sub-agent pill — existing behavior
              notifEl.classList.remove('ct-tool-active');
              const iconEl = notifEl.querySelector<HTMLElement>('.ct-tool-pill-icon');
              const label = notifEl.querySelector('.ct-tool-pill-text');
              if (event.status === 'completed') {
                notifEl.classList.add('ct-task-done');
                if (iconEl) setIcon(iconEl, 'check-circle');
              } else {
                notifEl.classList.add('ct-task-failed');
                if (iconEl) setIcon(iconEl, 'x-circle');
              }
              if (label) label.textContent = event.summary;
            }
            this.taskPills.delete(event.taskId);
            this.taskStartTimes.delete(event.taskId);
          }
        }
        this.subagentWaiting = false;
        // When the thread is idle (no active streaming container / no pill), the
        // main.ts subscriber appends a persisted 'notice' message to the
        // transcript (which renders live via the 'message' event). Nothing more
        // needed here.
        break;
      }

      case 'task_updated': {
        // Apply status/description patches to the live task pill when present.
        // task_notification handles terminal states, but task_updated can arrive
        // first for workflow sub-agents or when backgrounded tasks resume.
        const updatedPill = this.taskPills.get(event.taskId);
        if (updatedPill) {
          if (event.description) {
            const label = updatedPill.querySelector('.ct-tool-pill-text');
            if (label) label.textContent = event.description;
          }
          if (event.error) {
            updatedPill.classList.add('ct-task-failed');
            updatedPill.classList.remove('ct-tool-active');
            const iconEl = updatedPill.querySelector<HTMLElement>('.ct-tool-pill-icon');
            if (iconEl) setIcon(iconEl, 'x-circle');
          } else if (event.status === 'completed') {
            updatedPill.classList.add('ct-task-done');
            updatedPill.classList.remove('ct-tool-active');
            const iconEl = updatedPill.querySelector<HTMLElement>('.ct-tool-pill-icon');
            if (iconEl) setIcon(iconEl, 'check-circle');
          }
        }
        break;
      }

      case 'notification': {
        if (event.priority === 'low') break;
        new Notice(event.text, event.priority === 'immediate' ? 0 : 5000);
        break;
      }

      case 'api_retry': {
        this.showStatusCard('active', `Retrying (${event.attempt}/${event.maxRetries})…`);
        break;
      }

      case 'permission_denied': {
        // A tool call was auto-denied without an interactive prompt (auto/dontAsk
        // mode, a deny rule, or a headless auto-deny). Render a distinct annotation
        // so the denial is visible instead of only surfacing as an is_error result.
        if (this.streamingEl) {
          const denyEl = this.streamingEl.createDiv('ct-permission-denied-annotation');
          const iconEl = denyEl.createSpan({ cls: 'ct-permission-denied-icon' });
          setIcon(iconEl, 'shield-off');
          const reason = event.decisionReasonType ? ` · ${event.decisionReasonType}` : '';
          denyEl.createSpan({
            cls: 'ct-permission-denied-text',
            text: `Auto-denied ${formatToolName(event.toolName)}${reason}`,
          });
        }
        break;
      }

      case 'rate_limit': {
        if (event.limitStatus === 'rejected') {
          const resetMsg = event.resetsAt
            ? ` Resets ${new Date(event.resetsAt).toLocaleTimeString()}.`
            : '';
          new Notice(`Rate limit reached.${resetMsg}`, 0);
          this.showStatusCard('rateLimit', '⛔ Rate limited', { variant: 'error' });
        } else if (event.limitStatus === 'allowed_warning') {
          this.showStatusCard('rateLimit', '⚠ Approaching rate limit', { variant: 'warning' });
        }
        break;
      }

      case 'tasks_updated': {
        this.renderTaskCard();
        break;
      }

      case 'tool_result_images': {
        // Render inline images returned by tool results (e.g. Read tool on a PNG).
        const container = this.cardContainer();
        const imgWrap = container.createDiv('ct-tool-result-images');
        for (const img of event.images) {
          imgWrap.createEl('img', {
            attr: {
              src: this.imageSrc(img, img.data),
              style: 'max-width:100%;border-radius:4px;margin-top:6px;display:block;',
            },
          });
        }
        this.scrollToBottom();
        break;
      }

      case 'model_fallback': {
        new Notice(`Claude switched to ${event.toModel} (${event.trigger})`, 5000);
        break;
      }

      case 'model_refusal_fallback': {
        new Notice(event.content || `Claude retried with ${event.fallbackModel}.`, 5000);
        break;
      }

      case 'model_refusal_no_fallback': {
        new Notice(event.content || `Claude ${event.originalModel} could not answer this request.`, 5000);
        break;
      }

      case 'tool_progress': {
        // Update the elapsed-time label on the active pill for this tool_use_id.
        const pill = this.toolPillsByUseId.get(event.toolUseId);
        if (pill) {
          const secs = Math.round(event.elapsedSeconds);
          const label = pill.querySelector<HTMLElement>('.ct-tool-pill-name');
          if (label) {
            label.textContent = `${formatToolName(event.toolName)} (${secs}s)`;
          }
        }
        break;
      }

      case 'memory_recall': {
        // Show a subtle annotation in the streaming element.
        if (this.streamingEl && event.paths.length > 0) {
          const annEl = this.streamingEl.createDiv('ct-memory-recall-annotation');
          annEl.createSpan({ cls: 'ct-memory-recall-label', text: `Recalled ${event.paths.length} memory file${event.paths.length === 1 ? '' : 's'}` });
          const fileList = annEl.createEl('ul', { cls: 'ct-memory-recall-files' });
          for (const p of event.paths) {
            fileList.createEl('li', { text: p.replace(/.*\//, '') });
          }
        }
        break;
      }

      case 'commands_changed': {
        // Forward the updated command list to the dispatch input autocomplete.
        this.dispatchInput?.setAvailableCommands?.(event.commands);
        break;
      }

      case 'task_progress_summary': {
        // Update the task pill label with the AI-generated summary.
        const progressEl = this.taskPills.get(event.taskId);
        if (progressEl) {
          const label = progressEl.querySelector<HTMLElement>('.ct-tool-pill-text');
          if (label) label.textContent = event.summary;
        }
        break;
      }

      case 'git_operation': {
        // Show a brief git-activity annotation below the active streaming content.
        if (this.streamingEl) {
          const gitEl = this.streamingEl.createDiv('ct-git-operation-annotation');
          gitEl.createSpan({ cls: 'ct-git-operation-text', text: event.summary });
        }
        break;
      }

      case 'file_user_modified': {
        this.userModifiedFilesSet.add(event.filePath);
        this.renderEditedFilesCard();
        break;
      }

      case 'files_edited': {
        for (const filePath of event.paths) {
          this.editedFilesSet.delete(filePath);
          this.editedFilesSet.add(filePath);
        }
        this.renderEditedFilesCard();
        break;
      }

      case 'tool_result_status': {
        // ClaudeSession mutates the SAME ToolCallRecord object in place
        // (record.status = status — see the 'user'/tool_result handling in
        // ClaudeSession.ts) and that object is the exact one held in
        // streamingBuffers.get(threadId).tools, so buf.tools already reflects
        // the new status by the time this event fires. Just trigger the
        // debounced rebuild so the live pill/group picks it up — no manual
        // DOM class-swap needed.
        if (this.streamingEl) this.scheduleLiveToolsRender();
        break;
      }

      case 'capabilities_discovered': {
        // Dynamically extend the model selector with models discovered from the active session.
        // Store for later so /context can reference agent names too.
        this.discoveredModels = event.models;
        this.discoveredAgents = event.agents;
        // Merge into the plugin-level list (deduplicated by value) so that
        // SettingsTab can build dynamic model dropdowns from discovered models.
        if (event.models.length > 0) {
          const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : undefined;
          const harness = thread?.agentHarness ?? 'claude';
          const harnessModels = this.plugin.discoveredModelsByHarness[harness];
          const existing = new Set(harnessModels.map((m) => m.value));
          for (const m of event.models) {
            if (!existing.has(m.value)) {
              harnessModels.push(m);
              if (harness === 'claude') this.plugin.discoveredModels.push(m);
              existing.add(m.value);
            }
          }
        }
        break;
      }

      case 'elicitation_request': {
        if (event.request.mode === 'url' && event.request.url) {
          this.renderElicitationUrlCard(event.request, event.signal, event.respond);
        } else {
          this.renderElicitationFormCard(event.request, event.signal, event.respond);
        }
        break;
      }

      case 'enter_plan_mode': {
        // Show a "Planning..." status card so the user knows Claude is in read-only planning mode.
        this.showStatusCard('active', 'Planning...');
        break;
      }

      case 'plan_ready': {
        // Clear the "Planning..." card and show the Approve/Reject/Edit card.
        this.activeWorkCardEl?.remove();
        this.activeWorkCardEl = null;
        this.renderPlanCard(event.planText, event.approve, event.reject);
        break;
      }

      case 'reconnecting': {
        // Transient auto-recovery notice — the closed-source CLI binary
        // spuriously force-closed the transport mid-tool-call, but the
        // action may have succeeded server-side. ThreadManager is about to
        // auto-fire one follow-up turn, so this is not a terminal error:
        // keep it visually distinct from the red 'error' treatment and skip
        // the full error-path teardown (task pills, workflow state, etc.)
        // since the session is retrying, not ending.
        if (this.streamingEl) {
          this.streamingEl.remove();
          this.streamingEl = null;
          this.streamingContentEl = null;
          this.streamingToolsEl = null;
        }
        const noticeEl = this.messagesEl.createDiv('ct-message ct-reconnecting');
        noticeEl.createEl('div', {
          text: 'Connection interrupted — automatically reconnecting…',
          cls: 'ct-reconnecting-text',
        });
        this.scrollToBottom();
        break;
      }

      case 'rate_limit_retry': {
        // The API rejected this turn with a rate-limit/overload error before
        // it was ever processed. ThreadManager is silently replaying the
        // exact same turn after a backoff delay — not a terminal error, and
        // not a new user-visible message, so reuse the same visual treatment
        // as the transport-closed 'reconnecting' notice above, just with
        // rate-limit-specific copy.
        if (this.streamingEl) {
          this.streamingEl.remove();
          this.streamingEl = null;
          this.streamingContentEl = null;
        }
        const rateLimitNoticeEl = this.messagesEl.createDiv('ct-message ct-reconnecting');
        rateLimitNoticeEl.createEl('div', {
          text: `Rate limited by the API — retrying in ${Math.round(event.delayMs / 1000)}s (attempt ${event.attempt}/${event.maxRetries})…`,
          cls: 'ct-reconnecting-text',
        });
        this.scrollToBottom();
        break;
      }

      case 'error': {
        this.clearStreamingState();
        this.taskPills.clear();
        this.taskStartTimes.clear();
        this.toolPillsByUseId.clear();
        this.subagentWaiting = false;
        this.activeWorkflowTaskId = null;
        this.workflowBlockEl = null;
        this.workflowPhaseEl = null;
        this.workflowAgentRows.clear();
        if (this.streamingEl) {
          this.streamingEl.remove();
          this.streamingEl = null;
          this.streamingContentEl = null;
        }
        const errEl = this.messagesEl.createDiv('ct-message ct-error');
        const { headline, stack } = splitErrorMessage(event.error.message);
        errEl.createEl('div', {
          text: headline,
          cls: 'ct-error-text',
        });
        if (stack) {
          const detailsEl = errEl.createEl('details', { cls: 'ct-error-details' });
          detailsEl.createEl('summary', { text: 'Show technical details' });
          detailsEl.createEl('pre', { text: stack, cls: 'ct-error-stack' });
        }
        // ── AWS SSO reauth button ──────────────────────────────────────────
        // When the error looks like an expired SSO token, show a one-click
        // button inline in the conversation so the user doesn't need to find
        // the Agent Dashboard to re-authenticate.
        if (isAwsSsoError(event.error.message)) {
          const profile = extractAwsProfile(this.plugin.settings.extraEnv ?? '');
          const reauthBtn = errEl.createEl('button', {
            cls: 'ct-aws-reauth-btn',
            text: '🔑 Re-authenticate AWS SSO',
          });
          reauthBtn.addEventListener('click', async () => {
            reauthBtn.setText('Authenticating…');
            reauthBtn.disabled = true;
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { exec } = require('child_process') as typeof import('child_process');
              const awsBin = resolveAwsBinary();
              const cmd = profile ? `${awsBin} sso login --profile ${profile}` : `${awsBin} sso login`;
              await new Promise<void>((resolve, reject) => {
                exec(cmd, { env: awsExecEnv() }, (err, _stdout, stderr) => {
                  if (err) reject(new Error(stderr?.trim() || err.message));
                  else resolve();
                });
              });
              new Notice('AWS SSO login successful — retry your request');
              reauthBtn.setText('✓ Done — retry your request');
            } catch (err) {
              new Notice(`AWS SSO login failed: ${(err as Error).message}`);
              reauthBtn.setText('🔑 Re-authenticate AWS SSO');
              reauthBtn.disabled = false;
            }
          });
        }
        this.setRunningState(false);
        this.scrollToBottom();
        break;
      }
    }
  }

  // ── Status rail helpers ───────────────────────────────────────────────────
  // showStatusCard / clearStatusCard: typed cards for persistent states
  // showEphemeralToast: 2-second auto-dismiss for one-off notices
  // renderQueueRows: rebuilds the stacked queue rows above the composer

  /**
   * Show or replace a typed status card in the rail.
   * type 'active': blue card with a CSS spinner (compacting, retrying, summarizing)
   * type 'rateLimit': colored warning/error card for rate-limit states
   */
  private showStatusCard(
    type: 'active' | 'rateLimit',
    text: string,
    opts?: { variant?: 'warning' | 'error' },
  ): void {
    if (type === 'active') {
      this.activeWorkCardEl?.remove();
      const card = this.statusRailEl.createDiv('ct-status-card ct-status-card-active');
      card.createSpan({ cls: 'ct-status-card-spinner' });
      card.createSpan({ cls: 'ct-status-card-text', text });
      this.activeWorkCardEl = card;
    } else {
      this.rateLimitCardEl?.remove();
      const variant = opts?.variant ?? 'warning';
      const card = this.statusRailEl.createDiv(
        `ct-status-card ct-status-card-${variant}`,
      );
      card.createSpan({ cls: 'ct-status-card-text', text });
      this.rateLimitCardEl = card;
    }
  }

  private clearStatusCard(type: 'active' | 'rateLimit'): void {
    if (type === 'active') {
      this.activeWorkCardEl?.remove();
      this.activeWorkCardEl = null;
    } else {
      this.rateLimitCardEl?.remove();
      this.rateLimitCardEl = null;
    }
  }

  /**
   * Show a transient popover tip above the model button when the session
   * escalates to a different model for a turn. Positions absolutely off the
   * button so it causes zero layout shift. Self-removes when the CSS
   * animation finishes (~3 s total).
   */
  private showModelEscalationTip(text: string): void {
    if (!this.moreBtn) return;
    // Remove any in-flight tip before showing a new one.
    this.moreBtn.querySelector('.ct-escalation-tip')?.remove();
    const tip = this.moreBtn.createDiv('ct-escalation-tip');
    tip.setText(text);
    tip.addEventListener('animationend', () => tip.remove(), { once: true });
  }

  /** Rebuild the stacked queue rows. */
  private renderQueueRows(): void {
    if (!this.queueRowsEl || !this.activeThreadId) {
      this.queueRowsEl?.addClass('ct-hidden');
      return;
    }
    const msgs = this.manager.getQueuedMessages(this.activeThreadId);
    this.queueRowsEl.empty();
    if (msgs.length === 0) {
      this.queueRowsEl.addClass('ct-hidden');
      return;
    }
    this.queueRowsEl.removeClass('ct-hidden');

    const MAX_VISIBLE = 3;
    const visible = msgs.length <= MAX_VISIBLE ? msgs : msgs.slice(0, MAX_VISIBLE);

    visible.forEach((msg, i) => {
      const row = this.queueRowsEl.createDiv('ct-queue-row');

      // × delete button
      const del = row.createEl('button', { cls: 'ct-queue-row-delete', text: '×', attr: { title: 'Remove' } });
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this.activeThreadId) return;
        this.manager.removeQueuedMessageAt(this.activeThreadId, i);
        this.renderQueueRows();
      });

      // preview text
      const preview = msg.text.length > 60 ? msg.text.slice(0, 60) + '…' : msg.text;
      const previewEl = row.createSpan({ cls: 'ct-queue-row-preview', text: preview || '(empty)' });

      // 📎 if has images
      if (msg.images && msg.images.length > 0) {
        row.createSpan({ cls: 'ct-queue-row-attach', text: ' 📎' });
      }

      // click row body → pull into composer (B2)
      previewEl.addEventListener('click', () => this.pullQueuedIntoComposer(i));
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.ct-queue-row-delete')) return;
        this.pullQueuedIntoComposer(i);
      });
    });

    // "+N more" row
    if (msgs.length > MAX_VISIBLE) {
      const extra = msgs.length - MAX_VISIBLE;
      const more = this.queueRowsEl.createDiv('ct-queue-more');
      more.setText(`+${extra} more queued`);
    }
  }

  /**
   * Pull a queued message at the given index into the composer (B2).
   * If the composer has content, insert an inline confirm row first.
   */
  private pullQueuedIntoComposer(index: number): void {
    if (!this.activeThreadId) return;
    const msgs = this.manager.getQueuedMessages(this.activeThreadId);
    const msg = msgs[index];
    if (!msg) return;

    const currentText = this.dispatchInput?.getValue()?.trim() ?? '';
    const doLoad = () => {
      if (!this.activeThreadId) return;
      this.manager.removeQueuedMessageAt(this.activeThreadId, index);
      this.dispatchInput?.setValue(msg.text);
      if (msg.images && msg.images.length > 0) {
        this.dispatchInput?.setPendingImages(msg.images);
      }
      this.renderQueueRows();
      this.dispatchInput?.focus();
    };

    if (!currentText) {
      doLoad();
      return;
    }

    // Show inline confirm row
    // Remove any existing confirm row
    this.queueRowsEl.querySelector('.ct-queue-confirm')?.remove();
    const row = this.queueRowsEl.querySelectorAll('.ct-queue-row')[index];
    if (!row) { doLoad(); return; }

    const confirm = this.queueRowsEl.createDiv('ct-queue-confirm');
    confirm.createSpan({ text: 'Replace draft?' });
    const yes = confirm.createEl('button', { cls: 'ct-queue-confirm-yes', text: 'Yes' });
    const no = confirm.createEl('button', { cls: 'ct-queue-confirm-no', text: 'Cancel' });
    yes.addEventListener('click', () => { confirm.remove(); doLoad(); });
    no.addEventListener('click', () => confirm.remove());
    row.after(confirm);
  }

  private setRunningState(running: boolean): void {
    this.dispatchInput?.setStreaming(
      running,
      !!this.activeThreadId && this.manager.hasPendingQuestion(this.activeThreadId),
    );
    if (!running) {
      this.clearStatusCard('active');
    }
    // Queue rows should always reflect current queue state.
    this.renderQueueRows();
    this.renderScheduledActivity();
  }

  private scheduledActivity(): ScheduledActivity[] {
    return scheduledActivityForThread(this.plugin.scheduler.listItems(), this.activeThreadId);
  }

  private renderScheduledActivity(rebuildPopover = true): void {
    if (!this.schedulePillEl) return;
    const activity = this.scheduledActivity();
    this.schedulePillEl.toggleClass('ct-hidden', activity.length === 0);
    const label = scheduledActivitySummary(activity);
    const text = this.schedulePillEl.querySelector('.ct-schedule-pill-text');
    if (text) text.textContent = label;
    this.schedulePillEl.setAttribute('aria-label', label ? `${label}. View scheduled activity` : 'View scheduled activity');
    if (activity.length === 0) {
      this.closeSchedulePopover();
      this.stopWakeupCountdown();
      return;
    }
    this.startWakeupCountdown();
    if (this.schedulePopoverEl) {
      if (rebuildPopover) this.renderSchedulePopoverRows();
      else this.reconcileSchedulePopover(activity);
    }
  }

  private toggleSchedulePopover(): void {
    if (this.schedulePopoverEl) {
      this.closeSchedulePopover();
      this.schedulePillEl?.focus();
    } else {
      this.openSchedulePopover();
    }
  }

  private openSchedulePopover(): void {
    if (!this.schedulePillEl || this.scheduledActivity().length === 0) return;
    const wrapper = this.mainEl.querySelector('.ct-panel-wrapper') as HTMLElement | null;
    if (!wrapper) return;
    const popover = wrapper.createDiv('ct-schedule-popover');
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', 'Scheduled activity');
    this.schedulePopoverEl = popover;
    this.schedulePillEl.setAttribute('aria-expanded', 'true');
    const header = popover.createDiv('ct-schedule-popover-header');
    header.createSpan({ cls: 'ct-schedule-popover-title', text: 'Scheduled activity' });
    const close = header.createEl('button', { cls: 'ct-schedule-popover-close', attr: { type: 'button', 'aria-label': 'Close scheduled activity' } });
    setIcon(close, 'x');
    close.addEventListener('click', () => { this.closeSchedulePopover(); this.schedulePillEl?.focus(); });
    popover.createDiv('ct-schedule-popover-list');
    this.renderSchedulePopoverRows();
    popover.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeSchedulePopover();
        this.schedulePillEl?.focus();
      }
    });
    this.schedulePopoverOutsideTimer = setTimeout(() => {
      this.schedulePopoverOutsideTimer = null;
      if (this.schedulePopoverEl !== popover || !popover.isConnected) return;
      this.schedulePopoverOutsideHandler = (event: MouseEvent) => {
        if (!popover.contains(event.target as Node) && !this.schedulePillEl?.contains(event.target as Node)) this.closeSchedulePopover();
      };
      document.addEventListener('mousedown', this.schedulePopoverOutsideHandler, true);
    }, 0);
    (popover.querySelector('.ct-schedule-action') as HTMLElement | null)?.focus();
  }

  private closeSchedulePopover(): void {
    this.schedulePopoverEl?.remove();
    this.schedulePopoverEl = null;
    this.schedulePillEl?.setAttribute('aria-expanded', 'false');
    if (this.schedulePopoverOutsideTimer !== null) clearTimeout(this.schedulePopoverOutsideTimer);
    this.schedulePopoverOutsideTimer = null;
    if (this.schedulePopoverOutsideHandler) document.removeEventListener('mousedown', this.schedulePopoverOutsideHandler, true);
    this.schedulePopoverOutsideHandler = null;
  }

  private renderSchedulePopoverRows(activity = this.scheduledActivity()): void {
    const list = this.schedulePopoverEl?.querySelector('.ct-schedule-popover-list') as HTMLElement | null;
    if (!list) return;
    list.empty();
    for (const entry of activity) {
      const row = list.createDiv(`ct-schedule-row ct-schedule-row-${entry.kind}`);
      row.dataset.scheduleId = entry.id;
      const icon = row.createDiv('ct-schedule-row-icon');
      setIcon(icon, entry.kind === 'wakeup' ? 'hourglass' : 'repeat');
      const body = row.createDiv('ct-schedule-row-body');
      body.createDiv({ cls: 'ct-schedule-row-type', text: entry.kind === 'wakeup' ? 'One-time wakeup' : 'Recurring loop' });
      body.createDiv({ cls: 'ct-schedule-row-detail', text: this.scheduleActivityDetail(entry) });
      body.createDiv({ cls: 'ct-schedule-row-label', text: entry.label });
      const action = row.createEl('button', { cls: 'ct-schedule-action', text: entry.kind === 'wakeup' ? 'Cancel' : 'Stop', attr: { type: 'button', 'aria-label': `${entry.kind === 'wakeup' ? 'Cancel' : 'Stop'} ${entry.label}` } });
      action.addEventListener('click', async () => {
        try {
          await deleteScheduledActivity(
            entry,
            (id) => this.plugin.scheduler.deleteItem(id),
            (threadId) => this.manager.notifyWakeupChanged(threadId),
          );
          this.renderScheduledActivity();
          this.renderStatusFooter();
          (this.schedulePopoverEl?.querySelector('.ct-schedule-action') as HTMLElement | null)?.focus();
        } catch (error) {
          this.renderScheduledActivity();
          const subject = entry.kind === 'wakeup' ? 'Wakeup canceled' : 'Loop stopped';
          this.showCommandDivider(`${subject} in this session, but persistence failed (${(error as Error).message}). It may return after reload.`, true);
        }
      });
    }
  }

  private scheduleActivityDetail(activity: ScheduledActivity): string {
    return activity.kind === 'wakeup'
      ? `${formatWakeupCountdown(activity.nextRun)} · ${new Date(activity.nextRun).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : `Every ${formatLoopInterval(activity.intervalSeconds ?? 0)} · next ${Number.isFinite(activity.nextRun) ? new Date(activity.nextRun).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'pending'}`;
  }

  private reconcileSchedulePopover(activity: ScheduledActivity[]): void {
    const rows = [...(this.schedulePopoverEl?.querySelectorAll<HTMLElement>('.ct-schedule-row') ?? [])];
    const renderedIds = rows.map((row) => row.dataset.scheduleId ?? '');
    const activityIds = activity.map((entry) => entry.id);
    const sameMembershipAndOrder = renderedIds.length === activityIds.length
      && renderedIds.every((id, index) => id === activityIds[index]);
    if (!sameMembershipAndOrder) {
      const focusedId = document.activeElement instanceof HTMLElement
        ? document.activeElement.closest<HTMLElement>('.ct-schedule-row')?.dataset.scheduleId
        : undefined;
      this.renderSchedulePopoverRows(activity);
      if (focusedId) {
        const focusedRow = [...(this.schedulePopoverEl?.querySelectorAll<HTMLElement>('.ct-schedule-row') ?? [])]
          .find((row) => row.dataset.scheduleId === focusedId);
        focusedRow?.querySelector<HTMLElement>('.ct-schedule-action')?.focus();
      }
      return;
    }
    const byId = new Map(activity.map((entry) => [entry.id, entry]));
    for (const row of rows) {
      const entry = row.dataset.scheduleId ? byId.get(row.dataset.scheduleId) : undefined;
      const detail = row.querySelector<HTMLElement>('.ct-schedule-row-detail');
      if (entry && detail) detail.textContent = this.scheduleActivityDetail(entry);
    }
  }

  private startWakeupCountdown(): void {
    if (this.wakeupCountdownTimer !== null) return;
    this.wakeupCountdownTimer = setInterval(() => this.tickWakeupCountdown(), 1000);
  }

  private stopWakeupCountdown(): void {
    if (this.wakeupCountdownTimer !== null) {
      clearInterval(this.wakeupCountdownTimer);
      this.wakeupCountdownTimer = null;
    }
  }

  /** Refresh countdown and next-run text without requiring the popover to reopen. */
  private tickWakeupCountdown(): void {
    this.renderScheduledActivity(false);
  }

  private scrollToBottom(): void {
    // Use rAF so we read scrollHeight after the browser has reflowed the DOM.
    // Without this, prepending a tool-call pill and immediately reading
    // scrollHeight can return a stale value that undershoots the new bottom.
    // No panel-height sync needed — ct-panel-wrapper is an in-flow flex child
    // so the browser keeps ct-messages sized correctly automatically.
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }


  /** Render a one-line centered status divider in the message list. */
  private showCommandDivider(text: string, isError = false): void {
    if (isError) {
      const errEl = this.messagesEl.createDiv('ct-message ct-error');
      errEl.createEl('p', { text });
    } else {
      const divider = this.messagesEl.createDiv('ct-compact-divider');
      divider.createSpan({ cls: 'ct-compact-label', text });
    }
    this.scrollToBottom();
  }

  private async handleGoalCommand(arg: string): Promise<void> {
    if (!this.activeThreadId) return;
    const threadId = this.activeThreadId;
    const thread = this.manager.getThread(threadId);

    if (!arg) {
      this.showCommandDivider(
        thread?.goal ? `Goal: ${thread.goal}` : 'No goal set. Use /goal <text> to set one.',
      );
      return;
    }

    if (/^(clear|off|done)$/i.test(arg)) {
      const hadGoal = !!thread?.goal;
      await this.applyThreadGoal(threadId, undefined);
      if (this.activeThreadId === threadId) {
        this.showCommandDivider(hadGoal ? 'Goal cleared' : 'No goal was set.');
      }
      return;
    }

    await this.applyThreadGoal(threadId, arg);
    if (this.activeThreadId === threadId) this.showCommandDivider(`Goal set: ${arg}`);
  }

  /** Shared thread-specific action for /goal and the message context menu. */
  private async applyThreadGoal(threadId: string, goal: string | undefined): Promise<void> {
    const revision = this.manager.setThreadGoal(threadId, goal);
    try {
      await this.plugin.saveSettings();
    } catch (error) {
      this.manager.rollbackThreadGoal(threadId, revision);
      throw error;
    }

    if (goal) {
      void this.manager.requestGoalKickoff(threadId, revision, goalKickoffMessage(goal)).catch((error) => {
        this.surfaceGoalActionError(threadId, error);
      });
    } else {
      this.manager.requestGoalContextRefresh(threadId, revision);
    }

    if (this.activeThreadId === threadId) this.renderThreadInfo();
  }

  private surfaceGoalActionError(threadId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.activeThreadId === threadId) {
      this.showCommandDivider(`Failed to set goal: ${message}`, true);
      this.setRunningState(this.manager.isRunning(threadId));
    } else {
      new Notice(`Failed to set goal: ${message}`);
    }
  }

  private attachSetAsGoalMenu(el: HTMLElement, message: ChatMessage): void {
    el.dataset.messageId = message.id;
    el.addEventListener('contextmenu', (event) => {
      const threadId = this.activeThreadId;
      if (!threadId) return;
      const thread = this.manager.getThread(threadId);
      if (!thread || !isSetAsGoalEligible(thread.messages, message)) return;

      event.preventDefault();
      const menu = new Menu();
      menu.addItem((item) => item
        .setTitle('Set as goal')
        .setIcon('target')
        .onClick(() => {
          const current = this.manager.getThread(threadId);
          if (!current || !isSetAsGoalEligible(current.messages, message)) return;
          void this.applyThreadGoal(threadId, message.content).catch((error) => {
            this.surfaceGoalActionError(threadId, error);
          });
        }));
      menu.showAtMouseEvent(event);
    });
  }

  /**
   * /create-pr [--draft] — also invoked directly by the git diff bar's Create
   * PR / Create draft PR buttons (via handleSendFromDispatch), so button
   * clicks and typing the command behave identically.
   */
  private async handleCreatePrCommand(draft: boolean): Promise<void> {
    if (!this.activeThreadId) return;
    this.showCommandDivider(draft ? 'Creating draft PR…' : 'Creating PR…');

    const sendThreadId = this.activeThreadId;
    this.manager
      .sendMessage(sendThreadId, resolveCreatePrMessage(this.plugin.settings, draft))
      .catch((err) => {
        this.showCommandDivider(`Failed to send: ${(err as Error).message}`, true);
        if (this.activeThreadId === sendThreadId) this.setRunningState(false);
      });
  }

  private async handleDesignCommand(brief: string): Promise<void> {
    if (!this.activeThreadId) return;
    const thread = this.manager.getThread(this.activeThreadId);
    if (!thread) return;
    if (!brief && !thread.artifacts?.length) {
      this.showCommandDivider('Include a brief — e.g. /design a responsive pricing page for a developer tool', true);
      return;
    }

    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      this.showCommandDivider('Design artifacts require a desktop vault with local filesystem access.', true);
      return;
    }
    const existing = thread.artifacts?.find((artifact) => artifact.kind === 'design-static');
    let artifact: DesignArtifact;
    try {
      const result = await this.plugin.enterDesignMode(
        thread.id,
        brief || existing?.title || 'Design artifact',
        true,
      );
      artifact = result.artifact;
    } catch (error) {
      this.showCommandDivider(`Could not prepare the design artifact: ${(error as Error).message}`, true);
      return;
    }

    if (!brief) {
      this.showCommandDivider(`Opened design artifact: ${artifact.title}`);
      return;
    }
    this.showCommandDivider(existing ? 'Revising design artifact…' : 'Design artifact created. Starting design turn…');
    const sendThreadId = thread.id;
    // Loaded on demand: the view must not carry a build-time dependency on an
    // optional capability (ADR-0008).
    const { designKickoffMessage } = await import('./designArtifact');
    this.manager.sendMessage(sendThreadId, designKickoffMessage(artifact, brief)).catch((error) => {
      this.showCommandDivider(`Failed to start design turn: ${(error as Error).message}`, true);
      if (this.activeThreadId === sendThreadId) this.setRunningState(false);
    });
  }

  private async handleLoopCommand(arg: string): Promise<void> {
    if (!this.activeThreadId) return;
    const threadId = this.activeThreadId;
    const loopsForThread = () =>
      this.plugin.scheduler.listItems().filter((i) =>
        i.enabled && i.targetThreadId === threadId && i.schedule.type === 'interval',
      );

    if (!arg) {
      const loops = loopsForThread();
      if (loops.length === 0) {
        this.showCommandDivider('No loop running. Use /loop <interval> <prompt>, e.g. /loop 5m check the build');
        return;
      }
      for (const loop of loops) {
        const secs = loop.schedule.intervalSeconds ?? 0;
        const next = loop.nextRun ? new Date(loop.nextRun).toLocaleTimeString() : 'soon';
        this.showCommandDivider(
          `Loop every ${formatLoopInterval(secs)} — "${loop.prompt.slice(0, 60)}" (next: ${next})`,
        );
      }
      return;
    }

    if (/^(stop|off|cancel|clear)$/i.test(arg)) {
      const loops = loopsForThread();
      if (loops.length === 0) {
        this.showCommandDivider('No loop to stop.');
        return;
      }
      await Promise.all(loops.map((loop) => this.plugin.scheduler.deleteItem(loop.id)));
      this.showCommandDivider(`Stopped ${loops.length} loop${loops.length > 1 ? 's' : ''}.`);
      this.renderScheduledActivity();
      this.renderStatusFooter();
      return;
    }

    const parsed = parseLoopArgs(arg);
    if (!parsed) {
      this.showCommandDivider(
        'Usage: /loop <interval> <prompt> — interval like 30s, 5m, 1h. Example: /loop 10m check CI status',
        true,
      );
      return;
    }

    // Replace, not stack: a thread can only have one active loop. Delete any
    // existing loop(s) targeting this thread before creating the new one.
    const existing = loopsForThread();
    await Promise.all(existing.map((loop) => this.plugin.scheduler.deleteItem(loop.id)));

    const thread = this.manager.getThread(threadId);
    await this.plugin.scheduler.createItem({
      name: `Loop: ${parsed.prompt.slice(0, 40)}`,
      prompt: parsed.prompt,
      schedule: { type: 'interval', intervalSeconds: parsed.intervalSeconds },
      enabled: true,
      cwd: thread?.cwd,
      projectId: thread?.projectId,
      targetThreadId: threadId,
    });
    const replacedNote = existing.length > 0 ? ' (replaced previous loop)' : '';
    this.showCommandDivider(
      `Loop started: "${parsed.prompt.slice(0, 60)}" every ${formatLoopInterval(parsed.intervalSeconds)}${replacedNote}. Stop with /loop stop.`,
    );
    this.renderScheduledActivity();
    this.renderStatusFooter();

    // Kick off the loop immediately rather than waiting for the first
    // interval to elapse.
    this.manager.sendMessage(threadId, parsed.prompt).catch((err) => {
      this.showCommandDivider(`Failed to send: ${(err as Error).message}`, true);
      this.clearEscalatedTurn(threadId);
      if (this.activeThreadId === threadId) this.setRunningState(false);
    });
  }

  private async handleSendFromDispatch(
    typed: string,
    images: ImageAttachment[],
    attachment: string | null,
  ): Promise<void> {
    if (!this.activeThreadId) return;

    // A message always goes to the thread, never to a child agent. Leave the
    // child view first so the send visibly lands in the main conversation
    // instead of being silently redirected out of sight. No-op when already there.
    await this.exitAgentView();

    this.lastSentTexts.set(this.activeThreadId, typed);

    // Clear any saved draft for this thread so it doesn't reappear
    const thread = this.manager.getThread(this.activeThreadId);
    if (thread) delete thread.draft;

    // Dismiss the context banner as soon as the user sends
    this.hideSummaryBanner(false);

    // /fork [optional focus] — open ForkModal without sending a message to Claude.
    const forkMatch = typed.match(/^\/fork(?:\s+([\s\S]+))?$/i);
    if (forkMatch) {
      const focusArea = (forkMatch[1] ?? '').trim();
      await this.forkThread(this.activeThreadId!, focusArea || undefined);
      return;
    }

    // /context — show context window usage breakdown for the active session.
    if (/^\/context$/i.test(typed.trim())) {
      const usage = await this.manager.getContextUsage(this.activeThreadId);
      if (!usage) {
        this.showCommandDivider('No active session — start a conversation first.');
      } else {
        this.renderContextUsageCard(usage);
      }
      return;
    }

    // /usage — cross-provider token totals, quota windows, and account activity.
    // /cost remains untouched as the harness-native command for compatibility.
    if (/^\/usage$/i.test(typed.trim())) {
      const usage = await this.manager.getUsageSnapshot(this.activeThreadId);
      if (!usage) this.showCommandDivider('Usage is unavailable — start a conversation first.');
      else this.renderUsageCard(usage);
      return;
    }

    // /ephemeral — mark this thread as ephemeral (sessions not persisted to disk).
    if (/^\/ephemeral$/i.test(typed.trim())) {
      const t = thread;
      if (t) {
        const wasEphemeral = !!t.ephemeral;
        t.ephemeral = !wasEphemeral;
        await this.plugin.saveSettings();
        this.renderTitleBar();
        this.showCommandDivider(
          t.ephemeral
            ? 'Ephemeral mode on: future sessions in this thread will not be persisted to disk.'
            : 'Ephemeral mode off: sessions in this thread will be persisted normally.',
        );
      }
      return;
    }

    // Bare escalation keyword (e.g. "/escalate" with no prompt) — show a
    // usage error instead of sending an empty escalated turn, matching /goal.
    if (this.plugin.settings.escalationEnabled) {
      const keyword = (this.plugin.settings.escalationKeyword ?? '').trim();
      if (keyword.startsWith('/') && keyword.length > 1) {
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`^${escaped}$`, 'i').test(typed.trim())) {
          this.showCommandDivider(`Include a prompt — e.g. "${keyword} fix the failing build"`);
          return;
        }
      }
    }

    // /design [brief] — create/revise, or reopen the thread's static artifact.
    const designMatch = typed.match(/^\/design(?:\s+([\s\S]+))?$/i);
    if (designMatch) {
      await this.handleDesignCommand((designMatch[1] ?? '').trim());
      return;
    }

    // /goal [text | clear] — set/show/clear the persistent goal for this thread.
    const goalMatch = typed.match(/^\/goal(?:\s+([\s\S]+))?$/i);
    if (goalMatch) {
      await this.handleGoalCommand((goalMatch[1] ?? '').trim());
      return;
    }

    // /loop [interval prompt | stop] — recurring prompt into this thread.
    const loopMatch = typed.match(/^\/loop(?:\s+([\s\S]+))?$/i);
    if (loopMatch) {
      await this.handleLoopCommand((loopMatch[1] ?? '').trim());
      return;
    }

    // /create-pr [--draft] — same action as the git diff bar's Create PR / Create draft PR buttons.
    const createPrMatch = typed.match(/^\/create-pr(?:\s+(--draft|draft))?\s*$/i);
    if (createPrMatch) {
      await this.handleCreatePrCommand(!!createPrMatch[1]);
      return;
    }

    let text = typed;
    if (attachment) {
      text = typed
        ? `${typed}\n\n\`\`\`\n${attachment}\n\`\`\``
        : `\`\`\`\n${attachment}\n\`\`\``;
    }

    // Resolve @this — substitute the currently open file before the mention resolver runs
    if (/@this\b/.test(text)) {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) {
        text = text.replace(/@this\b/g, `@[[${activeFile.basename}]]`);
      } else {
        new Notice('@this: no file is currently open in the editor');
      }
    }

    // Resolve @[[basename]] file mentions
    const mentionRegex = /@\[\[([^\]]+)\]\]/g;
    const mentions = [...text.matchAll(mentionRegex)].map(m => m[1]);
    if (mentions.length > 0) {
      const fileContextParts: string[] = [];
      for (const basename of mentions) {
        const file = this.app.vault.getMarkdownFiles().find(f => f.basename === basename);
        if (file) {
          try {
            const content = await this.app.vault.cachedRead(file);
            fileContextParts.push(`**File: ${file.path}**\n\`\`\`\n${content}\n\`\`\``);
          } catch { /* skip */ }
        }
      }
      if (fileContextParts.length > 0) {
        text = text + '\n\n---\nReferenced files:\n\n' + fileContextParts.join('\n\n');
      }
    }

    // A normal composer submission while AskUserQuestion is open is the
    // user's free-form answer to that prompt. Resolve the blocking callback
    // directly instead of queueing a second turn behind it. For a multi-part
    // question card, apply the free-form response to each unanswered prompt;
    // the structured card remains available when distinct answers are needed.
    const pendingQuestions = thread?.pendingQuestions;
    if (pendingQuestions && this.manager.hasPendingQuestion(this.activeThreadId)) {
      const answer = text || (images.length > 0 ? '[See attached image]' : '');
      const answers = Object.fromEntries(pendingQuestions.map(q => [q.question, answer]));
      this.manager.resolveQuestion(this.activeThreadId, answers);
      return;
    }

    if (!this.manager.isRunning(this.activeThreadId)) {
      // Remove the "Ask Claude anything" empty-state placeholder before appending
      // the first real bubble. Leaving it in the DOM causes height: 100% to double
      // the scroll area, pushing tool-call pills behind the floating input panel.
      this.messagesEl.querySelector('.ct-empty')?.remove();
      const userEl = this.messagesEl.createDiv('ct-message ct-message-user');
      this.pendingUserEl = userEl;
      const content = userEl.createDiv('ct-message-content');
      if (typed) content.createEl('p', { text: typed });
      if (attachment) {
        const attachRow = content.createDiv('ct-message-attachment');
        attachRow.createSpan({ text: '📄 ' });
        attachRow.createSpan({ cls: 'ct-message-attachment-label', text: `${attachment.length.toLocaleString()} chars pasted` });
      }
      if (images.length > 0) {
        const imgRow = content.createDiv('ct-message-images');
        for (const img of images) {
          const thumb = imgRow.createEl('img', { cls: 'ct-message-img-thumb' });
          thumb.src = this.imageSrc(img, img.base64);
          thumb.title = img.name;
        }
      }
      this.scrollToBottom();
    }

    const modelMatch = typed.match(/^\/model(?:\s+(\S+))?$/i);
    if (modelMatch) {
      const arg = (modelMatch[1] ?? '').toLowerCase();
      if (!arg) {
        const currentThread = this.manager.getThread(this.activeThreadId);
        const current = currentThread?.model ?? 'default';
        const infoEl = this.messagesEl.createDiv('ct-compact-divider');
        infoEl.createSpan({ cls: 'ct-compact-label', text: `Model: ${current}` });
        this.scrollToBottom();
        return;
      }
      const activeThread = this.manager.getThread(this.activeThreadId);
      const isCodex = activeThread?.agentHarness === 'codex';
      const codexModel = isCodex
        ? this.plugin.discoveredModelsByHarness.codex.find((model) => model.value.toLowerCase() === arg)
        : undefined;
      if (isCodex && arg !== 'default' && !codexModel) {
        const errEl = this.messagesEl.createDiv('ct-message ct-error');
        const available = this.plugin.discoveredModelsByHarness.codex.map((model) => model.value).join(', ') || 'the Codex default (start a Codex thread to load its catalog)';
        errEl.createEl('p', { text: `Unknown Codex model "${arg}". Available: ${available}` });
        this.scrollToBottom();
        return;
      }
      if (!isCodex && !(arg in MODEL_ALIASES)) {
        const errEl = this.messagesEl.createDiv('ct-message ct-error');
        errEl.createEl('p', { text: `Unknown model "${arg}". Use: fable, opus, sonnet, haiku, default` });
        this.scrollToBottom();
        return;
      }
      const resolved = isCodex ? (arg === 'default' ? undefined : codexModel!.value) : MODEL_ALIASES[arg];
      this.manager.setThreadModel(this.activeThreadId, resolved);
      await this.plugin.saveSettings();
      const label = resolved ? `Model set to ${resolved}` : 'Model reset to default';
      const divider = this.messagesEl.createDiv('ct-compact-divider');
      divider.createSpan({ cls: 'ct-compact-label', text: label });
      this.renderThreadInfo();
      this.scrollToBottom();
      return;
    }

    // Fire-and-forget: do NOT await sendMessage. Awaiting it keeps
    // DispatchInput.dispatching = true for the entire response, which blocks
    // the user from sending to any other thread while this one is running.
    // UI state (stop button ↔ send button) is managed by the event system
    // (streaming_start → setRunningState(true), done/error → setRunningState(false))
    // so there is nothing useful the await was providing.
    const sendThreadId = this.activeThreadId;
    this.manager.sendMessage(sendThreadId, text || ' ', images.length > 0 ? images : undefined)
      .catch(err => {
        const errEl = this.messagesEl.createDiv('ct-message ct-error');
        errEl.createEl('p', { text: `Failed to send: ${(err as Error).message}` });
        this.clearEscalatedTurn(sendThreadId);
        // Only update running state if we're still looking at the thread that errored
        if (this.activeThreadId === sendThreadId) this.setRunningState(false);
      });
  }

  private async stopMessage(): Promise<void> {
    if (this.activeThreadId) {
      await this.manager.interrupt(this.activeThreadId);
    }
  }

  private openThreadSwitcher(event: MouseEvent): void {
    // Toggle: close if already open
    if (this.switcherPanelEl) {
      this.closeSwitcherPanel();
      return;
    }

    this.switcherTriggerEl = event.currentTarget as HTMLElement | null;
    const anchor = this.nativeHeaderMode ? this.rootEl : (this.titleEl.closest('.ct-title-row') as HTMLElement ?? this.rootEl);
    const panel = anchor.createDiv(`ct-switcher-panel${this.nativeHeaderMode ? ' ct-switcher-panel-native' : ''}`);
    this.switcherPanelEl = panel;

    const allThreads = this.manager.getThreads();
    const buckets = partitionThreads(allThreads, (t) => ({
      isRunning: this.manager.isRunning(t.id),
      hasPendingPermission: this.manager.hasPendingPermission(t.id) || this.manager.hasPendingQuestion(t.id) || this.manager.hasPendingPlan(t.id),
      hasActiveBackgroundTasks: this.manager.hasActiveBackgroundTasks(t.id),
      hasPendingWakeup: this.plugin.hasPendingWakeup(t.id),
      lastError: t.lastError,
      messageCount: t.messages.length,
      reviewed: t.reviewed,
    }));
    // No separate "Awaiting" group in this panel (matches AgentDashboard) —
    // fold permission/question-pending threads into "Working".
    const running: Thread[] = [...buckets.running, ...buckets.awaiting];
    const waiting: Thread[] = buckets.waiting;
    const unreviewed: Thread[] = buckets['idle-new'];
    const reviewed: Thread[] = buckets['idle-reviewed'];
    const errors: Thread[] = buckets.error;
    const empty: Thread[] = buckets.empty;

    const byRecency = (a: Thread, b: Thread) => b.updatedAt - a.updatedAt;
    running.sort(byRecency);
    waiting.sort(byRecency);
    unreviewed.sort(byRecency);
    reviewed.sort(byRecency);
    errors.sort(byRecency);
    empty.sort(byRecency);

    const listEl = panel.createDiv('ct-agents-list');

    if (allThreads.length === 0) {
      listEl.createDiv({ cls: 'ct-agents-empty', text: 'No threads yet.' });
    }

    const renderSwitcherGroup = (label: string, threads: Thread[], state: string): void => {
      const group = listEl.createDiv('ct-agents-group');
      const labelEl = group.createDiv('ct-agents-group-label');
      labelEl.createSpan({ text: label });

      for (const thread of threads) {
        const isActive = thread.id === this.activeThreadId;
        const row = group.createDiv({
          cls: `ct-agents-row ct-agents-row-${state}${isActive ? ' ct-agents-row-active' : ''}`,
        });

        // Icon
        const iconEl = row.createDiv('ct-agents-icon');
        switch (state) {
          case 'running': iconEl.addClass('ct-agents-icon-running'); iconEl.setText('✽'); break;
          case 'waiting': iconEl.addClass('ct-agents-icon-waiting'); iconEl.setText('⏳'); break;
          case 'error':   iconEl.addClass('ct-agents-icon-error');   iconEl.setText('✗'); break;
          case 'empty':   iconEl.addClass('ct-agents-icon-empty');   iconEl.setText('○'); break;
          default:        iconEl.addClass('ct-agents-icon-idle');    iconEl.setText('✓'); break;
        }

        const body = row.createDiv('ct-agents-row-body');
        const titleEl = body.createDiv({ cls: 'ct-agents-row-title', text: thread.title });
        appendOrchestratorBadge(titleEl, thread.id, this.plugin.settings.orchestratorThreadId, thread.projectId ? this.manager.getProject(thread.projectId)?.orchestratorThreadId : undefined);

        // Summary for idle threads (same as AgentDashboard)
        const summary = thread.summary || thread.recap;
        if (summary && state === 'idle') {
          body.createDiv({ cls: 'ct-agents-row-summary', text: summary });
        }

        // Activity line
        let activityText = '';
        if (state === 'running') {
          activityText = this.manager.getThreadActivity(thread.id) || 'Working...';
        } else if (state === 'waiting') {
          const next = this.plugin.getPendingWakeups(thread.id)[0];
          if (!next) activityText = 'Waiting to resume';
          else {
            const when = formatWakeupCountdown(next.fireAt);
            activityText = next.reason ? `Resumes ${when} — ${next.reason}` : `Resumes ${when}`;
          }
        } else if (state === 'error') {
          activityText = thread.lastError ?? 'Error occurred';
        } else if (state === 'empty') {
          activityText = 'Ready to start';
        } else {
          const lastAssistant = [...thread.messages].reverse().find(m => m.role === 'assistant');
          if (lastAssistant) {
            const t = lastAssistant.content.replace(/```[\s\S]*?```/g, '[code]').replace(/\n/g, ' ').trim();
            activityText = t.length > 90 ? t.slice(0, 90) + '…' : t;
          } else {
            activityText = 'Completed';
          }
        }
        body.createDiv({ cls: 'ct-agents-row-activity', text: activityText });

        const meta = row.createDiv('ct-agents-row-meta');
        meta.createDiv({ cls: 'ct-agents-row-time', text: this.relativeTime(thread.updatedAt) });

        row.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          this.closeSwitcherPanel();
          void this.setActiveThread(thread.id);
        });
      }
    };

    if (running.length > 0)   renderSwitcherGroup('Working',  running,    'running');
    if (waiting.length > 0)   renderSwitcherGroup('Waiting',  waiting,    'waiting');
    if (unreviewed.length > 0) renderSwitcherGroup('New',      unreviewed, 'idle');
    if (reviewed.length > 0)  renderSwitcherGroup('Reviewed', reviewed,   'idle');
    if (errors.length > 0)    renderSwitcherGroup('Failed',   errors,     'error');
    if (empty.length > 0)     renderSwitcherGroup('Ready',    empty,      'empty');

    // Footer: rename current thread and start a new chat.
    const footer = panel.createDiv('ct-switcher-footer');
    const activeThread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;
    if (activeThread) {
      const renameBtn = footer.createEl('button', {
        cls: 'ct-switcher-new-btn ct-switcher-rename-btn',
        attr: { title: 'Rename current thread', 'aria-label': 'Rename current thread' },
      });
      renameBtn.createSpan({ cls: 'ct-title-text', text: 'Rename thread' });
      renameBtn.addEventListener('click', (renameEvent) => {
        renameEvent.stopPropagation();
        this.renameThread(activeThread.id);
      });
    }
    const newBtn = footer.createEl('button', { cls: 'ct-switcher-new-btn', text: '+ New chat' });
    newBtn.addEventListener('click', () => {
      this.closeSwitcherPanel();
      void this.openNewThread();
    });

    // Close on outside click (next tick so this click doesn't immediately re-close)
    this.switcherOutsideTimer = setTimeout(() => {
      this.switcherOutsideTimer = null;
      if (this.switcherPanelEl !== panel || !panel.isConnected) return;
      const outsideHandler = (e: MouseEvent) => {
        if (!panel.contains(e.target as Node) && !this.switcherTriggerEl?.contains(e.target as Node)) {
          this.closeSwitcherPanel();
        }
      };
      this.switcherOutsideHandler = outsideHandler;
      document.addEventListener('mousedown', outsideHandler, true);
    }, 0);
  }

  private closeSwitcherPanel(): void {
    if (this.switcherOutsideTimer !== null) {
      clearTimeout(this.switcherOutsideTimer);
      this.switcherOutsideTimer = null;
    }
    this.switcherPanelEl?.remove();
    this.switcherPanelEl = null;
    this.switcherTriggerEl = null;
    if (this.switcherOutsideHandler) {
      document.removeEventListener('mousedown', this.switcherOutsideHandler, true);
      this.switcherOutsideHandler = null;
    }
  }

  private relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  async openNewThread(event?: MouseEvent): Promise<void> {
    const projects = this.manager.getProjects();

    if (projects.length === 0) {
      await this.createThreadWithProject(null);
      return;
    }

    const menu = new Menu();
    menu.addItem(item =>
      item.setTitle('New chat')
        .setIcon('square-pen')
        .onClick(() => this.createThreadWithProject(null)),
    );
    menu.addSeparator();
    for (const project of projects) {
      menu.addItem(item =>
        item.setTitle(project.name)
          .setIcon('folder')
          .onClick(() => this.createThreadWithProject(project.id)),
      );
    }

    if (event) menu.showAtMouseEvent(event);
    else menu.showAtPosition({ x: 0, y: 0 });
  }

  private async createThreadWithProject(projectId: string | null): Promise<void> {
    let cwd = this.plugin.getEffectiveCwd();
    if (projectId) {
      const project = this.manager.getProject(projectId);
      if (project) cwd = this.manager.getProjectCwd(project);
    }
    const thread = this.manager.createThread(
      `Thread ${this.manager.getThreads().length + 1}`,
      cwd,
      projectId ?? undefined,
    );
    await this.plugin.saveSettings();
    this.renderProjectBar(); // update thread count badges
    void this.setActiveThread(thread.id);
  }

  navigateTab(direction: 1 | -1): void {
    const threads = this.manager.getThreads();
    if (threads.length <= 1) return;
    const idx = threads.findIndex(t => t.id === this.activeThreadId);
    const next = (idx + direction + threads.length) % threads.length;
    void this.setActiveThread(threads[next].id);
  }

  switchToTabIndex(index: number): void {
    const threads = this.manager.getThreads();
    if (threads[index]) void this.setActiveThread(threads[index].id);
  }

  private applyAutoTitle(threadId: string, title: string): void {
    const thread = this.manager.getThread(threadId);
    if (!thread || !title) return;
    // Only apply the auto-title if the user has not explicitly renamed this thread.
    // This covers both "Thread N" style titles AND dispatch-created threads whose
    // title is the first 50 chars of the user's first message — both are system
    // placeholders that should be replaced by the summarizer.
    if (!thread.titleUserSet) {
      this.manager.renameThread(threadId, title);
    }
  }

  private async closeThread(id: string): Promise<void> {
    const threads = this.manager.getThreads();
    if (threads.length <= 1) return;

    const role = describeOrchestratorThread(id, this.orchestratorContext());
    if (role) {
      const confirmed = await promptConfirm(this.app, {
        message: orchestratorWarning(role),
        confirmLabel: 'Delete anyway',
      });
      if (!confirmed) return;
    }

    await this.plugin.archiveThreadById(id, true);
    await this.plugin.saveSettings();
    // Selection repair and title-bar refresh are handled by
    // repairSelectionAfterDelete(), driven by the `thread_deleted` event that
    // archiveThreadById() emits — the same path every other archive entry point
    // goes through.
  }

  private renameThread(id: string): void {
    const thread = this.manager.getThread(id);
    if (!thread) return;
    this.closeSwitcherPanel();
    new RenameThreadModal(this.app, thread.title, async (title) => {
      const current = this.manager.getThread(id);
      if (!current) return;
      if (title !== current.title) {
        current.titleUserSet = true;
        this.manager.renameThread(id, title);
        this.renderTitleBar();
        if (id === this.activeThreadId) this.refreshLeafHeader();
      }
      await this.plugin.saveSettings();
    }).open();
  }
}

class RenameThreadModal extends Modal {
  constructor(app: App, private current: string, private save: (title: string) => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Rename thread');
    this.contentEl.addClass('ct-rename-thread-modal');
    const input = this.contentEl.createEl('input', {
      cls: 'ct-title-rename-input',
      attr: { type: 'text', 'aria-label': 'Thread name' },
    });
    input.value = this.current;
    const buttons = this.contentEl.createDiv('ct-skills-modal-btns');
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    const saveButton = buttons.createEl('button', { text: 'Rename', cls: 'mod-cta' });
    let submitted = false;
    const submit = () => {
      const title = input.value.trim();
      if (submitted || !title) return;
      submitted = true;
      this.close();
      void this.save(title).catch((error: unknown) => {
        console.error('[claude-threads] failed to save thread name:', error);
        new Notice('The thread was renamed, but saving failed. Try again before closing the app.');
      });
    };
    saveButton.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); submit(); }
      if (event.key === 'Escape') { event.stopPropagation(); this.close(); }
    });
    input.focus();
    input.select();
  }
}

class ForkModal extends Modal {
  private plugin: ClaudeThreadsPlugin;
  private sourceThread: Thread;
  private onFork: (prompt: string) => Promise<void>;
  private initialFocus: string;

  private focusInput!: HTMLInputElement;
  private promptTextarea!: HTMLTextAreaElement;
  private generateBtn!: HTMLButtonElement;
  private openForkBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private promptSection!: HTMLElement;
  private phase: 'input' | 'generating' | 'review' = 'input';

  constructor(
    app: App,
    plugin: ClaudeThreadsPlugin,
    sourceThread: Thread,
    onFork: (prompt: string) => Promise<void>,
    initialFocus?: string,
  ) {
    super(app);
    this.plugin = plugin;
    this.sourceThread = sourceThread;
    this.onFork = onFork;
    this.initialFocus = initialFocus ?? '';
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('ct-fork-modal');

    contentEl.createEl('h2', { text: 'Fork conversation' });
    contentEl.createEl('p', {
      text: 'Claude will distill the relevant context from this conversation and generate a focused starting prompt for a new thread.',
      cls: 'ct-fork-desc',
    });

    const focusSection = contentEl.createDiv({ cls: 'ct-fork-focus-section' });
    focusSection.createEl('label', {
      text: 'What should the new thread focus on? (optional)',
      cls: 'ct-fork-label',
    });
    this.focusInput = focusSection.createEl('input', {
      type: 'text',
      placeholder: 'e.g. "the auth bug", "refactoring the API layer", "next deployment steps"',
    });
    this.focusInput.addClass('ct-fork-input');
    this.focusInput.style.cssText = 'width:100%;margin-top:4px;';
    if (this.initialFocus) {
      this.focusInput.value = this.initialFocus;
    }

    this.statusEl = contentEl.createDiv({ cls: 'ct-fork-status' });
    this.statusEl.style.display = 'none';

    this.promptSection = contentEl.createDiv({ cls: 'ct-fork-prompt-section' });
    this.promptSection.style.display = 'none';
    this.promptSection.createEl('label', {
      text: 'Generated starting prompt — edit before opening:',
      cls: 'ct-fork-label',
    });
    this.promptTextarea = this.promptSection.createEl('textarea');
    this.promptTextarea.addClass('ct-fork-textarea');
    this.promptTextarea.rows = 8;
    this.promptTextarea.style.cssText = 'width:100%;resize:vertical;margin-top:4px;';

    const btnRow = contentEl.createDiv({ cls: 'ct-fork-btn-row' });
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';

    this.generateBtn = btnRow.createEl('button', { text: 'Generate fork prompt' });
    this.generateBtn.addClass('mod-cta');
    this.generateBtn.addEventListener('click', () => void this.handleGenerate());

    this.openForkBtn = btnRow.createEl('button', { text: 'Open fork' });
    this.openForkBtn.addClass('mod-cta');
    this.openForkBtn.style.display = 'none';
    this.openForkBtn.addEventListener('click', () => void this.handleOpenFork());

    this.focusInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.handleGenerate();
      }
    });

    this.focusInput.focus();
  }

  private async handleGenerate(): Promise<void> {
    if (this.phase === 'generating') return;
    this.phase = 'generating';

    this.generateBtn.disabled = true;
    this.generateBtn.textContent = 'Generating…';
    this.statusEl.style.display = 'block';
    this.statusEl.textContent = 'Generating fork prompt…';
    this.promptSection.style.display = 'none';
    this.openForkBtn.style.display = 'none';

    try {
      const focus = this.focusInput.value;
      const result = await this.plugin.inProcessSummarizer.generateForkPrompt(
        this.sourceThread.messages,
        focus,
        this.plugin.settings.claudeBinaryPath,
        this.plugin.settings.inprocessModel,
        effectiveExtraEnv(this.plugin.settings),
        (status: string) => { this.statusEl.textContent = status; },
      );

      this.promptTextarea.value = result;
      this.promptSection.style.display = 'block';
      this.statusEl.style.display = 'none';
      this.generateBtn.textContent = 'Regenerate';
      this.generateBtn.disabled = false;
      this.openForkBtn.style.display = 'inline-block';
      this.phase = 'review';
    } catch (err) {
      this.statusEl.textContent = `Error: ${(err as Error).message}`;
      this.generateBtn.textContent = 'Try again';
      this.generateBtn.disabled = false;
      this.phase = 'input';
    }
  }

  private async handleOpenFork(): Promise<void> {
    const prompt = this.promptTextarea.value.trim();
    if (!prompt) return;
    this.openForkBtn.disabled = true;
    this.openForkBtn.textContent = 'Opening…';
    try {
      await this.onFork(prompt);
      this.close();
    } catch (err) {
      new Notice(`Fork failed: ${(err as Error).message}`, 8000);
      this.openForkBtn.disabled = false;
      this.openForkBtn.textContent = 'Open fork';
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

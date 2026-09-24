import { type SessionCallbacks, type TaskTrackerEvent } from './ThreadSession';
import { createHarnessSession } from './HarnessFactory';
import { resolveCodexPermissions, type HarnessSession, type HarnessSessionOptions } from './HarnessSession';
import { RawLogWriter, type RawLogTraceChunk, type RawLogTraceMetadata } from './RawLogWriter';
import { AttachmentWriter } from './AttachmentWriter';
// Safe to import statically on mobile: this module requires `fs`/`path` lazily,
// inside functions, so nothing Node-only runs at module-init scope.
import { removeStorageRoot, type ArtifactStorageFs } from './artifactStorage';
import { collectPendingImageExternalizations } from './imageExternalization';
import { effectiveExtraEnv } from './types';
import { derivePrUrl } from './statusLine';
import { resolveGitProjectName } from './pathUtils';
import { legacyWorktreeRoot, resolveWorktreeRoot } from './worktreePaths';
import { debugLog } from './logger';
import { codexSkillRoots, buildSkillPlugins } from './skillManager';
import { pluginSkillsRootFrom } from './skillPaths';
import { resolveLocalSkillsRoot, externalSkillRoots } from './localSkills';
import { selectCanonicalHarnessTools } from './mcpServerMerge';
import { AgentRunStore } from './agentRuns/AgentRunStore';
import { loadAgentProfiles, type AgentProfileMap } from './AgentProfiles';
import type { App } from 'obsidian';
import type { Thread, ChatMessage, PluginSettings, ToolCallRecord, AskQuestion, ImageAttachment, Project, PendingBackgroundTask, TaskItem, TaskItemStatus, StatusTag, GitDiffInfo, AgentRun } from './types';
import type { McpServerConfig, SdkBeta, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

type ThreadStateListener = (threadId: string, event: ThreadEvent) => void;

interface GoalContextState {
  desiredRevision: number;
  appliedRevision: number;
  durableRevision: number;
  durableGoal: string | undefined;
  refreshRequested: boolean;
  processing: boolean;
  persistencePendingRevision?: number;
  pendingKickoff?: {
    revision: number;
    message: string;
    resolve: (sent: boolean) => void;
    reject: (error: unknown) => void;
  };
  inFlightKickoff?: GoalContextState['pendingKickoff'];
}

/**
 * A thread that has been `isRunning` this long with no progress-bearing event
 * is treated as "stale" (wedged at an unanswered prompt, a dead transport, or
 * otherwise not actually working). Views pause its spinner animations once it
 * crosses this threshold — see `isRunStale`. Well above any normal streaming
 * lull, so genuinely-active threads never trip it.
 */
export const STALE_MS = 45_000;

export type ThreadEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_use'; record: ToolCallRecord }
  | { type: 'message'; message: ChatMessage }
  | { type: 'recap'; summary: string }
  | { type: 'done' }
  | { type: 'error'; error: Error }
  | { type: 'reconnecting'; error: string }
  | { type: 'rate_limit_retry'; attempt: number; maxRetries: number; delayMs: number }
  | { type: 'streaming_start' }
  | { type: 'escalated'; model: string }
  | { type: 'queued'; text: string; images?: ImageAttachment[] }
  | { type: 'dequeued'; text: string; images?: ImageAttachment[] }
  | { type: 'status'; status: 'compacting' | 'requesting' | null }
  | { type: 'compact'; message: ChatMessage }
  | { type: 'task_started'; taskId: string; description: string; skipTranscript: boolean; taskType?: string; workflowName?: string; subagentType?: string }
  | { type: 'task_updated'; taskId: string; status?: string; description?: string; error?: string }
  | { type: 'task_progress'; taskId: string; description: string; lastToolName?: string }
  | { type: 'task_notification'; taskId: string; status: 'completed' | 'failed' | 'stopped'; summary: string }
  | { type: 'background_tasks_pending'; tasks: PendingBackgroundTask[] }
  | { type: 'notification'; text: string; priority: 'low' | 'medium' | 'high' | 'immediate' }
  | { type: 'api_retry'; attempt: number; maxRetries: number; error: string }
  | { type: 'permission_denied'; toolName: string; toolUseId: string; message: string; agentId?: string; decisionReasonType?: string }
  | { type: 'rate_limit'; limitStatus: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt?: number }
  | { type: 'usage'; usage: import('./Usage').UsageSnapshot }
  | { type: 'interrupted' }
  | { type: 'cwd_changed'; cwd: string }
  | { type: 'project_changed' }
  | { type: 'projects_changed' }
  | { type: 'thread_deleted' }
  | { type: 'thread_created' }
  | { type: 'threads_loaded'; threadIds: string[] }
  | { type: 'thread_renamed'; threadId: string; title: string }
  | { type: 'permission_request'; toolName: string; detail: string }
  | { type: 'permission_resolved' }
  | { type: 'active_thread_changed' }
  | { type: 'user_message_added'; message: ChatMessage }
  | { type: 'summary_updated' }
  | { type: 'tool_result_images'; images: Array<{ mediaType: string; data: string }> }
  | { type: 'tasks_updated'; tasks: TaskItem[] }
  | { type: 'wakeup_changed' }
  | { type: 'reviewed_changed' }
  | { type: 'manager_notes_changed' }
  | { type: 'proposed_reply_changed' }
  | { type: 'run_state_settled' }
  | { type: 'status_tags' }
  | { type: 'git_diff' }
  | { type: 'model_fallback'; trigger: string; fromModel: string; toModel: string }
  | { type: 'model_refusal_fallback'; content: string; originalModel: string; fallbackModel: string; scope: 'session' | 'local'; category?: string; explanation?: string }
  | { type: 'model_refusal_no_fallback'; content: string; originalModel: string; category?: string; explanation?: string }
  | { type: 'tool_progress'; toolUseId: string; toolName: string; elapsedSeconds: number }
  | { type: 'memory_recall'; paths: string[]; mode: 'select' | 'synthesize' }
  | { type: 'commands_changed'; commands: import('@anthropic-ai/claude-agent-sdk').SlashCommand[] }
  | { type: 'task_progress_summary'; taskId: string; summary: string }
  | { type: 'agent_runs_changed'; agentRuns: AgentRun[] }
  | { type: 'git_operation'; summary: string }
  | { type: 'file_user_modified'; filePath: string }
  | { type: 'files_edited'; paths: string[] }
  | { type: 'tool_result_status'; toolUseId: string; status: 'success' | 'error'; durationMs?: number }
  | { type: 'enter_plan_mode' }
  | { type: 'plan_ready'; planText: string; approve: (editedPlan?: string) => void; reject: () => boolean }
  | { type: 'pending_plan_changed'; planText: string | undefined }
  | { type: 'permission_mode_changed'; mode: PluginSettings['permissionMode'] | undefined }
  | { type: 'plan_transition_error'; error: Error }
  | { type: 'question_ready'; questions: AskQuestion[] }
  | { type: 'pending_question_changed'; questions: AskQuestion[] | undefined }
  | { type: 'capabilities_discovered'; models: import('@anthropic-ai/claude-agent-sdk').ModelInfo[]; agents: import('@anthropic-ai/claude-agent-sdk').AgentInfo[] }
  | { type: 'elicitation_request'; request: import('@anthropic-ai/claude-agent-sdk').ElicitationRequest; signal: AbortSignal; respond: (result: import('@anthropic-ai/claude-agent-sdk').ElicitationResult) => void }
  | { type: 'harness_switching'; targetHarness: 'claude' | 'codex' }
  | { type: 'harness_changed'; sourceHarness: 'claude' | 'codex'; targetHarness: 'claude' | 'codex' };

/**
 * Structural equality for the small, plain-data poll payloads (StatusTag[] /
 * GitDiffInfo) that the status-line and git-diff poll services re-apply on
 * every pass. These are tiny arrays/objects of primitives, so a JSON.stringify
 * compare is both correct and cheap; it lets applyStatusTags/applyGitDiff skip
 * a redundant emit (and the Kanban rebuild it triggers) on a no-op re-apply.
 * `undefined` (no prior value) and any concrete payload compare as unequal, so
 * the first real apply always emits.
 */
function payloadsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export class ThreadManager {
  private threads: Map<string, Thread> = new Map();
  private agentRuns = new AgentRunStore();
  private selectedAgentRuns = new Map<string, string>();
  private projects: Map<string, Project> = new Map();
  /**
   * One long-lived `ThreadSession` per thread (ADR-0002 §2), lazily created
   * on the thread's first message and reused across every subsequent turn.
   * Replaces the old `sessions` (turn in flight) + `lingeringSessions`
   * (result landed but a background task still streaming a further
   * generation) two-map model — there is only ever one `Query` per thread
   * now, so there is nothing for a second session to race for its stdin.
   * An entry here means the thread has a live subprocess; it stays in the
   * map (idle or busy) until the thread is deleted or the plugin shuts
   * down — `session.turnInFlight` (see `isRunning()`) is what distinguishes
   * "busy right now" from "warm but idle."
   */
  private sessions: Map<string, HarnessSession> = new Map();
  /**
   * Initialization context cannot be mutated on a live Claude or Codex
   * adapter. Track the goal revision each adapter was built with and retire it
   * only at a safe boundary. A pending kickoff is revision-scoped, making
   * rapid replacements last-write-wins.
   */
  private goalContextStates: Map<string, GoalContextState> = new Map();
  /**
   * Per-thread accumulator for inline images returned by a tool result,
   * flushed onto the next assistant message. Previously a local variable
   * scoped to one `sendMessage()`/`ClaudeSession.run()` call; now instance
   * state because `SessionCallbacks` are built once per `ThreadSession`
   * (`start()`/`restart()`) and reused across every turn of that session,
   * not rebuilt per turn.
   */
  private pendingToolResultImages: Map<string, Array<{ mediaType: string; data: string }>> = new Map();
  /**
   * Per-thread tracking of background (skipTranscript) tasks that have
   * started but not yet notified completion, so `onDone` can persist them to
   * `thread.pendingBackgroundTasks` for polling resumption. Same rationale
   * as `pendingToolResultImages` above — moved from a per-turn local to
   * instance state now that callbacks outlive a single turn.
   */
  private activeBgTasks: Map<string, Map<string, { description: string; startedAt: number }>> = new Map();
  /**
   * IDs of user messages pushed to `thread.messages` since the last settled
   * generation (onDone/onInterrupted/onError) for this thread. Under the old
   * per-turn model, `onInterrupted` only ever needed to roll back the single
   * `userMsg` pushed by that turn's own `sendMessage()` call, matched by
   * exact id. Under ADR-0002 §2's confirmed always-safe-to-send() model,
   * `sendMessage()` no longer gates on "busy," so a follow-up (or a second,
   * third, ...) user message can land — and get pushed to `thread.messages`
   * — before a single generation's `result`/interrupt settles it. If an
   * interrupt then lands, ALL of those unresolved messages need to be
   * rolled back, not just the last one, or an earlier one is left sitting
   * in the transcript looking like it was successfully sent and answered
   * when it was never actually processed.
   */
  private pendingUserMessageIds: Map<string, string[]> = new Map();
  private queuedMessages: Map<string, { text: string; images?: ImageAttachment[] }[]> = new Map();
  private harnessSwitches = new Set<string>();
  /** Threads draining rejected-plan feedback in FIFO order. */
  private releasingPlanFeedback = new Set<string>();
  private threadActivity: Map<string, string> = new Map();
  private pendingPermissions: Map<string, { toolName: string; detail: string }> = new Map();
  private permissionResolvers: Map<string, (allow: boolean) => void> = new Map();
  /**
   * In-memory store for pending AskUserQuestion answer resolvers, keyed by
   * thread ID. Mirrors `permissionResolvers` — the *state* (the questions
   * themselves) is persisted on `thread.pendingQuestions` like `pendingPlan`,
   * but the live resolver can only exist while the session is actively
   * awaiting the answer. `hasPendingQuestion` is keyed off this map's
   * presence rather than a parallel state map, since the question content
   * itself already lives on `thread.pendingQuestions`.
   */
  private pendingQuestionResolvers: Map<string, (answers: Record<string, string>) => void> = new Map();
  /** Remote permission resolvers keyed by requestId (used by RelayClient). */
  private remotePermissionResolvers: Map<string, (allow: boolean) => void> = new Map();
  /** Remote question resolvers keyed by requestId (used by RelayClient). */
  private remoteQuestionResolvers: Map<string, (answers: Record<string, string>) => void> = new Map();
  private listeners: Set<ThreadStateListener> = new Set();
  private settings: PluginSettings;
  mcpServers: Record<string, McpServerConfig> | undefined = undefined;
  /**
   * When set, called before each session run to produce per-thread MCP server configs.
   * Preferred over `mcpServers` when present — allows baking a thread-specific callback
   * (e.g. onSetCwd) into the server without shared mutable state across concurrent threads.
   */
  mcpServerFactory: ((threadId: string, initialCwd: string) => Record<string, McpServerConfig>) | undefined = undefined;
  /** Human-readable plugin host injected into new session context. */
  hostName: 'Geode' | 'Obsidian' = 'Obsidian';
  /**
   * When set, called before each session run to resolve secret env var values from
   * the OS keychain. Returns a plain key-value map that is merged into the session
   * environment. Only ever called at session start — values are not cached or stored.
   *
   * Takes the resolving thread's `projectId` (undefined for project-less
   * threads) so the resolver can apply `PluginSettings.secretEnvScopes` —
   * see `secretUtils.isSecretVisibleToProject`.
   */
  secretEnvResolver: ((projectId?: string) => Record<string, string>) | undefined = undefined;
  permissionHandler: (threadId: string, toolName: string, detail: string) => Promise<boolean> = async () => false;
  questionHandler: (threadId: string, questions: AskQuestion[]) => Promise<Record<string, string>> = async () => ({});
  openNewTabHandler: (title?: string, initialPrompt?: string) => Promise<{ threadId: string; title: string }> = async (title) => ({ threadId: '', title: title ?? 'New Thread' });
  vaultRoot = '';

  private localSkillsRoot(): string {
    if (!this.vaultRoot) return '';
    try { return resolveLocalSkillsRoot(this.vaultRoot, this.settings.localSkillsFolder ?? 'Skills', externalSkillRoots(this.settings.skillSources)); }
    catch (error) { console.warn('[ClaudeThreads] Local skills unavailable:', error); return ''; }
  }
  /**
   * Obsidian App handle, set once from main.ts alongside `vaultRoot`. Needed by
   * AttachmentWriter to write image files through the vault API (so they
   * register with the metadata cache). Null in tests / on mobile, where image
   * externalization is skipped.
   */
  app: App | null = null;
  /**
   * Absolute filesystem path to this plugin's installed directory (vaultRoot +
   * manifest.dir), set once from main.ts alongside vaultRoot. Used to resolve
   * the bundled thread-orchestrator skill at <pluginResourceDir>/resources/skills/
   * so it can be registered as a local SDK plugin without any manual install
   * into ~/.claude/skills/. Empty until main.ts sets it (e.g. in tests).
   */
  pluginResourceDir = '';
  /**
   * In-memory store for the live approve/reject callbacks from a plan_ready event.
   * Keyed by thread ID. NOT serialized to JSON — only set while the session is
   * actively waiting for the user to act on the plan card.
   */
  private pendingPlanResolvers: Map<string, { approve: (edited?: string) => void; reject: () => boolean }> = new Map();
  /**
   * Central per-thread activity heartbeat: `Date.now()` of the last
   * progress-bearing event (token, tool_use, streaming_start, message, task
   * start/progress, compact) fanned out through `emit()`. Read by
   * `msSinceActivity`/`isRunStale` so views can pause the spinner of a thread
   * that is `isRunning` but making no progress. Not serialized — a reload
   * starts every thread fresh (and a reloaded thread is not `isRunning`).
   */
  private lastActivityAt: Map<string, number> = new Map();
  /** Appends each thread's raw SDK event stream to a per-thread JSONL log. */
  private rawLogWriter: RawLogWriter;
  /** Writes message images out to vault attachment files (ADR-0003, PR 1). */
  private attachmentWriter: AttachmentWriter;
  /** Injectable filesystem for artifact-storage GC; defaults to the real one. */
  artifactStorageFs?: ArtifactStorageFs;
  /**
   * Settles once the artifact-storage cleanup fired by every deletion so far has
   * finished. Production ignores this — deletion stays synchronous and never
   * fails on cleanup. It exists so callers that need to observe the filesystem
   * afterwards can await the real work instead of sleeping for a guessed
   * interval, which is inherently racy on a loaded machine.
   */
  artifactCleanupSettled: Promise<void> = Promise.resolve();

  constructor(settings: PluginSettings) {
    this.settings = settings;
    this.rawLogWriter = new RawLogWriter(
      () => this.vaultRoot,
      () => this.settings.vaultFolder,
    );
    this.attachmentWriter = new AttachmentWriter(
      () => this.app,
      () => this.settings.vaultFolder,
    );
  }

  updateSettings(settings: PluginSettings): void {
    this.settings = settings;
  }

  /**
   * Reads parsed entries from a thread's raw JSONL log. Filters by `type` then
   * tails to the most recent `limit` entries. Returns null if no log exists.
   */
  readRawLog(
    threadId: string,
    opts?: { limit?: number; type?: string },
  ): Promise<{ path: string; total: number; returned: number; entries: unknown[] } | null> {
    return this.rawLogWriter.read(threadId, opts);
  }

  getRawLogTraceMetadata(threadId: string): Promise<RawLogTraceMetadata | null> {
    return this.rawLogWriter.getTraceMetadata(threadId);
  }

  readRawLogTraceChunk(
    threadId: string,
    options: { byteOffset: number; eventIndex: number; limit: number },
  ): Promise<RawLogTraceChunk | null> {
    return this.rawLogWriter.readTraceChunk(threadId, options);
  }

  /**
   * Externalize a finalized message's images to vault attachment files, setting
   * `path` on each ref once written (base64/data stays in the live object for
   * render + relay). Fire-and-forget: writes run off the session hot path and
   * the serialize step drops the base64 on the next save. No-op off desktop.
   */
  private externalizeMessageImages(threadId: string, message: ChatMessage): void {
    if (!this.attachmentWriter.isDesktop()) return;
    message.images?.forEach((img, index) => {
      if (img.base64 && !img.path) {
        void this.attachmentWriter
          .write(threadId, message.id, index, img.mediaType, img.base64)
          .then((p) => {
            if (p) img.path = p;
          });
      }
    });
    message.toolResultImages?.forEach((img, index) => {
      if (img.data && !img.path) {
        void this.attachmentWriter
          .write(threadId, message.id, index, img.mediaType, img.data)
          .then((p) => {
            if (p) img.path = p;
          });
      }
    });
  }

  /**
   * One-time backfill (ADR-0003, PR 1): walk every loaded thread's inline image
   * bytes, write each to a vault attachment file, and set its `path`. The file
   * is written FIRST, then `path` is set, so a crash in between just retries
   * next launch (idempotent, since an existing correct file is overwritten). Returns
   * the number of images externalized. No-op off desktop.
   */
  async backfillExternalizeImages(): Promise<number> {
    if (!this.attachmentWriter.isDesktop()) return 0;
    const pending = collectPendingImageExternalizations(this.getThreads());
    let count = 0;
    for (const item of pending) {
      // eslint-disable-next-line no-await-in-loop
      const p = await this.attachmentWriter.write(
        item.threadId,
        item.messageId,
        item.index,
        item.mediaType,
        item.base64,
      );
      if (p) {
        item.setPath(p);
        count++;
      }
    }
    return count;
  }

  // ── Projects ────────────────────────────────────────────────────────────────

  loadProjects(projects: Project[]): void {
    for (const p of projects) {
      this.projects.set(p.id, p);
    }
  }

  getProjects(): Project[] {
    return Array.from(this.projects.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  getProject(id: string): Project | undefined {
    return this.projects.get(id);
  }

  createProject(name: string, vaultFolder: string, description?: string, cwdOverride?: string): Project {
    const project: Project = {
      id: crypto.randomUUID(),
      name: name.trim() || 'Untitled Project',
      description,
      vaultFolder: vaultFolder.trim(),
      cwdOverride,
      orchestratorEnabled: true,
      createdAt: Date.now(),
    };
    this.projects.set(project.id, project);
    this.emit('', { type: 'projects_changed' });
    return project;
  }

  updateProject(id: string, updates: Partial<Omit<Project, 'id' | 'createdAt'>>): Project {
    const project = this.projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    Object.assign(project, updates);
    this.emit('', { type: 'projects_changed' });
    return project;
  }

  deleteProject(id: string): void {
    const project = this.projects.get(id);
    if (!project) return;
    project.orchestratorThreadId = undefined;
    // Detach threads that belonged to this project
    for (const thread of this.threads.values()) {
      if (thread.projectId === id) {
        delete thread.proposedReply;
        this.setThreadProject(thread.id, null);
      }
    }
    this.projects.delete(id);
    this.emit('', { type: 'projects_changed' });
  }

  /**
   * Returns the resolved filesystem cwd for a project. Uses cwdOverride if
   * set, otherwise joins vaultRoot + vaultFolder.
   */
  getProjectCwd(project: Project): string {
    if (project.cwdOverride) return project.cwdOverride;
    if (!this.vaultRoot) return project.vaultFolder;
    const path = require('path') as typeof import('path');
    return path.join(this.vaultRoot, project.vaultFolder);
  }

  /** Assign or detach a thread from a Project, optionally aligning its cwd. */
  setThreadProject(id: string, projectId: string | null, alignCwd = false): void {
    const thread = this.threads.get(id);
    if (!thread) throw new Error(`Thread not found: ${id}`);
    const project = projectId === null ? undefined : this.projects.get(projectId);
    if (projectId !== null && !project) throw new Error(`Project not found: ${projectId}`);
    if (id === this.settings.orchestratorThreadId && projectId !== null) {
      throw new Error('The Portfolio orchestrator cannot be assigned to a Project.');
    }
    const ownedProject = this.getProjects().find(candidate => candidate.orchestratorThreadId === id);
    if (ownedProject && projectId !== ownedProject.id) {
      throw new Error('A Project orchestrator cannot be reassigned or detached while referenced by its Project.');
    }

    const changed = thread.projectId !== (projectId ?? undefined);
    thread.projectId = projectId ?? undefined;
    if (changed) delete thread.proposedReply;
    thread.updatedAt = Date.now();
    this.emit(id, { type: 'project_changed' });
    if (alignCwd && project) this.setThreadCwd(id, this.getProjectCwd(project));
  }

  // ── Threads ──────────────────────────────────────────────────────────────────

  loadThreads(threads: Thread[], notify = false): void {
    for (const t of threads) {
      // Threads saved before multi-harness support are Claude sessions.
      if (!t.agentHarness) t.agentHarness = 'claude';
      // Migrate threads persisted before status was introduced.
      if (!t.status) t.status = 'waiting';
      // Migrate threads persisted before updatedAt was introduced so that the
      // Kanban byRecency sort never sees undefined (NaN comparisons break sort).
      if (!t.updatedAt) t.updatedAt = t.createdAt;
      if (t.agentRuns?.length) this.agentRuns.restore(t.id, t.agentRuns);
      this.threads.set(t.id, t);
    }
    if (notify && threads.length > 0) {
      this.emit('', { type: 'threads_loaded', threadIds: threads.map((thread) => thread.id) });
    }
  }

  getThreads(): Thread[] {
    return Array.from(this.threads.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  getThreadsByProject(projectId: string | null): Thread[] {
    const all = this.getThreads();
    if (projectId === null) return all;
    return all.filter((t) => t.projectId === projectId);
  }

  getThread(id: string): Thread | undefined {
    return this.threads.get(id);
  }

  /** A single source of truth for whether a thread can safely change providers. */
  getHarnessSwitchBlockReason(id: string): string | undefined {
    const thread = this.threads.get(id);
    if (!thread) return 'Thread not found.';
    if (this.harnessSwitches.has(id)) return 'A harness switch is already in progress.';
    if (this.isRunning(id)) return 'Wait for the active turn to finish.';
    if (this.pendingUserMessageIds.get(id)?.length || this.getQueuedCount(id) > 0) return 'Wait for queued messages to finish.';
    if (this.hasPendingPermission(id)) return 'Resolve the pending permission request first.';
    if (this.hasPendingQuestion(id)) return 'Answer the pending question first.';
    if (this.hasPendingPlan(id)) return 'Approve or reject the pending plan first.';
    if (this.releasingPlanFeedback.has(id)) return 'Wait for plan feedback to finish.';
    const goal = this.goalContextStates.get(id);
    if (goal && (goal.processing || goal.refreshRequested || goal.persistencePendingRevision !== undefined || goal.desiredRevision !== goal.appliedRevision)) {
      return 'Wait for the goal context transition to finish.';
    }
    if (this.hasActiveBackgroundTasks(id)) return 'Wait for background tasks and agents to finish.';
    return undefined;
  }

  /** Transactionally changes the provider that owns the next native session. */
  async switchHarness(
    id: string,
    targetHarness: 'claude' | 'codex',
    persist: () => Promise<void>,
  ): Promise<void> {
    const thread = this.threads.get(id);
    if (!thread) throw new Error(`Thread not found: ${id}`);
    const sourceHarness = thread.agentHarness ?? 'claude';
    if (sourceHarness === targetHarness) return;
    const blocked = this.getHarnessSwitchBlockReason(id);
    if (blocked) throw new Error(blocked);

    const snapshot = {
      agentHarness: thread.agentHarness, sessionGeneration: thread.sessionGeneration,
      sessionId: thread.sessionId, model: thread.model, usageSnapshot: thread.usageSnapshot,
      tasks: thread.tasks, pendingBackgroundTasks: thread.pendingBackgroundTasks,
      recap: thread.recap, lastError: thread.lastError,
      pendingHarnessHandoff: thread.pendingHarnessHandoff,
      messages: thread.messages.map(message => ({ ...message })),
    };
    this.harnessSwitches.add(id);
    this.emit(id, { type: 'harness_switching', targetHarness });
    try {
      // Confirmation may have taken time; the caller invokes this only after it,
      // so revalidation here is the transaction's race boundary.
      const reblocked = this.getHarnessSwitchBlockReasonIgnoringSelf(id);
      if (reblocked) throw new Error(reblocked);
      for (const message of thread.messages) {
        if (message.role === 'assistant' && !message.agentHarness) message.agentHarness = sourceHarness;
      }
      thread.sessionGeneration = (thread.sessionGeneration ?? 0) + 1;
      thread.agentHarness = targetHarness;
      delete thread.sessionId;
      delete thread.model;
      delete thread.usageSnapshot;
      delete thread.tasks;
      delete thread.pendingBackgroundTasks;
      delete thread.recap;
      delete thread.lastError;
      thread.pendingHarnessHandoff = createHarnessHandoff(thread, sourceHarness, targetHarness);
      thread.updatedAt = Date.now();
      await persist();
      const oldSession = this.sessions.get(id);
      if (oldSession) oldSession.close();
      this.sessions.delete(id);
      this.selectedAgentRuns.delete(id);
      this.emit(id, { type: 'harness_changed', sourceHarness, targetHarness });
    } catch (error) {
      Object.assign(thread, snapshot);
      if (snapshot.sessionId === undefined) delete thread.sessionId;
      if (snapshot.model === undefined) delete thread.model;
      if (snapshot.usageSnapshot === undefined) delete thread.usageSnapshot;
      if (snapshot.tasks === undefined) delete thread.tasks;
      if (snapshot.pendingBackgroundTasks === undefined) delete thread.pendingBackgroundTasks;
      if (snapshot.recap === undefined) delete thread.recap;
      if (snapshot.lastError === undefined) delete thread.lastError;
      if (snapshot.pendingHarnessHandoff === undefined) delete thread.pendingHarnessHandoff;
      throw error;
    } finally {
      this.harnessSwitches.delete(id);
      this.flushQueuedMessages(id);
    }
  }

  private getHarnessSwitchBlockReasonIgnoringSelf(id: string): string | undefined {
    this.harnessSwitches.delete(id);
    const reason = this.getHarnessSwitchBlockReason(id);
    this.harnessSwitches.add(id);
    return reason;
  }

  private flushQueuedMessages(id: string): void {
    const queued = this.queuedMessages.get(id) ?? [];
    this.queuedMessages.delete(id);
    for (const item of queued) {
      this.emit(id, { type: 'dequeued', text: item.text, images: item.images });
      void this.sendMessage(id, item.text, item.images);
    }
  }

  getAgentRuns(threadId: string): AgentRun[] { return this.agentRuns.getByThread(threadId); }
  getAgentRun(agentRunId: string): AgentRun | undefined { return this.agentRuns.getById(agentRunId); }
  getSelectedAgentRun(threadId: string): string | undefined { return this.selectedAgentRuns.get(threadId); }
  selectAgentRun(threadId: string, agentRunId: string): void { this.selectedAgentRuns.set(threadId, agentRunId); this.emit(threadId, { type: 'agent_runs_changed', agentRuns: this.getAgentRuns(threadId) }); }

  /**
   * Drops the thread's selected agent. Used when the view self-heals a selection
   * that no longer matches a live run, so the child activity view falls back to
   * the main conversation instead of rendering an empty pane.
   */
  clearSelectedAgentRun(threadId: string): void {
    if (!this.selectedAgentRuns.delete(threadId)) return;
    this.emit(threadId, { type: 'agent_runs_changed', agentRuns: this.getAgentRuns(threadId) });
  }

  private persistAgentRuns(thread: Thread): void {
    thread.agentRuns = this.agentRuns.snapshot(thread.id);
    thread.updatedAt = Date.now();
    this.emit(thread.id, { type: 'agent_runs_changed', agentRuns: thread.agentRuns });
  }

  createThread(title: string, cwd?: string, projectId?: string, agentHarness?: 'claude' | 'codex', metadata?: Pick<Thread, 'origin' | 'externalJobId' | 'ephemeral' | 'background'>): Thread {
    const thread: Thread = {
      id: crypto.randomUUID(),
      title: title || `Thread ${this.threads.size + 1}`,
      cwd: cwd ?? this.settings.defaultCwd,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectId,
      status: 'waiting',
      agentHarness: agentHarness ?? this.settings.agentHarness,
      ...metadata,
    };
    this.threads.set(thread.id, thread);
    this.emit(thread.id, { type: 'thread_created' });
    return thread;
  }

  deleteThread(id: string): void {
    const thread = this.threads.get(id);
    // Hard-delete of a thread with no markdown note: remove its attachment dir.
    // On archive the thread has a `noteFile` (persistence.saveThread set it), and
    // a later PR embeds those images in the note, so keep the directory then.
    // Fire-and-forget so delete stays synchronous; no-op off desktop.
    if (thread && !thread.noteFile) {
      void this.attachmentWriter.removeThreadDir(id);
    }
    if (thread) this.removeArtifactStorage(thread);
    const session = this.sessions.get(id);
    if (session) {
      session.close();
      this.sessions.delete(id);
    }
    this.cancelPendingGoalContext(id);
    this.pendingToolResultImages.delete(id);
    this.activeBgTasks.delete(id);
    this.pendingUserMessageIds.delete(id);
    this.queuedMessages.delete(id);
    this.releasingPlanFeedback.delete(id);
    this.threadActivity.delete(id);
    this.lastActivityAt.delete(id);
    this.selectedAgentRuns.delete(id);
    this.threads.delete(id);
    this.emit(id, { type: 'thread_deleted' });
  }

  /**
   * Garbage-collects artifact storage belonging to a deleted thread (ADR-0010).
   *
   * Until `storageRoot` became host-visible, nothing owned these directories:
   * deleting a thread removed its attachment directory but left
   * `.geode/artifacts/<id>` on disk forever. Every root is re-validated against
   * the vault artifact root inside `removeStorageRoot` before anything is
   * removed, so a hand-edited or hostile record cannot aim the delete
   * elsewhere. Fire-and-forget, and a missing directory is not an error, so
   * deletion stays synchronous and never fails on cleanup.
   */
  private removeArtifactStorage(thread: Thread): void {
    const vaultRoot = this.vaultRoot;
    const roots = (thread.artifacts ?? []).map(artifact => artifact.storageRoot).filter((root): root is string => !!root);
    if (!vaultRoot || roots.length === 0) return;
    const pending = roots.map(root => removeStorageRoot(vaultRoot, root, this.artifactStorageFs).catch(() => undefined));
    // Chained rather than replaced, so awaiting after several deletions covers
    // all of them rather than only the most recent.
    this.artifactCleanupSettled = this.artifactCleanupSettled
      .then(() => Promise.all(pending))
      .then(() => undefined);
  }

  renameThread(id: string, title: string): void {
    const thread = this.threads.get(id);
    if (thread) {
      thread.title = title;
      thread.updatedAt = Date.now();
      this.emit(id, { type: 'thread_renamed', threadId: id, title });
    }
  }

  /**
   * `originRepoPath` semantics (see `ObsidianMcpServerOptions.onSetCwd`):
   *  - omitted (`undefined`) — plain `set_working_directory` call; leave any
   *    existing `thread.originRepoPath` untouched.
   *  - a string — `enter_worktree` captured the origin repo's git root; store it.
   *  - `null` — `exit_worktree` is back in the origin repo; clear it.
   */
  setThreadCwd(id: string, cwd: string, originRepoPath?: string | null): void {
    const thread = this.threads.get(id);
    if (thread) {
      thread.cwd = cwd;
      if (originRepoPath !== undefined) {
        thread.originRepoPath = originRepoPath ?? undefined;
      }
      // Session IDs are scoped to a Claude Code project directory. Resuming a
      // session from the old cwd in the new cwd's project directory will fail with
      // "No conversation found with session ID". Clear it so the next turn starts
      // fresh in the new directory.
      thread.sessionId = undefined;
      thread.updatedAt = Date.now();
      this.emit(id, { type: 'cwd_changed', cwd });

      // A cwd change is session-breaking (a resumed session can't cross
      // Claude Code project directories — the comment above establishes
      // that). We deliberately do NOT restart the live Query here. This call
      // path is reached synchronously mid-tool-call by enter_worktree /
      // set_working_directory (via onSetCwd), BEFORE those tools have
      // returned their tool_result. Closing the live Query here would tear
      // down the very transport that must carry that tool_result back to the
      // model — the turn would hang forever waiting for a result that can
      // never arrive (the EnterWorktree hang). Instead the rebuild is
      // DEFERRED: sendMessage() rebuilds the session against the new cwd at
      // the next safe turn boundary (see the stale-cwd guard there), which
      // restores the pre-ADR-0002 behavior where a fresh unresumed session
      // was built on the next turn anyway. The tool descriptions' "takes
      // effect next turn" wording is therefore accurate.
    }
  }

  /**
   * Scans all threads and repairs any whose `cwd` is a stale worktree path.
   *
   * Worktrees created by `enter_worktree` can disappear behind the plugin's back:
   * `exit_worktree` removes them, the Agent tool auto-removes its own, and the
   * worktree-cleanup skill prunes them on demand. Threads created before the
   * durability fix additionally lived under `<os.tmpdir()>/claude-worktrees/`,
   * which macOS clears **on reboot** — historically the single biggest cause of
   * vanished worktrees, and the reason the default root is now durable.
   *
   * Whatever the cause, the persisted `thread.cwd` becomes a dangling path.
   * Node.js throws ENOENT when spawning with a non-existent cwd, which the SDK
   * surfaces as the misleading "binary not found" error.
   *
   * **Scope**: only paths under a recognised worktree container are repaired —
   * the current root (default `~/.geode/worktrees`, or the configured override)
   * and the legacy `<os.tmpdir()>/claude-worktrees/` layout. Other missing cwds
   * (e.g. a deleted project directory) are left alone — those should surface as
   * an explicit error so the user knows to update the path.
   *
   * For each stale worktree path this method:
   *   1. Prefers rerouting straight to `thread.originRepoPath` (the origin repo's
   *      git root, captured by `enter_worktree`) when that path still exists —
   *      this recovers a working cwd AND the correct project name in one shot.
   *   2. Otherwise walks up the directory tree to the nearest valid ancestor,
   *      stopping before the worktree container dir itself.
   *   3. Falls back to `vaultRoot` or `os.homedir()` if no valid ancestor is found.
   *   4. Calls `setThreadCwd()` so the session ID is cleared and `cwd_changed` fires
   *      (giving callers a chance to persist the fix via `saveSettings()`).
   *
   * Returns the number of threads that were repaired.
   */
  repairStaleCwds(): number {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePath = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');

    // Two containers must be recognised:
    //  - the current root (default ~/.geode/worktrees, or the configured override)
    //  - the legacy <os.tmpdir()>/claude-worktrees layout, because threads
    //    persisted before the durability fix still carry cwds pointing there.
    // Each is paired with its real-path twin, since both can sit behind a
    // symlink (on macOS /var/folders/... → /private/var/folders/...).
    const realTwin = (p: string) => {
      try { return fs.realpathSync(nodePath.dirname(p)) + nodePath.sep + nodePath.basename(p); }
      catch { return p; }
    };

    const containers = Array.from(new Set(
      [resolveWorktreeRoot(this.settings?.worktreeRoot), legacyWorktreeRoot()].flatMap((c) => [c, realTwin(c)]),
    ));

    const isWorktreePath = (p: string) =>
      containers.some((c) => p.startsWith(c + nodePath.sep));

    const isWorktreeContainer = (p: string) => containers.includes(p);

    let repaired = 0;

    for (const [id, thread] of this.threads) {
      // Only repair volatile worktree paths — other non-existent cwds should be
      // surfaced as an explicit error, not silently rerouted.
      if (!thread.cwd || !isWorktreePath(thread.cwd)) continue;
      if (fs.existsSync(thread.cwd)) continue;

      // Prefer rerouting straight back to the origin repo captured at
      // `enter_worktree` time (Thread.originRepoPath) — this recovers both a
      // working cwd AND the correct project name in one shot, and is
      // available even when the worktree directory itself is long gone.
      if (thread.originRepoPath && fs.existsSync(thread.originRepoPath)) {
        console.warn(
          `[ClaudeThreads] Repairing stale worktree cwd for thread "${thread.title}" via originRepoPath: ` +
          `"${thread.cwd}" → "${thread.originRepoPath}"`,
        );
        this.setThreadCwd(id, thread.originRepoPath, null);
        repaired++;
        continue;
      }

      // Walk up the tree to the nearest ancestor that both exists and is not
      // the worktree container directory itself.
      let fallback = thread.cwd;
      while (true) {
        const parent = nodePath.dirname(fallback);
        if (parent === fallback) { fallback = ''; break; } // hit filesystem root
        fallback = parent;
        if (fs.existsSync(fallback) && !isWorktreeContainer(fallback)) break;
      }

      if (!fallback || !fs.existsSync(fallback)) {
        fallback = this.vaultRoot || os.homedir();
      }

      console.warn(
        `[ClaudeThreads] Repairing stale worktree cwd for thread "${thread.title}": ` +
        `"${thread.cwd}" → "${fallback}"`,
      );
      this.setThreadCwd(id, fallback);
      repaired++;
    }

    return repaired;
  }

  /**
   * One-time migration for threads orphaned *before* `Thread.originRepoPath`
   * existed: their worktree cwd was already gone (with nothing recoverable on
   * disk) by the time this fix shipped, so `repairStaleCwds()` can only reroute
   * them to a generic ancestor/vaultRoot/homedir — which also can't resolve a
   * project name, leaving the Kanban lane showing the bare worktree hash.
   *
   * For each thread that:
   *   - has no `originRepoPath` and no `projectNameOverride` already, and
   *   - can't resolve a project name from its current `cwd` via a live git walk
   *     (`resolveGitProjectName` returns null), and
   *   - has a `prUrl` pointing at a GitHub PR (e.g.
   *     `https://github.com/<owner>/<repo>/pull/<n>`)
   *
   * ...sets `projectNameOverride` to `<repo>` extracted from the PR URL, purely
   * as a display label for `resolveThreadProjectName()` (see pathUtils.ts) —
   * it does not touch `cwd` or attempt to find a real filesystem path.
   *
   * Safe to call repeatedly / on every load: threads that already have
   * `originRepoPath` or `projectNameOverride`, or whose cwd resolves fine on
   * its own, are left untouched.
   *
   * Returns the number of threads that were backfilled.
   */
  backfillLegacyProjectNames(): number {
    let backfilled = 0;

    for (const thread of this.threads.values()) {
      if (thread.originRepoPath || thread.projectNameOverride) continue;
      if (!thread.prUrl) continue;
      if (resolveGitProjectName(thread.cwd)) continue; // cwd already resolves fine

      const match = thread.prUrl.match(/github\.com\/[^/]+\/([^/]+)\/pull\/\d+/);
      if (!match) continue;

      thread.projectNameOverride = match[1];
      console.warn(
        `[ClaudeThreads] Backfilled project name for orphaned thread "${thread.title}" ` +
        `from prUrl: "${match[1]}"`,
      );
      backfilled++;
    }

    return backfilled;
  }

  setThreadModel(id: string, model: string | undefined): void {
    const thread = this.threads.get(id);
    if (thread) {
      thread.model = model;
      thread.updatedAt = Date.now();
      // ADR-0002 §2: model changes become a direct control-request on the
      // live Query instead of waiting for the next turn to rebuild Options.
      // If the session hasn't finished start()-ing yet, swallow the error —
      // the persisted thread.model above is already correct and will be
      // picked up whenever start() actually runs.
      const session = this.sessions.get(id);
      if (session) {
        session.setModel(model).catch((err) => {
          console.error('[ClaudeThreads] setThreadModel: live setModel() failed:', err);
        });
      }
    }
  }

  setThreadPendingPlan(id: string, planText: string | undefined): void {
    const thread = this.threads.get(id);
    if (thread) {
      if (planText !== undefined) thread.pendingPlan = planText;
      else delete thread.pendingPlan;
      thread.updatedAt = Date.now();
    }
  }

  /** Returns the live approve/reject callbacks if a plan is actively awaiting user action. */
  getPendingPlanResolvers(id: string): { approve: (edited?: string) => void; reject: () => boolean } | undefined {
    return this.pendingPlanResolvers.get(id);
  }

  setThreadPendingQuestions(id: string, questions: AskQuestion[] | undefined): void {
    const thread = this.threads.get(id);
    if (thread) {
      if (questions !== undefined) thread.pendingQuestions = questions;
      else delete thread.pendingQuestions;
      thread.updatedAt = Date.now();
    }
  }

  setThreadPermissionMode(id: string, mode: PluginSettings['permissionMode'] | undefined): void {
    const thread = this.threads.get(id);
    if (thread) {
      if (mode !== undefined) thread.permissionMode = mode;
      else delete thread.permissionMode;
      thread.updatedAt = Date.now();
      this.emit(id, { type: 'permission_mode_changed', mode });
      // ADR-0002 §2: same rationale as setThreadModel() above — a direct
      // control-request on the live Query, no restart needed.
      const session = this.sessions.get(id);
      if (session) {
        const effectiveMode = mode ?? this.settings.permissionMode;
        session.setPermissionMode(effectiveMode as PermissionMode).catch((err) => {
          console.error('[ClaudeThreads] setThreadPermissionMode: live setPermissionMode() failed:', err);
        });
      }
    }
  }

  /**
   * Set or clear (pass undefined) the persistent goal for a thread and
   * invalidate any adapter built with the previous initialization context.
   * Returns the new revision so callers can finish persistence before asking
   * for the matching refresh/kickoff.
   */
  setThreadGoal(id: string, goal: string | undefined): number {
    const thread = this.threads.get(id);
    if (!thread) return -1;
    const state = this.getGoalContextState(id);
    if (goal) thread.goal = goal;
    else delete thread.goal;
    thread.updatedAt = Date.now();

    state.desiredRevision += 1;
    state.refreshRequested = false;
    state.persistencePendingRevision = state.desiredRevision;
    if (state.pendingKickoff) {
      state.pendingKickoff.resolve(false);
      delete state.pendingKickoff;
    }
    if (state.inFlightKickoff) {
      state.inFlightKickoff.resolve(false);
      delete state.inFlightKickoff;
    }
    return state.desiredRevision;
  }

  /** Restore the last durable value when persistence of a requested goal fails. */
  rollbackThreadGoal(id: string, failedRevision: number): void {
    const thread = this.threads.get(id);
    const state = this.goalContextStates.get(id);
    if (!thread || !state || state.desiredRevision !== failedRevision) return;
    if (state.durableGoal) thread.goal = state.durableGoal;
    else delete thread.goal;
    thread.updatedAt = Date.now();
    state.pendingKickoff?.resolve(false);
    state.inFlightKickoff?.resolve(false);
    delete state.pendingKickoff;
    delete state.inFlightKickoff;
    state.desiredRevision = state.durableRevision;
    delete state.persistencePendingRevision;
    state.refreshRequested = state.durableRevision !== state.appliedRevision;
    if (state.refreshRequested) this.scheduleGoalContextProcessing(id);
    this.scheduleQueuedMessageFlush(id);
  }

  /** Mark a goal revision durable before any context refresh may consume it. */
  commitThreadGoal(id: string, revision: number): boolean {
    const state = this.goalContextStates.get(id);
    if (!state || state.desiredRevision !== revision) return false;
    if (state.persistencePendingRevision !== undefined && state.persistencePendingRevision !== revision) return false;
    delete state.persistencePendingRevision;
    state.durableRevision = revision;
    state.durableGoal = this.threads.get(id)?.goal;
    return true;
  }

  /** Refresh the adapter for a persisted goal change without sending a turn. */
  requestGoalContextRefresh(id: string, revision: number): void {
    const state = this.goalContextStates.get(id);
    if (!state || revision !== state.desiredRevision || !this.threads.has(id) || !this.commitThreadGoal(id, revision)) return;
    state.refreshRequested = true;
    this.scheduleGoalContextProcessing(id);
  }

  /**
   * Queue the one kickoff associated with a persisted goal revision. The
   * promise resolves false when a newer goal supersedes it or the thread is
   * deleted/shut down.
   */
  requestGoalKickoff(id: string, revision: number, message: string): Promise<boolean> {
    const state = this.goalContextStates.get(id);
    if (
      !state
      || revision !== state.desiredRevision
      || !this.threads.has(id)
      || !this.commitThreadGoal(id, revision)
    ) {
      return Promise.resolve(false);
    }
    if (state.pendingKickoff) state.pendingKickoff.resolve(false);
    state.refreshRequested = true;
    const result = new Promise<boolean>((resolve, reject) => {
      state.pendingKickoff = { revision, message, resolve, reject };
    });
    this.scheduleGoalContextProcessing(id);
    return result;
  }

  /** ADR-0002 §2: a simple event-derived boolean off the single session map — no second map to check. */
  isRunning(id: string): boolean {
    return this.sessions.get(id)?.turnInFlight ?? false;
  }

  /**
   * Returns all threads that currently have a live `ThreadSession` (busy or
   * idle-but-warm). Used by the safe-reload guard to enumerate what would be
   * killed — under the long-lived-session model, any entry in `sessions` is
   * a real subprocess, not just threads with a turn in flight right now.
   */
  getRunningThreads(): Thread[] {
    return this.getThreads().filter((t) => this.sessions.has(t.id));
  }

  hasPendingPermission(threadId: string): boolean {
    return this.pendingPermissions.has(threadId);
  }

  getPendingPermission(threadId: string): { toolName: string; detail: string } | undefined {
    return this.pendingPermissions.get(threadId);
  }

  registerPermissionResolver(threadId: string, resolver: (allow: boolean) => void): void {
    this.permissionResolvers.set(threadId, resolver);
  }

  resolvePermission(threadId: string, allow: boolean): void {
    const resolver = this.permissionResolvers.get(threadId);
    if (resolver) resolver(allow);
  }

  hasPendingQuestion(threadId: string): boolean {
    return this.pendingQuestionResolvers.has(threadId)
      || (this.threads.get(threadId)?.pendingQuestions?.length ?? 0) > 0;
  }

  /**
   * True while a `skipTranscript` task (a `run_in_background: true` Agent
   * call, or any Workflow-tool task — both go through the same
   * `task_started`/`task_notification` protocol) has started but not yet
   * reported completion for this thread. This is what lets the UI keep a
   * thread in "Working" even after the outer turn's own `isRunning()` has
   * already flipped to false, since the outer turn's result can land before
   * a spawned subagent or workflow finishes server-side.
   */
  hasActiveBackgroundTasks(threadId: string): boolean {
    if (this.agentRuns.getByThread(threadId).some(run => run.status === 'starting' || run.status === 'working' || run.status === 'waiting')) return true;
    const live = this.activeBgTasks.get(threadId);
    if (live && live.size > 0) return true;
    return (this.threads.get(threadId)?.pendingBackgroundTasks?.length ?? 0) > 0;
  }

  /**
   * Merges the live `activeBgTasks` map (populated from `onTaskStarted`,
   * cleared on `onTaskNotification`) with `thread.pendingBackgroundTasks`
   * (the snapshot persisted in `onDone` for poll-recovery after a reload).
   * The persisted array matters for the brief window right after an
   * Obsidian reload, before `scheduleBgTaskPoll` has re-confirmed status —
   * without merging it in, a reload would briefly flash the thread back to
   * New/Reviewed until the first poll lands. Dedup by taskId; live entries
   * win on conflict since they reflect the current session's state.
   */
  getActiveBackgroundTasks(threadId: string): PendingBackgroundTask[] {
    const live = this.activeBgTasks.get(threadId);
    const persisted = this.threads.get(threadId)?.pendingBackgroundTasks ?? [];
    const result = new Map<string, PendingBackgroundTask>();
    for (const task of persisted) {
      result.set(task.taskId, task);
    }
    if (live) {
      for (const [taskId, { description, startedAt }] of live.entries()) {
        result.set(taskId, { taskId, description, startedAt, pollCount: result.get(taskId)?.pollCount ?? 0 });
      }
    }
    return Array.from(result.values());
  }

  registerQuestionResolver(threadId: string, resolver: (answers: Record<string, string>) => void): void {
    this.pendingQuestionResolvers.set(threadId, resolver);
  }

  /** Safe no-op if no resolver is currently registered for this thread. */
  resolveQuestion(threadId: string, answers: Record<string, string>): void {
    const resolver = this.pendingQuestionResolvers.get(threadId);
    if (resolver) resolver(answers);
  }

  /** Returns the live answer resolver if a question is actively awaiting user action. */
  getPendingQuestionResolver(threadId: string): ((answers: Record<string, string>) => void) | undefined {
    return this.pendingQuestionResolvers.get(threadId);
  }

  /**
   * Resolve a permission that was issued with a specific requestId (used by
   * RelayClient for remote permission resolution from a mobile client).
   */
  resolvePermissionByRequestId(requestId: string, allow: boolean): void {
    const resolver = this.remotePermissionResolvers.get(requestId);
    if (resolver) {
      this.remotePermissionResolvers.delete(requestId);
      resolver(allow);
    }
  }

  /**
   * Register a resolver keyed by a stable requestId so that RelayClient can
   * bridge remote resolve_permission commands to the correct local promise.
   */
  registerRemotePermissionResolver(requestId: string, resolver: (allow: boolean) => void): void {
    this.remotePermissionResolvers.set(requestId, resolver);
  }

  /**
   * Resolve a question that was issued with a specific requestId (used by
   * RelayClient for remote question resolution from a mobile client).
   */
  resolveQuestionByRequestId(requestId: string, answers: Record<string, string>): void {
    const resolver = this.remoteQuestionResolvers.get(requestId);
    if (resolver) {
      this.remoteQuestionResolvers.delete(requestId);
      resolver(answers);
    }
  }

  /**
   * Register a resolver keyed by a stable requestId so that RelayClient can
   * bridge remote resolve_question commands to the correct local promise.
   */
  registerRemoteQuestionResolver(requestId: string, resolver: (answers: Record<string, string>) => void): void {
    this.remoteQuestionResolvers.set(requestId, resolver);
  }

  getQueuedMessage(id: string): string | undefined {
    const queue = this.queuedMessages.get(id);
    return queue && queue.length > 0 ? queue[0].text : undefined;
  }

  getQueuedMessages(id: string): { text: string; images?: ImageAttachment[] }[] {
    return this.queuedMessages.get(id) ?? [];
  }

  getQueuedCount(id: string): number {
    return this.queuedMessages.get(id)?.length ?? 0;
  }

  removeQueuedMessageAt(id: string, index: number): void {
    const queue = this.queuedMessages.get(id);
    if (!queue || index < 0 || index >= queue.length) return;
    queue.splice(index, 1);
    if (queue.length === 0) this.queuedMessages.delete(id);
  }

  getThreadActivity(id: string): string | undefined {
    return this.threadActivity.get(id);
  }

  /**
   * Store status-line tags for a thread (from StatusLineService) and derive its
   * prUrl. prUrl is STICKY: only overwritten when the tags yield a PR url, never
   * cleared on absence — so the release archive-on-merge workflow can still match
   * a thread after its PR merges. Emits `status_tags` so views re-render.
   * Returns true if prUrl changed (so the caller can decide to persist).
   */
  applyStatusTags(threadId: string, tags: StatusTag[]): boolean {
    const thread = this.threads.get(threadId);
    if (!thread) return false;
    // Poll services re-apply tags on every pass; most passes yield identical
    // tags. Detect a genuine change BEFORE overwriting so we can skip the emit
    // (and the full Kanban rebuild it triggers) when nothing actually changed.
    const tagsChanged = !payloadsEqual(thread.statusTags, tags);
    thread.statusTags = tags;
    const pr = derivePrUrl(tags);
    let prChanged = false;
    if (pr && pr !== thread.prUrl) {
      thread.prUrl = pr;
      prChanged = true;
    }
    // Emit when the tags changed OR a new PR url appeared (so the PR chip can
    // render) — but stay silent on a no-op re-apply.
    if (tagsChanged || prChanged) {
      this.emit(threadId, { type: 'status_tags' });
    }
    return prChanged;
  }


  /**
   * Store native git plumbing info for a thread (from GitDiffService) and emit
   * `git_diff` so views re-render the git diff bar. Ephemeral like statusTags —
   * not persisted, re-derived on the next poll.
   */
  applyGitDiff(threadId: string, info: GitDiffInfo): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    // Same dedupe rationale as applyStatusTags: GitDiffService re-derives this
    // on every poll and it's usually identical — skip the emit when unchanged.
    const changed = !payloadsEqual(thread.gitDiff, info);
    thread.gitDiff = info;
    if (changed) {
      this.emit(threadId, { type: 'git_diff' });
    }
  }

  // ── Background task tracking ─────────────────────────────────────────────────

  getPendingBackgroundTasks(threadId: string): PendingBackgroundTask[] {
    return this.threads.get(threadId)?.pendingBackgroundTasks ?? [];
  }

  /** Remove a single resolved task from the thread's pending list. */
  clearPendingBackgroundTask(threadId: string, taskId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread?.pendingBackgroundTasks) return;
    thread.pendingBackgroundTasks = thread.pendingBackgroundTasks.filter(t => t.taskId !== taskId);
    if (thread.pendingBackgroundTasks.length === 0) {
      delete thread.pendingBackgroundTasks;
    }
    this.scheduleGoalContextProcessing(threadId);
  }

  /** Clear ALL pending background tasks for a thread (e.g. when giving up after max polls). */
  clearAllPendingBackgroundTasks(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (thread) delete thread.pendingBackgroundTasks;
    this.scheduleGoalContextProcessing(threadId);
  }

  /** Increment pollCount on all pending tasks for a thread. */
  incrementPendingTaskPollCount(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread?.pendingBackgroundTasks) return;
    for (const task of thread.pendingBackgroundTasks) {
      task.pollCount++;
    }
  }

  /**
   * Append a persisted 'notice' message to a thread's transcript — used when a
   * background task completes after its parent thread has gone idle. Renders as
   * a subtle centered row in the chat (see ThreadsView) instead of a global
   * toast, and survives reload because it lives in thread.messages (persisted
   * to data.json). Emits a 'message' event so any open view appends it live.
   */
  addNoticeMessage(
    threadId: string,
    status: 'completed' | 'failed' | 'stopped',
    summary: string,
  ): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'notice',
      content: summary,
      noticeStatus: status,
      timestamp: Date.now(),
    };
    thread.messages.push(message);
    thread.updatedAt = Date.now();
    this.emit(threadId, { type: 'message', message });
  }

  /**
   * Detect whether the message triggers model escalation. Returns the model
   * string to use for this turn if escalation should occur, or undefined
   * if the default model should be used.
   */
  private resolveModel(userText: string): string | undefined {
    if (!this.settings.escalationEnabled) return undefined;
    const keyword = (this.settings.escalationKeyword ?? '/escalate').trim();
    if (!keyword) return undefined;
    // Match keyword anywhere in the message (case-insensitive)
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`, 'i');
    return re.test(userText) ? (this.settings.escalationModel || 'opus') : undefined;
  }

  /**
   * Strip the escalation keyword from the message so it isn't passed to Claude verbatim.
   */
  private stripKeyword(userText: string): string {
    if (!this.settings.escalationEnabled) return userText;
    const keyword = (this.settings.escalationKeyword ?? '/escalate').trim();
    if (!keyword) return userText;
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`, 'gi');
    return userText.replace(re, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  private getGoalContextState(threadId: string): GoalContextState {
    let state = this.goalContextStates.get(threadId);
    if (!state) {
      state = {
        desiredRevision: 0,
        appliedRevision: 0,
        durableRevision: 0,
        durableGoal: this.threads.get(threadId)?.goal,
        refreshRequested: false,
        processing: false,
      };
      this.goalContextStates.set(threadId, state);
    }
    return state;
  }

  private cancelPendingGoalContext(threadId: string): void {
    const state = this.goalContextStates.get(threadId);
    state?.pendingKickoff?.resolve(false);
    state?.inFlightKickoff?.resolve(false);
    this.goalContextStates.delete(threadId);
  }

  private isGoalContextRefreshSafe(threadId: string, session: HarnessSession): boolean {
    return !session.turnInFlight
      && !session.hasPendingPermission
      && !this.pendingPermissions.has(threadId)
      && !this.pendingQuestionResolvers.has(threadId)
      && !this.pendingPlanResolvers.has(threadId)
      && !this.hasActiveBackgroundTasks(threadId);
  }

  private scheduleGoalContextProcessing(threadId: string): void {
    queueMicrotask(() => { void this.processGoalContextChange(threadId); });
  }

  private scheduleQueuedMessageFlush(threadId: string): void {
    queueMicrotask(() => {
      const state = this.goalContextStates.get(threadId);
      if (!state || state.persistencePendingRevision !== undefined || state.desiredRevision !== state.appliedRevision) return;
      const queued = this.queuedMessages.get(threadId) ?? [];
      this.queuedMessages.delete(threadId);
      for (const item of queued) {
        this.emit(threadId, { type: 'dequeued', text: item.text, images: item.images });
        void this.sendMessage(threadId, item.text, item.images);
      }
    });
  }

  private releaseRejectedPlanFeedback(threadId: string): void {
    if (this.releasingPlanFeedback.has(threadId)) return;
    this.releasingPlanFeedback.add(threadId);
    void (async () => {
      try {
        while (true) {
          if (!this.threads.has(threadId)) return;
          const goalState = this.goalContextStates.get(threadId);
          if (goalState && (
            goalState.persistencePendingRevision !== undefined
            || goalState.desiredRevision !== goalState.appliedRevision
          )) {
            if (goalState.persistencePendingRevision === undefined) {
              goalState.refreshRequested = true;
              this.scheduleGoalContextProcessing(threadId);
            }
            return;
          }
          const queue = this.queuedMessages.get(threadId);
          const item = queue?.shift();
          if (!item) {
            this.queuedMessages.delete(threadId);
            return;
          }
          if (queue?.length === 0) this.queuedMessages.delete(threadId);
          this.emit(threadId, { type: 'dequeued', text: item.text, images: item.images });
          // Open the gate only for this already-dequeued item. sendMessage()
          // executes synchronously through its gate before its first await, so
          // a racing external send still sees the gate restored below.
          this.releasingPlanFeedback.delete(threadId);
          const dispatched = this.sendMessage(threadId, item.text, item.images);
          this.releasingPlanFeedback.add(threadId);
          await dispatched;
        }
      } catch (error) {
        const thread = this.threads.get(threadId);
        if (thread) {
          const dispatchError = error instanceof Error ? error : new Error(String(error));
          thread.status = 'error';
          thread.lastError = dispatchError.message;
          thread.updatedAt = Date.now();
          this.emit(threadId, { type: 'error', error: dispatchError });
        }
      } finally {
        this.releasingPlanFeedback.delete(threadId);
      }
    })();
  }

  /**
   * Retire stale initialization context only when the adapter is fully idle.
   * Closing is synchronous; the next send lazily creates a replacement and
   * resumes the same provider session id with newly-built prompt options.
   */
  private async processGoalContextChange(threadId: string): Promise<void> {
    const state = this.goalContextStates.get(threadId);
    const thread = this.threads.get(threadId);
    if (!state || !thread || state.processing || !state.refreshRequested) return;

    const session = this.sessions.get(threadId);
    if (session && !this.isGoalContextRefreshSafe(threadId, session)) return;

    state.processing = true;
    const processingRevision = state.desiredRevision;
    try {
      if (session) {
        session.close();
        this.sessions.delete(threadId);
      }
      state.refreshRequested = false;

      const kickoff = state.pendingKickoff;
      if (kickoff && kickoff.revision === state.desiredRevision) {
        delete state.pendingKickoff;
        state.inFlightKickoff = kickoff;
        try {
          const sent = await this.sendGoalKickoffAtRevision(threadId, kickoff.revision, kickoff.message);
          kickoff.resolve(sent);
        } catch (error) {
          kickoff.reject(error);
        } finally {
          if (state.inFlightKickoff === kickoff) delete state.inFlightKickoff;
        }
      } else {
        // With no kickoff (notably /goal clear), there is no adapter startup
        // to await. No live adapter now exists, so the next lazy creation will
        // necessarily use the desired context.
        state.appliedRevision = state.desiredRevision;
      }

      if (state.desiredRevision !== processingRevision) return;

      // Messages submitted after invalidation but before persistence/rollover
      // must not leak into the old initialization context. Release them only
      // after the replacement adapter has been marked current.
      const queued = this.queuedMessages.get(threadId) ?? [];
      this.queuedMessages.delete(threadId);
      for (const item of queued) {
        this.emit(threadId, { type: 'dequeued', text: item.text, images: item.images });
        await this.sendMessage(threadId, item.text, item.images);
      }
    } finally {
      state.processing = false;
      if (state.refreshRequested) this.scheduleGoalContextProcessing(threadId);
    }
  }

  /**
   * Start the refreshed adapter before recording/sending the kickoff. Recheck
   * the revision after every awaited startup step so a replacement requested
   * during resume cannot leak an obsolete kickoff into the transcript.
   */
  private async sendGoalKickoffAtRevision(threadId: string, revision: number, message: string): Promise<boolean> {
    const thread = this.threads.get(threadId);
    const state = this.goalContextStates.get(threadId);
    if (!thread || !state || state.desiredRevision !== revision) return false;

    let session = this.sessions.get(threadId);
    if (!session) {
      session = createHarnessSession(thread, this.settings);
      this.sessions.set(threadId, session);
      const options = this.buildThreadSessionOptions(threadId, thread, undefined, false);
      if (!options) {
        this.sessions.delete(threadId);
        return false;
      }
      try {
        await session.start(options);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (
          this.goalContextStates.get(threadId) !== state
          || this.threads.get(threadId) !== thread
          || state.desiredRevision !== revision
        ) {
          session.close();
          if (this.sessions.get(threadId) === session) this.sessions.delete(threadId);
          return false;
        }
        thread.status = 'error';
        thread.lastError = error.message;
        this.emit(threadId, { type: 'error', error });
        this.sessions.delete(threadId);
        throw error;
      }
    }

    if (
      this.goalContextStates.get(threadId) !== state
      || this.threads.get(threadId) !== thread
      || state.desiredRevision !== revision
    ) {
      session.close();
      if (this.sessions.get(threadId) === session) this.sessions.delete(threadId);
      return false;
    }

    const priorMessages = thread.messages;
    const effectivePrompt = !thread.sessionId && priorMessages.length > 0
      ? buildHistoryPreamble(priorMessages, thread.cwd) + message
      : message;
    await session.prepareForSend?.(effectivePrompt);

    if (
      this.goalContextStates.get(threadId) !== state
      || this.threads.get(threadId) !== thread
      || state.desiredRevision !== revision
    ) {
      session.close();
      if (this.sessions.get(threadId) === session) this.sessions.delete(threadId);
      return false;
    }

    thread.lastError = undefined;
    thread.status = 'active';
    this.threadActivity.delete(threadId);
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: message,
      timestamp: Date.now(),
    };
    thread.messages.push(userMsg);
    thread.updatedAt = Date.now();
    this.pendingUserMessageIds.set(threadId, [...(this.pendingUserMessageIds.get(threadId) ?? []), userMsg.id]);
    state.appliedRevision = revision;
    this.emit(threadId, { type: 'user_message_added', message: userMsg });
    this.emit(threadId, { type: 'streaming_start' });
    session.send(effectivePrompt, undefined, userMsg.id);
    return true;
  }

  async sendMessage(threadId: string, userText: string, images?: ImageAttachment[]): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);

    // A completed plan is a real lifecycle gate, not merely a card rendered
    // over an otherwise-sendable session. Keep fresh user input out of the
    // provider until the user approves or rejects the plan explicitly.
    if (this.harnessSwitches.has(threadId) || this.hasPendingPlan(threadId) || this.releasingPlanFeedback.has(threadId)) {
      const queue = this.queuedMessages.get(threadId) ?? [];
      queue.push({ text: userText, images });
      this.queuedMessages.set(threadId, queue);
      this.emit(threadId, { type: 'queued', text: userText, images });
      return;
    }

    const goalState = this.getGoalContextState(threadId);
    const currentSession = this.sessions.get(threadId);
    if (
      goalState.persistencePendingRevision !== undefined
      || (currentSession && goalState.desiredRevision !== goalState.appliedRevision)
    ) {
      const queue = this.queuedMessages.get(threadId) ?? [];
      queue.push({ text: userText, images });
      this.queuedMessages.set(threadId, queue);
      this.emit(threadId, { type: 'queued', text: userText, images });
      if (goalState.persistencePendingRevision === undefined) {
        goalState.refreshRequested = true;
        this.scheduleGoalContextProcessing(threadId);
      }
      return;
    }

    thread.lastError = undefined;
    thread.status = 'active';
    this.threadActivity.delete(threadId);

    const keywordModel = this.resolveModel(userText);
    // Precedence: escalation keyword > per-thread /model override > settings default
    const model = thread.agentHarness === 'codex'
      ? (thread.model || undefined)
      : keywordModel ?? thread.model ?? (this.settings.defaultModel || undefined);
    const promptText = keywordModel ? this.stripKeyword(userText) : userText;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userText,
      timestamp: Date.now(),
      images: images && images.length > 0 ? images : undefined,
    };
    thread.messages.push(userMsg);
    thread.updatedAt = Date.now();
    // Externalize pasted images to vault files so their base64 leaves data.json
    // on the next save (keeps base64 in memory for render + relay). Desktop-only.
    this.externalizeMessageImages(threadId, userMsg);
    this.emit(threadId, { type: 'user_message_added', message: userMsg });

    // Track this message as unresolved until the generation it lands in
    // settles (onDone/onInterrupted/onError) — see pendingUserMessageIds'
    // doc comment. Multiple ids can accumulate here across concurrent
    // sendMessage() calls now that there's no "busy" gate.
    const pendingIds = this.pendingUserMessageIds.get(threadId) ?? [];
    pendingIds.push(userMsg.id);
    this.pendingUserMessageIds.set(threadId, pendingIds);

    // Get-or-lazily-create this thread's ThreadSession (ADR-0002 §3: lazy on
    // first message, reused for every subsequent turn — replaces `new
    // ClaudeSession()` per turn). IMPORTANT: this lookup-or-create is
    // synchronous, with no `await` before `this.sessions.set()` below — two
    // concurrent sendMessage() calls for the same thread can never both
    // observe "no session yet," because JS run-to-completion semantics mean
    // the first call's synchronous prefix (including the `.set()`) always
    // finishes before the second call's synchronous prefix starts, so the
    // second call sees the first call's session already in the map. That
    // closes the exact race this ADR exists to remove, without needing the
    // old `if (this.sessions.has(threadId)) { queue; return; }` gate — which
    // is also why that gate is gone entirely: ADR-0002 §2's live-CLI probe
    // confirmed `send()` is safe to call unconditionally even while a turn
    // is already in flight (the CLI coalesces it into the current
    // generation), so there's no need to hold messages back locally anymore.
    let session = this.sessions.get(threadId);
    // A cwd change (enter_worktree / set_working_directory) since this session
    // was built leaves its Query pinned to the old directory. setThreadCwd() no
    // longer restarts eagerly (that stranded the very tool result that triggered
    // the change — the EnterWorktree hang). Rebuild here instead, at a safe turn
    // boundary. Guard on !turnInFlight so a rare concurrent send mid-turn can't
    // re-introduce the mid-turn close(); that message coalesces into the current
    // generation and the rebuild happens on the following turn.
    if (session && session.cwd !== undefined && session.cwd !== thread.cwd && !session.turnInFlight) {
      session.close();
      this.sessions.delete(threadId);
      session = undefined;
    }
    const isNewSession = !session;
    if (!session) {
      session = createHarnessSession(thread, this.settings);
      this.sessions.set(threadId, session);
      const goalState = this.getGoalContextState(threadId);
      goalState.appliedRevision = goalState.desiredRevision;
    }

    this.emit(threadId, { type: 'streaming_start' });
    if (model) {
      this.emit(threadId, { type: 'escalated', model });
    }

    // Safety net against the misleading "binary not found" ENOENT the SDK
    // emits when Claude is spawned with a non-existent cwd — see
    // ensureCwdExists() for the repair strategy. Bail out (an 'error' event
    // has already been emitted) if the cwd is still missing afterward.
    const options = this.buildThreadSessionOptions(threadId, thread, model);
    if (!options) return;

    // If there is no session to resume but there IS prior history, the cwd must
    // have changed mid-conversation (via obsidian_set_working_directory). Inject
    // the prior turns as a preamble so Claude isn't amnesiac after the switch.
    const priorMessages = thread.messages.slice(0, -1); // excludes the just-pushed user msg
    const isFreshUnresumedSession = !thread.sessionId && priorMessages.length > 0;
    const handoffPrompt = thread.pendingHarnessHandoff
      ? buildHarnessHandoffPrompt(thread, thread.pendingHarnessHandoff.sourceHarness, thread.pendingHarnessHandoff.targetHarness)
      : undefined;
    const effectivePrompt = handoffPrompt
      ? `${handoffPrompt}\n\n${promptText}`
      : isFreshUnresumedSession
        ? buildHistoryPreamble(priorMessages, thread.cwd) + promptText
        : promptText;

    // The SDK's Task board IDs are small integers that restart at 1 for every
    // new session (~/.claude/tasks/<session-uuid>/1.json, 2.json, ...). Once we
    // start a brand-new session here — rather than resuming the prior one —
    // any tasks left over on this thread belong to a session that's gone for
    // good. Leaving them in place means the new session's TaskCreate calls
    // collide by ID with these stale entries: applyTaskEvent() upserts by raw
    // ID, so a leftover incomplete task silently gets its content overwritten
    // and flipped to whatever status the new session's same-ID task reaches.
    // Clear both so the new session starts with a clean board.
    if (isFreshUnresumedSession) {
      delete thread.tasks;
      delete thread.pendingBackgroundTasks;
      this.emit(threadId, { type: 'tasks_updated', tasks: [] });
    }

    if (isNewSession) {
      try {
        await session.start(options);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        thread.status = 'error';
        thread.lastError = error.message;
        this.emit(threadId, { type: 'error', error });
        this.sessions.delete(threadId);
        return;
      }
    } else {
      // ADR-0002 §2: model/permission-mode changes are a direct
      // control-request on the live Query instead of a full session
      // rebuild. Resync on every turn (not just when setThreadModel()/
      // setThreadPermissionMode() are explicitly called) so the transient
      // /escalate keyword keeps working — it was always a per-run()
      // override before; applying it for this turn and leaving it in
      // effect until a future turn resolves a different model is the
      // closest equivalent under a persistent Query.
      try {
        await session.setModel(model);
        await session.setPermissionMode(options.permissionMode as PermissionMode);
      } catch (err) {
        console.error('[ClaudeThreads] sendMessage: failed to sync model/permission mode before send:', err);
      }
    }

    try {
      await session.prepareForSend?.(effectivePrompt, images);
      session.send(effectivePrompt, images, userMsg.id);
    } catch (err) {
      // The ThreadSession's Query had already been torn down (a prior
      // generation errored out, or the channel was otherwise closed) —
      // restart it in place (resuming thread.sessionId, same as a lazy
      // first start) and retry once. Unlike the old per-turn ClaudeSession,
      // a closed ThreadSession is reopened on the SAME instance rather than
      // raced against a second one (ADR-0002 §2).
      console.warn('[ClaudeThreads] sendMessage: send() on a closed ThreadSession — restarting:', err);
      await session.start(options);
      session.send(effectivePrompt, images, userMsg.id);
    }
  }

  /**
   * Checks (and best-effort repairs) a thread's cwd before opening or
   * restarting its `ThreadSession`. Moved out of `sendMessage()` so
   * `setThreadCwd()`'s restart path (via `buildThreadSessionOptions()`
   * below) can share it. Returns false — having already emitted an 'error'
   * event — if the cwd is still missing after an attempted repair.
   */
  private ensureCwdExists(threadId: string, thread: Thread): boolean {
    if (!thread.cwd) return true;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    if (fs.existsSync(thread.cwd)) return true;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePath = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');
    const worktreeContainer = nodePath.join(os.tmpdir(), 'claude-worktrees');
    const isVolatileWorktree = thread.cwd.startsWith(worktreeContainer + nodePath.sep);

    if (isVolatileWorktree) {
      // Use the dedicated repair path for tmpdir worktrees.
      this.repairStaleCwds();
    } else {
      // Non-volatile path (e.g. a project-directory worktree or a deleted
      // folder). Walk up to the nearest valid ancestor — same strategy as
      // repairStaleCwds() — and silently reroute the thread there.
      let fallback: string = thread.cwd;
      while (true) {
        const parent = nodePath.dirname(fallback);
        if (parent === fallback) { fallback = ''; break; }
        fallback = parent;
        if (fs.existsSync(fallback)) break;
      }
      if (!fallback || !fs.existsSync(fallback)) {
        fallback = this.vaultRoot || os.homedir();
      }
      console.warn(
        `[ClaudeThreads] Auto-repairing stale cwd for thread "${thread.title}": ` +
        `"${thread.cwd}" → "${fallback}"`,
      );
      this.setThreadCwd(threadId, fallback);
    }

    // If the cwd is still missing after attempted repair, surface a clear
    // error rather than letting Node emit the confusing ENOENT.
    if (!fs.existsSync(thread.cwd!)) {
      const err = new Error(
        `Working directory no longer exists: "${thread.cwd}". ` +
        `Use set_working_directory to point this thread at a valid path.`,
      );
      this.emit(threadId, { type: 'error', error: err });
      return false;
    }
    return true;
  }

  /**
   * Builds the full options needed to open (or restart) a thread's
   * `ThreadSession`: cwd validation/repair, additional directories, the
   * per-thread system-prompt context, MCP servers, secret env, and the
   * `SessionCallbacks` that wire the session's message pump back into
   * `ThreadEvent`s. Called both from `sendMessage()` (lazy first start) and
   * `setThreadCwd()` (explicit cwd-change restart, ADR-0002 §2). Returns
   * null if the thread's cwd is missing and couldn't be repaired (an
   * 'error' event has already been emitted in that case).
   */
  private buildThreadSessionOptions(
    threadId: string,
    thread: Thread,
    modelOverride?: string,
    latestMessageIsCurrentSend = true,
  ): HarnessSessionOptions | null {
    if (!this.ensureCwdExists(threadId, thread)) return null;

    const additionalDirs = [...new Set([this.vaultRoot, thread.cwd].filter(Boolean))];
    const project = thread.projectId ? this.getProject(thread.projectId) : undefined;
    const envContext = buildEnvironmentSystemPrompt(
      this.vaultRoot,
      thread.cwd,
      this.settings.vaultFolder,
      this.settings.saveThreadsToVault,
      this.hostName,
    );
    const projectDesc = project?.description?.trim();
    const goalContext = thread.goal
      ? `## Active Goal\nThe user has set a persistent goal for this thread: "${thread.goal}"\n` +
        'Keep working toward this goal across turns. If a reply would leave the goal unmet, ' +
        'state what remains and continue working on it. The goal stays active until the user clears it with /goal clear.'
      : '';
    // INTENTIONAL: thread.managerNotes and thread.proposedReply are never included
    // here. They are thread-orchestrator bookkeeping (inferred goal/status/cursor,
    // a drafted-but-unsent reply) meant to be visible only in the UI. Unlike
    // `goal` below — which the user explicitly asks to be injected into every
    // turn — leaking these into the session context would let the model see
    // its own prior "grading" of the thread and the orchestrator's draft before
    // Rick has approved it. Do not "fix" this by adding them to the list.
    const appendSystemPrompt = [envContext, projectDesc, goalContext]
      .filter(Boolean)
      .join('\n\n');
    const sessionMcpServers = this.mcpServerFactory ? this.mcpServerFactory(threadId, thread.cwd) : this.mcpServers;
    // The Agent Threads MCP server exposes the same canonical tool definitions to
    // Codex through its app-server dynamic-tool adapter. Serializable external
    // stdio/HTTP/SSE servers are mirrored into Codex's per-thread config.
    const codexDynamicTools = selectCanonicalHarnessTools<import('./HarnessSession').HarnessDynamicTool>(sessionMcpServers);
    const codexMcpServers = Object.fromEntries(
      Object.entries(sessionMcpServers ?? {}).filter(([, server]) => (server as { type?: string }).type !== 'sdk'),
    );
    const resolvedSecretEnv = this.secretEnvResolver ? this.secretEnvResolver(project?.id) : {};
    const agentProfiles = loadAgentProfiles(this.settings.skillSources ?? []);

    return {
      cwd: thread.cwd,
      permissionMode: thread.permissionMode ?? this.settings.permissionMode,
      extraEnvRaw: effectiveExtraEnv(this.settings),
      // Session IDs are harness-specific. Existing threads predate the field
      // and are Claude threads, so they never get passed to Codex.
      resume: thread.sessionId,
      callbacks: this.buildSessionCallbacks(threadId, thread),
      additionalDirectories: additionalDirs,
      // modelOverride carries sendMessage()'s escalation-aware `model` local
      // (keywordModel ?? thread.model ?? settings.defaultModel) through to a
      // brand-new session's start(). Without it, a thread's first-ever
      // message silently dropped the /escalate keyword: this method used to
      // independently recompute `thread.model ?? settings.defaultModel`,
      // never consulting the escalation resolution sendMessage() already
      // did. On an existing session, sendMessage()'s `else` branch already
      // applies the escalation-aware value directly via `session.setModel()`
      // — this override brings the very first message in line with that.
      // Other call sites (e.g. setThreadCwd()'s cwd-change restart) omit it
      // and fall back to the plain thread.model — correct there, since a
      // cwd-change restart isn't a new user message and has no escalation
      // keyword to apply.
      model: thread.agentHarness === 'codex'
        ? (modelOverride ?? thread.model ?? undefined)
        : modelOverride ?? thread.model ?? (this.settings.defaultModel || undefined),
      appendSystemPrompt,
      resumeFallbackHistory: thread.agentHarness === 'codex' && thread.sessionId
        ? buildHistoryPreamble(
            latestMessageIsCurrentSend ? thread.messages.slice(0, -1) : thread.messages,
            thread.cwd,
          )
        : undefined,
      secretEnv: resolvedSecretEnv,
      claude: {
        mcpServers: sessionMcpServers,
        disallowedTools: this.settings.disallowedTools,
        sessionOptions: this.buildSessionOptions(thread, agentProfiles),
      },
      codex: {
        computerUseEnabled: this.settings.codexComputerUseEnabled === true,
        localSkillsRoot: this.localSkillsRoot(),
        ...resolveCodexPermissions(thread.permissionMode ?? this.settings.permissionMode),
        ...(this.settings.codexEffort && this.settings.codexEffort !== 'default'
          ? { effort: this.settings.codexEffort }
          : {}),
        skillRoots: codexSkillRoots(
          this.settings.skillSources ?? [],
          this.pluginResourceDir
            ? require('path').join(this.pluginResourceDir, 'resources', 'skills')
            : undefined,
          // Vault-installed skills. Codex discovers by parent root, so it gets
          // the skills dir itself rather than the generated plugin root Claude uses.
          pluginSkillsRootFrom(this.pluginResourceDir ?? ''),
          this.localSkillsRoot(),
        ),
        dynamicTools: codexDynamicTools,
        mcpServers: codexMcpServers,
        agentProfiles,
      },
    };
  }

  /**
   * Clears the transient `'reconnecting'` status set by `onReconnecting`
   * (see below) once the auto-retried continuation turn actually starts
   * producing events again. Under the old per-turn model, this reset
   * happened implicitly: the continuation was a brand-new `sendMessage()`
   * call, which sets `thread.status = 'active'` at its own top (`:738`).
   * Under the new long-lived-`ThreadSession` model there is no such call —
   * `ThreadSession.pumpMessages()`'s catch block calls `this.send(...)`
   * internally, with no `sendMessage()`/`ThreadManager` round-trip at all —
   * so nothing would otherwise clear `'reconnecting'` if the continuation
   * succeeds.
   *
   * Called from whichever of `onToken`/`onMessage`/`onStatus` fires first
   * once the continuation's generation resumes producing events, mirroring
   * the existing pattern elsewhere in this file of guarding a state
   * transition with "if it's currently in the state I'm about to leave"
   * (e.g. the `pendingPlan`/`pendingQuestions` safety nets in `onDone`/
   * `onError` below) rather than introducing a new dedicated signal from
   * `ThreadSession`. `onToken` is expected to fire first in the common case
   * (`includePartialMessages: true` streams text deltas before the final
   * `assistant` message), but a continuation whose first action is a tool
   * call with no preceding text would skip straight to `onMessage` (or, for
   * a `compacting`/`requesting` status flip mid-continuation, `onStatus`) —
   * covering all three is what actually guarantees the thread never gets
   * stuck showing `'reconnecting'` forever once real progress resumes,
   * regardless of what shape that progress takes.
   *
   * Deliberately NOT cleared in `onDone`/`onInterrupted`/`onError`: those
   * already unconditionally set `thread.status` to `'waiting'`/`'waiting'`/
   * `'error'` respectively, so a reconnecting thread that settles without
   * ever producing a visible event (unlikely, but not impossible) still
   * ends up in a correct terminal status without needing this helper too.
   */
  private clearReconnectingStatus(thread: Thread): void {
    if (thread.status === 'reconnecting') {
      thread.status = 'active';
      thread.updatedAt = Date.now();
    }
  }

  /**
   * Builds the `SessionCallbacks` that wire a `ThreadSession`'s message pump
   * back into `ThreadEvent`s for this thread. Built once per `start()`/
   * `restart()` call — NOT once per turn, unlike the old per-turn
   * `ClaudeSession`'s callback object. Per-turn accumulation that used to
   * live in local variables scoped to one `sendMessage()` call (tool-result
   * images, in-flight background tasks) now lives in instance state
   * (`pendingToolResultImages`, `activeBgTasks`) keyed by threadId, since
   * these callbacks are reused across every turn of the thread's session.
   */
  private buildSessionCallbacks(threadId: string, thread: Thread): SessionCallbacks {
    // Captured once, when this session's callbacks are built (i.e. when the
    // session is opened against a particular cwd). If a cwd change lands
    // mid-turn, thread.cwd will have moved on by the time onDone fires; the
    // guard below then refuses to write back a sessionId that belongs to the
    // OLD directory's project (see onDone).
    const cwdAtStart = thread.cwd;
    const harnessAtStart = thread.agentHarness ?? 'claude';
    const generationAtStart = thread.sessionGeneration ?? 0;
    const isCurrentGeneration = () =>
      this.threads.get(threadId) === thread
      && (thread.sessionGeneration ?? 0) === generationAtStart;
    return {
      onRawEvent: (event) => {
        if (!isCurrentGeneration()) return;
        if (!this.settings.saveRawLogs || !this.vaultRoot) return;
        // Record the log path on the thread the first time we write, so the
        // markdown note's `raw_log` frontmatter can link to it.
        if (!thread.rawLogPath) {
          thread.rawLogPath = this.rawLogWriter.vaultRelativePath(thread.id);
        }
        this.rawLogWriter.append(
          thread.id,
          thread.sessionId,
          typeof event.type === 'string' ? event.type : 'unknown',
          event,
        );
      },
      onToken: (text) => {
        if (!isCurrentGeneration()) return;
        this.clearReconnectingStatus(thread);
        this.emit(threadId, { type: 'token', text });
      },
      onToolUse: (record) => {
        if (!isCurrentGeneration()) return;
        this.threadActivity.set(threadId, record.summary);
        // Persist file paths for Write/Edit tools so they survive tab switches.
        if (record.name === 'Write' || record.name === 'Edit') {
          const filePath = record.summary.replace(/^[^:]+: /, '');
          if (filePath) {
            if (!thread.editedFiles) thread.editedFiles = [];
            if (!thread.editedFiles.includes(filePath)) thread.editedFiles.push(filePath);
          }
        }
        this.emit(threadId, { type: 'tool_use', record });
      },
      onFilesEdited: (paths) => {
        if (!isCurrentGeneration()) return;
        const added: string[] = [];
        if (!thread.editedFiles) thread.editedFiles = [];
        for (const filePath of paths) {
          if (!filePath || thread.editedFiles.includes(filePath)) continue;
          thread.editedFiles.push(filePath);
          added.push(filePath);
        }
        if (added.length > 0) this.emit(threadId, { type: 'files_edited', paths: added });
      },
      onRecap: (summary) => {
        if (!isCurrentGeneration()) return;
        thread.recap = summary;
        this.emit(threadId, { type: 'recap', summary });
      },
      onMessage: (content, toolCalls) => {
        if (!isCurrentGeneration()) return;
        this.clearReconnectingStatus(thread);
        const images = this.pendingToolResultImages.get(threadId);
        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content,
          timestamp: Date.now(),
          agentHarness: harnessAtStart,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          toolResultImages: images && images.length > 0 ? [...images] : undefined,
        };
        this.pendingToolResultImages.delete(threadId);
        thread.messages.push(assistantMsg);
        thread.updatedAt = Date.now();
        // Externalize tool-result images to vault files (see sendMessage above).
        this.externalizeMessageImages(threadId, assistantMsg);
        this.emit(threadId, { type: 'message', message: assistantMsg });
      },
      onDone: (sessionId, cost, _numTurns, metadata) => {
        if (!isCurrentGeneration()) return;
        // Only persist this sessionId if the cwd hasn't changed since this
        // session was opened. setThreadCwd() (enter_worktree /
        // set_working_directory) clears thread.sessionId and defers the
        // session rebuild to the next turn (see setThreadCwd()); if the
        // change landed mid-turn, this sessionId belongs to the OLD
        // directory's Claude Code project. Writing it back would resurrect
        // the id setThreadCwd() just cleared, and the next turn would try to
        // `resume` an old-dir session in the new dir — failing with "No
        // conversation found". The guard keeps thread.sessionId undefined so
        // the next turn starts fresh in the new cwd with a history preamble.
        if (thread.cwd === cwdAtStart) {
          thread.sessionId = sessionId;
        }
        if ((metadata?.queuedTurnCount ?? 0) > 0) {
          const pendingIds = this.pendingUserMessageIds.get(threadId);
          if (pendingIds && metadata?.userMessageUuid) {
            const remaining = pendingIds.filter((id) => id !== metadata.userMessageUuid);
            if (remaining.length > 0) this.pendingUserMessageIds.set(threadId, remaining);
            else this.pendingUserMessageIds.delete(threadId);
          }
          thread.updatedAt = Date.now();
          thread.status = 'active';
          return;
        }
        thread.updatedAt = Date.now();
        thread.status = 'waiting';
        thread.streamCloseRetryCount = 0; // TODO: likely vestigial post-Stage-C — see types.ts's doc comment on this field
        thread.rateLimitRetryCount = 0;
        const lastMsg = thread.messages[thread.messages.length - 1];
        if (lastMsg?.role === 'assistant' && cost > 0) {
          lastMsg.cost = cost;
        }
        this.threadActivity.delete(threadId);
        // This generation settled successfully — every user message pushed
        // since the last settlement (including any that coalesced into this
        // same generation per ADR-0002 §2) has now been answered. Nothing to
        // roll back, just stop tracking them.
        this.pendingUserMessageIds.delete(threadId);
        if (thread.pendingHarnessHandoff && thread.sessionId) delete thread.pendingHarnessHandoff;

        // Safety net: if a pending plan somehow survived to onDone (e.g. the
        // session completed without user action), clear it so a stale card
        // can't reappear on the next focus.
        if (thread.pendingPlan) {
          delete thread.pendingPlan;
          this.pendingPlanResolvers.delete(threadId);
          this.emit(threadId, { type: 'pending_plan_changed', planText: undefined });
        }

        // Same safety net for a dangling pending question.
        if (thread.pendingQuestions) {
          delete thread.pendingQuestions;
          this.pendingQuestionResolvers.delete(threadId);
          this.emit(threadId, { type: 'pending_question_changed', questions: undefined });
        }

        // If any background tasks started but never notified, persist them so
        // main.ts can schedule polling resumption after the session closes.
        const activeBgTasksForThread = this.activeBgTasks.get(threadId);
        if (activeBgTasksForThread && activeBgTasksForThread.size > 0) {
          const newPending: PendingBackgroundTask[] = Array.from(activeBgTasksForThread.entries()).map(
            ([taskId, { description, startedAt }]) => ({ taskId, description, startedAt, pollCount: 0 }),
          );
          // Merge with any already-persisted tasks (dedup by taskId).
          const existing = thread.pendingBackgroundTasks ?? [];
          const existingIds = new Set(existing.map(t => t.taskId));
          thread.pendingBackgroundTasks = [
            ...existing,
            ...newPending.filter(t => !existingIds.has(t.taskId)),
          ];
          this.emit(threadId, { type: 'background_tasks_pending', tasks: thread.pendingBackgroundTasks });
        }

        // Peer review does not require a mounted list/board. Invalidate here
        // before persistence listeners run, so completed work is always New.
        thread.reviewed = false;
        this.emit(threadId, { type: 'done' });
        this.emitRunStateSettledWhenIdle(threadId);
        this.scheduleQueuedMessageFlush(threadId);
      },
      onInterrupted: (_sessionId) => {
        if (!isCurrentGeneration()) return;
        // Roll back every orphaned, unresolved user message — not just the
        // trailing one. Under the old per-turn model, sendMessage() gated on
        // "busy," so at most one user message could ever be unresolved when
        // an interrupt landed, and matching its exact userMsg.id (captured
        // in that turn's own closure) was enough. Under ADR-0002 §2's
        // confirmed always-safe-to-send() model there's no such gate: a
        // follow-up (or several) can be pushed to thread.messages while a
        // prior generation is still in flight and coalesce into it (or land
        // just before the interrupt), so more than one trailing message can
        // be unresolved at once. pendingUserMessageIds tracks every id
        // pushed since the last settlement, so roll back all of them — not
        // just the last — or an earlier one is left in the transcript
        // looking answered when it never was.
        const pendingIds = this.pendingUserMessageIds.get(threadId);
        if (pendingIds && pendingIds.length > 0) {
          const idSet = new Set(pendingIds);
          thread.messages = thread.messages.filter((m) => !idSet.has(m.id));
        }
        this.pendingUserMessageIds.delete(threadId);
        thread.updatedAt = Date.now();
        thread.status = 'waiting';
        // Do NOT update thread.sessionId — the last successful session ID is still valid
        this.threadActivity.delete(threadId);
        this.queuedMessages.delete(threadId);
        this.emit(threadId, { type: 'interrupted' });
        this.emitRunStateSettledWhenIdle(threadId);
      },
      onError: (err) => {
        if (!isCurrentGeneration()) return;
        // Safety net: always clean up a pending plan card here, mirroring
        // the onDone safety net above — otherwise an errored session (e.g.
        // during a long ExitPlanMode wait) leaves the card stuck forever
        // and its resolvers leak, since they resolve a promise for a
        // session that has already exited.
        if (thread.pendingPlan) {
          delete thread.pendingPlan;
          this.pendingPlanResolvers.delete(threadId);
          this.emit(threadId, { type: 'pending_plan_changed', planText: undefined });
        }

        // Transport-error auto-retry is now entirely ThreadSession's job
        // (ADR-0002 §2: "process died → respawn with resume" becomes
        // `session.restart('transport-error')`, handled internally in
        // ThreadSession's pump loop before this callback is ever reached —
        // see the `catch` block in `ThreadSession.pumpMessages()`). By the
        // time onError fires here, ThreadSession has already either
        // exhausted its own one-shot retry budget or determined the error
        // isn't transport-related — either way it's terminal from
        // ThreadManager's perspective, so there is no longer a second
        // retry-and-requeue branch here.
        thread.updatedAt = Date.now();
        thread.lastError = err.message;
        thread.status = 'error';
        thread.streamCloseRetryCount = 0; // TODO: likely vestigial post-Stage-C — see types.ts's doc comment on this field
        thread.rateLimitRetryCount = 0;
        this.threadActivity.delete(threadId);
        this.queuedMessages.delete(threadId);
        // Terminal, like onDone — stop tracking these ids as unresolved.
        // Unlike onInterrupted, an error doesn't roll the messages back
        // (matches the pre-existing behavior: only an explicit interrupt
        // ever popped messages).
        this.pendingUserMessageIds.delete(threadId);
        this.emit(threadId, { type: 'error', error: err });
        this.emitRunStateSettledWhenIdle(threadId);
      },
      onPermissionRequest: async (toolName, detail) => {
        if (!isCurrentGeneration()) return false;
        this.pendingPermissions.set(threadId, { toolName, detail });
        this.emit(threadId, { type: 'permission_request', toolName, detail });
        try {
          return await this.permissionHandler(threadId, toolName, detail);
        } finally {
          this.pendingPermissions.delete(threadId);
          this.permissionResolvers.delete(threadId);
          this.emit(threadId, { type: 'permission_resolved' });
        }
      },
      onAskUserQuestion: async (questions) => {
        if (!isCurrentGeneration()) return {};
        // Persist the question set so the card can be restored after a
        // reload/crash OR after the user switches threads mid-session,
        // mirroring the pendingPlan pattern.
        thread.pendingQuestions = questions;
        thread.updatedAt = Date.now();
        this.emit(threadId, { type: 'pending_question_changed', questions });
        this.emit(threadId, { type: 'question_ready', questions });
        try {
          return await this.questionHandler(threadId, questions);
        } finally {
          delete thread.pendingQuestions;
          thread.updatedAt = Date.now();
          this.pendingQuestionResolvers.delete(threadId);
          this.emit(threadId, { type: 'pending_question_changed', questions: undefined });
        }
      },
      onAskUserQuestionCanceled: () => {
        if (!isCurrentGeneration()) return;
        this.pendingQuestionResolvers.get(threadId)?.({});
      },
      onOpenNewTab: (title, initialPrompt) => this.openNewTabHandler(title, initialPrompt),
      onStatus: (status) => {
        if (!isCurrentGeneration()) return;
        this.clearReconnectingStatus(thread);
        this.emit(threadId, { type: 'status', status });
      },
      onReconnecting: (error) => {
        if (!isCurrentGeneration()) return;
        // Mirrors the old per-turn model's ThreadManager.sendMessage()
        // onError branch (see ClaudeSession.ts's SessionCallbacks.onReconnecting
        // doc comment) as closely as possible: mark the thread as
        // reconnecting and emit the same 'reconnecting' event the UI
        // (ThreadsView.ts's `case 'reconnecting':`) already knows how to
        // render. Cleared by clearReconnectingStatus() once the internally
        // auto-retried continuation turn actually starts producing events
        // again (see that method's doc comment for why onDone/onError don't
        // also need to clear it).
        thread.status = 'reconnecting';
        thread.updatedAt = Date.now();
        this.emit(threadId, { type: 'reconnecting', error });
      },
      onRateLimitRetry: (attempt, maxRetries, delayMs) => {
        if (!isCurrentGeneration()) return;
        // A rate-limit / overload reject that ThreadSession is silently
        // replaying after a backoff (see its pumpMessages() catch block).
        // Share the transport-error path's transient 'reconnecting' status —
        // both are auto-recovered, non-terminal, and cleared by
        // clearReconnectingStatus() once the replayed turn produces events —
        // but emit a distinct event so the UI can show rate-limit-specific
        // copy (attempt N/M, retrying in Ns).
        thread.status = 'reconnecting';
        thread.rateLimitRetryCount = attempt;
        thread.updatedAt = Date.now();
        this.emit(threadId, { type: 'rate_limit_retry', attempt, maxRetries, delayMs });
      },
      onCompact: (trigger, preTokens) => {
        if (!isCurrentGeneration()) return;
        const compactMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'compact',
          content: '',
          timestamp: Date.now(),
          compactTrigger: trigger,
          preTokens,
        };
        thread.messages.push(compactMsg);
        thread.updatedAt = Date.now();
        this.emit(threadId, { type: 'compact', message: compactMsg });
      },
      onTaskStarted: (taskId, description, skipTranscript, taskType, workflowName, subagentType, parentNativeAgentId, model) => {
        if (!isCurrentGeneration()) return;
        this.threadActivity.set(threadId, description);
        // Background tasks use skipTranscript=true. Track them so we can detect
        // if they're still running when the session ends.
        if (skipTranscript) {
          const active = this.activeBgTasks.get(threadId) ?? new Map<string, { description: string; startedAt: number }>();
          active.set(taskId, { description, startedAt: Date.now() });
          this.activeBgTasks.set(threadId, active);
        }
        if (AgentRunStore.isAgentTask({ skipTranscript, taskType, subagentType })) {
          this.agentRuns.observeStart({
            threadId, harness: harnessAtStart, nativeAgentId: taskId, sessionGeneration: generationAtStart,
            taskId, description, role: subagentType, parentNativeAgentId, model,
          });
          this.persistAgentRuns(thread);
        }
        this.emit(threadId, { type: 'task_started', taskId, description, skipTranscript, taskType, workflowName, subagentType });
      },
      onTaskUpdated: (taskId, patch) => {
        if (!isCurrentGeneration()) return;
        const run = this.agentRuns.getByNativeId(threadId, harnessAtStart, taskId, generationAtStart);
        if (run) {
          if (patch.description) run.description = patch.description;
          const status = patch.status === 'completed' ? 'completed' : patch.status === 'failed' ? 'failed' : patch.status === 'killed' ? 'interrupted' : patch.status === 'pending' ? 'waiting' : 'working';
          this.agentRuns.observeStatus(threadId, run.harness, taskId, status, undefined, patch.error, Date.now(), generationAtStart);
          this.persistAgentRuns(thread);
        }
        this.emit(threadId, { type: 'task_updated', taskId, ...patch });
      },
      onTaskProgress: (taskId, description, lastToolName) => {
        if (!isCurrentGeneration()) return;
        const suffix = lastToolName ? ` · ${lastToolName}` : '';
        this.threadActivity.set(threadId, description + suffix);
        const run = this.agentRuns.getByNativeId(threadId, harnessAtStart, taskId, generationAtStart);
        if (run) {
          this.agentRuns.observeActivity(threadId, run.harness, taskId, { kind: lastToolName ? 'tool' : 'activity', text: description, toolName: lastToolName, timestamp: Date.now() }, generationAtStart);
          this.persistAgentRuns(thread);
        }
        this.emit(threadId, { type: 'task_progress', taskId, description, lastToolName });
      },
      onTaskNotification: (taskId, status, summary) => {
        if (!isCurrentGeneration()) return;
        // Task resolved — remove from background tracking set.
        this.activeBgTasks.get(threadId)?.delete(taskId);
        // Also clear from persisted state (handles notifications that arrive
        // on a poll-resume after a previous session missed them).
        this.clearPendingBackgroundTask(threadId, taskId);
        const run = this.agentRuns.getByNativeId(threadId, harnessAtStart, taskId, generationAtStart);
        if (run) {
          this.agentRuns.observeStatus(threadId, run.harness, taskId, status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'interrupted', summary, undefined, Date.now(), generationAtStart);
          this.persistAgentRuns(thread);
        }
        this.emit(threadId, { type: 'task_notification', taskId, status, summary });
        this.scheduleGoalContextProcessing(threadId);
      },
      onNotification: (text, priority) => this.emit(threadId, { type: 'notification', text, priority }),
      onApiRetry: (attempt, maxRetries, error) => this.emit(threadId, { type: 'api_retry', attempt, maxRetries, error }),
      onPermissionDenied: (toolName, toolUseId, message, agentId, decisionReasonType) => this.emit(threadId, { type: 'permission_denied', toolName, toolUseId, message, agentId, decisionReasonType }),
      onRateLimit: (limitStatus, resetsAt) => this.emit(threadId, { type: 'rate_limit', limitStatus, resetsAt }),
      onUsage: (usage) => {
        if (!isCurrentGeneration()) return;
        thread.usageSnapshot = usage;
        thread.updatedAt = Date.now();
        this.emit(threadId, { type: 'usage', usage });
      },
      onModelFallback: (trigger, fromModel, toModel) => this.emit(threadId, { type: 'model_fallback', trigger, fromModel, toModel }),
      onModelRefusalFallback: (refusal) => this.emit(threadId, { type: 'model_refusal_fallback', ...refusal }),
      onModelRefusalNoFallback: (refusal) => this.emit(threadId, { type: 'model_refusal_no_fallback', ...refusal }),
      onToolProgress: (toolUseId, toolName, elapsedSeconds) => this.emit(threadId, { type: 'tool_progress', toolUseId, toolName, elapsedSeconds }),
      onMemoryRecall: (paths, mode) => this.emit(threadId, { type: 'memory_recall', paths, mode }),
      onCommandsChanged: (commands) => this.emit(threadId, { type: 'commands_changed', commands }),
      onTaskProgressSummary: (taskId, summary) => {
        if (!isCurrentGeneration()) return;
        const run = this.agentRuns.getByNativeId(threadId, thread.agentHarness ?? 'claude', taskId);
        if (run) {
          this.agentRuns.observeActivity(threadId, run.harness, taskId, { kind: 'activity', text: summary, timestamp: Date.now() });
          this.persistAgentRuns(thread);
        }
        this.emit(threadId, { type: 'task_progress_summary', taskId, summary });
      },
      onGitOperation: (summary) => this.emit(threadId, { type: 'git_operation', summary }),
      onToolResult: (toolUseId, status, durationMs) => this.emit(threadId, { type: 'tool_result_status', toolUseId, status, durationMs }),
      onEnterPlanMode: () => this.emit(threadId, { type: 'enter_plan_mode' }),
      onPlanModeRequested: () => {
        if (!isCurrentGeneration()) return;
        // Codex crosses a safe turn boundary before entering Plan mode. Persist
        // the reduced-capability state here; the adapter owns the matching
        // app-server settings update so there is one live control request.
        thread.permissionMode = 'plan';
        thread.updatedAt = Date.now();
        this.emit(threadId, { type: 'permission_mode_changed', mode: 'plan' });
      },
      onPlanApprovalCommitted: () => {
        if (!isCurrentGeneration()) return;
        thread.permissionMode = 'default';
        thread.updatedAt = Date.now();
        this.emit(threadId, { type: 'permission_mode_changed', mode: 'default' });
        delete thread.pendingPlan;
        this.pendingPlanResolvers.delete(threadId);
        this.emit(threadId, { type: 'pending_plan_changed', planText: undefined });
      },
      onPlanTransitionError: (error) => {
        if (!isCurrentGeneration()) return;
        thread.lastError = error.message;
        thread.updatedAt = Date.now();
        this.emit(threadId, { type: 'plan_transition_error', error });
      },
      onPlanReady: (planText, approve, reject) => {
        if (!isCurrentGeneration()) return;
        // Persist the plan text so the card can be restored after a reload/crash
        // OR after the user switches threads mid-session.
        thread.pendingPlan = planText;
        thread.updatedAt = Date.now();
        this.emit(threadId, { type: 'pending_plan_changed', planText });
        // Wrap callbacks to clear both the persisted plan and the in-memory
        // resolvers when the user acts on the card.
        const wrappedApprove = (editedPlan?: string) => {
          // Both harnesses leave plan mode on approval. Persist that transition
          // before emitting any save-triggering event so data.json can never
          // capture a cleared card with stale Plan mode.
          if (thread.agentHarness === 'codex') {
            approve(editedPlan);
            return;
          } else {
            this.setThreadPermissionMode(threadId, 'default');
          }
          delete thread.pendingPlan;
          thread.updatedAt = Date.now();
          this.pendingPlanResolvers.delete(threadId);
          this.emit(threadId, { type: 'pending_plan_changed', planText: undefined });
          approve(editedPlan);
        };
        const wrappedReject = (): boolean => {
          delete thread.pendingPlan;
          thread.updatedAt = Date.now();
          this.pendingPlanResolvers.delete(threadId);
          this.emit(threadId, { type: 'pending_plan_changed', planText: undefined });
          const adapterHadFeedback = reject();
          const queued = this.queuedMessages.get(threadId) ?? [];
          const managerHadFeedback = queued.length > 0;
          if (managerHadFeedback) {
            this.releaseRejectedPlanFeedback(threadId);
          }
          return adapterHadFeedback || managerHadFeedback;
        };
        // Store resolvers in-memory so restorePendingPlanCard() can re-wire the
        // card after the user switches threads and switches back mid-session.
        this.pendingPlanResolvers.set(threadId, { approve: wrappedApprove, reject: wrappedReject });
        this.emit(threadId, { type: 'plan_ready', planText, approve: wrappedApprove, reject: wrappedReject });
      },
      onCapabilitiesDiscovered: (models, agents) => {
        if (isCurrentGeneration()) this.emit(threadId, { type: 'capabilities_discovered', models, agents });
      },
      onElicitation: (request, signal) => {
        if (!isCurrentGeneration()) {
          return Promise.resolve({ action: 'cancel' } as import('@anthropic-ai/claude-agent-sdk').ElicitationResult);
        }
        return new Promise<import('@anthropic-ai/claude-agent-sdk').ElicitationResult>((resolve) => {
          this.emit(threadId, { type: 'elicitation_request', request, signal, respond: resolve });
        });
      },
      onFileUserModified: (filePath) => {
        if (!isCurrentGeneration()) return;
        if (!thread.userModifiedFiles) thread.userModifiedFiles = [];
        if (!thread.userModifiedFiles.includes(filePath)) thread.userModifiedFiles.push(filePath);
        this.emit(threadId, { type: 'file_user_modified', filePath });
      },
      onToolResultImages: (images) => {
        if (!isCurrentGeneration()) return;
        const existing = this.pendingToolResultImages.get(threadId) ?? [];
        existing.push(...images);
        this.pendingToolResultImages.set(threadId, existing);
        this.emit(threadId, { type: 'tool_result_images', images });
      },
      onTaskEvent: (event) => {
        if (!isCurrentGeneration()) return;
        this.applyTaskEvent(thread, event);
        this.emit(threadId, { type: 'tasks_updated', tasks: thread.tasks ?? [] });
      },
    };
  }

  /**
   * `ThreadSession._turnInFlight` flips to `false` immediately AFTER
   * onDone/onInterrupted/onError returns (see the `case 'result':` handler
   * in `ThreadSession.pumpMessages()` — the callback fires, THEN
   * `_turnInFlight = false` runs), so emitting `run_state_settled`
   * synchronously from inside those callbacks would race a stale `true`
   * value for `isRunning()`/`turnInFlight`. Deferring to a microtask lets
   * that flip happen first (it runs synchronously, before the pump loop's
   * `for await` can yield control back to the event loop), so listeners
   * re-checking `isRunning()` on this event always see the settled value.
   */
  private emitRunStateSettledWhenIdle(threadId: string): void {
    queueMicrotask(() => {
      debugLog('[ClaudeThreads] run state settled', threadId, 'isRunning:', this.isRunning(threadId));
      this.emit(threadId, { type: 'run_state_settled' });
      void this.processGoalContextChange(threadId);
    });
  }

  /** Merge a task-tracker event from the session into the thread's task list. */
  private applyTaskEvent(thread: Thread, event: TaskTrackerEvent): void {
    if (event.kind === 'replace') {
      thread.tasks = event.tasks.map((t, i) => ({
        id: String(i + 1),
        content: t.content,
        status: t.status,
      }));
    } else if (event.kind === 'create') {
      const tasks = (thread.tasks ??= []);
      const existing = tasks.find(t => t.id === event.id);
      if (existing) existing.content = event.content;
      else tasks.push({ id: event.id, content: event.content, status: 'pending' });
    } else {
      const tasks = (thread.tasks ??= []);
      const existing = tasks.find(t => t.id === event.id);
      if (event.status === 'deleted') {
        if (existing) thread.tasks = tasks.filter(t => t.id !== event.id);
        return;
      }
      const status =
        event.status === 'pending' || event.status === 'in_progress' || event.status === 'completed'
          ? (event.status as TaskItemStatus)
          : undefined;
      if (existing) {
        if (status) existing.status = status;
        if (event.content) existing.content = event.content;
      } else if (event.content) {
        tasks.push({ id: event.id, content: event.content, status: status ?? 'pending' });
      }
    }
    thread.updatedAt = Date.now();
  }

  /** Build the sessionOptions object from plugin settings (and thread-level overrides). */
  private buildSessionOptions(
    thread: Thread,
    agentProfiles: AgentProfileMap,
  ): NonNullable<HarnessSessionOptions['claude']>['sessionOptions'] {
    const s = this.settings;
    const opts: {
      thinking?: Options['thinking'];
      effort?: Options['effort'];
      agentProgressSummaries?: boolean;
      betas?: SdkBeta[];
      persistSession?: boolean;
      plugins?: import('@anthropic-ai/claude-agent-sdk').SdkPluginConfig[];
      agents?: Record<string, import('@anthropic-ai/claude-agent-sdk').AgentDefinition>;
    } = {};

    // Thinking mode
    if (s.thinkingMode && s.thinkingMode !== 'disabled') {
      if (s.thinkingMode === 'adaptive') {
        opts.thinking = { type: 'adaptive' };
      } else {
        opts.thinking = { type: 'enabled', budgetTokens: s.thinkingBudgetTokens ?? 8000 };
      }
    }

    // Effort level
    if (s.effort && s.effort !== 'default') {
      opts.effort = s.effort as Options['effort'];
    }

    // Agent progress summaries
    opts.agentProgressSummaries = s.agentProgressSummaries ?? true;

    // 1M context beta
    if (s.enable1MContext) {
      opts.betas = ['context-1m-2025-08-07'];
    }

    // Ephemeral session (thread-level flag)
    if (thread.ephemeral) {
      opts.persistSession = false;
    }

    // Skill plugins. Nothing is ever copied into ~/.claude/skills/ to make a
    // skill loadable — the SDK takes paths directly.
    //
    // Configured sources register one local plugin per skill directory, which
    // the SDK names `<skill>:<skill>`. The vault skills root registers once, as
    // a plugin root holding a generated `.claude-plugin/plugin.json` plus its
    // `skills/` subdir, which the SDK names `vault:<skill>`. (An earlier
    // comment here claimed plugins:{type:'local'} requires an individual skill
    // directory rather than a plugin root. That is wrong: verified against the
    // real `claude` CLI, the root form registers fine and yields better names.)
    {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require('path') as typeof import('path');
      const plugins = buildSkillPlugins({
        localSkillsRoot: this.localSkillsRoot(),
        skillSources: s.skillSources ?? [],
        pluginSkillsRoot: pluginSkillsRootFrom(this.pluginResourceDir ?? ''),
        // Bundled thread-orchestrator skill — ships inside the plugin's own
        // dist/ (copied there by esbuild.config.mjs from resources/skills/),
        // so it is discoverable in every session. Registered unconditionally,
        // not gated by any setting.
        bundledSkillPath: this.pluginResourceDir
          ? path.join(this.pluginResourceDir, 'resources', 'skills', 'thread-orchestrator')
          : undefined,
      });

      if (plugins.length > 0) opts.plugins = plugins;
    }

    // Claude retains its native agent profile support. The same already-loaded
    // map is rendered into Codex instructions by its harness adapter.
    if (Object.keys(agentProfiles).length > 0) opts.agents = agentProfiles;

    return opts;
  }

  /**
   * Returns a context usage snapshot for the active session on the given thread.
   * Returns null when no session is running or the SDK call fails.
   */
  async getContextUsage(threadId: string): Promise<import('@anthropic-ai/claude-agent-sdk').SDKControlGetContextUsageResponse | null> {
    const session = this.sessions.get(threadId);
    if (!session) return null;
    return session.getContextUsage();
  }

  /** Returns the latest cross-provider usage/quota snapshot, refreshing account activity on demand. */
  async getUsageSnapshot(threadId: string): Promise<import('./Usage').UsageSnapshot | null> {
    const thread = this.threads.get(threadId);
    if (!thread) return null;
    const session = this.sessions.get(threadId);
    if (!session) return thread.usageSnapshot ?? null;
    const usage = await session.getUsageSnapshot(true);
    if (usage) thread.usageSnapshot = usage;
    return usage ?? thread.usageSnapshot ?? null;
  }

  async interrupt(threadId: string): Promise<void> {
    // ADR-0002 §2: a single ThreadSession per thread — no more lingering-
    // session fallback needed, since the same session that's mid-turn is
    // the same session that would otherwise have "lingered."
    const session = this.sessions.get(threadId);
    if (session) {
      // AskUserQuestion blocks inside canUseTool until its answer promise
      // resolves. Release that promise before interrupting the query so the
      // question card and resolver cannot survive into later turns.
      this.pendingQuestionResolvers.get(threadId)?.({});
      await session.interrupt();
    }
  }

  subscribe(listener: ThreadStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notifyActiveThreadChanged(threadId: string): void {
    this.emit(threadId, { type: 'active_thread_changed' });
  }

  notifySummaryUpdated(threadId: string): void {
    this.emit(threadId, { type: 'summary_updated' });
  }

  /**
   * Notify listeners that a thread's pending ScheduleWakeup set changed
   * (registered, fired, or cancelled). The wake-up timers themselves live in
   * the plugin (alongside the background-task poll timers), so this is a thin
   * pass-through that lets the dashboard and chat view re-read wake-up state.
   */
  notifyWakeupChanged(threadId: string): void {
    this.emit(threadId, { type: 'wakeup_changed' });
  }

  notifyReviewedChanged(threadId: string): void {
    this.emit(threadId, { type: 'reviewed_changed' });
  }

  /** Notify listeners that a thread's orchestrator tracking notes changed. */
  notifyManagerNotesChanged(threadId: string): void {
    this.emit(threadId, { type: 'manager_notes_changed' });
  }

  /** Notify listeners that a thread's proposed reply was set or cleared. */
  notifyProposedReplyChanged(threadId: string): void {
    this.emit(threadId, { type: 'proposed_reply_changed' });
  }

  /**
   * Progress-bearing event types that count as "the thread is actually doing
   * something." Any of these resets the thread's activity heartbeat (see
   * `lastActivityAt`). `streaming_start` covers send-start, since it is emitted
   * as each turn begins. Waits (permission/plan/question) deliberately do NOT
   * appear here: parking at a prompt keeps `isRunning` true but is exactly the
   * "no progress" condition `isRunStale` exists to detect.
   */
  private static readonly ACTIVITY_EVENTS: ReadonlySet<ThreadEvent['type']> = new Set([
    'streaming_start',
    'token',
    'tool_use',
    'message',
    'task_started',
    'task_progress',
    'compact',
  ]);

  private emit(threadId: string, event: ThreadEvent): void {
    if (threadId && ThreadManager.ACTIVITY_EVENTS.has(event.type)) {
      this.lastActivityAt.set(threadId, Date.now());
    }
    for (const listener of this.listeners) {
      listener(threadId, event);
    }
  }

  /**
   * Milliseconds since this thread last emitted a progress-bearing event.
   * Returns `Infinity` when no activity has ever been recorded (a thread that
   * has never run is trivially "stale," but `isRunStale` gates on `isRunning`
   * first so that never matters in practice).
   */
  msSinceActivity(id: string): number {
    const last = this.lastActivityAt.get(id);
    return last === undefined ? Infinity : Date.now() - last;
  }

  /**
   * True when a thread is `isRunning` but has made no progress for `staleMs`
   * (default `STALE_MS`). Views use this to pause its spinner animations so a
   * thread wedged at an unanswered prompt stops compositing at 60fps forever.
   * Does NOT touch run-state: the pending answer still needs the live session,
   * and the next progress event clears staleness automatically.
   */
  isRunStale(id: string, staleMs: number = STALE_MS): boolean {
    return this.isRunning(id) && this.msSinceActivity(id) > staleMs;
  }

  /**
   * True while a thread is parked at an ExitPlanMode plan-approval prompt.
   * Plan state lives in `pendingPlanResolvers` / `thread.pendingPlan`, separate
   * from `hasPendingPermission`/`hasPendingQuestion`, so classifiers must OR
   * this in to treat a plan-parked thread as 'awaiting' rather than 'running'.
   */
  hasPendingPlan(id: string): boolean {
    return this.pendingPlanResolvers.has(id) || this.threads.get(id)?.pendingPlan !== undefined;
  }

  /**
   * Gracefully shuts down all live sessions by sending an interrupt signal
   * to each one, waiting briefly for in-flight turns to settle, then closing
   * every `ThreadSession` (idle or not) and clearing the map.
   *
   * ADR-0002 §4: under the long-lived-session model, a `sessions` entry no
   * longer self-removes when a turn finishes (unlike the old per-turn
   * `ClaudeSession`, whose `onDone`/`onInterrupted` deleted it) — the
   * `ThreadSession` stays warm, idle, for the thread's whole lifetime. So
   * "poll until the map drains" no longer signals anything: an idle session
   * would sit in the map forever and the old poll loop would spin until
   * `timeoutMs` on every shutdown. Instead, poll only until no session has a
   * turn in flight (or the deadline passes), then force `close()` on
   * everything unconditionally — a graceful shutdown always tears every
   * subprocess down; `timedOut` just reports whether interrupted turns had
   * time to settle cleanly first. This also means "how many active threads
   * exist" (not "how many have a turn in flight right now") sets the real
   * blast radius on an ungraceful reload — see ADR-0002 §4's note to
   * re-verify this budget once real concurrency is observed.
   *
   * @param timeoutMs  Maximum milliseconds to wait for in-flight turns to
   *                   settle before force-closing. Defaults to 10 000 (10s).
   */
  async gracefulShutdown(timeoutMs = 10_000): Promise<{ timedOut: boolean }> {
    for (const threadId of this.goalContextStates.keys()) this.cancelPendingGoalContext(threadId);
    if (this.sessions.size === 0) return { timedOut: false };

    const busyIds = [...this.sessions.entries()].filter(([, s]) => s.turnInFlight).map(([id]) => id);

    // Fire interrupt signals in parallel — errors are non-fatal.
    // We deliberately do NOT await these: interrupt() may not resolve until the
    // session's internal turn completes, which could take longer than our timeout.
    for (const id of busyIds) {
      this.interrupt(id).catch(() => {});
    }

    // Poll until every session has settled (no turn in flight) or we hit the deadline.
    const deadline = Date.now() + timeoutMs;
    const anyBusy = () => [...this.sessions.values()].some((s) => s.turnInFlight);
    while (anyBusy() && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }

    const timedOut = anyBusy();

    // Force-close every session regardless of whether it settled in time —
    // idle sessions never would have drained from the map on their own.
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();

    return { timedOut };
  }

  destroy(): void {
    for (const threadId of this.goalContextStates.keys()) this.cancelPendingGoalContext(threadId);
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();
    this.releasingPlanFeedback.clear();
  }
}

const HARNESS_HANDOFF_SUMMARY_LIMIT = 2400;

function createHarnessHandoff(
  thread: Thread,
  sourceHarness: 'claude' | 'codex',
  targetHarness: 'claude' | 'codex',
): NonNullable<Thread['pendingHarnessHandoff']> {
  const messageSummary = [...thread.messages].reverse().find(message => message.summary?.trim())?.summary;
  const fallback = `Continue the thread titled "${thread.title}"${thread.goal ? ` toward this goal: ${thread.goal}` : ''}.`;
  return {
    sourceHarness, targetHarness, threadId: thread.id,
    summary: (thread.summary?.trim() || messageSummary?.trim() || fallback).slice(0, HARNESS_HANDOFF_SUMMARY_LIMIT),
    noteFile: thread.noteFile, rawLogPath: thread.rawLogPath, createdAt: Date.now(),
  };
}

/** Builds the one-time provider-neutral bridge; it deliberately contains no transcript replay. */
export function buildHarnessHandoffPrompt(
  thread: Thread,
  sourceHarness: 'claude' | 'codex',
  targetHarness: 'claude' | 'codex',
): string {
  const handoff = thread.pendingHarnessHandoff ?? createHarnessHandoff(thread, sourceHarness, targetHarness);
  const references = [
    `Use threads_get_messages with thread ID ${thread.id} when exact visible history is needed.`,
    ...(handoff.rawLogPath ? [`Use threads_get_log for raw events; the persisted log path is ${handoff.rawLogPath}.`] : []),
    ...(handoff.noteFile ? [`The archived thread note is ${handoff.noteFile}.`] : []),
  ];
  return [
    `## Harness handoff (${sourceHarness} → ${targetHarness})`,
    'This is the same Agent Threads conversation, but a fresh provider-native session.',
    `Summary: ${handoff.summary.slice(0, HARNESS_HANDOFF_SUMMARY_LIMIT)}`,
    ...references,
    'Continue from the user message below. Do not claim native-session continuity.',
  ].join('\n');
}

/**
 * Builds a text preamble that summarises prior conversation turns when session
 * continuity is lost (e.g. after a working-directory change). Capped at the
 * most recent 20 messages to avoid bloating the context window.
 */
function buildHistoryPreamble(priorMessages: ChatMessage[], newCwd: string): string {
  const MAX_MESSAGES = 20;
  const messages = priorMessages.length > MAX_MESSAGES
    ? priorMessages.slice(-MAX_MESSAGES)
    : priorMessages;

  const omitted = priorMessages.length - messages.length;
  const lines: string[] = [
    `[Note: the working directory was changed to ${newCwd} and the Claude Code session could not be resumed. The prior conversation is summarised below to restore context.]`,
    '',
  ];

  if (omitted > 0) {
    lines.push(`[... ${omitted} earlier message${omitted > 1 ? 's' : ''} omitted ...]`, '');
  }

  for (const msg of messages) {
    if (msg.role === 'compact') {
      lines.push('[— context compacted here —]', '');
      continue;
    }
    // 'notice' rows are display-only UI (background-task completions) and must
    // never enter the model's context — skip them in the resume preamble.
    if (msg.role === 'notice') continue;

    const label = msg.role === 'user' ? 'User' : 'Assistant';
    const toolSuffix =
      msg.toolCalls && msg.toolCalls.length > 0
        ? ` [used: ${msg.toolCalls.map(t => t.summary).join(', ')}]`
        : '';

    lines.push(`${label}: ${msg.content}${toolSuffix}`, '');
  }

  lines.push('[End of prior context. Continue from here.]', '');

  return lines.join('\n');
}

/**
 * Builds the base system-prompt context injected into every session.
 * Tells the agent where it is running, path semantics for Obsidian vs
 * filesystem tools, and key behavioral notes about session-affecting tools.
 */
export function buildEnvironmentSystemPrompt(
  vaultRoot: string,
  cwd: string,
  vaultFolder: string,
  saveThreadsToVault: boolean,
  hostName: 'Geode' | 'Obsidian' = 'Obsidian',
): string {
  const lines = [
    `You are running inside the ${hostName} Agent Threads plugin.`,
    '',
    `Vault root (filesystem path): ${vaultRoot}`,
    `Working directory: ${cwd}`,
    '',
    'Path semantics:',
    '- vault_* tools use vault-relative paths (e.g. "Daily/2026-05-18.md")',
    '- Filesystem tools (Read, Write, Bash) use absolute paths',
  ];

  if (saveThreadsToVault) {
    lines.push(
      '',
      `Conversation history: completed threads are auto-saved as Markdown notes to "${vaultFolder}/YYYY-MM-DD-<title-slug>.md" in the vault. Use vault_search or Read to look up prior conversations.`,
    );
  }

  lines.push(
    '',
    'Tool notes:',
    '- set_working_directory takes effect on the next turn and resets session continuity. Set it before starting a task, not mid-conversation.',
    '- EnterWorktree / ExitWorktree are automatically routed to the plugin\'s MCP versions (enter_worktree / exit_worktree), which read the effective cwd set by set_working_directory.',
    '- ScheduleWakeup injects the given prompt as a new message into this thread after the delay.',
    '- host_list_commands returns all registered host commands (id + name); pass a query to filter. Call this before host_execute_command to look up the correct command ID.',
    '- host_execute_command triggers any host command by ID — useful for vault-bridge sync, git push, toggling editor modes, etc.',
    '- host_open_url opens a URL directly in the host Web Viewer panel (reuses an existing tab by default). Use this to open local dev servers, HTML files, or any web page without the user having to type the URL.',
  );

  return lines.join('\n');
}

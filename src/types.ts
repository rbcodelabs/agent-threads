import { DEFAULT_VAULT_FOLDER } from './productIdentity';

export type MessageRole = 'user' | 'assistant' | 'compact' | 'notice';

export type ThreadStatus = 'waiting' | 'active' | 'error' | 'archived' | 'reconnecting';

export type LayoutDensity = 'compact' | 'comfortable' | 'spacious';

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface ImageAttachment {
  /**
   * Inline base64 image bytes. Optional because, once the image is externalized
   * to a vault attachment file (see `path`), the base64 is dropped from the
   * serialized data.json copy to keep the file small. It stays in the live
   * in-memory object so the synchronous render and the mobile relay frame keep
   * working unchanged. Legacy data (pre-externalization) has base64 and no path.
   */
  base64?: string;
  mediaType: ImageMediaType;
  name: string;
  /**
   * Vault-relative path to the externalized image file, set once the image has
   * been written to `<vaultFolder>/attachments/<threadId>/<messageId>-<index>.<ext>`.
   * When set, the desktop render resolves it via adapter.getResourcePath();
   * mobile still uses base64 (it cannot resolve a desktop attachment path).
   */
  path?: string;
}

export interface AskQuestionOption {
  label: string;
  description: string;
}

export interface AskQuestion {
  /** Stable provider question ID. Claude questions predate this and use `question` as the answer key. */
  id?: string;
  question: string;
  header: string;
  options: AskQuestionOption[];
  multiSelect: boolean;
  /** Whether a free-form answer is available. Undefined preserves Claude's always-Other behavior. */
  allowOther?: boolean;
  /** Masks the free-form input without persisting its value. */
  isSecret?: boolean;
  /** Provider label used by the shared desktop/mobile card. */
  source?: 'claude' | 'codex';
  /** Codex tool-call item that owns this question set. */
  requestItemId?: string;
  /** Whether Codex waits indefinitely for this answer. */
  isBlocking?: boolean;
  /** Deprecated Codex auto-resolution hint, retained for persisted/relay fidelity. */
  autoResolutionMs?: number;
}

export interface ToolCallRecord {
  name: string;
  summary: string;
  timestamp?: number;
  /** tool_use block id from the SDK, used to correlate tool_progress heartbeats. */
  toolUseId?: string;
  /** Lifecycle state derived from the matching tool_result. Undefined until the result arrives. */
  status?: 'pending' | 'success' | 'error';
  /** Wall-clock time between the tool_use and its tool_result, in milliseconds. */
  durationMs?: number;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  toolCalls?: ToolCallRecord[];
  cost?: number;
  compactTrigger?: 'auto' | 'manual';
  preTokens?: number;
  /** Images attached to this message (user role only). Stored as base64 for display. */
  images?: ImageAttachment[];
  /** AI-generated 1-sentence summary used in compressed view. */
  summary?: string;
  /**
   * Images returned by tool results during this turn (e.g. Read on a PNG).
   * `data` is optional for the same reason as ImageAttachment.base64: it is
   * dropped from the serialized data.json copy once the image is externalized
   * to `path`, but kept in the live object for render/relay.
   */
  toolResultImages?: Array<{ mediaType: string; data?: string; path?: string }>;
  /** For role 'notice': the completion status of the background task, drives the icon. */
  noticeStatus?: 'completed' | 'failed' | 'stopped';
}

export interface ThreadDraft {
  text: string;
  attachment: string | null;
  images: ImageAttachment[];
}

/**
 * A background task started during a session (Bash with run_in_background: true)
 * that hasn't received a completion notification yet.
 */
export interface PendingBackgroundTask {
  taskId: string;
  description: string;
  /** Epoch ms when the task was started. */
  startedAt: number;
  /** Number of times the plugin has polled for this task's status. */
  pollCount: number;
}

export type AgentRunStatus = 'starting' | 'working' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'unavailable';

export interface AgentCapabilities {
  viewTranscript: boolean;
  sendMessage: boolean;
  interrupt: boolean;
}

export interface AgentRunEvent {
  kind: 'lifecycle' | 'activity' | 'tool' | 'result' | 'error' | 'control';
  text: string;
  timestamp: number;
  nativeEventId?: string;
  toolName?: string;
}

/** Durable projection of a harness-native child agent. It is not a Thread. */
export interface AgentRun {
  id: string;
  threadId: string;
  nativeAgentId: string;
  parentAgentRunId?: string;
  /** Retained until a late parent-start event resolves parentAgentRunId. */
  parentNativeAgentId?: string;
  taskId?: string;
  harness: 'claude' | 'codex';
  role?: string;
  description: string;
  model?: string;
  status: AgentRunStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  currentActivity?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  capabilities: AgentCapabilities;
  events: AgentRunEvent[];
  resultSummary?: string;
  error?: string;
}

export type TaskItemStatus = 'pending' | 'in_progress' | 'completed';

/**
 * One entry in Claude Code's task list. Populated from TodoWrite (older CLIs,
 * full-list replace) or TaskCreate/TaskUpdate (newer CLIs, incremental).
 */
export interface TaskItem {
  id: string;
  content: string;
  status: TaskItemStatus;
}

/**
 * One pill in a thread's status-line footer, produced by the configured
 * statusLineCommand. Scripts may emit these as a JSON array; legacy plaintext
 * output is normalized into the same shape (see src/statusLine.ts).
 */
export interface StatusTag {
  /** Required display text, e.g. "PR #42", "main", "AWS ok". */
  label: string;
  /** If set, the pill is a link (opened via electron shell.openExternal). */
  url?: string;
  /** Lucide icon name. If omitted, derived from `kind` at render time. */
  icon?: string;
  /** Visual tone. Defaults to 'normal'. */
  tone?: 'normal' | 'warn' | 'error';
  /**
   * Semantic category. 'pr' drives prUrl derivation and the leading PR pill.
   * Open-ended so scripts can introduce new kinds without a plugin change.
   */
  kind?: 'pr' | 'branch' | 'dev' | 'aws' | string;
}

/**
 * Native git plumbing info for a thread's working directory, populated by
 * GitDiffService (local `git` only — no `gh`, no network). Powers the git
 * diff bar + Create PR button shown above the compose box in ThreadsView.
 */
export interface GitDiffInfo {
  /** Whether the thread's cwd is inside a git working tree at all. */
  isGitRepo: boolean;
  /** Current branch name. Undefined for detached HEAD or when `isGitRepo` is false. */
  branch?: string;
  /** Repo's default/base branch (e.g. "main"), best-effort detected. */
  baseBranch?: string;
  /** True when `branch === baseBranch` — nothing to open a PR against, bar is hidden. */
  isBaseBranch?: boolean;
  /** Lines added between `baseBranch` and the current working tree (incl. uncommitted). */
  insertions?: number;
  /** Lines removed between `baseBranch` and the current working tree (incl. uncommitted). */
  deletions?: number;
  /** Parsed from `git remote get-url origin` when it points at GitHub; used to build the "Manually create PR" compare URL. */
  ownerRepo?: { owner: string; repo: string };
}

export interface Thread {
  id: string;
  sessionId?: string;
  /** Harness that owns this thread's persisted session ID. Kept per-thread so
   * switching the default never attempts to resume a Claude session in Codex. */
  agentHarness?: 'claude' | 'codex';
  /** Latest provider usage/quota snapshot; replaces older samples rather than building history. */
  usageSnapshot?: import('./Usage').UsageSnapshot;
  title: string;
  cwd: string;
  /**
   * Absolute path to the origin repo's git root, set when `cwd` is a worktree
   * created by `enter_worktree` (captured at creation time via `git rev-parse
   * --show-toplevel` on the repo the worktree was cut from). Persisted so the
   * project name for Kanban grouping and `repairStaleCwds()`'s repair target
   * both survive the worktree directory itself being deleted later (by
   * `exit_worktree`, an external `git worktree remove`/prune, or the
   * worktree-cleanup skill) — see `resolveThreadProjectName()` in pathUtils.ts.
   * Cleared when `exit_worktree` restores the thread to the origin repo cwd.
   */
  originRepoPath?: string;
  /**
   * Display-only project name override for legacy threads whose worktree cwd
   * was already gone (and `originRepoPath` was never captured) before this
   * field existed. Populated once by `ThreadManager.backfillLegacyProjectNames()`
   * from the thread's `prUrl` (`github.com/<owner>/<repo>/pull/<n>`) when no
   * other way remains to resolve a project name. Never used to derive a real
   * filesystem path — purely a label of last resort in `resolveThreadProjectName()`.
   */
  projectNameOverride?: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  noteFile?: string;
  /**
   * Vault-relative path to the raw JSONL conversation log for this thread
   * (e.g. "Claude/logs/<thread_id>.jsonl"). Append-only record of every raw
   * SDK event (tool calls with inputs, tool results, assistant messages,
   * usage/cost, system events) so agents can retrieve and analyze the full
   * transcript. Linked from the markdown note's `raw_log` frontmatter.
   */
  rawLogPath?: string;
  recap?: string;
  summary?: string;
  lastError?: string;
  /**
   * Auto-retry budget tracker for the closed-source CLI's spurious
   * "Stream closed" transport errors (see transportErrorRecovery.ts).
   * Reset to 0 on a successful onDone; incremented on each auto-retry.
   *
   * TODO(ADR-0002 Stage 2 gap fix): as of ThreadSession, the retry decision
   * is gated entirely by `ThreadSession.transportErrorRetryCount` (private,
   * in-memory, resets on every `start()`/successful `result` — see
   * ThreadSession.ts). Grepping src/ turns up only two write sites for this
   * field (both in ThreadManager.ts, both `= 0` resets in onDone/onError)
   * and zero reads anywhere — it looks fully vestigial post-Stage-C, but
   * this wasn't the stage for aggressive cleanup, so it's left in place
   * (and still persisted to disk via VaultPersistence) pending confirmation
   * it's truly safe to delete.
   */
  streamCloseRetryCount?: number;
  /**
   * Auto-retry budget tracker for API rate-limit / overload errors (see
   * rateLimitRecovery.ts). Reset to 0 on a successful onDone; incremented
   * on each auto-retry.
   */
  rateLimitRetryCount?: number;
  model?: string;
  projectId?: string;
  /** Stable producer identity for peer-plugin jobs; absent for user-authored threads. */
  origin?: string;
  externalJobId?: string;
  background?: boolean;
  reviewed?: boolean;
  /** Paths of files written or edited during this thread's lifetime. */
  editedFiles?: string[];
  /** Durable local design artifacts created from this thread. Source files remain canonical. */
  artifacts?: DesignArtifact[];
  /** Subset of editedFiles where the user modified the proposed content in the permission dialog. */
  userModifiedFiles?: string[];
  /** Unsent draft message and attachments for this thread. */
  draft?: ThreadDraft;
  /**
   * An AI-proposed reply awaiting Rick's approval — distinct from `draft`
   * (his own unsent compose-box text). Set by the thread-orchestrator skill
   * via `obsidian_set_thread_proposed_reply`, rendered as a banner in
   * ThreadsView with Approve & Send / Edit / Discard actions. Nothing ever
   * sends this automatically — only a human clicking Approve & Send does.
   */
  proposedReply?: { text: string; generatedAt: number; sourceThreadId?: string };
  /**
   * Free-form tracking notes written by the thread-orchestrator skill about
   * this thread (inferred goal, status, last-reviewed cursor). Visible in the
   * UI but intentionally EXCLUDED from `appendSystemPrompt` in
   * ThreadManager.ts — unlike `goal` below, this must never be injected into
   * the underlying Claude session's context.
   */
  managerNotes?: string;
  /** Thread that last wrote managerNotes. Missing on legacy persisted notes. */
  managerNotesSourceThreadId?: string;
  /** Epoch milliseconds when managerNotes was last updated. */
  managerNotesUpdatedAt?: number;
  /** Current lifecycle status of the thread. */
  status?: ThreadStatus;
  /**
   * URL of the GitHub PR associated with this thread (e.g. https://github.com/owner/repo/pull/42).
   * DERIVED from `statusTags` by StatusLineService (a tag with kind:'pr' or a /pull/N url).
   * Sticky: only overwritten when a poll yields a PR tag, never cleared on absence, so the
   * release archive-on-merge workflow can still match a thread after its PR merges.
   *
   * THREAD-SCOPED HISTORY, NOT BRANCH STATE. Because it is never cleared, it
   * outlives both the branch it came from and — when a thread is moved with
   * `set_working_directory` — the repository itself. Do NOT use it to label
   * branch-scoped UI (that's what the live kind:'pr' tag in `statusTags` is
   * for, since the status-line script derives it per-branch on every poll).
   * See `renderGitDiffBar` and `prUrlMatchesRepo` in gitDiffUtils.ts.
   */
  prUrl?: string;
  /**
   * ID of the scheduled item (cron) whose fire() created this thread, if any.
   * Set once at creation time and never cleared. Undefined for threads created
   * any other way (manual, dispatched, etc).
   */
  scheduledItemId?: string;
  /**
   * Name of the scheduled item at the time this thread was created, captured
   * alongside `scheduledItemId` for display (e.g. the "Scheduled: <name>" footer pill).
   * Not kept in sync with later renames of the scheduled item.
   */
  scheduledItemName?: string;
  /**
   * Status-line pills for this thread, populated by StatusLineService from the
   * configured statusLineCommand. Ephemeral — never persisted to data.json,
   * re-derived on the next poll. Undefined on mobile / when no script is set.
   */
  statusTags?: StatusTag[];
  /**
   * Native git plumbing info (branch/base/diff-stat) for this thread's cwd,
   * populated by GitDiffService. Ephemeral — never persisted to data.json,
   * re-derived on the next poll. Undefined on mobile / non-git cwds.
   */
  gitDiff?: GitDiffInfo;
  /** Timestamp (ms epoch) of the last summarize call. Used by incremental summarization to identify messages added since the prior summary. */
  lastSummarizedAt?: number;
  /**
   * Set to true when the user has explicitly renamed this thread via the rename UI.
   * Prevents the auto-summarizer from overwriting a user-chosen title.
   * Threads that were never manually renamed (including those auto-titled from the
   * dispatch input's first message) leave this undefined/false so auto-title applies.
   */
  titleUserSet?: boolean;
  /**
   * Background tasks (Bash run_in_background: true) that started during a session
   * but didn't emit a task_notification before the stream ended. The plugin polls
   * these automatically and clears them when completions arrive.
   */
  pendingBackgroundTasks?: PendingBackgroundTask[];
  /** Persisted native-agent workspace projection. */
  agentRuns?: AgentRun[];
  /**
   * Persistent goal set via the /goal command. Injected into the session's
   * appended system prompt on every turn until cleared with /goal clear.
   */
  goal?: string;
  /** Claude Code task list (TodoWrite / TaskCreate+TaskUpdate), rendered as a checklist card. */
  tasks?: TaskItem[];
  /**
   * When true, this thread is ephemeral: sessions are not persisted to disk
   * and the thread note is not saved to the vault.
   */
  ephemeral?: boolean;
  /**
   * Per-thread permission mode override. When set, takes precedence over the
   * global settings.permissionMode for sessions in this thread.
   */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
  /**
   * Plan text from a pending ExitPlanMode call that hasn't been approved or
   * rejected yet. Persisted so the plan card can be restored after a reload
   * or crash that killed the session mid-turn.
   */
  pendingPlan?: string;
  /**
   * Questions from a pending AskUserQuestion call that hasn't been answered
   * yet. Persisted so the question card can be restored after a reload or
   * crash that killed the session mid-turn, exactly like `pendingPlan`.
   */
  pendingQuestions?: AskQuestion[];
}

export interface DesignArtifact {
  id: string;
  kind: 'design-static';
  title: string;
  /** Absolute local artifact directory containing artifact.json. */
  root: string;
  manifestPath: string;
  entryPath: string;
  createdAt: number;
  updatedAt: number;
  lastCapturePath?: string;
}

/**
 * A Project groups related threads and chooses their initial working context.
 * It is not a security or filesystem-isolation boundary: vault tools, MCP
 * server/skill *registration*, and unscoped secrets remain global regardless
 * of Project. The one exception is secret *values* — see
 * `PluginSettings.secretEnvScopes` — which can optionally be restricted to a
 * set of Project ids. Absent that opt-in, a secret is still resolved for
 * every Project (and for project-less threads/scheduled items) exactly as
 * before.
 */
export interface Project {
  id: string;
  name: string;
  description?: string;
  /** Vault-relative folder path (e.g. "Claude/my-project" or "Work/Acme"). */
  vaultFolder: string;
  /**
   * Optional explicit filesystem cwd override. When absent the plugin derives
   * the cwd automatically from vaultFolder + vault root.
   */
  cwdOverride?: string;
  /** Project-scoped orchestrator. The settings-level id remains the portfolio orchestrator. */
  orchestratorThreadId?: string;
  /** False after the Project orchestrator is intentionally archived. */
  orchestratorEnabled: boolean;
  createdAt: number;
}

export type ScheduleType = 'interval' | 'daily' | 'weekly' | 'once';

export interface ScheduledItemSchedule {
  type: ScheduleType;
  /** For 'interval': seconds between runs (e.g. 3600 = hourly) */
  intervalSeconds?: number;
  /** For 'daily' and 'weekly': 24h time string e.g. "09:00" */
  timeOfDay?: string;
  /** For 'weekly': array of day numbers 0=Sun...6=Sat */
  daysOfWeek?: number[];
  /**
   * For 'once': absolute epoch ms at which to fire exactly one time. The item
   * is deleted after firing (see Scheduler.fire()) rather than rearmed.
   */
  fireAt?: number;
  /**
   * Optional local time-of-day window (24h "HH:MM") during which this item
   * is allowed to actually fire. Applies on top of any schedule type — most
   * useful for 'interval' (e.g. "every 6h, but only 07:00-22:00"). When a
   * cycle comes due outside [start, end), Scheduler.fire() skips it entirely
   * — no thread is created, no message is sent — and jumps `nextRun` straight
   * to the next window-open time instead of following the schedule's normal
   * math. This replaces the need to encode a business-hours check into the
   * prompt itself (which wastes a thread/turn every time it fires outside
   * the window just to check and bail).
   *
   * Supports overnight windows where start > end (e.g. "22:00"-"06:00") by
   * wrapping past midnight. A zero-width window (start === end) is treated
   * as unrestricted rather than "never fires".
   */
  activeHours?: { start: string; end: string };
}

export interface ScheduledItem {
  id: string;
  name: string;
  prompt: string;
  schedule: ScheduledItemSchedule;
  enabled: boolean;
  /** Optional cwd override. Otherwise resolves from Project, then plugin default. */
  cwd?: string;
  /** Optional project ID for new threads */
  projectId?: string;
  /** Epoch ms of the last successful run */
  lastRun?: number;
  /** Epoch ms of the next scheduled run */
  nextRun?: number;
  /** Thread ID of the most recent run */
  lastThreadId?: string;
  /**
   * When set, fire the prompt into this existing thread instead of creating a
   * new one (used by the /loop command). Falls back to creating a new thread
   * if the target thread no longer exists.
   */
  targetThreadId?: string;
  /**
   * Marks this item as created by the ScheduleWakeup tool rather than the
   * user-facing Cron tools/dashboard. Lets ClaudeThreadsPlugin.getPendingWakeups/
   * hasPendingWakeup/cancelWakeups find these durable one-shot items without a
   * separate in-memory tracking structure. Absent for ordinary cron items.
   */
  origin?: 'wakeup';
  /**
   * Marks this item as the orchestrator's own heartbeat backstop (created by
   * ensureOrchestratorThread()) so it can be found and cleaned up reliably
   * when the orchestrator thread is recreated, and so Scheduler.fire() can
   * special-case it: if its targetThreadId no longer resolves, skip creating
   * a stray replacement thread rather than falling back to the generic
   * new-thread behavior other targetThreadId items use.
   */
  isOrchestratorHeartbeat?: boolean;
  /**
   * Optional deterministic pre-check run before firing (see Scheduler.fire()).
   * A shell command evaluated at fire time: exit 0 means "fire the agent",
   * exit 75 means the gate could not determine whether work exists, and other
   * clean non-zero exits mean "nothing to do, skip this cycle" (matching the
   * convention of `test -s file` / `grep -q`). On a fire, the gate's
   * stdout is interpolated into the prompt so the agent doesn't have to
   * re-derive what changed. Runs at fire time regardless of schedule type, so
   * it lives at the top level rather than on `schedule`.
   */
  gate?: {
    /** Shell command; exit 0 = fire, exit 75 = indeterminate, other non-zero = skip. */
    command: string;
    /** Max seconds the gate may run before it's killed. Defaults to 30. */
    timeoutSeconds?: number;
    /**
     * When the gate cannot be evaluated (exit 75, timeout, or a spawn failure
     * such as command-not-found), whether to fire anyway. Defaults to true so a
     * broken check never silently blackholes a real cron. Other clean non-zero
     * exits are deliberate skips regardless of this flag.
     */
    failOpen?: boolean;
  };
  /**
   * Observability written by Scheduler.fire() and surfaced in CronList. Records
   * why the most recent due cycle was skipped, if it was: 'gate' (the gate
   * command returned a clean non-zero exit), 'active-hours' (the cycle came
   * due outside the configured window), or 'busy' (the previous run of this
   * item was still in flight, so the cycle was dropped rather than stacked).
   */
  lastSkipReason?: 'gate' | 'active-hours' | 'busy';
  /** Exit code of the most recent gate evaluation (0 on a fire, non-zero on a gated skip). */
  lastGateExitCode?: number;
  /** Bounded, sanitized detail when the most recent gate was indeterminate, timed out, or failed to spawn. */
  lastGateError?: string;
  /**
   * Bounded ring buffer of recent cycle outcomes (oldest first, most recent
   * last), written by Scheduler.fire() on every completed cycle — a fire, a
   * gate skip, an active-hours skip, or an error. Unlike the `last*` fields
   * above (which only reflect the single most recent cycle), this gives a
   * durable run history so the Settings view can show whether a gated job has
   * been firing or skipping over time. Capped at RUN_HISTORY_MAX entries; older
   * events are dropped. Absent until the item has fired at least once.
   */
  runHistory?: RunEvent[];
  /** Internal durable mutation revision. Never exposed by CronList. */
  _scheduleRevision?: number;
  /** Internal owner token for the currently claimed occurrence. */
  _scheduleClaimToken?: string;
  /** Internal canonical due time associated with the current claim. */
  _scheduleClaimDueAt?: number;
  /** Internal revision that must still be current before external dispatch. */
  _scheduleClaimRevision?: number;
}

/**
 * A single entry in a ScheduledItem's run history — one completed scheduler
 * cycle. Written by Scheduler.fire(). Kept intentionally small since many of
 * these are persisted per item.
 */
export interface RunEvent {
  /** Epoch ms at which the cycle was evaluated. */
  ts: number;
  /**
   * What happened on this cycle:
   * - 'fired'                 → a thread was created or reused and the prompt sent
   * - 'skipped-gate'          → the gate deliberately skipped, or an indeterminate gate failed closed
   * - 'skipped-active-hours'  → the cycle came due outside the active-hours window
   * - 'skipped-busy'          → the item's previous run was still in flight (overlap guard)
   * - 'error'                 → thread creation / send threw (see `note`)
   */
  outcome: 'fired' | 'skipped-gate' | 'skipped-active-hours' | 'skipped-busy' | 'error';
  /**
   * For 'fired': the thread the prompt was sent to (absent for a stale
   * heartbeat). For 'skipped-busy': the still-running thread from the previous
   * cycle that caused this one to be dropped.
   */
  threadId?: string;
  /** Gate exit code when relevant, including exit 75 on an indeterminate evaluation. */
  gateExitCode?: number;
  /**
   * Optional short human-readable detail — an error message for 'error', or a
   * "fired open despite a gate error" note when a gate could not be evaluated
   * but failOpen let the cycle fire anyway.
   */
  note?: string;
}

/**
 * A single vault document watch: alerts the owning thread whenever the
 * document's content changes. Ownership is per-thread — two threads can
 * independently watch the same path with no dedup/merge, and only the
 * owning thread is alerted.
 */
export interface WatchedDocument {
  id: string;
  /** Vault-relative path; kept in sync on rename. */
  path: string;
  /** Thread ID that created this watch and receives its alerts. */
  threadId: string;
  enabled: boolean;
  createdAt: number;
  /**
   * `${mtimeMs}:${size}` stamp captured when the watch is (re)primed, e.g. at
   * creation time — the same cheap "did content change" pattern used by
   * `loadFragment` in `src/visualizeRenderer.ts`. Comparing against this on
   * every `modify` event is what keeps watching itself from counting as a
   * change, and keeps a resave-with-no-actual-diff from re-alerting.
   */
  lastStamp?: string;
  /** Epoch ms of the most recent alert sent for this watch. */
  lastAlertedAt?: number;
}

/**
 * A configured skill source.
 *
 * Two ways one comes into existence, and the difference matters for `id` and
 * `clonePath`:
 * - **Added through the UI** — `id` is a `crypto.randomUUID()` and `clonePath` is
 *   filled in at clone time.
 * - **Declared** in a committed `data.json` — `type` + `repoUrl` are enough. Both
 *   `id` (derived deterministically from `repoUrl`) and `clonePath` (machine
 *   specific, so never committable) are resolved and cloned on load by
 *   `ensureGithubSourcesCloned`, then persisted back.
 */
export interface SkillSource {
  /**
   * Stable ID. `crypto.randomUUID()` for a source added through the UI; for a
   * declared source arriving without one, derived deterministically from
   * `repoUrl` so the same config resolves to the same id on every machine.
   */
  id: string;
  /** Human-readable label, e.g. "Agentic PM Playbook" */
  name: string;
  /** 'github' = managed clone at <vault>/<plugin-dir>/skill-sources/<id>; 'local' = user-provided path */
  type: 'github' | 'local';
  // ── github type fields ──────────────────────────────────────────────────────
  /** GitHub repo URL, e.g. "https://github.com/owner/repo" */
  repoUrl?: string;
  /**
   * Absolute path to the managed clone, e.g.
   * "/Users/foo/MyVault/.obsidian/plugins/claude-threads/skill-sources/<id>".
   * Omit it in a declared source — it is computed from the plugin dir and `id`.
   */
  clonePath?: string;
  /** ms epoch of the last git fetch (for staleness display) */
  lastFetched?: number;
  /** Commits behind remote (0 = up to date, undefined = not yet fetched) */
  behindCount?: number;
  // ── local type fields (legacy) ───────────────────────────────────────────────
  /** Absolute path (may use ~) to the directory containing skill subdirectories */
  skillsPath?: string;
  /** Optional: path to the git repo root, enables "Pull Updates" button */
  repoPath?: string;
}

export interface RemoteAccessSettings {
  enabled: boolean;
  /** 32-char hex string generated on first enable. Empty string when not yet generated. */
  roomId: string;
  relayUrl: string;
  /** Non-null only while actively pairing (the pairing code is the formatted roomId). */
  pairingCode: string | null;
  /** ms epoch at which the pairing code expires. */
  pairingExpiresAt: number | null;
}

/**
 * Which account/backend the Claude Code CLI authenticates against.
 * - 'claude': the CLI's own login (Claude.ai/Console subscription or ANTHROPIC_API_KEY)
 * - 'bedrock': Amazon Bedrock — sets CLAUDE_CODE_USE_BEDROCK=1 on every session;
 *   AWS credentials come from extra env vars (e.g. AWS_PROFILE + AWS_REGION)
 */
export type ProviderMode = 'claude' | 'bedrock';

/**
 * One external MCP server as stored in `PluginSettings.mcpServers`.
 *
 * Stored UNRESOLVED: string fields may contain `${VAR_NAME}` placeholders that
 * are expanded at session start against the secrets named in `secretEnvKeys`
 * (plus `process.env`). Secret values themselves are never stored here — see
 * `mcpServerStore.resolveMcpServers`.
 *
 * There is no `sdk` variant on purpose: an SDK-type server needs a live
 * in-process `McpServer` instance, which cannot be serialized into data.json
 * or handed to the Codex app-server.
 */
export type StoredMcpServer =
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      type: 'http' | 'sse';
      url: string;
      headers?: Record<string, string>;
    };

/**
 * Runtime status for one registered `oauth`-type MCP server (see
 * `mcpServerStore.mcpRegistrationSchema`'s `oauth` variant). Not yet persisted
 * anywhere — this is the shape a future `PluginSettings.oauthMcpState` map (or
 * equivalent) will use once thread lifecycle wiring lands; see
 * `mcpServerStore.resolveMcpServers` for why `oauth` isn't resolved yet.
 *
 * Tokens are **never** stored on this interface or anywhere in data.json —
 * only in the OS keychain via `OAuthTokenStore`. This only tracks enough to
 * render connection status and drive proxy/refresh lifecycle without ever
 * touching a secret value.
 */
/**
 * Config for one `oauth`-type MCP server (see `mcpServerStore.mcpRegistrationSchema`'s
 * oauth variant). Tokens live only in the OS keychain — see `OAuthMcpState` / `OAuthTokenStore`.
 */
export interface StoredOAuthMcpServer {
  url: string;
  scopes?: string;
  tools?: { allow?: string[]; deny?: string[] };
  clientId?: string;
  authorizationServerUrl?: string;
  redirectUri?: string;
}

export interface OAuthMcpState {
  serverName: string;
  /** DCR-issued client_id, or the user-provided `clientId` override. */
  clientId: string;
  /** Resolved authorization server URL from discovery, cached to skip re-discovery. */
  asMetadataUrl: string;
  /** Local proxy port, assigned when the proxy starts. */
  proxyPort: number;
  status: 'connected' | 'needs-auth' | 'expired' | 'error';
  errorMessage?: string;
  /** Access token expiry, ms epoch. Only the timestamp is kept here — never the token. */
  accessTokenExpiresAt?: number;
  hasRefreshToken: boolean;
  revocationEndpoint?: string;
  tokenEndpoint: string;
}

export interface PluginSettings {
  claudeBinaryPath: string;
  /** Which local coding-agent harness new threads use. */
  agentHarness: 'claude' | 'codex';
  /** Path to the Codex CLI executable (the app-server is launched from it). */
  codexBinaryPath: string;
  /**
   * Root directory for worktrees created by `enter_worktree`.
   *
   * Blank uses the default `~/.geode/worktrees`. Must be durable storage: an
   * earlier version created worktrees under `os.tmpdir()`, which macOS clears
   * on reboot — silently destroying any uncommitted work inside them.
   */
  worktreeRoot: string;
  defaultCwd: string;
  saveThreadsToVault: boolean;
  /**
   * When true, every thread's raw SDK event stream is appended to a JSONL log
   * at `<vaultFolder>/logs/<thread_id>.jsonl` and linked from the markdown
   * note's `raw_log` frontmatter. Independent of saveThreadsToVault so you can
   * keep raw logs without markdown notes, or vice versa. Defaults to true.
   */
  saveRawLogs: boolean;
  vaultFolder: string;
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
  /** Thinking mode for extended reasoning. 'disabled' sends no thinking param; 'adaptive' lets Claude decide; 'enabled' uses a fixed token budget. */
  thinkingMode: 'disabled' | 'adaptive' | 'enabled';
  /** Token budget for thinking when thinkingMode is 'enabled'. */
  thinkingBudgetTokens: number;
  /** Effort level passed to query(). 'default' omits the param. */
  effort: 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Codex reasoning effort. Ultra enables proactive native multi-agent behavior on supported models. */
  codexEffort: 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  /** When true, subagents emit AI-generated progress summaries every ~30s. */
  agentProgressSummaries: boolean;
  /** When true, passes the context-1m-2025-08-07 beta header for 1M context window. */
  enable1MContext: boolean;
  extraEnv: string;
  /** Account/backend the Claude CLI authenticates against. Defaults to 'claude'. */
  provider: ProviderMode;
  /**
   * Model alias applied to threads that have no per-thread override
   * (set via /model). Empty string = let the CLI use its own default.
   * Accepts the same aliases as /model: fable, opus, sonnet, haiku.
   */
  defaultModel: string;
  summarizationEnabled: boolean;
  inprocessModel: string;
  autoSummarize: boolean;
  /** When the escalation keyword appears in a message, route that turn to escalationModel. */
  escalationEnabled: boolean;
  /** Keyword that triggers escalation for a single turn (stripped before sending). */
  escalationKeyword: string;
  /** Model alias the escalation keyword routes to (fable, opus, sonnet, haiku). */
  escalationModel: string;
  alwaysAllowedTools: string[];
  disallowedTools: string[];
  threads: Thread[];
  projects: Project[];
  wakeLockEnabled: boolean;
  layoutDensity: LayoutDensity;
  /** Primary grouping shown in the Agents List. Missing values use project-status. */
  agentsGroupBy?: 'project' | 'status' | 'project-status';
  /**
   * Shell command for the context footer bar. Receives JSON on stdin with
   * {cwd, workspace:{current_dir}, branch} describing the thread. stdout may be
   * a JSON array of status tags (see StatusTag) or legacy plaintext (segments
   * split on 2+ spaces). Rendered as pills below the input area. Empty disables
   * it. Run per-thread by StatusLineService (desktop only).
   */
  statusLineCommand: string;
  /** How often (ms) StatusLineService polls the statusLineCommand per thread cwd. Default 30000. */
  statusLineIntervalMs?: number;
  /** Message sent directly to the active agent by the Create PR action. */
  createPrMessage: string;
  /** Message sent directly to the active agent by the Create draft PR action. */
  createDraftPrMessage: string;
  remoteAccess: RemoteAccessSettings;
  /** When true, verbose operational logs (stream events, session lifecycle, relay connections) are emitted to the console. Off by default to keep long sessions clean. */
  debugLogging: boolean;
  /**
   * When true (default), the always-on local telemetry layer records counters and
   * renderer performance samples used by the "Generate diagnostics report" command.
   * Local-only — nothing ever leaves the machine. Turning it off disables the
   * sampler and stops counter bumps. Desktop-only; a no-op on mobile.
   */
  telemetryEnabled: boolean;
  /** Where the desktop conversation view lives. Classic preserves the sidebar layout. */
  threadViewPlacement: 'classic' | 'conversation-first';
  /** Last selected desktop thread, used when a host does not persist ItemView state changes. */
  activeThreadId?: string;
  /** Opaque plugin-owned marker for the live conversation companion. Never contains native view state. */
  conversationCompanionMarker?: string;
  /** Set to true after the first-run onboarding flow has completed. Prevents the welcome guide and panel auto-layout from triggering on subsequent loads. */
  hasSeenWelcome: boolean;
  /**
   * Hotkey for push-to-talk recording. Serialized as e.g. "Alt+Space" or "Control+Shift+Space".
   * Empty string disables PTT. Default: "Alt+Space" (Option+Space on Mac).
   */
  pttKey: string;
  /** OpenAI API key used for Whisper speech-to-text. Stored in data.json (device-local). */
  openAIKey: string;
  /**
   * List of environment variable names whose values are stored securely in the OS
   * keychain via app.secretStorage under the key `ct-secret-<varName>`. Only the
   * names are persisted here — values never appear in data.json.
   */
  secretEnvKeys: string[];
  /**
   * Optional per-secret Project scoping, keyed by env var name (matching
   * `secretEnvKeys` entries). The value is the list of Project ids the secret
   * is allowed to be injected into.
   *
   * An absent key, or an empty array, means global — identical to the
   * pre-scoping behavior, and the default for every existing secret so no
   * data.json migration is needed. A non-empty list restricts the secret's
   * *value* to threads/scheduled items whose `projectId` is in that list. A
   * thread or scheduled item with no `projectId` at all only ever receives
   * global secrets, never a project-scoped one — see
   * `secretUtils.isSecretVisibleToProject`.
   *
   * MCP servers and skills are unaffected by this: they stay registered
   * globally regardless of Project. Only whether a scoped secret's value
   * resolves (e.g. to fill an MCP server's `${VAR}` placeholder, or to
   * populate session/gate env) is gated by this map.
   */
  secretEnvScopes?: Record<string, string[]>;
  /**
   * External MCP servers injected into every new thread, on both the Claude and
   * Codex harnesses. Keyed by server name.
   *
   * This plugin owns this data. It deliberately does NOT live in
   * `~/.claude/settings.json`: that file belongs to Claude Code, its schema has
   * no top-level `mcpServers` property (see the SDK's `Settings` interface), and
   * nothing — not the CLI, not the SDK — ever read what we wrote there. Storing
   * it here also keeps the server definitions and the `secretEnvKeys` registry
   * that resolves their `${VAR}` placeholders in one file instead of two.
   */
  mcpServers: Record<string, StoredMcpServer>;
  /**
   * `oauth`-type MCP servers registered via the `mcp_register_server` tool's
   * async consent flow (see `OAuthMcpRegistry.registerServer`). Keyed by
   * server name, same key space as `mcpServers` (name collisions are rejected
   * at registration). Nonsecret config only — access/refresh tokens and the
   * DCR-issued client_id live in the OS keychain, never here.
   */
  oauthMcpServers: Record<string, StoredOAuthMcpServer>;
  /** Runtime connection status for each `oauthMcpServers` entry, keyed the same way. */
  oauthMcpState: Record<string, OAuthMcpState>;
  /** Opt-in Google-provided MCP toolsets, authenticated by Google Docs Sync. */
  googleWorkspaceMcp?: Partial<Record<'docs' | 'drive' | 'sheets' | 'slides', boolean>>;
  /** Nonsecret identity/service pinning; local bearer capabilities are never persisted. */
  googleWorkspaceBindings?: Record<string, import('./GoogleWorkspaceMcp').GoogleWorkspaceBinding>;
  /**
   * Set to true after the orphaned-note archive scan has run at least once with
   * nothing left to clean up. Prevents a full vault file-read scan on every startup
   * once the one-time migration for pre-archive-on-close thread notes is complete.
   * Reset to false whenever crash recovery restores threads from vault notes.
   */
  orphanArchiveScanComplete?: boolean;
  /**
   * Set to true after the one-time image-externalization backfill has run and
   * shrunk data.json. The backfill walks every message image still stored as
   * inline base64, writes it to a vault attachment file, and records its `path`
   * so the serialize step can drop the base64. Idempotent and desktop-only;
   * gates the walk so it doesn't re-run on every startup once complete.
   */
  imageExternalizationComplete?: boolean;
  /**
   * Number of days a `waiting` thread must sit idle (no `updatedAt` change)
   * before the periodic sweep auto-archives it: writes it to its markdown note
   * (images embedded) and evicts it from the live thread list so data.json stops
   * growing without bound. Only `waiting` threads qualify. `active`, `reconnecting`,
   * `error`, the orchestrator thread, and any thread with a pending plan/question
   * are never swept. `0` disables the sweep entirely. Defaults to 14.
   */
  autoArchiveIdleDays?: number;
  /** Recurring scheduled tasks that fire prompts into new threads. */
  scheduledItems: ScheduledItem[];
  /** Vault documents being watched for content changes, each owned by a thread. */
  watchedDocuments: WatchedDocument[];
  /**
   * ID of the persistent thread running the bundled thread-orchestrator skill,
   * created by the "Agent Threads: Open Thread Orchestrator" command. Used
   * both to reopen the same thread on repeat invocations and so the
   * event-driven wake-up subscriber can skip pinging the orchestrator about
   * its own completions. Undefined until the command is run once.
   */
  orchestratorThreadId?: string;
  /**
   * How the Kanban board groups threads. 'status' (default) renders the seven
   * status columns. 'folder' renders one horizontal swimlane per app/project
   * (by assigned Project, falling back to working-directory label), with the
   * status columns nested inside each lane. 'project' renders one vertical
   * column per app/project, with threads inside each column grouped under
   * status section headers (matching the Agent Dashboard sidebar's grouping).
   */
  kanbanGroupBy?: 'status' | 'folder' | 'project';
  /**
   * Which sidebar panel(s) to auto-collapse when the Kanban board tab is
   * opened, and restore when it is closed. Defaults to 'none' (no change).
   * Useful for giving the wide Kanban board more horizontal room.
   */
  kanbanCollapseSide?: 'none' | 'left' | 'right' | 'both';
  /**
   * When true (default), repeat runs of the same scheduled/cron job collapse
   * into a single expandable rollup — the Kanban board's quiet columns (New,
   * Done, Ready) show one stack card per job instead of one card per run, and
   * the Agent Dashboard groups their quiet runs into a "Scheduled Jobs"
   * section. A run that's running, waiting on a permission/question, or
   * errored is never stacked — it always renders individually in its normal
   * group. Set to false to disable and render every run as its own card/row,
   * exactly like before this setting existed.
   */
  stackScheduledThreads?: boolean;
  /**
   * When true, the obsidian_open_url MCP tool is registered and available to Claude.
   * Only takes effect if the Obsidian Web Viewer core plugin is also enabled.
   * Defaults to true so the tool is available out of the box.
   */
  enableWebViewerTool?: boolean;
  /**
   * When true, a canonical wrapped `visualize` content reference in an
   * assistant message renders as a live sandboxed visualization inline instead
   * of raw text. Legacy bare references remain supported. Desktop only.
   * Defaults to true.
   */
  enableInlineVisualizations?: boolean;
  /** Registered local skill collections browsable from the Skills Manager. */
  skillSources: SkillSource[];
  /** Vault-relative folder for authored packages; installs retain their own root. */
  localSkillsFolder?: string;
  /** Durable peer-API correlations and bounded run results. Internal format; consumers use api.v1. */
  publicApiState?: import('./PublicApi').PublicApiPersistedState;
  /** Width in px of the Skills Manager's left list panel, set by dragging the divider. */
  skillsListWidth: number;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  claudeBinaryPath: '/opt/homebrew/bin/claude',
  agentHarness: 'claude',
  codexBinaryPath: 'codex',
  worktreeRoot: '',
  defaultCwd: '',
  saveThreadsToVault: true,
  saveRawLogs: true,
  vaultFolder: DEFAULT_VAULT_FOLDER,
  permissionMode: 'acceptEdits',
  thinkingMode: 'disabled',
  thinkingBudgetTokens: 8000,
  effort: 'default',
  codexEffort: 'default',
  agentProgressSummaries: true,
  enable1MContext: false,
  extraEnv: '',
  provider: 'claude',
  defaultModel: '',
  summarizationEnabled: true,
  inprocessModel: 'haiku',
  autoSummarize: false,
  escalationEnabled: true,
  escalationKeyword: '/escalate',
  escalationModel: 'opus',
  alwaysAllowedTools: [],
  disallowedTools: ['CronCreate', 'CronDelete', 'CronList', 'CronUpdate'],
  threads: [],
  projects: [],
  wakeLockEnabled: true,
  layoutDensity: 'comfortable',
  agentsGroupBy: 'project-status',
  statusLineCommand: 'bash $HOME/claude-config/bin/statusline-command.sh',
  statusLineIntervalMs: 30_000,
  createPrMessage: '/create-pr',
  createDraftPrMessage: '/create-pr --draft',
  debugLogging: false,
  telemetryEnabled: true,
  threadViewPlacement: 'conversation-first',
  hasSeenWelcome: false,
  imageExternalizationComplete: false,
  autoArchiveIdleDays: 14,
  pttKey: 'Alt+Space',
  openAIKey: '',
  secretEnvKeys: [],
  mcpServers: {},
  oauthMcpServers: {},
  oauthMcpState: {},
  remoteAccess: {
    enabled: false,
    roomId: '',
    relayUrl: 'wss://claude-threads-relay.rbcodelabs.workers.dev',
    pairingCode: null,
    pairingExpiresAt: null,
  },
  scheduledItems: [],
  watchedDocuments: [],
  enableWebViewerTool: true,
  enableInlineVisualizations: true,
  kanbanGroupBy: 'status',
  kanbanCollapseSide: 'none',
  stackScheduledThreads: true,
  skillSources: [],
  localSkillsFolder: 'Skills',
  skillsListWidth: 200,
};

/**
 * Returns the extraEnv string with provider-specific variables prepended.
 * Prepending (not appending) means a user-supplied CLAUDE_CODE_USE_BEDROCK
 * line in extraEnv still wins, since parseExtraEnv lets later lines override.
 */
export function effectiveExtraEnv(
  settings: Pick<PluginSettings, 'extraEnv' | 'provider'>,
): string {
  if (settings.provider === 'bedrock') {
    return `CLAUDE_CODE_USE_BEDROCK=1\n${settings.extraEnv ?? ''}`;
  }
  return settings.extraEnv ?? '';
}

export function parseExtraEnv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return result;
}

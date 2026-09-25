import { query, type Options, type Query, type CanUseTool, type SDKUserMessage, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { ToolCallRecord, AskQuestion, ImageAttachment, TaskItemStatus } from './types';
import { parseExtraEnv } from './types';
import { debugLog } from './logger';
import { mergeUsageSnapshot, normalizeClaudeRateLimit, normalizeClaudeResult, timestampMs, type UsageSnapshot } from './Usage';
// Import from the mobile-safe utility module, then re-export so that desktop
// callers that already import formatToolName/getToolIcon from ClaudeSession
// continue to work without changes.
import { formatToolName, getToolIcon } from './toolNameUtils';
export { formatToolName, getToolIcon };

/**
 * Incremental change to the shared task list, derived from harness-native
 * task-tracking events:
 * - 'replace' — TodoWrite (older CLIs) sends the whole list each time
 *               and Codex update_plan notifications send full snapshots
 * - 'create'  — TaskCreate confirmed by its tool result ("Task #N created…")
 * - 'update'  — TaskUpdate sets status (and possibly a new subject)
 */
export type TaskTrackerEvent =
  | { kind: 'replace'; tasks: { content: string; status: TaskItemStatus }[] }
  | { kind: 'create'; id: string; content: string }
  | { kind: 'update'; id: string; status?: string; content?: string };

export interface ModelRefusalFallback {
  content: string;
  originalModel: string;
  fallbackModel: string;
  scope: 'session' | 'local';
  category?: string;
  explanation?: string;
}
export interface ModelRefusalNoFallback {
  content: string;
  originalModel: string;
  category?: string;
  explanation?: string;
}
export interface ResultMetadata {
  queuedTurnCount?: number;
  userMessageUuid?: string;
}

export interface SessionCallbacks {
  onToken: (text: string) => void;
  onToolUse: (record: ToolCallRecord) => void;
  onMessage: (content: string, toolCalls: ToolCallRecord[]) => void;
  onRecap: (summary: string) => void;
  onDone: (sessionId: string, cost: number, numTurns: number, metadata?: ResultMetadata) => void;
  onInterrupted: (sessionId: string) => void;
  onError: (err: Error) => void;
  /**
   * Fired when a transport-closed error is about to be auto-retried
   * in-process (ADR-0002 Stage 2 gap fix): the connection to the CLI dropped
   * mid-turn but the auto-retry budget (`transportErrorRecovery.ts`) hasn't
   * been exhausted yet, so a continuation turn is about to be sent
   * automatically rather than surfacing a terminal `onError`. Only invoked
   * by `ThreadSession` (whose long-lived `Query` handles this retry
   * internally, see `pumpMessages()`'s catch block) — `ClaudeSession`'s
   * per-turn `run()` never calls it, since under the old model
   * `ThreadManager.sendMessage()` drove the equivalent "reconnecting" UI
   * state itself from its own `onError` branch rather than needing a
   * dedicated callback.
   */
  onReconnecting?: (error: string) => void;
  /**
   * Fired when a rate-limit / overload error is about to be auto-retried
   * in-process by `ThreadSession` (see `pumpMessages()`'s catch block). The
   * API rejected the turn before the model saw it, so the plugin silently
   * replays the exact same turn after `delayMs` of backoff — no new
   * transcript message. `attempt` is 1-based; `maxRetries` is the budget
   * (`MAX_RATE_LIMIT_AUTO_RETRIES`). Only `ThreadSession` invokes it; the
   * per-turn `ClaudeSession` never does. Distinct from `onRateLimit`, which
   * merely surfaces the CLI's observed rate-limit *window* status.
   */
  onRateLimitRetry?: (attempt: number, maxRetries: number, delayMs: number) => void;
  onPermissionRequest: (toolName: string, detail: string) => Promise<boolean>;
  onAskUserQuestion: (questions: AskQuestion[]) => Promise<Record<string, string>>;
  /** Provider resolved/canceled its pending question before the user answered. */
  onAskUserQuestionCanceled?: () => void;
  onOpenNewTab: (title?: string, initialPrompt?: string) => Promise<{ threadId: string; title: string }>;
  onStatus?: (status: 'compacting' | 'requesting' | null) => void;
  onCompact?: (trigger: 'auto' | 'manual', preTokens: number) => void;
  onTaskStarted?: (taskId: string, description: string, skipTranscript: boolean, taskType?: string, workflowName?: string, subagentType?: string, parentNativeAgentId?: string, model?: string) => void;
  onTaskUpdated?: (taskId: string, patch: { status?: string; description?: string; error?: string }) => void;
  onTaskProgress?: (taskId: string, description: string, lastToolName?: string) => void;
  onTaskNotification?: (taskId: string, status: 'completed' | 'failed' | 'stopped', summary: string) => void;
  onNotification?: (text: string, priority: 'low' | 'medium' | 'high' | 'immediate') => void;
  onApiRetry?: (attempt: number, maxRetries: number, error: string) => void;
  /**
   * Fired when a tool call is auto-denied WITHOUT an interactive permission
   * prompt — e.g. the auto-mode classifier, `dontAsk` mode, a headless-agent
   * auto-deny, or a deny rule. The interactive 'ask' path never reaches here
   * (it surfaces via canUseTool). Lets the UI render the denial distinctly
   * instead of the user only seeing an is_error tool_result.
   */
  onPermissionDenied?: (toolName: string, toolUseId: string, message: string, agentId?: string, decisionReasonType?: string) => void;
  onRateLimit?: (status: 'allowed' | 'allowed_warning' | 'rejected', resetsAt?: number) => void;
  /** Fired whenever provider token, cost, quota, or account-usage data changes. */
  onUsage?: (usage: import('./Usage').UsageSnapshot) => void;
  /** Fired when a tool result contains inline images (e.g. the Read tool reading a PNG). */
  onToolResultImages?: (images: Array<{ mediaType: string; data: string }>) => void;
  /** Fired when the agent's task list changes (TodoWrite / TaskCreate / TaskUpdate). */
  onTaskEvent?: (event: TaskTrackerEvent) => void;
  /**
   * Fired for each raw SDK event (and a synthetic `session_start` marker at the
   * top of each turn) so a consumer can persist the verbatim event stream to a
   * JSONL log. Partial streaming token deltas (`stream_event`) are filtered out
   * before this fires — they're reconstructed in the final `assistant` message.
   */
  onRawEvent?: (event: { type?: string } & Record<string, unknown>) => void;
  /** Harness-neutral reroute callback retained for Codex model/rerouted events. */
  onModelFallback?: (trigger: string, fromModel: string, toModel: string) => void;
  onModelRefusalFallback?: (refusal: ModelRefusalFallback) => void;
  onModelRefusalNoFallback?: (refusal: ModelRefusalNoFallback) => void;
  /** Fired when a running tool emits a progress heartbeat with elapsed time. */
  onToolProgress?: (toolUseId: string, toolName: string, elapsedSeconds: number) => void;
  /** Fired when the session surfaces memory files into the current turn. */
  onMemoryRecall?: (paths: string[], mode: 'select' | 'synthesize') => void;
  /** Fired when the slash-command list changes mid-session (e.g. new skill discovered). */
  onCommandsChanged?: (commands: import('@anthropic-ai/claude-agent-sdk').SlashCommand[]) => void;
  /** Fired when agentProgressSummaries is enabled and a task emits an AI summary. */
  onTaskProgressSummary?: (taskId: string, summary: string) => void;
  /**
   * Fired when a Bash tool result contains a gitOperation classification
   * (commit, push, PR create/merge, etc.). Lets the UI render a structured
   * git-activity summary without re-parsing stdout.
   */
  onGitOperation?: (summary: string) => void;
  /**
   * Fired when a Write/Edit tool result indicates the user modified the
   * proposed content in the permission dialog before accepting.
   */
  onFileUserModified?: (filePath: string) => void;
  /** Fired when the harness reports one or more files changed during a turn. */
  onFilesEdited?: (paths: string[]) => void;
  /**
   * Fired when a tool_result arrives for a previously-seen tool_use, carrying
   * its final success/error status and elapsed duration. Mirrors the
   * onGitOperation/onFileUserModified side-channel pattern — lets the UI
   * update a live pill immediately without waiting for the finalized message.
   */
  onToolResult?: (toolUseId: string, status: 'success' | 'error', durationMs?: number) => void;
  /**
   * Fired when the active harness enters read-only planning mode.
   * Non-blocking: fire and continue.
   */
  onEnterPlanMode?: () => void;
  /**
   * Fired when a harness needs to persist Plan mode before starting an
   * internal read-only continuation at a safe turn boundary.
   */
  onPlanModeRequested?: () => void | Promise<void>;
  /** Fired after Codex has successfully restored Default mode for an approved plan. */
  onPlanApprovalCommitted?: () => void | Promise<void>;
  /** Retryable Plan/Default transition failure; the approval card remains live. */
  onPlanTransitionError?: (error: Error) => void;
  /**
   * Fired when the active harness produces a completed plan. The harness must
   * not begin implementation until either approve() or reject() is called.
   * - approve(editedPlan?) - allow implementation to proceed; pass the edited
   *   plan text if the user modified it, otherwise undefined.
   * - reject() - deny implementation while leaving the harness ready for plan revision.
   */
  onPlanReady?: (planText: string, approve: (editedPlan?: string) => void, reject: () => boolean) => void;
  /**
   * Fired once per session after the Query is initialized with the list of
   * available models and subagent types for this session.
   */
  onCapabilitiesDiscovered?: (
    models: import('@anthropic-ai/claude-agent-sdk').ModelInfo[],
    agents: import('@anthropic-ai/claude-agent-sdk').AgentInfo[],
  ) => void;
  /**
   * Fired when an MCP server sends an elicitation request (e.g. for OAuth or
   * structured form input). Blocking: the session waits until the returned
   * Promise resolves with an ElicitationResult.
   */
  onElicitation?: (
    request: import('@anthropic-ai/claude-agent-sdk').ElicitationRequest,
    signal: AbortSignal,
  ) => Promise<import('@anthropic-ai/claude-agent-sdk').ElicitationResult>;
}

export class ClaudeSession {
  private activeQuery: Query | null = null;
  private latestUsage: UsageSnapshot | null = null;
  private usageCallback: SessionCallbacks['onUsage'] = undefined;
  private recapEmitted = false;
  private interrupted = false;
  private resumeSessionId: string | undefined = undefined;
  private releaseInputResolve: (() => void) | null = null;
  private inputOpen = false;

  constructor(private claudePath: string) {}

  private applyUsage(update: UsageSnapshot): void {
    this.latestUsage = mergeUsageSnapshot(this.latestUsage, update);
    this.usageCallback?.(this.latestUsage);
  }

  /** Idempotent: resolves the held-open input generator's release promise, if any. */
  private releaseInput(): void {
    this.inputOpen = false;
    this.releaseInputResolve?.();
    this.releaseInputResolve = null;
  }

  /**
   * Explicitly end the current turn's input stream, letting the SDK close
   * stdin (`transport.endInput()`) and the CLI subprocess exit once it
   * drains. Used by ThreadManager to unwind a lingering session — one still
   * alive past its first `result` because background tasks were pending —
   * before starting the thread's next turn.
   */
  endInput(): void {
    this.releaseInput();
  }

  async run(
    prompt: string,
    resumeSessionId: string | undefined,
    cwd: string,
    permissionMode: Options['permissionMode'],
    extraEnvRaw: string,
    callbacks: SessionCallbacks,
    additionalDirectories?: string[],
    model?: string,
    images?: ImageAttachment[],
    appendSystemPrompt?: string,
    mcpServers?: Record<string, McpServerConfig>,
    secretEnv?: Record<string, string>,
    disallowedTools?: string[],
    sessionOptions?: {
      thinking?: Options['thinking'];
      effort?: Options['effort'];
      agentProgressSummaries?: boolean;
      betas?: import('@anthropic-ai/claude-agent-sdk').SdkBeta[];
      persistSession?: boolean;
      plugins?: import('@anthropic-ai/claude-agent-sdk').SdkPluginConfig[];
      agents?: Record<string, import('@anthropic-ai/claude-agent-sdk').AgentDefinition>;
    },
  ): Promise<void> {
    this.interrupted = false;
    this.resumeSessionId = resumeSessionId;
    this.usageCallback = callbacks.onUsage;

    const inputReleased = new Promise<void>((resolve) => {
      this.releaseInputResolve = resolve;
    });
    this.inputOpen = true;

    const canUseTool: CanUseTool = async (toolName, input, opts) => {
      pendingInteractiveCallbacks++;
      try {
        if (toolName === 'AskUserQuestion') {
          const questions = (input as { questions: import('./types').AskQuestion[] }).questions;
          const answers = await callbacks.onAskUserQuestion(questions);
          // Spread original input to preserve metadata/annotations, then override answers
          return { behavior: 'allow' as const, updatedInput: { ...input, answers } };
        }
        if (toolName === 'OpenNewTab') {
          const inp = input as { title?: string; initialPrompt?: string };
          const result = await callbacks.onOpenNewTab(inp.title, inp.initialPrompt);
          return { behavior: 'allow' as const, updatedInput: { ...input, result: JSON.stringify(result) } };
        }
        if (toolName === 'EnterPlanMode') {
          callbacks.onEnterPlanMode?.();
          return { behavior: 'allow' as const };
        }
        if (toolName === 'ExitPlanMode') {
          // ExitPlanMode cannot be allowed to execute: the CLI's Zod schema rejects the
          // extra `plan` field Claude sends in the input, causing a validation error.
          // Instead we show the plan card, then signal approval/rejection via deny messages
          // so Claude's turn continues (approve) or is interrupted (reject) without the
          // CLI ever attempting to run the tool.
          //
          // Denying the tool call only changes what THIS Claude instance believes — it does
          // NOT clear the CLI's own internal permission-mode state, which is what actually
          // gates the "you are in Plan Mode" system-reminder shown on every turn. Any
          // subagent spawned via the `agents` option runs inside this same query/session and
          // reads that same internal state, so without explicitly calling setPermissionMode()
          // on approval, subagents keep seeing a live plan-mode restriction forever, even
          // after the parent has "exited" plan mode from the user's point of view. See
          // Query.setPermissionMode in the SDK types — this is the actual mechanism meant to
          // clear it, and it was previously never called anywhere in this file.
          const clearPlanMode = async () => {
            try {
              await this.activeQuery?.setPermissionMode('default');
            } catch (err) {
              console.error('[ClaudeThreads] failed to clear plan mode via setPermissionMode:', err);
            }
          };
          const planText = String((input as { plan?: unknown }).plan ?? '');
          if (callbacks.onPlanReady) {
            const result = await new Promise<import('@anthropic-ai/claude-agent-sdk').PermissionResult>((resolve) => {
              callbacks.onPlanReady!(
                planText,
                async (editedPlan) => {
                  // Approve: clear the CLI's real plan-mode state first, then deny the tool
                  // call (avoids Zod error) with a message Claude can read to understand it
                  // should proceed with implementation.
                  await clearPlanMode();
                  const approvalNote = editedPlan !== undefined && editedPlan !== planText
                    ? `Plan approved with edits:\n\n${editedPlan}`
                    : 'Plan approved — proceed with implementation.';
                  resolve({ behavior: 'deny' as const, message: approvalNote, interrupt: false });
                },
                () => {
                  resolve({ behavior: 'deny' as const, message: 'Plan rejected by user — stop immediately and do not proceed with any implementation.', interrupt: false });
                  return false;
                },
              );
            });
            return result;
          }
          // No handler registered: clear plan mode and deny non-interruptingly so Claude can
          // proceed normally.
          await clearPlanMode();
          return { behavior: 'deny' as const, message: 'Plan approved — proceed with implementation.', interrupt: false };
        }
        const detail = opts.description ?? opts.decisionReason ?? opts.blockedPath ?? JSON.stringify(input).slice(0, 120);
        const title = opts.title ?? toolName;
        const allowed = await callbacks.onPermissionRequest(title, detail);
        // Never return `updatedPermissions` (e.g. `opts.suggestions`): the CLI
        // persists those rules to `.claude/settings.local.json`, turning every
        // one-shot "Allow" — and every auto-allow of an already-trusted tool —
        // into a permanent, invisible rule. "Always Allow" is persisted by the
        // plugin itself (`settings.alwaysAllowedTools`), which the permission
        // handler consults, so nothing is lost.
        return allowed
          ? { behavior: 'allow' as const, updatedInput: input }
          : { behavior: 'deny' as const, message: 'Denied by user' };
      } catch (err) {
        console.error('[ClaudeThreads] canUseTool error:', err);
        return { behavior: 'deny' as const, message: 'Permission handler error' };
      } finally {
        pendingInteractiveCallbacks--;
      }
    };

    const options: Options = {
      pathToClaudeCodeExecutable: this.claudePath,
      permissionMode,
      cwd,
      includePartialMessages: true,
      canUseTool,
      // Keep task-tracking tools (TaskCreate/TaskUpdate/TaskList/TodoWrite) in the
      // default tool surface — SDK 0.3.233 drops them on Opus 4.8 / Sonnet 5 / Fable 5
      // and newer models unless opted back in. The plugin's dashboard depends on them.
      // Placed after process.env (so a stray inherited value can't disable a core
      // feature) but before extra/secret env (so explicit plugin config still wins).
      env: { ...process.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', ...parseExtraEnv(extraEnvRaw), ...(secretEnv ?? {}) },
    };
    if (resumeSessionId) options.resume = resumeSessionId;
    if (additionalDirectories?.length) options.additionalDirectories = additionalDirectories;
    if (model) options.model = model;
    if (appendSystemPrompt) options.extraArgs = { 'append-system-prompt': appendSystemPrompt };
    if (mcpServers && Object.keys(mcpServers).length) {
      options.mcpServers = mcpServers;
      const mcpDebug = Object.entries(mcpServers).map(([k, v]) => ({
        serverName: k,
        type: (v as unknown as Record<string, unknown>).type,
        hasInstance: 'instance' in v,
      }));
      debugLog('[ClaudeThreads] MCP servers attached to session:', JSON.stringify(mcpDebug));
    } else {
      console.warn('[ClaudeThreads] No MCP servers for this session — built-in tools will be unavailable');
    }
    if (disallowedTools?.length) options.disallowedTools = disallowedTools;
    if (sessionOptions?.thinking) options.thinking = sessionOptions.thinking;
    if (sessionOptions?.effort) options.effort = sessionOptions.effort;
    if (sessionOptions?.agentProgressSummaries !== undefined) options.agentProgressSummaries = sessionOptions.agentProgressSummaries;
    if (sessionOptions?.betas?.length) options.betas = sessionOptions.betas;
    if (sessionOptions?.persistSession === false) options.persistSession = false;
    if (sessionOptions?.plugins?.length) options.plugins = sessionOptions.plugins;
    if (sessionOptions?.agents && Object.keys(sessionOptions.agents).length > 0) {
      options.agents = { ...options.agents, ...sessionOptions.agents };
    }
    if (callbacks.onElicitation) {
      options.onElicitation = (request, opts) => callbacks.onElicitation!(request, opts.signal);
    }
    // Route the built-in EnterWorktree / ExitWorktree SDK tools to the plugin's
    // MCP versions, which read effectiveCwd (updated by set_working_directory)
    // rather than the frozen OS-level subprocess cwd.
    options.toolAliases = {
      EnterWorktree: 'mcp__claude_threads__enter_worktree',
      ExitWorktree: 'mcp__claude_threads__exit_worktree',
    };

    debugLog('[ClaudeThreads] launching query', { claudePath: this.claudePath, cwd, permissionMode, resume: resumeSessionId, model: model ?? 'default' });

    // Always drive the SDK in streaming-input mode via a held-open async
    // generator, for text-only turns as well as image turns. Passing a plain
    // string sets the SDK's internal `isSingleUserTurn` flag, which force-
    // closes stdin — the only channel carrying permission responses
    // (canUseTool, AskUserQuestion, ExitPlanMode) — the instant the first
    // `result` event arrives. That's fine for a single-generation turn, but
    // once a background task keeps the CLI alive past the first result
    // (routine now — see the pending-task tracking in the event loop below),
    // every later permission round-trip gets force-rejected with a
    // "Stream closed" error even though the CLI process is still running.
    // Completing this generator is instead how *we* trigger
    // `transport.endInput()` — deliberately, once no background tasks are
    // pending — so the permission channel survives multi-generation turns.
    const promptArg: AsyncIterable<SDKUserMessage> = (async function* () {
      yield {
        type: 'user' as const,
        parent_tool_use_id: null,
        message: {
          role: 'user' as const,
          content: images && images.length > 0
            ? [
                ...(prompt.trim() ? [{ type: 'text' as const, text: prompt }] : []),
                // An image with only an externalized `path` and no in-memory
                // base64 can't be sent inline; a live send always has base64, so
                // this filters nothing in practice but keeps the SDK type honest.
                ...images
                  .filter((img): img is ImageAttachment & { base64: string } => img.base64 != null)
                  .map(img => ({
                    type: 'image' as const,
                    source: {
                      type: 'base64' as const,
                      media_type: img.mediaType,
                      data: img.base64,
                    },
                  })),
              ]
            : prompt,
        },
      };
      await inputReleased;
    })();

    let q: Query;
    try {
      q = query({ prompt: promptArg, options });
    } catch (initErr) {
      console.error('[ClaudeThreads] query() init failed:', initErr);
      callbacks.onError(initErr instanceof Error ? initErr : new Error(String(initErr)));
      return;
    }
    this.activeQuery = q;

    // Discover supported models and agents once per session init — fire and
    // forget; failures are non-fatal.
    if (callbacks.onCapabilitiesDiscovered) {
      Promise.all([
        q.supportedModels().catch(() => []),
        q.supportedAgents().catch(() => []),
      ]).then(([models, agents]) => {
        callbacks.onCapabilitiesDiscovered?.(models, agents);
      }).catch(() => { /* ignore */ });
    }

    // Synthetic boundary marker so each turn is delimited in the raw log and
    // carries the turn's inputs (prompt, cwd, model, resume target).
    callbacks.onRawEvent?.({
      type: 'session_start',
      resume: resumeSessionId ?? null,
      cwd,
      model: model ?? null,
      permissionMode: permissionMode ?? null,
      prompt,
      imageCount: images?.length ?? 0,
      timestamp: Date.now(),
    });

    const pendingToolCalls: ToolCallRecord[] = [];
    let streamingText = '';

    const allToolCalls: ToolCallRecord[] = [];
    // toolUseId -> ToolCallRecord, scoped to this run() call, so the 'user'
    // case handling tool_result blocks can mutate the SAME record object that
    // flows into pendingToolCalls/allToolCalls/onMessage's persisted array —
    // no extra plumbing needed for the finalized view to pick up the status.
    const toolCallsByUseId = new Map<string, ToolCallRecord>();
    // TaskCreate tool_use ids → subject, awaiting the "Task #N created" result
    // so the create event carries the CLI-assigned task id.
    const pendingTaskCreates = new Map<string, string>();
    // Task IDs currently running (any task_started — a backgrounded Bash
    // command's task_type is 'local_bash' and does NOT set skip_transcript,
    // so gating on that flag misses the common case). The input stream stays
    // open across a `result` event as long as this is non-empty: the CLI
    // process is still alive doing work, and whatever generation it streams
    // next needs a working permission channel just as much as the first one
    // did.
    const pendingBgTaskIds = new Set<string>();
    // A `task_notification` is the CLI's explicit "wake the model" signal for
    // an out-of-band task completion (verified live: a background Bash task
    // that finishes fast enough to notify *before* the first `result` still
    // causes the CLI to stream a distinct follow-up generation afterward —
    // pendingBgTaskIds is already empty by then, so it alone isn't a
    // sufficient release signal). Set this flag on notification; clear it as
    // soon as the next `assistant` event streams (that IS the reaction the
    // flag protects — see the `case 'assistant'` handler). If a `result`
    // arrives with the flag still true, no reaction has streamed yet, so
    // skip release and let the next result re-check. Log-verified (14 days
    // of raw JSONL): clearing only at the *next result* — the pre-fix
    // behavior — wedges nearly every turn that uses background tasks at all,
    // because the reaction generation almost always streams and completes
    // with its own result BEFORE the flag would have been cleared, leaving
    // the flag true at the turn's final result with no further result ever
    // coming to release the stream.
    let sawTaskNotificationSinceLastResult = false;
    // Tracks any in-flight `canUseTool` call — covers ExitPlanMode,
    // AskUserQuestion, and generic permission prompts uniformly (simpler and
    // more future-proof than special-casing individual tool names). It ticks
    // up the instant canUseTool is entered and back down in a `finally`, so
    // it's harmless for fast-resolving paths like EnterPlanMode/OpenNewTab
    // (up and back down almost immediately) and only matters for the slow,
    // human-driven waits this fix targets. One `query()` serves both the
    // foreground generation and any concurrent background-task generations
    // over the same stream, so a `result` from a *different*, concurrent
    // background-task generation can land while THIS generation's
    // canUseTool call is still awaiting a human click — without this gate,
    // the release check below would close stdin anyway, and the eventual
    // human response would be force-rejected with "Stream closed" even
    // though the CLI process is still running. See the release-gate comment
    // at the `case 'result':` handler below for how this is used.
    let pendingInteractiveCallbacks = 0;

    try {
      for await (const msg of q) {
        debugLog('[ClaudeThreads] msg.type:', msg.type, (msg as Record<string, unknown>).subtype ?? '');
        // Persist the verbatim event to the raw JSONL log, skipping the noisy
        // per-token partial deltas (reconstructed in the final assistant message).
        if (callbacks.onRawEvent && msg.type !== 'stream_event') {
          callbacks.onRawEvent(msg as { type?: string } & Record<string, unknown>);
        }
        switch (msg.type) {
          case 'stream_event': {
            const evt = msg.event;
            if (evt.type === 'content_block_delta') {
              const delta = evt.delta as { type: string; text?: string };
              if (delta.type === 'text_delta' && delta.text) {
                streamingText += delta.text;
                callbacks.onToken(delta.text);
              }
            }
            break;
          }

          case 'assistant': {
            // Assistant activity arriving after a task_notification IS the
            // reaction generation the flag below exists to protect — it has
            // now streamed, so clear the flag immediately rather than waiting
            // for the next `result` (which was the wedge: the reaction's own
            // result was the turn's LAST event, so the flag stayed true there,
            // release was skipped, and no further result ever came — see the
            // comment on sawTaskNotificationSinceLastResult).
            sawTaskNotificationSinceLastResult = false;
            const parts: string[] = [];
            for (const block of msg.message.content) {
              if (block.type === 'text') {
                parts.push(block.text);
              } else if (block.type === 'tool_use') {
                const summary = formatToolSummary(
                  block.name,
                  block.input as Record<string, unknown>,
                );
                const record: ToolCallRecord = { name: block.name, summary, timestamp: Date.now(), toolUseId: block.id, status: 'pending' };
                pendingToolCalls.push(record);
                allToolCalls.push(record);
                toolCallsByUseId.set(block.id, record);
                callbacks.onToolUse(record);

                // Task-tracking tools — surface as task list updates
                if (callbacks.onTaskEvent) {
                  const input = block.input as Record<string, unknown>;
                  if (block.name === 'TodoWrite' && Array.isArray(input.todos)) {
                    const tasks = (input.todos as Array<Record<string, unknown>>)
                      .filter(t => typeof t.content === 'string')
                      .map(t => ({
                        content: t.content as string,
                        status: (t.status as TaskItemStatus) ?? 'pending',
                      }));
                    callbacks.onTaskEvent({ kind: 'replace', tasks });
                  } else if (block.name === 'TaskCreate' && typeof input.subject === 'string') {
                    pendingTaskCreates.set(block.id, input.subject);
                  } else if (block.name === 'TaskUpdate' && input.taskId != null) {
                    callbacks.onTaskEvent({
                      kind: 'update',
                      id: String(input.taskId),
                      status: typeof input.status === 'string' ? input.status : undefined,
                      content: typeof input.subject === 'string' ? input.subject : undefined,
                    });
                  }
                }
              }
            }
            if (parts.length > 0) {
              const content = parts.join('\n');
              callbacks.onMessage(content, [...pendingToolCalls]);
            }
            pendingToolCalls.length = 0;
            streamingText = '';
            break;
          }

          case 'tool_use_summary': {
            this.recapEmitted = true;
            callbacks.onRecap(msg.summary);
            break;
          }

          case 'result': {
            this.applyUsage(normalizeClaudeResult(msg as unknown as Record<string, any>));
            if (msg.subtype === 'success') {
              // Fallback recap from tool calls if no tool_use_summary was emitted
              if (allToolCalls.length > 0 && !this.recapEmitted) {
                const names = [...new Set(allToolCalls.map(t => formatToolName(t.name)))];
                callbacks.onRecap(`Used ${names.join(', ')} (${allToolCalls.length} call${allToolCalls.length > 1 ? 's' : ''})`);
              }
              const result = msg as typeof msg & { queued_turn_count?: number; user_message_uuid?: string };
              callbacks.onDone(msg.session_id, msg.total_cost_usd, msg.num_turns, {
                queuedTurnCount: result.queued_turn_count,
                userMessageUuid: result.user_message_uuid,
              });
            } else if (this.interrupted) {
              // User-initiated stop — Claude Code reports error_during_execution when
              // interrupted; treat this as a clean cancellation, not a real error.
              callbacks.onInterrupted(this.resumeSessionId ?? '');
            } else {
              callbacks.onError(
                new Error(`Claude session ended: ${(msg as { subtype: string }).subtype}`),
              );
            }
            // Only release the input stream (and let stdin close) once no
            // background task is still running, no task_notification landed
            // in this same result window, AND no canUseTool call is
            // currently awaiting a human response (ExitPlanMode /
            // AskUserQuestion / a permission prompt) — re-checked on every
            // subsequent `result` this loop sees. See the pendingBgTaskIds /
            // sawTaskNotificationSinceLastResult / pendingInteractiveCallbacks
            // declarations above for why all three conditions are needed.
            // The third exists because a `result` from a *different*,
            // concurrent background-task generation can land while THIS
            // generation is still blocked inside canUseTool waiting on the
            // user — without the check, that result would close stdin out
            // from under the still-pending human response, which then gets
            // force-rejected with "Stream closed" once it finally arrives.
            // Once canUseTool resolves, the counter drops to 0 and the
            // generation it was blocking resumes and eventually emits its
            // own `result`, which re-checks this gate and releases
            // normally — same soundness argument used for the
            // notification-flag condition above.
            const queuedTurnCount = msg.subtype === 'success'
              ? (msg as typeof msg & { queued_turn_count?: number }).queued_turn_count ?? 0
              : 0;
            if (queuedTurnCount === 0 && pendingBgTaskIds.size === 0 && !sawTaskNotificationSinceLastResult && pendingInteractiveCallbacks === 0) {
              this.releaseInput();
            }
            sawTaskNotificationSinceLastResult = false;
            break;
          }

          case 'system': {
            const sys = msg as Record<string, unknown>;
            switch (sys.subtype) {
              case 'status':
                callbacks.onStatus?.(sys.status as 'compacting' | 'requesting' | null);
                break;
              case 'compact_boundary': {
                const meta = sys.compact_metadata as { trigger: 'auto' | 'manual'; pre_tokens: number } | undefined;
                callbacks.onCompact?.(meta?.trigger ?? 'auto', meta?.pre_tokens ?? 0);
                break;
              }
              case 'task_started':
                pendingBgTaskIds.add(sys.task_id as string);
                callbacks.onTaskStarted?.(
                  sys.task_id as string,
                  sys.description as string,
                  !!(sys.skip_transcript),
                  sys.task_type as string | undefined,
                  sys.workflow_name as string | undefined,
                  sys.subagent_type as string | undefined,
                  sys.parent_task_id as string | undefined,
                  sys.model as string | undefined,
                );
                break;
              case 'task_updated': {
                const patch = sys.patch as Record<string, unknown>;
                if (patch.status === 'completed' || patch.status === 'failed' || patch.status === 'killed') {
                  pendingBgTaskIds.delete(sys.task_id as string);
                }
                callbacks.onTaskUpdated?.(
                  sys.task_id as string,
                  {
                    status: patch.status as string | undefined,
                    description: patch.description as string | undefined,
                    error: patch.error as string | undefined,
                  }
                );
                break;
              }
              case 'task_progress':
                callbacks.onTaskProgress?.(
                  sys.task_id as string,
                  sys.description as string,
                  sys.last_tool_name as string | undefined,
                );
                if (sys.summary && callbacks.onTaskProgressSummary) {
                  callbacks.onTaskProgressSummary(sys.task_id as string, sys.summary as string);
                }
                break;
              case 'task_notification':
                pendingBgTaskIds.delete(sys.task_id as string);
                sawTaskNotificationSinceLastResult = true;
                callbacks.onTaskNotification?.(
                  sys.task_id as string,
                  sys.status as 'completed' | 'failed' | 'stopped',
                  sys.summary as string,
                );
                break;
              case 'notification':
                callbacks.onNotification?.(
                  sys.text as string,
                  sys.priority as 'low' | 'medium' | 'high' | 'immediate',
                );
                break;
              case 'api_retry':
                callbacks.onApiRetry?.(
                  sys.attempt as number,
                  sys.max_retries as number,
                  sys.error as string,
                );
                break;
              case 'permission_denied':
                callbacks.onPermissionDenied?.(
                  sys.tool_name as string,
                  sys.tool_use_id as string,
                  sys.message as string,
                  sys.agent_id as string | undefined,
                  sys.decision_reason_type as string | undefined,
                );
                break;
              case 'model_refusal_fallback':
                callbacks.onModelRefusalFallback?.({
                  content: sys.content as string,
                  originalModel: sys.original_model as string,
                  fallbackModel: sys.fallback_model as string,
                  scope: (sys.scope as 'session' | 'local' | undefined) ?? 'session',
                  category: (sys.api_refusal_category as string | null | undefined) ?? undefined,
                  explanation: (sys.api_refusal_explanation as string | null | undefined) ?? undefined,
                });
                break;
              case 'model_refusal_no_fallback':
                callbacks.onModelRefusalNoFallback?.({
                  content: sys.content as string,
                  originalModel: sys.original_model as string,
                  category: (sys.api_refusal_category as string | null | undefined) ?? undefined,
                  explanation: (sys.api_refusal_explanation as string | null | undefined) ?? undefined,
                });
                break;
              case 'memory_recall': {
                const paths = ((sys.memories as Array<{ path: string }>) ?? []).map(m => m.path);
                callbacks.onMemoryRecall?.(paths, sys.mode as 'select' | 'synthesize');
                break;
              }
              case 'commands_changed':
                callbacks.onCommandsChanged?.(
                  sys.commands as import('@anthropic-ai/claude-agent-sdk').SlashCommand[],
                );
                break;
            }
            break;
          }

          case 'tool_progress': {
            const tp = msg as Record<string, unknown>;
            callbacks.onToolProgress?.(
              tp.tool_use_id as string,
              tp.tool_name as string,
              tp.elapsed_time_seconds as number,
            );
            break;
          }

          case 'rate_limit_event': {
            const rle = msg as Record<string, unknown>;
            const info = rle.rate_limit_info as Record<string, unknown>;
            callbacks.onRateLimit?.(
              info.status as 'allowed' | 'allowed_warning' | 'rejected',
              timestampMs(info.resetsAt),
            );
            this.applyUsage(normalizeClaudeRateLimit(info));
            break;
          }

          case 'user': {
            // Tool results come back as 'user' messages. parent_tool_use_id is null
            // even for tool results, so scan content unconditionally.
            const userMsg = msg as Record<string, unknown>;
            const msgContent = (userMsg.message as Record<string, unknown>)?.content;
            if (Array.isArray(msgContent)) {
              for (const block of msgContent) {
                const b = block as Record<string, unknown>;
                if (b.type !== 'tool_result') continue;

                // Resolve the tool's final status from is_error and stamp duration.
                // Mutates the SAME ToolCallRecord object referenced by
                // pendingToolCalls/allToolCalls, so the finalized message's
                // toolCalls array (and anything already persisted from it via a
                // shallow copy) sees the update with no further plumbing.
                {
                  const toolUseId = b.tool_use_id as string | undefined;
                  const record = toolUseId ? toolCallsByUseId.get(toolUseId) : undefined;
                  if (record) {
                    const status: 'success' | 'error' = b.is_error === true ? 'error' : 'success';
                    record.status = status;
                    if (record.timestamp) {
                      record.durationMs = Date.now() - record.timestamp;
                    }
                    callbacks.onToolResult?.(toolUseId!, status, record.durationMs);
                  }
                }

                // Inline images returned by tools (e.g. Read on a PNG)
                if (callbacks.onToolResultImages && Array.isArray(b.content)) {
                  const images: Array<{ mediaType: string; data: string }> = [];
                  for (const inner of b.content as Array<Record<string, unknown>>) {
                    if (inner.type !== 'image') continue;
                    const src = inner.source as Record<string, unknown> | undefined;
                    if (src?.type === 'base64' && src.data && src.media_type) {
                      images.push({ mediaType: src.media_type as string, data: src.data as string });
                    } else if (inner.data && inner.mimeType) {
                      // MCP's own image block shape ({ type, data, mimeType }).
                      // The SDK/CLI is expected to normalise this to the
                      // Anthropic shape above, but no built-in tool returns an
                      // image yet, so that conversion is unproven. Accept both
                      // rather than silently drop the image.
                      images.push({ mediaType: inner.mimeType as string, data: inner.data as string });
                    }
                  }
                  if (images.length > 0) callbacks.onToolResultImages(images);
                }

                // gitOperation structured summary from BashOutput
                if (callbacks.onGitOperation) {
                  const resultRaw = b.tool_result ?? b.content;
                  let parsedResult: Record<string, unknown> | null = null;
                  try {
                    if (typeof resultRaw === 'string') {
                      parsedResult = JSON.parse(resultRaw) as Record<string, unknown>;
                    } else if (resultRaw && typeof resultRaw === 'object') {
                      parsedResult = resultRaw as Record<string, unknown>;
                    }
                  } catch { /* non-JSON tool result — skip */ }
                  if (parsedResult?.gitOperation) {
                    const op = parsedResult.gitOperation as Record<string, unknown>;
                    const parts: string[] = [];
                    if (op.commit) {
                      const c = op.commit as Record<string, unknown>;
                      parts.push(`${c.kind ?? 'committed'} ${String(c.sha ?? '').substring(0, 7)}`);
                    }
                    if (op.push) {
                      const p = op.push as Record<string, unknown>;
                      parts.push(`pushed to ${p.branch}`);
                    }
                    if (op.branch) {
                      const br = op.branch as Record<string, unknown>;
                      parts.push(`${br.action} ${br.ref}`);
                    }
                    if (op.pr) {
                      const pr = op.pr as Record<string, unknown>;
                      const prDesc = pr.url ? `PR #${pr.number} ${pr.action}` : `PR #${pr.number} ${pr.action}`;
                      parts.push(prDesc);
                    }
                    if (parts.length > 0) {
                      callbacks.onGitOperation(`git: ${parts.join(', ')}`);
                    }
                  }
                }

                // userModified flag from FileEditOutput / FileWriteOutput
                if (callbacks.onFileUserModified) {
                  const resultRaw = b.tool_result ?? b.content;
                  let parsedResult: Record<string, unknown> | null = null;
                  try {
                    if (typeof resultRaw === 'string') {
                      parsedResult = JSON.parse(resultRaw) as Record<string, unknown>;
                    } else if (resultRaw && typeof resultRaw === 'object') {
                      parsedResult = resultRaw as Record<string, unknown>;
                    }
                  } catch { /* non-JSON tool result — skip */ }
                  if (parsedResult?.userModified === true && typeof parsedResult.filePath === 'string') {
                    callbacks.onFileUserModified(parsedResult.filePath);
                  }
                }

                // TaskCreate confirmation — "Task #N created successfully: <subject>"
                const toolUseId = b.tool_use_id as string | undefined;
                if (toolUseId && pendingTaskCreates.has(toolUseId)) {
                  const subject = pendingTaskCreates.get(toolUseId)!;
                  pendingTaskCreates.delete(toolUseId);
                  const text = typeof b.content === 'string'
                    ? b.content
                    : Array.isArray(b.content)
                      ? (b.content as Array<Record<string, unknown>>)
                          .map(c => (typeof c.text === 'string' ? c.text : ''))
                          .join(' ')
                      : '';
                  const idMatch = text.match(/Task #(\d+)/i);
                  if (idMatch) {
                    callbacks.onTaskEvent?.({ kind: 'create', id: idMatch[1], content: subject });
                  }
                }
              }
            }
            break;
          }

          // Known top-level types the plugin does not (yet) act on, handled
          // explicitly so they are no longer silently dropped by the switch.
          // Both are already persisted verbatim via onRawEvent above.
          case 'auth_status': {
            const as = msg as { isAuthenticating?: boolean; error?: string };
            debugLog('[ClaudeThreads] auth_status:', { isAuthenticating: as.isAuthenticating, error: as.error });
            break;
          }
          case 'conversation_reset': {
            const cr = msg as { new_conversation_id?: string };
            debugLog('[ClaudeThreads] conversation_reset:', cr.new_conversation_id);
            break;
          }
        }
      }
    } catch (err) {
      if (this.interrupted) {
        // Clean cancellation — notify the manager so it can roll back the orphaned user message
        callbacks.onInterrupted(this.resumeSessionId ?? '');
      } else {
        const e = err instanceof Error ? err : new Error(String(err));
        const zodIssues = (err as Record<string, unknown>).issues;
        console.error('[ClaudeThreads] session error:', e, zodIssues ? JSON.stringify(zodIssues, null, 2) : '');
        callbacks.onError(new Error(`${e.message}${zodIssues ? '\n\nZod issues: ' + JSON.stringify(zodIssues) : ''}\n\nStack: ${e.stack ?? 'none'}`));
      }
    } finally {
      this.interrupted = false;
      this.activeQuery = null;
      // Release the input generator unconditionally — a path that exits the
      // loop without a `result` (e.g. a stream error before one ever
      // arrives) would otherwise leave the generator's `await inputReleased`
      // pending forever, leaking that promise and its resolver.
      this.releaseInput();
      // Explicitly close the query so the SDK removes the subprocess wrapper from its
      // internal tracking Set (w7) and detaches exit/error listeners. Without this call,
      // every completed query leaks its ChildProcess wrapper and the closure chain it
      // holds (options.env copy, callbacks, MCP server config) until the parent process
      // exits. On a day of heavy use with many queries this accumulates into tens of MB
      // of heap that is never collected.
      q.close();
    }
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    if (this.activeQuery) {
      await this.activeQuery.interrupt();
    }
  }

  close(): void {
    this.releaseInput();
    if (this.activeQuery) {
      this.activeQuery.close();
      this.activeQuery = null;
    }
  }

  /**
   * Returns a snapshot of current context window usage from the active query.
   * Returns null when no session is active or the call fails.
   */
  async getContextUsage(): Promise<import('@anthropic-ai/claude-agent-sdk').SDKControlGetContextUsageResponse | null> {
    if (!this.activeQuery) return null;
    try {
      return await this.activeQuery.getContextUsage();
    } catch {
      return null;
    }
  }

  async getUsageSnapshot(): Promise<UsageSnapshot | null> { return this.latestUsage; }
}


function formatToolSummary(name: string, input: Record<string, unknown>): string {
  // Normalize MCP tool names so the switch cases below always match bare names
  const mcpMatch = name.match(/^mcp__[^_]+__(.+)$/);
  const bare = mcpMatch ? mcpMatch[1] : name;
  const server = mcpMatch ? name.match(/^mcp__([^_]+)__/)![1] : null;
  const key = (server && bare.startsWith(server + '_'))
    ? bare.slice(server.length + 1)
    : bare;

  switch (key) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'Glob':
    case 'Grep':
      return `${String(input.file_path ?? input.path ?? input.pattern ?? '')}`;
    case 'Bash':
      return `${String(input.command ?? '').substring(0, 60)}`;
    case 'REPL': {
      const code = String(input.code ?? '');
      const firstLine = code.split('\n')[0].trim();
      return `Run JS: ${firstLine.substring(0, 60)}`;
    }
    case 'WebFetch':
      return `${input.url}`;
    case 'WebSearch':
      return `${input.query}`;
    case 'Agent':
      return String(input.description ?? input.prompt ?? '').substring(0, 80);
    case 'OpenNewTab':
      return `${(input.title as string) ?? 'New Thread'}`;
    case 'navigate_to_file': return `${input.path}`;
    case 'search_vault': return `${input.query}`;
    case 'get_backlinks': return `${input.path}`;
    case 'get_outgoing_links': return `${input.path}`;
    case 'insert_at_cursor': return '';
    case 'get_note_metadata': return `${input.path}`;
    case 'set_working_directory': return `${input.path}`;
    default:
      return '';
  }
}

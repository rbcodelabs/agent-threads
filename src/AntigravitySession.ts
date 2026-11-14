/**
 * Antigravity harness adapter (Google's Antigravity CLI, `agy acp`).
 *
 * Each session launches its own `agy acp` child and drives it over the Agent Client Protocol (see AcpClient):
 * NDJSON JSON-RPC on stdio, protocol version 1. Verified against the real CLI 1.1.13 (ACP server 1.5.8); frames
 * recorded from it live in test/fixtures/antigravity and drive the fake agent the unit tests use.
 *
 * What the recording showed, and what this adapter does about it:
 * - Model catalog is dynamic (it differs between `agy models` and `session/new`): the menu comes from `session/new`,
 *   never a hard-coded list.
 * - Edits arrive as `tool_call` with `kind: edit` and `content: [{type: 'diff', path, oldText?, newText}]`. A
 *   permission request carries the same diff, so the approval card can show it before anything is written.
 * - Permissions are `session/request_permission` with `allow_once` / `reject_once` only. The adapter owns the
 *   decision (resolveAntigravityPermission) so the thread's permission mode and denylist behave as for other harnesses.
 * - `session/cancel` is a notification; the in-flight `session/prompt` then resolves `stopReason: cancelled`.
 * - `session/load` REPLAYS history as ordinary updates BEFORE its response, and a bad session id does not error (it
 *   quietly creates a fresh session under that id). So replay is swallowed, and "zero replayed history" is the only
 *   signal a resume failed; the thread's transcript is then prepended to the first prompt (`resumeFallbackHistory`).
 * - Mode/model switching: `session/set_mode {modeId}` and `session/set_model {modelId}` (recorded).
 *
 * Desktop only: the child process is spawned lazily by AcpClient, so importing this module is inert on mobile.
 */
import { formatCurrentTimeContext, shouldAddCurrentTimeContext } from './currentTimeContext';
import type { AgentHarness, ImageAttachment } from './types';
import { parseExtraEnv } from './types';
import { isEditDenied, isShellDenied } from './toolRestrictions';
import type { SessionCallbacks } from './ClaudeSession';
import type {
  HarnessContextUsage,
  HarnessMcpServerConfig,
  HarnessPermissionMode,
  HarnessSessionOptions,
} from './HarnessSession';
import { mergeUsageSnapshot, type UsageSnapshot, type UsageTokenTotals } from './Usage';
import { AcpClient, type AcpClientOptions, type AcpLauncher } from './AcpClient';
import { OPENCODE_HOST_TOOLS_SERVER, OpenCodeHostToolsBridge } from './OpenCodeHostTools';

/** The ACP server release this adapter was verified against (`agentInfo.version` of `agy acp`). */
export const ANTIGRAVITY_VERIFIED_VERSION = '1.5.8';
const HARNESS: AgentHarness = 'antigravity';
const ACP_PROTOCOL_VERSION = 1;
export const ANTIGRAVITY_INSTALL_HINT = 'Install the Antigravity CLI (agy) and sign in once with it, or set its path under Settings, Antigravity binary path.';

// ── Pure mapping helpers (unit tested) ─────────────────────────────────────

/** ACP tool kinds that never need approval. */
const READ_ONLY_KINDS = new Set(['read', 'search', 'fetch', 'think', 'switch_mode']);
/** ACP tool kinds that change files. */
const EDIT_KINDS = new Set(['edit', 'delete', 'move']);

/** Map the plugin permission mode onto one Antigravity permission request (by ACP tool kind). */
export function resolveAntigravityPermission(mode: HarnessPermissionMode, kind: string | undefined): 'allow' | 'deny' | 'prompt' {
  if (kind !== undefined && READ_ONLY_KINDS.has(kind)) return 'allow';
  const edits = kind !== undefined && EDIT_KINDS.has(kind);
  switch (mode) {
    case 'bypassPermissions':
    case 'auto':
      return 'allow';
    case 'dontAsk':
      // Never stall an unattended run: anything that would prompt is denied.
      return 'deny';
    case 'plan':
      // Plan mode is read-only: an edit is refused outright, anything else still asks.
      return edits ? 'deny' : 'prompt';
    case 'acceptEdits':
      return edits ? 'allow' : 'prompt';
    case 'default':
    default:
      return 'prompt';
  }
}

/**
 * The Antigravity mode to put the session in. Only `plan` and the user's explicit `acceptEdits`/`auto` choices change
 * what agy asks; the adapter still decides every request that reaches it. When a denylist forbids edits or the shell,
 * the session stays in `default` (or `plan`) so agy can never auto-approve past the adapter's refusal.
 */
export function antigravityModeForPermission(mode: HarnessPermissionMode, disallowedTools?: readonly string[]): 'default' | 'accept-edits' | 'auto' | 'plan' {
  if (mode === 'plan') return 'plan';
  if (isEditDenied(disallowedTools) || isShellDenied(disallowedTools)) return 'default';
  switch (mode) {
    case 'acceptEdits': return 'accept-edits';
    case 'auto':
    case 'bypassPermissions': return 'auto';
    default: return 'default';
  }
}

/** Antigravity tool names/kinds mapped to the plugin's display names (drives tool icons). */
const KIND_TOOL_NAMES: Record<string, string> = {
  execute: 'Bash', read: 'Read', search: 'Grep', fetch: 'WebFetch', think: 'Think', delete: 'Edit', move: 'Edit',
};
const NAME_TOOL_NAMES: Record<string, string> = {
  write_file: 'Write', edit_file: 'Edit', run_command: 'Bash',
};

export function antigravityToolName(name: string | undefined, kind: string | undefined): string {
  if (name && NAME_TOOL_NAMES[name]) return NAME_TOOL_NAMES[name];
  if (kind && KIND_TOOL_NAMES[kind]) return KIND_TOOL_NAMES[kind];
  if (kind === 'edit') return 'Edit';
  const hostPrefix = `${OPENCODE_HOST_TOOLS_SERVER}_`;
  if (name?.startsWith(hostPrefix)) return name.slice(hostPrefix.length);
  return name || 'tool';
}

export interface AcpToolCall {
  toolCallId?: string;
  name?: string;
  kind?: string;
  title?: string;
  status?: string;
  rawInput?: Record<string, unknown>;
  args?: Record<string, unknown>;
  locations?: Array<{ path?: string }>;
  content?: Array<Record<string, any>>;
}

/** One-line card summary: the command for a shell call, the file for an edit, else the agent's own title. */
export function antigravityToolSummary(tool: AcpToolCall): string {
  const input = tool.rawInput ?? tool.args ?? {};
  const command = input.CommandLine ?? input.command;
  if (tool.kind === 'execute' && typeof command === 'string' && command.trim()) return command.trim().split('\n')[0].slice(0, 200);
  const file = tool.locations?.find((location) => typeof location.path === 'string' && location.path)?.path;
  if (EDIT_KINDS.has(tool.kind ?? '') && file) return file;
  if (tool.title?.trim()) return tool.title.trim();
  return file ?? tool.name ?? 'tool';
}

/** Every file path a tool call touches, from its diffs first and its locations second. */
export function antigravityEditedPaths(tool: AcpToolCall): string[] {
  const paths = new Set<string>();
  for (const item of tool.content ?? []) if (item?.type === 'diff' && typeof item.path === 'string' && item.path) paths.add(item.path);
  if (paths.size === 0) for (const location of tool.locations ?? []) if (typeof location.path === 'string' && location.path) paths.add(location.path);
  return [...paths];
}

const MAX_DIFF_DETAIL_CHARS = 4000;

/** Plain-text rendering of ACP diff content for the approval card. A missing `oldText` means a new file. */
export function antigravityDiffDetail(content: AcpToolCall['content']): string {
  const blocks: string[] = [];
  for (const item of content ?? []) {
    if (item?.type !== 'diff' || typeof item.newText !== 'string') continue;
    const header = `${item.path ?? 'file'}${typeof item.oldText === 'string' ? '' : ' (new file)'}`;
    const removed = typeof item.oldText === 'string' && item.oldText ? item.oldText.replace(/\n$/, '').split('\n').map((line: string) => `- ${line}`) : [];
    const added = item.newText ? item.newText.replace(/\n$/, '').split('\n').map((line: string) => `+ ${line}`) : [];
    blocks.push([header, ...removed, ...added].join('\n'));
  }
  const text = blocks.join('\n\n');
  return text.length > MAX_DIFF_DETAIL_CHARS ? `${text.slice(0, MAX_DIFF_DETAIL_CHARS)}\n…` : text;
}

/** What the approval card shows: the command, or the file, plus the diff when there is one. */
export function antigravityPermissionDetail(tool: AcpToolCall): string {
  const summary = antigravityToolSummary(tool);
  const diff = antigravityDiffDetail(tool.content);
  return diff ? `${summary}\n\n${diff}` : summary;
}

/** Convert neutral MCP servers to the ACP `mcpServers` shape (name/value lists, not maps). */
export function antigravityMcpServers(servers: Record<string, HarnessMcpServerConfig> | undefined): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (!server) continue;
    if ('url' in server) {
      result.push({
        type: server.type === 'sse' ? 'sse' : 'http',
        name,
        url: server.url,
        headers: Object.entries(server.headers ?? {}).map(([headerName, value]) => ({ name: headerName, value })),
      });
    } else if (typeof server.command === 'string') {
      result.push({
        name,
        command: server.command,
        args: server.args ?? [],
        env: Object.entries(server.env ?? {}).map(([envName, value]) => ({ name: envName, value })),
      });
    }
  }
  return result;
}

export interface AntigravityModelInfo { value: string; displayName: string; description: string }

/** `session/new` and `session/load` carry the live catalog in `models.availableModels`. */
export function antigravityModels(result: any): AntigravityModelInfo[] {
  const tier = result?._meta?.antigravity?.tier?.name;
  const models: any[] = Array.isArray(result?.models?.availableModels) ? result.models.availableModels : [];
  return models
    .filter((model) => typeof model?.modelId === 'string' && model.modelId)
    .map((model) => ({ value: String(model.modelId), displayName: String(model.name ?? model.modelId), description: typeof tier === 'string' ? tier : '' }));
}

/** `usage_update {used, size}` to the shared /context snapshot. */
export function antigravityContextUsage(used: number, size: number, model: string): HarnessContextUsage | null {
  if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return null;
  const totalTokens = Math.max(0, used);
  return {
    categories: [
      { name: 'Context in use', tokens: totalTokens, color: '#4b9cd3', kind: 'used' },
      { name: 'Free', tokens: Math.max(0, size - totalTokens), color: '#d9dde3', kind: 'free' },
    ],
    totalTokens,
    maxTokens: size,
    percentage: Math.min(100, (totalTokens / size) * 100),
    model,
  };
}

/** The `usage` object that ends a `session/prompt`. */
export function antigravityTurnTokens(usage: any): UsageTokenTotals | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  return {
    total: num(usage.totalTokens),
    input: num(usage.inputTokens),
    output: num(usage.outputTokens),
    cachedInput: num(usage.cachedReadTokens),
    cacheWriteInput: num(usage.cachedWriteTokens),
    reasoning: num(usage.thoughtTokens),
  };
}

/** Streaming chunks are covered by the finished message; logging each would bloat the raw log. */
const UNLOGGED_UPDATES = new Set(['agent_message_chunk', 'agent_thought_chunk', 'usage_update', 'user_message_chunk', 'available_commands_update']);
/** Updates that are part of the conversation history replayed by `session/load`. */
const HISTORY_UPDATES = new Set(['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update']);

// ── Session ────────────────────────────────────────────────────────────────

export type AntigravityClientFactory = (options: AcpClientOptions) => AcpClient;

export class AntigravitySession {
  private client: AcpClient | null = null;
  private bridge: OpenCodeHostToolsBridge | null = null;
  private options: HarnessSessionOptions | null = null;
  private sessionId: string | undefined;
  private closed = true;
  private _turnInFlight = false;
  private turnText = '';
  private queuedTurns: Array<{ text: string; images?: ImageAttachment[] }> = [];
  private resumeFallbackPending = false;
  private systemPromptPending = false;
  private loading = false;
  /** True from `start()` until the handshake completes: failures then reject `start()` instead of calling onError. */
  private starting = false;
  private replayedHistory = 0;
  private announcedTools = new Map<string, AcpToolCall>();
  private settledTools = new Set<string>();
  private toolStartedAt = new Map<string, number>();
  private pendingPermissions = new Map<string, (outcome: Record<string, unknown>) => void>();
  private currentMode: string | undefined;
  private activeModel = '';
  private latestContextUsage: HarnessContextUsage | null = null;
  private latestUsage: UsageSnapshot | null = null;
  private cumulativeTokens: UsageTokenTotals = {};
  private turns = 0;
  private hostToolNames = new Set<string>();

  /**
   * `launcher` replaces process spawning (tests); `startTimeoutMs` bounds the handshake and session setup, which on a
   * cold start of the real agent exceeds 20s.
   */
  constructor(
    private binaryPath: string,
    private launcher?: AcpLauncher,
    private startTimeoutMs?: number,
  ) {}

  get turnInFlight(): boolean { return this._turnInFlight; }
  get cwd(): string | undefined { return this.options?.cwd; }
  get hasPendingPermission(): boolean { return this.pendingPermissions.size > 0; }
  canIdleReap(): boolean { return !this._turnInFlight && !this.hasPendingPermission; }

  async start(options: HarnessSessionOptions): Promise<void> {
    this.close();
    this.options = options;
    this.closed = false;
    this.resetTurnState();
    this.announcedTools.clear();
    this.settledTools.clear();
    this.toolStartedAt.clear();
    this.latestContextUsage = null;
    this.latestUsage = null;
    this.cumulativeTokens = {};
    this.turns = 0;
    this.activeModel = options.model ?? '';
    this.resumeFallbackPending = false;
    this.systemPromptPending = Boolean(options.appendSystemPrompt);
    this.currentMode = undefined;
    this.sessionId = undefined;
    this.loading = false;
    this.starting = true;
    this.replayedHistory = 0;

    const mcpServers = antigravityMcpServers(options.antigravity?.mcpServers);
    const hostTools = options.antigravity?.dynamicTools ?? [];
    this.hostToolNames = new Set(hostTools.map((tool) => tool.name));
    if (hostTools.length > 0) {
      const bridge = new OpenCodeHostToolsBridge(hostTools, {
        permissionMode: () => this.options?.permissionMode ?? 'default',
        requestPermission: (toolName, detail) => this.options?.callbacks.onPermissionRequest(toolName, detail) ?? Promise.resolve(false),
      });
      await bridge.start();
      this.bridge = bridge;
      mcpServers.push({
        type: 'http',
        name: OPENCODE_HOST_TOOLS_SERVER,
        url: bridge.url,
        headers: Object.entries(bridge.headers).map(([name, value]) => ({ name, value })),
      });
    }

    const client = new AcpClient({
      binaryPath: this.binaryPath,
      args: ['acp'],
      cwd: options.cwd,
      env: { ...process.env, ...parseExtraEnv(options.extraEnvRaw), ...(options.secretEnv ?? {}) },
      launcher: this.launcher,
      startTimeoutMs: this.startTimeoutMs,
      installHint: ANTIGRAVITY_INSTALL_HINT,
      label: 'Antigravity',
    });
    this.client = client;
    client.onNotification('session/update', (params) => this.handleSessionUpdate(params));
    client.onRequest('session/request_permission', (params) => this.handlePermissionRequest(params));
    client.onProtocolError((line, error) => console.warn('[ClaudeThreads] Unparseable Antigravity line:', line.slice(0, 200), error.message));
    client.onClose((error) => this.handleClientClosed(client, error));
    client.spawn();

    try {
      const init = await client.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        // agy owns its tools and file access; nothing is delegated to the client.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, client.startTimeoutMs);
      options.callbacks.onRawEvent?.({ type: 'antigravity/initialize', agentInfo: init?.agentInfo, protocolVersion: init?.protocolVersion });
      const canLoad = Boolean(init?.agentCapabilities?.loadSession ?? init?.agentCapabilities?.load_session);
      let setup: any;
      if (options.resume && canLoad) setup = await this.loadSession(client, options.resume, options.cwd, mcpServers);
      if (!setup) {
        if (options.resume) this.resumeFallbackPending = true;
        setup = await client.request('session/new', { cwd: options.cwd, mcpServers }, client.startTimeoutMs);
      }
      const sessionId = typeof setup?.sessionId === 'string' ? setup.sessionId : undefined;
      if (!sessionId) throw new Error(`Antigravity did not return a session id.${this.compatibilityHint()}`);
      this.sessionId = sessionId;
      this.currentMode = setup?.modes?.currentModeId;
      if (!this.activeModel) this.activeModel = String(setup?.models?.currentModelId ?? '');
      const models = antigravityModels(setup);
      if (models.length > 0) options.callbacks.onCapabilitiesDiscovered?.(models as any, []);
      await this.applyInitialSettings(setup);
    } catch (error) {
      this.starting = false;
      this.close();
      throw error;
    }
    this.starting = false;
  }

  /** `session/load`, swallowing replayed history. Returns undefined when the load fails or the id is unknown. */
  private async loadSession(client: AcpClient, resume: string, cwd: string, mcpServers: Array<Record<string, unknown>>): Promise<any | undefined> {
    this.loading = true;
    this.replayedHistory = 0;
    this.sessionId = resume; // so replayed updates are recognised as ours and dropped
    try {
      const response = await client.request('session/load', { sessionId: resume, cwd, mcpServers }, client.startTimeoutMs);
      // A bad id "succeeds" as a fresh session. No replayed history therefore means the resume did not find anything.
      if (this.replayedHistory === 0) {
        this.resumeFallbackPending = true;
        console.warn('[ClaudeThreads] Antigravity replayed no history for the saved session; the transcript will be sent with the next prompt.');
      }
      return { ...response, sessionId: typeof response?.sessionId === 'string' ? response.sessionId : resume };
    } catch (error) {
      console.warn('[ClaudeThreads] Could not resume Antigravity session; starting a new one:', error);
      return undefined;
    } finally {
      this.loading = false;
      this.sessionId = undefined;
    }
  }

  /** Put a fresh session in the thread's permission mode and model, when they differ from agy's defaults. */
  private async applyInitialSettings(setup: any): Promise<void> {
    const options = this.options;
    if (!options || !this.sessionId) return;
    const wantedMode = antigravityModeForPermission(options.permissionMode ?? 'default', options.disallowedTools);
    if (wantedMode !== this.currentMode) await this.setAgentMode(wantedMode);
    const available: string[] = (setup?.models?.availableModels ?? []).map((model: any) => String(model?.modelId));
    if (options.model && options.model !== setup?.models?.currentModelId) {
      if (available.length === 0 || available.includes(options.model)) await this.setAgentModel(options.model);
      else console.warn(`[ClaudeThreads] Antigravity does not offer model "${options.model}"; using ${setup?.models?.currentModelId}.`);
    }
  }

  private async setAgentMode(modeId: string): Promise<void> {
    if (!this.client || !this.sessionId) return;
    try {
      await this.client.request('session/set_mode', { sessionId: this.sessionId, modeId }, 15_000);
      this.currentMode = modeId;
    } catch (error) {
      console.warn('[ClaudeThreads] Could not set Antigravity mode:', error);
    }
  }

  private async setAgentModel(modelId: string): Promise<void> {
    if (!this.client || !this.sessionId) return;
    try {
      await this.client.request('session/set_model', { sessionId: this.sessionId, modelId }, 15_000);
      this.activeModel = modelId;
    } catch (error) {
      console.warn('[ClaudeThreads] Could not set Antigravity model:', error);
    }
  }

  async setModel(model: string | undefined): Promise<void> {
    if (this.options) this.options.model = model;
    if (model) await this.setAgentModel(model);
  }

  async setPermissionMode(mode: HarnessPermissionMode): Promise<void> {
    if (this.options) this.options.permissionMode = mode;
    const wanted = antigravityModeForPermission(mode, this.options?.disallowedTools);
    if (wanted !== this.currentMode) await this.setAgentMode(wanted);
  }

  send(text: string, images?: ImageAttachment[], _userMessageUuid?: string): void {
    if (this.closed || !this.sessionId || !this.client) throw new Error('Antigravity session is not running');
    if (this._turnInFlight) {
      this.queuedTurns.push({ text, images });
      return;
    }
    this.startTurn(text, images);
  }

  private startTurn(text: string, images?: ImageAttachment[]): void {
    const options = this.options;
    const client = this.client;
    const sessionId = this.sessionId;
    if (!options || !client || !sessionId) return;
    this._turnInFlight = true;
    this.turnText = '';
    const mode = options.permissionMode ?? 'default';

    let effectiveText = text;
    const history = options.resumeFallbackHistory;
    if (this.resumeFallbackPending && history) effectiveText = history + effectiveText;
    this.resumeFallbackPending = false;
    // `_meta.antigravity.systemPrompt.append` is advertised but its request shape is unobserved, so the system prompt
    // rides the first prompt of each process instead (a resumed process has lost it).
    if (this.systemPromptPending && options.appendSystemPrompt) {
      effectiveText = `<system-instructions>\n${options.appendSystemPrompt}\n</system-instructions>\n\n${effectiveText}`;
      this.systemPromptPending = false;
    }
    const prompt: Array<Record<string, unknown>> = [{ type: 'text', text: effectiveText }];
    // Per-turn clock as its own text block (see currentTimeContext.ts).
    if (shouldAddCurrentTimeContext(text)) prompt.push({ type: 'text', text: formatCurrentTimeContext() });
    for (const image of images ?? []) prompt.push({ type: 'image', mimeType: image.mediaType, data: image.base64 });

    if (mode === 'plan') options.callbacks.onEnterPlanMode?.();
    client.request('session/prompt', { sessionId, prompt })
      .then((result) => this.finishTurn(result))
      .catch((error) => {
        if (this.closed || !this._turnInFlight) return;
        this.resetTurnState();
        options.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      });
  }

  async interrupt(): Promise<void> {
    if (!this.client || !this.sessionId || !this._turnInFlight) return;
    this.queuedTurns = [];
    // A pending approval would otherwise keep the agent waiting on us: answer it as cancelled first.
    for (const resolve of [...this.pendingPermissions.values()]) resolve({ outcome: 'cancelled' });
    this.client.notify('session/cancel', { sessionId: this.sessionId });
  }

  close(): void {
    this.closed = true;
    this.resetTurnState();
    for (const resolve of [...this.pendingPermissions.values()]) resolve({ outcome: 'cancelled' });
    this.pendingPermissions.clear();
    // `session/close` is advertised but not called: the process is killed instead, and the saved session must stay
    // loadable for resume.
    this.client?.close();
    this.client = null;
    this.bridge?.close();
    this.bridge = null;
  }

  async getContextUsage(): Promise<HarnessContextUsage | null> { return this.latestContextUsage; }

  async getUsageSnapshot(_includeAccountUsage = false): Promise<UsageSnapshot | null> { return this.latestUsage; }

  private resetTurnState(): void {
    this._turnInFlight = false;
    this.turnText = '';
    this.queuedTurns = [];
  }

  private compatibilityHint(): string {
    return ` The plugin is verified against the Antigravity ACP server ${ANTIGRAVITY_VERIFIED_VERSION}; check \`agy --version\` and update the plugin or agy if they differ.`;
  }

  private handleClientClosed(client: AcpClient, error?: Error): void {
    if (this.client !== client || this.closed || this.starting) return;
    const failure = error ?? new Error('Antigravity exited unexpectedly.');
    // The process is gone: further sends fail fast so the manager starts a fresh session instead of writing to a dead pipe.
    this.closed = true;
    this.resetTurnState();
    this.pendingPermissions.clear();
    this.options?.callbacks.onError(failure);
  }

  // ── Updates ──────────────────────────────────────────────────────────────

  /** Public for tests: route one `session/update` notification to the session callbacks. */
  handleSessionUpdate(params: { sessionId?: string; update?: any } | undefined): void {
    const callbacks = this.options?.callbacks;
    const update = params?.update;
    if (!callbacks || this.closed || !update || params?.sessionId !== this.sessionId) return;
    const kind = String(update.sessionUpdate ?? '');
    if (this.loading) {
      // Replay of saved history: counted (it is the only proof the resume worked) and otherwise dropped.
      if (HISTORY_UPDATES.has(kind)) this.replayedHistory++;
      if (kind === 'available_commands_update') this.handleCommands(update, callbacks);
      return;
    }
    if (!UNLOGGED_UPDATES.has(kind)) callbacks.onRawEvent?.({ type: `antigravity/${kind}`, ...(update as Record<string, unknown>) });

    switch (kind) {
      case 'agent_message_chunk': {
        const text = update.content?.type === 'text' ? update.content.text : undefined;
        if (this._turnInFlight && typeof text === 'string' && text) {
          this.turnText += text;
          callbacks.onToken(text);
        }
        break;
      }
      case 'tool_call':
      case 'tool_call_update':
        this.handleTool(update as AcpToolCall, callbacks);
        break;
      case 'usage_update':
        this.latestContextUsage = antigravityContextUsage(Number(update.used), Number(update.size), this.activeModel);
        break;
      case 'available_commands_update':
        this.handleCommands(update, callbacks);
        break;
      case 'current_mode_update':
        if (typeof update.currentModeId === 'string') this.currentMode = update.currentModeId;
        break;
      // agent_thought_chunk: the existing UI has no thinking affordance for non-Claude harnesses, so it is dropped (kept
      // out of the raw log too, like the other streaming chunks). user_message_chunk is an echo of our own prompt.
      // session_info_update and config_option_update carry nothing the thread needs.
      default:
        break;
    }
  }

  private handleCommands(update: any, callbacks: SessionCallbacks): void {
    if (!Array.isArray(update.availableCommands)) return;
    const commands = update.availableCommands
      .filter((command: any) => typeof command?.name === 'string' && command.name)
      .map((command: any) => ({ name: command.name, description: String(command.description ?? ''), argumentHint: '' }));
    callbacks.onCommandsChanged?.(commands);
  }

  private handleTool(tool: AcpToolCall, callbacks: SessionCallbacks): void {
    const callId = String(tool.toolCallId ?? '');
    if (!callId) return;
    const known = this.announcedTools.get(callId);
    const merged: AcpToolCall = { ...known, ...tool, content: tool.content ?? known?.content };
    if (!known) {
      // Text before a tool is a finished segment: flush it so the transcript keeps text/tool order.
      this.flushText(callbacks);
      this.announcedTools.set(callId, merged);
      this.toolStartedAt.set(callId, Date.now());
      callbacks.onToolUse({
        toolUseId: callId,
        name: antigravityToolName(merged.name, merged.kind),
        summary: antigravityToolSummary(merged),
        status: 'pending',
        timestamp: Date.now(),
      });
    } else {
      this.announcedTools.set(callId, merged);
    }
    const status = tool.status;
    if ((status === 'completed' || status === 'failed') && !this.settledTools.has(callId)) {
      this.settledTools.add(callId);
      if (status === 'completed' && EDIT_KINDS.has(merged.kind ?? '')) {
        const paths = antigravityEditedPaths(merged);
        if (paths.length > 0) callbacks.onFilesEdited?.(paths);
      }
      const started = this.toolStartedAt.get(callId);
      callbacks.onToolResult?.(callId, status === 'completed' ? 'success' : 'error', started ? Math.max(0, Date.now() - started) : undefined);
    }
  }

  private flushText(callbacks: SessionCallbacks): void {
    if (!this.turnText.trim()) { this.turnText = ''; return; }
    const text = this.turnText;
    this.turnText = '';
    callbacks.onMessage(text, []);
  }

  private finishTurn(result: any): void {
    const callbacks = this.options?.callbacks;
    if (!callbacks || this.closed || !this._turnInFlight) return;
    const stopReason = String(result?.stopReason ?? 'end_turn');
    this.applyTurnUsage(result?.usage, callbacks);
    const sessionId = this.sessionId ?? '';
    // Settle tools the agent never reported as finished (cancelled mid-call) so no card spins forever.
    for (const [callId] of this.announcedTools) {
      if (!this.settledTools.has(callId)) {
        this.settledTools.add(callId);
        callbacks.onToolResult?.(callId, 'error', undefined);
      }
    }
    if (stopReason === 'cancelled') {
      // The streamed tokens already cover any partial text, so no late message is appended.
      this.resetTurnState();
      callbacks.onInterrupted(sessionId);
      return;
    }
    if (stopReason === 'refusal') {
      this.resetTurnState();
      callbacks.onError(new Error('Antigravity declined to continue with this request.'));
      return;
    }
    this.flushText(callbacks);
    if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
      callbacks.onNotification?.(`Antigravity stopped early (${stopReason.replace(/_/g, ' ')}).`, 'medium');
    }
    this._turnInFlight = false;
    this.turns++;
    callbacks.onDone(sessionId, 0, 1);
    const next = this.queuedTurns.shift();
    if (next && !this.closed) this.startTurn(next.text, next.images);
  }

  private applyTurnUsage(usage: any, callbacks: SessionCallbacks): void {
    const turn = antigravityTurnTokens(usage);
    if (!turn) return;
    const sum = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
    const totals = this.cumulativeTokens;
    this.cumulativeTokens = {
      total: sum(totals.total, turn.total), input: sum(totals.input, turn.input), output: sum(totals.output, turn.output),
      cachedInput: sum(totals.cachedInput, turn.cachedInput), cacheWriteInput: sum(totals.cacheWriteInput, turn.cacheWriteInput),
      reasoning: sum(totals.reasoning, turn.reasoning),
    };
    this.latestUsage = mergeUsageSnapshot(this.latestUsage, {
      provider: HARNESS, updatedAt: Date.now(), quotaWindows: [], tokens: this.cumulativeTokens, lastTurnTokens: turn, turns: this.turns + 1,
    });
    callbacks.onUsage?.(this.latestUsage);
  }

  // ── Permissions ──────────────────────────────────────────────────────────

  /** Public for tests: answer one `session/request_permission` (the AcpClient wiring calls this). */
  async handlePermissionRequest(params: { sessionId?: string; toolCall?: AcpToolCall; options?: Array<{ optionId?: string; kind?: string }> } | undefined): Promise<Record<string, unknown>> {
    const callbacks = this.options?.callbacks;
    const tool = params?.toolCall ?? {};
    const optionId = (kind: string, fallback: string) => params?.options?.find((option) => option.kind === kind)?.optionId ?? fallback;
    const select = (kind: string, fallback: string) => ({ outcome: { outcome: 'selected', optionId: optionId(kind, fallback) } });
    const cancelled = { outcome: { outcome: 'cancelled' } };
    if (!callbacks || this.closed) return cancelled;
    // Mirror the permission card into the raw log so a recorded thread shows what was asked.
    callbacks.onRawEvent?.({ type: 'antigravity/permission_request', toolCall: tool });

    const kind = tool.kind;
    const disallowed = this.options?.disallowedTools;
    // Defence in depth for the per-thread denylist: refuse the shell and file edits whatever mode agy is in.
    const denied = (kind === 'execute' && isShellDenied(disallowed)) || (EDIT_KINDS.has(kind ?? '') && isEditDenied(disallowed));
    const hostTool = this.isBridgedHostTool(tool);
    const decision = denied
      ? 'deny'
      : hostTool
        ? 'allow' // bridged host tools are approved by the MCP bridge itself
        : resolveAntigravityPermission(this.options?.permissionMode ?? 'default', kind);
    if (decision === 'allow') return select('allow_once', 'allow');
    if (decision === 'deny') return select('reject_once', 'deny');

    const key = String(tool.toolCallId ?? `perm-${this.pendingPermissions.size}`);
    return new Promise<Record<string, unknown>>((resolve) => {
      let answered = false;
      const settle = (outcome: Record<string, unknown>) => {
        if (answered) return;
        answered = true;
        this.pendingPermissions.delete(key);
        resolve(outcome);
      };
      this.pendingPermissions.set(key, (outcome) => settle(outcome.outcome === 'cancelled' ? cancelled : outcome));
      callbacks.onPermissionRequest(`Antigravity: ${antigravityToolName(tool.name, kind)}`, antigravityPermissionDetail(tool))
        .then((allow) => settle(allow ? select('allow_once', 'allow') : select('reject_once', 'deny')))
        .catch(() => settle(select('reject_once', 'deny')));
    });
  }

  private isBridgedHostTool(tool: AcpToolCall): boolean {
    if (!this.bridge) return false;
    const name = tool.name ?? '';
    const prefix = `${OPENCODE_HOST_TOOLS_SERVER}_`;
    return name.startsWith(prefix) || this.hostToolNames.has(name) || (tool.title ?? '').startsWith(`${OPENCODE_HOST_TOOLS_SERVER}`);
  }
}

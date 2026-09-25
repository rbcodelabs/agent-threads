/**
 * OpenCode harness adapter (https://opencode.ai, MIT).
 *
 * Each session launches its own `opencode serve` on 127.0.0.1 (desktop only),
 * streams the server's `/event` SSE feed, and drives the documented HTTP API:
 * `POST /session`, `POST /session/:id/prompt_async`, `POST /session/:id/abort`,
 * `POST /permission/:id/reply` and `POST /question/:id/reply`.
 *
 * Like CodexSession, payloads are kept structural rather than bundling the
 * generated `@opencode-ai/sdk` types: the server is the user's installed CLI,
 * so a vendored type snapshot would drift. Shapes were verified live against
 * `opencode-ai@1.18.32` (see docs/adr/0013-opencode-harness.md).
 *
 * Node built-ins are required lazily so importing this module stays inert on
 * mobile, where HarnessFactory is never reached.
 */
import type { ChildProcess } from 'child_process';
import type { AgentHarness, AskQuestion, ImageAttachment, TaskItemStatus } from './types';
import { parseExtraEnv } from './types';
import type { SessionCallbacks } from './ClaudeSession';
import type {
  HarnessContextUsage,
  HarnessMcpServerConfig,
  HarnessPermissionMode,
  HarnessSessionOptions,
} from './HarnessSession';
import { mergeUsageSnapshot, type UsageSnapshot } from './Usage';
import { OPENCODE_HOST_TOOLS_SERVER, OpenCodeHostToolsBridge } from './OpenCodeHostTools';

/** The CLI release whose HTTP/SSE shapes this adapter was verified against. */
export const OPENCODE_VERIFIED_VERSION = '1.18.32';
const HARNESS: AgentHarness = 'opencode';
const SERVER_START_TIMEOUT_MS = 20_000;

// ── Pure mapping helpers (unit tested) ─────────────────────────────────────

/** Tools OpenCode may run without asking; everything else is routed to the adapter. */
const OPENCODE_READ_ONLY_PERMISSIONS = ['read', 'glob', 'grep', 'list', 'lsp', 'todowrite', 'todoread', 'question'] as const;

/**
 * OpenCode config `permission` block. Every non-read-only action is set to
 * `ask` so the adapter — not a static config file — applies the thread's live
 * permission mode (see resolveOpenCodePermission). Host tools are approved by
 * the MCP bridge itself, so OpenCode must not ask a second time.
 */
export function openCodePermissionConfig(): Record<string, 'ask' | 'allow'> {
  const config: Record<string, 'ask' | 'allow'> = { '*': 'ask' };
  for (const permission of OPENCODE_READ_ONLY_PERMISSIONS) config[permission] = 'allow';
  config[`${OPENCODE_HOST_TOOLS_SERVER}_*`] = 'allow';
  return config;
}

/** Map the plugin permission mode onto one OpenCode `permission.asked` request. */
export function resolveOpenCodePermission(
  mode: HarnessPermissionMode,
  permission: string,
): 'allow' | 'deny' | 'prompt' {
  if ((OPENCODE_READ_ONLY_PERMISSIONS as readonly string[]).includes(permission)) return 'allow';
  switch (mode) {
    case 'bypassPermissions':
    case 'auto':
      return 'allow';
    case 'dontAsk':
      // Never stall an unattended run: anything that would prompt is denied.
      return 'deny';
    case 'plan':
      // The plan agent is read-only; an edit request is refused outright.
      return permission === 'edit' ? 'deny' : 'prompt';
    case 'acceptEdits':
      return permission === 'edit' ? 'allow' : 'prompt';
    case 'default':
    default:
      return 'prompt';
  }
}

/** Plan mode uses OpenCode's built-in read-only `plan` agent. */
export function openCodeAgentForMode(mode: HarnessPermissionMode): 'plan' | 'build' {
  return mode === 'plan' ? 'plan' : 'build';
}

/** OpenCode addresses models as `provider/model`; the model part may itself contain slashes. */
export function parseOpenCodeModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const index = model.indexOf('/');
  if (index <= 0 || index === model.length - 1) return undefined;
  return { providerID: model.slice(0, index), modelID: model.slice(index + 1) };
}

/** Convert neutral process-transport MCP servers to OpenCode `mcp` config entries. */
export function openCodeMcpServers(servers: Record<string, HarnessMcpServerConfig> | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (!server) continue;
    if ('url' in server) {
      result[name] = {
        type: 'remote',
        url: server.url,
        enabled: true,
        ...(server.headers ? { headers: server.headers } : {}),
        ...(server.timeout ? { timeout: server.timeout } : {}),
      };
      continue;
    }
    if (typeof server.command !== 'string') continue;
    result[name] = {
      type: 'local',
      command: [server.command, ...(server.args ?? [])],
      enabled: true,
      ...(server.env ? { environment: server.env } : {}),
      ...(server.timeout ? { timeout: server.timeout } : {}),
    };
  }
  return result;
}

export interface OpenCodeStepTokens {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

/** Translate a `step-finish` token report into the shared /context snapshot. */
export function openCodeContextUsage(tokens: OpenCodeStepTokens, contextLimit: number | undefined, model: string): HarnessContextUsage | null {
  if (!contextLimit || contextLimit <= 0) return null;
  const input = Math.max(0, tokens.input ?? 0);
  const cached = Math.max(0, tokens.cache?.read ?? 0);
  const output = Math.max(0, tokens.output ?? 0);
  const reasoning = Math.max(0, tokens.reasoning ?? 0);
  const totalTokens = Math.max(0, tokens.total ?? input + cached + output + reasoning);
  return {
    categories: [
      { name: 'Input', tokens: input, color: '#4b9cd3', kind: 'used' },
      { name: 'Cached input', tokens: cached, color: '#7cb9e8', kind: 'used' },
      { name: 'Output', tokens: output, color: '#97c1e8', kind: 'used' },
      { name: 'Reasoning', tokens: reasoning, color: '#b0cfe8', kind: 'used' },
    ],
    totalTokens,
    maxTokens: contextLimit,
    percentage: Math.min(100, (totalTokens / contextLimit) * 100),
    model,
  };
}

/** OpenCode tool IDs mapped to the plugin's display names (drives tool icons). */
const OPENCODE_TOOL_NAMES: Record<string, string> = {
  bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', patch: 'Edit', apply_patch: 'Edit', multiedit: 'MultiEdit',
  glob: 'Glob', grep: 'Grep', list: 'LS', webfetch: 'WebFetch', websearch: 'WebSearch', todowrite: 'TodoWrite',
  todoread: 'TodoRead', task: 'Agent', question: 'AskUserQuestion', skill: 'Skill',
};

export function openCodeToolName(tool: string): string {
  const hostPrefix = `${OPENCODE_HOST_TOOLS_SERVER}_`;
  if (tool.startsWith(hostPrefix)) return tool.slice(hostPrefix.length);
  return OPENCODE_TOOL_NAMES[tool] ?? tool;
}

export function openCodeToolSummary(tool: string, input: Record<string, unknown> | undefined, title?: string): string {
  const value = input?.command ?? input?.filePath ?? input?.path ?? input?.pattern ?? input?.url ?? input?.query ?? input?.description;
  if (typeof value === 'string' && value.trim()) return value;
  if (title && title.trim()) return title;
  return openCodeToolName(tool);
}

const OPENCODE_UNLOGGED_EVENTS = new Set([
  'message.part.delta', 'server.heartbeat', 'server.connected', 'plugin.added', 'catalog.updated',
  'reference.updated', 'integration.updated', 'lsp.updated', 'file.watcher.updated',
]);

const FILE_EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'apply_patch', 'multiedit']);

function todoStatus(status: unknown): TaskItemStatus | null {
  if (status === 'pending' || status === 'completed') return status;
  if (status === 'in_progress') return 'in_progress';
  return null; // cancelled and unknown statuses leave the tracker
}

// ── Transport ──────────────────────────────────────────────────────────────

/** Minimal HTTP/SSE client for one `opencode serve` instance. */
export interface OpenCodeTransport {
  request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; body: any }>;
  /** Subscribe to `/event`; `onClose` fires if the stream ends unexpectedly. */
  subscribe(onEvent: (event: OpenCodeEvent) => void, onClose: (error?: Error) => void): void;
  close(): void;
}

export interface OpenCodeEvent {
  type: string;
  properties?: any;
}

export type OpenCodeLauncher = (options: {
  binaryPath: string;
  cwd: string;
  env: Record<string, string | undefined>;
  config: Record<string, unknown>;
}) => Promise<OpenCodeTransport>;

/** Launch `opencode serve` and return a Node http transport bound to the session directory. */
export const launchOpenCodeServer: OpenCodeLauncher = async ({ binaryPath, cwd, env, config }) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawn } = require('child_process') as typeof import('child_process');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http = require('http') as typeof import('http');
  const child: ChildProcess = spawn(binaryPath, ['serve', '--hostname=127.0.0.1', '--port=0'], {
    cwd,
    env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`opencode serve did not start within ${SERVER_START_TIMEOUT_MS / 1000}s`));
    }, SERVER_START_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/opencode server listening on (https?:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not launch OpenCode at "${binaryPath}": ${error.message}. Install OpenCode (https://opencode.ai) or set its path in Settings.`));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`opencode serve exited (${code ?? 'unknown'})${output.trim() ? `: ${output.trim().slice(-500)}` : ''}`));
    });
  });
  child.stderr?.on('data', (chunk: Buffer) => console.warn('[ClaudeThreads] opencode serve:', chunk.toString().trim()));

  const url = (path: string) => {
    const target = new URL(path, baseUrl);
    target.searchParams.set('directory', cwd);
    return target;
  };
  let eventRequest: import('http').ClientRequest | null = null;
  let closed = false;
  return {
    request(method, path, body) {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      return new Promise((resolve, reject) => {
        const req = http.request(url(path), {
          method,
          headers: payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {},
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = text;
            try { parsed = text ? JSON.parse(text) : undefined; } catch { /* non-JSON body */ }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
          res.on('error', reject);
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
    },
    subscribe(onEvent, onClose) {
      eventRequest = http.get(url('/event'), { headers: { accept: 'text/event-stream' } }, (res) => {
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let index: number;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            try { onEvent(JSON.parse(data) as OpenCodeEvent); } catch (error) { console.warn('[ClaudeThreads] Invalid OpenCode event:', error); }
          }
        });
        res.on('end', () => { if (!closed) onClose(new Error('OpenCode event stream ended')); });
      });
      eventRequest.on('error', (error) => { if (!closed) onClose(error); });
    },
    close() {
      closed = true;
      eventRequest?.destroy();
      eventRequest = null;
      if (child.exitCode === null) child.kill('SIGTERM');
    },
  };
};

// ── Session ────────────────────────────────────────────────────────────────

export class OpenCodeSession {
  private transport: OpenCodeTransport | null = null;
  private bridge: OpenCodeHostToolsBridge | null = null;
  private options: HarnessSessionOptions | null = null;
  private sessionId: string | undefined;
  /** Our session plus child sessions spawned by the `task` tool. */
  private ownedSessions = new Set<string>();
  private _turnInFlight = false;
  private turnSawBusy = false;
  private turnError: { aborted: boolean; message: string } | null = null;
  private turnCost = 0;
  private queuedTurns: Array<{ text: string; images?: ImageAttachment[] }> = [];
  private closed = true;
  private resumeFallbackPending = false;
  private messageRoles = new Map<string, string>();
  private partTypes = new Map<string, string>();
  private completedTextParts = new Set<string>();
  private announcedTools = new Set<string>();
  private settledTools = new Set<string>();
  private pendingPermissions = new Set<string>();
  private pendingQuestions = new Set<string>();
  private contextLimits = new Map<string, number>();
  private activeModel = '';
  private latestContextUsage: HarnessContextUsage | null = null;
  private latestUsage: UsageSnapshot | null = null;

  constructor(private binaryPath: string, private launcher: OpenCodeLauncher = launchOpenCodeServer) {}

  get turnInFlight(): boolean { return this._turnInFlight; }
  get cwd(): string | undefined { return this.options?.cwd; }
  get hasPendingPermission(): boolean { return this.pendingPermissions.size > 0 || this.pendingQuestions.size > 0; }
  canIdleReap(): boolean { return !this._turnInFlight && !this.hasPendingPermission; }

  async start(options: HarnessSessionOptions): Promise<void> {
    this.close();
    this.options = options;
    this.closed = false;
    this.resetTurnState();
    this.messageRoles.clear();
    this.partTypes.clear();
    this.completedTextParts.clear();
    this.announcedTools.clear();
    this.settledTools.clear();
    this.ownedSessions.clear();
    this.latestContextUsage = null;
    this.latestUsage = null;
    this.activeModel = options.model ?? '';
    this.resumeFallbackPending = false;

    const mcp = openCodeMcpServers(options.opencode?.mcpServers);
    const hostTools = options.opencode?.dynamicTools ?? [];
    if (hostTools.length > 0) {
      const bridge = new OpenCodeHostToolsBridge(hostTools, {
        permissionMode: () => this.options?.permissionMode ?? 'default',
        requestPermission: (toolName, detail) => this.options?.callbacks.onPermissionRequest(toolName, detail) ?? Promise.resolve(false),
      });
      await bridge.start();
      this.bridge = bridge;
      mcp[OPENCODE_HOST_TOOLS_SERVER] = { type: 'remote', url: bridge.url, headers: bridge.headers, oauth: false, enabled: true };
    }

    try {
      this.transport = await this.launcher({
        binaryPath: this.binaryPath,
        cwd: options.cwd,
        env: { ...process.env, ...parseExtraEnv(options.extraEnvRaw), ...(options.secretEnv ?? {}) },
        config: {
          permission: openCodePermissionConfig(),
          ...(Object.keys(mcp).length > 0 ? { mcp } : {}),
        },
      });
    } catch (error) {
      this.close();
      throw error;
    }
    this.transport.subscribe(
      (event) => this.handleEvent(event),
      (error) => {
        if (this.closed) return;
        const failure = error ?? new Error('OpenCode event stream closed');
        this.resetTurnState();
        this.options?.callbacks.onError(failure);
      },
    );

    let sessionId: string | undefined;
    if (options.resume) {
      const existing = await this.transport.request('GET', `/session/${encodeURIComponent(options.resume)}`);
      if (existing.status === 200 && existing.body?.id) sessionId = String(existing.body.id);
      else {
        this.resumeFallbackPending = true;
        console.warn('[ClaudeThreads] Could not resume OpenCode session; starting a new one:', existing.status);
      }
    }
    if (!sessionId) {
      const created = await this.transport.request('POST', '/session', { title: 'Agent Threads' });
      if (created.status !== 200 || !created.body?.id) {
        this.close();
        throw new Error(`OpenCode could not create a session (${created.status}): ${JSON.stringify(created.body ?? '').slice(0, 300)}`);
      }
      sessionId = String(created.body.id);
    }
    this.sessionId = sessionId;
    this.ownedSessions.add(sessionId);
    void this.discoverModels();
  }

  private async discoverModels(): Promise<void> {
    try {
      const result = await this.transport?.request('GET', '/config/providers');
      const providers: Array<{ id?: string; name?: string; models?: Record<string, { id?: string; name?: string; limit?: { context?: number } }> }> = result?.body?.providers ?? [];
      const models: Array<{ value: string; displayName: string; description: string }> = [];
      for (const provider of providers) {
        if (!provider?.id) continue;
        for (const [key, model] of Object.entries(provider.models ?? {})) {
          const value = `${provider.id}/${model.id ?? key}`;
          if (model.limit?.context) this.contextLimits.set(value, model.limit.context);
          models.push({ value, displayName: `${provider.name ?? provider.id}: ${model.name ?? model.id ?? key}`, description: '' });
        }
      }
      if (models.length > 0) this.options?.callbacks.onCapabilitiesDiscovered?.(models as any, []);
    } catch (error) {
      console.warn('[ClaudeThreads] Could not list OpenCode models:', error);
    }
  }

  async setModel(model: string | undefined): Promise<void> {
    if (model !== undefined && !parseOpenCodeModel(model)) {
      throw new Error(`OpenCode models use provider/model IDs (for example openai/gpt-5); got "${model}".`);
    }
    if (this.options) this.options.model = model;
    if (model) this.activeModel = model;
  }

  async setPermissionMode(mode: HarnessPermissionMode): Promise<void> {
    // Applied per request: the next permission.asked and prompt agent read it live.
    if (this.options) this.options.permissionMode = mode;
  }

  send(text: string, images?: ImageAttachment[], _userMessageUuid?: string): void {
    if (this.closed || !this.sessionId) throw new Error('OpenCode session is not running');
    if (this._turnInFlight) {
      this.queuedTurns.push({ text, images });
      return;
    }
    const history = this.options?.resumeFallbackHistory;
    const effectiveText = this.resumeFallbackPending && history ? history + text : text;
    this.resumeFallbackPending = false;
    this.startTurn(effectiveText, images);
  }

  private startTurn(text: string, images?: ImageAttachment[]): void {
    const options = this.options;
    if (!options || !this.transport || !this.sessionId) return;
    this._turnInFlight = true;
    this.turnSawBusy = false;
    this.turnError = null;
    this.turnCost = 0;
    const mode = options.permissionMode ?? 'default';
    const model = parseOpenCodeModel(options.model);
    const parts: Array<Record<string, unknown>> = [{ type: 'text', text }];
    for (const [index, image] of (images ?? []).entries()) {
      parts.push({ type: 'file', mime: image.mediaType, filename: `image-${index + 1}`, url: `data:${image.mediaType};base64,${image.base64}` });
    }
    const body = {
      parts,
      agent: openCodeAgentForMode(mode),
      ...(model ? { model } : {}),
      ...(options.appendSystemPrompt ? { system: options.appendSystemPrompt } : {}),
    };
    if (mode === 'plan') options.callbacks.onEnterPlanMode?.();
    this.transport.request('POST', `/session/${encodeURIComponent(this.sessionId)}/prompt_async`, body)
      .then((response) => {
        if (response.status >= 300) {
          throw new Error(`OpenCode rejected the prompt (${response.status}): ${JSON.stringify(response.body ?? '').slice(0, 300)}`);
        }
      })
      .catch((error) => {
        if (!this._turnInFlight) return;
        this.resetTurnState();
        options.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      });
  }

  async interrupt(): Promise<void> {
    if (!this.sessionId || !this._turnInFlight || !this.transport) return;
    this.queuedTurns = [];
    await this.transport.request('POST', `/session/${encodeURIComponent(this.sessionId)}/abort`);
  }

  close(): void {
    this.closed = true;
    this.resetTurnState();
    if (this.pendingQuestions.size > 0) {
      this.pendingQuestions.clear();
      this.options?.callbacks.onAskUserQuestionCanceled?.();
    }
    this.pendingPermissions.clear();
    this.transport?.close();
    this.transport = null;
    this.bridge?.close();
    this.bridge = null;
  }

  async getContextUsage(): Promise<HarnessContextUsage | null> { return this.latestContextUsage; }

  async getUsageSnapshot(_includeAccountUsage = false): Promise<UsageSnapshot | null> { return this.latestUsage; }

  private resetTurnState(): void {
    this._turnInFlight = false;
    this.turnSawBusy = false;
    this.turnError = null;
    this.queuedTurns = [];
  }

  // ── Event mapping ────────────────────────────────────────────────────────

  /** Public for tests: route one SSE event to the session callbacks. */
  handleEvent(event: OpenCodeEvent): void {
    const callbacks = this.options?.callbacks;
    if (!callbacks || this.closed) return;
    const props = event.properties ?? {};
    // Token deltas are covered by the completed part; heartbeats and plugin/catalog
    // chatter carry no thread information. Keeping them out bounds raw-log size.
    if (!OPENCODE_UNLOGGED_EVENTS.has(event.type)) {
      callbacks.onRawEvent?.({ type: `opencode/${event.type}`, ...(props as Record<string, unknown>) });
    }

    if (event.type === 'session.created' || event.type === 'session.updated') {
      const info = props.info ?? {};
      if (info.parentID && this.ownedSessions.has(String(info.parentID))) this.ownedSessions.add(String(info.id));
      return;
    }
    const eventSession = props.sessionID ? String(props.sessionID) : undefined;
    if (!eventSession || !this.ownedSessions.has(eventSession)) return;
    const isRoot = eventSession === this.sessionId;

    switch (event.type) {
      case 'message.updated': {
        const info = props.info ?? {};
        if (info.id && info.role) this.messageRoles.set(String(info.id), String(info.role));
        // Turn cost is summed from step-finish parts; here we only track the live model.
        if (isRoot && info.role === 'assistant' && info.providerID && info.modelID) {
          this.activeModel = `${info.providerID}/${info.modelID}`;
        }
        break;
      }
      case 'message.part.updated':
        this.handlePart(props.part ?? {}, isRoot, callbacks);
        break;
      case 'message.part.delta': {
        if (!isRoot || props.field !== 'text') break;
        if (this.messageRoles.get(String(props.messageID)) !== 'assistant') break;
        if (this.partTypes.get(String(props.partID)) !== 'text') break;
        if (typeof props.delta === 'string' && props.delta) callbacks.onToken(props.delta);
        break;
      }
      case 'permission.asked':
        this.handlePermission(props, callbacks);
        break;
      case 'permission.replied':
        this.pendingPermissions.delete(String(props.requestID ?? props.permissionID ?? ''));
        break;
      case 'question.asked':
        this.handleQuestion(props, callbacks);
        break;
      case 'question.replied':
      case 'question.rejected':
        if (this.pendingQuestions.delete(String(props.requestID ?? ''))) callbacks.onAskUserQuestionCanceled?.();
        break;
      case 'todo.updated': {
        if (!isRoot || !Array.isArray(props.todos)) break;
        const tasks = props.todos.flatMap((todo: { content?: unknown; status?: unknown }) => {
          const status = todoStatus(todo?.status);
          return typeof todo?.content === 'string' && todo.content.trim() && status ? [{ content: todo.content, status }] : [];
        });
        callbacks.onTaskEvent?.({ kind: 'replace', tasks });
        break;
      }
      case 'session.status': {
        if (!isRoot) break;
        const status = props.status ?? {};
        if (status.type === 'busy' && this._turnInFlight) this.turnSawBusy = true;
        if (status.type === 'retry') {
          callbacks.onApiRetry?.(Number(status.attempt ?? 0), 0, String(status.message ?? 'retrying'));
        }
        break;
      }
      case 'session.compacted':
        if (isRoot) callbacks.onCompact?.('auto', this.latestContextUsage?.totalTokens ?? 0);
        break;
      case 'session.error': {
        if (!isRoot) break;
        const error = props.error ?? {};
        const aborted = error.name === 'MessageAbortedError';
        const message = String(error.data?.message ?? error.message ?? error.name ?? 'OpenCode turn failed');
        this.turnError = { aborted, message };
        // A prompt rejected before the loop started never produces busy/idle.
        if (this._turnInFlight && !this.turnSawBusy) this.finishTurn(callbacks);
        break;
      }
      case 'session.idle':
        if (isRoot && this._turnInFlight && (this.turnSawBusy || this.turnError)) this.finishTurn(callbacks);
        break;
    }
  }

  private handlePart(part: any, isRoot: boolean, callbacks: SessionCallbacks): void {
    const partId = part.id ? String(part.id) : undefined;
    if (!partId) return;
    if (part.type) this.partTypes.set(partId, String(part.type));
    const role = this.messageRoles.get(String(part.messageID));
    if (role === 'user') return;

    if (part.type === 'text' && isRoot) {
      // An aborted turn can finalize its partial text part after session.error;
      // the streamed tokens already cover it, so do not append a late message.
      if (!this._turnInFlight) return;
      if (part.time?.end && typeof part.text === 'string' && part.text.trim() && !part.synthetic && !this.completedTextParts.has(partId)) {
        this.completedTextParts.add(partId);
        callbacks.onMessage(part.text, []);
      }
      return;
    }
    if (part.type === 'step-finish' && isRoot) {
      if (typeof part.cost === 'number') this.turnCost += part.cost;
      if (part.tokens) this.applyTokens(part.tokens as OpenCodeStepTokens, callbacks);
      return;
    }
    if (part.type !== 'tool') return;
    const callId = String(part.callID ?? partId);
    const tool = String(part.tool ?? 'tool');
    const state = part.state ?? {};
    const status = String(state.status ?? '');
    if (status === 'pending') return; // input is not known yet
    if (!this.announcedTools.has(callId)) {
      this.announcedTools.add(callId);
      callbacks.onToolUse({
        toolUseId: callId,
        name: openCodeToolName(tool),
        summary: openCodeToolSummary(tool, state.input, state.title),
        status: 'pending',
        timestamp: Date.now(),
      });
    }
    if ((status === 'completed' || status === 'error') && !this.settledTools.has(callId)) {
      this.settledTools.add(callId);
      const start = Number(state.time?.start);
      const end = Number(state.time?.end);
      const duration = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
      if (status === 'completed' && FILE_EDIT_TOOLS.has(tool)) {
        const filePath = state.input?.filePath ?? state.input?.path;
        if (typeof filePath === 'string' && filePath) callbacks.onFilesEdited?.([filePath]);
      }
      callbacks.onToolResult?.(callId, status === 'completed' ? 'success' : 'error', duration);
    }
  }

  private applyTokens(tokens: OpenCodeStepTokens, callbacks: SessionCallbacks): void {
    this.latestContextUsage = openCodeContextUsage(tokens, this.contextLimits.get(this.activeModel), this.activeModel);
    const totals = {
      total: tokens.total,
      input: tokens.input,
      output: tokens.output,
      cachedInput: tokens.cache?.read,
      cacheWriteInput: tokens.cache?.write,
      reasoning: tokens.reasoning,
    };
    this.latestUsage = mergeUsageSnapshot(this.latestUsage, {
      provider: HARNESS, updatedAt: Date.now(), quotaWindows: [], lastTurnTokens: totals,
    });
    callbacks.onUsage?.(this.latestUsage);
  }

  private finishTurn(callbacks: SessionCallbacks): void {
    const error = this.turnError;
    const cost = this.turnCost;
    this._turnInFlight = false;
    this.turnSawBusy = false;
    this.turnError = null;
    this.turnCost = 0;
    const sessionId = this.sessionId ?? '';
    if (error?.aborted) {
      this.queuedTurns = [];
      callbacks.onInterrupted(sessionId);
      return;
    }
    if (error) {
      this.queuedTurns = [];
      callbacks.onError(new Error(error.message));
      return;
    }
    callbacks.onDone(sessionId, cost, 1);
    const next = this.queuedTurns.shift();
    if (next && !this.closed) this.startTurn(next.text, next.images);
  }

  private handlePermission(props: any, callbacks: SessionCallbacks): void {
    const requestId = String(props.id ?? '');
    if (!requestId || !this.transport) return;
    const permission = String(props.permission ?? 'tool');
    const reply = (decision: 'once' | 'reject', message?: string) => {
      this.pendingPermissions.delete(requestId);
      void this.transport?.request('POST', `/permission/${encodeURIComponent(requestId)}/reply`, {
        reply: decision, ...(message ? { message } : {}),
      }).catch((error) => console.warn('[ClaudeThreads] Could not answer OpenCode permission:', error));
    };
    const decision = resolveOpenCodePermission(this.options?.permissionMode ?? 'default', permission);
    if (decision === 'allow') { reply('once'); return; }
    if (decision === 'deny') { reply('reject', `${permission} is not allowed in the current permission mode.`); return; }
    this.pendingPermissions.add(requestId);
    const metadata = props.metadata ?? {};
    const patterns: string[] = Array.isArray(props.patterns) ? props.patterns.map(String) : [];
    const detail = String(metadata.command ?? metadata.filepath ?? metadata.filePath ?? metadata.url ?? patterns.join('\n') ?? permission)
      + (typeof metadata.diff === 'string' && metadata.diff ? `\n\n${metadata.diff.slice(0, 4000)}` : '');
    callbacks.onPermissionRequest(`OpenCode: ${openCodeToolName(permission)}`, detail || permission)
      .then((allow) => reply(allow ? 'once' : 'reject', allow ? undefined : 'Denied by the user.'))
      .catch(() => reply('reject', 'Denied by the user.'));
  }

  private handleQuestion(props: any, callbacks: SessionCallbacks): void {
    const requestId = String(props.id ?? '');
    if (!requestId || !this.transport) return;
    const rawQuestions: any[] = Array.isArray(props.questions) ? props.questions : [];
    const questions: AskQuestion[] = rawQuestions.map((question, index) => ({
      id: String(index),
      header: typeof question?.header === 'string' ? question.header : '',
      question: String(question?.question ?? ''),
      options: (Array.isArray(question?.options) ? question.options : []).map((option: any) => ({
        label: String(option?.label ?? ''),
        description: typeof option?.description === 'string' ? option.description : '',
      })),
      multiSelect: question?.multiple === true,
      allowOther: question?.custom !== false,
      source: HARNESS,
    }));
    const reject = () => {
      void this.transport?.request('POST', `/question/${encodeURIComponent(requestId)}/reject`)
        .catch((error) => console.warn('[ClaudeThreads] Could not reject OpenCode question:', error));
    };
    if (questions.length === 0 || !callbacks.onAskUserQuestion) { reject(); return; }
    this.pendingQuestions.add(requestId);
    callbacks.onAskUserQuestion(questions)
      .then((answers) => {
        if (!this.pendingQuestions.delete(requestId)) return;
        const reply = questions.map((question) => {
          const value = String(answers[question.id!] ?? answers[question.question] ?? '').trim();
          if (!value) return [];
          return question.multiSelect ? value.split(',').map((item) => item.trim()).filter(Boolean) : [value];
        });
        void this.transport?.request('POST', `/question/${encodeURIComponent(requestId)}/reply`, { answers: reply })
          .catch((error) => console.warn('[ClaudeThreads] Could not answer OpenCode question:', error));
      })
      .catch(() => {
        if (this.pendingQuestions.delete(requestId)) reject();
      });
  }
}

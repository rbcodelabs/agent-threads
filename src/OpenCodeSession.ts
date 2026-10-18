/**
 * OpenCode harness adapter (https://opencode.ai, MIT).
 *
 * Each session launches its own `opencode serve` on 127.0.0.1 (desktop only),
 * streams the server's SSE feed, and drives its HTTP API. Two API generations
 * are supported, chosen from `opencode --version` and confirmed by the startup
 * banner:
 *
 * - v1 (opencode 1.x, verified 1.18.32): unauthenticated, `/event`,
 *   `POST /session`, `POST /session/:id/prompt_async`, `POST /session/:id/abort`,
 *   `POST /permission/:id/reply` and `POST /question/:id/reply`.
 * - v2 (opencode 2.x, verified 2.0.32): everything under `/api/*` with HTTP Basic
 *   auth (user `opencode`, password printed in the banner as `server password`),
 *   events shaped `{id,type,data}`, sessions bound to `location.directory`,
 *   model/agent/system prompt set on the session rather than per prompt, and
 *   questions delivered as forms. The OpenAPI document is served at
 *   `/openapi.json`, but the SSE event union is not published, so event shapes
 *   were recorded live (fixtures in test/fixtures/opencode-v2).
 *
 * v2 events are translated into the v1 event shape by one adapter
 * (OpenCodeV2EventAdapter) so the session logic below is shared.
 *
 * Like CodexSession, payloads are kept structural rather than bundling the
 * generated `@opencode-ai/sdk` types: the server is the user's installed CLI,
 * so a vendored type snapshot would drift. v1 shapes were verified live against
 * `opencode-ai@1.18.32` (see ADR-0013 in Compass:
 * https://compass.rbcodelabs.com/rbcodelabs/claude-threads/docs/d7b8c236-d8ac-48a4-a8e4-6524ff74e886).
 *
 * Node built-ins are required lazily so importing this module stays inert on
 * mobile, where HarnessFactory is never reached.
 */
import type { ChildProcess } from 'child_process';
import { formatCurrentTimeContext, shouldAddCurrentTimeContext } from './currentTimeContext';
import type { AgentHarness, AskQuestion, ImageAttachment, TaskItemStatus } from './types';
import { parseExtraEnv } from './types';
import { isShellDenied } from './toolRestrictions';
import type { SessionCallbacks } from './ClaudeSession';
import type {
  HarnessContextUsage,
  HarnessMcpServerConfig,
  HarnessPermissionMode,
  HarnessSessionOptions,
} from './HarnessSession';
import { mergeUsageSnapshot, type UsageSnapshot } from './Usage';
import { OPENCODE_HOST_TOOLS_SERVER, OpenCodeHostToolsBridge } from './OpenCodeHostTools';

/** The newest CLI release whose HTTP/SSE shapes this adapter was verified against. */
export const OPENCODE_VERIFIED_VERSION = '2.0.32';
/** The last verified release of the v1 (unauthenticated, `/session`) API generation. */
export const OPENCODE_V1_VERIFIED_VERSION = '1.18.32';

/** Which `opencode serve` HTTP API a transport speaks. */
export type OpenCodeApiGeneration = 'v1' | 'v2';
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
export function openCodePermissionConfig(disallowedTools?: readonly string[]): Record<string, 'ask' | 'allow' | 'deny'> {
  const config: Record<string, 'ask' | 'allow' | 'deny'> = { '*': 'ask' };
  for (const permission of OPENCODE_READ_ONLY_PERMISSIONS) config[permission] = 'allow';
  config[`${OPENCODE_HOST_TOOLS_SERVER}_*`] = 'allow';
  // Per-thread denylist (restriction-only): OpenCode's native `deny` refuses
  // the shell tool outright, before any prompt.
  if (isShellDenied(disallowedTools)) config.bash = 'deny';
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

/**
 * v2 `permissions` config: an ordered rule list where later rules override
 * earlier ones (verified: a trailing `shell deny` removed the shell tool).
 * Same policy as openCodePermissionConfig, in the v2 schema. v2 renamed the
 * `bash` action to `shell`; both are denied so the rule survives either name.
 */
export function openCodePermissionRules(disallowedTools?: readonly string[]): Array<{ action: string; resource: string; effect: 'ask' | 'allow' | 'deny' }> {
  const rules: Array<{ action: string; resource: string; effect: 'ask' | 'allow' | 'deny' }> = [{ action: '*', resource: '*', effect: 'ask' }];
  for (const permission of OPENCODE_READ_ONLY_PERMISSIONS) rules.push({ action: permission, resource: '*', effect: 'allow' });
  rules.push({ action: `${OPENCODE_HOST_TOOLS_SERVER}_*`, resource: '*', effect: 'allow' });
  if (isShellDenied(disallowedTools)) {
    rules.push({ action: 'shell', resource: '*', effect: 'deny' }, { action: 'bash', resource: '*', effect: 'deny' });
  }
  return rules;
}

/**
 * Convert v1-style `mcp` entries (see openCodeMcpServers) to the v2
 * `mcp.servers` schema: `enabled` became `disabled`, and `timeout` became an
 * object of phase timeouts, so the v1 number is dropped rather than guessed.
 */
export function openCodeMcpServersV2(mcp: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(mcp)) {
    const { enabled, timeout: _timeout, ...rest } = entry as Record<string, unknown>;
    result[name] = enabled === false ? { ...rest, disabled: true } : rest;
  }
  return result;
}

/** The full `OPENCODE_CONFIG_CONTENT` for a v2 server. */
export function openCodeConfigV2(disallowedTools: readonly string[] | undefined, mcp: Record<string, unknown>): Record<string, unknown> {
  return {
    permissions: openCodePermissionRules(disallowedTools),
    ...(Object.keys(mcp).length > 0 ? { mcp: { servers: openCodeMcpServersV2(mcp) } } : {}),
  };
}

/** Pick the API generation from `opencode --version` output; undefined when unparseable. */
export function openCodeGenerationFromVersion(output: string): OpenCodeApiGeneration | undefined {
  const match = output.match(/(\d+)\.\d+\.\d+/);
  if (!match) return undefined;
  return Number(match[1]) >= 2 ? 'v2' : 'v1';
}

/** Parse the `opencode serve` startup banner: the listen URL and, on v2, the Basic-auth password. */
export function parseOpenCodeBanner(output: string): { baseUrl?: string; password?: string } {
  const url = output.match(/(?:opencode )?server listening on (https?:\/\/\S+)/);
  const password = output.match(/server password (\S+)/);
  return { baseUrl: url?.[1], password: password?.[1] };
}

/** v2 authenticates every `/api/*` request with HTTP Basic, user `opencode`. */
export function openCodeAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

/** Pull the JSON payload out of one SSE frame (undefined for comments such as heartbeats). */
export function openCodeSseData(frame: string): string | undefined {
  const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
  return data || undefined;
}

/** Appended to API failures so a CLI/plugin version mismatch is obvious to the user. */
function openCodeCompatibilityHint(): string {
  return ` The plugin is verified against OpenCode ${OPENCODE_V1_VERIFIED_VERSION} and ${OPENCODE_VERIFIED_VERSION}; check \`opencode --version\` and update the plugin or OpenCode if they differ.`;
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
  bash: 'Bash', shell: 'Bash', execute: 'Execute', read: 'Read', edit: 'Edit', write: 'Write', patch: 'Edit', apply_patch: 'Edit', multiedit: 'MultiEdit',
  glob: 'Glob', grep: 'Grep', list: 'LS', webfetch: 'WebFetch', websearch: 'WebSearch', todowrite: 'TodoWrite',
  todoread: 'TodoRead', task: 'Agent', question: 'AskUserQuestion', skill: 'Skill',
};

export function openCodeToolName(tool: string): string {
  const hostPrefix = `${OPENCODE_HOST_TOOLS_SERVER}_`;
  if (tool.startsWith(hostPrefix)) return tool.slice(hostPrefix.length);
  return OPENCODE_TOOL_NAMES[tool] ?? tool;
}

export function openCodeToolSummary(tool: string, input: Record<string, unknown> | undefined, title?: string): string {
  // `code` is the v2 "execute" tool's script; show only its first line.
  const code = typeof input?.code === 'string' ? input.code.trim().split('\n')[0].slice(0, 160) : undefined;
  const value = input?.command ?? input?.filePath ?? input?.path ?? input?.pattern ?? input?.url ?? input?.query ?? input?.description ?? code;
  if (typeof value === 'string' && value.trim()) return value;
  if (title && title.trim()) return title;
  return openCodeToolName(tool);
}

const OPENCODE_UNLOGGED_EVENTS = new Set([
  'message.part.delta', 'server.heartbeat', 'server.connected', 'plugin.added', 'catalog.updated',
  'reference.updated', 'integration.updated', 'lsp.updated', 'file.watcher.updated',
  // v2 chatter: streaming deltas are covered by the *.ended events.
  'session.text.delta', 'session.reasoning.delta', 'session.tool.input.delta', 'session.step.streamed',
  'session.usage.updated', 'session.tool.progress', 'session.instructions.updated', 'project.updated',
  'provider.updated', 'model.updated', 'agent.updated', 'command.updated', 'skill.updated',
  'websearch.updated', 'shell.created', 'shell.exited',
]);

const FILE_EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'apply_patch', 'multiedit']);

function todoStatus(status: unknown): TaskItemStatus | null {
  if (status === 'pending' || status === 'completed') return status;
  if (status === 'in_progress') return 'in_progress';
  return null; // cancelled and unknown statuses leave the tracker
}

// ── v2 event adapter ───────────────────────────────────────────────────────

/**
 * Translate recorded v2 `{id,type,data}` events into the v1 event shape the
 * session logic consumes. Stateful only to carry what v2 splits across events:
 * a tool's name (announced on `session.tool.input.started`) and input
 * (`session.tool.called`) are needed when it completes. Reasoning, usage
 * totals, inbox and housekeeping events are intentionally dropped (still
 * written to the raw log by the session).
 */
export class OpenCodeV2EventAdapter {
  private toolNames = new Map<string, string>();
  private toolInputs = new Map<string, Record<string, unknown>>();
  private toolStarts = new Map<string, number>();

  adapt(event: OpenCodeEvent): OpenCodeEvent[] {
    const data = event.data ?? {};
    const sessionID: string | undefined = data.sessionID ?? data.form?.sessionID;
    const messageID: string | undefined = data.assistantMessageID;
    const at = typeof event.created === 'number' ? event.created : Date.now();
    switch (event.type) {
      case 'session.created':
        return [{ type: 'session.created', properties: { sessionID, info: { id: sessionID, parentID: data.parentID } } }];
      case 'session.execution.started':
        return [{ type: 'session.status', properties: { sessionID, status: { type: 'busy' } } }];
      case 'session.execution.succeeded':
        return [{ type: 'session.idle', properties: { sessionID } }];
      case 'session.execution.failed':
        // v2 reports failure and idle as one event; v1 needs an error then an idle.
        return [
          { type: 'session.error', properties: { sessionID, error: { name: data.error?.type ?? 'Error', message: data.error?.message } } },
          { type: 'session.idle', properties: { sessionID } },
        ];
      case 'session.execution.interrupted':
        return [
          { type: 'session.error', properties: { sessionID, error: { name: 'MessageAbortedError', message: 'Aborted' } } },
          { type: 'session.idle', properties: { sessionID } },
        ];
      case 'session.retry.scheduled':
        return [{ type: 'session.status', properties: { sessionID, status: { type: 'retry', attempt: data.attempt ?? data.retry?.attempt, message: data.error?.message ?? data.message } } }];
      case 'session.compaction.ended':
        return [{ type: 'session.compacted', properties: { sessionID } }];
      case 'session.step.started':
        return [{ type: 'message.updated', properties: { sessionID, info: { id: messageID, role: 'assistant', providerID: data.model?.providerID, modelID: data.model?.id } } }];
      case 'session.step.ended':
        return [{ type: 'message.part.updated', properties: { sessionID, part: {
          id: `${messageID}:finish`, messageID, type: 'step-finish', cost: data.cost, tokens: data.tokens,
        } } }];
      case 'session.text.started':
        return [{ type: 'message.part.updated', properties: { sessionID, part: { id: `${messageID}:text:${data.ordinal ?? 0}`, messageID, type: 'text', text: '' } } }];
      case 'session.text.delta':
        return [{ type: 'message.part.delta', properties: { sessionID, messageID, partID: `${messageID}:text:${data.ordinal ?? 0}`, field: 'text', delta: data.delta } }];
      case 'session.text.ended':
        return [{ type: 'message.part.updated', properties: { sessionID, part: {
          id: `${messageID}:text:${data.ordinal ?? 0}`, messageID, type: 'text', text: data.text, time: { end: at },
        } } }];
      case 'session.tool.input.started':
        if (typeof data.id === 'string') this.toolNames.set(data.id, String(data.name ?? 'tool'));
        return [];
      case 'session.tool.called': {
        const input = (data.input && typeof data.input === 'object' ? data.input : {}) as Record<string, unknown>;
        this.toolInputs.set(String(data.id), input);
        this.toolStarts.set(String(data.id), at);
        return [this.toolPart(sessionID, messageID, String(data.id), { status: 'running', input, time: { start: at } })];
      }
      case 'session.tool.success':
      case 'session.tool.failed': {
        const id = String(data.id);
        const failed = event.type === 'session.tool.failed';
        const out = this.toolPart(sessionID, messageID, id, {
          status: failed ? 'error' : 'completed',
          input: this.toolInputs.get(id) ?? {},
          ...(failed ? { error: data.error?.message } : {}),
          time: { start: this.toolStarts.get(id) ?? at, end: at },
        });
        this.toolNames.delete(id);
        this.toolInputs.delete(id);
        this.toolStarts.delete(id);
        return [out];
      }
      case 'permission.asked':
        return [{ type: 'permission.asked', properties: {
          id: data.id, sessionID, permission: data.action, patterns: data.resources ?? [], metadata: data.metadata ?? {},
        } }];
      case 'permission.replied':
        return [{ type: 'permission.replied', properties: { sessionID, requestID: data.requestID, reply: data.reply } }];
      case 'form.created':
        return this.questionAsked(data.form);
      case 'form.replied':
        return [{ type: 'question.replied', properties: { sessionID, requestID: data.id } }];
      case 'form.cancelled':
        return [{ type: 'question.rejected', properties: { sessionID, requestID: data.id } }];
      default:
        return [];
    }
  }

  private toolPart(sessionID: string | undefined, messageID: string | undefined, callId: string, state: Record<string, unknown>): OpenCodeEvent {
    return { type: 'message.part.updated', properties: { sessionID, part: {
      id: `tool:${callId}`, messageID, type: 'tool', callID: callId, tool: this.toolNames.get(callId) ?? 'tool', state,
    } } };
  }

  /** v2 delivers the question tool as a form; other form kinds are not answerable here. */
  private questionAsked(form: any): OpenCodeEvent[] {
    if (!form || form.metadata?.kind !== 'question' || !Array.isArray(form.fields)) return [];
    const fields: any[] = form.fields;
    return [{ type: 'question.asked', properties: {
      id: form.id,
      sessionID: form.sessionID,
      fieldKeys: fields.map((field) => String(field.key)),
      questions: fields.map((field) => ({
        header: field.title ?? '',
        question: field.description ?? field.title ?? '',
        multiple: field.type === 'multiselect',
        custom: field.custom !== false,
        options: (Array.isArray(field.options) ? field.options : []).map((option: any) => ({
          label: option.label ?? option.value, value: option.value, description: option.description,
        })),
      })),
    } }];
  }
}

// ── Transport ──────────────────────────────────────────────────────────────

/** Minimal HTTP/SSE client for one `opencode serve` instance. */
export interface OpenCodeTransport {
  /** API generation of the server behind this transport; absent means v1. */
  readonly generation?: OpenCodeApiGeneration;
  request(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; body: any }>;
  /** Subscribe to the event stream; `onClose` fires if the stream ends unexpectedly. */
  subscribe(onEvent: (event: OpenCodeEvent) => void, onClose: (error?: Error) => void): void;
  close(): void;
}

/** One SSE event: v1 uses `properties`, v2 uses `data` (plus `created`). */
export interface OpenCodeEvent {
  type: string;
  properties?: any;
  data?: any;
  created?: number;
}

export type OpenCodeLauncher = (options: {
  binaryPath: string;
  cwd: string;
  env: Record<string, string | undefined>;
  /** `OPENCODE_CONFIG_CONTENT` for a v1 server. */
  config: Record<string, unknown>;
  /** `OPENCODE_CONFIG_CONTENT` for a v2 server (the v1 shape is silently ignored there). */
  configV2?: Record<string, unknown>;
}) => Promise<OpenCodeTransport>;

/** Ask the binary which API generation it serves; undefined when it cannot be determined. */
async function detectOpenCodeGeneration(binaryPath: string, env: Record<string, string | undefined>): Promise<OpenCodeApiGeneration | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execFile } = require('child_process') as typeof import('child_process');
  return new Promise((resolve) => {
    execFile(binaryPath, ['--version'], { env: env as NodeJS.ProcessEnv, timeout: 10_000 }, (error, stdout) => {
      resolve(error ? undefined : openCodeGenerationFromVersion(String(stdout)));
    });
  });
}

/** Launch `opencode serve` and return a Node http transport bound to the session directory. */
export const launchOpenCodeServer: OpenCodeLauncher = async ({ binaryPath, cwd, env, config, configV2 }) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawn } = require('child_process') as typeof import('child_process');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http = require('http') as typeof import('http');
  // The config shape differs per generation and is fixed at spawn time, so the
  // version has to be known first. When it cannot be read, assume v1 and let the
  // banner (v2 prints a password) catch a mismatch below.
  const detected = await detectOpenCodeGeneration(binaryPath, env);
  const expected: OpenCodeApiGeneration = detected ?? 'v1';
  const child: ChildProcess = spawn(binaryPath, ['serve', '--hostname=127.0.0.1', '--port=0'], {
    cwd,
    env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(expected === 'v2' ? (configV2 ?? config) : config) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const started = await new Promise<{ baseUrl: string; password?: string }>((resolve, reject) => {
    let output = '';
    let settled = false;
    const finish = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); if (grace) clearTimeout(grace); action(); };
    const timer = setTimeout(() => {
      finish(() => { child.kill(); reject(new Error(`opencode serve did not start within ${SERVER_START_TIMEOUT_MS / 1000}s`)); });
    }, SERVER_START_TIMEOUT_MS);
    let grace: ReturnType<typeof setTimeout> | undefined;
    const check = (final: boolean) => {
      const { baseUrl, password } = parseOpenCodeBanner(output);
      if (!baseUrl) return;
      // v2 prints the password on the line after the URL and v1 prints none, so
      // wait briefly for it before concluding which generation answered.
      if (!password && !final) { grace ??= setTimeout(() => check(true), 500); return; }
      finish(() => resolve({ baseUrl, password }));
    };
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); check(false); });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.once('error', (error) => {
      finish(() => reject(new Error(`Could not launch OpenCode at "${binaryPath}": ${error.message}. Install OpenCode (https://opencode.ai) or set its path in Settings.`)));
    });
    child.once('exit', (code) => {
      finish(() => reject(new Error(`opencode serve exited (${code ?? 'unknown'})${output.trim() ? `: ${output.trim().slice(-500)}` : ''}`)));
    });
  });
  const generation: OpenCodeApiGeneration = started.password ? 'v2' : 'v1';
  if (generation !== expected) {
    // The config was shaped for the other generation, which the server silently
    // ignores; its default policy would then run tools without asking. Refuse
    // rather than continue unprotected.
    child.kill();
    throw new Error(`\`${binaryPath} --version\` ${detected ? `reported OpenCode ${detected}` : 'could not be read'}, but the server speaks the ${generation} API.${openCodeCompatibilityHint()}`);
  }
  const { baseUrl, password } = started;
  child.stderr?.on('data', (chunk: Buffer) => console.warn('[ClaudeThreads] opencode serve:', chunk.toString().trim()));

  const authHeaders: Record<string, string> = password ? { authorization: openCodeAuthHeader(password) } : {};
  const url = (path: string) => {
    const target = new URL(path, baseUrl);
    // v1 scopes requests with ?directory=; v2 binds the directory to the session at creation.
    if (generation === 'v1') target.searchParams.set('directory', cwd);
    return target;
  };
  let eventRequest: import('http').ClientRequest | null = null;
  let closed = false;
  return {
    generation,
    request(method, path, body) {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      return new Promise((resolve, reject) => {
        const req = http.request(url(path), {
          method,
          headers: payload
            ? { ...authHeaders, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : { ...authHeaders },
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
      eventRequest = http.get(url(generation === 'v2' ? '/api/event' : '/event'), { headers: { ...authHeaders, accept: 'text/event-stream' } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          if (!closed) onClose(new Error(`OpenCode event stream returned HTTP ${res.statusCode}.${openCodeCompatibilityHint()}`));
          return;
        }
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let index: number;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const data = openCodeSseData(frame);
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
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        // Never leave an orphaned server behind if SIGTERM is ignored.
        const escalate = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 3000);
        (escalate as { unref?: () => void }).unref?.();
      }
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
  private generation: OpenCodeApiGeneration = 'v1';
  private v2Adapter = new OpenCodeV2EventAdapter();
  /** v2 holds agent/model/system prompt on the session; remember what was last pushed. */
  private applied: { agent?: string; model?: string; system?: string } = {};
  /** v2 turn start (settings sync plus prompt); interrupt waits for it so an early stop cannot be overtaken. */
  private promptInFlight: Promise<void> | null = null;

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
    this.generation = 'v1';
    this.v2Adapter = new OpenCodeV2EventAdapter();
    this.applied = {};
    this.promptInFlight = null;

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
          permission: openCodePermissionConfig(options.disallowedTools),
          ...(Object.keys(mcp).length > 0 ? { mcp } : {}),
        },
        configV2: openCodeConfigV2(options.disallowedTools, mcp),
      });
      this.generation = this.transport.generation ?? 'v1';
    } catch (error) {
      this.close();
      throw error;
    }
    this.transport.subscribe(
      (event) => this.handleRawEvent(event),
      (error) => {
        if (this.closed) return;
        const failure = error ?? new Error('OpenCode event stream closed');
        this.resetTurnState();
        this.options?.callbacks.onError(failure);
      },
    );

    const v2 = this.generation === 'v2';
    let sessionId: string | undefined;
    if (options.resume) {
      const existing = await this.transport.request('GET', v2 ? `/api/session/${encodeURIComponent(options.resume)}` : `/session/${encodeURIComponent(options.resume)}`);
      const existingId = v2 ? existing.body?.data?.id : existing.body?.id;
      if (existing.status === 200 && existingId) sessionId = String(existingId);
      else {
        this.resumeFallbackPending = true;
        console.warn('[ClaudeThreads] Could not resume OpenCode session; starting a new one:', existing.status);
      }
    }
    if (!sessionId) {
      const model = parseOpenCodeModel(options.model);
      const agent = openCodeAgentForMode(options.permissionMode ?? 'default');
      const created = v2
        ? await this.transport.request('POST', '/api/session', {
          title: 'Agent Threads',
          agent,
          ...(model ? { model: { providerID: model.providerID, id: model.modelID } } : {}),
          location: { directory: options.cwd },
        })
        : await this.transport.request('POST', '/session', { title: 'Agent Threads' });
      const createdId = v2 ? created.body?.data?.id : created.body?.id;
      if (created.status !== 200 || !createdId) {
        this.close();
        throw new Error(`OpenCode could not create a session (${created.status}): ${(typeof created.body === 'string' ? created.body : JSON.stringify(created.body ?? '')).slice(0, 300)}.${openCodeCompatibilityHint()}`);
      }
      sessionId = String(createdId);
      if (v2) this.applied = { agent, model: model ? options.model : undefined };
    }
    this.sessionId = sessionId;
    this.ownedSessions.add(sessionId);
    void this.discoverModels();
  }

  private async discoverModelsV2(): Promise<void> {
    // /api/model lists models that are usable now; /api/provider only supplies display names.
    const [modelResult, providerResult] = await Promise.all([
      this.transport?.request('GET', '/api/model'),
      this.transport?.request('GET', '/api/provider').catch(() => undefined),
    ]);
    const providerNames = new Map<string, string>();
    for (const provider of providerResult?.body?.data ?? []) {
      if (provider?.id && provider?.name) providerNames.set(String(provider.id), String(provider.name));
    }
    const models: Array<{ value: string; displayName: string; description: string }> = [];
    for (const model of modelResult?.body?.data ?? []) {
      if (!model?.providerID || !model?.id || model.enabled === false) continue;
      const value = `${model.providerID}/${model.id}`;
      if (model.limit?.context) this.contextLimits.set(value, model.limit.context);
      models.push({ value, displayName: `${providerNames.get(model.providerID) ?? model.providerID}: ${model.name ?? model.id}`, description: '' });
    }
    if (models.length > 0) this.options?.callbacks.onCapabilitiesDiscovered?.(models as any, []);
  }

  private async discoverModels(): Promise<void> {
    try {
      if (this.generation === 'v2') { await this.discoverModelsV2(); return; }
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
    if (this.generation === 'v2') { this.startTurnV2(text, images); return; }
    const model = parseOpenCodeModel(options.model);
    const parts: Array<Record<string, unknown>> = [{ type: 'text', text }];
    for (const [index, image] of (images ?? []).entries()) {
      parts.push({ type: 'file', mime: image.mediaType, filename: `image-${index + 1}`, url: `data:${image.mediaType};base64,${image.base64}` });
    }
    // Per-turn clock as its own text part (see currentTimeContext.ts). A plain
    // part, not `synthetic`, so it is guaranteed to reach the model.
    if (shouldAddCurrentTimeContext(text)) parts.push({ type: 'text', text: formatCurrentTimeContext() });
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

  /**
   * v2 keeps agent, model and system prompt on the session instead of in each
   * prompt, so push any that changed since the last turn, then send the text.
   */
  private startTurnV2(text: string, images?: ImageAttachment[]): void {
    const options = this.options;
    const transport = this.transport;
    const sessionId = this.sessionId;
    if (!options || !transport || !sessionId) return;
    const sid = encodeURIComponent(sessionId);
    const mode = options.permissionMode ?? 'default';
    const agent = openCodeAgentForMode(mode);
    const model = parseOpenCodeModel(options.model);
    const system = options.appendSystemPrompt;
    const files = (images ?? []).map((image, index) => ({ uri: `data:${image.mediaType};base64,${image.base64}`, name: `image-${index + 1}` }));
    // v2 has no separate parts: the per-turn clock (see currentTimeContext.ts) rides in the text.
    const promptText = shouldAddCurrentTimeContext(text) ? `${text}\n\n${formatCurrentTimeContext()}` : text;
    if (mode === 'plan') options.callbacks.onEnterPlanMode?.();
    const ensureOk = (what: string, response: { status: number; body: any }) => {
      if (response.status >= 300) throw new Error(`OpenCode rejected ${what} (${response.status}): ${JSON.stringify(response.body ?? '').slice(0, 300)}`);
    };
    const run = (async () => {
      if (agent !== this.applied.agent) {
        ensureOk('the agent change', await transport.request('POST', `/api/session/${sid}/agent`, { agent }));
        this.applied.agent = agent;
      }
      if (model && options.model !== this.applied.model) {
        ensureOk('the model change', await transport.request('POST', `/api/session/${sid}/model`, { model: { providerID: model.providerID, id: model.modelID } }));
        this.applied.model = options.model;
      }
      if (system && system !== this.applied.system) {
        ensureOk('the system prompt', await transport.request('PUT', `/api/experimental/session/${sid}/instructions/entries/agent-threads`, { value: system }));
        this.applied.system = system;
      }
      ensureOk('the prompt', await transport.request('POST', `/api/session/${sid}/prompt`, { text: promptText, ...(files.length > 0 ? { files } : {}) }));
    })().catch((error) => {
      if (!this._turnInFlight) return;
      this.resetTurnState();
      options.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    });
    this.promptInFlight = run;
    void run.finally(() => { if (this.promptInFlight === run) this.promptInFlight = null; });
  }

  async interrupt(): Promise<void> {
    if (!this.sessionId || !this._turnInFlight || !this.transport) return;
    this.queuedTurns = [];
    await this.promptInFlight;
    if (!this._turnInFlight || !this.transport) return;
    const sid = encodeURIComponent(this.sessionId);
    await this.transport.request('POST', this.generation === 'v2' ? `/api/session/${sid}/interrupt` : `/session/${sid}/abort`);
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

  /** Public for tests: route one wire event (either generation) to the session callbacks. */
  handleRawEvent(event: OpenCodeEvent): void {
    if (this.generation !== 'v2') { this.handleEvent(event); return; }
    const callbacks = this.options?.callbacks;
    if (!callbacks || this.closed) return;
    if (!OPENCODE_UNLOGGED_EVENTS.has(event.type)) {
      callbacks.onRawEvent?.({ type: `opencode/${event.type}`, ...((event.data ?? {}) as Record<string, unknown>) });
    }
    for (const adapted of this.v2Adapter.adapt(event)) this.dispatch(adapted);
  }

  /** Public for tests: route one v1-shaped event to the session callbacks. */
  handleEvent(event: OpenCodeEvent): void {
    const callbacks = this.options?.callbacks;
    if (!callbacks || this.closed) return;
    // Token deltas are covered by the completed part; heartbeats and plugin/catalog
    // chatter carry no thread information. Keeping them out bounds raw-log size.
    if (!OPENCODE_UNLOGGED_EVENTS.has(event.type)) {
      callbacks.onRawEvent?.({ type: `opencode/${event.type}`, ...((event.properties ?? {}) as Record<string, unknown>) });
    }
    this.dispatch(event);
  }

  private dispatch(event: OpenCodeEvent): void {
    const callbacks = this.options?.callbacks;
    if (!callbacks || this.closed) return;
    const props = event.properties ?? {};

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
      const request = this.generation === 'v2' && props.sessionID
        ? this.transport?.request('POST', `/api/session/${encodeURIComponent(String(props.sessionID))}/permission/${encodeURIComponent(requestId)}/reply`, {
          decision, ...(message ? { message } : {}),
        })
        : this.transport?.request('POST', `/permission/${encodeURIComponent(requestId)}/reply`, {
          reply: decision, ...(message ? { message } : {}),
        });
      void request?.catch((error) => console.warn('[ClaudeThreads] Could not answer OpenCode permission:', error));
    };
    // Defence in depth for the per-thread denylist: refuse the shell even if the
    // launch config was not honoured. v2 renamed the `bash` action to `shell`.
    const decision = (permission === 'bash' || permission === 'shell') && isShellDenied(this.options?.disallowedTools)
      ? 'deny'
      : permission.startsWith(`${OPENCODE_HOST_TOOLS_SERVER}_`)
        ? 'allow' // bridged host tools are approved by the MCP bridge itself
        : resolveOpenCodePermission(this.options?.permissionMode ?? 'default', permission);
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
    const v2 = this.generation === 'v2';
    const formPath = `/api/session/${encodeURIComponent(String(props.sessionID ?? this.sessionId ?? ''))}/form/${encodeURIComponent(requestId)}`;
    const reject = () => {
      void (v2 ? this.transport?.request('DELETE', formPath) : this.transport?.request('POST', `/question/${encodeURIComponent(requestId)}/reject`))
        ?.catch((error) => console.warn('[ClaudeThreads] Could not reject OpenCode question:', error));
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
        let request: Promise<unknown> | undefined;
        if (v2) {
          // v2 forms answer by field key; options answer by value, free text as typed.
          const fieldKeys: string[] = Array.isArray(props.fieldKeys) ? props.fieldKeys.map(String) : [];
          const answer: Record<string, string | string[]> = {};
          reply.forEach((labels, index) => {
            const key = fieldKeys[index];
            if (!key || labels.length === 0) return;
            const options: any[] = Array.isArray(rawQuestions[index]?.options) ? rawQuestions[index].options : [];
            const values = labels.map((label) => String(options.find((option) => option?.label === label)?.value ?? label));
            answer[key] = questions[index].multiSelect ? values : values[0];
          });
          request = this.transport?.request('POST', `${formPath}/reply`, { answer });
        } else {
          request = this.transport?.request('POST', `/question/${encodeURIComponent(requestId)}/reply`, { answers: reply });
        }
        void request?.catch((error) => console.warn('[ClaudeThreads] Could not answer OpenCode question:', error));
      })
      .catch(() => {
        if (this.pendingQuestions.delete(requestId)) reject();
      });
  }
}

/**
 * Antigravity harness adapter (Google's Antigravity CLI, `agy acp`).
 *
 * Each session launches its own `agy acp` child and drives it over the Agent Client Protocol (see AcpClient):
 * NDJSON JSON-RPC on stdio, protocol version 1. Verified against the real CLI 1.1.13 (ACP server 1.5.8 / 1.5.9); frames
 * recorded from it live in test/fixtures/antigravity and drive the fake agent the unit tests use.
 *
 * What the recording and binary inspection showed, and what this adapter does about it:
 * - Model catalog is dynamic (it differs between `agy models` and `session/new`): the menu comes from `session/new`,
 *   never a hard-coded list.
 * - Edits arrive as `tool_call` with `kind: edit` and `content: [{type: 'diff', path, oldText?, newText}]`. A
 *   permission request carries the same diff, so the approval card can show it before anything is written.
 * - Permissions are `session/request_permission` with `allow_once` / `reject_once` only, and `agy acp` 1.5.8/1.5.9
 *   forwards permission prompts ONLY for the parent session's active `session/prompt` turn — never for child subagents.
 *   In `bypassPermissions` mode (when no edit/shell denylist applies), the adapter launches `agy acp
 *   --dangerously-skip-permissions` (respawning and resuming via `session/load` when toggled mid-session) so both parent
 *   and child subagents run unattended without 60s approval timeouts.
 * - Subagent progress and reactive wakeups: `agy acp` omits child `conversationId`s and closes the ACP turn stream as
 *   soon as `session/prompt` returns, before background subagents finish and wake the parent up. When `<brainDir>/<id>`
 *   is present on disk, the adapter tails the parent and child JSONL transcripts to emit `onTaskStarted`,
 *   `onTaskProgress`, `onTaskUpdated`, `onTaskNotification`, and post-ACP wakeup messages before closing the turn.
 * - Structured agent questions (`ask_question`): `initialize` advertises `clientCapabilities.elicitation.form` so `agy acp`
 *   takes `askQuestionWithForm` (`elicitation/create` with `<key>` + `<key>_other` JSON-schema properties) instead of
 *   dumping numbered `[1]`/`[2]` bullets into chat (`askQuestionInChat`). The adapter pairs those fields into native
 *   `AskQuestion[]` cards (`callbacks.onAskUserQuestion`) and translates answers/cancellations back into ACP elicitation
 *   results.
 * - `session/cancel` is a notification; the in-flight `session/prompt` then resolves `stopReason: cancelled`.
 * - `session/load` REPLAYS history as ordinary updates BEFORE its response, and a bad session id does not error (it
 *   quietly creates a fresh session under that id). So replay is swallowed, and "zero replayed history" is the only
 *   signal a resume failed; the thread's transcript is then prepended to the first prompt (`resumeFallbackHistory`).
 * - Mode/model switching: `session/set_mode {modeId}` and `session/set_model {modelId}` (recorded).
 *
 * Desktop only: the child process and filesystem brain reader are loaded lazily, so importing this module is inert on
 * mobile.
 */
import { formatCurrentTimeContext, shouldAddCurrentTimeContext } from './currentTimeContext';
import type { AgentHarness, AskQuestion, ImageAttachment, ToolCallRecord } from './types';
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
import { ANTIGRAVITY_EXECUTION_NOTE, ANTIGRAVITY_MCP_FALLBACK_NOTE, CALL_MCP_TOOL_NAME } from './antigravityMcpFallback';
import {
  BrainTranscriptReader,
  cleanBrainArgString,
  cleanBrainArgStringArray,
  describeSubagentSpawn,
  extractAntigravityThoughtSummary,
  extractBrainToolCallBgMeta,
  extractSubagentSpawnMeta,
  parseAntigravityBackgroundTask,
  parseAntigravityCreatedSubagent,
  parseAntigravityWakeupMessage,
  resolveDefaultAntigravityBrainDir,
  type AntigravityBrainOptions,
  type BrainTranscriptStep,
  type PendingBrainToolCallMeta,
  type PendingSubagentSpawnMeta,
  type TrackedSubagent,
} from './antigravityBrain';

export type { AntigravityBrainOptions } from './antigravityBrain';

/** The ACP server release this adapter was verified against (`agentInfo.version` of `agy acp`). */
export const ANTIGRAVITY_VERIFIED_VERSION = '1.5.8';
const HARNESS: AgentHarness = 'antigravity';
const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_BRAIN_POLL_MS = 250;
const DEFAULT_WAKEUP_GRACE_MS = 2500;
const DEFAULT_WAKEUP_TOOL_STALL_MS = 2500;
const DEFAULT_WAKEUP_CANCEL_SETTLE_MS = 150;
const INTERNAL_ORCHESTRATION_TOOLS = new Set([
  'invoke_subagent',
  'define_subagent',
  'manage_subagents',
  'send_message',
  'manage_task',
  'schedule',
  'run_workflow',
  'swarm',
]);
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

/**
 * Whether `agy acp` should launch with `--dangerously-skip-permissions`.
 *
 * `agy acp` 1.5.8/1.5.9 does not forward subagent permission prompts over ACP, and ACP `auto` mode still prompts on
 * external paths and unsandboxed commands (causing 60s subagent timeouts). Passing `--dangerously-skip-permissions`
 * enables `always-proceed` + non-workspace access across parent and child subagents. When a per-thread denylist blocks
 * edits or shell execution, this stays `false` so `agy` still asks `ACPServer` and `handlePermissionRequest` refuses.
 */
export function antigravityShouldSkipPermissions(mode: HarnessPermissionMode, disallowedTools?: readonly string[]): boolean {
  return (mode === 'bypassPermissions' || mode === 'auto') && !isEditDenied(disallowedTools) && !isShellDenied(disallowedTools);
}

/** CLI argv passed to `agy` for a given permission mode and tool denylist. */
export function antigravityCliArgs(mode: HarnessPermissionMode, disallowedTools?: readonly string[]): string[] {
  return antigravityShouldSkipPermissions(mode, disallowedTools)
    ? ['acp', '--dangerously-skip-permissions']
    : ['acp'];
}

/** Antigravity tool names/kinds mapped to the plugin's display names (drives tool icons in `toolNameUtils.ts`). */
const KIND_TOOL_NAMES: Record<string, string> = {
  execute: 'Bash', read: 'Read', search: 'Grep', fetch: 'WebFetch', think: 'Think', delete: 'Edit', move: 'Edit',
};
const NAME_TOOL_NAMES: Record<string, string> = {
  write_file: 'Write',
  edit_file: 'Edit',
  read_file: 'Read',
  view_file_outline: 'Read',
  view_code_item: 'Read',
  grep_search: 'Grep',
  find_by_name: 'Glob',
  list_dir: 'Glob',
  run_command: 'Bash',
  invoke_subagent: 'Agent',
  run_workflow: 'Workflow',
  search_web: 'WebSearch',
  ask_question: 'AskUserQuestion',
  schedule: 'ScheduleWakeup',
  list_resources: 'ListMcpResources',
  read_resource: 'ReadMcpResource',
};

const CALL_MCP_TOOL_ACP_NAME = `mcp_${OPENCODE_HOST_TOOLS_SERVER}_${CALL_MCP_TOOL_NAME}`;

export function antigravityToolName(
  name: string | undefined,
  kind: string | undefined,
  rawInput?: Record<string, unknown>,
): string {
  if (name === CALL_MCP_TOOL_ACP_NAME && typeof rawInput?.tool === 'string' && rawInput.tool.trim()) {
    const targetTool = rawInput.tool.trim();
    const server = typeof rawInput.server === 'string' && rawInput.server.trim()
      ? rawInput.server.trim()
      : OPENCODE_HOST_TOOLS_SERVER;
    return server === OPENCODE_HOST_TOOLS_SERVER ? targetTool : `mcp_${server}_${targetTool}`;
  }
  if (name && NAME_TOOL_NAMES[name]) return NAME_TOOL_NAMES[name];
  if (kind && KIND_TOOL_NAMES[kind]) return KIND_TOOL_NAMES[kind];
  if (kind === 'edit') return 'Edit';
  // MCP tools surface as `mcp_<server>_<tool>` (recorded from agy 1.1.13); show the bare host-tool name.
  const hostPrefix = `mcp_${OPENCODE_HOST_TOOLS_SERVER}_`;
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

function firstSummaryLine(value: unknown, maxChars = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const line = value
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  return line ? line.slice(0, maxChars) : undefined;
}

/** One-line card summary: the command for a shell call, the file for an edit, else the agent's own title. */
export function antigravityToolSummary(tool: AcpToolCall): string {
  const input = tool.rawInput ?? tool.args ?? {};
  const command = input.CommandLine ?? input.command;
  // An MCP tool's title is "Run mcp_<server>_<tool>"; agy's own one-line description of the call reads better.
  if (tool.name?.startsWith('mcp_') && typeof input.toolSummary === 'string' && input.toolSummary.trim()) return input.toolSummary.trim();
  if (tool.name === CALL_MCP_TOOL_ACP_NAME) {
    const server = typeof input.server === 'string' && input.server.trim() ? input.server.trim() : OPENCODE_HOST_TOOLS_SERVER;
    return typeof input.tool === 'string' && input.tool.trim()
      ? `${server}/${input.tool.trim()}`
      : `list tools (${server})`;
  }
  if ((tool.kind === 'execute' || tool.name === 'run_command') && typeof command === 'string' && command.trim()) {
    return command.trim().split('\n')[0].slice(0, 200);
  }
  switch (tool.name) {
    case 'invoke_subagent':
      return firstSummaryLine(input.Role) ?? firstSummaryLine(input.TypeName) ?? firstSummaryLine(input.Prompt) ?? 'Subagent';
    case 'define_subagent': {
      const name = firstSummaryLine(input.Name, 80);
      return name ? `Define subagent: ${name}` : 'Define subagent';
    }
    case 'manage_subagents': {
      const action = firstSummaryLine(input.Action, 40);
      return action ? `Subagents: ${action}` : 'Manage subagents';
    }
    case 'send_message': {
      const recipient = firstSummaryLine(input.Recipient, 48);
      return recipient ? `Message to ${recipient}` : 'Send message';
    }
    case 'swarm': {
      const action = firstSummaryLine(input.action, 40);
      const name = firstSummaryLine(input.name, 60);
      return action ? `Swarm: ${action}${name ? ` (${name})` : ''}` : 'Swarm';
    }
    case 'run_workflow':
      return firstSummaryLine(input.Description) ?? firstSummaryLine(input.ScriptPath) ?? 'Run workflow';
    case 'schedule':
      return firstSummaryLine(input.Prompt) ?? firstSummaryLine(input.CronExpression) ?? 'Schedule';
    case 'manage_task': {
      const action = firstSummaryLine(input.Action, 40);
      const taskId = firstSummaryLine(input.TaskId, 60);
      return action ? `Task: ${action}${taskId ? ` (${taskId})` : ''}` : 'Manage task';
    }
    case 'search_web':
      return firstSummaryLine(input.query) ?? 'Web search';
    case 'ask_question': {
      const firstQuestion = Array.isArray(input.questions) ? (input.questions[0] as Record<string, unknown> | undefined)?.question : undefined;
      return firstSummaryLine(firstQuestion) ?? 'Ask user';
    }
    default:
      break;
  }
  const file = tool.locations?.find((location) => typeof location.path === 'string' && location.path)?.path
    ?? firstSummaryLine(input.Path ?? input.TargetFile ?? input.DirectoryPath);
  if ((EDIT_KINDS.has(tool.kind ?? '') || tool.name === 'write_file' || tool.name === 'edit_file' || tool.name === 'read_file') && file) return file;
  if (tool.name === 'grep_search') return firstSummaryLine(input.Query) ?? file ?? 'grep_search';
  if (tool.name === 'find_by_name') return firstSummaryLine(input.Pattern ?? input.SearchDirectory) ?? file ?? 'find_by_name';
  if (tool.name === 'list_dir' && file) return file;
  if (tool.title?.trim()) return tool.title.trim();
  return file ?? tool.name ?? 'tool';
}

/** Every file path a tool call touches, from its diffs first, locations second, and `Path` argument third. */
export function antigravityEditedPaths(tool: AcpToolCall): string[] {
  const paths = new Set<string>();
  for (const item of tool.content ?? []) if (item?.type === 'diff' && typeof item.path === 'string' && item.path) paths.add(item.path);
  if (paths.size === 0) for (const location of tool.locations ?? []) if (typeof location.path === 'string' && location.path) paths.add(location.path);
  if (paths.size === 0 && (tool.name === 'write_file' || tool.name === 'edit_file')) {
    const rawPath = (tool.rawInput ?? tool.args)?.Path;
    if (typeof rawPath === 'string' && rawPath.trim()) paths.add(rawPath.trim());
  }
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

export interface AntigravityElicitationOption {
  constValue: string;
  label: string;
  description: string;
}

export interface AntigravityParsedQuestionField {
  id: string;
  question: string;
  multiSelect: boolean;
  options: AntigravityElicitationOption[];
  otherKey?: string;
  allowOther: boolean;
  askQuestion: AskQuestion;
}

export interface AntigravityElicitationParams {
  sessionId?: string;
  toolCallId?: string;
  elicitationId?: string;
  mode?: string;
  message?: string;
  requestedSchema?: Record<string, any>;
}

function extractSchemaChoices(entries: unknown): AntigravityElicitationOption[] {
  if (!Array.isArray(entries)) return [];
  const options: AntigravityElicitationOption[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string' && entry) {
      options.push({ constValue: entry, label: entry, description: '' });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    if (obj.const === undefined || obj.const === null) continue;
    const constValue = String(obj.const);
    const label = typeof obj.title === 'string' && obj.title.trim() ? obj.title : constValue;
    const description = typeof obj.description === 'string' ? obj.description : '';
    options.push({ constValue, label, description });
  }
  return options;
}

function propHasSelectableChoices(prop: Record<string, any> | undefined): boolean {
  if (!prop || typeof prop !== 'object') return false;
  if (prop.type === 'array') {
    const items = prop.items;
    return Array.isArray(items?.anyOf) || Array.isArray(items?.oneOf) || Array.isArray(items?.enum);
  }
  return Array.isArray(prop.oneOf) || Array.isArray(prop.anyOf) || Array.isArray(prop.enum);
}

/**
 * Parse an ACP `elicitation/create` form request (`agy acp`'s `ask_question` schema) into `AskQuestion` descriptors.
 * Returns `null` when the request is not a supported form elicitation (e.g. `mode: "url"` or non-question JSON types).
 */
export function parseAntigravityElicitation(
  params: AntigravityElicitationParams | undefined,
): AntigravityParsedQuestionField[] | null {
  if (!params || typeof params !== 'object') return null;
  if (params.mode !== undefined && params.mode !== 'form') return null;
  const props = params.requestedSchema?.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return null;

  const propEntries = Object.entries(props as Record<string, any>);
  if (propEntries.length === 0) return null;

  // `agy acp` emits `<key>` (choices) paired with `<key>_other` (`type: "string"`, title `"Other"`).
  const consumedOtherKeys = new Set<string>();
  const pairedOtherForKey = new Map<string, string>();
  for (const [key, prop] of propEntries) {
    if (!propHasSelectableChoices(prop)) continue;
    const candidateOther = `${key}_other`;
    const otherProp = (props as Record<string, any>)[candidateOther];
    if (otherProp && typeof otherProp === 'object' && otherProp.type === 'string') {
      consumedOtherKeys.add(candidateOther);
      pairedOtherForKey.set(key, candidateOther);
    }
  }

  const toolCallId = typeof params.toolCallId === 'string' && params.toolCallId ? params.toolCallId : undefined;
  const fields: AntigravityParsedQuestionField[] = [];
  for (const [key, prop] of propEntries) {
    if (consumedOtherKeys.has(key)) continue;
    if (!prop || typeof prop !== 'object') return null;
    const multiSelect = prop.type === 'array';
    const options = multiSelect
      ? extractSchemaChoices(prop.items?.anyOf ?? prop.items?.oneOf ?? prop.items?.enum)
      : extractSchemaChoices(prop.oneOf ?? prop.anyOf ?? prop.enum);

    if (options.length === 0 && prop.type !== 'string') {
      // Unsupported primitive (e.g. boolean/number/object from a generic MCP form) — decline rather than mis-typing.
      return null;
    }

    const otherKey = pairedOtherForKey.get(key);
    const allowOther = options.length === 0 ? true : Boolean(otherKey);
    const question = typeof prop.title === 'string' && prop.title.trim()
      ? prop.title.trim()
      : typeof prop.description === 'string' && prop.description.trim()
        ? prop.description.trim()
        : key;

    fields.push({
      id: key,
      question,
      multiSelect,
      options,
      otherKey,
      allowOther,
      askQuestion: {
        id: key,
        question,
        header: '',
        options: options.map(({ label, description }) => ({ label, description })),
        multiSelect,
        allowOther,
        source: HARNESS,
        ...(toolCallId ? { requestItemId: toolCallId } : {}),
      },
    });
  }

  return fields.length > 0 ? fields : null;
}

/**
 * Decompose `QuestionForm`'s comma-joined multi-select string back into ordered option `const` values plus an optional
 * trailing write-in string, without corrupting option labels that themselves contain commas.
 */
function matchMultiSelectAnswer(
  idx: number,
  remaining: string | null,
  options: readonly AntigravityElicitationOption[],
  chosenConsts: string[],
  allowTrailingOther: boolean,
): { consts: string[]; writeIn?: string } | null {
  if (remaining === null) return { consts: chosenConsts };
  if (idx === options.length) {
    if (allowTrailingOther && remaining.trim().length > 0) {
      return { consts: chosenConsts, writeIn: remaining.trim() };
    }
    return null;
  }
  const opt = options[idx];
  if (remaining === opt.label) {
    return matchMultiSelectAnswer(options.length, null, options, [...chosenConsts, opt.constValue], allowTrailingOther);
  }
  if (remaining.startsWith(`${opt.label},`)) {
    const rest = remaining.slice(opt.label.length + 1);
    const withOpt = matchMultiSelectAnswer(idx + 1, rest, options, [...chosenConsts, opt.constValue], allowTrailingOther);
    if (withOpt) return withOpt;
  }
  return matchMultiSelectAnswer(idx + 1, remaining, options, chosenConsts, allowTrailingOther);
}

/**
 * Build the ACP `CreateElicitationResult` (`{ action: 'accept', content }` or `{ action: 'cancel' }`) from the answers
 * map returned by `callbacks.onAskUserQuestion`.
 *
 * `ThreadManager` resolves `{}` (zero keys) when a prompt is aborted by generation fence or interrupt, whereas
 * `QuestionForm.collect()` always populates a key per question (even when left blank).
 */
export function buildAntigravityElicitationReply(
  fields: readonly AntigravityParsedQuestionField[],
  answers: Record<string, string>,
): Record<string, unknown> {
  if (!answers || Object.keys(answers).length === 0) return { action: 'cancel' };
  const content: Record<string, unknown> = {};

  for (const field of fields) {
    const raw = answers[field.id] ?? answers[field.question] ?? '';
    if (!raw || !raw.trim()) continue;

    if (field.options.length === 0) {
      content[field.id] = raw.trim();
      continue;
    }

    if (!field.multiSelect) {
      const exact = field.options.find((opt) => opt.label === raw || opt.label === raw.trim());
      if (exact) {
        content[field.id] = exact.constValue;
      } else if (field.otherKey) {
        content[field.otherKey] = raw.trim();
      }
      continue;
    }

    // Pass 1 prefers a 100% option-only match so an option containing a comma is never split into prefix + Other.
    const parsed = matchMultiSelectAnswer(0, raw, field.options, [], false)
      ?? (field.allowOther ? matchMultiSelectAnswer(0, raw, field.options, [], true) : null);
    if (!parsed) continue;
    if (parsed.consts.length > 0) content[field.id] = parsed.consts;
    if (parsed.writeIn && field.otherKey) content[field.otherKey] = parsed.writeIn;
  }

  return { action: 'accept', content };
}

// ── Session ────────────────────────────────────────────────────────────────

export type AntigravityClientFactory = (options: AcpClientOptions) => AcpClient;

export class AntigravitySession {
  private client: AcpClient | null = null;
  private bridge: OpenCodeHostToolsBridge | null = null;
  private mcpServers: Array<Record<string, unknown>> = [];
  private resolvedEnv: Record<string, string | undefined> = {};
  private options: HarnessSessionOptions | null = null;
  private sessionId: string | undefined;
  private closed = true;
  private _turnInFlight = false;
  private acpPromptInFlight = false;
  private acpTurnBrainEnded = false;
  private turnText = '';
  private turnThought = '';
  private lastEmittedThoughtSummary = '';
  /** Tool calls made since the last finished message; they ride with the text that precedes them, as Claude's do. */
  private pendingTools: ToolCallRecord[] = [];
  private queuedTurns: Array<{ text: string; images?: ImageAttachment[] }> = [];
  private resumeFallbackPending = false;
  private systemPromptPending = false;
  private loading = false;
  /** True from `start()` (or mid-session permission respawn) until the handshake completes. */
  private starting = false;
  private spawnedWithSkipPermissions = false;
  private restartForPermissionFlagPending = false;
  private restartingClient: Promise<void> | null = null;
  private replayedHistory = 0;
  private announcedTools = new Map<string, AcpToolCall>();
  private settledTools = new Set<string>();
  private toolStartedAt = new Map<string, number>();
  private pendingPermissions = new Map<string, (outcome: Record<string, unknown>) => void>();
  private pendingElicitations = new Map<string, (result: Record<string, unknown>) => void>();
  private elicitationSeq = 0;
  private currentMode: string | undefined;
  private activeModel = '';
  private latestContextUsage: HarnessContextUsage | null = null;
  private latestUsage: UsageSnapshot | null = null;
  private cumulativeTokens: UsageTokenTotals = {};
  private turns = 0;
  private hostToolNames = new Set<string>();

  // Brain transcript tracking for subagent progress and post-ACP parent reactive wakeups
  private brainReader: BrainTranscriptReader | null = null;
  private parentPendingSpawns: PendingSubagentSpawnMeta[] = [];
  private parentPendingToolCalls: PendingBrainToolCallMeta[] = [];
  private subagents = new Map<string, TrackedSubagent>();
  private activeBgTaskIds = new Set<string>();
  private pendingWakeups = 0;
  private wakeupDeadlineMs = 0;
  private parentWakeupInFlight = false;
  private wakeupPendingTools: Array<{ callId: string; tool: AcpToolCall; startedAt: number }> = [];
  private bridgeCallsInFlight = 0;
  private wakeupToolStallDeadlineMs = 0;
  private promotingWakeup = false;

  /**
   * `launcher` replaces process spawning (tests); `startTimeoutMs` bounds the handshake and session setup, which on a
   * cold start of the real agent exceeds 20s; `brainOptions` overrides the local brain log directory/cadence in tests.
   */
  constructor(
    private binaryPath: string,
    private launcher?: AcpLauncher,
    private startTimeoutMs?: number,
    private brainOptions?: AntigravityBrainOptions,
  ) {}

  get turnInFlight(): boolean { return this._turnInFlight; }
  get cwd(): string | undefined { return this.options?.cwd; }
  get hasPendingPermission(): boolean { return this.pendingPermissions.size > 0; }
  get hasPendingElicitation(): boolean { return this.pendingElicitations.size > 0; }
  canIdleReap(): boolean {
    return !this._turnInFlight && !this.hasPendingPermission && !this.hasPendingElicitation && !this.restartingClient && !this.hasRunningSubagents();
  }

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
    this.systemPromptPending = false;
    this.currentMode = undefined;
    this.sessionId = undefined;
    this.loading = false;
    this.starting = true;
    this.spawnedWithSkipPermissions = false;
    this.restartForPermissionFlagPending = false;
    this.restartingClient = null;
    this.replayedHistory = 0;
    this.bridgeCallsInFlight = 0;
    this.subagents.clear();
    this.activeBgTaskIds.clear();

    this.resolvedEnv = { ...process.env, ...parseExtraEnv(options.extraEnvRaw), ...(options.secretEnv ?? {}) };
    const brainDir = this.brainOptions?.brainDir ?? resolveDefaultAntigravityBrainDir(this.resolvedEnv);
    this.brainReader = new BrainTranscriptReader(brainDir, this.brainOptions?.pollIntervalMs ?? DEFAULT_BRAIN_POLL_MS);

    const externalServers = options.antigravity?.mcpServers ?? {};
    const mcpServers = antigravityMcpServers(externalServers);
    const hostTools = options.antigravity?.dynamicTools ?? [];
    this.hostToolNames = new Set(hostTools.map((tool) => tool.name));
    if (hostTools.length > 0 || Object.keys(externalServers).length > 0) {
      this.hostToolNames.add(CALL_MCP_TOOL_NAME);
      const trackedHostTools = hostTools.map((tool) => ({
        ...tool,
        invoke: async (args: Record<string, unknown>) => {
          this.bridgeCallsInFlight++;
          try {
            return await tool.invoke(args);
          } finally {
            this.bridgeCallsInFlight = Math.max(0, this.bridgeCallsInFlight - 1);
            this.refreshWakeupToolStallDeadline();
          }
        },
      }));
      const bridge = new OpenCodeHostToolsBridge(
        trackedHostTools,
        {
          permissionMode: () => this.options?.permissionMode ?? 'default',
          requestPermission: async (toolName, detail) => {
            this.bridgeCallsInFlight++;
            try {
              return await (this.options?.callbacks.onPermissionRequest(toolName, detail) ?? Promise.resolve(false));
            } finally {
              this.bridgeCallsInFlight = Math.max(0, this.bridgeCallsInFlight - 1);
              this.refreshWakeupToolStallDeadline();
            }
          },
        },
        {
          enableMcpDispatcher: true,
          externalMcpServers: externalServers,
          cwd: options.cwd,
          env: this.resolvedEnv,
        },
      );
      await bridge.start();
      this.bridge = bridge;
      mcpServers.push({
        type: 'http',
        name: OPENCODE_HOST_TOOLS_SERVER,
        url: bridge.url,
        headers: Object.entries(bridge.headers).map(([name, value]) => ({ name, value })),
      });
    }
    this.mcpServers = mcpServers;
    this.systemPromptPending = Boolean(this.effectiveSystemPrompt());

    try {
      await this.connectClient(options.resume, 'initial');
    } catch (error) {
      this.starting = false;
      this.close();
      throw error;
    }
    this.starting = false;
  }

  /** Spawn an `AcpClient`, run `initialize`, and create or `session/load` the conversation. */
  private async connectClient(resumeSessionId: string | undefined, phase: 'initial' | 'respawn'): Promise<void> {
    const options = this.options;
    if (!options) return;
    const mode = options.permissionMode ?? 'default';
    const skipPermissions = antigravityShouldSkipPermissions(mode, options.disallowedTools);
    const client = new AcpClient({
      binaryPath: this.binaryPath,
      args: antigravityCliArgs(mode, options.disallowedTools),
      cwd: options.cwd,
      env: this.resolvedEnv,
      launcher: this.launcher,
      startTimeoutMs: this.startTimeoutMs,
      installHint: ANTIGRAVITY_INSTALL_HINT,
      label: 'Antigravity',
    });
    this.client = client;
    this.spawnedWithSkipPermissions = skipPermissions;
    client.onNotification('session/update', (params) => this.handleSessionUpdate(params));
    client.onRequest('session/request_permission', (params) => this.handlePermissionRequest(params));
    client.onRequest('elicitation/create', (params) => this.handleElicitationCreate(params));
    client.onProtocolError((line, error) => console.warn('[ClaudeThreads] Unparseable Antigravity line:', line.slice(0, 200), error.message));
    client.onClose((error) => this.handleClientClosed(client, error));
    client.spawn();

    const init = await client.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      // agy owns its tools and file access; advertise form elicitation so `ask_question` uses `elicitation/create`
      // instead of falling back to plain-text `[1]`/`[2]` bullets in chat.
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: { form: {} },
      },
    }, client.startTimeoutMs);
    options.callbacks.onRawEvent?.({ type: 'antigravity/initialize', agentInfo: init?.agentInfo, protocolVersion: init?.protocolVersion });
    const canLoad = Boolean(init?.agentCapabilities?.loadSession ?? init?.agentCapabilities?.load_session);
    const expectHistory = phase === 'initial' ? Boolean(resumeSessionId) : (this.turns > 0 || Boolean(options.resume && !this.resumeFallbackPending));
    let setup: any;
    if (resumeSessionId && canLoad) {
      setup = await this.loadSession(client, resumeSessionId, options.cwd, this.mcpServers, phase, expectHistory);
      if (setup && phase === 'initial' && !this.resumeFallbackPending) {
        // Replayed history succeeded: the saved conversation already carries `<system-instructions>`.
        this.systemPromptPending = false;
      }
    }
    if (!setup) {
      if (phase === 'initial' && resumeSessionId) this.resumeFallbackPending = true;
      if (phase === 'respawn') this.systemPromptPending = Boolean(this.effectiveSystemPrompt());
      setup = await client.request('session/new', { cwd: options.cwd, mcpServers: this.mcpServers }, client.startTimeoutMs);
    }
    const sessionId = typeof setup?.sessionId === 'string' ? setup.sessionId : undefined;
    if (!sessionId) throw new Error(`Antigravity did not return a session id.${this.compatibilityHint()}`);
    this.sessionId = sessionId;
    this.currentMode = setup?.modes?.currentModeId;
    if (phase === 'initial') {
      if (!this.activeModel) this.activeModel = String(setup?.models?.currentModelId ?? '');
      const models = antigravityModels(setup);
      if (models.length > 0) options.callbacks.onCapabilitiesDiscovered?.(models as any, []);
    }
    await this.applyInitialSettings(setup);
  }

  /** `session/load`, swallowing replayed history. Returns undefined when the load fails. */
  private async loadSession(
    client: AcpClient,
    resume: string,
    cwd: string,
    mcpServers: Array<Record<string, unknown>>,
    phase: 'initial' | 'respawn',
    expectHistory: boolean,
  ): Promise<any | undefined> {
    this.loading = true;
    this.replayedHistory = 0;
    this.sessionId = resume; // so replayed updates are recognised as ours and dropped
    try {
      const response = await client.request('session/load', { sessionId: resume, cwd, mcpServers }, client.startTimeoutMs);
      // A bad id "succeeds" as a fresh session. No replayed history when history was expected means the resume missed.
      if (this.replayedHistory === 0 && expectHistory) {
        if (phase === 'initial') {
          this.resumeFallbackPending = true;
          console.warn('[ClaudeThreads] Antigravity replayed no history for the saved session; the transcript will be sent with the next prompt.');
        } else {
          // A mid-session respawn whose session vanished on disk starts clean under the same id; re-arm system prompt.
          this.systemPromptPending = Boolean(this.effectiveSystemPrompt());
        }
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

  /** Put a session in the thread's permission mode and model, when they differ from agy's defaults. */
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
    if (this.closed || !this.options) return;
    const wantedMode = antigravityModeForPermission(mode, this.options.disallowedTools);
    const wantedSkip = antigravityShouldSkipPermissions(mode, this.options.disallowedTools);
    if (wantedSkip !== this.spawnedWithSkipPermissions) {
      if (this._turnInFlight) {
        // Defer process respawn until the active turn settles; still apply the ACP mode immediately.
        this.restartForPermissionFlagPending = true;
        if (wantedMode !== this.currentMode) await this.setAgentMode(wantedMode);
        return;
      }
      await this.ensurePermissionFlagSynced();
      return;
    }
    this.restartForPermissionFlagPending = false;
    if (wantedMode !== this.currentMode) await this.setAgentMode(wantedMode);
  }

  /** Respawn `AcpClient` and `session/load` the current session when `--dangerously-skip-permissions` needs to change. */
  private async ensurePermissionFlagSynced(): Promise<void> {
    if (this.restartingClient) {
      await this.restartingClient;
      return;
    }
    const run = (async () => {
      while (!this.closed && this.options && this.sessionId) {
        const currentMode = this.options.permissionMode ?? 'default';
        const wantedSkip = antigravityShouldSkipPermissions(currentMode, this.options.disallowedTools);
        if (wantedSkip === this.spawnedWithSkipPermissions) {
          const wantedMode = antigravityModeForPermission(currentMode, this.options.disallowedTools);
          if (wantedMode !== this.currentMode) await this.setAgentMode(wantedMode);
          break;
        }
        this.restartForPermissionFlagPending = false;
        const resumeId = this.sessionId;
        const oldClient = this.client;
        this.client = null;
        oldClient?.close();
        this.starting = true;
        try {
          await this.connectClient(resumeId, 'respawn');
        } finally {
          this.starting = false;
        }
      }
    })();
    this.restartingClient = run;
    try {
      await run;
    } finally {
      if (this.restartingClient === run) this.restartingClient = null;
      if (!this.closed && !this._turnInFlight && this.queuedTurns.length > 0) {
        const next = this.queuedTurns.shift()!;
        this.startTurn(next.text, next.images);
      }
    }
  }

  send(text: string, images?: ImageAttachment[], _userMessageUuid?: string): void {
    if (this.closed || (!this.restartingClient && (!this.sessionId || !this.client))) {
      throw new Error('Antigravity session is not running');
    }
    if (this._turnInFlight || this.restartingClient) {
      this.queuedTurns.push({ text, images });
      return;
    }
    const wantedSkip = this.options
      ? antigravityShouldSkipPermissions(this.options.permissionMode ?? 'default', this.options.disallowedTools)
      : this.spawnedWithSkipPermissions;
    if (this.restartForPermissionFlagPending || wantedSkip !== this.spawnedWithSkipPermissions) {
      this.queuedTurns.push({ text, images });
      void this.ensurePermissionFlagSynced().catch((error) => {
        if (!this.closed) this.options?.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      });
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
    this.acpPromptInFlight = true;
    this.acpTurnBrainEnded = false;
    // Snapshot the brain transcript's pre-turn step index on the session's first turn so prior history is never replayed;
    // on subsequent turns, flush any late post-ACP wakeups or subagent steps that landed while idle between turns.
    if (this.brainReader) {
      if (this.brainReader.getLastStepIndex(sessionId) < 0) {
        const existingMax = this.brainReader.peekMaxStepIndex(sessionId);
        if (existingMax >= 0) this.brainReader.setBaselineStepIndex(sessionId, existingMax);
      } else {
        this.syncSubagentTranscripts(options.callbacks);
        this.syncParentPostAcp(options.callbacks);
        this.syncSubagentTranscripts(options.callbacks);
        this.flushText(options.callbacks);
      }
    }
    this.turnText = '';
    this.turnThought = '';
    this.lastEmittedThoughtSummary = '';
    this.pendingTools = [];
    this.parentPendingSpawns = [];
    this.parentPendingToolCalls = [];
    this.parentWakeupInFlight = false;
    this.wakeupPendingTools = [];
    this.wakeupToolStallDeadlineMs = 0;
    this.promotingWakeup = false;
    const mode = options.permissionMode ?? 'default';

    if (this.brainReader) {
      this.brainReader.startPolling(() => this.onBrainTick());
      this.brainReader.watchConversation(sessionId, () => this.onBrainTick());
    }

    let effectiveText = text;
    const history = options.resumeFallbackHistory;
    if (this.resumeFallbackPending && history) effectiveText = history + effectiveText;
    this.resumeFallbackPending = false;
    // `_meta.antigravity.systemPrompt.append` is advertised but its request shape is unobserved, so the system prompt
    // rides the first prompt of each fresh conversation instead (a resumed conversation already has it in history).
    const systemPrompt = this.effectiveSystemPrompt();
    if (this.systemPromptPending && systemPrompt) {
      effectiveText = `<system-instructions>\n${systemPrompt}\n</system-instructions>\n\n${effectiveText}`;
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
        this.abortBackgroundWork(options.callbacks, 'Failed');
        this.cancelPendingElicitations();
        this.resetTurnState();
        options.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      });
  }

  async interrupt(): Promise<void> {
    if (!this.client || !this.sessionId || !this._turnInFlight) return;
    this.queuedTurns = [];
    // A pending approval or question would otherwise keep the agent waiting on us: answer it as cancelled first.
    for (const resolve of [...this.pendingPermissions.values()]) resolve({ outcome: 'cancelled' });
    this.cancelPendingElicitations();
    this.client.notify('session/cancel', { sessionId: this.sessionId });
    // When `session/prompt` already ended and we are holding the turn open for background subagents/wakeups, there is
    // no pending `session/prompt` RPC left to resolve `stopReason: cancelled` — settle the interrupted turn right here.
    if (!this.acpPromptInFlight) {
      const callbacks = this.options?.callbacks;
      const sessionId = this.sessionId;
      if (callbacks) {
        this.settleWakeupToolsAsError(callbacks);
        this.abortBackgroundWork(callbacks, 'Interrupted');
      }
      this.resetTurnState();
      callbacks?.onInterrupted(sessionId);
      if (callbacks) this.maybeSyncPermissionFlagAfterTurn(callbacks);
    }
  }

  close(): void {
    this.closed = true;
    this.resetTurnState();
    this.brainReader?.reset();
    this.brainReader = null;
    this.subagents.clear();
    this.activeBgTaskIds.clear();
    for (const resolve of [...this.pendingPermissions.values()]) resolve({ outcome: 'cancelled' });
    this.pendingPermissions.clear();
    this.cancelPendingElicitations();
    // `session/close` is advertised but not called: the process is killed instead, and the saved session must stay
    // loadable for resume.
    const oldClient = this.client;
    this.client = null;
    oldClient?.close();
    this.bridge?.close();
    this.bridge = null;
  }

  async getContextUsage(): Promise<HarnessContextUsage | null> { return this.latestContextUsage; }

  async getUsageSnapshot(_includeAccountUsage = false): Promise<UsageSnapshot | null> { return this.latestUsage; }

  private resetTurnState(): void {
    this._turnInFlight = false;
    this.acpPromptInFlight = false;
    this.acpTurnBrainEnded = false;
    this.turnText = '';
    this.turnThought = '';
    this.lastEmittedThoughtSummary = '';
    this.pendingTools = [];
    this.queuedTurns = [];
    this.parentPendingSpawns = [];
    this.parentPendingToolCalls = [];
    this.pendingWakeups = 0;
    this.wakeupDeadlineMs = 0;
    this.parentWakeupInFlight = false;
    this.wakeupPendingTools = [];
    this.wakeupToolStallDeadlineMs = 0;
    this.promotingWakeup = false;
    this.brainReader?.stopWatching();
  }

  private effectiveSystemPrompt(): string | undefined {
    const base = this.options?.appendSystemPrompt ? this.options.appendSystemPrompt : undefined;
    const agyNotes = this.bridge ? `${ANTIGRAVITY_MCP_FALLBACK_NOTE}\n\n${ANTIGRAVITY_EXECUTION_NOTE}` : undefined;
    if (base && agyNotes) return `${base}\n\n${agyNotes}`;
    return base ?? agyNotes;
  }

  private compatibilityHint(): string {
    return ` The plugin is verified against the Antigravity ACP server ${ANTIGRAVITY_VERIFIED_VERSION}; check \`agy --version\` and update the plugin or agy if they differ.`;
  }

  private handleClientClosed(client: AcpClient, error?: Error): void {
    if (this.client !== client || this.closed || this.starting) return;
    const failure = error ?? new Error('Antigravity exited unexpectedly.');
    const callbacks = this.options?.callbacks;
    if (callbacks) this.abortBackgroundWork(callbacks, 'Antigravity exited unexpectedly');
    // The process is gone: further sends fail fast so the manager starts a fresh session instead of writing to a dead pipe.
    this.closed = true;
    this.resetTurnState();
    this.pendingPermissions.clear();
    this.cancelPendingElicitations();
    this.bridge?.close();
    this.bridge = null;
    callbacks?.onError(failure);
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
          this.turnThought = '';
          this.lastEmittedThoughtSummary = '';
          // Text after tool calls starts a new message; the previous one closes with its tools.
          if (this.pendingTools.length > 0) this.flushText(callbacks);
          this.turnText += text;
          callbacks.onToken(text);
        }
        break;
      }
      case 'agent_thought_chunk': {
        const thought = update.content?.type === 'text' ? update.content.text : undefined;
        if (this._turnInFlight && !this.turnText && typeof thought === 'string' && thought) {
          this.turnThought += thought;
          const summary = extractAntigravityThoughtSummary(this.turnThought);
          if (summary && summary !== this.lastEmittedThoughtSummary) {
            this.lastEmittedThoughtSummary = summary;
            callbacks.onThinking?.(summary);
          }
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
      // user_message_chunk is an echo of our own prompt; session_info_update and config_option_update carry nothing the thread needs.
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
    const merged: AcpToolCall = {
      ...known,
      ...tool,
      content: tool.content ?? known?.content,
      rawInput: tool.rawInput ?? known?.rawInput,
      args: tool.args ?? known?.args,
    };
    if (!known) {
      this.turnThought = '';
      this.lastEmittedThoughtSummary = '';
      this.announcedTools.set(callId, merged);
      this.toolStartedAt.set(callId, Date.now());
      const record: ToolCallRecord = {
        toolUseId: callId,
        name: antigravityToolName(merged.name, merged.kind, merged.rawInput ?? merged.args),
        summary: antigravityToolSummary(merged),
        status: 'pending',
        timestamp: Date.now(),
      };
      // The same object the manager tracks: its status is updated in place when the result arrives.
      this.pendingTools.push(record);
      callbacks.onToolUse(record);
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
      // When `invoke_subagent` or a background task settles over ACP, check the brain transcript right away so the
      // subagent pill appears without waiting for the next timer tick.
      if (status === 'completed' && (merged.name === 'invoke_subagent' || merged.name === 'schedule' || merged.name === 'run_command' || merged.name === 'manage_subagents' || merged.name === 'send_message')) {
        this.onBrainTick();
      }
    }
  }

  /** Close the current assistant message: its text and the tool calls that followed it. */
  private flushText(callbacks: SessionCallbacks): void {
    const text = this.turnText;
    const tools = this.pendingTools;
    this.turnText = '';
    this.turnThought = '';
    this.lastEmittedThoughtSummary = '';
    this.pendingTools = [];
    if (!text.trim() && tools.length === 0) return;
    callbacks.onMessage(text, tools);
  }

  private maybeSyncPermissionFlagAfterTurn(callbacks: SessionCallbacks): boolean {
    if (this.closed || !this.options) return false;
    const wantedSkip = antigravityShouldSkipPermissions(this.options.permissionMode ?? 'default', this.options.disallowedTools);
    if (!this.restartForPermissionFlagPending && wantedSkip === this.spawnedWithSkipPermissions) return false;
    void this.ensurePermissionFlagSynced().catch((error) => {
      if (!this.closed) callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    });
    return true;
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
      this.abortBackgroundWork(callbacks, 'Interrupted');
      this.resetTurnState();
      callbacks.onInterrupted(sessionId);
      this.maybeSyncPermissionFlagAfterTurn(callbacks);
      return;
    }
    if (stopReason === 'refusal') {
      this.abortBackgroundWork(callbacks, 'Stopped');
      this.resetTurnState();
      callbacks.onError(new Error('Antigravity declined to continue with this request.'));
      this.maybeSyncPermissionFlagAfterTurn(callbacks);
      return;
    }

    // Catch up synchronously to the end of the ACP turn in `<brainDir>/<sessionId>` BEFORE transitioning out of
    // `acpPromptInFlight`, so any subagent or background task created during the turn is registered without duplicating
    // the ACP turn's own streamed text/tools.
    this.syncParentDuringAcp(callbacks);
    this.syncSubagentTranscripts(callbacks);

    this.flushText(callbacks);
    if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
      callbacks.onNotification?.(`Antigravity stopped early (${stopReason.replace(/_/g, ' ')}).`, 'medium');
    }
    this.acpPromptInFlight = false;

    // Stream any post-ACP wakeup steps that already landed, and hold the turn open while subagents or wakeups remain.
    this.syncParentPostAcp(callbacks);
    this.syncSubagentTranscripts(callbacks);
    if (this.brainReader?.hasTranscript(sessionId) && this.hasPendingBackgroundActivity(Date.now())) {
      this.brainReader.startPolling(() => this.onBrainTick());
      this.brainReader.watchConversation(sessionId, () => this.onBrainTick());
      return;
    }

    this.completeTurn(callbacks);
  }

  private completeTurn(callbacks: SessionCallbacks): void {
    if (this.closed || !this._turnInFlight) return;
    const sessionId = this.sessionId ?? '';
    this.flushText(callbacks);
    this._turnInFlight = false;
    this.acpPromptInFlight = false;
    this.pendingWakeups = 0;
    this.wakeupDeadlineMs = 0;
    this.parentWakeupInFlight = false;
    this.wakeupPendingTools = [];
    this.wakeupToolStallDeadlineMs = 0;
    this.promotingWakeup = false;
    this.brainReader?.stopWatching();
    this.turns++;
    callbacks.onDone(sessionId, 0, 1);

    if (this.maybeSyncPermissionFlagAfterTurn(callbacks)) return;
    const next = this.queuedTurns.shift();
    if (next && !this.closed) this.startTurn(next.text, next.images);
  }

  // ── Brain transcript subagent & wakeup tracking ──────────────────────────

  private hasRunningSubagents(): boolean {
    for (const subagent of this.subagents.values()) {
      if (subagent.running) return true;
    }
    return false;
  }

  private hasPendingBackgroundActivity(now: number): boolean {
    if (this.promotingWakeup) return true;
    if (this.pendingElicitations.size > 0) return true;
    if (this.hasRunningSubagents()) return true;
    if (this.activeBgTaskIds.size > 0) return true;
    if (this.parentWakeupInFlight) return true;
    if (this.pendingWakeups > 0 && now < this.wakeupDeadlineMs) return true;
    return false;
  }

  private hasPermissionSensitiveWakeupTool(): boolean {
    return this.wakeupPendingTools.some((entry) => !INTERNAL_ORCHESTRATION_TOOLS.has(entry.tool.name ?? ''));
  }

  private refreshWakeupToolStallDeadline(): void {
    if (this.spawnedWithSkipPermissions || this.acpPromptInFlight || !this.hasPermissionSensitiveWakeupTool()) {
      this.wakeupToolStallDeadlineMs = 0;
      return;
    }
    const stallMs = this.brainOptions?.wakeupToolStallMs ?? DEFAULT_WAKEUP_TOOL_STALL_MS;
    this.wakeupToolStallDeadlineMs = Date.now() + stallMs;
  }

  private noteExpectedParentWakeup(): void {
    this.pendingWakeups++;
    const graceMs = this.brainOptions?.wakeupGraceMs ?? DEFAULT_WAKEUP_GRACE_MS;
    this.wakeupDeadlineMs = Date.now() + graceMs;
  }

  private onBrainTick(): void {
    const callbacks = this.options?.callbacks;
    if (this.closed || !this._turnInFlight || !callbacks || !this.sessionId || !this.brainReader) return;
    this.brainReader.watchConversation(this.sessionId, () => this.onBrainTick());
    if (this.promotingWakeup) return;
    if (this.acpPromptInFlight) {
      this.syncParentDuringAcp(callbacks);
      this.syncSubagentTranscripts(callbacks);
      return;
    }
    this.syncSubagentTranscripts(callbacks);
    this.syncParentPostAcp(callbacks);
    this.syncSubagentTranscripts(callbacks);
    if (
      !this.spawnedWithSkipPermissions &&
      this.wakeupToolStallDeadlineMs > 0 &&
      this.bridgeCallsInFlight === 0 &&
      this.pendingElicitations.size === 0 &&
      this.hasPermissionSensitiveWakeupTool() &&
      Date.now() >= this.wakeupToolStallDeadlineMs
    ) {
      void this.promoteStalledWakeupToPrompt(callbacks);
      return;
    }
    if (!this.hasPendingBackgroundActivity(Date.now())) {
      this.completeTurn(callbacks);
    }
  }

  /**
   * Harvest omitted metadata (`invoke_subagent` child IDs, background task IDs, revivals, kills) from parent steps
   * written during the ACP turn without re-emitting ACP's own text/tool stream.
   */
  private syncParentDuringAcp(callbacks: SessionCallbacks): void {
    const sessionId = this.sessionId;
    if (!sessionId || !this.brainReader || this.acpTurnBrainEnded) return;
    const steps = this.brainReader.readNewSteps(sessionId);
    for (let idx = 0; idx < steps.length; idx++) {
      const step = steps[idx];
      if (step.type === 'PLANNER_RESPONSE') {
        this.parentPendingSpawns = [];
        this.parentPendingToolCalls = [];
        const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
        for (const tc of calls) this.trackParentToolCallMeta(tc.name, tc.args, callbacks);
        // An LLM tool loop ends a `session/prompt` turn on the first `PLANNER_RESPONSE` with zero tool calls; anything
        // written after that belongs to a post-ACP wakeup and must be left for `syncParentPostAcp` even if `onBrainTick`
        // ran before `session/prompt` resolved over stdio.
        if (calls.length === 0 && step.status === 'DONE') {
          this.acpTurnBrainEnded = true;
          if (idx < steps.length - 1) this.brainReader.rewindCursorToStep(sessionId, step.step_index);
          break;
        }
      } else if (step.type === 'GENERIC') {
        this.harvestParentGenericStep(step, callbacks);
      } else if (step.type === 'SYSTEM_MESSAGE') {
        this.consumeParentWakeupStep(step, callbacks, false);
      }
    }
  }

  /** Stream reactive wakeup steps written to `<brainDir>/<sessionId>` after `session/prompt` returned. */
  private syncParentPostAcp(callbacks: SessionCallbacks): void {
    const sessionId = this.sessionId;
    if (!sessionId || !this.brainReader) return;
    const steps = this.brainReader.readNewSteps(sessionId);
    for (const step of steps) {
      if (step.type === 'SYSTEM_MESSAGE') {
        this.consumeParentWakeupStep(step, callbacks, true);
      } else if (step.type === 'PLANNER_RESPONSE') {
        this.parentWakeupInFlight = true;
        this.parentPendingSpawns = [];
        this.parentPendingToolCalls = [];
        if (typeof step.content === 'string' && step.content) {
          this.turnThought = '';
          this.lastEmittedThoughtSummary = '';
          if (this.pendingTools.length > 0) this.flushText(callbacks);
          this.turnText += step.content;
          callbacks.onToken(step.content);
        } else if (typeof step.thinking === 'string' && step.thinking) {
          const summary = extractAntigravityThoughtSummary(step.thinking);
          if (summary && summary !== this.lastEmittedThoughtSummary) {
            this.lastEmittedThoughtSummary = summary;
            callbacks.onThinking?.(summary);
          }
        }
        const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
        if (calls.length > 0) {
          for (let i = 0; i < calls.length; i++) {
            const tc = calls[i];
            this.trackParentToolCallMeta(tc.name, tc.args, callbacks);
            const callId = typeof tc.id === 'string' && tc.id ? tc.id : `wakeup-${step.step_index}-${i}`;
            const tool: AcpToolCall = { toolCallId: callId, name: tc.name, args: tc.args };
            const record: ToolCallRecord = {
              toolUseId: callId,
              name: antigravityToolName(tool.name, tool.kind, tool.rawInput ?? tool.args),
              summary: antigravityToolSummary(tool),
              status: 'pending',
              timestamp: Date.now(),
            };
            this.pendingTools.push(record);
            this.wakeupPendingTools.push({ callId, tool, startedAt: Date.now() });
            callbacks.onToolUse(record);
          }
          if (this.wakeupToolStallDeadlineMs === 0) this.refreshWakeupToolStallDeadline();
        } else if (step.status === 'DONE') {
          this.settleWakeupTools(callbacks, 'success');
          this.flushText(callbacks);
          this.parentWakeupInFlight = false;
        }
      } else if (step.type === 'GENERIC') {
        this.harvestParentGenericStep(step, callbacks);
        const pending = this.wakeupPendingTools.shift();
        if (pending) {
          const ok = step.status !== 'ERROR';
          if (ok && (pending.tool.name === 'write_file' || pending.tool.name === 'edit_file')) {
            const paths = antigravityEditedPaths(pending.tool);
            if (paths.length > 0) callbacks.onFilesEdited?.(paths);
          }
          callbacks.onToolResult?.(pending.callId, ok ? 'success' : 'error', Math.max(0, Date.now() - pending.startedAt));
        }
        this.refreshWakeupToolStallDeadline();
      } else if (step.type === 'ERROR_MESSAGE' && this.parentWakeupInFlight) {
        // `agy` often retries stream hiccups on the next step; bound the wait if no retry arrives.
        const graceMs = this.brainOptions?.wakeupGraceMs ?? DEFAULT_WAKEUP_GRACE_MS;
        this.wakeupDeadlineMs = Date.now() + graceMs;
      }
    }
    if (this.parentWakeupInFlight && this.wakeupDeadlineMs > 0 && !this.hasRunningSubagents() && this.activeBgTaskIds.size === 0 && Date.now() >= this.wakeupDeadlineMs && this.wakeupPendingTools.length === 0) {
      this.parentWakeupInFlight = false;
    }
  }

  private trackParentToolCallMeta(name: string | undefined, args: Record<string, unknown> | undefined, callbacks: SessionCallbacks): void {
    this.parentPendingToolCalls.push(extractBrainToolCallBgMeta(name, args));
    if (name === 'invoke_subagent') {
      this.parentPendingSpawns.push(extractSubagentSpawnMeta(args));
    } else if (name === 'send_message') {
      const recipient = cleanBrainArgString(args?.Recipient) ?? '';
      const child = recipient ? this.subagents.get(recipient) : undefined;
      if (child && !child.running) {
        child.running = true;
        child.sentMessageThisRun = false;
        child.lastStepError = undefined;
        callbacks.onTaskStarted?.(child.id, child.description, false, 'subagent', undefined, child.subagentType, child.parentAgentId, child.model);
        callbacks.onTaskUpdated?.(child.id, { status: 'in_progress', description: child.description });
      }
    } else if (name === 'manage_subagents') {
      this.handleManageSubagentsCall(args, callbacks);
    } else if (name === 'manage_task') {
      const action = cleanBrainArgString(args?.Action);
      const taskId = cleanBrainArgString(args?.TaskId);
      if (action === 'kill' && taskId && this.activeBgTaskIds.delete(taskId)) {
        callbacks.onTaskUpdated?.(taskId, { status: 'killed' });
        callbacks.onTaskNotification?.(taskId, 'stopped', 'Killed');
      }
    }
  }

  private handleManageSubagentsCall(args: Record<string, unknown> | undefined, callbacks: SessionCallbacks): void {
    const action = cleanBrainArgString(args?.Action) ?? '';
    if (action === 'kill_all') {
      for (const child of this.subagents.values()) this.markSubagentKilled(child, callbacks, 'Killed');
    } else if (action === 'kill') {
      for (const id of cleanBrainArgStringArray(args?.ConversationIds)) {
        const child = this.subagents.get(id);
        if (child) this.markSubagentKilled(child, callbacks, 'Killed');
      }
    }
  }

  private markSubagentKilled(child: TrackedSubagent, callbacks: SessionCallbacks, reason: string): void {
    child.activeBgTaskIds.clear();
    child.pendingToolCalls = [];
    child.pendingSpawns = [];
    if (!child.running) return;
    child.running = false;
    this.brainReader?.unwatchConversation(child.id);
    callbacks.onTaskUpdated?.(child.id, { status: 'killed' });
    callbacks.onTaskNotification?.(child.id, 'stopped', reason);
  }

  private harvestParentGenericStep(step: BrainTranscriptStep, callbacks: SessionCallbacks): void {
    const toolMeta = this.parentPendingToolCalls.shift();
    if (this.parentPendingSpawns.length > 0) {
      const created = parseAntigravityCreatedSubagent(step.content);
      if (created) {
        const meta = this.parentPendingSpawns.shift();
        this.registerSubagent(created.conversationId, meta, callbacks);
      }
    }
    if (toolMeta?.bgCapable && !toolMeta.isDaemon) {
      const bg = parseAntigravityBackgroundTask(step.content);
      if (bg && !this.activeBgTaskIds.has(bg.taskId)) {
        this.activeBgTaskIds.add(bg.taskId);
        callbacks.onTaskStarted?.(bg.taskId, 'Background task', false, 'bash');
      }
    }
  }

  private registerSubagent(id: string, meta: PendingSubagentSpawnMeta | undefined, callbacks: SessionCallbacks): void {
    const description = describeSubagentSpawn(meta);
    const existing = this.subagents.get(id);
    if (existing) {
      existing.running = true;
      existing.sentMessageThisRun = false;
      existing.lastStepError = undefined;
      callbacks.onTaskStarted?.(id, existing.description, false, 'subagent', undefined, existing.subagentType, existing.parentAgentId, existing.model);
      callbacks.onTaskUpdated?.(id, { status: 'in_progress', description: existing.description });
      return;
    }
    const tracked: TrackedSubagent = {
      id,
      description,
      subagentType: meta?.subagentType,
      parentAgentId: meta?.parentAgentId,
      model: meta?.model,
      running: true,
      sentMessageThisRun: false,
      pendingSpawns: [],
      pendingToolCalls: [],
      activeBgTaskIds: new Set<string>(),
    };
    this.subagents.set(id, tracked);
    this.brainReader?.watchConversation(id, () => this.onBrainTick());
    callbacks.onTaskStarted?.(id, description, false, 'subagent', undefined, tracked.subagentType, tracked.parentAgentId, tracked.model);
  }

  private consumeParentWakeupStep(step: BrainTranscriptStep, callbacks: SessionCallbacks, startWakeupTurn: boolean): void {
    const parsed = parseAntigravityWakeupMessage(step.content);
    if (parsed.senders.some((sender) => this.subagents.get(sender)?.running)) {
      this.syncSubagentTranscripts(callbacks);
    }
    const consumedCount = Math.max(1, parsed.senders.length);
    this.pendingWakeups = Math.max(0, this.pendingWakeups - consumedCount);
    for (const sender of parsed.senders) {
      if (this.activeBgTaskIds.delete(sender)) {
        callbacks.onTaskNotification?.(sender, 'completed', parsed.summary || 'Background task completed');
      }
      const subagent = this.subagents.get(sender);
      // If a child terminated fatally without a final PLANNER_RESPONSE, settle its pill when its wakeup reaches parent.
      if (subagent && subagent.running && subagent.lastStepError) {
        subagent.running = false;
        callbacks.onTaskUpdated?.(subagent.id, { status: 'failed', error: subagent.lastStepError });
        callbacks.onTaskNotification?.(subagent.id, 'failed', subagent.lastStepError);
      }
    }
    if (startWakeupTurn) {
      this.parentWakeupInFlight = true;
      this.wakeupDeadlineMs = 0;
      callbacks.onRawEvent?.({ type: 'antigravity/wakeup_system_message', stepIndex: step.step_index, senders: parsed.senders });
    }
  }

  private syncSubagentTranscripts(callbacks: SessionCallbacks): void {
    if (!this.brainReader || this.subagents.size === 0) return;
    const visited = new Set<string>();
    let progress = true;
    while (progress) {
      progress = false;
      for (const subagent of [...this.subagents.values()]) {
        if (visited.has(subagent.id)) continue;
        visited.add(subagent.id);
        this.brainReader.watchConversation(subagent.id, () => this.onBrainTick());
        const steps = this.brainReader.readNewSteps(subagent.id);
        for (const step of steps) {
          if (step.type === 'SYSTEM_MESSAGE') {
            const parsedWakeup = parseAntigravityWakeupMessage(step.content);
            for (const sender of parsedWakeup.senders) {
              subagent.activeBgTaskIds.delete(sender);
            }
            subagent.lastStepError = undefined;
            if (!subagent.running) {
              subagent.running = true;
              subagent.sentMessageThisRun = false;
              callbacks.onTaskStarted?.(subagent.id, subagent.description, false, 'subagent', undefined, subagent.subagentType, subagent.parentAgentId, subagent.model);
              callbacks.onTaskUpdated?.(subagent.id, { status: 'in_progress', description: subagent.description });
            }
          } else if (step.type === 'ERROR_MESSAGE') {
            subagent.lastStepError = firstSummaryLine(step.content, 200) ?? 'Subagent error';
          } else if (step.type === 'PLANNER_RESPONSE') {
            subagent.lastStepError = undefined;
            subagent.pendingSpawns = [];
            subagent.pendingToolCalls = [];
            if (typeof step.model === 'string' && step.model && !subagent.model) subagent.model = step.model;
            const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
            if (calls.length > 0) {
              subagent.running = true;
              for (const tc of calls) {
                subagent.pendingToolCalls.push(extractBrainToolCallBgMeta(tc.name, tc.args));
                if (tc.name === 'invoke_subagent') {
                  subagent.pendingSpawns.push(extractSubagentSpawnMeta(tc.args, subagent.id));
                } else if (tc.name === 'send_message' && cleanBrainArgString(tc.args?.Recipient) === this.sessionId) {
                  subagent.sentMessageThisRun = true;
                  subagent.lastSentMessage = cleanBrainArgString(tc.args?.Message);
                  this.noteExpectedParentWakeup();
                } else if (tc.name === 'manage_subagents') {
                  this.handleManageSubagentsCall(tc.args, callbacks);
                } else if (tc.name === 'manage_task') {
                  const action = cleanBrainArgString(tc.args?.Action);
                  const taskId = cleanBrainArgString(tc.args?.TaskId);
                  if (action === 'kill' && taskId) subagent.activeBgTaskIds.delete(taskId);
                }
              }
              const lastTool = calls[calls.length - 1];
              callbacks.onTaskProgress?.(subagent.id, subagent.description, antigravityToolName(lastTool?.name, undefined, lastTool?.args));
            } else if (step.status === 'DONE' && subagent.running) {
              if (subagent.activeBgTaskIds.size > 0) {
                // Child yielded its LLM turn while waiting on its own background command/timer; keep it running until woken.
                const waitingSummary = firstSummaryLine(step.content, 240);
                if (waitingSummary) callbacks.onTaskProgress?.(subagent.id, waitingSummary);
              } else {
                subagent.running = false;
                const summary = firstSummaryLine(step.content, 240)
                  ?? firstSummaryLine(subagent.lastSentMessage, 240)
                  ?? subagent.description;
                callbacks.onTaskNotification?.(subagent.id, 'completed', summary);
                if (!subagent.sentMessageThisRun && !subagent.parentAgentId) {
                  this.noteExpectedParentWakeup();
                }
              }
            }
          } else if (step.type === 'GENERIC') {
            const toolMeta = subagent.pendingToolCalls.shift();
            if (subagent.pendingSpawns.length > 0) {
              const created = parseAntigravityCreatedSubagent(step.content);
              if (created) {
                const meta = subagent.pendingSpawns.shift() ?? { parentAgentId: subagent.id };
                this.registerSubagent(created.conversationId, meta, callbacks);
                progress = true;
              }
            }
            if (toolMeta?.bgCapable && !toolMeta.isDaemon) {
              const bg = parseAntigravityBackgroundTask(step.content);
              if (bg) {
                subagent.activeBgTaskIds.add(bg.taskId);
              }
            }
          }
        }
      }
    }
  }

  private settleWakeupTools(callbacks: SessionCallbacks, outcome: 'success' | 'error'): void {
    while (this.wakeupPendingTools.length > 0) {
      const pending = this.wakeupPendingTools.shift()!;
      callbacks.onToolResult?.(pending.callId, outcome, Math.max(0, Date.now() - pending.startedAt));
    }
    this.wakeupToolStallDeadlineMs = 0;
  }

  private settleWakeupToolsAsError(callbacks: SessionCallbacks): void {
    this.settleWakeupTools(callbacks, 'error');
  }

  /**
   * When `agy acp` runs without `--dangerously-skip-permissions`, post-ACP `<SYSTEM_MESSAGE>` wakeups have no open
   * `session/prompt` RPC stream on which to emit `session/request_permission`, so permission-gated tools (`run_command`,
   * external MCP calls, or out-of-workspace file edits) wedge internally. Cancel the wedged internal wakeup and promote
   * continuation onto an active `session/prompt` RPC so `agy` can request permission normally.
   */
  private async promoteStalledWakeupToPrompt(callbacks: SessionCallbacks): Promise<void> {
    if (this.promotingWakeup || this.closed || !this._turnInFlight || this.acpPromptInFlight) return;
    const client = this.client;
    const sessionId = this.sessionId;
    if (!client || !sessionId) return;

    this.promotingWakeup = true;
    this.wakeupToolStallDeadlineMs = 0;
    callbacks.onRawEvent?.({
      type: 'antigravity/wakeup_promoted_to_prompt',
      sessionId,
      stalledTools: this.wakeupPendingTools.map((t) => t.tool.name ?? 'unknown'),
    });
    this.settleWakeupToolsAsError(callbacks);
    this.flushText(callbacks);
    this.parentWakeupInFlight = false;

    client.notify('session/cancel', { sessionId });
    const settleMs = this.brainOptions?.wakeupCancelSettleMs ?? DEFAULT_WAKEUP_CANCEL_SETTLE_MS;
    await new Promise((resolve) => setTimeout(resolve, settleMs));

    this.promotingWakeup = false;
    if (this.closed || !this._turnInFlight || this.client !== client || this.sessionId !== sessionId) return;

    if (this.brainReader) {
      const maxIdx = this.brainReader.peekMaxStepIndex(sessionId);
      if (maxIdx > this.brainReader.getLastStepIndex(sessionId)) {
        this.brainReader.setBaselineStepIndex(sessionId, maxIdx);
      }
    }

    this.acpPromptInFlight = true;
    this.acpTurnBrainEnded = false;
    const prompt = [
      {
        type: 'text',
        text: '[System: Resuming background wakeup over active ACP session so pending tool calls can request permission and execute. Continue from your last step without repeating completed work.]',
      },
    ];
    client.request('session/prompt', { sessionId, prompt })
      .then((result) => this.finishTurn(result))
      .catch((error) => {
        if (this.closed || !this._turnInFlight) return;
        this.abortBackgroundWork(callbacks, 'Failed');
        this.cancelPendingElicitations();
        this.resetTurnState();
        callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      });
  }

  private abortBackgroundWork(callbacks: SessionCallbacks, reason: string): void {
    for (const subagent of this.subagents.values()) {
      subagent.activeBgTaskIds.clear();
      subagent.pendingToolCalls = [];
      subagent.pendingSpawns = [];
      if (subagent.running) {
        subagent.running = false;
        callbacks.onTaskUpdated?.(subagent.id, { status: 'killed' });
        callbacks.onTaskNotification?.(subagent.id, 'stopped', reason);
      }
    }
    for (const taskId of [...this.activeBgTaskIds]) {
      this.activeBgTaskIds.delete(taskId);
      callbacks.onTaskUpdated?.(taskId, { status: 'killed' });
      callbacks.onTaskNotification?.(taskId, 'stopped', reason);
    }
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
      callbacks.onPermissionRequest(`Antigravity: ${antigravityToolName(tool.name, kind, tool.rawInput ?? tool.args)}`, antigravityPermissionDetail(tool))
        .then((allow) => settle(allow ? select('allow_once', 'allow') : select('reject_once', 'deny')))
        .catch(() => settle(select('reject_once', 'deny')));
    });
  }

  /** Public for tests: answer one ACP `elicitation/create` request (wired to `callbacks.onAskUserQuestion`). */
  async handleElicitationCreate(params: AntigravityElicitationParams | undefined): Promise<Record<string, unknown>> {
    const callbacks = this.options?.callbacks;
    if (!callbacks || this.closed) return { action: 'cancel' };
    callbacks.onRawEvent?.({
      type: 'antigravity/elicitation_create',
      toolCallId: params?.toolCallId,
      mode: params?.mode,
      message: params?.message,
      requestedSchema: params?.requestedSchema,
    });
    // Never stall an unattended/scheduled `dontAsk` run; `{ action: 'cancel' }` resolves `User Skipped` in `agy`
    // without triggering the JSON-RPC error fallback that dumps questions into chat.
    if ((this.options?.permissionMode ?? 'default') === 'dontAsk') return { action: 'cancel' };

    const fields = parseAntigravityElicitation(params);
    if (!fields) return { action: 'decline' };
    if (!callbacks.onAskUserQuestion) return { action: 'cancel' };

    const key = `${params?.elicitationId ?? params?.toolCallId ?? 'elicitation'}-${++this.elicitationSeq}`;
    return new Promise<Record<string, unknown>>((resolve) => {
      let answered = false;
      const settle = (result: Record<string, unknown>) => {
        if (answered) return;
        answered = true;
        this.pendingElicitations.delete(key);
        resolve(result);
      };
      this.pendingElicitations.set(key, settle);
      callbacks.onAskUserQuestion(fields.map((field) => field.askQuestion))
        .then((answers) => settle(buildAntigravityElicitationReply(fields, answers)))
        .catch(() => settle({ action: 'cancel' }));
    });
  }

  private cancelPendingElicitations(): void {
    if (this.pendingElicitations.size === 0) return;
    for (const resolve of [...this.pendingElicitations.values()]) resolve({ action: 'cancel' });
    this.pendingElicitations.clear();
    this.options?.callbacks.onAskUserQuestionCanceled?.();
  }

  private isBridgedHostTool(tool: AcpToolCall): boolean {
    if (!this.bridge) return false;
    const name = tool.name ?? '';
    const prefix = `mcp_${OPENCODE_HOST_TOOLS_SERVER}_`;
    return name.startsWith(prefix) && this.hostToolNames.has(name.slice(prefix.length));
  }
}

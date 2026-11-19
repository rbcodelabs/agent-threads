/**
 * Local brain transcript reader and subagent/wakeup state tracker for Antigravity (`agy acp`).
 *
 * Why this exists:
 * `agy acp` (verified against ACP server 1.5.8 / 1.5.9) streams `session/update` notifications only for the parent
 * session's active `session/prompt` RPC. It omits the spawned child `conversationId` from `invoke_subagent` tool updates,
 * emits no child subagent progress or completion notifications over ACP, and runs reactive wakeup turns (triggered when
 * a child subagent or background task sends a message or goes idle) internally after `session/prompt` has already
 * returned. Meanwhile, `agy` writes deterministic step-by-step JSONL state logs for the parent and every child
 * conversation under `<brainDir>/<conversationId>/.system_generated/logs/transcript_full.jsonl` (falling back to
 * `transcript.jsonl`).
 *
 * Mobile/core invariant:
 * This module sits in the daemon/mobile core closure (imported by `AntigravitySession.ts`). Never import Node built-ins
 * (`fs`, `path`, `os`) at module load time; load them lazily inside runtime methods so mobile bundles never evaluate
 * `require('fs')` on startup.
 */
import type * as FsTypes from 'fs';
import type * as OsTypes from 'os';
import type * as PathTypes from 'path';

export interface BrainToolCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

export interface BrainTranscriptStep {
  step_index: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  model?: string;
  thinking?: string;
  content?: string;
  tool_calls?: BrainToolCall[];
}

export interface AntigravityBrainOptions {
  /** Override `<home>/.gemini/antigravity-cli/brain` (used by unit tests). */
  brainDir?: string;
  /** Poll cadence while a turn or background subagent is active (default 250ms). */
  pollIntervalMs?: number;
  /**
   * Bounded fallback window (default 2500ms) waiting for `agy` to write the parent `<SYSTEM_MESSAGE>` after a child
   * subagent finishes. `agy acp` has no post-turn ACP notification stream, so if `agy` suppresses a wakeup (e.g. silent
   * cancellation or a future CLI change), this prevents holding the turn open indefinitely.
   */
  wakeupGraceMs?: number;
  /**
   * Time (default 2500ms) a post-ACP wakeup tool call may remain pending without `--dangerously-skip-permissions`
   * before `AntigravitySession` cancels the wedged internal wakeup and promotes it to an active `session/prompt` RPC so
   * `agy` can forward `session/request_permission`.
   */
  wakeupToolStallMs?: number;
  /** Settle delay (default 150ms) between `session/cancel` and continuation `session/prompt` on stalled wakeup promotion. */
  wakeupCancelSettleMs?: number;
}

export interface PendingSubagentSpawnMeta {
  role?: string;
  subagentType?: string;
  prompt?: string;
  model?: string;
  parentAgentId?: string;
}

export interface PendingBrainToolCallMeta {
  bgCapable: boolean;
  isDaemon: boolean;
}

export interface TrackedSubagent {
  id: string;
  description: string;
  subagentType?: string;
  parentAgentId?: string;
  model?: string;
  running: boolean;
  sentMessageThisRun: boolean;
  lastSentMessage?: string;
  lastStepError?: string;
  pendingSpawns: PendingSubagentSpawnMeta[];
  pendingToolCalls: PendingBrainToolCallMeta[];
  activeBgTaskIds: Set<string>;
}

interface TranscriptCursor {
  filePath?: string;
  byteOffset: number;
  lastStepIndex: number;
}

// ── Pure step & argument parsers (exported for unit tests) ─────────────────

const CREATED_SUBAGENT_PREFIX = 'Created the ' + 'following subagent:';
const BG_TASK_PREFIX = 'Tool is running as a ' + 'background task with task id:';
const VALID_CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/;
const VALID_BG_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_/-]{1,160}$/;

/**
 * Normalize a string tool-call argument from an Antigravity brain transcript.
 * When `transcript.jsonl` (compact) truncates `tool_calls`, `agy` may serialize string arguments as JSON-encoded
 * strings (e.g. `"\"ecf60001-...\""`). Unwrap one layer of JSON string quoting when valid.
 */
export function cleanBrainArgString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed.trim() || undefined;
    } catch {
      return trimmed.slice(1, -1).trim() || undefined;
    }
  }
  return trimmed;
}

/**
 * Normalize a `string[]` tool-call argument (such as `manage_subagents.ConversationIds`), unwrapping compact-log
 * JSON-encoded arrays (`"[\"id-1\",\"id-2\"]"`) as well as individually quoted elements.
 */
export function cleanBrainArgStringArray(value: unknown): string[] {
  let items: unknown[] | undefined;
  if (Array.isArray(value)) {
    items = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) items = parsed;
      } catch {
        items = undefined;
      }
    }
  }
  if (!items) return [];
  const out: string[] = [];
  for (const item of items) {
    const cleaned = cleanBrainArgString(item);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

/**
 * Normalize a boolean tool-call argument (such as `IsDaemon` on `run_command`/`schedule`), handling native booleans
 * in `transcript_full.jsonl` as well as stringified/JSON-quoted booleans (`"true"`, `"\"true\""`) in `transcript.jsonl`.
 */
export function cleanBrainArgBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const cleaned = cleanBrainArgString(value);
    return cleaned?.toLowerCase() === 'true';
  }
  return false;
}

export function isAntigravityBgCapableTool(name: string | undefined): boolean {
  return name === 'run_command' || name === 'schedule' || name === 'run_workflow';
}

export function extractBrainToolCallBgMeta(
  name: string | undefined,
  args: Record<string, unknown> | undefined,
): PendingBrainToolCallMeta {
  const bgCapable = isAntigravityBgCapableTool(name);
  const isDaemon = (name === 'run_command' || name === 'schedule') && cleanBrainArgBoolean(args?.IsDaemon);
  return { bgCapable, isDaemon };
}

function firstCleanLine(value: unknown, maxChars = 200): string | undefined {
  const unwrapped = cleanBrainArgString(value);
  if (!unwrapped) return undefined;
  const line = unwrapped
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  return line ? line.slice(0, maxChars) : undefined;
}

function stripBrainGenericTimestampHeader(content: string): string {
  return content.replace(/^(?:(?:Created|Completed) At:[^\r\n]*\r?\n)+/, '');
}

/**
 * Extract the child `conversationId` from an `invoke_subagent` `GENERIC` step output.
 * Anchored to the start of the step payload (after optional `Created At:` / `Completed At:` header lines) and validated
 * against `VALID_CONVERSATION_ID_RE` so file reads, diffs, and placeholder strings never register phantom subagents.
 */
export function parseAntigravityCreatedSubagent(content: string | undefined): { conversationId: string } | null {
  if (typeof content !== 'string' || !content) return null;
  const body = stripBrainGenericTimestampHeader(content).trimStart();
  if (!body.startsWith(CREATED_SUBAGENT_PREFIX)) return null;
  const rest = body.slice(CREATED_SUBAGENT_PREFIX.length).trimStart();
  if (!rest.startsWith('{')) return null;
  const closeBrace = rest.indexOf('}');
  if (closeBrace < 0) return null;
  const jsonBlock = rest.slice(0, closeBrace + 1);
  try {
    const parsed = JSON.parse(jsonBlock) as { conversationId?: unknown };
    const id = cleanBrainArgString(parsed?.conversationId);
    if (id && VALID_CONVERSATION_ID_RE.test(id)) return { conversationId: id };
  } catch {
    const m = jsonBlock.match(/"conversationId"\s*:\s*"([^"]+)"/);
    const id = m?.[1]?.trim();
    if (id && VALID_CONVERSATION_ID_RE.test(id)) return { conversationId: id };
  }
  return null;
}

/**
 * Extract a background task ID (`<conversationId>/<taskId>`) from an async `GENERIC` step output (`run_command`,
 * `schedule`, `run_workflow`). Anchored to the start of the step payload (after optional timestamp lines).
 */
export function parseAntigravityBackgroundTask(content: string | undefined): { taskId: string } | null {
  if (typeof content !== 'string' || !content) return null;
  const body = stripBrainGenericTimestampHeader(content).trimStart();
  if (!body.startsWith(BG_TASK_PREFIX)) return null;
  const firstLine = body.slice(BG_TASK_PREFIX.length).split(/\r?\n/, 1)[0]?.trim() ?? '';
  const token = firstLine.split(/\s+/, 1)[0] ?? '';
  if (token && VALID_BG_TASK_ID_RE.test(token)) return { taskId: token };
  return null;
}

/**
 * Parse a `<SYSTEM_MESSAGE>` step delivered to a conversation when a child subagent or background task reports back.
 * Handles both `[Message] ... sender=<id>` envelopes and `"Subagent <id> has gone idle"` notifications.
 */
export function parseAntigravityWakeupMessage(content: string | undefined): { senders: string[]; summary: string } {
  if (typeof content !== 'string' || !content.trim()) return { senders: [], summary: '' };
  const senders: string[] = [];
  for (const match of content.matchAll(/\[Message\][^\n]*?\bsender=([^\s\n<]+)/g)) {
    if (match[1]) senders.push(match[1].trim());
  }
  const idleMatch = content.match(/Subagent\s+([0-9a-fA-F-]+)\s+has gone idle/);
  if (idleMatch?.[1] && !senders.includes(idleMatch[1])) senders.push(idleMatch[1]);

  const stripped = content
    .replace(/<\/?SYSTEM_MESSAGE>/g, '')
    .replace(/You have received the following message\(s\) while idle:/g, '')
    .replace(/\[Message\][^\n]*/g, '')
    .trim();
  return {
    senders,
    summary: firstCleanLine(stripped, 240) ?? 'Background update received',
  };
}

/** Extract a concise single-line preview from streaming `agent_thought_chunk` text or `step.thinking`. */
export function extractAntigravityThoughtSummary(raw: string | undefined, maxLen = 140): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const cleaned = lines[i]
      .replace(/^[\s>*#-]+/, '')
      .replace(/\*\*|__/g, '')
      .replace(/`/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length >= 4) {
      return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
    }
  }
  return undefined;
}

/** Build spawn metadata from an `invoke_subagent` tool call's arguments. */
export function extractSubagentSpawnMeta(args: Record<string, unknown> | undefined, parentAgentId?: string): PendingSubagentSpawnMeta {
  const role = firstCleanLine(args?.Role, 120);
  const subagentType = firstCleanLine(args?.TypeName, 80);
  const prompt = firstCleanLine(args?.Prompt, 160);
  const rawModel = firstCleanLine(args?.Model, 80);
  const model = rawModel && rawModel !== 'inherit' ? rawModel : undefined;
  return { role, subagentType, prompt, model, parentAgentId };
}

export function describeSubagentSpawn(meta: PendingSubagentSpawnMeta | undefined): string {
  return meta?.role || meta?.subagentType || meta?.prompt || 'Subagent';
}

/** Parse complete `\n`-terminated JSONL transcript lines after `afterStepIndex`. */
export function parseCompleteJsonlSteps(
  chunk: string,
  afterStepIndex: number,
): { consumedChars: number; steps: BrainTranscriptStep[]; maxStepIndex: number } {
  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline < 0) return { consumedChars: 0, steps: [], maxStepIndex: afterStepIndex };
  const complete = chunk.slice(0, lastNewline + 1);
  const steps: BrainTranscriptStep[] = [];
  let maxStepIndex = afterStepIndex;
  for (const rawLine of complete.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as BrainTranscriptStep;
      if (typeof parsed?.step_index === 'number' && Number.isFinite(parsed.step_index)) {
        if (parsed.step_index > maxStepIndex) maxStepIndex = parsed.step_index;
        if (parsed.step_index > afterStepIndex) steps.push(parsed);
      }
    } catch {
      // Ignore malformed lines; partial trailing writes are already excluded by `lastNewline`.
    }
  }
  steps.sort((a, b) => a.step_index - b.step_index);
  return { consumedChars: complete.length, steps, maxStepIndex };
}

// ── Lazy Node I/O transcript reader & watcher ──────────────────────────────

function loadNodeDeps(): { fs: typeof FsTypes; os: typeof OsTypes; path: typeof PathTypes } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof FsTypes;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('os') as typeof OsTypes;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof PathTypes;
    if (!fs || typeof fs.existsSync !== 'function') return null;
    return { fs, os, path };
  } catch {
    return null;
  }
}

export function resolveDefaultAntigravityBrainDir(env?: Record<string, string | undefined>): string | undefined {
  const deps = loadNodeDeps();
  if (!deps) return undefined;
  const home = env?.HOME || env?.USERPROFILE || deps.os.homedir?.();
  if (!home) return undefined;
  return deps.path.join(home, '.gemini', 'antigravity-cli', 'brain');
}

export class BrainTranscriptReader {
  private cursors = new Map<string, TranscriptCursor>();
  private watchers = new Map<string, FsTypes.FSWatcher>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly brainDir: string | undefined,
    private readonly pollIntervalMs = 250,
  ) {}

  private resolveLogFile(conversationId: string): string | undefined {
    if (!this.brainDir || !conversationId) return undefined;
    const deps = loadNodeDeps();
    if (!deps) return undefined;
    const logsDir = deps.path.join(this.brainDir, conversationId, '.system_generated', 'logs');
    const fullPath = deps.path.join(logsDir, 'transcript_full.jsonl');
    if (deps.fs.existsSync(fullPath)) return fullPath;
    const compactPath = deps.path.join(logsDir, 'transcript.jsonl');
    if (deps.fs.existsSync(compactPath)) return compactPath;
    return undefined;
  }

  hasTranscript(conversationId: string | undefined): boolean {
    return Boolean(conversationId && this.resolveLogFile(conversationId));
  }

  /** Inspect the highest `step_index` currently on disk without mutating or registering a live cursor. */
  peekMaxStepIndex(conversationId: string | undefined): number {
    if (!conversationId) return -1;
    const filePath = this.resolveLogFile(conversationId);
    const deps = loadNodeDeps();
    if (!filePath || !deps) return -1;
    try {
      const text = deps.fs.readFileSync(filePath, 'utf8');
      return parseCompleteJsonlSteps(text, -1).maxStepIndex;
    } catch {
      return -1;
    }
  }

  setBaselineStepIndex(conversationId: string, stepIndex: number): void {
    const existing = this.cursors.get(conversationId);
    if (existing) {
      existing.lastStepIndex = Math.max(existing.lastStepIndex, stepIndex);
    } else {
      this.cursors.set(conversationId, { byteOffset: 0, lastStepIndex: stepIndex });
    }
  }

  getLastStepIndex(conversationId: string): number {
    return this.cursors.get(conversationId)?.lastStepIndex ?? -1;
  }

  /** Advance the recorded `lastStepIndex` manually (used when `syncDuringAcp` stops cleanly at turn boundary). */
  rewindCursorToStep(conversationId: string, stepIndex: number): void {
    const cursor = this.cursors.get(conversationId);
    if (!cursor) {
      this.cursors.set(conversationId, { byteOffset: 0, lastStepIndex: stepIndex });
      return;
    }
    // Reset `byteOffset` so any unconsumed steps after `stepIndex` are re-read cleanly on the next pass.
    cursor.byteOffset = 0;
    cursor.lastStepIndex = stepIndex;
  }

  /** Read all complete steps strictly newer than the cursor's `lastStepIndex`. */
  readNewSteps(conversationId: string): BrainTranscriptStep[] {
    const filePath = this.resolveLogFile(conversationId);
    const deps = loadNodeDeps();
    if (!filePath || !deps) return [];
    let cursor = this.cursors.get(conversationId);
    if (!cursor) {
      cursor = { filePath, byteOffset: 0, lastStepIndex: -1 };
      this.cursors.set(conversationId, cursor);
    }
    // Switching from `transcript.jsonl` to `transcript_full.jsonl` changes byte offsets; `lastStepIndex` prevents replay.
    if (cursor.filePath !== filePath) {
      cursor.filePath = filePath;
      cursor.byteOffset = 0;
    }
    try {
      const stat = deps.fs.statSync(filePath);
      if (stat.size < cursor.byteOffset) cursor.byteOffset = 0;
      if (stat.size === cursor.byteOffset) return [];
      const fd = deps.fs.openSync(filePath, 'r');
      try {
        const length = stat.size - cursor.byteOffset;
        const buf = Buffer.alloc(length);
        const bytesRead = deps.fs.readSync(fd, buf, 0, length, cursor.byteOffset);
        const slice = buf.subarray(0, bytesRead);
        const lastNewlineByte = slice.lastIndexOf(0x0a);
        if (lastNewlineByte < 0) return [];
        const completeChunk = slice.subarray(0, lastNewlineByte + 1).toString('utf8');
        const parsed = parseCompleteJsonlSteps(completeChunk, cursor.lastStepIndex);
        cursor.byteOffset += lastNewlineByte + 1;
        cursor.lastStepIndex = parsed.maxStepIndex;
        return parsed.steps;
      } finally {
        deps.fs.closeSync(fd);
      }
    } catch {
      return [];
    }
  }

  /** Ensure an opportunistic `fs.watch` is attached to `<brainDir>/<id>/.system_generated/logs` when present. */
  watchConversation(conversationId: string, onChange: () => void): void {
    if (!this.brainDir || !conversationId || this.watchers.has(conversationId)) return;
    const deps = loadNodeDeps();
    if (!deps) return;
    const logsDir = deps.path.join(this.brainDir, conversationId, '.system_generated', 'logs');
    if (!deps.fs.existsSync(logsDir)) return;
    try {
      const watcher = deps.fs.watch(logsDir, { persistent: false }, () => onChange());
      watcher.on('error', () => {
        this.unwatchConversation(conversationId);
      });
      this.watchers.set(conversationId, watcher);
    } catch {
      // Polling remains active whenever `fs.watch` is unavailable or the directory disappears.
    }
  }

  unwatchConversation(conversationId: string): void {
    const watcher = this.watchers.get(conversationId);
    if (!watcher) return;
    this.watchers.delete(conversationId);
    try { watcher.close(); } catch { /* ignore */ }
  }

  startPolling(onTick: () => void): void {
    if (this.pollTimer || !this.brainDir) return;
    const timer = setInterval(onTick, Math.max(10, this.pollIntervalMs));
    (timer as any).unref?.();
    this.pollTimer = timer;
  }

  stopWatching(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const id of [...this.watchers.keys()]) this.unwatchConversation(id);
  }

  reset(): void {
    this.stopWatching();
    this.cursors.clear();
  }
}

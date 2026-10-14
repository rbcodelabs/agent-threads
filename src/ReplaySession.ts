import type { HarnessSession, HarnessSessionOptions } from './HarnessSession';
import type { SessionCallbacks, TaskTrackerEvent } from './ClaudeSession';
import { formatToolSummary } from './ClaudeSession';
import type { ImageAttachment, ToolCallRecord } from './types';

/**
 * Scripted harness used to record product demos deterministically.
 *
 * It is NOT a user feature: `HarnessFactory` only returns it when the host
 * process sets `CLAUDE_THREADS_DEMO_SCRIPT` to a JSON file (see `demo/`). With
 * the variable unset the factory never reaches this module's code paths, so
 * normal behaviour is unchanged.
 *
 * A script maps user prompts to canned turns. Each turn replays the same
 * callbacks a real `ThreadSession` fires (token deltas, tool_use, message,
 * tool results, permission requests, sub-agent task events, task-list events,
 * done), with explicit pacing so a recording is repeatable and costs no tokens.
 */

/** One tool call inside a scripted assistant message. */
export interface ReplayTool {
  name: string;
  /** Tool input, shown in the permission card and used to derive the pill summary. */
  input?: Record<string, unknown>;
  /** Overrides the summary derived from `name` + `input`. */
  summary?: string;
  /** How long the tool "runs" before its result arrives. Default 700. */
  durationMs?: number;
  /** Default 'success'. */
  status?: 'success' | 'error';
  /** Files this tool changed; reported through `onFilesEdited` once the tool succeeds. */
  filesEdited?: string[];
  /** Ask the user before the tool runs. Allow runs the tool; deny runs `ifDenied`. */
  permission?: {
    /** Defaults to `JSON.stringify(input)`. */
    detail?: string;
    /** Steps replayed when the user denies. */
    ifDenied?: ReplayStep[];
  };
  /** Marks this tool as a sub-agent launch and replays its task lifecycle. */
  agent?: ReplayAgent;
  /** Task-list change reported when the tool is issued (TaskCreate / TaskUpdate / TodoWrite). */
  taskEvent?: TaskTrackerEvent;
}

export interface ReplayAgent {
  taskId: string;
  description: string;
  subagentType?: string;
  /** Progress ticks, `afterMs` after the previous tick (or the start). */
  progress?: { afterMs: number; description: string; lastToolName?: string }[];
  /** Time from the last tick to completion. Default 600. */
  finishAfterMs?: number;
  summary?: string;
  /** If true the sub-agent never finishes on its own (it stays "running"). */
  hold?: boolean;
}

export type ReplayStep =
  | {
      type: 'message';
      /** Streamed as token deltas, then committed as the assistant message. */
      text?: string;
      /** Streaming speed. Default `pacing.charsPerSecond`. */
      charsPerSecond?: number;
      tools?: ReplayTool[];
    }
  | { type: 'pause'; ms: number }
  /** Blocks until the thread is interrupted or closed (keeps a thread "running" for a scene). */
  | { type: 'hold' };

export interface ReplayTurn {
  /** Case-insensitive regular expression tested against the user prompt. Omit to match any prompt. */
  match?: string;
  steps: ReplayStep[];
}

export interface ReplayScript {
  version: 1;
  /** Reported through `onActiveModel`. */
  model?: string;
  /** Slash commands and skills reported through `onCommandsChanged` when the session starts. */
  commands?: { name: string; description: string; argumentHint?: string }[];
  pacing?: {
    /** Streaming speed for message text. Default 90. */
    charsPerSecond?: number;
    /** Characters per emitted token delta. Default 4. */
    chunkChars?: number;
  };
  turns: ReplayTurn[];
  /** Used when no turn matches. */
  fallback?: ReplayStep[];
}

const DEFAULT_CPS = 90;
const DEFAULT_CHUNK = 4;
const DEFAULT_TOOL_MS = 700;
const DEFAULT_AGENT_FINISH_MS = 600;

export class ReplayScriptError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSteps(steps: unknown, where: string, errors: string[]): void {
  if (!Array.isArray(steps)) {
    errors.push(`${where}: steps must be an array`);
    return;
  }
  steps.forEach((step, i) => {
    const at = `${where}[${i}]`;
    if (!isObject(step)) return void errors.push(`${at}: must be an object`);
    if (step.type === 'pause') {
      if (typeof step.ms !== 'number' || step.ms < 0) errors.push(`${at}: pause needs ms >= 0`);
    } else if (step.type === 'hold') {
      // no fields
    } else if (step.type === 'message') {
      if (step.text !== undefined && typeof step.text !== 'string') errors.push(`${at}.text: must be a string`);
      if (step.tools !== undefined && !Array.isArray(step.tools)) errors.push(`${at}.tools: must be an array`);
      (Array.isArray(step.tools) ? step.tools : []).forEach((tool: unknown, j: number) => {
        const tat = `${at}.tools[${j}]`;
        if (!isObject(tool) || typeof tool.name !== 'string' || !tool.name) return void errors.push(`${tat}: needs a name`);
        if (isObject(tool.permission)) validateSteps(tool.permission.ifDenied ?? [], `${tat}.permission.ifDenied`, errors);
        if (isObject(tool.agent) && (typeof tool.agent.taskId !== 'string' || typeof tool.agent.description !== 'string')) {
          errors.push(`${tat}.agent: needs taskId and description`);
        }
      });
    } else {
      errors.push(`${at}: unknown step type ${JSON.stringify(step.type)}`);
    }
  });
}

/** Collects every problem so one edit-validate loop fixes a script. */
export function validateReplayScript(raw: unknown): string[] {
  if (!isObject(raw)) return ['script must be a JSON object'];
  const errors: string[] = [];
  if (raw.version !== 1) errors.push('version: must be 1');
  if (!Array.isArray(raw.turns)) {
    errors.push('turns: must be an array');
  } else {
    raw.turns.forEach((turn, i) => {
      const at = `turns[${i}]`;
      if (!isObject(turn)) return void errors.push(`${at}: must be an object`);
      if (turn.match !== undefined) {
        if (typeof turn.match !== 'string') errors.push(`${at}.match: must be a string`);
        else {
          try {
            new RegExp(turn.match, 'i');
          } catch {
            errors.push(`${at}.match: invalid regular expression`);
          }
        }
      }
      validateSteps(turn.steps, `${at}.steps`, errors);
    });
  }
  if (raw.fallback !== undefined) validateSteps(raw.fallback, 'fallback', errors);
  return errors;
}

export function parseReplayScript(raw: unknown): ReplayScript {
  const errors = validateReplayScript(raw);
  if (errors.length) throw new ReplayScriptError(`Invalid demo script:\n  - ${errors.join('\n  - ')}`);
  return raw as ReplayScript;
}

/** First turn whose `match` accepts the prompt (a turn without `match` accepts any). */
export function selectTurn(script: ReplayScript, prompt: string): ReplayStep[] {
  for (const turn of script.turns) {
    if (turn.match === undefined || new RegExp(turn.match, 'i').test(prompt)) return turn.steps;
  }
  return script.fallback ?? [];
}

export interface ReplaySessionOptions {
  /** Injected so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
}

class Cancelled extends Error {}

export class ReplaySession implements HarnessSession {
  private callbacks: SessionCallbacks | null = null;
  private options: HarnessSessionOptions | null = null;
  private _turnInFlight = false;
  private pendingPermissions = 0;
  private closed = false;
  /** Bumped by interrupt/close so an in-flight replay stops at its next await. */
  private epoch = 0;
  private readonly sessionId = `replay-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  /** Resolvers for every sleep/hold currently waiting, so interrupt/close can end them all. */
  private readonly wakers = new Set<() => void>();
  private turnCount = 0;

  constructor(private readonly script: ReplayScript, opts: ReplaySessionOptions = {}) {
    this.sleepImpl = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get turnInFlight(): boolean {
    return this._turnInFlight;
  }
  get cwd(): string | undefined {
    return this.options?.cwd;
  }
  get hasPendingPermission(): boolean {
    return this.pendingPermissions > 0;
  }
  canIdleReap(): boolean {
    return !this._turnInFlight && !this.hasPendingPermission;
  }

  async start(options: HarnessSessionOptions): Promise<void> {
    this.options = options;
    this.callbacks = options.callbacks;
    this.closed = false;
    if (this.script.model) options.callbacks.onActiveModel?.(this.script.model);
    if (this.script.commands?.length) {
      options.callbacks.onCommandsChanged?.(this.script.commands.map((c) => ({ argumentHint: '', ...c })));
    }
  }

  send(text: string, _images?: ImageAttachment[], _userMessageUuid?: string): void {
    const callbacks = this.callbacks;
    if (!callbacks) throw new Error('ReplaySession.send() called before start()');
    if (this.closed) throw new Error('ReplaySession is closed');
    const steps = selectTurn(this.script, text);
    const epoch = this.epoch;
    this._turnInFlight = true;
    this.turnCount++;
    void this.runTurn(steps, callbacks, epoch);
  }

  async interrupt(): Promise<void> {
    this.epoch++;
    this.wakeAll();
  }

  close(): void {
    this.closed = true;
    this.epoch++;
    this.wakeAll();
  }

  async setModel(_model: string | undefined): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async getContextUsage(): Promise<null> {
    return null;
  }
  async getUsageSnapshot(): Promise<null> {
    return null;
  }

  private async runTurn(steps: ReplayStep[], callbacks: SessionCallbacks, epoch: number): Promise<void> {
    try {
      await this.runSteps(steps, callbacks, epoch);
      if (epoch !== this.epoch) throw new Cancelled();
      this._turnInFlight = false;
      callbacks.onDone(this.sessionId, 0, this.turnCount, undefined);
    } catch (err) {
      this._turnInFlight = false;
      if (err instanceof Cancelled) {
        if (!this.closed) callbacks.onInterrupted(this.sessionId);
        return;
      }
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async runSteps(steps: ReplayStep[], callbacks: SessionCallbacks, epoch: number): Promise<void> {
    for (const step of steps) {
      this.check(epoch);
      switch (step.type) {
        case 'pause':
          await this.sleep(step.ms, epoch);
          break;
        case 'hold':
          await this.waitForWake().promise;
          this.check(epoch);
          break;
        case 'message':
          await this.runMessage(step, callbacks, epoch);
          break;
      }
    }
  }

  private check(epoch: number): void {
    if (epoch !== this.epoch) throw new Cancelled();
  }

  /** Sleep that ends early (and cancels the turn) when the session is interrupted or closed. */
  private async sleep(ms: number, epoch: number): Promise<void> {
    if (ms > 0) {
      const wake = this.waitForWake();
      try {
        await Promise.race([this.sleepImpl(ms), wake.promise]);
      } finally {
        wake.cancel();
      }
    }
    this.check(epoch);
  }

  private wakeAll(): void {
    for (const wake of [...this.wakers]) wake();
  }

  private waitForWake(): { promise: Promise<void>; cancel: () => void } {
    let wake!: () => void;
    const promise = new Promise<void>((resolve) => {
      wake = () => {
        this.wakers.delete(wake);
        resolve();
      };
      this.wakers.add(wake);
    });
    return { promise, cancel: () => void this.wakers.delete(wake) };
  }

  private async streamText(text: string, cps: number, callbacks: SessionCallbacks, epoch: number): Promise<void> {
    const chunk = Math.max(1, this.script.pacing?.chunkChars ?? DEFAULT_CHUNK);
    const delay = Math.max(0, Math.round((chunk / Math.max(1, cps)) * 1000));
    for (let i = 0; i < text.length; i += chunk) {
      this.check(epoch);
      callbacks.onToken(text.slice(i, i + chunk));
      await this.sleep(delay, epoch);
    }
  }

  private async runMessage(
    step: Extract<ReplayStep, { type: 'message' }>,
    callbacks: SessionCallbacks,
    epoch: number,
  ): Promise<void> {
    const text = step.text ?? '';
    await this.streamText(text, step.charsPerSecond ?? this.script.pacing?.charsPerSecond ?? DEFAULT_CPS, callbacks, epoch);

    // Mirrors ThreadSession: every tool_use of the assistant message is announced, then the message is committed.
    const issued: { tool: ReplayTool; record: ToolCallRecord }[] = (step.tools ?? []).map((tool, i) => {
      const toolUseId = `replay-tool-${this.sessionId}-${this.turnCount}-${Date.now().toString(36)}-${i}`;
      const summary = tool.summary ?? formatToolSummary(tool.name, tool.input ?? {});
      const record: ToolCallRecord = { name: tool.name, summary, timestamp: Date.now(), toolUseId, status: 'pending' };
      return { tool, record };
    });
    for (const { tool, record } of issued) {
      callbacks.onToolUse(record);
      if (tool.taskEvent) callbacks.onTaskEvent?.(tool.taskEvent);
    }
    if (text || issued.length > 0) callbacks.onMessage(text, issued.map((i) => i.record));

    // Tools run concurrently, like parallel tool_use blocks; permission prompts still serialize in the host.
    await Promise.all(issued.map(({ tool, record }) => this.runTool(tool, record, callbacks, epoch)));
  }

  private async runTool(tool: ReplayTool, record: ToolCallRecord, callbacks: SessionCallbacks, epoch: number): Promise<void> {
    if (tool.permission) {
      const detail = tool.permission.detail ?? JSON.stringify(tool.input ?? {});
      this.pendingPermissions++;
      let allowed: boolean;
      try {
        allowed = await callbacks.onPermissionRequest(tool.name, detail);
      } finally {
        this.pendingPermissions--;
      }
      this.check(epoch);
      if (!allowed) {
        this.finishTool(record, 'error', callbacks);
        await this.runSteps(tool.permission.ifDenied ?? [], callbacks, epoch);
        return;
      }
    }

    if (tool.agent) await this.runAgent(tool.agent, callbacks, epoch);
    else await this.sleep(tool.durationMs ?? DEFAULT_TOOL_MS, epoch);

    const status = tool.status ?? 'success';
    this.finishTool(record, status, callbacks);
    if (status === 'success' && tool.filesEdited?.length) callbacks.onFilesEdited?.(tool.filesEdited);
  }

  private finishTool(record: ToolCallRecord, status: 'success' | 'error', callbacks: SessionCallbacks): void {
    record.status = status;
    record.durationMs = record.timestamp ? Date.now() - record.timestamp : undefined;
    callbacks.onToolResult?.(record.toolUseId!, status, record.durationMs);
  }

  private async runAgent(agent: ReplayAgent, callbacks: SessionCallbacks, epoch: number): Promise<void> {
    callbacks.onTaskStarted?.(agent.taskId, agent.description, false, 'local_agent', undefined, agent.subagentType);
    for (const tick of agent.progress ?? []) {
      await this.sleep(tick.afterMs, epoch);
      callbacks.onTaskProgress?.(agent.taskId, tick.description, tick.lastToolName);
    }
    if (agent.hold) {
      await this.waitForWake().promise;
      this.check(epoch);
    }
    await this.sleep(agent.finishAfterMs ?? DEFAULT_AGENT_FINISH_MS, epoch);
    callbacks.onTaskNotification?.(agent.taskId, 'completed', agent.summary ?? agent.description);
  }
}

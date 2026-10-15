/**
 * The loop `attach` and `run` share: follow one thread's event stream on a `DaemonClient`, show it,
 * and (when allowed to) answer the permission/question/plan/elicitation requests it raises.
 *
 * The one-writer seat decides who may answer. A control-scope client that attaches normally claims
 * a free thread's seat and every mutating command (including `resolve.*`) needs it; the daemon
 * refuses the rest with `conflict`. So:
 *   - observer (the `attach` default): attached with `observe`, never takes the seat, only shows;
 *   - controller (`attach --claim`, `run`): holds the seat and answers.
 * Answers race fairly: the first `resolve.*` the daemon accepts wins, and the loser is told so
 * (`not_found: no pending ...`, or a `request_resolved` event naming who won).
 *
 * Prompts are held back until the replayed backlog has been delivered: a request that was opened
 * and answered while this terminal was away must not be asked about again.
 */
import { DaemonCommandError, type AttachInfo, type ChannelSubscription, type DaemonClient } from '../../src/remote/DaemonClient';
import type { EventFrame, ResyncFrame } from '../../src/protocol';
import { cliLine, field, frameLine, oneLine, TextRenderer } from './render';
import { randomHex } from '../../src/remote/randomId';

export type AnswerMode =
  /** Ask on the terminal (stdin is a TTY). */
  | 'terminal'
  /** NDJSON commands on stdin (`--json`). */
  | 'json'
  /** Show requests, never answer (observer, or no way to ask). */
  | 'none'
  /** Refuse every request and stop the turn (`run --unattended`). */
  | 'deny';

export type RequestKind = 'permission' | 'question' | 'plan' | 'elicitation';

export type FollowOutcome =
  | 'done' | 'error' | 'interrupted' | 'idle' | 'needs_input' | 'stopped' | 'closed' | 'failed';

export interface FollowResult {
  outcome: FollowOutcome;
  message?: string;
  lastSeq: number;
}

export interface FollowIo {
  /** The transcript: text, or NDJSON with --json. */
  out(text: string): void;
  /** Prompts, notes and diagnostics. */
  err(text: string): void;
}

/** Asks one line of the person at the terminal. `null` = aborted (answered elsewhere) or end of input. */
export interface Prompter {
  ask(prompt: string, signal: AbortSignal): Promise<string | null>;
}

export interface FollowOptions {
  client: DaemonClient;
  threadId: string;
  afterSeq: number;
  epoch?: string;
  observe: boolean;
  json: boolean;
  answer: AnswerMode;
  prompter?: Prompter;
  /** 'idle': stop once caught up with nothing running. 'turn_end': stop at the first done/error/interrupted. */
  stopOn: 'never' | 'idle' | 'turn_end';
  io: FollowIo;
}

interface OpenRequest {
  kind: RequestKind;
  requestId: string;
  args: Record<string, unknown>;
  /** Already shown/asked/refused: do not do it twice (a reopen re-delivers the same request). */
  handled: boolean;
}

const REQUEST_EVENTS: Record<string, RequestKind> = {
  permission_request: 'permission',
  question_request: 'question',
  plan_ready: 'plan',
  elicitation_request: 'elicitation',
};

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// ── answer parsing (pure) ───────────────────────────────────────────────────

export function parseYesNo(input: string): 'yes' | 'no' | null {
  const t = input.trim().toLowerCase();
  if (t === 'y' || t === 'yes') return 'yes';
  if (t === 'n' || t === 'no' || t === '') return 'no';
  return null;
}

/**
 * An answer to a multiple-choice question: option numbers (`2`, or `1,3` when multi-select) become the
 * options' labels; anything else is taken as free text. `null` = empty input.
 */
export function parseChoice(input: string, labels: string[], multi: boolean): string | null {
  const t = input.trim();
  if (!t) return null;
  const picks = t.split(/[,\s]+/).filter(Boolean);
  if (picks.every((p) => /^\d+$/.test(p) && Number(p) >= 1 && Number(p) <= labels.length)) {
    const chosen = picks.map((p) => labels[Number(p) - 1]);
    return multi ? chosen.join(', ') : chosen[0];
  }
  return t;
}

export class Follower {
  private readonly renderer: TextRenderer;
  private sub: ChannelSubscription | null = null;
  private readonly open = new Map<string, OpenRequest>();
  private caughtUp = false;
  /** The attach reply has been processed. Replayed events can overtake it (it settles on a later microtask), so "caught up" is meaningless before this. */
  private attachSeen = false;
  /** Highest seq this follower has PROCESSED (the client's cursor runs ahead of it while early frames are held). */
  private processedSeq: number;
  /** Frames that arrived before the attach reply, shown right after it so the `attached` record always comes first. */
  private early: Array<() => void> = [];
  private targetSeq = 0;
  private turnInFlight = false;
  private seat = false;
  private needsInput: string | null = null;
  private resolveFinished!: (r: FollowResult) => void;
  private done = false;
  private promptChain: Promise<void> = Promise.resolve();
  private answerMode: AnswerMode;
  private active: { requestId: string; abort: AbortController } | null = null;
  private resolveAttached!: (info: AttachInfo) => void;
  private lastTerminal: FollowOutcome | null = null;

  readonly finished: Promise<FollowResult>;
  /** Resolves with the first attach reply (so `controller` is known). */
  readonly attached: Promise<AttachInfo>;

  constructor(private readonly opts: FollowOptions) {
    this.answerMode = opts.answer;
    this.processedSeq = opts.afterSeq;
    this.renderer = new TextRenderer({ write: (s) => opts.io.out(s) });
    this.finished = new Promise((res) => { this.resolveFinished = res; });
    this.attached = new Promise((res) => { this.resolveAttached = res; });
  }

  /** This client holds the thread's read-write seat. */
  get controller(): boolean { return this.seat; }
  get lastSeq(): number { return this.processedSeq; }
  get openRequestCount(): number { return this.open.size; }

  start(): void {
    this.sub = this.opts.client.subscribe(this.opts.threadId, {
      onEvent: (frame, meta) => this.onEvent(frame, meta),
      onResync: (frame) => this.onResync(frame),
      onAttached: (info) => this.onAttached(info),
      onRewind: (seq) => { this.processedSeq = Math.min(this.processedSeq, seq); },
      onAttachError: (err) => this.stop('failed', err.message),
    }, this.opts.afterSeq, this.opts.epoch, { observe: this.opts.observe });
  }

  /** Change who may answer (`run --json` switches to refusing when stdin closes). Requests already open are refused too when switching to 'deny'. */
  setAnswerMode(mode: AnswerMode): void {
    this.answerMode = mode;
    if (!this.caughtUp) return;
    if (mode === 'deny') {
      for (const r of this.open.values()) { r.handled = true; void this.deny(r); }
    } else {
      this.handleOpenRequests();
    }
  }

  /** Detach from the stream (the session keeps running on the daemon). */
  stop(outcome: FollowOutcome, message?: string): void {
    if (this.done) return;
    this.done = true;
    this.active?.abort.abort();
    this.renderer.endLine();
    this.sub?.close();
    this.resolveFinished({ outcome, ...(message ? { message } : {}), lastSeq: this.lastSeq });
  }

  /** Tell the daemon everything up to what we have shown is persisted on this side (controller only). */
  ackCurrent(): void {
    if (this.seat) this.sub?.ack(this.lastSeq);
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  private note(text: string): void {
    if (this.opts.json) this.opts.io.out(`${cliLine('note', { text })}\n`);
    else { this.renderer.endLine(); this.opts.io.err(`[cli] ${oneLine(text, 600)}\n`); }
  }

  private onAttached(info: AttachInfo): void {
    this.seat = info.controller === true;
    this.targetSeq = info.lastSeq;
    this.attachSeen = true;
    this.caughtUp = false;
    if (this.opts.json) {
      this.opts.io.out(`${cliLine('attached', { threadId: this.opts.threadId, controller: this.seat, lastSeq: info.lastSeq, lowWater: info.lowWater, resync: info.resync, epoch: info.epoch })}\n`);
    }
    this.resolveAttached(info);
    for (const replay of this.early.splice(0)) replay();
    this.checkCaughtUp();
  }

  private onResync(frame: ResyncFrame): void {
    if (!this.attachSeen) { this.early.push(() => this.onResync(frame)); return; }
    this.processedSeq = frame.checkpoint.seq;
    if (this.opts.json) this.opts.io.out(`${frameLine(frame)}\n`);
    else this.renderer.resync(frame);
    for (const m of frame.checkpoint.openRequests) {
      if (!this.opts.json) this.renderer.event({ ...(m.event as object), v: 1, ch: frame.ch, seq: m.seq, ts: m.ts, type: 'event' } as EventFrame);
      this.track(m.event.name, m.event.args);
    }
    const st = frame.checkpoint.state?.event;
    if (st?.name === 'session.state') this.turnInFlight = st.args.turnInFlight === true;
    this.checkCaughtUp();
  }

  private onEvent(frame: EventFrame, meta: { reopen: boolean; replay: boolean }): void {
    if (this.done) return;
    if (!this.attachSeen) { this.early.push(() => this.onEvent(frame, meta)); return; }
    if (!meta.reopen) this.processedSeq = Math.max(this.processedSeq, frame.seq);
    const requestKind = REQUEST_EVENTS[frame.name];
    // A reopened request is one already shown before the socket dropped: track it, do not print it twice.
    const quiet = meta.reopen && requestKind !== undefined && this.open.get(String(obj(frame.args).requestId))?.handled === true;
    if (!quiet) {
      if (this.opts.json) this.opts.io.out(`${frameLine(frame)}\n`);
      else this.renderer.event(frame);
    }
    this.track(frame.name, frame.args);
    this.checkCaughtUp();
    this.afterEvent(frame);
  }

  /** Book-keeping that does not depend on how the event is shown. */
  private track(name: string, args: unknown): void {
    const kind = REQUEST_EVENTS[name];
    const a = obj(args);
    if (kind) {
      const requestId = String(a.requestId ?? '');
      if (requestId && !this.open.has(requestId)) this.open.set(requestId, { kind, requestId, args: a, handled: false });
      return;
    }
    if (name === 'request_resolved') {
      const requestId = String(a.requestId ?? '');
      if (this.open.delete(requestId) && this.active?.requestId === requestId) {
        this.note(`request ${requestId} was answered elsewhere${a.by ? ` (by ${String(a.by)})` : ''}; dropping the prompt`);
        this.active.abort.abort();
      }
      return;
    }
    if (name === 'session.state') {
      this.turnInFlight = a.turnInFlight === true;
      return;
    }
    if (name === 'onDone') this.lastTerminal = 'done';
    else if (name === 'onError') this.lastTerminal = 'error';
    else if (name === 'onInterrupted') this.lastTerminal = 'interrupted';
    else if (name === 'onToken' || name === 'onToolUse') this.lastTerminal = null;
  }

  private checkCaughtUp(): void {
    if (this.caughtUp || !this.sub || !this.attachSeen) return;
    if (this.processedSeq < this.targetSeq) return;
    this.caughtUp = true;
    this.handleOpenRequests();
    this.maybeFinish();
  }

  private afterEvent(frame: EventFrame): void {
    if (this.done) return;
    if (this.caughtUp) this.handleOpenRequests();
    const terminal = frame.name === 'onDone' ? 'done' : frame.name === 'onError' ? 'error' : frame.name === 'onInterrupted' ? 'interrupted' : null;
    if (terminal && this.opts.stopOn === 'turn_end' && this.caughtUp) {
      this.stop(this.needsInput ? 'needs_input' : terminal, this.needsInput ?? undefined);
      return;
    }
    this.maybeFinish();
  }

  private maybeFinish(): void {
    if (this.done || !this.caughtUp) return;
    if (this.opts.stopOn === 'idle' && !this.turnInFlight && this.open.size === 0) {
      this.stop(this.lastTerminal === 'error' ? 'error' : this.lastTerminal === 'interrupted' ? 'interrupted' : 'idle');
    }
  }

  // ── requests ─────────────────────────────────────────────────────────────

  private handleOpenRequests(): void {
    for (const r of this.open.values()) {
      if (r.handled) continue;
      r.handled = true;
      // Without the seat every answer would be refused, so there is nothing to offer.
      const mode: AnswerMode = (this.answerMode === 'terminal' || this.answerMode === 'json') && !this.seat ? 'none' : this.answerMode;
      switch (mode) {
        case 'terminal': this.enqueuePrompt(r); break;
        case 'json': this.note(`waiting for a command: {"cmd":"resolve.${r.kind}","requestId":"${r.requestId}", ...}`); break;
        case 'deny': void this.deny(r); break;
        case 'none':
          this.note(this.seat
            ? `${r.kind} request ${r.requestId} is open; there is no terminal to answer it here`
            : `${r.kind} request ${r.requestId} is open; this is a read-only view, answer it from the client that holds the thread (or re-run with --claim when none does)`);
          break;
      }
    }
  }

  private async deny(r: OpenRequest): Promise<void> {
    this.needsInput = `a ${r.kind} request was raised (${r.requestId}) and nobody could answer it; use --permission-mode, or run attended`;
    try {
      if (r.kind === 'permission') await this.opts.client.command('resolve.permission', { threadId: this.opts.threadId, requestId: r.requestId, allow: false });
    } catch (err) {
      this.note(`could not refuse ${r.requestId}: ${errText(err)}`);
    }
    try {
      await this.opts.client.command('session.interrupt', { threadId: this.opts.threadId });
    } catch (err) {
      this.stop('needs_input', `${this.needsInput}; interrupt failed: ${errText(err)}`);
    }
  }

  private enqueuePrompt(r: OpenRequest): void {
    this.promptChain = this.promptChain.then(() => this.prompt(r)).catch((err) => this.note(`prompt failed: ${errText(err)}`));
  }

  private async prompt(r: OpenRequest): Promise<void> {
    if (this.done || !this.open.has(r.requestId)) return;
    const prompter = this.opts.prompter;
    if (!prompter) return;
    const abort = new AbortController();
    this.active = { requestId: r.requestId, abort };
    try {
      const a = r.args;
      switch (r.kind) {
        case 'permission': {
          const line = await prompter.ask(`Allow ${field(a.toolName, 'this tool')}? [y/N] `, abort.signal);
          if (line === null) return;
          const yn = parseYesNo(line);
          await this.resolve({ cmd: 'resolve.permission', requestId: r.requestId, allow: yn === 'yes' });
          return;
        }
        case 'question': {
          const answers: Record<string, string> = {};
          for (const q of Array.isArray(a.questions) ? a.questions : []) {
            const qq = obj(q);
            const labels = (Array.isArray(qq.options) ? qq.options : []).map((o) => String(obj(o).label ?? ''));
            const line = await prompter.ask(`${field(qq.header, 'Question')}: ${oneLine(String(qq.question ?? ''), 500)}\n  answer (number${qq.multiSelect === true ? 's, comma separated' : ''} or text): `, abort.signal);
            if (line === null) return;
            const picked = parseChoice(line, labels, qq.multiSelect === true);
            if (picked !== null) answers[String(qq.id ?? qq.question ?? '')] = picked;
          }
          await this.resolve({ cmd: 'resolve.question', requestId: r.requestId, answers });
          return;
        }
        case 'plan': {
          const line = await prompter.ask('Approve this plan? [y/N] ', abort.signal);
          if (line === null) return;
          await this.resolve({ cmd: 'resolve.plan', requestId: r.requestId, approve: parseYesNo(line) === 'yes' });
          return;
        }
        case 'elicitation': {
          const line = await prompter.ask('Reply with a JSON object to accept, or press Enter to decline: ', abort.signal);
          if (line === null) return;
          const text = line.trim();
          let result: Record<string, unknown> = { action: 'decline' };
          if (text) {
            try {
              const parsed: unknown = JSON.parse(text);
              result = { action: 'accept', content: obj(parsed) };
            } catch {
              this.note('that is not JSON; declining');
            }
          }
          await this.resolve({ cmd: 'resolve.elicitation', requestId: r.requestId, result });
          return;
        }
      }
    } finally {
      if (this.active?.abort === abort) this.active = null;
    }
  }

  // ── commands (terminal answers and --json stdin) ─────────────────────────

  /**
   * Run one command against the thread. Returns a record describing the outcome so `--json` callers
   * can see it; failures never throw.
   */
  async resolve(cmd: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    const threadId = this.opts.threadId;
    const name = String(cmd.cmd ?? '');
    let result: { ok: boolean; error?: string };
    try {
      switch (name) {
        case 'resolve.permission':
          await this.opts.client.command('resolve.permission', { threadId, requestId: String(cmd.requestId), allow: cmd.allow === true });
          break;
        case 'resolve.question':
          await this.opts.client.command('resolve.question', { threadId, requestId: String(cmd.requestId), answers: obj(cmd.answers) as Record<string, string> });
          break;
        case 'resolve.plan':
          await this.opts.client.command('resolve.plan', { threadId, requestId: String(cmd.requestId), approve: cmd.approve === true, ...(typeof cmd.editedPlan === 'string' ? { editedPlan: cmd.editedPlan } : {}) });
          break;
        case 'resolve.elicitation':
          await this.opts.client.command('resolve.elicitation', { threadId, requestId: String(cmd.requestId), result: obj(cmd.result) });
          break;
        case 'interrupt':
          await this.opts.client.command('session.interrupt', { threadId });
          break;
        case 'send':
          await this.opts.client.command('session.send', { threadId, text: String(cmd.text ?? ''), userMessageUuid: typeof cmd.id === 'string' && cmd.id ? cmd.id : `cli-${randomHex(8)}` });
          break;
        default:
          result = { ok: false, error: `unknown command "${name}"` };
          this.report(name, result);
          return result;
      }
      result = { ok: true };
    } catch (err) {
      result = { ok: false, error: explain(err) };
    }
    this.report(name, result, typeof cmd.requestId === 'string' ? cmd.requestId : undefined);
    return result;
  }

  private report(cmd: string, result: { ok: boolean; error?: string }, requestId?: string): void {
    if (this.opts.json) this.opts.io.out(`${cliLine('command_result', { cmd, ...(requestId ? { requestId } : {}), ok: result.ok, ...(result.error ? { error: result.error } : {}) })}\n`);
    else if (!result.ok) this.note(`${cmd} failed: ${result.error}`);
  }
}

/** A refusal the user can act on. */
function explain(err: unknown): string {
  if (err instanceof DaemonCommandError) {
    if (err.code === 'conflict') return `${err.message} (another client holds this thread's read-write seat)`;
    if (err.code === 'not_found' && /pending/.test(err.message)) return 'already answered by another client';
    return err.message;
  }
  return errText(err);
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

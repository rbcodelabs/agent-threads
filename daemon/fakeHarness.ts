/**
 * Scripted stand-in for a HarnessSession: turns `session.send` text into the
 * event sequence a real session produces (state, tokens, message, done), with
 * enough control over shape and pacing to exercise resume and backpressure.
 *
 * Script grammar (first word of the sent text):
 *   /tokens N [size=S] [burst=B] [delay=MS]  N tokens `t<i>:` padded to S chars, B per macrotask
 *                                 (default 10), MS ms between bursts (default 0 = back to back)
 *   /hang                         one token, then wait for interrupt
 *   /permission                   open a permission_request, finish after resolve.permission
 *   /question | /plan | /elicitation   same shape with a question_request / plan_ready / elicitation_request
 *   anything else                 echo "echo: <text>" word by word
 */
import { toWireError, type WireEvent } from '../src/protocol';
import type { DriverContext, DriverFactory, RequestKind, SessionDriver } from './sessionDriver';

const REQUEST_SCRIPTS = ['permission', 'question', 'plan', 'elicitation'] as const;
type RequestScript = (typeof REQUEST_SCRIPTS)[number];

export const FAKE_TOKEN_PREFIX = 't';

/** The text of token `i` for `/tokens N size=S`, so tests can recompute it. */
export function fakeTokenText(i: number, size = 0): string {
  const base = `${FAKE_TOKEN_PREFIX}${i}:`;
  return size > base.length ? base.padEnd(size, 'x') : base;
}

interface ParsedScript {
  kind: 'tokens' | 'hang' | RequestScript | 'echo';
  count: number;
  size: number;
  burst: number;
  delay: number;
  text: string;
}

function parseScript(text: string): ParsedScript {
  const [head, ...rest] = text.trim().split(/\s+/);
  const opt = (name: string, dflt: number): number => {
    const hit = rest.find((r) => r.startsWith(`${name}=`));
    const n = hit ? Number(hit.slice(name.length + 1)) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
  };
  if (head === '/tokens') {
    const n = Number(rest[0]);
    return { kind: 'tokens', count: Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0, size: opt('size', 0), burst: opt('burst', 10), delay: opt('delay', 0), text };
  }
  if (head === '/hang') return { kind: 'hang', count: 0, size: 0, burst: 1, delay: 0, text };
  for (const k of REQUEST_SCRIPTS) {
    if (head === `/${k}`) return { kind: k, count: 0, size: 0, burst: 1, delay: 0, text };
  }
  // Plain text echoes word by word; `delay=MS` anywhere in the text slows it (the e2e uses this to watch tokens arrive).
  const echoDelay = /delay=(\d+)/.exec(text);
  return { kind: 'echo', count: 0, size: 0, burst: 4, delay: echoDelay ? Number(echoDelay[1]) : 0, text };
}

export class FakeHarnessSession implements SessionDriver {
  private _turnInFlight = false;
  private closed = false;
  private turnGen = 0;
  private pending: { requestId: string; kind: RequestKind; continueTurn: (payload: Record<string, unknown>) => void } | null = null;
  private _lastActivityAt = Date.now();
  /** Applied via setModel / setPermissionMode; exposed so tests can see the command landed. */
  model: string | undefined;
  permissionMode: string;
  private requestCounter = 0;
  private readonly sessionId: string;

  constructor(private readonly ctx: DriverContext) {
    this.sessionId = `fake-${ctx.threadId}`;
    this.model = ctx.spec.model;
    this.permissionMode = ctx.spec.permissionMode;
    ctx.onNativeSessionId(this.sessionId);
    this.emitState();
  }

  get turnInFlight(): boolean { return this._turnInFlight; }
  get hasPendingPermission(): boolean { return this.pending !== null; }
  get cwd(): string | undefined { return this.ctx.spec.cwd; }
  get lastActivityAt(): number { return this._lastActivityAt; }
  canIdleReap(): boolean { return !this._turnInFlight && this.pending === null; }

  send(text: string, _userMessageUuid: string): void {
    if (this.closed) throw new Error('session is closed');
    if (this._turnInFlight) throw new Error('a turn is already in flight');
    this._lastActivityAt = Date.now();
    const gen = ++this.turnGen;
    this._turnInFlight = true;
    this.emitState();
    const script = parseScript(text);
    const alive = () => !this.closed && gen === this.turnGen;

    switch (script.kind) {
      case 'tokens': this.streamTokens(script, alive); break;
      case 'hang':
        this.emit({ name: 'onToken', args: ['working... '] });
        break;
      case 'permission':
      case 'question':
      case 'plan':
      case 'elicitation': {
        const requestId = `${script.kind}-${++this.requestCounter}`;
        this.pending = {
          requestId,
          kind: script.kind === 'permission' ? 'permission' : script.kind === 'question' ? 'question' : script.kind === 'plan' ? 'plan' : 'elicitation',
          continueTurn: (payload) => setImmediate(() => {
            if (alive()) this.finish(script, `${script.kind} resolved: ${JSON.stringify(payload)}`, alive);
          }),
        };
        this.emit(this.requestEvent(script.kind, requestId));
        this.emitState();
        break;
      }
      default: {
        const words = `echo: ${script.text}`.split(' ').map((w, i, a) => (i < a.length - 1 ? `${w} ` : w));
        this.streamChunks(words, script.burst, script.delay, alive, () => this.finish(script, words.join(''), alive));
      }
    }
  }

  private streamTokens(script: ParsedScript, alive: () => boolean): void {
    const chunks: string[] = [];
    for (let i = 0; i < script.count; i++) chunks.push(fakeTokenText(i, script.size));
    this.streamChunks(chunks, script.burst, script.delay, alive, () => this.finish(script, chunks.join(''), alive));
  }

  private streamChunks(chunks: string[], burst: number, delay: number, alive: () => boolean, done: () => void): void {
    let i = 0;
    const step = () => {
      if (!alive()) return;
      const end = Math.min(i + burst, chunks.length);
      for (; i < end; i++) this.emit({ name: 'onToken', args: [chunks[i]] });
      if (i < chunks.length) later();
      else done();
    };
    const later = (): void => { if (delay > 0) setTimeout(step, delay); else setImmediate(step); };
    later();
  }

  private finish(_script: ParsedScript, content: string, alive: () => boolean): void {
    if (!alive()) return;
    this.emit({ name: 'onMessage', args: [content, []] });
    this.emit({ name: 'onDone', args: [this.sessionId, 0, 1] });
    this._turnInFlight = false;
    this.emitState();
  }

  private requestEvent(kind: RequestScript, requestId: string): WireEvent {
    switch (kind) {
      case 'permission': return { name: 'permission_request', args: { requestId, toolName: 'Bash', detail: 'ls /srv/workspaces' } };
      case 'question': return { name: 'question_request', args: { requestId, questions: [{ question: 'Pick one?', header: 'Pick', options: [{ label: 'a', description: 'first' }], multiSelect: false }] } };
      case 'plan': return { name: 'plan_ready', args: { requestId, planText: '1. do the thing' } };
      case 'elicitation': return { name: 'elicitation_request', args: { requestId, request: { message: 'need input' } } };
    }
  }

  interrupt(): void {
    if (!this._turnInFlight) return;
    this.turnGen++;
    if (this.pending) this.emit({ name: 'request_resolved', args: { requestId: this.pending.requestId, outcome: 'canceled' } });
    this.pending = null;
    this._turnInFlight = false;
    this.emit({ name: 'onInterrupted', args: [this.sessionId] });
    this.emitState();
  }

  resolve(kind: RequestKind, requestId: string, payload: Record<string, unknown>): boolean {
    if (!this.pending || this.pending.kind !== kind || this.pending.requestId !== requestId) return false;
    const { continueTurn } = this.pending;
    this.pending = null;
    continueTurn(payload);
    return true;
  }

  async setModel(model: string | undefined): Promise<void> { this.model = model; }
  async setPermissionMode(mode: string): Promise<void> { this.permissionMode = mode; }
  async getContextUsage(): Promise<unknown> {
    return { categories: [], totalTokens: 1, maxTokens: 100, percentage: 1, model: this.model ?? 'fake' };
  }
  async mcpServerStatus(): Promise<Array<{ name: string; status: string }>> { return [{ name: 'fake-mcp', status: 'connected' }]; }
  async getUsageSnapshot(includeAccountUsage?: boolean): Promise<unknown> { return { fake: true, includeAccountUsage: includeAccountUsage === true }; }

  close(): void {
    this.closed = true;
    this.pending = null;
  }

  /** Surface a fault the way a real session would. */
  fail(err: Error): void {
    this.emit({ name: 'onError', args: [toWireError(err)] });
    this._turnInFlight = false;
    this.emitState();
  }

  private emit(event: WireEvent): void { this.ctx.emit(event); }

  private emitState(): void {
    this.emit({
      name: 'session.state',
      args: {
        turnInFlight: this._turnInFlight,
        hasPendingPermission: this.pending !== null,
        hostAttached: false,
        canIdleReap: this.canIdleReap(),
        cwd: this.ctx.spec.cwd,
      },
    });
  }
}

export const fakeHarnessFactory: DriverFactory = (ctx) => new FakeHarnessSession(ctx);

/**
 * Scripted stand-in for a HarnessSession: turns `session.send` text into the
 * event sequence a real session produces (state, tokens, message, done), with
 * enough control over shape and pacing to exercise resume and backpressure.
 *
 * Script grammar (first word of the sent text):
 *   /tokens N [size=S] [burst=B]  N tokens `t<i>:` padded to S chars, B per macrotask (default 10)
 *   /hang                         one token, then wait for interrupt
 *   /permission                   open a permission_request, finish after resolve.permission
 *   anything else                 echo "echo: <text>" word by word
 */
import { toWireError, type WireEvent } from '../src/protocol';
import type { DriverContext, DriverFactory, RequestKind, SessionDriver } from './sessionDriver';

export const FAKE_TOKEN_PREFIX = 't';

/** The text of token `i` for `/tokens N size=S`, so tests can recompute it. */
export function fakeTokenText(i: number, size = 0): string {
  const base = `${FAKE_TOKEN_PREFIX}${i}:`;
  return size > base.length ? base.padEnd(size, 'x') : base;
}

interface ParsedScript {
  kind: 'tokens' | 'hang' | 'permission' | 'echo';
  count: number;
  size: number;
  burst: number;
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
    return { kind: 'tokens', count: Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0, size: opt('size', 0), burst: opt('burst', 10), text };
  }
  if (head === '/hang') return { kind: 'hang', count: 0, size: 0, burst: 1, text };
  if (head === '/permission') return { kind: 'permission', count: 0, size: 0, burst: 1, text };
  return { kind: 'echo', count: 0, size: 0, burst: 4, text };
}

export class FakeHarnessSession implements SessionDriver {
  private _turnInFlight = false;
  private closed = false;
  private turnGen = 0;
  private pending: { requestId: string; continueTurn: () => void } | null = null;
  private requestCounter = 0;
  private readonly sessionId: string;

  constructor(private readonly ctx: DriverContext) {
    this.sessionId = `fake-${ctx.threadId}`;
  }

  get turnInFlight(): boolean { return this._turnInFlight; }

  send(text: string, _userMessageUuid: string): void {
    if (this.closed) throw new Error('session is closed');
    if (this._turnInFlight) throw new Error('a turn is already in flight');
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
      case 'permission': {
        const requestId = `perm-${++this.requestCounter}`;
        this.pending = {
          requestId,
          continueTurn: () => setImmediate(() => { if (alive()) this.finish(script, 'permission granted', alive); }),
        };
        this.emit({ name: 'permission_request', args: { requestId, toolName: 'Bash', detail: 'ls /srv/workspaces' } });
        this.emitState();
        break;
      }
      default: {
        const words = `echo: ${script.text}`.split(' ').map((w, i, a) => (i < a.length - 1 ? `${w} ` : w));
        this.streamChunks(words, script.burst, alive, () => this.finish(script, words.join(''), alive));
      }
    }
  }

  private streamTokens(script: ParsedScript, alive: () => boolean): void {
    const chunks: string[] = [];
    for (let i = 0; i < script.count; i++) chunks.push(fakeTokenText(i, script.size));
    this.streamChunks(chunks, script.burst, alive, () => this.finish(script, chunks.join(''), alive));
  }

  private streamChunks(chunks: string[], burst: number, alive: () => boolean, done: () => void): void {
    let i = 0;
    const step = () => {
      if (!alive()) return;
      const end = Math.min(i + burst, chunks.length);
      for (; i < end; i++) this.emit({ name: 'onToken', args: [chunks[i]] });
      if (i < chunks.length) setImmediate(step);
      else done();
    };
    setImmediate(step);
  }

  private finish(_script: ParsedScript, content: string, alive: () => boolean): void {
    if (!alive()) return;
    this.emit({ name: 'onMessage', args: [content, []] });
    this.emit({ name: 'onDone', args: [this.sessionId, 0, 1] });
    this._turnInFlight = false;
    this.emitState();
  }

  interrupt(): void {
    if (!this._turnInFlight) return;
    this.turnGen++;
    this.pending = null;
    this._turnInFlight = false;
    this.emit({ name: 'onInterrupted', args: [this.sessionId] });
    this.emitState();
  }

  resolve(kind: RequestKind, requestId: string, _payload: Record<string, unknown>): boolean {
    if (kind !== 'permission' || !this.pending || this.pending.requestId !== requestId) return false;
    const { continueTurn } = this.pending;
    this.pending = null;
    continueTurn();
    return true;
  }

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
      args: { turnInFlight: this._turnInFlight, hasPendingPermission: this.pending !== null, hostAttached: false, cwd: this.ctx.spec.cwd },
    });
  }
}

export const fakeHarnessFactory: DriverFactory = (ctx) => new FakeHarnessSession(ctx);

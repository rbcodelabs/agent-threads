/**
 * Turning daemon event frames into terminal text, and into the stable NDJSON the `--json` flag emits.
 *
 * Text is for people and may change between releases. `--json` is a contract: every line is one JSON
 * object with a `type`. Daemon frames are passed through verbatim (`type` is `event` or `resync`, the
 * fields are exactly the wire protocol's, so they are additive-only within protocol v1); the CLI's own
 * records have `type: "cli"` and a `kind`. See docs/remote-daemon.md ("CLI").
 */
import type { EventFrame, ResyncFrame } from '../../src/protocol';

export interface Sink {
  write(text: string): void;
}

type Args = unknown[];

const asArray = (a: unknown): Args => (Array.isArray(a) ? a : []);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** One line, no control characters, bounded: a tool summary must not be able to repaint the terminal. */
export function oneLine(text: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Strip terminal control sequences from text the agent produced before it reaches a terminal. */
export function safeText(text: string): string {
  // Keep \n and \t; drop ESC and the other C0/C1 controls (an agent can print anything a tool returned).
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

/** A short single-line field (id, name, outcome) from the wire: never a way to emit escape sequences or fake lines. */
export function field(v: unknown, fallback = '', max = 80): string {
  const text = typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
  return oneLine(text, max) || fallback;
}

export function formatCost(cost: unknown): string {
  const c = num(cost);
  return c !== undefined && c > 0 ? `, $${c.toFixed(4)}` : '';
}

export class TextRenderer {
  /** The cursor is in the middle of streamed assistant text. */
  private lineOpen = false;
  /** Tokens of the current assistant message were printed, so its final `onMessage` must not repeat them. */
  private streamed = false;
  private readonly toolNames = new Map<string, string>();

  constructor(private readonly sink: Sink) {}

  /** Finish a half-written line (call before printing anything that is not streamed text). */
  endLine(): void {
    if (this.lineOpen) { this.sink.write('\n'); this.lineOpen = false; }
  }

  line(text: string): void {
    this.endLine();
    this.sink.write(`${text}\n`);
  }

  private tokens(text: string): void {
    if (!text) return;
    this.sink.write(safeText(text));
    this.lineOpen = !text.endsWith('\n');
    this.streamed = true;
  }

  resync(frame: ResyncFrame): void {
    const cp = frame.checkpoint;
    this.line(`[resync] the daemon no longer holds the history before seq ${cp.seq}; showing its checkpoint`);
    for (const m of cp.recentMessages) this.event({ ...(m.event as object), v: 1, ch: frame.ch, seq: m.seq, ts: m.ts, type: 'event' } as EventFrame);
    if (cp.inFlightText) this.tokens(cp.inFlightText);
  }

  event(frame: EventFrame): void {
    const args = frame.args as unknown;
    const a = asArray(args);
    switch (frame.name) {
      case 'onToken': this.tokens(str(a[0])); return;
      case 'onMessage': {
        const content = str(a[0]);
        if (this.streamed) this.endLine();
        else if (content) this.line(safeText(content));
        this.streamed = false;
        return;
      }
      case 'onToolUse': {
        const rec = obj(a[0]);
        const name = field(rec.name, 'tool');
        if (typeof rec.toolUseId === 'string') this.toolNames.set(rec.toolUseId, name);
        const summary = oneLine(str(rec.summary));
        this.line(`[tool] ${name}${summary ? ` ${summary}` : ''}`);
        return;
      }
      case 'onToolResult': {
        if (a[1] !== 'error') return;
        const id = str(a[0]);
        this.line(`[tool] ${this.toolNames.get(id) ?? 'tool'} failed`);
        return;
      }
      case 'onDone': {
        const turns = num(a[2]);
        this.line(`[done]${turns !== undefined ? ` ${turns} turn${turns === 1 ? '' : 's'}` : ''}${formatCost(a[1])}`);
        this.streamed = false;
        return;
      }
      case 'onError': {
        this.line(`[error] ${oneLine(str(obj(a[0]).message, 'unknown error'), 500)}`);
        this.streamed = false;
        return;
      }
      case 'onInterrupted': this.line('[interrupted]'); this.streamed = false; return;
      case 'permission_request': {
        const r = obj(args);
        this.line(`[permission ${field(r.requestId)}] ${field(r.toolName, 'tool')}`);
        const detail = safeText(str(r.detail)).trimEnd();
        if (detail) for (const l of detail.split('\n')) this.sink.write(`    ${l}\n`);
        return;
      }
      case 'question_request': {
        const r = obj(args);
        this.line(`[question ${field(r.requestId)}]`);
        for (const q of asArray(r.questions)) {
          const qq = obj(q);
          this.sink.write(`  ${safeText(str(qq.header))}: ${safeText(str(qq.question))}\n`);
          asArray(qq.options).forEach((o, i) => {
            const oo = obj(o);
            this.sink.write(`    ${i + 1}) ${safeText(str(oo.label))}${oo.description ? ` - ${safeText(str(oo.description))}` : ''}\n`);
          });
        }
        return;
      }
      case 'plan_ready': {
        const r = obj(args);
        this.line(`[plan ${field(r.requestId)}]`);
        for (const l of safeText(str(r.planText)).trimEnd().split('\n')) this.sink.write(`    ${l}\n`);
        return;
      }
      case 'elicitation_request': {
        const r = obj(args);
        this.line(`[input ${field(r.requestId)}] ${oneLine(str(obj(r.request).message, 'the agent asks for input'), 500)}`);
        return;
      }
      case 'request_resolved': {
        const r = obj(args);
        const outcome = field(r.outcome, 'resolved');
        this.line(`[resolved ${field(r.requestId)}]${r.by ? ` by ${field(r.by)}` : ''} (${outcome})`);
        return;
      }
      case 'onPermissionDenied': this.line(`[denied] ${field(a[0], 'tool')}: ${oneLine(str(a[2]), 300)}`); return;
      case 'session.state': {
        const s = obj(args);
        if (typeof s.closed === 'string') this.line(`[session closed: ${field(s.closed)}]`);
        return;
      }
      case 'onReconnecting': this.line(`[reconnecting] ${oneLine(str(a[0]), 300)}`); return;
      case 'onRateLimitRetry': this.line(`[rate limited] retry ${field(a[0])}/${field(a[1])} in ${Math.round((num(a[2]) ?? 0) / 1000)}s`); return;
      case 'onApiRetry': this.line(`[api retry] ${field(a[0])}/${field(a[1])}: ${oneLine(str(a[2]), 200)}`); return;
      case 'onAuthRetry': this.line('[sign-in] the Claude login looks expired; retrying once'); return;
      case 'onAuthRequired': this.line(`[sign-in required] ${oneLine(str(a[0]), 400)}`); return;
      case 'onNotification': this.line(`[notice] ${oneLine(str(a[0]), 400)}`); return;
      case 'onRecap': this.line(`[recap] ${oneLine(str(a[0]), 400)}`); return;
      case 'onCompact': this.line('[compact] the conversation was compacted'); return;
      case 'onTaskStarted': this.line(`[task] ${oneLine(str(a[1]), 200)}`); return;
      case 'onTaskNotification': this.line(`[task ${field(a[1])}] ${oneLine(str(a[2]), 200)}`); return;
      default:
        // Everything else (usage, status, progress, ...) is machine-oriented: --json carries it.
    }
  }
}

// ── NDJSON ──────────────────────────────────────────────────────────────────

export type CliRecord = { type: 'cli'; kind: string } & Record<string, unknown>;

/** One NDJSON line for a daemon frame, passed through exactly as received. */
export const frameLine = (frame: EventFrame | ResyncFrame): string => JSON.stringify(frame);

/** One NDJSON line for a record the CLI itself produced. */
export const cliLine = (kind: string, fields: Record<string, unknown> = {}): string => JSON.stringify({ type: 'cli', kind, ...fields });

/**
 * One authenticated (or authenticating) WebSocket client.
 *
 * Delivery model (design section 3.4): per attached channel there is ONE
 * ordered queue holding the replayed backlog followed by live events. Attach
 * takes the replay snapshot and subscribes in the same synchronous turn, so no
 * event can fall between them and none is delivered twice.
 *
 * Backpressure: the backlog is just pointers into the journal and is drained
 * lazily as the socket accepts data, so a client replaying a large history is
 * never penalised. What is bounded (4 MB) is LIVE data that was produced faster
 * than this client reads it, plus whatever the socket has buffered; exceeding
 * it closes the connection with 4408 and the client resumes from its cursor.
 */
import type { IncomingMessage } from 'node:http';
import type { RawData, WebSocket } from 'ws';
import {
  CLOSE_SLOW_CONSUMER,
  CLOSE_UNAUTHORIZED,
  PROTOCOL_VERSION,
  decodeClientFrame,
  encodeFrame,
  isChannel,
  threadChannel,
  type AckFrame,
  type Channel,
  type ClientFrame,
  type ErrFrame,
  type ErrorCode,
  type JournalEntry,
  type WelcomeFrame,
  type WireEvent,
} from '../src/protocol';
import type { CommandCache } from './cmdCache';
import type { FailureThrottle } from './failureThrottle';
import { HostError, type ThreadHost, type ThreadJournal } from './threadHost';
import { scopeSatisfies, type TokenScope, type TokenStore, type VerifiedToken } from './tokenStore';
import { DAEMON_VERSION, MIN_CLIENT_VERSION } from './version';

export const MAX_OUTBOUND_BYTES = 4 * 1024 * 1024;
/** Stop handing frames to the socket once this much is already buffered in it. */
const SOCKET_HIGH_WATER = 256 * 1024;
export const CAPABILITIES = ['session.channel', 'journal.resume', 'cmd.idempotency', 'harness.fake'];

export interface Timings {
  helloTimeoutMs: number;
  pingIntervalMs: number;
  pongTimeoutMs: number;
  closeGraceMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  helloTimeoutMs: 5_000,
  pingIntervalMs: 20_000,
  pongTimeoutMs: 10_000,
  closeGraceMs: 5_000,
};

export interface ServerContext {
  host: ThreadHost;
  tokens: TokenStore;
  throttle: FailureThrottle;
  cmdCache: CommandCache;
  daemonId: string;
  epoch: string;
  timings: Timings;
  maxOutboundBytes: number;
  audit(record: Record<string, unknown>): void;
}

/** Minimum scope per command. Unlisted commands are admin-only. */
const REQUIRED_SCOPE: Record<string, TokenScope> = {
  attach: 'read',
  'session.list': 'read',
  'session.getContextUsage': 'read',
  'session.mcpServerStatus': 'read',
  'session.getUsageSnapshot': 'read',
  ack: 'control',
  'session.open': 'control',
  'session.detach': 'control',
  'session.close': 'control',
  'session.send': 'control',
  'session.prepareForSend': 'control',
  'session.interrupt': 'control',
  'session.sendAgentMessage': 'control',
  'session.interruptAgent': 'control',
  'session.setModel': 'control',
  'session.setPermissionMode': 'control',
  'resolve.permission': 'control',
  'resolve.question': 'control',
  'resolve.plan': 'control',
  'resolve.elicitation': 'control',
  'resolve.openTab': 'control',
  'tool.result': 'control',
  'tool.manifest': 'control',
  'creds.push': 'admin',
};

/** Commands whose reply must be re-evaluated, not replayed from the idempotency cache. */
const NOT_CACHED = new Set(['hello', 'attach', 'ack']);

class CommandError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

interface QueueItem {
  entry: JournalEntry<WireEvent>;
  live: boolean;
  text?: string;
}

class ChannelSub {
  items: QueueItem[] = [];
  head = 0;
  /** Pre-encoded resync frame, sent before any item. */
  resyncText: string | null = null;
  unsubscribe: (() => void) | null = null;
  constructor(readonly ch: Channel) {}
  get pending(): number { return this.items.length - this.head; }
  next(): QueueItem | undefined {
    const item = this.items[this.head];
    if (!item) return undefined;
    this.items[this.head++] = undefined as unknown as QueueItem;
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }
}

export class Connection {
  private auth: VerifiedToken | null = null;
  private readonly preAuth: VerifiedToken | null;
  private helloSeen = false;
  private dead = false;
  private pumping = false;
  private liveBytes = 0;
  private readonly control: string[] = [];
  private readonly subs = new Map<Channel, ChannelSub>();
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly ip: string,
    private readonly ctx: ServerContext,
    preAuth: VerifiedToken | null,
    private readonly onGone: (c: Connection) => void,
    readonly request?: IncomingMessage,
  ) {
    this.preAuth = preAuth;
    ws.on('message', (data) => this.onMessage(data));
    ws.on('close', () => this.cleanup());
    ws.on('error', () => this.cleanup());
    ws.on('pong', () => { if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; } });
    this.helloTimer = setTimeout(() => {
      if (!this.helloSeen) this.closeWith(CLOSE_UNAUTHORIZED, 'hello timeout');
    }, ctx.timings.helloTimeoutMs);
    this.pingTimer = setInterval(() => this.heartbeat(), ctx.timings.pingIntervalMs);
  }

  get tokenId(): string | null { return this.auth?.id ?? null; }

  // ── lifecycle ────────────────────────────────────────────────────────────

  private heartbeat(): void {
    if (this.dead) return;
    if (this.auth && !this.ctx.tokens.isActive(this.auth.id)) {
      this.closeWith(CLOSE_UNAUTHORIZED, 'token revoked');
      return;
    }
    if (this.pongTimer) return;
    this.pongTimer = setTimeout(() => this.ws.terminate(), this.ctx.timings.pongTimeoutMs);
    try { this.ws.ping(); } catch { this.ws.terminate(); }
  }

  closeWith(code: number, reason: string): void {
    if (this.dead) return;
    this.dropSubscriptions();
    this.dead = true;
    try { this.ws.close(code, reason); } catch { /* already closing */ }
    const t = setTimeout(() => this.ws.terminate(), this.ctx.timings.closeGraceMs);
    t.unref?.();
    this.cleanup(false);
  }

  private cleanup(notify = true): void {
    this.dead = true;
    this.dropSubscriptions();
    if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
    if (notify) this.onGone(this);
  }

  private dropSubscriptions(): void {
    for (const sub of this.subs.values()) sub.unsubscribe?.();
    this.subs.clear();
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  private onMessage(data: RawData): void {
    if (this.dead) return;
    const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8');
    const decoded = decodeClientFrame(text);
    if (!decoded.ok) {
      if (!this.auth) { this.closeWith(CLOSE_UNAUTHORIZED, 'hello required'); return; }
      this.queueControl(this.err(decoded.error.cmdId ?? '', decoded.error.code === 'unknown_type' ? 'bad_frame' : decoded.error.code, decoded.error.message));
      return;
    }
    const frame = decoded.frame;
    if (frame.type === 'hello') { this.onHello(frame); return; }
    if (!this.auth) { this.closeWith(CLOSE_UNAUTHORIZED, 'hello required'); return; }
    this.onCommand(frame, this.auth);
  }

  private onHello(frame: Extract<ClientFrame, { type: 'hello' }>): void {
    if (this.helloSeen) {
      this.queueControl(this.err(frame.cmdId, 'conflict', 'already authenticated'));
      return;
    }
    this.helloSeen = true;
    if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
    if (frame.protocol !== PROTOCOL_VERSION) {
      this.queueControl(this.err(frame.cmdId, 'unsupported_version', `daemon speaks protocol ${PROTOCOL_VERSION}`));
      this.closeWith(1002, 'unsupported protocol');
      return;
    }
    const verified = this.preAuth ?? (frame.token ? this.ctx.tokens.verify(frame.token) : null);
    if (!verified) {
      this.ctx.throttle.recordFailure(this.ip);
      this.ctx.audit({ event: 'auth_failed', ip: this.ip });
      this.queueControl(this.err(frame.cmdId, 'unauthorized', 'invalid token'));
      this.closeWith(CLOSE_UNAUTHORIZED, 'unauthorized');
      return;
    }
    this.ctx.throttle.reset(this.ip);
    this.auth = verified;
    this.ctx.audit({ event: 'connected', tokenId: verified.id, ip: this.ip, client: frame.client });
    const welcome: WelcomeFrame = {
      v: PROTOCOL_VERSION,
      type: 'welcome',
      cmdId: frame.cmdId,
      protocol: PROTOCOL_VERSION,
      daemonVersion: DAEMON_VERSION,
      minClientVersion: MIN_CLIENT_VERSION,
      capabilities: CAPABILITIES,
      daemonId: this.ctx.daemonId,
      epoch: this.ctx.epoch,
    };
    this.queueControl(encodeFrame(welcome));
  }

  private onCommand(frame: ClientFrame, auth: VerifiedToken): void {
    const need = REQUIRED_SCOPE[frame.type] ?? 'admin';
    if (!scopeSatisfies(auth.scope, need)) {
      this.queueControl(this.err(frame.cmdId, 'forbidden', `${frame.type} needs scope ${need}`));
      return;
    }
    const cacheable = !NOT_CACHED.has(frame.type);
    if (cacheable) {
      const hit = this.ctx.cmdCache.get(auth.id, frame.cmdId);
      if (hit) { this.queueControl(encodeFrame(hit)); return; }
    }
    let reply: AckFrame | ErrFrame;
    try {
      reply = { v: PROTOCOL_VERSION, type: 'ack', cmdId: frame.cmdId, result: this.dispatch(frame, auth) };
    } catch (e) {
      reply = this.toErr(frame.cmdId, e);
    }
    if (cacheable) this.ctx.cmdCache.set(auth.id, frame.cmdId, reply);
    this.ctx.audit({ event: 'command', tokenId: auth.id, type: frame.type, ok: reply.type === 'ack', ...('threadId' in frame ? { threadId: frame.threadId } : {}) });
    this.queueControl(encodeFrame(reply));
  }

  private toErr(cmdId: string, e: unknown): ErrFrame {
    if (e instanceof CommandError) return { v: PROTOCOL_VERSION, type: 'err', cmdId, code: e.code, message: e.message };
    if (e instanceof HostError) return { v: PROTOCOL_VERSION, type: 'err', cmdId, code: e.code, message: e.message };
    return { v: PROTOCOL_VERSION, type: 'err', cmdId, code: 'internal', message: e instanceof Error ? e.message : String(e) };
  }

  private dispatch(frame: ClientFrame, auth: VerifiedToken): unknown {
    const { host } = this.ctx;
    switch (frame.type) {
      case 'attach': return this.attach(frame.ch, frame.afterSeq);
      case 'ack': {
        if (frame.ch === 'ctl') return {};
        host.ack(frame.ch.slice(2), frame.seq);
        return {};
      }
      case 'session.open': {
        const res = host.open(frame.threadId, frame.spec);
        return { created: res.created, adopted: !res.created, ch: threadChannel(frame.threadId), lastSeq: res.lastSeq, epoch: this.ctx.epoch };
      }
      case 'session.send': host.send(frame.threadId, frame.text, frame.userMessageUuid); return {};
      case 'session.interrupt': host.interrupt(frame.threadId); return {};
      case 'session.detach':
      case 'session.close': host.closeSession(frame.threadId); return {};
      case 'session.list': return { threads: host.list() };
      case 'resolve.permission':
        host.resolve(frame.threadId, 'permission', frame.requestId, { allow: frame.allow, alwaysAllow: frame.alwaysAllow }, auth.id);
        return {};
      case 'resolve.question':
        host.resolve(frame.threadId, 'question', frame.requestId, { answers: frame.answers }, auth.id);
        return {};
      case 'resolve.plan':
        host.resolve(frame.threadId, 'plan', frame.requestId, { approve: frame.approve, editedPlan: frame.editedPlan }, auth.id);
        return {};
      case 'resolve.elicitation':
        host.resolve(frame.threadId, 'elicitation', frame.requestId, { result: frame.result }, auth.id);
        return {};
      case 'resolve.openTab':
        host.resolve(frame.threadId, 'openTab', frame.requestId, { openedThreadId: frame.openedThreadId, title: frame.title }, auth.id);
        return {};
      default:
        throw new CommandError('unknown_command', `${frame.type} is not supported by this daemon build`);
    }
  }

  // ── attach: replay then live, one ordered queue ──────────────────────────

  private attach(ch: Channel, afterSeq: number): unknown {
    if (!isChannel(ch)) throw new CommandError('bad_frame', 'invalid channel');
    if (ch === 'ctl') return { lastSeq: 0, lowWater: 0, epoch: this.ctx.epoch };
    const journal: ThreadJournal | null = this.ctx.host.journalFor(ch.slice(2));
    if (!journal) throw new CommandError('not_found', `unknown thread ${ch.slice(2)}`);

    this.subs.get(ch)?.unsubscribe?.();
    const sub = new ChannelSub(ch);
    // Everything from here to the end of this block runs in one synchronous
    // turn: no append can interleave, so replay + subscribe has no gap.
    // A cursor AHEAD of the journal means the client saw history we no longer
    // have (data directory restored or wiped); it must rebuild, not wait.
    const replay = afterSeq > journal.lastSeq
      ? { kind: 'resync' as const, checkpoint: journal.checkpoint(), lastSeq: journal.lastSeq }
      : journal.replay(afterSeq);
    if (replay.kind === 'resync') {
      const cp = replay.checkpoint;
      sub.resyncText = encodeFrame({ v: PROTOCOL_VERSION, ch, seq: cp.seq, ts: cp.ts, type: 'resync', checkpoint: cp });
    } else {
      for (const entry of replay.entries) sub.items.push({ entry, live: false });
    }
    sub.unsubscribe = journal.subscribe((entry) => this.onLive(sub, entry));
    this.subs.set(ch, sub);
    const result = { lastSeq: replay.lastSeq, lowWater: journal.lowWater, epoch: this.ctx.epoch, resync: replay.kind === 'resync' };
    // The ack is queued first (control drains before channels) so the client
    // learns the cursor before the first replayed event.
    return result;
  }

  private onLive(sub: ChannelSub, entry: JournalEntry<WireEvent>): void {
    if (this.dead) return;
    const text = this.eventText(sub.ch, entry);
    sub.items.push({ entry, live: true, text });
    this.liveBytes += text.length;
    if (this.liveBytes + this.ws.bufferedAmount > this.ctx.maxOutboundBytes) {
      this.ctx.audit({ event: 'slow_consumer', tokenId: this.tokenId, ch: sub.ch });
      this.closeWith(CLOSE_SLOW_CONSUMER, 'slow_consumer');
      return;
    }
    this.pump();
  }

  private eventText(ch: Channel, entry: JournalEntry<WireEvent>): string {
    return encodeFrame({ v: PROTOCOL_VERSION, ch, seq: entry.seq, ts: entry.ts, type: 'event', ...entry.event });
  }

  // ── outbound ─────────────────────────────────────────────────────────────

  private err(cmdId: string, code: ErrorCode, message: string): string {
    return encodeFrame({ v: PROTOCOL_VERSION, type: 'err', cmdId, code, message });
  }

  private queueControl(text: string): void {
    this.control.push(text);
    this.pump();
  }

  private pump(): void {
    if (this.pumping || this.ws.readyState !== 1) return;
    this.pumping = true;
    try {
      while (this.ws.bufferedAmount < SOCKET_HIGH_WATER) {
        const text = this.nextFrame();
        if (text === null) break;
        this.ws.send(text, (err) => {
          if (err) this.ws.terminate();
          else this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  private nextFrame(): string | null {
    const c = this.control.shift();
    if (c !== undefined) return c;
    // Round-robin one frame per channel so a long backlog cannot starve another channel.
    for (const sub of this.subs.values()) {
      if (sub.resyncText !== null) {
        const t = sub.resyncText;
        sub.resyncText = null;
        return t;
      }
      const item = sub.next();
      if (!item) continue;
      if (item.live) this.liveBytes -= item.text?.length ?? 0;
      const text = item.text ?? this.eventText(sub.ch, item.entry);
      // Rotate so the next call starts at a different channel.
      this.subs.delete(sub.ch);
      this.subs.set(sub.ch, sub);
      return text;
    }
    return null;
  }
}

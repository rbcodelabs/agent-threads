/**
 * DaemonClient
 *
 * Client side of the daemon wire protocol (`src/protocol`, design 3.1-3.4):
 * one authenticated WebSocket to one daemon, shared by every remote thread on
 * it. Transport-agnostic and core-safe (no DOM, no Node-only import): the
 * caller injects a `WebSocketFactory`. The plugin passes the bundled `ws`
 * module (Geode's renderer CSP blocks the global `WebSocket`; see
 * docs/remote-daemon.md), a test passes `ws`, and the CLI can pass either.
 *
 * What it guarantees:
 *   - first-frame `hello{token}` auth; the token is never put in the URL;
 *   - reconnect on the shared `RECONNECT_BACKOFF_MS` ladder, then re-attach
 *     every open channel with `afterSeq = cursor.lastSeq`;
 *   - idempotent apply: an event with `seq <= lastSeq` is dropped
 *     (`StreamCursor`), so replay overlapping live delivery never double-applies;
 *   - idempotent commands: a command whose ack was lost is re-sent with the SAME
 *     `cmdId` after reconnect, and the daemon answers from its 10 minute cache
 *     instead of running it twice;
 *   - `ack` of a channel's seq, debounced, sent only when the consumer says the
 *     state behind it is persisted;
 *   - liveness: WebSocket pings are invisible to the browser API, so an idle
 *     socket is probed with a cheap `attach{ctl}` and dropped if it goes unanswered.
 */
import {
  CLOSE_UNAUTHORIZED,
  PROTOCOL_VERSION,
  StreamCursor,
  decodeServerFrame,
  encodeFrame,
  threadChannel,
  type AckFrame,
  type Channel,
  type ClientCommand,
  type ClientCommandType,
  type ClientFrame,
  type ClientKind,
  type ErrFrame,
  type ErrorCode,
  type EventFrame,
  type ResyncFrame,
  type WelcomeFrame,
} from '../protocol';
import { RECONNECT_BACKOFF_MS } from './backoff';

// ── transport seam ──────────────────────────────────────────────────────────

/** The slice of the WHATWG `WebSocket` (also implemented by `ws`) this client uses. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** `ws` only: drop the TCP connection without a closing handshake. */
  terminate?(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const WS_OPEN = 1;

/** Normalise a user-entered daemon URL to the WebSocket endpoint. */
export function daemonWsUrl(input: string): string {
  const raw = input.trim().replace(/\/+$/, '');
  let url = raw;
  if (/^http:\/\//i.test(url)) url = `ws://${url.slice(7)}`;
  else if (/^https:\/\//i.test(url)) url = `wss://${url.slice(8)}`;
  else if (!/^wss?:\/\//i.test(url)) url = `ws://${url}`;
  return url.endsWith('/v1/ws') ? url : `${url}/v1/ws`;
}

// ── public types ────────────────────────────────────────────────────────────

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unreachable'
  | 'unauthorized'
  | 'incompatible'
  | 'closed';

export interface DaemonInfo {
  daemonId: string;
  daemonVersion: string;
  protocol: number;
  minClientVersion: string;
  capabilities: string[];
  epoch: string;
}

export interface ConnectionState {
  status: ConnectionStatus;
  /** Consecutive failed attempts since the last successful connection. */
  attempt: number;
  /** Human-readable reason for the current non-connected state. */
  detail?: string;
  /** Present once a `welcome` has been received (kept while reconnecting). */
  info?: DaemonInfo;
}

export class DaemonCommandError extends Error {
  constructor(
    readonly code: ErrorCode | 'unreachable' | 'timeout' | 'closed' | 'incompatible',
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'DaemonCommandError';
  }
}

export type CommandResult = Record<string, unknown>;

/** What `attach` answered (also emitted to the channel handler after every (re)attach). */
export interface AttachInfo {
  lastSeq: number;
  lowWater: number;
  epoch: string;
  resync: boolean;
  /** False when another client holds the read-write seat and this one only observes. */
  controller: boolean;
}

export interface ChannelHandlers {
  /**
   * A fresh event (`seq` above the cursor), in order. `reopen` is set for a
   * request re-delivered below the cursor: it did not advance the cursor.
   */
  onEvent(frame: EventFrame, meta: { reopen: boolean }): void;
  /** The cursor fell behind the daemon's journal: rebuild from the checkpoint. */
  onResync?(frame: ResyncFrame): void;
  onAttached?(info: AttachInfo): void;
  onAttachError?(err: DaemonCommandError): void;
}

export interface ChannelSubscription {
  readonly channel: Channel;
  readonly cursor: StreamCursor;
  /** Tell the daemon everything through `seq` is persisted on this side (debounced). */
  ack(seq: number): void;
  close(): void;
}

export interface DaemonClientOptions {
  url: string;
  /** Read at every (re)connect so a token changed in Settings applies without a restart. */
  getToken: () => string | undefined;
  createSocket: WebSocketFactory;
  client?: ClientKind;
  clientVersion: string;
  /** Default `RECONNECT_BACKOFF_MS`. */
  backoffMs?: readonly number[];
  /** Failed attempts after which the state reads `unreachable` instead of `reconnecting` (default 3). */
  unreachableAfter?: number;
  /** Retry forever (default) or give up after the first failure (used by "test connection"). */
  reconnect?: boolean;
  helloTimeoutMs?: number;
  /** Idle time before a liveness probe (default 25 s) and the wait for its answer (default 10 s). */
  idleProbeMs?: number;
  probeTimeoutMs?: number;
  /** Default time a command waits for a connection plus its ack (default 30 s). */
  commandTimeoutMs?: number;
  ackDebounceMs?: number;
  log?: (message: string) => void;
}

interface PendingCommand {
  cmdId: string;
  text: string;
  type: string;
  /** Re-sent after a reconnect (same cmdId). Attach and probes are not: they are re-issued. */
  resend: boolean;
  resolve(result: CommandResult): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
}

class ChannelSubscriptionImpl implements ChannelSubscription {
  readonly cursor: StreamCursor;
  ackTarget = 0;
  ackSent = 0;
  ackTimer: ReturnType<typeof setTimeout> | null = null;
  closed = false;

  constructor(
    readonly channel: Channel,
    afterSeq: number,
    readonly handlers: ChannelHandlers,
    private readonly owner: DaemonClient,
  ) {
    this.cursor = new StreamCursor(afterSeq);
  }

  ack(seq: number): void {
    if (this.closed || seq <= this.ackTarget) return;
    this.ackTarget = seq;
    this.owner.scheduleAck(this);
  }

  close(): void {
    this.closed = true;
    this.owner.dropChannel(this);
  }
}

let cmdCounter = 0;
const newCmdId = (): string => {
  const rand = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `dc${++cmdCounter}-${rand}`;
};

/** Numeric dotted-version comparison; non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => parseInt(p, 10) || 0);
  const pb = b.split('.').map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export class DaemonClient {
  private readonly opts: Required<Pick<DaemonClientOptions, 'backoffMs' | 'unreachableAfter' | 'reconnect' | 'helloTimeoutMs' | 'idleProbeMs' | 'probeTimeoutMs' | 'commandTimeoutMs' | 'ackDebounceMs'>> & DaemonClientOptions;
  private state: ConnectionState = { status: 'idle', attempt: 0 };
  private info: DaemonInfo | undefined;
  private ws: WebSocketLike | null = null;
  private socketGen = 0;
  private welcomed = false;
  private wantConnected = false;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRx = 0;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly channels = new Map<Channel, ChannelSubscriptionImpl>();
  private readonly stateListeners = new Set<(s: ConnectionState) => void>();

  constructor(options: DaemonClientOptions) {
    this.opts = {
      backoffMs: RECONNECT_BACKOFF_MS,
      unreachableAfter: 3,
      reconnect: true,
      helloTimeoutMs: 10_000,
      idleProbeMs: 25_000,
      probeTimeoutMs: 10_000,
      commandTimeoutMs: 30_000,
      ackDebounceMs: 750,
      ...options,
    };
  }

  // ── state ────────────────────────────────────────────────────────────────

  get connection(): ConnectionState { return this.state; }
  get daemonInfo(): DaemonInfo | undefined { return this.info; }
  get url(): string { return this.opts.url; }
  get isConnected(): boolean { return this.state.status === 'connected'; }

  onState(listener: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private setState(next: Partial<ConnectionState> & { status: ConnectionStatus }): void {
    const merged: ConnectionState = { attempt: this.state.attempt, info: this.info, ...next };
    if (merged.status === 'connected') delete merged.detail;
    const same = merged.status === this.state.status && merged.attempt === this.state.attempt && merged.detail === this.state.detail && merged.info === this.state.info;
    this.state = merged;
    if (same) return;
    for (const l of [...this.stateListeners]) {
      try { l(merged); } catch (err) { this.log(`state listener threw: ${String(err)}`); }
    }
  }

  private log(message: string): void { this.opts.log?.(`[DaemonClient ${this.opts.url}] ${message}`); }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Start (or restart after a terminal failure) connecting. Idempotent. */
  connect(): void {
    if (this.disposed) return;
    // An incompatible daemon will not become compatible by retrying; reconnectNow() is the explicit retry.
    if (this.state.status === 'incompatible') return;
    this.wantConnected = true;
    if (this.ws || this.reconnectTimer) return;
    this.openSocket();
  }

  /** Re-read the token / URL-independent config and try again now (Settings changed). */
  reconnectNow(): void {
    if (this.disposed) return;
    this.wantConnected = true;
    this.clearReconnectTimer();
    if (this.ws) this.dropSocket(false);
    this.state = { ...this.state, attempt: 0 };
    this.openSocket();
  }

  /** Close for good: rejects pending commands and ends every subscription. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.wantConnected = false;
    this.clearReconnectTimer();
    for (const sub of [...this.channels.values()]) {
      if (sub.ackTimer) clearTimeout(sub.ackTimer);
    }
    this.channels.clear();
    this.dropSocket(true);
    this.failAllPending(new DaemonCommandError('closed', 'client closed'));
    this.setState({ status: 'closed', attempt: this.state.attempt, detail: 'closed' });
    this.stateListeners.clear();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private openSocket(): void {
    if (this.disposed || this.ws) return;
    this.clearReconnectTimer();
    const token = this.opts.getToken();
    if (!token) {
      this.setState({ status: 'unauthorized', attempt: this.state.attempt, detail: 'no access token is configured for this daemon' });
      return;
    }
    const gen = ++this.socketGen;
    let ws: WebSocketLike;
    try {
      ws = this.opts.createSocket(this.opts.url);
    } catch (err) {
      this.onSocketFailed(gen, `could not open socket: ${errText(err)}`);
      return;
    }
    this.ws = ws;
    this.welcomed = false;
    // After `this.ws` is set: a state listener that calls connect() (the thread header does) must see a socket in flight.
    this.setState({
      status: this.state.attempt === 0 ? 'connecting' : this.state.attempt >= this.opts.unreachableAfter ? 'unreachable' : 'reconnecting',
      attempt: this.state.attempt,
      detail: this.state.detail,
    });
    ws.onopen = () => {
      if (gen !== this.socketGen) return;
      this.lastRx = Date.now();
      this.rawSend({
        v: PROTOCOL_VERSION,
        cmdId: 'hello',
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        client: this.opts.client ?? 'geode-plugin',
        clientVersion: this.opts.clientVersion,
        token,
      });
      this.helloTimer = setTimeout(() => {
        if (gen === this.socketGen && !this.welcomed) this.onSocketFailed(gen, 'daemon did not answer the handshake');
      }, this.opts.helloTimeoutMs);
    };
    ws.onmessage = (ev) => {
      if (gen !== this.socketGen) return;
      this.lastRx = Date.now();
      this.onFrame(typeof ev.data === 'string' ? ev.data : String(ev.data), gen);
    };
    ws.onerror = () => { /* followed by onclose; the reason is not exposed by browsers */ };
    ws.onclose = (ev) => {
      if (gen !== this.socketGen) return;
      this.onSocketFailed(gen, ev.reason || `connection closed (${ev.code})`, ev.code);
    };
  }

  /** Tear the current socket down without scheduling anything. */
  private dropSocket(final: boolean): void {
    this.socketGen++; // orphan its handlers
    const ws = this.ws;
    this.ws = null;
    this.welcomed = false;
    if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.probeTimer) { clearTimeout(this.probeTimer); this.probeTimer = null; }
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        if (typeof ws.terminate === 'function') ws.terminate();
        else ws.close(final ? 1000 : 4000, 'client reset');
      } catch { /* already closed */ }
    }
    // Requests that cannot be re-sent die with the socket; resendable ones wait.
    for (const [id, cmd] of [...this.pending]) {
      if (!cmd.resend) {
        this.pending.delete(id);
        if (cmd.timer) clearTimeout(cmd.timer);
        cmd.reject(new DaemonCommandError('unreachable', 'connection lost'));
      }
    }
  }

  private onSocketFailed(gen: number, detail: string, code?: number): void {
    if (gen !== this.socketGen || this.disposed) return;
    this.dropSocket(false);
    if (code === CLOSE_UNAUTHORIZED) {
      this.failAllPending(new DaemonCommandError('unauthorized', 'the daemon rejected the access token'));
      this.setState({ status: 'unauthorized', attempt: this.state.attempt, detail: 'the daemon rejected the access token' });
      return;
    }
    if (code === 1002) {
      this.setState({ status: 'incompatible', attempt: this.state.attempt, detail: 'the daemon does not speak this protocol version' });
      return;
    }
    const attempt = this.state.attempt + 1;
    if (!this.opts.reconnect || !this.wantConnected) {
      this.setState({ status: 'unreachable', attempt, detail });
      return;
    }
    const delay = this.opts.backoffMs[Math.min(attempt - 1, this.opts.backoffMs.length - 1)];
    // The timer is armed BEFORE listeners hear about the new state: a listener that calls connect()
    // (the thread header does) must find a retry already pending, not open a second socket.
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wantConnected && !this.ws) this.openSocket();
    }, delay);
    this.setState({ status: attempt >= this.opts.unreachableAfter ? 'unreachable' : 'reconnecting', attempt, detail });
    this.log(`${detail}; retry ${attempt} in ${delay} ms`);
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  private onFrame(text: string, gen: number): void {
    const decoded = decodeServerFrame(text);
    if (!decoded.ok) {
      this.log(`dropped undecodable frame: ${decoded.error.message}`);
      return;
    }
    const frame = decoded.frame;
    switch (frame.type) {
      case 'welcome': this.onWelcome(frame, gen); return;
      case 'ack': this.settle(frame); return;
      case 'err': this.settleErr(frame, gen); return;
      case 'event':
      case 'resync': this.onChannelFrame(frame); return;
    }
  }

  private onWelcome(w: WelcomeFrame, gen: number): void {
    if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
    const info: DaemonInfo = {
      daemonId: w.daemonId,
      daemonVersion: w.daemonVersion,
      protocol: w.protocol,
      minClientVersion: w.minClientVersion,
      capabilities: w.capabilities,
      epoch: w.epoch,
    };
    this.info = info;
    if (w.protocol !== PROTOCOL_VERSION) {
      this.makeIncompatible(gen, `daemon speaks protocol ${w.protocol}, this client speaks ${PROTOCOL_VERSION}`);
      return;
    }
    if (compareVersions(this.opts.clientVersion, w.minClientVersion) < 0) {
      this.makeIncompatible(gen, `this plugin (${this.opts.clientVersion}) is older than the daemon requires (${w.minClientVersion}); update the plugin`);
      return;
    }
    this.welcomed = true;
    this.setState({ status: 'connected', attempt: 0, info });
    this.scheduleIdleProbe();
    // Order matters: channels first (events start flowing), then the commands whose acks were lost.
    for (const sub of this.channels.values()) this.attach(sub);
    for (const cmd of this.pending.values()) {
      if (cmd.resend) this.rawSendText(cmd.text);
    }
    for (const sub of this.channels.values()) {
      if (sub.ackTarget > sub.ackSent) this.scheduleAck(sub);
    }
  }

  private makeIncompatible(gen: number, detail: string): void {
    this.wantConnected = false;
    this.dropSocket(false);
    this.failAllPending(new DaemonCommandError('incompatible', detail));
    void gen;
    this.setState({ status: 'incompatible', attempt: this.state.attempt, detail, info: this.info });
  }

  private settle(frame: AckFrame): void {
    const cmd = this.pending.get(frame.cmdId);
    if (!cmd) return;
    this.pending.delete(frame.cmdId);
    if (cmd.timer) clearTimeout(cmd.timer);
    cmd.resolve((frame.result && typeof frame.result === 'object' ? frame.result : {}) as CommandResult);
  }

  private settleErr(frame: ErrFrame, gen: number): void {
    if (frame.cmdId === 'hello') {
      this.dropSocket(false);
      this.failAllPending(new DaemonCommandError(frame.code, frame.message));
      if (frame.code === 'unauthorized') {
        this.setState({ status: 'unauthorized', attempt: this.state.attempt, detail: frame.message });
      } else if (frame.code === 'unsupported_version') {
        this.setState({ status: 'incompatible', attempt: this.state.attempt, detail: frame.message });
      } else {
        this.onSocketFailed(this.socketGen, frame.message);
      }
      void gen;
      return;
    }
    const cmd = this.pending.get(frame.cmdId);
    if (!cmd) return;
    this.pending.delete(frame.cmdId);
    if (cmd.timer) clearTimeout(cmd.timer);
    cmd.reject(new DaemonCommandError(frame.code, frame.message, frame.retryable === true));
  }

  private onChannelFrame(frame: EventFrame | ResyncFrame): void {
    const sub = this.channels.get(frame.ch);
    if (!sub || sub.closed) return;
    try {
      if (frame.type === 'event' && frame.reopen) {
        // A still-open request seen before: never dropped, never moves the cursor.
        sub.handlers.onEvent(frame, { reopen: true });
        return;
      }
      const outcome = sub.cursor.accept(frame);
      if (outcome === 'duplicate') return;
      if (outcome === 'resync') sub.handlers.onResync?.(frame as ResyncFrame);
      else sub.handlers.onEvent(frame as EventFrame, { reopen: false });
    } catch (err) {
      // A consumer bug must not wedge the socket loop or lose the cursor.
      this.log(`handler for ${frame.ch} threw: ${errText(err)}`);
    }
  }

  // ── liveness ─────────────────────────────────────────────────────────────

  private scheduleIdleProbe(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const gen = this.socketGen;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (gen !== this.socketGen || !this.welcomed) return;
      const quiet = Date.now() - this.lastRx;
      if (quiet < this.opts.idleProbeMs) { this.scheduleIdleProbe(); return; }
      // `attach{ctl}` is read-scope, stateless and uncached: the cheapest round trip there is.
      void this.request('attach', { ch: 'ctl', afterSeq: 0 }, { resend: false, timeoutMs: this.opts.probeTimeoutMs })
        .then(() => { if (gen === this.socketGen) this.scheduleIdleProbe(); })
        .catch(() => { if (gen === this.socketGen) this.onSocketFailed(gen, 'daemon stopped answering'); });
    }, this.opts.idleProbeMs);
  }

  // ── commands ─────────────────────────────────────────────────────────────

  /**
   * Send a command and resolve with its ack result. If the socket is down the
   * command waits for the next connection (up to `timeoutMs`); if it was sent
   * but its ack was lost, it is re-sent with the same `cmdId` after reconnect,
   * which the daemon deduplicates.
   */
  command<K extends Exclude<ClientCommandType, 'hello'>>(
    type: K,
    payload: Omit<Extract<ClientCommand, { type: K }>, 'type'>,
    opts: { timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    return this.request(type, payload as Record<string, unknown>, { resend: true, timeoutMs: opts.timeoutMs ?? this.opts.commandTimeoutMs });
  }

  private request(
    type: string,
    payload: Record<string, unknown>,
    opts: { resend: boolean; timeoutMs: number },
  ): Promise<CommandResult> {
    if (this.disposed) return Promise.reject(new DaemonCommandError('closed', 'client closed'));
    const st = this.state.status;
    if (st === 'unauthorized') return Promise.reject(new DaemonCommandError('unauthorized', this.state.detail ?? 'unauthorized'));
    if (st === 'incompatible') return Promise.reject(new DaemonCommandError('incompatible', this.state.detail ?? 'incompatible daemon'));
    if (!this.wantConnected) this.connect();
    const cmdId = newCmdId();
    const frame = { v: PROTOCOL_VERSION, cmdId, type, ...payload } as ClientFrame;
    const text = encodeFrame(frame);
    return new Promise<CommandResult>((resolve, reject) => {
      const cmd: PendingCommand = {
        cmdId,
        text,
        type,
        resend: opts.resend,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(cmdId);
          const connected = this.isConnected;
          reject(new DaemonCommandError(
            connected ? 'timeout' : 'unreachable',
            connected ? `${type} timed out waiting for the daemon` : `daemon unreachable${this.state.detail ? ` (${this.state.detail})` : ''}`,
          ));
        }, opts.timeoutMs),
      };
      this.pending.set(cmdId, cmd);
      if (this.welcomed && this.ws?.readyState === WS_OPEN) this.rawSendText(text);
    });
  }

  private failAllPending(err: Error): void {
    for (const cmd of [...this.pending.values()]) {
      if (cmd.timer) clearTimeout(cmd.timer);
      cmd.reject(err);
    }
    this.pending.clear();
  }

  private rawSend(frame: ClientFrame): void { this.rawSendText(encodeFrame(frame)); }

  private rawSendText(text: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return;
    try { ws.send(text); } catch (err) { this.log(`send failed: ${errText(err)}`); }
  }

  // ── channels ─────────────────────────────────────────────────────────────

  /**
   * Follow one thread's event stream. The subscription survives reconnects:
   * each connection re-attaches with `afterSeq = cursor.lastSeq`. Replaces any
   * existing subscription for the thread.
   */
  subscribe(threadId: string, handlers: ChannelHandlers, afterSeq = 0): ChannelSubscription {
    const channel = threadChannel(threadId);
    this.channels.get(channel)?.close();
    const sub = new ChannelSubscriptionImpl(channel, afterSeq, handlers, this);
    sub.ackSent = afterSeq;
    sub.ackTarget = afterSeq;
    this.channels.set(channel, sub);
    if (!this.wantConnected) this.connect();
    if (this.welcomed) this.attach(sub);
    return sub;
  }

  private attach(sub: ChannelSubscriptionImpl): void {
    const gen = this.socketGen;
    // `afterSeq` is read NOW, not at subscribe time: it is the exact point this client has applied.
    this.request('attach', { ch: sub.channel, afterSeq: sub.cursor.lastSeq }, { resend: false, timeoutMs: this.opts.commandTimeoutMs })
      .then((result) => {
        if (sub.closed || gen !== this.socketGen) return;
        sub.handlers.onAttached?.(result as unknown as AttachInfo);
      })
      .catch((err: unknown) => {
        if (sub.closed || gen !== this.socketGen) return;
        // A dropped socket re-attaches on the next connection; only a real refusal is reported.
        if (err instanceof DaemonCommandError && err.code !== 'unreachable' && err.code !== 'timeout' && err.code !== 'closed') {
          sub.handlers.onAttachError?.(err);
        }
      });
  }

  /** @internal */
  dropChannel(sub: ChannelSubscriptionImpl): void {
    if (this.channels.get(sub.channel) === sub) this.channels.delete(sub.channel);
    if (sub.ackTimer) { clearTimeout(sub.ackTimer); sub.ackTimer = null; }
  }

  /** @internal */
  scheduleAck(sub: ChannelSubscriptionImpl): void {
    if (sub.ackTimer) return;
    sub.ackTimer = setTimeout(() => {
      sub.ackTimer = null;
      if (sub.closed || sub.ackTarget <= sub.ackSent) return;
      if (!this.welcomed) return; // re-scheduled by onWelcome
      const seq = sub.ackTarget;
      sub.ackSent = seq;
      void this.request('ack', { ch: sub.channel, seq }, { resend: false, timeoutMs: this.opts.commandTimeoutMs }).catch(() => {
        // Not acked: retention just stays longer. Retry on the next connection.
        if (sub.ackSent === seq) sub.ackSent = Math.min(sub.ackSent, seq - 1);
      });
    }, this.opts.ackDebounceMs);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── one-shot probe (Settings -> Test connection) ────────────────────────────

export type ProbeResult =
  | { ok: true; info: DaemonInfo }
  | { ok: false; status: ConnectionStatus; detail: string; info?: DaemonInfo };

/** Connect once, report what the daemon said, disconnect. Never retries. */
export function probeDaemon(
  options: Pick<DaemonClientOptions, 'url' | 'createSocket' | 'clientVersion' | 'client'> & { token: string; timeoutMs?: number },
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const client = new DaemonClient({
      url: options.url,
      getToken: () => options.token,
      createSocket: options.createSocket,
      clientVersion: options.clientVersion,
      client: options.client,
      reconnect: false,
      helloTimeoutMs: options.timeoutMs ?? 8000,
    });
    let done = false;
    const finish = (r: ProbeResult): void => {
      if (done) return;
      done = true;
      client.dispose();
      resolve(r);
    };
    client.onState((s) => {
      if (s.status === 'connected' && s.info) finish({ ok: true, info: s.info });
      else if (s.status === 'unauthorized' || s.status === 'incompatible' || s.status === 'unreachable' || s.status === 'closed') {
        finish({ ok: false, status: s.status, detail: s.detail ?? s.status, info: s.info });
      }
    });
    client.connect();
  });
}

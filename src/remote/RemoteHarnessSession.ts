/**
 * RemoteHarnessSession
 *
 * A `HarnessSession` whose process lives on an agent-threads daemon (design
 * 4.3). `ThreadManager` is unchanged and still owns the transcript: it hands
 * this class the same `SessionCallbacks` it hands a local `ThreadSession`, and
 * this class invokes them, in order, from the daemon's event stream.
 *
 *   commands    start/send/interrupt/setModel/... -> daemon commands (idempotent cmdIds)
 *   callbacks   `event` frames -> `options.callbacks.on*(...)`, after the cursor check
 *   requests    permission / question / plan / elicitation arrive as `*_request`
 *               events carrying a daemon-owned id; the callback's promise (or the
 *               approve/reject functions) answer with `resolve.*`
 *   getters     `turnInFlight`, `hasPendingPermission`, `canIdleReap()` are served
 *               from the mirrored `session.state` event, never an RPC
 *
 * Persistence: `thread.remote.lastSeq` is the resume cursor and is mutated on
 * the thread object, so it is saved by the same write as the transcript it
 * describes. It is conservative: while an assistant message is still streaming
 * it stays before that message's first token, so a restart replays the tokens
 * (the transcript only ever receives the finished `onMessage`).
 */
import type { SessionCallbacks } from '../ClaudeSession';
import type {
  HarnessContextUsage,
  HarnessPermissionMode,
  HarnessSession,
  HarnessSessionOptions,
} from '../HarnessSession';
import {
  OVERRIDES,
  type EventFrame,
  type RemoteSessionSpec,
  type ResyncFrame,
  type SessionStateArgs,
  type WireImage,
} from '../protocol';
import type { ImageAttachment, Thread, ThreadRemote } from '../types';
import type { UsageSnapshot } from '../Usage';
import { DaemonCommandError, type ChannelSubscription, type DaemonClient } from './DaemonClient';
import { projectSessionOptions } from './sessionSpec';

type Dict = Record<string, unknown>;

export interface RemoteSessionDeps {
  log?: (message: string) => void;
  /** Test seam for the generated message uuid. */
  newId?: () => string;
}

interface OpenRequest {
  kind: 'permission' | 'question' | 'plan' | 'elicitation';
  abort?: AbortController;
}

interface QueuedSend {
  text: string;
  images?: ImageAttachment[];
  uuid: string;
}

/** Callbacks whose first wire argument is a serialized `Error`. */
const ERROR_ARG_CALLBACKS = new Set(['onError', 'onPlanTransitionError']);
const WIRE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export class RemoteHarnessSession implements HarnessSession {
  private callbacks: SessionCallbacks | null = null;
  private spec: RemoteSessionSpec | null = null;
  private startedCwd: string | undefined;
  private state: SessionStateArgs = { turnInFlight: false, hasPendingPermission: false, hostAttached: false };
  /** A send was issued and the mirrored state has not caught up yet. */
  private sendAwaitingState = false;
  private queued: QueuedSend[] = [];
  private readonly requests = new Map<string, OpenRequest>();
  private sub: ChannelSubscription | null = null;
  private opened = false;
  private closed = false;
  /** Seq just before the first token of the assistant message being streamed (null = none open). */
  private streamOpenFrom: number | null = null;
  private observerNoticeShown = false;

  constructor(
    private readonly client: DaemonClient,
    private readonly thread: Thread,
    private readonly deps: RemoteSessionDeps = {},
  ) {
    if (!thread.remote) throw new Error('RemoteHarnessSession needs a thread with a remote marker');
  }

  private get remote(): ThreadRemote { return this.thread.remote as ThreadRemote; }
  private get threadId(): string { return this.thread.id; }
  private log(message: string): void { this.deps.log?.(`[RemoteHarnessSession ${this.threadId}] ${message}`); }

  // ── synchronous getters (mirror) ─────────────────────────────────────────

  get turnInFlight(): boolean { return this.sendAwaitingState || this.state.turnInFlight; }
  get cwd(): string | undefined { return this.startedCwd; }
  get hasPendingPermission(): boolean { return this.requests.size > 0 || this.state.hasPendingPermission; }
  canIdleReap(): boolean {
    return !this.turnInFlight && !this.hasPendingPermission && this.queued.length === 0 && this.state.canIdleReap !== false;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * Open (or adopt) the session on the daemon, then follow its event stream.
   * `attachOnly` re-attaches a thread whose turn was running when Geode quit:
   * it only listens, and opens the session lazily if a command needs it, so
   * viewing a finished thread never spawns a process.
   */
  async start(options: HarnessSessionOptions, mode: { attachOnly?: boolean } = {}): Promise<void> {
    this.callbacks = options.callbacks;
    this.startedCwd = options.cwd;
    this.spec = projectSessionOptions(options, this.thread);
    this.resume = options.resume;
    if (mode.attachOnly) {
      // A turn was running when the host quit: show it as running until the replay says otherwise.
      if (this.remote.turnPending) this.sendAwaitingState = true;
      this.follow();
      return;
    }
    await this.ensureOpen();
    if (this.closed) return;
    this.follow();
  }

  private resume: string | undefined;
  private opening: Promise<void> | null = null;

  private ensureOpen(): Promise<void> {
    if (this.opened) return Promise.resolve();
    if (!this.spec) return Promise.reject(new Error('session was never started'));
    this.opening ??= this.client
      .command('session.open', { threadId: this.threadId, spec: this.spec, ...(this.resume ? { resume: this.resume } : {}) })
      .then((res) => {
        this.opened = true;
        if (typeof res.epoch === 'string') this.remote.epoch = res.epoch;
        if (typeof res.nativeSessionId === 'string') this.remote.nativeSessionId = res.nativeSessionId;
      })
      .finally(() => { this.opening = null; });
    return this.opening;
  }

  private follow(): void {
    if (this.sub || this.closed) return;
    this.sub = this.client.subscribe(
      this.threadId,
      {
        onEvent: (frame, meta) => this.onEvent(frame, meta.reopen),
        onResync: (frame) => this.onResync(frame),
        onAttached: (info) => {
          this.remote.epoch = info.epoch;
          if (!info.controller && !this.observerNoticeShown) {
            this.observerNoticeShown = true;
            this.callbacks?.onNotification?.('This thread is controlled by another client; you are viewing it read-only.', 'high');
          }
        },
        onAttachError: (err) => {
          if (this.closed) return;
          this.log(`attach refused: ${err.code}: ${err.message}`);
          this.failTurn(new Error(err.code === 'not_found'
            ? 'The daemon no longer has this thread (its data may have been reset).'
            : `Could not follow the remote thread: ${err.message}`));
        },
      },
      this.remote.lastSeq,
    );
  }

  /** Stop and tear down the session on the daemon (history stays attachable there). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sub?.close();
    this.sub = null;
    this.cancelLocalRequests();
    this.queued = [];
    if (this.opened || this.opening) {
      void this.client.command('session.close', { threadId: this.threadId }).catch((err: unknown) => {
        this.log(`session.close failed: ${errText(err)}`);
      });
    }
  }

  /** Let go without ending anything: the turn keeps running on the daemon. */
  detach(): void {
    if (this.closed) return;
    this.closed = true;
    this.sub?.close();
    this.sub = null;
    this.cancelLocalRequests();
    if (this.opened) {
      void this.client.command('session.detach', { threadId: this.threadId }, { timeoutMs: 3000 }).catch(() => { /* the disconnect releases the seat anyway */ });
    }
  }

  notifyPersisted(): void {
    this.sub?.ack(this.remote.lastSeq);
  }

  private cancelLocalRequests(): void {
    for (const req of this.requests.values()) req.abort?.abort();
    this.requests.clear();
  }

  // ── commands ─────────────────────────────────────────────────────────────

  async prepareForSend(text: string, images?: ImageAttachment[]): Promise<void> {
    await this.ensureOpen();
    await this.client.command('session.prepareForSend', { threadId: this.threadId, text, ...wireImages(images) });
  }

  send(text: string, images?: ImageAttachment[], userMessageUuid?: string): void {
    const item: QueuedSend = { text, images, uuid: userMessageUuid ?? (this.deps.newId ?? (() => crypto.randomUUID()))() };
    // The daemon refuses a second send while a turn runs (a local ThreadSession would coalesce it);
    // hold it here and send it the moment the turn ends.
    if (this.turnInFlight) {
      this.queued.push(item);
      return;
    }
    this.dispatchSend(item);
  }

  private dispatchSend(item: QueuedSend): void {
    this.sendAwaitingState = true;
    this.syncPending();
    void this.ensureOpen()
      .then(() => this.client.command('session.send', {
        threadId: this.threadId,
        text: item.text,
        userMessageUuid: item.uuid,
        ...wireImages(item.images),
      }))
      .catch((err: unknown) => {
        if (this.closed) return;
        this.log(`session.send failed: ${errText(err)}`);
        this.failTurn(err instanceof DaemonCommandError && err.code === 'unreachable'
          ? new Error('The remote daemon is unreachable; your message was not delivered. Check the connection and send it again.')
          : err instanceof Error ? err : new Error(String(err)));
      });
  }

  async interrupt(): Promise<void> {
    this.queued = [];
    await this.client.command('session.interrupt', { threadId: this.threadId });
  }

  async sendAgentMessage(nativeAgentId: string, text: string): Promise<void> {
    await this.client.command('session.sendAgentMessage', { threadId: this.threadId, nativeAgentId, text });
  }

  async interruptAgent(nativeAgentId: string): Promise<void> {
    await this.client.command('session.interruptAgent', { threadId: this.threadId, nativeAgentId });
  }

  async setModel(model: string | undefined): Promise<void> {
    await this.client.command('session.setModel', { threadId: this.threadId, ...(model ? { model } : {}) });
  }

  async setPermissionMode(mode: HarnessPermissionMode): Promise<void> {
    await this.client.command('session.setPermissionMode', { threadId: this.threadId, mode });
  }

  async getContextUsage(): Promise<HarnessContextUsage | null> {
    const res = await this.client.command('session.getContextUsage', { threadId: this.threadId });
    return (res.usage ?? null) as HarnessContextUsage | null;
  }

  async mcpServerStatus(): Promise<Array<{ name: string; status: string }>> {
    const res = await this.client.command('session.mcpServerStatus', { threadId: this.threadId });
    return (Array.isArray(res.servers) ? res.servers : []) as Array<{ name: string; status: string }>;
  }

  async getUsageSnapshot(includeAccountUsage?: boolean): Promise<UsageSnapshot | null> {
    const res = await this.client.command('session.getUsageSnapshot', {
      threadId: this.threadId,
      ...(includeAccountUsage !== undefined ? { includeAccountUsage } : {}),
    });
    return (res.snapshot ?? null) as UsageSnapshot | null;
  }

  // ── events ───────────────────────────────────────────────────────────────

  private onEvent(frame: EventFrame, reopen: boolean): void {
    if (this.closed) return;
    if (!reopen) this.trackStream(frame);
    this.dispatch(frame, reopen);
    if (!reopen) {
      this.settleSendFlag(frame);
      this.advanceCursor(frame);
    }
  }

  /** Remember where the open assistant message began so the persisted cursor can stay before it. */
  private trackStream(frame: EventFrame): void {
    if (frame.name === 'onToken') {
      this.streamOpenFrom ??= frame.seq - 1;
    } else if (frame.name === 'onMessage' || frame.name === 'onDone' || frame.name === 'onInterrupted' || frame.name === 'onError') {
      this.streamOpenFrom = null;
    }
  }

  private advanceCursor(frame: EventFrame): void {
    const next = this.streamOpenFrom ?? frame.seq;
    if (next > this.remote.lastSeq) this.remote.lastSeq = next;
    this.syncPending();
  }

  /** Clear the optimistic "turn started" flag once the stream shows the turn really started or ended. */
  private settleSendFlag(frame: EventFrame): void {
    if (!this.sendAwaitingState) return;
    if (frame.name === 'session.state' && (frame.args as SessionStateArgs).turnInFlight) this.sendAwaitingState = false;
    else if (frame.name === 'onDone' || frame.name === 'onInterrupted' || frame.name === 'onError') this.sendAwaitingState = false;
  }

  private syncPending(): void {
    if (this.turnInFlight || this.queued.length > 0) this.remote.turnPending = true;
    else delete this.remote.turnPending;
  }

  private dispatch(frame: EventFrame, reopen: boolean): void {
    const cb = this.callbacks;
    if (!cb) return;
    const args = frame.args as unknown;
    try {
      switch (frame.name) {
        case 'session.state':
          this.onState(args as SessionStateArgs);
          return;
        case 'request_resolved':
          this.onRequestResolved(args as { requestId: string; outcome?: string });
          return;
        case OVERRIDES.onPermissionRequest.event:
          this.openPermission(cb, args as { requestId: string; toolName: string; detail: string });
          return;
        case OVERRIDES.onAskUserQuestion.event:
          this.openQuestion(cb, args as { requestId: string; questions: never });
          return;
        case OVERRIDES.onPlanReady.event:
          this.openPlan(cb, args as { requestId: string; planText: string });
          return;
        case OVERRIDES.onElicitation.event:
          this.openElicitation(cb, args as { requestId: string; request: never });
          return;
        case OVERRIDES.onOpenNewTab.event:
          return; // the daemon refuses OpenNewTab before it is ever journaled
        case 'tool.call':
        case 'tool.cancel':
          // Host-tool proxying is PR 7; a daemon that sends one before then gets no answer.
          this.log(`ignoring ${frame.name} (host tools are not proxied yet)`);
          return;
        default: {
          const fn = (cb as unknown as Dict)[frame.name];
          if (typeof fn !== 'function') return;
          const list = (Array.isArray(args) ? args : []) as unknown[];
          const revived = ERROR_ARG_CALLBACKS.has(frame.name) ? list.map(reviveError) : list;
          (fn as (...a: unknown[]) => unknown).apply(cb, revived);
        }
      }
    } catch (err) {
      this.log(`callback ${frame.name}${reopen ? ' (reopen)' : ''} threw: ${errText(err)}`);
    }
  }

  private onState(next: SessionStateArgs): void {
    const wasBusy = this.turnInFlight;
    this.state = next;
    if (next.closed) this.opened = false; // reaped or closed on the daemon: the next send re-opens/cold-resumes
    if (wasBusy && !this.turnInFlight) this.flushQueue();
  }

  private flushQueue(): void {
    const next = this.queued.shift();
    if (next) this.dispatchSend(next);
  }

  /** A turn that cannot continue: let the transcript owner show it. */
  private failTurn(err: Error): void {
    this.sendAwaitingState = false;
    this.queued = [];
    this.state = { ...this.state, turnInFlight: false };
    this.syncPending();
    try { this.callbacks?.onError(err); } catch (e) { this.log(`onError threw: ${errText(e)}`); }
  }

  // ── requests ─────────────────────────────────────────────────────────────

  private respond(
    type: 'resolve.permission' | 'resolve.question' | 'resolve.plan' | 'resolve.elicitation',
    requestId: string,
    payload: Dict,
  ): void {
    // Re-checked when the user finally answers: a request already closed (other client, interrupt,
    // daemon restart) must not be answered again.
    if (!this.requests.has(requestId)) return;
    this.requests.delete(requestId);
    void this.client
      .command(type, { threadId: this.threadId, requestId, ...payload } as never)
      .catch((err: unknown) => this.log(`${type} ${requestId} failed: ${errText(err)}`));
  }

  private openPermission(cb: SessionCallbacks, a: { requestId: string; toolName: string; detail: string }): void {
    if (this.requests.has(a.requestId)) return; // reopen of a prompt that is still showing
    this.requests.set(a.requestId, { kind: 'permission' });
    cb.onPermissionRequest(a.toolName, a.detail).then(
      (allow) => this.respond('resolve.permission', a.requestId, { allow: allow === true }),
      () => this.respond('resolve.permission', a.requestId, { allow: false }),
    );
  }

  private openQuestion(cb: SessionCallbacks, a: { requestId: string; questions: never }): void {
    if (this.requests.has(a.requestId)) return;
    this.requests.set(a.requestId, { kind: 'question' });
    cb.onAskUserQuestion(a.questions).then(
      (answers) => this.respond('resolve.question', a.requestId, { answers }),
      () => { this.requests.delete(a.requestId); },
    );
  }

  private openPlan(cb: SessionCallbacks, a: { requestId: string; planText: string }): void {
    if (this.requests.has(a.requestId) || !cb.onPlanReady) return;
    this.requests.set(a.requestId, { kind: 'plan' });
    cb.onPlanReady(
      a.planText,
      (editedPlan) => this.respond('resolve.plan', a.requestId, { approve: true, ...(editedPlan !== undefined ? { editedPlan } : {}) }),
      () => {
        const open = this.requests.has(a.requestId);
        this.respond('resolve.plan', a.requestId, { approve: false });
        return open;
      },
    );
  }

  private openElicitation(cb: SessionCallbacks, a: { requestId: string; request: never }): void {
    if (this.requests.has(a.requestId) || !cb.onElicitation) return;
    const abort = new AbortController();
    this.requests.set(a.requestId, { kind: 'elicitation', abort });
    cb.onElicitation(a.request, abort.signal).then(
      (result) => this.respond('resolve.elicitation', a.requestId, { result: result as unknown as Dict }),
      () => this.respond('resolve.elicitation', a.requestId, { result: { action: 'cancel' } }),
    );
  }

  /** Another client answered, the turn was interrupted, or the daemon restarted. */
  private onRequestResolved(a: { requestId: string; outcome?: string }): void {
    const req = this.requests.get(a.requestId);
    if (!req) return;
    this.requests.delete(a.requestId);
    if (req.kind === 'question') this.callbacks?.onAskUserQuestionCanceled?.();
    req.abort?.abort();
  }

  // ── resync ───────────────────────────────────────────────────────────────

  /**
   * The daemon's journal no longer reaches our cursor. Full reconciliation is
   * PR 6; this keeps the stream usable: show the text streamed so far, re-offer
   * open requests, and move the cursor to the checkpoint.
   */
  private onResync(frame: ResyncFrame): void {
    if (this.closed) return;
    const cp = frame.checkpoint;
    this.log(`resync to seq ${cp.seq}`);
    this.streamOpenFrom = null;
    if (cp.inFlightText) {
      this.streamOpenFrom = cp.seq - 1;
      try { this.callbacks?.onToken(cp.inFlightText); } catch (err) { this.log(`onToken threw: ${errText(err)}`); }
    }
    for (const entry of cp.openRequests) {
      this.dispatch({ v: 1, ch: frame.ch, seq: entry.seq, ts: entry.ts, type: 'event', ...entry.event } as EventFrame, true);
    }
    if (cp.state) this.dispatch({ v: 1, ch: frame.ch, seq: cp.state.seq, ts: cp.state.ts, type: 'event', ...cp.state.event } as EventFrame, false);
    if (cp.seq > this.remote.lastSeq || cp.seq < this.remote.lastSeq) this.remote.lastSeq = this.streamOpenFrom ?? cp.seq;
    if (this.turnInFlight && !this.state.turnInFlight) {
      // We believed a turn was running but the daemon says it is not, and its history no longer
      // tells us how it ended.
      this.failTurn(new Error('Lost track of the remote turn: the daemon\'s history moved on while this app was away.'));
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function wireImages(images: ImageAttachment[] | undefined): { images?: WireImage[] } {
  const wire = (images ?? [])
    .filter((i): i is ImageAttachment & { base64: string } => typeof i.base64 === 'string' && WIRE_IMAGE_TYPES.has(i.mediaType))
    .map((i) => ({ base64: i.base64, mediaType: i.mediaType, name: i.name }));
  return wire.length > 0 ? { images: wire } : {};
}

function reviveError(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && typeof (value as Dict).message === 'string') {
    const w = value as { name?: unknown; message: string; stack?: unknown };
    const err = new Error(w.message);
    if (typeof w.name === 'string') err.name = w.name;
    if (typeof w.stack === 'string') err.stack = w.stack;
    return err;
  }
  return value;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

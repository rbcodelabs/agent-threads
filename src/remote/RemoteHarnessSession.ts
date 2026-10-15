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
  CALLBACK_DISPOSITION,
  OVERRIDES,
  manifestSignature,
  specsFromManifest,
  type EventFrame,
  type RemoteSessionSpec,
  type ResyncFrame,
  type SessionStateArgs,
  type WireImage,
} from '../protocol';
import type { ImageAttachment, Thread, ThreadRemote } from '../types';
import type { UsageSnapshot } from '../Usage';
import { DaemonCommandError, type ChannelSubscription, type DaemonClient } from './DaemonClient';
import { applyHostToolsPrompt, projectSessionOptions } from './sessionSpec';
import type { HostManifest, RemoteHostTools } from './hostTools';
import { HostToolExecutor, HostToolSlots } from './hostToolExecutor';

type Dict = Record<string, unknown>;

export interface RemoteSessionDeps {
  log?: (message: string) => void;
  /**
   * `thread.remote.turnPending` flipped. The host persists on this so a quit
   * right after a send still re-attaches the turn on the next start.
   */
  onPendingChanged?: (pending: boolean) => void;
  /** Test seam for the generated message uuid. */
  newId?: () => string;
  /**
   * Run `fn` with the host's clock pinned to `ts` (`ThreadManager.runAtTime`). Replayed events are
   * dispatched through it so the transcript keeps their original time. Absent = real time.
   */
  runAtTime?: <T>(ts: number, fn: () => T) => T;
  /** Waits (ms) between attempts when the daemon answers a send with a retryable `conflict` (default 1 s doubling to 30 s). */
  retryDelaysMs?: readonly number[];
  /**
   * The tools of this computer the daemon may call for this thread (vault, workspace, threads, Google, ...).
   * Absent = the thread has the daemon's own tools only.
   */
  hostTools?: RemoteHostTools;
  /** Calls in flight across every remote thread; shared so a busy daemon cannot starve the plugin. */
  hostToolSlots?: HostToolSlots;
  /** A persisted inline row in the transcript (host tools unavailable, dropped servers). */
  onNotice?: (status: 'completed' | 'failed' | 'stopped', text: string) => void;
  /** A worktree tool moved the session's folder on the daemon; mirror it on the thread. */
  onCwdChanged?: (cwd: string, originRepoPath?: string | null) => void;
  /** Name of this computer's host app for user-facing text. */
  hostName?: string;
  /** How long a replayed tool call waits for its closing event before it runs (default 300 ms). */
  replayedCallSettleMs?: number;
}

/** The daemon was momentarily full (retryable `conflict`): try again after these waits, then give up. */
const DEFAULT_SEND_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

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

/**
 * Only names the protocol classifies as plain events may be invoked on the host's callbacks object. The
 * name comes off the wire, so without this a daemon (or a corrupted journal) could make us call any
 * function-valued property: `onRawEvent`, `onStreamReset`, a request callback, or anything else on it.
 */
export function isEventCallbackName(name: unknown): name is keyof SessionCallbacks {
  return typeof name === 'string'
    && Object.prototype.hasOwnProperty.call(CALLBACK_DISPOSITION, name)
    && CALLBACK_DISPOSITION[name as keyof SessionCallbacks] === 'event';
}

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
  /** A send waiting out a retryable `conflict`; cleared by interrupt/close. */
  private sendRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The manifest THIS client sent: the only thing a `tool.call` may name. */
  private sentManifest: HostManifest | null = null;
  private manifestSent = '';
  private executor: HostToolExecutor | null = null;
  /** Replayed (historic) tool calls wait here for a closing event before running, so a finished call never re-runs. */
  private deferredCalls = new Map<string, unknown>();
  private deferredTimer: ReturnType<typeof setTimeout> | null = null;
  private unavailableNoticeShown = false;

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
    // A re-attach after a restart shows the turn as running at once, before anything is awaited.
    if (mode.attachOnly && this.remote.turnPending) this.sendAwaitingState = true;
    if (this.deps.hostTools) await this.prepareHostTools();
    if (this.spec.appendSystemPrompt) {
      this.spec = { ...this.spec, appendSystemPrompt: applyHostToolsPrompt(this.spec.appendSystemPrompt, this.sentManifest && Object.keys(this.sentManifest).length ? this.deps.hostTools?.summary ?? null : null, this.deps.hostName ?? 'Geode') };
    }
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

  // ── host tools ───────────────────────────────────────────────────────────

  /** Build the manifest, attach it to the spec, and set up the gate that every `tool.call` goes through. */
  private async prepareHostTools(): Promise<void> {
    const tools = this.deps.hostTools;
    if (!tools || !this.spec) return;
    try {
      const manifest = await tools.manifest();
      this.sentManifest = manifest;
      const flat = specsFromManifest(manifest);
      if (flat.length > 0) this.spec = { ...this.spec, hostTools: flat };
      const skipped = tools.summary.skipped;
      if (skipped.length > 0) this.log(`host tools not offered: ${skipped.map((x) => `${x.server} (${x.reason})`).join('; ')}`);
    } catch (err) {
      this.log(`could not build the host tool manifest: ${errText(err)}`);
      this.sentManifest = {};
    }
    this.executor = new HostToolExecutor({
      manifest: () => this.sentManifest,
      invoke: (server, tool, input, signal) => tools.invoke(server, tool, input, signal),
      requestPermission: (name, detail) => (this.callbacks ? this.callbacks.onPermissionRequest(name, detail) : Promise.resolve(false)),
      sendResult: async (callId, result) => {
        await this.client.command('tool.result', { threadId: this.threadId, callId, success: result.success, text: result.text, ...(result.content?.length ? { content: result.content } : {}) });
      },
      slots: this.deps.hostToolSlots ?? new HostToolSlots(),
      log: (m) => this.log(m),
    });
    this.manifestSent = this.sentManifest ? manifestSignature(this.sentManifest) : '';
  }

  /** Tell the daemon the current manifest if it changed (on open, on every attach, before each turn). */
  private async syncManifest(force = false): Promise<void> {
    const tools = this.deps.hostTools;
    if (!tools || this.closed || !this.client.daemonInfo?.capabilities.includes('host.tools')) return;
    try {
      const manifest = await tools.manifest();
      const sig = manifestSignature(manifest);
      if (!force && sig === this.manifestSent) return;
      this.sentManifest = manifest;
      await this.client.command('tool.manifest', { threadId: this.threadId, servers: manifest });
      this.manifestSent = sig;
    } catch (err) {
      this.log(`tool.manifest failed: ${errText(err)}`);
    }
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
        // session.open carried the manifest; send it again explicitly so the daemon's copy is current.
        void this.syncManifest(true);
      })
      .finally(() => { this.opening = null; });
    return this.opening;
  }

  private follow(): void {
    if (this.sub || this.closed) return;
    this.sub = this.client.subscribe(
      this.threadId,
      {
        onEvent: (frame, meta) => this.onEvent(frame, meta.reopen, meta.replay),
        onResync: (frame) => this.onResync(frame),
        onRewind: (seq) => this.onRewind(seq),
        onAttached: (info) => {
          this.remote.epoch = info.epoch;
          if (info.controller) void this.syncManifest(true);
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
      this.remote.epoch,
    );
  }

  /**
   * The daemon crashed after we applied events it never flushed; its history resumed at `seq` with the
   * same seqs reused. Lower our persisted cursor to match (it only ever moves forward otherwise) and drop
   * the half-streamed text those lost events produced; the restart notice that follows ends the turn.
   */
  private onRewind(seq: number): void {
    this.log(`daemon history resumed at seq ${seq} (we had applied through ${this.remote.lastSeq})`);
    if (this.remote.lastSeq > seq) this.remote.lastSeq = seq;
    this.streamOpenFrom = null;
    try { this.callbacks?.onStreamReset?.(); } catch (err) { this.log(`onStreamReset threw: ${errText(err)}`); }
  }

  /** Stop and tear down the session on the daemon (history stays attachable there). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.executor?.abortAll();
    this.clearDeferred();
    this.deps.hostTools?.dispose();
    this.sub?.close();
    this.sub = null;
    this.cancelLocalRequests();
    this.cancelSendRetry();
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
    const attached = this.sub !== null;
    this.executor?.abortAll();
    this.clearDeferred();
    this.deps.hostTools?.dispose();
    this.sub?.close();
    this.sub = null;
    this.cancelLocalRequests();
    this.cancelSendRetry();
    // Also when we only re-attached (never opened): that attach claimed the seat and a server-side subscription.
    if (this.opened || attached) {
      void this.client.command('session.detach', { threadId: this.threadId }, { timeoutMs: 3000 }).catch(() => { /* the disconnect releases the seat anyway */ });
    }
  }

  /**
   * The host saved the thread. Ack the cursor the save covered (`savedThrough`), never past the live
   * cursor: an event applied after the save was requested is not on disk yet.
   */
  notifyPersisted(savedThrough?: number): void {
    const live = this.remote.lastSeq;
    this.sub?.ack(savedThrough === undefined ? live : Math.min(savedThrough, live));
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
    void this.syncManifest(); // tools may have changed since the last turn (a broker connected, a setting flipped)
    this.sendAwaitingState = true;
    this.syncPending();
    this.attemptSend(item, 0);
  }

  private attemptSend(item: QueuedSend, attempt: number): void {
    void this.ensureOpen()
      .then(() => this.client.command('session.send', {
        threadId: this.threadId,
        text: item.text,
        userMessageUuid: item.uuid,
        ...wireImages(item.images),
      }))
      .catch((err: unknown) => {
        if (this.closed) return;
        this.log(`session.send failed (attempt ${attempt + 1}): ${errText(err)}`);
        // The daemon is at capacity right now (maxConcurrentTurns): it said so, and said "retryable". Wait and
        // resend the SAME message id (the daemon deduplicates by it), instead of failing the user's turn.
        const delays = this.deps.retryDelaysMs ?? DEFAULT_SEND_RETRY_DELAYS_MS;
        if (err instanceof DaemonCommandError && err.retryable && attempt < delays.length) {
          this.sendRetryTimer = setTimeout(() => {
            this.sendRetryTimer = null;
            if (!this.closed) this.attemptSend(item, attempt + 1);
          }, delays[attempt]);
          return;
        }
        this.failTurn(this.sendFailure(err));
      });
  }

  private cancelSendRetry(): boolean {
    if (!this.sendRetryTimer) return false;
    clearTimeout(this.sendRetryTimer);
    this.sendRetryTimer = null;
    return true;
  }

  /**
   * What to tell the user when a send did not get an ack. "Not delivered" is only true when the command never
   * left this process; once it was written to a socket the daemon may have run it, so say that instead and let
   * the replay (this session stays attached) show what actually happened.
   */
  private sendFailure(err: unknown): Error {
    if (err instanceof DaemonCommandError) {
      if (err.unconfirmed) {
        return new Error('The remote daemon did not confirm your message. It may still have received it and be working on it: anything it produces will appear here when the connection catches up. Check this thread before sending the message again.');
      }
      if (err.code === 'unreachable') {
        return new Error('The remote daemon is unreachable; your message was not delivered. Check the connection and send it again.');
      }
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  async interrupt(): Promise<void> {
    this.queued = [];
    if (this.cancelSendRetry()) {
      // The message was still waiting for a free slot on the daemon; the user changed their mind.
      this.sendAwaitingState = false;
      this.syncPending();
      return;
    }
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

  private onEvent(frame: EventFrame, reopen: boolean, replay: boolean): void {
    if (this.closed) return;
    if (!reopen) {
      this.trackStream(frame);
      // BEFORE the callbacks: a callback may save the thread (the host persists on every message),
      // and that snapshot must carry a cursor that already covers the event it just recorded. With
      // the cursor behind, a quit right after that save replays the event into a transcript that has it.
      this.advanceCursor(frame);
    }
    // Backlog keeps its original time; a live event is stamped with this machine's clock (the
    // daemon's clock may differ, and "now" is accurate for something that just happened).
    this.atEventTime(replay && !reopen ? frame.ts : undefined, () => this.dispatch(frame, reopen, replay));
    if (!reopen) {
      this.settleSendFlag(frame);
      this.syncPending();
    }
  }

  private atEventTime<T>(ts: number | undefined, fn: () => T): T {
    return ts !== undefined && this.deps.runAtTime ? this.deps.runAtTime(ts, fn) : fn();
  }

  /** Remember where the open assistant message began so the persisted cursor can stay before it. */
  private trackStream(frame: EventFrame): void {
    if (frame.name === 'onToken') {
      this.streamOpenFrom ??= frame.seq - 1;
    } else if (frame.name === 'onMessage' || frame.name === 'onDone' || frame.name === 'onInterrupted' || frame.name === 'onError') {
      this.streamOpenFrom = null;
      if (frame.name !== 'onMessage') this.unavailableNoticeShown = false;
    }
  }

  private advanceCursor(frame: EventFrame): void {
    const next = this.streamOpenFrom ?? frame.seq;
    if (next > this.remote.lastSeq) this.remote.lastSeq = next;
  }

  /** Clear the optimistic "turn started" flag once the stream shows the turn really started or ended. */
  private settleSendFlag(frame: EventFrame): void {
    if (!this.sendAwaitingState) return;
    if (frame.name === 'session.state' && (frame.args as SessionStateArgs).turnInFlight) this.sendAwaitingState = false;
    else if (frame.name === 'onDone' || frame.name === 'onInterrupted' || frame.name === 'onError') this.sendAwaitingState = false;
  }

  private syncPending(): void {
    const was = this.remote.turnPending === true;
    const now = this.turnInFlight || this.queued.length > 0;
    if (now) this.remote.turnPending = true;
    else delete this.remote.turnPending;
    if (now !== was) {
      try { this.deps.onPendingChanged?.(now); } catch (err) { this.log(`onPendingChanged threw: ${errText(err)}`); }
    }
  }

  private dispatch(frame: EventFrame, reopen: boolean, replay = false): void {
    const cb = this.callbacks;
    if (!cb) return;
    const args = frame.args as unknown;
    try {
      switch (frame.name) {
        case 'session.state':
          this.onState(args as SessionStateArgs);
          return;
        case 'request_resolved':
          this.deferredCalls.delete((args as { requestId?: string }).requestId ?? '');
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
          this.onToolCall(args, reopen, replay);
          return;
        case 'tool.cancel':
          this.deferredCalls.delete((args as { callId?: string }).callId ?? '');
          this.executor?.handleCancel((args as { callId?: unknown }).callId);
          return;
        case 'tool.unavailable':
          this.onToolUnavailable(args as { server?: string; tool?: string; reason?: string });
          return;
        case 'session.cwd': {
          const a = args as { cwd?: unknown; originRepoPath?: unknown };
          if (typeof a.cwd === 'string' && a.cwd) {
            this.startedCwd = a.cwd;
            this.deps.onCwdChanged?.(a.cwd, typeof a.originRepoPath === 'string' || a.originRepoPath === null ? a.originRepoPath : undefined);
          }
          return;
        }
        default: {
          if (!isEventCallbackName(frame.name)) {
            this.log(`ignoring event "${String(frame.name).slice(0, 60)}": not a session event`);
            return;
          }
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

  /**
   * A `tool.call`. Live and reopened calls run at once. A call replayed from history waits briefly for its closing
   * event (`request_resolved` / `tool.cancel`) so a call that already finished is not run a second time.
   */
  private onToolCall(args: unknown, reopen: boolean, replay: boolean): void {
    if (!this.executor) { this.log('ignoring tool.call: host tools are off for this thread'); return; }
    const id = (args as { callId?: unknown } | null)?.callId;
    if (replay && !reopen && typeof id === 'string') {
      this.deferredCalls.set(id, args);
      if (this.deferredTimer) clearTimeout(this.deferredTimer);
      this.deferredTimer = setTimeout(() => this.flushDeferred(), this.deps.replayedCallSettleMs ?? 300);
      return;
    }
    this.executor.handleCall(args, reopen);
  }

  private flushDeferred(): void {
    this.deferredTimer = null;
    const calls = [...this.deferredCalls.values()];
    this.deferredCalls.clear();
    for (const c of calls) this.executor?.handleCall(c, true);
  }

  private clearDeferred(): void {
    if (this.deferredTimer) clearTimeout(this.deferredTimer);
    this.deferredTimer = null;
    this.deferredCalls.clear();
  }

  /** A host tool call failed because no host could serve it: one inline notice per turn. */
  private onToolUnavailable(a: { server?: string; tool?: string; reason?: string }): void {
    if (this.unavailableNoticeShown) return;
    this.unavailableNoticeShown = true;
    const host = this.deps.hostName ?? 'Geode';
    const what = a.server && a.tool ? `${a.server}/${a.tool}` : 'a host tool';
    const text = a.reason === 'timeout'
      ? `Host tools unavailable: ${what} did not answer in time, so the remote agent carried on without it.`
      : `Host tools unavailable: ${what} needs ${host}, which was not connected, so the remote agent carried on without it. Open ${host} on this computer and ask again.`;
    this.deps.onNotice?.('failed', text);
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
      (allow) => {
        if (allow === true) this.executor?.recordApproval(a.toolName);
        this.respond('resolve.permission', a.requestId, { allow: allow === true });
      },
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
   * The daemon's journal no longer reaches our cursor (or the daemon's history was reset), so it sent
   * its folded state instead of the missing events. Reconcile, never replay:
   *
   *   - the unfinished assistant message's text is DISCARDED (`onStreamReset`) and re-streamed from
   *     the checkpoint's in-flight text, so nothing is shown twice;
   *   - the finalized transcript is KEPT; messages finished while we were away arrive in the
   *     checkpoint's `recentMessages`, and only those past what we already applied are added (each at
   *     its original time), so none is lost or duplicated;
   *   - a request still open on the daemon is re-presented once (dedup by request id); one we are
   *     still showing that the daemon no longer has open is withdrawn;
   *   - a turn we thought was running that is not any more is settled from what was recovered.
   *
   * Limit: the checkpoint carries the last K messages (default 20), so a client away across more than
   * K messages of a still-retained turn history misses the oldest ones. The raw log has them all.
   */
  private onResync(frame: ResyncFrame): void {
    if (this.closed) return;
    const cp = frame.checkpoint;
    // What the transcript already holds (the persisted cursor, conservatively before any unfinished message).
    const applied = this.remote.lastSeq;
    const wasBusy = this.turnInFlight;
    this.log(`resync to seq ${cp.seq} (applied through ${applied})`);
    this.streamOpenFrom = null;
    try { this.callbacks?.onStreamReset?.(); } catch (err) { this.log(`onStreamReset threw: ${errText(err)}`); }

    // A cursor AHEAD of the journal means the daemon's history was reset; its seqs are unrelated to
    // ours, so we cannot tell which messages we already have. Add none rather than risk duplicates.
    let recovered = 0;
    if (cp.seq >= applied) {
      for (const entry of cp.recentMessages) {
        if (entry.seq <= applied) continue;
        this.atEventTime(entry.ts, () => this.dispatch({ v: 1, ch: frame.ch, seq: entry.seq, ts: entry.ts, type: 'event', ...entry.event } as EventFrame, false));
        recovered++;
      }
    }

    if (cp.inFlightText) {
      this.streamOpenFrom = cp.seq - 1;
      try { this.callbacks?.onToken(cp.inFlightText); } catch (err) { this.log(`onToken threw: ${errText(err)}`); }
    }

    const stillOpen = new Set<string>();
    for (const entry of cp.openRequests) {
      const id = (entry.event.args as { requestId?: unknown } | undefined)?.requestId;
      if (typeof id === 'string') stillOpen.add(id);
      this.dispatch({ v: 1, ch: frame.ch, seq: entry.seq, ts: entry.ts, type: 'event', ...entry.event } as EventFrame, true);
    }
    for (const id of [...this.requests.keys()]) {
      if (!stillOpen.has(id)) this.onRequestResolved({ requestId: id });
    }

    if (cp.state) this.dispatch({ v: 1, ch: frame.ch, seq: cp.state.seq, ts: cp.state.ts, type: 'event', ...cp.state.event } as EventFrame, false);
    this.remote.lastSeq = this.streamOpenFrom ?? cp.seq;

    if (wasBusy && !this.state.turnInFlight) {
      // We believed a turn was running; the daemon says it is not, and its history no longer tells us how it ended.
      // Always finish it here (never leave a streaming bubble hanging).
      this.sendAwaitingState = false;
      if (recovered > 0) {
        // It produced output we have just added, so it finished: close it like a normal completion.
        const sessionId = this.remote.nativeSessionId ?? this.thread.sessionId ?? '';
        const at = cp.state?.ts ?? cp.ts;
        try { this.atEventTime(at, () => this.callbacks?.onDone(sessionId, 0, 0, undefined)); } catch (err) { this.log(`onDone threw: ${errText(err)}`); }
        this.syncPending();
        this.flushQueue();
      } else {
        this.failTurn(new Error('Lost track of the remote turn: the daemon\'s history moved on while this app was away.'));
      }
    } else {
      this.syncPending();
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

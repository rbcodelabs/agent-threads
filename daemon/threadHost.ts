/**
 * Owns every thread's journal and (when live) its session driver.
 *
 * Journals outlive sessions: after an idle reap or a daemon restart the history
 * is still attachable from disk. The recipe for bringing the process back (the
 * validated spec and the native session id) is persisted in `sessions/`, so the
 * next `session.send` or `session.open` cold-resumes the native session.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyWireEvent,
  manifestFromSpecs,
  specsFromManifest,
  validateManifestServers,
  wireJournalPolicy,
  type RemoteHostToolSpec,
  type ErrorCode,
  type RemoteSessionSpec,
  type WireEvent,
  type WireImage,
} from '../src/protocol';
import { DiskJournal, type DiskJournalOptions } from './diskJournal';
import { HostToolBroker } from './hostTools';
import { ensureDir, isSafeThreadId } from './fsutil';
import type { DriverFactory, RequestKind, SessionDriver } from './sessionDriver';
import { SessionMetaStore, type SessionMeta } from './sessionMeta';
import { PolicyError, assertCwdAllowed, assertPermissionModeAllowed, specIsReadOnly, validateSpec, type SessionPolicy } from './sessionPolicy';

export type ThreadJournal = DiskJournal<WireEvent>;

export class HostError extends Error {
  constructor(
    readonly code: Extract<ErrorCode, 'not_found' | 'conflict' | 'bad_frame' | 'forbidden' | 'unknown_command' | 'internal'>,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'HostError';
  }
}

export interface ThreadHostOptions {
  dataDir: string;
  epoch: string;
  driverFactory: DriverFactory;
  flushMs?: number;
  journalOptions?: Omit<DiskJournalOptions<WireEvent>, 'epoch' | 'flushMs' | 'isBoundary' | 'isTurnInFlight'>;
  now?: () => number;
  /** Enforced on every open and cold resume when set (the fake harness runs without it). */
  policy?: SessionPolicy;
  /** Workspace rules for working-directory changes made by local tools; set even when `policy` is not (the fake harness). */
  cwdPolicy?: SessionPolicy;
  /** At most this many turns at once; further sends are refused with a retryable `conflict`. */
  maxConcurrentTurns?: number;
  /**
   * At most this many sessions with a live process at once (each is a `claude` child). Opening or cold-resuming
   * beyond it is refused; idle reaping or `session.close` frees a slot. Unset = unbounded.
   */
  maxLiveSessions?: number;
  /** Idle sessions are stopped after this long (ms). 0 or unset disables the reaper. */
  idleReapMs?: number;
  /** Wait this long (ms) for a client to attach before a proxied host-tool call fails (default 60 s). */
  hostToolGraceMs?: number;
  /** Wait this long (ms) for an attached client to answer one host-tool call (default 300 s). */
  hostToolTimeoutMs?: number;
  /** Where `enter_worktree` puts worktrees (a daemon path inside a workspace). */
  worktreeRoot?: string;
  audit?: (record: Record<string, unknown>) => void;
  /** Raw SDK events for the daemon's own JSONL log. */
  rawLog?: (threadId: string, event: Record<string, unknown>) => void;
}

interface Runtime {
  journal: ThreadJournal;
  driver: SessionDriver | null;
  /** Persisted recipe for restarting the process (see sessionMeta.ts). */
  meta: SessionMeta | null;
  /** Bumped whenever the live driver is replaced or stopped; late events from an old one are dropped. */
  gen: number;
  /** `userMessageUuid`s already accepted, newest last, so a client retry of a send cannot run the turn twice. */
  seenSends: string[];
}

const SEEN_SENDS_KEPT = 64;

export interface ThreadListEntry {
  threadId: string;
  lastSeq: number;
  /** A live driver exists (false after an idle reap or a restart). */
  open: boolean;
  turnInFlight: boolean;
  hasPendingPermission: boolean;
  cwd?: string;
  nativeSessionId?: string;
  lastActivityAt?: number;
}

/**
 * Design 3.4 lists done/error/permission_request/idle-state. We also fsync the
 * turn START (state with turnInFlight=true) so that once `session.send` has
 * been acked the turn is known to the journal after a crash, which is what lets
 * recovery close it out as daemon_restarted.
 */
const isBoundary = (e: WireEvent): boolean => {
  const role = classifyWireEvent(e).role;
  return role === 'turn_end' || role === 'request_open' || role === 'request_close'
    || e.name === 'session.state';
};

export class ThreadHost {
  private readonly threads = new Map<string, Runtime>();
  private readonly journalDir: string;
  private readonly metaStore: SessionMetaStore;
  private readonly now: () => number;
  private compactTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Proxies Geode-only tools (design 3.3); one per daemon, state keyed by thread. */
  readonly hostTools: HostToolBroker;
  private get cwdPolicy(): SessionPolicy | undefined { return this.opts.cwdPolicy ?? this.opts.policy; }

  constructor(private readonly opts: ThreadHostOptions) {
    this.hostTools = new HostToolBroker({
      graceMs: opts.hostToolGraceMs ?? 60_000,
      timeoutMs: opts.hostToolTimeoutMs ?? 300_000,
      emit: (threadId, event) => { this.threads.get(threadId)?.journal.append(event, this.now()); },
      audit: opts.audit,
    });
    this.journalDir = join(opts.dataDir, 'journal');
    this.now = opts.now ?? (() => Date.now());
    ensureDir(this.journalDir);
    this.metaStore = new SessionMetaStore(opts.dataDir);
  }

  // ── startup ──────────────────────────────────────────────────────────────

  /**
   * Load every journal and session recipe, and close out turns the previous
   * process left running: a synthetic `error{daemon_restarted}` +
   * `interrupted` + idle state, and `expired` for blocking requests nobody can
   * answer any more. The native session id survives, so the next send resumes.
   * @returns thread ids that needed closing out.
   */
  recover(): string[] {
    const interrupted: string[] = [];
    const ids = new Set([...DiskJournal.listIds(this.journalDir, readdirSync), ...this.metaStore.listIds()]);
    for (const id of ids) {
      if (!isSafeThreadId(id)) continue;
      const rt = this.runtime(id);
      rt.meta = this.metaStore.load(id);
      const cp = rt.journal.checkpoint();
      const state = cp.state?.event.name === 'session.state' ? cp.state.event.args : null;
      const inFlight = state?.turnInFlight === true || cp.inFlightText !== '';
      if (!inFlight && cp.openRequests.length === 0) continue;
      for (const req of cp.openRequests) {
        const requestId = (req.event.args as { requestId?: string; callId?: string }).requestId
          ?? (req.event.args as { callId?: string }).callId;
        if (requestId) rt.journal.append({ name: 'request_resolved', args: { requestId, outcome: 'expired' } }, this.now());
      }
      if (inFlight) {
        rt.journal.append({ name: 'onError', args: [{ name: 'daemon_restarted', message: 'The daemon restarted while this turn was running' }] }, this.now());
        rt.journal.append({ name: 'onInterrupted', args: [rt.meta?.nativeSessionId ?? `restart-${id}`] }, this.now());
        rt.journal.append({
          name: 'session.state',
          args: { turnInFlight: false, hasPendingPermission: false, hostAttached: false, canIdleReap: true, ...(state?.cwd ? { cwd: state.cwd } : {}) },
        }, this.now());
        interrupted.push(id);
      }
      rt.journal.flush(true);
    }
    this.compactAll(); // TTL/size/acked-token bounds hold from the first moment, not only after the next ack
    return interrupted;
  }

  // ── lookup ───────────────────────────────────────────────────────────────

  has(threadId: string): boolean {
    return this.threads.has(threadId);
  }

  journalFor(threadId: string): ThreadJournal | null {
    return this.threads.get(threadId)?.journal ?? null;
  }

  list(): ThreadListEntry[] {
    return [...this.threads.entries()].map(([threadId, rt]) => ({
      threadId,
      lastSeq: rt.journal.lastSeq,
      open: rt.driver !== null,
      turnInFlight: rt.driver?.turnInFlight ?? false,
      hasPendingPermission: rt.driver?.hasPendingPermission ?? false,
      ...(rt.driver?.cwd ?? rt.meta?.spec.cwd ? { cwd: rt.driver?.cwd ?? rt.meta?.spec.cwd } : {}),
      ...(rt.meta?.nativeSessionId ? { nativeSessionId: rt.meta.nativeSessionId } : {}),
      ...(rt.driver ? { lastActivityAt: rt.driver.lastActivityAt } : {}),
    }));
  }

  /** Turns running right now across all sessions (what `maxConcurrentTurns` bounds). */
  turnsInFlight(): number {
    let n = 0;
    for (const rt of this.threads.values()) if (rt.driver?.turnInFlight) n++;
    return n;
  }

  // ── commands ─────────────────────────────────────────────────────────────

  /**
   * Open-or-adopt: idempotent by threadId. With no live session a new driver is
   * started, resuming the native session: the one the daemon remembers, else
   * the client's `resume`, else `spec.resume`. (The daemon's copy is the
   * freshest: it is updated on every event.)
   */
  open(threadId: string, spec: RemoteSessionSpec, resume?: string, owner?: number): { created: boolean; lastSeq: number; nativeSessionId?: string } {
    if (!isSafeThreadId(threadId)) throw new HostError('bad_frame', `invalid threadId "${threadId}"`);
    const rt = this.runtime(threadId);
    if (rt.driver) return { created: false, lastSeq: rt.journal.lastSeq, nativeSessionId: rt.meta?.nativeSessionId };
    const valid = this.validate(spec);
    if (valid.hostTools) this.hostTools.setManifest(threadId, manifestFromSpecs(valid.hostTools), owner);
    const previous = rt.meta;
    const nativeSessionId = previous?.nativeSessionId ?? resume ?? valid.resume;
    rt.meta = { threadId, spec: valid, ...(nativeSessionId ? { nativeSessionId } : {}), updatedAt: this.now() };
    this.metaStore.save(rt.meta);
    try {
      this.startDriver(threadId, rt, valid, nativeSessionId);
    } catch (err) {
      // A recipe for a session that never started would make every later send fail the same way.
      rt.meta = previous;
      if (previous) this.metaStore.save(previous); else this.metaStore.delete(threadId);
      throw err;
    }
    return { created: true, lastSeq: rt.journal.lastSeq, nativeSessionId };
  }

  send(threadId: string, text: string, userMessageUuid: string, images?: WireImage[]): void {
    const rt = this.requireThread(threadId);
    // A client that never saw our ack (timeout, dropped socket) sends the same message again under a new
    // cmdId. The message id is the idempotency key: accept it once, acknowledge repeats without running them.
    if (rt.seenSends.includes(userMessageUuid)) return;
    if (rt.driver?.turnInFlight) throw new HostError('conflict', 'a turn is already in flight');
    const cap = this.opts.maxConcurrentTurns;
    if (cap !== undefined && this.turnsInFlight() >= cap) {
      throw new HostError('conflict', `the daemon is already running ${cap} turns (maxConcurrentTurns); retry shortly`, true);
    }
    if (!rt.driver) this.coldResume(threadId, rt);
    rt.driver!.send(text, userMessageUuid, images);
    rt.seenSends.push(userMessageUuid);
    if (rt.seenSends.length > SEEN_SENDS_KEPT) rt.seenSends.shift();
  }

  async prepareForSend(threadId: string, text: string, images?: WireImage[]): Promise<void> {
    const driver = this.liveDriver(threadId);
    await driver.prepareForSend?.(text, images);
  }

  async interrupt(threadId: string): Promise<void> {
    const rt = this.requireThread(threadId);
    // In-flight host-tool calls end with the turn.
    this.hostTools.cancelThread(threadId);
    // No live session means no turn to stop (reaped, or lost in a restart).
    await rt.driver?.interrupt();
  }

  async sendAgentMessage(threadId: string, nativeAgentId: string, text: string): Promise<void> {
    const d = this.liveDriver(threadId);
    if (!d.sendAgentMessage) throw new HostError('unknown_command', 'this session cannot message child agents');
    await d.sendAgentMessage(nativeAgentId, text);
  }

  async interruptAgent(threadId: string, nativeAgentId: string): Promise<void> {
    const d = this.liveDriver(threadId);
    if (!d.interruptAgent) throw new HostError('unknown_command', 'this session cannot interrupt child agents');
    await d.interruptAgent(nativeAgentId);
  }

  /** With no live session the change is recorded and applies at the next cold resume. */
  async setModel(threadId: string, model: string | undefined): Promise<void> {
    const rt = this.requireThread(threadId);
    if (rt.driver) {
      if (!rt.driver.setModel) throw new HostError('unknown_command', 'this session cannot change model');
      await rt.driver.setModel(model);
    }
    this.updateSpec(rt, { model });
  }

  async setPermissionMode(threadId: string, mode: string): Promise<void> {
    const rt = this.requireThread(threadId);
    this.guard(() => {
      const policy = this.opts.policy;
      if (policy) assertPermissionModeAllowed(mode, policy, { readOnly: !!rt.meta && specIsReadOnly(rt.meta.spec, policy) });
    });
    if (rt.driver) {
      if (!rt.driver.setPermissionMode) throw new HostError('unknown_command', 'this session cannot change permission mode');
      await rt.driver.setPermissionMode(mode);
    }
    this.updateSpec(rt, { permissionMode: mode as RemoteSessionSpec['permissionMode'] });
  }

  async getContextUsage(threadId: string): Promise<unknown> {
    const rt = this.requireThread(threadId);
    return rt.driver?.getContextUsage ? rt.driver.getContextUsage() : null;
  }

  async mcpServerStatus(threadId: string): Promise<Array<{ name: string; status: string }>> {
    const rt = this.requireThread(threadId);
    return rt.driver?.mcpServerStatus ? rt.driver.mcpServerStatus() : [];
  }

  async getUsageSnapshot(threadId: string, includeAccountUsage?: boolean): Promise<unknown> {
    const rt = this.requireThread(threadId);
    return rt.driver?.getUsageSnapshot ? rt.driver.getUsageSnapshot(includeAccountUsage) : null;
  }

  /** The thread's controlling client gained or lost its seat (drives the host-tool grace logic). */
  setSeatHolder(threadId: string, connectionId: number | undefined): void {
    this.hostTools.setSeatHolder(threadId, connectionId);
  }

  /** `tool.manifest`: replace the host tools this thread's client offers (`owner` = the sending connection). */
  setManifest(threadId: string, servers: Record<string, RemoteHostToolSpec[]>, owner?: number): { changed: boolean; tools: number } {
    const rt = this.requireThread(threadId);
    const problem = validateManifestServers(servers);
    if (problem) throw new HostError('bad_frame', `tool.manifest: ${problem}`);
    const changed = this.hostTools.setManifest(threadId, servers, owner);
    if (changed) this.updateSpec(rt, { hostTools: specsFromManifest(servers) });
    return { changed, tools: Object.values(servers).reduce((n, l) => n + l.length, 0) };
  }

  /** `tool.result`: the client's answer to a `tool.call`. Only a call made for THIS thread can be answered. */
  toolResult(threadId: string, callId: string, result: { success: boolean; text: string; content?: unknown[] }, by: string): void {
    this.requireThread(threadId);
    if (!this.hostTools.resolve(threadId, callId, result, by)) {
      throw new HostError('not_found', `no pending host tool call ${callId} for this thread`);
    }
  }

  resolve(
    threadId: string,
    kind: RequestKind,
    requestId: string,
    payload: Record<string, unknown>,
    by: string,
  ): void {
    const rt = this.threads.get(threadId);
    if (!rt?.driver) throw new HostError('not_found', `session ${threadId} is not open`);
    if (!rt.driver.resolve(kind, requestId, payload)) {
      throw new HostError('not_found', `no pending ${kind} request ${requestId}`);
    }
    rt.journal.append({
      name: 'request_resolved',
      // No `alwaysAllow` here: the driver answers a permission once and creates no standing rule, so the
      // journal must not claim one exists.
      args: { requestId, by, outcome: 'resolved' },
    }, this.now());
  }

  /** `session.close`: stop the live session. History stays attachable; the next send cold-resumes. */
  closeSession(threadId: string): void {
    const rt = this.threads.get(threadId);
    if (!rt) throw new HostError('not_found', `unknown thread ${threadId}`);
    if (rt.driver) this.stop(threadId, rt, 'client');
  }

  /**
   * Stop sessions that have been idle (no turn, nothing awaiting a human) for
   * `idleReapMs`. Their journal and native session survive; the next send
   * cold-resumes. @returns the reaped thread ids.
   */
  reapIdle(at: number = this.now()): string[] {
    const idleMs = this.opts.idleReapMs;
    if (!idleMs || idleMs <= 0) return [];
    const reaped: string[] = [];
    for (const [id, rt] of this.threads) {
      const d = rt.driver;
      if (d && d.canIdleReap() && at - d.lastActivityAt >= idleMs) {
        this.stop(id, rt, 'idle');
        reaped.push(id);
      }
    }
    return reaped;
  }

  /** Apply TTL, size caps and acked-token compaction to every journal (also runs on a timer and at startup). */
  compactAll(): void {
    for (const [id, rt] of this.threads) {
      try { rt.journal.compact(); } catch (err) { console.error(`compact ${id}:`, err); }
    }
  }

  /** Retention: the owner acknowledged everything up to `seq`. */
  ack(threadId: string, seq: number): void {
    const rt = this.threads.get(threadId);
    if (!rt) throw new HostError('not_found', `unknown thread ${threadId}`);
    rt.journal.ack(seq);
    if (this.compactTimers.has(threadId)) return;
    // Coalesce: clients ack per event, compaction is O(n) and may rewrite the file.
    const t = setTimeout(() => {
      this.compactTimers.delete(threadId);
      try { rt.journal.compact(); } catch (err) { console.error(`compact ${threadId}:`, err); }
    }, 250);
    t.unref?.();
    this.compactTimers.set(threadId, t);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Graceful stop: close drivers, flush + fsync every journal. */
  shutdown(): void {
    this.hostTools.shutdown();
    for (const t of this.compactTimers.values()) clearTimeout(t);
    this.compactTimers.clear();
    for (const rt of this.threads.values()) {
      rt.driver?.close();
      rt.driver = null;
      rt.gen++;
      rt.journal.close();
    }
  }

  /** Test hook: behave like SIGKILL (unflushed data is lost, nothing is finalized). */
  crash(): void {
    this.hostTools.shutdown();
    for (const t of this.compactTimers.values()) clearTimeout(t);
    this.compactTimers.clear();
    for (const rt of this.threads.values()) {
      rt.gen++;
      rt.driver?.close();
      rt.journal.abandon();
    }
    this.threads.clear();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private requireThread(threadId: string): Runtime {
    const rt = this.threads.get(threadId);
    if (!rt) throw new HostError('not_found', `session ${threadId} is not open; send session.open first`);
    return rt;
  }

  private liveDriver(threadId: string): SessionDriver {
    const d = this.requireThread(threadId).driver;
    if (!d) throw new HostError('not_found', `session ${threadId} is not running (idle or restarted); send a message or session.open to resume it`);
    return d;
  }

  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof PolicyError) throw new HostError(err.code, err.message);
      throw err;
    }
  }

  private validate(spec: RemoteSessionSpec): RemoteSessionSpec {
    return this.opts.policy ? this.guard(() => validateSpec(spec, this.opts.policy!)) : spec;
  }

  private coldResume(threadId: string, rt: Runtime): void {
    if (!rt.meta) throw new HostError('not_found', `session ${threadId} is not open; send session.open first`);
    const spec = this.validate(rt.meta.spec);
    // After a daemon restart the client has not re-sent its manifest yet: the one it opened with stands in.
    if (spec.hostTools && Object.keys(this.hostTools.manifest(threadId)).length === 0) this.hostTools.setManifest(threadId, manifestFromSpecs(spec.hostTools));
    this.startDriver(threadId, rt, spec, rt.meta.nativeSessionId);
  }

  private liveSessions(): number {
    let n = 0;
    for (const rt of this.threads.values()) if (rt.driver) n++;
    return n;
  }

  private startDriver(threadId: string, rt: Runtime, spec: RemoteSessionSpec, resume: string | undefined): void {
    const cap = this.opts.maxLiveSessions;
    if (cap !== undefined && this.liveSessions() >= cap) {
      throw new HostError('conflict', `the daemon already has ${cap} live sessions (maxLiveSessions); close or wait for an idle one to be reaped, then retry`);
    }
    const gen = ++rt.gen;
    let driver: SessionDriver;
    try {
      driver = this.opts.driverFactory({
        threadId,
        spec,
        resume,
        // A closed or replaced driver may still fire late callbacks; they must not reach the journal.
        emit: (e) => { if (rt.gen === gen) rt.journal.append(e, this.now()); },
        onNativeSessionId: (id) => { if (rt.gen === gen) this.rememberNative(rt, id); },
        hostTools: {
          attached: () => this.hostTools.isAttached(threadId),
          manifest: () => this.hostTools.manifest(threadId),
          call: (server, tool, input, signal) => (rt.gen === gen
            ? this.hostTools.call(threadId, server, tool, input, signal)
            : Promise.resolve({ success: false, text: 'This session has ended.' })),
          onChange: (cb) => this.hostTools.onChange(threadId, cb),
        },
        localTools: {
          enabled: !(this.cwdPolicy && specIsReadOnly(spec, this.cwdPolicy)),
          ...(this.opts.worktreeRoot ? { worktreeRoot: this.opts.worktreeRoot } : {}),
          checkCwd: (p) => { if (this.cwdPolicy) assertCwdAllowed(p, this.cwdPolicy); },
        },
        onCwdChanged: (cwd, origin) => { if (rt.gen === gen) this.cwdChanged(rt, cwd, origin); },
        onRawEvent: (e) => { if (rt.gen === gen) this.opts.rawLog?.(threadId, e); },
      });
    } catch (err) {
      rt.gen++;
      throw new HostError('internal', err instanceof Error ? err.message : String(err));
    }
    rt.driver = driver;
  }

  private rememberNative(rt: Runtime, id: string): void {
    if (!rt.meta || rt.meta.nativeSessionId === id) return;
    rt.meta = { ...rt.meta, nativeSessionId: id, updatedAt: this.now() };
    this.metaStore.save(rt.meta);
  }

  /** A worktree tool moved the session: remember it for cold resume, tell clients. */
  private cwdChanged(rt: Runtime, cwd: string, originRepoPath?: string | null): void {
    if (!rt.meta) return;
    // A native session belongs to the directory it started in; resuming it from the new one fails.
    const { nativeSessionId: _gone, ...rest } = rt.meta;
    rt.meta = { ...rest, spec: { ...rt.meta.spec, cwd }, updatedAt: this.now() };
    this.metaStore.save(rt.meta);
    rt.journal.append({ name: 'session.cwd', args: { cwd, ...(originRepoPath !== undefined ? { originRepoPath } : {}) } }, this.now());
  }

  private updateSpec(rt: Runtime, patch: Partial<RemoteSessionSpec>): void {
    if (!rt.meta) return;
    rt.meta = { ...rt.meta, spec: { ...rt.meta.spec, ...patch }, updatedAt: this.now() };
    this.metaStore.save(rt.meta);
  }

  /** Stop the live process, leaving the journal consistent: no dangling turn, no dangling request. */
  private stop(threadId: string, rt: Runtime, reason: 'idle' | 'client'): void {
    const driver = rt.driver;
    if (!driver) return;
    const hadTurn = driver.turnInFlight;
    const cwd = driver.cwd;
    this.hostTools.cancelThread(threadId);
    try { driver.close(); } catch (err) { console.error(`close ${threadId}:`, err); }
    rt.gen++;
    rt.driver = null;
    for (const req of rt.journal.checkpoint().openRequests) {
      const requestId = (req.event.args as { requestId?: string; callId?: string }).requestId
        ?? (req.event.args as { callId?: string }).callId;
      if (requestId) rt.journal.append({ name: 'request_resolved', args: { requestId, outcome: 'canceled' } }, this.now());
    }
    if (hadTurn) rt.journal.append({ name: 'onInterrupted', args: [rt.meta?.nativeSessionId ?? ''] }, this.now());
    rt.journal.append({
      name: 'session.state',
      args: { turnInFlight: false, hasPendingPermission: false, hostAttached: false, canIdleReap: true, closed: reason, ...(cwd ? { cwd } : {}) },
    }, this.now());
  }

  private runtime(threadId: string): Runtime {
    let rt = this.threads.get(threadId);
    if (!rt) {
      const journal = DiskJournal.open<WireEvent>(this.journalDir, threadId, wireJournalPolicy, {
        ...this.opts.journalOptions,
        epoch: this.opts.epoch,
        flushMs: this.opts.flushMs,
        isBoundary,
        isTurnInFlight: (cp) => cp.state?.event.name === 'session.state' && cp.state.event.args.turnInFlight === true,
      });
      rt = { journal, driver: null, meta: null, gen: 0, seenSends: [] };
      this.threads.set(threadId, rt);
    }
    return rt;
  }
}

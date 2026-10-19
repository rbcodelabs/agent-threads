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
 * The control-reply queue (acks, errs) is bounded the same way, so a client that
 * sends commands but never reads cannot grow it without limit.
 *
 * Nothing a client sends may take the process down: every socket handler is
 * wrapped, a reply that cannot be serialized becomes an `internal` error, and
 * an unexpected throw closes only that connection.
 */
import type { IncomingMessage } from 'node:http';
import type { RawData, WebSocket } from 'ws';
import {
  CLOSE_SLOW_CONSUMER,
  CLOSE_UNAUTHORIZED,
  MCP_SYNC_CAPABILITY,
  MCP_SYNC_STDIO_CAPABILITY,
  PROTOCOL_VERSION,
  decodeClientFrame,
  encodeFrame,
  isChannel,
  ProtocolEncodeError,
  threadChannel,
  type AckFrame,
  type Channel,
  type ClientFrame,
  type ErrFrame,
  type ErrorCode,
  type JournalEntry,
  type FileReadReply,
  type PathListReply,
  type WelcomeFrame,
  type WireEvent,
  type WorkspaceInfo,
} from '../src/protocol';
import type { CommandCache } from './cmdCache';
import { CredError, type CredStore } from './credStore';
import { RepoError, type ReposManager } from './repos';
import type { SyncedMcpStore } from './syncedMcp';
import type { PathAccess } from './sessionPolicy';
import type { ControlRegistry } from './controlRegistry';
import type { FailureThrottle } from './failureThrottle';
import { harnessCapabilities, isRealHarness, type RealHarness } from './harnesses';
import { HostError, type ThreadHost, type ThreadJournal } from './threadHost';
import { scopeSatisfies, type TokenScope, type TokenStore, type VerifiedToken } from './tokenStore';
import { DAEMON_VERSION, MIN_CLIENT_VERSION } from './version';

export const MAX_OUTBOUND_BYTES = 4 * 1024 * 1024;
/** Largest frame accepted before `hello` completes (a token is ~50 bytes); raised to `MAX_FRAME_BYTES` once authenticated. */
export const PRE_AUTH_MAX_FRAME_BYTES = 4 * 1024;
/** Largest frame accepted from an authenticated client (images ride in `session.send`). */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * `ws` enforces `maxPayload` per frame inside its receiver, before any of our code runs, which is what
 * makes a pre-auth cap worth having. The server is created with the small cap; an authenticated
 * connection raises its own receiver's limit. `_receiver` is internal to `ws`, so a version that
 * stops exposing it fails the "large authenticated frame" integration test instead of silently
 * limiting every client to the pre-auth size.
 */
export function raiseFrameLimit(ws: WebSocket, bytes: number): boolean {
  const receiver = (ws as unknown as { _receiver?: { _maxPayload?: number } })._receiver;
  if (!receiver || typeof receiver._maxPayload !== 'number') return false;
  receiver._maxPayload = bytes;
  return true;
}
/** Stop handing frames to the socket once this much is already buffered in it. */
const SOCKET_HIGH_WATER = 256 * 1024;
/** What every daemon build speaks; `harness.<kind>` is added from the configured session host. */
export const BASE_CAPABILITIES = ['session.channel', 'journal.resume', 'cmd.idempotency', 'requests.reopen', 'session.cold_resume', 'path.check', 'workspaces.list', 'path.list', 'file.read', 'host.tools', 'creds.push', 'mcp.status', 'repos', MCP_SYNC_CAPABILITY];
/**
 * `harness.<kind>` for each harness a client may request, plus `harness.<kind>.<feature>` for what that harness
 * supports (see `HARNESS_FEATURES`). The scripted fake advertises only `harness.fake`.
 */
export const capabilitiesFor = (harness: string, enabled: readonly RealHarness[] = [], syncedStdio = false): string[] => [
  ...BASE_CAPABILITIES,
  // Tells the app, before it syncs anything, that stdio definitions will not be refused by policy.
  ...(syncedStdio ? [MCP_SYNC_STDIO_CAPABILITY] : []),
  ...(harness === 'fake' ? ['harness.fake'] : harnessCapabilities(enabled.length ? enabled : isRealHarness(harness) ? [harness] : [])),
];

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
  /** Advertised in `welcome`. */
  capabilities: string[];
  controllers: ControlRegistry;
  /** Credentials pushed by admin clients (`creds.push`). */
  creds: CredStore;
  /** The repositories the daemon keeps cloned (`repos.sync`, `repos.status`). */
  repos: ReposManager;
  /** MCP server definitions synced by the app (`mcp.sync`). */
  syncedMcp: SyncedMcpStore;
  /** Names of the servers in the operator's config.json, which override a synced server of the same name. */
  configuredMcpNames(): ReadonlySet<string>;
  /** Answers `path.check` from the configured workspaces (set even when the session host is not policed). */
  checkPath(path: string): PathAccess;
  /** Answers `workspaces.list`: the configured roots, with vault detection. */
  listWorkspaces(): WorkspaceInfo[];
  /** Answers `path.list`: subfolders of an allowed folder. */
  listPath(path: string): PathListReply;
  /** Answers `file.read`: an image inside the workspaces; throws `HostError` when it may not be shown. */
  readFile(path: string): FileReadReply;
  timings: Timings;
  maxOutboundBytes: number;
  audit(record: Record<string, unknown>): void;
}

/** Minimum scope per command. Unlisted commands are admin-only. */
export const REQUIRED_SCOPE: Record<string, TokenScope> = {
  attach: 'read',
  'session.list': 'read',
  'path.check': 'read',
  'workspaces.list': 'read',
  'path.list': 'read',
  'file.read': 'read',
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
  // Changing the list runs git against remotes with the stored token; looking at it only shows names and states.
  'repos.sync': 'admin',
  'repos.status': 'read',
  // Defines programs and endpoints sessions will start, with the credentials pushed beside them.
  'mcp.sync': 'admin',
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
  /** A still-open request re-delivered below the client's cursor. */
  reopen?: true;
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

let nextConnectionId = 0;

export class Connection {
  readonly id = ++nextConnectionId;
  private auth: VerifiedToken | null = null;
  /** The client install behind this connection (`hello.instanceId`), if it sent one. */
  private instanceId: string | undefined;
  private readonly preAuth: VerifiedToken | null;
  private helloSeen = false;
  private dead = false;
  private pumping = false;
  private liveBytes = 0;
  private readonly control: string[] = [];
  private controlBytes = 0;
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
    /** Loopback peer (a local reverse proxy): failures are not counted against the shared address. */
    private readonly throttleExempt = false,
  ) {
    this.preAuth = preAuth;
    // A connection authenticated at the upgrade (Bearer header) never sends a small-frame-only hello.
    if (preAuth) raiseFrameLimit(ws, MAX_FRAME_BYTES);
    ws.on('message', (data) => this.guarded('message', () => this.onMessage(data)));
    ws.on('close', () => this.cleanup());
    ws.on('error', () => this.cleanup());
    ws.on('pong', () => { if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; } });
    this.helloTimer = setTimeout(() => {
      if (!this.helloSeen) this.closeWith(CLOSE_UNAUTHORIZED, 'hello timeout');
    }, ctx.timings.helloTimeoutMs);
    this.pingTimer = setInterval(() => this.heartbeat(), ctx.timings.pingIntervalMs);
  }

  get tokenId(): string | null { return this.auth?.id ?? null; }
  get authenticated(): boolean { return this.auth !== null || this.preAuth !== null; }

  /** The seat identity of this connection: token plus (when sent) the client install. */
  private seat(auth: VerifiedToken): { id: number; tokenId: string; instanceId?: string } {
    return { id: this.id, tokenId: auth.id, ...(this.instanceId !== undefined ? { instanceId: this.instanceId } : {}) };
  }

  /** Cache key for idempotent commands: two installs sharing a token must not see each other's replies. */
  private cacheScope(auth: VerifiedToken): string {
    return this.instanceId !== undefined ? `${auth.id}:${this.instanceId}` : auth.id;
  }

  /** Run a socket/timer handler so a throw drops this connection, never the process. */
  private guarded(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.ctx.audit({ event: 'handler_error', what, tokenId: this.tokenId, error: err instanceof Error ? err.message : String(err) });
      console.error(`[daemon] ${what} handler failed:`, err);
      this.closeWith(1011, 'internal error');
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  private heartbeat(): void {
    this.guarded('heartbeat', () => {
      if (this.dead) return;
      // Revocation is noticed here, so a revoked token can stay connected for up to one ping interval (20 s).
      if (this.auth && !this.ctx.tokens.isActive(this.auth.id)) {
        this.closeWith(CLOSE_UNAUTHORIZED, 'token revoked');
        return;
      }
      if (this.pongTimer) return;
      this.pongTimer = setTimeout(() => this.ws.terminate(), this.ctx.timings.pongTimeoutMs);
      try { this.ws.ping(); } catch { this.ws.terminate(); }
    });
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
    this.control.length = 0;
    this.controlBytes = 0;
    this.dropSubscriptions();
    this.ctx.controllers.releaseAll(this.id);
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
      if (!this.throttleExempt) this.ctx.throttle.recordFailure(this.ip);
      this.ctx.audit({ event: 'auth_failed', ip: this.ip });
      this.queueControl(this.err(frame.cmdId, 'unauthorized', 'invalid token'));
      this.closeWith(CLOSE_UNAUTHORIZED, 'unauthorized');
      return;
    }
    this.ctx.throttle.reset(this.ip);
    this.auth = verified;
    if (typeof frame.instanceId === 'string' && frame.instanceId.length > 0) this.instanceId = frame.instanceId.slice(0, 128);
    raiseFrameLimit(this.ws, MAX_FRAME_BYTES);
    this.ctx.audit({ event: 'connected', tokenId: verified.id, ip: this.ip, client: frame.client });
    const welcome: WelcomeFrame = {
      v: PROTOCOL_VERSION,
      type: 'welcome',
      cmdId: frame.cmdId,
      protocol: PROTOCOL_VERSION,
      daemonVersion: DAEMON_VERSION,
      minClientVersion: MIN_CLIENT_VERSION,
      capabilities: this.ctx.capabilities,
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
      const hit = this.ctx.cmdCache.get(this.cacheScope(auth), frame.cmdId);
      if (hit) { this.queueControl(encodeFrame(hit)); return; }
      // A retry that arrives while the original is still running joins it instead of running twice.
      const running = this.ctx.cmdCache.pending(this.cacheScope(auth), frame.cmdId);
      if (running) { void running.then((reply) => this.guarded('reply', () => this.queueControl(encodeFrame(reply)))); return; }
    }
    let outcome: unknown;
    try {
      outcome = this.dispatch(frame, auth);
    } catch (e) {
      this.reply(frame, auth, cacheable, this.toErr(frame.cmdId, e));
      return;
    }
    if (outcome instanceof Promise) {
      const settled: Promise<AckFrame | ErrFrame> = outcome.then(
        (result): AckFrame => ({ v: PROTOCOL_VERSION, type: 'ack', cmdId: frame.cmdId, result }),
        (e): ErrFrame => this.toErr(frame.cmdId, e),
      );
      if (cacheable) this.ctx.cmdCache.track(this.cacheScope(auth), frame.cmdId, settled);
      void settled.then((reply) => this.guarded('reply', () => this.reply(frame, auth, false, reply)));
      return;
    }
    this.reply(frame, auth, cacheable, { v: PROTOCOL_VERSION, type: 'ack', cmdId: frame.cmdId, result: outcome });
  }

  private reply(frame: ClientFrame, auth: VerifiedToken, cache: boolean, reply: AckFrame | ErrFrame): void {
    let text: string;
    try {
      text = encodeFrame(reply);
    } catch (err) {
      // A result that cannot be serialized (cycle, BigInt) is the command's failure, not the process's.
      if (!(err instanceof ProtocolEncodeError)) throw err;
      reply = { v: PROTOCOL_VERSION, type: 'err', cmdId: frame.cmdId, code: 'internal', message: 'the reply could not be serialized' };
      text = encodeFrame(reply);
    }
    if (cache) this.ctx.cmdCache.set(this.cacheScope(auth), frame.cmdId, reply);
    // The debounced retention ack arrives per event; auditing each would make the log a transcript of traffic.
    if (frame.type !== 'ack') {
      this.ctx.audit({ event: 'command', tokenId: auth.id, type: frame.type, ok: reply.type === 'ack', ...('threadId' in frame ? { threadId: frame.threadId } : {}) });
    }
    this.queueControl(text);
  }

  private toErr(cmdId: string, e: unknown): ErrFrame {
    if (e instanceof CommandError) return { v: PROTOCOL_VERSION, type: 'err', cmdId, code: e.code, message: e.message };
    if (e instanceof HostError) return { v: PROTOCOL_VERSION, type: 'err', cmdId, code: e.code, message: e.message, ...(e.retryable ? { retryable: true } : {}) };
    return { v: PROTOCOL_VERSION, type: 'err', cmdId, code: 'internal', message: e instanceof Error ? e.message : String(e) };
  }

  /** Mutating commands need to be the thread's single read-write client; a free thread is claimed on first use. */
  private requireControl(threadId: string, auth: VerifiedToken): void {
    if (!this.ctx.controllers.claim(threadId, this.seat(auth))) {
      throw new CommandError('conflict', `thread ${threadId} is controlled by another client; detach it there first (or use a read-only attach)`);
    }
  }

  /** Unlike `requireControl`, never claims a free seat: a host-tool answer must come from the thread's actual client. */
  private requireSeat(threadId: string): void {
    if (!this.ctx.controllers.isController(threadId, this.id)) {
      throw new CommandError('forbidden', `this connection does not hold thread ${threadId}'s seat`);
    }
  }

  private async reposSync(repos: unknown, wait: boolean, auth: VerifiedToken): Promise<unknown> {
    let reply;
    try {
      reply = await this.ctx.repos.sync(repos, wait);
    } catch (err) {
      if (err instanceof RepoError) throw new CommandError('bad_frame', err.message);
      throw err;
    }
    this.ctx.audit({ event: 'repos_sync', tokenId: auth.id, repos: reply.repos.map((r) => r.name), replaced: repos !== undefined });
    return { ...reply };
  }

  private dispatch(frame: ClientFrame, auth: VerifiedToken): unknown {
    const { host } = this.ctx;
    switch (frame.type) {
      case 'attach': return this.attach(frame.ch, frame.afterSeq, auth, frame.epoch, frame.observe === true);
      case 'ack': {
        // Only the controlling client's acks bound retention.
        if (frame.ch === 'ctl' || !this.ctx.controllers.isController(frame.ch.slice(2), this.id)) return {};
        host.ack(frame.ch.slice(2), frame.seq);
        return {};
      }
      case 'session.open': {
        this.requireControl(frame.threadId, auth);
        const res = host.open(frame.threadId, frame.spec, frame.resume, this.id);
        return {
          created: res.created,
          adopted: !res.created,
          ch: threadChannel(frame.threadId),
          lastSeq: res.lastSeq,
          epoch: this.ctx.epoch,
          ...(res.nativeSessionId ? { nativeSessionId: res.nativeSessionId } : {}),
        };
      }
      case 'session.send':
        this.requireControl(frame.threadId, auth);
        host.send(frame.threadId, frame.text, frame.userMessageUuid, frame.images);
        return {};
      case 'session.prepareForSend':
        this.requireControl(frame.threadId, auth);
        return host.prepareForSend(frame.threadId, frame.text, frame.images).then(() => ({}));
      case 'session.interrupt':
        this.requireControl(frame.threadId, auth);
        return host.interrupt(frame.threadId).then(() => ({}));
      case 'session.sendAgentMessage':
        this.requireControl(frame.threadId, auth);
        return host.sendAgentMessage(frame.threadId, frame.nativeAgentId, frame.text).then(() => ({}));
      case 'session.interruptAgent':
        this.requireControl(frame.threadId, auth);
        return host.interruptAgent(frame.threadId, frame.nativeAgentId).then(() => ({}));
      case 'session.setModel':
        this.requireControl(frame.threadId, auth);
        return host.setModel(frame.threadId, frame.model).then(() => ({}));
      case 'session.setPermissionMode':
        this.requireControl(frame.threadId, auth);
        return host.setPermissionMode(frame.threadId, frame.mode).then(() => ({}));
      case 'session.getContextUsage': return host.getContextUsage(frame.threadId).then((usage) => ({ usage }));
      case 'session.mcpServerStatus': return host.mcpServerStatus(frame.threadId).then((servers) => ({ servers }));
      case 'session.getUsageSnapshot': return host.getUsageSnapshot(frame.threadId, frame.includeAccountUsage).then((snapshot) => ({ snapshot }));
      case 'session.detach': {
        // The client goes away; the session (and any running turn) keeps going.
        if (!host.has(frame.threadId)) throw new HostError('not_found', `unknown thread ${frame.threadId}`);
        this.subs.get(threadChannel(frame.threadId))?.unsubscribe?.();
        this.subs.delete(threadChannel(frame.threadId));
        this.ctx.controllers.release(frame.threadId, this.id);
        return {};
      }
      case 'session.close':
        this.requireControl(frame.threadId, auth);
        host.closeSession(frame.threadId);
        return {};
      case 'session.list': return { threads: host.list() };
      case 'path.check': return { ...this.ctx.checkPath(frame.path) };
      case 'workspaces.list': return { workspaces: this.ctx.listWorkspaces() };
      case 'path.list': return { ...this.ctx.listPath(frame.path) };
      case 'file.read': return { ...this.ctx.readFile(frame.path) };
      case 'resolve.permission':
        this.requireControl(frame.threadId, auth);
        host.resolve(frame.threadId, 'permission', frame.requestId, { allow: frame.allow }, auth.id);
        // "Always allow" would need a persistent permission rule in the harness, which this daemon does not
        // create. The answer still counts as a one-time allow; say so instead of pretending.
        return frame.alwaysAllow === true ? { alwaysAllow: 'not_supported' } : {};
      case 'resolve.question':
        this.requireControl(frame.threadId, auth);
        host.resolve(frame.threadId, 'question', frame.requestId, { answers: frame.answers }, auth.id);
        return {};
      case 'resolve.plan':
        this.requireControl(frame.threadId, auth);
        host.resolve(frame.threadId, 'plan', frame.requestId, { approve: frame.approve, editedPlan: frame.editedPlan }, auth.id);
        return {};
      case 'resolve.elicitation':
        this.requireControl(frame.threadId, auth);
        host.resolve(frame.threadId, 'elicitation', frame.requestId, { result: frame.result }, auth.id);
        return {};
      case 'tool.manifest':
        this.requireSeat(frame.threadId);
        return host.setManifest(frame.threadId, frame.servers, this.id);
      case 'tool.result':
        // Only the client holding this thread's seat can answer, and only a call made for this thread.
        this.requireSeat(frame.threadId);
        host.toolResult(frame.threadId, frame.callId, { success: frame.success, text: frame.text, content: frame.content }, auth.id);
        return {};
      case 'creds.push': {
        let result;
        try {
          result = this.ctx.creds.push(frame.kind, frame.ttlSec, frame.fields);
        } catch (err) {
          if (err instanceof CredError) throw new CommandError('bad_frame', err.message);
          throw err;
        }
        // Who changed which credential, never the values.
        this.ctx.audit({ event: 'creds_push', tokenId: auth.id, kind: result.kind, fields: result.fields, removed: result.removed });
        return { kind: result.kind, fields: result.fields, removed: result.removed, ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}) };
      }
      case 'repos.sync': return this.reposSync(frame.repos, frame.wait === true, auth);
      case 'repos.status': return { ...this.ctx.repos.status() };
      case 'mcp.sync': {
        const change = this.ctx.syncedMcp.replace(frame.servers, auth.id, this.ctx.configuredMcpNames());
        // Names only: never a definition, a header or a credential.
        this.ctx.audit({ event: 'mcp_sync', tokenId: auth.id, names: change.accepted, added: change.added, removed: change.removed });
        return { accepted: change.accepted, rejected: change.rejected, requiredCreds: change.requiredCreds, shadowed: change.shadowed };
      }
      case 'resolve.openTab':
        // OpenNewTab is refused when the harness asks (daemon sessions cannot create Geode threads), so nothing is ever pending.
        throw new CommandError('unknown_command', 'open-tab requests are not supported by this daemon build');
      default:
        throw new CommandError('unknown_command', `${frame.type} is not supported by this daemon build`);
    }
  }

  // ── attach: replay then live, one ordered queue ──────────────────────────

  private attach(ch: Channel, requestedAfterSeq: number, auth: VerifiedToken, clientEpoch?: string, observe = false): unknown {
    if (!isChannel(ch)) throw new CommandError('bad_frame', 'invalid channel');
    if (ch === 'ctl') return { lastSeq: 0, lowWater: 0, epoch: this.ctx.epoch };
    const journal: ThreadJournal | null = this.ctx.host.journalFor(ch.slice(2));
    if (!journal) throw new CommandError('not_found', `unknown thread ${ch.slice(2)}`);

    // A client that applied events a crashed daemon never flushed holds seqs we have since reused:
    // start from where history really resumed, and tell it (it must lower its own cursor to match).
    const rewind = journal.rewindFor(clientEpoch, requestedAfterSeq);
    const afterSeq = rewind ?? requestedAfterSeq;
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
      // A request opened at or below the cursor that is still unanswered was seen
      // by the client, but a client that lost its socket (or its UI) needs the
      // prompt again. Re-deliver it first, flagged so it is not dropped as a duplicate.
      for (const entry of journal.checkpoint().openRequests) {
        if (entry.seq <= afterSeq) sub.items.push({ entry, live: false, reopen: true });
      }
      for (const entry of replay.entries) sub.items.push({ entry, live: false });
    }
    sub.unsubscribe = journal.subscribe((entry) => this.onLive(sub, entry));
    this.subs.set(ch, sub);
    // A control-scope client takes (or, with the same token, takes back) the read-write seat;
    // anyone else observes. Mutating commands re-check, so this is advisory for the client UI.
    // An `observe` attach never claims it (a terminal watching a thread must not lock Geode out).
    const controller = !observe && scopeSatisfies(auth.scope, 'control')
      && this.ctx.controllers.claim(ch.slice(2), this.seat(auth));
    const result = { lastSeq: replay.lastSeq, lowWater: journal.lowWater, epoch: this.ctx.epoch, resync: replay.kind === 'resync', controller, ...(rewind !== null ? { rewind } : {}) };
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

  private eventText(ch: Channel, entry: JournalEntry<WireEvent>, reopen?: true, replay?: true): string {
    return encodeFrame({ v: PROTOCOL_VERSION, ch, seq: entry.seq, ts: entry.ts, type: 'event', ...(reopen ? { reopen } : {}), ...(replay ? { replay } : {}), ...entry.event });
  }

  // ── outbound ─────────────────────────────────────────────────────────────

  private err(cmdId: string, code: ErrorCode, message: string): string {
    return encodeFrame({ v: PROTOCOL_VERSION, type: 'err', cmdId, code, message });
  }

  private queueControl(text: string): void {
    if (this.dead) return;
    this.control.push(text);
    this.controlBytes += text.length;
    if (this.controlBytes > this.ctx.maxOutboundBytes) {
      // A peer that sends commands and never reads replies; same treatment as a slow event consumer.
      this.ctx.audit({ event: 'slow_consumer', tokenId: this.tokenId, ch: 'control' });
      this.closeWith(CLOSE_SLOW_CONSUMER, 'slow_consumer');
      return;
    }
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
    if (c !== undefined) { this.controlBytes -= c.length; return c; }
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
      const text = item.text ?? this.eventText(sub.ch, item.entry, item.reopen, item.live ? undefined : true);
      // Rotate so the next call starts at a different channel.
      this.subs.delete(sub.ch);
      this.subs.set(sub.ch, sub);
      return text;
    }
    return null;
  }
}

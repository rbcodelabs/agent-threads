/**
 * Real session host: a `SessionDriver` over a live `HarnessSession` (Claude's
 * long-lived `ThreadSession`, built through the existing `HarnessFactory`).
 *
 * The harness is handed a `SessionCallbacks` object generated from
 * `CALLBACK_DISPOSITION`, so the wire event set cannot drift from the
 * callbacks:
 *   - 'event' callbacks append `{ name, args }` to the journal;
 *   - 'request' callbacks (permission, question, plan, elicitation, open-tab)
 *     block the harness on a daemon-owned request id. The request is journaled
 *     (so it is replayed to a client that reattaches) and stays resolvable
 *     until some client answers it, the turn is interrupted, or the session
 *     ends;
 *   - `onRawEvent` goes to the daemon's own JSONL log and is never on the wire.
 */
import { randomUUID } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { SessionCallbacks } from '../src/ClaudeSession';
import { createHarnessSession } from '../src/HarnessFactory';
import type { ClaudeHarnessOptions, HarnessSession, HarnessSessionOptions } from '../src/HarnessSession';
import {
  CALLBACK_DISPOSITION,
  toWireArg,
  type RemoteSessionSpec,
  type WireEvent,
  type WireImage,
} from '../src/protocol';
import type { PluginSettings, Thread } from '../src/types';
import type { CredStore } from './credStore';
import { buildHostServers, type HostServers } from './hostServers';
import { RESERVED_MCP_NAMES, resolveDaemonMcpServers, type DaemonMcpServers, type ResolvedMcpServers } from './mcpServers';
import type { DriverContext, DriverFactory, RequestKind, SessionDriver } from './sessionDriver';

export interface ClaudeDriverDeps {
  /** Build the harness for a spec. Tests inject a scripted one. */
  createHarness(spec: RemoteSessionSpec): HarnessSession;
  /** Extra env for the Claude process (e.g. a token read from `$CREDENTIALS_DIRECTORY`). */
  secretEnv?: Record<string, string>;
  /**
   * A permission/question/plan/elicitation request nobody answers within this many ms is canceled
   * (the harness gets a denial / rejection), so an abandoned prompt cannot hold a turn slot forever.
   * 0 or absent = wait indefinitely.
   */
  requestTimeoutMs?: number;
  /**
   * The daemon's own MCP servers with their `${NAME}` placeholders filled from the credential store. Called when a
   * session starts, so a credential pushed since the last session is picked up.
   */
  daemonMcp?: () => ResolvedMcpServers;
}

// ── spec -> options ────────────────────────────────────────────────────────

/**
 * Project a `RemoteSessionSpec` back onto `HarnessSessionOptions`. VM routing
 * (`claude.vm`) is never set, which is `harnessVmMode: 'never'`: the daemon is
 * already the sandbox. `secretEnv`/`containerAuthToken` are never taken from
 * the client.
 */
export function specToSessionOptions(
  spec: RemoteSessionSpec,
  parts: { resume?: string; callbacks: SessionCallbacks; secretEnv?: Record<string, string>; hostServers?: HostServers['servers']; daemonServers?: DaemonMcpServers; preApprove?: (toolName: string) => boolean },
): HarnessSessionOptions {
  const claude: ClaudeHarnessOptions = {};
  if (parts.preApprove) claude.preApprove = parts.preApprove;
  if (spec.disallowedTools?.length) claude.disallowedTools = spec.disallowedTools;
  const so = spec.sessionOptions;
  if (so) {
    claude.sessionOptions = {
      ...(so.thinking !== undefined ? { thinking: so.thinking as never } : {}),
      ...(so.effort !== undefined ? { effort: so.effort as never } : {}),
      ...(so.agentProgressSummaries !== undefined ? { agentProgressSummaries: so.agentProgressSummaries } : {}),
      ...(so.betas?.length ? { betas: so.betas as never } : {}),
      ...(so.persistSession !== undefined ? { persistSession: so.persistSession } : {}),
      ...(so.agents && Object.keys(so.agents).length ? { agents: so.agents as never } : {}),
    };
  }
  // The daemon's own servers win: a client-supplied http server must not stand in for `claude_threads` (whose
  // tools the client treats as first-party) or for any server it proxies, nor for an operator-configured server
  // (which carries the operator's credentials). `claude_threads` / `obsidian` stay reserved even if neither side
  // currently defines them.
  const own = parts.hostServers ?? {};
  const configured = Object.fromEntries(Object.entries(parts.daemonServers ?? {}).filter(([name]) => !RESERVED_MCP_NAMES.includes(name) && !(name in own)));
  const passthrough = Object.entries(spec.mcpServers ?? {})
    .filter(([name]) => !(name in own) && !(name in configured) && !RESERVED_MCP_NAMES.includes(name));
  if (passthrough.length || Object.keys(own).length || Object.keys(configured).length) {
    claude.mcpServers = {
      ...Object.fromEntries(passthrough.map(([name, s]) => [name, { type: s.type, url: s.url, ...(s.headers ? { headers: s.headers } : {}) }])),
      ...configured,
      ...own,
    } as never;
  }
  return {
    cwd: spec.cwd,
    permissionMode: spec.permissionMode,
    extraEnvRaw: spec.extraEnvRaw ?? '',
    callbacks: parts.callbacks,
    ...(spec.disallowedTools?.length ? { disallowedTools: spec.disallowedTools } : {}),
    ...(parts.resume ? { resume: parts.resume } : {}),
    ...(spec.additionalDirectories?.length ? { additionalDirectories: spec.additionalDirectories } : {}),
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.appendSystemPrompt ? { appendSystemPrompt: spec.appendSystemPrompt } : {}),
    ...(spec.resumeFallbackHistory ? { resumeFallbackHistory: spec.resumeFallbackHistory } : {}),
    ...(parts.secretEnv && Object.keys(parts.secretEnv).length ? { secretEnv: parts.secretEnv } : {}),
    claude,
  };
}

/**
 * Is this `mcp__<server>__<tool>` one of the host tools currently proxied to the user's app? Those are allowed here
 * without a card: the app shows its own (the only prompt that is shown the real input and cannot be forged by this
 * daemon). A daemon-local tool (worktree tools) is not in the manifest and keeps its normal prompt.
 */
export function isProxiedHostTool(toolName: string, manifest: Readonly<Record<string, ReadonlyArray<{ name: string }>>>): boolean {
  for (const [server, tools] of Object.entries(manifest)) {
    const prefix = `mcp__${server}__`;
    if (!toolName.startsWith(prefix)) continue;
    const bare = toolName.slice(prefix.length);
    if (tools.some((t) => t.name === bare)) return true;
  }
  return false;
}

// ── pending requests ───────────────────────────────────────────────────────

interface PendingRequest {
  kind: RequestKind;
  /** Deliver a client's answer to the blocked harness callback. */
  settle(payload: Record<string, unknown>): void;
  /** Unblock the harness without an answer (interrupt, close, abort). */
  cancel(): void;
  /** Expiry timer; cleared when the request ends any other way. */
  timer?: ReturnType<typeof setTimeout>;
}

const WIRE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * The attachments a harness can take. Defensive on every element even though the codec validates the
 * frame: this runs before the turn flag is raised, so a bad element can never leave a turn "in flight".
 */
function toAttachments(images: unknown): Array<{ base64: string; mediaType: WireImage['mediaType']; name: string }> {
  if (!Array.isArray(images)) return [];
  const out: Array<{ base64: string; mediaType: WireImage['mediaType']; name: string }> = [];
  for (const i of images as unknown[]) {
    if (typeof i !== 'object' || i === null) continue;
    const { base64, mediaType, name } = i as Partial<WireImage>;
    if (typeof base64 !== 'string' || typeof mediaType !== 'string' || !WIRE_IMAGE_TYPES.has(mediaType)) continue;
    out.push({ base64, mediaType, name: typeof name === 'string' ? name : 'image' });
  }
  return out;
}

export class ClaudeSessionDriver implements SessionDriver {
  private readonly harness: HarnessSession;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly ready: Promise<void>;
  private closed = false;
  /** A send was accepted but the harness has not been handed it yet. */
  private sendAccepted = false;
  private stateScheduled = false;
  private lastStateKey = '';
  private native: string | undefined;
  private readonly hostServers: HostServers;
  /** A worktree tool moved the cwd: the native session belongs to the old directory and must not be remembered. */
  private cwdMoved = false;
  /** Daemon-configured servers left out of this session (missing credential), reported as failed in the status event. */
  private unresolvedMcp: ResolvedMcpServers['unresolved'] = [];
  private lastMcpStatusKey = '';
  private _lastActivityAt: number;

  constructor(
    private readonly ctx: DriverContext,
    private readonly deps: ClaudeDriverDeps,
    private readonly now: () => number = () => Date.now(),
  ) {
    this._lastActivityAt = this.now();
    this.native = ctx.resume;
    this.harness = deps.createHarness(ctx.spec);
    this.hostServers = buildHostServers({ ...ctx, onCwdChanged: (cwd, origin) => { this.cwdMoved = true; ctx.onCwdChanged?.(cwd, origin); } });
    this.emitState();
    const daemonMcp = deps.daemonMcp?.();
    this.unresolvedMcp = daemonMcp?.unresolved ?? [];
    const options = specToSessionOptions(ctx.spec, {
      resume: ctx.resume,
      callbacks: this.buildCallbacks(),
      secretEnv: deps.secretEnv,
      hostServers: this.hostServers.servers,
      ...(daemonMcp ? { daemonServers: daemonMcp.servers } : {}),
      preApprove: (toolName) => isProxiedHostTool(toolName, ctx.hostTools?.manifest() ?? {}),
    });
    this.ready = this.harness.start(options).catch((err: unknown) => {
      this.emit({ name: 'onError', args: [toWireArg(err instanceof Error ? err : new Error(String(err)))] } as WireEvent);
      this.scheduleState();
    });
  }

  // ── state ────────────────────────────────────────────────────────────────

  get turnInFlight(): boolean { return this.sendAccepted || this.harness.turnInFlight; }
  get hasPendingPermission(): boolean { return this.pending.size > 0 || this.harness.hasPendingPermission; }
  get cwd(): string | undefined { return this.harness.cwd ?? this.ctx.spec.cwd; }
  get lastActivityAt(): number { return this._lastActivityAt; }
  get nativeSessionId(): string | undefined { return this.native; }

  canIdleReap(): boolean {
    return !this.turnInFlight && !this.hasPendingPermission && this.harness.canIdleReap();
  }

  private touch(): void { this._lastActivityAt = this.now(); }

  private emit(event: WireEvent): void {
    try {
      this.ctx.emit(event);
    } catch (err) {
      // A payload that cannot be serialized or journaled must not take the turn down with it.
      console.error(`[daemon] could not journal ${event.name} for ${this.ctx.threadId}:`, err);
    }
  }

  private emitState(): void {
    const args = {
      turnInFlight: this.turnInFlight,
      hasPendingPermission: this.hasPendingPermission,
      hostAttached: this.ctx.hostTools?.attached() ?? false,
      canIdleReap: this.canIdleReap(),
      cwd: this.cwd,
    };
    // `hostAttached` rides along but never triggers an event by itself: a client attaching between turns must not
    // add journal entries after the transcript was saved (the client's ack would then lag its cursor).
    const key = JSON.stringify({ ...args, hostAttached: undefined });
    if (key === this.lastStateKey) return;
    this.lastStateKey = key;
    this.emit({ name: 'session.state', args });
  }

  /**
   * Re-read the harness getters after the current callback has fully run:
   * `ThreadSession` clears `turnInFlight` right AFTER it fires `onDone`.
   */
  private scheduleState(): void {
    if (this.stateScheduled || this.closed) return;
    this.stateScheduled = true;
    setImmediate(() => { this.stateScheduled = false; if (!this.closed) this.emitState(); });
  }

  private setNative(id: unknown): void {
    if (typeof id !== 'string' || !id || id === this.native || this.cwdMoved) return;
    this.native = id;
    this.ctx.onNativeSessionId(id);
  }

  // ── MCP status ───────────────────────────────────────────────────────────

  /** Journal the per-server status once per change; configured servers we could not start show as failed. */
  private emitMcpStatus(reported: Array<{ name: string; status: string; error?: string }>): void {
    const known = new Set(reported.map((s) => s.name));
    const servers = [
      ...reported,
      ...this.unresolvedMcp
        .filter((u) => !known.has(u.name))
        .map((u) => ({ name: u.name, status: 'failed', error: `missing credential ${u.missing.join(', ')}` })),
    ];
    const key = JSON.stringify(servers);
    if (key === this.lastMcpStatusKey) return;
    this.lastMcpStatusKey = key;
    this.emit({ name: 'onMcpServerStatus', args: [servers] } as WireEvent);
  }

  private async refreshMcpStatus(): Promise<void> {
    if (this.closed || !this.harness.mcpServerStatus) return;
    try {
      const live = await this.harness.mcpServerStatus();
      if (!this.closed && live.length) this.emitMcpStatus(live);
    } catch { /* a status poll must never disturb the turn */ }
  }

  // ── callbacks ────────────────────────────────────────────────────────────

  private buildCallbacks(): SessionCallbacks {
    const cb: Record<string, unknown> = {};
    for (const key of Object.keys(CALLBACK_DISPOSITION) as Array<keyof SessionCallbacks>) {
      if (CALLBACK_DISPOSITION[key] !== 'event') continue;
      cb[key] = (...args: unknown[]) => {
        this.touch();
        if ((key === 'onDone' || key === 'onInterrupted') && typeof args[0] === 'string') this.setNative(args[0]);
        if (key === 'onMcpServerStatus') {
          this.emitMcpStatus(args[0] as Array<{ name: string; status: string; error?: string }>);
          return;
        }
        this.emit({ name: key, args: args.map(toWireArg) } as WireEvent);
        // A server can die after the session started (the init report is only the first word): re-read at turn end.
        if (key === 'onDone') void this.refreshMcpStatus();
        if (key === 'onAskUserQuestionCanceled') this.cancelKind('question');
        this.scheduleState();
      };
    }
    cb.onStreamReset = () => { /* client-local: the daemon never resyncs itself */ };
    cb.onRawEvent = (event: Record<string, unknown>) => {
      this.touch();
      // Every SDK event carries the session id; the first turn of a session
      // that is killed before `onDone` is still resumable because of this.
      this.setNative(event.session_id);
      this.ctx.onRawEvent?.(event);
    };
    cb.onPermissionRequest = (toolName: string, detail: string) => new Promise<boolean>((resolve) => {
      this.open('permission', (requestId) => ({ name: 'permission_request', args: { requestId, toolName, detail } }),
        (p) => resolve(p.allow === true),
        () => resolve(false));
    });
    cb.onAskUserQuestion = (questions: unknown) => new Promise<Record<string, string>>((resolve, reject) => {
      this.open('question', (requestId) => ({ name: 'question_request', args: { requestId, questions: questions as never } }),
        (p) => resolve((p.answers ?? {}) as Record<string, string>),
        () => reject(new Error('question canceled')));
    });
    cb.onPlanReady = (planText: string, approve: (editedPlan?: string) => void, reject: () => boolean) => {
      this.open('plan', (requestId) => ({ name: 'plan_ready', args: { requestId, planText } }),
        (p) => { if (p.approve === true) approve(typeof p.editedPlan === 'string' ? p.editedPlan : undefined); else reject(); },
        () => { reject(); });
    };
    cb.onElicitation = (request: Record<string, unknown>, signal: AbortSignal) => new Promise<unknown>((resolve) => {
      const requestId = this.open('elicitation', (id) => ({ name: 'elicitation_request', args: { requestId: id, request } }),
        (p) => resolve(p.result),
        () => resolve({ action: 'cancel' }));
      signal?.addEventListener('abort', () => this.cancelRequest(requestId), { once: true });
    });
    cb.onOpenNewTab = () => Promise.reject(new Error('OpenNewTab is not supported on daemon-hosted sessions'));
    return cb as unknown as SessionCallbacks;
  }

  /** Register a blocking request, journal it, return its daemon-owned id. */
  private open(
    kind: RequestKind,
    makeEvent: (requestId: string) => WireEvent,
    settle: PendingRequest['settle'],
    cancel: PendingRequest['cancel'],
  ): string {
    const requestId = randomUUID();
    this.touch();
    // Registered before it is journaled: a client can answer the moment it sees it.
    const req: PendingRequest = { kind, settle, cancel };
    const ttl = this.deps.requestTimeoutMs;
    if (ttl && ttl > 0) {
      req.timer = setTimeout(() => this.cancelRequest(requestId, 'expired'), ttl);
      req.timer.unref?.();
    }
    this.pending.set(requestId, req);
    this.emit(makeEvent(requestId));
    this.emitState();
    return requestId;
  }

  private cancelRequest(requestId: string, outcome: 'canceled' | 'expired' = 'canceled'): void {
    const req = this.pending.get(requestId);
    if (!req) return;
    this.pending.delete(requestId);
    if (req.timer) clearTimeout(req.timer);
    try { req.cancel(); } catch { /* the harness callback is already gone */ }
    this.emit({ name: 'request_resolved', args: { requestId, outcome } });
    this.scheduleState();
  }

  private cancelKind(kind: RequestKind): void {
    for (const [id, req] of [...this.pending]) if (req.kind === kind) this.cancelRequest(id);
  }

  private cancelAllRequests(): void {
    for (const id of [...this.pending.keys()]) this.cancelRequest(id);
  }

  // ── commands ─────────────────────────────────────────────────────────────

  send(text: string, userMessageUuid: string, images?: WireImage[]): void {
    if (this.closed) throw new Error('session is closed');
    // Validate first: the flag below keeps `turnInFlight` true until the harness has been handed the send,
    // so anything that throws after it is raised and before the handoff would wedge the session.
    const attachments = toAttachments(images);
    this.touch();
    this.sendAccepted = true;
    this.emitState();
    void this.ready.then(() => {
      if (this.closed) return;
      try {
        this.harness.send(text, attachments.length ? attachments : undefined, userMessageUuid);
      } catch (err) {
        this.emit({ name: 'onError', args: [toWireArg(err instanceof Error ? err : new Error(String(err)))] } as WireEvent);
      } finally {
        this.sendAccepted = false;
        this.scheduleState();
      }
    });
  }

  async prepareForSend(text: string, images?: WireImage[]): Promise<void> {
    await this.ready;
    const attachments = toAttachments(images);
    await this.harness.prepareForSend?.(text, attachments.length ? attachments : undefined);
  }

  async interrupt(): Promise<void> {
    this.touch();
    // The harness is waiting on these; release them first so the interrupt can land.
    this.cancelAllRequests();
    await this.ready;
    // ThreadSession latches "interrupted" until its pump ends, so interrupting an idle
    // session would make the NEXT turn's result report as interrupted.
    if (this.turnInFlight) await this.harness.interrupt();
    this.scheduleState();
  }

  resolve(kind: RequestKind, requestId: string, payload: Record<string, unknown>): boolean {
    const req = this.pending.get(requestId);
    if (!req || req.kind !== kind) return false;
    this.pending.delete(requestId);
    if (req.timer) clearTimeout(req.timer);
    this.touch();
    req.settle(payload);
    this.scheduleState();
    return true;
  }

  async sendAgentMessage(nativeAgentId: string, text: string): Promise<void> {
    if (!this.harness.sendAgentMessage) throw new Error('this harness cannot message child agents');
    await this.ready;
    await this.harness.sendAgentMessage(nativeAgentId, text);
  }

  async interruptAgent(nativeAgentId: string): Promise<void> {
    if (!this.harness.interruptAgent) throw new Error('this harness cannot interrupt child agents');
    await this.ready;
    await this.harness.interruptAgent(nativeAgentId);
  }

  async setModel(model: string | undefined): Promise<void> {
    await this.ready;
    await this.harness.setModel(model);
    this.touch();
  }

  async setPermissionMode(mode: string): Promise<void> {
    await this.ready;
    await this.harness.setPermissionMode(mode as never);
    this.touch();
  }

  async getContextUsage(): Promise<unknown> {
    await this.ready;
    return this.harness.getContextUsage();
  }

  async mcpServerStatus(): Promise<Array<{ name: string; status: string }>> {
    await this.ready;
    return this.harness.mcpServerStatus ? this.harness.mcpServerStatus() : [];
  }

  async getUsageSnapshot(includeAccountUsage?: boolean): Promise<unknown> {
    await this.ready;
    return this.harness.getUsageSnapshot(includeAccountUsage);
  }

  close(): void {
    if (this.closed) return;
    this.cancelAllRequests();
    this.hostServers.dispose();
    this.closed = true;
    try { this.harness.close(); } catch (err) { console.error(`[daemon] harness close failed for ${this.ctx.threadId}:`, err); }
  }
}

// ── factory + environment discovery ────────────────────────────────────────

/** Where an operator's `claude` usually lives, after PATH. */
function candidateBinaries(env: NodeJS.ProcessEnv, home: string): string[] {
  const onPath = (env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, 'claude'));
  return [
    ...onPath,
    join(home, '.npm-global/bin/claude'),
    join(home, '.local/bin/claude'),
    join(home, '.claude/local/claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
}

export function findClaudeBinary(explicit?: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  const executable = (p: string): boolean => {
    try { accessSync(p, constants.X_OK); return true; } catch { return false; }
  };
  if (explicit) return executable(explicit) ? explicit : null;
  return candidateBinaries(env, home).find(executable) ?? null;
}

/**
 * Credential for the Claude process. The daemon reuses the logged-in
 * `~/.claude` of its own HOME by default, so nothing is needed. A token in the
 * environment (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) reaches the
 * process through `process.env` already; this only adds the systemd
 * `LoadCredential=` form (`$CREDENTIALS_DIRECTORY/claude-token`).
 */
export function resolveCredentialEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY) return {};
  const dir = env.CREDENTIALS_DIRECTORY;
  if (!dir) return {};
  try {
    const token = readFileSync(join(dir, 'claude-token'), 'utf8').trim();
    return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
  } catch {
    return {};
  }
}

/** Which credential the Claude process will use, for the startup log (never the value). */
export function describeCredentialSource(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return 'CLAUDE_CODE_OAUTH_TOKEN (environment)';
  if (env.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY (environment)';
  if (env.CREDENTIALS_DIRECTORY) {
    try { accessSync(join(env.CREDENTIALS_DIRECTORY, 'claude-token'), constants.R_OK); return 'claude-token (CREDENTIALS_DIRECTORY)'; } catch { /* fall through */ }
  }
  const claudeHome = env.CLAUDE_CONFIG_DIR || join(env.HOME || home, '.claude');
  for (const f of ['.credentials.json', '../.claude.json']) {
    try { accessSync(join(claudeHome, f), constants.R_OK); return `existing Claude login (${claudeHome})`; } catch { /* next */ }
  }
  return 'none found: run `claude` once as the daemon user, or set CLAUDE_CODE_OAUTH_TOKEN';
}

export interface ClaudeDriverFactoryOptions {
  /** Test seam; the default builds a real `ThreadSession` through `HarnessFactory`. */
  createHarness?: (spec: RemoteSessionSpec) => HarnessSession;
  claudeBinaryPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** See `ClaudeDriverDeps.requestTimeoutMs`. */
  requestTimeoutMs?: number;
  /** Operator-configured servers (`config.mcpServers`) and the store their `${NAME}` placeholders resolve from. */
  mcpServers?: DaemonMcpServers;
  creds?: CredStore;
}

export function createClaudeDriverFactory(opts: ClaudeDriverFactoryOptions = {}): DriverFactory {
  const env = opts.env ?? process.env;
  const secretEnv = resolveCredentialEnv(env);
  const createHarness = opts.createHarness ?? ((): ((spec: RemoteSessionSpec) => HarnessSession) => {
    return () => {
      const binary = findClaudeBinary(opts.claudeBinaryPath, env);
      if (!binary) {
        throw new Error('claude CLI not found: install Claude Code for the daemon user or set claudeBinaryPath / AGENT_THREADS_CLAUDE_BINARY');
      }
      // Same construction point ThreadManager uses; only the fields it reads are populated.
      return createHarnessSession({ agentHarness: 'claude' } as Thread, { claudeBinaryPath: binary } as PluginSettings);
    };
  })();
  const configured = opts.mcpServers ?? {};
  const daemonMcp = Object.keys(configured).length
    ? () => resolveDaemonMcpServers(configured, (name) => opts.creds?.lookup(name))
    : undefined;
  return (ctx) => new ClaudeSessionDriver(ctx, { createHarness, secretEnv, requestTimeoutMs: opts.requestTimeoutMs, ...(daemonMcp ? { daemonMcp } : {}) }, opts.now);
}

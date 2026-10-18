/**
 * Real session host: a `SessionDriver` over a live `HarnessSession` (Claude's
 * long-lived `ThreadSession`, Codex's app-server session or an OpenCode server session, built through the
 * existing `HarnessFactory` per `spec.harness`). The file keeps its historical name; nothing in it is Claude-only
 * except the `claude` option block and the Claude credential.
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
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionCallbacks } from '../src/ClaudeSession';
import { createHarnessSession } from '../src/HarnessFactory';
import { OPENCODE_HOST_TOOLS_SERVER } from '../src/OpenCodeHostTools';
import {
  resolveCodexPermissions,
  type ClaudeHarnessOptions,
  type CodexHarnessOptions,
  type HarnessDynamicTool,
  type HarnessMcpServerConfig,
  type HarnessSession,
  type HarnessSessionOptions,
} from '../src/HarnessSession';
import {
  CALLBACK_DISPOSITION,
  toWireArg,
  type RemoteSessionSpec,
  type WireEvent,
  type WireImage,
} from '../src/protocol';
import type { PluginSettings, Thread } from '../src/types';
import type { CredStore } from './credStore';
import { buildHostDynamicTools } from './hostDynamicTools';
import { findHarnessBinary, isRealHarness, missingBinaryMessage, readClaudeCredentialFile, type RealHarness } from './harnesses';
import { CLAUDE_THREADS_SERVER, buildHostServers, type HostServers } from './hostServers';
import { RESERVED_MCP_NAMES, resolveDaemonMcpServers, type DaemonMcpServers, type ResolvedMcpServers } from './mcpServers';
import { isReadOnlyDenylist } from './sessionPolicy';
import type { DriverContext, DriverFactory, RequestKind, SessionDriver } from './sessionDriver';

export interface ClaudeDriverDeps {
  /** Build the harness for a spec. Tests inject a scripted one. */
  createHarness(spec: RemoteSessionSpec): HarnessSession;
  /** Extra env for the Claude process only (e.g. a token read from `$CREDENTIALS_DIRECTORY`); other harnesses never get it. */
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
  /** Environment for the agent's own process only (a repository token for `gh` and `git push`); read when a session starts. */
  sessionEnv?: () => Record<string, string>;
  /** A session is starting in this folder (lets the daemon refresh a stale clone in the background). */
  onSessionStart?: (cwd: string) => void;
}

// ── spec -> options ────────────────────────────────────────────────────────

/** Codex efforts a client may ask for through `spec.sessionOptions.effort`; anything else is left to the model default. */
const CODEX_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export interface SessionOptionParts {
  resume?: string;
  callbacks: SessionCallbacks;
  secretEnv?: Record<string, string>;
  /** Claude only: the daemon's in-process MCP servers (`claude_threads` and the proxy servers). */
  hostServers?: HostServers['servers'];
  /** Codex and OpenCode: the same tools as plain definitions. */
  dynamicTools?: HarnessDynamicTool[];
  /** Server names the host tools use, for the reserved-name rule when `hostServers` is not set (Codex, OpenCode). */
  hostServerNames?: string[];
  daemonServers?: DaemonMcpServers;
  preApprove?: (toolName: string) => boolean;
}

/**
 * Project a `RemoteSessionSpec` back onto `HarnessSessionOptions`. VM routing
 * (`claude.vm`) is never set, which is `harnessVmMode: 'never'`: the daemon is
 * already the sandbox. `secretEnv`/`containerAuthToken` are never taken from
 * the client. Only the option block of `spec.harness` is filled:
 *   claude    sessionOptions (thinking, effort, agents, betas, ...), the SDK MCP servers, `preApprove`
 *   codex     approval policy + sandbox from the permission mode (a read-only workspace pins the sandbox to
 *             read-only for the life of the session), `sessionOptions.effort`, dynamic tools, external MCP servers
 *   opencode  dynamic tools (served through its loopback bridge), external MCP servers
 * Claude-specific `sessionOptions` (thinking, betas, agents, ...) have no equivalent elsewhere and are dropped.
 */
export function specToSessionOptions(spec: RemoteSessionSpec, parts: SessionOptionParts): HarnessSessionOptions {
  // The daemon's own servers win: a client-supplied http server must not stand in for `claude_threads` (whose
  // tools the client treats as first-party) or for any server it proxies, nor for an operator-configured server
  // (which carries the operator's credentials). `claude_threads` / `obsidian` stay reserved even if neither side
  // currently defines them. The rule is the same for every harness.
  const ownNames = new Set([...Object.keys(parts.hostServers ?? {}), ...(parts.hostServerNames ?? [])]);
  const configured = Object.fromEntries(Object.entries(parts.daemonServers ?? {}).filter(([name]) => !RESERVED_MCP_NAMES.includes(name) && !ownNames.has(name)));
  const passthrough = Object.entries(spec.mcpServers ?? {})
    .filter(([name]) => !ownNames.has(name) && !(name in configured) && !RESERVED_MCP_NAMES.includes(name));
  const external = (): Record<string, HarnessMcpServerConfig> => ({
    ...Object.fromEntries(passthrough.map(([name, s]) => [name, { type: s.type, url: s.url, ...(s.headers ? { headers: s.headers } : {}) } as HarnessMcpServerConfig])),
    ...configured,
  });

  const base: HarnessSessionOptions = {
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
  };

  if (spec.harness === 'codex') {
    const codex: CodexHarnessOptions = {
      ...resolveCodexPermissions(spec.permissionMode),
      ...(isReadOnlyDenylist(spec.disallowedTools) ? { sandbox: 'read-only' as const, enforceReadOnly: true } : {}),
    };
    const effort = spec.sessionOptions?.effort;
    if (effort && CODEX_EFFORTS.has(effort)) codex.effort = effort as NonNullable<CodexHarnessOptions['effort']>;
    if (parts.dynamicTools?.length) codex.dynamicTools = parts.dynamicTools;
    const mcp = external();
    if (Object.keys(mcp).length) codex.mcpServers = mcp;
    return { ...base, codex };
  }

  if (spec.harness === 'opencode') {
    const opencode: NonNullable<HarnessSessionOptions['opencode']> = {};
    if (parts.dynamicTools?.length) opencode.dynamicTools = parts.dynamicTools;
    const mcp = external();
    if (Object.keys(mcp).length) opencode.mcpServers = mcp;
    return { ...base, opencode };
  }

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
  const own = parts.hostServers ?? {};
  if (passthrough.length || Object.keys(own).length || Object.keys(configured).length) {
    claude.mcpServers = { ...external(), ...own } as never;
  }
  return { ...base, claude };
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

/** The MCP server names the daemon's own tools occupy in this session (what a client's server must not take over). */
function hostServerNames(ctx: DriverContext, hasLocalOrProxied: boolean): string[] {
  const names = new Set(Object.keys(ctx.hostTools?.manifest() ?? {}));
  if (hasLocalOrProxied && ctx.localTools?.enabled !== false) names.add(CLAUDE_THREADS_SERVER);
  // OpenCode's loopback bridge for these tools is registered under this name; a client server must not take it.
  if (ctx.spec.harness === 'opencode') names.add(OPENCODE_HOST_TOOLS_SERVER);
  return [...names];
}

export class HarnessSessionDriver implements SessionDriver {
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
    const hostCtx = { ...ctx, onCwdChanged: (cwd: string, origin?: string | null) => { this.cwdMoved = true; ctx.onCwdChanged?.(cwd, origin); } };
    const harnessKind = ctx.spec.harness;
    // Claude gets the host tools as in-process MCP servers (which follow the live manifest); Codex and OpenCode
    // take plain tool definitions, fixed when the session starts.
    this.hostServers = harnessKind === 'claude' ? buildHostServers(hostCtx) : { servers: {}, dispose: () => {} };
    const dynamicTools = harnessKind === 'claude' ? [] : buildHostDynamicTools(hostCtx);
    this.emitState();
    const daemonMcp = deps.daemonMcp?.();
    this.unresolvedMcp = daemonMcp?.unresolved ?? [];
    const options = specToSessionOptions(ctx.spec, {
      resume: ctx.resume,
      callbacks: this.buildCallbacks(),
      secretEnv: { ...(harnessKind === 'claude' ? deps.secretEnv : {}), ...(deps.sessionEnv?.() ?? {}) },
      hostServers: this.hostServers.servers,
      ...(harnessKind === 'claude' ? {} : { dynamicTools, hostServerNames: hostServerNames(ctx, dynamicTools.length > 0) }),
      ...(daemonMcp ? { daemonServers: daemonMcp.servers } : {}),
      preApprove: (toolName) => isProxiedHostTool(toolName, ctx.hostTools?.manifest() ?? {}),
    });
    try { deps.onSessionStart?.(ctx.spec.cwd); } catch { /* a refresh must never stop a session from starting */ }
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

/** Kept for existing callers (doctor, tests); the discovery rules live in `harnesses.ts`. */
export function findClaudeBinary(explicit?: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  return findHarnessBinary('claude', explicit, env, home);
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
  const token = readClaudeCredentialFile(env.CREDENTIALS_DIRECTORY);
  return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
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
  /** Test seam; the default builds a real session for `spec.harness` through `HarnessFactory`. */
  createHarness?: (spec: RemoteSessionSpec) => HarnessSession;
  claudeBinaryPath?: string;
  codexBinaryPath?: string;
  opencodeBinaryPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** See `ClaudeDriverDeps.requestTimeoutMs`. */
  requestTimeoutMs?: number;
  /** Operator-configured servers (`config.mcpServers`) and the store their `${NAME}` placeholders resolve from. */
  mcpServers?: DaemonMcpServers;
  creds?: CredStore;
  /** See `ClaudeDriverDeps.sessionEnv` / `onSessionStart`. */
  sessionEnv?: () => Record<string, string>;
  onSessionStart?: (cwd: string) => void;
}

/**
 * Build the real harness for a spec: find that harness's CLI (explicit path, then PATH and the usual install dirs)
 * and construct its session through `HarnessFactory`. A missing CLI throws a clear error, which `session.open`
 * reports to the client; it never takes the daemon down.
 */
export function createRealHarness(
  spec: RemoteSessionSpec,
  binaries: Partial<Record<RealHarness, string>>,
  env: NodeJS.ProcessEnv = process.env,
): HarnessSession {
  const kind = spec.harness;
  if (!isRealHarness(kind)) throw new Error(`harness "${String(kind)}" cannot be started by this daemon`);
  const binary = findHarnessBinary(kind, binaries[kind], env);
  if (!binary) throw new Error(missingBinaryMessage(kind));
  // Same construction point ThreadManager uses; only the fields it reads are populated.
  const settings = { claudeBinaryPath: '', codexBinaryPath: '', opencodeBinaryPath: '', [`${kind}BinaryPath`]: binary } as unknown as PluginSettings;
  return createHarnessSession({ agentHarness: kind } as Thread, settings);
}

export function createClaudeDriverFactory(opts: ClaudeDriverFactoryOptions = {}): DriverFactory {
  const env = opts.env ?? process.env;
  const secretEnv = resolveCredentialEnv(env);
  const binaries = { claude: opts.claudeBinaryPath, codex: opts.codexBinaryPath, opencode: opts.opencodeBinaryPath };
  const createHarness = opts.createHarness ?? ((spec: RemoteSessionSpec) => createRealHarness(spec, binaries, env));
  const configured = opts.mcpServers ?? {};
  const daemonMcp = Object.keys(configured).length
    ? () => resolveDaemonMcpServers(configured, (name) => opts.creds?.lookup(name))
    : undefined;
  return (ctx) => new HarnessSessionDriver(ctx, { createHarness, secretEnv, requestTimeoutMs: opts.requestTimeoutMs, ...(daemonMcp ? { daemonMcp } : {}), ...(opts.sessionEnv ? { sessionEnv: opts.sessionEnv } : {}), ...(opts.onSessionStart ? { onSessionStart: opts.onSessionStart } : {}) }, opts.now);
}

/** Neutral names for the generalized driver; the Claude-named exports stay for existing callers. */
export { HarnessSessionDriver as ClaudeSessionDriver, createClaudeDriverFactory as createDriverFactory };

/**
 * managedPolicy.ts - Agent Threads' side of Geode's managed `threadExecution` policy.
 *
 * An administrator can deploy a machine-level policy file (and a narrowing-only vault file). Geode validates and
 * layers them and hands the result to plugins through `window.geode.getEffectivePolicy()`. This module is the only
 * place Agent Threads interprets it. It is dependency-free apart from `types.ts` (no Obsidian, no Node, no DOM) so it
 * can sit in the daemon-core closure and every rule below is unit-testable.
 *
 * ## Rules
 *
 *   - FAIL OPEN. No bridge (Obsidian, old Geode, mobile), a bridge that throws, or a reply that is not the expected
 *     shape means "no policy", i.e. no restriction. Most installs have no policy file (ADR 0002).
 *   - A thread may start only if ALL hold: the target is enabled, its harness is in the global list, and its harness is
 *     in the target's own list. Every list is an allowlist, so the result is an intersection. An absent list or flag is
 *     no restriction; an EMPTY list, or one holding only the `!none` sentinel, allows nothing.
 *   - Policy is evaluated FRESH at the moment of use. Settings in `data.json` are user-writable and are never trusted
 *     to decide policy; the only thing cached here is a last-seen snapshot for advisory UI.
 *   - Policy is a runtime gate, never a mutation: nothing here deletes threads, daemons, containers or settings.
 */
import { AGENT_HARNESSES, agentHarnessLabel, type AgentHarness } from './types';

/** The sentinel Geode's policy layer uses for "this list matches nothing". */
export const POLICY_NO_MATCH = '!none';

/** Where a thread runs, as far as policy is concerned. */
export type PolicyTargetKind = 'machine' | 'localDaemon' | 'remoteDaemon';

export interface PolicyTarget {
  kind: PolicyTargetKind;
  /** For `remoteDaemon`: the daemon URL as configured, checked against `remoteDaemon.hosts`. */
  url?: string;
}

/**
 * The slice of Geode's `EffectivePolicy.threadExecution` this plugin reads. Deliberately looser than Geode's own type
 * (every field optional): the shape is defined locally and never imported from the host.
 */
export interface ThreadExecutionPolicy {
  harnesses?: string[];
  machine?: { enabled?: boolean; harnesses?: string[] };
  localDaemon?: { enabled?: boolean; harnesses?: string[] };
  remoteDaemon?: { enabled?: boolean; harnesses?: string[]; hosts?: string[] };
  hostExec?: { enabled?: boolean; allowAlways?: boolean };
  mobileRemoteAccess?: boolean;
}

export type PolicyDenyCode =
  | 'all-disabled'
  | 'target-disabled'
  | 'harness-not-allowed'
  | 'host-not-allowed'
  | 'remote-hosts-none';

export type PolicyDecision = { allowed: true } | { allowed: false; code: PolicyDenyCode; message: string };

const ALLOWED: PolicyDecision = Object.freeze({ allowed: true });

/** Shown wherever the effective set of (target, harness) is empty. */
export const ALL_DISABLED_MESSAGE = 'Claude Threads is disabled by your administrator.';

/** Raised when a launch is refused. `message` is written for the user. */
export class ManagedPolicyError extends Error {
  constructor(readonly code: PolicyDenyCode, message: string) {
    super(message);
    this.name = 'ManagedPolicyError';
  }
}

// ── Parsing (defensive: the reply crosses an IPC boundary) ───────────────────

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function stringList(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

function flag(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function targetBlock(v: unknown): { enabled?: boolean; harnesses?: string[] } | undefined {
  if (v === false) return { enabled: false };
  if (!isObject(v)) return undefined;
  return { enabled: flag(v.enabled), harnesses: stringList(v.harnesses) };
}

/**
 * Reads `threadExecution` out of whatever the bridge returned (`{effective: {threadExecution}}`, or the block itself).
 * Anything that is not an object yields `undefined` (no policy); a field of the wrong type is ignored (open) rather
 * than guessed at.
 */
export function parseThreadExecutionPolicy(raw: unknown): ThreadExecutionPolicy | undefined {
  if (!isObject(raw)) return undefined;
  const block = isObject(raw.effective) ? raw.effective.threadExecution : isObject(raw.threadExecution) ? raw.threadExecution : undefined;
  if (!isObject(block)) return undefined;
  const remote = isObject(block.remoteDaemon) ? block.remoteDaemon : undefined;
  const hostExec = isObject(block.hostExec) ? block.hostExec : undefined;
  const out: ThreadExecutionPolicy = {};
  const harnesses = stringList(block.harnesses);
  if (harnesses) out.harnesses = harnesses;
  const machine = targetBlock(block.machine);
  if (machine) out.machine = machine;
  const localDaemon = targetBlock(block.localDaemon);
  if (localDaemon) out.localDaemon = localDaemon;
  const remoteDaemon = targetBlock(block.remoteDaemon);
  if (remoteDaemon) out.remoteDaemon = { ...remoteDaemon, ...(remote && stringList(remote.hosts) ? { hosts: stringList(remote.hosts) } : {}) };
  if (hostExec) out.hostExec = { enabled: flag(hostExec.enabled), allowAlways: flag(hostExec.allowAlways) };
  const mobile = flag(block.mobileRemoteAccess);
  if (mobile !== undefined) out.mobileRemoteAccess = mobile;
  return out;
}

/**
 * A reply that is neither "a policy" nor a plain "no threadExecution policy here" (an older Geode, or a policy file
 * without the area): worth a console warning, still treated as no restriction.
 */
function isUnrecognisedReply(raw: unknown): boolean {
  if (!isObject(raw)) return true;
  if (isObject(raw.effective)) return raw.effective.threadExecution !== undefined && !isObject(raw.effective.threadExecution);
  return raw.threadExecution !== undefined ? !isObject(raw.threadExecution) : true;
}

// ── Lists ────────────────────────────────────────────────────────────────────

/**
 * An allowlist as a set. `undefined` = no restriction. The `!none` sentinel and values this plugin does not know are
 * dropped, so a list holding only those is an empty set (nothing allowed). Unknown ids are ignored, which keeps a newer
 * policy file safe with an older plugin.
 */
function allowSet(list: readonly string[] | undefined): Set<string> | undefined {
  if (!Array.isArray(list)) return undefined;
  return new Set(list.filter((x) => typeof x === 'string' && x !== POLICY_NO_MATCH));
}

const TARGET_LABEL: Record<PolicyTargetKind, string> = {
  machine: 'running on this computer',
  localDaemon: 'the local daemon',
  remoteDaemon: 'remote daemons',
};

function blockFor(policy: ThreadExecutionPolicy, kind: PolicyTargetKind): { enabled?: boolean; harnesses?: string[]; hosts?: string[] } | undefined {
  return kind === 'machine' ? policy.machine : kind === 'localDaemon' ? policy.localDaemon : policy.remoteDaemon;
}

/** Is `harness` allowed on `kind` by the enabled flag and both harness lists (ignores `hosts`)? */
function targetAllows(policy: ThreadExecutionPolicy, kind: PolicyTargetKind, harness: AgentHarness): 'ok' | 'target-disabled' | 'harness-not-allowed' {
  const block = blockFor(policy, kind);
  if (block?.enabled === false) return 'target-disabled';
  const global = allowSet(policy.harnesses);
  if (global && !global.has(harness)) return 'harness-not-allowed';
  const own = allowSet(block?.harnesses);
  if (own && !own.has(harness)) return 'harness-not-allowed';
  return 'ok';
}

// ── Remote host matching ─────────────────────────────────────────────────────

/**
 * The URL a daemon entry is actually connected to. Mirrors `daemonWsUrl` in remote/DaemonClient.ts (kept dependency
 * free here; a unit test pins the two together): http(s) becomes ws(s), a bare host:port becomes ws://.
 */
function connectionUrl(input: string): string {
  let url = input.trim();
  // Linear trailing-slash trim (a `/\/+$/` regex is polynomial on long runs of slashes; CodeQL flags it).
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
  url = url.slice(0, end);
  if (/^http:\/\//i.test(url)) url = `ws://${url.slice(7)}`;
  else if (/^https:\/\//i.test(url)) url = `wss://${url.slice(8)}`;
  else if (!/^wss?:\/\//i.test(url)) url = `ws://${url}`;
  return url;
}

/**
 * Canonical `scheme://host:port` of a daemon URL, or `undefined` when it cannot be trusted to name one host: it does
 * not parse, is not ws/wss, or carries user info (`wss://allowed.example@evil.example`, `wss://user:pw@allowed.example`).
 * The scheme is kept as written (ws and wss are different origins), the host is lower-cased by the URL parser, a
 * trailing dot is NOT stripped (exact match only), and a default port is elided by the parser so `wss://h` equals
 * `wss://h:443`.
 */
export function daemonOriginKey(input: string): string | undefined {
  if (typeof input !== 'string' || input.trim() === '') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(connectionUrl(input));
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return undefined;
  if (parsed.username !== '' || parsed.password !== '') return undefined;
  if (parsed.hostname === '') return undefined;
  const port = parsed.port !== '' ? parsed.port : parsed.protocol === 'wss:' ? '443' : '80';
  return `${parsed.protocol}//${parsed.hostname}:${port}`;
}

/** The `remoteDaemon.hosts` list as canonical origins; `undefined` = no restriction. Unparseable entries match nothing. */
function allowedOrigins(policy: ThreadExecutionPolicy): Set<string> | undefined {
  const hosts = policy.remoteDaemon?.hosts;
  if (!Array.isArray(hosts)) return undefined;
  const out = new Set<string>();
  for (const entry of hosts) {
    if (typeof entry !== 'string' || entry === POLICY_NO_MATCH) continue;
    const key = daemonOriginKey(entry);
    if (key) out.add(key);
  }
  return out;
}

/** True when `url` may be registered or used as a remote daemon under `remoteDaemon.hosts`. No list = any. */
export function remoteHostAllowed(policy: ThreadExecutionPolicy | undefined, url: string | undefined): boolean {
  if (!policy) return true;
  const origins = allowedOrigins(policy);
  if (!origins) return true;
  if (url === undefined) return false;
  const key = daemonOriginKey(url);
  return key !== undefined && origins.has(key);
}

// ── Decisions ────────────────────────────────────────────────────────────────

/** Can a thread of `harness` run on `target`? `undefined` policy is no restriction. */
export function evaluateLaunch(policy: ThreadExecutionPolicy | undefined, target: PolicyTarget, harness: AgentHarness): PolicyDecision {
  if (!policy) return ALLOWED;
  if (isEverythingDisabled(policy)) return { allowed: false, code: 'all-disabled', message: ALL_DISABLED_MESSAGE };
  const verdict = targetAllows(policy, target.kind, harness);
  if (verdict === 'target-disabled') {
    return { allowed: false, code: 'target-disabled', message: `Running threads on ${TARGET_LABEL[target.kind]} is disabled by your administrator.` };
  }
  if (verdict === 'harness-not-allowed') {
    return {
      allowed: false,
      code: 'harness-not-allowed',
      message: `${agentHarnessLabel(harness)} is not allowed on ${TARGET_LABEL[target.kind]} by your administrator.`,
    };
  }
  if (target.kind === 'remoteDaemon') {
    const origins = allowedOrigins(policy);
    if (origins && origins.size === 0) {
      return { allowed: false, code: 'remote-hosts-none', message: 'Your administrator has not allowed any remote daemon host.' };
    }
    if (!remoteHostAllowed(policy, target.url)) {
      return { allowed: false, code: 'host-not-allowed', message: 'This remote daemon is not on the list of hosts your administrator allows.' };
    }
  }
  return ALLOWED;
}

/** Throws {@link ManagedPolicyError} when the launch is refused. */
export function assertLaunchAllowed(policy: ThreadExecutionPolicy | undefined, target: PolicyTarget, harness: AgentHarness): void {
  const decision = evaluateLaunch(policy, target, harness);
  if (!decision.allowed) throw new ManagedPolicyError(decision.code, decision.message);
}

/** Harnesses that may run on `kind` at all (host list ignored). */
export function allowedHarnesses(policy: ThreadExecutionPolicy | undefined, kind: PolicyTargetKind): AgentHarness[] {
  if (!policy) return [...AGENT_HARNESSES];
  return AGENT_HARNESSES.filter((h) => targetAllows(policy, kind, h) === 'ok');
}

/** Is a target usable at all (enabled, at least one harness, and for remote at least one allowed host)? */
export function targetUsable(policy: ThreadExecutionPolicy | undefined, kind: PolicyTargetKind): boolean {
  if (!policy) return true;
  if (allowedHarnesses(policy, kind).length === 0) return false;
  if (kind === 'remoteDaemon') {
    const origins = allowedOrigins(policy);
    if (origins && origins.size === 0) return false;
  }
  return true;
}

/** The effective set of (target, harness) pairs is empty: Claude Threads cannot start any thread. */
export function isEverythingDisabled(policy: ThreadExecutionPolicy | undefined): boolean {
  if (!policy) return false;
  return !(['machine', 'localDaemon', 'remoteDaemon'] as const).some((kind) => targetUsable(policy, kind));
}

/**
 * May this app register, connect to, push to or sync to a daemon at all (independent of any one thread's harness)?
 * Local: the local-daemon target must be usable. Remote: the remote target must be usable and the URL on `hosts`.
 * Returns the user-facing refusal, or `undefined` when allowed.
 */
export function daemonUseDenial(policy: ThreadExecutionPolicy | undefined, target: PolicyTarget): string | undefined {
  if (!policy || target.kind === 'machine') return undefined;
  if (!targetUsable(policy, target.kind)) {
    if (isEverythingDisabled(policy)) return ALL_DISABLED_MESSAGE;
    const block = blockFor(policy, target.kind);
    if (block?.enabled === false) return `Running threads on ${TARGET_LABEL[target.kind]} is disabled by your administrator.`;
    return target.kind === 'remoteDaemon' && allowedOrigins(policy)?.size === 0
      ? 'Your administrator has not allowed any remote daemon host.'
      : `${TARGET_LABEL[target.kind][0].toUpperCase()}${TARGET_LABEL[target.kind].slice(1)} are not available: your administrator has not allowed any harness there.`;
  }
  if (target.kind === 'remoteDaemon' && !remoteHostAllowed(policy, target.url)) {
    return 'This remote daemon is not on the list of hosts your administrator allows.';
  }
  return undefined;
}

/** Why a harness is unavailable on a target, for a disabled menu item; `undefined` when it is available. */
export function harnessDenyReason(policy: ThreadExecutionPolicy | undefined, target: PolicyTarget, harness: AgentHarness): string | undefined {
  const decision = evaluateLaunch(policy, target, harness);
  return decision.allowed ? undefined : decision.message;
}

/**
 * The policy snapshot a caller took in the SAME call path as the session start (the fresh read happens one level up,
 * where the code is async). Passing it is mandatory for ThreadManager (a source-scan test pins that); an absent
 * argument means "this host has no managed policy" (the daemon, tests).
 */
export interface LaunchPolicy {
  policy: ThreadExecutionPolicy | undefined;
}

/** Where a thread runs, for policy: a daemon is local or remote by how its config is classified. */
export function policyTargetOfThread(thread: { remote?: { daemonId: string } }, remoteDaemons?: { targetOf?(daemonId: string): PolicyTarget | undefined }): PolicyTarget {
  if (!thread.remote) return { kind: 'machine' };
  return remoteDaemons?.targetOf?.(thread.remote.daemonId) ?? { kind: 'remoteDaemon' };
}

/** Which target a daemon config is, for policy. */
export function policyTargetOfDaemon(daemon: { id: string; url: string; managed?: string } | undefined, localDaemonId: string): PolicyTarget {
  if (!daemon) return { kind: 'remoteDaemon' };
  // The local container daemon is recognised by its fixed id AND the managed marker AND a loopback address. A user who
  // edits settings.json cannot make a remote host look local by setting `managed` on it.
  if (daemon.id === localDaemonId && daemon.managed === 'local-container' && isLoopbackDaemonUrl(daemon.url)) return { kind: 'localDaemon', url: daemon.url };
  return { kind: 'remoteDaemon', url: daemon.url };
}

function isLoopbackDaemonUrl(url: string): boolean {
  try {
    const host = new URL(connectionUrl(url)).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  } catch {
    return false;
  }
}

// ── host_exec / mobile ───────────────────────────────────────────────────────

export interface HostExecPolicyState {
  enabled: boolean;
  /** Whether the "Always allow" option and previously saved command prefixes are honoured. */
  allowAlways: boolean;
}

export function hostExecState(policy: ThreadExecutionPolicy | undefined): HostExecPolicyState {
  const enabled = policy?.hostExec?.enabled !== false;
  return { enabled, allowAlways: enabled && policy?.hostExec?.allowAlways !== false };
}

/** What the host_exec wiring gets: the state when the session was set up, and a fresh answer on demand. */
export interface HostExecPolicyAccess {
  initial: HostExecPolicyState;
  current(): Promise<HostExecPolicyState>;
}

export const HOST_EXEC_DISABLED_MESSAGE = 'host_exec is disabled by your administrator.';

export function mobileRemoteAccessAllowed(policy: ThreadExecutionPolicy | undefined): boolean {
  return policy?.mobileRemoteAccess !== false;
}

// ── GitHub delivery to remote daemons ────────────────────────────────────────

/**
 * `github.deliverToRemoteDaemon` from a raw `getEffectivePolicy()` reply; absent or unrecognised = allowed (fail open).
 * Today this plugin delivers a GitHub token only to the managed LOCAL daemon (localDaemon/githubDelivery.ts); it has no
 * remote-daemon GitHub delivery. Any code that would ever send a GitHub token to a remote daemon MUST ask this first,
 * with a fresh reply (`test/unit/managed-policy-boundaries.test.ts` pins that nothing sends one today).
 */
export function githubDeliveryToRemoteDaemonAllowed(rawReply: unknown): boolean {
  if (!isObject(rawReply) || !isObject(rawReply.effective) || !isObject(rawReply.effective.github)) return true;
  return rawReply.effective.github.deliverToRemoteDaemon !== false;
}

// ── The bridge ───────────────────────────────────────────────────────────────

export interface PolicyBridge {
  getEffectivePolicy(): Promise<unknown>;
}

/**
 * Picks the policy bridge off a host window; undefined on Obsidian, on a Geode that predates it, and on mobile
 * (which has no `window.geode`). Everything then fails open.
 */
export function resolvePolicyBridge(hostWindow: { geode?: { getEffectivePolicy?: unknown } } | undefined): PolicyBridge | undefined {
  const geode = hostWindow?.geode;
  if (!geode || typeof geode.getEffectivePolicy !== 'function') return undefined;
  const fn = geode.getEffectivePolicy as () => Promise<unknown>;
  return { getEffectivePolicy: () => fn.call(geode) };
}

/** What the rest of the plugin sees: a fresh read, plus the last snapshot for synchronous advisory UI. */
export interface ManagedPolicySource {
  /** Evaluate NOW. Never rejects; resolves `undefined` (no restriction) when there is no usable policy. */
  read(): Promise<ThreadExecutionPolicy | undefined>;
  /** The most recent result of `read()`, for UI that cannot await. Never used to authorize anything. */
  peek(): ThreadExecutionPolicy | undefined;
  /** Called after a `read()` whose result differs from the previous one. */
  subscribe(listener: () => void): () => void;
}

export interface ManagedPolicyServiceOptions {
  /** Resolved on every read so a bridge that appears later is picked up. */
  bridge: () => PolicyBridge | undefined;
  warn?: (message: string) => void;
}

/**
 * The live policy reader. Each `read()` asks the host again; concurrent reads share one IPC round trip (coalescing is
 * the only caching, and it lasts exactly as long as the request is in flight).
 */
export class ManagedPolicyService implements ManagedPolicySource {
  private inflight: Promise<ThreadExecutionPolicy | undefined> | null = null;
  private last: ThreadExecutionPolicy | undefined;
  private lastKey = 'undefined';
  private lastWarning = '';
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: ManagedPolicyServiceOptions) {}

  read(): Promise<ThreadExecutionPolicy | undefined> {
    if (this.inflight) return this.inflight;
    const pending = this.fetch().finally(() => { if (this.inflight === pending) this.inflight = null; });
    this.inflight = pending;
    return pending;
  }

  peek(): ThreadExecutionPolicy | undefined {
    return this.last;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private warn(message: string): void {
    // One line per distinct problem, not one per read.
    if (message === this.lastWarning) return;
    this.lastWarning = message;
    (this.options.warn ?? ((m: string) => console.warn(m)))(`[ClaudeThreads] managed policy: ${message}; treating it as no restriction.`);
  }

  private async fetch(): Promise<ThreadExecutionPolicy | undefined> {
    let policy: ThreadExecutionPolicy | undefined;
    try {
      const bridge = this.options.bridge();
      if (bridge) {
        const raw = await bridge.getEffectivePolicy();
        if (raw === null || raw === undefined) policy = undefined;
        else {
          policy = parseThreadExecutionPolicy(raw);
          if (!policy && isUnrecognisedReply(raw)) this.warn('the host returned an unrecognised policy shape');
          else this.lastWarning = '';
        }
      }
    } catch (err) {
      this.warn(`reading the policy failed (${err instanceof Error ? err.message : String(err)})`);
      policy = undefined;
    }
    this.publish(policy);
    return policy;
  }

  private publish(policy: ThreadExecutionPolicy | undefined): void {
    const key = JSON.stringify(policy ?? null);
    const changed = key !== this.lastKey;
    this.last = policy;
    this.lastKey = key;
    if (!changed) return;
    for (const listener of [...this.listeners]) {
      try { listener(); } catch (err) { console.warn('[ClaudeThreads] managed policy listener failed', err); }
    }
  }
}

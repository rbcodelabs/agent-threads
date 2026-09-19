import type { ChatMessage, Thread, ThreadArtifactRecord, ThreadStatus } from './types';
import type { ThreadEvent } from './ThreadManager';
import type { RawLogTraceChunk, RawLogTraceMetadata } from './RawLogWriter';
import type { McpRegistrationResult } from './mcpServerStore';
import type { ArtifactActionResult, ArtifactAttachResult, ArtifactContribution, ArtifactMutationResult, ArtifactPatch, ArtifactProviderRegistry, ArtifactRegistrationResult, ArtifactStoreHost, PeerIdentity, ThreadArtifactRef } from './ArtifactContributions';
import { HOST_OWNED_ARTIFACT_FIELDS, PROVIDER_ID_PATTERN, toArtifactRef } from './ArtifactContributions';

export type { ArtifactAction, ArtifactActionHost, ArtifactActionResult, ArtifactAttachResult, ArtifactContribution, ArtifactMutationResult, ArtifactPatch, ArtifactPresentation, ArtifactRegistrationResult, ArtifactStoreHost, ArtifactViewPlacement, PeerIdentity, ThreadArtifactRef } from './ArtifactContributions';

export type PublicErrorCode = 'PLUGIN_UNAVAILABLE' | 'THREAD_NOT_FOUND' | 'RUN_NOT_FOUND' | 'RUN_FAILED' | 'RUN_INTERRUPTED' | 'THREAD_BUSY' | 'IDEMPOTENCY_CONFLICT' | 'TRACE_NOT_FOUND' | 'CURSOR_INVALID' | 'CONSTRAINT_UNSUPPORTED' | 'ORCHESTRATOR_NOT_FOUND' | 'INVALID_ARGUMENT';
export interface PublicError { readonly code: PublicErrorCode; readonly message: string }
export class ClaudeThreadsApiError extends Error implements PublicError {
  constructor(public readonly code: PublicErrorCode, message: string, public readonly generation?: string) { super(message); this.name = 'ClaudeThreadsApiError'; }
}
export interface MessageSnapshot { readonly id: string; readonly role: ChatMessage['role']; readonly content: string; readonly timestamp: number }
export interface ThreadSummary { readonly id: string; readonly title: string; readonly status: ThreadStatus; readonly reviewed: boolean; readonly cwd?: string; readonly projectId?: string; readonly agentHarness: 'claude' | 'codex'; readonly origin?: string; readonly externalJobId?: string; readonly ephemeral?: boolean; readonly background?: boolean; readonly createdAt: number; readonly updatedAt: number; readonly isRunning: boolean; readonly messageCount: number }
export interface ThreadSnapshot extends ThreadSummary { readonly messages: readonly MessageSnapshot[] }
export interface ThreadQuery { readonly projectId?: string | null; readonly status?: ThreadStatus; readonly limit?: number }
export interface CorrelationInput { readonly ownerPluginId?: string; readonly idempotencyKey?: string }
export interface CreateThreadInput extends CorrelationInput { readonly title?: string; readonly cwd?: string; readonly projectId?: string; readonly agentHarness?: 'claude' | 'codex'; readonly origin?: string; readonly externalJobId?: string; readonly ephemeral?: boolean; readonly background?: boolean }
export interface SendInput extends CorrelationInput { readonly prompt: string }
export interface WaitOptions { readonly timeoutMs?: number }
export type RunResult =
  | { readonly status: 'completed'; readonly runId: string; readonly threadId: string; readonly finalMessage?: MessageSnapshot; readonly usage?: PublicUsage }
  | { readonly status: 'failed'; readonly runId: string; readonly threadId: string; readonly error: PublicError }
  | { readonly status: 'timed_out'; readonly runId: string; readonly threadId: string };
export type PublicThreadEvent =
  | { readonly kind: 'run.started'; readonly threadId: string; readonly runId: string; readonly at: number }
  | { readonly kind: 'message.completed'; readonly threadId: string; readonly runId?: string; readonly message: MessageSnapshot; readonly at: number }
  | { readonly kind: 'run.completed'; readonly threadId: string; readonly runId: string; readonly finalMessage?: MessageSnapshot; readonly at: number }
  | { readonly kind: 'run.failed'; readonly threadId: string; readonly runId: string; readonly error: PublicError; readonly at: number }
  | { readonly kind: 'thread.removed'; readonly threadId: string; readonly at: number };
export interface Disposable { dispose(): void }
export interface PublicUsage { readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number; readonly durationMs?: number; readonly turns?: number }
export interface TraceSource { readonly sourceId: string; readonly threadId: string; readonly projectId?: string; readonly harness: 'claude' | 'codex'; readonly revision: string; readonly contentHash: string; readonly byteLength: number; readonly updatedAt: number }
export interface TraceSourcePage { readonly sources: readonly TraceSource[]; readonly nextCursor?: string; readonly eof: boolean }
export interface SkillRunOutcome { readonly invokedSkill: string; readonly runOutcome: 'success' | 'failure'; readonly invocationIndex: number }
export interface TraceEvent { readonly index: number; readonly timestamp: string; readonly type: string; readonly invokedSkill?: string; readonly skillLoadOutcome?: 'loaded'; readonly skillRunOutcomes?: readonly SkillRunOutcome[]; readonly data: unknown }
export interface TraceChunk { readonly sourceId: string; readonly revision: string; readonly contentHash: string; readonly cursor?: string; readonly nextCursor: string; readonly eof: boolean; readonly events: readonly TraceEvent[] }
export type PublicTraceEvent = { readonly kind: 'trace.updated' | 'trace.removed'; readonly sourceId: string; readonly revision: string; readonly at: number };
export interface ConstrainedRunInput extends CorrelationInput { readonly ownerPluginId: string; readonly idempotencyKey: string; readonly harness: 'claude'; readonly model: string; readonly systemInstructions: string; readonly prompt: string; readonly maxTurns: 1; readonly maxBudgetUsd: number; readonly timeoutMs: number }
export type ConstrainedRunResult =
  | { readonly status: 'running'; readonly runId: string }
  | { readonly status: 'completed'; readonly runId: string; readonly output: string; readonly model: string; readonly usage: PublicUsage }
  | { readonly status: 'failed' | 'cancelled'; readonly runId: string; readonly error: PublicError };
export type PersistedThreadRun = Exclude<RunResult, { status: 'timed_out' }> | { readonly status: 'running'; readonly runId: string; readonly threadId: string };
export interface CorrelatedResource { readonly resourceId: string; readonly fingerprint: string }
export interface PublicApiPersistedState { readonly version: 1; readonly creates: Record<string, string | CorrelatedResource>; readonly sends: Record<string, string | CorrelatedResource>; readonly runs: Record<string, PersistedThreadRun>; readonly constrained: Record<string, ConstrainedRunResult>; readonly constrainedKeys: Record<string, string | CorrelatedResource> }
export interface ConstrainedQueryInput { readonly prompt: string; readonly options: { readonly model: string; readonly systemInstructions: string; readonly maxTurns: 1; readonly maxBudgetUsd: number; readonly timeoutMs: number }; readonly signal: AbortSignal }
export interface ConstrainedQueryOutput { readonly output: string; readonly usage: PublicUsage }
export interface OrchestratorSnapshot { readonly id: string; readonly kind: 'portfolio' | 'project'; readonly threadId: string; readonly title: string; readonly projectId?: string }
export interface OrchestratorTarget { readonly id: string }
export interface AgentToolDefinition { readonly type: 'function'; readonly name: string; readonly description: string; readonly parameters: Readonly<Record<string, unknown>> }
export interface AgentToolBundle { readonly tools: readonly AgentToolDefinition[]; execute(name: string, args: Record<string, unknown>): Promise<string> }
export interface McpRegisterInput {
  readonly name: string;
  readonly type: 'stdio' | 'http' | 'sse' | 'oauth';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly scopes?: string;
  readonly tools?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] };
  readonly clientId?: string;
  readonly authorizationServerUrl?: string;
  readonly redirectUri?: string;
}
export interface RequestSecretInput { readonly secretName: string; readonly reason: string; readonly force?: boolean }
export type RequestSecretResult =
  | { readonly success: true; readonly secretName: string; readonly alreadyExisted: boolean }
  | { readonly success: false; readonly reason: string };
export interface ClaudeThreadsApiV1 {
  readonly apiVersion: 1; readonly generation: string; readonly capabilities: readonly string[];
  readonly threads: {
    list(query?: ThreadQuery): Promise<readonly ThreadSummary[]>; get(threadId: string): Promise<ThreadSnapshot | null>;
    create(input: CreateThreadInput): Promise<{ readonly threadId: string }>; send(threadId: string, input: SendInput): Promise<{ readonly runId: string }>;
    wait(runId: string, options?: WaitOptions): Promise<RunResult>; cancel(runId: string): Promise<Exclude<RunResult, { status: 'timed_out' }>>; open(threadId: string): Promise<void>; subscribe(listener: (event: PublicThreadEvent) => void): Disposable;
  };
  readonly traces: { listSources(options?: { readonly cursor?: string; readonly limit?: number }): Promise<TraceSourcePage>; readChunk(sourceId: string, options?: { readonly cursor?: string; readonly limit?: number }): Promise<TraceChunk>; subscribe(listener: (event: PublicTraceEvent) => void): Disposable };
  readonly constrainedRuns: { create(input: ConstrainedRunInput): Promise<{ readonly runId: string }>; get(runId: string): Promise<ConstrainedRunResult>; wait(runId: string, options?: WaitOptions): Promise<ConstrainedRunResult>; cancel(runId: string): Promise<ConstrainedRunResult> };
  readonly orchestrators: { list(): Promise<readonly OrchestratorSnapshot[]>; dispatch(target: OrchestratorTarget, input: SendInput): Promise<{ readonly runId: string }> };
  readonly agentTools: { createBundle(profile: 'voice-orchestration'): AgentToolBundle };
  readonly mcp: {
    register(input: McpRegisterInput): Promise<McpRegistrationResult>;
    requestSecret(input: RequestSecretInput): Promise<RequestSecretResult>;
  };
  /**
   * Contribution surface (ADR-0008). Every registration is disposable and is
   * dropped both on the caller's dispose and on host `stop()`.
   */
  readonly extensions: {
    registerArtifactProvider(owner: PeerIdentity, contribution: ArtifactContribution): ArtifactRegistrationResult;
  };
  /**
   * Artifact entry point (ADR-0010). Lets a peer create an artifact and open
   * it without any view, DOM or private-manager access — the gap that made
   * `extensions.registerArtifactProvider` presentation-only.
   *
   * `owner` is explicit on every mutating call because the API object is a
   * single shared singleton: the host cannot infer which plugin is calling,
   * so ownership has to be asserted rather than derived. It is checked against
   * the identity that registered the provider, so a peer cannot write into
   * another plugin's provider namespace.
   */
  readonly artifacts: {
    list(threadId: string): Promise<readonly ThreadArtifactRef[]>;
    attach(owner: PeerIdentity, threadId: string, ref: ThreadArtifactRef): Promise<ArtifactAttachResult>;
    update(owner: PeerIdentity, threadId: string, artifactId: string, patch: ArtifactPatch): Promise<ArtifactMutationResult>;
    detach(owner: PeerIdentity, threadId: string, artifactId: string): Promise<ArtifactMutationResult>;
    /** Runs a named provider action on the same path a card click takes. */
    invokeAction(threadId: string, artifactId: string, actionId: string): Promise<ArtifactActionResult>;
  };
}
export interface PublicApiDependencies {
  getThreads(): Thread[]; getThread(id: string): Thread | undefined; isRunning(id: string): boolean; createThread(input: CreateThreadInput): Thread | Promise<Thread>;
  sendMessage(id: string, prompt: string): Promise<void>; openThread(id: string): Promise<void>; subscribe(listener: (threadId: string, event: ThreadEvent) => void): () => void;
  interruptThread?(id: string): Promise<void>;
  getTraceMetadata?(id: string): Promise<RawLogTraceMetadata | null>;
  readTraceChunk?(id: string, options: { byteOffset: number; eventIndex: number; limit: number }): Promise<RawLogTraceChunk | null>;
  getRegisteredSkillNames?(): Promise<readonly string[]>;
  getRedactionSecrets?(): readonly string[];
  getPublicState?(): PublicApiPersistedState | undefined; savePublicState?(state: PublicApiPersistedState): Promise<void>;
  runConstrainedQuery?(input: ConstrainedQueryInput): Promise<ConstrainedQueryOutput>;
  listOrchestrators(): OrchestratorSnapshot[]; resolveOrchestrator(target: OrchestratorTarget): Promise<string | null>;
  triggerHostEvent(name: 'claude-threads:api-ready' | 'claude-threads:api-stopping', payload: { apiVersion: 1; generation: string }): void;
  registerMcpServer?(input: unknown): Promise<McpRegistrationResult>;
  requestSecret?(secretName: string, reason: string, force?: boolean): Promise<boolean>;
  hasSecret?(secretName: string): boolean;
  /** Host-owned artifact provider registry; absent when the host cannot render artifacts. */
  artifactProviders?: ArtifactProviderRegistry;
  /** Host-owned artifact persistence; absent when the host cannot store artifacts. */
  artifactStore?: ArtifactStoreHost;
}
interface RunRecord { readonly runId: string; readonly threadId: string; result?: Exclude<RunResult, { status: 'timed_out' }>; waiters: Set<(result: Exclude<RunResult, { status: 'timed_out' }>) => void> }
export interface ClaudeThreadsApiService { readonly api: ClaudeThreadsApiV1; start(): void; stop(): void }

/**
 * Capabilities are computed from the dependencies actually present, so
 * discovery never advertises an operation that fails at call time (ADR-0008).
 * `threads.*`, `orchestrators.*` and `agentTools.*` rest on required deps and
 * are therefore always present.
 */
function computeCapabilities(deps: PublicApiDependencies): readonly string[] {
  const capabilities = ['threads.list', 'threads.get', 'threads.create', 'threads.send', 'threads.wait', 'threads.cancel', 'threads.open', 'threads.subscribe'];
  if (deps.getTraceMetadata && deps.readTraceChunk) capabilities.push('traces.listSources', 'traces.readChunk', 'traces.subscribe');
  if (deps.runConstrainedQuery) capabilities.push('constrainedRuns.create', 'constrainedRuns.get', 'constrainedRuns.wait', 'constrainedRuns.cancel');
  capabilities.push('orchestrators.list', 'orchestrators.dispatch', 'agentTools.voice-orchestration');
  if (deps.registerMcpServer) capabilities.push('mcp.register');
  if (deps.requestSecret) capabilities.push('mcp.requestSecret');
  if (deps.artifactProviders) capabilities.push('extensions.registerArtifactProvider');
  if (deps.artifactStore && deps.artifactProviders) capabilities.push('artifacts.list', 'artifacts.attach', 'artifacts.update', 'artifacts.detach', 'artifacts.invokeAction');
  return Object.freeze(capabilities);
}
function freeze<T extends object>(value: T): Readonly<T> { for (const nested of Object.values(value)) if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) freeze(nested as object); return Object.freeze(value); }
function snapshotMessage(message: ChatMessage): MessageSnapshot { return freeze({ id: message.id, role: message.role, content: String(message.content).slice(0, 100_000), timestamp: message.timestamp }); }
function snapshotSummary(thread: Thread, running: boolean): ThreadSummary { return freeze({ id: thread.id, title: thread.title, status: thread.status ?? 'waiting', reviewed: thread.reviewed ?? false, cwd: thread.cwd, projectId: thread.projectId, agentHarness: thread.agentHarness ?? 'claude', origin: thread.origin, externalJobId: thread.externalJobId, ephemeral: thread.ephemeral, background: thread.background, createdAt: thread.createdAt, updatedAt: thread.updatedAt, isRunning: running, messageCount: thread.messages.length }); }
const EMPTY_STATE = (): PublicApiPersistedState => ({ version: 1, creates: {}, sends: {}, runs: {}, constrained: {}, constrainedKeys: {} });
const MAX_PERSISTED_RECORDS = 500;
const MAX_PERSISTED_STATE_BYTES = 1024 * 1024;
function trimRecord<T>(record: Record<string, T>): void { const keys = Object.keys(record); for (const key of keys.slice(0, Math.max(0, keys.length - MAX_PERSISTED_RECORDS))) delete record[key]; }
const MAX_OWNER_LENGTH = 128;
const MAX_KEY_LENGTH = 256;
const MAX_PROMPT_LENGTH = 100_000;
const MAX_SYSTEM_LENGTH = 20_000;
const MAX_MODEL_LENGTH = 128;
const MAX_BUDGET_USD = 100;
const MAX_TIMEOUT_MS = 600_000;
const MAX_SECRET_NAME_LENGTH = 128;
const MAX_SECRET_REASON_LENGTH = 500;
const MAX_ARTIFACT_ID_LENGTH = 128;
const MAX_ARTIFACT_KIND_LENGTH = 128;
const MAX_ARTIFACT_TITLE_LENGTH = 512;
/** Provider data rides along in the host's settings file, so it stays bounded. */
const MAX_ARTIFACT_DATA_BYTES = 256 * 1024;
function boundedString(value: unknown, name: string, max: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') throw new ClaudeThreadsApiError('INVALID_ARGUMENT', `${name} must be a string.`);
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > max) throw new ClaudeThreadsApiError('INVALID_ARGUMENT', `${name} must contain 1-${max} characters.`);
  return normalized || undefined;
}
function validateCorrelation(input: CorrelationInput): { owner?: string; key?: string } {
  const owner = boundedString(input.ownerPluginId, 'ownerPluginId', MAX_OWNER_LENGTH);
  const key = boundedString(input.idempotencyKey, 'idempotencyKey', MAX_KEY_LENGTH);
  if (Boolean(owner) !== Boolean(key)) throw new ClaudeThreadsApiError('INVALID_ARGUMENT', 'ownerPluginId and idempotencyKey must be provided together.');
  return { owner, key };
}
function correlationKey(operation: string, input: CorrelationInput, threadId?: string): string | undefined {
  const { owner, key } = validateCorrelation(input);
  return owner && key ? `${operation}\u0000${owner}\u0000${threadId ?? ''}\u0000${key}` : undefined;
}
async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function correlatedId(value: string | CorrelatedResource | undefined, expectedFingerprint: string): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (value.fingerprint !== expectedFingerprint) throw new ClaudeThreadsApiError('IDEMPOTENCY_CONFLICT', 'The idempotency key was already used with different input.');
  return value.resourceId;
}
function traceCursor(sourceId: string, revision: string, byteOffset: number, eventIndex: number, boundaryHash: string): string { return `ct1:${btoa(JSON.stringify({ sourceId, revision, byteOffset, eventIndex, boundaryHash }))}`; }
function parseTraceCursor(value: string | undefined, sourceId: string, revision: string): { byteOffset: number; eventIndex: number; boundaryHash?: string } {
  if (!value) return { byteOffset: 0, eventIndex: 0 };
  try {
    if (!value.startsWith('ct1:')) throw new Error();
    const decoded = JSON.parse(atob(value.slice(4))) as { sourceId: string; revision: string; byteOffset: number; eventIndex: number; boundaryHash: string };
    if (decoded.sourceId !== sourceId || decoded.revision !== revision || !Number.isInteger(decoded.byteOffset) || decoded.byteOffset < 0 || !Number.isInteger(decoded.eventIndex) || decoded.eventIndex < 0 || typeof decoded.boundaryHash !== 'string') throw new Error();
    return { byteOffset: decoded.byteOffset, eventIndex: decoded.eventIndex, boundaryHash: decoded.boundaryHash };
  } catch { throw new ClaudeThreadsApiError('CURSOR_INVALID', 'The trace cursor is invalid or stale.'); }
}
function sourcePageCursor(after: string): string { return `cts1:${btoa(JSON.stringify({ after }))}`; }
function parseSourcePageCursor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { if (!value.startsWith('cts1:')) throw new Error(); const decoded = JSON.parse(atob(value.slice(5))) as { after: string }; if (typeof decoded.after !== 'string' || !decoded.after) throw new Error(); return decoded.after; }
  catch { throw new ClaudeThreadsApiError('CURSOR_INVALID', 'The trace source cursor is invalid.'); }
}
function positiveLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0 || limit > 500) throw new ClaudeThreadsApiError('INVALID_ARGUMENT', 'limit must be a finite positive integer no greater than 500.');
  return limit;
}
const SENSITIVE_KEY = /(?:token|secret|password|authorization|cookie|rawlogpath|path)$/i;
const SENSITIVE_VALUE = /\b(?:token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi;
const LOCAL_PATH = /file:\/\/\/(?:[A-Za-z]:[\\/])?[^\s"'<>]+|~[\\/][^\s"'<>]+|(^|[\s([{=])(?:(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+|\/(?!\/)[^\s"'<>),;\]]+)/gim;
function sanitize(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') return secrets.filter(secret => secret.length >= 4).reduce((text, secret) => text.split(secret).join('[REDACTED]'), value.replace(SENSITIVE_VALUE, '[REDACTED]').replace(LOCAL_PATH, (_match, prefix = '') => `${prefix}[PATH]`));
  if (Array.isArray(value)) return value.map(item => sanitize(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !SENSITIVE_KEY.test(key)).map(([key, nested]) => [key, sanitize(nested, secrets)]));
  return value;
}
function textBlocks(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap(block => block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text' && typeof (block as Record<string, unknown>).text === 'string' ? [(block as Record<string, unknown>).text as string] : []);
}
function projectTraceData(type: string, raw: unknown, secrets: readonly string[]): unknown {
  const event = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const message = event.message && typeof event.message === 'object' ? event.message as Record<string, unknown> : event;
  if (type === 'assistant') {
    const content = Array.isArray(message.content) ? message.content : [];
    const tools = content.flatMap(block => block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use' && typeof (block as Record<string, unknown>).name === 'string' ? [(block as Record<string, unknown>).name as string] : []);
    return sanitize({ text: textBlocks(message.content).join('\n'), tools, model: typeof message.model === 'string' ? message.model : undefined }, secrets);
  }
  if (type === 'user') return sanitize({ text: textBlocks(message.content ?? event.message).join('\n') }, secrets);
  if (type === 'result') return sanitize({ subtype: event.subtype, durationMs: event.duration_ms, turns: event.num_turns, costUsd: event.total_cost_usd, usage: event.usage, modelUsage: event.modelUsage ?? event.model_usage, errors: event.is_error ? ['run_failed'] : undefined }, secrets);
  if (type === 'tool_use_summary') return sanitize({ summary: event.summary }, secrets);
  if (type === 'session_start') return sanitize({ harness: event.harness, model: event.model }, secrets);
  return { kind: type };
}
function traceContent(raw: unknown): readonly unknown[] {
  if (!raw || typeof raw !== 'object') return [];
  const event = raw as Record<string, unknown>;
  const message = event.message && typeof event.message === 'object' ? event.message as Record<string, unknown> : event;
  return Array.isArray(message.content) ? message.content : [];
}
function snapshotThread(thread: Thread, running: boolean): ThreadSnapshot { return freeze({ ...snapshotSummary(thread, running), messages: thread.messages.map(snapshotMessage) }); }
function stringProp(): Record<string, unknown> { return { type: 'string' }; }
function boolProp(): Record<string, unknown> { return { type: 'boolean' }; }
function numberProp(): Record<string, unknown> { return { type: 'number' }; }
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): AgentToolDefinition { return { type: 'function', name, description, parameters: { type: 'object', properties, required } }; }
const VOICE_TOOLS: readonly AgentToolDefinition[] = freeze([
  tool('ct_send_message', 'Send a message to an existing Claude thread.', { message: stringProp(), thread_id: stringProp(), wait: boolProp(), timeout_secs: numberProp() }, ['message', 'thread_id']),
  tool('ct_new_thread', 'Start a new Claude thread with an initial message.', { message: stringProp(), title_hint: stringProp(), wait: boolProp(), timeout_secs: numberProp() }, ['message']),
  tool('ct_wait_for_thread', 'Wait for a Claude thread run to finish.', { thread_id: stringProp(), timeout_secs: numberProp() }),
  tool('ct_get_thread', 'Read messages and status from a Claude thread.', { thread_id: stringProp(), last_n: numberProp() }),
  tool('ct_list_threads', 'List Claude threads and their statuses.', { status: { type: 'string', enum: ['active', 'waiting', 'waiting_new', 'error', 'all'] }, limit: numberProp() }),
  tool('ct_open_thread', 'Open a Claude thread in the host UI.', { thread_id: stringProp() }, ['thread_id']),
]);

export function createClaudeThreadsApiV1(deps: PublicApiDependencies): ClaudeThreadsApiService {
  const generation = crypto.randomUUID();
  const listeners = new Set<(event: PublicThreadEvent) => void>(); const runs = new Map<string, RunRecord>();
  const traceListeners = new Set<(event: PublicTraceEvent) => void>();
  const eligibleTraceIds = new Set(deps.getThreads().filter(thread => !thread.origin).map(thread => thread.id));
  const constrainedControllers = new Map<string, AbortController>();
  const constrainedWaiters = new Map<string, Set<(result: ConstrainedRunResult) => void>>();
  const persisted = structuredClone(deps.getPublicState?.() ?? EMPTY_STATE());
  let reconciliationDirty = false;
  for (const [runId, stored] of Object.entries(persisted.runs)) {
    const result = stored.status === 'running' ? freeze({ status: 'failed' as const, runId, threadId: stored.threadId, error: freeze({ code: 'RUN_INTERRUPTED' as const, message: 'The agent run was interrupted.' }) }) : stored;
    if (stored.status === 'running') reconciliationDirty = true;
    persisted.runs[runId] = result; runs.set(runId, { runId, threadId: stored.threadId, result, waiters: new Set() });
  }
  for (const [runId, stored] of Object.entries(persisted.constrained)) if (stored.status === 'running') { reconciliationDirty = true; persisted.constrained[runId] = freeze({ status: 'failed', runId, error: freeze({ code: 'RUN_INTERRUPTED' as const, message: 'The agent run was interrupted.' }) }); }
  const runIdsByThread = new Map<string, Set<string>>(); const latestRunByThread = new Map<string, string>();
  const serial = new Map<string, Promise<unknown>>();
  let active = true; let started = false; let stopped = false;
  const unavailable = () => new ClaudeThreadsApiError('PLUGIN_UNAVAILABLE', 'Agent Threads is not available.', generation);
  const guard = () => { if (!active) throw unavailable(); };
  const publish = (event: PublicThreadEvent) => { if (!active) return; const immutable = freeze(event); for (const listener of [...listeners]) { try { listener(immutable); } catch (error) { console.error('[ClaudeThreads] Public API listener failed:', error); } } };
  const publicFailure = (code: PublicErrorCode): PublicError => freeze({ code, message: code === 'PLUGIN_UNAVAILABLE' ? 'Agent Threads became unavailable.' : code === 'RUN_INTERRUPTED' ? 'The agent run was interrupted.' : 'The agent run failed.' });
  const trimPairedState = () => {
    trimRecord(persisted.creates);
    trimRecord(persisted.runs);
    const retainedRuns = new Set(Object.keys(persisted.runs));
    for (const [key, value] of Object.entries(persisted.sends)) if (!retainedRuns.has(typeof value === 'string' ? value : value.resourceId)) delete persisted.sends[key];
    trimRecord(persisted.constrained);
    const retainedConstrained = new Set(Object.keys(persisted.constrained));
    for (const [key, value] of Object.entries(persisted.constrainedKeys)) if (!retainedConstrained.has(typeof value === 'string' ? value : value.resourceId)) delete persisted.constrainedKeys[key];
    const removeReferences = (record: Record<string, string | CorrelatedResource>, resourceId: string) => { for (const [key, value] of Object.entries(record)) if ((typeof value === 'string' ? value : value.resourceId) === resourceId) delete record[key]; };
    while (new TextEncoder().encode(JSON.stringify(persisted)).byteLength > MAX_PERSISTED_STATE_BYTES) {
      const constrainedId = Object.keys(persisted.constrained).find(id => persisted.constrained[id].status !== 'running');
      if (constrainedId) { delete persisted.constrained[constrainedId]; removeReferences(persisted.constrainedKeys, constrainedId); continue; }
      const runId = Object.keys(persisted.runs).find(id => persisted.runs[id].status !== 'running');
      if (runId) { delete persisted.runs[runId]; removeReferences(persisted.sends, runId); continue; }
      const createKey = Object.keys(persisted.creates)[0]; if (createKey) { delete persisted.creates[createKey]; continue; }
      const constrainedKey = Object.keys(persisted.constrainedKeys)[0]; if (constrainedKey) { delete persisted.constrainedKeys[constrainedKey]; continue; }
      const sendKey = Object.keys(persisted.sends)[0]; if (sendKey) { delete persisted.sends[sendKey]; continue; }
      break;
    }
  };
  let saveChain: Promise<void> = Promise.resolve();
  const saveState = async () => { trimPairedState(); const snapshot = structuredClone(persisted); saveChain = saveChain.catch(() => undefined).then(() => deps.savePublicState?.(snapshot) ?? Promise.resolve()); await saveChain; reconciliationDirty = false; };
  const persistReconciliation = async () => { if (reconciliationDirty) await saveState(); };
  const serialize = async <T>(key: string, action: () => Promise<T>): Promise<T> => { const previous = serial.get(key) ?? Promise.resolve(); let release!: () => void; const turn = new Promise<void>(resolve => { release = resolve; }); const queued = previous.catch(() => undefined).then(() => turn); serial.set(key, queued); await previous.catch(() => undefined); try { return await action(); } finally { release(); if (serial.get(key) === queued) serial.delete(key); } };
  const settle = async (record: RunRecord, result: Exclude<RunResult, { status: 'timed_out' }>) => { if (record.result) return record.result; record.result = freeze(result); persisted.runs[record.runId] = result; await saveState(); for (const resolve of [...record.waiters]) resolve(record.result); record.waiters.clear(); runIdsByThread.get(record.threadId)?.delete(record.runId); return record.result; };
  const activeRuns = (threadId: string) => [...(runIdsByThread.get(threadId) ?? [])].map(id => runs.get(id)).filter((record): record is RunRecord => !!record && !record.result);
  const lastAssistant = (threadId: string) => { const message = [...(deps.getThread(threadId)?.messages ?? [])].reverse().find(candidate => candidate.role === 'assistant'); return message ? snapshotMessage(message) : undefined; };
  const unsubscribeInternal = deps.subscribe((threadId, event) => {
    if (!active) return;
    const traceThread = deps.getThread(threadId);
    if (traceThread && !traceThread.origin) eligibleTraceIds.add(threadId);
    const traceChanged = event.type === 'message' || event.type === 'done' || event.type === 'error' || event.type === 'interrupted';
    if (event.type === 'thread_deleted' && eligibleTraceIds.delete(threadId)) {
      const update = freeze({ kind: 'trace.removed' as const, sourceId: threadId, revision: 'removed', at: Date.now() });
      for (const listener of [...traceListeners]) { try { listener(update); } catch (error) { console.error('[ClaudeThreads] Public trace listener failed:', error); } }
    } else if (traceChanged && traceThread && eligibleTraceIds.has(threadId)) {
      void deps.getTraceMetadata?.(threadId).then(metadata => {
        if (!active || !metadata) return;
        const update = freeze({ kind: 'trace.updated' as const, sourceId: threadId, revision: metadata.revision, at: Date.now() });
        for (const listener of [...traceListeners]) { try { listener(update); } catch (error) { console.error('[ClaudeThreads] Public trace listener failed:', error); } }
      }).catch(error => console.error('[ClaudeThreads] Public trace metadata read failed:', error));
    }
    if (event.type === 'message' && event.message.role === 'assistant') publish({ kind: 'message.completed', threadId, runId: latestRunByThread.get(threadId), message: snapshotMessage(event.message), at: Date.now() });
    else if (event.type === 'done') { const finalMessage = lastAssistant(threadId); const snapshot = deps.getThread(threadId)?.usageSnapshot; const usage = snapshot ? freeze({ inputTokens: snapshot.tokens?.input ?? 0, outputTokens: snapshot.tokens?.output ?? 0, costUsd: snapshot.estimatedCostUsd ?? 0, turns: snapshot.turns }) : undefined; for (const record of activeRuns(threadId)) void settle(record, { status: 'completed', runId: record.runId, threadId, finalMessage, usage }).then(() => publish({ kind: 'run.completed', threadId, runId: record.runId, finalMessage, at: Date.now() })); }
    else if (event.type === 'error' || event.type === 'interrupted') { const code = event.type === 'interrupted' ? 'RUN_INTERRUPTED' : 'RUN_FAILED'; for (const record of activeRuns(threadId)) { const error = publicFailure(code); void settle(record, { status: 'failed', runId: record.runId, threadId, error }).then(() => publish({ kind: 'run.failed', threadId, runId: record.runId, error, at: Date.now() })); } }
    else if (event.type === 'thread_deleted') publish({ kind: 'thread.removed', threadId, at: Date.now() });
  });
  const send = async (threadId: string, input: SendInput): Promise<{ readonly runId: string }> => {
    guard(); if (!deps.getThread(threadId)) throw new ClaudeThreadsApiError('THREAD_NOT_FOUND', 'Thread not found.');
    const prompt = boundedString(input.prompt, 'prompt', MAX_PROMPT_LENGTH, true)!;
    const key = correlationKey('send', input, threadId); const fp = await fingerprint({ threadId, prompt });
    return serialize(key ?? `thread:${threadId}`, async () => {
      const prior = key ? correlatedId(persisted.sends[key], fp) : undefined; if (prior) return freeze({ runId: prior });
      if (activeRuns(threadId).length > 0 || deps.isRunning(threadId)) throw new ClaudeThreadsApiError('THREAD_BUSY', 'Thread is already running.');
      const runId = crypto.randomUUID(); const record: RunRecord = { runId, threadId, waiters: new Set() }; runs.set(runId, record);
      persisted.runs[runId] = freeze({ status: 'running', runId, threadId }); if (key) persisted.sends[key] = freeze({ resourceId: runId, fingerprint: fp }); await saveState();
      const ids = runIdsByThread.get(threadId) ?? new Set<string>(); ids.add(runId); runIdsByThread.set(threadId, ids); latestRunByThread.set(threadId, runId);
      publish({ kind: 'run.started', threadId, runId, at: Date.now() });
      try { await deps.sendMessage(threadId, prompt); } catch { const error = publicFailure('RUN_FAILED'); await settle(record, { status: 'failed', runId, threadId, error }); publish({ kind: 'run.failed', threadId, runId, error, at: Date.now() }); }
      return freeze({ runId });
    });
  };
  const cancel = async (runId: string): Promise<Exclude<RunResult, { status: 'timed_out' }>> => { guard(); const record = runs.get(runId); if (!record) throw new ClaudeThreadsApiError('RUN_NOT_FOUND', 'Run not found.'); if (record.result) return record.result; await deps.interruptThread?.(record.threadId); const error = publicFailure('RUN_INTERRUPTED'); const result = freeze({ status: 'failed' as const, runId, threadId: record.threadId, error }); const terminal = await settle(record, result); publish({ kind: 'run.failed', threadId: record.threadId, runId, error, at: Date.now() }); return terminal; };
  const wait = async (runId: string, options?: WaitOptions): Promise<RunResult> => {
    guard(); const record = runs.get(runId); if (!record) throw new ClaudeThreadsApiError('RUN_NOT_FOUND', 'Run not found.'); if (record.result) { await persistReconciliation(); return record.result; }
    const timeoutMs = boundedTimeout(options?.timeoutMs);
    return new Promise(resolve => { let done = false; const settleWait = (result: Exclude<RunResult, { status: 'timed_out' }>) => { if (done) return; done = true; clearTimeout(timer); record.waiters.delete(settleWait); resolve(result); }; const timer = setTimeout(() => { if (done) return; done = true; record.waiters.delete(settleWait); resolve(freeze({ status: 'timed_out', runId, threadId: record.threadId })); }, timeoutMs); record.waiters.add(settleWait); });
  };
  const list = async (query?: ThreadQuery): Promise<readonly ThreadSummary[]> => { guard(); let values = deps.getThreads(); if (query?.projectId !== undefined) values = values.filter(thread => (thread.projectId ?? null) === query.projectId); if (query?.status) values = values.filter(thread => (thread.status ?? 'waiting') === query.status); if (query?.limit !== undefined) values = values.slice(0, Math.max(0, Math.floor(query.limit))); return freeze(values.map(thread => snapshotSummary(thread, deps.isRunning(thread.id)))); };
  const get = async (threadId: string): Promise<ThreadSnapshot | null> => { guard(); const thread = deps.getThread(threadId); return thread ? snapshotThread(thread, deps.isRunning(threadId)) : null; };
  const listTraceSources = async (options?: { readonly cursor?: string; readonly limit?: number }): Promise<TraceSourcePage> => {
    guard();
    const limit = positiveLimit(options?.limit, 100);
    const values = deps.getThreads().filter(thread => !thread.origin).sort((a, b) => a.id.localeCompare(b.id));
    const after = parseSourcePageCursor(options?.cursor);
    const start = after === undefined ? 0 : values.findIndex(thread => thread.id > after);
    if (after !== undefined && start < 0) return freeze({ sources: [], eof: true });
    const page = values.slice(start, start + limit);
    const sources: TraceSource[] = [];
    for (const thread of page) {
      const metadata = await deps.getTraceMetadata?.(thread.id);
      if (!metadata) continue;
      sources.push(freeze({ sourceId: thread.id, threadId: thread.id, projectId: thread.projectId, harness: thread.agentHarness ?? 'claude', revision: metadata.revision, contentHash: metadata.contentHash, byteLength: metadata.byteLength, updatedAt: metadata.updatedAt }));
    }
    const next = start + page.length;
    return freeze({ sources, nextCursor: next < values.length && page.length ? sourcePageCursor(page.at(-1)!.id) : undefined, eof: next >= values.length });
  };
  const MAX_SESSION_SKILL_ATTRIBUTIONS = 128;
  const MAX_RETAINED_SKILL_ATTRIBUTIONS = 512;
  const MAX_INFLIGHT_SOURCE_PROJECTIONS = 32;
  interface ProjectionState { revision: string; registryFingerprint: string; byteOffset: number; eventIndex: number; overflowed: boolean; pending: Map<string, { skill: string; index: number }>; loaded: Array<{ skill: string; index: number }>; sessionAttributionIndexes: Set<number>; attributions: Map<number, { skill: string; loaded: boolean }>; terminals: Map<number, readonly SkillRunOutcome[]> }
  const projectionStates = new Map<string, ProjectionState>();
  const projectionTails = new Map<string, Promise<ProjectionState>>();
  const advanceProjection = async (sourceId: string, revision: string, endByteOffset: number, registeredNames: readonly string[]): Promise<ProjectionState> => {
    const registryFingerprint = JSON.stringify([...new Set(registeredNames.map(name => name.trim()).filter(Boolean))].sort());
    let state = projectionStates.get(sourceId);
    if (!state || state.revision !== revision || state.registryFingerprint !== registryFingerprint || state.byteOffset > endByteOffset) {
      if (!state && projectionStates.size >= 100) projectionStates.delete(projectionStates.keys().next().value!);
      state = { revision, registryFingerprint, byteOffset: 0, eventIndex: 0, overflowed: false, pending: new Map(), loaded: [], sessionAttributionIndexes: new Set(), attributions: new Map(), terminals: new Map() }; projectionStates.set(sourceId, state);
    } else { projectionStates.delete(sourceId); projectionStates.set(sourceId, state); }
    const registered = new Set(registeredNames.map(name => name.trim()).filter(Boolean));
    while (state.byteOffset < endByteOffset) {
      const page = await deps.readTraceChunk?.(sourceId, { byteOffset: state.byteOffset, eventIndex: state.eventIndex, limit: 500 });
      if (!page || page.nextByteOffset <= state.byteOffset) throw new ClaudeThreadsApiError('CURSOR_INVALID', 'The trace source could not make forward progress.');
      page.entries.forEach((entry, offset) => {
        const index = state!.eventIndex + offset;
        if (entry.type === 'session_start') { state!.pending.clear(); state!.loaded = []; state!.sessionAttributionIndexes.clear(); state!.overflowed = false; }
        for (const candidate of traceContent(entry.event)) {
          if (!candidate || typeof candidate !== 'object') continue; const block = candidate as Record<string, unknown>;
          if (block.type === 'tool_use' && block.name === 'Skill' && typeof block.id === 'string' && block.input && typeof block.input === 'object') {
            const skill = (block.input as Record<string, unknown>).skill;
            if (!state!.overflowed && typeof skill === 'string' && registered.has(skill.trim())) {
              if (!state!.pending.has(block.id) && state!.pending.size >= MAX_SESSION_SKILL_ATTRIBUTIONS) { state!.pending.clear(); state!.loaded = []; for (const attributedIndex of state!.sessionAttributionIndexes) state!.attributions.delete(attributedIndex); state!.sessionAttributionIndexes.clear(); state!.overflowed = true; }
              else state!.pending.set(block.id, { skill: skill.trim(), index });
            }
          } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            const pending = state!.pending.get(block.tool_use_id); state!.pending.delete(block.tool_use_id);
            if (!state!.overflowed && pending && block.is_error !== true) {
              if (state!.loaded.length >= MAX_SESSION_SKILL_ATTRIBUTIONS) { state!.pending.clear(); state!.loaded = []; for (const attributedIndex of state!.sessionAttributionIndexes) state!.attributions.delete(attributedIndex); state!.sessionAttributionIndexes.clear(); state!.overflowed = true; }
              else {
                state!.loaded.push(pending); state!.attributions.set(pending.index, { skill: pending.skill, loaded: false }); state!.attributions.set(index, { skill: pending.skill, loaded: true }); state!.sessionAttributionIndexes.add(pending.index); state!.sessionAttributionIndexes.add(index);
                while (state!.attributions.size > MAX_RETAINED_SKILL_ATTRIBUTIONS) { const oldest = state!.attributions.keys().next().value!; state!.attributions.delete(oldest); state!.sessionAttributionIndexes.delete(oldest); }
              }
            }
          }
        }
        if (entry.type === 'result') {
          const result = entry.event && typeof entry.event === 'object' ? entry.event as Record<string, unknown> : {};
          const runOutcome = result.subtype === 'success' && result.is_error !== true ? 'success' as const : 'failure' as const;
          state!.terminals.set(index, state!.overflowed ? freeze([]) : freeze(state!.loaded.map(item => freeze({ invokedSkill: item.skill, runOutcome, invocationIndex: item.index }))));
          while (state!.terminals.size > 500) state!.terminals.delete(state!.terminals.keys().next().value!);
          state!.pending.clear(); state!.loaded = []; state!.sessionAttributionIndexes.clear(); state!.overflowed = false;
        }
      });
      state.byteOffset = page.nextByteOffset; state.eventIndex = page.nextEventIndex;
    }
    return state;
  };
  const ensureProjection = async (sourceId: string, revision: string, endByteOffset: number, registeredNames: readonly string[]): Promise<ProjectionState> => {
    if (!projectionTails.has(sourceId) && projectionTails.size >= MAX_INFLIGHT_SOURCE_PROJECTIONS) throw new ClaudeThreadsApiError('RUN_FAILED', 'Trace projection capacity is temporarily exhausted.');
    const waitForPrior: Promise<unknown> = projectionTails.get(sourceId)?.catch(() => undefined) ?? Promise.resolve();
    const current = waitForPrior.then(() => advanceProjection(sourceId, revision, endByteOffset, registeredNames));
    projectionTails.set(sourceId, current);
    try { return await current; } finally { if (projectionTails.get(sourceId) === current) projectionTails.delete(sourceId); }
  };
  const readTraceChunk = async (sourceId: string, options?: { readonly cursor?: string; readonly limit?: number }): Promise<TraceChunk> => {
    guard();
    const thread = deps.getThread(sourceId);
    if (!thread || thread.origin) throw new ClaudeThreadsApiError('TRACE_NOT_FOUND', 'Trace source not found.');
    const limit = positiveLimit(options?.limit, 100);
    const metadata = await deps.getTraceMetadata?.(sourceId);
    if (!metadata) throw new ClaudeThreadsApiError('TRACE_NOT_FOUND', 'Trace source not found.');
    const position = parseTraceCursor(options?.cursor, sourceId, metadata.revision);
    let raw: RawLogTraceChunk | null;
    try { raw = await deps.readTraceChunk?.(sourceId, { ...position, limit }) ?? null; }
    catch (error) { if (error instanceof RangeError) throw new ClaudeThreadsApiError('CURSOR_INVALID', 'The trace cursor is invalid or stale.'); throw error; }
    if (!raw) throw new ClaudeThreadsApiError('TRACE_NOT_FOUND', 'Trace source not found.');
    if (raw.metadata.revision !== metadata.revision) throw new ClaudeThreadsApiError('CURSOR_INVALID', 'The trace cursor is invalid or stale.');
    if (position.boundaryHash !== undefined && raw.startBoundaryHash !== position.boundaryHash) throw new ClaudeThreadsApiError('CURSOR_INVALID', 'The trace cursor is invalid or stale.');
    const lookahead = raw.eof ? null : await deps.readTraceChunk?.(sourceId, { byteOffset: raw.nextByteOffset, eventIndex: raw.nextEventIndex, limit: 32 }) ?? null;
    const registeredNames = await deps.getRegisteredSkillNames?.() ?? [];
    const projection = await ensureProjection(sourceId, metadata.revision, lookahead?.nextByteOffset ?? raw.nextByteOffset, registeredNames);
    const secrets = deps.getRedactionSecrets?.() ?? [];
    const events = raw.entries.map((entry, offset) => {
      const type = String(entry.type ?? 'unknown');
      const index = position.eventIndex + offset;
      const attribution = projection.attributions.get(index);
      return freeze({ index, timestamp: String(entry.ts ?? ''), type, ...(attribution ? { invokedSkill: attribution.skill } : {}), ...(attribution?.loaded ? { skillLoadOutcome: 'loaded' as const } : {}), ...((type === 'result') ? { skillRunOutcomes: projection.terminals.get(index) ?? [] } : {}), data: projectTraceData(type, entry.event, secrets) });
    });
    return freeze({ sourceId, revision: metadata.revision, contentHash: raw.metadata.contentHash, cursor: options?.cursor, nextCursor: traceCursor(sourceId, metadata.revision, raw.nextByteOffset, raw.nextEventIndex, raw.nextBoundaryHash), eof: raw.eof, events });
  };
  const settleConstrained = async (runId: string, result: ConstrainedRunResult): Promise<ConstrainedRunResult> => {
    const current = persisted.constrained[runId];
    if (current && current.status !== 'running') return current;
    persisted.constrained[runId] = result; await saveState();
    for (const waiter of [...(constrainedWaiters.get(runId) ?? [])]) waiter(result);
    constrainedWaiters.delete(runId); constrainedControllers.delete(runId); return result;
  };
  const createConstrained = async (input: ConstrainedRunInput): Promise<{ readonly runId: string }> => {
    guard();
    if (input.harness !== 'claude' || input.maxTurns !== 1) throw new ClaudeThreadsApiError('CONSTRAINT_UNSUPPORTED', 'Only bounded, one-turn Claude input-only runs are supported.');
    const model = boundedString(input.model, 'model', MAX_MODEL_LENGTH, true)!;
    const systemInstructions = boundedString(input.systemInstructions, 'systemInstructions', MAX_SYSTEM_LENGTH, true)!;
    const prompt = boundedString(input.prompt, 'prompt', MAX_PROMPT_LENGTH, true)!;
    if (!Number.isFinite(input.maxBudgetUsd) || input.maxBudgetUsd <= 0 || input.maxBudgetUsd > MAX_BUDGET_USD) throw new ClaudeThreadsApiError('INVALID_ARGUMENT', `maxBudgetUsd must be finite and at most ${MAX_BUDGET_USD}.`);
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > MAX_TIMEOUT_MS) throw new ClaudeThreadsApiError('INVALID_ARGUMENT', `timeoutMs must be finite and at most ${MAX_TIMEOUT_MS}.`);
    if (!deps.runConstrainedQuery) throw new ClaudeThreadsApiError('CONSTRAINT_UNSUPPORTED', 'This host cannot enforce constrained execution.');
    const runConstrainedQuery = deps.runConstrainedQuery;
    const key = correlationKey('constrained', input)!; const fp = await fingerprint({ model, systemInstructions, prompt, maxTurns: 1, maxBudgetUsd: input.maxBudgetUsd, timeoutMs: input.timeoutMs });
    return serialize(key, async () => {
      const prior = correlatedId(persisted.constrainedKeys[key], fp); if (prior) return freeze({ runId: prior });
      const runId = crypto.randomUUID(); persisted.constrainedKeys[key] = freeze({ resourceId: runId, fingerprint: fp }); persisted.constrained[runId] = freeze({ status: 'running', runId }); await saveState();
      const controller = new AbortController(); constrainedControllers.set(runId, controller);
      void runConstrainedQuery({ prompt, options: { model, systemInstructions, maxTurns: 1, maxBudgetUsd: input.maxBudgetUsd, timeoutMs: input.timeoutMs }, signal: controller.signal })
        .then(result => settleConstrained(runId, freeze({ status: 'completed', runId, output: result.output, model, usage: result.usage })))
        .catch(() => { const cancelled = controller.signal.aborted; return settleConstrained(runId, freeze({ status: cancelled ? 'cancelled' : 'failed', runId, error: publicFailure(cancelled ? 'RUN_INTERRUPTED' : 'RUN_FAILED') })); });
      return freeze({ runId });
    });
  };
  const getConstrained = async (runId: string): Promise<ConstrainedRunResult> => { guard(); const result = persisted.constrained[runId]; if (!result) throw new ClaudeThreadsApiError('RUN_NOT_FOUND', 'Run not found.'); await persistReconciliation(); return freeze(structuredClone(result)); };
  const waitConstrained = async (runId: string, options?: WaitOptions): Promise<ConstrainedRunResult> => { const current = await getConstrained(runId); if (current.status !== 'running') return current; const timeoutMs = boundedTimeout(options?.timeoutMs); return new Promise(resolve => { let done = false; const finish = (result: ConstrainedRunResult) => { if (done) return; done = true; clearTimeout(timer); constrainedWaiters.get(runId)?.delete(finish); resolve(result); }; const timer = setTimeout(() => finish(freeze({ status: 'running', runId })), timeoutMs); const waiters = constrainedWaiters.get(runId) ?? new Set(); waiters.add(finish); constrainedWaiters.set(runId, waiters); const latest = persisted.constrained[runId]; if (latest?.status !== 'running') finish(latest); }); };
  const cancelConstrained = async (runId: string): Promise<ConstrainedRunResult> => { const current = await getConstrained(runId); if (current.status !== 'running') return current; constrainedControllers.get(runId)?.abort(); return settleConstrained(runId, freeze({ status: 'cancelled' as const, runId, error: publicFailure('RUN_INTERRUPTED') })); };
  const executeTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    try {
      if (name === 'ct_send_message') { const threadId = String(args.thread_id ?? '').trim(); const { runId } = await send(threadId, { prompt: String(args.message ?? '').trim() }); if (args.wait === false) return `Message sent to thread ${threadId}. Running in the background.`; return formatRunResult(await wait(runId, { timeoutMs: toolTimeout(args) })); }
      if (name === 'ct_new_thread') { const prompt = String(args.message ?? '').trim(); if (!prompt) throw new ClaudeThreadsApiError('INVALID_ARGUMENT', 'message is required.'); const created = await api.threads.create({ title: String(args.title_hint ?? prompt).slice(0, 50) }); const { runId } = await send(created.threadId, { prompt }); if (args.wait === false) return `New thread started (id: ${created.threadId}). Running in the background.`; return formatRunResult(await wait(runId, { timeoutMs: toolTimeout(args) })); }
      if (name === 'ct_wait_for_thread') { const threadId = String(args.thread_id ?? '').trim(); const thread = deps.getThread(threadId); if (!thread) throw new ClaudeThreadsApiError('THREAD_NOT_FOUND', `Thread not found: ${threadId}`); const runId = latestRunByThread.get(threadId); return runId ? formatRunResult(await wait(runId, { timeoutMs: toolTimeout(args) })) : formatFinishedThread(thread); }
      if (name === 'ct_get_thread') { const threadId = String(args.thread_id ?? '').trim(); const thread = await get(threadId); if (!thread) throw new ClaudeThreadsApiError('THREAD_NOT_FOUND', `Thread not found: ${threadId}`); const lastN = Math.min(Math.max(1, Number(args.last_n) || 5), 20); return JSON.stringify({ ...thread, messages: thread.messages.slice(-lastN) }, null, 2); }
      if (name === 'ct_list_threads') { const status = String(args.status ?? 'all'); const limit = Math.min(Math.max(1, Number(args.limit) || 15), 30); let threads = [...await list()].sort((a, b) => b.updatedAt - a.updatedAt); threads = threads.filter(thread => toolStatus(thread) === status || status === 'all' || (status === 'waiting' && thread.status === 'waiting')).slice(0, limit); return JSON.stringify({ count: threads.length, threads }, null, 2); }
      if (name === 'ct_open_thread') { const threadId = String(args.thread_id ?? '').trim(); await api.threads.open(threadId); return `Opened thread ${threadId} in the Agent Threads panel.`; }
      return `Error: Agent Threads tool "${name}" is not available in public API v1.`;
    } catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}`; }
  };
  const registerMcp = async (input: McpRegisterInput): Promise<McpRegistrationResult> => {
    guard();
    if (!deps.registerMcpServer) {
      return freeze({ success: false, status: 'unavailable', message: 'MCP registration is not available in this host context.' });
    }
    return freeze(await deps.registerMcpServer(input));
  };
  const requestSecretMcp = async (input: RequestSecretInput): Promise<RequestSecretResult> => {
    guard();
    const secretName = boundedString(input.secretName, 'secretName', MAX_SECRET_NAME_LENGTH, true)!;
    const reason = boundedString(input.reason, 'reason', MAX_SECRET_REASON_LENGTH, true)!;
    const varName = secretName.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!deps.requestSecret) {
      return freeze({ success: false, reason: 'Secret request UI is not available in this context.' });
    }
    if (!input.force && deps.hasSecret?.(varName)) {
      return freeze({ success: true, secretName: varName, alreadyExisted: true });
    }
    const saved = await deps.requestSecret(varName, reason, !!input.force);
    if (saved) return freeze({ success: true, secretName: varName, alreadyExisted: false });
    return freeze({ success: false, reason: 'The user did not save the secret.' });
  };
  const artifactRegistrations = new Set<{ dispose: () => void }>();
  const registerArtifactProvider = (owner: PeerIdentity, contribution: ArtifactContribution): ArtifactRegistrationResult => {
    guard();
    const registry = deps.artifactProviders;
    if (!registry) {
      return freeze({ success: false as const, status: 'invalid' as const, providerId: String(contribution?.providerId ?? ''), message: 'Artifact contributions are not available in this host context.', dispose: () => {} });
    }
    const result = registry.register(owner, contribution);
    if (!result.success) return freeze(result);
    // Tracked so stop() can drop it the way event listeners are dropped; a
    // plugin reload must never leave a provider bound to a dead generation.
    const tracked = { dispose: result.dispose };
    artifactRegistrations.add(tracked);
    return freeze({
      success: true as const, status: 'registered' as const, providerId: result.providerId,
      dispose: () => { artifactRegistrations.delete(tracked); result.dispose(); },
    });
  };

  // --- artifacts -----------------------------------------------------------
  // Everything below returns a structured result and never throws for an
  // input the caller could plausibly get wrong, so a peer branches on `status`
  // instead of pattern-matching an exception (the `mcp.register` precedent).

  type ArtifactFailure = Extract<ArtifactMutationResult, { success: false }>['status'];
  type AuthorizationFailure = 'invalid' | 'conflict' | 'unknown-provider';

  // Generic in the status literal so one helper serves both the attach and the
  // mutation union without widening either.
  const artifactFailure = <S extends ArtifactFailure>(artifactId: string, status: S, message: string) =>
    freeze({ success: false as const, status, artifactId, message });

  /** Resolves the owner/provider pair, or the reason the pair is not usable. */
  const authorizeProvider = (
    owner: PeerIdentity | undefined,
    providerId: unknown,
    artifactId: string,
  ): { ok: true; providerId: string } | { ok: false; failure: ReturnType<typeof artifactFailure<AuthorizationFailure>> } => {
    const registry = deps.artifactProviders!;
    const pluginId = typeof owner?.pluginId === 'string' ? owner.pluginId.trim() : '';
    if (!pluginId || pluginId.length > MAX_OWNER_LENGTH) {
      return { ok: false, failure: artifactFailure(artifactId, 'invalid', 'owner.pluginId must be a non-empty string.') };
    }
    const id = typeof providerId === 'string' ? providerId.trim() : '';
    if (!id || !PROVIDER_ID_PATTERN.test(id)) {
      return { ok: false, failure: artifactFailure(artifactId, 'invalid', 'providerId must be namespaced, e.g. "my-plugin.artifacts".') };
    }
    const registered = registry.ownerOf(id);
    if (!registered) {
      return { ok: false, failure: artifactFailure(artifactId, 'unknown-provider', `No artifact provider is registered for "${id}".`) };
    }
    if (registered.pluginId !== pluginId) {
      // The whole point of namespaced providers: one plugin cannot write
      // artifacts into another plugin's namespace, deliberately or by typo.
      return { ok: false, failure: artifactFailure(artifactId, 'conflict', `"${id}" is registered by "${registered.pluginId}", not "${pluginId}".`) };
    }
    return { ok: true, providerId: id };
  };

  /**
   * Provider data is opaque but still persisted into the host's own settings
   * file, so it must be JSON-representable and bounded. The round-trip also
   * drops functions and prototypes a peer might otherwise smuggle into state.
   */
  const artifactData = (value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } => {
    if (value === undefined || value === null) return { ok: true, value: {} };
    if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, message: 'data must be a plain object.' };
    let serialized: string | undefined;
    try { serialized = JSON.stringify(value); } catch { serialized = undefined; }
    if (serialized === undefined) return { ok: false, message: 'data must be JSON-serializable.' };
    if (new TextEncoder().encode(serialized).byteLength > MAX_ARTIFACT_DATA_BYTES) {
      return { ok: false, message: `data must serialize to no more than ${MAX_ARTIFACT_DATA_BYTES} bytes.` };
    }
    return { ok: true, value: JSON.parse(serialized) as Record<string, unknown> };
  };

  /** Drops host-owned identity, so provider data can never rewrite it. */
  const providerFields = (data: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(data).filter(([key]) => !HOST_OWNED_ARTIFACT_FIELDS.includes(key)));

  const listArtifacts = async (threadId: string): Promise<readonly ThreadArtifactRef[]> => {
    guard();
    const stored = deps.artifactStore?.list(threadId);
    return freeze((stored ?? []).map(toArtifactRef));
  };

  const attachArtifact = async (owner: PeerIdentity, threadId: string, ref: ThreadArtifactRef): Promise<ArtifactAttachResult> => {
    guard();
    const artifactId = typeof ref?.id === 'string' ? ref.id.trim() : '';
    const store = deps.artifactStore;
    if (!store || !deps.artifactProviders) {
      return artifactFailure(artifactId, 'unavailable', 'Artifact attachment is not available in this host context.');
    }
    if (!artifactId || artifactId.length > MAX_ARTIFACT_ID_LENGTH) {
      return artifactFailure(artifactId, 'invalid', `id must contain 1-${MAX_ARTIFACT_ID_LENGTH} characters.`);
    }
    const authorized = authorizeProvider(owner, ref?.providerId, artifactId);
    if (!authorized.ok) return authorized.failure;

    const kind = typeof ref?.kind === 'string' ? ref.kind.trim() : '';
    if (!kind || kind.length > MAX_ARTIFACT_KIND_LENGTH) {
      return artifactFailure(artifactId, 'invalid', `kind must contain 1-${MAX_ARTIFACT_KIND_LENGTH} characters.`);
    }
    if (!(deps.artifactProviders.kindsOf(authorized.providerId) ?? []).includes(kind)) {
      return artifactFailure(artifactId, 'invalid', `"${authorized.providerId}" did not declare the artifact kind "${kind}".`);
    }
    const title = typeof ref?.title === 'string' ? ref.title.trim() : '';
    if (!title || title.length > MAX_ARTIFACT_TITLE_LENGTH) {
      return artifactFailure(artifactId, 'invalid', `title must contain 1-${MAX_ARTIFACT_TITLE_LENGTH} characters.`);
    }
    const schemaVersion = ref?.schemaVersion ?? 1;
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
      return artifactFailure(artifactId, 'invalid', 'schemaVersion must be a positive integer.');
    }
    let storageRoot: string | undefined;
    if (ref?.storageRoot !== undefined) {
      const resolved = store.resolveStorageRoot(ref.storageRoot);
      // Never silently drop a rejected root and attach anyway: an artifact
      // whose storage the host cannot safely collect must not be created.
      if (resolved.status !== 'ok') return artifactFailure(artifactId, 'invalid', resolved.message);
      storageRoot = resolved.path;
    }
    const data = artifactData(ref?.data);
    if (!data.ok) return artifactFailure(artifactId, 'invalid', data.message);

    const now = Date.now();
    const record: ThreadArtifactRecord = {
      // Provider fields first; host-owned identity below always wins.
      ...providerFields(data.value),
      id: artifactId, kind, title, providerId: authorized.providerId, schemaVersion,
      ...(storageRoot ? { storageRoot } : {}),
      createdAt: now, updatedAt: now,
    };
    const outcome = await store.put(threadId, record);
    if (outcome === 'thread-not-found') return artifactFailure(artifactId, 'thread-not-found', `Thread not found: ${threadId}`);
    return freeze({ success: true as const, status: outcome, artifactId });
  };

  const updateArtifact = async (owner: PeerIdentity, threadId: string, artifactId: string, patch: ArtifactPatch): Promise<ArtifactMutationResult> => {
    guard();
    const id = typeof artifactId === 'string' ? artifactId.trim() : '';
    const store = deps.artifactStore;
    if (!store || !deps.artifactProviders) {
      return artifactFailure(id, 'unavailable', 'Artifact updates are not available in this host context.');
    }
    const stored = store.list(threadId);
    if (!stored) return artifactFailure(id, 'thread-not-found', `Thread not found: ${threadId}`);
    const existing = stored.find(candidate => candidate.id === id);
    if (!existing) return artifactFailure(id, 'artifact-not-found', `Artifact not found: ${id}`);
    const authorized = authorizeProvider(owner, existing.providerId, id);
    if (!authorized.ok) return authorized.failure;

    const next: ThreadArtifactRecord = { ...existing };
    if (patch?.title !== undefined) {
      const title = typeof patch.title === 'string' ? patch.title.trim() : '';
      if (!title || title.length > MAX_ARTIFACT_TITLE_LENGTH) {
        return artifactFailure(id, 'invalid', `title must contain 1-${MAX_ARTIFACT_TITLE_LENGTH} characters.`);
      }
      next.title = title;
    }
    if (patch?.data !== undefined) {
      const data = artifactData(patch.data);
      if (!data.ok) return artifactFailure(id, 'invalid', data.message);
      Object.assign(next, providerFields(data.value));
    }
    if (patch?.storageRoot !== undefined) {
      const resolved = store.resolveStorageRoot(patch.storageRoot);
      if (resolved.status !== 'ok') return artifactFailure(id, 'invalid', resolved.message);
      next.storageRoot = resolved.path;
    }
    next.updatedAt = Date.now();
    const outcome = await store.put(threadId, next);
    if (outcome === 'thread-not-found') return artifactFailure(id, 'thread-not-found', `Thread not found: ${threadId}`);
    return freeze({ success: true as const, status: 'updated' as const, artifactId: id });
  };

  const detachArtifact = async (owner: PeerIdentity, threadId: string, artifactId: string): Promise<ArtifactMutationResult> => {
    guard();
    const id = typeof artifactId === 'string' ? artifactId.trim() : '';
    const store = deps.artifactStore;
    if (!store || !deps.artifactProviders) {
      return artifactFailure(id, 'unavailable', 'Artifact detachment is not available in this host context.');
    }
    const stored = store.list(threadId);
    if (!stored) return artifactFailure(id, 'thread-not-found', `Thread not found: ${threadId}`);
    const existing = stored.find(candidate => candidate.id === id);
    if (!existing) return artifactFailure(id, 'artifact-not-found', `Artifact not found: ${id}`);
    const authorized = authorizeProvider(owner, existing.providerId, id);
    if (!authorized.ok) return authorized.failure;
    const outcome = await store.detach(threadId, id);
    if (outcome === 'thread-not-found') return artifactFailure(id, 'thread-not-found', `Thread not found: ${threadId}`);
    if (outcome === 'artifact-not-found') return artifactFailure(id, 'artifact-not-found', `Artifact not found: ${id}`);
    return freeze({ success: true as const, status: 'detached' as const, artifactId: id });
  };

  /**
   * Deliberately ownerless. Invoking an action runs the *owning* provider's
   * own code against its own artifact, which is exactly what a user clicking
   * the card does; gating it on caller identity would buy nothing, since both
   * plugins are trusted in-process code either way (ADR-0008).
   */
  const invokeArtifactAction = async (threadId: string, artifactId: string, actionId: string): Promise<ArtifactActionResult> => {
    guard();
    const store = deps.artifactStore;
    if (!store) return freeze({ status: 'error' as const, message: 'Artifact actions are not available in this host context.' });
    const id = typeof artifactId === 'string' ? artifactId.trim() : '';
    const action = typeof actionId === 'string' ? actionId.trim() : '';
    if (!action) return freeze({ status: 'error' as const, message: 'actionId must be a non-empty string.' });
    const stored = store.list(threadId);
    if (!stored) return freeze({ status: 'error' as const, message: `Thread not found: ${threadId}` });
    if (!stored.some(candidate => candidate.id === id)) {
      return freeze({ status: 'error' as const, message: `Artifact not found: ${id}` });
    }
    // Same entry point the card click uses, so provider isolation, the invoke
    // timeout and the result shape cannot drift between the two callers.
    return freeze(await store.invokeAction(threadId, id, action));
  };

  const api: ClaudeThreadsApiV1 = freeze({ apiVersion: 1 as const, generation, capabilities: computeCapabilities(deps),
    threads: { list, get, create: async (input: CreateThreadInput) => { guard(); const key = correlationKey('create', input); const owner = boundedString(input.ownerPluginId, 'ownerPluginId', MAX_OWNER_LENGTH); const explicitOrigin = boundedString(input.origin, 'origin', MAX_OWNER_LENGTH); if (owner && explicitOrigin && owner !== explicitOrigin) throw new ClaudeThreadsApiError('INVALID_ARGUMENT', 'origin must match ownerPluginId.'); const normalized = { ...input, title: boundedString(input.title, 'title', 512), origin: explicitOrigin ?? owner, externalJobId: boundedString(input.externalJobId, 'externalJobId', MAX_KEY_LENGTH) }; const fp = await fingerprint(normalized); return serialize(key ?? `create:${crypto.randomUUID()}`, async () => { const prior = key ? correlatedId(persisted.creates[key], fp) : undefined; if (prior && deps.getThread(prior)) return freeze({ threadId: prior }); const thread = await deps.createThread(normalized); if (key) { persisted.creates[key] = freeze({ resourceId: thread.id, fingerprint: fp }); await saveState(); } return freeze({ threadId: thread.id }); }); }, send, wait, cancel,
      open: async (threadId: string) => { guard(); if (!deps.getThread(threadId)) throw new ClaudeThreadsApiError('THREAD_NOT_FOUND', 'Thread not found.'); await deps.openThread(threadId); },
      subscribe: (listener: (event: PublicThreadEvent) => void) => { guard(); listeners.add(listener); let disposed = false; return freeze({ dispose: () => { if (disposed) return; disposed = true; listeners.delete(listener); } }); } },
    traces: { listSources: listTraceSources, readChunk: readTraceChunk, subscribe: (listener: (event: PublicTraceEvent) => void) => { guard(); traceListeners.add(listener); let disposed = false; return freeze({ dispose: () => { if (disposed) return; disposed = true; traceListeners.delete(listener); } }); } },
    constrainedRuns: { create: createConstrained, get: getConstrained, wait: waitConstrained, cancel: cancelConstrained },
    orchestrators: { list: async () => { guard(); return freeze(deps.listOrchestrators().map(item => freeze({ ...item }))); }, dispatch: async (target, input) => { guard(); const threadId = await deps.resolveOrchestrator(target); if (!threadId || !deps.getThread(threadId)) throw new ClaudeThreadsApiError('ORCHESTRATOR_NOT_FOUND', `Orchestrator not found: ${target.id}`); return send(threadId, input); } },
    agentTools: { createBundle: (profile) => { guard(); if (profile !== 'voice-orchestration') throw new ClaudeThreadsApiError('INVALID_ARGUMENT', `Unknown tool profile: ${String(profile)}`); return freeze({ tools: VOICE_TOOLS, execute: executeTool }); } },
    mcp: { register: registerMcp, requestSecret: requestSecretMcp },
    extensions: { registerArtifactProvider },
    artifacts: { list: listArtifacts, attach: attachArtifact, update: updateArtifact, detach: detachArtifact, invokeAction: invokeArtifactAction },
  });
  return { api, start: () => { guard(); if (started) return; started = true; deps.triggerHostEvent('claude-threads:api-ready', { apiVersion: 1, generation }); },
    stop: () => { if (stopped) return; stopped = true; active = false; deps.triggerHostEvent('claude-threads:api-stopping', { apiVersion: 1, generation }); unsubscribeInternal(); listeners.clear(); traceListeners.clear(); for (const registration of [...artifactRegistrations]) registration.dispose(); artifactRegistrations.clear(); for (const [runId, controller] of constrainedControllers) { controller.abort(); void settleConstrained(runId, freeze({ status: 'failed', runId, error: publicFailure('PLUGIN_UNAVAILABLE') })); } for (const record of runs.values()) if (!record.result) void settle(record, { status: 'failed', runId: record.runId, threadId: record.threadId, error: publicFailure('PLUGIN_UNAVAILABLE') }); } };
}

function toolTimeout(args: Record<string, unknown>): number { return Math.min(Math.max(10, Number(args.timeout_secs) || 120), 300) * 1_000; }
function boundedTimeout(value: number | undefined): number { if (value === undefined) return 120_000; if (!Number.isFinite(value) || value < 1) throw new ClaudeThreadsApiError('INVALID_ARGUMENT', 'timeoutMs must be a positive finite number.'); return Math.min(Math.floor(value), MAX_TIMEOUT_MS); }
function formatRunResult(result: RunResult): string { if (result.status === 'timed_out') return `Timed out waiting for thread ${result.threadId}.`; if (result.status === 'failed') return `Thread error: ${result.error.message}`; return result.finalMessage ? `Thread finished. Last message (${result.finalMessage.role}): ${result.finalMessage.content.slice(0, 800)}` : 'Thread finished (no messages).'; }
function formatFinishedThread(thread: Thread): string { const last = thread.messages.at(-1); return last ? `Thread finished. Last message (${last.role}): ${String(last.content).slice(0, 800)}` : 'Thread finished (no messages).'; }
function toolStatus(thread: ThreadSummary): string { if (thread.isRunning) return 'active'; if (thread.status === 'waiting' && thread.messageCount > 0) return thread.reviewed ? 'waiting' : 'waiting_new'; return thread.status; }

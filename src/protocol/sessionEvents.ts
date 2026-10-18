/**
 * sessionEvents.ts
 *
 * Session events on the daemon wire (design section 3.3). The event set is
 * DERIVED from `SessionCallbacks` so the contract cannot drift: every callback
 * either becomes an event whose args are the callback's parameters (made
 * JSON-safe by `WireArgs`), becomes a request/resolve pair when a parameter is
 * not serializable (a function, an AbortSignal) or the callback returns a
 * promise the daemon must wait on, or is explicitly listed in `NOT_ON_WIRE`.
 *
 * `CALLBACK_DISPOSITION` is typed `Record<keyof SessionCallbacks, ...>`, so
 * adding a callback without classifying it is a compile error; the drift test
 * (test/unit/protocol-drift.test.ts) enforces the same at runtime from the
 * source file, which also catches a stale entry.
 */
import type { SessionCallbacks } from '../ClaudeSession';
import type { AskQuestion } from '../types';

/** `Error` does not survive JSON; it crosses the wire as this. */
export interface WireError {
  name: string;
  message: string;
  stack?: string;
}

export function toWireError(err: unknown): WireError {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  }
  return { name: 'Error', message: String(err) };
}

/** Convert one callback argument to its wire form (Errors only; the rest is JSON already). */
export function toWireArg(value: unknown): unknown {
  return value instanceof Error ? toWireError(value) : value;
}

type WireValue<T> =
  T extends Error ? WireError
  : T extends AbortSignal ? never
  : T extends (...args: never[]) => unknown ? never
  : T;

/** A callback's parameter tuple with every non-JSON parameter replaced. */
export type WireArgs<A extends readonly unknown[]> = { [I in keyof A]: WireValue<A[I]> };

/** Callbacks that never cross the wire. `onRawEvent` is the daemon's own JSONL log hook. */
export const NOT_ON_WIRE = ['onRawEvent', 'onStreamReset'] as const satisfies ReadonlyArray<keyof SessionCallbacks>;
export type NotOnWireKey = (typeof NOT_ON_WIRE)[number];

/** Wire payloads for callbacks that need explicit overrides (request/resolve pairs). */
export interface OverrideArgs {
  onPlanReady: { requestId: string; planText: string };
  onElicitation: { requestId: string; request: ElicitationRequestWire };
  onPermissionRequest: { requestId: string; toolName: string; detail: string };
  onAskUserQuestion: { requestId: string; questions: AskQuestion[] };
  onOpenNewTab: { requestId: string; title?: string; initialPrompt?: string };
}

/** The SDK's ElicitationRequest is plain JSON; typed loosely so this file needs no SDK import. */
export type ElicitationRequestWire = Record<string, unknown>;

export type OverrideKey = keyof OverrideArgs;

/** Event name each override takes on the wire, and the command that resolves it. */
export const OVERRIDES = {
  onPlanReady: { event: 'plan_ready', resolve: 'resolve.plan' },
  onElicitation: { event: 'elicitation_request', resolve: 'resolve.elicitation' },
  onPermissionRequest: { event: 'permission_request', resolve: 'resolve.permission' },
  onAskUserQuestion: { event: 'question_request', resolve: 'resolve.question' },
  onOpenNewTab: { event: 'open_tab_request', resolve: 'resolve.openTab' },
} as const satisfies Record<OverrideKey, { event: string; resolve: string }>;

export type OverrideEventName = (typeof OVERRIDES)[OverrideKey]['event'];

export type CallbackDisposition = 'event' | 'request' | 'not_on_wire';

/** Exhaustive over `keyof SessionCallbacks` by construction. */
export const CALLBACK_DISPOSITION: Record<keyof SessionCallbacks, CallbackDisposition> = {
  onToken: 'event',
  onToolUse: 'event',
  onMessage: 'event',
  onRecap: 'event',
  onDone: 'event',
  onInterrupted: 'event',
  onError: 'event',
  onReconnecting: 'event',
  onRateLimitRetry: 'event',
  onAuthRetry: 'event',
  onAuthRequired: 'event',
  onPermissionRequest: 'request',
  onAskUserQuestion: 'request',
  onAskUserQuestionCanceled: 'event',
  onOpenNewTab: 'request',
  onStatus: 'event',
  onCompact: 'event',
  onTaskStarted: 'event',
  onTaskUpdated: 'event',
  onTaskProgress: 'event',
  onTaskNotification: 'event',
  onNotification: 'event',
  onApiRetry: 'event',
  onPermissionDenied: 'event',
  onRateLimit: 'event',
  onUsage: 'event',
  onToolResultImages: 'event',
  onTaskEvent: 'event',
  onRawEvent: 'not_on_wire',
  onStreamReset: 'not_on_wire', // client-local: raised by RemoteHarnessSession on a resync
  onModelFallback: 'event',
  onActiveModel: 'event',
  onModelRefusalFallback: 'event',
  onModelRefusalNoFallback: 'event',
  onToolProgress: 'event',
  onMemoryRecall: 'event',
  onCommandsChanged: 'event',
  onMcpServerStatus: 'event',
  onTaskProgressSummary: 'event',
  onGitOperation: 'event',
  onFileUserModified: 'event',
  onFilesEdited: 'event',
  onToolResult: 'event',
  onEnterPlanMode: 'event',
  onPlanModeRequested: 'event',
  onPlanApprovalCommitted: 'event',
  onPlanTransitionError: 'event',
  onPlanReady: 'request',
  onCapabilitiesDiscovered: 'event',
  onElicitation: 'request',
};

type PlainKey = Exclude<keyof SessionCallbacks, OverrideKey | NotOnWireKey>;

/** `{ name: callbackName, args: <JSON-safe parameter tuple> }` for every plain callback. */
export type DerivedEvent = {
  [K in PlainKey]: { name: K; args: WireArgs<Parameters<NonNullable<SessionCallbacks[K]>>> };
}[PlainKey];

/** Request events for callbacks the daemon must wait on. */
export type OverrideEvent = {
  [K in OverrideKey]: { name: (typeof OVERRIDES)[K]['event']; args: OverrideArgs[K] };
}[OverrideKey];

export interface SessionStateArgs {
  turnInFlight: boolean;
  hasPendingPermission: boolean;
  /** Whether a client able to serve host tools is attached. */
  hostAttached: boolean;
  cwd?: string;
  /** Mirror of `HarnessSession.canIdleReap()` (no turn running, nothing awaiting a human). */
  canIdleReap?: boolean;
  /**
   * Set when the daemon stopped the live session: 'idle' = reaped by the idle
   * reaper, 'client' = `session.close`. History stays attachable and the next
   * `session.send` cold-resumes the native session.
   */
  closed?: 'idle' | 'client';
}

/** Events that do not originate from a `SessionCallbacks` entry. */
export type ControlEvent =
  /** Mirror of the synchronous getters on HarnessSession (not RPCs). */
  | { name: 'session.state'; args: SessionStateArgs }
  /** Closes any request id: first resolver wins; others learn who. */
  | { name: 'request_resolved'; args: { requestId: string; by?: string; outcome?: 'resolved' | 'canceled' | 'expired'; alwaysAllow?: boolean } }
  /**
   * Daemon asks the attached host to run one tool it offered in its manifest (design 3.6). `callId` is a daemon-owned
   * UUID bound to this thread: only the thread's controlling client can answer it (`tool.result`). Journaled as an
   * open request, so a client that reattaches while it is pending is shown it again.
   */
  | { name: 'tool.call'; args: { callId: string; threadId: string; server: string; tool: string; input: Record<string, unknown> } }
  | { name: 'tool.cancel'; args: { callId: string } }
  /**
   * A host tool call failed because no host could serve it (detached past the grace period, or no answer in time).
   * Journaled so a client that was away learns it afterwards and can tell the user; the model has already been told.
   */
  | { name: 'tool.unavailable'; args: { callId: string; server: string; tool: string; reason: 'detached' | 'timeout' } }
  /** The session's working directory changed (worktree tools ran on the daemon); the client mirrors it. */
  | { name: 'session.cwd'; args: { cwd: string; originRepoPath?: string | null } };

/** Everything that can ride in an `event` frame. */
export type WireEvent = DerivedEvent | OverrideEvent | ControlEvent;
/** The subset generated from `SessionCallbacks`. */
export type SessionEvent = DerivedEvent | OverrideEvent;

/** Event names that open a request which must survive disconnects. */
export const REQUEST_EVENT_NAMES: readonly string[] = [
  ...Object.values(OVERRIDES).map((o) => o.event),
  'tool.call',
];

export function isWireEvent(value: unknown): value is WireEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { name?: unknown; args?: unknown };
  return typeof v.name === 'string' && typeof v.args === 'object' && v.args !== null;
}

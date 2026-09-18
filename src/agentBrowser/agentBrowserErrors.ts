/**
 * Error vocabulary shared by the pool, the guest, and (from PR2) the MCP tools.
 *
 * Every failure the agent can see is one of these codes. The point is that the
 * model gets a stable, machine-readable reason plus a `retryable` flag, instead
 * of prose it has to interpret. Retry behaviour is the difference between an
 * agent that backs off and an agent that spins — and an agent spinning against a
 * page that reliably kills its renderer is exactly the process-churn problem
 * this feature exists to remove.
 */

export type AgentBrowserErrorCode =
  /** No `<webview>` support, or the host exposes no FD diagnostics. */
  | 'capability_unavailable'
  /** Refused because file-descriptor pressure makes a guest likely to die at launch. */
  | 'admission_denied_fd_pressure'
  /** Refused because the pool is at its guest ceiling. */
  | 'admission_denied_cap'
  /** Refused because guests are being created too quickly. */
  | 'create_rate_limited'
  /** Refused because this thread's page has repeatedly crashed. */
  | 'crash_cooldown'
  /** The guest never reached `dom-ready`. */
  | 'guest_start_timeout'
  /** The page process died. */
  | 'guest_crashed'
  /** The page stopped responding and was destroyed. */
  | 'guest_hung'
  /** The guest was recycled after exhausting a budget or its TTL. */
  | 'guest_recycled'
  /** URL policy refused the navigation. */
  | 'navigation_blocked'
  /** Navigation did not settle in time. */
  | 'navigation_timeout'
  /** An injected script did not settle in time. */
  | 'script_timeout'
  /** A screenshot did not settle in time. */
  | 'capture_timeout'
  /** Refs were produced by a different page, origin, or snapshot generation. */
  | 'stale_snapshot'
  /** The ref is unknown, or its element has left the page. */
  | 'ref_not_found'
  /** The element exists but cannot be acted on (disabled, or a refused input). */
  | 'not_actionable'
  /** Too many operations already queued against this guest. */
  | 'queue_depth_exceeded'
  /** An operation waited too long behind others. */
  | 'queue_timeout'
  /** The guest was reclaimed while this call was in flight. */
  | 'destroyed_during_call'
  /**
   * The operation failed but the page is still alive.
   *
   * Distinct from `guest_crashed` on purpose. Reporting a failed screenshot as a
   * crash tells the agent every element ref it holds is dead — which, when the
   * guest is in fact still `ready`, throws away a working session and sends it
   * back to re-navigate for no reason. Observed live: `capturePage()` on an
   * uncomposited guest rejects with `UnknownVizError` while the guest is fine.
   */
  | 'operation_failed';

export interface AgentBrowserErrorInit {
  code: AgentBrowserErrorCode;
  message: string;
  /** Whether trying again could plausibly succeed. */
  retryable: boolean;
  /** Actionable next step for the agent, when there is one. */
  hint?: string;
}

export class AgentBrowserError extends Error {
  readonly code: AgentBrowserErrorCode;
  readonly retryable: boolean;
  readonly hint?: string;

  constructor(init: AgentBrowserErrorInit) {
    super(init.message);
    this.name = 'AgentBrowserError';
    this.code = init.code;
    this.retryable = init.retryable;
    this.hint = init.hint;
  }

  toJSON(): { code: AgentBrowserErrorCode; message: string; retryable: boolean; hint?: string } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.hint ? { hint: this.hint } : {}),
    };
  }
}

export function isAgentBrowserError(value: unknown): value is AgentBrowserError {
  return value instanceof AgentBrowserError;
}

/**
 * Every element reference the agent holds is invalidated by a crash or a
 * navigation, because the ref table lives in the page's JS context and dies with
 * it. Saying so explicitly is load-bearing: without it the agent reuses a stale
 * `@eN`, gets a second error, and burns turns discovering what we already knew.
 */
export const REFS_INVALIDATED_HINT =
  'All element refs from earlier snapshots are now invalid. Navigate and take a ' +
  'fresh snapshot before acting again; do not reuse @eN refs from before this error.';

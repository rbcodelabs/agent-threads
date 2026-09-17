/**
 * Compass → Agent Threads "Send to Agent" receiver — pure helpers.
 *
 * Compass runs inside Geode's Web Viewer. When the user picks the *local*
 * runtime on Compass's "Send to Agent" button, Compass calls
 * `window.__geode.postEvent("agent.handoff", payload)`. Geode re-checks the
 * origin in the main process, stamps the verified connector id onto `source`,
 * and re-emits the result on the Obsidian workspace bus as `web-viewer:event`.
 *
 * Everything Geode guarantees:
 *   - `source` is the *verified* connector id, never anything the page claims.
 *   - the event type is allowlisted per connector (`agent.handoff` on `compass`).
 *   - the payload is JSON-serializable and at most 8192 bytes.
 *
 * Everything Geode does NOT guarantee: the payload's internal shape. A Compass
 * regression, a stale deploy, or a future field rename all arrive here as a
 * well-formed envelope wrapped around a payload we cannot trust. So the whole
 * surface below is defensive: validate, then build, then (in main.ts) dispatch.
 *
 * No Obsidian/Node imports — kept pure so it can be unit tested directly, the
 * same way `documentChat.ts` separates helpers from wiring.
 */

/**
 * Workspace event Geode re-emits web-viewer bridge events on
 * (`src/renderer/app.ts` → `workspace.trigger('web-viewer:event', ev)`).
 * Obsidian itself never fires this, so subscribing under plain Obsidian is inert.
 */
export const WEB_VIEWER_EVENT_NAME = 'web-viewer:event';

/** Verified connector id Geode stamps on events coming from the Compass origin. */
export const COMPASS_CONNECTOR_ID = 'compass';

/** The one event type this receiver handles. */
export const AGENT_HANDOFF_EVENT_TYPE = 'agent.handoff';

/**
 * Geode's `NormalizedWebViewerEvent`, as re-emitted on the workspace bus.
 * Declared locally because Obsidian's own `Workspace` typings know nothing
 * about this Geode-specific event.
 */
export interface WebViewerBridgeEvent {
  /** Connector id, set by Geode from the verified origin. */
  source: string;
  type: string;
  payload: unknown;
  /** Guest frame URL, e.g. `https://compass.rbcodelabs.com/...`. */
  url: string;
  timestamp: number;
}

/**
 * The wire payload for `agent.handoff`.
 *
 * Mirrors Compass's shipped `AgentHandoffContext` (`lib/agent-context.ts`,
 * Compass PR #194) plus the entity ref it resolves from. Note this supersedes
 * the provisional `{ instruction, contextLabel, url, title }` shape written
 * down while the feature was still being designed — that shape never shipped.
 */
export interface AgentHandoffPayload {
  /** `"solutionPlan" | "decision"` today; kept open for future entity types. */
  entityType: string;
  entityId: string;
  /** Chip label, e.g. `Approved plan · <solution title>`. */
  label: string;
  /** 1-2 line summary (Compass slices the plan body to 280 chars). */
  summary: string;
  /** Composer text Compass already phrased for this handoff. */
  suggestedInstruction: string;
  /** The labeled context block Compass wants folded into turn 1. */
  promptBlock: string;
  /** Workspace-RELATIVE link back to the entity (absolute is also accepted). */
  sourceUrl: string;
}

/**
 * A payload that passed validation. Load-bearing fields are non-empty strings;
 * the rest are absent when Compass omitted them or sent something unusable.
 */
export interface NormalizedHandoff {
  entityType: string;
  entityId: string;
  suggestedInstruction: string;
  promptBlock: string;
  label?: string;
  summary?: string;
  /** Absolutized and scheme-checked. Absent when unusable. */
  sourceUrl?: string;
}

export type HandoffParseResult =
  | { ok: true; value: NormalizedHandoff }
  | { ok: false; reason: string };

/**
 * Fields without which the seed would be useless. A thread started from a
 * broken seed is worse than no thread: it burns tokens, looks like it worked,
 * and the user has to re-explain anyway. So a missing one is a hard failure.
 */
const REQUIRED_FIELDS = ['entityType', 'entityId', 'suggestedInstruction', 'promptBlock'] as const;

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const raw = source[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Validate an `agent.handoff` payload.
 *
 * Strict on the four load-bearing fields, tolerant on the rest: `label`,
 * `summary` and `sourceUrl` are presentation sugar, so a missing or
 * wrong-typed one is dropped rather than failing the whole handoff. The
 * asymmetry is deliberate — it lets Compass add or rename a cosmetic field
 * without bricking the receiver, while still refusing to start a thread whose
 * instruction or context is absent.
 */
export function parseAgentHandoffPayload(payload: unknown, eventUrl?: string): HandoffParseResult {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'payload is not an object' };
  }
  const source = payload as Record<string, unknown>;

  const missing = REQUIRED_FIELDS.filter((field) => readString(source, field) === undefined);
  if (missing.length > 0) {
    return { ok: false, reason: `missing or invalid field(s): ${missing.join(', ')}` };
  }

  const value: NormalizedHandoff = {
    entityType: readString(source, 'entityType')!,
    entityId: readString(source, 'entityId')!,
    suggestedInstruction: readString(source, 'suggestedInstruction')!,
    promptBlock: readString(source, 'promptBlock')!,
  };
  const label = readString(source, 'label');
  const summary = readString(source, 'summary');
  const sourceUrl = absolutizeSourceUrl(readString(source, 'sourceUrl'), eventUrl);
  if (label) value.label = label;
  if (summary) value.summary = summary;
  if (sourceUrl) value.sourceUrl = sourceUrl;
  return { ok: true, value };
}

/**
 * Resolve Compass's `sourceUrl` into something clickable.
 *
 * Compass ships a workspace-relative path (`/rbcodelabs/compass/discovery/...`),
 * so it has to be absolutized against the guest frame's origin before it can go
 * in a prompt. An already-absolute URL is accepted unchanged — `new URL(x, base)`
 * handles both without a branch.
 *
 * Only `http:`/`https:` survive. A payload is page-controlled data being folded
 * into agent-visible prompt text, so a `javascript:`, `file:` or `data:` URL is
 * dropped rather than passed along; there is no legitimate handoff that needs one.
 */
export function absolutizeSourceUrl(
  sourceUrl: string | undefined | null,
  eventUrl: string | undefined | null,
): string | undefined {
  if (typeof sourceUrl !== 'string' || !sourceUrl.trim()) return undefined;
  let resolved: URL;
  try {
    resolved = new URL(sourceUrl.trim(), eventUrl ?? undefined);
  } catch {
    return undefined;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined;
  return resolved.toString();
}

/**
 * Build the seed prompt for the new thread.
 *
 * `suggestedInstruction` is the spine: Compass already phrased the ask, and the
 * owner's explicit decision is that the cloud runtime and this local runtime
 * behave identically — so we do not re-word it. Everything else is appended as
 * context the agent can act on without the user re-explaining, including the
 * entity ref so the thread can pull more detail over Compass MCP.
 */
export function buildHandoffPrompt(handoff: NormalizedHandoff): string {
  const contextLines: string[] = [];
  contextLines.push(handoff.label ? `## Context from Compass — ${handoff.label}` : '## Context from Compass');
  if (handoff.summary) contextLines.push('', handoff.summary);
  contextLines.push('', handoff.promptBlock);
  contextLines.push('', `Compass entity: ${handoff.entityType} \`${handoff.entityId}\``);
  if (handoff.sourceUrl) contextLines.push(`Source: ${handoff.sourceUrl}`);
  contextLines.push(
    '',
    'Use the Compass MCP tools with the entity ref above if you need fuller detail than this block carries.',
  );
  return `${handoff.suggestedInstruction}\n\n---\n\n${contextLines.join('\n')}`;
}

/** Thread title hint. The label is the human-facing name Compass already chose. */
export function buildHandoffTitle(handoff: NormalizedHandoff): string {
  return handoff.label ?? `Compass ${handoff.entityType}`;
}

/** Stable identity of a handoff, used as the debounce key. */
export function handoffKey(handoff: NormalizedHandoff): string {
  return `${handoff.entityType}:${handoff.entityId}`;
}

/**
 * Leading-edge debounce over handoff identity.
 *
 * Decision: accept the first event for an `entityType:entityId` immediately and
 * suppress repeats for `windowMs`. Rationale:
 *
 *  - The failure we are guarding against is a double-click (or a Compass
 *    re-render firing `postEvent` twice) producing two identical threads that
 *    both immediately start spending tokens on the same task. That is not a
 *    cosmetic duplicate; it is real, concurrent, wasted work.
 *  - A *trailing*-edge debounce would delay the common case — a single
 *    deliberate click — by the full window for no benefit. Leading edge gives
 *    the normal path zero added latency.
 *  - Keying on entity identity rather than on "any handoff" means two genuinely
 *    different handoffs fired back to back both go through; only a repeat of
 *    the *same* entity is collapsed.
 *  - 3s is long enough to cover a double-click and a duplicate render, short
 *    enough that a user who deliberately re-sends the same plan (e.g. after
 *    deleting the first thread) is not blocked.
 *
 * Entries older than the window are pruned on every call, so the map cannot
 * grow without bound over a long session.
 */
export class HandoffDebouncer {
  private readonly lastAccepted = new Map<string, number>();

  constructor(
    private readonly windowMs = 3000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** True if this handoff should proceed; false if it is a rapid repeat. */
  shouldAccept(key: string): boolean {
    const now = this.now();
    for (const [existing, at] of this.lastAccepted) {
      if (now - at >= this.windowMs) this.lastAccepted.delete(existing);
    }
    const previous = this.lastAccepted.get(key);
    if (previous !== undefined && now - previous < this.windowMs) return false;
    this.lastAccepted.set(key, now);
    return true;
  }
}

/** Host capabilities the handler needs. Injected so the handler stays testable. */
export interface HandoffHost {
  /** False while the plugin is loaded but thread infrastructure is not up yet. */
  isReady(): boolean;
  /** Create a thread and send the seed as its first message. Returns the id. */
  dispatchThread(prompt: string, titleHint: string): Promise<string>;
  /** Bring the new thread to the front. */
  surfaceThread(threadId: string): Promise<void>;
  /** User-visible message (a `Notice` in the plugin). */
  notify(message: string): void;
}

export type HandoffOutcome =
  /** Not ours — wrong connector or wrong event type. Zero side effects. */
  | { kind: 'ignored' }
  /** Ours, but the payload cannot seed a useful thread. Notice, no thread. */
  | { kind: 'malformed'; reason: string }
  /** Ours, but a repeat of an entity we just handled. */
  | { kind: 'duplicate'; key: string }
  /** Ours, but thread infrastructure is not up yet. */
  | { kind: 'not-ready' }
  /** Ours, and a thread was created and surfaced. */
  | { kind: 'created'; threadId: string }
  /** Ours, but dispatch or surfacing threw. */
  | { kind: 'failed'; reason: string };

function isBridgeEvent(ev: unknown): ev is WebViewerBridgeEvent {
  if (ev === null || typeof ev !== 'object') return false;
  const candidate = ev as Partial<WebViewerBridgeEvent>;
  return typeof candidate.source === 'string' && typeof candidate.type === 'string';
}

/**
 * The whole receiver, minus the Obsidian wiring.
 *
 * Filters narrowly and returns early. This bus is shared: it already carries
 * `decision.approved` (allowlisted on the same connector, deliberately NOT
 * handled here) and will carry other connectors' events later. A permissive
 * handler becomes a cross-connector bug the moment a second connector
 * registers, so both `source` and `type` must match exactly.
 *
 * Never throws. An exception escaping a workspace listener poisons the bus for
 * every other subscriber, so every failure path resolves to an outcome instead.
 */
export async function handleWebViewerEvent(
  ev: unknown,
  host: HandoffHost,
  debouncer: HandoffDebouncer,
): Promise<HandoffOutcome> {
  try {
    if (!isBridgeEvent(ev)) return { kind: 'ignored' };
    if (ev.source !== COMPASS_CONNECTOR_ID || ev.type !== AGENT_HANDOFF_EVENT_TYPE) {
      return { kind: 'ignored' };
    }

    const parsed = parseAgentHandoffPayload(ev.payload, ev.url);
    if (!parsed.ok) {
      host.notify(`Compass handoff ignored — ${parsed.reason}.`);
      return { kind: 'malformed', reason: parsed.reason };
    }
    const handoff = parsed.value;

    // Readiness is checked BEFORE the debounce on purpose: a dropped handoff
    // must not also consume the debounce slot, or the "try again in a moment"
    // retry the notice invites would be silently swallowed as a duplicate.
    if (!host.isReady()) {
      // Drop rather than queue. There is no bounded, observable semantics for a
      // queue here (how long? replayed against which workspace state?), and the
      // listener is registered after the thread manager exists, so this is a
      // guard against an unexpected teardown ordering, not a routine path.
      host.notify('Compass handoff ignored — Agent Threads is still starting up. Try again in a moment.');
      return { kind: 'not-ready' };
    }

    const key = handoffKey(handoff);
    if (!debouncer.shouldAccept(key)) return { kind: 'duplicate', key };

    const threadId = await host.dispatchThread(buildHandoffPrompt(handoff), buildHandoffTitle(handoff));
    await host.surfaceThread(threadId);
    return { kind: 'created', threadId };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      host.notify(`Compass handoff failed — ${reason}`);
    } catch {
      /* a failing Notice must not escape either */
    }
    return { kind: 'failed', reason };
  }
}

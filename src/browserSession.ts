/**
 * browserSession.ts
 *
 * Pure logic behind the chat's "browser session card": everything that turns a
 * run of `browser_*` tool calls (plus, optionally, the login-handoff state) into
 * a view-model the DOM layer (BrowserSessionCard.ts) can draw.
 *
 * Runtime imports are limited to toolNameUtils.ts, which itself has ZERO imports,
 * so this module is safe for the mobile bundle (no Node built-ins, no SDK, no
 * Obsidian). Type-only imports are erased at build time.
 *
 * Data limits worth knowing (they shape the copy below):
 *  - A ToolCallRecord carries only name/summary/status/duration. The browser
 *    tools' inputs are `ref`/`epoch`, never an element name, so a click is
 *    labelled by its ref ("element e5"), not by what it clicked.
 *  - The page URL is not in the tool INPUT for anything but browser_navigate, so
 *    the sessions (ClaudeSession/ThreadSession) copy `url`/`title` out of each
 *    tool RESULT into `ToolCallRecord.browser` via parseBrowserToolResult. Only
 *    origin+path are kept (query strings and fragments routinely carry tokens).
 */

import { isBrowserTool, toolKey, groupToolCalls, browserSessionKey } from './toolNameUtils';
import type { ChatMessage, ToolCallRecord } from './types';

// ─── Summaries & result parsing (used by the sessions at tool_use / tool_result time) ───

/** Origin + path of a URL, dropping query and fragment. Falls back to a trimmed string. */
export function stripUrlDetail(raw: string): string {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  try {
    const u = new URL(text);
    return `${u.origin}${u.pathname}`;
  } catch {
    return text.slice(0, 200);
  }
}

/**
 * One-line summary for a browser tool_use, shown by generic tool pills (mobile,
 * fallbacks) and used as the step target on the card. Returns null for a
 * non-browser tool so callers can fall through to their own switch.
 * Never includes typed text: only its length.
 */
export function browserToolSummary(name: string, input: Record<string, unknown>): string | null {
  if (!isBrowserTool(name)) return null;
  switch (toolKey(name)) {
    case 'browser_navigate':
      return typeof input.url === 'string' ? stripUrlDetail(input.url) : '';
    case 'browser_click':
      return typeof input.ref === 'string' ? input.ref : '';
    case 'browser_type': {
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const chars = typeof input.text === 'string' ? input.text.length : 0;
      const parts = [ref, `${chars} char${chars === 1 ? '' : 's'}`];
      if (input.submit === true) parts.push('Enter');
      return parts.filter(Boolean).join(' · ');
    }
    case 'browser_eval':
      // Length only: the expression is agent-authored code and can embed anything.
      return typeof input.expression === 'string' ? `${input.expression.length} chars` : '';
    case 'browser_network':
      return typeof input.filter === 'string' ? input.filter.slice(0, 60) : '';
    case 'browser_scroll': {
      if (typeof input.ref === 'string') return input.ref;
      const dir = typeof input.direction === 'string' ? input.direction : '';
      return typeof input.amount === 'number' ? `${dir} ${input.amount}px`.trim() : dir;
    }
    case 'browser_resize':
      return typeof input.width === 'number' && typeof input.height === 'number'
        ? `${input.width}×${input.height}`
        : '';
    default:
      return '';
  }
}

/** What a browser tool_result tells the card. Deliberately tiny: no page content, ever. */
export interface BrowserResultInfo {
  pageUrl?: string;
  pageTitle?: string;
  error?: string;
}

const MAX_TITLE = 120;
const MAX_ERROR = 200;

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as { type?: unknown; text?: unknown };
      if (b && b.type === 'text' && typeof b.text === 'string') return b.text;
    }
  }
  return '';
}

/**
 * Extract `{url, title}` (success) or the error message (failure) from a browser
 * tool result. Tolerant of every shape: non-JSON, wrong types, empty. Returns
 * undefined when there is nothing worth keeping.
 */
export function parseBrowserToolResult(content: unknown, isError: boolean): BrowserResultInfo | undefined {
  const text = resultText(content);
  if (!text) return isError ? { error: 'The browser action failed.' } : undefined;
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === 'object') parsed = value as Record<string, unknown>;
  } catch { /* image result or prose: nothing to extract */ }
  if (!parsed) return isError ? { error: text.slice(0, MAX_ERROR) } : undefined;

  const info: BrowserResultInfo = {};
  if (typeof parsed.url === 'string' && parsed.url) info.pageUrl = stripUrlDetail(parsed.url);
  if (typeof parsed.title === 'string' && parsed.title) info.pageTitle = parsed.title.slice(0, MAX_TITLE);
  if (isError || parsed.success === false) {
    const err = parsed.error as { message?: unknown } | string | undefined;
    const message = typeof err === 'string' ? err : typeof err?.message === 'string' ? err.message : '';
    info.error = (message || 'The browser action failed.').slice(0, MAX_ERROR);
  }
  return info.pageUrl || info.pageTitle || info.error ? info : undefined;
}

// ─── View-model ────────────────────────────────────────────────────────────

export type BrowserSessionState = 'navigating' | 'live' | 'finished' | 'error' | 'ended';
export type BrowserHandoffPhase = 'requested' | 'control' | 'returned' | 'expired';
export type BrowserStepOutcome = 'ok' | 'now' | 'bad' | 'unknown' | 'wait' | 'human';

export const HANDOFF_TTL_SECONDS = 30;

export interface BrowserSessionStep {
  verb: string;
  target: string;
  outcome: BrowserStepOutcome;
  /** Preformatted ("1.2s"); empty while running. */
  duration: string;
}

/** A finished handoff, kept in controller memory so the card can keep its "sign in · you" step. */
export interface HandoffHistoryEntry {
  /** Epoch ms when the handoff ended; orders the step among the tool steps. */
  at: number;
  outcome: 'returned' | 'expired';
  host: string;
  durationMs?: number;
}

/** The slice of controller state the card needs. Structural so this module imports nothing. */
export interface BrowserHandoffInput {
  phase: BrowserHandoffPhase | null;
  /** Host of the sign-in page, e.g. "accounts.acme.io". */
  host: string;
  /** Full URL of the requested/active page (only its host+path is ever displayed). */
  url: string;
  /** Requested phase: seconds left, computed by the caller at render time. */
  remainingSeconds?: number;
  history: readonly HandoffHistoryEntry[];
}

export interface BrowserSessionViewModel {
  /** Stable across live growth and finalization; the expand-state key. */
  key: string;
  state: BrowserSessionState;
  /** Set while a handoff is layered on the card; drives the amber/teal mode treatments. */
  mode: BrowserHandoffPhase | null;
  /** Word shown at the right of the chrome bar. */
  statusLabel: string;
  url: string | null;
  host: string;
  path: string;
  verb: string;
  target: string;
  steps: BrowserSessionStep[];
  /** True when the caller resolved a real screenshot for this session. */
  hasScreenshot: boolean;
  /** Which image fills the viewport. */
  viewport: 'screenshot' | 'skeleton' | 'frame';
  /** Finished/ended sessions start collapsed to a chip. */
  collapsedByDefault: boolean;
  chip: { title: string; subtitle: string };
  error?: { title: string; detail: string };
  /** Amber/teal banner above the chrome. */
  banner?: { icon: string; title: string; subtitle: string; showRing: boolean; remainingSeconds?: number };
  /** Text laid over a dimmed viewport (requested state). */
  overlay?: { icon: string; title: string; text: string };
  cue?: string;
  privacy?: string;
  actions?: 'request' | 'control';
  hint?: { lead: string; strong: string; trail: string };
  /** Screen-reader text for the live region when the card's mode changes. */
  announce: string;
}

const VERBS: Record<string, string> = {
  browser_navigate: 'navigate',
  browser_snapshot: 'snapshot',
  browser_read_text: 'read',
  browser_click: 'click',
  browser_type: 'type',
  browser_screenshot: 'screenshot',
  browser_status: 'status',
  browser_close: 'close',
  browser_resize: 'resize',
  browser_console: 'console',
  browser_network: 'network',
  browser_scroll: 'scroll',
  browser_eval: 'eval',
};

export function browserVerb(name: string): string {
  return VERBS[toolKey(name)] ?? 'browse';
}

/** "1.2s", "0.4s", "30s", "1m 5s". Empty for unknown. */
export function formatStepDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 100) return '0.1s';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** "acme.io" + "/pricing" from a URL-ish string; a root path collapses to "". */
export function splitDisplayUrl(url: string | null | undefined): { host: string; path: string } {
  if (!url) return { host: '', path: '' };
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname === '/' ? '' : u.pathname };
  } catch {
    return { host: url.slice(0, 60), path: '' };
  }
}

function displayUrl(url: string | null | undefined): string {
  const { host, path } = splitDisplayUrl(url);
  return `${host}${path}`;
}

function tail(tools: ToolCallRecord[]): ToolCallRecord {
  return tools[tools.length - 1];
}

/** Latest page URL known to the session: a navigate's own URL, or any result's `browser.pageUrl`. */
export function sessionUrl(tools: ToolCallRecord[]): string | null {
  for (let i = tools.length - 1; i >= 0; i--) {
    const t = tools[i];
    if (t.browser?.pageUrl) return t.browser.pageUrl;
    if (toolKey(t.name) === 'browser_navigate' && t.summary) return t.summary;
  }
  return null;
}

function stepTarget(t: ToolCallRecord, pageUrl: string | null): string {
  switch (toolKey(t.name)) {
    case 'browser_navigate':
      return displayUrl(t.browser?.pageUrl ?? t.summary) || 'page';
    case 'browser_click':
      return t.summary ? `element ${t.summary}` : 'element';
    case 'browser_type':
      return t.summary ? `into ${t.summary}` : 'text';
    case 'browser_read_text':
      return 'page text';
    case 'browser_snapshot':
      return 'page structure';
    case 'browser_screenshot':
      return displayUrl(t.browser?.pageUrl ?? pageUrl) || 'viewport';
    case 'browser_close':
      return 'session';
    case 'browser_status':
      return 'browser status';
    case 'browser_resize':
      return t.summary || 'viewport';
    case 'browser_console':
      return 'console log';
    case 'browser_network':
      return t.summary ? `requests matching ${t.summary}` : 'network log';
    case 'browser_scroll':
      return t.summary ? `scroll ${t.summary}` : 'page';
    case 'browser_eval':
      return t.summary ? `script (${t.summary})` : 'script';
    default:
      return t.summary || '';
  }
}

function stepFor(t: ToolCallRecord, pageUrl: string | null, live: boolean): BrowserSessionStep {
  const outcome: BrowserStepOutcome =
    t.status === 'error' ? 'bad'
    : t.status === 'pending' ? (live ? 'now' : 'unknown')
    : 'ok';
  let target = stepTarget(t, pageUrl);
  if (outcome === 'bad' && t.browser?.error) target = `${target} — ${t.browser.error.slice(0, 60)}`;
  return { verb: browserVerb(t.name), target, outcome, duration: outcome === 'now' ? '' : formatStepDuration(t.durationMs) };
}

function sessionSpanMs(tools: ToolCallRecord[]): number | undefined {
  const first = tools[0].timestamp;
  const last = tail(tools);
  if (first === undefined || last.timestamp === undefined) return undefined;
  const span = last.timestamp + (last.durationMs ?? 0) - first;
  const sum = tools.reduce((n, t) => n + (t.durationMs ?? 0), 0);
  return Math.max(span, sum);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function deriveState(tools: ToolCallRecord[], live: boolean): BrowserSessionState {
  const last = tail(tools);
  if (last.status === 'error') return 'error';
  if (toolKey(last.name) === 'browser_close' && last.status !== 'pending') return 'ended';
  if (last.status === 'pending' && live) {
    const key = toolKey(last.name);
    return key === 'browser_navigate' || key === 'browser_resize' ? 'navigating' : 'live';
  }
  return live ? 'live' : 'finished';
}

const STATUS_LABEL: Record<BrowserSessionState, string> = {
  navigating: 'Loading',
  live: 'Live',
  finished: 'Done',
  error: 'Failed',
  ended: 'Ended',
};

export interface BuildBrowserSessionOptions {
  /** This is the session currently being driven (thread running, latest session). */
  live: boolean;
  /** A real screenshot was resolved for this session. */
  hasScreenshot: boolean;
  handoff?: BrowserHandoffInput | null;
}

/** Steps for a finished handoff, slotted among the tool steps by timestamp. */
function withHistorySteps(
  tools: ToolCallRecord[],
  toolSteps: BrowserSessionStep[],
  allHistory: readonly HandoffHistoryEntry[],
): BrowserSessionStep[] {
  let history = allHistory;
  // A handoff only belongs on the session that was running when it happened.
  const sessionStart = tools.length > 0 ? (tools[0].timestamp ?? 0) : 0;
  history = history.filter((h) => h.at >= sessionStart);
  if (history.length === 0) return toolSteps;
  const out: Array<{ at: number; step: BrowserSessionStep }> = toolSteps.map((step, i) => ({
    at: tools[i].timestamp ?? Number.MAX_SAFE_INTEGER,
    step,
  }));
  for (const h of history) {
    const step: BrowserSessionStep = h.outcome === 'returned'
      ? { verb: 'sign in', target: `you · ${h.host}`, outcome: 'ok', duration: formatStepDuration(h.durationMs) }
      : { verb: 'sign in', target: `expired after ${HANDOFF_TTL_SECONDS}s`, outcome: 'bad', duration: `${HANDOFF_TTL_SECONDS}s` };
    // Insert before the first tool step that started after the handoff ended.
    let idx = out.findIndex((o) => o.at > h.at);
    if (idx === -1) idx = out.length;
    out.splice(idx, 0, { at: h.at, step });
  }
  return out.map((o) => o.step);
}

export function buildBrowserSessionViewModel(
  tools: ToolCallRecord[],
  opts: BuildBrowserSessionOptions,
): BrowserSessionViewModel {
  return composeViewModel(tools, opts);
}

/** A card for a handoff that has no browser tool calls to hang off (e.g. the session was closed). */
export function buildStandaloneHandoffViewModel(handoff: BrowserHandoffInput): BrowserSessionViewModel {
  return composeViewModel([], { live: true, hasScreenshot: false, handoff });
}

function composeViewModel(tools: ToolCallRecord[], opts: BuildBrowserSessionOptions): BrowserSessionViewModel {
  const handoff = opts.handoff && opts.handoff.phase ? opts.handoff : null;
  const pageUrl = tools.length > 0 ? sessionUrl(tools) : null;
  const toolSteps = tools.map((t) => stepFor(t, pageUrl, opts.live));
  const steps = withHistorySteps(tools, toolSteps, opts.handoff?.history ?? []);
  const state: BrowserSessionState = tools.length > 0 ? deriveState(tools, opts.live) : 'live';
  const key = tools.length > 0 ? browserSessionKey(tools) : 'browser:handoff';
  const stepCount = steps.length;
  const spanMs = tools.length > 0 ? sessionSpanMs(tools) : undefined;
  const spanLabel = formatStepDuration(spanMs);

  const url = handoff?.phase === 'control' ? handoff.url : (pageUrl ?? (handoff?.url || null));
  const { host, path } = splitDisplayUrl(url);
  const sessionDisplay = displayUrl(pageUrl ?? url);
  const last = tools.length > 0 ? tail(tools) : null;

  // Caption
  let verb: string;
  let target: string;
  if (state === 'finished') { verb = 'finished'; target = [plural(stepCount, 'step'), spanLabel].filter(Boolean).join(' · '); }
  else if (state === 'ended') { verb = 'session ended'; target = 'browser closed'; }
  else if (state === 'error' && last) {
    verb = `${browserVerb(last.name)} failed`;
    target = (last.browser?.error ?? 'the browser reported an error').slice(0, 80);
  } else if (last) { verb = browserVerb(last.name); target = stepTarget(last, pageUrl); }
  else { verb = 'waiting'; target = 'for you to sign in'; }

  const vm: BrowserSessionViewModel = {
    key,
    state,
    mode: null,
    statusLabel: STATUS_LABEL[state],
    url,
    host,
    path,
    verb,
    target,
    steps,
    hasScreenshot: opts.hasScreenshot,
    viewport: opts.hasScreenshot ? 'screenshot' : 'skeleton',
    collapsedByDefault: (state === 'finished' || state === 'ended') && !handoff,
    chip: {
      title: state === 'ended' ? 'Session ended' : `Browsed ${host || 'the web'}`,
      subtitle: [sessionDisplay, plural(stepCount, 'step'), spanLabel].filter(Boolean).join(' · '),
    },
    announce: '',
  };

  if (state === 'error' && last) {
    vm.error = {
      title: `${capitalize(browserVerb(last.name))} failed`,
      detail: last.browser?.error ?? 'The browser reported an error.',
    };
  }

  if (handoff) applyHandoff(vm, handoff);
  return vm;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function applyHandoff(vm: BrowserSessionViewModel, handoff: BrowserHandoffInput): void {
  const host = handoff.host || vm.host || 'this site';
  vm.mode = handoff.phase;
  switch (handoff.phase) {
    case 'requested': {
      const remaining = Math.max(0, Math.min(HANDOFF_TTL_SECONDS, handoff.remainingSeconds ?? HANDOFF_TTL_SECONDS));
      vm.statusLabel = 'Waiting';
      vm.verb = 'waiting';
      vm.target = 'for you to sign in';
      vm.banner = { icon: 'user', title: 'Sign-in needed', subtitle: `${host} wants you to sign in`, showRing: true, remainingSeconds: remaining };
      vm.overlay = { icon: 'lock', title: 'Sign in on a separate page', text: `Opens ${host} in a temporary browser page you control.` };
      vm.privacy = "Claude can't see the sign-in page or what you type.";
      vm.actions = 'request';
      vm.steps = [...vm.steps, { verb: 'sign in', target: 'waiting for you', outcome: 'wait', duration: '' }];
      vm.announce = `Action needed: ${host} wants you to sign in. You have ${HANDOFF_TTL_SECONDS} seconds to take control.`;
      break;
    }
    case 'control':
      vm.statusLabel = 'Manual';
      vm.verb = 'you';
      vm.target = `signing in to ${host}`;
      vm.viewport = 'frame';
      vm.banner = { icon: 'hand', title: "You're in control", subtitle: `Signing in to ${host}`, showRing: false };
      vm.cue = 'Your input is being sent to this page';
      vm.privacy = "Claude can't see this page or what you type.";
      vm.actions = 'control';
      vm.steps = [...vm.steps, { verb: 'sign in', target: `you · ${host}`, outcome: 'human', duration: '' }];
      vm.announce = "You're in control. Claude is waiting and can't see this page.";
      break;
    case 'returned':
      vm.statusLabel = 'Live';
      vm.verb = 'resumed';
      vm.target = `signed in to ${host}`;
      vm.banner = { icon: 'check', title: `Signed in to ${host}`, subtitle: 'Claude resumed', showRing: false };
      vm.announce = `Control returned. Signed in to ${host}. Claude resumed.`;
      break;
    case 'expired':
      vm.statusLabel = 'Expired';
      vm.verb = 'sign-in';
      vm.target = 'request expired';
      vm.banner = { icon: 'clock', title: 'Sign-in request expired', subtitle: 'Ask Claude to try again', showRing: false };
      vm.hint = { lead: 'Nothing was sent. ', strong: 'Ask Claude to retry', trail: ' and click sign-in again.' };
      // The failed "sign in" step comes from the handoff history (recorded at expiry).
      vm.announce = 'The sign-in request expired. Ask Claude to try again.';
      break;
  }
}

// ─── Screenshot assignment ──────────────────────────────────────────────────

/** One rendered row, in order, as seen by the screenshot resolver. */
export interface BrowserRowInput {
  id: string;
  role: ChatMessage['role'];
  /** Non-empty prose (or a user message): the turn's browsing is over once one follows. */
  hasText: boolean;
  tools: ToolCallRecord[];
  /** Number of `toolResultImages` on the row. */
  imageCount: number;
}

export interface BrowserScreenshotAssignment {
  /** sessionKey -> where its screenshot lives. */
  bySession: Map<string, { rowIndex: number; imageIndex: number }>;
  /** rowIndex -> image indexes now shown inside a card (skip them in the loose image list). */
  claimed: Map<number, Set<number>>;
}

function isCompletedScreenshot(t: ToolCallRecord): boolean {
  return toolKey(t.name) === 'browser_screenshot' && t.status !== 'error' && t.status !== 'pending';
}

/**
 * Pair browser_screenshot calls with the images tool results produced, FIFO.
 *
 * ChatMessage.toolResultImages is per message, not per call, and ThreadManager
 * attaches an image to the NEXT assistant message after the call that made it —
 * so the image for a screenshot in row N usually sits on row N+1 (often the final
 * prose message). A per-row rule would miss that; FIFO across rows does not.
 * Failed or still-pending screenshots never produce an image and are skipped.
 * v1 limitation: images from other tools (a Read on a PNG) share the queue and
 * can be mis-paired if the two interleave.
 */
export function assignBrowserScreenshots(rows: readonly BrowserRowInput[]): BrowserScreenshotAssignment {
  const bySession = new Map<string, { rowIndex: number; imageIndex: number }>();
  const claimed = new Map<number, Set<number>>();
  // Screenshot calls still waiting for an image, oldest first.
  const waiting: string[] = [];
  rows.forEach((row, rowIndex) => {
    for (const entry of groupToolCalls(row.tools)) {
      if (entry.kind !== 'browser') continue;
      const key = browserSessionKey(entry.tools);
      for (const t of entry.tools) if (isCompletedScreenshot(t)) waiting.push(key);
    }
    for (let imageIndex = 0; imageIndex < row.imageCount && waiting.length > 0; imageIndex++) {
      const key = waiting.shift()!;
      bySession.set(key, { rowIndex, imageIndex }); // later shots of a session overwrite: card shows the newest
      let set = claimed.get(rowIndex);
      if (!set) { set = new Set(); claimed.set(rowIndex, set); }
      set.add(imageIndex);
    }
  });
  return { bySession, claimed };
}

/**
 * Key of the session that is currently being driven, or null. It is the last
 * browser session in the thread, and only while the thread is running with no
 * later prose/user row (a final answer means browsing is over).
 */
export function findLiveBrowserSessionKey(rows: readonly BrowserRowInput[], running: boolean): string | null {
  if (!running) return null;
  for (let r = rows.length - 1; r >= 0; r--) {
    const entries = groupToolCalls(rows[r].tools).filter((e) => e.kind === 'browser');
    if (entries.length > 0) {
      return browserSessionKey((entries[entries.length - 1] as { tools: ToolCallRecord[] }).tools);
    }
    if (rows[r].hasText || rows[r].role === 'user') return null;
  }
  return null;
}

/** Key of the last browser session in the thread regardless of running state (handoff overlay target). */
export function findLastBrowserSessionKey(rows: readonly BrowserRowInput[]): string | null {
  for (let r = rows.length - 1; r >= 0; r--) {
    const entries = groupToolCalls(rows[r].tools).filter((e) => e.kind === 'browser');
    if (entries.length > 0) {
      return browserSessionKey((entries[entries.length - 1] as { tools: ToolCallRecord[] }).tools);
    }
  }
  return null;
}

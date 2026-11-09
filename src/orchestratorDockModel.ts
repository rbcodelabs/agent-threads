/**
 * orchestratorDockModel.ts
 *
 * Pure, host-free model behind the Agent Board's OrchestratorDock: dot state,
 * attention items, suggestion chips, unread tracking, the transcript projection,
 * thread-link resolution and the count/tooltip text. No `obsidian` import and no
 * manager access: callers pass live values in, exactly as KanbanView.rowFlags
 * does, so everything here is unit-testable and stays out of the daemon core
 * closure.
 */
import { classifyThreadRow, type ThreadClassificationFlags } from './threadRowState';

// ── Dock state ──────────────────────────────────────────────────────────────

export type DockState = 'none' | 'offline' | 'error' | 'attention' | 'working' | 'idle';

export interface DockThread {
  status?: string;
  lastError?: string;
  authRequired?: unknown;
  remote?: { daemonId: string };
}

export interface DockStateInput {
  /** settings.orchestratorThreadId */
  orchestratorId: string | undefined;
  /** manager.getThread(orchestratorId); undefined when the stored id is stale (deleted). */
  thread: DockThread | undefined;
  isRunning: boolean;
  /** daemonRegistry.stateOf(thread.remote.daemonId); only consulted for remote threads. */
  daemon: { status: string } | undefined;
  /** needsYouCount(attentionItems(...)) */
  needsYouCount: number;
  hasUnreadReply: boolean;
}

const DAEMON_DOWN: ReadonlySet<string> = new Set(['unreachable', 'closed', 'incompatible', 'unauthorized']);

/**
 * Precedence: none > offline > error > attention > working > idle (attention
 * outranks working: product decision, confirmed).
 * connecting/reconnecting/idle are transient (a running turn continues on the
 * daemon) so they are not offline. Like classifyThreadRow, a running turn
 * outranks a stale lastError. The error signals intentionally go beyond
 * classifyThreadRow, which only looks at lastError: `status === 'error'` and
 * `authRequired` count as errors here too.
 */
export function deriveDockState(i: DockStateInput): DockState {
  if (!i.orchestratorId || !i.thread) return 'none';
  if (i.thread.remote && i.daemon && DAEMON_DOWN.has(i.daemon.status)) return 'offline';
  if (!i.isRunning && (i.thread.lastError || i.thread.authRequired || i.thread.status === 'error')) return 'error';
  if (i.needsYouCount > 0 || i.hasUnreadReply) return 'attention';
  if (i.isRunning) return 'working';
  return 'idle';
}

// ── Attention items ─────────────────────────────────────────────────────────

export type AttentionKind = 'permission' | 'question' | 'plan' | 'failed';

export interface AttentionCandidate {
  threadId: string;
  title: string;
  /** Live flags, as KanbanView.rowFlags builds them. */
  flags: ThreadClassificationFlags;
  /** threadNeedsInput(): staged reply / decisions / question (the board's Needs you lane). */
  needsInput: boolean;
  /** Which kind of pending prompt sits behind flags.hasPendingPermission. */
  pending: { permission: boolean; question: boolean; plan: boolean };
}

export interface AttentionItem {
  threadId: string;
  title: string;
  kind: AttentionKind;
}

/**
 * One item per thread that is awaiting Rick or failed. Mirrors the board: the
 * Needs you lane is pulled out first, then classifyThreadRow decides. If a
 * thread is awaiting but no pending flag is set (flags raced), it is reported
 * as `permission`.
 */
export function attentionItems(candidates: AttentionCandidate[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const c of candidates) {
    const base = { threadId: c.threadId, title: c.title };
    if (c.needsInput) { items.push({ ...base, kind: 'question' }); continue; }
    const state = classifyThreadRow(c.flags);
    if (state === 'awaiting') {
      const kind: AttentionKind = c.pending.permission ? 'permission' : c.pending.question ? 'question' : c.pending.plan ? 'plan' : 'permission';
      items.push({ ...base, kind });
    } else if (state === 'error') {
      items.push({ ...base, kind: 'failed' });
    }
  }
  return items;
}

/**
 * Threads awaiting Rick (everything but failures); drives the attention dot.
 * Product decisions: failed threads are excluded (they surface as the "Triage
 * failed" chip); the orchestrator's own pending prompts DO count, because it
 * needs the user, and callers decide whether to include the orchestrator thread
 * in the "What needs me?" chip. This follows the board's Needs-you definition,
 * but the Needs-you lane exists only in status-board mode, so in project/folder
 * modes the dot can differ from the visible columns.
 */
export function needsYouCount(items: AttentionItem[]): number {
  return items.filter((i) => i.kind !== 'failed').length;
}

// ── Suggestion chips ────────────────────────────────────────────────────────

export interface SuggestionChip {
  id: 'needs-me' | 'triage-failed' | 'summarise-today' | 'what-shipped';
  label: string;
  /** Text sent to the orchestrator when the chip is chosen. */
  prompt: string;
}

export function suggestionChips(items: AttentionItem[]): SuggestionChip[] {
  const needs = needsYouCount(items);
  const failed = items.length - needs;
  const chips: SuggestionChip[] = [];
  if (needs > 0) chips.push({ id: 'needs-me', label: `What needs me? (${needs})`, prompt: 'What needs me right now? List the threads waiting on me and what each one needs.' });
  if (failed > 0) chips.push({ id: 'triage-failed', label: `Triage failed (${failed})`, prompt: 'Triage the failed threads: for each, say why it failed and what you recommend.' });
  chips.push({ id: 'summarise-today', label: 'Summarise today', prompt: "Summarise today's activity across my threads." });
  chips.push({ id: 'what-shipped', label: 'What shipped?', prompt: 'What shipped recently? Link the threads and PRs.' });
  return chips;
}

// ── Unread + transcript ─────────────────────────────────────────────────────

export interface RoleMessage { id: string; role: string }

export function unreadState(messages: readonly RoleMessage[], lastSeenId: string | undefined): { hasUnread: boolean; latestAssistantId: string | undefined } {
  let latestAssistantId: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { latestAssistantId = messages[i].id; break; }
  }
  return { hasUnread: latestAssistantId !== undefined && latestAssistantId !== lastSeenId, latestAssistantId };
}

export interface DockTranscriptEntry { id: string; role: 'user' | 'assistant'; content: string }

/**
 * The dock transcript, derived fresh from thread.messages on every refresh.
 * Never an append-only log: interrupt() removes unresolved user messages with
 * no per-message event, so a re-projection is the only way they disappear.
 */
export function dockTranscript(messages: ReadonlyArray<RoleMessage & { content: string }>): DockTranscriptEntry[] {
  const out: DockTranscriptEntry[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (!m.content.trim()) continue;
    out.push({ id: m.id, role: m.role, content: m.content });
  }
  return out;
}

// ── Thread links ────────────────────────────────────────────────────────────

export type LinkSegment =
  | { type: 'text'; text: string }
  | { type: 'thread'; threadId: string; label: string };

/**
 * `[[thread:<ref>|label]]`. Single-line only (a marker spanning a newline is not
 * a link), the ref cannot contain `|`, and a backslash before the pipe is
 * accepted so a link survives a GFM table cell (`\|`). `[[thread:a|b|c]]` has
 * ref `a` and label `b|c`.
 */
const THREAD_LINK = /\[\[thread:([^\]|\n]+?)(?:\\?\|([^\]\n]+))?\]\]/g;

export interface ThreadRef { id: string; title: string }

function uniqueByTitle(threads: readonly ThreadRef[], title: string): ThreadRef | undefined {
  if (!title) return undefined; // never match an empty-titled thread on an empty string
  const hits = threads.filter((t) => t.title === title);
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Resolves one `[[thread:...]]` marker: by id, then by unique exact
 * (case-sensitive) title of the ref, then of the label. An empty or blank ref
 * never resolves; a blank label is never matched against titles.
 */
export function resolveThreadLink(ref: string, label: string, threads: readonly ThreadRef[]): { threadId: string; title: string } | null {
  const r = ref.trim();
  if (!r) return null;
  const hit = threads.find((t) => t.id === r) ?? uniqueByTitle(threads, r) ?? uniqueByTitle(threads, label.trim());
  return hit ? { threadId: hit.id, title: hit.title } : null;
}

/**
 * Splits markdown into text and resolved thread-link segments.
 *
 * FOR PLAIN-TEXT CONTEXTS ONLY (tooltips, notifications, search). Never render
 * markdown per segment: a link inside `**bold**` or a table cell would cut the
 * surrounding syntax in half. Markdown rendering must use
 * {@link rewriteThreadLinks} and render the whole document once.
 *
 * Labels are model-controlled text: consumers must set them with `textContent`
 * (never innerHTML). An unresolved marker degrades to its label (or ref) as text.
 */
export function splitThreadLinks(markdown: string, threads: readonly ThreadRef[]): LinkSegment[] {
  const segments: LinkSegment[] = [];
  const pushText = (text: string): void => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last?.type === 'text') last.text += text;
    else segments.push({ type: 'text', text });
  };
  let cursor = 0;
  for (const m of markdown.matchAll(THREAD_LINK)) {
    pushText(markdown.slice(cursor, m.index));
    cursor = m.index + m[0].length;
    const ref = m[1].trim();
    const alias = (m[2] ?? '').trim();
    const hit = resolveThreadLink(ref, alias, threads);
    if (hit) segments.push({ type: 'thread', threadId: hit.threadId, label: alias || hit.title });
    else pushText(alias || ref);
  }
  pushText(markdown.slice(cursor));
  return segments;
}

/** Makes a model-supplied label safe inside a `[[thread:id|label]]` marker. */
function markerLabel(label: string): string {
  return label.replace(/[\[\]|\\\s]+/g, ' ').trim();
}

/**
 * The supported path for markdown rendering. Resolvable markers become
 * `[[thread:<id>|label]]` (normalised: real id, label = alias or the thread
 * title, characters that would break the marker replaced by spaces); unresolvable
 * ones become their plain label. Everything else, including surrounding
 * `**bold**` and table syntax, is untouched. The renderer then turns the
 * normalised markers into anchors before running markdown (dockMarkdown).
 * Labels are model-controlled: set them via textContent / escape them.
 */
export function rewriteThreadLinks(markdown: string, threads: readonly ThreadRef[]): string {
  return markdown.replace(THREAD_LINK, (_m, rawRef: string, rawAlias?: string) => {
    const ref = rawRef.trim();
    const alias = (rawAlias ?? '').trim();
    const hit = resolveThreadLink(ref, alias, threads);
    if (!hit) return alias || ref;
    return `[[thread:${hit.threadId}|${markerLabel(alias || hit.title)}]]`;
  });
}

// ── Count text ──────────────────────────────────────────────────────────────

/** The board header's legacy count text (KanbanView.updateHeader), kept derivable. */
export function countText(total: number, running: number): string {
  return running > 0 ? `${running} running · ${total} total` : `${total} thread${total !== 1 ? 's' : ''}`;
}

/** Dot tooltip: "2 running · 14 total · 2 need you". */
export function tooltipText(c: { running: number; total: number; needsYou: number }): string {
  const parts: string[] = [];
  if (c.running > 0) parts.push(`${c.running} running`);
  parts.push(`${c.total} total`);
  if (c.needsYou > 0) parts.push(`${c.needsYou} ${c.needsYou === 1 ? 'needs' : 'need'} you`);
  return parts.join(' · ');
}

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
 * Precedence: none > offline > error > attention > working > idle.
 * connecting/reconnecting/idle are transient (a running turn continues on the
 * daemon) so they are not offline. A running turn outranks a stale lastError,
 * matching classifyThreadRow, so the dot and the board cannot disagree.
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
 * Needs you lane is pulled out first, then classifyThreadRow decides.
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

/** Threads awaiting Rick (everything but failures); drives the attention dot. */
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

const THREAD_LINK = /\[\[thread:([^\]|]+)(?:\|([^\]]+))?\]\]/g;

function uniqueByTitle(threads: ReadonlyArray<{ id: string; title: string }>, title: string): string | undefined {
  const hits = threads.filter((t) => t.title === title);
  return hits.length === 1 ? hits[0].id : undefined;
}

/**
 * Splits markdown into text and resolved thread-link segments. `[[thread:<ref>|Label]]`
 * resolves by id, then by exact unique title (ref, then label); anything
 * unresolved degrades to its label as plain text. Other wikilinks stay text.
 */
export function splitThreadLinks(markdown: string, threads: ReadonlyArray<{ id: string; title: string }>): LinkSegment[] {
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
    const label = (m[2] ?? ref).trim();
    const threadId = threads.find((t) => t.id === ref)?.id ?? uniqueByTitle(threads, ref) ?? uniqueByTitle(threads, label);
    if (threadId) segments.push({ type: 'thread', threadId, label });
    else pushText(label);
  }
  pushText(markdown.slice(cursor));
  return segments;
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

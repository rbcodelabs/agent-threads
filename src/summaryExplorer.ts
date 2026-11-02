/**
 * Read-only exploration primitives for the "explorer tier" summarizer.
 *
 * The cheap per-turn summarizer sees a sliding window of recent messages, which
 * is why long threads drift to "the last couple of dev/test cycles". The
 * explorer tier instead gives the model a few read-only tools over an in-memory
 * snapshot of the thread so it can find what the thread is FOR.
 *
 * Everything here is pure and dependency-free (types only): the handlers close
 * over a snapshot taken once, so there is no file, network, vault or write
 * access to reason about, and the bounds below are unit-testable without the
 * Claude Agent SDK. `InProcessSummarizer` adapts these to SDK `tool()`s.
 *
 * Thread content is untrusted: handlers return it as data, wrapped in a marker
 * so a message that says "ignore previous instructions" is clearly a quote.
 */
import type { ChatMessage } from './types';
import { summarizableMessages } from './summarization';

/** Outline rows show only this much of each message. */
export const OUTLINE_PREVIEW_CHARS = 150;
export const OUTLINE_DEFAULT_LIMIT = 40;
export const OUTLINE_MAX_LIMIT = 100;
export const READ_DEFAULT_CHARS = 2000;
export const READ_MAX_CHARS = 4000;
export const SEARCH_MAX_RESULTS = 15;
export const SEARCH_SNIPPET_CHARS = 160;
export const SEARCH_MAX_QUERY_CHARS = 100;
/** Upper bound on get_current_summary output. */
const CURRENT_SUMMARY_MAX_CHARS = 2000;

export interface ExplorerHandlers {
  outline(offset?: number, limit?: number): string;
  readMessage(index: number, maxChars?: number): string;
  search(query: string): string;
  getCurrentSummary(): string;
  /** Number of messages in the snapshot (the valid index range is [0, count)). */
  readonly count: number;
}

export interface ExplorerContext {
  title?: string;
  summary?: string;
  goal?: string;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function roleLabel(m: ChatMessage): string {
  return m.role === 'user' ? 'user' : 'assistant';
}

function isoTime(ts: number): string {
  return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : 'unknown time';
}

/**
 * Build the tool handlers over a frozen snapshot of the thread. Indices are
 * positions in `summarizableMessages(messages)`, so tool-only and compact
 * messages never appear and indices are stable for the whole exploration.
 */
export function createExplorerHandlers(messages: ChatMessage[], context: ExplorerContext = {}): ExplorerHandlers {
  const snapshot = summarizableMessages(messages).map((m) => ({
    role: roleLabel(m),
    timestamp: m.timestamp,
    content: m.content,
  }));
  const count = snapshot.length;

  return {
    count,

    outline(offset, limit) {
      if (count === 0) return 'The thread has no messages.';
      const start = clampInt(offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const size = clampInt(limit, OUTLINE_DEFAULT_LIMIT, 1, OUTLINE_MAX_LIMIT);
      if (start >= count) return `offset ${start} is past the end; the thread has ${count} messages (valid indices 0-${count - 1}).`;
      const end = Math.min(count, start + size);
      const rows: string[] = [];
      for (let i = start; i < end; i++) {
        const m = snapshot[i];
        const preview = oneLine(m.content).slice(0, OUTLINE_PREVIEW_CHARS);
        rows.push(`[${i}] ${m.role} ${isoTime(m.timestamp)}: ${preview}`);
      }
      const more = end < count ? ` Call outline(offset=${end}) for more.` : ' End of thread.';
      return `Messages ${start}-${end - 1} of ${count}.${more}\n${rows.join('\n')}`;
    },

    readMessage(index, maxChars) {
      if (count === 0) return 'The thread has no messages.';
      if (!Number.isInteger(index) || index < 0 || index >= count) {
        return `index ${String(index)} is out of range; valid indices are 0-${count - 1}.`;
      }
      const limit = clampInt(maxChars, READ_DEFAULT_CHARS, 1, READ_MAX_CHARS);
      const m = snapshot[index];
      const body = m.content.slice(0, limit);
      const truncated = m.content.length > limit ? ` [truncated: ${m.content.length - limit} more chars]` : '';
      return `<message index="${index}" role="${m.role}" time="${isoTime(m.timestamp)}">\n${body}${truncated}\n</message>`;
    },

    search(query) {
      const needle = (query ?? '').trim().slice(0, SEARCH_MAX_QUERY_CHARS).toLowerCase();
      if (!needle) return 'query must be a non-empty string.';
      const hits: string[] = [];
      let total = 0;
      for (let i = 0; i < count; i++) {
        const at = snapshot[i].content.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        total++;
        if (hits.length >= SEARCH_MAX_RESULTS) continue;
        const half = Math.floor((SEARCH_SNIPPET_CHARS - needle.length) / 2);
        const from = Math.max(0, at - Math.max(0, half));
        const snippet = oneLine(snapshot[i].content.slice(from, from + SEARCH_SNIPPET_CHARS));
        hits.push(`[${i}] ${snapshot[i].role}: …${snippet}…`);
      }
      if (total === 0) return `No messages match "${needle}".`;
      const shown = hits.length < total ? ` (showing first ${hits.length}; narrow the query)` : '';
      return `${total} matching message(s)${shown}:\n${hits.join('\n')}`;
    },

    getCurrentSummary() {
      const parts: string[] = [];
      if (context.title?.trim()) parts.push(`title: ${context.title.trim()}`);
      if (context.goal?.trim()) parts.push(`goal: ${context.goal.trim()}`);
      if (context.summary?.trim()) parts.push(`summary: ${context.summary.trim()}`);
      if (!parts.length) return 'No existing title, goal or summary.';
      return `Existing (possibly drifted or stale) metadata:\n${parts.join('\n')}`.slice(0, CURRENT_SUMMARY_MAX_CHARS);
    },
  };
}

/** Result of the explorer pass. Goal and status are non-empty, or the whole result is `EXPLORER_NO_RESULT`. */
export interface ExplorerResult {
  title: string;
  goal: string;
  status: string;
}

export const EXPLORER_NO_RESULT: ExplorerResult = { title: '', goal: '', status: '' };
export const MAX_GOAL_CHARS = 400;
export const MAX_STATUS_CHARS = 700;
const EXPLORER_SENTINEL = 'NO_SUMMARY';

/**
 * Parse the explorer's final answer. A usable result needs a goal and a status;
 * anything else (prose, refusal, sentinel, partial JSON) yields the empty result
 * so callers never persist garbage. Tolerates markdown fences and leading or
 * trailing prose around a single JSON object.
 */
export function parseExplorerResult(text: string): ExplorerResult {
  const cleaned = (text ?? '').replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim();
  if (!cleaned || cleaned.toUpperCase() === EXPLORER_SENTINEL) return { ...EXPLORER_NO_RESULT };

  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last <= first) return { ...EXPLORER_NO_RESULT };

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(first, last + 1));
  } catch {
    return { ...EXPLORER_NO_RESULT };
  }
  if (!parsed || typeof parsed !== 'object') return { ...EXPLORER_NO_RESULT };
  const rec = parsed as Record<string, unknown>;
  const field = (v: unknown): string => {
    if (typeof v !== 'string') return '';
    const s = v.trim();
    return s.toUpperCase() === EXPLORER_SENTINEL ? '' : s;
  };
  const goal = field(rec.goal).slice(0, MAX_GOAL_CHARS);
  const status = field(rec.status).slice(0, MAX_STATUS_CHARS);
  if (!goal || !status) return { ...EXPLORER_NO_RESULT };
  return { title: field(rec.title), goal, status };
}

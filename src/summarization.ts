/**
 * Pure helpers for the thread auto-title / summarize path.
 *
 * Extracted out of ThreadsView (which is not unit-testable — it needs a live
 * Obsidian workspace) so the fire/skip decision and the transcript builder can
 * be exercised directly by tests.
 *
 * This module must stay dependency-free (types only). It is imported by both
 * ThreadsView and InProcessSummarizer, and pulling a Node built-in or the
 * Claude Agent SDK in here would drag them into the eager mobile bundle.
 */
import type { ChatMessage } from './types';

/** Roles that never carry conversational content worth summarizing. */
const NON_TRANSCRIPT_ROLES = new Set(['compact']);

/**
 * Messages that can actually contribute to a summary: real conversational
 * roles with non-whitespace content.
 *
 * Filtering on content is the fix for the "Transcript empty" bug — the agentic
 * loop stores tool-only assistant messages with `content: ''`, and a thread
 * whose recent window is all tool calls would otherwise send the model a
 * transcript of `Claude: \n\nClaude: \n\n…`.
 */
export function summarizableMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (m) => !NON_TRANSCRIPT_ROLES.has(m.role) && m.content.trim().length > 0,
  );
}

export interface BuildTranscriptOptions {
  /** Keep at most this many messages (most recent), applied AFTER filtering. */
  maxMessages: number;
  /** Truncate each message's content to this many characters. */
  maxCharsPerMessage: number;
  /** Hard cap on the joined transcript length. */
  maxTotalChars: number;
  /** When set, only messages with `timestamp > since` are considered. */
  since?: number;
}

/**
 * Build a transcript string for the summarizer prompt.
 *
 * Order matters: filter empties and compact markers FIRST, then slice to the
 * message limit. The old code sliced first, so a window of tool-only messages
 * could evict every message that had real content.
 *
 * Returns '' when nothing survives filtering — callers must treat that as
 * "there is nothing to summarize" and skip the model call entirely.
 */
export function buildTranscript(
  messages: ChatMessage[],
  opts: BuildTranscriptOptions,
): string {
  let usable = summarizableMessages(messages);
  if (opts.since !== undefined) {
    usable = usable.filter((m) => m.timestamp > opts.since!);
  }
  return usable
    .slice(-opts.maxMessages)
    .map((m) => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.content.slice(0, opts.maxCharsPerMessage)}`)
    .join('\n\n')
    .slice(0, opts.maxTotalChars);
}

/** True when at least one summarizable message arrived after `lastSummarizedAt`. */
export function hasNewSummarizableContent(
  messages: ChatMessage[],
  lastSummarizedAt?: number,
): boolean {
  const cutoff = lastSummarizedAt ?? 0;
  return summarizableMessages(messages).some((m) => m.timestamp > cutoff);
}

/** Longest auto-generated title we will accept. Anything longer is not a title. */
export const MAX_AUTO_TITLE_LENGTH = 60;

/**
 * Meta-commentary the model emits when it has nothing to summarize. These are
 * never legitimate thread titles, and "Transcript empty" is the exact string
 * that shipped to a real thread in the wild.
 */
const UNUSABLE_TITLE_PATTERN = /^(transcript|empty|no |n\/a|unknown|untitled)/i;

/**
 * Defense-in-depth against this bug class: even if a degenerate transcript
 * reaches the model, refuse to apply the resulting title.
 */
export function isUsableTitle(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return false;
  if (trimmed.length > MAX_AUTO_TITLE_LENGTH) return false;
  if (UNUSABLE_TITLE_PATTERN.test(trimmed)) return false;
  return true;
}

export interface AutoSummarizeDecisionInput {
  /** `settings.summarizationEnabled` — master switch for the whole feature. */
  summarizationEnabled: boolean;
  /**
   * `settings.autoSummarize`. When true the summarizer runs every completed
   * turn even after the user has renamed the thread (they still want a fresh
   * summary body). When false — the default — it runs only while the title is
   * still auto-generated, so renaming a thread stops the calls entirely.
   */
  autoSummarize: boolean;
  /** `thread.titleUserSet` — the user explicitly renamed this thread. */
  titleUserSet?: boolean;
  /** A summarize call is already in flight for this thread. */
  inFlight: boolean;
  messages: ChatMessage[];
  /** `thread.lastSummarizedAt`. */
  lastSummarizedAt?: number;
}

/**
 * Decide whether a completed turn should trigger the auto-summarizer.
 *
 * Called once per `done` event (one per completed user turn), not once per
 * assistant SDK message — the old trigger fired ~58x per turn because every
 * step of the agentic loop, including tool-only steps and sub-agent steps,
 * emits an assistant message.
 */
export function shouldAutoSummarize(input: AutoSummarizeDecisionInput): boolean {
  if (!input.summarizationEnabled) return false;
  if (input.inFlight) return false;
  if (!input.autoSummarize && input.titleUserSet) return false;
  if (!hasNewSummarizableContent(input.messages, input.lastSummarizedAt)) return false;
  return true;
}

/**
 * A thread needs at least this many summarizable messages before the explorer
 * tier is worth its (multi-turn) cost. Below it the cheap windowed summarizer
 * already sees most of the thread, so it cannot drift away from the goal.
 */
export const EXPLORER_MIN_MESSAGES = 40;

export type SummarizeTier = 'none' | 'cheap' | 'explore';

export interface SummarizeTierInput extends AutoSummarizeDecisionInput {
  /** `thread.derivedGoal`. */
  derivedGoal?: string;
  /** This thread already had an explorer backfill attempt this session (success or not). */
  backfillAttempted: boolean;
}

/**
 * Pick the tier for a completed turn.
 *
 * `explore` is the backfill trigger: a long thread with no stored goal, tried at
 * most once per session (the caller marks it attempted even on failure, so an
 * unparseable answer cannot cause a retry on every turn). It replaces the cheap
 * pass for that turn rather than adding a second spawn. Everything else keeps
 * the existing per-turn cheap path unchanged.
 */
export function decideSummarizeTier(input: SummarizeTierInput): SummarizeTier {
  if (!shouldAutoSummarize(input)) return 'none';
  if (
    !input.derivedGoal?.trim() &&
    !input.backfillAttempted &&
    summarizableMessages(input.messages).length >= EXPLORER_MIN_MESSAGES
  ) {
    return 'explore';
  }
  return 'cheap';
}

/** What the caller must do after an explorer result has been applied to a thread. */
export interface ExplorerApplyOutcome {
  /** The thread was modified (goal and summary written) and should be persisted. */
  applied: boolean;
  /** A usable title to hand to the caller's rename path (which owns `titleUserSet`), or ''. */
  title: string;
}

/**
 * Write an explorer result onto the thread. Empty or goal-less results never
 * touch it, so a failed exploration can't blank a good goal or summary. The
 * `status` becomes `thread.summary` so every existing summary surface shows it.
 */
export function applyExplorerResult(
  thread: { summary?: string; derivedGoal?: string; derivedGoalUpdatedAt?: number },
  result: { title: string; goal: string; status: string },
  now: number,
): ExplorerApplyOutcome {
  const goal = result.goal.trim();
  const status = result.status.trim();
  if (!goal || !status) return { applied: false, title: '' };
  thread.derivedGoal = goal;
  thread.derivedGoalUpdatedAt = now;
  thread.summary = status;
  return { applied: true, title: isUsableTitle(result.title) ? result.title.trim() : '' };
}

/** Banner/summary text: "Goal: … / Now: …" when a derived goal exists, else the plain summary. */
export function formatGoalAndStatus(goal: string | undefined, status: string): string {
  const g = goal?.trim();
  return g ? `Goal: ${g}\nNow: ${status}` : status;
}

/**
 * "Needs you" classification for the Kanban board: a thread needs Rick when an
 * orchestrator has staged something for him to act on, or the agent is asking
 * him a question. Permission and plan prompts stay in the separate Awaiting
 * lane. Pure, so the bucketing is unit-testable without a view.
 */
import type { Thread } from './types';

export type NeedsInputSource = Pick<Thread, 'proposedReply' | 'pendingDecisions' | 'pendingQuestions'>;

export function threadNeedsInput(thread: NeedsInputSource, hasLiveQuestion = false): boolean {
  return !!thread.proposedReply
    || (thread.pendingDecisions?.length ?? 0) > 0
    || (thread.pendingQuestions?.length ?? 0) > 0
    || hasLiveQuestion;
}

/** Splits threads into those that need Rick (original order kept) and the rest. */
export function splitNeedsInput<T>(
  threads: T[],
  needs: (t: T) => boolean,
): { needsInput: T[]; rest: T[] } {
  const needsInput: T[] = [];
  const rest: T[] = [];
  for (const t of threads) (needs(t) ? needsInput : rest).push(t);
  return { needsInput, rest };
}

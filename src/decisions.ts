/**
 * Orchestrator-posted decisions (`Thread.pendingDecisions`): lifecycle,
 * ownership and answer formatting as pure functions over a thread-like object,
 * so the MCP tools, ThreadManager and tests share one implementation.
 *
 * Routing rule (binding): an answer is delivered to the POSTING orchestrator
 * (`decision.sourceThreadId`) as a user message. It is never written to the
 * subject thread's own session, queue or system prompt.
 */
import type { AskQuestion, AskQuestionOption, PendingDecision, Thread } from './types';

export const MAX_PENDING_DECISIONS_PER_THREAD = 5;

export interface PostDecisionInput {
  question: string;
  header?: string;
  options: AskQuestionOption[];
  multiSelect?: boolean;
  allowOther?: boolean;
}

type DecisionHolder = Pick<Thread, 'pendingDecisions'>;

/** Validates input and appends a new decision; returns it. Throws on bad input or a full queue. */
export function postDecision(
  thread: DecisionHolder,
  callerThreadId: string,
  input: PostDecisionInput,
  now: number = Date.now(),
  newId: () => string = () => `dec-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
): PendingDecision {
  const question = input.question?.trim();
  if (!question) throw new Error('A decision needs a non-empty question.');
  const options = (input.options ?? []).map((o) => ({ label: String(o.label ?? '').trim(), description: String(o.description ?? '').trim() }));
  if (options.length < 2 || options.length > 4) throw new Error('A decision needs 2 to 4 options.');
  if (options.some((o) => !o.label)) throw new Error('Every option needs a label.');
  const existing = thread.pendingDecisions ?? [];
  if (existing.length >= MAX_PENDING_DECISIONS_PER_THREAD) {
    throw new Error(`This thread already has ${MAX_PENDING_DECISIONS_PER_THREAD} pending decisions. Clear stale ones first.`);
  }
  const decision: PendingDecision = {
    id: newId(),
    question,
    header: (input.header ?? '').trim().slice(0, 60),
    options,
    multiSelect: input.multiSelect === true,
    allowOther: input.allowOther !== false,
    createdAt: now,
    sourceThreadId: callerThreadId,
  };
  thread.pendingDecisions = [...existing, decision];
  return decision;
}

/**
 * Same rule as assertProposalOwnership: only the orchestrator that posted a
 * decision may clear it. Throws when the decision exists but belongs to another.
 */
export function assertDecisionOwnership(decision: Pick<PendingDecision, 'sourceThreadId'> | undefined, callerThreadId: string): void {
  if (decision && decision.sourceThreadId !== callerThreadId) {
    throw new Error('That decision was posted by another orchestrator. Only its author can clear it.');
  }
}

/** Removes one decision (ownership-checked). Returns false when it was not pending. */
export function clearDecision(thread: DecisionHolder, callerThreadId: string, decisionId: string): boolean {
  const found = thread.pendingDecisions?.find((d) => d.id === decisionId);
  if (!found) return false;
  assertDecisionOwnership(found, callerThreadId);
  removeDecision(thread, decisionId);
  return true;
}

/** Unconditional removal used when Rick answers or dismisses (the UI is the authority there). */
export function removeDecision(thread: DecisionHolder, decisionId: string): PendingDecision | undefined {
  const found = thread.pendingDecisions?.find((d) => d.id === decisionId);
  if (!found) return undefined;
  const rest = thread.pendingDecisions!.filter((d) => d.id !== decisionId);
  if (rest.length > 0) thread.pendingDecisions = rest;
  else delete thread.pendingDecisions;
  return found;
}

/** Renders a decision as the AskQuestion the shared QuestionForm understands (id = decision id). */
export function decisionToQuestion(decision: PendingDecision): AskQuestion {
  return {
    id: decision.id,
    question: decision.question,
    header: decision.header,
    options: decision.options,
    multiSelect: decision.multiSelect,
    allowOther: decision.allowOther,
  };
}

/** The user message delivered to the posting orchestrator. */
export function formatDecisionAnswer(
  decision: PendingDecision,
  answer: string,
  subject?: { id: string; title?: string },
): string {
  const label = decision.header || decision.question;
  const about = subject ? ` (about thread ${subject.title ? `"${subject.title}" ` : ''}${subject.id})` : '';
  return `Decision ${label}${about} [${decision.id}]: ${answer.trim() || '(no answer)'}`;
}

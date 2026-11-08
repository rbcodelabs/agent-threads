/**
 * Shared answer routing for a thread's pending AskUserQuestion set, used by
 * ThreadsView (restored card) and KanbanView (inline card form).
 *
 * Two situations: a live session is blocked on the question (resolve its
 * promise), or the session is gone (post-reload) and the answer must travel as
 * an ordinary user message. A secret answer must never become a persisted chat
 * message, so for secret questions the fallback asks the agent to re-request
 * the value instead.
 */
import type { AskQuestion } from './types';

export interface QuestionAnswerDeps {
  getPendingQuestionResolver(threadId: string): ((answers: Record<string, string>) => void) | undefined;
  setThreadPendingQuestions(threadId: string, questions: AskQuestion[] | undefined): void;
  sendMessage(threadId: string, text: string): Promise<void>;
  saveSettings(): Promise<unknown> | void;
}

export const SECRET_EXPIRED_MESSAGE =
  'A secret input request expired when the session reloaded. Please request the secret again with request_user_input; do not ask me to send it in chat.';

/** Post-crash / post-reload path: no live session, so dispatch the answer via sendMessage. */
export function sendRestoredQuestionAnswer(
  deps: QuestionAnswerDeps,
  threadId: string,
  questions: AskQuestion[],
  answers: Record<string, string>,
): void {
  deps.setThreadPendingQuestions(threadId, undefined);
  void deps.saveSettings();
  if (questions.some((q) => q.isSecret)) {
    void deps.sendMessage(threadId, SECRET_EXPIRED_MESSAGE);
    return;
  }
  const formatted = questions
    .map((q) => `${q.question}: ${answers[q.id ?? q.question] ?? ''}`)
    .join('\n');
  void deps.sendMessage(threadId, formatted);
}

/** Answers a thread's pending questions through whichever path is available. */
export function answerPendingQuestions(
  deps: QuestionAnswerDeps,
  threadId: string,
  questions: AskQuestion[],
  answers: Record<string, string>,
): 'live' | 'restored' {
  const live = deps.getPendingQuestionResolver(threadId);
  if (live) {
    live(answers);
    return 'live';
  }
  sendRestoredQuestionAnswer(deps, threadId, questions, answers);
  return 'restored';
}

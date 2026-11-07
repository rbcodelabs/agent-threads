/**
 * Adapters binding the pure action helpers (proposedReplyActions, questionActions)
 * to a live ThreadManager. Kept separate so the helpers stay unit-testable with
 * plain fakes and the views stay one-liners.
 */
import type { ThreadManager } from './ThreadManager';
import type { ProposedReplyDeps } from './proposedReplyActions';
import type { QuestionAnswerDeps } from './questionActions';

type Save = () => Promise<unknown> | void;

export function proposedReplyDeps(manager: ThreadManager, saveSettings: Save): ProposedReplyDeps {
  return {
    getThread: (id) => manager.getThread(id),
    notifyProposedReplyChanged: (id) => manager.notifyProposedReplyChanged(id),
    saveSettings,
    sendMessage: (id, text) => manager.sendMessage(id, text),
  };
}

export function questionAnswerDeps(manager: ThreadManager, saveSettings: Save): QuestionAnswerDeps {
  return {
    getPendingQuestionResolver: (id) => manager.getPendingQuestionResolver(id),
    setThreadPendingQuestions: (id, questions) => manager.setThreadPendingQuestions(id, questions),
    sendMessage: (id, text) => manager.sendMessage(id, text),
    saveSettings,
  };
}

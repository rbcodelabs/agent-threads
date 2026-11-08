import { describe, expect, it, vi } from 'vitest';
import { answerPendingQuestions, SECRET_EXPIRED_MESSAGE, type QuestionAnswerDeps } from '../../src/questionActions';
import type { AskQuestion } from '../../src/types';

const q = (over: Partial<AskQuestion> = {}): AskQuestion => ({ question: 'Which?', header: 'H', options: [], multiSelect: false, ...over });

function deps(resolver?: (a: Record<string, string>) => void) {
  return {
    getPendingQuestionResolver: vi.fn(() => resolver),
    setThreadPendingQuestions: vi.fn(),
    sendMessage: vi.fn(async () => {}),
    saveSettings: vi.fn(),
  } satisfies QuestionAnswerDeps;
}

describe('answerPendingQuestions', () => {
  it('resolves the live promise when a session is blocked on the question', () => {
    const resolver = vi.fn();
    const d = deps(resolver);
    expect(answerPendingQuestions(d, 't', [q()], { Which: 'A' })).toBe('live');
    expect(resolver).toHaveBeenCalledWith({ Which: 'A' });
    expect(d.sendMessage).not.toHaveBeenCalled();
  });

  it('falls back to a user message after a reload, clearing pendingQuestions first', () => {
    const d = deps();
    expect(answerPendingQuestions(d, 't', [q({ question: 'Which?' })], { 'Which?': 'A' })).toBe('restored');
    expect(d.setThreadPendingQuestions).toHaveBeenCalledWith('t', undefined);
    expect(d.sendMessage).toHaveBeenCalledWith('t', 'Which?: A');
  });

  it('never turns a secret answer into a chat message', () => {
    const d = deps();
    answerPendingQuestions(d, 't', [q({ isSecret: true, id: 'k' })], { k: 'hunter2' });
    expect(d.sendMessage).toHaveBeenCalledWith('t', SECRET_EXPIRED_MESSAGE);
    expect(JSON.stringify(d.sendMessage.mock.calls)).not.toContain('hunter2');
  });
});

import { describe, expect, it } from 'vitest';
import {
  assertDecisionOwnership, clearDecision, decisionToQuestion, formatDecisionAnswer, MAX_PENDING_DECISIONS_PER_THREAD,
  postDecision, removeDecision,
} from '../../src/decisions';
import type { Thread } from '../../src/types';

const opts = [{ label: 'Ship', description: 'go' }, { label: 'Hold', description: '' }];
const input = { question: 'Ship v2?', header: 'Release', options: opts };
const holder = (): Pick<Thread, 'pendingDecisions'> => ({});

describe('decision lifecycle', () => {
  it('posts a decision with defaults and records the author', () => {
    const t = holder();
    const d = postDecision(t, 'orch', input, 1000, () => 'd1');
    expect(d).toMatchObject({ id: 'd1', sourceThreadId: 'orch', multiSelect: false, allowOther: true, createdAt: 1000, header: 'Release' });
    expect(t.pendingDecisions).toEqual([d]);
  });

  it.each([
    ['blank question', { ...input, question: '  ' }],
    ['one option', { ...input, options: [opts[0]] }],
    ['five options', { ...input, options: [...opts, ...opts, opts[0]] }],
    ['an unlabeled option', { ...input, options: [opts[0], { label: ' ', description: '' }] }],
  ])('rejects %s', (_l, bad) => {
    expect(() => postDecision(holder(), 'orch', bad)).toThrow();
  });

  it('caps pending decisions per thread', () => {
    const t = holder();
    for (let i = 0; i < MAX_PENDING_DECISIONS_PER_THREAD; i++) postDecision(t, 'orch', input);
    expect(() => postDecision(t, 'orch', input)).toThrow(/pending decisions/);
  });

  it('only the author may clear; others get the ownership error and nothing changes', () => {
    const t = holder();
    const d = postDecision(t, 'orch-a', input);
    expect(() => clearDecision(t, 'orch-b', d.id)).toThrow(/another orchestrator/);
    expect(t.pendingDecisions).toHaveLength(1);
    expect(clearDecision(t, 'orch-a', d.id)).toBe(true);
    expect(t.pendingDecisions).toBeUndefined();
    expect(clearDecision(t, 'orch-a', d.id)).toBe(false);
  });

  it('assertDecisionOwnership allows a missing decision and the author', () => {
    expect(() => assertDecisionOwnership(undefined, 'x')).not.toThrow();
    expect(() => assertDecisionOwnership({ sourceThreadId: 'x' }, 'x')).not.toThrow();
    expect(() => assertDecisionOwnership({ sourceThreadId: 'y' }, 'x')).toThrow();
  });

  it('removeDecision keeps siblings and drops the array when empty', () => {
    const t = holder();
    const a = postDecision(t, 'o', input);
    const b = postDecision(t, 'o', input);
    removeDecision(t, a.id);
    expect(t.pendingDecisions?.map((d) => d.id)).toEqual([b.id]);
    removeDecision(t, b.id);
    expect('pendingDecisions' in t).toBe(false);
  });

  it('maps to the AskQuestion the shared form renders, keyed by decision id', () => {
    const d = postDecision(holder(), 'o', { ...input, allowOther: false, multiSelect: true });
    expect(decisionToQuestion(d)).toMatchObject({ id: d.id, question: 'Ship v2?', multiSelect: true, allowOther: false });
  });

  it('formats the answer for the orchestrator with the decision id and subject', () => {
    const d = postDecision(holder(), 'o', input, 1, () => 'd9');
    expect(formatDecisionAnswer(d, ' Ship ', { id: 't1', title: 'Fix login' })).toBe('Decision Release (about thread "Fix login" t1) [d9]: Ship');
  });
});

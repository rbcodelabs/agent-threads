import { describe, expect, it } from 'vitest';
import {
  assertDecisionOwnership, clearAllDecisions, clearDecision, decisionToQuestion, formatDecisionAnswer, MAX_PENDING_DECISIONS_PER_THREAD,
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

  it('clearAllDecisions removes multiple decisions and cleans empty arrays', () => {
    const empty = holder();
    expect(clearAllDecisions(empty)).toBe(false);
    expect('pendingDecisions' in empty).toBe(false);

    const withEmptyArr: Pick<Thread, 'pendingDecisions'> = { pendingDecisions: [] };
    expect(clearAllDecisions(withEmptyArr)).toBe(false);
    expect('pendingDecisions' in withEmptyArr).toBe(false);

    const populated = holder();
    postDecision(populated, 'orch-a', input);
    postDecision(populated, 'orch-b', input);
    expect(clearAllDecisions(populated)).toBe(true);
    expect('pendingDecisions' in populated).toBe(false);
    expect(populated.pendingDecisions).toBeUndefined();
    expect(clearAllDecisions(populated)).toBe(false);
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

describe('decision recommended option', () => {
  it('stores a recommended label that matches an option (trimmed)', () => {
    const t = holder();
    const d = postDecision(t, 'orch', { ...input, recommended: '  Ship ' }, 1, () => 'd1');
    expect(d.recommended).toBe('Ship');
    expect(t.pendingDecisions![0].recommended).toBe('Ship');
  });

  it('omits the field entirely when recommended is not given or blank', () => {
    const a = postDecision(holder(), 'orch', input, 1, () => 'd1');
    const b = postDecision(holder(), 'orch', { ...input, recommended: '   ' }, 1, () => 'd2');
    expect('recommended' in a).toBe(false);
    expect('recommended' in b).toBe(false);
  });

  it.each([['an unknown label', 'Nope'], ['a different case', 'ship']])('rejects %s', (_l, rec) => {
    const t = holder();
    expect(() => postDecision(t, 'orch', { ...input, recommended: rec })).toThrow(/recommended.*Ship, Hold/);
    expect(t.pendingDecisions).toBeUndefined();
  });

  it('legacy persisted decisions without the field still clear, render and format', () => {
    const legacy = { id: 'old', question: 'Q?', header: 'H', options: opts, multiSelect: false, allowOther: true, createdAt: 1, sourceThreadId: 'orch' };
    const t: Pick<Thread, 'pendingDecisions'> = { pendingDecisions: [legacy] };
    expect(decisionToQuestion(legacy).options).toEqual(opts);
    expect(formatDecisionAnswer(legacy, 'Ship')).toContain('[old]');
    expect(clearDecision(t, 'orch', 'old')).toBe(true);
    expect(t.pendingDecisions).toBeUndefined();
  });

  it('survives a JSON persistence round trip', () => {
    const t = holder();
    postDecision(t, 'orch', { ...input, recommended: 'Hold' }, 1, () => 'd1');
    const restored = JSON.parse(JSON.stringify(t)) as typeof t;
    expect(restored.pendingDecisions![0].recommended).toBe('Hold');
  });
});

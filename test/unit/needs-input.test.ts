import { describe, expect, it } from 'vitest';
import { splitNeedsInput, threadNeedsInput } from '../../src/needsInput';
import type { PendingDecision } from '../../src/types';

const decision: PendingDecision = {
  id: 'd1', question: 'Ship?', header: 'Ship', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
  multiSelect: false, allowOther: true, createdAt: 1, sourceThreadId: 'orch',
};

describe('threadNeedsInput', () => {
  it('is false for a thread with nothing staged', () => {
    expect(threadNeedsInput({})).toBe(false);
    expect(threadNeedsInput({ pendingDecisions: [], pendingQuestions: [] })).toBe(false);
  });

  it.each([
    ['a proposed reply', { proposedReply: { text: 'hi', generatedAt: 1 } }],
    ['a pending decision', { pendingDecisions: [decision] }],
    ['a pending question', { pendingQuestions: [{ question: 'q', header: 'h', options: [], multiSelect: false }] }],
  ])('is true for %s', (_label, thread) => {
    expect(threadNeedsInput(thread)).toBe(true);
  });

  it('is true when only a live question is pending (no persisted copy)', () => {
    expect(threadNeedsInput({}, true)).toBe(true);
  });
});

describe('splitNeedsInput', () => {
  it('partitions while preserving order', () => {
    const items = [{ id: 'a', n: true }, { id: 'b', n: false }, { id: 'c', n: true }, { id: 'd', n: false }];
    const { needsInput, rest } = splitNeedsInput(items, (i) => i.n);
    expect(needsInput.map((i) => i.id)).toEqual(['a', 'c']);
    expect(rest.map((i) => i.id)).toEqual(['b', 'd']);
  });
});

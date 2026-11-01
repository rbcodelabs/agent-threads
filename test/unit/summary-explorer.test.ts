import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '../../src/types';
import {
  createExplorerHandlers,
  parseExplorerResult,
  OUTLINE_MAX_LIMIT,
  OUTLINE_PREVIEW_CHARS,
  READ_MAX_CHARS,
  SEARCH_MAX_RESULTS,
  MAX_GOAL_CHARS,
} from '../../src/summaryExplorer';
import {
  decideSummarizeTier,
  applyExplorerResult,
  formatGoalAndStatus,
  EXPLORER_MIN_MESSAGES,
} from '../../src/summarization';

function msg(role: ChatMessage['role'], content: string, timestamp = 1_700_000_000_000): ChatMessage {
  return { id: crypto.randomUUID(), role, content, timestamp };
}

function thread(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `message number ${i} about topic${i % 5}`, 1000 + i));
}

describe('explorer tool handlers', () => {
  it('indexes only summarizable messages (skips compact and empty tool-only messages)', () => {
    const h = createExplorerHandlers([
      msg('user', 'first'),
      msg('compact', '[compacted]'),
      msg('assistant', '   '),
      msg('assistant', 'second'),
    ]);
    expect(h.count).toBe(2);
    expect(h.outline()).toContain('[0] user');
    expect(h.outline()).toContain('[1] assistant');
    expect(h.outline()).not.toContain('compacted');
  });

  it('outline truncates previews, paginates, and caps the limit', () => {
    const h = createExplorerHandlers([msg('user', 'x'.repeat(1000)), ...thread(300)]);
    const first = h.outline(0, 1);
    expect(first).toContain('x'.repeat(OUTLINE_PREVIEW_CHARS));
    expect(first).not.toContain('x'.repeat(OUTLINE_PREVIEW_CHARS + 1));
    const big = h.outline(0, 10_000);
    expect(big.split('\n').length - 1).toBe(OUTLINE_MAX_LIMIT);
    expect(big).toContain(`outline(offset=${OUTLINE_MAX_LIMIT})`);
    expect(h.outline(300, 5)).toContain('End of thread');
  });

  it('outline handles offsets past the end, negatives, NaN and empty threads', () => {
    const h = createExplorerHandlers(thread(3));
    expect(h.outline(99)).toMatch(/past the end.*0-2/);
    expect(h.outline(-5, 2)).toContain('[0]');
    expect(h.outline(Number.NaN, Number.NaN)).toContain('[0]');
    expect(createExplorerHandlers([]).outline()).toBe('The thread has no messages.');
  });

  it('read_message returns the message, truncates by maxChars, and caps maxChars', () => {
    const h = createExplorerHandlers([msg('user', 'a'.repeat(10_000))]);
    const small = h.readMessage(0, 10);
    expect(small).toContain('a'.repeat(10));
    expect(small).toContain('truncated: 9990 more chars');
    const capped = h.readMessage(0, 999_999);
    expect(capped.match(/a{100,}/)![0]).toHaveLength(READ_MAX_CHARS);
    expect(h.readMessage(0)).toContain('<message index="0" role="user"');
  });

  it('read_message reports out-of-range, negative, fractional and NaN indices without throwing', () => {
    const h = createExplorerHandlers(thread(3));
    for (const bad of [3, 99, -1, 1.5, Number.NaN, Infinity]) {
      expect(h.readMessage(bad)).toMatch(/out of range; valid indices are 0-2/);
    }
    expect(createExplorerHandlers([]).readMessage(0)).toBe('The thread has no messages.');
  });

  it('search finds case-insensitively, returns indices with snippets, and bounds results', () => {
    const msgs = [msg('user', 'Build the OFFLINE sync feature'), ...Array.from({ length: 40 }, () => msg('assistant', 'running tests again'))];
    const h = createExplorerHandlers(msgs);
    expect(h.search('offline')).toMatch(/1 matching message\(s\):\n\[0\] user: ….*OFFLINE sync/);
    const many = h.search('tests');
    expect(many).toContain(`40 matching message(s) (showing first ${SEARCH_MAX_RESULTS}`);
    expect(many.split('\n').length - 1).toBe(SEARCH_MAX_RESULTS);
    expect(h.search('zzz')).toContain('No messages match');
  });

  it('search rejects empty queries and treats regex metacharacters literally', () => {
    const h = createExplorerHandlers([msg('user', 'a.*b (c)')]);
    expect(h.search('   ')).toContain('non-empty');
    expect(h.search('.*')).toContain('1 matching');
    expect(h.search('zzz.*')).toContain('No messages match');
  });

  it('get_current_summary reports existing metadata or its absence', () => {
    expect(createExplorerHandlers([]).getCurrentSummary()).toContain('No existing');
    const h = createExplorerHandlers([], { title: 'T', goal: 'G', summary: 'S' });
    expect(h.getCurrentSummary()).toMatch(/title: T[\s\S]*goal: G[\s\S]*summary: S/);
  });

  it('is a snapshot: later mutation of the source array does not change the indices', () => {
    const src = thread(2);
    const h = createExplorerHandlers(src);
    src.push(msg('user', 'late'));
    expect(h.count).toBe(2);
  });
});

describe('parseExplorerResult', () => {
  const ok = { title: 'Add offline sync', goal: 'Build offline sync for the mobile app.', status: 'Conflict handling is next.' };

  it('parses plain JSON, fenced JSON, and JSON surrounded by prose', () => {
    expect(parseExplorerResult(JSON.stringify(ok))).toEqual(ok);
    expect(parseExplorerResult('```json\n' + JSON.stringify(ok) + '\n```')).toEqual(ok);
    expect(parseExplorerResult('Here you go: ' + JSON.stringify(ok) + ' Done.')).toEqual(ok);
  });

  it('returns the empty result for sentinel, prose, bad JSON, and non-objects', () => {
    for (const bad of ['NO_SUMMARY', 'no_summary', '', "I couldn't determine a goal.", '{not json}', '[1,2]', 'null']) {
      expect(parseExplorerResult(bad)).toEqual({ title: '', goal: '', status: '' });
    }
  });

  it('requires both goal and status; sentinel inside a field counts as empty', () => {
    expect(parseExplorerResult(JSON.stringify({ ...ok, goal: '' })).goal).toBe('');
    expect(parseExplorerResult(JSON.stringify({ ...ok, status: 'NO_SUMMARY' }))).toEqual({ title: '', goal: '', status: '' });
    expect(parseExplorerResult(JSON.stringify({ title: 't', goal: 5, status: {} }))).toEqual({ title: '', goal: '', status: '' });
  });

  it('caps the goal length', () => {
    const r = parseExplorerResult(JSON.stringify({ ...ok, goal: 'g'.repeat(5000) }));
    expect(r.goal).toHaveLength(MAX_GOAL_CHARS);
  });
});

describe('applyExplorerResult', () => {
  it('writes goal, status as summary, and returns a usable title', () => {
    const t: { summary?: string; derivedGoal?: string; derivedGoalUpdatedAt?: number } = { summary: 'old' };
    const out = applyExplorerResult(t, { title: 'Add offline sync', goal: 'G', status: 'S' }, 42);
    expect(out).toEqual({ applied: true, title: 'Add offline sync' });
    expect(t).toEqual({ summary: 'S', derivedGoal: 'G', derivedGoalUpdatedAt: 42 });
  });

  it('never persists an empty result or blanks existing state', () => {
    const t = { summary: 'old', derivedGoal: 'keep' };
    expect(applyExplorerResult(t, { title: '', goal: '', status: '' }, 1).applied).toBe(false);
    expect(applyExplorerResult(t, { title: 'x', goal: 'g', status: '  ' }, 1).applied).toBe(false);
    expect(t).toEqual({ summary: 'old', derivedGoal: 'keep' });
  });

  it('drops unusable titles (meta-commentary) but still applies the goal', () => {
    const t: { summary?: string; derivedGoal?: string } = {};
    expect(applyExplorerResult(t, { title: 'Transcript empty', goal: 'G', status: 'S' }, 1)).toEqual({ applied: true, title: '' });
    expect(t.derivedGoal).toBe('G');
  });
});

describe('decideSummarizeTier', () => {
  const base = {
    summarizationEnabled: true,
    autoSummarize: false,
    inFlight: false,
    lastSummarizedAt: 0,
    backfillAttempted: false,
  };

  it('explores a long thread with no goal', () => {
    expect(decideSummarizeTier({ ...base, messages: thread(EXPLORER_MIN_MESSAGES) })).toBe('explore');
  });

  it('stays cheap below the threshold', () => {
    expect(decideSummarizeTier({ ...base, messages: thread(EXPLORER_MIN_MESSAGES - 1) })).toBe('cheap');
  });

  it('counts only summarizable messages toward the threshold', () => {
    const msgs = [...thread(EXPLORER_MIN_MESSAGES - 1), ...Array.from({ length: 50 }, () => msg('assistant', ''))];
    expect(decideSummarizeTier({ ...base, messages: msgs })).toBe('cheap');
  });

  it('stays cheap once a goal exists or backfill was already attempted this session', () => {
    const messages = thread(100);
    expect(decideSummarizeTier({ ...base, messages, derivedGoal: 'Build X' })).toBe('cheap');
    expect(decideSummarizeTier({ ...base, messages, backfillAttempted: true })).toBe('cheap');
  });

  it('defers to the existing gate: disabled, in flight, user-renamed, or no new content', () => {
    const messages = thread(100);
    expect(decideSummarizeTier({ ...base, messages, summarizationEnabled: false })).toBe('none');
    expect(decideSummarizeTier({ ...base, messages, inFlight: true })).toBe('none');
    expect(decideSummarizeTier({ ...base, messages, titleUserSet: true })).toBe('none');
    expect(decideSummarizeTier({ ...base, messages, lastSummarizedAt: 10_000_000 })).toBe('none');
  });
});

describe('formatGoalAndStatus', () => {
  it('shows Goal / Now when a goal exists and the plain summary otherwise', () => {
    expect(formatGoalAndStatus('Build X', 'Testing')).toBe('Goal: Build X\nNow: Testing');
    expect(formatGoalAndStatus(undefined, 'Testing')).toBe('Testing');
    expect(formatGoalAndStatus('  ', 'Testing')).toBe('Testing');
  });
});

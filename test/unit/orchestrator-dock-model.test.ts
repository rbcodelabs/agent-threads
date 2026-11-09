import { describe, it, expect } from 'vitest';
import {
  deriveDockState, attentionItems, needsYouCount, suggestionChips, unreadState, dockTranscript,
  splitThreadLinks, countText, tooltipText,
  type AttentionCandidate,
} from '../../src/orchestratorDockModel';
import { classifyThreadRow, type ThreadClassificationFlags } from '../../src/threadRowState';

const base = {
  orchestratorId: 'orch', thread: {}, isRunning: false, daemon: undefined, needsYouCount: 0, hasUnreadReply: false,
};

describe('deriveDockState', () => {
  it('is none without an id or when the stored thread is missing (stale id)', () => {
    expect(deriveDockState({ ...base, orchestratorId: undefined })).toBe('none');
    expect(deriveDockState({ ...base, thread: undefined })).toBe('none');
    expect(deriveDockState({ ...base, thread: undefined, needsYouCount: 3, hasUnreadReply: true })).toBe('none');
  });

  it.each(['unreachable', 'closed', 'incompatible', 'unauthorized'])('is offline for a remote thread on a %s daemon', (status) => {
    expect(deriveDockState({ ...base, thread: { remote: { daemonId: 'd' } }, daemon: { status } })).toBe('offline');
  });

  it.each(['connecting', 'reconnecting', 'idle', 'connected'])('does not treat %s as offline', (status) => {
    expect(deriveDockState({ ...base, thread: { remote: { daemonId: 'd' } }, daemon: { status } })).toBe('idle');
  });

  it('never reports offline for a local thread, whatever the daemon says', () => {
    expect(deriveDockState({ ...base, thread: {}, daemon: { status: 'unreachable' } })).toBe('idle');
  });

  it('is error from lastError, status error or authRequired', () => {
    expect(deriveDockState({ ...base, thread: { lastError: 'boom' } })).toBe('error');
    expect(deriveDockState({ ...base, thread: { status: 'error' } })).toBe('error');
    expect(deriveDockState({ ...base, thread: { authRequired: { kind: 'claude' } } })).toBe('error');
  });

  it('a running turn outranks a stale lastError (same rule as classifyThreadRow)', () => {
    expect(deriveDockState({ ...base, thread: { lastError: 'old' }, isRunning: true })).toBe('working');
  });

  it('precedence: none > offline > error > attention > working > idle', () => {
    const remote = { daemonId: 'd' };
    const down = { status: 'unreachable' };
    expect(deriveDockState({ ...base, thread: { remote, lastError: 'x' }, daemon: down, needsYouCount: 2, hasUnreadReply: true, isRunning: true })).toBe('offline');
    expect(deriveDockState({ ...base, thread: { lastError: 'x' }, needsYouCount: 2, hasUnreadReply: true })).toBe('error');
    expect(deriveDockState({ ...base, needsYouCount: 2, isRunning: true })).toBe('attention');
    expect(deriveDockState({ ...base, hasUnreadReply: true, isRunning: true })).toBe('attention');
    expect(deriveDockState({ ...base, isRunning: true })).toBe('working');
    expect(deriveDockState({ ...base })).toBe('idle');
  });
});

const flags = (over: Partial<ThreadClassificationFlags> = {}): ThreadClassificationFlags => ({
  isRunning: false, hasPendingPermission: false, hasActiveBackgroundTasks: false, hasPendingWakeup: false, messageCount: 1, ...over,
});
const cand = (id: string, over: Partial<AttentionCandidate> = {}): AttentionCandidate => ({
  threadId: id, title: `T ${id}`, flags: flags(), needsInput: false,
  pending: { permission: false, question: false, plan: false }, ...over,
});

describe('attentionItems', () => {
  it('classifies permission, question, plan, failed and ignores the rest', () => {
    const items = attentionItems([
      cand('perm', { flags: flags({ hasPendingPermission: true }), pending: { permission: true, question: false, plan: false } }),
      cand('q', { flags: flags({ hasPendingPermission: true }), pending: { permission: false, question: true, plan: false } }),
      cand('plan', { flags: flags({ hasPendingPermission: true }), pending: { permission: false, question: false, plan: true } }),
      cand('fail', { flags: flags({ lastError: 'x' }) }),
      cand('run', { flags: flags({ isRunning: true }) }),
      cand('done'),
    ]);
    expect(items).toEqual([
      { threadId: 'perm', title: 'T perm', kind: 'permission' },
      { threadId: 'q', title: 'T q', kind: 'question' },
      { threadId: 'plan', title: 'T plan', kind: 'plan' },
      { threadId: 'fail', title: 'T fail', kind: 'failed' },
    ]);
  });

  it('staged reply/decisions (needsInput) is a question and appears once even when also awaiting', () => {
    const items = attentionItems([
      cand('n', { needsInput: true, flags: flags({ hasPendingPermission: true }), pending: { permission: true, question: false, plan: false } }),
    ]);
    expect(items).toEqual([{ threadId: 'n', title: 'T n', kind: 'question' }]);
  });

  it('a running thread with a stale lastError is not failed (agrees with the board)', () => {
    expect(attentionItems([cand('r', { flags: flags({ isRunning: true, lastError: 'old' }) })])).toEqual([]);
  });

  it('agrees with classifyThreadRow for every awaiting/error flag combination', () => {
    for (const hasPendingPermission of [true, false]) for (const isRunning of [true, false]) for (const lastError of [undefined, 'e']) {
      const f = flags({ hasPendingPermission, isRunning, lastError });
      const state = classifyThreadRow(f);
      const kinds = attentionItems([cand('x', { flags: f, pending: { permission: hasPendingPermission, question: false, plan: false } })]).map((i) => i.kind);
      if (state === 'awaiting') expect(kinds).toEqual(['permission']);
      else if (state === 'error') expect(kinds).toEqual(['failed']);
      else expect(kinds).toEqual([]);
    }
  });

  it('needsYouCount excludes failed', () => {
    expect(needsYouCount([
      { threadId: 'a', title: 'a', kind: 'permission' }, { threadId: 'b', title: 'b', kind: 'failed' }, { threadId: 'c', title: 'c', kind: 'plan' },
    ])).toBe(2);
  });
});

describe('suggestionChips', () => {
  const item = (kind: 'permission' | 'failed') => ({ threadId: kind, title: kind, kind } as const);
  it('always offers Summarise today and What shipped?', () => {
    expect(suggestionChips([]).map((c) => c.label)).toEqual(['Summarise today', 'What shipped?']);
  });
  it('adds counts only when non-zero, needs-me first', () => {
    const labels = suggestionChips([item('permission'), item('permission'), item('failed')]).map((c) => c.label);
    expect(labels).toEqual(['What needs me? (2)', 'Triage failed (1)', 'Summarise today', 'What shipped?']);
    expect(suggestionChips([item('failed')]).map((c) => c.label)).toEqual(['Triage failed (1)', 'Summarise today', 'What shipped?']);
  });
  it('every chip carries a non-empty prompt and a stable id', () => {
    for (const c of suggestionChips([item('permission'), item('failed')])) { expect(c.prompt.length).toBeGreaterThan(0); expect(c.id).toBeTruthy(); }
  });
});

describe('unreadState', () => {
  const m = (id: string, role: string) => ({ id, role });
  it('is read when there is no assistant message', () => {
    expect(unreadState([m('u1', 'user')], undefined)).toEqual({ hasUnread: false, latestAssistantId: undefined });
  });
  it('is unread when the latest assistant message is not the last seen', () => {
    expect(unreadState([m('u1', 'user'), m('a1', 'assistant')], undefined)).toEqual({ hasUnread: true, latestAssistantId: 'a1' });
    expect(unreadState([m('a1', 'assistant'), m('u2', 'user'), m('a2', 'assistant')], 'a1').hasUnread).toBe(true);
  });
  it('is read once seen, ignoring later user/notice messages', () => {
    expect(unreadState([m('a1', 'assistant'), m('u2', 'user'), m('n', 'notice')], 'a1').hasUnread).toBe(false);
  });
  it('treats a vanished lastSeenId as unread rather than throwing', () => {
    expect(unreadState([m('a9', 'assistant')], 'gone').hasUnread).toBe(true);
  });
});

describe('dockTranscript', () => {
  const msg = (id: string, role: string, content: string) => ({ id, role, content });
  it('keeps user and assistant messages only, in order', () => {
    expect(dockTranscript([msg('1', 'user', 'hi'), msg('2', 'compact', 'c'), msg('3', 'assistant', 'yo'), msg('4', 'notice', 'n')]))
      .toEqual([{ id: '1', role: 'user', content: 'hi' }, { id: '3', role: 'assistant', content: 'yo' }]);
  });
  it('drops assistant messages with no text (tool-call-only turns)', () => {
    expect(dockTranscript([msg('1', 'assistant', '  ')])).toEqual([]);
  });
  it('is a pure projection: rolled-back messages disappear when the source shrinks (interrupt)', () => {
    const messages = [msg('1', 'user', 'a'), msg('2', 'user', 'b')];
    expect(dockTranscript(messages)).toHaveLength(2);
    messages.length = 0; // ThreadManager.interrupt() removes unresolved user messages
    expect(dockTranscript(messages)).toEqual([]);
  });
});

describe('splitThreadLinks', () => {
  const threads = [{ id: 'abc-1', title: 'Deploy fix' }, { id: 'def-2', title: 'Docs' }, { id: 'x1', title: 'Twin' }, { id: 'x2', title: 'Twin' }];
  it('resolves by id', () => {
    expect(splitThreadLinks('See [[thread:abc-1|Deploy fix]] now', threads)).toEqual([
      { type: 'text', text: 'See ' }, { type: 'thread', threadId: 'abc-1', label: 'Deploy fix' }, { type: 'text', text: ' now' },
    ]);
  });
  it('id wins over a mismatching label', () => {
    expect(splitThreadLinks('[[thread:def-2|Something else]]', threads)).toEqual([{ type: 'thread', threadId: 'def-2', label: 'Something else' }]);
  });
  it('falls back to an exact title match (ref, then label)', () => {
    expect(splitThreadLinks('[[thread:Docs]]', threads)).toEqual([{ type: 'thread', threadId: 'def-2', label: 'Docs' }]);
    expect(splitThreadLinks('[[thread:bad-id|Docs]]', threads)).toEqual([{ type: 'thread', threadId: 'def-2', label: 'Docs' }]);
  });
  it('is case-sensitive on titles and degrades to plain text when unresolved or ambiguous', () => {
    expect(splitThreadLinks('[[thread:nope|docs]]', threads)).toEqual([{ type: 'text', text: 'docs' }]);
    expect(splitThreadLinks('[[thread:nope]]', threads)).toEqual([{ type: 'text', text: 'nope' }]);
    expect(splitThreadLinks('[[thread:bad|Twin]]', threads)).toEqual([{ type: 'text', text: 'Twin' }]);
  });
  it('leaves ordinary wikilinks and plain text untouched, merging adjacent text', () => {
    expect(splitThreadLinks('a [[Note]] b', threads)).toEqual([{ type: 'text', text: 'a [[Note]] b' }]);
    expect(splitThreadLinks('', threads)).toEqual([]);
    expect(splitThreadLinks('x [[thread:zzz|Gone]] y', threads)).toEqual([{ type: 'text', text: 'x Gone y' }]);
  });
  it('handles several links in one string', () => {
    const segs = splitThreadLinks('[[thread:abc-1|A]] and [[thread:def-2|B]]', threads);
    expect(segs.filter((s) => s.type === 'thread')).toHaveLength(2);
  });
});

describe('countText / tooltipText', () => {
  it('countText reproduces the legacy header text exactly', () => {
    expect(countText(14, 2)).toBe('2 running · 14 total');
    expect(countText(14, 0)).toBe('14 threads');
    expect(countText(1, 0)).toBe('1 thread');
    expect(countText(0, 0)).toBe('0 threads');
  });
  it('tooltipText joins running, total and needs-you', () => {
    expect(tooltipText({ running: 2, total: 14, needsYou: 2 })).toBe('2 running · 14 total · 2 need you');
    expect(tooltipText({ running: 0, total: 14, needsYou: 0 })).toBe('14 total');
    expect(tooltipText({ running: 0, total: 3, needsYou: 1 })).toBe('3 total · 1 needs you');
    expect(tooltipText({ running: 1, total: 1, needsYou: 0 })).toBe('1 running · 1 total');
  });
});

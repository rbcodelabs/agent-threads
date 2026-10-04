import { describe, it, expect } from 'vitest';
import {
  getActivityKind,
  groupToolCalls,
  liveToolGroupKey,
  mergeAdjacentToolOnlyMessages,
  smoothToolGroups,
  pickCurrentTool,
  shouldWrapOuter,
  OUTER_WRAP_ENTRY_THRESHOLD,
  type ActivityKind,
} from '../../src/toolNameUtils';
import type { ChatMessage, ToolCallRecord } from '../../src/types';

function tool(name: string, extra: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return { name, summary: '', timestamp: 1000, ...extra };
}

function toolOnlyMsg(id: string, toolName: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: 1000,
    toolCalls: [tool(toolName, { toolUseId: id })],
    ...extra,
  };
}

// ─── getActivityKind ───────────────────────────────────────────────────────

describe('getActivityKind', () => {
  const cases: Array<[string, ActivityKind]> = [
    ['Bash', 'exploring'],
    ['Read', 'exploring'],
    ['Grep', 'exploring'],
    ['Glob', 'exploring'],
    ['Edit', 'editing'],
    ['Write', 'editing'],
    ['NotebookEdit', 'editing'],
    ['TaskCreate', 'planning'],
    ['TaskUpdate', 'planning'],
    ['ExitPlanMode', 'planning'],
    ['EnterPlanMode', 'planning'],
    ['WebFetch', 'researching'],
    ['WebSearch', 'researching'],
    ['ToolSearch', 'searching'],
    ['Agent', 'searching'],
    ['Skill', 'working'],
    ['TodoWrite', 'working'],
  ];

  it.each(cases)('classifies %s as %s', (name, expected) => {
    expect(getActivityKind(name)).toBe(expected);
  });

  it('classifies an MCP-prefixed tool name using the underlying bare name', () => {
    expect(getActivityKind('mcp__obsidian__Bash')).toBe('exploring');
  });

  it('falls back to "working" for an unknown tool name', () => {
    expect(getActivityKind('SomeRandomFutureTool')).toBe('working');
  });
});

// ─── groupToolCalls ────────────────────────────────────────────────────────

describe('groupToolCalls', () => {
  it('returns [] for an empty array', () => {
    expect(groupToolCalls([])).toEqual([]);
  });

  it('keeps a single isolated call as a "single" entry (no same-kind neighbor)', () => {
    const tools = [tool('Bash')];
    const result = groupToolCalls(tools);
    expect(result).toEqual([{ kind: 'single', tool: tools[0] }]);
  });

  it('groups a run of 2+ same-kind calls into one "group" entry with the correct count', () => {
    const tools = [tool('Read'), tool('Read')];
    const result = groupToolCalls(tools);
    expect(result).toEqual([{ kind: 'group', activityKind: 'exploring', tools }]);
  });

  // NOTE: Bash and Read are BOTH classified as 'exploring' (see getActivityKind
  // above), so Read,Read,Bash would merge into a single 3-item exploring group,
  // not split around Bash. WebFetch ('researching') is used here in place of
  // Bash to actually exercise a group/single/group split across three buckets.
  it('handles a mixed run: Read,Read,WebFetch,Edit,Edit -> [group(exploring,2), single(WebFetch), group(editing,2)]', () => {
    const tools = [tool('Read'), tool('Read'), tool('WebFetch'), tool('Edit'), tool('Edit')];
    const result = groupToolCalls(tools);
    expect(result).toEqual([
      { kind: 'group', activityKind: 'exploring', tools: [tools[0], tools[1]] },
      { kind: 'single', tool: tools[2] },
      { kind: 'group', activityKind: 'editing', tools: [tools[3], tools[4]] },
    ]);
  });

  it('merges a run spanning multiple tool names within the same activity kind (Read,Read,Bash all exploring)', () => {
    const tools = [tool('Read'), tool('Read'), tool('Bash')];
    const result = groupToolCalls(tools);
    expect(result).toEqual([{ kind: 'group', activityKind: 'exploring', tools }]);
  });

  it('leaves every call as "single" when kinds fully alternate', () => {
    const tools = [tool('Bash'), tool('Edit'), tool('Bash'), tool('Edit')];
    const result = groupToolCalls(tools);
    expect(result).toEqual([
      { kind: 'single', tool: tools[0] },
      { kind: 'single', tool: tools[1] },
      { kind: 'single', tool: tools[2] },
      { kind: 'single', tool: tools[3] },
    ]);
  });

  it('groups a longer run of 3+ same-kind calls into one group', () => {
    const tools = [tool('Read'), tool('Read'), tool('Read')];
    const result = groupToolCalls(tools);
    expect(result).toEqual([{ kind: 'group', activityKind: 'exploring', tools }]);
  });

  // A tool call the live view hasn't gotten a result for yet still has
  // status: 'pending' (stamped by ClaudeSession the instant tool_use fires).
  // groupToolCalls only buckets on activity kind, not status, so a pending
  // call in the middle of an otherwise-resolved run must still merge into the
  // same group — this is what lets a live run keep collapsing as new pending
  // calls are appended mid-turn, not just after they all resolve.
  it('treats a "pending" call as groupable alongside "success"/"error" calls of the same kind', () => {
    const tools = [
      tool('Read', { toolUseId: 't1', status: 'success' }),
      tool('Read', { toolUseId: 't2', status: 'success' }),
      tool('Bash', { toolUseId: 't3', status: 'pending' }),
    ];
    const result = groupToolCalls(tools);
    expect(result).toEqual([{ kind: 'group', activityKind: 'exploring', tools }]);
  });

  it('groups two still-pending calls of the same kind together', () => {
    const tools = [
      tool('Edit', { toolUseId: 't1', status: 'pending' }),
      tool('Edit', { toolUseId: 't2', status: 'pending' }),
    ];
    const result = groupToolCalls(tools);
    expect(result).toEqual([{ kind: 'group', activityKind: 'editing', tools }]);
  });

  it.each([
    { names: ['commandExecution', 'commandExecution'], activityKind: 'exploring' as const },
    { names: ['fileChange', 'fileChange'], activityKind: 'editing' as const },
    { names: ['webSearch', 'webSearch'], activityKind: 'researching' as const },
  ])('groups raw Codex $names records as $activityKind', ({ names, activityKind }) => {
    const tools = names.map((name, index) => tool(name, { toolUseId: `codex-${index}` }));
    expect(groupToolCalls(tools)).toEqual([{ kind: 'group', activityKind, tools }]);
  });
});

// ─── smoothToolGroups ──────────────────────────────────────────────────────
// Folds short off-kind interruptions back into their surrounding same-kind
// groups so a normal Read→Edit→Read→TaskUpdate→Bash-style coding loop doesn't
// render as a wall of short flat entries. See the function's doc comment in
// toolNameUtils.ts for the full merge-rule rationale.

describe('smoothToolGroups', () => {
  it('returns [] for an empty array', () => {
    expect(smoothToolGroups([])).toEqual([]);
  });

  it('returns the EXACT SAME array reference as groupToolCalls() when no triple is mergeable (fully alternating kinds)', () => {
    const tools = [tool('Bash'), tool('Edit'), tool('Bash'), tool('Edit')];
    const grouped = groupToolCalls(tools);
    const result = smoothToolGroups(grouped);
    expect(result).toBe(grouped);
  });

  it('merges a single-tool interstitial sandwiched between two same-kind groups', () => {
    const tools = [
      tool('Read'), tool('Read'),
      tool('TaskUpdate'),
      tool('Read'), tool('Read'),
    ];
    const grouped = groupToolCalls(tools);
    expect(grouped).toHaveLength(3); // group(exploring,2), single(TaskUpdate), group(exploring,2)
    const result = smoothToolGroups(grouped);
    expect(result).toEqual([{ kind: 'group', activityKind: 'exploring', tools }]);
  });

  it('merges a 2-tool-group interstitial sandwiched between two same-kind groups', () => {
    const tools = [
      tool('Read'), tool('Read'),
      tool('TaskCreate'), tool('TaskUpdate'),
      tool('Read'), tool('Read'),
    ];
    const grouped = groupToolCalls(tools);
    expect(grouped).toHaveLength(3); // group(exploring,2), group(planning,2), group(exploring,2)
    const result = smoothToolGroups(grouped);
    expect(result).toEqual([{ kind: 'group', activityKind: 'exploring', tools }]);
  });

  it('does NOT merge when the interstitial is 3+ tools', () => {
    const tools = [
      tool('Read'), tool('Read'),
      tool('TaskCreate'), tool('TaskUpdate'), tool('TaskCreate'),
      tool('Read'), tool('Read'),
    ];
    const grouped = groupToolCalls(tools);
    expect(grouped).toHaveLength(3);
    const result = smoothToolGroups(grouped);
    expect(result).toEqual(grouped);
  });

  it('does NOT merge when the two surrounding groups have different activity kinds', () => {
    const tools = [
      tool('Read'), tool('Read'),
      tool('TaskUpdate'),
      tool('Edit'), tool('Edit'),
    ];
    const grouped = groupToolCalls(tools);
    expect(grouped).toHaveLength(3); // group(exploring,2), single(TaskUpdate), group(editing,2)
    const result = smoothToolGroups(grouped);
    expect(result).toEqual(grouped);
  });

  it('does NOT merge a short entry with only one neighbor (start-of-array boundary)', () => {
    const tools = [
      tool('TaskUpdate'),
      tool('Read'), tool('Read'),
    ];
    const grouped = groupToolCalls(tools);
    expect(grouped).toHaveLength(2); // single(TaskUpdate), group(exploring,2)
    const result = smoothToolGroups(grouped);
    expect(result).toEqual(grouped);
  });

  it('does NOT merge a short entry with only one neighbor (end-of-array boundary)', () => {
    const tools = [
      tool('Read'), tool('Read'),
      tool('TaskUpdate'),
    ];
    const grouped = groupToolCalls(tools);
    expect(grouped).toHaveLength(2); // group(exploring,2), single(TaskUpdate)
    const result = smoothToolGroups(grouped);
    expect(result).toEqual(grouped);
  });

  it('cascades merges across the fixed-point loop: two separate mergeable interstitials both fold into one final group', () => {
    const tools = [
      tool('Read'), tool('Read'),
      tool('TaskUpdate'),
      tool('Read'), tool('Read'),
      tool('TaskCreate'),
      tool('Read'), tool('Read'),
    ];
    const grouped = groupToolCalls(tools);
    expect(grouped).toHaveLength(5);
    const result = smoothToolGroups(grouped);
    expect(result).toEqual([{ kind: 'group', activityKind: 'exploring', tools }]);
  });

  it('documented v1 limitation: two CONSECUTIVE short interstitials between same-kind groups do NOT merge', () => {
    const tools = [
      tool('Read'), tool('Read'),
      tool('TaskUpdate'),
      tool('WebFetch'),
      tool('Read'), tool('Read'),
    ];
    const grouped = groupToolCalls(tools);
    expect(grouped).toHaveLength(4); // group(exploring,2), single(TaskUpdate), single(WebFetch), group(exploring,2)
    const result = smoothToolGroups(grouped);
    expect(result).toEqual(grouped);
    expect(result).toHaveLength(4);
  });
});

// ─── pickCurrentTool ───────────────────────────────────────────────────────

describe('pickCurrentTool', () => {
  it('returns null for an empty array', () => {
    expect(pickCurrentTool([])).toBeNull();
  });

  it('returns the LAST pending tool, not the first', () => {
    const tools = [
      tool('Read', { toolUseId: 't1', status: 'pending' }),
      tool('Bash', { toolUseId: 't2', status: 'success' }),
      tool('Edit', { toolUseId: 't3', status: 'pending' }),
    ];
    expect(pickCurrentTool(tools)).toBe(tools[2]);
  });

  it('falls back to the last tool overall when none are pending', () => {
    const tools = [
      tool('Read', { toolUseId: 't1', status: 'success' }),
      tool('Bash', { toolUseId: 't2', status: 'error' }),
    ];
    expect(pickCurrentTool(tools)).toBe(tools[1]);
  });

  it('returns the single element regardless of status', () => {
    const tools = [tool('Read', { toolUseId: 't1', status: 'success' })];
    expect(pickCurrentTool(tools)).toBe(tools[0]);
  });
});

// ─── shouldWrapOuter ───────────────────────────────────────────────────────

describe('shouldWrapOuter', () => {
  it(`returns false at exactly the threshold (${OUTER_WRAP_ENTRY_THRESHOLD} entries)`, () => {
    const entries = Array.from({ length: OUTER_WRAP_ENTRY_THRESHOLD }, () => ({ kind: 'single' as const, tool: tool('Read') }));
    expect(shouldWrapOuter(entries)).toBe(false);
  });

  it(`returns true just above the threshold (${OUTER_WRAP_ENTRY_THRESHOLD + 1} entries)`, () => {
    const entries = Array.from({ length: OUTER_WRAP_ENTRY_THRESHOLD + 1 }, () => ({ kind: 'single' as const, tool: tool('Read') }));
    expect(shouldWrapOuter(entries)).toBe(true);
  });
});

// ─── liveToolGroupKey ──────────────────────────────────────────────────────
// Stable identity for a LIVE group's expand/collapse state across rebuilds —
// see the function's doc comment in toolNameUtils.ts for the full rationale.
// The key must stay the same as a run is extended at the tail (so a group
// the user expands mid-turn doesn't snap back closed on the next event), and
// must change once a genuinely different run starts (a kind-interrupting
// call, or — after that call — a new run of the original kind resuming).

describe('liveToolGroupKey', () => {
  it('is derived from the FIRST call in the run, not the last', () => {
    const tools = [
      tool('Read', { toolUseId: 't1', status: 'success' }),
      tool('Read', { toolUseId: 't2', status: 'pending' }),
    ];
    expect(liveToolGroupKey(tools)).toBe('t1:exploring');
  });

  it('stays the same key when more same-kind calls are appended to the run', () => {
    const before = [
      tool('Read', { toolUseId: 't1', status: 'success' }),
      tool('Read', { toolUseId: 't2', status: 'pending' }),
    ];
    const after = [
      ...before,
      tool('Bash', { toolUseId: 't3', status: 'pending' }),
      tool('Grep', { toolUseId: 't4', status: 'pending' }),
    ];
    expect(liveToolGroupKey(after)).toBe(liveToolGroupKey(before));
  });

  it('produces a different key for a run that starts with a different first call (kind-interrupting call started a new run)', () => {
    // Simulates: Read,Read (group A, key = t1:exploring) then Edit (single,
    // breaks the run) then Edit,Edit (group B — a NEW exploring-adjacent run
    // of a different kind, first call t3). Group B's key must not collide
    // with group A's.
    const groupA = [
      tool('Read', { toolUseId: 't1' }),
      tool('Read', { toolUseId: 't2' }),
    ];
    const groupB = [
      tool('Edit', { toolUseId: 't3' }),
      tool('Edit', { toolUseId: 't4' }),
    ];
    expect(liveToolGroupKey(groupA)).not.toBe(liveToolGroupKey(groupB));
    expect(liveToolGroupKey(groupA)).toBe('t1:exploring');
    expect(liveToolGroupKey(groupB)).toBe('t3:editing');
  });

  it('falls back to timestamp when the first call has no toolUseId', () => {
    const tools = [tool('Read', { toolUseId: undefined, timestamp: 5000 })];
    expect(liveToolGroupKey(tools)).toBe('5000:exploring');
  });
});

// ─── mergeAdjacentToolOnlyMessages ─────────────────────────────────────────
// Regression coverage for the tool-call-fragmentation bug: a commit fixing
// silent data loss in ThreadSession.pumpMessages now persists every tool-only
// SDK assistant message as its own ChatMessage, so a Read → Edit → Bash chain
// produces one separate persisted message per step. This helper re-merges
// adjacent tool-only rows back into one for rendering, without ever touching
// thread.messages itself.

describe('mergeAdjacentToolOnlyMessages', () => {
  it('returns [] for an empty array', () => {
    expect(mergeAdjacentToolOnlyMessages([])).toEqual([]);
  });

  it('returns a single tool-only assistant message as-is (reference equality)', () => {
    const msg = toolOnlyMsg('m1', 'Read');
    const result = mergeAdjacentToolOnlyMessages([msg]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(msg);
  });

  it('merges two consecutive tool-only assistant messages into one row with concatenated toolCalls', () => {
    const m1 = toolOnlyMsg('m1', 'Read');
    const m2 = toolOnlyMsg('m2', 'Edit');
    const result = mergeAdjacentToolOnlyMessages([m1, m2]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('m1');
    expect(result[0].timestamp).toBe(m1.timestamp);
    expect(result[0].role).toBe('assistant');
    expect(result[0].content).toBe('');
    expect(result[0].toolCalls).toEqual([...m1.toolCalls!, ...m2.toolCalls!]);
  });

  it('concatenates toolResultImages in order, skipping messages with none, across 3+ merged messages', () => {
    const m1 = toolOnlyMsg('m1', 'Read');
    const m2 = toolOnlyMsg('m2', 'Read', {
      toolResultImages: [{ mediaType: 'image/png', data: 'aaa' }],
    });
    const m3 = toolOnlyMsg('m3', 'Bash');
    const result = mergeAdjacentToolOnlyMessages([m1, m2, m3]);
    expect(result).toHaveLength(1);
    expect(result[0].toolResultImages).toEqual(m2.toolResultImages);
    expect(result[0].toolCalls).toEqual([
      ...m1.toolCalls!,
      ...m2.toolCalls!,
      ...m3.toolCalls!,
    ]);
  });

  it('takes the last non-undefined cost value found in the run', () => {
    const m1 = toolOnlyMsg('m1', 'Read');
    const m2 = toolOnlyMsg('m2', 'Edit');
    const m3 = toolOnlyMsg('m3', 'Bash', { cost: 0.0042 });
    const result = mergeAdjacentToolOnlyMessages([m1, m2, m3]);
    expect(result).toHaveLength(1);
    expect(result[0].cost).toBe(0.0042);
  });

  it('breaks a run at a narrated message that itself carries tool calls', () => {
    const m1 = toolOnlyMsg('m1', 'Read');
    const m2 = toolOnlyMsg('m2', 'Edit');
    const m3 = toolOnlyMsg('m3', 'Bash', { content: 'Here is what I found.' });
    const m4 = toolOnlyMsg('m4', 'Grep');
    const result = mergeAdjacentToolOnlyMessages([m1, m2, m3, m4]);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('m1');
    expect(result[0].toolCalls).toEqual([...m1.toolCalls!, ...m2.toolCalls!]);
    expect(result[1]).toBe(m3);
    expect(result[2]).toBe(m4);
  });

  it('breaks a run at a user message', () => {
    const m1 = toolOnlyMsg('m1', 'Read');
    const m2 = toolOnlyMsg('m2', 'Edit');
    const userMsg: ChatMessage = { id: 'u1', role: 'user', content: 'go on', timestamp: 1000 };
    const m3 = toolOnlyMsg('m3', 'Bash');
    const m4 = toolOnlyMsg('m4', 'Grep');
    const result = mergeAdjacentToolOnlyMessages([m1, m2, userMsg, m3, m4]);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('m1');
    expect(result[1]).toBe(userMsg);
    expect(result[2].id).toBe('m3');
  });

  it('breaks a run at a role: compact divider the same way', () => {
    const m1 = toolOnlyMsg('m1', 'Read');
    const m2 = toolOnlyMsg('m2', 'Edit');
    const compactMsg: ChatMessage = { id: 'c1', role: 'compact', content: '', timestamp: 1000 };
    const m3 = toolOnlyMsg('m3', 'Bash');
    const m4 = toolOnlyMsg('m4', 'Grep');
    const result = mergeAdjacentToolOnlyMessages([m1, m2, compactMsg, m3, m4]);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('m1');
    expect(result[1]).toBe(compactMsg);
    expect(result[2].id).toBe('m3');
  });

  it('passes through all messages unmerged when kinds fully alternate with no adjacency', () => {
    const m1 = toolOnlyMsg('m1', 'Read');
    const m2: ChatMessage = { id: 'm2', role: 'assistant', content: 'narration', timestamp: 1000 };
    const m3 = toolOnlyMsg('m3', 'Bash');
    const m4: ChatMessage = { id: 'm4', role: 'assistant', content: 'more narration', timestamp: 1000 };
    const result = mergeAdjacentToolOnlyMessages([m1, m2, m3, m4]);
    expect(result).toHaveLength(4);
    expect(result[0]).toBe(m1);
    expect(result[1]).toBe(m2);
    expect(result[2]).toBe(m3);
    expect(result[3]).toBe(m4);
  });
});

describe('groupToolCalls — browser session with interleaved non-browser tools', () => {
  it('keeps one browser card when Bash calls fall between browser calls', () => {
    const entries = groupToolCalls([
      tool('mcp__x__browser_navigate', { toolUseId: 'b1' }),
      tool('Bash', { toolUseId: 'x1' }),
      tool('mcp__x__browser_click', { toolUseId: 'b2' }),
      tool('Bash', { toolUseId: 'x2' }),
      tool('mcp__x__browser_eval', { toolUseId: 'b3' }),
    ]);
    const browsers = entries.filter((e) => e.kind === 'browser');
    expect(browsers).toHaveLength(1);
    expect(browsers[0].kind === 'browser' && browsers[0].tools).toHaveLength(3);
    expect(entries).toHaveLength(2); // card + the two deferred Bash calls grouped
  });

  it('starts a new card after browser_close', () => {
    const entries = groupToolCalls([
      tool('mcp__x__browser_navigate'),
      tool('mcp__x__browser_close'),
      tool('Bash'),
      tool('mcp__x__browser_navigate'),
    ]);
    expect(entries.filter((e) => e.kind === 'browser')).toHaveLength(2);
  });

  it('leaves trailing non-browser tools to normal grouping', () => {
    const entries = groupToolCalls([tool('mcp__x__browser_navigate'), tool('Bash')]);
    expect(entries.map((e) => e.kind)).toEqual(['browser', 'single']);
  });
});

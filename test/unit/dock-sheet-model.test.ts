/**
 * dock-sheet-model.test.ts
 *
 * Pure projection helpers behind the OrchestratorDock reply sheet: what a message
 * contains that the sheet cannot draw (-> "Open full thread" chip), the transcript
 * built ON dockTranscript, and the one-line unread peek text.
 */
import { describe, it, expect } from 'vitest';
import { richnessOf, sheetTranscript, stripVisualizeLines, peekLine, sheetBlock } from '../../src/dockSheetModel';

const msg = (id: string, role: string, content: string, extra: Record<string, unknown> = {}) => ({ id, role, content, ...extra });

describe('richnessOf', () => {
  it('plain text has no rich content', () => {
    expect(richnessOf(msg('1', 'assistant', 'hi'))).toEqual({ images: false, visualize: false, tools: 0 });
  });
  it('user images and assistant tool-result images count as images', () => {
    expect(richnessOf(msg('1', 'user', 'look', { images: [{ mediaType: 'image/png' }] })).images).toBe(true);
    expect(richnessOf(msg('2', 'assistant', 'x', { toolResultImages: [{ mediaType: 'image/png' }] })).images).toBe(true);
    expect(richnessOf(msg('3', 'assistant', 'x', { toolResultImages: [] })).images).toBe(false);
  });
  it('a visualize{...} line is flagged, wherever it sits', () => {
    expect(richnessOf(msg('1', 'assistant', 'before\nvisualize{"path":"/a/b.html"}\nafter')).visualize).toBe(true);
    expect(richnessOf(msg('2', 'assistant', 'we can visualize things')).visualize).toBe(false);
  });
  it('counts tool calls', () => {
    expect(richnessOf(msg('1', 'assistant', 'x', { toolCalls: [{ name: 'Read' }, { name: 'Bash' }] })).tools).toBe(2);
  });
});

describe('stripVisualizeLines', () => {
  it('drops marker lines and keeps the prose', () => {
    expect(stripVisualizeLines('a\nvisualize{"path":"/x.html"}\nb')).toBe('a\nb');
  });
});

describe('sheetTranscript', () => {
  it('is dockTranscript for plain conversations: user/assistant only, in order, blank content skipped', () => {
    const out = sheetTranscript([
      msg('u1', 'user', 'hello'), msg('n1', 'notice', 'bg done'), msg('a1', 'assistant', 'hi there'), msg('a2', 'assistant', '   '),
    ]);
    expect(out.map((e) => [e.id, e.role, e.text])).toEqual([['u1', 'user', 'hello'], ['a1', 'assistant', 'hi there']]);
  });
  it('keeps a text-less message that has rich content (never silently hidden), and marks the chip', () => {
    const out = sheetTranscript([
      msg('a1', 'assistant', '', { toolResultImages: [{ mediaType: 'image/png' }] }),
      msg('a2', 'assistant', 'visualize{"path":"/x.html"}'),
    ]);
    expect(out.map((e) => e.id)).toEqual(['a1', 'a2']);
    expect(out[0].rich.images).toBe(true);
    expect(out[1].rich.visualize).toBe(true);
    expect(out[1].text).toBe('');
  });
  it('a text-less, content-less message is still dropped', () => {
    expect(sheetTranscript([msg('a1', 'assistant', '')])).toEqual([]);
  });
  it('strips visualize lines from the shown text', () => {
    expect(sheetTranscript([msg('a1', 'assistant', 'see\nvisualize{"path":"/x.html"}')])[0].text).toBe('see');
  });
  it('re-projects: removing a message from the source removes it from the output (interrupt rollback)', () => {
    const src = [msg('u1', 'user', 'one'), msg('u2', 'user', 'two')];
    expect(sheetTranscript(src)).toHaveLength(2);
    expect(sheetTranscript([])).toHaveLength(0);
  });
});

describe('peekLine', () => {
  const threads = [{ id: 't1', title: 'Deploy curation' }];
  it('takes the first non-empty line, strips markdown, and turns thread links into their label', () => {
    expect(peekLine('\n\n## **Two** things: [[thread:t1|Deploy fix]] needs you\nmore', threads)).toBe('Two things: Deploy fix needs you');
  });
  it('an unresolved thread link degrades to its label', () => {
    expect(peekLine('see [[thread:nope|Gone]]', threads)).toBe('see Gone');
  });
  it('strips list bullets, quotes and backticks', () => {
    expect(peekLine('- `npm test` is red', threads)).toBe('npm test is red');
  });
  it('caps very long lines', () => {
    expect(peekLine('x'.repeat(1000), threads).length).toBeLessThanOrEqual(241);
  });
  it('empty content yields an empty string', () => {
    expect(peekLine('  \n ', threads)).toBe('');
  });
});

describe('sheetBlock (K2 P5: the sheet notice is shown only when the tray does not already list that thread)', () => {
  const entry = (threadId: string, kind: 'permission' | 'question' | 'plan', withButtons = false) => ({ item: { threadId, kind }, permission: withButtons ? {} : undefined });
  const base = { ownId: 'orch', pendingPlan: false, pendingQuestion: false, pendingPermission: false, tray: [] as ReturnType<typeof entry>[] };

  it('nothing pending: no notice', () => {
    expect(sheetBlock(base)).toBeNull();
  });
  it('a plan / question / permission the tray does not list keeps its notice', () => {
    expect(sheetBlock({ ...base, pendingPlan: true })).toBe('plan');
    expect(sheetBlock({ ...base, pendingQuestion: true })).toBe('question');
    expect(sheetBlock({ ...base, pendingPermission: true })).toBe('permission');
  });
  it('plan and question notices are hidden when the tray lists the orchestrator with that kind', () => {
    expect(sheetBlock({ ...base, pendingPlan: true, tray: [entry('orch', 'plan')] })).toBeNull();
    expect(sheetBlock({ ...base, pendingQuestion: true, tray: [entry('orch', 'question')] })).toBeNull();
  });
  it('another thread in the tray does not hide the orchestrator notice', () => {
    expect(sheetBlock({ ...base, pendingPlan: true, tray: [entry('other', 'plan')] })).toBe('plan');
  });
  it('a card hidden behind "Show N more" (past the first three) does not count as listed', () => {
    const tray = [entry('a', 'permission', true), entry('b', 'permission', true), entry('c', 'permission', true), entry('orch', 'plan')];
    expect(sheetBlock({ ...base, pendingPlan: true, tray })).toBe('plan');
    expect(sheetBlock({ ...base, pendingPlan: true, tray: tray.slice(1) })).toBeNull();
  });
  it('is conservative by design: an entry past the collapsed three is treated as not listed even if the tray is expanded (the notice may repeat the card, it is never missing)', () => {
    // sheetBlock has no expanded-state input: the same answer for the same tray whatever the toggle says.
    const tray = [entry('a', 'permission', true), entry('b', 'permission', true), entry('c', 'permission', true), entry('orch', 'question')];
    expect(sheetBlock({ ...base, pendingQuestion: true, tray })).toBe('question');
  });
  it('P4 permission rule is unchanged: hidden only by the orchestrator\'s OWN permission entry that has buttons', () => {
    expect(sheetBlock({ ...base, pendingPermission: true, tray: [entry('orch', 'permission', true)] })).toBeNull();
    expect(sheetBlock({ ...base, pendingPermission: true, tray: [entry('orch', 'permission', false)] })).toBe('permission');
    expect(sheetBlock({ ...base, pendingPermission: true, tray: [entry('other', 'permission', true)] })).toBe('permission');
  });
  it('falls through plan -> question -> permission, skipping the suppressed ones', () => {
    expect(sheetBlock({ ...base, pendingPlan: true, pendingPermission: true, tray: [entry('orch', 'plan')] })).toBe('permission');
    expect(sheetBlock({ ...base, pendingPlan: true, pendingQuestion: true })).toBe('plan');
  });
});

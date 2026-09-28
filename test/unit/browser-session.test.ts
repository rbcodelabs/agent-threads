import { describe, it, expect } from 'vitest';
import {
  browserSessionKey,
  groupToolCalls,
  isBrowserTool,
  liveToolGroupKey,
  mergeAdjacentToolOnlyMessages,
  shouldWrapOuter,
  smoothToolGroups,
} from '../../src/toolNameUtils';
import {
  assignBrowserScreenshots,
  browserToolSummary,
  buildBrowserSessionViewModel,
  buildStandaloneHandoffViewModel,
  findLastBrowserSessionKey,
  findLiveBrowserSessionKey,
  formatStepDuration,
  parseBrowserToolResult,
  splitDisplayUrl,
  stripUrlDetail,
  type BrowserHandoffInput,
  type BrowserRowInput,
} from '../../src/browserSession';
import type { ChatMessage, ToolCallRecord } from '../../src/types';

let seq = 0;
function tool(name: string, extra: Partial<ToolCallRecord> = {}): ToolCallRecord {
  seq += 1;
  return { name, summary: '', timestamp: 1000 + seq * 10, toolUseId: `t${seq}`, status: 'success', durationMs: 400, ...extra };
}
const b = (short: string, extra: Partial<ToolCallRecord> = {}) => tool(`mcp__claude_threads__browser_${short}`, extra);

describe('isBrowserTool', () => {
  it('matches every prefix shape the hosts produce', () => {
    expect(isBrowserTool('mcp__claude_threads__browser_navigate')).toBe(true);
    expect(isBrowserTool('mcp__obsidian__browser_click')).toBe(true);
    expect(isBrowserTool('claude_threads:browser_screenshot')).toBe(true);
    expect(isBrowserTool('browser_close')).toBe(true);
  });
  it('rejects everything else, including lookalikes', () => {
    expect(isBrowserTool('WebFetch')).toBe(false);
    expect(isBrowserTool('browser_evaluate')).toBe(false);
    expect(isBrowserTool('mcp__other__browse')).toBe(false);
  });
});

describe('groupToolCalls with browser sessions', () => {
  it('turns a run of browser calls into ONE browser entry, never a Researching group', () => {
    const tools = [b('navigate'), b('snapshot'), b('click'), b('read_text')];
    const grouped = groupToolCalls(tools);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ kind: 'browser' });
    expect((grouped[0] as { tools: unknown[] }).tools).toHaveLength(4);
  });

  it('renders even a lone browser call as a session', () => {
    expect(groupToolCalls([b('status')])[0].kind).toBe('browser');
  });

  it('ends a session at browser_close and starts a new one after it', () => {
    const tools = [b('navigate'), b('close'), b('navigate'), b('snapshot')];
    const grouped = groupToolCalls(tools);
    expect(grouped.map((g) => g.kind)).toEqual(['browser', 'browser']);
    expect((grouped[0] as { tools: unknown[] }).tools).toHaveLength(2);
    expect((grouped[1] as { tools: unknown[] }).tools).toHaveLength(2);
  });

  it('a non-browser tool between two browser calls starts a NEW card (v1 limitation)', () => {
    const tools = [b('navigate'), tool('Read'), b('snapshot')];
    expect(groupToolCalls(tools).map((g) => g.kind)).toEqual(['browser', 'single', 'browser']);
  });

  it('keeps neighbouring research tools out of the browser entry', () => {
    const tools = [tool('WebSearch'), tool('WebFetch'), b('navigate'), b('read_text'), tool('WebSearch'), tool('WebFetch')];
    const grouped = groupToolCalls(tools);
    expect(grouped.map((g) => g.kind)).toEqual(['group', 'browser', 'group']);
  });

  it('does not fold a browser card into a surrounding same-kind group when smoothing', () => {
    const tools = [
      tool('WebSearch'), tool('WebFetch'),
      b('navigate'),
      tool('WebSearch'), tool('WebFetch'),
    ];
    const smoothed = smoothToolGroups(groupToolCalls(tools));
    expect(smoothed.map((g) => g.kind)).toEqual(['group', 'browser', 'group']);
  });

  it('still smooths ordinary sandwiches (unchanged behaviour)', () => {
    const tools = [tool('Read'), tool('Grep'), tool('Edit'), tool('Read'), tool('Grep')];
    const smoothed = smoothToolGroups(groupToolCalls(tools));
    expect(smoothed).toHaveLength(1);
  });

  it('counts a browser card as one entry for the outer-wrap threshold', () => {
    const tools = [tool('Edit'), tool('Bash'), b('navigate'), b('click'), b('read_text'), b('close'), tool('Write'), tool('Bash')];
    const grouped = smoothToolGroups(groupToolCalls(tools));
    expect(shouldWrapOuter(grouped)).toBe(false);
  });

  it('keeps a session key stable while it grows and after finalization', () => {
    const first = b('navigate');
    const live = [first, b('snapshot')];
    const grown = [first, b('snapshot'), b('click')];
    expect(browserSessionKey(live)).toBe(browserSessionKey(grown));
    // liveToolGroupKey (activity groups) is intentionally a different namespace.
    expect(browserSessionKey(live)).not.toBe(liveToolGroupKey(live));
  });

  it('a session spanning tool-only messages is re-joined by mergeAdjacentToolOnlyMessages', () => {
    const msgs: ChatMessage[] = ['navigate', 'click', 'screenshot'].map((short, i) => ({
      id: `m${i}`, role: 'assistant', content: '', timestamp: 1, toolCalls: [b(short)],
    }));
    const merged = mergeAdjacentToolOnlyMessages(msgs);
    expect(merged).toHaveLength(1);
    const grouped = groupToolCalls(merged[0].toolCalls!);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].kind).toBe('browser');
  });
});

describe('browserToolSummary', () => {
  it('returns null for non-browser tools', () => {
    expect(browserToolSummary('WebFetch', { url: 'https://x.com' })).toBeNull();
  });
  it('navigate keeps origin+path only', () => {
    expect(browserToolSummary('mcp__claude_threads__browser_navigate', { url: 'https://acme.io/pricing?token=abc#frag' })).toBe('https://acme.io/pricing');
  });
  it('type reports length, never the text', () => {
    const s = browserToolSummary('browser_type', { ref: 'e3', text: 'hunter2', submit: true });
    expect(s).toBe('e3 · 7 chars · Enter');
    expect(s).not.toContain('hunter2');
  });
  it('click reports the ref; resize the size', () => {
    expect(browserToolSummary('browser_click', { ref: 'e5', epoch: 2 })).toBe('e5');
    expect(browserToolSummary('browser_resize', { width: 1280, height: 800 })).toBe('1280×800');
  });
});

describe('parseBrowserToolResult', () => {
  it('extracts url/title from an MCP text block and strips the query', () => {
    const content = [{ type: 'text', text: JSON.stringify({ success: true, url: 'https://acme.io/pricing?x=1', title: 'Pricing', snapshot: 'SECRET PAGE TEXT' }) }];
    expect(parseBrowserToolResult(content, false)).toEqual({ pageUrl: 'https://acme.io/pricing', pageTitle: 'Pricing' });
  });
  it('never carries page content', () => {
    const info = parseBrowserToolResult(JSON.stringify({ success: true, url: 'https://a.io/', title: 't', content: 'BODY' }), false);
    expect(JSON.stringify(info)).not.toContain('BODY');
  });
  it('extracts the error message from a failure', () => {
    const text = JSON.stringify({ success: false, error: { code: 'nav_timeout', message: 'Timed out after 30s', retryable: true } });
    expect(parseBrowserToolResult(text, true)).toEqual({ error: 'Timed out after 30s' });
  });
  it('tolerates prose, images and empties', () => {
    expect(parseBrowserToolResult('not json', false)).toBeUndefined();
    expect(parseBrowserToolResult('not json', true)).toEqual({ error: 'not json' });
    expect(parseBrowserToolResult([{ type: 'image', data: 'AAAA' }], false)).toBeUndefined();
    expect(parseBrowserToolResult(undefined, true)).toEqual({ error: 'The browser action failed.' });
  });
});

describe('formatting helpers', () => {
  it('formats durations', () => {
    expect(formatStepDuration(1234)).toBe('1.2s');
    expect(formatStepDuration(40)).toBe('0.1s');
    expect(formatStepDuration(30_000)).toBe('30s');
    expect(formatStepDuration(65_000)).toBe('1m 5s');
    expect(formatStepDuration(undefined)).toBe('');
  });
  it('splits urls', () => {
    expect(splitDisplayUrl('https://acme.io/pricing')).toEqual({ host: 'acme.io', path: '/pricing' });
    expect(splitDisplayUrl('https://acme.io/')).toEqual({ host: 'acme.io', path: '' });
    expect(splitDisplayUrl(null)).toEqual({ host: '', path: '' });
    expect(stripUrlDetail('https://a.io/p?q=1#h')).toBe('https://a.io/p');
  });
});

describe('buildBrowserSessionViewModel', () => {
  const nav = () => b('navigate', { summary: 'https://acme.io/pricing', browser: { pageUrl: 'https://acme.io/pricing' }, durationMs: 1200 });

  it('navigating: a pending navigate on a live session', () => {
    const vm = buildBrowserSessionViewModel([b('navigate', { status: 'pending', summary: 'https://acme.io/pricing', durationMs: undefined })], { live: true, hasScreenshot: false });
    expect(vm.state).toBe('navigating');
    expect(vm.statusLabel).toBe('Loading');
    expect(vm.verb).toBe('navigate');
    expect(vm.target).toBe('acme.io/pricing');
    expect(vm.viewport).toBe('skeleton');
    expect(vm.steps[0].outcome).toBe('now');
    expect(vm.collapsedByDefault).toBe(false);
  });

  it('live: a pending non-navigate call, or an idle live session', () => {
    const pending = buildBrowserSessionViewModel([nav(), b('click', { status: 'pending', summary: 'e5' })], { live: true, hasScreenshot: true });
    expect(pending.state).toBe('live');
    expect(pending.verb).toBe('click');
    expect(pending.target).toBe('element e5');
    expect(pending.viewport).toBe('screenshot');
    const idle = buildBrowserSessionViewModel([nav(), b('click')], { live: true, hasScreenshot: false });
    expect(idle.state).toBe('live');
  });

  it('finished: collapsed by default, chip and caption summarise the run', () => {
    const vm = buildBrowserSessionViewModel([nav(), b('read_text'), b('screenshot')], { live: false, hasScreenshot: true });
    expect(vm.state).toBe('finished');
    expect(vm.collapsedByDefault).toBe(true);
    expect(vm.verb).toBe('finished');
    expect(vm.chip.title).toBe('Browsed acme.io');
    expect(vm.chip.subtitle).toContain('acme.io/pricing');
    expect(vm.chip.subtitle).toContain('3 steps');
    expect(vm.steps).toHaveLength(3);
    expect(vm.steps[0]).toMatchObject({ verb: 'navigate', target: 'acme.io/pricing', outcome: 'ok', duration: '1.2s' });
  });

  it('a pending call in a NON-live (interrupted) session is finished, not eternally loading', () => {
    const vm = buildBrowserSessionViewModel([nav(), b('click', { status: 'pending' })], { live: false, hasScreenshot: false });
    expect(vm.state).toBe('finished');
    expect(vm.steps[1].outcome).toBe('unknown');
  });

  it('error: the latest failure wins, stays expanded and carries the message', () => {
    const vm = buildBrowserSessionViewModel(
      [nav(), b('click', { status: 'error', summary: 'e5', browser: { error: 'Timed out after 30s' } })],
      { live: false, hasScreenshot: false },
    );
    expect(vm.state).toBe('error');
    expect(vm.collapsedByDefault).toBe(false);
    expect(vm.error).toEqual({ title: 'Click failed', detail: 'Timed out after 30s' });
    expect(vm.verb).toBe('click failed');
    expect(vm.steps[1].outcome).toBe('bad');
    expect(vm.steps[1].target).toContain('Timed out');
  });

  it('error mid-session that the agent recovered from is not an error card, but the step stays red', () => {
    const vm = buildBrowserSessionViewModel(
      [nav(), b('click', { status: 'error', browser: { error: 'stale' } }), b('snapshot'), b('click')],
      { live: false, hasScreenshot: false },
    );
    expect(vm.state).toBe('finished');
    expect(vm.error).toBeUndefined();
    expect(vm.steps[1].outcome).toBe('bad');
  });

  it('ended: browser_close makes it muted and collapsed', () => {
    const vm = buildBrowserSessionViewModel([nav(), b('close')], { live: false, hasScreenshot: true });
    expect(vm.state).toBe('ended');
    expect(vm.chip.title).toBe('Session ended');
    expect(vm.collapsedByDefault).toBe(true);
    expect(vm.statusLabel).toBe('Ended');
  });

  it('a failed close is an error, not an ended session', () => {
    const vm = buildBrowserSessionViewModel([nav(), b('close', { status: 'error' })], { live: false, hasScreenshot: false });
    expect(vm.state).toBe('error');
  });

  it('a session with no known URL still renders (skeleton, generic chip)', () => {
    const vm = buildBrowserSessionViewModel([b('snapshot')], { live: false, hasScreenshot: false });
    expect(vm.url).toBeNull();
    expect(vm.chip.title).toBe('Browsed the web');
  });

  it('follows the page URL from tool results after navigation', () => {
    const vm = buildBrowserSessionViewModel([nav(), b('click', { browser: { pageUrl: 'https://acme.io/signup' } })], { live: true, hasScreenshot: false });
    expect(vm.host).toBe('acme.io');
    expect(vm.path).toBe('/signup');
  });

  describe('handoff overlay', () => {
    const handoff = (over: Partial<BrowserHandoffInput>): BrowserHandoffInput => ({
      phase: 'requested', host: 'accounts.acme.io', url: 'https://accounts.acme.io/login', history: [], ...over,
    });
    const base = () => [nav(), b('click')];

    it('requested: countdown, actions, privacy and a waiting step', () => {
      const vm = buildBrowserSessionViewModel(base(), { live: true, hasScreenshot: true, handoff: handoff({ remainingSeconds: 24 }) });
      expect(vm.mode).toBe('requested');
      expect(vm.banner).toMatchObject({ title: 'Sign-in needed', showRing: true, remainingSeconds: 24 });
      expect(vm.actions).toBe('request');
      expect(vm.privacy).toContain("can't see");
      expect(vm.overlay?.title).toBe('Sign in on a separate page');
      expect(vm.steps[vm.steps.length - 1]).toMatchObject({ verb: 'sign in', outcome: 'wait' });
      expect(vm.collapsedByDefault).toBe(false);
      expect(vm.announce).toContain('30 seconds');
    });

    it('requested clamps the countdown to 0..30', () => {
      const hi = buildBrowserSessionViewModel(base(), { live: true, hasScreenshot: false, handoff: handoff({ remainingSeconds: 99 }) });
      const lo = buildBrowserSessionViewModel(base(), { live: true, hasScreenshot: false, handoff: handoff({ remainingSeconds: -5 }) });
      expect(hi.banner?.remainingSeconds).toBe(30);
      expect(lo.banner?.remainingSeconds).toBe(0);
    });

    it("control: solid banner, the login page URL, frame viewport, cue and Return control", () => {
      const vm = buildBrowserSessionViewModel(base(), { live: true, hasScreenshot: true, handoff: handoff({ phase: 'control' }) });
      expect(vm.mode).toBe('control');
      expect(vm.banner?.title).toBe("You're in control");
      expect(vm.host).toBe('accounts.acme.io');
      expect(vm.path).toBe('/login');
      expect(vm.viewport).toBe('frame');
      expect(vm.cue).toBe('Your input is being sent to this page');
      expect(vm.privacy).toBe("Claude can't see this page or what you type.");
      expect(vm.actions).toBe('control');
      expect(vm.statusLabel).toBe('Manual');
      expect(vm.steps[vm.steps.length - 1]).toMatchObject({ outcome: 'human', target: 'you · accounts.acme.io' });
    });

    it('returned: teal confirmation, no actions', () => {
      const vm = buildBrowserSessionViewModel(base(), { live: true, hasScreenshot: true, handoff: handoff({ phase: 'returned' }) });
      expect(vm.mode).toBe('returned');
      expect(vm.banner).toMatchObject({ title: 'Signed in to accounts.acme.io', subtitle: 'Claude resumed' });
      expect(vm.actions).toBeUndefined();
    });

    it('expired: muted, with a retry hint and a failed step from the handoff history', () => {
      const tools = base();
      const at = (tools[1].timestamp as number) + 5;
      const vm = buildBrowserSessionViewModel(tools, {
        live: true, hasScreenshot: true,
        handoff: handoff({ phase: 'expired', history: [{ at, outcome: 'expired', host: 'accounts.acme.io' }] }),
      });
      expect(vm.mode).toBe('expired');
      expect(vm.hint?.strong).toBe('Ask Claude to retry');
      expect(vm.steps.filter((s) => s.verb === 'sign in')).toEqual([expect.objectContaining({ outcome: 'bad', target: 'expired after 30s' })]);
    });

    it('a handoff that happened before this session started is not shown on it', () => {
      const tools = base();
      const vm = buildBrowserSessionViewModel(tools, {
        live: true, hasScreenshot: false,
        handoff: { phase: null, host: 'x', url: '', history: [{ at: 1, outcome: 'returned', host: 'old.example' }] },
      });
      expect(vm.steps.some((s) => s.verb === 'sign in')).toBe(false);
    });

    it('a finished session with a handoff stays expanded (never collapses away an action)', () => {
      const vm = buildBrowserSessionViewModel([nav(), b('read_text')], { live: false, hasScreenshot: false, handoff: handoff({}) });
      expect(vm.state).toBe('finished');
      expect(vm.collapsedByDefault).toBe(false);
    });

    it('keeps a completed handoff as a "sign in · you" step slotted by time', () => {
      const t1 = nav();
      const t2 = b('click');
      const t3 = b('read_text');
      const at = (t2.timestamp as number) + 1; // after the click, before the read
      const vm = buildBrowserSessionViewModel([t1, t2, t3], {
        live: true, hasScreenshot: false,
        handoff: { phase: null, host: 'accounts.acme.io', url: '', history: [{ at, outcome: 'returned', host: 'accounts.acme.io', durationMs: 14_000 }] },
      });
      expect(vm.mode).toBeNull();
      expect(vm.steps.map((s) => s.verb)).toEqual(['navigate', 'click', 'sign in', 'read']);
      expect(vm.steps[2]).toMatchObject({ outcome: 'ok', target: 'you · accounts.acme.io', duration: '14s' });
    });

    it('builds a standalone card when there are no browser calls', () => {
      const vm = buildStandaloneHandoffViewModel(handoff({ phase: 'control' }));
      expect(vm.mode).toBe('control');
      expect(vm.key).toBe('browser:handoff');
      expect(vm.host).toBe('accounts.acme.io');
      expect(vm.steps).toEqual([expect.objectContaining({ verb: 'sign in', outcome: 'human' })]);
    });
  });
});

describe('screenshot assignment', () => {
  const row = (id: string, tools: ToolCallRecord[], imageCount = 0, over: Partial<BrowserRowInput> = {}): BrowserRowInput =>
    ({ id, role: 'assistant', hasText: false, tools, imageCount, ...over });

  it('pairs a screenshot with the image on the same (merged) row', () => {
    const shot = b('screenshot');
    const nav = b('navigate');
    const result = assignBrowserScreenshots([row('r1', [nav, shot], 1)]);
    expect(result.bySession.get(browserSessionKey([nav, shot]))).toEqual({ rowIndex: 0, imageIndex: 0 });
    expect([...result.claimed.get(0)!]).toEqual([0]);
  });

  it('pairs a screenshot with the image on the NEXT row (ThreadManager attaches it to the following message)', () => {
    const nav = b('navigate');
    const shot = b('screenshot');
    const result = assignBrowserScreenshots([
      row('r1', [nav, shot], 0),
      row('r2', [], 1, { hasText: true }),
    ]);
    expect(result.bySession.get(browserSessionKey([nav, shot]))).toEqual({ rowIndex: 1, imageIndex: 0 });
    expect(result.claimed.get(1)?.has(0)).toBe(true);
  });

  it('gives no image to a session without a screenshot call (skeleton)', () => {
    const nav = b('navigate');
    const result = assignBrowserScreenshots([row('r1', [nav, b('read_text')], 1)]);
    expect(result.bySession.size).toBe(0);
    expect(result.claimed.size).toBe(0);
  });

  it('ignores failed and still-pending screenshots', () => {
    const nav = b('navigate');
    const result = assignBrowserScreenshots([row('r1', [nav, b('screenshot', { status: 'error' }), b('screenshot', { status: 'pending' })], 1)]);
    expect(result.bySession.size).toBe(0);
  });

  it('two screenshots, two images: each maps in order and the card shows the newest of its session', () => {
    const nav = b('navigate');
    const s1 = b('screenshot');
    const s2 = b('screenshot');
    const result = assignBrowserScreenshots([row('r1', [nav, s1, s2], 2)]);
    expect(result.bySession.get(browserSessionKey([nav, s1, s2]))).toEqual({ rowIndex: 0, imageIndex: 1 });
    expect([...result.claimed.get(0)!].sort()).toEqual([0, 1]);
  });

  it('leaves surplus images unclaimed so they still render loose', () => {
    const nav = b('navigate');
    const shot = b('screenshot');
    const result = assignBrowserScreenshots([row('r1', [nav, shot], 3)]);
    expect([...result.claimed.get(0)!]).toEqual([0]);
  });

  it('each session gets its own image across separate cards', () => {
    const a1 = b('navigate'); const a2 = b('screenshot'); const closeA = b('close');
    const c1 = b('navigate'); const c2 = b('screenshot');
    const result = assignBrowserScreenshots([row('r1', [a1, a2, closeA, c1, c2], 2)]);
    expect(result.bySession.get(browserSessionKey([a1, a2, closeA]))?.imageIndex).toBe(0);
    expect(result.bySession.get(browserSessionKey([c1, c2]))?.imageIndex).toBe(1);
  });
});

describe('live / last session detection', () => {
  const row = (id: string, tools: ToolCallRecord[], over: Partial<BrowserRowInput> = {}): BrowserRowInput =>
    ({ id, role: 'assistant', hasText: false, tools, imageCount: 0, ...over });

  it('the last session is live while running and nothing was said after it', () => {
    const nav = b('navigate');
    const rows = [row('u', [], { role: 'user', hasText: true }), row('r', [nav, b('click')])];
    expect(findLiveBrowserSessionKey(rows, true)).toBe(browserSessionKey([nav, b('click')]));
    expect(findLiveBrowserSessionKey(rows, false)).toBeNull();
  });

  it('final prose after the session ends the live state', () => {
    const rows = [row('r', [b('navigate')]), row('t', [], { hasText: true })];
    expect(findLiveBrowserSessionKey(rows, true)).toBeNull();
    expect(findLastBrowserSessionKey(rows)).not.toBeNull();
  });

  it('a user message before any browser call means no live session', () => {
    expect(findLiveBrowserSessionKey([row('r', [b('navigate')]), row('u', [], { role: 'user', hasText: true })], true)).toBeNull();
  });

  it('only the LAST of several sessions is live', () => {
    const a = b('navigate'); const c = b('close'); const d = b('navigate');
    expect(findLiveBrowserSessionKey([row('r', [a, c, d])], true)).toBe(browserSessionKey([d]));
  });
});

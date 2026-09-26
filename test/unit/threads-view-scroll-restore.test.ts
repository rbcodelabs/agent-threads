/**
 * @vitest-environment jsdom
 *
 * Regression coverage for the "panel closes and the conversation jumps to the
 * top" bug: agentScroll used to remember a raw, stale `scrollTop` pixel offset
 * across the sub-agent-view detour. If the main conversation was short enough
 * to already read scrollTop 0 when the user entered the panel — even though
 * they were conceptually "at the bottom" because everything fit on screen —
 * and new messages streamed in while the panel was open, exiting replayed
 * that stale 0 and snapped the user to the literal top of a now-much-longer
 * conversation.
 *
 * The fix tracks *both* the offset and whether it was effectively at the
 * bottom (same 40px stick threshold used elsewhere in ThreadsView), and on
 * restore only replays the exact offset when the user was genuinely scrolled
 * up; otherwise it re-derives "bottom" from the current (post-streaming)
 * scrollHeight via scrollToBottom().
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup/obsidian-dom';
import { ThreadsView } from '../../src/ThreadsView';

function makeMessagesEl(scrollHeight: number, clientHeight: number, scrollTop: number): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  el.scrollTop = scrollTop;
  return el;
}

/** Builds a minimal ThreadsView with only the fields the scroll-restore path touches. */
function buildView(messagesEl: HTMLElement) {
  const view = Object.assign(Object.create(ThreadsView.prototype), {
    activeThreadId: 'thread-1',
    messagesEl,
    agentScroll: new Map(),
    pendingMainScroll: null,
    manager: {
      getSelectedAgentRun: vi.fn(() => undefined),
      getAgentRuns: vi.fn(() => []),
      clearSelectedAgentRun: vi.fn(),
      selectAgentRun: vi.fn(),
    },
  }) as ThreadsView & Record<string, unknown>;
  return view;
}

describe('ThreadsView scroll restore across the sub-agent panel', () => {
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    document.body.innerHTML = '';
    rafCallbacks = [];
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
  });

  function flushRaf(): void {
    const pending = rafCallbacks;
    rafCallbacks = [];
    pending.forEach(cb => cb(0));
  }

  it('lands on the new bottom, not a stale offset, when the user was at the bottom before the panel opened', () => {
    // Main conversation was short: scrollTop 0 already reads as "at bottom"
    // because everything fits (scrollHeight === clientHeight).
    const messagesEl = makeMessagesEl(/* scrollHeight */ 300, /* clientHeight */ 300, /* scrollTop */ 0);
    const view = buildView(messagesEl);

    // Enter the agent view: remembers the main-conversation position.
    (view as any).rememberAgentScroll();
    expect((view as any).agentScroll.get('thread-1:main')).toEqual({ scrollTop: 0, atBottom: true });

    // Simulate content streaming in while the panel was open: the transcript
    // grew substantially, and the DOM was reset to scrollTop 0 (as .empty()
    // does on every render).
    Object.defineProperty(messagesEl, 'scrollHeight', { value: 5000, configurable: true });
    messagesEl.scrollTop = 0;

    // Exit the agent view: transfers the remembered "main" entry into pendingMainScroll,
    // exactly as exitAgentView() does.
    (view as any).pendingMainScroll = (view as any).agentScroll.get(
      `${(view as any).activeThreadId}:main`,
    ) ?? null;
    expect((view as any).pendingMainScroll).toEqual({ scrollTop: 0, atBottom: true });

    // Apply the restore that renderMessagesBody() runs after re-rendering.
    (view as any).applyPendingMainScroll();
    flushRaf();

    // Must land at the CURRENT bottom (scrollToBottom() sets scrollTop to the
    // live scrollHeight), not the stale 0.
    expect(messagesEl.scrollTop).toBe(5000);
    expect((view as any).pendingMainScroll).toBeNull();
  });

  it('preserves the exact scroll offset when the user had scrolled up before the panel opened', () => {
    // Long conversation, user scrolled well above the bottom.
    const messagesEl = makeMessagesEl(/* scrollHeight */ 5000, /* clientHeight */ 300, /* scrollTop */ 1200);
    const view = buildView(messagesEl);

    (view as any).rememberAgentScroll();
    expect((view as any).agentScroll.get('thread-1:main')).toEqual({ scrollTop: 1200, atBottom: false });

    // No content changes while the panel is open this time.
    messagesEl.scrollTop = 0; // .empty()/render reset, as in the real flow
    (view as any).pendingMainScroll = (view as any).agentScroll.get(
      `${(view as any).activeThreadId}:main`,
    ) ?? null;

    (view as any).applyPendingMainScroll();
    flushRaf();

    // Restored to the exact remembered reading position, not snapped to 0 or to bottom.
    expect(messagesEl.scrollTop).toBe(1200);
  });

  it('scrolls to the current bottom when there is no remembered position at all', () => {
    const messagesEl = makeMessagesEl(2000, 300, 0);
    const view = buildView(messagesEl);
    (view as any).pendingMainScroll = null;

    (view as any).applyPendingMainScroll();
    flushRaf();

    expect(messagesEl.scrollTop).toBe(2000);
  });
});

describe('ThreadsView scroll-to-bottom pill', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function buildViewWithPill(messagesEl: HTMLElement) {
    const btn = document.createElement('button');
    btn.className = 'ct-scroll-bottom-pill ct-hidden';
    document.body.appendChild(btn);
    const view = Object.assign(Object.create(ThreadsView.prototype), {
      messagesEl,
      scrollBottomBtn: btn,
    }) as ThreadsView & Record<string, unknown>;
    return { view, btn };
  }

  it('shows the pill once the scroller passes the 40px-from-bottom threshold, hides it once back within it', () => {
    // scrollHeight 1000, clientHeight 300 => the true-bottom scrollTop is 700.
    const messagesEl = makeMessagesEl(1000, 300, 700);
    const { view, btn } = buildViewWithPill(messagesEl);

    (view as any).updateScrollBottomPillVisibility();
    expect(btn.classList.contains('ct-hidden')).toBe(true);

    // Scroll up just past the 40px threshold: distance from bottom becomes 41px.
    messagesEl.scrollTop = 700 - 41;
    (view as any).updateScrollBottomPillVisibility();
    expect(btn.classList.contains('ct-hidden')).toBe(false);

    // Scroll back to exactly the threshold (40px from bottom): counts as "at bottom".
    messagesEl.scrollTop = 700 - 40;
    (view as any).updateScrollBottomPillVisibility();
    expect(btn.classList.contains('ct-hidden')).toBe(true);
  });

  it('clicking the pill invokes scrollToBottom, which lands scrollTop at the current scrollHeight', () => {
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const messagesEl = makeMessagesEl(2500, 300, 100);
    const { view, btn } = buildViewWithPill(messagesEl);
    const scrollToBottomSpy = vi.spyOn(view as any, 'scrollToBottom');
    btn.addEventListener('click', () => (view as any).scrollToBottom());

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(scrollToBottomSpy).toHaveBeenCalledOnce();
    expect(messagesEl.scrollTop).toBe(2500);
  });
});

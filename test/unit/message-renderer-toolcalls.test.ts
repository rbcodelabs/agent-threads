/**
 * @vitest-environment jsdom
 *
 * The shared tool-call renderer (src/messageRenderer/toolCalls.ts): the pills, activity groups and the outer wrap that
 * ThreadsView used to own as private methods. The main panel (ThreadsView) and the dock sheet both build one; the
 * expand/collapse sets and the browser-card behaviour are injected. The structural goldens in
 * threads-view-render-golden.test.ts guard that ThreadsView's output did not change when it started delegating here.
 */
import '../setup/obsidian-dom';
import { describe, expect, it, vi } from 'vitest';
import { ToolCallRenderer, createToolCallExpandState, type ToolCallRendererDeps } from '../../src/messageRenderer';
import { OUTER_WRAP_ENTRY_THRESHOLD, type ToolCallGroup } from '../../src/toolNameUtils';
import type { ToolCallRecord } from '../../src/types';

const t = (name: string, over: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  name, summary: `${name}: x`, status: 'success', toolUseId: `${name}-${Math.random().toString(36).slice(2, 8)}`, ...over,
});

function make(over: Partial<ToolCallRendererDeps> = {}) {
  const state = createToolCallExpandState();
  const deps: ToolCallRendererDeps = {
    state,
    pathContext: () => ({}),
    formatTime: (ts) => `t${ts}`,
    browser: () => null,
    ...over,
  };
  return { renderer: new ToolCallRenderer(deps), state, deps };
}

describe('ToolCallRenderer', () => {
  it('renders one `.ct-tools` wrapper holding a group per unbroken run, collapsed by default, rows carrying the formatted time', () => {
    const { renderer } = make();
    const parent = document.createElement('div');
    const wrapper = renderer.renderToolCalls(parent, [t('Read', { timestamp: 5 }), t('Read'), t('Grep')]);
    expect(wrapper.className).toBe('ct-tools');
    expect(parent.firstElementChild).toBe(wrapper);
    const group = wrapper.querySelector('.ct-tool-group')!;
    expect(wrapper.querySelectorAll(':scope > .ct-tool-group')).toHaveLength(1);
    expect(group.querySelector('.ct-tool-group-header')?.getAttribute('aria-expanded')).toBe('false');
    expect(group.querySelector('.ct-full-content')?.classList.contains('ct-hidden')).toBe(true);
    expect(group.querySelectorAll('.ct-tool-pill')).toHaveLength(3);
    expect(group.querySelector('.ct-tool-pill-ts')?.textContent).toBe('t5');
  });

  it('the injected expand state survives a rebuild: opening a group records it, and the next render draws it open', () => {
    const { renderer, state } = make();
    const tools = [t('Read'), t('Read')];
    const a = renderer.renderToolCalls(document.createElement('div'), tools);
    (a.querySelector('.ct-tool-group-header') as HTMLButtonElement).click();
    expect(state.expandedToolGroups.size).toBe(1);
    const b = renderer.renderToolCalls(document.createElement('div'), tools);
    expect(b.querySelector('.ct-tool-group-header')?.getAttribute('aria-expanded')).toBe('true');
    (b.querySelector('.ct-tool-group-header') as HTMLButtonElement).click();
    expect(state.expandedToolGroups.size).toBe(0);
    expect(state.userCollapsedToolGroups.size).toBe(1);
  });

  it('a failed call flags its group and the group is still collapsed (only a group the user opened stays open)', () => {
    const { renderer } = make();
    const wrapper = renderer.renderToolCalls(document.createElement('div'), [t('Read'), t('Bash', { status: 'error' })]);
    expect(wrapper.querySelector('.ct-tool-group-header')?.classList.contains('ct-tool-error')).toBe(true);
    expect(wrapper.querySelector('.ct-tool-group-header')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('live mode keys groups by the first call and reports each pending pill', () => {
    const { renderer, state } = make();
    const onPillRendered = vi.fn();
    const pending = t('Read', { status: 'pending', toolUseId: 'u1' });
    const wrapper = renderer.renderToolCalls(document.createElement('div'), [pending, t('Read')], { live: true, onPillRendered });
    expect(onPillRendered).toHaveBeenCalledTimes(2);
    expect(onPillRendered.mock.calls[0][0]).toBe(pending);
    (wrapper.querySelector('.ct-tool-group-header') as HTMLButtonElement).click();
    expect(state.liveExpandedToolGroups.size).toBe(1);
    expect(state.expandedToolGroups.size).toBe(0);
  });

  describe('outer wrap and browser entries', () => {
    const browserRun = (): ToolCallRecord[] => [t('browser_navigate'), t('browser_close')];
    const longList = (): ToolCallRecord[] => {
      const out: ToolCallRecord[] = [];
      for (let i = 0; i <= OUTER_WRAP_ENTRY_THRESHOLD / 2 + 1; i++) out.push(t('Bash'), ...browserRun());
      return out;
    };

    it('delegates a browser session to the injected card renderer (and draws pills when there is none)', () => {
      const renderEntry = vi.fn((container: HTMLElement, entry: Extract<ToolCallGroup, { kind: 'browser' }>) => { container.createDiv('card').textContent = String(entry.tools.length); });
      const withCard = make({ browser: () => ({ renderEntry, needsAttention: () => false }) });
      const a = withCard.renderer.renderToolCalls(document.createElement('div'), browserRun());
      expect(renderEntry).toHaveBeenCalledOnce();
      expect(a.querySelector('.card')?.textContent).toBe('2');
      const bare = make();
      const b = bare.renderer.renderToolCalls(document.createElement('div'), browserRun());
      expect(b.querySelectorAll(':scope > .ct-tool-pill')).toHaveLength(2);
    });

    it('wraps a list of more than the threshold of entries in one collapsible outer tier, remembered in the injected set', () => {
      const { renderer, state } = make();
      const wrapper = renderer.renderToolCalls(document.createElement('div'), longList());
      const wrap = wrapper.querySelector(':scope > .ct-tool-outer-wrap')!;
      expect(wrap).not.toBeNull();
      expect(wrap.querySelector('.ct-compressed-summary')?.textContent).toMatch(/^\d+ tool calls, \d+ steps$/);
      expect(wrap.querySelector('.ct-full-content')?.classList.contains('ct-hidden')).toBe(true);
      (wrap.querySelector('.ct-tool-outer-wrap-header .ct-expand-btn') as HTMLButtonElement).click();
      expect(wrap.querySelector('.ct-full-content')?.classList.contains('ct-hidden')).toBe(false);
      expect(state.expandedOuterToolWrap.size).toBe(1);
    });

    it('an error anywhere opens the outer wrap, and a browser card that needs the human does too', () => {
      const { renderer } = make();
      const list = longList();
      list[0] = t('Bash', { status: 'error' });
      const wrap = renderer.renderToolCalls(document.createElement('div'), list).querySelector('.ct-tool-outer-wrap')!;
      expect(wrap.querySelector('.ct-full-content')?.classList.contains('ct-hidden')).toBe(false);
      const attention = make({ browser: () => ({ renderEntry: () => {}, needsAttention: () => true }) });
      const w2 = attention.renderer.renderToolCalls(document.createElement('div'), longList()).querySelector('.ct-tool-outer-wrap')!;
      expect(w2.querySelector('.ct-full-content')?.classList.contains('ct-hidden')).toBe(false);
    });
  });

  it('populateToolCallsWrapper fills a wrapper the caller made (live streaming path)', () => {
    const { renderer } = make();
    const wrapper = document.createElement('div');
    renderer.populateToolCallsWrapper(wrapper, [t('Read'), t('Read')], { live: true });
    expect(wrapper.querySelectorAll('.ct-tool-group')).toHaveLength(1);
  });
});

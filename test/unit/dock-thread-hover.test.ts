/**
 * dock-thread-hover.test.ts
 * @vitest-environment jsdom
 *
 * Hovering (or keyboard-focusing) a `[[thread:id|Title]]` link in the reply sheet highlights its card on the board
 * through deps.focusCard; leaving / blurring / closing / destroying clears it. Click still opens the thread and the
 * sheet stays open.
 */
import '../setup/obsidian-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { OrchestratorDock, type OrchestratorDockDeps } from '../../src/orchestratorDock';
import type { Thread } from '../../src/types';

type Listener = (threadId: string, event: { type: string; [k: string]: unknown }) => void;

function thread(id: string, over: Partial<Thread> = {}): Thread {
  return { id, title: `Thread ${id}`, cwd: '/r', messages: [], createdAt: 0, updatedAt: 0, status: 'waiting', reviewed: true, ...over } as Thread;
}

async function setup(opts: { focusCard?: boolean; mode?: 'pill' | 'orb' } = {}) {
  const content = 'See [[thread:a|Deploy curation]] and [[thread:b|Mobile polish]] and [[thread:gone|Archived one]].';
  const orch = thread('orch', { messages: [{ id: 'm1', role: 'assistant', content, timestamp: 0 }] as never });
  const threads = [orch, thread('a', { title: 'Deploy curation' }), thread('b', { title: 'Mobile polish' })];
  const listeners = new Set<Listener>();
  const emit = (id: string, type: string, extra: Record<string, unknown> = {}) => { for (const l of [...listeners]) l(id, { type, ...extra }); };
  const manager = {
    getThread: (id: string) => threads.find((t) => t.id === id),
    isRunning: () => false, hasPendingPermission: () => false, hasPendingQuestion: () => false, hasPendingPlan: () => false,
    hasActiveBackgroundTasks: () => false, getQueuedMessages: () => [], removeQueuedMessageAt: vi.fn(), getThreadActivity: () => undefined,
    interrupt: vi.fn(), sendMessage: vi.fn(), getPendingPermission: () => undefined, getRemoteScope: () => null, resolvePermission: vi.fn(),
    subscribe: vi.fn((l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; }),
  };
  const focusCard = vi.fn((_id: string, _o: { scroll: boolean; flash: boolean }) => true);
  const clearCardFocus = vi.fn();
  const deps = {
    manager: manager as never, listThreads: () => threads, hasPendingWakeup: () => false,
    getOrchestratorThreadId: () => 'orch', ensureOrchestrator: vi.fn(async () => {}), openThread: vi.fn(),
    mode: () => opts.mode ?? 'pill', daemons: null,
    ...(opts.focusCard === false ? {} : { focusCard, clearCardFocus }),
  } as OrchestratorDockDeps;
  const stage = document.createElement('div');
  stage.className = 'ct-kanban-dispatch';
  const host = document.createElement('div');
  stage.appendChild(host);
  document.body.appendChild(stage);
  const dock = new OrchestratorDock(host, deps);
  dock.mount();
  dock.openSheet();
  await new Promise((r) => setTimeout(r, 0)); // markdown swap
  const link = (id: string) => stage.querySelector(`a.ct-thread-link[data-thread-id="${id}"]`) as HTMLAnchorElement;
  return { dock, deps, stage, focusCard, clearCardFocus, link, emit, orch, manager };
}
const over = (el: Element, rel: Element | null = null) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: rel }));
const out = (el: Element, rel: Element | null = null) => el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: rel }));
const focusIn = (el: Element) => el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
const focusOut = (el: Element, rel: Element | null = null) => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: rel }));

beforeEach(() => { document.body.innerHTML = ''; });

describe('thread-link hover', () => {
  it('hover highlights the card (scroll + flash) and leaving clears it', async () => {
    const t = await setup();
    expect(t.link('a')).toBeTruthy();
    over(t.link('a'));
    expect(t.focusCard).toHaveBeenCalledWith('a', { scroll: true, flash: true });
    out(t.link('a'), t.stage);
    expect(t.clearCardFocus).toHaveBeenCalledTimes(1);
  });

  it('moving from one link to another switches the highlight (no clear in between flicker needed)', async () => {
    const t = await setup();
    over(t.link('a'));
    out(t.link('a'), t.link('b'));
    over(t.link('b'), t.link('a'));
    expect(t.focusCard.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    out(t.link('b'), t.stage);
    expect(t.clearCardFocus).toHaveBeenCalled();
  });

  it('moving inside the same anchor (child to child) does not clear or re-focus', async () => {
    const t = await setup();
    const a = t.link('a');
    over(a);
    const child = document.createElement('span');
    a.appendChild(child);
    out(a, child);
    over(child, a);
    expect(t.focusCard).toHaveBeenCalledTimes(1);
    expect(t.clearCardFocus).not.toHaveBeenCalled();
  });

  it('keyboard focus highlights the card and blur clears it', async () => {
    const t = await setup();
    focusIn(t.link('b'));
    expect(t.focusCard).toHaveBeenCalledWith('b', { scroll: true, flash: true });
    focusOut(t.link('b'), null);
    expect(t.clearCardFocus).toHaveBeenCalledTimes(1);
  });

  it('a link that is not on the board: focusCard is told, returns false, and nothing else happens (click still opens)', async () => {
    const t = await setup();
    t.focusCard.mockReturnValue(false);
    over(t.link('a'));
    expect(() => out(t.link('a'), t.stage)).not.toThrow();
    t.link('a').click();
    expect(t.deps.openThread).toHaveBeenCalledWith('a');
  });

  it('an unresolvable id renders as plain text: no anchor, so nothing to hover', async () => {
    const t = await setup();
    expect(t.link('gone')).toBeNull();
    expect(t.stage.textContent).toContain('Archived one');
  });

  it('non-thread anchors and plain text do not highlight', async () => {
    const t = await setup();
    const a = document.createElement('a');
    a.href = '#';
    t.stage.querySelector('.ct-orch-bubble')!.appendChild(a);
    over(a);
    focusIn(a);
    over(t.stage.querySelector('.ct-orch-bubble')!);
    expect(t.focusCard).not.toHaveBeenCalled();
  });

  it('click opens the thread and the sheet stays open', async () => {
    const t = await setup();
    over(t.link('b'));
    t.link('b').click();
    expect(t.deps.openThread).toHaveBeenCalledWith('b');
    expect((t.stage.querySelector('.ct-orch-sheet') as HTMLElement).hidden).toBe(false);
  });

  it('closing the sheet clears the highlight', async () => {
    const t = await setup();
    over(t.link('a'));
    t.dock.closeSheet();
    expect(t.clearCardFocus).toHaveBeenCalled();
  });

  it('Escape closes the sheet and clears the highlight (focus was on the link)', async () => {
    const t = await setup();
    t.link('a').focus();
    focusIn(t.link('a'));
    t.link('a').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(t.clearCardFocus).toHaveBeenCalled();
  });

  it('the hovered anchor being re-rendered away clears the highlight (no mouseout fires for a removed node)', async () => {
    const t = await setup();
    over(t.link('a'));
    t.orch.messages = [{ id: 'm1', role: 'assistant', content: 'Rewritten without links', timestamp: 0 }] as never;
    t.emit('orch', 'message', { message: { role: 'assistant', content: 'Rewritten without links' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.clearCardFocus).toHaveBeenCalled();
  });

  it('destroy clears the highlight (nothing left behind on the board)', async () => {
    const t = await setup();
    over(t.link('a'));
    t.dock.destroy();
    expect(t.clearCardFocus).toHaveBeenCalled();
  });

  it('is inert when the host provides no focusCard (list-view host later)', async () => {
    const t = await setup({ focusCard: false });
    expect(() => { over(t.link('a')); focusIn(t.link('a')); out(t.link('a'), null); t.dock.closeSheet(); }).not.toThrow();
  });

  it('works in the narrow bottom sheet too (focus highlights; no hover needed on touch)', async () => {
    const t = await setup({ mode: 'orb' });
    focusIn(t.link('a'));
    expect(t.focusCard).toHaveBeenCalledWith('a', { scroll: true, flash: true });
  });
});

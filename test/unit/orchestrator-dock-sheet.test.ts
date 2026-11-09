/**
 * orchestrator-dock-sheet.test.ts
 * @vitest-environment jsdom
 *
 * OrchestratorDock P3: the reply sheet. Fake manager that behaves like the real one where it matters
 * (spike S4): sendMessage appends the user message and emits `user_message_added`; interrupt rolls
 * unresolved user messages back with NO per-message event; a send during a turn coalesces (no `queued`).
 */
import '../setup/obsidian-dom';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OrchestratorDock, type OrchestratorDockDeps } from '../../src/orchestratorDock';
import type { Thread } from '../../src/types';

type Ev = { type: string; [k: string]: unknown };
type Listener = (threadId: string, event: Ev) => void;
type Msg = { id: string; role: string; content: string; timestamp: number; [k: string]: unknown };

let seq = 0;
const m = (role: string, content: string, extra: Record<string, unknown> = {}): Msg => ({ id: `m${++seq}`, role, content, timestamp: 0, ...extra });

function thread(id: string, over: Partial<Thread> = {}): Thread {
  return { id, title: `Thread ${id}`, cwd: '/r', messages: [], createdAt: 0, updatedAt: 0, status: 'waiting', reviewed: true, ...over } as Thread;
}

function setup(opts: {
  messages?: Msg[];
  running?: boolean;
  mode?: 'pill' | 'orb';
  orchestratorId?: string | undefined;
  lastError?: string;
  plan?: boolean; question?: boolean; permission?: boolean;
  deferSend?: boolean;
  sendThrowsAfterEcho?: boolean;
  activity?: string;
} = {}) {
  const orch = thread('orch', { messages: (opts.messages ?? []) as never, ...(opts.lastError ? { lastError: opts.lastError } : {}) });
  const others = [thread('a', { title: 'Deploy curation' }), thread('b')];
  const threads = [orch, ...others];
  const s = {
    running: new Set<string>(opts.running ? ['orch'] : []),
    mode: opts.mode ?? ('pill' as 'pill' | 'orb'),
    orchestratorId: 'orchestratorId' in opts ? opts.orchestratorId : 'orch',
    queue: [] as { text: string }[],
    activity: opts.activity as string | undefined,
    plan: !!opts.plan, question: !!opts.question, permission: !!opts.permission,
  };
  const listeners = new Set<Listener>();
  const emit = (type: string, extra: Record<string, unknown> = {}, id = 'orch') => { for (const l of [...listeners]) l(id, { type, ...extra }); };
  let pendingResolve: (() => void) | null = null;
  const manager = {
    getThread: (id: string) => threads.find((t) => t.id === id),
    isRunning: (id: string) => s.running.has(id),
    hasPendingPermission: (id: string) => id === 'orch' && s.permission,
    hasPendingQuestion: (id: string) => id === 'orch' && s.question,
    hasPendingPlan: (id: string) => id === 'orch' && s.plan,
    hasActiveBackgroundTasks: () => false,
    getQueuedMessages: vi.fn(() => s.queue),
    removeQueuedMessageAt: vi.fn((_id: string, i: number) => { s.queue.splice(i, 1); }),
    getThreadActivity: vi.fn(() => s.activity),
    interrupt: vi.fn(async () => {
      // Real manager: removes every unresolved user message, emits interrupted then run_state_settled.
      orch.messages = (orch.messages as unknown as Msg[]).filter((x) => x.role !== 'user' || !(x as Msg).unresolved) as never;
      s.running.delete('orch');
      emit('interrupted'); emit('run_state_settled');
    }),
    sendMessage: vi.fn(async (id: string, text: string) => {
      const user = m('user', text, { unresolved: true });
      (orch.messages as unknown as Msg[]).push(user);
      emit('user_message_added', { message: user }, id); // precedes streaming_start: isRunning is still the PRIOR state
      if (opts.deferSend) await new Promise<void>((r) => { pendingResolve = r; });
      if (opts.sendThrowsAfterEcho) throw new Error('turn failed to start');
    }),
    subscribe: vi.fn((l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; }),
  };
  const deps: OrchestratorDockDeps = {
    manager: manager as never,
    listThreads: () => threads,
    hasPendingWakeup: () => false,
    getOrchestratorThreadId: () => s.orchestratorId,
    ensureOrchestrator: vi.fn(async () => { s.orchestratorId = 'orch'; }),
    openThread: vi.fn(),
    openLink: vi.fn(),
    resolveLink: vi.fn(() => true),
    mode: () => s.mode,
    daemons: null,
  };
  const stage = document.createElement('div');
  stage.className = 'ct-kanban-dispatch';
  const host = document.createElement('div');
  stage.appendChild(host);
  document.body.appendChild(stage);
  const dock = new OrchestratorDock(host, deps);
  dock.mount();
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => stage.querySelector(sel) as T | null;
  const qa = (sel: string) => [...stage.querySelectorAll(sel)] as HTMLElement[];
  return {
    dock, deps, manager, host, stage, s, emit, orch, q, qa,
    resolveSend: () => pendingResolve?.(),
    sheet: () => q('.ct-orch-sheet'),
    isOpen: () => { const el = q('.ct-orch-sheet'); return !!el && !el.hidden; },
    input: () => stage.querySelector('textarea.ct-orch-input') as HTMLTextAreaElement | null,
    dot: () => q('[data-testid="orchestrator-dot"]')!,
    root: () => q('.ct-orch-dock')!,
    say: (content: string) => { const a = m('assistant', content); (orch.messages as unknown as Msg[]).push(a); emit('message', { message: a }); return a; },
    type: (text: string) => { const el = stage.querySelector('textarea.ct-orch-input') as HTMLTextAreaElement; el.value = text; el.dispatchEvent(new Event('input')); return el; },
    enter: (el: HTMLElement) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    esc: (el: HTMLElement) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
  };
}
type T = ReturnType<typeof setup>;
const flush = () => new Promise((r) => setTimeout(r, 0));
/** A real user scroll: input intent (wheel) followed by the scroll event. A bare scroll event is programmatic / layout. */
function userScrollsUp(scroll: HTMLElement): void {
  scroll.dispatchEvent(new Event('wheel', { bubbles: true }));
  scroll.dispatchEvent(new Event('scroll'));
}
const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

beforeEach(() => { document.body.innerHTML = ''; seq = 0; });
afterEach(() => { vi.useRealTimers(); });

describe('sheet shell', () => {
  it('is a child of the pill (.ct-kanban-dispatch), closed until something opens it', () => {
    const t = setup();
    const sheet = t.sheet();
    expect(sheet).toBeTruthy();
    expect(sheet!.closest('.ct-kanban-dispatch')).toBe(t.stage);
    expect(t.isOpen()).toBe(false);
  });

  it('is a labelled, non-modal dialog with a polite live region', () => {
    const t = setup({ messages: [m('assistant', 'hi')] });
    t.dock.openSheet();
    const sheet = t.sheet()!;
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(sheet.getAttribute('aria-modal')).not.toBe('true');
    const label = t.q(`#${sheet.getAttribute('aria-labelledby')}`)!;
    expect(label.textContent).toBe('Portfolio orchestrator');
    expect(t.q('.ct-orch-live')!.getAttribute('aria-live')).toBe('polite');
  });

  it('header: orb, title, "Open full thread ↗" (openThread) and a close button; no Dock button in v1', () => {
    const t = setup({ messages: [m('assistant', 'hi')] });
    t.dock.openSheet();
    const open = t.q<HTMLButtonElement>('.ct-orch-sheet-full')!;
    open.click();
    expect(t.deps.openThread).toHaveBeenCalledWith('orch');
    expect(t.sheet()!.textContent).not.toMatch(/Dock/);
    t.q<HTMLButtonElement>('.ct-orch-sheet-head button[aria-label="Close"]')!.click();
    expect(t.isOpen()).toBe(false);
  });

  it('the header orb rings while the orchestrator works', () => {
    const t = setup({ messages: [m('assistant', 'hi')], running: true });
    t.dock.openSheet();
    expect(t.q('.ct-orch-sheet-orb')!.classList.contains('ct-orch-orb-spinning')).toBe(true);
  });

  it('layoutChanged sets the max-height variable from the view height (60%, capped above the pill)', () => {
    const t = setup({ messages: [m('assistant', 'hi')] });
    const root = document.createElement('div'); root.className = 'ct-agents-root';
    Object.defineProperty(root, 'clientHeight', { value: 1000 });
    document.body.appendChild(root); root.appendChild(t.stage);
    t.dock.openSheet();
    t.dock.layoutChanged();
    const px = parseFloat(t.sheet()!.style.getPropertyValue('--ct-orch-sheet-max'));
    expect(px).toBeGreaterThan(0);
    expect(px).toBeLessThanOrEqual(600);
  });
});

describe('opening and closing', () => {
  it('sending opens the sheet and does NOT hand off to the full thread', async () => {
    const t = setup();
    t.enter(t.type('What needs me?'));
    expect(t.isOpen()).toBe(true);
    await vi.waitFor(() => expect(t.manager.sendMessage).toHaveBeenCalledWith('orch', 'What needs me?'));
    expect(t.deps.openThread).not.toHaveBeenCalled();
    expect(t.input()!.value).toBe('');
    await vi.waitFor(() => expect(t.q('.ct-orch-msg[data-role="user"]')?.textContent).toContain('What needs me?'));
  });

  it('clicking the field opens the sheet when a transcript exists, not when it is empty', () => {
    const empty = setup();
    empty.input()!.click();
    expect(empty.isOpen()).toBe(false);
    document.body.innerHTML = '';
    const t = setup({ messages: [m('user', 'hi'), m('assistant', 'hello')] });
    t.input()!.click();
    expect(t.isOpen()).toBe(true);
  });

  it('Enter on an EMPTY field opens the sheet when a transcript exists (keyboard route) and sends nothing', () => {
    const t = setup({ messages: [m('assistant', 'hello')] });
    t.enter(t.input()!);
    expect(t.isOpen()).toBe(true);
    expect(t.manager.sendMessage).not.toHaveBeenCalled();
  });

  it('stays open when the board is clicked (approved decision)', () => {
    const t = setup({ messages: [m('assistant', 'hello')] });
    t.dock.openSheet();
    const card = document.createElement('div'); document.body.appendChild(card);
    card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); card.click();
    expect(t.isOpen()).toBe(true);
  });

  it('Esc in the field closes the sheet and focus stays in the field; with the sheet closed Esc just blurs', () => {
    const t = setup({ messages: [m('assistant', 'hello')] });
    t.dock.openSheet();
    const el = t.input()!; el.focus();
    t.esc(el);
    expect(t.isOpen()).toBe(false);
    expect(document.activeElement).toBe(el);
    t.esc(el);
    expect(document.activeElement).not.toBe(el);
  });

  it('Esc on a control inside the sheet closes it and returns focus to the field', () => {
    const t = setup({ messages: [m('assistant', 'hello')] });
    t.dock.openSheet();
    const close = t.q<HTMLButtonElement>('.ct-orch-sheet-head button[aria-label="Close"]')!;
    close.focus();
    t.esc(close);
    expect(t.isOpen()).toBe(false);
    expect(document.activeElement).toBe(t.input());
  });

  it('Esc elsewhere in the pill (e.g. the search box) does not close the sheet', () => {
    const t = setup({ messages: [m('assistant', 'hello')] });
    t.dock.openSheet();
    const search = document.createElement('input'); t.stage.appendChild(search);
    t.esc(search);
    expect(t.isOpen()).toBe(true);
  });

  it('closes when the orchestrator thread is deleted', () => {
    const t = setup({ messages: [m('assistant', 'hello')] });
    t.dock.openSheet();
    t.s.orchestratorId = undefined; t.emit('thread_deleted');
    expect(t.isOpen()).toBe(false);
  });
});

describe('transcript is a projection of thread.messages', () => {
  it('renders user and assistant bubbles in order; assistant text as markdown', async () => {
    const t = setup({ messages: [m('user', 'what now?'), m('assistant', 'Two **things** wait')] });
    t.dock.openSheet();
    const rows = t.qa('.ct-orch-msg');
    expect(rows.map((r) => r.dataset.role)).toEqual(['user', 'assistant']);
    await vi.waitFor(() => expect(rows[1].querySelector('strong')?.textContent).toBe('things'));
    expect(rows[0].textContent).toContain('what now?');
  });

  it('user_message_added puts the user bubble in', () => {
    const t = setup({ messages: [m('assistant', 'hi')] });
    t.dock.openSheet();
    const u = m('user', 'fresh'); (t.orch.messages as unknown as Msg[]).push(u);
    t.emit('user_message_added', { message: u });
    expect(t.qa('.ct-orch-msg[data-role="user"]')).toHaveLength(1);
  });

  it('interrupt rolls the unresolved user message back: the bubble disappears (never append-only)', async () => {
    const t = setup({ messages: [m('assistant', 'hi')] });
    t.dock.openSheet();
    t.s.running.add('orch');
    const el = t.type('first'); t.enter(el);
    await flush();
    t.type('second'); t.enter(t.input()!);
    await vi.waitFor(() => expect(t.qa('.ct-orch-msg[data-role="user"]')).toHaveLength(2));
    await t.manager.interrupt();
    expect(t.qa('.ct-orch-msg[data-role="user"]')).toHaveLength(0);
    expect(t.qa('.ct-orch-msg')).toHaveLength(1);
  });

  it('keeps the DOM node of an unchanged message across re-derivations', async () => {
    const t = setup({ messages: [m('user', 'one'), m('assistant', 'two')] });
    t.dock.openSheet();
    const before = t.qa('.ct-orch-msg')[0];
    t.say('three');
    expect(t.qa('.ct-orch-msg')[0]).toBe(before);
    await vi.waitFor(() => expect(t.qa('.ct-orch-msg')).toHaveLength(3));
  });

  it('ignores events from other threads', () => {
    const t = setup({ messages: [m('assistant', 'hi')] });
    t.dock.openSheet();
    t.emit('token', { text: 'leak' }, 'a');
    expect(t.q('[data-streaming]')).toBeNull();
  });

  it('thread-link anchors open that thread; [[note]] anchors go through openLink', async () => {
    const t = setup({ messages: [m('assistant', 'See [[thread:a|Deploy fix]] and [[Plan note]]')] });
    t.dock.openSheet();
    const a = await vi.waitFor(() => { const x = t.q('a.ct-thread-link'); expect(x).toBeTruthy(); return x!; });
    a.click();
    expect(t.deps.openThread).toHaveBeenCalledWith('a');
    t.q('a.internal-link')!.click();
    expect(t.deps.openLink).toHaveBeenCalledWith('Plan note');
  });
});

describe('streaming', () => {
  it('appends token text live to a streaming bubble, then reconciles with the real message', async () => {
    const t = setup({ messages: [m('user', 'go')], running: true });
    t.dock.openSheet();
    t.emit('streaming_start');
    t.emit('token', { text: 'Two ' }); t.emit('token', { text: 'things' });
    await frame();
    const live = t.q('[data-streaming]')!;
    expect(live.textContent).toContain('Two things');
    t.say('Two things are waiting');
    expect(t.q('[data-streaming]')).toBeNull();
    await vi.waitFor(() => expect(t.qa('.ct-orch-msg[data-role="assistant"]')[0]?.textContent).toContain('Two things are waiting'));
    expect(t.qa('.ct-orch-msg[data-role="assistant"]')).toHaveLength(1);
  });

  it('streamed text is text, never markup', async () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    t.dock.openSheet();
    t.emit('token', { text: '<img src=x onerror=alert(1)>' });
    await frame();
    expect(t.q('[data-streaming] img')).toBeNull();
    expect(t.q('[data-streaming]')!.textContent).toContain('<img');
  });

  it('stream_reset and interrupted clear the live bubble', () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    t.dock.openSheet();
    t.emit('token', { text: 'abc' });
    t.emit('stream_reset');
    expect(t.q('[data-streaming]')).toBeNull();
    t.emit('token', { text: 'def' });
    t.s.running.delete('orch'); t.emit('interrupted');
    expect(t.q('[data-streaming]')).toBeNull();
  });

  it('tokens are buffered while the sheet is closed and show when it opens', () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    t.emit('token', { text: 'early' });
    t.dock.openSheet();
    expect(t.q('[data-streaming]')!.textContent).toContain('early');
  });

  it('activity line shows the manager activity while running and disappears when it stops', () => {
    const t = setup({ running: true, messages: [m('user', 'go')], activity: 'Reading 14 threads' });
    t.dock.openSheet();
    expect(t.q('.ct-orch-activity')!.textContent).toContain('Reading 14 threads');
    t.s.activity = 'Editing PlaceCard.tsx';
    t.emit('tool_use', { record: { name: 'Edit', summary: 'Editing PlaceCard.tsx' } });
    expect(t.q('.ct-orch-activity')!.textContent).toContain('Editing PlaceCard.tsx');
    t.s.running.delete('orch'); t.emit('done');
    expect(t.q('.ct-orch-activity')).toBeNull();
  });

  it('a running turn with no activity yet still says it is working', () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    t.dock.openSheet();
    expect(t.q('.ct-orch-activity')!.textContent).toMatch(/\S/);
  });

  it('live-region announcements are throttled: a burst of tokens announces at most once', () => {
    vi.useFakeTimers();
    const t = setup({ running: true, messages: [m('user', 'go')] });
    t.dock.openSheet();
    const live = t.q('.ct-orch-live')!;
    const writes: string[] = [];
    new MutationObserver(() => writes.push(live.textContent ?? '')).observe(live, { childList: true, characterData: true, subtree: true });
    for (let i = 0; i < 50; i++) t.emit('token', { text: 'word ' });
    vi.advanceTimersByTime(500);
    expect(live.textContent!.length).toBeLessThan(200);
    expect(t.q('[data-streaming]')!.getAttribute('aria-live')).toBe('off');
  });

  it('the finished reply is announced once', async () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    t.dock.openSheet();
    t.say('All clear today.');
    await vi.waitFor(() => expect(t.q('.ct-orch-live')!.textContent).toContain('All clear today.'));
  });
});

describe('Stop', () => {
  it('replaces Send while the orchestrator runs and interrupts the turn', async () => {
    const t = setup({ running: true, messages: [m('user', 'go')], mode: 'orb' });
    t.dock.openSheet();
    expect(t.q('.ct-orch-send')!.hidden).toBe(true);
    const stop = t.q<HTMLButtonElement>('.ct-orch-stop')!;
    expect(stop.hidden).toBe(false);
    stop.click();
    expect(t.manager.interrupt).toHaveBeenCalledWith('orch');
    await vi.waitFor(() => expect(t.q('.ct-orch-stop')!.hidden).toBe(true));
    expect(t.q('.ct-orch-send')!.hidden).toBe(false);
  });

  it('pill mode: Stop sits in the field while the sheet is open and running; never when idle or closed', () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    expect(t.q('.ct-orch-stop')!.hidden).toBe(true);
    t.dock.openSheet();
    expect(t.q('.ct-orch-stop')!.hidden).toBe(false);
    expect(t.q('.ct-orch-stop')!.closest('.ct-orch-field')).toBeTruthy();
    t.s.running.delete('orch'); t.emit('done');
    expect(t.q('.ct-orch-stop')!.hidden).toBe(true);
  });

  it('a rejected interrupt tells the user instead of failing silently', async () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    t.manager.interrupt.mockRejectedValueOnce(new Error('nope'));
    t.dock.openSheet();
    expect(() => t.q<HTMLButtonElement>('.ct-orch-stop')!.click()).not.toThrow();
    await flush();
    expect(t.q<HTMLButtonElement>('.ct-orch-stop')!.disabled).toBe(false);
  });
});

describe('send while the orchestrator is working', () => {
  it('shows "Sent, will be picked up" under that bubble (never the word queued), until the turn settles', async () => {
    const t = setup({ running: true, messages: [m('user', 'first'), m('assistant', 'on it')] });
    t.dock.openSheet();
    t.enter(t.type('also check CI'));
    await vi.waitFor(() => expect(t.q('.ct-orch-pickup')).toBeTruthy());
    expect(t.q('.ct-orch-pickup')!.textContent).toBe('Sent, will be picked up');
    expect(t.q('.ct-orch-pickup')!.closest('.ct-orch-msg')!.textContent).toContain('also check CI');
    expect(t.sheet()!.textContent!.toLowerCase()).not.toContain('queued');
    expect(t.stage.innerHTML.toLowerCase()).not.toMatch(/queued/);
    t.s.running.delete('orch'); t.emit('run_state_settled');
    expect(t.q('.ct-orch-pickup')).toBeNull();
  });

  it('an idle orchestrator gets no status line', async () => {
    const t = setup({ messages: [m('assistant', 'hi')] });
    t.enter(t.type('hello'));
    await vi.waitFor(() => expect(t.qa('.ct-orch-msg[data-role="user"]')).toHaveLength(1));
    expect(t.q('.ct-orch-pickup')).toBeNull();
  });

  it('interrupt clears the status together with the rolled-back message', async () => {
    const t = setup({ running: true, messages: [m('assistant', 'x')] });
    t.dock.openSheet();
    t.enter(t.type('mid turn'));
    await vi.waitFor(() => expect(t.q('.ct-orch-pickup')).toBeTruthy());
    await t.manager.interrupt();
    expect(t.q('.ct-orch-pickup')).toBeNull();
    expect(t.qa('.ct-orch-msg[data-role="user"]')).toHaveLength(0);
  });
});

describe('Waiting to send (manager local queue: plan gate, harness switch, goal context)', () => {
  it('lists getQueuedMessages separately, refreshed on queued / dequeued', () => {
    const t = setup({ messages: [m('assistant', 'plan pending')] });
    t.dock.openSheet();
    expect(t.q('.ct-orch-waiting')).toBeNull();
    t.s.queue.push({ text: 'ship it after the plan' });
    t.emit('queued', { text: 'ship it after the plan' });
    const box = t.q('.ct-orch-waiting')!;
    expect(box.textContent).toContain('Waiting to send');
    expect(box.textContent).toContain('ship it after the plan');
    expect(t.sheet()!.textContent!.toLowerCase()).not.toContain('queued');
    t.s.queue.length = 0; t.emit('dequeued', { text: 'ship it after the plan' });
    expect(t.q('.ct-orch-waiting')).toBeNull();
  });

  it('remove calls removeQueuedMessageAt with the index and re-renders itself (the manager emits no event)', () => {
    const t = setup({ messages: [m('assistant', 'x')] });
    t.dock.openSheet();
    t.s.queue.push({ text: 'one' }, { text: 'two' });
    t.emit('queued');
    t.qa('.ct-orch-waiting button')[1].click();
    expect(t.manager.removeQueuedMessageAt).toHaveBeenCalledWith('orch', 1);
    expect(t.qa('.ct-orch-waiting li').map((li) => li.textContent)).toEqual([expect.stringContaining('one')]);
  });

  it('a stale remove (the queue changed under the user) does not delete the wrong message', () => {
    const t = setup({ messages: [m('assistant', 'x')] });
    t.dock.openSheet();
    t.s.queue.push({ text: 'one' }, { text: 'two' });
    t.emit('queued');
    t.s.queue.shift(); // 'one' was dequeued without us seeing the event yet
    t.qa('.ct-orch-waiting button')[0].click();
    expect(t.manager.removeQueuedMessageAt).not.toHaveBeenCalled();
    expect(t.qa('.ct-orch-waiting li')).toHaveLength(1);
  });

  it('remove buttons carry an accessible name', () => {
    const t = setup({ messages: [m('assistant', 'x')] });
    t.dock.openSheet();
    t.s.queue.push({ text: 'one' }); t.emit('queued');
    expect(t.q('.ct-orch-waiting button')!.getAttribute('aria-label')).toMatch(/Remove/);
  });
});

describe('suggestion chips', () => {
  it('shown above the pill when the field is focused and the transcript is empty; clicking one sends its text', async () => {
    const t = setup();
    t.input()!.focus();
    const strip = t.q('.ct-orch-chips')!;
    expect(strip.hidden).toBe(false);
    const labels = [...strip.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toContain('Summarise today');
    expect(labels).toContain('What shipped?');
    [...strip.querySelectorAll('button')].find((b) => b.textContent === 'Summarise today')!.click();
    await vi.waitFor(() => expect(t.manager.sendMessage).toHaveBeenCalledWith('orch', expect.stringMatching(/Summarise today/)));
    expect(t.isOpen()).toBe(true);
    expect(t.q('.ct-orch-chips')!.hidden).toBe(true);
  });

  it('hidden when the transcript is not empty, before focus, and after the field loses focus elsewhere', () => {
    const t = setup();
    expect(t.q('.ct-orch-chips')?.hidden ?? true).toBe(true);
    t.input()!.focus();
    expect(t.q('.ct-orch-chips')!.hidden).toBe(false);
    const other = document.createElement('button'); document.body.appendChild(other); other.focus();
    expect(t.q('.ct-orch-chips')!.hidden).toBe(true);
    document.body.innerHTML = '';
    const full = setup({ messages: [m('assistant', 'hi')] });
    full.input()!.focus();
    expect(full.q('.ct-orch-chips')?.hidden ?? true).toBe(true);
  });

  it('orb mode: the empty sheet offers the chips inside the sheet', () => {
    const t = setup({ mode: 'orb' });
    t.dock.openSheet();
    expect(t.q('.ct-orch-sheet .ct-orch-empty button')).toBeTruthy();
  });
});

describe('unread reply + peek', () => {
  it('history at mount is not unread', () => {
    const t = setup({ messages: [m('assistant', 'old news')] });
    expect(t.q('.ct-orch-peek')!.hidden).toBe(true);
    expect(t.dot().classList.contains('ct-orch-dot-attention')).toBe(false);
  });

  it('a reply while the sheet is closed shows ONE peek (orb, first line, Open, close) and keeps the dot until read', () => {
    const t = setup({ messages: [m('user', 'q'), m('assistant', 'old')] });
    t.say('Two things are waiting\nmore detail');
    const peek = t.q('.ct-orch-peek')!;
    expect(peek.hidden).toBe(false);
    expect(peek.textContent).toContain('Two things are waiting');
    expect(peek.textContent).not.toContain('more detail');
    expect(peek.querySelector('.ct-orch-peek-orb')).toBeTruthy();
    expect(t.dot().classList.contains('ct-orch-dot-attention')).toBe(true);
    expect(t.root().dataset.state).toBe('attention');
    t.say('A newer reply');
    expect(t.qa('.ct-orch-peek')).toHaveLength(1);
    expect(t.q('.ct-orch-peek')!.textContent).toContain('A newer reply');
  });

  it('dismissing the peek keeps the dot; Open opens the sheet, marks read and clears both', () => {
    const t = setup({ messages: [m('assistant', 'old')] });
    t.say('new one');
    t.q<HTMLButtonElement>('.ct-orch-peek button[aria-label="Dismiss"]')!.click();
    expect(t.q('.ct-orch-peek')!.hidden).toBe(true);
    expect(t.dot().classList.contains('ct-orch-dot-attention')).toBe(true);
    t.say('another');
    t.qa('.ct-orch-peek button').find((b) => b.textContent === 'Open')!.click();
    expect(t.isOpen()).toBe(true);
    expect(t.q('.ct-orch-peek')!.hidden).toBe(true);
    expect(t.dot().classList.contains('ct-orch-dot-attention')).toBe(false);
  });

  it('auto-dismisses after ~8s (dot stays)', () => {
    vi.useFakeTimers();
    const t = setup({ messages: [m('assistant', 'old')] });
    t.say('new');
    expect(t.q('.ct-orch-peek')!.hidden).toBe(false);
    vi.advanceTimersByTime(7900);
    expect(t.q('.ct-orch-peek')!.hidden).toBe(false);
    vi.advanceTimersByTime(300);
    expect(t.q('.ct-orch-peek')!.hidden).toBe(true);
    expect(t.dot().classList.contains('ct-orch-dot-attention')).toBe(true);
  });

  it('a reply while the sheet is open is read immediately: no peek, no dot', () => {
    const t = setup({ messages: [m('assistant', 'old')] });
    t.dock.openSheet();
    t.say('live reply');
    expect(t.q('.ct-orch-peek')?.hidden ?? true).toBe(true);
    expect(t.dot().classList.contains('ct-orch-dot-attention')).toBe(false);
  });

  it('closing the sheet does not make already-read replies unread again', () => {
    const t = setup({ messages: [m('assistant', 'old')] });
    t.dock.openSheet(); t.say('read me'); t.dock.closeSheet();
    expect(t.dot().classList.contains('ct-orch-dot-attention')).toBe(false);
  });

  it('thread links in the peek line show their label as plain text', () => {
    const t = setup({ messages: [m('assistant', 'old')] });
    t.say('[[thread:a|Deploy fix]] needs you');
    expect(t.q('.ct-orch-peek')!.textContent).toContain('Deploy fix needs you');
    expect(t.q('.ct-orch-peek a')).toBeNull();
  });

  it('a user message never triggers a peek', () => {
    const t = setup({ messages: [m('assistant', 'old')] });
    const u = m('user', 'mine'); (t.orch.messages as unknown as Msg[]).push(u);
    t.emit('user_message_added', { message: u });
    expect(t.q('.ct-orch-peek')?.hidden ?? true).toBe(true);
  });
});

describe('offline / error / none with the sheet', () => {
  it('orb mode, errored: the sheet shows P2\'s reason + action in the composer slot and no textarea', async () => {
    const t = setup({ mode: 'orb', messages: [m('assistant', 'last words')], lastError: 'boom' });
    t.dock.openSheet();
    const slot = t.q('.ct-orch-sheet-composer')!;
    expect(slot.querySelector('.ct-orch-reason')!.textContent).toBe('Orchestrator errored — boom');
    expect(slot.querySelector('textarea')).toBeNull();
    slot.querySelector<HTMLElement>('.ct-orch-action')!.click();
    expect(t.deps.openThread).toHaveBeenCalledWith('orch');
    await vi.waitFor(() => expect(t.sheet()!.textContent).toContain('last words'));
  });

  it('pill mode, errored: the field carries the reason; the orb opens the sheet so the transcript is reachable', async () => {
    const t = setup({ messages: [m('assistant', 'last words')], lastError: 'boom' });
    expect(t.input()).toBeNull();
    t.q<HTMLElement>('.ct-orch-orb')!.click();
    expect(t.isOpen()).toBe(true);
    await vi.waitFor(() => expect(t.sheet()!.textContent).toContain('last words'));
    expect(t.q('.ct-orch-field .ct-orch-reason')).toBeTruthy();
  });

  it('the body returns from the sheet to the field when the sheet closes (one textarea, one reason, always)', () => {
    const t = setup({ mode: 'orb', messages: [m('assistant', 'x')] });
    t.dock.openSheet();
    expect(t.q('.ct-orch-sheet-composer textarea')).toBeTruthy();
    t.dock.closeSheet();
    expect(t.q('.ct-orch-sheet-composer textarea')).toBeNull();
    expect(t.qa('textarea.ct-orch-input')).toHaveLength(1);
  });

  it('the draft survives the textarea moving into the sheet and back', () => {
    const t = setup({ mode: 'orb', messages: [m('assistant', 'x')] });
    t.type('half written');
    t.dock.openSheet();
    expect(t.input()!.value).toBe('half written');
    t.dock.closeSheet();
    expect(t.input()!.value).toBe('half written');
  });

  it('a failed send is never dropped: the draft comes back and the sheet stays open', async () => {
    const t = setup({ messages: [m('assistant', 'x')] });
    t.manager.sendMessage.mockRejectedValueOnce(new Error('boom'));
    t.enter(t.type('precious'));
    await vi.waitFor(() => expect(t.input()!.value).toBe('precious'));
    expect(t.isOpen()).toBe(true);
  });
});

describe('orb mode (bottom sheet)', () => {
  it('orb click opens the sheet (no hand-off); the one textarea lives in the sheet with Send', async () => {
    const t = setup({ mode: 'orb', messages: [m('assistant', 'x')] });
    t.q<HTMLElement>('.ct-orch-orb')!.click();
    expect(t.isOpen()).toBe(true);
    expect(t.deps.openThread).not.toHaveBeenCalled();
    expect(t.sheet()!.dataset.mode).toBe('orb');
    t.type('hello');
    t.q<HTMLButtonElement>('.ct-orch-send')!.click();
    await vi.waitFor(() => expect(t.manager.sendMessage).toHaveBeenCalledWith('orch', 'hello'));
  });

  it('orb click with no orchestrator sets one up and opens the (empty) sheet', async () => {
    const t = setup({ mode: 'orb', orchestratorId: undefined });
    t.q<HTMLElement>('.ct-orch-orb')!.click();
    await vi.waitFor(() => expect(t.deps.ensureOrchestrator).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(t.isOpen()).toBe(true));
    expect(t.deps.openThread).not.toHaveBeenCalled();
  });

  it('Esc returns focus to the orb in orb mode', () => {
    const t = setup({ mode: 'orb', messages: [m('assistant', 'x')] });
    t.dock.openSheet();
    t.esc(t.input()!);
    expect(t.isOpen()).toBe(false);
    expect(document.activeElement).toBe(t.q('.ct-orch-orb'));
  });

  it('crossing the breakpoint with the sheet open keeps it open and re-homes the textarea', () => {
    const t = setup({ messages: [m('assistant', 'x')] });
    t.dock.openSheet();
    t.s.mode = 'orb'; t.dock.relayout();
    expect(t.isOpen()).toBe(true);
    expect(t.q('.ct-orch-sheet-composer textarea')).toBeTruthy();
    t.s.mode = 'pill'; t.dock.relayout();
    expect(t.q('.ct-orch-sheet-composer textarea')).toBeNull();
    expect(t.q('.ct-orch-field textarea')).toBeTruthy();
  });
});

describe('content the sheet cannot draw', () => {
  it('images, visualize markers and tool calls give that message a quiet "Open full thread ↗" chip', () => {
    const t = setup({ messages: [
      m('assistant', 'a picture', { toolResultImages: [{ mediaType: 'image/png' }] }),
      m('assistant', 'chart\nvisualize{"path":"/x.html"}'),
      m('assistant', 'did work', { toolCalls: [{ name: 'Read', summary: 'r' }] }),
      m('assistant', 'plain'),
    ] });
    t.dock.openSheet();
    const rows = t.qa('.ct-orch-msg');
    expect(rows.map((r) => !!r.querySelector('.ct-orch-chip-full'))).toEqual([true, true, true, false]);
    rows[0].querySelector<HTMLElement>('.ct-orch-chip-full')!.click();
    expect(t.deps.openThread).toHaveBeenCalledWith('orch');
    expect(rows[1].textContent).not.toContain('visualize{');
  });

  it('a text-less message with an image is a row with the chip, not a blank bubble and not hidden', () => {
    const t = setup({ messages: [m('assistant', '', { toolResultImages: [{ mediaType: 'image/png' }] })] });
    t.dock.openSheet();
    const row = t.q('.ct-orch-msg')!;
    expect(row.querySelector('.ct-orch-chip-full')).toBeTruthy();
    expect(row.querySelector('.ct-orch-bubble')?.textContent ?? '').toMatch(/\S/);
  });

  it('a pending plan / question / permission on the orchestrator shows a notice with the chip', () => {
    for (const k of ['plan', 'question', 'permission'] as const) {
      document.body.innerHTML = '';
      const t = setup({ messages: [m('assistant', 'x')], [k]: true });
      t.dock.openSheet();
      const n = t.q('.ct-orch-notice')!;
      expect(n.textContent, k).toContain(k);
      n.querySelector<HTMLElement>('.ct-orch-chip-full')!.click();
      expect(t.deps.openThread).toHaveBeenCalledWith('orch');
    }
  });
});

describe('send discipline', () => {
  it('rapid Enter sends once; the field is cleared synchronously', async () => {
    const t = setup({ deferSend: true });
    const el = t.type('once');
    t.enter(el); t.enter(el); t.enter(el);
    expect(t.manager.sendMessage).toHaveBeenCalledTimes(1);
    expect(el.value).toBe('');
    t.type('twice while pending'); t.enter(el);
    expect(t.manager.sendMessage).toHaveBeenCalledTimes(1);
    t.resolveSend();
    await flush();
  });

  it('observed events never send', () => {
    const t = setup({ messages: [m('assistant', 'x')] });
    t.dock.openSheet();
    for (const e of ['message', 'done', 'user_message_added', 'queued', 'dequeued', 'interrupted', 'run_state_settled']) t.emit(e);
    expect(t.manager.sendMessage).not.toHaveBeenCalled();
  });
});

describe('lifecycle', () => {
  it('destroy removes the sheet, peek and chips, clears the peek timer, and ignores later events', () => {
    vi.useFakeTimers();
    const t = setup({ messages: [m('assistant', 'old')] });
    t.say('new');
    t.dock.destroy();
    expect(t.stage.querySelector('.ct-orch-sheet, .ct-orch-peek, .ct-orch-chips')).toBeNull();
    expect(() => { t.emit('token', { text: 'x' }); vi.advanceTimersByTime(10_000); }).not.toThrow();
  });

  it('an orchestrator swap resets the streaming buffer and unread baseline', () => {
    const t = setup({ messages: [m('assistant', 'old')], running: true });
    t.emit('token', { text: 'stale' });
    t.s.orchestratorId = 'orch'; t.emit('thread_created');
    t.dock.openSheet();
    expect(t.dot().classList.contains('ct-orch-dot-attention')).toBe(false);
  });
});


// ── Review round (#903 at 854b52c) ─────────────────────────────────────────────────────────────────────────────────
describe('review: wikilinks never navigate the board (B1)', () => {
  it('an unresolvable [[note]] renders as inert text: no anchor, no click target', async () => {
    const t = setup({ messages: [m('assistant', 'see [[Ghost note]] and [[Real note]]')] });
    t.deps.resolveLink = vi.fn((href: string) => href === 'Real note');
    t.dock.destroy(); document.body.innerHTML = '';
    const u = setup({ messages: [m('assistant', 'see [[Ghost note]] and [[Real note]]')] });
    u.deps.resolveLink = vi.fn((href: string) => href === 'Real note');
    u.dock.openSheet();
    await vi.waitFor(() => expect(u.qa('a.internal-link').length + u.qa('.ct-orch-wikilink-unresolved').length).toBe(2));
    expect(u.qa('a.internal-link').map((a) => a.textContent)).toEqual(['Real note']);
    expect(u.qa('.ct-orch-wikilink-unresolved').map((a) => a.textContent)).toEqual(['Ghost note']);
    u.q('a.internal-link')!.click();
    expect(u.deps.openLink).toHaveBeenCalledWith('Real note');
  });

  it('without an openLink dependency wikilinks are inert text (nothing to click)', async () => {
    const t = setup({ messages: [m('assistant', 'see [[Note]]')] });
    (t.deps as { openLink?: unknown }).openLink = undefined;
    t.dock.openSheet();
    await vi.waitFor(() => expect(t.sheet()!.textContent).toContain('Note'));
    expect(t.q('a.internal-link')).toBeNull();
  });
});

describe('review: assistant row hand-off (A1, A2)', () => {
  it('the new assistant row is seeded with its text immediately (never empty while markdown renders)', () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    t.dock.openSheet();
    t.emit('token', { text: 'Done' });
    t.say('**Done** and dusted');
    const row = t.qa('.ct-orch-msg[data-role="assistant"]').find((r) => !r.dataset.streaming)!;
    expect(row.querySelector('.ct-orch-bubble')!.textContent).toBe('**Done** and dusted');
  });

  it('re-pins to the bottom after the async markdown lands, if the user was pinned', async () => {
    const t = setup({ messages: [m('user', 'hi')] });
    t.dock.openSheet();
    const scroll = t.q('.ct-orch-sheet-scroll')!;
    let height = 400;
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 200 });
    scroll.scrollTop = 200;
    t.say('first');
    height = 900; // markdown swap makes the row taller
    await vi.waitFor(() => expect(scroll.scrollTop).toBe(900));
  });

  it('does not yank the user down when they scrolled up', async () => {
    const t = setup({ messages: [m('user', 'hi')] });
    t.dock.openSheet();
    const scroll = t.q('.ct-orch-sheet-scroll')!;
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => 2000 });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 200 });
    scroll.scrollTop = 100;
    userScrollsUp(scroll); // the user scrolled up
    t.say('later');
    await flush(); await flush();
    expect(scroll.scrollTop).toBe(100);
  });
});

describe('review: streaming writes are coalesced (A4)', () => {
  it('a burst of tokens in one frame produces at most one text write', async () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    t.dock.openSheet();
    t.emit('token', { text: 'a' });
    await frame();
    const bubble = t.q('[data-streaming] .ct-orch-bubble')!;
    let writes = 0;
    new MutationObserver((rs) => { writes += rs.length; }).observe(bubble, { childList: true, characterData: true, subtree: true });
    for (let i = 0; i < 200; i++) t.emit('token', { text: 'x' });
    expect(bubble.textContent).toBe('a');
    await frame(); await flush();
    expect(bubble.textContent!.length).toBe(201);
    expect(writes).toBeLessThanOrEqual(2);
  });
});

describe('review: a stopped partial stays visible (A5; the manager does not persist partial text on interrupt)', () => {
  it('after interrupt the partial streamed text remains, labelled Stopped, until the next send', async () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    t.dock.openSheet();
    t.emit('token', { text: 'Half an answ' });
    await frame();
    await t.manager.interrupt();
    const row = t.q('[data-stopped]')!;
    expect(row.textContent).toContain('Half an answ');
    expect(row.textContent).toContain('Stopped');
    expect(t.q('[data-streaming]')).toBeNull();
    t.enter(t.type('try again'));
    await vi.waitFor(() => expect(t.q('[data-stopped]')).toBeNull());
  });

  it('a normally finished turn leaves no Stopped row', async () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    t.dock.openSheet();
    t.emit('token', { text: 'full' });
    t.say('full'); t.s.running.delete('orch'); t.emit('done');
    expect(t.q('[data-stopped]')).toBeNull();
  });
});

describe('review: chips only when they can send (A6)', () => {
  it('orb mode + error: the empty sheet offers no chips (the input is a reason, not a field)', () => {
    const t = setup({ mode: 'orb', lastError: 'boom' });
    t.dock.openSheet();
    expect(t.q('.ct-orch-sheet .ct-orch-empty button')).toBeNull();
  });

  it('chips on screen when the orchestrator errors are hidden, and a stale chip click sends nothing', () => {
    const t = setup();
    t.input()!.focus();
    const chip = t.q('.ct-orch-chips button')!;
    t.orch.lastError = 'boom'; t.emit('error');
    expect(t.q('.ct-orch-chips')!.hidden).toBe(true);
    chip.click();
    expect(t.manager.sendMessage).not.toHaveBeenCalled();
  });
});

describe('review: Escape during IME composition (A7)', () => {
  it('does not close the sheet from the field, the dock root or the sheet', () => {
    const t = setup({ messages: [m('assistant', 'x')] });
    t.dock.openSheet();
    const field = t.input()!;
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }));
      expect(t.isOpen()).toBe(true);
      t.q('.ct-orch-sheet-close')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }));
      expect(t.isOpen()).toBe(true);
    }
  });
});

describe('review: no rebuild churn (A8)', () => {
  it('a focused Remove button keeps its node and focus across refreshes', () => {
    const t = setup({ messages: [m('assistant', 'x')] });
    t.dock.openSheet();
    t.s.queue.push({ text: 'one' }); t.emit('queued');
    const btn = t.q<HTMLButtonElement>('.ct-orch-waiting button')!;
    btn.focus();
    t.emit('done'); t.emit('message', { message: m('user', 'noise') }); t.emit('queued');
    expect(t.q('.ct-orch-waiting button')).toBe(btn);
    expect(document.activeElement).toBe(btn);
  });

  it('the notice and the empty-state chips keep their nodes while unchanged', () => {
    const t = setup({ mode: 'orb', plan: true });
    t.dock.openSheet();
    const chip = t.q('.ct-orch-notice button')!;
    const sug = t.q('.ct-orch-empty button')!;
    t.emit('done'); t.emit('queued');
    expect(t.q('.ct-orch-notice button')).toBe(chip);
    expect(t.q('.ct-orch-empty button')).toBe(sug);
  });
});

describe('review: max height follows the CURRENT mode (A9)', () => {
  it('crossing the breakpoint with the sheet open re-measures with the new mode', () => {
    const t = setup({ messages: [m('assistant', 'x')] });
    const root = document.createElement('div'); root.className = 'ct-agents-root';
    Object.defineProperty(root, 'clientHeight', { value: 500 });
    document.body.appendChild(root); root.appendChild(t.stage);
    Object.defineProperty(t.stage, 'offsetHeight', { value: 300 });
    t.dock.openSheet();
    const max = () => parseFloat(t.sheet()!.style.getPropertyValue('--ct-orch-sheet-max'));
    expect(max()).toBe(148); // pill: room above the pill (500 - 36 - 300 - 16)
    t.s.mode = 'orb'; t.dock.relayout();
    expect(max()).toBe(300); // bottom sheet: the 60% cap only
  });
});

describe('review: focus moves into the dialog (A11)', () => {
  it('peek Open in pill mode puts focus in the composer field', () => {
    const t = setup({ messages: [m('assistant', 'old')] });
    t.say('new');
    t.qa('.ct-orch-peek button').find((b) => b.textContent === 'Open')!.click();
    expect(document.activeElement).toBe(t.input());
  });

  it('pill + error (no input): opening the sheet focuses a control inside the dialog, and closing returns to the field area', () => {
    const t = setup({ messages: [m('assistant', 'x')], lastError: 'boom' });
    t.q<HTMLElement>('.ct-orch-orb')!.click();
    expect(t.sheet()!.contains(document.activeElement)).toBe(true);
    t.q<HTMLButtonElement>('.ct-orch-sheet-close')!.click();
    expect(t.sheet()!.contains(document.activeElement)).toBe(false);
  });

  it('orb + offline-style reason in the sheet: focus lands on the action, not the page', () => {
    const t = setup({ mode: 'orb', messages: [m('assistant', 'x')], lastError: 'boom' });
    t.dock.openSheet();
    expect(t.sheet()!.contains(document.activeElement)).toBe(true);
  });
});

describe('review: a failure AFTER the user message was recorded does not duplicate it (A13)', () => {
  it('sendMessage that throws after user_message_added keeps the draft empty (the message is in the transcript)', async () => {
    const t = setup({ sendThrowsAfterEcho: true, messages: [m('assistant', 'x')] });
    t.enter(t.type('already recorded'));
    await vi.waitFor(() => expect(t.qa('.ct-orch-msg[data-role="user"]')).toHaveLength(1));
    await flush();
    expect(t.input()!.value).toBe('');
  });
});

describe('review: link clicks (A14)', () => {
  it('an https link opens externally with noopener; javascript: never does', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const t = setup({ messages: [m('assistant', '[ext](https://example.com/x) [bad](javascript:alert(1))')] });
    t.dock.openSheet();
    await vi.waitFor(() => expect(t.qa('.ct-orch-bubble a').length).toBeGreaterThan(0));
    const links = t.qa('.ct-orch-bubble a') as HTMLAnchorElement[];
    const ext = links.find((a) => a.getAttribute('href')?.startsWith('https'))!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    ext.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener,noreferrer');
    open.mockClear();
    for (const a of links.filter((l) => !l.getAttribute('href')?.startsWith('https'))) {
      const e2 = new MouseEvent('click', { bubbles: true, cancelable: true });
      a.dispatchEvent(e2);
      expect(e2.defaultPrevented).toBe(true);
    }
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
});


// ── QA round (#903 at 854b52c) ─────────────────────────────────────────────────────────────────────────────────────
function metrics(scroll: HTMLElement, height: number, client = 200) {
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => client });
}

describe('QA D1: the sheet lands on the latest message', () => {
  it('opening a long transcript scrolls to the bottom', () => {
    const t = setup({ messages: Array.from({ length: 30 }, (_, i) => m(i % 2 ? 'assistant' : 'user', `line ${i}`)) });
    metrics(t.q('.ct-orch-sheet-scroll')!, 3000);
    t.dock.openSheet();
    expect(t.q('.ct-orch-sheet-scroll')!.scrollTop).toBe(3000);
  });

  it('sending while scrolled up scrolls to the new message, and following resumes', async () => {
    const t = setup({ messages: Array.from({ length: 30 }, (_, i) => m(i % 2 ? 'assistant' : 'user', `line ${i}`)) });
    const scroll = t.q('.ct-orch-sheet-scroll')!;
    let h = 3000; Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => h });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 200 });
    t.dock.openSheet();
    scroll.scrollTop = 100; userScrollsUp(scroll); // the user scrolled up
    h = 3200; // the new user bubble adds height
    t.enter(t.type('latest question'));
    await vi.waitFor(() => expect(scroll.scrollTop).toBe(3200));
  });

  it('a reply arriving while the user is scrolled up does not yank them down', async () => {
    const t = setup({ messages: [m('user', 'a')] });
    const scroll = t.q('.ct-orch-sheet-scroll')!;
    metrics(scroll, 3000);
    t.dock.openSheet();
    scroll.scrollTop = 100; userScrollsUp(scroll);
    t.say('background reply');
    await flush(); await flush();
    expect(scroll.scrollTop).toBe(100);
  });
});

describe('QA D4: chips stay reachable by keyboard', () => {
  it('moving focus from the field to a chip keeps the strip; leaving both hides it', () => {
    const t = setup();
    t.input()!.focus();
    const chip = t.q<HTMLButtonElement>('.ct-orch-chips button')!;
    chip.focus();
    expect(t.q('.ct-orch-chips')!.hidden).toBe(false);
    const other = document.createElement('button'); document.body.appendChild(other);
    other.focus();
    expect(t.q('.ct-orch-chips')!.hidden).toBe(true);
  });
});

describe('QA D5: tab order and the modal bottom sheet', () => {
  it('the sheet, peek and chips live inside the dock root, right after the field (Tab reaches them next)', () => {
    const t = setup({ messages: [m('assistant', 'x')] });
    const root = t.q('.ct-orch-dock')!;
    expect(root.contains(t.sheet())).toBe(true);
    expect(root.contains(t.q('.ct-orch-chips'))).toBe(true);
    expect(root.contains(t.q('.ct-orch-peek'))).toBe(true);
    const field = t.q('.ct-orch-field')!;
    expect(field.compareDocumentPosition(t.sheet()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('narrow: the bottom sheet is aria-modal and Tab wraps inside it in both directions; pill mode is non-modal', () => {
    const t = setup({ mode: 'orb', messages: [m('assistant', 'x')] });
    t.dock.openSheet();
    const sheet = t.sheet()!;
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    const focusables = () => [...sheet.querySelectorAll<HTMLElement>('button, a[href], textarea')].filter((e) => !e.hidden && !(e as HTMLButtonElement).disabled && !e.closest('[hidden]'));
    const list = focusables();
    list[list.length - 1].focus();
    const fwd = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    list[list.length - 1].dispatchEvent(fwd);
    expect(fwd.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(list[0]);
    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    list[0].dispatchEvent(back);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(list[list.length - 1]);
    t.s.mode = 'pill'; t.dock.relayout();
    expect(sheet.getAttribute('aria-modal')).not.toBe('true');
  });

  it('closing the narrow sheet restores focus to the orb', () => {
    const t = setup({ mode: 'orb', messages: [m('assistant', 'x')] });
    t.dock.openSheet();
    t.q<HTMLButtonElement>('.ct-orch-sheet-close')!.click();
    expect(document.activeElement).toBe(t.q('.ct-orch-orb'));
  });
});

describe('QA D7: no font-dependent glyphs in the sheet chrome', () => {
  it('header, remove, peek and stop use icons + aria-labels, not ↗ ✕ ■ text', () => {
    const t = setup({ running: true, messages: [m('assistant', 'x', { toolCalls: [{ name: 'Read' }] })] });
    t.s.queue.push({ text: 'held' });
    t.dock.openSheet();
    t.emit('queued');
    t.say('another');
    expect(t.sheet()!.textContent).not.toMatch(/[↗✕■]/);
    expect(t.q('.ct-orch-peek')?.textContent ?? '').not.toMatch(/[↗✕■]/);
    expect(t.q('.ct-orch-sheet-full')!.getAttribute('aria-label')).toBe('Open full thread');
    expect(t.q('.ct-orch-chip-full')!.getAttribute('aria-label')).toBe('Open full thread');
  });
});

describe('QA D8: the full error reason is shown (wrapped), not cut at 60 characters', () => {
  it('a 100-char error is complete in the reason text; only extreme lengths are capped', () => {
    const msg = 'connection reset by peer while streaming the response from the upstream API after 3 retries, giving up now';
    const t = setup({ mode: 'orb', lastError: msg });
    expect(t.q('.ct-orch-reason')!.textContent).toBe(`Orchestrator errored — ${msg}`);
    document.body.innerHTML = '';
    const long = setup({ lastError: 'x'.repeat(1000) });
    expect(long.q('.ct-orch-reason')!.textContent!.length).toBeLessThan(200);
  });
});


// ── Delta review of #903 at cccfa3e ────────────────────────────────────────────────────────────────────────────────
describe('delta B1: a queued streaming frame never resurrects a ghost bubble', () => {
  const twoTokens = (t: T) => { t.emit('token', { text: 'He' }); t.emit('token', { text: 'llo' }); };

  it('tokens immediately followed by the final message leave exactly one assistant bubble and no streaming row', async () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    t.dock.openSheet();
    twoTokens(t);
    t.say('Hello there');
    await frame(); await frame();
    expect(t.q('[data-streaming]')).toBeNull();
    await vi.waitFor(() => expect(t.qa('.ct-orch-msg[data-role="assistant"]')).toHaveLength(1));
  });

  it('tokens followed by interrupted leave one Stopped partial, not a duplicate live bubble', async () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    t.dock.openSheet();
    twoTokens(t);
    await t.manager.interrupt();
    await frame(); await frame();
    expect(t.q('[data-streaming]')).toBeNull();
    expect(t.qa('[data-stopped]')).toHaveLength(1);
  });

  it('tokens followed by done leave no streaming row', async () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    t.dock.openSheet();
    twoTokens(t);
    t.s.running.delete('orch'); t.emit('done'); t.emit('run_state_settled');
    await frame(); await frame();
    expect(t.q('[data-streaming]')).toBeNull();
  });
});

describe('delta (b): the Stopped partial survives event-order variants', () => {
  const stopWith = async (t: T, events: string[]) => {
    t.manager.interrupt.mockImplementation(async () => { t.s.running.delete('orch'); for (const e of events) t.emit(e); });
    t.dock.openSheet();
    t.emit('token', { text: 'Partial answ' });
    await frame();
    t.q<HTMLButtonElement>('.ct-orch-stop')!.click();
    await flush();
  };

  it.each([['done only', ['done']], ['run_state_settled only', ['run_state_settled']], ['error only', ['error']], ['interrupted', ['interrupted', 'run_state_settled']]])('Stop then %s keeps the partial, labelled', async (_n, events) => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    await stopWith(t, events as string[]);
    expect(t.q('[data-stopped]')!.textContent).toContain('Partial answ');
    expect(t.q('[data-streaming]')).toBeNull();
  });

  it('a turn that ends on its own (no Stop) leaves no Stopped row', async () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    t.dock.openSheet();
    t.emit('token', { text: 'whole' });
    t.s.running.delete('orch'); t.emit('done'); t.emit('run_state_settled');
    expect(t.q('[data-stopped]')).toBeNull();
  });

  it('Stop, but the reply completes anyway (message arrives): no Stopped row', async () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    t.manager.interrupt.mockImplementation(async () => { t.say('Finished anyway'); t.s.running.delete('orch'); t.emit('done'); });
    t.dock.openSheet();
    t.emit('token', { text: 'Finished' });
    await frame();
    t.q<HTMLButtonElement>('.ct-orch-stop')!.click();
    await flush();
    expect(t.q('[data-stopped]')).toBeNull();
  });
});

describe('delta (c): rollback then resend', () => {
  it('after an interrupt rolls the message back, a resend shows only the new message (memo is not stale)', async () => {
    const t = setup({ running: true, messages: [m('assistant', 'hi')] });
    t.dock.openSheet();
    t.enter(t.type('first try')); await flush();
    expect(t.qa('.ct-orch-msg[data-role="user"]')).toHaveLength(1);
    await t.manager.interrupt();
    expect(t.qa('.ct-orch-msg[data-role="user"]')).toHaveLength(0);
    t.enter(t.type('second try')); await flush();
    const users = t.qa('.ct-orch-msg[data-role="user"]');
    expect(users).toHaveLength(1);
    expect(users[0].textContent).toContain('second try');
  });

  it('an in-place edit of the last message is picked up (content is part of the memo key)', async () => {
    const t = setup({ messages: [m('assistant', 'short')] });
    t.dock.openSheet();
    (t.orch.messages as unknown as Msg[])[0].content = 'much longer replacement';
    t.emit('done');
    await vi.waitFor(() => expect(t.sheet()!.textContent).toContain('much longer replacement'));
  });
});

describe('delta (d): programmatic close never drops focus to the page', () => {
  it('thread_deleted while focus is inside the sheet moves focus to the field (here the Set up button), not the page', () => {
    const t = setup({ messages: [m('assistant', 'x')] });
    t.dock.openSheet();
    t.q<HTMLButtonElement>('.ct-orch-sheet-close')!.focus();
    t.s.orchestratorId = undefined; t.emit('thread_deleted');
    expect(t.isOpen()).toBe(false);
    expect(t.q('.ct-orch-field')!.contains(document.activeElement)).toBe(true);
  });
});

describe('delta (e): the narrow modal sheet inerts what it covers', () => {
  it('orb mode: siblings of the sheet and its ancestors are inert while open; restored on close and on destroy', () => {
    const t = setup({ mode: 'orb', messages: [m('assistant', 'x')] });
    const board = document.createElement('div'); board.className = 'board'; document.body.appendChild(board);
    t.dock.openSheet();
    expect(board.hasAttribute('inert')).toBe(true);
    expect(t.q('.ct-orch-field')!.hasAttribute('inert')).toBe(true);
    expect(t.sheet()!.hasAttribute('inert')).toBe(false);
    expect(t.sheet()!.closest('[inert]')).toBeNull();
    t.dock.closeSheet();
    expect(document.querySelector('[inert]')).toBeNull();
    t.dock.openSheet();
    t.dock.destroy();
    expect(document.querySelector('[inert]')).toBeNull();
  });

  it('pill mode never sets inert', () => {
    const t = setup({ messages: [m('assistant', 'x')] });
    const board = document.createElement('div'); document.body.appendChild(board);
    t.dock.openSheet();
    expect(document.querySelector('[inert]')).toBeNull();
  });

  it('crossing to pill mode with the sheet open removes inert', () => {
    const t = setup({ mode: 'orb', messages: [m('assistant', 'x')] });
    t.dock.openSheet();
    expect(document.querySelector('[inert]')).not.toBeNull();
    t.s.mode = 'pill'; t.dock.relayout();
    expect(document.querySelector('[inert]')).toBeNull();
  });

  it('the Tab trap also covers tabindex and select elements', () => {
    const t = setup({ mode: 'orb', messages: [m('assistant', 'x')] });
    t.dock.openSheet();
    const extra = document.createElement('div'); extra.tabIndex = 0; extra.className = 'ct-orch-extra';
    t.q('.ct-orch-sheet-log')!.appendChild(extra);
    const last = t.sheet()!.querySelector<HTMLElement>('textarea')!;
    last.focus();
    // forward from the last control wraps to the first; backward from the first reaches the last, which must be the textarea or a later tabbable
    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    t.q<HTMLElement>('.ct-orch-sheet-full')!.focus();
    t.q('.ct-orch-sheet-full')!.dispatchEvent(back);
    expect(document.activeElement).not.toBe(extra); // extra is mid-list, never an end
    const list = [...t.sheet()!.querySelectorAll<HTMLElement>('button, a[href], textarea, input, select, summary, [tabindex]:not([tabindex="-1"])')].filter((n) => !n.hidden && !n.closest('[hidden]'));
    expect(list).toContain(extra);
  });
});

describe('delta (f): links follow the world, not just the text', () => {
  it('a note created later turns an inert wikilink into a link on the next refresh', async () => {
    let exists = false;
    const t = setup({ messages: [m('assistant', 'see [[Later note]]')] });
    t.deps.resolveLink = vi.fn(() => exists);
    t.dock.openSheet();
    await vi.waitFor(() => expect(t.q('.ct-orch-wikilink-unresolved')).toBeTruthy());
    exists = true; t.emit('done');
    await vi.waitFor(() => expect(t.q('a.internal-link')).toBeTruthy());
  });

  it('a renamed thread updates a title-only thread link', async () => {
    const t = setup({ messages: [m('assistant', 'open [[thread:a]]')] });
    t.dock.openSheet();
    await vi.waitFor(() => expect(t.q('a.ct-thread-link')?.textContent).toBe('Deploy curation'));
    t.deps.listThreads().find((x) => x.id === 'a')!.title = 'Deploy curation v2';
    t.emit('thread_renamed');
    t.emit('done');
    await vi.waitFor(() => expect(t.q('a.ct-thread-link')?.textContent).toBe('Deploy curation v2'));
  });
});


// ── Final QA round on cccfa3e (N1, N2, observation) ───────────────────────────────────────────────────────────────
describe('N1: the pin survives content growing under it (streaming_start + a long first token in one task)', () => {
  it('a programmatic scroll event after the content grew by more than 48px does not unpin', async () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    const scroll = t.q('.ct-orch-sheet-scroll')!;
    let h = 400;
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => h });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 200 });
    t.dock.openSheet();
    await frame();
    expect(scroll.scrollTop).toBe(400);
    t.emit('streaming_start'); t.emit('token', { text: 'x'.repeat(600) });
    h = 900; // the long first token made the bubble much taller
    scroll.dispatchEvent(new Event('scroll')); // fired by OUR scroll, after the growth: no user intent
    t.emit('token', { text: ' more' });
    await frame(); await frame();
    expect(scroll.scrollTop).toBe(900);
  });

  it('but a real user scroll up mid-stream still stops the following', async () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    const scroll = t.q('.ct-orch-sheet-scroll')!;
    let h = 400;
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => h });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 200 });
    t.dock.openSheet();
    t.emit('token', { text: 'a' });
    await frame();
    scroll.scrollTop = 50; userScrollsUp(scroll);
    h = 900;
    t.emit('token', { text: 'bcd' });
    await frame(); await frame();
    expect(scroll.scrollTop).toBe(50);
  });
});

describe('N2: opening the narrow sheet from the orb moves focus into it', () => {
  it('orb focused + activated: the composer takes focus (typing lands in it)', () => {
    const t = setup({ mode: 'orb', messages: [m('assistant', 'x')] });
    const orb = t.q<HTMLButtonElement>('.ct-orch-orb')!;
    orb.focus();
    orb.click();
    expect(t.isOpen()).toBe(true);
    expect(document.activeElement).toBe(t.input());
  });

  it('no input (error): focus goes to a control inside the dialog, never stays on the covered orb', () => {
    const t = setup({ mode: 'orb', messages: [m('assistant', 'x')], lastError: 'boom' });
    const orb = t.q<HTMLButtonElement>('.ct-orch-orb')!;
    orb.focus(); orb.click();
    expect(t.sheet()!.contains(document.activeElement)).toBe(true);
  });

  it('pill mode keeps focus in the field it was typed in', () => {
    const t = setup({ messages: [m('assistant', 'x')] });
    t.input()!.focus();
    t.dock.openSheet();
    expect(document.activeElement).toBe(t.input());
  });
});

describe('observation: openThread never opens an id the board does not know', () => {
  it('a thread anchor injected after render with an unknown id opens nothing; a known id still opens', async () => {
    const t = setup({ messages: [m('assistant', 'hello')] });
    t.dock.openSheet();
    await vi.waitFor(() => expect(t.qa('.ct-orch-bubble').length).toBe(1));
    const mk = (id: string) => { const a = document.createElement('a'); a.setAttribute('data-thread-id', id); a.href = '#'; a.textContent = id; t.q('.ct-orch-sheet-log')!.appendChild(a); return a; };
    mk('ghost-id').click();
    expect(t.deps.openThread).not.toHaveBeenCalled();
    mk('a').click();
    expect(t.deps.openThread).toHaveBeenCalledWith('a');
  });
});


// ── Delta review of #903 at e232979 ────────────────────────────────────────────────────────────────────────────────
describe('delta: middle-click / auxclick on a plain link is handled like click', () => {
  it('is prevented and never navigates', async () => {
    const t = setup({ messages: [m('assistant', '[ext](https://example.com/x)')] });
    t.dock.openSheet();
    await vi.waitFor(() => expect(t.q('.ct-orch-bubble a')).toBeTruthy());
    const ev = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    t.q('.ct-orch-bubble a')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe('delta B: inert follows the board while the modal sheet is open', () => {
  it('a node added behind the sheet while it is open becomes inert on the next render; closing removes only OUR inert', () => {
    const t = setup({ mode: 'orb', messages: [m('assistant', 'x')] });
    const theirs = document.createElement('div'); theirs.setAttribute('inert', ''); document.body.appendChild(theirs);
    t.dock.openSheet();
    const late = document.createElement('div'); document.body.appendChild(late);
    t.emit('done');
    expect(late.hasAttribute('inert')).toBe(true);
    t.dock.closeSheet();
    expect(late.hasAttribute('inert')).toBe(false);
    expect(theirs.hasAttribute('inert')).toBe(true); // not ours: left alone
  });
});

describe('delta C: the pin is decided by what the sheet last wrote, not by a time window', () => {
  const rig = (t: T, start = 3000) => {
    const scroll = t.q('.ct-orch-sheet-scroll')!;
    let h = start;
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => h });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 200 });
    return { scroll, grow: (n: number) => { h = n; } };
  };

  it('a touch fling long after any input (no intent signal at all) still unpins', async () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    const { scroll } = rig(t);
    t.dock.openSheet(); await frame();
    scroll.scrollTop = 500; scroll.dispatchEvent(new Event('scroll')); // momentum scroll: no wheel/touch event nearby
    t.emit('token', { text: 'a' }); await frame();
    t.emit('token', { text: 'b' }); await frame(); await frame();
    expect(scroll.scrollTop).toBe(500);
  });

  it('keyboard PageUp / End and a scrollbar drag are just scrollTop changes: unpin on PageUp, re-pin on End', async () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    const { scroll, grow } = rig(t);
    t.dock.openSheet(); await frame();
    scroll.scrollTop = 2000; scroll.dispatchEvent(new Event('scroll')); // PageUp
    grow(3400); t.emit('token', { text: 'x' }); await frame(); await frame();
    expect(scroll.scrollTop).toBe(2000);
    scroll.scrollTop = 3200; scroll.dispatchEvent(new Event('scroll')); // End: back at the bottom
    grow(3600); t.emit('token', { text: 'y' }); await frame(); await frame();
    expect(scroll.scrollTop).toBe(3600);
  });

  it('the opposite case: the user reaches the bottom while content is growing, and stays pinned', async () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    const { scroll, grow } = rig(t);
    t.dock.openSheet(); await frame();
    scroll.scrollTop = 1000; scroll.dispatchEvent(new Event('scroll')); // scrolled up
    t.emit('token', { text: 'a' }); await frame();
    scroll.scrollTop = 2800; // wheels down to the old bottom (3000 - 200)
    grow(3500); // ...and the content grew before the scroll event was handled
    scroll.dispatchEvent(new Event('scroll'));
    t.emit('token', { text: 'b' }); await frame(); await frame();
    expect(scroll.scrollTop).toBe(3500);
  });
});

describe('delta D: a failed interrupt leaves no stale stop state', () => {
  it('after interrupt() throws, a later normal end of turn does not invent a Stopped row', async () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    t.manager.interrupt.mockRejectedValueOnce(new Error('cannot stop'));
    t.dock.openSheet();
    t.emit('token', { text: 'Partial' });
    await frame();
    t.q<HTMLButtonElement>('.ct-orch-stop')!.click();
    await flush(); await flush();
    t.emit('token', { text: ' more' }); // the turn carries on: Stop failed
    t.s.running.delete('orch'); t.emit('done'); t.emit('run_state_settled'); // ends with no `message` and no `interrupted`
    expect(t.q('[data-stopped]')).toBeNull();
  });
});

describe('delta G: resolveLink is not called per row per render', () => {
  it('N rows with the same wikilink resolve it once per render', async () => {
    const t = setup({ messages: Array.from({ length: 5 }, () => m('assistant', 'see [[Same note]]')) });
    const spy = vi.fn(() => true);
    t.deps.resolveLink = spy;
    t.dock.openSheet();
    await flush();
    spy.mockClear();
    t.emit('done');
    expect(spy.mock.calls.filter((c) => c[0] === 'Same note').length).toBeLessThanOrEqual(1);
  });
});

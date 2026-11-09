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

beforeEach(() => { document.body.innerHTML = ''; seq = 0; });
afterEach(() => { vi.useRealTimers(); });

describe('sheet shell', () => {
  it('is a child of the pill (.ct-kanban-dispatch), closed until something opens it', () => {
    const t = setup();
    const sheet = t.sheet();
    expect(sheet).toBeTruthy();
    expect(sheet!.parentElement).toBe(t.stage);
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
    const open = t.qa('.ct-orch-sheet-head button').find((b) => b.textContent === 'Open full thread ↗')!;
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
    const live = t.q('[data-streaming]')!;
    expect(live.textContent).toContain('Two things');
    t.say('Two things are waiting');
    expect(t.q('[data-streaming]')).toBeNull();
    await vi.waitFor(() => expect(t.qa('.ct-orch-msg[data-role="assistant"]')).toHaveLength(1));
    expect(t.qa('.ct-orch-msg[data-role="assistant"]')[0].textContent).toContain('Two things are waiting');
  });

  it('streamed text is text, never markup', () => {
    const t = setup({ running: true, messages: [m('user', 'go')] });
    t.dock.openSheet();
    t.emit('token', { text: '<img src=x onerror=alert(1)>' });
    expect(t.q('[data-streaming] img')).toBeNull();
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
    expect(t.q('.ct-orch-peek')).toBeNull();
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
  it('orb mode, errored: the sheet shows P2\'s reason + action in the composer slot and no textarea', () => {
    const t = setup({ mode: 'orb', messages: [m('assistant', 'last words')], lastError: 'boom' });
    t.dock.openSheet();
    const slot = t.q('.ct-orch-sheet-composer')!;
    expect(slot.querySelector('.ct-orch-reason')!.textContent).toBe('Orchestrator errored — boom');
    expect(slot.querySelector('textarea')).toBeNull();
    slot.querySelector<HTMLElement>('.ct-orch-action')!.click();
    expect(t.deps.openThread).toHaveBeenCalledWith('orch');
    expect(t.sheet()!.textContent).toContain('last words');
  });

  it('pill mode, errored: the field carries the reason; the orb opens the sheet so the transcript is reachable', () => {
    const t = setup({ messages: [m('assistant', 'last words')], lastError: 'boom' });
    expect(t.input()).toBeNull();
    t.q<HTMLElement>('.ct-orch-orb')!.click();
    expect(t.isOpen()).toBe(true);
    expect(t.sheet()!.textContent).toContain('last words');
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

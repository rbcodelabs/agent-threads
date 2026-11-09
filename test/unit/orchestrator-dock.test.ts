/**
 * orchestrator-dock.test.ts
 * @vitest-environment jsdom
 *
 * OrchestratorDock (P2 shell): DOM structure, state rendering, the interim
 * send hand-off, first-run setup, offline/error, subscriptions, narrow mode.
 * Uses a fake manager; no KanbanView.
 */
import '../setup/obsidian-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { OrchestratorDock, dockModeForWidth, DOCK_ORB_BREAKPOINT, type OrchestratorDockDeps } from '../../src/orchestratorDock';
import type { Thread } from '../../src/types';

type Listener = (threadId: string, event: { type: string }) => void;

function thread(id: string, over: Partial<Thread> = {}): Thread {
  return {
    id, title: `Thread ${id}`, cwd: '/r',
    messages: [{ id: `${id}-m`, role: 'assistant', content: 'hi', createdAt: 0 }],
    createdAt: 0, updatedAt: 0, status: 'waiting', reviewed: true, ...over,
  } as Thread;
}

function setup(opts: {
  threads?: Thread[];
  orchestratorId?: string | undefined;
  running?: string[];
  permission?: string[];
  mode?: 'pill' | 'orb';
  daemon?: { status: string };
  sendRejects?: boolean;
} = {}) {
  const threads = opts.threads ?? [thread('orch'), thread('a'), thread('b')];
  const state = { orchestratorId: 'orchestratorId' in opts ? opts.orchestratorId : 'orch', running: new Set(opts.running ?? []), permission: new Set(opts.permission ?? []), mode: opts.mode ?? 'pill' as 'pill' | 'orb', daemon: opts.daemon };
  const listeners = new Set<Listener>();
  const daemonListeners = new Set<(id: string, s: { status: string }) => void>();
  const calls: string[] = [];
  const manager = {
    getThread: (id: string) => threads.find((t) => t.id === id),
    isRunning: (id: string) => state.running.has(id),
    hasPendingPermission: (id: string) => state.permission.has(id),
    hasPendingQuestion: () => false,
    hasPendingPlan: () => false,
    hasActiveBackgroundTasks: () => false,
    getQueuedMessages: () => [],
    removeQueuedMessageAt: vi.fn(),
    getThreadActivity: () => undefined,
    interrupt: vi.fn(async () => {}),
    sendMessage: vi.fn(async (id: string, text: string) => { calls.push(`send:${id}:${text}`); if (opts.sendRejects) throw new Error('boom'); }),
    subscribe: vi.fn((l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; }),
  };
  const deps: OrchestratorDockDeps = {
    manager: manager as never,
    listThreads: () => threads,
    hasPendingWakeup: () => false,
    getOrchestratorThreadId: () => state.orchestratorId,
    ensureOrchestrator: vi.fn(async () => { calls.push('ensure'); state.orchestratorId = 'orch'; }),
    openThread: vi.fn((id: string) => { calls.push(`open:${id}`); }),
    mode: () => state.mode,
    daemons: {
      stateOf: () => state.daemon as never,
      onState: (l) => { daemonListeners.add(l); return () => { daemonListeners.delete(l); }; },
      reconnect: vi.fn(),
    },
  };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const dock = new OrchestratorDock(host, deps);
  dock.mount();
  const root = () => host.querySelector('.ct-orch-dock') as HTMLElement;
  const emit = (type: string, id = 'a') => { for (const l of [...listeners]) l(id, { type }); };
  return { dock, deps, manager, host, root, state, calls, listeners, daemonListeners, emit, threads };
}

const input = (host: HTMLElement) => host.querySelector('textarea.ct-orch-input') as HTMLTextAreaElement;
function press(el: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('mode threshold', () => {
  it('collapses to the orb strictly under 640px; unmeasured widths stay a pill', () => {
    expect(DOCK_ORB_BREAKPOINT).toBe(640);
    expect(dockModeForWidth(639)).toBe('orb');
    expect(dockModeForWidth(640)).toBe('pill');
    expect(dockModeForWidth(1280)).toBe('pill');
    expect(dockModeForWidth(0)).toBe('pill');
  });
});

describe('structure and states', () => {
  it('renders field (orb + textarea + hint) and a dot, state idle when calm', () => {
    const t = setup();
    expect(t.root().dataset.state).toBe('idle');
    expect(t.root().dataset.mode).toBe('pill');
    expect(t.host.querySelector('.ct-orch-orb')).toBeTruthy();
    expect(input(t.host).placeholder).toMatch(/Ask the orchestrator/);
    expect(t.host.querySelector('[data-testid="orchestrator-dot"]')).toBeTruthy();
  });

  it('dot tooltip is the model tooltipText (running / total / needs you)', () => {
    const t = setup({ running: ['a'], permission: ['a'] });
    const dot = t.host.querySelector('[data-testid="orchestrator-dot"]') as HTMLElement;
    expect(dot.getAttribute('title')).toBe('1 running · 3 total · 1 needs you');
    expect(dot.getAttribute('aria-label')).toBe('1 running · 3 total · 1 needs you');
    expect(t.root().dataset.state).toBe('attention');
  });

  it('quiet dot (no attention) still carries the tooltip', () => {
    const t = setup();
    const dot = t.host.querySelector('[data-testid="orchestrator-dot"]') as HTMLElement;
    expect(dot.getAttribute('title')).toBe('3 total');
    expect(dot.classList.contains('ct-orch-dot-attention')).toBe(false);
  });

  it('ring spins while any thread runs, and stops when none do', () => {
    const t = setup({ running: ['a'] });
    const orb = t.host.querySelector('.ct-orch-orb') as HTMLElement;
    expect(orb.classList.contains('ct-orch-orb-spinning')).toBe(true);
    t.state.running.clear();
    t.emit('done');
    expect(orb.classList.contains('ct-orch-orb-spinning')).toBe(false);
  });

  it('refreshes in place on manager events (same nodes, no rebuild)', () => {
    const t = setup();
    const before = input(t.host);
    t.state.permission.add('a');
    t.emit('permission_request');
    expect(t.root().dataset.state).toBe('attention');
    expect(input(t.host)).toBe(before);
  });

  it('ignores high-frequency token events', () => {
    const t = setup();
    const spy = vi.spyOn(t.deps, 'listThreads');
    spy.mockClear();
    t.emit('token');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('first run (no orchestrator or stale id)', () => {
  it('renders the dashed affordance with a Set up button and no textarea', () => {
    const t = setup({ orchestratorId: undefined });
    expect(t.root().dataset.state).toBe('none');
    expect(t.host.querySelector('.ct-orch-reason')?.textContent).toBe('No orchestrator yet');
    expect(input(t.host)).toBeNull();
    expect((t.host.querySelector('.ct-orch-action') as HTMLElement).textContent).toBe('Set up…');
  });

  it('a stale id (thread deleted) is first-run too', () => {
    const t = setup({ orchestratorId: 'gone' });
    expect(t.root().dataset.state).toBe('none');
  });

  it('Set up calls ensureOrchestrator (not openThread), then shows and focuses the field', async () => {
    const t = setup({ orchestratorId: undefined });
    (t.host.querySelector('.ct-orch-action') as HTMLElement).click();
    await vi.waitFor(() => expect(input(t.host)).toBeTruthy());
    expect(t.deps.ensureOrchestrator).toHaveBeenCalledTimes(1);
    expect(t.deps.openThread).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input(t.host));
  });

  it('a failing setup keeps the affordance and re-enables the button', async () => {
    const t = setup({ orchestratorId: undefined });
    (t.deps.ensureOrchestrator as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('nope'));
    const btn = t.host.querySelector('.ct-orch-action') as HTMLButtonElement;
    btn.click();
    await vi.waitFor(() => expect(btn.disabled).toBe(false));
    expect(t.root().dataset.state).toBe('none');
  });
});

describe('offline and error', () => {
  it('offline remote orchestrator: disabled field with the reason and Reconnect', () => {
    const o = thread('orch', { remote: { daemonId: 'd1' } as never });
    const t = setup({ threads: [o, thread('a')], daemon: { status: 'unreachable' } });
    expect(t.root().dataset.state).toBe('offline');
    expect(t.host.querySelector('.ct-orch-reason')?.textContent).toBe('Orchestrator stopped — daemon disconnected');
    expect(input(t.host)).toBeNull();
    (t.host.querySelector('.ct-orch-action') as HTMLElement).click();
    expect(t.deps.daemons!.reconnect).toHaveBeenCalledWith('d1');
  });

  it('transient daemon states are not offline', () => {
    const o = thread('orch', { remote: { daemonId: 'd1' } as never });
    const t = setup({ threads: [o], daemon: { status: 'reconnecting' } });
    expect(t.root().dataset.state).toBe('idle');
  });

  it('re-derives when the daemon registry reports a new state', () => {
    const o = thread('orch', { remote: { daemonId: 'd1' } as never });
    const t = setup({ threads: [o], daemon: { status: 'connected' } });
    expect(t.root().dataset.state).toBe('idle');
    t.state.daemon = { status: 'closed' };
    for (const l of t.daemonListeners) l('d1', { status: 'closed' });
    expect(t.root().dataset.state).toBe('offline');
  });

  it('errored orchestrator: reason carries the error, action opens the thread', () => {
    const o = thread('orch', { lastError: 'Claude process exited unexpectedly' });
    const t = setup({ threads: [o, thread('a')] });
    expect(t.root().dataset.state).toBe('error');
    expect(t.host.querySelector('.ct-orch-reason')?.textContent).toBe('Orchestrator errored — Claude process exited unexpectedly');
    (t.host.querySelector('.ct-orch-action') as HTMLElement).click();
    expect(t.deps.openThread).toHaveBeenCalledWith('orch');
  });

  it('truncates a long error to 60 characters', () => {
    const o = thread('orch', { lastError: 'x'.repeat(200) });
    const t = setup({ threads: [o] });
    expect((t.host.querySelector('.ct-orch-reason')?.textContent ?? '').length).toBeLessThan(100);
  });
});

describe('send (P3: the sheet replaces the interim hand-off)', () => {
  it('Enter sends to the orchestrator, opens the sheet (NOT the thread), and clears the field', async () => {
    const t = setup();
    const el = input(t.host);
    el.value = 'What needs me?';
    el.dispatchEvent(new Event('input'));
    const e = press(el, 'Enter');
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(t.calls).toEqual(['send:orch:What needs me?']));
    expect(t.deps.openThread).not.toHaveBeenCalled();
    expect((document.querySelector('.ct-orch-sheet') as HTMLElement).hidden).toBe(false);
    expect(el.value).toBe('');
  });

  it('Shift+Enter is a newline: nothing sent, not prevented', () => {
    const t = setup();
    const el = input(t.host);
    el.value = 'hi';
    const e = press(el, 'Enter', { shiftKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(t.manager.sendMessage).not.toHaveBeenCalled();
  });

  it('empty / whitespace and IME composition never send', () => {
    const t = setup();
    const el = input(t.host);
    el.value = '   ';
    press(el, 'Enter');
    el.value = 'hello';
    press(el, 'Enter', { isComposing: true });
    expect(t.manager.sendMessage).not.toHaveBeenCalled();
  });

  it('a second Enter while the first send is pending does not double-send', async () => {
    const t = setup();
    const el = input(t.host);
    el.value = 'once';
    press(el, 'Enter');
    el.value = 'twice';
    press(el, 'Enter');
    await Promise.resolve();
    expect(t.manager.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('a rejected send restores the draft and does not open the thread', async () => {
    const t = setup({ sendRejects: true });
    const el = input(t.host);
    el.value = 'keep me';
    press(el, 'Enter');
    await vi.waitFor(() => expect(el.value).toBe('keep me'));
    expect(t.deps.openThread).not.toHaveBeenCalled();
  });

  it('sends while the orchestrator is working (the manager coalesces)', async () => {
    const t = setup({ running: ['orch'] });
    const el = input(t.host);
    el.value = 'also this';
    press(el, 'Enter');
    await vi.waitFor(() => expect(t.manager.sendMessage).toHaveBeenCalledWith('orch', 'also this'));
  });

  it('Escape blurs the field', () => {
    const t = setup();
    const el = input(t.host);
    el.focus();
    press(el, 'Escape');
    expect(document.activeElement).not.toBe(el);
  });

  it('nothing is ever sent without a keydown from the user (events alone never send)', () => {
    const t = setup();
    t.emit('message'); t.emit('done'); t.emit('user_message_added');
    expect(t.manager.sendMessage).not.toHaveBeenCalled();
  });
});

describe('focusField (Cmd+J target)', () => {
  it('focuses the textarea and tolerates being called when already focused', () => {
    const t = setup();
    t.dock.focusField();
    expect(document.activeElement).toBe(input(t.host));
    t.dock.focusField();
    expect(document.activeElement).toBe(input(t.host));
  });

  it('first run: focuses the Set up button', () => {
    const t = setup({ orchestratorId: undefined });
    t.dock.focusField();
    expect(document.activeElement).toBe(t.host.querySelector('.ct-orch-action'));
  });

  it('orb mode: opens the bottom sheet instead of focusing a hidden field', () => {
    const t = setup({ mode: 'orb' });
    t.dock.focusField();
    expect((document.querySelector('.ct-orch-sheet') as HTMLElement).hidden).toBe(false);
    expect(t.deps.openThread).not.toHaveBeenCalled();
  });
});

describe('narrow mode', () => {
  it('relayout re-reads mode() and sets data-mode', () => {
    const t = setup();
    expect(t.root().dataset.mode).toBe('pill');
    t.state.mode = 'orb';
    t.dock.relayout();
    expect(t.root().dataset.mode).toBe('orb');
  });

  it('tapping the orb in orb mode opens the sheet; in pill mode it focuses the field', () => {
    const t = setup({ mode: 'orb' });
    (t.host.querySelector('.ct-orch-orb') as HTMLElement).click();
    expect((document.querySelector('.ct-orch-sheet') as HTMLElement).hidden).toBe(false);
    expect(t.deps.openThread).not.toHaveBeenCalled();
    t.state.mode = 'pill';
    t.dock.relayout();
    (document.querySelector('.ct-orch-sheet-head button[aria-label="Close"]') as HTMLElement).click();
    (t.host.querySelector('.ct-orch-orb') as HTMLElement).click();
    expect(t.deps.openThread).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input(t.host));
  });

  it('orb tap with no orchestrator sets one up first, then opens the sheet (no thread hand-off)', async () => {
    const t = setup({ orchestratorId: undefined, mode: 'orb' });
    (t.host.querySelector('.ct-orch-orb') as HTMLElement).click();
    await vi.waitFor(() => expect(t.calls).toEqual(['ensure']));
    await vi.waitFor(() => expect((document.querySelector('.ct-orch-sheet') as HTMLElement).hidden).toBe(false));
    expect(t.deps.openThread).not.toHaveBeenCalled();
  });
});

describe('lifecycle', () => {
  it('mount subscribes to the manager and the daemon registry; destroy unsubscribes and removes the DOM', () => {
    const t = setup();
    expect(t.listeners.size).toBe(1);
    expect(t.daemonListeners.size).toBe(1);
    t.dock.destroy();
    expect(t.listeners.size).toBe(0);
    expect(t.daemonListeners.size).toBe(0);
    expect(t.host.querySelector('.ct-orch-dock')).toBeNull();
    t.dock.destroy(); // idempotent
  });

  it('events after destroy do not throw or re-render', () => {
    const t = setup();
    t.dock.destroy();
    expect(() => t.emit('done')).not.toThrow();
  });

  it('works without a daemon registry (never offline)', () => {
    const t = setup();
    expect(t.root()).toBeTruthy();
  });
});

describe('review follow-ups', () => {
  it('A1: only state-relevant events refresh (true allowlist); task_progress/token/tool_use do not', () => {
    const t = setup();
    const spy = vi.spyOn(t.deps, 'listThreads');
    spy.mockClear();
    for (const ev of ['task_progress', 'token', 'tool_use', 'usage', 'some_future_event']) t.emit(ev);
    expect(spy).not.toHaveBeenCalled();
    for (const ev of ['pending_plan_changed', 'pending_question_changed', 'plan_ready', 'question_ready', 'auth_retry', 'proposed_reply_changed', 'permission_request', 'done']) {
      spy.mockClear();
      t.emit(ev);
      expect(spy, ev).toHaveBeenCalled();
    }
  });

  it('A2: a setup that throws AFTER the id was set still refreshes into the field', async () => {
    const t = setup({ orchestratorId: undefined });
    (t.deps.ensureOrchestrator as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      t.state.orchestratorId = 'orch';
      throw new Error('saveSettings failed');
    });
    (t.host.querySelector('.ct-orch-action') as HTMLElement).click();
    await vi.waitFor(() => expect(t.root().dataset.state).toBe('idle'));
    expect(input(t.host)).toBeTruthy();
  });

  it('A3: a failed send restores the draft into the CURRENT textarea even after a rebuild during the await', async () => {
    let rejectSend: (e: Error) => void = () => {};
    const t = setup();
    t.manager.sendMessage.mockImplementationOnce(() => new Promise<void>((_r, rej) => { rejectSend = rej; }));
    const el = input(t.host);
    el.value = 'precious';
    press(el, 'Enter');
    // Orchestrator disappears then returns while the send is pending: the textarea node is rebuilt.
    t.state.orchestratorId = undefined; t.emit('thread_deleted');
    expect(input(t.host)).toBeNull();
    t.state.orchestratorId = 'orch'; t.emit('thread_created');
    const rebuilt = input(t.host);
    expect(rebuilt).not.toBe(el);
    rejectSend(new Error('boom'));
    await vi.waitFor(() => expect(rebuilt.value).toBe('precious'));
  });

  it('A4: a restored multi-line draft is autosized when the textarea is rebuilt', () => {
    const t = setup();
    const el = input(t.host);
    el.value = 'a\nb\nc';
    el.dispatchEvent(new Event('input'));
    t.state.orchestratorId = undefined; t.emit('thread_deleted');
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', { configurable: true, get: () => 64 });
    try {
      t.state.orchestratorId = 'orch'; t.emit('thread_created');
      expect(input(t.host).value).toBe('a\nb\nc');
      expect(input(t.host).style.height).toBe('64px');
    } finally {
      delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>).scrollHeight;
      if (desc) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', desc);
    }
  });

  it('A5: keyCode 229 (IME) Enter never sends', () => {
    const t = setup();
    const el = input(t.host);
    el.value = 'konnichiwa';
    press(el, 'Enter', { keyCode: 229 });
    expect(t.manager.sendMessage).not.toHaveBeenCalled();
  });

  it('A6: Cmd+J with the field already focused selects its text', () => {
    const t = setup();
    const el = input(t.host);
    el.value = 'draft text';
    t.dock.focusField();
    expect(document.activeElement).toBe(el);
    t.dock.focusField();
    expect(el.selectionStart).toBe(0);
    expect(el.selectionEnd).toBe('draft text'.length);
  });

  it('A9: the orb is out of the tab order in pill mode (the field is the stop) and back in it in orb mode', () => {
    const t = setup();
    const orb = t.host.querySelector('.ct-orch-orb') as HTMLElement;
    expect(orb.getAttribute('tabindex')).toBe('-1');
    t.state.mode = 'orb';
    t.dock.relayout();
    expect(orb.hasAttribute('tabindex')).toBe(false);
  });
});

describe('narrow status row (D2): none / error / offline stay visible in orb mode', () => {
  const status = (t: ReturnType<typeof setup>) => t.host.previousElementSibling as HTMLElement | null;

  it('first run in orb mode: a status row sits immediately before the host with reason + Set up…, and the orb is tinted, not spinning', async () => {
    const t = setup({ orchestratorId: undefined, mode: 'orb', running: ['a'] });
    const row = status(t)!;
    expect(row.classList.contains('ct-orch-status')).toBe(true);
    expect(row.hidden).toBe(false);
    expect(row.querySelector('.ct-orch-reason')?.textContent).toBe('No orchestrator yet');
    const orb = t.host.querySelector('.ct-orch-orb') as HTMLElement;
    expect(orb.classList.contains('ct-orch-orb-alert')).toBe(true);
    expect(orb.classList.contains('ct-orch-orb-spinning')).toBe(false);
    (row.querySelector('.ct-orch-action') as HTMLElement).click();
    await vi.waitFor(() => expect(t.deps.ensureOrchestrator).toHaveBeenCalledTimes(1));
  });

  it('error in orb mode shows the reason and Open thread; offline shows Reconnect', () => {
    const e = setup({ threads: [thread('orch', { lastError: 'boom' })], mode: 'orb' });
    expect(status(e)!.querySelector('.ct-orch-reason')?.textContent).toBe('Orchestrator errored — boom');
    (status(e)!.querySelector('.ct-orch-action') as HTMLElement).click();
    expect(e.deps.openThread).toHaveBeenCalledWith('orch');
    document.body.innerHTML = '';
    const o = setup({ threads: [thread('orch', { remote: { daemonId: 'd1' } as never })], daemon: { status: 'unreachable' }, mode: 'orb' });
    expect(status(o)!.querySelector('.ct-orch-reason')?.textContent).toBe('Orchestrator stopped — daemon disconnected');
    (status(o)!.querySelector('.ct-orch-action') as HTMLElement).click();
    expect(o.deps.daemons!.reconnect).toHaveBeenCalledWith('d1');
  });

  it('idle / working / attention in orb mode: no status row, orb not tinted', () => {
    const t = setup({ mode: 'orb', running: ['a'] });
    expect(status(t)!.hidden).toBe(true);
    expect((t.host.querySelector('.ct-orch-orb') as HTMLElement).classList.contains('ct-orch-orb-alert')).toBe(false);
  });

  it('pill mode never shows the status row (the field itself carries the reason)', () => {
    const t = setup({ orchestratorId: undefined });
    expect(status(t)!.hidden).toBe(true);
    expect(t.host.querySelector('.ct-orch-reason')).toBeTruthy();
  });

  it('crossing the breakpoint moves the reason between the field and the status row without duplicating it', () => {
    const t = setup({ orchestratorId: undefined });
    t.state.mode = 'orb'; t.dock.relayout();
    expect(document.querySelectorAll('.ct-orch-reason')).toHaveLength(1);
    expect(status(t)!.querySelector('.ct-orch-reason')).toBeTruthy();
    t.state.mode = 'pill'; t.dock.relayout();
    expect(document.querySelectorAll('.ct-orch-reason')).toHaveLength(1);
    expect(t.host.querySelector('.ct-orch-reason')).toBeTruthy();
  });

  it('destroy removes the status row too', () => {
    const t = setup({ orchestratorId: undefined, mode: 'orb' });
    t.dock.destroy();
    expect(document.querySelector('.ct-orch-status')).toBeNull();
  });
});

describe('delta review follow-ups', () => {
  it('remote_pending_changed refreshes (a remote turn flips isRunning without a paired done/streaming_start)', () => {
    const t = setup();
    const spy = vi.spyOn(t.deps, 'listThreads');
    spy.mockClear();
    t.emit('remote_pending_changed');
    expect(spy).toHaveBeenCalled();
  });

  it('setUp uses aria-disabled + early return (keeps keyboard focus), not the disabled attribute', async () => {
    const t = setup({ orchestratorId: undefined });
    let release: () => void = () => {};
    (t.deps.ensureOrchestrator as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    const btn = t.host.querySelector('.ct-orch-action') as HTMLButtonElement;
    btn.focus();
    btn.click();
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(btn);
    btn.click(); // second click while pending is a no-op
    expect(t.deps.ensureOrchestrator).toHaveBeenCalledTimes(1);
    t.state.orchestratorId = 'orch';
    release();
    await vi.waitFor(() => expect(t.root().dataset.state).toBe('idle'));
  });

  it('a failed setup leaves the button focused and re-enabled (aria-disabled cleared)', async () => {
    const t = setup({ orchestratorId: undefined });
    (t.deps.ensureOrchestrator as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('nope'));
    const btn = t.host.querySelector('.ct-orch-action') as HTMLButtonElement;
    btn.focus();
    btn.click();
    await vi.waitFor(() => expect(btn.hasAttribute('aria-disabled')).toBe(false));
    expect(document.activeElement).toBe(btn);
  });

  it('focusField reads activeElement from the input\'s own document (popout windows)', () => {
    const t = setup();
    const el = input(t.host);
    el.value = 'draft';
    const spy = vi.spyOn(el, 'ownerDocument', 'get').mockReturnValue({ activeElement: el } as unknown as Document);
    const select = vi.spyOn(el, 'select');
    t.dock.focusField();
    expect(select).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a draft typed while the field is hidden (orb mode, scrollHeight 0) is autosized when the pill returns', () => {
    const t = setup({ mode: 'orb' });
    const el = input(t.host);
    el.value = 'a\nb\nc';
    el.dispatchEvent(new Event('input'));
    expect(el.style.height).not.toBe('64px');
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', { configurable: true, get: () => 64 });
    try {
      t.state.mode = 'pill';
      t.dock.relayout();
      expect(el.style.height).toBe('64px');
    } finally {
      delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>).scrollHeight;
    }
  });
});

describe('N4 wording', () => {
  it('keeps a parenthesised tail attached to its word (non-breaking spaces) so "(code 1)" cannot split', () => {
    const t = setup({ threads: [thread('orch', { lastError: 'Claude process exited unexpectedly (code 1)' })] });
    const text = t.host.querySelector('.ct-orch-reason')?.textContent ?? '';
    expect(text).toBe('Orchestrator errored — Claude process exited unexpectedly\u00a0(code\u00a01)');
  });
});

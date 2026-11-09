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
    expect(t.host.querySelector('.ct-orch-reason')?.textContent).toBe('No portfolio orchestrator yet');
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

describe('interim send hand-off (P3 replaces this with the sheet)', () => {
  it('Enter sends to the orchestrator, then opens its thread, and clears the field', async () => {
    const t = setup();
    const el = input(t.host);
    el.value = 'What needs me?';
    el.dispatchEvent(new Event('input'));
    const e = press(el, 'Enter');
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(t.calls).toEqual(['send:orch:What needs me?', 'open:orch']));
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
    await vi.waitFor(() => expect(t.calls).toContain('open:orch'));
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

  it('orb mode: opens the orchestrator thread (interim) instead of focusing a hidden field', () => {
    const t = setup({ mode: 'orb' });
    t.dock.focusField();
    expect(t.deps.openThread).toHaveBeenCalledWith('orch');
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

  it('tapping the orb in orb mode opens the thread; in pill mode it focuses the field', () => {
    const t = setup({ mode: 'orb' });
    (t.host.querySelector('.ct-orch-orb') as HTMLElement).click();
    expect(t.deps.openThread).toHaveBeenCalledWith('orch');
    t.state.mode = 'pill';
    t.dock.relayout();
    (t.deps.openThread as ReturnType<typeof vi.fn>).mockClear();
    (t.host.querySelector('.ct-orch-orb') as HTMLElement).click();
    expect(t.deps.openThread).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input(t.host));
  });

  it('orb tap with no orchestrator sets one up first, then opens it', async () => {
    const t = setup({ orchestratorId: undefined, mode: 'orb' });
    (t.host.querySelector('.ct-orch-orb') as HTMLElement).click();
    await vi.waitFor(() => expect(t.calls).toEqual(['ensure', 'open:orch']));
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

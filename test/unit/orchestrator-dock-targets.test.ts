/**
 * orchestrator-dock-targets.test.ts
 * @vitest-environment jsdom
 *
 * TASK-29 / SOL-25 / RM-12: the dock talks to the Portfolio orchestrator AND every Project orchestrator, switched from the
 * sheet title (a menu button). Per-target state: transcript, streaming buffer, drafts, unread; the menu's keyboard and a11y
 * contract; the peek that opens on the target the reply came from; the all-orchestrator tray / dot.
 */
import '../setup/obsidian-dom';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { OrchestratorDock, type OrchestratorDockDeps } from '../../src/orchestratorDock';
import { createDraftStore } from '../../src/dockDraftStore';
import type { Thread } from '../../src/types';

type Ev = { type: string; [k: string]: unknown };
type Listener = (threadId: string, event: Ev) => void;
type Msg = { id: string; role: string; content: string; timestamp: number; [k: string]: unknown };
interface Proj { id: string; name: string; orchestratorThreadId?: string }

let seq = 0;
const m = (role: string, content: string, extra: Record<string, unknown> = {}): Msg => ({ id: `m${++seq}`, role, content, timestamp: 0, ...extra });
function thread(id: string, over: Partial<Thread> = {}): Thread {
  return { id, title: `Thread ${id}`, cwd: '/r', messages: [], createdAt: 0, updatedAt: 0, status: 'waiting', reviewed: true, ...over } as Thread;
}

const HOSTILE = '<img src=x onerror="window.__pwned=1"><b>Bold</b>';

function setup(opts: {
  projects?: Proj[];
  portfolio?: boolean;
  mode?: 'pill' | 'orb';
  extraThreads?: Thread[];
  permission?: string[];
} = {}) {
  const portfolio = opts.portfolio ?? true;
  const projects: Proj[] = opts.projects ?? [
    { id: 'x', name: 'Agent Threads', orchestratorThreadId: 'tx' },
    { id: 'y', name: 'Compass', orchestratorThreadId: 'ty' },
    { id: 'z', name: 'No orchestrator yet' },
    { id: 's', name: 'Stale one', orchestratorThreadId: 'gone' },
  ];
  const threads: Thread[] = [
    ...(portfolio ? [thread('orch', { title: 'Portfolio Orchestrator', messages: [m('assistant', 'portfolio says hi')] as never })] : []),
    thread('tx', { title: 'Agent Threads Orchestrator', messages: [m('user', 'status?'), m('assistant', 'agent-threads says hi')] as never }),
    thread('ty', { title: 'Compass Orchestrator', messages: [m('assistant', 'compass says hi')] as never }),
    ...(opts.extraThreads ?? []),
  ];
  const s = {
    projects,
    portfolioId: portfolio ? 'orch' : undefined as string | undefined,
    running: new Set<string>(),
    permission: new Set<string>(opts.permission ?? []),
    mode: opts.mode ?? ('pill' as 'pill' | 'orb'),
  };
  const listeners = new Set<Listener>();
  const emit = (id: string, type: string, extra: Record<string, unknown> = {}) => { for (const l of [...listeners]) l(id, { type, ...extra }); };
  const byId = (id: string) => threads.find((t) => t.id === id);
  const manager = {
    getThread: (id: string) => byId(id),
    isRunning: (id: string) => s.running.has(id),
    hasPendingPermission: (id: string) => s.permission.has(id),
    hasPendingQuestion: () => false,
    hasPendingPlan: () => false,
    hasActiveBackgroundTasks: () => false,
    getQueuedMessages: vi.fn(() => []),
    removeQueuedMessageAt: vi.fn(),
    getThreadActivity: vi.fn(() => undefined),
    getPendingPermission: vi.fn(() => undefined),
    resolvePermission: vi.fn(),
    interrupt: vi.fn(async () => {}),
    sendMessage: vi.fn(async (id: string, text: string) => {
      const user = m('user', text, { unresolved: true });
      (byId(id)!.messages as unknown as Msg[]).push(user);
      emit(id, 'user_message_added', { message: user });
    }),
    subscribe: vi.fn((l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; }),
  };
  const drafts = createDraftStore();
  const deps: OrchestratorDockDeps = {
    manager: manager as never,
    listThreads: () => threads,
    hasPendingWakeup: () => false,
    getOrchestratorThreadId: () => s.portfolioId,
    projects: () => s.projects,
    ensureOrchestrator: vi.fn(async () => {}),
    openThread: vi.fn(),
    mode: () => s.mode,
    drafts,
    daemons: null,
  };
  const stage = document.createElement('div');
  stage.className = 'ct-kanban-dispatch';
  const host = document.createElement('div');
  stage.appendChild(host);
  document.body.appendChild(stage);
  const dock = new OrchestratorDock(host, deps);
  dock.mount();
  const q = <E extends HTMLElement = HTMLElement>(sel: string) => stage.querySelector(sel) as E | null;
  const qa = (sel: string) => [...stage.querySelectorAll(sel)] as HTMLElement[];
  const key = (el: Element, k: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(e);
    return e;
  };
  return {
    dock, deps, manager, stage, s, threads, drafts, emit, q, qa, key, byId,
    titleBtn: () => q<HTMLButtonElement>('.ct-orch-title-btn'),
    title: () => q('h2.ct-orch-sheet-title')!,
    menu: () => q('.ct-orch-menu'),
    options: () => qa('.ct-orch-menu [role="option"]'),
    optionFor: (id: string) => q(`.ct-orch-menu [role="option"][data-target-id="${id}"]`),
    isOpen: () => { const el = q('.ct-orch-sheet'); return !!el && !el.hidden; },
    menuOpen: () => { const el = q('.ct-orch-menu'); return !!el && !el.hidden; },
    input: () => q<HTMLTextAreaElement>('textarea.ct-orch-input'),
    log: () => q('.ct-orch-sheet-log')!,
    dot: () => q('[data-testid="orchestrator-dot"]')!,
    peek: () => q('[data-testid="orchestrator-peek"]')!,
    say: (id: string, content: string) => { const a = m('assistant', content); (byId(id)!.messages as unknown as Msg[]).push(a); emit(id, 'message', { message: a }); return a; },
    type: (text: string) => { const el = q<HTMLTextAreaElement>('textarea.ct-orch-input')!; el.value = text; el.dispatchEvent(new Event('input')); return el; },
    select: (id: string) => { (q(`.ct-orch-menu [role="option"][data-target-id="${id}"]`) as HTMLElement).click(); },
  };
}
type T = ReturnType<typeof setup>;
const flush = () => new Promise((r) => setTimeout(r, 0));
/** The transcript's text. Rows render their markdown asynchronously: await `settle()` after anything that builds rows. */
const texts = (t: T) => t.log().textContent ?? '';
const settle = async () => { await flush(); await flush(); };

beforeEach(() => { document.body.innerHTML = ''; seq = 0; delete (window as unknown as { __pwned?: number }).__pwned; });
afterEach(() => { vi.useRealTimers(); });

describe('the title: plain heading vs menu button', () => {
  it('with no Project orchestrator the title is the plain heading, exactly as today (no button, no listbox)', async () => {
    const t = setup({ projects: [{ id: 'z', name: 'Nothing yet' }] });
    t.dock.openSheet();
    expect(t.title().textContent).toBe('Portfolio orchestrator');
    expect(t.title().children.length).toBe(0);
    expect(t.titleBtn()).toBeNull();
    expect(t.menu()).toBeNull();
    expect(t.q('[aria-haspopup]')).toBeNull();
  });

  it('with a Project orchestrator the title is a menu button: aria-haspopup=listbox, aria-expanded, reachable by Tab', async () => {
    const t = setup();
    t.dock.openSheet();
    const btn = t.titleBtn()!;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-haspopup')).toBe('listbox');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.tabIndex).toBeGreaterThanOrEqual(0);
    expect(btn.textContent).toContain('Portfolio orchestrator');
    expect(btn.getAttribute('aria-controls')).toBe(t.menu()!.id);
    // The dialog is still named by the heading.
    expect(t.q('.ct-orch-sheet')!.getAttribute('aria-labelledby')).toBe(t.title().id);
  });

  it('the menu lists the Portfolio first, then each Project orchestrator, hiding projects with none or a stale one', async () => {
    const t = setup();
    t.dock.openSheet();
    t.titleBtn()!.click();
    expect(t.menuOpen()).toBe(true);
    expect(t.titleBtn()!.getAttribute('aria-expanded')).toBe('true');
    expect(t.menu()!.getAttribute('role')).toBe('listbox');
    expect(t.options().map((o) => o.dataset.targetId)).toEqual(['orch', 'tx', 'ty']);
    expect(t.options().map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(t.menu()!.textContent).not.toContain('No orchestrator yet');
    expect(t.menu()!.textContent).not.toContain('Stale one');
  });

  it('with no Portfolio orchestrator the menu lists the projects and the dock opens on the first', async () => {
    const t = setup({ portfolio: false });
    t.dock.openSheet();
    expect(t.titleBtn()!.textContent).toContain('Agent Threads orchestrator');
    t.titleBtn()!.click();
    expect(t.options().map((o) => o.dataset.targetId)).toEqual(['tx', 'ty']);
    expect(t.optionFor('tx')!.getAttribute('aria-selected')).toBe('true');
  });
});

describe('selecting a target switches the whole sheet', () => {
  it('shows that thread\'s transcript, title, labels and placeholder; closes the menu; focus returns to the title button', async () => {
    const t = setup();
    t.dock.openSheet();
    await settle();
    expect(texts(t)).toContain('portfolio says hi');
    t.titleBtn()!.click();
    t.select('tx');
    expect(t.menuOpen()).toBe(false);
    expect(t.titleBtn()!.textContent).toContain('Agent Threads orchestrator');
    expect(t.titleBtn()!.getAttribute('aria-expanded')).toBe('false');
    await settle();
    expect(texts(t)).toContain('agent-threads says hi');
    await settle();
    expect(texts(t)).not.toContain('portfolio says hi');
    expect(t.input()!.placeholder).toBe('Reply to Agent Threads orchestrator…');
    expect(t.input()!.getAttribute('aria-label')).toBe('Ask the Agent Threads orchestrator');
    expect(t.q('.ct-orch-sheet-scroll')!.getAttribute('aria-label')).toBe('Conversation with the Agent Threads orchestrator');
    expect(document.activeElement).toBe(t.titleBtn());
  });

  it('Portfolio keeps today\'s exact strings', async () => {
    const t = setup();
    t.dock.openSheet();
    expect(t.input()!.placeholder).toBe('Reply…');
    expect(t.input()!.getAttribute('aria-label')).toBe('Ask the portfolio orchestrator');
    expect(t.q('[data-testid="orchestrator-orb"]')!.getAttribute('aria-label')).toBe('Ask the portfolio orchestrator');
    expect(t.q('.ct-orch-stop')!.getAttribute('aria-label')).toBe('Stop the orchestrator');
  });

  it('Stop, Open full thread and sends act on the selected target', async () => {
    const t = setup();
    t.dock.openSheet();
    t.titleBtn()!.click();
    t.select('ty');
    t.s.running.add('ty');
    t.dock.refresh();
    expect(t.q('.ct-orch-stop')!.getAttribute('aria-label')).toBe('Stop the Compass orchestrator');
    t.q('.ct-orch-stop')!.click();
    await flush();
    expect(t.manager.interrupt).toHaveBeenCalledWith('ty');
    t.q('.ct-orch-sheet-full')!.click();
    expect(t.deps.openThread).toHaveBeenCalledWith('ty');
    t.s.running.clear();
    t.dock.refresh();
    t.type('hello compass');
    t.input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flush();
    expect(t.manager.sendMessage).toHaveBeenCalledWith('ty', 'hello compass');
  });

  it('every open starts on the Portfolio orchestrator, whatever was selected last', async () => {
    const t = setup();
    t.dock.openSheet();
    t.titleBtn()!.click();
    t.select('tx');
    t.dock.closeSheet();
    t.dock.openSheet();
    expect(t.titleBtn()!.textContent).toContain('Portfolio orchestrator');
    await settle();
    expect(texts(t)).toContain('portfolio says hi');
  });

  it('a selected orchestrator that goes away falls back to the default', async () => {
    const t = setup();
    t.dock.openSheet();
    t.titleBtn()!.click();
    t.select('tx');
    t.s.projects = t.s.projects.map((p) => (p.id === 'x' ? { ...p, orchestratorThreadId: undefined } : p));
    t.emit('tx', 'projects_changed');
    expect(t.titleBtn()!.textContent).toContain('Portfolio orchestrator');
    await settle();
    expect(texts(t)).toContain('portfolio says hi');
  });
});

describe('project names are user data: text only', () => {
  it('a hostile name renders as text in the title, the rows and the labels (no element, no handler)', async () => {
    const t = setup({ projects: [{ id: 'x', name: HOSTILE, orchestratorThreadId: 'tx' }] });
    t.dock.openSheet();
    t.titleBtn()!.click();
    expect(t.stage.querySelector('img')).toBeNull();
    expect(t.menu()!.querySelector('b')).toBeNull();
    expect(t.optionFor('tx')!.textContent).toContain(HOSTILE);
    t.select('tx');
    expect(t.titleBtn()!.textContent).toContain(`${HOSTILE} orchestrator`);
    expect(t.stage.querySelector('img')).toBeNull();
    expect(t.stage.querySelector('.ct-orch-sheet-head b')).toBeNull();
    expect(t.input()!.getAttribute('aria-label')).toBe(`Ask the ${HOSTILE} orchestrator`);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe('menu rows: status, unread, needs-you, draft', () => {
  it('shows a status dot, unread count, needs-you badge and draft mark per row', async () => {
    const w1 = thread('w1', { title: 'Waiting work', projectId: 'x' } as never);
    const t = setup({ extraThreads: [w1], permission: ['w1'] });
    // tx has an unread assistant reply that arrived while the sheet was closed
    t.say('tx', 'new reply 1');
    t.say('tx', 'new reply 2');
    t.drafts.set('typing for compass', 'ty');
    t.s.running.add('ty');
    t.dock.refresh();
    t.dock.openSheet();
    t.titleBtn()!.click();
    const tx = t.optionFor('tx')!;
    expect(tx.querySelector('.ct-orch-opt-unread')!.textContent).toBe('2');
    expect(tx.querySelector('.ct-orch-opt-needs')!.textContent).toBe('1 needs you');
    expect(tx.querySelector('.ct-orch-sdot')!.className).toContain('ct-orch-sdot-idle');
    const ty = t.optionFor('ty')!;
    expect(ty.querySelector('.ct-orch-sdot')!.className).toContain('ct-orch-sdot-running');
    expect(ty.querySelector('.ct-orch-opt-draft')).toBeTruthy();
    expect(t.optionFor('orch')!.querySelector('.ct-orch-opt-draft')).toBeNull();
    expect(tx.getAttribute('aria-label')).toBe('Agent Threads, idle, 2 unread replies, 1 needs you');
  });

  it('an error orchestrator shows the error dot', async () => {
    const t = setup();
    t.byId('ty')!.lastError = 'boom';
    t.dock.refresh();
    t.dock.openSheet();
    t.titleBtn()!.click();
    expect(t.optionFor('ty')!.querySelector('.ct-orch-sdot')!.className).toContain('ct-orch-sdot-error');
  });

  it('opening a target reads its replies: the unread badge clears', async () => {
    const t = setup();
    t.say('tx', 'new reply');
    t.dock.openSheet();
    t.titleBtn()!.click();
    expect(t.optionFor('tx')!.querySelector('.ct-orch-opt-unread')).toBeTruthy();
    t.select('tx');
    t.titleBtn()!.click();
    expect(t.optionFor('tx')!.querySelector('.ct-orch-opt-unread')).toBeNull();
  });
});

describe('keyboard', () => {
  it('Enter / Space / ArrowDown on the button open the menu with focus on the selected option', async () => {
    for (const k of ['Enter', ' ', 'ArrowDown']) {
      document.body.innerHTML = '';
      const t = setup();
      t.dock.openSheet();
      t.titleBtn()!.focus();
      // A real browser turns Enter / Space on a button into a click; ArrowDown is ours.
      if (k === 'ArrowDown') t.key(t.titleBtn()!, k); else t.titleBtn()!.click();
      expect(t.menuOpen()).toBe(true);
      expect(document.activeElement).toBe(t.optionFor('orch'));
    }
  });

  it('ArrowDown / ArrowUp / Home / End move between options; Enter selects; focus returns to the title button', async () => {
    const t = setup();
    t.dock.openSheet();
    t.titleBtn()!.click();
    t.key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(t.optionFor('tx'));
    t.key(document.activeElement!, 'End');
    expect(document.activeElement).toBe(t.optionFor('ty'));
    t.key(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(t.optionFor('tx'));
    t.key(document.activeElement!, 'Home');
    expect(document.activeElement).toBe(t.optionFor('orch'));
    t.key(document.activeElement!, 'ArrowDown');
    t.key(document.activeElement!, 'Enter');
    expect(t.menuOpen()).toBe(false);
    expect(t.titleBtn()!.textContent).toContain('Agent Threads orchestrator');
    expect(document.activeElement).toBe(t.titleBtn());
  });

  it('Space selects the focused option', async () => {
    const t = setup();
    t.dock.openSheet();
    t.titleBtn()!.click();
    t.key(document.activeElement!, 'End');
    t.key(document.activeElement!, ' ');
    expect(t.titleBtn()!.textContent).toContain('Compass orchestrator');
  });

  it('Escape closes the menu first (focus back on the button), and only a second Escape closes the sheet', async () => {
    const t = setup();
    t.dock.openSheet();
    t.titleBtn()!.click();
    t.key(document.activeElement!, 'Escape');
    expect(t.menuOpen()).toBe(false);
    expect(t.isOpen()).toBe(true);
    expect(document.activeElement).toBe(t.titleBtn());
    t.key(document.activeElement!, 'Escape');
    expect(t.isOpen()).toBe(false);
  });

  it('Escape while only the button is focused and the menu is open also closes just the menu', async () => {
    const t = setup();
    t.dock.openSheet();
    t.titleBtn()!.click();
    t.titleBtn()!.focus();
    t.key(t.titleBtn()!, 'Escape');
    expect(t.menuOpen()).toBe(false);
    expect(t.isOpen()).toBe(true);
  });

  it('options are a roving set: only the focused one is in the tab order', async () => {
    const t = setup();
    t.dock.openSheet();
    t.titleBtn()!.click();
    expect(t.options().map((o) => o.tabIndex)).toEqual([0, -1, -1]);
  });

  it('Tab out of the menu closes it', async () => {
    const t = setup();
    t.dock.openSheet();
    t.titleBtn()!.click();
    t.key(document.activeElement!, 'Tab');
    expect(t.menuOpen()).toBe(false);
  });
});

describe('outside click', () => {
  it('a press outside the title and the menu closes the menu (the sheet stays open)', async () => {
    const t = setup();
    t.dock.openSheet();
    t.titleBtn()!.click();
    t.q('.ct-orch-sheet-log')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(t.menuOpen()).toBe(false);
    expect(t.isOpen()).toBe(true);
  });

  it('a press inside the menu does not close it; the title button toggles it', async () => {
    const t = setup();
    t.dock.openSheet();
    t.titleBtn()!.click();
    t.menu()!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(t.menuOpen()).toBe(true);
    t.titleBtn()!.click();
    expect(t.menuOpen()).toBe(false);
  });

  it('closing the sheet closes the menu', async () => {
    const t = setup();
    t.dock.openSheet();
    t.titleBtn()!.click();
    t.dock.closeSheet();
    expect(t.menuOpen()).toBe(false);
  });
});

describe('per-target streaming', () => {
  const streaming = (t: T) => t.log().querySelector('[data-streaming="true"]');

  it('a stream on another target never shows in this one, and appears when that target is selected', async () => {
    const t = setup();
    t.dock.openSheet();
    t.emit('tx', 'streaming_start');
    t.emit('tx', 'token', { text: 'TX-STREAM' });
    expect(streaming(t)).toBeNull();
    t.titleBtn()!.click();
    t.select('tx');
    expect(streaming(t)!.textContent).toContain('TX-STREAM');
  });

  it('switching away from a streaming target leaves no stale streaming row and no foreign text', async () => {
    const t = setup();
    t.dock.openSheet();
    t.emit('orch', 'streaming_start');
    t.emit('orch', 'token', { text: 'PORTFOLIO-STREAM' });
    expect(streaming(t)!.textContent).toContain('PORTFOLIO-STREAM');
    t.titleBtn()!.click();
    t.select('ty');
    expect(streaming(t)).toBeNull();
    expect(t.log().textContent).not.toContain('PORTFOLIO-STREAM');
    t.titleBtn()!.click();
    t.select('orch');
    expect(streaming(t)!.textContent).toContain('PORTFOLIO-STREAM');
  });

  it('two targets streaming at once keep separate buffers', async () => {
    const t = setup();
    t.dock.openSheet();
    t.emit('orch', 'token', { text: 'AAA' });
    t.emit('tx', 'token', { text: 'BBB' });
    expect(streaming(t)!.textContent).toContain('AAA');
    expect(streaming(t)!.textContent).not.toContain('BBB');
    t.titleBtn()!.click();
    t.select('tx');
    expect(streaming(t)!.textContent).toContain('BBB');
    expect(streaming(t)!.textContent).not.toContain('AAA');
  });

  it('a Stopped row belongs to the target that was stopped', async () => {
    const t = setup();
    t.dock.openSheet();
    t.emit('orch', 'streaming_start');
    t.emit('orch', 'token', { text: 'partial reply' });
    t.emit('orch', 'interrupted');
    expect(t.log().querySelector('[data-stopped="true"]')).toBeTruthy();
    t.titleBtn()!.click();
    t.select('tx');
    expect(t.log().querySelector('[data-stopped="true"]')).toBeNull();
  });
});

describe('per-target drafts and input history', () => {
  it('each target keeps its own draft across switching, and the field shows the selected one', async () => {
    const t = setup();
    t.dock.openSheet();
    t.type('portfolio draft');
    t.titleBtn()!.click();
    t.select('tx');
    expect(t.input()!.value).toBe('');
    t.type('agent-threads draft');
    t.titleBtn()!.click();
    t.select('orch');
    expect(t.input()!.value).toBe('portfolio draft');
    t.titleBtn()!.click();
    t.select('tx');
    expect(t.input()!.value).toBe('agent-threads draft');
    expect(t.drafts.get('orch')).toBe('portfolio draft');
    expect(t.drafts.get('tx')).toBe('agent-threads draft');
  });

  it('the menu marks the targets that hold a draft (the selected one included)', async () => {
    const t = setup();
    t.dock.openSheet();
    t.type('half typed');
    t.titleBtn()!.click();
    expect(t.optionFor('orch')!.querySelector('.ct-orch-opt-draft')).toBeTruthy();
    expect(t.optionFor('tx')!.querySelector('.ct-orch-opt-draft')).toBeNull();
  });

  it('sending clears only the selected target\'s draft', async () => {
    const t = setup();
    t.dock.openSheet();
    t.type('keep me');
    t.titleBtn()!.click();
    t.select('tx');
    t.type('send me');
    t.input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flush();
    expect(t.drafts.get('tx')).toBe('');
    expect(t.drafts.get('orch')).toBe('keep me');
  });

  it('input history (ArrowUp recall) is per target', async () => {
    const t = setup();
    t.dock.openSheet();
    t.type('first for portfolio');
    t.input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flush();
    t.titleBtn()!.click();
    t.select('tx');
    t.input()!.focus();
    const up = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    t.input()!.dispatchEvent(up);
    expect(t.input()!.value).toBe('');
    t.titleBtn()!.click();
    t.select('orch');
    t.input()!.focus();
    t.input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    expect(t.input()!.value).toBe('first for portfolio');
  });
});

describe('unread peek and the dot cover every orchestrator', () => {
  it('a reply from a Project orchestrator peeks with its name and opens the sheet on that target', async () => {
    const t = setup();
    t.say('ty', 'compass finished the review');
    expect(t.peek().hidden).toBe(false);
    expect(t.peek().textContent).toContain('Compass');
    expect(t.peek().textContent).toContain('compass finished the review');
    (t.peek().querySelector('.ct-orch-peek-open') as HTMLElement).click();
    expect(t.isOpen()).toBe(true);
    expect(t.titleBtn()!.textContent).toContain('Compass orchestrator');
    await settle();
    expect(texts(t)).toContain('compass finished the review');
  });

  it('a Portfolio reply still peeks as "Orchestrator" and opens on the Portfolio', async () => {
    const t = setup();
    t.say('orch', 'portfolio finished');
    expect(t.peek().textContent).toContain('Orchestrator');
    (t.peek().querySelector('.ct-orch-peek-open') as HTMLElement).click();
    expect(t.titleBtn()!.textContent).toContain('Portfolio orchestrator');
  });

  it('opening the sheet by any other route (the field, Cmd+J) still starts on the Portfolio', async () => {
    const t = setup();
    t.say('ty', 'compass finished the review');
    t.dock.openSheet();
    expect(t.titleBtn()!.textContent).toContain('Portfolio orchestrator');
  });

  it('a peek while the sheet is open on another target switches to its source when Open is pressed', async () => {
    const t = setup();
    t.dock.openSheet();
    t.say('ty', 'compass finished the review');
    expect(t.peek().hidden).toBe(false);
    (t.peek().querySelector('.ct-orch-peek-open') as HTMLElement).click();
    expect(t.titleBtn()!.textContent).toContain('Compass orchestrator');
  });

  it('an unread reply on a non-selected orchestrator keeps the dot in its attention state', async () => {
    const t = setup();
    t.say('tx', 'unread over there');
    expect(t.dot().classList.contains('ct-orch-dot-attention')).toBe(true);
    expect(t.dot().getAttribute('title')).toContain('unread reply');
    t.dock.openSheet();
    expect(t.dot().classList.contains('ct-orch-dot-attention')).toBe(true); // tx is still unread: only Portfolio was opened
    t.titleBtn()!.click();
    t.select('tx');
    expect(t.dot().classList.contains('ct-orch-dot-attention')).toBe(false);
  });

  it('a reply on the selected target while the sheet is open is read at once, no peek', async () => {
    const t = setup();
    t.dock.openSheet();
    t.titleBtn()!.click();
    t.select('tx');
    t.say('tx', 'live reply');
    expect(t.peek().hidden).toBe(true);
    await settle();
    expect(texts(t)).toContain('live reply');
  });
});

describe('the Needs-you tray covers every orchestrator', () => {
  const owner = (t: T, threadId: string) => t.q(`.ct-orch-tray-card[data-thread-id="${threadId}"] .ct-orch-tray-owner`);

  it('a card of a non-selected orchestrator says whose it is; the selected one\'s do not', async () => {
    const wx = thread('wx', { title: 'Project X work', projectId: 'x' } as never);
    const wfree = thread('wf', { title: 'Unassigned work' });
    const t = setup({ extraThreads: [wx, wfree], permission: ['wx', 'wf'] });
    t.dock.openSheet(); // Portfolio selected
    expect(owner(t, 'wx')!.textContent).toBe('Agent Threads');
    expect(owner(t, 'wf')).toBeNull();
    t.titleBtn()!.click();
    t.select('tx');
    expect(owner(t, 'wx')).toBeNull();
    expect(owner(t, 'wf')!.textContent).toBe('Portfolio');
  });

  it('the hand-off ("Review in thread") opens the thread that is waiting, not the selected orchestrator', async () => {
    const wx = thread('wx', { title: 'Project X work', projectId: 'x' } as never);
    const t = setup({ extraThreads: [wx], permission: ['wx'] });
    t.dock.openSheet();
    (t.q('.ct-orch-tray-card[data-thread-id="wx"] .ct-orch-tray-handoff') as HTMLElement).click();
    expect(t.deps.openThread).toHaveBeenCalledWith('wx');
  });

  it('a hostile project name in the owner label is text', async () => {
    const wx = thread('wx', { title: 'Project X work', projectId: 'x' } as never);
    const t = setup({ extraThreads: [wx], permission: ['wx'], projects: [{ id: 'x', name: HOSTILE, orchestratorThreadId: 'tx' }] });
    t.dock.openSheet();
    expect(owner(t, 'wx')!.textContent).toBe(HOSTILE);
    expect(t.stage.querySelector('img')).toBeNull();
  });
});

describe('a send that fails after the user switched target', () => {
  it('goes back into the draft of the target it was sent to, not the one now showing', async () => {
    const t = setup();
    let reject!: (e: Error) => void;
    t.manager.sendMessage.mockImplementationOnce(() => new Promise<void>((_r, rej) => { reject = rej; }));
    t.dock.openSheet();
    t.type('slow message');
    t.input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    t.titleBtn()!.click();
    t.select('tx');
    reject(new Error('boom'));
    await flush();
    expect(t.input()!.value).toBe('');
    expect(t.drafts.get('orch')).toBe('slow message');
  });
});

describe('narrow (orb) mode', () => {
  it('the same menu works in the bottom sheet, and its rows are 44px tall (CSS)', async () => {
    const t = setup({ mode: 'orb' });
    t.dock.openSheet();
    expect(t.titleBtn()).toBeTruthy();
    t.titleBtn()!.click();
    expect(t.options().length).toBe(3);
    const css = readFileSync('styles.css', 'utf8');
    expect(css).toMatch(/\.ct-orch-sheet\[data-mode="orb"\][^{]*\.ct-orch-menu-opt[^{]*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/\.ct-orch-title-btn:focus-visible/);
    expect(css).toMatch(/\.ct-orch-menu-opt:focus-visible/);
  });
});

/**
 * orchestrator-dock-tray.test.ts
 * @vitest-environment jsdom
 *
 * OrchestratorDock P4: the Needs-you tray inside the reply sheet. The fake manager keeps ONE piece of pending
 * state per thread (like the real one), so "resolve in the sheet OR on the board, both update" is observable:
 * resolvePermission clears the pending state and emits permission_resolved, exactly as the manager does.
 */
import '../setup/obsidian-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { OrchestratorDock, type OrchestratorDockDeps } from '../../src/orchestratorDock';
import type { Thread } from '../../src/types';

type Ev = { type: string; [k: string]: unknown };
type Listener = (threadId: string, event: Ev) => void;
type Kind = 'permission' | 'question' | 'plan' | 'failed';
interface Spec { id: string; title: string; kind: Kind; tool?: string; detail?: string }

const HOST_EXEC_DETAIL = `Run host_exec for a remote thread: ${JSON.stringify({ command: 'git status' })}`;
const DEFAULT: Spec[] = [
  { id: 'p', title: 'Deploy curation', kind: 'permission', tool: 'Bash', detail: 'npm run deploy --prod' },
  { id: 'q', title: 'Mobile layout polish', kind: 'question' },
  { id: 'pl', title: 'Social nudge', kind: 'plan' },
];

function thread(id: string, over: Partial<Thread> = {}): Thread {
  return { id, title: `Thread ${id}`, cwd: '/r', messages: [{ id: `m-${id}`, role: 'assistant', content: 'hi', timestamp: 0 }], createdAt: 0, updatedAt: 0, status: 'waiting', reviewed: true, ...over } as Thread;
}

function setup(opts: { specs?: Spec[]; mode?: 'pill' | 'orb'; permissionCard?: boolean; open?: boolean; allowAlways?: boolean } = {}) {
  const specs = opts.specs ?? DEFAULT;
  const orch = thread('orch', { title: 'Portfolio Orchestrator' });
  const threads: Thread[] = [orch, ...specs.map((s) => thread(s.id, { title: s.title, ...(s.kind === 'failed' ? { lastError: 'boom' } : {}) }))];
  const perms = new Map<string, { toolName: string; detail: string }>();
  const questions = new Set<string>();
  const plans = new Set<string>();
  for (const s of specs) {
    if (s.kind === 'permission') perms.set(s.id, { toolName: s.tool ?? 'Bash', detail: s.detail ?? '{}' });
    if (s.kind === 'question') questions.add(s.id);
    if (s.kind === 'plan') plans.add(s.id);
  }
  const state = { mode: opts.mode ?? ('pill' as 'pill' | 'orb') };
  const listeners = new Set<Listener>();
  const emit = (id: string, type: string, extra: Record<string, unknown> = {}) => { for (const l of [...listeners]) l(id, { type, ...extra }); };
  const manager = {
    getThread: (id: string) => threads.find((t) => t.id === id),
    isRunning: () => false,
    hasPendingPermission: (id: string) => perms.has(id),
    hasPendingQuestion: (id: string) => questions.has(id),
    hasPendingPlan: (id: string) => plans.has(id),
    hasActiveBackgroundTasks: () => false,
    getQueuedMessages: () => [],
    removeQueuedMessageAt: vi.fn(),
    getThreadActivity: () => undefined,
    interrupt: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    getPendingPermission: vi.fn((id: string) => perms.get(id)),
    getRemoteScope: vi.fn(() => null),
    // Real manager: the resolver settles the prompt; promptPermission's finally emits permission_resolved.
    resolvePermission: vi.fn((id: string) => { perms.delete(id); emit(id, 'permission_resolved'); }),
    subscribe: vi.fn((l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; }),
  };
  const settings = { alwaysAllowedTools: [] as string[], hostExecAlwaysAllowedPrefixes: [] as string[] };
  const saveSettings = vi.fn(async () => {});
  const deps: OrchestratorDockDeps = {
    manager: manager as never,
    listThreads: () => threads,
    hasPendingWakeup: () => false,
    getOrchestratorThreadId: () => 'orch',
    ensureOrchestrator: vi.fn(async () => {}),
    openThread: vi.fn(),
    mode: () => state.mode,
    daemons: null,
    ...(opts.permissionCard === false ? {} : { permissionCard: { getSettings: () => settings, saveSettings, hostExecAllowAlways: () => opts.allowAlways ?? true } }),
  } as OrchestratorDockDeps;
  const stage = document.createElement('div');
  stage.className = 'ct-kanban-dispatch';
  const host = document.createElement('div');
  stage.appendChild(host);
  document.body.appendChild(stage);
  const dock = new OrchestratorDock(host, deps);
  dock.mount();
  if (opts.open !== false) dock.openSheet();
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => stage.querySelector(sel) as T | null;
  const qa = (sel: string) => [...stage.querySelectorAll(sel)] as HTMLElement[];
  return {
    dock, deps, manager, stage, q, qa, emit, perms, questions, plans, threads, settings, saveSettings, state,
    tray: () => q('.ct-orch-tray'),
    cards: () => qa('.ct-orch-tray-card'),
    card: (id: string) => q(`.ct-orch-tray-card[data-thread-id="${id}"]`),
    btn: (id: string, name: RegExp | string) => qa(`.ct-orch-tray-card[data-thread-id="${id}"] button`).find((b) => (typeof name === 'string' ? b.textContent === name : name.test(b.textContent ?? ''))),
    live: () => q('.ct-orch-live')!.textContent,
    /** The board resolving it (or any other surface): the manager state changes, the manager emits. */
    resolveElsewhere: (id: string) => { perms.delete(id); emit(id, 'permission_resolved'); },
    addPermission: (s: Spec) => {
      threads.push(thread(s.id, { title: s.title }));
      perms.set(s.id, { toolName: s.tool ?? 'Bash', detail: s.detail ?? '{}' });
      emit(s.id, 'permission_request', { toolName: s.tool ?? 'Bash' });
    },
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { document.body.innerHTML = ''; });

describe('tray structure + a11y', () => {
  it('is a labelled region inside the sheet dialog, between the transcript and the composer, titled "Needs you (N)"', () => {
    const t = setup();
    const tray = t.tray()!;
    expect(tray.getAttribute('role')).toBe('region');
    expect(tray.getAttribute('aria-label')).toBe('Needs you');
    expect(tray.closest('.ct-orch-sheet')).toBe(t.q('.ct-orch-sheet'));
    expect(tray.querySelector('.ct-orch-tray-title')!.textContent).toBe('Needs you (3)');
    const sheet = t.q('.ct-orch-sheet')!;
    const order = [...sheet.querySelectorAll('.ct-orch-sheet-scroll, .ct-orch-tray-slot, .ct-orch-sheet-composer')].map((e) => e.className.split(' ')[0]);
    expect(order).toEqual(['ct-orch-sheet-scroll', 'ct-orch-tray-slot', 'ct-orch-sheet-composer']);
  });

  it('is in the focus trap of the narrow modal bottom sheet (Tab wraps through its buttons, never out)', () => {
    const t = setup({ mode: 'orb' });
    const sheet = t.q('.ct-orch-sheet')!;
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    const trayButtons = t.qa('.ct-orch-tray button');
    expect(trayButtons.length).toBeGreaterThan(0);
    trayButtons.forEach((b) => expect(sheet.contains(b)).toBe(true));
    // Tab from the last control in the sheet wraps to the first: the tray buttons are in the list the trap walks.
    const last = [...sheet.querySelectorAll<HTMLElement>('button, a[href], textarea, input')].filter((n) => !n.hidden && !n.closest('[hidden]')).pop()!;
    last.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    sheet.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(sheet.contains(document.activeElement)).toBe(true);
  });

  it('every action has an accessible name that includes the thread title', () => {
    const t = setup();
    expect(t.btn('p', 'Deny')!.getAttribute('aria-label')).toBe('Deny Bash for Deploy curation');
    expect(t.btn('p', 'Allow')!.getAttribute('aria-label')).toBe('Allow Bash for Deploy curation');
    expect(t.btn('p', 'Always')!.getAttribute('aria-label')).toBe('Always Bash for Deploy curation');
    expect(t.btn('q', 'Answer…')!.getAttribute('aria-label')).toBe('Answer Mobile layout polish in its thread');
    expect(t.btn('pl', 'Review plan…')!.getAttribute('aria-label')).toBe('Review plan for Social nudge');
  });

  it('cards live in a list; DOM order is board order (permission, question, plan here)', () => {
    const t = setup();
    expect(t.q('.ct-orch-tray ul')).toBeTruthy();
    expect(t.cards().map((c) => c.dataset.threadId)).toEqual(['p', 'q', 'pl']);
  });
});

describe('what the tray lists', () => {
  it('matches the attention list: awaiting threads only, failures excluded, count in the heading', () => {
    const t = setup({ specs: [...DEFAULT, { id: 'f', title: 'Relay backoff', kind: 'failed' }] });
    expect(t.cards().map((c) => c.dataset.threadId)).toEqual(['p', 'q', 'pl']);
    expect(t.q('.ct-orch-tray-title')!.textContent).toBe('Needs you (3)');
  });

  it('includes the orchestrator\'s OWN pending permission', () => {
    const t = setup({ specs: [] });
    t.perms.set('orch', { toolName: 'Edit', detail: JSON.stringify({ file_path: '/r/a.ts' }) });
    t.emit('orch', 'permission_request');
    expect(t.cards().map((c) => c.dataset.threadId)).toEqual(['orch']);
    expect(t.btn('orch', 'Deny')).toBeTruthy();
  });

  it('has no tray (no empty region) when nothing awaits', () => {
    const t = setup({ specs: [{ id: 'f', title: 'Failed one', kind: 'failed' }] });
    expect(t.tray()).toBeNull();
  });

  it('removes the tray when the last item is resolved', () => {
    const t = setup({ specs: [DEFAULT[0]] });
    expect(t.tray()).toBeTruthy();
    t.resolveElsewhere('p');
    expect(t.tray()).toBeNull();
  });
});

describe('permission cards reuse the board buttons', () => {
  it('shows the tool chip, the summarised detail and Deny / Allow / Always', () => {
    const t = setup();
    const card = t.card('p')!;
    expect(card.querySelector('.ct-orch-tray-name')!.textContent).toBe('Deploy curation');
    expect(card.querySelector('.ct-agents-permission-tool')!.textContent).toBe('Bash');
    expect(card.querySelector('.ct-agents-permission-detail')!.textContent).toBe('npm run deploy --prod');
    expect([...card.querySelectorAll('.ct-permission-btn')].map((b) => b.textContent)).toEqual(['Deny', 'Allow', 'Always']);
  });

  it('host_exec: Allow once + Always `prefix` (the shared helper\'s variants)', () => {
    const t = setup({ specs: [{ id: 'h', title: 'Remote job', kind: 'permission', tool: 'mcp__claude_threads__host_exec', detail: HOST_EXEC_DETAIL }] });
    expect([...t.card('h')!.querySelectorAll('.ct-permission-btn')].map((b) => b.textContent)).toEqual(['Deny', 'Allow once', 'Always `git status`']);
  });

  it('Deny / Allow call manager.resolvePermission(threadId, allow) and nothing else', async () => {
    const t = setup();
    t.btn('p', 'Deny')!.click();
    await flush();
    expect(t.manager.resolvePermission.mock.calls).toEqual([['p', false]]);
    const t2 = setup();
    t2.btn('p', 'Allow')!.click();
    await flush();
    expect(t2.manager.resolvePermission.mock.calls).toEqual([['p', true]]);
  });

  it('Always records the allowance through the lazily read settings, then resolves', async () => {
    const t = setup();
    t.btn('p', 'Always')!.click();
    await flush();
    expect(t.settings.alwaysAllowedTools).toEqual(['Bash']);
    expect(t.saveSettings).toHaveBeenCalledTimes(1);
    expect(t.manager.resolvePermission).toHaveBeenCalledWith('p', true);
  });

  it('NEVER approves anything without a click: render, refresh, relayout, reopen and unrelated events resolve nothing', () => {
    const t = setup();
    t.dock.refresh();
    t.dock.relayout();
    t.emit('p', 'permission_request');
    t.emit('q', 'pending_question_changed');
    t.dock.closeSheet();
    t.dock.openSheet();
    expect(t.manager.resolvePermission).not.toHaveBeenCalled();
    expect(t.saveSettings).not.toHaveBeenCalled();
  });

  it('a card click does not bubble (the pill / board must not see it)', () => {
    const t = setup();
    const outer = vi.fn();
    t.stage.addEventListener('click', outer);
    t.btn('p', 'Deny')!.click();
    expect(outer).not.toHaveBeenCalled();
  });

  it('without permissionCard deps the card hands off instead of showing buttons that would not persist an Always', () => {
    const t = setup({ permissionCard: false });
    expect(t.card('p')!.querySelector('.ct-permission-btn')).toBeNull();
    t.btn('p', 'Open thread…')!.click();
    expect(t.deps.openThread).toHaveBeenCalledWith('p');
    expect(t.manager.resolvePermission).not.toHaveBeenCalled();
  });

  it('a permission that vanished between classification and render hands off rather than offering dead buttons', () => {
    const t = setup();
    t.perms.delete('p'); // gone, but hasPendingPermission is what attentionItems read first: emulate the race
    t.manager.hasPendingPermission = (id: string) => id === 'p' || t.perms.has(id);
    t.dock.refresh();
    expect(t.card('p')!.querySelector('.ct-permission-btn')).toBeNull();
    expect(t.btn('p', 'Open thread…')).toBeTruthy();
  });
});

describe('resolving in either place resolves both', () => {
  it('sheet -> board: clicking in the tray resolves through the manager, the card leaves the tray, and the manager state is cleared for the board', async () => {
    const t = setup();
    t.btn('p', 'Allow')!.click();
    await flush();
    expect(t.card('p')).toBeNull();
    expect(t.manager.hasPendingPermission('p')).toBe(false); // the board reads this same state
    expect(t.cards().map((c) => c.dataset.threadId)).toEqual(['q', 'pl']);
    expect(t.q('.ct-orch-tray-title')!.textContent).toBe('Needs you (2)');
  });

  it('board -> sheet: the board resolving the same permission removes the tray card', () => {
    const t = setup();
    t.resolveElsewhere('p');
    expect(t.card('p')).toBeNull();
    expect(t.cards()).toHaveLength(2);
  });

  it('a new permission request appears as a card', () => {
    const t = setup({ specs: [] });
    expect(t.tray()).toBeNull();
    t.addPermission({ id: 'n', title: 'New one', kind: 'permission', tool: 'Write', detail: '{}' });
    expect(t.card('n')).toBeTruthy();
    expect(t.btn('n', 'Deny')).toBeTruthy();
  });
});

describe('question and plan items hand off, never resolve inline', () => {
  it('a question has ONE button, "Answer…", which opens that thread', () => {
    const t = setup();
    const btns = t.qa('.ct-orch-tray-card[data-thread-id="q"] button');
    expect(btns.map((b) => b.textContent)).toEqual(['Answer…']);
    btns[0].click();
    expect(t.deps.openThread).toHaveBeenCalledWith('q');
    expect(t.manager.resolvePermission).not.toHaveBeenCalled();
    expect(t.manager.sendMessage).not.toHaveBeenCalled();
  });

  it('a plan has ONE button, "Review plan…", which opens that thread', () => {
    const t = setup();
    const btns = t.qa('.ct-orch-tray-card[data-thread-id="pl"] button');
    expect(btns.map((b) => b.textContent)).toEqual(['Review plan…']);
    btns[0].click();
    expect(t.deps.openThread).toHaveBeenCalledWith('pl');
    expect(t.manager.resolvePermission).not.toHaveBeenCalled();
  });

  it('opening a thread leaves the sheet open', () => {
    const t = setup();
    t.btn('q', 'Answer…')!.click();
    expect(t.q('.ct-orch-sheet')!.hidden).toBe(false);
  });
});

describe('collapse beyond three', () => {
  const five: Spec[] = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, title: `Thread ${i}`, kind: 'permission' as const, tool: 'Bash', detail: `cmd ${i}` }));

  it('three or fewer: no toggle', () => {
    const t = setup();
    expect(t.q('.ct-orch-tray-toggle')).toBeNull();
  });

  it('five: three cards + "Show 2 more"; the heading still counts all five', () => {
    const t = setup({ specs: five });
    expect(t.cards()).toHaveLength(3);
    const toggle = t.q<HTMLButtonElement>('.ct-orch-tray-toggle')!;
    expect(toggle.textContent).toBe('Show 2 more');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(t.q('.ct-orch-tray-title')!.textContent).toBe('Needs you (5)');
  });

  it('the toggle expands to all five and back; the same button node keeps focus', () => {
    const t = setup({ specs: five });
    const toggle = t.q<HTMLButtonElement>('.ct-orch-tray-toggle')!;
    toggle.focus();
    toggle.click();
    expect(t.cards()).toHaveLength(5);
    expect(t.q('.ct-orch-tray-toggle')).toBe(toggle);
    expect(toggle.textContent).toBe('Show fewer');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(toggle);
    toggle.click();
    expect(t.cards()).toHaveLength(3);
    expect(toggle.textContent).toBe('Show 2 more');
  });

  it('resolving a visible card pulls the next hidden one in; resolving down to three drops the toggle', () => {
    const t = setup({ specs: five });
    t.resolveElsewhere('t0');
    expect(t.cards().map((c) => c.dataset.threadId)).toEqual(['t1', 't2', 't3']);
    expect(t.q('.ct-orch-tray-toggle')!.textContent).toBe('Show 1 more');
    t.resolveElsewhere('t1');
    expect(t.q('.ct-orch-tray-toggle')).toBeNull();
    expect(t.cards()).toHaveLength(3);
  });
});

describe('announcements and focus', () => {
  it('a new request is announced politely as "<title> needs approval" and does not move focus', () => {
    const t = setup();
    const input = t.q<HTMLTextAreaElement>('textarea.ct-orch-input')!;
    input.focus();
    t.addPermission({ id: 'n', title: 'Ship the thing', kind: 'permission' });
    expect(t.live()).toBe('Ship the thing needs approval');
    expect(t.q('.ct-orch-live')!.getAttribute('aria-live')).toBe('polite');
    expect(document.activeElement).toBe(input);
  });

  it('what is already listed when the sheet opens is NOT announced', () => {
    const t = setup();
    expect(t.live()).toBe('');
  });

  it('a resolved-then-requested thread is announced again; unrelated refreshes announce nothing', () => {
    const t = setup();
    t.dock.refresh();
    expect(t.live()).toBe('');
    t.resolveElsewhere('p');
    t.perms.set('p', { toolName: 'Bash', detail: 'again' });
    t.emit('p', 'permission_request');
    expect(t.live()).toBe('Deploy curation needs approval');
  });

  it('arrivals while the sheet is CLOSED do not open it and do not announce on reopen', () => {
    const t = setup({ open: false, specs: [DEFAULT[1]] });
    t.addPermission({ id: 'n', title: 'Ship the thing', kind: 'permission' });
    expect(t.q('.ct-orch-sheet')!.hidden).toBe(true);
    t.dock.openSheet();
    expect(t.live()).toBe('');
    expect(t.card('n')).toBeTruthy();
  });

  it('when the focused card is resolved, focus moves to the next card\'s first button (not lost to <body>)', () => {
    const t = setup();
    t.btn('p', 'Deny')!.focus();
    t.resolveElsewhere('p');
    expect(document.activeElement).toBe(t.btn('q', 'Answer…'));
  });

  it('when the last card is resolved under focus, focus goes into the composer', () => {
    const t = setup({ specs: [DEFAULT[0]] });
    t.btn('p', 'Deny')!.focus();
    t.resolveElsewhere('p');
    expect(document.activeElement).toBe(t.q('textarea.ct-orch-input'));
  });

  it('a refresh that changes nothing keeps the same card and button nodes (focus + clicks survive)', () => {
    const t = setup();
    const deny = t.btn('p', 'Deny');
    deny!.focus();
    t.dock.refresh();
    t.emit('q', 'pending_question_changed');
    expect(t.btn('p', 'Deny')).toBe(deny);
    expect(document.activeElement).toBe(deny);
  });
});

describe('lifecycle', () => {
  it('destroy removes the tray and later events do nothing', () => {
    const t = setup();
    t.dock.destroy();
    expect(t.tray()).toBeNull();
    expect(() => t.emit('p', 'permission_resolved')).not.toThrow();
  });
});

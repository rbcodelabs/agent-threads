/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Menu } from 'obsidian';
import { ThreadsView } from '../../src/ThreadsView';

/**
 * Covers the "Move to Project…" item added to the per-thread ⋯ menu. Choosing the
 * Project uses the searchable ProjectPicker (filter + sort), exercised in
 * project-picker.test.ts; here we only check the wiring and the move itself.
 *
 * Before this, a thread created outside a Project could never be moved into one:
 * `threads_set_project` rejected it at the coordination layer and ThreadsView only
 * exposed a Project at thread *creation* time. This menu is the human-side escape hatch.
 *
 * ThreadsView is a full Obsidian ItemView and is not constructible under vitest, so these
 * call the real prototype methods against a stub receiver — the production code under
 * test is the actual shipped implementation, not a mirror.
 */

type MenuMock = Menu & { titles(): string[]; item(title: string): { checked: boolean; clickHandler?: (evt?: unknown) => unknown } | undefined };

/** Menus opened during a test, in creation order. */
let opened: MenuMock[] = [];
const realShow = Menu.prototype.showAtMouseEvent;

beforeEach(() => {
  opened = [];
  Menu.prototype.showAtMouseEvent = function (this: MenuMock, evt: unknown) {
    opened.push(this);
    return realShow.call(this, evt);
  } as typeof Menu.prototype.showAtMouseEvent;
});

afterEach(() => {
  Menu.prototype.showAtMouseEvent = realShow;
});

interface Ctx {
  view: ThreadsView;
  setThreadProject: ReturnType<typeof vi.fn>;
  saveSettings: ReturnType<typeof vi.fn>;
  renderComposerContext: ReturnType<typeof vi.fn>;
}

function makeView(opts: {
  activeThreadId: string;
  threads: Array<{ id: string; projectId?: string }>;
  projects?: Array<{ id: string; name: string; orchestratorThreadId?: string }>;
  portfolioOrchestratorThreadId?: string;
  setThreadProjectImpl?: (...args: unknown[]) => void;
}): Ctx {
  const projects = opts.projects ?? [];
  const setThreadProject = vi.fn(opts.setThreadProjectImpl);
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const renderComposerContext = vi.fn();

  const manager = {
    getThread: (id: string) => opts.threads.find(t => t.id === id) ?? null,
    getThreads: () => opts.threads,
    getProjects: () => projects,
    getProject: (id: string) => projects.find(p => p.id === id) ?? null,
    setThreadProject,
  };

  // Built on the real prototype so the methods under test call each other for real —
  // only collaborators and DOM-bound repaint helpers are stubbed.
  const view = Object.assign(Object.create(ThreadsView.prototype), {
    activeThreadId: opts.activeThreadId,
    compressedView: false,
    escalatedTurnModels: new Map(),
    manager,
    plugin: {
      manager,
      settings: { orchestratorThreadId: opts.portfolioOrchestratorThreadId },
      discoveredModelsByHarness: { codex: [] },
      saveSettings,
      openNewProjectSettings: vi.fn(),
    },
    renderComposerContext,
    // Referenced by the other ⋯ items; never invoked in these tests.
    toggleCompressView: vi.fn(),
    summarizeThread: vi.fn(),
    forkThread: vi.fn(),
  }) as ThreadsView;

  return { view, setThreadProject, saveSettings, renderComposerContext };
}

/** Private-by-convention methods; reached through the prototype for testing. */
const proto = ThreadsView.prototype as unknown as {
  toggleMoreMenu(this: ThreadsView, event: MouseEvent): void;
  openMoveToProjectMenu(this: ThreadsView, anchor: HTMLElement, threadId: string): void;
  moveThreadToProject(this: ThreadsView, threadId: string, projectId: string | null): Promise<void>;
};

const evt = {} as MouseEvent;
const anchor = document.createElement('button');

afterEach(() => { document.body.innerHTML = ''; });

const pickerRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.ct-project-picker [role="option"]')];
const rowByName = (name: string): HTMLElement | undefined => pickerRows().find(r => r.textContent?.includes(name));
const PROJECTS = [
  { id: 'p1', name: 'Agentic PM Playbook' },
  { id: 'p2', name: 'Golden Wealth', orchestratorThreadId: 'orch-p2' },
];

describe('ThreadsView — Move to Project…', () => {
  it('offers the item for a normal unassigned thread', () => {
    const { view } = makeView({
      activeThreadId: 't1',
      threads: [{ id: 't1' }],
      projects: PROJECTS,
      portfolioOrchestratorThreadId: 'portfolio',
    });

    proto.toggleMoreMenu.call(view, evt);

    expect(opened).toHaveLength(1);
    expect(opened[0]!.titles()).toContain('Move to Project…');
  });

  it('offers the item for a thread that is a plain member of a Project', () => {
    const { view } = makeView({
      activeThreadId: 't1',
      threads: [{ id: 't1', projectId: 'p1' }],
      projects: PROJECTS,
      portfolioOrchestratorThreadId: 'portfolio',
    });

    proto.toggleMoreMenu.call(view, evt);

    expect(opened[0]!.titles()).toContain('Move to Project…');
  });

  it('hides the item for the Portfolio orchestrator, which can never be assigned', () => {
    const { view } = makeView({
      activeThreadId: 'portfolio',
      threads: [{ id: 'portfolio' }],
      projects: PROJECTS,
      portfolioOrchestratorThreadId: 'portfolio',
    });

    proto.toggleMoreMenu.call(view, evt);

    expect(opened[0]!.titles()).not.toContain('Move to Project…');
    // The rest of the ⋯ menu is untouched.
    expect(opened[0]!.titles()).toContain('Fork conversation');
  });

  it('hides the item for a Project orchestrator, which cannot be reassigned', () => {
    const { view } = makeView({
      activeThreadId: 'orch-p2',
      threads: [{ id: 'orch-p2', projectId: 'p2' }],
      projects: PROJECTS,
      portfolioOrchestratorThreadId: 'portfolio',
    });

    proto.toggleMoreMenu.call(view, evt);

    expect(opened[0]!.titles()).not.toContain('Move to Project…');
  });

  it('lists No Project, every Project and New Project…, checking the thread’s current one', () => {
    const { view } = makeView({
      activeThreadId: 't1',
      threads: [{ id: 't1', projectId: 'p1' }],
      projects: PROJECTS,
    });

    proto.openMoveToProjectMenu.call(view, anchor, 't1');

    expect(pickerRows().map(r => r.textContent)).toEqual(['No Project', 'Agentic PM Playbook', 'Golden Wealth', 'New Project…']);
    expect(rowByName('Agentic PM Playbook')!.getAttribute('aria-selected')).toBe('true');
    expect(rowByName('No Project')!.getAttribute('aria-selected')).toBe('false');
    expect(rowByName('Golden Wealth')!.getAttribute('aria-selected')).toBe('false');
  });

  it('checks No Project when the thread has no Project', () => {
    const { view } = makeView({ activeThreadId: 't1', threads: [{ id: 't1' }], projects: PROJECTS });

    proto.openMoveToProjectMenu.call(view, anchor, 't1');

    expect(rowByName('No Project')!.getAttribute('aria-selected')).toBe('true');
  });

  it('selecting a Project calls setThreadProject with alignCwd true and persists', async () => {
    const ctx = makeView({ activeThreadId: 't1', threads: [{ id: 't1' }], projects: PROJECTS });

    proto.openMoveToProjectMenu.call(ctx.view, anchor, 't1');
    rowByName('Agentic PM Playbook')!.click();
    await vi.waitFor(() => expect(ctx.setThreadProject).toHaveBeenCalledWith('t1', 'p1', true));

    expect(ctx.saveSettings).toHaveBeenCalled();
    expect(ctx.renderComposerContext).toHaveBeenCalledOnce();
  });

  it('selecting No Project detaches by passing null', async () => {
    const ctx = makeView({ activeThreadId: 't1', threads: [{ id: 't1', projectId: 'p1' }], projects: PROJECTS });

    proto.openMoveToProjectMenu.call(ctx.view, anchor, 't1');
    rowByName('No Project')!.click();
    await vi.waitFor(() => expect(ctx.setThreadProject).toHaveBeenCalledWith('t1', null, true));
  });

  it('re-selecting the current Project is a no-op', () => {
    const ctx = makeView({ activeThreadId: 't1', threads: [{ id: 't1', projectId: 'p1' }], projects: PROJECTS });

    proto.openMoveToProjectMenu.call(ctx.view, anchor, 't1');
    rowByName('Agentic PM Playbook')!.click();

    expect(ctx.setThreadProject).not.toHaveBeenCalled();
  });

  it('does not repaint the active-thread chrome when moving a non-active thread', async () => {
    const ctx = makeView({
      activeThreadId: 'other',
      threads: [{ id: 't1' }, { id: 'other' }],
      projects: PROJECTS,
    });

    await proto.moveThreadToProject.call(ctx.view, 't1', 'p1');

    expect(ctx.setThreadProject).toHaveBeenCalledWith('t1', 'p1', true);
    expect(ctx.renderComposerContext).not.toHaveBeenCalled();
  });

  it('surfaces a ThreadManager rejection instead of throwing out of the click handler', async () => {
    const ctx = makeView({
      activeThreadId: 't1',
      threads: [{ id: 't1' }],
      projects: PROJECTS,
      setThreadProjectImpl: () => { throw new Error('Project not found: p9'); },
    });

    await expect(proto.moveThreadToProject.call(ctx.view, 't1', 'p9')).resolves.toBeUndefined();
    expect(ctx.saveSettings).not.toHaveBeenCalled();
  });
});

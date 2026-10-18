/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ClaudeSession', () => ({ formatToolName: (n: string) => n, getToolIcon: () => 'wrench' }));
vi.mock('../../src/stt', () => ({
  SttController: function SttController() {
    return {
      attachPttToTextarea: vi.fn(() => () => {}),
      createMicButton: vi.fn(() => document.createElement('button')),
      destroy: vi.fn(),
    };
  },
}));
vi.mock('fs', () => ({
  default: { readdirSync: () => [], statSync: () => ({ isDirectory: () => false }), existsSync: () => false, readFileSync: () => '' },
  readdirSync: () => [], statSync: () => ({ isDirectory: () => false }), existsSync: () => false, readFileSync: () => '',
}));
vi.mock('../../src/SettingsTab', () => ({ isWebViewerEnabled: () => false }));

import { AgentDashboard } from '../../src/AgentDashboard';
import { KanbanView } from '../../src/KanbanView';
import { ThreadsView } from '../../src/ThreadsView';
import { ThreadManager } from '../../src/ThreadManager';
import { SlashCommandRegistry } from '../../src/SlashCommandContributions';
import { DispatchInput } from '../../src/DispatchInput';
import { DEFAULT_SETTINGS } from '../../src/types';

type Internals = Record<string, any>;
const proto = ThreadsView.prototype as unknown as Record<string, (...args: any[]) => any>;

function makeView(opts: { activeThreadId?: string | null } = {}) {
  const settings = { ...DEFAULT_SETTINGS };
  const manager = new ThreadManager(settings);
  const alpha = manager.createProject('Alpha', 'Projects/Alpha');
  const original = manager.createThread('Original thread', '/repo');
  const floatingPanelEl = document.createElement('div');
  const input = {
    value: '',
    setValue(v: string) { this.value = v; },
    getValue() { return this.value; },
    focus: vi.fn(),
    setContext: vi.fn(),
    clearAttachments: vi.fn(),
  };
  const plugin = { manager, settings, saveSettings: vi.fn(async () => undefined), getEffectiveCwd: () => '/repo' };
  const view = Object.assign(Object.create(ThreadsView.prototype), {
    plugin, manager,
    activeThreadId: opts.activeThreadId === undefined ? original.id : opts.activeThreadId,
    newConv: null,
    newConvProjectId: '',
    newConvInput: input,
    floatingPanelEl,
    messageContentController: new AbortController(),
    messageContentManager: { reset: vi.fn() },
    closeSwitcherPanel: vi.fn(), closeAgentPopover: vi.fn(), closeSchedulePopover: vi.fn(), closeTaskPopover: vi.fn(),
    rememberAgentScroll: vi.fn(), saveDraftToThread: vi.fn(),
    setRunningState: vi.fn(), renderTitleBar: vi.fn(), renderManagerNotesPanel: vi.fn(), renderGitDiffBar: vi.fn(),
    renderMessages: vi.fn(async () => undefined), refreshLeafHeader: vi.fn(),
    setActiveThread: vi.fn(async function (this: Internals, id: string) {
      this.leaveNewConversationUi();
      this.activeThreadId = id;
    }),
  }) as Internals;
  return { view, manager, alpha, original, input, floatingPanelEl, plugin };
}

describe('ThreadsView new-conversation mode', () => {
  it('enters the mode without creating a thread, and remembers where to return', async () => {
    const { view, manager, original, floatingPanelEl } = makeView();
    const before = manager.getThreads().length;

    await view.startNewConversation();

    expect(view.isNewConversation()).toBe(true);
    expect(view.activeThreadId).toBeNull();
    expect(view.newConv).toEqual({ returnTo: original.id });
    expect(manager.getThreads()).toHaveLength(before);
    expect(floatingPanelEl.classList.contains('ct-new-conversation')).toBe(true);
    expect(view.saveDraftToThread).toHaveBeenCalledWith(original.id);
    expect(view.renderMessages).toHaveBeenCalled();
    expect(view.getDisplayText()).toBe('New conversation');
  });

  it('preselects a Project, shows its name on the chip, and focuses the composer', async () => {
    const { view, alpha, input } = makeView();

    await view.startNewConversation({ projectId: alpha.id });

    expect(view.newConvProjectId).toBe(alpha.id);
    expect(input.setContext).toHaveBeenLastCalledWith('Alpha', expect.stringContaining('Alpha'));
    expect(input.focus).toHaveBeenCalled();
  });

  it('shows "No project" for an unknown Project id', async () => {
    const { view, input } = makeView();
    await view.startNewConversation({ projectId: 'does-not-exist' });
    expect(view.newConvProjectId).toBe('');
    expect(input.setContext).toHaveBeenLastCalledWith('No project', expect.any(String));
  });

  it('seeds an @[[note]] mention and appends to the draft already being composed (Chat about this document)', async () => {
    const { view, input } = makeView();
    await view.startNewConversation();
    input.setValue('compare against');

    await view.startNewConversation({ mention: 'Weekly Review' });

    expect(input.getValue()).toBe('compare against @[[Weekly Review]] ');
  });

  it('a fresh entry starts with a clean composer and no stale Project, even after an abandoned session', async () => {
    const { view, alpha, input } = makeView();
    await view.startNewConversation({ projectId: alpha.id });
    input.setValue('half typed');
    await view.setActiveThread(view.newConv.returnTo); // leave without sending

    await view.startNewConversation();

    expect(input.getValue()).toBe('');
    expect(input.clearAttachments).toHaveBeenCalled();
    expect(view.newConvProjectId).toBe('');
  });

  it('re-entering while already composing keeps the draft (a failed-directive restore stays put)', async () => {
    const { view, input } = makeView();
    await view.startNewConversation();
    input.setValue('/goal');
    await view.startNewConversation();
    expect(input.getValue()).toBe('/goal');
  });

  it('a seeded entry (Chat about this document) is clean apart from the seed', async () => {
    const { view, input } = makeView();
    input.setValue('stale text');
    await view.startNewConversation({ mention: 'Spec' });
    expect(input.getValue()).toBe('@[[Spec]] ');
  });

  it('seeds a draft', async () => {
    const { view, input } = makeView();
    await view.startNewConversation({ draft: 'Plan the release' });
    expect(input.getValue()).toBe('Plan the release');
  });

  it('is idempotent: re-entering re-seeds without resetting where to return', async () => {
    const { view, original, input } = makeView();
    await view.startNewConversation();
    view.renderMessages.mockClear();

    await view.startNewConversation({ mention: 'Spec' });

    expect(view.newConv).toEqual({ returnTo: original.id });
    expect(view.renderMessages).not.toHaveBeenCalled();
    expect(input.getValue()).toBe('@[[Spec]] ');
  });

  it('resets a Project that was deleted while composing', async () => {
    const { view, manager, alpha, input } = makeView();
    await view.startNewConversation({ projectId: alpha.id });

    manager.deleteProject(alpha.id);
    view.refreshNewConversationContext();

    expect(view.newConvProjectId).toBe('');
    expect(input.setContext).toHaveBeenLastCalledWith('No project', expect.any(String));
  });

  it('selecting any thread leaves the mode', async () => {
    const { view, original, floatingPanelEl } = makeView();
    await view.startNewConversation();

    await view.setActiveThread(original.id);

    expect(view.isNewConversation()).toBe(false);
    expect(floatingPanelEl.classList.contains('ct-new-conversation')).toBe(false);
    expect(view.getDisplayText()).toBe('Original thread');
  });

  it('Cancel returns to the thread we came from, or the first thread if it is gone', async () => {
    const { view, manager, original } = makeView();
    await view.startNewConversation();
    view.cancelNewConversation();
    expect(view.setActiveThread).toHaveBeenLastCalledWith(original.id);

    await view.startNewConversation();
    manager.deleteThread(original.id);
    const other = manager.createThread('Other', '/repo');
    view.cancelNewConversation();
    expect(view.setActiveThread).toHaveBeenLastCalledWith(other.id);
  });

  it('first send creates the thread through dispatchNewThread with the chosen Project, then switches to it', async () => {
    const { view, alpha, input, plugin } = makeView();
    const dispatchNewThread = vi.fn(async () => 'created-thread');
    Object.assign(plugin, {
      dispatchNewThread,
      app: { vault: { getMarkdownFiles: () => [] } },
    });
    view.app = plugin.app;
    await view.startNewConversation({ projectId: alpha.id });

    await view.sendNewConversation({ text: 'Fix the login bug', images: [], attachment: null, agentHarness: 'codex' });

    expect(dispatchNewThread).toHaveBeenCalledWith(
      'Fix the login bug', undefined, 'Fix the login bug',
      expect.objectContaining({ projectId: alpha.id, agentHarness: 'codex' }),
    );
    expect(view.setActiveThread).toHaveBeenCalledWith('created-thread');
    expect(view.isNewConversation()).toBe(false);
    // The Project pick is consumed so the next new conversation starts clean.
    expect(view.newConvProjectId).toBe('');
  });

  it('a /model directive is applied before the first send and its prompt becomes the message', async () => {
    const { view, plugin } = makeView();
    const dispatchNewThread = vi.fn(async () => 'created-thread');
    Object.assign(plugin, { dispatchNewThread, app: { vault: { getMarkdownFiles: () => [] } } });
    view.app = plugin.app;
    await view.startNewConversation();

    await view.sendNewConversation({ text: '/model opus fix the login bug', images: [], attachment: null });

    const [text, , title, opts] = dispatchNewThread.mock.calls[0] as unknown as [string, unknown, string, Record<string, unknown>];
    expect(text).toBe('fix the login bug');
    expect(title).toBe('fix the login bug');
    expect(opts.model).toBeTruthy();
  });

  it('does not switch away when the send did not create a thread (refused directive)', async () => {
    const { view, plugin, input } = makeView();
    const dispatchNewThread = vi.fn(async () => 'never');
    Object.assign(plugin, { dispatchNewThread, app: { vault: { getMarkdownFiles: () => [] } } });
    view.app = plugin.app;
    const restore = vi.fn();
    view.newConvInput = Object.assign(input, { restoreFailedDraft: restore });
    await view.startNewConversation();

    await view.sendNewConversation({ text: '/model', images: [], attachment: null });

    expect(dispatchNewThread).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalled();
    expect(view.setActiveThread).not.toHaveBeenCalled();
    expect(view.isNewConversation()).toBe(true);
  });

  it('renders an empty state with a Back button that names the previous thread', async () => {
    const { view } = makeView();
    await view.startNewConversation();
    view.messagesEl = document.createElement('div');

    view.renderNewConversationEmptyState();

    expect(view.messagesEl.querySelector('[data-testid="new-conversation"]')).not.toBeNull();
    const back = view.messagesEl.querySelector<HTMLButtonElement>('.ct-new-conv-cancel')!;
    expect(back.textContent).toBe('Back to Original thread');
  });

  it('openNewThread (title button, switcher footer, shortcuts) enters the mode instead of creating a thread', async () => {
    const { view, manager } = makeView();
    const before = manager.getThreads().length;

    await proto.openNewThread.call(view);

    expect(view.isNewConversation()).toBe(true);
    expect(manager.getThreads()).toHaveLength(before);
  });
});

describe('New thread buttons', () => {
  beforeEach(() => { document.body.empty(); });
  afterEach(() => { vi.restoreAllMocks(); });

  function plugin() {
    const settings = { ...DEFAULT_SETTINGS, kanbanCollapseSide: 'none' as const };
    const manager = new ThreadManager(settings);
    manager.createThread('A thread', '/repo');
    return {
      app: {
        vault: { getMarkdownFiles: () => [] },
        workspace: {
          leftSplit: { collapsed: true, collapse: vi.fn(), expand: vi.fn() },
          rightSplit: { collapsed: true, collapse: vi.fn(), expand: vi.fn() },
        },
      },
      settings, manager,
      getActiveThreadId: () => null,
      getPendingWakeups: () => [],
      hasPendingWakeup: () => false,
      saveSettings: vi.fn(async () => undefined),
      openNewConversation: vi.fn(async () => true),
      activateKanbanView: vi.fn(),
    };
  }

  it.each([
    ['Agents List', AgentDashboard, '.ct-agents-row'],
    ['Kanban board', KanbanView, '.ct-kanban-card'],
  ] as const)('%s drops the selected-thread highlight while composing and restores it after', async (_label, View, rowSel) => {
    const p = plugin();
    const id = p.manager.getThreads()[0].id;
    const view = new View({ updateHeader: vi.fn() } as never, p as never);
    (view as unknown as { app: unknown }).app = p.app;
    await view.onOpen();
    const active = () => view.containerEl.querySelectorAll(rowSel + '.ct-agents-row-active').length;

    p.manager.notifyActiveThreadChanged(id);
    expect(active()).toBe(1);
    p.manager.notifyActiveThreadCleared();
    expect(active()).toBe(0);
    p.manager.notifyActiveThreadChanged(id);
    expect(active()).toBe(1);
    await view.onClose();
  });

  it.each([
    ['Agents List', AgentDashboard, 'header'],
    ['Kanban board', KanbanView, 'panel'],
  ] as const)('%s has a labelled New thread control that opens new-conversation mode, and no dispatch composer', async (_label, View, where) => {
    const p = plugin();
    const view = new View({ updateHeader: vi.fn() } as never, p as never);
    (view as unknown as { app: unknown }).app = p.app;
    await view.onOpen();

    const button = view.containerEl.querySelector<HTMLElement>('[data-testid="new-thread-button"]')!;
    expect(button).not.toBeNull();
    expect(button.getAttribute('aria-label')).toBe('New thread');
    if (where === 'panel') expect(button.textContent).toContain('New thread');
    else expect(button.classList.contains('view-action')).toBe(true);

    button.click();
    expect(p.openNewConversation).toHaveBeenCalledOnce();

    expect(view.containerEl.querySelector('textarea')).toBeNull();
    expect(view.containerEl.querySelector('.ct-dispatch-root')).toBeNull();
    expect(view.containerEl.querySelector('.ct-dispatch-project')).toBeNull();
    expect(view.containerEl.querySelector('select')).toBeNull();
    expect(view.containerEl.textContent).not.toContain('Dispatch');
    expect(view.containerEl.querySelector('.ct-kanban-toggle')).toBeNull();
    await view.onClose();
  });

});

describe('stale slash-command pill', () => {
  it('a /goal pill left in the composer is gone on the next fresh entry', async () => {
    document.body.empty();
    const { view, plugin } = makeView();
    Object.assign(plugin, { slashCommands: new SlashCommandRegistry() });
    view.app = { vault: { getMarkdownFiles: () => [] } };
    view.manager.vaultRoot = '/vault';
    view.floatingPanelEl = document.body.createDiv();
    view.newConvInput = null;

    await view.startNewConversation();
    const composer = view.newConvInput as unknown as DispatchInput;
    composer.setValue('/goal ');
    expect(document.body.querySelector('.ct-command-pill')).not.toBeNull();

    await view.setActiveThread(view.newConv.returnTo);
    await view.startNewConversation();

    expect(document.body.querySelector('.ct-command-pill')).toBeNull();
    expect(composer.getValue()).toBe('');
  });
});

describe('new-conversation composer construction', () => {
  it('feeds the dispatch surface (not the thread surface) into slash completion and offers the harness picker', () => {
    document.body.empty();
    const { view, plugin } = makeView();
    const registry = new SlashCommandRegistry();
    registry.register({ pluginId: 'peer' }, { name: 'board', dispatch: { description: 'Board', invoke: async () => ({ status: 'ok' as const }) } });
    Object.assign(plugin, { slashCommands: registry, remoteFolders: undefined });
    Object.assign(plugin.settings, { agentHarness: 'codex' });
    view.app = { vault: { getMarkdownFiles: () => [] } };
    view.manager.vaultRoot = '/vault';
    const panel = document.body.createDiv();

    proto.buildNewConversationComposer.call(view, panel);

    expect(panel.querySelector('[data-testid="new-conversation-composer"]')).not.toBeNull();
    const built = view.newConvInput as unknown as { getBuiltinCommands(): { name: string }[]; options: { harnessPicker?: { initialHarness: string } } };
    const names = built.getBuiltinCommands().map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['model', 'goal', 'loop', 'board']));
    expect(names).not.toContain('compact');
    expect(built.options.harnessPicker?.initialHarness).toBe('codex');
    // The Project chip is part of the composer footer.
    expect(panel.querySelector('.ct-footer-context')).not.toBeNull();
  });
});

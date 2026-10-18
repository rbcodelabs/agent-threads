/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', () => ({
  default: {
    readdirSync: () => [], statSync: () => ({ isDirectory: () => false }),
    existsSync: () => false, readFileSync: () => '',
  },
  readdirSync: () => [], statSync: () => ({ isDirectory: () => false }),
  existsSync: () => false, readFileSync: () => '',
}));
vi.mock('../../src/stt', () => ({
  SttController: function SttController() {
    return {
      attachPttToTextarea: vi.fn(() => () => {}),
      createMicButton: vi.fn(() => document.createElement('button')),
      destroy: vi.fn(),
    };
  },
}));
vi.mock('../../src/ClaudeSession', () => ({
  formatToolName: (name: string) => name,
  getToolIcon: () => 'wrench',
}));
vi.mock('../../src/SettingsTab', () => ({ isWebViewerEnabled: () => false }));

import { DispatchInput } from '../../src/DispatchInput';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS, type ImageAttachment } from '../../src/types';
import { SlashCommandRegistry } from '../../src/SlashCommandContributions';
import { createDesignSlashCommand } from '../harness/design-plugin/designSlashCommand';
import { createClaudeThreadsApiV1 } from '../../src/PublicApi';
import { ThreadsView } from '../../src/ThreadsView';

function commandApi(slashCommands: SlashCommandRegistry) {
  return createClaudeThreadsApiV1({
    getThreads: () => [], getThread: () => undefined, isRunning: () => false,
    createThread: () => ({ id: 't' }), sendMessage: async () => {}, openThread: async () => {},
    subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null,
    triggerHostEvent: () => {}, slashCommands,
  } as never);
}

function makeFixture() {
  const settings = { ...DEFAULT_SETTINGS, kanbanCollapseSide: 'none' as const };
  const manager = new ThreadManager(settings);
  const app = {
    vault: { getMarkdownFiles: () => [] },
    workspace: {
      leftSplit: { collapsed: true, collapse: vi.fn(), expand: vi.fn() },
      rightSplit: { collapsed: true, collapse: vi.fn(), expand: vi.fn() },
    },
  };
  const plugin = {
    app,
    settings,
    manager,
    slashCommands: new SlashCommandRegistry(),
    getActiveThreadId: () => null,
    getPendingWakeups: () => [],
    hasPendingWakeup: () => false,
    saveSettings: vi.fn(async () => undefined),
    openThreadInChatView: vi.fn(async () => undefined),
    dispatchNewThread: vi.fn(async () => 'ordinary-thread'),
    dispatchNewDesignThread: vi.fn(async (_brief: string, _harness?: 'claude' | 'codex') => 'design-thread'),
  };
  const service = commandApi(plugin.slashCommands);
  service.api.extensions.registerSlashCommand({ pluginId: 'design' }, createDesignSlashCommand({
    getState: () => null, isDesktopFilesystem: () => true,
    prepare: async () => ({ artifact: { title: 'Design' }, instructions: 'Design' }),
    send: async () => {}, dispatch: (brief, harness) => plugin.dispatchNewDesignThread(brief, harness),
  }));
  return { app, manager, plugin, service };
}

describe('thread composer contributed command routing', () => {
  function fixture() {
    const registry = new SlashCommandRegistry();
    const service = commandApi(registry);
    const thread = { id: 'original', agentHarness: 'codex', projectId: 'project', draft: 'draft' };
    const view = Object.create(ThreadsView.prototype);
    Object.assign(view, {
      activeThreadId: thread.id, lastSentTexts: new Map(),
      plugin: { slashCommands: registry, settings: DEFAULT_SETTINGS },
      manager: { getThread: vi.fn(() => thread), isRunning: () => false, sendMessage: vi.fn() },
      exitAgentView: vi.fn(async () => {}), showCommandDivider: vi.fn(), setRunningState: vi.fn(),
      hideSummaryBanner: vi.fn(),
    });
    return { view, service, registry };
  }

  it('uses public registration with immutable captured context and does not send an agent prompt', async () => {
    const { view, service } = fixture();
    const invoke = vi.fn(async (context: unknown) => {
      expect(Object.isFrozen(context)).toBe(true);
      return { status: 'ok' as const, message: 'Board opened' };
    });
    service.api.extensions.registerSlashCommand({ pluginId: 'peer' }, { name: 'board', thread: { description: 'Board', invoke } });
    await view.handleSendFromDispatch('/BOARD first\nsecond', [{ base64: 'private', name: 'x', mediaType: 'image/png' }], 'private attachment');
    expect(invoke.mock.calls[0][0]).toEqual({ surface: 'thread', text: '/BOARD first\nsecond', args: 'first\nsecond', threadId: 'original', projectId: 'project', agentHarness: 'codex', hasImages: true, hasAttachment: true });
    expect(view.showCommandDivider).toHaveBeenCalledWith('Board opened', false);
    expect(view.manager.sendMessage).not.toHaveBeenCalled();
  });

  it('does not retarget command context or feedback when selection changes during an await', async () => {
    const { view, service } = fixture();
    view.exitAgentView = async () => { view.activeThreadId = 'other'; };
    const invoke = vi.fn(async (_context: unknown, host: { report(message: string): void }) => {
      host.report('Captured thread feedback');
      return { status: 'error' as const, message: 'Failure' };
    });
    service.api.extensions.registerSlashCommand({ pluginId: 'peer' }, { name: 'board', thread: { description: 'Board', invoke } });
    await view.handleSendFromDispatch('/board x', [], null);
    expect(invoke.mock.calls[0][0]).toMatchObject({ threadId: 'original' });
    expect(view.showCommandDivider).not.toHaveBeenCalled();
    expect(view.setRunningState).not.toHaveBeenCalled();
    expect(view.manager.sendMessage).not.toHaveBeenCalled();
  });

  it('never falls through when the peer unloads after the command matched', async () => {
    const { view, service } = fixture();
    const invoke = vi.fn(async () => ({ status: 'ok' as const }));
    service.api.extensions.registerSlashCommand({ pluginId: 'peer' }, { name: 'board', thread: { description: 'Board', invoke } });
    view.exitAgentView = async () => { service.stop(); };
    await view.handleSendFromDispatch('/board x', [], null);
    expect(invoke).not.toHaveBeenCalled();
    expect(view.manager.sendMessage).not.toHaveBeenCalled();
    expect(view.showCommandDivider).toHaveBeenCalledWith('Command is no longer available. Please try again.', true);
  });
});

/**
 * The dispatch composer now lives in ThreadsView's new-conversation mode (it used to be
 * duplicated in the Agents List and the Kanban board). These drive the real shipped
 * `sendNewConversation` through a real `DispatchInput`, with only DOM-bound repaint
 * helpers stubbed.
 */
describe('new-conversation composer design routing', () => {
  beforeEach(() => { document.body.empty(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const sendNewConversation = (ThreadsView.prototype as unknown as {
    sendNewConversation(this: unknown, payload: unknown): Promise<void>;
  }).sendNewConversation;

  function composer(projectId = '') {
    const { app, plugin, service } = makeFixture();
    const setActiveThread = vi.fn(async () => undefined);
    const view: Record<string, unknown> = Object.assign(Object.create(ThreadsView.prototype), {
      app, plugin,
      newConv: { returnTo: null },
      newConvProjectId: projectId,
      setActiveThread,
      refreshNewConversationContext: vi.fn(),
    });
    const input = new DispatchInput({
      app: app as never,
      harnessPicker: { initialHarness: 'claude' },
      onSend: (payload) => sendNewConversation.call(view, payload),
    });
    input.mount(document.body.createDiv());
    view.newConvInput = input;
    return { input, plugin, service, setActiveThread };
  }

  it('routes a live peer command with captured dispatch context and never falls through on failure', async () => {
    const { input, plugin, service } = composer();
    const invoke = vi.fn(async (_context: unknown) => ({ status: 'error' as const, message: 'Retry later' }));
    service.api.extensions.registerSlashCommand({ pluginId: 'peer' }, { name: 'board', dispatch: { description: 'Board', invoke } });
    input.setValue('/board first\nsecond');
    input.triggerSend();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ surface: 'dispatch', args: 'first\nsecond', agentHarness: 'claude', hasImages: false, hasAttachment: false });
    expect(plugin.dispatchNewThread).not.toHaveBeenCalled();
    expect(input.getValue()).toBe('/board first\nsecond');
  });

  it('passes the chosen Project to a peer command', async () => {
    const { input, service } = composer('proj-1');
    const invoke = vi.fn(async (_context: unknown) => ({ status: 'ok' as const }));
    service.api.extensions.registerSlashCommand({ pluginId: 'peer' }, { name: 'board', dispatch: { description: 'Board', invoke } });
    input.setValue('/board x');
    input.triggerSend();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ surface: 'dispatch', projectId: 'proj-1' });
  });

  it('uses the native design dispatcher and never the ordinary prompt dispatcher', async () => {
    const { input, plugin, setActiveThread } = composer();

    input.setValue('/design create a simple responsive settings card');
    input.triggerSend();

    await vi.waitFor(() => expect(plugin.dispatchNewDesignThread).toHaveBeenCalledWith(
      'create a simple responsive settings card', 'claude',
    ));
    expect(plugin.dispatchNewThread).not.toHaveBeenCalled();
    // The design flow surfaces its own thread; the composer must not also switch to one.
    expect(setActiveThread).not.toHaveBeenCalled();
  });

  it('preserves image and text attachments when design dispatch rejects them', async () => {
    const { input, plugin } = composer();
    const image: ImageAttachment = {
      base64: 'aGVsbG8=', mediaType: 'image/png', name: 'settings.png',
    };

    input.setValue('/design settings card');
    input.setPendingImages([image]);
    input.setPendingAttachment('Reference copy');
    input.triggerSend();

    await vi.waitFor(() => expect(input.getValue()).toBe('/design settings card'));
    expect(input.getPendingImages()).toEqual([image]);
    expect(input.getPendingAttachment()).toBe('Reference copy');
    expect(plugin.dispatchNewDesignThread).not.toHaveBeenCalled();
    expect(plugin.dispatchNewThread).not.toHaveBeenCalled();
  });

  it('restores a retryable design draft when design setup or navigation fails', async () => {
    const { input, plugin } = composer();
    plugin.dispatchNewDesignThread.mockRejectedValueOnce(new Error('preview unavailable'));

    input.setValue('/design settings card');
    input.triggerSend();

    await vi.waitFor(() => expect(input.getValue()).toBe('/design settings card'));
    expect(plugin.dispatchNewDesignThread).toHaveBeenCalledOnce();
    expect(plugin.dispatchNewThread).not.toHaveBeenCalled();
  });
});

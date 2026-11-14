/**
 * @vitest-environment jsdom
 *
 * Regression tests for sub-agent / background-task / workflow pills detaching
 * when the parent assistant emits intermediate `message` events while child
 * tasks are still running, and for `streamingBuffers` losing active sub-agent
 * labels across prose-only `message` events on background/switched threads.
 */
import '../setup/obsidian-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', async (importOriginal) => {
  const actual = await importOriginal<typeof import('obsidian')>();
  return {
    ...actual,
    setIcon: (el: HTMLElement, icon: string) => { el.setAttribute('data-icon', icon); },
    setTooltip: (el: HTMLElement, tip: string) => { el.setAttribute('data-tooltip', tip); },
  };
});

vi.mock('../../src/ClaudeSession', () => ({
  formatToolName: (name: string) => name,
  getToolIcon: () => 'wrench',
}));
vi.mock('../../src/DispatchInput', () => ({ DispatchInput: class {} }));
vi.mock('../../src/SettingsTab', () => ({ isWebViewerEnabled: () => false }));

import Module from 'module';
import * as conversationFirstPlacement from '../../src/conversationFirstPlacement';
import { ThreadsView } from '../../src/ThreadsView';
import { MessageContentProviderRegistry } from '../../src/MessageContent';
import { RemoteImageCache } from '../../src/remote/remoteImages';
import type { ThreadEvent } from '../../src/ThreadManager';
import type { ChatMessage, Thread } from '../../src/types';

// Allow ThreadsView.onOpen / setActiveThread's CJS require('./conversationFirstPlacement')
// to resolve to the TypeScript module under Vitest.
const origLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
(Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown })._load = function (
  request: string,
  ...rest: unknown[]
) {
  if (request === './conversationFirstPlacement') return conversationFirstPlacement;
  return origLoad.call(this, request, ...rest);
};

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

function makeThread(id: string, messages: ChatMessage[] = []): Thread {
  return {
    id,
    title: `Thread ${id}`,
    cwd: '/repo',
    createdAt: 1,
    updatedAt: 1,
    messages: [...messages],
    reviewed: true,
  } as Thread;
}

interface Harness {
  view: ThreadsView & Record<string, any>;
  messagesEl: HTMLElement;
  threads: Map<string, Thread>;
  running: Set<string>;
  emit: (threadId: string, event: ThreadEvent) => void;
  cleanup: () => void;
}

async function createHarness(initialThreads: Thread[] = [makeThread('thread-1')]): Promise<Harness> {
  const threads = new Map<string, Thread>(initialThreads.map((t) => [t.id, t]));
  const running = new Set<string>();
  const subscribers: Array<(threadId: string, event: ThreadEvent) => void> = [];

  const manager = {
    subscribe: (cb: (threadId: string, event: ThreadEvent) => void) => {
      subscribers.push(cb);
      return () => {
        const idx = subscribers.indexOf(cb);
        if (idx >= 0) subscribers.splice(idx, 1);
      };
    },
    getThread: (id: string) => threads.get(id),
    getThreads: () => [...threads.values()],
    isRunning: (id: string) => running.has(id),
    isRunStale: () => false,
    getRemoteScope: () => undefined,
    registerPermissionResolver: () => {},
    registerQuestionResolver: () => {},
    notifyActiveThreadChanged: () => {},
    notifyActiveThreadCleared: () => {},
    getSelectedAgentRun: () => undefined,
    getAgentRuns: () => [],
    getPendingToolResultImages: () => [],
  };

  const plugin = {
    manager,
    settings: {
      activeThreadId: initialThreads[0]?.id,
      enableInlineVisualizations: false,
      toolCallStyle: 'pills',
      summarizationEnabled: false,
      autoSummarize: false,
      saveThreadsToVault: false,
    },
    saveSettings: vi.fn(async () => {}),
    getEffectiveCwd: () => '/repo',
    isConversationFirst: () => false,
    messageContentProviders: new MessageContentProviderRegistry(),
    daemonRegistry: { clientFor: () => undefined },
    inProcessSummarizer: {
      hasClaimedGoalBackfill: () => false,
      claimGoalBackfill: () => {},
      summarizeMessage: async () => '',
    },
  };

  const leaf = { updateHeader: () => {} };
  const view = new ThreadsView(leaf as never, plugin as never) as ThreadsView & Record<string, any>;

  const containerEl = document.createElement('div');
  document.body.appendChild(containerEl);
  view.containerEl = containerEl;
  view.app = {
    vault: {
      adapter: { basePath: '/vault' },
      getAbstractFileByPath: () => null,
    },
    workspace: {
      on: () => ({}),
      requestSaveLayout: () => {},
      openLinkText: () => {},
    },
    plugins: { plugins: {} },
  };
  view.remoteImageCache = new RemoteImageCache();

  let messagesEl!: HTMLElement;
  view.buildUI = () => {
    view.rootEl = containerEl.createDiv('ct-root');
    view.titleEl = view.rootEl.createEl('button', { cls: 'ct-title-btn' });
    view.mainEl = view.rootEl.createDiv('ct-main');
    messagesEl = view.mainEl.createDiv('ct-messages');
    view.messagesEl = messagesEl;
  };
  view.createNativeHeaderActions = () => {};
  view.syncHeaderMode = () => {};
  view.registerDomEvent = () => {};
  view.registerEvent = () => {};
  view.renderProjectBar = () => {};
  view.renderTitleBar = () => {};
  view.renderThreadInfo = () => {};
  view.renderStatusFooter = () => {};
  view.renderGitDiffBar = () => {};
  view.renderComposerContext = () => {};
  view.setRunningState = () => {};
  view.scheduleBrowserRefresh = () => {};
  view.renderAgentPill = () => {};
  view.updateScrollBottomPillVisibility = () => {};
  view.scheduleStickyUserUpdate = () => {};
  view.attachUserMessageMenu = () => {};
  view.formatShortTime = (t: number) => `t${t}`;
  view.scrollToBottom = () => {};
  view.restorePendingPlanCard = () => {};
  view.restorePendingQuestionCard = () => {};
  view.renderProposedReplyCard = () => {};
  view.syncEditedFiles = () => {};
  view.restoreDraftFromThread = () => {};
  view.saveDraftToThread = () => {};
  view.maybeShowSummaryBanner = () => {};
  view.applyComposerPlaceholder = () => {};

  await view.onOpen();
  await flush();

  const emit = (threadId: string, event: ThreadEvent) => {
    if (event.type === 'message') {
      threads.get(threadId)?.messages.push(event.message);
    }
    for (const sub of [...subscribers]) {
      sub(threadId, event);
    }
  };

  const cleanup = () => {
    if (view.staleInterval) clearInterval(view.staleInterval);
    view.unsubscribe?.();
    containerEl.remove();
  };

  return { view, messagesEl, threads, running, emit, cleanup };
}

describe('ThreadsView active sub-agent / workflow task pills across parent message events', () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    harness?.cleanup();
    harness = null;
  });

  it('keeps .ct-task-pill connected after tool-only Agent message AND prose-only message, updates on task_progress, marks done on task_notification, and clears on done', async () => {
    const userMsg: ChatMessage = { id: 'u1', role: 'user', content: 'Investigate auth bug', timestamp: 1 };
    harness = await createHarness([makeThread('thread-1', [userMsg])]);
    const { view, messagesEl, running, emit } = harness;
    running.add('thread-1');

    emit('thread-1', { type: 'streaming_start' });
    emit('thread-1', {
      type: 'task_started',
      taskId: 'sub-1',
      description: 'Research auth module',
      skipTranscript: false,
    });

    const initialPill = messagesEl.querySelector<HTMLElement>('.ct-task-pill');
    expect(initialPill).not.toBeNull();
    expect(initialPill!.isConnected).toBe(true);
    expect(initialPill!.querySelector('.ct-tool-pill-text')?.textContent).toBe('Research auth module');

    // Step 1: Parent commits a tool-only Agent message while sub-1 is still running.
    emit('thread-1', {
      type: 'message',
      message: {
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: 2,
        toolCalls: [{
          toolUseId: 'tu-agent-1',
          name: 'Agent',
          summary: 'Agent: Research auth module',
          status: 'pending',
          timestamp: 2,
        }],
      },
    });
    await flush();

    expect(initialPill!.isConnected).toBe(true);
    expect(messagesEl.contains(initialPill!)).toBe(true);

    // Step 2: Parent commits a prose-only message (toolCalls: undefined) while sub-1 is STILL running.
    emit('thread-1', {
      type: 'message',
      message: {
        id: 'a2',
        role: 'assistant',
        content: 'I launched the researcher sub-agent and am waiting for its report.',
        timestamp: 3,
      },
    });
    await flush();

    // Pill must still be connected inside .ct-messages AFTER the committed assistant prose message!
    const pillAfterProse = messagesEl.querySelector<HTMLElement>('.ct-task-pill');
    expect(pillAfterProse).toBe(initialPill);
    expect(initialPill!.isConnected).toBe(true);
    const streamingEl = messagesEl.querySelector<HTMLElement>('.ct-streaming');
    expect(streamingEl).not.toBeNull();
    expect(messagesEl.lastElementChild).toBe(streamingEl);
    expect(streamingEl!.contains(initialPill!)).toBe(true);
    // Pill sits above .ct-message-content inside .ct-streaming, matching task_started layout.
    const contentEl = streamingEl!.querySelector('.ct-message-content');
    expect(contentEl).not.toBeNull();
    expect(initialPill!.compareDocumentPosition(contentEl!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Step 3: task_progress updates the visible, connected pill.
    emit('thread-1', {
      type: 'task_progress',
      taskId: 'sub-1',
      description: 'Inspecting session middleware',
      lastToolName: 'Read',
    });
    expect(initialPill!.isConnected).toBe(true);
    expect(initialPill!.querySelector('.ct-tool-pill-text')?.textContent).toContain('Inspecting session middleware · Read');

    // Step 4: task_notification transitions the pill to .ct-task-done before turn ends.
    emit('thread-1', {
      type: 'task_notification',
      taskId: 'sub-1',
      status: 'completed',
      summary: 'Found stale token check in auth.ts',
    });
    expect(initialPill!.isConnected).toBe(true);
    expect(initialPill!.classList.contains('ct-task-done')).toBe(true);
    expect(initialPill!.classList.contains('ct-tool-active')).toBe(false);
    expect(initialPill!.querySelector('.ct-tool-pill-text')?.textContent).toBe('Found stale token check in auth.ts');

    // Step 5: done clears the streaming container and taskPills map.
    running.delete('thread-1');
    emit('thread-1', { type: 'done', result: 'Fixed.' });
    expect(messagesEl.querySelector('.ct-streaming')).toBeNull();
    expect(messagesEl.querySelector('.ct-task-pill')).toBeNull();
    expect(view.taskPills.size).toBe(0);
  });

  it('self-heals streamingEl and re-mounts a detached task pill on task_progress / task_updated after transient reconnecting', async () => {
    harness = await createHarness([makeThread('thread-1', [{ id: 'u1', role: 'user', content: 'Run check', timestamp: 1 }])]);
    const { messagesEl, running, emit } = harness;
    running.add('thread-1');

    emit('thread-1', { type: 'streaming_start' });
    emit('thread-1', {
      type: 'task_started',
      taskId: 'bg-1',
      description: 'Full test suite',
      skipTranscript: true,
    });

    const bgPill = messagesEl.querySelector<HTMLElement>('.ct-task-pill');
    expect(bgPill).not.toBeNull();

    // Transient reconnecting removes streamingEl while intentionally preserving taskPills.
    emit('thread-1', { type: 'reconnecting' });
    expect(bgPill!.isConnected).toBe(false);

    // Next task_progress self-heals streamingEl and reattaches bgPill below the notice.
    emit('thread-1', {
      type: 'task_progress',
      taskId: 'bg-1',
      description: 'Running unit tests',
    });
    expect(bgPill!.isConnected).toBe(true);
    expect(messagesEl.contains(bgPill!)).toBe(true);
    expect(bgPill!.querySelector('.ct-tool-pill-text')?.textContent).toContain('Running unit tests');

    // Simulate another transient drop followed by task_updated.
    emit('thread-1', { type: 'reconnecting' });
    expect(bgPill!.isConnected).toBe(false);

    emit('thread-1', {
      type: 'task_updated',
      taskId: 'bg-1',
      description: 'Running integration tests',
    });
    expect(bgPill!.isConnected).toBe(true);
    expect(bgPill!.querySelector('.ct-tool-pill-text')?.textContent).toBe('Running integration tests');
  });

  it('keeps workflow block and child rows mounted without duplicating child rows across intermediate message events', async () => {
    harness = await createHarness([makeThread('thread-1', [{ id: 'u1', role: 'user', content: 'Review PR', timestamp: 1 }])]);
    const { view, messagesEl, running, emit } = harness;
    running.add('thread-1');

    emit('thread-1', { type: 'streaming_start' });
    emit('thread-1', {
      type: 'task_started',
      taskId: 'wf-1',
      description: 'Review workflow',
      workflowName: 'review-changes',
      taskType: 'local_workflow',
      skipTranscript: true,
    });
    emit('thread-1', {
      type: 'task_started',
      taskId: 'wf-agent-1',
      description: 'Check types',
      skipTranscript: false,
    });
    emit('thread-1', {
      type: 'task_started',
      taskId: 'wf-agent-2',
      description: 'Audit security',
      skipTranscript: false,
    });

    // Complete first child before the intermediate message arrives.
    emit('thread-1', {
      type: 'task_notification',
      taskId: 'wf-agent-1',
      status: 'completed',
      summary: 'No type errors',
    });

    // Intermediate parent message arrives while workflow + wf-agent-2 are still running.
    emit('thread-1', {
      type: 'message',
      message: {
        id: 'a1',
        role: 'assistant',
        content: 'Workflow started; waiting on security audit.',
        timestamp: 2,
      },
    });
    await flush();

    const block = messagesEl.querySelector<HTMLElement>('.ct-workflow-block');
    expect(block).not.toBeNull();
    expect(block!.isConnected).toBe(true);

    const streamingEl = messagesEl.querySelector<HTMLElement>('.ct-streaming');
    expect(streamingEl).not.toBeNull();
    expect(messagesEl.lastElementChild).toBe(streamingEl);
    expect(streamingEl!.contains(block!)).toBe(true);

    // Child rows must stay exclusively inside .ct-workflow-agents (no top-level duplicates).
    const allRows = messagesEl.querySelectorAll('.ct-workflow-agent-row');
    const nestedRows = block!.querySelectorAll('.ct-workflow-agent-row');
    expect(allRows.length).toBe(2);
    expect(nestedRows.length).toBe(2);

    // Progress updates on workflow phase and running child row still reflect in the live DOM.
    emit('thread-1', {
      type: 'task_progress',
      taskId: 'wf-1',
      description: 'Security pass',
    });
    emit('thread-1', {
      type: 'task_progress',
      taskId: 'wf-agent-2',
      description: 'Scanning auth handlers',
      lastToolName: 'Grep',
    });

    expect(block!.querySelector('.ct-workflow-phase')?.textContent).toBe(' · Security pass');
    expect(nestedRows[0].classList.contains('ct-workflow-agent-done')).toBe(true);
    expect(nestedRows[0].querySelector('.ct-workflow-agent-desc')?.textContent).toBe('No type errors');
    expect(nestedRows[1].classList.contains('ct-workflow-agent-running')).toBe(true);
    expect(nestedRows[1].querySelector('.ct-workflow-agent-desc')?.textContent).toContain('Scanning auth handlers · Grep');

    // Finish child + workflow, then done.
    emit('thread-1', {
      type: 'task_notification',
      taskId: 'wf-agent-2',
      status: 'completed',
      summary: 'No vulnerabilities found',
    });
    emit('thread-1', {
      type: 'task_notification',
      taskId: 'wf-1',
      status: 'completed',
      summary: 'Workflow finished',
    });
    expect(block!.classList.contains('ct-workflow-done')).toBe(true);

    running.delete('thread-1');
    emit('thread-1', { type: 'done', result: 'All done.' });
    expect(messagesEl.querySelector('.ct-workflow-block')).toBeNull();
    expect(view.taskPills.size).toBe(0);
  });

  it('preserves active Sub-agent / Workflow labels in streamingBuffers across prose-only messages, restores on thread switch, and clears on done/error/interrupted', async () => {
    const t1 = makeThread('thread-1', [{ id: 'u1', role: 'user', content: 'Audit deps', timestamp: 1 }]);
    const t2 = makeThread('thread-2', [{ id: 'u2', role: 'user', content: 'Other task', timestamp: 1 }]);
    harness = await createHarness([t1, t2]);
    const { view, messagesEl, running, emit } = harness;
    running.add('thread-1');

    emit('thread-1', { type: 'streaming_start' });
    emit('thread-1', {
      type: 'task_started',
      taskId: 'sub-a',
      description: 'Dependency auditor',
      skipTranscript: false,
    });
    // Stream tokens (which temporarily clears subagentLabel while streaming text)
    // and then commit a prose-only message with no toolCalls while sub-a is still active.
    emit('thread-1', { type: 'token', text: 'Starting audit now…' });
    emit('thread-1', {
      type: 'message',
      message: {
        id: 'a1',
        role: 'assistant',
        content: 'Starting audit now…',
        timestamp: 2,
      },
    });
    await flush();

    // streamingBuffers must keep thread-1 alive with the active sub-agent label!
    const bufAfterProse = view.streamingBuffers.get('thread-1');
    expect(bufAfterProse).toBeDefined();
    expect(bufAfterProse.subagentLabel).toBe('Sub-agent: Dependency auditor');

    // Switch to thread-2 and emit a message there: thread-1's pill must NOT leak into thread-2!
    await view.setActiveThread('thread-2');
    await flush();
    running.add('thread-2');
    emit('thread-2', {
      type: 'message',
      message: { id: 'b1', role: 'assistant', content: 'Hello on thread 2', timestamp: 3 },
    });
    await flush();
    expect(messagesEl.querySelector('.ct-task-pill')).toBeNull();
    expect(messagesEl.querySelector('.ct-streaming')).toBeNull();
    running.delete('thread-2');
    emit('thread-2', { type: 'done', result: 'Done 2' });

    // Switch back to thread-1 while sub-a is still active: spinner restores 'Sub-agent: Dependency auditor'.
    await view.setActiveThread('thread-1');
    await flush();
    const spinner = messagesEl.querySelector<HTMLElement>('.ct-streaming .ct-thinking-spinner');
    expect(spinner).not.toBeNull();
    expect(spinner!.getAttribute('aria-label')).toBe('Sub-agent: Dependency auditor');

    // Workflow label takes priority over individual sub-agent labels and recomputes on task_notification.
    emit('thread-1', {
      type: 'task_started',
      taskId: 'wf-a',
      description: 'Release checks',
      workflowName: 'release-check',
      taskType: 'local_workflow',
      skipTranscript: true,
    });
    expect(view.streamingBuffers.get('thread-1')?.subagentLabel).toBe('Workflow: release-check');

    // When workflow finishes while sub-a is still running, label falls back to sub-a.
    emit('thread-1', {
      type: 'task_notification',
      taskId: 'wf-a',
      status: 'completed',
      summary: 'Checks complete',
    });
    expect(view.streamingBuffers.get('thread-1')?.subagentLabel).toBe('Sub-agent: Dependency auditor');

    // When sub-a also finishes, subagentLabel clears to undefined.
    emit('thread-1', {
      type: 'task_notification',
      taskId: 'sub-a',
      status: 'completed',
      summary: 'Audit complete',
    });
    expect(view.streamingBuffers.get('thread-1')?.subagentLabel).toBeUndefined();

    // Terminal `done` deletes the buffer.
    running.delete('thread-1');
    emit('thread-1', { type: 'done', result: 'Finished.' });
    expect(view.streamingBuffers.has('thread-1')).toBe(false);

    // Terminal `error` also deletes the buffer even when an active task was registered.
    running.add('thread-1');
    emit('thread-1', {
      type: 'task_started',
      taskId: 'sub-err',
      description: 'Will fail turn',
      skipTranscript: true,
    });
    expect(view.streamingBuffers.get('thread-1')?.subagentLabel).toBe('Background: Will fail turn');
    running.delete('thread-1');
    emit('thread-1', { type: 'error', error: new Error('Network failure') });
    expect(view.streamingBuffers.has('thread-1')).toBe(false);

    // Terminal `interrupted` also deletes the buffer.
    running.add('thread-1');
    emit('thread-1', {
      type: 'task_started',
      taskId: 'sub-int',
      description: 'Will interrupt turn',
      skipTranscript: false,
    });
    expect(view.streamingBuffers.get('thread-1')?.subagentLabel).toBe('Sub-agent: Will interrupt turn');
    running.delete('thread-1');
    emit('thread-1', { type: 'interrupted' });
    expect(view.streamingBuffers.has('thread-1')).toBe(false);
  });
});

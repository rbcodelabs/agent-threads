/**
 * MobileView.test.ts
 * @vitest-environment jsdom
 *
 * DOM-level tests for MobileView. Tests the core UI logic without a real Obsidian
 * runtime:
 *
 *   - Panel switching (showPanel): the exact mechanism that was broken and caused
 *     "tap thread → nothing happens"
 *   - Thread list renders titles + previews
 *   - Thread tap immediately switches panel (doesn't wait for store notify)
 *   - scrollToBottom uses requestAnimationFrame (not synchronous)
 *   - Send button dispatches correct command
 *   - Pairing screen shown when relayClient/store are null
 *   - Disconnected banner appears/disappears on connection state changes
 *   - create_thread command includes required title field
 */

import '../setup/obsidian-dom'; // Polyfill Obsidian's HTMLElement extensions for jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MobileView, MOBILE_VIEW_TYPE } from '../../src/MobileView';
import { MobileThreadStore } from '../../src/MobileThreadStore';
import type { SerializedThread, SerializedMessage } from '../../src/relay-protocol';

// Obsidian is aliased to test/__mocks__/obsidian.ts in vitest.config.ts.
// marked is mocked below so markdown parsing resolves synchronously in tests.
vi.mock('marked', () => ({
  marked: {
    parse: (content: string) => Promise.resolve(`<p>${content}</p>`),
  },
}));

// ── RelayClient mock ───────────────────────────────────────────────────────

type MockCommand = { type: string; [key: string]: unknown };

function makeRelayClient() {
  const sentCommands: MockCommand[] = [];
  const connectionListeners: Array<(state: string) => void> = [];

  return {
    sentCommands,
    connectionListeners,
    sendCommand: vi.fn((cmd: MockCommand) => { sentCommands.push(cmd); }),
    onConnectionStateChange: vi.fn((listener: (state: string) => void) => {
      connectionListeners.push(listener);
      return () => {};
    }),
    triggerConnectionState(state: string) {
      connectionListeners.forEach((l) => l(state));
    },
  };
}

// ── Thread factory ─────────────────────────────────────────────────────────

function makeThread(overrides: Partial<SerializedThread> = {}): SerializedThread {
  return {
    id: 'thread-1',
    title: 'My Thread',
    cwd: '/cwd',
    messages: [],
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<SerializedMessage> = {}): SerializedMessage {
  return {
    id: 'msg-1',
    role: 'user',
    content: 'Hello there',
    timestamp: 1000,
    ...overrides,
  };
}

// ── MobileView harness ─────────────────────────────────────────────────────

interface ViewHarness {
  view: MobileView;
  store: MobileThreadStore;
  relay: ReturnType<typeof makeRelayClient>;
}

async function buildView(opts?: { noRelay?: boolean }): Promise<ViewHarness> {
  const store = new MobileThreadStore();
  const relay = makeRelayClient();

  const mockLeaf = {} as never;
  const view = new MobileView(
    mockLeaf,
    opts?.noRelay ? null : (relay as never),
    opts?.noRelay ? null : store,
  );

  await view.onOpen();
  return { view, store, relay };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('MobileView — getViewType', () => {
  it('returns the correct view type', async () => {
    const { view } = await buildView();
    expect(view.getViewType()).toBe(MOBILE_VIEW_TYPE);
    await view.onClose();
  });

  it('returns correct display text', async () => {
    const { view } = await buildView();
    expect(view.getDisplayText()).toBe('Agent Threads (Mobile)');
    await view.onClose();
  });
});

describe('MobileView — panel switching', () => {
  it('starts on list panel (no threads)', async () => {
    const { view, store } = await buildView();
    store.applyFrame({ type: 'snapshot', threads: [], activeThreadId: null });

    const root = (view as never)['rootEl'] as HTMLElement;
    const listPanel = (view as never)['listPanelEl'] as HTMLElement;
    const convPanel = (view as never)['convPanelEl'] as HTMLElement;

    expect(listPanel.style.display).not.toBe('none');
    expect(convPanel.style.display).toBe('none');

    await view.onClose();
  });

  it('switches to conversation panel when showPanel("conversation") is called', async () => {
    const { view } = await buildView();

    const showPanel = (view as never)['showPanel'].bind(view) as (p: string) => void;
    const listPanel = (view as never)['listPanelEl'] as HTMLElement;
    const convPanel = (view as never)['convPanelEl'] as HTMLElement;

    showPanel('conversation');

    expect(listPanel.style.display).toBe('none');
    expect(convPanel.style.display).toBe('flex');

    await view.onClose();
  });

  it('switches back to list panel when showPanel("list") is called', async () => {
    const { view } = await buildView();

    const showPanel = (view as never)['showPanel'].bind(view) as (p: string) => void;
    const listPanel = (view as never)['listPanelEl'] as HTMLElement;
    const convPanel = (view as never)['convPanelEl'] as HTMLElement;

    showPanel('conversation');
    showPanel('list');

    expect(convPanel.style.display).toBe('none');
    expect(listPanel.style.display).toBe('flex');

    await view.onClose();
  });

  it('switches to conversation panel when active thread is set', async () => {
    const { view, store } = await buildView();
    const thread = makeThread({ id: 'tid', title: 'Test' });

    store.applyFrame({ type: 'snapshot', threads: [thread], activeThreadId: 'tid' });

    const convPanel = (view as never)['convPanelEl'] as HTMLElement;
    // After snapshot with an active thread, view should auto-switch to conversation
    expect(convPanel.style.display).toBe('flex');

    await view.onClose();
  });
});

describe('MobileView — thread list rendering', () => {
  it('renders each thread as a list item', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [
        makeThread({ id: 'a', title: 'Alpha' }),
        makeThread({ id: 'b', title: 'Beta', createdAt: 2000 }),
      ],
      activeThreadId: null,
    });

    const threadList = (view as never)['threadListEl'] as HTMLElement;
    const items = threadList.querySelectorAll('.ct-mobile-thread-item');
    expect(items).toHaveLength(2);

    await view.onClose();
  });

  it('shows thread title in each list item', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'a', title: 'Alpha thread' })],
      activeThreadId: null,
    });

    const threadList = (view as never)['threadListEl'] as HTMLElement;
    expect(threadList.textContent).toContain('Alpha thread');

    await view.onClose();
  });

  it('shows message preview for thread with messages', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [
        makeThread({
          id: 'a',
          title: 'With messages',
          messages: [makeMessage({ content: 'Preview text here' })],
        }),
      ],
      activeThreadId: null,
    });

    const threadList = (view as never)['threadListEl'] as HTMLElement;
    expect(threadList.textContent).toContain('Preview text here');

    await view.onClose();
  });

  it('shows empty state when no threads', async () => {
    const { view, store } = await buildView();
    store.applyFrame({ type: 'snapshot', threads: [], activeThreadId: null });

    const threadList = (view as never)['threadListEl'] as HTMLElement;
    expect(threadList.querySelector('.ct-mobile-no-threads')).not.toBeNull();

    await view.onClose();
  });
});

describe('MobileView — thread tap panel switch', () => {
  it('switching panel immediately (before store notify) when thread is tapped', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', title: 'Tap me' })],
      activeThreadId: null,
    });

    const threadList = (view as never)['threadListEl'] as HTMLElement;
    const item = threadList.querySelector('.ct-mobile-thread-item') as HTMLElement;
    expect(item).not.toBeNull();

    const convPanel = (view as never)['convPanelEl'] as HTMLElement;
    expect(convPanel.style.display).toBe('none'); // starts hidden

    item.click();

    // Panel switch should happen IMMEDIATELY, not waiting for store notify
    expect(convPanel.style.display).toBe('flex');

    await view.onClose();
  });

  it('updates conversation title when thread is tapped', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', title: 'My Special Thread' })],
      activeThreadId: null,
    });

    const threadList = (view as never)['threadListEl'] as HTMLElement;
    const item = threadList.querySelector('.ct-mobile-thread-item') as HTMLElement;
    item.click();

    const convTitle = (view as never)['convTitleEl'] as HTMLSpanElement;
    expect(convTitle.textContent).toBe('My Special Thread');

    await view.onClose();
  });

  it('sends set_active_thread command when thread is tapped', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', title: 'T' })],
      activeThreadId: null,
    });

    const threadList = (view as never)['threadListEl'] as HTMLElement;
    (threadList.querySelector('.ct-mobile-thread-item') as HTMLElement).click();

    expect(relay.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'set_active_thread', threadId: 'tid' }),
    );

    await view.onClose();
  });
});

describe('MobileView — back button', () => {
  it('pressing back returns to list panel', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', title: 'T' })],
      activeThreadId: 'tid',
    });

    // Auto-switched to conversation because active thread is set
    const convPanel = (view as never)['convPanelEl'] as HTMLElement;
    expect(convPanel.style.display).toBe('flex');

    const backBtn = convPanel.querySelector('.ct-mobile-back-btn') as HTMLElement;
    backBtn.click();

    const listPanel = (view as never)['listPanelEl'] as HTMLElement;
    expect(listPanel.style.display).toBe('flex');
    expect(convPanel.style.display).toBe('none');

    await view.onClose();
  });
});

describe('MobileView — send message', () => {
  it('labels the composer for the active thread harness', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [
        makeThread({ id: 'claude-thread', agentHarness: 'claude' }),
        makeThread({ id: 'codex-thread', agentHarness: 'codex' }),
      ],
      activeThreadId: 'codex-thread',
    });

    const inputEl = (view as never)['inputEl'] as HTMLTextAreaElement;
    expect(inputEl.placeholder).toBe('Message Codex');

    store.setActiveThreadId('claude-thread');
    expect(inputEl.placeholder).toBe('Message Claude');

    await view.onClose();
  });

  it('send button dispatches send_message command with correct threadId', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'active-tid', title: 'Chat' })],
      activeThreadId: 'active-tid',
    });

    const inputEl = (view as never)['inputEl'] as HTMLTextAreaElement;
    const sendBtn = (view as never)['sendBtn'] as HTMLButtonElement;

    inputEl.value = 'Hello from mobile';
    sendBtn.click();

    expect(relay.sendCommand).toHaveBeenCalledWith({
      type: 'send_message',
      threadId: 'active-tid',
      text: 'Hello from mobile',
    });

    await view.onClose();
  });

  it('clears input after send', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', title: 'T' })],
      activeThreadId: 'tid',
    });

    const inputEl = (view as never)['inputEl'] as HTMLTextAreaElement;
    const sendBtn = (view as never)['sendBtn'] as HTMLButtonElement;

    inputEl.value = 'Some message';
    sendBtn.click();

    expect(inputEl.value).toBe('');

    await view.onClose();
  });

  it('does not send empty message', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', title: 'T' })],
      activeThreadId: 'tid',
    });

    const inputEl = (view as never)['inputEl'] as HTMLTextAreaElement;
    const sendBtn = (view as never)['sendBtn'] as HTMLButtonElement;

    inputEl.value = '   '; // whitespace only
    sendBtn.click();

    expect(relay.sendCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'send_message' }),
    );

    await view.onClose();
  });

  it('Enter key sends message', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', title: 'T' })],
      activeThreadId: 'tid',
    });

    const inputEl = (view as never)['inputEl'] as HTMLTextAreaElement;
    inputEl.value = 'Enter send test';
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false, bubbles: true }));

    expect(relay.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'send_message', text: 'Enter send test' }),
    );

    await view.onClose();
  });

  it('Shift+Enter does not send message', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', title: 'T' })],
      activeThreadId: 'tid',
    });

    const inputEl = (view as never)['inputEl'] as HTMLTextAreaElement;
    inputEl.value = 'Multi-line';
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));

    expect(relay.sendCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'send_message' }),
    );

    await view.onClose();
  });
});

describe('MobileView — new thread button', () => {
  it('new thread button sends create_thread command with title', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({ type: 'snapshot', threads: [], activeThreadId: null });

    const listPanel = (view as never)['listPanelEl'] as HTMLElement;
    const newBtn = listPanel.querySelector('.ct-mobile-new-btn') as HTMLButtonElement;
    newBtn.click();

    // MUST include title — the relay protocol requires it
    expect(relay.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'create_thread', title: expect.any(String) }),
    );

    await view.onClose();
  });
});

describe('MobileView — pairing screen', () => {
  it('shows pairing screen when relayClient is null', async () => {
    const { view } = await buildView({ noRelay: true });

    const root = (view as never)['containerEl'] as HTMLElement;
    expect(root.textContent).toContain('Not connected');

    await view.onClose();
  });
});

describe('MobileView — disconnected banner', () => {
  it('shows disconnected banner when connection state is not connected', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({ type: 'snapshot', threads: [], activeThreadId: null });

    relay.triggerConnectionState('reconnecting');

    const rootEl = (view as never)['rootEl'] as HTMLElement;
    expect(rootEl.querySelector('.ct-mobile-disconnected-banner')).not.toBeNull();

    await view.onClose();
  });

  it('removes disconnected banner when connected', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({ type: 'snapshot', threads: [], activeThreadId: null });

    relay.triggerConnectionState('reconnecting');
    relay.triggerConnectionState('connected');

    const rootEl = (view as never)['rootEl'] as HTMLElement;
    expect(rootEl.querySelector('.ct-mobile-disconnected-banner')).toBeNull();

    await view.onClose();
  });
});

describe('MobileView — scrollToBottom uses requestAnimationFrame', () => {
  it('calls requestAnimationFrame when scrolling', async () => {
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      // Execute synchronously for test
      cb(0);
      return 0;
    });

    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [
        makeThread({
          id: 'tid',
          messages: Array.from({ length: 20 }, (_, i) =>
            makeMessage({ id: `m${i}`, content: `Message ${i}` }),
          ),
        }),
      ],
      activeThreadId: 'tid',
    });

    // renderConversation calls scrollToBottom which should call requestAnimationFrame
    expect(rafSpy).toHaveBeenCalled();

    rafSpy.mockRestore();
    await view.onClose();
  });
});

describe('MobileView — message rendering', () => {
  it('renders all messages in the active thread', async () => {
    const { view, store } = await buildView();
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMessage({ id: `m${i}`, content: `Content ${i}`, role: i % 2 === 0 ? 'user' : 'assistant' }),
    );

    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', messages })],
      activeThreadId: 'tid',
    });

    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    const msgEls = messagesEl.querySelectorAll('.ct-mobile-message');
    expect(msgEls.length).toBe(10);

    await view.onClose();
  });

  it('renders compact divider for compact messages', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [
        makeThread({
          id: 'tid',
          messages: [
            makeMessage({ id: 'm1', role: 'user', content: 'Before' }),
            { id: 'c1', role: 'compact', content: '', timestamp: 500 },
            makeMessage({ id: 'm2', role: 'assistant', content: 'After' }),
          ],
        }),
      ],
      activeThreadId: 'tid',
    });

    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    expect(messagesEl.querySelector('.ct-mobile-compact-divider')).not.toBeNull();
    // Compact divider should NOT be rendered as a regular message bubble
    const msgEls = messagesEl.querySelectorAll('.ct-mobile-message');
    expect(msgEls.length).toBe(2);

    await view.onClose();
  });

  it('renders streaming indicator when thread is streaming', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid' })],
      activeThreadId: 'tid',
    });
    store.applyFrame({ type: 'streaming_start', threadId: 'tid' });

    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    expect(messagesEl.querySelector('.ct-mobile-streaming')).not.toBeNull();

    await view.onClose();
  });

  it('renders streaming dot in thread list for streaming thread', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', title: 'Streaming thread' })],
      activeThreadId: null,
    });
    store.applyFrame({ type: 'streaming_start', threadId: 'tid' });

    const threadList = (view as never)['threadListEl'] as HTMLElement;
    expect(threadList.querySelector('.ct-mobile-thread-icon-running')).not.toBeNull();

    await view.onClose();
  });
});

describe('MobileView — permission cards', () => {
  it('renders permission card for pending permission', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid' })],
      activeThreadId: 'tid',
    });
    // Reset incremental-render cache so the next render() call triggers a full
    // renderConversation() even though activeId and msgCount haven't changed.
    (view as never)['lastRenderedMessageCount'] = -1;
    store.applyFrame({
      type: 'permission_request',
      threadId: 'tid',
      toolName: 'Bash',
      detail: 'rm -rf /tmp/test',
      requestId: 'req-1',
    });

    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    expect(messagesEl.querySelector('.ct-mobile-permission-card')).not.toBeNull();
    expect(messagesEl.textContent).toContain('Bash');

    await view.onClose();
  });

  it('Allow button sends resolve_permission with allow=true', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid' })],
      activeThreadId: 'tid',
    });
    // Reset incremental-render cache so the next render() call triggers a full
    // renderConversation() even though activeId and msgCount haven't changed.
    (view as never)['lastRenderedMessageCount'] = -1;
    store.applyFrame({
      type: 'permission_request',
      threadId: 'tid',
      toolName: 'Write',
      detail: 'write foo.txt',
      requestId: 'req-99',
    });

    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    const allowBtn = messagesEl.querySelector('.ct-mobile-permission-allow') as HTMLButtonElement;
    allowBtn.click();

    expect(relay.sendCommand).toHaveBeenCalledWith({
      type: 'resolve_permission',
      threadId: 'tid',
      requestId: 'req-99',
      allow: true,
    });

    await view.onClose();
  });

  it('Deny button sends resolve_permission with allow=false', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid' })],
      activeThreadId: 'tid',
    });
    // Reset incremental-render cache so the next render() call triggers a full
    // renderConversation() even though activeId and msgCount haven't changed.
    (view as never)['lastRenderedMessageCount'] = -1;
    store.applyFrame({
      type: 'permission_request',
      threadId: 'tid',
      toolName: 'Bash',
      detail: 'rm -rf /',
      requestId: 'req-7',
    });

    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    const denyBtn = messagesEl.querySelector('.ct-mobile-permission-deny') as HTMLButtonElement;
    denyBtn.click();

    expect(relay.sendCommand).toHaveBeenCalledWith({
      type: 'resolve_permission',
      threadId: 'tid',
      requestId: 'req-7',
      allow: false,
    });

    await view.onClose();
  });
});

describe('MobileView — question cards', () => {
  const singleSelectQuestion = {
    header: 'Deployment target',
    question: 'Which environment?',
    multiSelect: false,
    options: [
      { label: 'Staging', description: 'Deploy to staging' },
      { label: 'Production', description: 'Deploy to prod' },
    ],
  };

  const multiSelectQuestion = {
    header: 'Test suites',
    question: 'Which suites should run?',
    multiSelect: true,
    options: [
      { label: 'Unit', description: '' },
      { label: 'Integration', description: '' },
    ],
  };

  it('renders question card for pending question', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid' })],
      activeThreadId: 'tid',
    });
    (view as never)['lastRenderedMessageCount'] = -1;
    store.applyFrame({
      type: 'question_request',
      threadId: 'tid',
      requestId: 'q-1',
      questions: [singleSelectQuestion],
    });

    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    expect(messagesEl.querySelector('.ct-mobile-question-card')).not.toBeNull();
    expect(messagesEl.textContent).toContain('Which environment?');
    expect(messagesEl.textContent).toContain('Staging');

    await view.onClose();
  });

  it('single-select radio + submit sends correct resolve_question answers', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid' })],
      activeThreadId: 'tid',
    });
    (view as never)['lastRenderedMessageCount'] = -1;
    store.applyFrame({
      type: 'question_request',
      threadId: 'tid',
      requestId: 'q-2',
      questions: [singleSelectQuestion],
    });

    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    const radios = messagesEl.querySelectorAll<HTMLInputElement>('.ct-mobile-question-option input[type="radio"]');
    // First radio = "Staging", select it
    radios[0].checked = true;

    const submitBtn = messagesEl.querySelector('.ct-mobile-question-submit') as HTMLButtonElement;
    submitBtn.click();

    expect(relay.sendCommand).toHaveBeenCalledWith({
      type: 'resolve_question',
      threadId: 'tid',
      requestId: 'q-2',
      answers: { 'Which environment?': 'Staging' },
    });

    await view.onClose();
  });

  it('multiSelect checkbox joins selected labels with commas', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid' })],
      activeThreadId: 'tid',
    });
    (view as never)['lastRenderedMessageCount'] = -1;
    store.applyFrame({
      type: 'question_request',
      threadId: 'tid',
      requestId: 'q-3',
      questions: [multiSelectQuestion],
    });

    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    const checkboxes = messagesEl.querySelectorAll<HTMLInputElement>('.ct-mobile-question-option input[type="checkbox"]');
    // First two checkboxes = "Unit" and "Integration", select both
    checkboxes[0].checked = true;
    checkboxes[1].checked = true;

    const submitBtn = messagesEl.querySelector('.ct-mobile-question-submit') as HTMLButtonElement;
    submitBtn.click();

    expect(relay.sendCommand).toHaveBeenCalledWith({
      type: 'resolve_question',
      threadId: 'tid',
      requestId: 'q-3',
      answers: { 'Which suites should run?': 'Unit,Integration' },
    });

    await view.onClose();
  });

  it('"Other" free-text path sends the typed answer', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid' })],
      activeThreadId: 'tid',
    });
    (view as never)['lastRenderedMessageCount'] = -1;
    store.applyFrame({
      type: 'question_request',
      threadId: 'tid',
      requestId: 'q-4',
      questions: [singleSelectQuestion],
    });

    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    const otherText = messagesEl.querySelector('.ct-mobile-question-other-text') as HTMLInputElement;
    otherText.value = 'Canary environment';
    otherText.dispatchEvent(new Event('input', { bubbles: true }));

    const submitBtn = messagesEl.querySelector('.ct-mobile-question-submit') as HTMLButtonElement;
    submitBtn.click();

    expect(relay.sendCommand).toHaveBeenCalledWith({
      type: 'resolve_question',
      threadId: 'tid',
      requestId: 'q-4',
      answers: { 'Which environment?': 'Canary environment' },
    });

    await view.onClose();
  });

  it('uses a stable Codex question ID and masks secret free-form input', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid' })],
      activeThreadId: 'tid',
    });
    (view as never)['lastRenderedMessageCount'] = -1;
    store.applyFrame({
      type: 'question_request',
      threadId: 'tid',
      requestId: 'q-secret',
      questions: [{
        id: 'api_token', source: 'codex', question: 'Enter token', header: 'Token', options: [],
        multiSelect: false, allowOther: true, isSecret: true,
      }],
    });

    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    expect(messagesEl.textContent).toContain('Codex needs your input');
    const input = messagesEl.querySelector<HTMLInputElement>('.ct-mobile-question-other-text')!;
    expect(input.type).toBe('password');
    input.value = 's3cret';
    input.dispatchEvent(new Event('input'));
    (messagesEl.querySelector('.ct-mobile-question-submit') as HTMLButtonElement).click();

    expect(relay.sendCommand).toHaveBeenCalledWith({
      type: 'resolve_question', threadId: 'tid', requestId: 'q-secret', answers: { api_token: 's3cret' },
    });

    await view.onClose();
  });

  it('shows the pending-question badge in the thread list', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', title: 'Needs input' })],
      activeThreadId: null,
    });
    store.applyFrame({
      type: 'question_request',
      threadId: 'tid',
      requestId: 'q-5',
      questions: [singleSelectQuestion],
    });

    const threadList = (view as never)['threadListEl'] as HTMLElement;
    expect(threadList.querySelector('.ct-mobile-thread-item-permission')).not.toBeNull();
    expect(threadList.querySelector('.ct-mobile-thread-icon-permission')).not.toBeNull();

    await view.onClose();
  });
});

describe('MobileView — context summary banner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows banner when switching to a thread with a summary after the idle threshold', async () => {
    const { view, store } = await buildView();

    const threadA = makeThread({ id: 'thread-a', title: 'Thread A' });
    const threadB = makeThread({
      id: 'thread-b',
      title: 'Thread B',
      summary: 'Thread B was discussing widget refactors.',
    });

    store.applyFrame({ type: 'snapshot', threads: [threadA, threadB], activeThreadId: 'thread-a' });

    // Stamp an old access time for thread-b (2 minutes ago)
    const accessTimes = (view as never)['threadAccessTimes'] as Map<string, number>;
    accessTimes.set('thread-b', Date.now() - 120_000);

    // Directly call maybeShowSummaryBanner simulating the switch from A → B
    const maybeShow = (view as never)['maybeShowSummaryBanner'].bind(view) as (
      thread: SerializedThread,
      previousId: string | null,
      priorAccessTime: number | undefined,
    ) => void;
    maybeShow(threadB, 'thread-a', Date.now() - 120_000);

    const conversationEl = (view as never)['conversationEl'] as HTMLElement;
    expect(conversationEl.querySelector('.ct-summary-banner')).not.toBeNull();
    expect(conversationEl.textContent).toContain('Thread B was discussing widget refactors.');

    await view.onClose();
  });

  it('does NOT show banner when elapsed time is below the idle threshold', async () => {
    const { view, store } = await buildView();

    const threadA = makeThread({ id: 'thread-a' });
    const threadB = makeThread({
      id: 'thread-b',
      summary: 'Recent thread.',
    });

    store.applyFrame({ type: 'snapshot', threads: [threadA, threadB], activeThreadId: 'thread-a' });

    const maybeShow = (view as never)['maybeShowSummaryBanner'].bind(view) as (
      thread: SerializedThread,
      previousId: string | null,
      priorAccessTime: number | undefined,
    ) => void;

    // 30 seconds ago — below the 60 s threshold
    maybeShow(threadB, 'thread-a', Date.now() - 30_000);

    const conversationEl = (view as never)['conversationEl'] as HTMLElement;
    expect(conversationEl.querySelector('.ct-summary-banner')).toBeNull();

    await view.onClose();
  });

  it('does NOT show banner when the thread has no summary', async () => {
    const { view, store } = await buildView();

    const threadA = makeThread({ id: 'thread-a' });
    const threadB = makeThread({ id: 'thread-b' }); // no summary

    store.applyFrame({ type: 'snapshot', threads: [threadA, threadB], activeThreadId: 'thread-a' });

    const maybeShow = (view as never)['maybeShowSummaryBanner'].bind(view) as (
      thread: SerializedThread,
      previousId: string | null,
      priorAccessTime: number | undefined,
    ) => void;

    maybeShow(threadB, 'thread-a', Date.now() - 120_000);

    const conversationEl = (view as never)['conversationEl'] as HTMLElement;
    expect(conversationEl.querySelector('.ct-summary-banner')).toBeNull();

    await view.onClose();
  });

  it('does NOT show banner when switching to the same thread', async () => {
    const { view, store } = await buildView();

    const thread = makeThread({ id: 'thread-a', summary: 'Some summary.' });
    store.applyFrame({ type: 'snapshot', threads: [thread], activeThreadId: 'thread-a' });

    const maybeShow = (view as never)['maybeShowSummaryBanner'].bind(view) as (
      thread: SerializedThread,
      previousId: string | null,
      priorAccessTime: number | undefined,
    ) => void;

    maybeShow(thread, 'thread-a', Date.now() - 120_000);

    const conversationEl = (view as never)['conversationEl'] as HTMLElement;
    expect(conversationEl.querySelector('.ct-summary-banner')).toBeNull();

    await view.onClose();
  });

  it('close button dismisses the banner immediately', async () => {
    const { view, store } = await buildView();

    const threadA = makeThread({ id: 'thread-a' });
    const threadB = makeThread({ id: 'thread-b', summary: 'Summary text.' });
    store.applyFrame({ type: 'snapshot', threads: [threadA, threadB], activeThreadId: 'thread-a' });

    const maybeShow = (view as never)['maybeShowSummaryBanner'].bind(view) as (
      thread: SerializedThread,
      previousId: string | null,
      priorAccessTime: number | undefined,
    ) => void;
    maybeShow(threadB, 'thread-a', Date.now() - 120_000);

    const conversationEl = (view as never)['conversationEl'] as HTMLElement;
    const closeBtn = conversationEl.querySelector('.ct-summary-banner-close') as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();

    closeBtn.click();

    // hideSummaryBanner(false) sets summaryBannerEl to null immediately, then
    // schedules a 300 ms setTimeout to remove the DOM element after the fade-out.
    expect((view as never)['summaryBannerEl']).toBeNull();

    // Advance past the 300 ms removal timer so the element is also gone from DOM.
    vi.advanceTimersByTime(350);
    expect(conversationEl.querySelector('.ct-summary-banner')).toBeNull();

    await view.onClose();
  });

  it('auto-dismisses the banner after the dismiss delay', async () => {
    const { view, store } = await buildView();

    const threadA = makeThread({ id: 'thread-a' });
    const threadB = makeThread({ id: 'thread-b', summary: 'Auto-dismiss me.' });
    store.applyFrame({ type: 'snapshot', threads: [threadA, threadB], activeThreadId: 'thread-a' });

    const maybeShow = (view as never)['maybeShowSummaryBanner'].bind(view) as (
      thread: SerializedThread,
      previousId: string | null,
      priorAccessTime: number | undefined,
    ) => void;
    maybeShow(threadB, 'thread-a', Date.now() - 120_000);

    const conversationEl = (view as never)['conversationEl'] as HTMLElement;
    expect(conversationEl.querySelector('.ct-summary-banner')).not.toBeNull();

    // Advance past the auto-dismiss timer (10 s)
    vi.advanceTimersByTime(11_000);

    // The banner element is removed from DOM (immediate removal path starts after fade-out
    // animation — in jsdom animations don't fire, so the element is cleared via null ref)
    expect((view as never)['summaryBannerEl']).toBeNull();

    await view.onClose();
  });
});

describe('MobileView — copy button empty-content guard', () => {
  it('does NOT render a copy button for a tool-only assistant message (empty content)', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [
        makeThread({
          id: 'tid',
          messages: [
            makeMessage({
              id: 'm1',
              role: 'assistant',
              content: '',
              toolCalls: [{ name: 'TaskCreate', summary: 'Create task list', status: 'success' }],
            }),
          ],
        }),
      ],
      activeThreadId: 'tid',
    });

    // Let renderMessage()'s async renderMarkdown() call settle before asserting
    // absence, so this isn't just a race that happens to pass.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    expect(messagesEl.querySelector('.ct-mobile-copy-btn')).toBeNull();

    await view.onClose();
  });

  it('renders a working copy button for a normal assistant message with text content', async () => {
    const { view, store } = await buildView();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    store.applyFrame({
      type: 'snapshot',
      threads: [
        makeThread({
          id: 'tid',
          messages: [
            makeMessage({ id: 'm1', role: 'assistant', content: 'Here is the answer.' }),
          ],
        }),
      ],
      activeThreadId: 'tid',
    });

    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    // renderMessage() awaits renderMarkdown() (mocked as an async marked.parse)
    // before creating the copy button, so give the microtask queue a chance
    // to drain before asserting on it.
    const copyBtn = await vi.waitFor(() => {
      const btn = messagesEl.querySelector('.ct-mobile-copy-btn') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      return btn as HTMLButtonElement;
    });

    copyBtn.click();
    expect(writeText).toHaveBeenCalledWith('Here is the answer.');
    expect(copyBtn.textContent).toBe('✓');

    await view.onClose();
  });

  it('does NOT render a copy button for whitespace-only content', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [
        makeThread({
          id: 'tid',
          messages: [makeMessage({ id: 'm1', role: 'assistant', content: '   ' })],
        }),
      ],
      activeThreadId: 'tid',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    expect(messagesEl.querySelector('.ct-mobile-copy-btn')).toBeNull();

    await view.onClose();
  });
});

describe('MobileView — cleanup', () => {
  it('unsubscribes store listener on close', async () => {
    const { view, store } = await buildView();
    store.applyFrame({ type: 'snapshot', threads: [], activeThreadId: null });

    const listenersBefore = (store as never)['listeners'] as Set<() => void>;
    const countBefore = listenersBefore.size;

    await view.onClose();

    expect(listenersBefore.size).toBeLessThan(countBefore);
  });
});

// ── Inline visualization markers ───────────────────────────────────────────
//
// The mobile client is a relay: the fragment file lives on the desktop
// machine, and renderConversation() rebuilds the whole list on every finalized
// message with no throttle. So markers become inert card chrome here, never an
// iframe. When the fragment also happens to be inside the synced vault, the
// card gets a working "Open visualization" button.

describe('MobileView — visualize markers', () => {
  async function renderAssistant(content: string, vaultFiles: string[] = []): Promise<HTMLElement> {
    const { view, store } = await buildView();
    const opened: string[] = [];
    (view as never as { app: unknown }).app = {
      vault: { getAbstractFileByPath: (p: string) => (vaultFiles.includes(p) ? { path: p } : null) },
      workspace: { openLinkText: (p: string) => { opened.push(p); } },
    };
    (view as never as { openedLinks: string[] }).openedLinks = opened;
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', messages: [makeMessage({ id: 'm1', role: 'assistant', content })] })],
      activeThreadId: 'tid',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    (messagesEl as never as { view: MobileView }).view = view;
    return messagesEl;
  }

  it('renders a card instead of leaking the raw marker as text', async () => {
    const el = await renderAssistant('Here:\n\nvisualize{"path":"/desktop/Charts/rev.html"}');
    expect(el.textContent).not.toContain('visualize');
    expect(el.querySelector('.ct-visualize-card')).not.toBeNull();
  });

  it('never mounts an iframe on mobile', async () => {
    const el = await renderAssistant('visualize{"path":"/desktop/Charts/rev.html"}');
    expect(el.querySelector('iframe')).toBeNull();
    expect(el.querySelector('.ct-visualize-card')?.classList.contains('ct-visualize-static')).toBe(true);
  });

  it('shows the title in the card header', async () => {
    const el = await renderAssistant('visualize{"path":"/desktop/Charts/rev.html","title":"Revenue"}');
    expect(el.querySelector('.ct-visualize-title')?.textContent).toBe('Revenue');
  });

  it('falls back to a desktop-only note when the file is not in the vault', async () => {
    const el = await renderAssistant('visualize{"path":"/desktop/Charts/rev.html"}');
    expect(el.querySelector('.ct-visualize-open')).toBeNull();
    expect(el.querySelector('.ct-visualize-body')?.textContent).toMatch(/desktop/i);
  });

  it('offers an Open visualization button when the fragment is in the synced vault', async () => {
    const el = await renderAssistant(
      'visualize{"path":"/Users/me/Documents/Personal/Charts/rev.html"}',
      ['Charts/rev.html'],
    );
    const button = el.querySelector('.ct-visualize-open') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent).toBe('Open visualization');
  });

  it('opens the longest matching vault path when the button is tapped', async () => {
    const el = await renderAssistant(
      'visualize{"path":"/Users/me/Documents/Personal/Charts/rev.html"}',
      ['Charts/rev.html', 'rev.html'],
    );
    (el.querySelector('.ct-visualize-open') as HTMLButtonElement).click();
    const view = (el as never as { view: MobileView }).view;
    expect((view as never as { openedLinks: string[] }).openedLinks).toEqual(['Charts/rev.html']);
  });

  it('leaves a marker inside a fenced code block alone', async () => {
    const el = await renderAssistant('```text\nvisualize{"path":"/a.html"}\n```');
    expect(el.querySelector('.ct-visualize-card')).toBeNull();
    expect(el.textContent).toContain('visualize{');
  });
});

// ── Plain markdown-style links ─────────────────────────────────────────────
//
// Regression test: MobileView had zero click handling for ordinary
// `[label](path)` markdown links — only `a.internal-link` (wikilinks) got a
// listener. Mobile is always classic placement, so these must route through
// app.workspace.openLinkText, and an OS-absolute path that happens to fall
// under the synced vault must be resolved to its vault-relative form first
// (via the same resolveVaultCopy suffix-probing used for visualize markers).
//
// The mocked `marked.parse` in this suite doesn't actually parse markdown
// links — it just wraps content in `<p>`. So links are written here as raw
// HTML anchors (as marked would have produced them), which survive the mock
// unchanged and are then parsed into real DOM anchors by sanitizeHTMLToDom —
// same technique already used for the internal-link wikilink anchors.

describe('MobileView — plain markdown links', () => {
  async function renderAssistantWithApp(content: string, vaultFiles: string[] = []) {
    const { view, store } = await buildView();
    const opened: string[] = [];
    (view as never as { app: unknown }).app = {
      vault: { getAbstractFileByPath: (p: string) => (vaultFiles.includes(p) ? { path: p } : null) },
      workspace: { openLinkText: (p: string) => { opened.push(p); } },
    };
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', messages: [makeMessage({ id: 'm1', role: 'assistant', content })] })],
      activeThreadId: 'tid',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    return { messagesEl, opened, view };
  }

  it('attaches a click listener to a plain markdown link and opens the already vault-relative href', async () => {
    const { messagesEl, opened } = await renderAssistantWithApp(
      'See <a href="Docs/note.md">the doc</a> for details.',
    );
    const link = messagesEl.querySelector('a[href="Docs/note.md"]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    link.click();
    expect(opened).toEqual(['Docs/note.md']);
  });

  it('resolves an OS-absolute path under the synced vault before opening', async () => {
    const href = '/Users/me/Vault/Docs/note.md';
    const { messagesEl, opened } = await renderAssistantWithApp(
      `See <a href="${href}">the doc</a> for details.`,
      ['Docs/note.md'],
    );
    const link = messagesEl.querySelector(`a[href="${href}"]`) as HTMLAnchorElement;
    expect(link).not.toBeNull();
    link.click();
    expect(opened).toEqual(['Docs/note.md']);
  });

  // Previously this pinned the raw absolute path being forwarded to
  // openLinkText. Mobile is always classic placement, so that handed an
  // unresolved linktext to the host — which can create a stray note named
  // after a desktop path that simply isn't on this device. Withhold instead.
  it('does NOT forward an unresolvable OS-absolute path to openLinkText', async () => {
    const href = '/Users/me/elsewhere/note.md';
    const { messagesEl, opened } = await renderAssistantWithApp(
      `See <a href="${href}">the doc</a> for details.`,
      [],
    );
    const link = messagesEl.querySelector(`a[href="${href}"]`) as HTMLAnchorElement;
    link.click();
    expect(opened).toEqual([]);
  });

  it('still forwards an unresolvable RELATIVE href (ordinary vault linktext)', async () => {
    const { messagesEl, opened } = await renderAssistantWithApp(
      'See <a href="Notes/Missing.md">the doc</a> for details.',
      [],
    );
    (messagesEl.querySelector('a[href="Notes/Missing.md"]') as HTMLAnchorElement).click();
    expect(opened).toEqual(['Notes/Missing.md']);
  });

  it('preserves a #heading subpath when resolving an OS-absolute path', async () => {
    const href = '/Users/me/Vault/Docs/note.md#Section';
    const { messagesEl, opened } = await renderAssistantWithApp(
      `See <a href="${href}">the doc</a> for details.`,
      ['Docs/note.md'],
    );
    (messagesEl.querySelector(`a[href="${href}"]`) as HTMLAnchorElement).click();
    expect(opened).toEqual(['Docs/note.md#Section']);
  });

  it('does not attach a click listener to an external link', async () => {
    const { messagesEl, opened } = await renderAssistantWithApp(
      'See <a href="https://example.com">the site</a> for details.',
    );
    const link = messagesEl.querySelector('a[href="https://example.com"]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    link.click();
    expect(opened).toEqual([]);
  });

  it('decodes percent-encoded spaces (as real marked emits) before suffix-matching a path whose vault-relative portion has a space', async () => {
    // In production marked percent-encodes spaces in emitted hrefs; the mocked
    // marked.parse here doesn't, so the %20 is written explicitly to exercise
    // the same decode step MobileView applies before calling resolveVaultCopy.
    const encodedHref = '/Users/me/Vault/Products/Geode/Runs/My%20Report.md';
    const { messagesEl, opened } = await renderAssistantWithApp(
      `See <a href="${encodedHref}">the doc</a> for details.`,
      ['Products/Geode/Runs/My Report.md'],
    );
    const link = messagesEl.querySelector(`a[href="${encodedHref}"]`) as HTMLAnchorElement;
    expect(link).not.toBeNull();
    link.click();
    expect(opened).toEqual(['Products/Geode/Runs/My Report.md']);
  });
});

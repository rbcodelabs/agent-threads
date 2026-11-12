/**
 * @vitest-environment jsdom
 *
 * Golden-output tests for the CURRENT ThreadsView message rendering path
 * (renderMarkdown, appendMessage, appendAssistantGroup, streaming render).
 * They exist so the renderer can be extracted into a shared module without
 * changing what the main panel produces: the snapshots in __snapshots__ were
 * recorded on unmodified code and must not be edited to make a refactor pass.
 *
 * Each scenario records the normalised DOM and the routing of every anchor
 * click (plain and Cmd-click), because listeners are invisible in the DOM.
 * ThreadsView is driven via Object.create(ThreadsView.prototype), the same
 * pattern as threads-view-plain-link-click.test.ts.
 */
import '../setup/obsidian-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', async (importOriginal) => {
  const actual = await importOriginal<typeof import('obsidian')>();
  return {
    ...actual,
    // Record icon and tooltip names in the DOM so icon changes show up in goldens.
    setIcon: (el: HTMLElement, icon: string) => { el.setAttribute('data-icon', icon); },
    setTooltip: (el: HTMLElement, tip: string) => { el.setAttribute('data-tooltip', tip); },
  };
});

import { ThreadsView } from '../../src/ThreadsView';
import { RemoteImageCache } from '../../src/remote/remoteImages';
import { MessageContentProviderRegistry } from '../../src/MessageContent';
import { MessageContentMountManager } from '../../src/messageContentRenderer';
import { mergeAdjacentToolOnlyMessages } from '../../src/toolNameUtils';
import type { ChatMessage } from '../../src/types';
import { dumpDom, recordAnchorClicks } from '../helpers/domDump';
import {
  FIXTURE_BRIDGE_REPO, FIXTURE_VAULT_FILES, FIXTURE_VAULT_ROOT, RICH_MARKDOWN, RICH_MESSAGES, STREAMING_PARTIAL,
} from '../fixtures/richChatMessages';

interface Scenario { conversationFirst: boolean; remote: boolean; compressed?: boolean }

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
}

function makeHarness(s: Scenario) {
  const calls: string[] = [];
  const visualize: string[] = [];
  const view = Object.create(ThreadsView.prototype) as ThreadsView & Record<string, any>;
  const registry = new MessageContentProviderRegistry();
  registry.register({ pluginId: 'example' }, { providerId: 'example.cards', present: () => ({ kind: 'card' as const, title: 'Hydrated card' }) });
  const mounts = new MessageContentMountManager(registry, { openView: async () => 'tab' });
  const thread = { id: 'thread-1', noteFile: 'Threads/thread-1.md', messages: RICH_MESSAGES, remote: s.remote ? { daemonId: 'daemon-1' } : undefined };

  view.app = {
    vault: {
      adapter: { basePath: FIXTURE_VAULT_ROOT },
      getAbstractFileByPath: (p: string) => (FIXTURE_VAULT_FILES.includes(p) ? { path: p } : null),
    },
    workspace: { openLinkText: (...a: unknown[]) => { calls.push(`workspace.openLinkText(${a.map(String).join(', ')})`); } },
    plugins: { plugins: { 'vault-bridges': { api: { getBridges: () => [{
      id: 'b', name: 'Bridge', repoPath: FIXTURE_BRIDGE_REPO, sourcePath: '', vaultPath: 'Bridge', branch: 'main', autoSync: true, status: 'ok',
    }] } } } },
  };
  view.plugin = {
    settings: { enableInlineVisualizations: true, toolCallStyle: 'pills' },
    isConversationFirst: () => s.conversationFirst,
    contextPanel: { openLinkText: (...a: unknown[]) => { calls.push(`contextPanel.openLinkText(${a.map(String).join(', ')})`); } },
    daemonRegistry: { clientFor: () => undefined },
    inProcessSummarizer: { summarizeMessage: async () => '' },
  };
  view.manager = { getThread: () => thread };
  view.activeThreadId = 'thread-1';
  view.messageContentController = new AbortController();
  view.messageContentManager = mounts;
  view.visualizeManager = { hydrate: (_el: HTMLElement, markers: unknown[], o: { interactive: boolean }) => { visualize.push(`hydrate(${JSON.stringify(markers)}, interactive=${o.interactive})`); } };
  view.remoteImageCache = new RemoteImageCache();
  // Instance state normally set by field initialisers / setup().
  view.compressedView = !!s.compressed;
  view.summaryTextEls = new Map();
  view.browserRowEls = new Map();
  view.browser = undefined;
  view.expandedToolGroups = new Set();
  view.userCollapsedToolGroups = new Set();
  view.liveExpandedToolGroups = new Set();
  view.expandedOuterToolWrap = new Set();
  view.liveExpandedOuterToolWrap = new Set();
  view.groupSummaryCache = new Map();
  view.summaryQueue = Promise.resolve();
  view.summaryGeneration = 0;
  view.streamingRenderGeneration = 0;
  view.streamingRenderInFlight = false;
  view.streamingRenderDirty = false;
  // Not under test: user-message context menu, locale clock, scrolling, external opens.
  view.attachUserMessageMenu = () => {};
  view.formatShortTime = (t: number) => `t${t}`;
  view.scrollToBottom = () => {};
  view.openLink = (url: string, force = false) => { calls.push(`openLink(${url}, force=${force})`); };
  view.confirmOpenOutsideVaultLink = (href: string) => { calls.push(`confirmOpenOutsideVaultLink(${href})`); };

  const messagesEl = document.createElement('div');
  document.body.appendChild(messagesEl);
  view.messagesEl = messagesEl;
  return { view, calls, visualize, messagesEl, mounts };
}

async function renderTranscript(h: ReturnType<typeof makeHarness>): Promise<void> {
  const rows: ChatMessage[] = mergeAdjacentToolOnlyMessages(RICH_MESSAGES);
  if (h.view.compressedView) {
    let i = 0;
    while (i < rows.length) {
      if (rows[i].role === 'assistant') {
        const group: ChatMessage[] = [];
        while (i < rows.length && rows[i].role === 'assistant') group.push(rows[i++]);
        await h.view.appendAssistantGroup(group);
      } else { await h.view.appendMessage(rows[i++]); }
    }
  } else {
    for (const msg of rows) await h.view.appendMessage(msg);
  }
  await flush();
}

const SCENARIOS: Array<[string, Scenario]> = [
  ['classic placement, local thread', { conversationFirst: false, remote: false }],
  ['conversation-first placement, remote thread', { conversationFirst: true, remote: true }],
];

beforeEach(() => { document.body.innerHTML = ''; });

describe('ThreadsView golden output (current renderer)', () => {
  for (const [name, scenario] of SCENARIOS) {
    describe(name, () => {
      it('renderMarkdown of the rich assistant message', async () => {
        const h = makeHarness(scenario);
        const el = document.createElement('div'); document.body.appendChild(el);
        await h.view.renderMarkdown(RICH_MARKDOWN, el, { messageId: 'a1' });
        await flush();
        const dom = dumpDom(el);
        const clicks = await recordAnchorClicks(el, h.calls);
        expect(`${dom}\n--- visualize\n${h.visualize.join('\n')}\n--- clicks\n${clicks}`).toMatchSnapshot();
        h.mounts.dispose();
      });

      it('full transcript through appendMessage', async () => {
        const h = makeHarness(scenario);
        await renderTranscript(h);
        const dom = dumpDom(h.messagesEl);
        const clicks = await recordAnchorClicks(h.messagesEl, h.calls);
        expect(`${dom}\n--- clicks\n${clicks}`).toMatchSnapshot();
        h.mounts.dispose();
      });
    });
  }

  it('compressed view groups consecutive assistant rows', async () => {
    const h = makeHarness({ conversationFirst: false, remote: false, compressed: true });
    await renderTranscript(h);
    expect(dumpDom(h.messagesEl)).toMatchSnapshot();
    h.mounts.dispose();
  });

  it('streaming partial renders through the streaming path', async () => {
    const h = makeHarness({ conversationFirst: false, remote: false });
    h.view.streamingEl = h.messagesEl.createDiv('ct-message ct-message-assistant ct-streaming');
    h.view.streamingContentEl = h.view.streamingEl.createDiv('ct-message-content');
    h.view.streamingContent = STREAMING_PARTIAL;
    h.view.streamingRenderDirty = true;
    await h.view.renderStreamingContent();
    await flush();
    expect(`${dumpDom(h.messagesEl)}\n--- visualize\n${h.visualize.join('\n')}`).toMatchSnapshot();
    h.mounts.dispose();
  });
});

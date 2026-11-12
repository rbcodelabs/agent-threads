/**
 * @vitest-environment jsdom
 *
 * Golden-output tests for the CURRENT MobileView message rendering path
 * (renderMessage, updateStreamingEl and the renderMarkdown they share). Same
 * contract as threads-view-render-golden.test.ts: the snapshots were recorded
 * on unmodified code and must not be edited to make a refactor pass.
 *
 * MobileView has no manager; the fixture messages are fed through the real
 * view methods with a hand-built app (vault index, workspace spies).
 */
import '../setup/obsidian-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', async (importOriginal) => {
  const actual = await importOriginal<typeof import('obsidian')>();
  return {
    ...actual,
    setIcon: (el: HTMLElement, icon: string) => { el.setAttribute('data-icon', icon); },
    setTooltip: (el: HTMLElement, tip: string) => { el.setAttribute('data-tooltip', tip); },
  };
});

import { MobileView } from '../../src/MobileView';
import { MobileThreadStore } from '../../src/MobileThreadStore';
import { Notice } from 'obsidian';
import { dumpDom, recordAnchorClicks } from '../helpers/domDump';
import {
  FIXTURE_VAULT_FILES, RICH_MARKDOWN, RICH_MESSAGES, STREAMING_PARTIAL,
} from '../fixtures/richChatMessages';

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
}

async function makeHarness() {
  const calls: string[] = [];
  const relay = { sendCommand: vi.fn(), onConnectionStateChange: vi.fn(() => () => {}) };
  const store = new MobileThreadStore();
  const view = new MobileView({} as never, relay as never, store) as MobileView & Record<string, any>;
  await view.onOpen();
  view.app = {
    vault: { getAbstractFileByPath: (p: string) => (FIXTURE_VAULT_FILES.includes(p) ? { path: p } : null) },
    workspace: { openLinkText: (...a: unknown[]) => { calls.push(`workspace.openLinkText(${a.map(String).join(', ')})`); } },
  };
  view.formatShortTime = (t: number) => `t${t}`;
  const messagesEl = document.createElement('div');
  document.body.appendChild(messagesEl);
  view.messagesEl = messagesEl;
  return { view, store, calls, messagesEl };
}

beforeEach(() => { document.body.innerHTML = ''; Notice.messages.length = 0; });

describe('MobileView golden output (current renderer)', () => {
  it('renderMarkdown of the rich assistant message', async () => {
    const h = await makeHarness();
    const el = document.createElement('div'); document.body.appendChild(el);
    await h.view.renderMarkdown(RICH_MARKDOWN, el);
    await flush();
    const dom = dumpDom(el);
    const clicks = await recordAnchorClicks(el, h.calls);
    const notices = Notice.messages.map(n => n.message).join('\n');
    expect(`${dom}\n--- clicks\n${clicks}\n--- notices\n${notices}`).toMatchSnapshot();
  });

  it('full transcript through renderMessage', async () => {
    const h = await makeHarness();
    for (const msg of RICH_MESSAGES) await h.view.renderMessage(msg);
    await flush();
    const dom = dumpDom(h.messagesEl);
    const clicks = await recordAnchorClicks(h.messagesEl, h.calls);
    expect(`${dom}\n--- clicks\n${clicks}`).toMatchSnapshot();
  });

  it('streaming partial renders through updateStreamingEl', async () => {
    const h = await makeHarness();
    h.store.isStreaming = () => true;
    h.store.getStreamingContent = () => STREAMING_PARTIAL;
    h.store.getStreamingTools = () => [];
    await h.view.updateStreamingEl('thread-1');
    await flush();
    expect(dumpDom(h.messagesEl)).toMatchSnapshot();
  });
});

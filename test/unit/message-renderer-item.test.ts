/**
 * @vitest-environment jsdom
 *
 * The shared message item renderer (src/messageRenderer/message.ts): one renderMessage, the main panel's `.ct-message`
 * row, used by the main panel AND the dock sheet (which used to have a compact density; it renders identically now).
 * Pieces shared with every row: notices, dividers, user text, thumbnails, tool-result images. Tool rendering and the
 * surface's own state come in through `hooks`.
 */
import '../setup/obsidian-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderMessage, type MessageItemOptions, type MessageRenderHost } from '../../src/messageRenderer';
import type { ChatMessage, ToolCallRecord } from '../../src/types';

const TOOLS: ToolCallRecord[] = [
  { name: 'Read', summary: 'Read: /a.md', status: 'success' },
  { name: 'Read', summary: 'Read: /b.md', status: 'success' },
  { name: 'Grep', summary: 'Grep: TODO', status: 'error' },
];
const PNG = 'iVBORw0KGgo=';
const imageSrc: MessageItemOptions['imageSrc'] = (ref, data) => `data:${ref.mediaType};base64,${data ?? ''}`;

const MESSAGES: ChatMessage[] = [
  { id: 'u', role: 'user', timestamp: 1, content: 'see https://user.example.com/x and more', images: [{ name: 's.png', mediaType: 'image/png', base64: PNG }] },
  {
    id: 'a', role: 'assistant', timestamp: 2, cost: 0.01, toolCalls: TOOLS,
    toolResultImages: [{ mediaType: 'image/png', data: PNG }],
    content: 'Hello **world** with [site](https://example.com/p) and a [[thread:t1|Deploy]] link.\n\n![remote](https://evil.example/p.png)',
  },
  { id: 'n', role: 'notice', timestamp: 3, content: 'Background task done', noticeStatus: 'completed' },
  { id: 'c', role: 'compact', timestamp: 4, content: '', compactTrigger: 'manual', preTokens: 120000 },
];

const THREADS = [{ id: 't1', title: 'Deploy curation' }];
void THREADS;

const HOST: MessageRenderHost = {
  signal: new AbortController().signal,
  threadId: () => 'thread-1',
  getThread: () => undefined,
  sourcePath: () => '',
  openLinkText: () => {},
  confirmOutsideVault: () => {},
  vaultHas: () => false,
  visualize: { enabled: false, streamingAware: true, hydrate: () => {} },
};

function full(extra: Partial<MessageItemOptions> = {}): MessageItemOptions {
  return { imageSrc, formatTime: (t) => `t${t}`, ...extra };
}
async function render(msg: ChatMessage, opts: MessageItemOptions) {
  const parent = document.createElement('div');
  const r = renderMessage(msg, parent, HOST, opts);
  await r.done;
  return { parent, el: r.el };
}

describe('renderMessage (shared)', () => {
  it('notices and compact dividers are the bare main-panel rows', async () => {
    const n = await render(MESSAGES[2], full());
    expect(n.parent.firstElementChild).toBe(n.el);
    expect(n.parent.querySelector('.ct-notice-row .ct-notice-text')?.textContent).toBe('Background task done');
    const c = await render(MESSAGES[3], full());
    expect(c.parent.querySelector('.ct-compact-label')?.textContent).toBe('Context compacted');
    expect(c.parent.querySelector('.ct-compact-tokens')?.textContent).toBe('120k tokens');
  });

  it('the main-panel row with injected tool rendering, copy button, cost footer and user footer', async () => {
    const toolCalls = vi.fn((el: HTMLElement, tools: ToolCallRecord[]) => { el.createDiv('ct-tools').textContent = String(tools.length); });
    const a = await render(MESSAGES[1], full({ hooks: { toolCalls } }));
    expect(a.el?.className).toBe('ct-message ct-message-assistant');
    expect(toolCalls).toHaveBeenCalledOnce();
    expect(a.el?.querySelector('.ct-copy-btn')).not.toBeNull();
    expect(a.el?.querySelector('.ct-cost')?.textContent).toBe('$0.0100');
    expect(a.el?.querySelector('.ct-tool-result-images img')).not.toBeNull();
    const u = await render(MESSAGES[0], full());
    expect(u.el?.querySelector('.ct-message-footer .ct-message-ts')?.textContent).toBe('t1');
    expect(u.el?.querySelectorAll('.ct-message-img-thumb')).toHaveLength(1);
  });

  it('without a tool-call hook the surface draws no tool rows (there is no second, compact tool UI any more)', async () => {
    const a = await render(MESSAGES[1], full());
    expect(a.el?.querySelector('.ct-tools, .ct-tool-pill, .ct-orch-tools')).toBeNull();
  });

  it('user URLs route through openExternal; without one they are plain anchors the surface handles', async () => {
    const openExternal = vi.fn();
    const f = await render(MESSAGES[0], full({ openExternal }));
    f.el!.querySelector<HTMLAnchorElement>('a.ct-auto-link')!.click();
    expect(openExternal).toHaveBeenCalledWith('https://user.example.com/x', false);
    const c = await render(MESSAGES[0], full());
    const a = c.el!.querySelector<HTMLAnchorElement>('a.ct-auto-link')!;
    expect(a.getAttribute('href')).toBe('https://user.example.com/x');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('an assistant message with no text still renders its tool hook and images, with an empty content div and no copy button', async () => {
    const toolCalls = vi.fn((el: HTMLElement) => { el.createDiv('ct-tools'); });
    const a = await render({ ...MESSAGES[1], id: 'b', content: '' }, full({ hooks: { toolCalls } }));
    expect(a.el?.querySelector('.ct-tools')).not.toBeNull();
    expect(a.el?.querySelector('.ct-tool-result-images img')).not.toBeNull();
    expect(a.el?.querySelector('.ct-copy-btn')).toBeNull();
  });
});

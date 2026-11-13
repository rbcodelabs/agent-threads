/**
 * @vitest-environment jsdom
 *
 * The shared message item renderer (src/messageRenderer/message.ts): one renderMessage for the main panel
 * ('full') and the dock sheet ('compact'), built from shared pieces for notices, dividers, user text, thumbnails,
 * tool-result images and the compact tool summary row. Parity: the same messages produce the same text, link
 * targets and tool-call count in both densities.
 */
import '../setup/obsidian-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderMessage, type MessageItemOptions } from '../../src/messageRenderer';
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

function full(extra: Partial<MessageItemOptions> = {}): MessageItemOptions {
  return { density: 'full', linkPolicy: 'strict', threadRefs: THREADS, imageSrc, formatTime: (t) => `t${t}`, ...extra };
}
function compact(extra: Partial<MessageItemOptions> = {}): MessageItemOptions {
  return { density: 'compact', linkPolicy: 'strict', threadRefs: THREADS, imageSrc, ...extra };
}
async function render(msg: ChatMessage, opts: MessageItemOptions) {
  const parent = document.createElement('div');
  const r = renderMessage(msg, parent, undefined, opts);
  await r.done;
  return { parent, el: r.el };
}

describe('renderMessage (shared)', () => {
  it('notices and compact dividers are the same rows in both densities', async () => {
    for (const opts of [full(), compact()]) {
      const n = await render(MESSAGES[2], opts);
      expect(n.parent.querySelector('.ct-notice-row .ct-notice-text')?.textContent).toBe('Background task done');
      const c = await render(MESSAGES[3], opts);
      expect(c.parent.querySelector('.ct-compact-label')?.textContent).toBe('Context compacted');
      expect(c.parent.querySelector('.ct-compact-tokens')?.textContent).toBe('120k tokens');
    }
  });

  it('full: the main-panel row with injected tool rendering, copy button, cost footer and user footer', async () => {
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

  it('full: user URLs route through openExternal; compact: plain anchors the surface handles', async () => {
    const openExternal = vi.fn();
    const f = await render(MESSAGES[0], full({ openExternal }));
    f.el!.querySelector<HTMLAnchorElement>('a.ct-auto-link')!.click();
    expect(openExternal).toHaveBeenCalledWith('https://user.example.com/x', false);
    const c = await render(MESSAGES[0], compact());
    const a = c.el!.querySelector<HTMLAnchorElement>('a.ct-auto-link')!;
    expect(a.getAttribute('href')).toBe('https://user.example.com/x');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('compact: the dock bubble, tool calls as ONE collapsed summary row, no pills, footer or copy button', async () => {
    const a = await render(MESSAGES[1], compact());
    expect(a.el?.className).toBe('ct-orch-msg');
    expect(a.el?.getAttribute('data-role')).toBe('assistant');
    expect(a.el?.querySelectorAll('.ct-orch-tools')).toHaveLength(1);
    const toggle = a.el!.querySelector<HTMLButtonElement>('.ct-orch-tools-toggle')!;
    expect(toggle.textContent).toContain('3 tool calls, 1 failed');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const list = a.el!.querySelector<HTMLElement>('.ct-orch-tools-list')!;
    expect(list.hidden).toBe(true);
    toggle.click();
    expect(list.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(list.querySelectorAll('.ct-orch-tools-item')).toHaveLength(3);
    expect(a.el?.querySelector('.ct-tool-pill, .ct-copy-btn, .ct-message-footer')).toBeNull();
    expect(a.el?.querySelector('.ct-orch-bubble strong')?.textContent).toBe('world');
  });

  it('compact: strict policy still never renders a remote image', async () => {
    const a = await render(MESSAGES[1], compact());
    expect(a.el?.querySelector('.ct-orch-bubble img')).toBeNull();
    expect(a.el?.querySelector('a[href="https://evil.example/p.png"]')).not.toBeNull();
    expect(a.el?.querySelector('.ct-tool-result-images img')).not.toBeNull();
  });

  it('compact: an assistant message with no text still renders its tool row and images, with no empty bubble', async () => {
    const a = await render({ ...MESSAGES[1], id: 'b', content: '' }, compact());
    expect(a.el?.querySelector('.ct-orch-tools')).not.toBeNull();
    expect(a.el?.querySelector('.ct-orch-bubble')).toBeNull();
  });

  it('compact with seedPlainText: the text shows at once and a stale result never replaces it', async () => {
    const parent = document.createElement('div');
    const r = renderMessage({ ...MESSAGES[1], toolCalls: undefined, content: 'Hello **x**' }, parent, undefined, compact({ seedPlainText: true, isStale: () => true }));
    expect(parent.querySelector('.ct-orch-bubble')?.textContent).toBe('Hello **x**');
    await r.done;
    expect(parent.querySelector('.ct-orch-bubble strong')).toBeNull();
  });

  it('parity: the same messages give the same text, link targets and tool-call count in both densities', async () => {
    const summarise = async (opts: MessageItemOptions) => {
      const out = { text: [] as string[], hrefs: new Set<string>(), tools: 0 };
      for (const msg of MESSAGES) {
        const { parent } = await render(msg, opts);
        const body = parent.querySelectorAll('.ct-message-content, .ct-orch-bubble, .ct-notice-text, .ct-compact-label');
        body.forEach(b => out.text.push((b.textContent ?? '').trim()));
        parent.querySelectorAll('a').forEach(a => out.hrefs.add(a.getAttribute('data-thread-id') ?? a.getAttribute('href') ?? ''));
        out.tools += parent.querySelectorAll('.ct-orch-tools-item').length;
      }
      return out;
    };
    const toolCalls = (el: HTMLElement, tools: ToolCallRecord[]) => {
      tools.forEach(t => el.createDiv('ct-orch-tools-item').textContent = t.name);
    };
    const f = await summarise(full({ hooks: { toolCalls } }));
    const c = await summarise(compact());
    expect(f.text.filter(Boolean)).toEqual(c.text.filter(Boolean));
    expect([...f.hrefs].sort()).toEqual([...c.hrefs].sort());
    expect(f.tools).toBe(3);
    expect(c.tools).toBe(3);
  });
});

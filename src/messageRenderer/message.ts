import { setIcon } from 'obsidian';
import type { ChatMessage, ToolCallRecord } from '../types';
import { formatToolName } from '../toolNameUtils';
import { renderMarkdown } from './renderMarkdown';
import { linkifyUrls } from './links';
import type { MessageRenderHost } from './types';
import type { ThreadRef } from '../orchestratorDockModel';

/**
 * Message item rendering shared by the main panel and the OrchestratorDock sheet.
 *
 * 'full' is the main panel's `.ct-message` row (pills, copy button, footer, user thumbnails); 'compact' is the dock's
 * `.ct-orch-msg` bubble (tool calls collapsed into one summary row, no footer or copy button). Both use the same
 * pieces for notices, compact dividers, user text, image thumbnails and tool-result images, so a change to one of
 * them lands on both surfaces. Whatever depends on ThreadsView state (the user-message menu, the compressed view,
 * live tool-pill rendering, browser session cards) is injected through `hooks`.
 */
export interface MessageItemOptions {
  density: 'full' | 'compact';
  /** 'trusted' for the user's own transcript (needs a host); 'strict' for untrusted content (the dock). */
  linkPolicy?: 'trusted' | 'strict';
  /** Strict only: threads that `[[thread:id|Title]]` may resolve to. */
  threadRefs?: readonly ThreadRef[];
  /** Strict only: false makes a `[[note]]` that cannot be opened render as inert text. */
  resolveLink?: (href: string) => boolean;
  /** Source for an attached image: a vault resource URL when it has a path, else a data URL. */
  imageSrc(ref: { path?: string; mediaType: string }, inlineData: string | undefined): string;
  /** Short clock text for the footer (full only). */
  formatTime?(timestamp: number): string;
  /**
   * Opens http(s) links in user text. Omitted: the anchors are plain `href`s and the surface handles the click
   * (the dock delegates clicks on its log).
   */
  openExternal?(url: string, forceExternal: boolean): void;
  /** Compact only: show the plain text at once and swap in markdown when it is ready, unless stale. */
  seedPlainText?: boolean;
  isStale?(): boolean;
  /** Wraps the swap so the surface can capture state first (the dock's scroll pin). Omitted: the swap just happens. */
  swap?(apply: () => void): void;
  /** Full only: the pieces that live in ThreadsView. */
  hooks?: {
    /** Right after the row element exists (user-message menu). */
    onRow?(el: HTMLElement, msg: ChatMessage): void;
    /** Renders the row's tool calls (pills, groups, browser cards) and registers whatever the view tracks. */
    toolCalls?(el: HTMLElement, tools: ToolCallRecord[], msg: ChatMessage): void;
    /** Tool-result images, some of which a browser card may have claimed. */
    toolImages?(el: HTMLElement, msg: ChatMessage): void;
    /** Takes over the assistant body (the compressed view). Return a promise when handled; undefined falls through to markdown. */
    assistantBody?(content: HTMLElement, msg: ChatMessage): Promise<void> | undefined;
    /** After the copy button is added. */
    onAssistantRendered?(el: HTMLElement, msg: ChatMessage): void;
  };
}

export interface RenderedMessage {
  /** The row element (for a notice or divider in full density, the bare notice / divider element). */
  el: HTMLElement | null;
  /** Resolves when async content (markdown) is in place. */
  done: Promise<void>;
}

// ── Pieces ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function renderCompactDivider(parent: HTMLElement, msg: ChatMessage): HTMLElement {
  const divider = parent.createDiv('ct-compact-divider');
  const label = msg.compactTrigger === 'manual' ? 'Context compacted' : 'Context auto-compacted';
  divider.createSpan({ cls: 'ct-compact-label', text: label });
  if (msg.preTokens && msg.preTokens > 0) {
    divider.createSpan({ cls: 'ct-compact-tokens', text: `${(msg.preTokens / 1000).toFixed(0)}k tokens` });
  }
  return divider;
}

export function renderNoticeRow(parent: HTMLElement, msg: ChatMessage): HTMLElement {
  const row = parent.createDiv('ct-notice-row');
  const iconEl = row.createSpan('ct-notice-icon');
  setIcon(iconEl, msg.noticeStatus === 'completed' ? 'check-circle' : 'x-circle');
  row.createSpan({ cls: 'ct-notice-text', text: msg.content });
  return row;
}

/** User text (http(s) URLs linkified) plus the thumbnails of attached images. */
export function renderUserContent(content: HTMLElement, msg: ChatMessage, opts: Pick<MessageItemOptions, 'imageSrc' | 'openExternal'>): void {
  const p = content.createEl('p', { text: msg.content });
  linkifyUrls(p, opts.openExternal ?? null);
  // Thumbnails of images attached to a user message (sent from the dispatch box or the conversation input).
  if (msg.images && msg.images.length > 0) {
    const imgRow = content.createDiv('ct-message-images');
    for (const img of msg.images) {
      const thumb = imgRow.createEl('img', { cls: 'ct-message-img-thumb' });
      thumb.src = opts.imageSrc(img, img.base64);
      thumb.title = img.name;
    }
  }
}

/** Images returned by tool results. `claimed` indexes belong to a card that shows them itself. */
export function renderToolResultImages(
  rowEl: HTMLElement,
  msg: ChatMessage,
  imageSrc: MessageItemOptions['imageSrc'],
  claimed?: ReadonlySet<number>,
): HTMLElement | null {
  if (!msg.toolResultImages || msg.toolResultImages.length === 0) return null;
  const visible = msg.toolResultImages.filter((_, i) => !claimed?.has(i));
  if (visible.length === 0) return null;
  const imgWrap = rowEl.createDiv('ct-tool-result-images');
  for (const img of visible) {
    imgWrap.createEl('img', {
      attr: {
        src: imageSrc(img, img.data),
        style: 'max-width:100%;border-radius:4px;margin-bottom:6px;display:block;',
      },
    });
  }
  return imgWrap;
}

/** Compact density: all of a message's tool calls as ONE collapsed row, expandable to a plain list. */
export function renderToolSummaryRow(parent: HTMLElement, tools: readonly ToolCallRecord[]): HTMLElement {
  const wrap = parent.createDiv('ct-orch-tools');
  const failed = tools.filter(t => t.status === 'error').length;
  const toggle = wrap.createEl('button', { cls: 'ct-orch-tools-toggle', attr: { type: 'button', 'aria-expanded': 'false' } });
  if (failed > 0) toggle.addClass('ct-orch-tools-error');
  const iconEl = toggle.createSpan({ cls: 'ct-orch-tools-icon', attr: { 'aria-hidden': 'true' } });
  setIcon(iconEl, 'list-tree');
  toggle.createSpan({
    cls: 'ct-orch-tools-label',
    text: `${tools.length} tool call${tools.length === 1 ? '' : 's'}${failed > 0 ? `, ${failed} failed` : ''}`,
  });
  const chevron = toggle.createSpan({ cls: 'ct-orch-tools-chevron', attr: { 'aria-hidden': 'true' } });
  setIcon(chevron, 'chevron-down');
  const list = wrap.createDiv('ct-orch-tools-list');
  list.hidden = true;
  for (const tool of tools) {
    const line = list.createDiv({ cls: `ct-orch-tools-item${tool.status === 'error' ? ' ct-orch-tools-item-error' : ''}` });
    line.createSpan({ cls: 'ct-orch-tools-name', text: formatToolName(tool.name) });
    if (tool.summary) line.createSpan({ cls: 'ct-orch-tools-text', text: tool.summary });
  }
  toggle.addEventListener('click', () => {
    list.hidden = !list.hidden;
    toggle.setAttribute('aria-expanded', String(!list.hidden));
    setIcon(chevron, list.hidden ? 'chevron-down' : 'chevron-up');
  });
  return wrap;
}

// ── Message item ────────────────────────────────────────────────────────────────────────────────────────────────────

function markdownOptions(msg: ChatMessage, opts: MessageItemOptions) {
  return opts.linkPolicy === 'strict'
    ? { linkPolicy: 'strict' as const, threadRefs: opts.threadRefs, resolveLink: opts.resolveLink }
    : { messageId: msg.id };
}

/**
 * Renders one message into `parent`: `.ct-message` in 'full' density, the dock's `.ct-orch-msg` bubble in 'compact'.
 * Returns the row synchronously; `done` resolves when markdown has been swapped in.
 */
export function renderMessage(
  msg: ChatMessage,
  parent: HTMLElement,
  host: MessageRenderHost | undefined,
  opts: MessageItemOptions,
): RenderedMessage {
  if (msg.role === 'compact' || msg.role === 'notice') {
    // The dock keys, orders and removes rows by their `.ct-orch-msg` shell; the main panel appends the bare element.
    const shell = opts.density === 'compact' ? parent.createDiv({ cls: 'ct-orch-msg', attr: { 'data-role': msg.role, 'data-id': msg.id } }) : parent;
    const el = msg.role === 'compact' ? renderCompactDivider(shell, msg) : renderNoticeRow(shell, msg);
    return { el: shell === parent ? el : shell, done: Promise.resolve() };
  }
  return opts.density === 'compact' ? renderCompactMessage(msg, parent, host, opts) : renderFullMessage(msg, parent, host, opts);
}

function renderFullMessage(msg: ChatMessage, parent: HTMLElement, host: MessageRenderHost | undefined, opts: MessageItemOptions): RenderedMessage {
  const hooks = opts.hooks ?? {};
  const el = parent.createDiv(`ct-message ct-message-${msg.role}`);
  hooks.onRow?.(el, msg);

  if (msg.toolCalls && msg.toolCalls.length > 0) {
    if (hooks.toolCalls) hooks.toolCalls(el, msg.toolCalls, msg);
    else renderToolSummaryRow(el, msg.toolCalls);
  }
  if (hooks.toolImages) hooks.toolImages(el, msg);
  else renderToolResultImages(el, msg, opts.imageSrc);

  const content = el.createDiv('ct-message-content');
  let done: Promise<void> = Promise.resolve();
  if (msg.role === 'assistant') {
    done = (async () => {
      const handled = hooks.assistantBody?.(content, msg);
      if (handled) await handled;
      else await renderMarkdown(msg.content, content, host, markdownOptions(msg, opts));
      // Only render the copy button when there is actual text to copy. Desktop hides this button by default
      // (opacity: 0, revealed on hover), so an empty-content tool-only turn is cosmetically harmless, but guard
      // it anyway for correctness and so it doesn't regress if the hover-hide CSS ever changes.
      if (msg.content && msg.content.trim().length > 0) {
        const copyBtn = el.createEl('button', { cls: 'ct-copy-btn', attr: { title: 'Copy response' } });
        setIcon(copyBtn, 'copy');
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(msg.content);
          setIcon(copyBtn, 'check');
          setTimeout(() => setIcon(copyBtn, 'copy'), 1500);
        });
      }
      hooks.onAssistantRendered?.(el, msg);
    })();
  } else {
    renderUserContent(content, msg, opts);
  }

  // The footer row is shown for user messages (always: it marks when the user sent) and for assistant messages that
  // carry a cost (the terminal message of a turn). Intermediate assistant messages get none, keeping the view clean.
  const addFooter = (): void => {
    const hasCost = !!msg.cost && msg.cost > 0;
    if (msg.role === 'user' || hasCost) {
      const footer = el.createDiv('ct-message-footer');
      footer.createSpan({ cls: 'ct-message-ts', text: opts.formatTime?.(msg.timestamp) ?? '' });
      if (hasCost) footer.createSpan({ cls: 'ct-cost', text: `$${msg.cost!.toFixed(4)}` });
    }
  };
  return { el, done: done.then(addFooter) };
}

function renderCompactMessage(msg: ChatMessage, parent: HTMLElement, host: MessageRenderHost | undefined, opts: MessageItemOptions): RenderedMessage {
  const row = parent.createDiv({ cls: 'ct-orch-msg', attr: { 'data-role': msg.role, 'data-id': msg.id } });
  if (msg.toolCalls && msg.toolCalls.length > 0) renderToolSummaryRow(row, msg.toolCalls);
  renderToolResultImages(row, msg, opts.imageSrc);
  const bubble = row.createDiv('ct-orch-bubble');
  if (msg.role !== 'assistant') {
    if (msg.content.trim() !== '' || (msg.images?.length ?? 0) > 0) renderUserContent(bubble, msg, opts);
    return { el: row, done: Promise.resolve() };
  }
  if (msg.content.trim() === '') { bubble.remove(); return { el: row, done: Promise.resolve() }; }
  // Seeded with the plain text so the row is never empty while markdown renders; swapped for markdown when it resolves.
  // An empty result keeps the text.
  if (opts.seedPlainText) bubble.textContent = msg.content;
  const target = bubble.ownerDocument.createElement('div');
  const done = renderMarkdown(msg.content, target, host, markdownOptions(msg, opts)).then(() => {
    if (opts.isStale?.() || target.childNodes.length === 0) return;
    const apply = (): void => bubble.replaceChildren(...Array.from(target.childNodes));
    if (opts.swap) opts.swap(apply); else apply();
  }, () => { /* keep the plain-text seed */ });
  return { el: row, done };
}

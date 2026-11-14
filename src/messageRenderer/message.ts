import { setIcon } from 'obsidian';
import type { ChatMessage, ToolCallRecord } from '../types';
import { renderMarkdown } from './renderMarkdown';
import { linkifyUrls } from './links';
import type { MessageRenderHost } from './types';

/**
 * Message item rendering shared by the main panel and the OrchestratorDock sheet: ONE row, the main panel's `.ct-message`
 * (pills, copy button, footer, user thumbnails), plus notices, compaction dividers, user text, image thumbnails and
 * tool-result images. The dock sheet renders IDENTICALLY to the main panel (it used to draw a compact `.ct-orch-msg`
 * bubble with one collapsed tool row; that density and its strict link policy were removed). Whatever depends on a
 * surface's state (the user-message menu, the compressed view, tool-call rendering with its expand state and browser
 * cards, tool images a browser card may have claimed) is injected through `hooks`.
 */
export interface MessageItemOptions {
  /** Kept optional so existing callers may still name them; there is only one density and one link policy now. */
  density?: 'full';
  linkPolicy?: 'trusted';
  /** Source for an attached image: a vault resource URL when it has a path, else a data URL. */
  imageSrc(ref: { path?: string; mediaType: string }, inlineData: string | undefined): string;
  /** Short clock text for the footer. */
  formatTime?(timestamp: number): string;
  /**
   * Opens http(s) links in user text. Omitted: the anchors are plain `href`s and the surface handles the click.
   */
  openExternal?(url: string, forceExternal: boolean): void;
  /** The pieces that live in the surface (ThreadsView, the dock sheet). */
  hooks?: {
    /** Right after the row element exists (user-message menu). */
    onRow?(el: HTMLElement, msg: ChatMessage): void;
    /** Renders the row's tool calls (pills, groups, browser cards) and registers whatever the surface tracks. Omitted: tool calls are not drawn. */
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
  /** The row element (for a notice or divider, the bare notice / divider element). */
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

// ── Message item ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Renders one message into `parent` as the main panel row (`.ct-message`), or the bare notice / divider element.
 * Returns the row synchronously; `done` resolves when markdown has been swapped in.
 */
export function renderMessage(
  msg: ChatMessage,
  parent: HTMLElement,
  host: MessageRenderHost,
  opts: MessageItemOptions,
): RenderedMessage {
  if (msg.role === 'compact' || msg.role === 'notice') {
    const el = msg.role === 'compact' ? renderCompactDivider(parent, msg) : renderNoticeRow(parent, msg);
    return { el, done: Promise.resolve() };
  }
  return renderFullMessage(msg, parent, host, opts);
}

function renderFullMessage(msg: ChatMessage, parent: HTMLElement, host: MessageRenderHost, opts: MessageItemOptions): RenderedMessage {
  const hooks = opts.hooks ?? {};
  const el = parent.createDiv(`ct-message ct-message-${msg.role}`);
  hooks.onRow?.(el, msg);

  if (msg.toolCalls && msg.toolCalls.length > 0) {
    hooks.toolCalls?.(el, msg.toolCalls, msg);
  }
  if (hooks.toolImages) hooks.toolImages(el, msg);
  else renderToolResultImages(el, msg, opts.imageSrc);

  const content = el.createDiv('ct-message-content');
  let done: Promise<void> = Promise.resolve();
  if (msg.role === 'assistant') {
    done = (async () => {
      const handled = hooks.assistantBody?.(content, msg);
      if (handled) await handled;
      else await renderMarkdown(msg.content, content, host, { messageId: msg.id });
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

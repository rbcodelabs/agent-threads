import { sanitizeHTMLToDom } from 'obsidian';
import { marked } from 'marked';
import { extractMessageContent } from '../MessageContent';
import { extractVisualizeMarkers, VISUALIZE_SLOT_CLASS } from '../visualizeMarker';
import { classifyRenderedMarkdownLink, isOsAbsoluteHref, resolveAbsoluteVaultHref } from '../linkUtils';
import { hydrateRemoteImages } from '../remote/remoteImages';
import { linkifyBridgePaths, linkifyUrls } from './links';
import type { MessageRenderHost, MessageRenderOptions } from './types';

/**
 * Render assistant markdown into `el`. This is the single pipeline shared by
 * the main panel and the mobile view; anything surface-specific goes through
 * `host`. Order of operations matters (extraction before marked, hydration
 * after sanitizing, link wiring last) and is preserved from the original
 * ThreadsView implementation.
 */
export async function renderMarkdown(
  markdown: string,
  el: HTMLElement,
  host: MessageRenderHost,
  options: MessageRenderOptions = {},
): Promise<void> {
  const threadId = host.threadId();
  const signal = host.signal;
  const transcriptMessage = options.messageId && threadId
    ? host.getThread(threadId)?.messages.find(message => message.id === options.messageId && message.role === 'assistant' && message.content === markdown)
    : undefined;
  const inline = transcriptMessage || options.streaming || host.alwaysExtractMessageContent
    ? extractMessageContent(markdown, options)
    : { text: markdown, markers: [] };
  // Codex's `visualize` skill puts a wrapped content reference on its own line
  // where an inline visual belongs. Rewrite those lines into anchor
  // placeholders here, before marked runs, so the markdown is parsed exactly
  // once — splitting into segments and parsing each would break ordered-list
  // numbering, reference links, and footnotes that span a marker.
  const visualize = host.visualize.enabled
    ? extractVisualizeMarkers(inline.text, host.visualize.streamingAware ? { streaming: options.streaming } : undefined)
    : { text: inline.text, markers: [] };

  // Pre-process [[wikilinks]] and [[target|alias]] into inline HTML anchors
  // before handing off to marked. marked passes inline HTML through unchanged,
  // so GFM table parsing (and all other markdown features) work correctly.
  // This replaces the previous MarkdownRenderer.render() approach which did not
  // render GFM pipe tables in this non-document context.
  const processed = visualize.text.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match, target: string, alias?: string) => {
      const label = (alias ?? target.split('/').pop() ?? target).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c] ?? c));
      const escapedTarget = target.replace(/"/g, '&quot;');
      return `<a class="internal-link" data-href="${escapedTarget}" href="#">${label}</a>`;
    },
  );
  el.appendChild(sanitizeHTMLToDom(await marked.parse(processed)));
  // Swap the placeholders for live cards. Iframes mount only on settled
  // messages — during streaming the marker renders as inert card chrome, so
  // a frame is never rebuilt on every token.
  host.visualize.hydrate(el, visualize.markers, { interactive: !options.streaming });
  host.hydrateMessageContent?.(el, inline.markers, { threadId, messageId: transcriptMessage?.id ?? 'streaming', signal }, options);
  // `![alt](/abs/path)` in a remote thread names a file on the daemon's machine: the host's loader fetches it.
  const load = host.remoteImageLoader?.();
  if (load) hydrateRemoteImages(el, { load, signal });
  // Wrap tables in a scrollable container so wide tables don't overflow.
  el.querySelectorAll<HTMLTableElement>('table').forEach((table) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'ct-table-scroll';
    table.parentNode?.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  });
  // Wire up click handlers for [[wikilink]] anchors. Both placements resolve
  // against the thread's own note, so a wikilink lands on the same target
  // regardless of where the conversation is docked.
  el.querySelectorAll<HTMLAnchorElement>('a.internal-link').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const href = a.getAttribute('data-href') ?? a.getAttribute('href') ?? '';
      host.openLinkText(href, host.sourcePath());
    });
  });
  // marked renders ordinary `[label](path.md#heading)` links without the
  // custom wikilink class. Intercept only relative/vault-shaped hrefs;
  // protocols and same-page anchors retain the browser/host's standard
  // behavior. Some hrefs are OS-absolute paths that happen to fall under the
  // vault root (e.g. a fragment written from outside Obsidian) — resolve
  // those to a vault-relative path before handing them to the open calls,
  // which expect vault linktext, not filesystem paths.
  el.querySelectorAll<HTMLAnchorElement>(`a:not(.internal-link):not(.${VISUALIZE_SLOT_CLASS})`).forEach((a) => {
    const href = a.getAttribute('href') ?? '';
    if (classifyRenderedMarkdownLink(href) !== 'vault') return;
    const absolute = isOsAbsoluteHref(href);
    a.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Resolved on click, not at render: an agent frequently writes a file
      // and links to it in the same turn, so the vault copy may only appear
      // (or finish syncing) after this message was rendered. Probing here
      // means the link starts working as soon as the target exists.
      //
      // Only absolute paths need rewriting; marked percent-encodes the hrefs
      // it emits, which resolveAbsoluteVaultHref accounts for when probing.
      // An ordinary relative href is forwarded untouched — the open calls
      // parse the `#subpath` and do their own decoding, so decoding it here
      // would both double-decode and strip that responsibility from its
      // rightful owner.
      const resolved = resolveAbsoluteVaultHref(href, (p) => host.vaultHas(p));
      // An absolute filesystem path we could not map into the vault is NOT
      // vault linktext. Forwarding it would ask the host to open an
      // unresolved link, which can create a stray note named after the
      // path — the same hazard linkifyBridgePaths guards against.
      if (absolute && !resolved) {
        host.confirmOutsideVault(href);
        return;
      }
      host.openLinkText(resolved ?? href, host.sourcePath());
    });
  });
  // http(s) links get no listener above (classifyRenderedMarkdownLink calls
  // them 'external'), so they would fall through to the host's default anchor
  // click behavior, which does not know about conversation-first placement and
  // can open the page in the wrong tab. Wire them through the host's opener,
  // which already branches correctly. Only http(s) is intercepted — mailto:,
  // obsidian:, and other custom-protocol links keep the host/OS's own handler.
  const openExternal = host.openExternal?.bind(host);
  if (openExternal) {
    el.querySelectorAll<HTMLAnchorElement>('a:not(.internal-link):not(.ct-visualize-slot)').forEach((a) => {
      const href = a.getAttribute('href') ?? '';
      if (classifyRenderedMarkdownLink(href) !== 'external') return;
      if (!/^https?:\/\//i.test(href.trim())) return;
      a.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        // Cmd-click (Mac) / Ctrl-click (other) forces the system browser even
        // when the Web Viewer is enabled — matching the footer pill and
        // Obsidian's own "open in default app" modifier convention.
        openExternal(href, event.metaKey || event.ctrlKey);
      });
    });
  }
  linkifyBridgePaths(el, host);
  if (openExternal) linkifyUrls(el, openExternal);
}

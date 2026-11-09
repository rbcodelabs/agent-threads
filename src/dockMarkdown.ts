/**
 * dockMarkdown.ts
 *
 * Markdown for the OrchestratorDock reply sheet: `marked` + `sanitizeHTMLToDom`, plus
 * `[[thread:id|Title]]` and `[[note]]` links. Deliberately small: no visualize markers, no
 * tool-call UI (the sheet shows an "Open full thread" chip for those) and NO ThreadsView import.
 *
 * Link labels are model-controlled text. Anchors are therefore emitted EMPTY with the label in a
 * `data-label` attribute, and the label is written with `textContent` after sanitising: a label can
 * never become markup, and markdown punctuation in it (`*`, `_`) is not parsed. Click handling stays
 * outside this module (the sheet delegates it).
 */
import { marked } from 'marked';
import { sanitizeHTMLToDom } from 'obsidian';
import { rewriteThreadLinks, type ThreadRef } from './orchestratorDockModel';

const escapeAttr = (s: string): string =>
  s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] ?? c));

/** Fenced blocks (``` or ~~~, to the closing fence or the end) and inline code spans: wikilinks inside are literal. */
const CODE_SEGMENT = /(^[ \t]*(?:```|~~~)[\s\S]*?(?:^[ \t]*(?:```|~~~)[^\n]*$|(?![\s\S]))|`[^`\n]*`)/gm;

/** Applies `fn` to the prose between code, leaving code untouched. */
function outsideCode(markdown: string, fn: (prose: string) => string): string {
  let out = '';
  let cursor = 0;
  for (const m of markdown.matchAll(CODE_SEGMENT)) {
    out += fn(markdown.slice(cursor, m.index)) + m[0];
    cursor = m.index + m[0].length;
  }
  return out + fn(markdown.slice(cursor));
}

/**
 * Rewrites thread links (resolved + normalised by the model) and generic wikilinks into empty anchors
 * carrying only data attributes, before markdown runs. `thread:` markers go first: same regex shape.
 * Code spans and fenced blocks are skipped: a link quoted in code stays literal text.
 */
export function rewriteDockMarkup(markdown: string, threads: readonly ThreadRef[] = []): string {
  return outsideCode(markdown, (prose) => rewriteThreadLinks(prose, threads).replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_m, target: string, alias?: string) => {
      if (target.startsWith('thread:')) {
        const id = target.slice('thread:'.length).trim();
        return `<a class="ct-thread-link" data-thread-id="${escapeAttr(id)}" data-label="${escapeAttr((alias ?? '').trim())}" href="#"></a>`;
      }
      const label = (alias ?? target.split('/').pop() ?? target).trim();
      return `<a class="internal-link" data-href="${escapeAttr(target.trim())}" data-label="${escapeAttr(label)}" href="#"></a>`;
    },
  ));
}

export interface DockMarkdownOptions {
  threads: readonly ThreadRef[];
  /** False for a `[[note]]` that cannot be opened (unresolved, or the host cannot open links): it renders as inert text. */
  resolveLink?: (href: string) => boolean;
}

const INERT_SELECTOR = 'script, iframe, object, embed, style, link, meta, base, form';

function replaceWithText(el: Element, className: string, text: string): void {
  const span = el.ownerDocument.createElement('span');
  span.className = className;
  span.textContent = text;
  el.replaceWith(span);
}

/**
 * Posture: the orchestrator reads untrusted thread content, so its replies are untrusted. Beyond the sanitizer
 * (ThreadsView relies on it alone and also loads images, because there the user is reading their own transcript):
 * no remote content is ever auto-loaded in the sheet (images become links), active elements are removed, and a
 * model-authored raw thread anchor only survives for a thread that exists.
 */
export async function renderDockMarkdown(markdown: string, el: HTMLElement, opts: DockMarkdownOptions): Promise<void> {
  const html = await marked.parse(rewriteDockMarkup(markdown, opts.threads));
  const fragment = sanitizeHTMLToDom(html);
  el.appendChild(fragment);
  el.querySelectorAll(INERT_SELECTOR).forEach((n) => n.remove());
  el.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
    const src = img.getAttribute('src') ?? '';
    const label = img.getAttribute('alt') || src || 'image';
    if (/^https?:\/\//i.test(src)) {
      const a = img.ownerDocument.createElement('a');
      a.setAttribute('href', src);
      a.setAttribute('rel', 'noopener noreferrer');
      a.textContent = label;
      img.replaceWith(a);
    } else {
      replaceWithText(img, 'ct-orch-image-omitted', label);
    }
  });
  const known = new Set(opts.threads.map((t) => t.id));
  el.querySelectorAll<HTMLAnchorElement>('a.ct-thread-link, a.internal-link').forEach((a) => {
    const id = a.getAttribute('data-thread-id');
    const own = a.hasAttribute('data-label');
    // If a sanitizer ever strips data-label the link must not go blank: fall back to the thread title.
    const label = own ? (a.getAttribute('data-label') || opts.threads.find((t) => t.id === id)?.title || id || a.getAttribute('data-href') || '') : (a.textContent ?? '');
    a.removeAttribute('data-label');
    if (a.classList.contains('ct-thread-link')) {
      if (!id || !known.has(id)) { replaceWithText(a, 'ct-orch-wikilink-unresolved', label); return; }
      a.textContent = label;
      return;
    }
    const href = a.getAttribute('data-href') ?? '';
    if (!href || (opts.resolveLink && !opts.resolveLink(href))) { replaceWithText(a, 'ct-orch-wikilink-unresolved', label); return; }
    a.textContent = label;
  });
  // Wide tables scroll inside the bubble instead of widening it.
  el.querySelectorAll<HTMLTableElement>('table').forEach((table) => {
    const wrapper = el.ownerDocument.createElement('div');
    wrapper.className = 'ct-table-scroll';
    table.parentNode?.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  });
}

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

const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+/;
const INDENTED = /^(?: {4}|\t)/;

/** Inline code spans: wikilinks inside are literal. */
function outsideInlineCode(prose: string, fn: (text: string) => string): string {
  let out = '';
  let cursor = 0;
  for (const m of prose.matchAll(/(`+)[^\n]*?\1/g)) {
    out += fn(prose.slice(cursor, m.index)) + m[0];
    cursor = m.index + m[0].length;
  }
  return out + fn(prose.slice(cursor));
}

/**
 * Applies `fn` to the prose of a markdown document, leaving code untouched: fenced blocks (``` or ~~~, to the closing
 * fence or the end; a line like "```code```" is NOT a fence opener), 4-space indented code after a blank line (not
 * inside a list, where it is a continuation paragraph) and inline code spans.
 */
function outsideCode(markdown: string, fn: (prose: string) => string): string {
  const chunks: Array<{ code: boolean; lines: string[] }> = [];
  const push = (code: boolean, line: string): void => {
    const last = chunks[chunks.length - 1];
    if (last && last.code === code) last.lines.push(line); else chunks.push({ code, lines: [line] });
  };
  let fence: { ch: string; len: number } | null = null;
  let prevBlank = true;
  let prevIndentedCode = false;
  let afterList = false;
  for (const line of markdown.split('\n')) {
    if (fence) {
      push(true, line);
      const close = new RegExp(`^[ \\t]{0,3}\\${fence.ch}{${fence.len},}[ \\t]*$`);
      if (close.test(line)) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open && (open[1][0] === '~' || !open[2].includes('`'))) {
      fence = { ch: open[1][0], len: open[1].length };
      push(true, line);
      prevBlank = false; prevIndentedCode = false;
      continue;
    }
    const blank = line.trim() === '';
    if (!blank && INDENTED.test(line) && !afterList && (prevBlank || prevIndentedCode)) {
      push(true, line);
      prevBlank = false; prevIndentedCode = true;
      continue;
    }
    push(false, line);
    if (blank) { prevBlank = true; continue; } // blank lines keep an indented-code run alive
    prevBlank = false; prevIndentedCode = false;
    if (!INDENTED.test(line)) afterList = LIST_ITEM.test(line);
  }
  return chunks.map((c) => (c.code ? c.lines.join('\n') : outsideInlineCode(c.lines.join('\n'), fn))).join('\n');
}

/**
 * Rewrites thread links (resolved + normalised by the model) and generic wikilinks into empty anchors carrying data
 * attributes and the per-render `nonce`, before markdown runs. ONLY anchors carrying the nonce are real links:
 * model-authored raw anchors cannot know it. `thread:` markers go first (same regex shape). Code is skipped.
 */
export function rewriteDockMarkup(markdown: string, threads: readonly ThreadRef[] = [], nonce = ''): string {
  const n = escapeAttr(nonce);
  return outsideCode(markdown, (prose) => rewriteThreadLinks(prose, threads).replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_m, target: string, alias?: string) => {
      if (target.startsWith('thread:')) {
        const id = target.slice('thread:'.length).trim();
        return `<a class="ct-thread-link" data-ct-n="${n}" data-thread-id="${escapeAttr(id)}" data-label="${escapeAttr((alias ?? '').trim())}" href="#"></a>`;
      }
      const label = (alias ?? target.split('/').pop() ?? target).trim();
      return `<a class="internal-link" data-ct-n="${n}" data-href="${escapeAttr(target.trim())}" data-label="${escapeAttr(label)}" href="#"></a>`;
    },
  ));
}

export interface DockMarkdownOptions {
  threads: readonly ThreadRef[];
  /** False for a `[[note]]` that cannot be opened (unresolved, or the host cannot open links): it renders as inert text. */
  resolveLink?: (href: string) => boolean;
}

/** Prose elements only: everything else (media, embeds, forms, svg, style, script, unknown) is removed after sanitising. */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'p', 'em', 'strong', 'ul', 'ol', 'li', 'code', 'pre', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'a', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'del', 's', 'span', 'div', 'b', 'i', 'sup', 'sub',
]);

function replaceWithText(el: Element, className: string, text: string): void {
  const span = el.ownerDocument.createElement('span');
  span.className = className;
  span.textContent = text;
  el.replaceWith(span);
}

const SAFE_SCHEME = /^(?:https?|mailto):/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.\-]*:/i;
let nonceSeq = 0;

/** Default-deny attributes: only what a prose element needs survives. Anchors keep href (safe schemes) + our transport data. */
function scrubAttributes(node: Element): void {
  const tag = node.localName;
  for (const attr of Array.from(node.attributes)) {
    const name = attr.name.toLowerCase();
    const keep =
      (tag === 'a' && (name === 'href' || name === 'rel' || name === 'class' || name === 'data-ct-n' || name === 'data-thread-id' || name === 'data-href' || name === 'data-label'))
      || (tag === 'code' && name === 'class' && /^language-[\w-]+$/.test(attr.value))
      || (tag === 'ol' && name === 'start');
    if (!keep) node.removeAttribute(attr.name);
  }
  if (tag === 'a') {
    const href = node.getAttribute('href');
    if (href !== null && ANY_SCHEME.test(href.trim()) && !SAFE_SCHEME.test(href.trim())) node.removeAttribute('href');
  }
}

/**
 * Posture: the orchestrator reads untrusted thread content, so its replies are untrusted. Beyond the sanitizer (the real
 * `sanitizeHTMLToDom` was not run in tests; this is defence in depth) and unlike ThreadsView, which renders the user's own
 * transcript and relies on the sanitizer alone: only prose elements survive (no media, embeds, forms, svg, style), no
 * attribute outside the allowlist survives (no src / srcset / poster / style / on*), images become plain links, and ONLY
 * anchors the rewriter generated (they carry this render's nonce) can be thread links or wikilinks.
 */
export async function renderDockMarkdown(markdown: string, el: HTMLElement, opts: DockMarkdownOptions): Promise<void> {
  const nonce = `${Math.random().toString(36).slice(2)}${(nonceSeq++).toString(36)}`;
  const html = await marked.parse(rewriteDockMarkup(markdown, opts.threads, nonce));
  const fragment = sanitizeHTMLToDom(html);
  el.appendChild(fragment);
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
  for (const node of Array.from(el.querySelectorAll('*'))) {
    if (!el.contains(node)) continue; // inside an already removed element
    if (!ALLOWED_TAGS.has(node.localName)) { node.remove(); continue; }
    scrubAttributes(node);
  }
  const known = new Set(opts.threads.map((t) => t.id));
  el.querySelectorAll<HTMLAnchorElement>('a').forEach((a) => {
    const ours = a.getAttribute('data-ct-n') === nonce && nonce !== '';
    const id = a.getAttribute('data-thread-id');
    const href = a.getAttribute('data-href');
    const labelAttr = a.getAttribute('data-label');
    for (const name of ['data-ct-n', 'data-thread-id', 'data-href', 'data-label', 'class']) a.removeAttribute(name);
    if (!ours) return; // a model-authored anchor is a plain link at most
    // If a sanitizer ever strips data-label the link must not go blank: fall back to the thread title.
    const label = labelAttr || opts.threads.find((t) => t.id === id)?.title || id || href || '';
    if (id !== null) {
      if (!known.has(id)) { replaceWithText(a, 'ct-orch-wikilink-unresolved', label); return; }
      a.className = 'ct-thread-link';
      a.setAttribute('data-thread-id', id);
      a.textContent = label;
      return;
    }
    if (!href || (opts.resolveLink && !opts.resolveLink(href))) { replaceWithText(a, 'ct-orch-wikilink-unresolved', label); return; }
    a.className = 'internal-link';
    a.setAttribute('data-href', href);
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

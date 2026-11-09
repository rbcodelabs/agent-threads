/**
 * dockMarkdown.ts
 *
 * Markdown for the OrchestratorDock reply sheet: `marked` + `sanitizeHTMLToDom`, plus
 * `[[thread:id|Title]]` and `[[note]]` links. Deliberately small: no visualize markers, no
 * tool-call UI (the sheet shows an "Open full thread" chip for those) and NO ThreadsView import.
 *
 * Links never travel as markup. `[[...]]` is replaced by an inert alphanumeric token (carrying a
 * per-render random nonce) BEFORE markdown runs, and the real anchors are built from the rewriter's own
 * list, as DOM nodes, AFTER markdown and the allowlist: no attacker-controlled text can ever end up
 * inside a tag, an attribute or a link we generate. Labels are written with `textContent`.
 * Click handling stays outside this module (the sheet delegates it).
 */
import { marked } from 'marked';
import { sanitizeHTMLToDom } from 'obsidian';
import { rewriteThreadLinks, type ThreadRef } from './orchestratorDockModel';

// ── Code detection: wikilinks inside code are literal ───────────────────────────────────────────────────────────────

/** Optional blockquote markers, then optional indentation (a fence inside a list item or a blockquote). */
const PREFIX = String.raw`(?:[ \t]*>)*[ \t]*`;
const FENCE_OPEN = new RegExp(`^${PREFIX}(\`{3,}|~{3,})(.*)$`);
const LIST_ITEM = /^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+/;
const INDENTED = /^(?: {4}|\t)/;

/** Inline code spans, which may wrap across lines but never across a blank line. */
function outsideInlineCode(prose: string, fn: (text: string) => string): string {
  let out = '';
  let cursor = 0;
  for (const m of prose.matchAll(/(`+)(?:(?!\n[ \t]*\n)[\s\S])*?\1/g)) {
    out += fn(prose.slice(cursor, m.index)) + m[0];
    cursor = m.index + m[0].length;
  }
  return out + fn(prose.slice(cursor));
}

/**
 * Applies `fn` to the prose of a markdown document, leaving code untouched: fenced blocks (``` or ~~~, to the closing
 * fence or the end, also inside list items and blockquotes; a line like "```code```" is NOT a fence opener), 4-space
 * indented code after a blank line (not inside a list) and inline code spans. This only improves fidelity: a token that
 * still lands inside rendered code is restored to its literal `[[...]]` text at render time.
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
      const close = new RegExp(`^${PREFIX}\\${fence.ch}{${fence.len},}[ \\t]*$`);
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

// ── Link tokens ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DockLink {
  /** Inert alphanumeric stand-in that travels through markdown. */
  token: string;
  kind: 'thread' | 'note';
  /** Thread id (already resolved by the model) or the note's link target. */
  ref: string;
  label: string;
  /** The original `[[...]]` text, restored when the token ends up somewhere it must stay literal (code, attributes). */
  literal: string;
}

/**
 * Replaces `[[thread:...]]` (resolved + normalised by the model) and `[[note]]` with tokens; returns the new markdown and
 * the list the renderer builds the real links from. Pure. Code is skipped.
 */
export function rewriteDockMarkup(markdown: string, threads: readonly ThreadRef[] = [], nonce = 'n'): { markdown: string; links: DockLink[] } {
  const links: DockLink[] = [];
  const tag = nonce.replace(/[^a-z0-9]/gi, '') || 'n';
  const out = outsideCode(markdown, (prose) => rewriteThreadLinks(prose, threads).replace(
    /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g,
    (whole, target: string, alias?: string) => {
      const token = `ctlnk${tag}x${links.length}x`;
      if (target.startsWith('thread:')) links.push({ token, kind: 'thread', ref: target.slice('thread:'.length).trim(), label: (alias ?? '').trim(), literal: whole });
      else links.push({ token, kind: 'note', ref: target.trim(), label: (alias ?? target.split('/').pop() ?? target).trim(), literal: whole });
      return token;
    },
  ));
  return { markdown: out, links };
}

export interface DockMarkdownOptions {
  threads: readonly ThreadRef[];
  /** False for a `[[note]]` that cannot be opened (unresolved, or the host cannot open links): it renders as inert text. */
  resolveLink?: (href: string) => boolean;
}

// ── Allowlist ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Prose elements only: everything else (media, embeds, forms, svg, style, script, unknown) is removed. */
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

/**
 * A strict allowlist applied to the value AS THE BROWSER WILL SEE IT: the WHATWG URL parser drops tabs, newlines and
 * leading/trailing C0 controls and spaces before it reads the scheme, so test with all of those removed. Kept: http(s),
 * mailto, and relative / anchor references (no ':' before the first '/', '?' or '#'). Everything else (javascript:, data:,
 * vbscript:, file:, blob:, ...) is dropped.
 */
export function isSafeHref(href: string): boolean {
  const h = href.replace(/[\u0000- \u007f-\u009f]/g, '');
  if (/^(?:https?|mailto):/i.test(h)) return true;
  return /^[^:/?#]*(?:[/?#]|$)/.test(h);
}

/** Default-deny attributes: only what a prose element needs survives (no src / srcset / poster / style / on* / data-*). */
function scrubAttributes(node: Element): void {
  const tag = node.localName;
  for (const attr of Array.from(node.attributes)) {
    const name = attr.name.toLowerCase();
    const keep =
      (tag === 'a' && (name === 'href' || name === 'rel'))
      || (tag === 'code' && name === 'class' && /^language-[\w-]+$/.test(attr.value))
      || (tag === 'span' && name === 'class' && attr.value === 'ct-orch-image-omitted')
      || (tag === 'ol' && name === 'start');
    if (!keep) node.removeAttribute(attr.name);
  }
  if (tag === 'a') {
    const href = node.getAttribute('href');
    if (href !== null && !isSafeHref(href)) node.removeAttribute('href');
  }
}

/** Builds the real link for a token, or inert text when it cannot be opened. */
function buildLink(doc: Document, link: DockLink, opts: DockMarkdownOptions, known: ReadonlySet<string>): Node {
  const inert = (text: string): HTMLElement => {
    const span = doc.createElement('span');
    span.className = 'ct-orch-wikilink-unresolved';
    span.textContent = text;
    return span;
  };
  if (link.kind === 'thread') {
    const title = opts.threads.find((t) => t.id === link.ref)?.title;
    const label = link.label || title || link.ref;
    if (!known.has(link.ref)) return inert(label);
    const a = doc.createElement('a');
    a.className = 'ct-thread-link';
    a.setAttribute('href', '#');
    a.setAttribute('data-thread-id', link.ref);
    a.textContent = label;
    return a;
  }
  if (!link.ref || (opts.resolveLink && !opts.resolveLink(link.ref))) return inert(link.label || link.ref);
  const a = doc.createElement('a');
  a.className = 'internal-link';
  a.setAttribute('href', '#');
  a.setAttribute('data-href', link.ref);
  a.textContent = link.label || link.ref;
  return a;
}

let nonceSeq = 0;

/**
 * Posture: the orchestrator reads untrusted thread content, so its replies are untrusted. Beyond the sanitizer (the real
 * `sanitizeHTMLToDom` was not run in tests; this is defence in depth) and unlike ThreadsView, which renders the user's own
 * transcript and relies on the sanitizer alone: ALL work happens on an INERT parsed tree (nothing in it loads, runs or
 * fetches); only prose elements survive; no attribute outside the allowlist survives; images become plain links; hrefs are a
 * strict allowlist; and links are built only from the rewriter's own token list, so a model-authored anchor is a plain link
 * at most. Only the cleaned markup is then passed through sanitizeHTMLToDom into the live container.
 */
export async function renderDockMarkdown(markdown: string, el: HTMLElement, opts: DockMarkdownOptions): Promise<void> {
  const nonce = `${Math.random().toString(36).slice(2, 10)}${(nonceSeq++).toString(36)}`;
  const rewritten = rewriteDockMarkup(markdown, opts.threads, nonce);
  const html = await marked.parse(rewritten.markdown);
  const Parser = el.ownerDocument.defaultView?.DOMParser ?? DOMParser;
  const inert = new Parser().parseFromString(html, 'text/html');
  const root = inert.body;
  const byToken = new Map(rewritten.links.map((l) => [l.token, l]));
  const tokenRe = new RegExp(`ctlnk${nonce.replace(/[^a-z0-9]/gi, '')}x\\d+x`, 'g');

  root.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
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
  for (const node of Array.from(root.querySelectorAll('*'))) {
    if (!root.contains(node)) continue; // inside an already removed element
    if (!ALLOWED_TAGS.has(node.localName)) { node.remove(); continue; }
    // A token inside an attribute value (raw HTML, a link destination) goes back to its literal text: it never becomes a link.
    for (const attr of Array.from(node.attributes)) {
      if (tokenRe.test(attr.value)) node.setAttribute(attr.name, attr.value.replace(tokenRe, (t) => byToken.get(t)?.literal ?? ''));
      tokenRe.lastIndex = 0;
    }
    scrubAttributes(node);
  }

  // Tokens in text become real links, built here from the rewriter's list; inside code they go back to literal text.
  const known = new Set(opts.threads.map((t) => t.id));
  const walker = inert.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (tokenRe.test((n as Text).data)) texts.push(n as Text);
  tokenRe.lastIndex = 0;
  for (const text of texts) {
    const inCode = !!text.parentElement?.closest('code, pre');
    const parts: Node[] = [];
    let last = 0;
    for (const m of text.data.matchAll(tokenRe)) {
      if (m.index > last) parts.push(inert.createTextNode(text.data.slice(last, m.index)));
      const link = byToken.get(m[0]);
      if (link) parts.push(inCode ? inert.createTextNode(link.literal) : buildLink(inert, link, opts, known));
      last = m.index + m[0].length;
    }
    if (last < text.data.length) parts.push(inert.createTextNode(text.data.slice(last)));
    text.replaceWith(...parts);
  }

  el.appendChild(sanitizeHTMLToDom(root.innerHTML));
  // Wide tables scroll inside the bubble instead of widening it.
  el.querySelectorAll<HTMLTableElement>('table').forEach((table) => {
    const wrapper = el.ownerDocument.createElement('div');
    wrapper.className = 'ct-table-scroll';
    table.parentNode?.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  });
}

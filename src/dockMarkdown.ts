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

/**
 * Rewrites thread links (resolved + normalised by the model) and generic wikilinks into empty anchors
 * carrying only data attributes, before markdown runs. `thread:` markers go first: same regex shape.
 */
export function rewriteDockMarkup(markdown: string, threads: readonly ThreadRef[] = []): string {
  return rewriteThreadLinks(markdown, threads).replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_m, target: string, alias?: string) => {
      if (target.startsWith('thread:')) {
        const id = target.slice('thread:'.length).trim();
        return `<a class="ct-thread-link" data-thread-id="${escapeAttr(id)}" data-label="${escapeAttr((alias ?? '').trim())}" href="#"></a>`;
      }
      const label = (alias ?? target.split('/').pop() ?? target).trim();
      return `<a class="internal-link" data-href="${escapeAttr(target.trim())}" data-label="${escapeAttr(label)}" href="#"></a>`;
    },
  );
}

export async function renderDockMarkdown(markdown: string, el: HTMLElement, opts: { threads: readonly ThreadRef[] }): Promise<void> {
  const html = await marked.parse(rewriteDockMarkup(markdown, opts.threads));
  const fragment = sanitizeHTMLToDom(html);
  el.appendChild(fragment);
  el.querySelectorAll<HTMLAnchorElement>('a.ct-thread-link, a.internal-link').forEach((a) => {
    const id = a.getAttribute('data-thread-id');
    // If a sanitizer ever strips data-label the link must not go blank: fall back to the thread title.
    const label = a.getAttribute('data-label') || opts.threads.find((t) => t.id === id)?.title || id || a.getAttribute('data-href') || '';
    a.removeAttribute('data-label');
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

import { marked } from 'marked';
import { sanitizeHTMLToDom } from 'obsidian';

// SPIKE (S1): standalone markdown renderer for the OrchestratorDock. Must not import ThreadsView.
const escapeHtml = (s: string): string =>
  s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] ?? c));

/** Rewrites `[[thread:<id>|Title]]` then generic `[[target|alias]]` into inline anchors (pre-marked). */
export function rewriteDockWikilinks(markdown: string): string {
  return markdown.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_m, target: string, alias?: string) => {
      if (target.startsWith('thread:')) {
        const id = target.slice('thread:'.length).trim();
        const label = escapeHtml(alias ?? id);
        return `<a class="ct-thread-link" data-thread-id="${escapeHtml(id)}" href="#">${label}</a>`;
      }
      const label = escapeHtml(alias ?? target.split('/').pop() ?? target);
      return `<a class="internal-link" data-href="${escapeHtml(target)}" href="#">${label}</a>`;
    },
  );
}

export async function renderDockMarkdown(markdown: string, el: HTMLElement): Promise<void> {
  el.appendChild(sanitizeHTMLToDom(await marked.parse(rewriteDockWikilinks(markdown))));
}

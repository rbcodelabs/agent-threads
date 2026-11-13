/**
 * dockMarkdown.ts
 *
 * The dock's name for the shared renderer's strict link policy (src/messageRenderer/strict.ts). Kept as a thin
 * wrapper so the dock and its tests keep one stable entry point; new code should call `renderMarkdown` with
 * `linkPolicy: 'strict'`.
 */
import { renderStrictMarkdown, type StrictMarkdownOptions } from './messageRenderer/strict';

export { rewriteDockMarkup, isSafeHref, type DockLink } from './messageRenderer/strict';
export type DockMarkdownOptions = StrictMarkdownOptions;

export function renderDockMarkdown(markdown: string, el: HTMLElement, opts: DockMarkdownOptions): Promise<void> {
  return renderStrictMarkdown(markdown, el, opts);
}

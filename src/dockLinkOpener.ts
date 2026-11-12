/**
 * dockLinkOpener.ts
 *
 * Opening a `[[note]]` wikilink from the OrchestratorDock reply sheet. The Agent Board is the ACTIVE leaf, so
 * `workspace.openLinkText(href, '', false)` would replace the board and destroy the dock and its open sheet.
 * Links therefore open in a new tab (or through the context panel in conversation-first layouts, like
 * ThreadsView), and a link that does not resolve opens nothing at all (opening it would create an empty note).
 * Host-injected deps keep this unit-testable; no `obsidian` import.
 */
export interface DockLinkDeps {
  /** metadataCache.getFirstLinkpathDest(linkpath, sourcePath) */
  getFirstLinkpathDest(linkpath: string, sourcePath: string): unknown;
  isConversationFirst(): boolean;
  openInContextPanel(href: string, sourcePath: string): void;
  /** workspace.openLinkText(href, sourcePath, newLeaf) */
  openLinkText(href: string, sourcePath: string, newLeaf: 'tab'): void;
}

/** `Note#Heading`, `Note#^block`, `Note|alias` -> `Note` */
export function linkpathOf(href: string): string {
  return href.split('#')[0].split('|')[0].trim();
}

export function canOpenDockLink(deps: Pick<DockLinkDeps, 'getFirstLinkpathDest'>, href: string): boolean {
  const path = linkpathOf(href);
  return path !== '' && !!deps.getFirstLinkpathDest(path, '');
}

export function openDockLink(deps: DockLinkDeps, href: string): void {
  if (!canOpenDockLink(deps, href)) return;
  if (deps.isConversationFirst()) deps.openInContextPanel(href, '');
  else deps.openLinkText(href, '', 'tab');
}

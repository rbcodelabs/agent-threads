/**
 * Shared link-opening behavior: prefer Obsidian's in-app Web Viewer when the
 * core plugin is enabled, otherwise fall back to the system browser. Isolated
 * here (with injected deps) so the branch logic is unit-testable without a real
 * Obsidian workspace or electron.
 */
import type { App, WorkspaceLeaf } from 'obsidian';

/** Whether a rendered Markdown href represents vault navigation. */
export function classifyRenderedMarkdownLink(href: string): 'vault' | 'external' {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return 'external';
  // Any URI scheme (http:, mailto:, obsidian:, file:, data:, etc.) remains
  // under the host/browser's ordinary external-link behavior.
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return 'external';
  return 'vault';
}

/**
 * Whether `href` looks like an OS-absolute filesystem path (unix "/..." or
 * Windows "C:\..."). Call sites use this to tell "this was a filesystem path
 * we failed to map into the vault" apart from "this was an ordinary relative
 * link" — the former must not be forwarded to the host's link-opening APIs,
 * which would treat it as an unresolved vault link.
 *
 * Note that `classifyRenderedMarkdownLink` already routes Windows drive
 * letters to 'external' (the drive letter parses as a URI scheme), so in
 * practice only the unix branch is reachable from the rendered-markdown call
 * sites. The Windows branch is kept for direct callers and future use.
 */
export function isOsAbsoluteHref(href: string): boolean {
  return /^(\/|[a-zA-Z]:[\\/])/.test(href.trim());
}

/**
 * If `href` looks like an OS-absolute path (unix "/..." or Windows "C:\..."),
 * resolve it to a vault-relative path by probing successively shorter path
 * suffixes against `exists` (typically `app.vault.getAbstractFileByPath`).
 * Returns null if href isn't absolute-looking, or no suffix resolves.
 *
 * marked percent-encodes hrefs, so a path containing a space arrives as
 * `.../Claude%20Threads/notes.md` while the vault index holds the literal
 * `Agent Threads/notes.md`. Each suffix is therefore probed both raw and
 * percent-decoded — raw first, so a file whose real name legitimately
 * contains a "%20" still wins over the decoded interpretation. (That
 * precedence holds for what this function returns; a caller that decodes
 * again downstream can still collapse the two.)
 *
 * A trailing `#heading` / `#^block` subpath is split off before probing —
 * otherwise it would be glued onto the final path segment and no candidate
 * would ever match the vault index — then reattached to the resolved path so
 * the open call can still scroll to the target. The subpath is decoded on
 * reattach: marked encodes `#^block` as `#%5Eblock` and `#My Heading` as
 * `#My%20Heading`, and nothing downstream decodes the subpath (Obsidian's
 * parseLinktext splits it off, and ContextPanelController decodes only the
 * path half), so an encoded subpath would never match its target.
 */
export function resolveAbsoluteVaultHref(href: string, exists: (path: string) => boolean): string | null {
  const trimmed = href.trim();
  if (!isOsAbsoluteHref(trimmed)) return null;
  const hash = trimmed.indexOf('#');
  const pathPart = hash === -1 ? trimmed : trimmed.slice(0, hash);
  let subpath = hash === -1 ? '' : trimmed.slice(hash);
  if (subpath) {
    try { subpath = decodeURIComponent(subpath); } catch { /* malformed escape — keep raw */ }
  }
  const segments = pathPart.replace(/\\/g, '/').split('/').filter(Boolean);
  for (let start = 0; start < segments.length; start++) {
    const candidate = segments.slice(start).join('/');
    if (exists(candidate)) return candidate + subpath;
    let decoded: string | null = null;
    try { decoded = decodeURIComponent(candidate); } catch { /* malformed escape — raw probe stands */ }
    if (decoded !== null && decoded !== candidate && exists(decoded)) return decoded + subpath;
  }
  return null;
}

/**
 * Ask the host to open an absolute filesystem path the way it would handle a
 * clicked local-file link, returning false when it has no such concept.
 *
 * Geode can open a path that lives inside a Project folder the user attached
 * read-only, showing it in its in-app read-only viewer. The plugin cannot make
 * that decision itself: the host deliberately keeps attached-root identity
 * private, so an absolute path is all we have and only the host can map it.
 * Obsidian has no equivalent, so there the call simply reports "not handled"
 * and the caller keeps its existing OS fallback.
 */
export async function openLocalFileViaHost(app: App, absolutePath: string): Promise<boolean> {
  const open = (app as unknown as { openLocalFileLink?: (href: string) => Promise<string | void> })
    .openLocalFileLink;
  if (typeof open !== 'function') return false;
  try {
    // Older hosts resolve to undefined; treat that as handled, since they still
    // route the path themselves. Only an explicit "rejected" hands it back.
    return (await open.call(app, absolutePath)) !== 'rejected';
  } catch {
    return false;
  }
}

export interface OpenUrlDeps {
  /** Whether the Web Viewer core plugin is enabled. */
  webViewerEnabled: boolean;
  /** Open the URL in the system browser (electron shell.openExternal). */
  openExternal: (url: string) => void;
  /** Explicit native leaf selected by conversation-first contextual routing. */
  destinationLeaf?: WorkspaceLeaf;
}

/**
 * Open a user-selected `url`, preferring a fresh Web Viewer tab when enabled.
 * Falls back to the system browser when the Web Viewer is disabled or fails to
 * load. Returns the path taken (for tests).
 */
export function openUrlPreferringWebViewer(app: App, url: string, deps: OpenUrlDeps): 'webviewer' | 'external' {
  if (!deps.webViewerEnabled) {
    deps.openExternal(url);
    return 'external';
  }
  try {
    const ws = app.workspace;
    const leaf = deps.destinationLeaf ?? ws.getLeaf('tab');
    ws.revealLeaf(leaf);
    void Promise.resolve(leaf.setViewState({ type: 'webviewer', active: true, state: { url } }))
      .catch(() => deps.openExternal(url));
    return 'webviewer';
  } catch {
    deps.openExternal(url);
    return 'external';
  }
}

/** Minimal shape of electron's `shell` that {@link openOAuthConsentUrl} needs. */
export interface ExternalShellLike {
  openExternal?: (url: string) => void | Promise<void>;
}

export interface OpenConsentUrlDeps {
  /**
   * Resolve electron's `shell`, or null/undefined when unavailable (mobile, or a
   * renderer without node integration). Injected rather than `require`d here so
   * the branch is testable without electron present.
   */
  resolveShell: () => ExternalShellLike | null | undefined;
  /** Last-resort opener when no electron shell exists — typically `window.open`. */
  fallbackOpen: (url: string) => void;
}

/** Which surface actually received the consent URL. */
export type ConsentUrlTarget = 'system-browser' | 'fallback';

/**
 * Open an OAuth consent URL in the **system browser**, never an in-app Web
 * Viewer tab.
 *
 * This is deliberately *not* `openUrlPreferringWebViewer`. Two reasons:
 *
 * 1. **Reachability.** Interactive registration runs behind a modal host
 *    confirmation dialog. A Web Viewer tab opens *inside* the workspace, so the
 *    consent page renders behind that modal where it cannot be clicked — the
 *    flow deadlocks with the page loaded but unreachable.
 * 2. **Auth state lives in the real browser.** Consent normally depends on an
 *    existing SSO session, a passkey, or a password manager. A fresh in-app
 *    Web Viewer partition has none of them, forcing a from-scratch login that
 *    may not even be completable (hardware keys, IdP device checks).
 *
 * The loopback callback is unaffected: `OAuthMcpFlow` serves it from a local
 * HTTP server on 127.0.0.1, which any external browser can reach, and it
 * already renders a self-closing success page written for exactly that case.
 */
export async function openOAuthConsentUrl(url: string, deps: OpenConsentUrlDeps): Promise<ConsentUrlTarget> {
  let shell: ExternalShellLike | null | undefined;
  try {
    shell = deps.resolveShell();
  } catch {
    shell = null;
  }
  if (shell?.openExternal) {
    // `shell.openExternal` returns a promise on modern electron but is typed
    // loosely across versions; awaiting a plain `undefined` is harmless and
    // means a rejected open surfaces to the caller instead of going unhandled.
    await shell.openExternal(url);
    return 'system-browser';
  }
  deps.fallbackOpen(url);
  return 'fallback';
}

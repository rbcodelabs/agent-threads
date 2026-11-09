import { FileSystemAdapter, type App } from 'obsidian';

/**
 * Resource URL for a vault-relative file on desktop, or null when it cannot be
 * resolved (mobile, a host adapter without getResourcePath, or a throw).
 */
export function vaultResourceUrl(app: App, path: string): string | null {
  const adapter = app?.vault?.adapter;
  if (adapter instanceof FileSystemAdapter) {
    try {
      return adapter.getResourcePath(path);
    } catch {
      // Fall through: the caller decides on a fallback.
    }
  }
  return null;
}

/**
 * Resolve an <img> src for a message image (ADR-0003, PR 1). When the image
 * has been externalized to a vault file (`path` set) and we're on desktop,
 * use the synchronous resource URL so the render stays synchronous and doesn't
 * depend on the inline base64 (which is stripped from data.json after a
 * restart). Otherwise fall back to the inline base64 data URL, including on
 * mobile, where a desktop attachment path can't be resolved.
 *
 * Shared by ThreadsView (conversation) and KanbanView (Gallery mode).
 */
export function resolveImageSrc(
  app: App,
  ref: { path?: string; mediaType: string },
  inlineData: string | undefined,
): string {
  if (ref.path) {
    const url = vaultResourceUrl(app, ref.path);
    if (url) return url;
  }
  return `data:${ref.mediaType};base64,${inlineData ?? ''}`;
}

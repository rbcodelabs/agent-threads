import { describe, it, expect, vi } from 'vitest';
import { classifyRenderedMarkdownLink, isOsAbsoluteHref, openOAuthConsentUrl, openUrlPreferringWebViewer, resolveAbsoluteVaultHref } from '../../src/linkUtils';
import type { App } from 'obsidian';

function fakeApp(opts: { existingWebviewer?: boolean } = {}) {
  const existingSetViewState = vi.fn(() => Promise.resolve());
  const newSetViewState = vi.fn(() => Promise.resolve());
  const reveal = vi.fn();
  const existingLeaf = { setViewState: existingSetViewState };
  const newLeaf = { setViewState: newSetViewState };
  const ws = {
    getLeavesOfType: vi.fn((t: string) => (opts.existingWebviewer && t === 'webviewer' ? [existingLeaf] : [])),
    getLeaf: vi.fn(() => newLeaf),
    revealLeaf: reveal,
  };
  return {
    app: { workspace: ws } as unknown as App,
    setViewState: newSetViewState,
    existingSetViewState,
    reveal,
    ws,
    existingLeaf,
    newLeaf,
  };
}

describe('openUrlPreferringWebViewer', () => {
  it('opens externally when the Web Viewer is disabled', () => {
    const { app, setViewState } = fakeApp();
    const openExternal = vi.fn();
    const path = openUrlPreferringWebViewer(app, 'https://x/pull/1', { webViewerEnabled: false, openExternal });
    expect(path).toBe('external');
    expect(openExternal).toHaveBeenCalledWith('https://x/pull/1');
    expect(setViewState).not.toHaveBeenCalled();
  });

  it('forces the system browser (Cmd/Ctrl-click) even with a Web Viewer tab open', () => {
    // Cmd-click maps to webViewerEnabled:false; it must NOT reuse an open viewer tab.
    const { app, setViewState, ws } = fakeApp({ existingWebviewer: true });
    const openExternal = vi.fn();
    const path = openUrlPreferringWebViewer(app, 'https://x/pull/9', { webViewerEnabled: false, openExternal });
    expect(path).toBe('external');
    expect(openExternal).toHaveBeenCalledWith('https://x/pull/9');
    expect(setViewState).not.toHaveBeenCalled();
    expect(ws.getLeavesOfType).not.toHaveBeenCalled();
  });

  it('opens in the Web Viewer when enabled (new tab) and does not open externally', () => {
    const { app, setViewState, reveal, ws } = fakeApp({ existingWebviewer: false });
    const openExternal = vi.fn();
    const path = openUrlPreferringWebViewer(app, 'https://x/pull/2', { webViewerEnabled: true, openExternal });
    expect(path).toBe('webviewer');
    expect(ws.getLeaf).toHaveBeenCalledWith('tab');
    expect(reveal).toHaveBeenCalled();
    expect(setViewState).toHaveBeenCalledWith({ type: 'webviewer', active: true, state: { url: 'https://x/pull/2' } });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens a fresh tab and preserves an existing webviewer tab', () => {
    const { app, ws, existingSetViewState, setViewState } = fakeApp({ existingWebviewer: true });
    const openExternal = vi.fn();
    openUrlPreferringWebViewer(app, 'https://x', { webViewerEnabled: true, openExternal });
    expect(ws.getLeaf).toHaveBeenCalledWith('tab');
    expect(existingSetViewState).not.toHaveBeenCalled();
    expect(setViewState).toHaveBeenCalledWith({ type: 'webviewer', active: true, state: { url: 'https://x' } });
  });

  it('uses a caller-selected contextual leaf instead of an unrelated webviewer tab', () => {
    const { app, ws, existingLeaf } = fakeApp({ existingWebviewer: true });
    const contextualLeaf = { setViewState: vi.fn().mockResolvedValue(undefined) };
    const openExternal = vi.fn();

    openUrlPreferringWebViewer(app, 'https://x/context', {
      webViewerEnabled: true,
      openExternal,
      destinationLeaf: contextualLeaf as never,
    });

    expect(ws.getLeavesOfType).not.toHaveBeenCalled();
    expect(existingLeaf.setViewState).not.toHaveBeenCalled();
    expect(contextualLeaf.setViewState).toHaveBeenCalledWith({
      type: 'webviewer',
      active: true,
      state: { url: 'https://x/context' },
    });
  });

  it('falls back to external when the workspace throws', () => {
    const ws = {
      getLeavesOfType: () => { throw new Error('no webviewer'); },
      getLeaf: vi.fn(),
      revealLeaf: vi.fn(),
    };
    const app = { workspace: ws } as unknown as App;
    const openExternal = vi.fn();
    const path = openUrlPreferringWebViewer(app, 'https://x', { webViewerEnabled: true, openExternal });
    expect(path).toBe('external');
    expect(openExternal).toHaveBeenCalledWith('https://x');
  });
});

describe('classifyRenderedMarkdownLink', () => {
  it.each(['Notes/Plan.md', '../Plans/Roadmap%20Q4.md#Decision', 'Daily/Today#^block'])('classifies %s as a vault link', (href) => {
    expect(classifyRenderedMarkdownLink(href)).toBe('vault');
  });

  it.each(['https://example.com', 'mailto:team@example.com', 'obsidian://open?vault=x', 'tel:+15551212', '#same-page', 'file:///tmp/a.md'])('keeps %s outside vault routing', (href) => {
    expect(classifyRenderedMarkdownLink(href)).toBe('external');
  });
});

describe('resolveAbsoluteVaultHref', () => {
  it('resolves an OS-absolute unix path to the shortest existing vault-relative suffix', () => {
    const exists = (p: string) => ['Products/Geode/Runs/geode-2026-09-01-architecture-review.md', 'geode-2026-09-01-architecture-review.md'].includes(p);
    const href = '/Users/rickbowman/Library/Mobile Documents/com~apple~CloudDocs/Documents/Personal/Products/Geode/Runs/geode-2026-09-01-architecture-review.md';
    expect(resolveAbsoluteVaultHref(href, exists)).toBe('Products/Geode/Runs/geode-2026-09-01-architecture-review.md');
  });

  it('returns null when no suffix of an absolute path resolves', () => {
    const exists = () => false;
    expect(resolveAbsoluteVaultHref('/Users/rick/Documents/Personal/nope.md', exists)).toBeNull();
  });

  it('returns null for an already vault-relative href, even if exists would match', () => {
    const exists = () => true;
    expect(resolveAbsoluteVaultHref('Notes/Plan.md', exists)).toBeNull();
  });

  it('resolves a Windows-style absolute path', () => {
    const exists = (p: string) => p === 'Docs/note.md';
    expect(resolveAbsoluteVaultHref('C:\\Users\\rick\\Vault\\Docs\\note.md', exists)).toBe('Docs/note.md');
  });

  it('returns the longest matching suffix, not just any match', () => {
    const exists = (p: string) => ['Docs/note.md', 'note.md'].includes(p);
    expect(resolveAbsoluteVaultHref('/Users/rick/Vault/Docs/note.md', exists)).toBe('Docs/note.md');
  });

  // marked percent-encodes hrefs, so a vault path containing a space arrives
  // as "Claude%20Threads" while the vault index holds the literal space.
  it('resolves a percent-encoded space inside the vault-relative portion', () => {
    const exists = (p: string) => p === 'Products/Claude Threads/notes.md';
    const href = '/Users/rick/Library/Mobile%20Documents/Personal/Products/Claude%20Threads/notes.md';
    expect(resolveAbsoluteVaultHref(href, exists)).toBe('Products/Claude Threads/notes.md');
  });

  it('prefers a raw match over the decoded one when a filename really contains %20', () => {
    const exists = (p: string) => p === 'Docs/odd%20name.md';
    expect(resolveAbsoluteVaultHref('/Users/rick/Vault/Docs/odd%20name.md', exists)).toBe('Docs/odd%20name.md');
  });

  it('survives a malformed percent-escape without throwing', () => {
    const exists = (p: string) => p === 'Docs/100%.md';
    expect(resolveAbsoluteVaultHref('/Users/rick/Vault/Docs/100%.md', exists)).toBe('Docs/100%.md');
  });

  // A trailing #subpath must be split off before probing: glued onto the final
  // segment it makes every candidate ("Notes/Plan.md#Decision") miss the vault
  // index, so the whole link silently fails to resolve.
  it('splits a #heading subpath before probing and reattaches it', () => {
    const exists = (p: string) => p === 'Notes/Plan.md';
    expect(resolveAbsoluteVaultHref('/Users/rick/Vault/Notes/Plan.md#Decision', exists))
      .toBe('Notes/Plan.md#Decision');
  });

  it('splits a #^block subpath before probing and reattaches it', () => {
    const exists = (p: string) => p === 'Daily/Today.md';
    expect(resolveAbsoluteVaultHref('/Users/rick/Vault/Daily/Today.md#^abc123', exists))
      .toBe('Daily/Today.md#^abc123');
  });

  it('handles a subpath alongside a percent-encoded space', () => {
    const exists = (p: string) => p === 'Products/Claude Threads/notes.md';
    expect(resolveAbsoluteVaultHref('/Users/rick/Mobile%20Documents/Products/Claude%20Threads/notes.md#Section', exists))
      .toBe('Products/Claude Threads/notes.md#Section');
  });

  it('returns null when the path resolves nowhere even though it carries a subpath', () => {
    expect(resolveAbsoluteVaultHref('/Users/rick/elsewhere/gone.md#Heading', () => false)).toBeNull();
  });
});

describe('isOsAbsoluteHref', () => {
  it.each(['/Users/rick/note.md', '/tmp/x.md', 'C:\\Users\\rick\\note.md', 'C:/Users/rick/note.md'])(
    'treats %s as an OS-absolute path',
    (href) => { expect(isOsAbsoluteHref(href)).toBe(true); },
  );

  it.each(['Notes/Plan.md', '../Projects/Roadmap.md', 'Daily/Today#^block', '', '#anchor'])(
    'treats %s as not OS-absolute',
    (href) => { expect(isOsAbsoluteHref(href)).toBe(false); },
  );
});

describe('openOAuthConsentUrl', () => {
  const CONSENT = 'https://as.example.com/authorize?client_id=abc&state=xyz';

  it('opens the consent URL in the system browser via electron shell', async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    const fallbackOpen = vi.fn();

    const target = await openOAuthConsentUrl(CONSENT, {
      resolveShell: () => ({ openExternal }),
      fallbackOpen,
    });

    expect(target).toBe('system-browser');
    expect(openExternal).toHaveBeenCalledWith(CONSENT);
    expect(fallbackOpen).not.toHaveBeenCalled();
  });

  // The regression this whole helper exists for: interactive registration runs
  // behind a modal confirmation dialog, so a Web Viewer tab would render behind
  // it and be unreachable. Nothing here may touch the workspace.
  it('never opens a Web Viewer leaf or otherwise touches the workspace', async () => {
    const { setViewState, existingSetViewState, reveal, ws } = fakeApp({ existingWebviewer: true });

    await openOAuthConsentUrl(CONSENT, {
      resolveShell: () => ({ openExternal: vi.fn(() => Promise.resolve()) }),
      fallbackOpen: vi.fn(),
    });

    expect(setViewState).not.toHaveBeenCalled();
    expect(existingSetViewState).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
    expect(ws.getLeavesOfType).not.toHaveBeenCalled();
    expect(ws.getLeaf).not.toHaveBeenCalled();
  });

  it('awaits a promise-returning openExternal so a rejected open surfaces', async () => {
    const openExternal = vi.fn(() => Promise.reject(new Error('no handler for https')));

    await expect(openOAuthConsentUrl(CONSENT, {
      resolveShell: () => ({ openExternal }),
      fallbackOpen: vi.fn(),
    })).rejects.toThrow('no handler for https');
  });

  it('tolerates a void-returning openExternal (older electron typings)', async () => {
    const openExternal = vi.fn((): void => undefined);

    const target = await openOAuthConsentUrl(CONSENT, {
      resolveShell: () => ({ openExternal }),
      fallbackOpen: vi.fn(),
    });

    expect(target).toBe('system-browser');
    expect(openExternal).toHaveBeenCalledWith(CONSENT);
  });

  // Mobile / no-node-integration renderer: `require('electron')` is absent or
  // throws. The flow must still hand the URL somewhere rather than dead-ending.
  it.each([
    ['shell is null', () => null],
    ['shell is undefined', () => undefined],
    ['shell lacks openExternal', () => ({}) as { openExternal?: never }],
    ['resolveShell throws', () => { throw new Error("Cannot find module 'electron'"); }],
  ])('falls back to the injected opener when %s', async (_label, resolveShell) => {
    const fallbackOpen = vi.fn();

    const target = await openOAuthConsentUrl(CONSENT, { resolveShell, fallbackOpen });

    expect(target).toBe('fallback');
    expect(fallbackOpen).toHaveBeenCalledWith(CONSENT);
  });
});

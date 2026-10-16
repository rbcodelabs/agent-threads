import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Notice } from 'obsidian';
import { ThreadsView } from '../../src/ThreadsView';

type TestView = ThreadsView & {
  openEditedFile(filePath: string): Promise<void>;
};

function makeView(options: {
  webViewerEnabled?: boolean;
  vaultBase?: string;
  vaultFiles?: Record<string, object>;
  /** Present only on hosts that route local-file links themselves (Geode). */
  openLocalFileLink?: (href: string) => Promise<string | void>;
} = {}) {
  const vaultFiles = options.vaultFiles ?? {};
  const openLink = vi.fn();
  const openFile = vi.fn().mockResolvedValue(undefined);
  const getAbstractFileByPath = vi.fn((filePath: string) => vaultFiles[filePath] ?? null);
  const view = Object.assign(Object.create(ThreadsView.prototype), {
    app: {
      internalPlugins: {
        plugins: { webviewer: { enabled: options.webViewerEnabled ?? true } },
      },
      vault: {
        adapter: { basePath: options.vaultBase ?? '/vault' },
        getAbstractFileByPath,
      },
      workspace: { getLeaf: vi.fn(() => ({ openFile })) },
      ...(options.openLocalFileLink ? { openLocalFileLink: options.openLocalFileLink } : {}),
    },
    plugin: {
      isConversationFirst: () => false,
      contextPanel: { openFile: vi.fn() },
    },
    openLink,
    getBridges: () => [],
  }) as TestView;

  return { view, openLink, openFile, getAbstractFileByPath };
}


describe('ThreadsView.openEditedFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Notice.messages = [];
  });

  it.each([
    ['/tmp/report.html', 'file:///tmp/report.html'],
    ['/tmp/report.HTM', 'file:///tmp/report.HTM'],
  ])('opens external HTML path %s in the Web Viewer', async (filePath, expectedUrl) => {
    const { view, openLink, openFile } = makeView();

    await view.openEditedFile(filePath);

    expect(openLink).toHaveBeenCalledWith(expectedUrl);
    expect(openFile).not.toHaveBeenCalled();
  });

  it('continues to open vault HTML in the Web Viewer', async () => {
    const file = {};
    const { view, openLink, openFile } = makeView({
      vaultFiles: { 'docs/report.html': file },
    });

    await view.openEditedFile('/vault/docs/report.html');

    expect(openLink).toHaveBeenCalledWith('file:///vault/docs/report.html');
    expect(openFile).not.toHaveBeenCalled();
  });

  /**
   * A chip for a file the agent edited in its Project working directory used to
   * go straight to the OS default application. On Geode that ignored an
   * attached read-only Project root, so the file bounced out of the app even
   * though the same file opened in Geode's read-only viewer when reached
   * through the Projects tree.
   */
  describe('outside the vault', () => {
    it('lets the host route a Project file instead of handing it to the OS', async () => {
      const openLocalFileLink = vi.fn().mockResolvedValue('external-resource');
      const { view, openFile } = makeView({ openLocalFileLink });

      await view.openEditedFile('/Users/me/projects/compass/docs/note.md');

      expect(openLocalFileLink).toHaveBeenCalledWith('/Users/me/projects/compass/docs/note.md');
      expect(openFile).not.toHaveBeenCalled();
      // Reaching the OS fallback would fail on `require('electron')` here.
      expect(Notice.messages).toEqual([]);
    });

    it('treats a host with no local-file routing (Obsidian) as unhandled', async () => {
      const { view } = makeView();

      await view.openEditedFile('/Users/me/projects/compass/docs/note.md');

      // No host route, so the OS fallback runs; `electron` is absent under
      // vitest, and the failure is surfaced rather than swallowed silently.
      expect(Notice.messages).toHaveLength(1);
    });

    it('falls back to the OS when the host explicitly rejects the path', async () => {
      const openLocalFileLink = vi.fn().mockResolvedValue('rejected');
      const { view } = makeView({ openLocalFileLink });

      await view.openEditedFile('/Users/me/projects/compass/docs/note.md');

      expect(openLocalFileLink).toHaveBeenCalledOnce();
      expect(Notice.messages).toHaveLength(1);
    });

    it('still prefers a vault file over host routing', async () => {
      const openLocalFileLink = vi.fn().mockResolvedValue('external-resource');
      const { view, openFile } = makeView({
        openLocalFileLink,
        vaultFiles: { 'docs/note.md': {} },
      });

      await view.openEditedFile('/vault/docs/note.md');

      expect(openFile).toHaveBeenCalledOnce();
      expect(openLocalFileLink).not.toHaveBeenCalled();
    });
  });
});

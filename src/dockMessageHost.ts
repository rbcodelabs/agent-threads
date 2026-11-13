/**
 * dockMessageHost.ts
 *
 * The app-side half of the dock sheet's message rendering (see dockMessageEnv.ts): how to open a URL, confirm an
 * outside-vault path, list bridges, format the clock and read the tool-call style. These mirror what ThreadsView does
 * for the main panel (openLink, confirmOpenOutsideVaultLink, getBridges, formatShortTime, toolPathContext), so a link
 * in the sheet behaves like the same link in the conversation. Built by KanbanView.
 */
import { Notice, type App } from 'obsidian';
import type ClaudeThreadsPlugin from './main';
import type { ThreadManager } from './ThreadManager';
import type { DockMessageHostDeps } from './dockMessageEnv';
import { formatShortTime } from './dockMessageEnv';
import { getVaultBridgesAPI, type BridgeInfo } from './bridgeUtils';
import { isWebViewerEnabled } from './SettingsTab';
import { ContextPanelViewError } from './ContextPanelController';
import { openLocalFileViaHost, openUrlPreferringWebViewer } from './linkUtils';
import { OutsideVaultLinkModal } from './OutsideVaultLinkModal';
import { RemoteImageCache, createRemoteImageLoader } from './remote/remoteImages';
import { normalizeToolCallStyle } from './toolNameUtils';

export function createDockMessageHostDeps(app: App, plugin: ClaudeThreadsPlugin, manager: Pick<ThreadManager, 'getThread'>): DockMessageHostDeps {
  const remoteImageCache = new RemoteImageCache();

  /** ThreadsView.openLink: the Web Viewer (or the context panel in conversation-first layouts) unless Cmd/Ctrl-click, else the system browser. */
  const openExternal = async (url: string, forceExternal: boolean): Promise<void> => {
    let webViewerEnabled = !forceExternal && isWebViewerEnabled(app);
    if (webViewerEnabled && plugin.isConversationFirst()) {
      try {
        await plugin.contextPanel.setViewStateInNewTab({ type: 'webviewer', active: true, state: { url } });
        return;
      } catch (error) {
        if (error instanceof ContextPanelViewError) webViewerEnabled = false;
        else {
          new Notice(`Could not open contextual link: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
      }
    }
    openUrlPreferringWebViewer(app, url, {
      webViewerEnabled,
      openExternal: (u) => {
        const { shell } = require('electron') as { shell: { openExternal: (url: string) => void } };
        shell.openExternal(u);
      },
    });
  };

  return {
    vaultHas: (p) => !!app.vault.getAbstractFileByPath(p),
    bridges: (): BridgeInfo[] => {
      try { return getVaultBridgesAPI(app)?.getBridges() ?? []; } catch { return []; }
    },
    openExternal: (url, forceExternal) => { void openExternal(url, forceExternal); },
    confirmOutsideVault: (href) => {
      new OutsideVaultLinkModal(app, href, {
        open: async (path) => {
          try {
            if (await openLocalFileViaHost(app, path)) return;
            const { shell } = require('electron') as { shell: { openPath: (p: string) => Promise<string> } };
            const err = await shell.openPath(path);
            if (err) new Notice(`Could not open file: ${err}`);
          } catch (err) {
            new Notice(`Could not open file: ${(err as Error).message}`);
          }
        },
        reveal: (path) => {
          try {
            const { shell } = require('electron') as { shell: { showItemInFolder: (path: string) => void } };
            shell.showItemInFolder(path);
          } catch {
            new Notice('Reveal is not available here.');
          }
        },
        copy: async (path) => {
          try {
            await navigator.clipboard.writeText(path);
            new Notice('Path copied.');
          } catch {
            new Notice('Could not copy the path.');
          }
        },
      }).open();
    },
    formatTime: formatShortTime,
    toolPathContext: () => {
      const adapter = app.vault.adapter as { basePath?: string };
      const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
      return { vaultRoot: adapter.basePath || undefined, home: proc?.env?.HOME || undefined };
    },
    toolCallStyle: () => normalizeToolCallStyle(plugin.settings.toolCallStyle),
    remoteImageLoader: (threadId) => {
      const remote = manager.getThread(threadId)?.remote;
      return remote && plugin.daemonRegistry ? createRemoteImageLoader(plugin.daemonRegistry, remoteImageCache, remote.daemonId) : undefined;
    },
  };
}

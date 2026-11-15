import { debugLog } from '../logger';
import type {
  WebViewerFeedbackHandler,
  WebViewerFeedbackRegistration,
} from './contract';
import { createWebViewerFeedbackHandler, type WebViewerFeedbackHost } from './handler';
import { WebViewerSendCoordinator } from './sendCoordinator';

export interface WebViewerFeedbackDisposable {
  dispose(): void;
}

export interface GeodeWebViewerFeedbackPluginHost extends WebViewerFeedbackHost {
  readonly app?: {
    readonly webViewerFeedback?: {
      readonly contractVersions?: readonly number[];
    };
  };
  saveSettings?(): Promise<void>;
  registerWebViewerFeedbackHandler?: (
    handler: WebViewerFeedbackHandler,
  ) => WebViewerFeedbackRegistration;
}

/**
 * Registers Agent Threads as Geode's Web Viewer element feedback handler on desktop.
 * Silently returns `null` on Obsidian or older Geode builds lacking the API.
 */
export function registerWebViewerFeedback(
  plugin: GeodeWebViewerFeedbackPluginHost,
): WebViewerFeedbackDisposable | null {
  const registerFn = plugin.registerWebViewerFeedbackHandler;
  if (typeof registerFn !== 'function') {
    return null;
  }

  const advertisedVersions = plugin.app?.webViewerFeedback?.contractVersions;
  if (Array.isArray(advertisedVersions) && !advertisedVersions.includes(1)) {
    debugLog('[ClaudeThreads] Geode Web Viewer feedback contract v1 not supported by host:', advertisedVersions);
    return null;
  }

  const coordinator = new WebViewerSendCoordinator(plugin.manager, {
    onFlushed: () => {
      void plugin.saveSettings?.()?.catch?.(() => undefined);
    },
    onFlushError: (threadId, error) => {
      console.error(`[ClaudeThreads] Failed to flush queued Web Viewer feedback for thread ${threadId}:`, error);
    },
  });

  const handler = createWebViewerFeedbackHandler(plugin, coordinator);

  let registration: WebViewerFeedbackRegistration;
  try {
    registration = registerFn.call(plugin, handler);
  } catch (error) {
    coordinator.dispose();
    console.warn('[ClaudeThreads] registerWebViewerFeedbackHandler threw:', error);
    return null;
  }

  if (registration.status !== 'registered') {
    debugLog(
      `[ClaudeThreads] Web Viewer feedback handler not registered (${registration.status}): ${registration.message}`,
    );
    try {
      registration.dispose();
    } catch {
      // ignore host refusal dispose error
    }
    coordinator.dispose();
    return null;
  }

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        registration.dispose();
      } catch (error) {
        console.warn('[ClaudeThreads] Disposing Web Viewer feedback registration failed:', error);
      } finally {
        coordinator.dispose();
      }
    },
  };
}

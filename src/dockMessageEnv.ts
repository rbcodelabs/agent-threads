/**
 * dockMessageEnv.ts
 *
 * Everything the dock reply sheet needs to render a conversation IDENTICALLY to the main panel: the shared renderer's
 * MessageRenderHost (trusted link policy, built like ThreadsView.buildMessageRenderHost) and the shared tool-call
 * renderer with its own expand/collapse memory. The board (KanbanView) supplies the parts only the app knows
 * (`DockMessageHostDeps`: how to open a URL, confirm an outside-vault path, list bridges, the clock, the tool-call
 * style); the dock supplies the parts it owns (the orchestrator thread, thread and note opening).
 *
 * Two deliberate departures from the main panel's host, both because the sheet is a small overlay on top of the board:
 *  - visualizations are NOT hydrated (`visualize.enabled: false`). The sheet strips `visualize{...}` / `agent-content{...}`
 *    lines (dockSheetModel.stripVisualizeLines) and offers the "Open full thread" chip instead.
 *  - a `[[note]]` opens through the dock's own opener (never the active leaf, which is the board; unresolved links open
 *    nothing), see dockLinkOpener.ts.
 *
 * `[[thread:id|Title]]` composes with the trusted pipeline by PRE-REWRITING (orchestratorDockModel.rewriteThreadLinks):
 * a resolvable marker becomes `[[thread:<id>|label]]`, which the shared renderer turns into its ordinary
 * `a.internal-link[data-href="thread:<id>"]` (label escaped, sanitized like every other anchor); an unresolvable one
 * becomes its plain label. The host's `openLinkText` recognises the `thread:` prefix (threadIdOfHref) and opens that
 * thread; the sheet's delegated hover handler uses the same attribute for the card highlight. No attacker-controlled
 * text becomes an attribute: the id is one of the board's own thread ids, the label is escaped by the renderer.
 */
import type { BridgeInfo } from './bridgeUtils';
import type { ChatMessage } from './types';
import { ToolCallRenderer, createToolCallExpandState, type MessageRenderHost } from './messageRenderer';
import { DEFAULT_TOOL_CALL_STYLE, type ToolCallStyle, type ToolPathContext } from './toolNameUtils';
import { threadIdOfHref } from './orchestratorDockModel';

/** What only the host app (the Agent Board) knows. Every member is optional except the vault probe. */
export interface DockMessageHostDeps {
  /** Whether a vault-relative path exists right now (bridge-path linkification, absolute vault hrefs). */
  vaultHas(path: string): boolean;
  bridges?(): BridgeInfo[];
  /** http(s) links, and bare URLs in text. Absent: the browser's default anchor behavior and no URL linkification. */
  openExternal?(url: string, forceExternal: boolean): void;
  /** An absolute path outside the vault: offer (never auto-perform) opening it. */
  confirmOutsideVault?(href: string): void;
  formatTime?(timestamp: number): string;
  toolPathContext?(): ToolPathContext;
  toolCallStyle?(): ToolCallStyle;
  /** `(path) => data URL` for a remote thread's daemon; undefined when images are local. */
  remoteImageLoader?(threadId: string): ((path: string) => Promise<string | undefined>) | undefined;
}

export interface DockMessageEnv {
  /** A host for one render call; reads its dependencies lazily. */
  host(): MessageRenderHost;
  toolCalls: ToolCallRenderer;
  openExternal?(url: string, forceExternal: boolean): void;
  formatTime(timestamp: number): string;
  toolCallStyle(): ToolCallStyle;
  /** Aborts every in-flight remote-image hydration (the sheet was destroyed). */
  dispose(): void;
}

/** "3:45 PM", or "May 27, 3:45 PM" from another day: the same text the main panel shows (ThreadsView.formatShortTime). */
export function formatShortTime(timestamp: number): string {
  const d = new Date(timestamp);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

export interface DockMessageEnvInput {
  /** The orchestrator thread being drawn. */
  threadId(): string | undefined;
  getThread(id: string): { messages: ChatMessage[] } | undefined;
  /** A `[[note]]` / vault link (dockLinkOpener.openDockLink): never the active leaf, nothing for an unresolved link. */
  openNote(href: string): void;
  /** A `[[thread:<id>]]` link: opens that thread when the board knows it. */
  openThread(threadId: string): void;
  deps?: DockMessageHostDeps;
}

export function createDockMessageEnv(input: DockMessageEnvInput): DockMessageEnv {
  const deps = input.deps;
  const abort = new AbortController();
  const state = createToolCallExpandState();
  const formatTime = deps?.formatTime ?? formatShortTime;
  const toolCalls = new ToolCallRenderer({
    state,
    pathContext: () => deps?.toolPathContext?.() ?? {},
    formatTime,
    browser: () => null, // browser session cards live on the main panel; in the sheet a session is plain pills
  });
  return {
    toolCalls,
    openExternal: deps?.openExternal,
    formatTime,
    toolCallStyle: () => deps?.toolCallStyle?.() ?? DEFAULT_TOOL_CALL_STYLE,
    dispose: () => abort.abort(),
    host: () => {
      const threadId = input.threadId();
      return {
        signal: abort.signal,
        threadId: () => threadId,
        getThread: (id) => input.getThread(id),
        // Links resolve against nothing: the dock is not a note, and openDockLink resolves with ''.
        sourcePath: () => '',
        openLinkText: (target) => {
          const id = threadIdOfHref(target);
          if (id) input.openThread(id); else input.openNote(target);
        },
        openExternal: deps?.openExternal,
        confirmOutsideVault: (href) => deps?.confirmOutsideVault?.(href),
        vaultHas: (p) => deps?.vaultHas(p) ?? false,
        bridges: deps?.bridges,
        visualize: { enabled: false, streamingAware: true, hydrate: () => {} },
        remoteImageLoader: () => (threadId ? deps?.remoteImageLoader?.(threadId) : undefined),
      };
    },
  };
}

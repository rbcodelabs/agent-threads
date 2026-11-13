import type { BridgeInfo } from '../bridgeUtils';
import type { MessageContentMarker } from '../MessageContent';
import type { VisualizeMarker } from '../visualizeMarker';
import type { ChatMessage } from '../types';

/**
 * Everything a conversation surface (main panel, mobile, the dock sheet)
 * differs on when rendering markdown. The shared renderer holds no view state:
 * a host is built per render call and its methods are read lazily (link click
 * handlers call back into it long after the render returned).
 */
export interface MessageRenderHost {
  /** Aborted when the message is re-rendered or the view closes; nothing may be written to the DOM afterwards. */
  readonly signal: AbortSignal;
  /** Thread being rendered, read once at the start of a render. */
  threadId(): string | undefined;
  /** Minimal thread view: transcript lookup for message-content origin checks. */
  getThread(id: string): { messages: ChatMessage[] } | undefined;
  /** Note the wikilink/markdown link is resolved against, read at click time ('' when none). */
  sourcePath(): string;
  /**
   * Open vault linktext. `sourcePath` is omitted for bridge links, which
   * resolve against nothing. Conversation-first vs workspace routing lives in
   * the host.
   */
  openLinkText(target: string, sourcePath?: string): void;
  /**
   * Open an http(s) URL. When omitted the surface keeps the browser's default
   * anchor behavior and bare URLs in text are not linkified (mobile).
   */
  openExternal?(href: string, forceExternal: boolean): void;
  /** Offer (never auto-perform) opening an absolute path that is not in the vault. */
  confirmOutsideVault(href: string): void;
  /** Whether a vault-relative path exists right now. */
  vaultHas(path: string): boolean;
  /** Vault bridges for bridge-path linkification; omit to skip it. */
  bridges?(): BridgeInfo[];
  visualize: {
    /** False leaves `visualize{...}` lines as ordinary text. */
    enabled: boolean;
    /** Whether a trailing partial marker line is suppressed while streaming. */
    streamingAware: boolean;
    hydrate(el: HTMLElement, markers: VisualizeMarker[], options: { interactive: boolean }): void;
  };
  /** Extract message-content markers from every message, not just transcript/streaming ones (relay clients). */
  alwaysExtractMessageContent?: boolean;
  /** Mount contributed message content into the placeholders left by extraction. */
  hydrateMessageContent?(
    el: HTMLElement,
    markers: MessageContentMarker[],
    context: { threadId: string | undefined; messageId: string; signal: AbortSignal },
    options: { streaming?: boolean; messageId?: string },
  ): void;
  /** `(path) => data URL` for a remote thread's daemon; undefined when images are local. */
  remoteImageLoader?(): ((path: string) => Promise<string | undefined>) | undefined;
}

export interface MessageRenderOptions {
  streaming?: boolean;
  /** Transcript message being rendered; enables message-content hydration when it matches. */
  messageId?: string;
}

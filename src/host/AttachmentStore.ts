/**
 * Host seam: message-image attachment storage (ADR-0003).
 *
 * `ThreadManager` externalizes inline image bytes to files so they stop
 * bloating persisted thread state. How a file is written is host specific
 * (Obsidian vault API, Geode bridge, plain disk on a daemon), so core depends
 * only on this interface. The plugin passes `AttachmentWriter`; a host with no
 * storage uses `NULL_ATTACHMENT_STORE`, which leaves images inline.
 */
export interface AttachmentStore {
  /** True when attachments can be written; false means "leave images inline". */
  isDesktop(): boolean;
  /**
   * Write one image and return its store-relative path, or null if skipped or
   * every strategy failed. Must never throw into the session hot path.
   */
  write(
    threadId: string,
    messageId: string,
    index: number,
    mediaType: string,
    base64: string,
  ): Promise<string | null>;
  /** Remove a thread's whole attachment directory. Best effort, never throws. */
  removeThreadDir(threadId: string): Promise<void>;
}

export const NULL_ATTACHMENT_STORE: AttachmentStore = {
  isDesktop: () => false,
  write: async () => null,
  removeThreadDir: async () => undefined,
};

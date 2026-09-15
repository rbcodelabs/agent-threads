/**
 * "Watch with active thread" — pure helpers shared by all three entry points
 * (file-explorer context menu, editor context menu, command palette), mirroring
 * documentChat.ts's structure.
 *
 * No Obsidian/Node imports — kept pure so it can be unit tested directly.
 */
import { isChattableDocument } from './documentChat';

/**
 * Whether to offer the watch action on a given file.
 *
 * The watch service only ever compares mtime/size stamps and reads content for
 * alert formatting on markdown files reachable the same way "Chat about this
 * document" reaches them, so the gate is identical — reused rather than
 * duplicated to avoid the two menus drifting on which files qualify.
 */
export const isWatchableDocument = isChattableDocument;

/** Menu label shown when the document is not currently watched by any thread owned by the caller. */
export const WATCH_DOCUMENT_LABEL = 'Watch with active thread';
/** Menu label shown when the document is already watched by the active thread. */
export const UNWATCH_DOCUMENT_LABEL = 'Stop watching this document';

/** Menu label and command name, in one place so all three entry points match. */
export function watchMenuLabel(isCurrentlyWatched: boolean): string {
  return isCurrentlyWatched ? UNWATCH_DOCUMENT_LABEL : WATCH_DOCUMENT_LABEL;
}

/**
 * "Ack only after persisted" for a remote thread (design 3.4): the daemon may drop its replay buffer
 * only once the transcript that buffer would rebuild is safely on this side's disk.
 */
import type { Thread } from '../types';

interface AckHost {
  getThread(id: string): Thread | undefined;
  notifyThreadPersisted(id: string, seq?: number): void;
}

/**
 * Run `save` and, only if it succeeds, ack the cursor as it stood when the save was REQUESTED.
 *
 * Two traps this avoids:
 *   - acking before the write finished (the save is debounced/coalesced and asynchronous);
 *   - acking the live cursor after the write, which may already be past what the write captured
 *     (an event applied while the write was in flight is not on disk yet).
 * A save that fails or never settles acks nothing: the daemon just keeps the history longer.
 */
export async function saveThenAck(host: AckHost, threadId: string, save: () => Promise<void>): Promise<void> {
  const savedThrough = host.getThread(threadId)?.remote?.lastSeq;
  await save();
  host.notifyThreadPersisted(threadId, savedThrough);
}

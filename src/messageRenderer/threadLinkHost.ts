import { resolveThreadLink, type ThreadRef } from '../orchestratorDockModel';

export const THREAD_GONE_NOTICE = 'That thread no longer exists (it may have been archived or deleted).';

export interface ThreadLinkHostDeps {
  /** Every thread the surface knows, not filtered by Project. */
  threads(): readonly ThreadRef[];
  /** Whether the thread still exists right now (read at click time). */
  exists(threadId: string): boolean;
  /** Open the thread. */
  open(threadId: string): void;
  /** Tell the user something (a Notice). */
  notify(message: string): void;
}

/**
 * The thread-link half of a MessageRenderHost for a surface that owns a thread manager (the main panel). Resolution is
 * by id first, so a renamed thread still resolves. A thread archived after the message rendered fails soft at click time.
 */
export function createThreadLinkHost(deps: ThreadLinkHostDeps): {
  resolveThread(ref: string, label: string): { threadId: string; title: string } | null;
  openThread(threadId: string): void;
} {
  return {
    resolveThread: (ref, label) => resolveThreadLink(ref, label, deps.threads()),
    openThread: (threadId) => {
      if (deps.exists(threadId)) deps.open(threadId);
      else deps.notify(THREAD_GONE_NOTICE);
    },
  };
}

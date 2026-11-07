/**
 * Shared Approve & Send / Edit / Discard logic for a thread's AI-proposed reply
 * (`thread.proposedReply`, staged by an orchestrator via
 * `threads_set_proposed_reply`). Used by ThreadsView (conversation card) and
 * KanbanView (inline card block) so both clear-then-act identically.
 *
 * Invariant: the proposal is CLEARED FIRST, before anything is sent, so a
 * long-running send can never leave a stale proposal where a second click
 * would trigger a duplicate send. Nothing here sends automatically; every
 * entry point is called from an explicit user click.
 */
import type { Thread } from './types';

export interface ProposedReplyDeps {
  getThread(id: string): Pick<Thread, 'proposedReply'> | undefined;
  notifyProposedReplyChanged(id: string): void;
  saveSettings(): Promise<unknown> | void;
  sendMessage(id: string, text: string): Promise<void>;
}

/** Removes the proposal, notifies listeners and persists. No-op when the thread is gone. */
export function clearProposedReply(deps: ProposedReplyDeps, threadId: string): void {
  const thread = deps.getThread(threadId);
  if (!thread) return;
  delete thread.proposedReply;
  deps.notifyProposedReplyChanged(threadId);
  void deps.saveSettings();
}

/** Discard: clear without sending. */
export function discardProposedReply(deps: ProposedReplyDeps, threadId: string): void {
  clearProposedReply(deps, threadId);
}

/** Edit: clear the proposal and return its text so the caller can prefill the composer. */
export function takeProposedReplyForEdit(deps: ProposedReplyDeps, threadId: string): string | undefined {
  const text = deps.getThread(threadId)?.proposedReply?.text;
  if (!text) return undefined;
  clearProposedReply(deps, threadId);
  return text;
}

/**
 * Approve & Send: clear first, then send. Resolves true when a proposal existed
 * and was sent; rejects with the send error after the proposal has already been
 * cleared (the caller surfaces it, the user can retype).
 */
export async function approveProposedReply(deps: ProposedReplyDeps, threadId: string): Promise<boolean> {
  const text = deps.getThread(threadId)?.proposedReply?.text;
  if (!text) return false;
  clearProposedReply(deps, threadId);
  await deps.sendMessage(threadId, text);
  return true;
}

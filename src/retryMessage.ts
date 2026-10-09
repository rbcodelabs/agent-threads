import type { ChatMessage } from './types';

/**
 * "Retry" on a user message re-sends that turn as a brand-new message, exactly
 * as if the user had typed and sent it again. Unlike "Set as goal" it is not
 * limited to the latest turn: retrying an older prompt is a legitimate way to
 * re-run it after context has changed.
 *
 * A message is retryable when it carries something to send — text or images.
 * Only `user` rows qualify; assistant/notice/compact rows never do.
 */
export function isRetryEligible(message: ChatMessage): boolean {
  if (message.role !== 'user') return false;
  return message.content.trim().length > 0 || (message.images?.length ?? 0) > 0;
}

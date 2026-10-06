import { describe, expect, it } from 'vitest';
import { isRetryEligible } from '../../src/retryMessage';
import type { ChatMessage } from '../../src/types';

function message(role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: `${role}-1`, role, content, timestamp: 1, ...extra };
}

describe('Retry message eligibility', () => {
  it('accepts a user message with text', () => {
    expect(isRetryEligible(message('user', 'run the tests'))).toBe(true);
  });

  it('accepts any user message, not just the latest turn', () => {
    // Unlike "Set as goal", eligibility depends only on the message itself.
    expect(isRetryEligible(message('user', 'first prompt'))).toBe(true);
  });

  it('accepts an image-only user message', () => {
    const imageOnly = message('user', '', { images: [{ name: 'x.png', mediaType: 'image/png', path: 'a/x.png' }] });
    expect(isRetryEligible(imageOnly)).toBe(true);
  });

  it('rejects a blank user message with no images', () => {
    expect(isRetryEligible(message('user', '  \n '))).toBe(false);
    expect(isRetryEligible(message('user', '', { images: [] }))).toBe(false);
  });

  it.each(['assistant', 'compact', 'notice'] as const)('rejects a %s row', (role) => {
    expect(isRetryEligible(message(role, 'content'))).toBe(false);
  });
});

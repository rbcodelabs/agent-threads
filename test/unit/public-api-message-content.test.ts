import { describe, expect, it } from 'vitest';
import { createClaudeThreadsApiV1 } from '../../src/PublicApi';

describe('inline message content public API', () => {
  it('formats a durable reference without requiring a provider to be installed', () => {
    const { api } = createClaudeThreadsApiV1({
      getThreads: () => [], getThread: () => undefined, isRunning: () => false,
      createThread: () => ({ id: 't' }), sendMessage: async () => {}, openThread: async () => {},
      subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null,
      triggerHostEvent: () => {},
    } as never);
    const ref = { providerId: 'example.cards', id: 'one', schemaVersion: 1, title: 'Summary', data: { count: 2 } };
    expect(api.messageContent.formatReference(ref)).toBe(`agent-content${JSON.stringify(ref)}`);
    expect(api.capabilities).toContain('messageContent.formatReference');
  });
});

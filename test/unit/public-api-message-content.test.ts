import { describe, expect, it } from 'vitest';
import { createClaudeThreadsApiV1 } from '../../src/PublicApi';
import { MessageContentProviderRegistry } from '../../src/MessageContent';

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
  it('advertises local providers only when supplied and retracts registrations when the service stops', async () => {
    const registry = new MessageContentProviderRegistry();
    const service = createClaudeThreadsApiV1({
      getThreads: () => [], getThread: () => undefined, isRunning: () => false,
      createThread: () => ({ id: 't' }), sendMessage: async () => {}, openThread: async () => {},
      subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null,
      triggerHostEvent: () => {}, messageContentProviders: registry,
    } as never);
    expect(service.api.capabilities).toContain('extensions.registerMessageContentProvider');
    expect(service.api.extensions.registerMessageContentProvider({ pluginId: 'example' }, { providerId: 'example.cards', present: () => ({ kind: 'card', title: 'Rendered' }) }).success).toBe(true);
    const ref = { providerId: 'example.cards', id: 'one', schemaVersion: 1, title: 'Summary', data: {} };
    service.stop();
    expect(await registry.present(ref, { threadId: 't', messageId: 'm', signal: new AbortController().signal })).toBeNull();
    expect(() => service.api.messageContent.formatReference(ref)).toThrow('not available');
    expect(() => service.api.extensions.registerMessageContentProvider({ pluginId: 'example' }, { providerId: 'example.cards', present: () => ({ kind: 'card', title: 'Rendered' }) })).toThrow('not available');
  });
});

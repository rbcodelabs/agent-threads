import { describe, expect, it, vi } from 'vitest';
import { createClaudeThreadsApiV1 } from '../../src/PublicApi';

function setup(slashCommands?: unknown) {
  return createClaudeThreadsApiV1({
    getThreads: () => [], getThread: () => undefined, isRunning: () => false,
    createThread: () => ({ id: 't' }), sendMessage: async () => {}, openThread: async () => {},
    subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null,
    triggerHostEvent: () => {}, slashCommands,
  } as never);
}

describe('public slash-command registration', () => {
  it('advertises and delegates registration only when the host supports commands', () => {
    const dispose = vi.fn();
    const registry = { register: vi.fn(() => ({ success: true, status: 'registered', name: 'board', dispose })) };
    const service = setup(registry);
    expect(service.api.capabilities).toContain('extensions.registerSlashCommand');
    const owner = { pluginId: 'acme.boards' };
    const contribution = { name: 'board', thread: { description: 'Open board', invoke: async () => ({ status: 'ok' as const }) } };
    const registration = service.api.extensions.registerSlashCommand(owner, contribution);
    expect(registry.register).toHaveBeenCalledWith(owner, contribution);
    expect(registration.success).toBe(true);
    service.stop();
    expect(dispose).toHaveBeenCalledOnce();
    expect(() => service.api.extensions.registerSlashCommand(owner, contribution)).toThrow('not available');
  });

  it('returns unavailable and does not advertise support in a host without command routing', () => {
    const { api } = setup();
    expect(api.capabilities).not.toContain('extensions.registerSlashCommand');
    expect(api.extensions.registerSlashCommand({ pluginId: 'acme' }, {
      name: 'board', thread: { description: 'Board', invoke: async () => ({ status: 'ok' }) },
    })).toMatchObject({ success: false, status: 'unavailable' });
  });
});

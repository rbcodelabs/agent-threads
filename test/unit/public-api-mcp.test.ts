import { describe, expect, it, vi } from 'vitest';
import { createClaudeThreadsApiV1 } from '../../src/main';
import type { McpRegistrationResult } from '../../src/mcpServerStore';

/**
 * Minimal harness for the `mcp.register` / `mcp.requestSecret` peer-plugin
 * surface. Deliberately separate from public-api.test.ts's makeHarness(),
 * which doesn't wire the optional registerMcpServer/requestSecret/hasSecret
 * dependencies at all — every test there implicitly covers the "dependency
 * not supplied" branch for every OTHER capability; these tests exercise both
 * the "not supplied" and "supplied" branches specifically for mcp.*.
 */
function makeHarness(overrides: {
  registerMcpServer?: (input: unknown) => Promise<McpRegistrationResult>;
  requestSecret?: (secretName: string, reason: string, force?: boolean) => Promise<boolean>;
  hasSecret?: (secretName: string) => boolean;
} = {}) {
  const threads = new Map<string, any>();
  return {
    service: createClaudeThreadsApiV1({
      getThreads: () => [...threads.values()],
      getThread: (id: string) => threads.get(id),
      isRunning: () => false,
      createThread: () => { throw new Error('not used'); },
      sendMessage: async () => {},
      openThread: async () => {},
      subscribe: () => () => {},
      listOrchestrators: () => [],
      resolveOrchestrator: async () => null,
      triggerHostEvent: () => {},
      ...overrides,
    } as any),
  };
}

describe('Claude Threads public API v1 — mcp.register / mcp.requestSecret', () => {
  it('register returns an unavailable result (no throw) when the dependency is not supplied', async () => {
    const { service } = makeHarness();
    const result = await service.api.mcp.register({ name: 'my-server', type: 'stdio', command: 'echo' });
    expect(result).toMatchObject({ success: false, status: 'unavailable' });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('register forwards input to the dependency and passes through a registered result', async () => {
    const registerMcpServer = vi.fn(async (input: unknown): Promise<McpRegistrationResult> => {
      expect(input).toMatchObject({ name: 'my-server', type: 'stdio', command: 'echo' });
      return { success: true, status: 'registered', message: 'Saved globally.' };
    });
    const { service } = makeHarness({ registerMcpServer });
    const result = await service.api.mcp.register({ name: 'my-server', type: 'stdio', command: 'echo' });
    expect(registerMcpServer).toHaveBeenCalledOnce();
    expect(result).toEqual({ success: true, status: 'registered', message: 'Saved globally.' });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('register passes through a conflict result unchanged', async () => {
    const registerMcpServer = vi.fn(async (): Promise<McpRegistrationResult> =>
      ({ success: false, status: 'conflict', message: 'That MCP server name already exists with a different configuration. No changes were made.' }));
    const { service } = makeHarness({ registerMcpServer });
    const result = await service.api.mcp.register({ name: 'taken', type: 'http', url: 'https://example.com' });
    expect(result).toEqual({ success: false, status: 'conflict', message: 'That MCP server name already exists with a different configuration. No changes were made.' });
  });

  it('register throws PLUGIN_UNAVAILABLE after stop()', async () => {
    const { service } = makeHarness({ registerMcpServer: async () => ({ success: true, status: 'registered', message: 'ok' }) });
    service.stop();
    await expect(service.api.mcp.register({ name: 'x', type: 'stdio', command: 'echo' })).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' });
  });

  it('requestSecret short-circuits with alreadyExisted:true and does not call the dependency when hasSecret is true and force is unset', async () => {
    const requestSecret = vi.fn(async () => true);
    const hasSecret = vi.fn(() => true);
    const { service } = makeHarness({ requestSecret, hasSecret });
    const result = await service.api.mcp.requestSecret({ secretName: 'LINEAR_API_KEY', reason: 'to list issues' });
    expect(result).toEqual({ success: true, secretName: 'LINEAR_API_KEY', alreadyExisted: true });
    expect(requestSecret).not.toHaveBeenCalled();
    expect(hasSecret).toHaveBeenCalledWith('LINEAR_API_KEY');
  });

  it('requestSecret calls the dependency when force:true even though hasSecret is true', async () => {
    const requestSecret = vi.fn(async () => true);
    const hasSecret = vi.fn(() => true);
    const { service } = makeHarness({ requestSecret, hasSecret });
    const result = await service.api.mcp.requestSecret({ secretName: 'LINEAR_API_KEY', reason: 'rotate', force: true });
    expect(requestSecret).toHaveBeenCalledWith('LINEAR_API_KEY', 'rotate', true);
    expect(result).toEqual({ success: true, secretName: 'LINEAR_API_KEY', alreadyExisted: false });
  });

  it('requestSecret normalizes the secret name the same way the agent tool does', async () => {
    const requestSecret = vi.fn(async () => true);
    const { service } = makeHarness({ requestSecret, hasSecret: () => false });
    const result = await service.api.mcp.requestSecret({ secretName: 'my key!', reason: 'because' }) as any;
    expect(result.secretName).toBe('MY_KEY_');
    expect(requestSecret).toHaveBeenCalledWith('MY_KEY_', 'because', false);
  });

  it('requestSecret returns a failure reason when the dependency resolves false (user cancelled)', async () => {
    const { service } = makeHarness({ requestSecret: async () => false, hasSecret: () => false });
    const result = await service.api.mcp.requestSecret({ secretName: 'X', reason: 'y' });
    expect(result).toEqual({ success: false, reason: 'The user did not save the secret.' });
  });

  it('requestSecret returns an unavailable-style failure when the dependency is not supplied', async () => {
    const { service } = makeHarness();
    const result = await service.api.mcp.requestSecret({ secretName: 'X', reason: 'y' });
    expect(result).toEqual({ success: false, reason: 'Secret request UI is not available in this context.' });
  });

  it('requestSecret throws PLUGIN_UNAVAILABLE after stop()', async () => {
    const { service } = makeHarness({ requestSecret: async () => true, hasSecret: () => false });
    service.stop();
    await expect(service.api.mcp.requestSecret({ secretName: 'X', reason: 'y' })).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' });
  });
});

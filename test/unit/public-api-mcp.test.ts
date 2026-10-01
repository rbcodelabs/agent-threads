import { describe, expect, it, vi } from 'vitest';
import { createClaudeThreadsApiV1 } from '../../src/main';
import type { McpRegistrationResult } from '../../src/mcpServerStore';
import { OAUTH_MCP_PRESETS } from '../../src/oauthMcpPresets';
import { resolve } from 'node:path';

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

describe('Claude Threads public API v1 — mcp.listPresets / mcp.registerPreset', () => {
  const registered = async (): Promise<McpRegistrationResult> => ({ success: true, status: 'registered', message: 'ok' });

  it('lists every preset as frozen copies, with booleans for the client requirements', () => {
    const { service } = makeHarness();
    const list = service.api.mcp.listPresets();
    expect(list.map(p => p.id)).toEqual(OAUTH_MCP_PRESETS.map(p => p.id));
    expect(Object.isFrozen(list)).toBe(true);
    expect(list.every(p => Object.isFrozen(p))).toBe(true);
    for (const p of list) {
      expect(typeof p.requiresClientId).toBe('boolean');
      expect(typeof p.requiresClientSecret).toBe('boolean');
    }
    // Copies, not the internal array: mutating one result cannot leak into the next.
    expect(service.api.mcp.listPresets()[0]).not.toBe(list[0]);
    expect(list[0]).not.toBe(OAUTH_MCP_PRESETS[0]);
    expect(() => { (list[0] as { name: string }).name = 'x'; }).toThrow();
  });

  it('advertises the capabilities consumers feature-detect on', () => {
    const { service } = makeHarness({ registerMcpServer: registered });
    expect(service.api.capabilities).toContain('mcp.listPresets');
    expect(service.api.capabilities).toContain('mcp.registerPreset');
    const bare = makeHarness().service.api.capabilities;
    expect(bare).toContain('mcp.listPresets');
    expect(bare).not.toContain('mcp.registerPreset');
  });

  it('registers a preset through the same dependency as mcp.register with the merged config', async () => {
    const registerMcpServer = vi.fn(registered);
    const { service } = makeHarness({ registerMcpServer });
    const result = await service.api.mcp.registerPreset('linear');
    expect(result).toMatchObject({ success: true, status: 'registered' });
    expect(registerMcpServer).toHaveBeenCalledWith({ type: 'oauth', name: 'linear', url: 'https://mcp.linear.app/mcp' });
  });

  it('lets overrides win over preset values and ignores undefined overrides', async () => {
    const registerMcpServer = vi.fn(registered);
    const { service } = makeHarness({ registerMcpServer });
    await service.api.mcp.registerPreset('asana', {
      name: 'asana-work', clientId: 'cid', clientSecret: '${ASANA_SECRET}', redirectUri: 'http://localhost:4000/cb',
      tools: { deny: ['delete_task'] }, scopes: undefined,
    });
    expect(registerMcpServer).toHaveBeenCalledWith({
      type: 'oauth', name: 'asana-work', url: 'https://mcp.asana.com/v2/mcp',
      redirectUri: 'http://localhost:4000/cb', clientId: 'cid', clientSecret: '${ASANA_SECRET}', tools: { deny: ['delete_task'] },
    });
  });

  it('uses the preset redirect URI when no override is given', async () => {
    const registerMcpServer = vi.fn(registered);
    const { service } = makeHarness({ registerMcpServer });
    await service.api.mcp.registerPreset('asana', { clientId: 'cid' });
    expect(registerMcpServer.mock.calls[0]![0]).toMatchObject({ redirectUri: 'http://localhost:3118/callback', clientId: 'cid' });
  });

  it('rejects an unknown id with INVALID_ARGUMENT without calling the dependency', async () => {
    const registerMcpServer = vi.fn(registered);
    const { service } = makeHarness({ registerMcpServer });
    await expect(service.api.mcp.registerPreset('nope')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(registerMcpServer).not.toHaveBeenCalled();
  });

  it('rejects a requiresClientId preset without a clientId override', async () => {
    const registerMcpServer = vi.fn(registered);
    const { service } = makeHarness({ registerMcpServer });
    await expect(service.api.mcp.registerPreset('asana')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('clientId') });
    await expect(service.api.mcp.registerPreset('asana', { clientId: '  ' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(registerMcpServer).not.toHaveBeenCalled();
  });

  it('rejects overrides of the preset identity (url, type, grantType)', async () => {
    const registerMcpServer = vi.fn(registered);
    const { service } = makeHarness({ registerMcpServer });
    await expect(service.api.mcp.registerPreset('linear', { url: 'https://evil.example' } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(registerMcpServer).not.toHaveBeenCalled();
  });

  it('returns the unavailable result when registration is not supplied, and rejects after stop', async () => {
    const { service } = makeHarness();
    expect(await service.api.mcp.registerPreset('linear')).toMatchObject({ success: false, status: 'unavailable' });
    service.stop();
    await expect(service.api.mcp.registerPreset('linear')).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' });
  });

  it('passes through non-registered results (unchanged / invalid) untouched', async () => {
    const { service } = makeHarness({ registerMcpServer: async () => ({ success: true, status: 'unchanged', message: 'same' }) });
    expect(await service.api.mcp.registerPreset('notion')).toMatchObject({ status: 'unchanged' });
  });
});

describe('checked-in consumer declaration — presets', () => {
  it('compiles a consumer that lists and registers presets', async () => {
    const ts = await import('typescript');
    const dts = resolve(__dirname, '../../api/public-api-v1.d.ts');
    const consumer = resolve(__dirname, '__consumer.ts');
    const source = [
      `import type { AgentThreadsApiV1, McpPresetDescriptor, McpPresetOverrides, McpRegistrationResult } from '${dts.replace(/\.d\.ts$/, '')}';`,
      'export async function use(api: AgentThreadsApiV1): Promise<McpRegistrationResult | undefined> {',
      '  const presets: readonly McpPresetDescriptor[] = api.mcp.listPresets();',
      '  const needsId: boolean = presets[0]!.requiresClientId;',
      "  const overrides: McpPresetOverrides = { name: 'x', clientId: 'y', tools: { allow: ['a'] } };",
      "  if (!api.capabilities.includes('mcp.registerPreset') || needsId) return undefined;",
      "  return api.mcp.registerPreset('linear', overrides);",
      '}',
      "// @ts-expect-error url is not overridable",
      "export const bad: McpPresetOverrides = { url: 'https://x' };",
    ].join('\n');
    const options = { noEmit: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, types: [] as string[] };
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, ...rest) => name === consumer ? ts.createSourceFile(name, source, ts.ScriptTarget.ES2022) : original(name, ...rest);
    const fileExists = host.fileExists.bind(host);
    host.fileExists = name => name === consumer || fileExists(name);
    const program = ts.createProgram([consumer], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(diagnostics).toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import { OpenCodeHostToolsBridge, handleHostToolsRpc, type OpenCodeHostToolsContext } from '../../src/OpenCodeHostTools';
import type { HarnessDynamicTool, HarnessPermissionMode } from '../../src/HarnessSession';

function tool(name: string, requiresApproval: boolean): HarnessDynamicTool & { invoke: ReturnType<typeof vi.fn> } {
  return {
    name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} }, requiresApproval,
    invoke: vi.fn(async () => ({ success: true, text: `${name} ok` })),
  };
}

function context(mode: HarnessPermissionMode, allow = true): OpenCodeHostToolsContext & { requestPermission: ReturnType<typeof vi.fn> } {
  return { permissionMode: () => mode, requestPermission: vi.fn(async () => allow) };
}

describe('handleHostToolsRpc', () => {
  it('negotiates the client protocol version and lists tools', async () => {
    const tools = [tool('threads_list', false)];
    const init = await handleHostToolsRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, tools, context('default'));
    expect(init?.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} } });
    const list = await handleHostToolsRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, tools, context('default'));
    expect(list?.result).toEqual({ tools: [{ name: 'threads_list', description: 'threads_list tool', inputSchema: { type: 'object', properties: {} } }] });
  });

  it('never answers notifications and rejects unknown methods', async () => {
    expect(await handleHostToolsRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, [], context('default'))).toBeNull();
    expect((await handleHostToolsRpc({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, [], context('default')))?.error?.code).toBe(-32601);
  });

  it('runs read-only tools without asking', async () => {
    const readOnly = tool('threads_list', false);
    const ctx = context('default');
    const reply = await handleHostToolsRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'threads_list', arguments: { a: 1 } } }, [readOnly], ctx);
    expect(ctx.requestPermission).not.toHaveBeenCalled();
    expect(readOnly.invoke).toHaveBeenCalledWith({ a: 1 });
    expect(reply?.result).toEqual({ content: [{ type: 'text', text: 'threads_list ok' }], isError: false });
  });

  it('prompts for mutating tools and honors a denial', async () => {
    const mutating = tool('threads_archive', true);
    const ctx = context('default', false);
    const reply = await handleHostToolsRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'threads_archive', arguments: {} } }, [mutating], ctx);
    expect(ctx.requestPermission).toHaveBeenCalledWith('Agent Threads: threads_archive', expect.stringContaining('threads_archive tool'));
    expect(mutating.invoke).not.toHaveBeenCalled();
    expect(reply?.result).toMatchObject({ isError: true });
  });

  it('denies mutating tools in plan mode without prompting', async () => {
    const mutating = tool('threads_archive', true);
    const ctx = context('plan');
    const reply = await handleHostToolsRpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'threads_archive' } }, [mutating], ctx);
    expect(ctx.requestPermission).not.toHaveBeenCalled();
    expect(reply?.result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/permission mode/) }] });
  });

  it('reports unknown tools and thrown errors as tool errors', async () => {
    expect((await handleHostToolsRpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope' } }, [], context('default')))?.result).toMatchObject({ isError: true });
    const failing = tool('threads_list', false);
    failing.invoke.mockRejectedValueOnce(new Error('boom'));
    expect((await handleHostToolsRpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'threads_list' } }, [failing], context('default')))?.result)
      .toEqual({ content: [{ type: 'text', text: 'boom' }], isError: true });
  });
});

describe('OpenCodeHostToolsBridge', () => {
  let bridge: OpenCodeHostToolsBridge | undefined;
  afterEach(() => bridge?.close());

  const post = (url: string, headers: Record<string, string>, body: unknown) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = ''; res.on('data', (c) => (text += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject); req.write(JSON.stringify(body)); req.end();
  });

  it('serves JSON-RPC on loopback only to callers presenting the capability token', async () => {
    bridge = new OpenCodeHostToolsBridge([tool('threads_list', false)], context('default'));
    await bridge.start();
    expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect((await post(bridge.url, {}, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
    expect((await post(bridge.url, { 'X-Capability-Token': 'wrong' }, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
    const ok = await post(bridge.url, bridge.headers, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).result.tools[0].name).toBe('threads_list');
    expect((await post(bridge.url, bridge.headers, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
  });
});

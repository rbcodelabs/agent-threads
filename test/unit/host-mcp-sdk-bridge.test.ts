import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { HostMcpSdkBridge, type HostMcpBridgeClient } from '../../src/HostMcpSdkBridge';

function fakeClient(overrides: Partial<HostMcpBridgeClient> = {}): HostMcpBridgeClient {
  return {
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    listTools: vi.fn(async (): Promise<ListToolsResult> => ({
      tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object' } }],
      nextCursor: 'page-2',
    })),
    callTool: vi.fn(async (): Promise<CallToolResult> => ({
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        { type: 'resource_link', uri: 'file:///result.md', name: 'result' },
      ],
      structuredContent: { accepted: true },
      isError: false,
    })),
    ...overrides,
  };
}

async function connectedBridge(upstream: HostMcpBridgeClient) {
  const bridge = new HostMcpSdkBridge('oauth', new URL('http://127.0.0.1:5555'), {
    'X-Capability-Token': 'host-only-secret',
  }, { createClient: () => upstream });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await bridge.config.instance.connect(serverTransport);
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { bridge, client };
}

describe('HostMcpSdkBridge', () => {
  it('closes an upstream client whose initial connection fails before allowing a retry', async () => {
    const failed = fakeClient({ connect: vi.fn(async () => { throw new Error('upstream unavailable'); }) });
    const recovered = fakeClient();
    const createClient = vi.fn()
      .mockReturnValueOnce(failed)
      .mockReturnValueOnce(recovered);
    const bridge = new HostMcpSdkBridge('oauth', new URL('http://127.0.0.1:5555'), {}, { createClient });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await bridge.config.instance.connect(serverTransport);
    const client = new Client({ name: 'bridge-test', version: '1.0.0' });
    await client.connect(clientTransport);

    await expect(client.listTools()).rejects.toThrow('upstream unavailable');
    expect(failed.close).toHaveBeenCalledOnce();

    await expect(client.listTools()).resolves.toMatchObject({ tools: [{ name: 'echo' }] });
    expect(createClient).toHaveBeenCalledTimes(2);

    await client.close();
    await bridge.close();
  });

  it('forwards paginated tools/list and preserves rich tools/call results', async () => {
    const upstream = fakeClient();
    const { bridge, client } = await connectedBridge(upstream);

    const listed = await client.listTools({ cursor: 'page-1' });
    expect(listed.tools[0].name).toBe('echo');
    expect(listed.nextCursor).toBe('page-2');
    expect(upstream.listTools).toHaveBeenCalledWith({ cursor: 'page-1' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));

    const called = await client.callTool({ name: 'echo', arguments: { value: 'x' } });
    expect(called).toMatchObject({
      structuredContent: { accepted: true },
      isError: false,
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', mimeType: 'image/png' },
        { type: 'resource_link', uri: 'file:///result.md' },
      ],
    });

    await client.close();
    await bridge.close();
    expect(upstream.close).toHaveBeenCalledOnce();
  });

  it('forwards progress and cancellation without retrying an ambiguous tool call', async () => {
    let calls = 0;
    const upstream = fakeClient({
      callTool: vi.fn(async (_params, _schema, options) => {
        calls += 1;
        options?.onprogress?.({ progress: 1, total: 2, message: 'halfway' });
        await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
        return { content: [] };
      }),
    });
    const { bridge, client } = await connectedBridge(upstream);
    const progress = vi.fn();
    const controller = new AbortController();
    const pending = client.callTool({ name: 'echo', arguments: {} }, undefined, { signal: controller.signal, onprogress: progress });
    await vi.waitFor(() => expect(progress).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(calls).toBe(1);

    await client.close();
    await bridge.close();
  });

  it('does not close the shared upstream client when one of two concurrent calls fails', async () => {
    let finishSlow!: (result: CallToolResult) => void;
    const slow = new Promise<CallToolResult>(resolve => { finishSlow = resolve; });
    const upstream = fakeClient({
      callTool: vi.fn(async (params) => {
        if (params.name === 'fails') throw new Error('application error');
        return slow;
      }),
    });
    const { bridge, client } = await connectedBridge(upstream);

    const surviving = client.callTool({ name: 'slow', arguments: {} });
    await expect(client.callTool({ name: 'fails', arguments: {} })).rejects.toThrow('application error');
    expect(upstream.close).not.toHaveBeenCalled();
    finishSlow({ content: [{ type: 'text', text: 'survived' }] });
    await expect(surviving).resolves.toMatchObject({ content: [{ text: 'survived' }] });

    await client.close();
    await bridge.close();
  });
});

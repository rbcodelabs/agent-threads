import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  HOST_RESOURCE_LIMITS, HOST_RESOURCE_TOOLS, HOST_TOOL_LIMITS, checkResourceUri, decodeResourceContents, decodeResourceList,
  decodeResourceTemplates, encodeResourceContents, encodeResourceList, encodeResourceTemplates, isHostResourceTool, manifestFromSpecs,
} from '../../src/protocol';
import { HostToolExecutor, HostToolSlots } from '../../src/remote/hostToolExecutor';
import { RemoteHostTools } from '../../src/remote/hostTools';
import { createLoopbackMcpSource, type HostMcpSource } from '../../src/remote/hostMcpClient';
import { HostToolBroker } from '../../daemon/hostTools';
import { createHostMcpServer } from '../../daemon/hostMcpServer';
import type { WireEvent } from '../../src/protocol';

const spec = (name: string, server: string) => ({ name, description: 'd', inputSchema: { type: 'object' }, requiresApproval: false, server });

describe('resource wire helpers', () => {
  it('recognises only the reserved resource tool names, which are not valid manifest tool names', () => {
    expect(Object.values(HOST_RESOURCE_TOOLS).every(isHostResourceTool)).toBe(true);
    expect(isHostResourceTool('read_doc')).toBe(false);
    expect(isHostResourceTool(undefined)).toBe(false);
  });
  it('round-trips a resource list, keeping only known fields', () => {
    const text = encodeResourceList([{ uri: 'docs://w/a', name: 'A', mimeType: 'text/markdown', secret: 'x' }, { nope: 1 }, { uri: 'docs://w/b' }]);
    expect(decodeResourceList(text)).toEqual({ ok: true, value: [{ uri: 'docs://w/a', name: 'A', mimeType: 'text/markdown' }, { uri: 'docs://w/b', name: 'docs://w/b' }] });
    expect(decodeResourceTemplates(encodeResourceTemplates([{ uriTemplate: 'docs://w/{path}', name: 'doc' }])))
      .toEqual({ ok: true, value: [{ uriTemplate: 'docs://w/{path}', name: 'doc' }] });
  });
  it('bounds a list by count and by serialized size, and marks the cut', () => {
    const many = Array.from({ length: 900 }, (_, i) => ({ uri: `docs://w/${i}`, name: `n${i}` }));
    const decoded = decodeResourceList(encodeResourceList(many));
    expect(decoded.ok && decoded.value.length).toBe(HOST_RESOURCE_LIMITS.maxEntries);
    const big = Array.from({ length: 400 }, (_, i) => ({ uri: `docs://w/${i}`, name: 'n', description: 'd'.repeat(2000) }));
    const text = encodeResourceList(big);
    expect(text.length).toBeLessThanOrEqual(HOST_TOOL_LIMITS.maxResultTextChars);
    expect(JSON.parse(text).truncated).toBe(true);
  });
  it('keeps text contents, replaces blobs with a note, and cuts oversized text with a marker', () => {
    const decoded = decodeResourceContents(encodeResourceContents([{ uri: 'u1', mimeType: 'text/markdown', text: '# Hi' }, { uri: 'u2', mimeType: 'image/png', blob: 'AAAA' }]));
    expect(decoded).toEqual({ ok: true, value: [{ uri: 'u1', mimeType: 'text/markdown', text: '# Hi' }, { uri: 'u2', mimeType: 'image/png', text: '[binary content (image/png) omitted: 3 bytes]' }] });
    const text = encodeResourceContents([{ uri: 'u', text: '"\n'.repeat(120_000) }]);
    expect(text.length).toBeLessThanOrEqual(HOST_TOOL_LIMITS.maxResultTextChars);
    expect(JSON.parse(text).contents[0].text).toContain('output truncated');
  });
  it('rejects unreadable payloads and bad uris', () => {
    expect(decodeResourceList('not json').ok).toBe(false);
    expect(decodeResourceContents('{"contents":5}').ok).toBe(false);
    expect(checkResourceUri('')).not.toBeNull();
    expect(checkResourceUri('a\nb')).not.toBeNull();
    expect(checkResourceUri('x'.repeat(5000))).not.toBeNull();
    expect(checkResourceUri('docs://w/some%20path.md')).toBeNull();
  });
});

describe('loopback MCP source resources', () => {
  const client = (over: Record<string, unknown>) => () => ({
    connect: async () => undefined, close: async () => undefined,
    listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), ...over,
  }) as never;

  it('lists across pages and reads', async () => {
    const pages = [{ resources: [{ uri: 'a', name: 'A' }], nextCursor: 'p2' }, { resources: [{ uri: 'b', name: 'B' }] }];
    const seen: Array<string | undefined> = [];
    const src = createLoopbackMcpSource('http://127.0.0.1:1/', {}, client({
      listResources: async (p: { cursor?: string }) => { seen.push(p.cursor); return pages[seen.length - 1]; },
      listResourceTemplates: async () => ({ resourceTemplates: [{ uriTemplate: 'docs://w/{p}', name: 't' }] }),
      readResource: async (p: { uri: string }) => ({ contents: [{ uri: p.uri, text: 'body' }] }),
    }));
    expect((await src.listResources!()).map((r) => r.uri)).toEqual(['a', 'b']);
    expect(seen).toEqual([undefined, 'p2']);
    expect((await src.listResourceTemplates!()).map((t) => t.uriTemplate)).toEqual(['docs://w/{p}']);
    expect(await src.readResource!('docs://w/x')).toEqual([{ uri: 'docs://w/x', text: 'body' }]);
  });
  it('an upstream without resources lists as empty rather than failing, and keeps its connection', async () => {
    let made = 0;
    const src = createLoopbackMcpSource('http://127.0.0.1:1/', {}, () => {
      made++;
      return client({
        listResources: async () => { throw new McpError(ErrorCode.MethodNotFound, 'Method not found'); },
        listResourceTemplates: async () => { throw new Error('Server "x" does not support resources'); },
        readResource: async () => { throw new McpError(ErrorCode.MethodNotFound, 'Method not found'); },
      })();
    });
    expect(await src.listResources!()).toEqual([]);
    expect(await src.listResourceTemplates!()).toEqual([]);
    await expect(src.readResource!('u')).rejects.toThrow('Method not found');
    expect(made).toBe(1);
  });
  it('a transport failure while listing rejects and reconnects next time', async () => {
    let made = 0;
    const src = createLoopbackMcpSource('http://127.0.0.1:1/', {}, () => {
      made++;
      const n = made;
      return client({ listResources: async () => { if (n === 1) throw new Error('socket closed'); return { resources: [{ uri: 'a', name: 'A' }] }; } })();
    });
    await expect(src.listResources!()).rejects.toThrow('socket closed');
    expect((await src.listResources!()).length).toBe(1);
    expect(made).toBe(2);
  });
});

describe('RemoteHostTools resource requests', () => {
  const source = (over: Partial<HostMcpSource> = {}): HostMcpSource => ({
    listTools: async () => [{ name: 'get_doc', inputSchema: { type: 'object' } }],
    callTool: async () => ({ content: [] }), close: async () => undefined,
    listResources: async () => [{ uri: 'docs://w/a.md', name: 'a' }],
    listResourceTemplates: async () => [],
    readResource: async (uri) => [{ uri, mimeType: 'text/markdown', text: '# A' }],
    ...over,
  });
  it('serves list, templates and read for an offered server', async () => {
    const t = new RemoteHostTools({ mcpSources: { compass: source() }, overrides: { compass: 'host' } });
    await t.manifest();
    expect(decodeResourceList((await t.invoke('compass', HOST_RESOURCE_TOOLS.list, {})).text)).toEqual({ ok: true, value: [{ uri: 'docs://w/a.md', name: 'a' }] });
    expect(decodeResourceTemplates((await t.invoke('compass', HOST_RESOURCE_TOOLS.templates, {})).text)).toEqual({ ok: true, value: [] });
    const read = await t.invoke('compass', HOST_RESOURCE_TOOLS.read, { uri: 'docs://w/a.md' });
    expect(read.success).toBe(true);
    expect(decodeResourceContents(read.text)).toEqual({ ok: true, value: [{ uri: 'docs://w/a.md', mimeType: 'text/markdown', text: '# A' }] });
  });
  it('refuses servers that were not offered, bad uris, and sources without resources; hides transport errors', async () => {
    const logs: string[] = [];
    const t = new RemoteHostTools({
      mcpSources: { compass: source(), off: source(), plain: { listTools: async () => [{ name: 'x', inputSchema: { type: 'object' } }], callTool: async () => ({ content: [] }), close: async () => undefined }, boom: source({ listResources: async () => { throw new Error('ECONNREFUSED http://127.0.0.1:9'); } }) },
      overrides: { compass: 'host', plain: 'host', boom: 'host' }, log: (m) => logs.push(m),
    });
    await t.manifest();
    expect((await t.invoke('off', HOST_RESOURCE_TOOLS.list, {})).success).toBe(false);
    expect((await t.invoke('claude_threads', HOST_RESOURCE_TOOLS.list, {})).success).toBe(false);
    expect((await t.invoke('compass', HOST_RESOURCE_TOOLS.read, { uri: 5 })).success).toBe(false);
    // A source with no resource support lists as empty, but cannot read.
    expect(decodeResourceList((await t.invoke('plain', HOST_RESOURCE_TOOLS.list, {})).text)).toEqual({ ok: true, value: [] });
    expect((await t.invoke('plain', HOST_RESOURCE_TOOLS.read, { uri: 'u' })).success).toBe(false);
    const boom = await t.invoke('boom', HOST_RESOURCE_TOOLS.list, {});
    expect(boom.success).toBe(false);
    expect(boom.text).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
    expect(logs.join(' ')).toContain('ECONNREFUSED');
  });
  it('relays an upstream MCP error for an unknown uri so the model can read it', async () => {
    const t = new RemoteHostTools({
      mcpSources: { compass: source({ readResource: async () => { throw new McpError(ErrorCode.InvalidParams, 'Resource not found: docs://w/nope'); } }) },
      overrides: { compass: 'host' },
    });
    await t.manifest();
    const out = await t.invoke('compass', HOST_RESOURCE_TOOLS.read, { uri: 'docs://w/nope' });
    expect(out).toMatchObject({ success: false });
    expect(out.text).toContain('Resource not found');
  });
});

describe('HostToolExecutor resource gate', () => {
  const rig = (manifest = manifestFromSpecs([spec('get_doc', 'compass')])) => {
    const results: Array<{ callId: string; success: boolean; text: string }> = [];
    const invoke = vi.fn(async () => ({ success: true, text: '{"resources":[]}' }));
    const requestPermission = vi.fn(async () => true);
    const ex = new HostToolExecutor({ manifest: () => manifest, invoke, requestPermission, slots: new HostToolSlots(), sendResult: async (callId, r) => { results.push({ callId, ...r }); } });
    return { ex, results, invoke, requestPermission };
  };
  const tick = () => new Promise((r) => setTimeout(r, 5));
  it('runs a resource request for an offered server without an approval card', async () => {
    const { ex, results, invoke, requestPermission } = rig();
    ex.handleCall({ callId: 'c1', threadId: 't', server: 'compass', tool: 'resources/list', input: {} });
    await tick();
    expect(invoke).toHaveBeenCalledWith('compass', 'resources/list', {}, expect.anything());
    expect(requestPermission).not.toHaveBeenCalled();
    expect(results).toEqual([{ callId: 'c1', success: true, text: '{"resources":[]}' }]);
  });
  it('refuses a resource request for a server the client did not offer, including prototype keys', async () => {
    const { ex, results, invoke } = rig();
    ex.handleCall({ callId: 'c1', threadId: 't', server: 'other', tool: 'resources/list', input: {} });
    ex.handleCall({ callId: 'c2', threadId: 't', server: 'constructor', tool: 'resources/read', input: { uri: 'u' } });
    await tick();
    expect(invoke).not.toHaveBeenCalled();
    expect(results.every((r) => !r.success)).toBe(true);
  });
});

describe('daemon broker resource requests', () => {
  it('issues a tool.call for an offered proxied server and refuses claude_threads and unknown servers', async () => {
    const events: WireEvent[] = [];
    const broker = new HostToolBroker({ graceMs: 50, timeoutMs: 1000, emit: (_t, e) => events.push(e), newId: () => 'id1' });
    broker.setManifest('t', { compass: [spec('get_doc', 'compass')], claude_threads: [spec('vault_search', 'claude_threads')] }, 1);
    broker.setSeatHolder('t', 1);
    const pending = broker.call('t', 'compass', HOST_RESOURCE_TOOLS.list, {});
    expect(events[0]).toMatchObject({ name: 'tool.call', args: { server: 'compass', tool: 'resources/list' } });
    broker.resolve('t', 'id1', { success: true, text: '{"resources":[]}' }, 'c');
    expect(await pending).toMatchObject({ success: true });
    expect((await broker.call('t', 'claude_threads', HOST_RESOURCE_TOOLS.list, {})).success).toBe(false);
    expect((await broker.call('t', 'nope', HOST_RESOURCE_TOOLS.read, { uri: 'u' })).success).toBe(false);
  });
});

describe('host MCP server resources', () => {
  async function connect(opts: Partial<Parameters<typeof createHostMcpServer>[0]>) {
    const handle = createHostMcpServer({ name: 'compass', proxied: () => [spec('get_doc', 'compass')], call: async () => ({ success: true, text: '{}' }), ...opts });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await (handle.config as unknown as { instance: { connect(t: unknown): Promise<void> } }).instance.connect(a);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(b);
    return client;
  }
  it('advertises resources for a proxied server and proxies list, templates and read through call()', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const client = await connect({
      resources: true,
      call: async (tool, input) => {
        calls.push([tool, input]);
        if (tool === 'resources/list') return { success: true, text: encodeResourceList([{ uri: 'docs://w/a.md', name: 'a' }]) };
        if (tool === 'resources/templates/list') return { success: true, text: encodeResourceTemplates([{ uriTemplate: 'docs://w/{p}', name: 't' }]) };
        return { success: true, text: encodeResourceContents([{ uri: input.uri, mimeType: 'text/markdown', text: '# A' }]) };
      },
    });
    expect(client.getServerCapabilities()?.resources).toBeDefined();
    expect((await client.listResources()).resources).toEqual([{ uri: 'docs://w/a.md', name: 'a' }]);
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([{ uriTemplate: 'docs://w/{p}', name: 't' }]);
    expect((await client.readResource({ uri: 'docs://w/a.md' })).contents).toEqual([{ uri: 'docs://w/a.md', mimeType: 'text/markdown', text: '# A' }]);
    expect(calls.map((c) => c[0])).toEqual(['resources/list', 'resources/templates/list', 'resources/read']);
    await client.close();
  });
  it('does not advertise resources unless asked (claude_threads), and rejects the method', async () => {
    const client = await connect({});
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    await expect(client.listResources()).rejects.toThrow();
    await client.close();
  });
  it('turns a host failure or a malformed answer into a clear MCP error', async () => {
    const failing = await connect({ resources: true, call: async () => ({ success: false, text: 'Resource not found: docs://w/nope' }) });
    await expect(failing.readResource({ uri: 'docs://w/nope' })).rejects.toThrow('Resource not found');
    await expect(failing.listResources()).rejects.toThrow('Resource not found');
    await failing.close();
    const garbage = await connect({ resources: true, call: async () => ({ success: true, text: 'not json' }) });
    await expect(garbage.listResources()).rejects.toThrow('unreadable');
    await garbage.close();
    const gone = await connect({ resources: true, proxied: () => [] });
    await expect(gone.listResources()).rejects.toThrow('not available');
    await gone.close();
  });
  it('refuses a malformed uri without asking the host', async () => {
    const call = vi.fn(async () => ({ success: true, text: '{}' }));
    const client = await connect({ resources: true, call });
    await expect(client.readResource({ uri: 'a\nb' })).rejects.toThrow('control characters');
    expect(call).not.toHaveBeenCalled();
    await client.close();
  });
});

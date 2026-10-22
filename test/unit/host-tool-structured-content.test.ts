import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HOST_TOOL_LIMITS, asStructuredContent, fitStructuredContent, manifestFromSpecs, type RemoteHostToolSpec } from '../../src/protocol';
import { HostToolExecutor, HostToolSlots } from '../../src/remote/hostToolExecutor';
import { RemoteHostTools } from '../../src/remote/hostTools';
import type { HostMcpSource } from '../../src/remote/hostMcpClient';
import { HostToolBroker } from '../../daemon/hostTools';
import { createHostMcpServer } from '../../daemon/hostMcpServer';

const IMG = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
const upload = { ok: true, message: 'ready', data: { clientToken: 'tok-secret', receipt: 'r1' } };
const LARGE = { rows: 'x'.repeat(1_000_000), nested: { a: [1, { b: 2 }] } };
const OVER = { big: 'x'.repeat(HOST_TOOL_LIMITS.maxResultFrameChars + 1) };

async function proxied(result: Record<string, unknown>) {
  const source: HostMcpSource = {
    listTools: async () => [{ name: 'prepare', inputSchema: { type: 'object' } }],
    callTool: async () => result as never,
    close: async () => undefined,
  };
  const tools = new RemoteHostTools({ mcpSources: { compass: source }, overrides: { mcp: 'host' } });
  await tools.manifest();
  return tools;
}

describe('asStructuredContent / fitStructuredContent', () => {
  it('passes an object through by reference, unchanged', () => {
    expect(asStructuredContent(upload)).toBe(upload);
    expect(asStructuredContent(LARGE)).toBe(LARGE);
  });
  it('treats non-objects as absent (the MCP result schema would reject them)', () => {
    for (const v of [undefined, null, 'x', 5, true, [1], [{ a: 1 }]]) expect(asStructuredContent(v)).toBeUndefined();
  });
  it('keeps a large object that fits the frame budget, intact', () => {
    expect(fitStructuredContent(LARGE, 't')).toEqual({ text: 't', structuredContent: LARGE });
  });
  it('over budget (by UTF-8 bytes) or unserializable: omitted, and the text says so', () => {
    const over = fitStructuredContent(OVER, 't');
    expect(over.structuredContent).toBeUndefined();
    expect(over.text).toMatch(/^t\n\[\.\.\. structured output omitted: it is \d+ bytes/);
    // 3-byte characters: under the limit in characters, over it in bytes
    expect(fitStructuredContent({ s: '€'.repeat(Math.ceil(HOST_TOOL_LIMITS.maxResultFrameChars / 3)) }, 't').structuredContent).toBeUndefined();
    const cyc: Record<string, unknown> = {}; cyc.self = cyc;
    const bad = fitStructuredContent(cyc, 't');
    expect(bad.structuredContent).toBeUndefined();
    expect(bad.text).toContain('not serializable');
  });
});

describe('plugin side: RemoteHostTools / HostToolExecutor', () => {
  it('forwards structuredContent from a proxied tool, without _meta', async () => {
    const tools = await proxied({ content: [{ type: 'text', text: 'summary' }], structuredContent: upload, _meta: { x: 1 } });
    expect(await tools.invoke('compass', 'prepare', {})).toEqual({ success: true, text: 'summary', structuredContent: upload });
  });
  it('is absent when the tool returned none, and mixes with images', async () => {
    expect(await (await proxied({ content: [{ type: 'text', text: 'plain' }] })).invoke('compass', 'prepare', {})).toEqual({ success: true, text: 'plain' });
    const mixed = await (await proxied({ content: [{ type: 'text', text: 't' }, IMG], structuredContent: { a: 1 } })).invoke('compass', 'prepare', {});
    expect(mixed).toEqual({ success: true, text: 't', content: [IMG], structuredContent: { a: 1 } });
  });
  it('drops only non-object values, passes a large object intact, and keeps isError', async () => {
    for (const bad of [[1, 2], 'str', 7, null]) {
      expect(await (await proxied({ content: [{ type: 'text', text: 't' }], structuredContent: bad })).invoke('compass', 'prepare', {})).toEqual({ success: true, text: 't' });
    }
    expect(await (await proxied({ content: [{ type: 'text', text: 't' }], structuredContent: LARGE })).invoke('compass', 'prepare', {})).toEqual({ success: true, text: 't', structuredContent: LARGE });
    expect(await (await proxied({ isError: true, content: [{ type: 'text', text: 'no' }], structuredContent: { e: 1 } })).invoke('compass', 'prepare', {}))
      .toEqual({ success: false, text: 'no', structuredContent: { e: 1 } });
  });
  it('the executor sends it on the wire result and re-sanitizes', async () => {
    const spec: RemoteHostToolSpec = { name: 'prepare', description: '', inputSchema: { type: 'object' }, requiresApproval: false, server: 'compass' };
    const results: Array<Record<string, unknown>> = [];
    let out: Record<string, unknown> = { success: true, text: 'x', structuredContent: upload };
    const ex = new HostToolExecutor({
      manifest: () => manifestFromSpecs([spec]), invoke: vi.fn(async () => out as never), requestPermission: async () => true,
      slots: new HostToolSlots(), sendResult: async (callId, r) => { results.push({ callId, ...r }); },
    });
    const call = (callId: string) => ({ callId, threadId: 't', server: 'compass', tool: 'prepare', input: {} });
    ex.handleCall(call('a')); await new Promise((r) => setTimeout(r, 5));
    out = { success: true, text: 'x', structuredContent: [1] };
    ex.handleCall(call('b')); await new Promise((r) => setTimeout(r, 5));
    expect(results).toEqual([{ callId: 'a', success: true, text: 'x', structuredContent: upload }, { callId: 'b', success: true, text: 'x' }]);
  });
  it('an over-budget structuredContent never reaches the frame: the call still succeeds and the text tells the model', async () => {
    const spec: RemoteHostToolSpec = { name: 'prepare', description: '', inputSchema: { type: 'object' }, requiresApproval: false, server: 'compass' };
    const results: Array<Record<string, unknown>> = [];
    const ex = new HostToolExecutor({
      manifest: () => manifestFromSpecs([spec]), invoke: async () => ({ success: true, text: 'summary', content: [IMG], structuredContent: OVER }) as never,
      requestPermission: async () => true, slots: new HostToolSlots(), sendResult: async (callId, r) => { results.push({ callId, ...r }); },
    });
    ex.handleCall({ callId: 'o', threadId: 't', server: 'compass', tool: 'prepare', input: {} });
    await new Promise((r) => setTimeout(r, 20));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ success: true, content: [IMG] });
    expect(results[0].structuredContent).toBeUndefined();
    expect(String(results[0].text)).toContain('structured output omitted');
    expect(JSON.stringify(results[0]).length).toBeLessThan(HOST_TOOL_LIMITS.maxResultFrameChars);
  });
});

describe('daemon side: HostToolBroker', () => {
  function rig() {
    const audit: Array<Record<string, unknown>> = [];
    const events: Array<{ name: string; args: Record<string, unknown> }> = [];
    const broker = new HostToolBroker({ graceMs: 50, timeoutMs: 500, emit: (_t, e) => events.push(e as never), audit: (r) => audit.push(r), newId: () => 'id1' });
    broker.setManifest('t', manifestFromSpecs([{ name: 'prepare', description: '', inputSchema: { type: 'object' }, requiresApproval: false, server: 'compass' }]));
    broker.setAttached('t', true);
    return { broker, audit, events };
  }
  it('resolves with structuredContent, but never audits or journals its content', async () => {
    const { broker, audit, events } = rig();
    const p = broker.call('t', 'compass', 'prepare', {});
    broker.resolve('t', 'id1', { success: true, text: 's', structuredContent: upload }, 'c');
    expect(await p).toEqual({ success: true, text: 's', structuredContent: upload });
    expect(JSON.stringify(audit)).not.toContain('tok-secret');
    expect(JSON.stringify(events)).not.toContain('tok-secret');
  });
  it('passes a large object through unchanged; old client shape (no field) and non-objects resolve as text-only', async () => {
    {
      const { broker } = rig();
      const p = broker.call('t', 'compass', 'prepare', {});
      broker.resolve('t', 'id1', { success: true, text: 's', structuredContent: LARGE }, 'c');
      expect(await p).toEqual({ success: true, text: 's', structuredContent: LARGE });
    }
    for (const sc of [undefined, [1], 'x']) {
      const { broker } = rig();
      const p = broker.call('t', 'compass', 'prepare', {});
      broker.resolve('t', 'id1', { success: true, text: 's', structuredContent: sc }, 'c');
      expect(await p).toEqual({ success: true, text: 's' });
    }
  });
});

describe('daemon hostMcpServer toResult', () => {
  async function callWith(outcome: Record<string, unknown>) {
    const handle = createHostMcpServer({
      name: 'compass', proxied: () => [{ name: 'prepare', description: 'd', inputSchema: { type: 'object' }, requiresApproval: false, server: 'compass' }],
      call: async () => outcome as never,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await (handle.config as unknown as { instance: { connect(t: unknown): Promise<void> } }).instance.connect(a);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(b);
    const r = await client.callTool({ name: 'prepare', arguments: {} });
    await client.close();
    return r;
  }
  it('adds structuredContent next to text and images; isError unchanged', async () => {
    expect(await callWith({ success: true, text: 's', content: [IMG], structuredContent: upload }))
      .toMatchObject({ content: [{ type: 'text', text: 's' }, IMG], structuredContent: upload });
    expect(await callWith({ success: false, text: 'bad', structuredContent: { e: 1 } })).toMatchObject({ isError: true, structuredContent: { e: 1 } });
  });
  it('omits it when the outcome has none (old plugin)', async () => {
    const r = await callWith({ success: true, text: 's' });
    expect(r.structuredContent).toBeUndefined();
    expect(r.content).toEqual([{ text: 's', type: 'text' }]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  HOST_TOOL_LIMITS, checkCallInput, clampResultText, findManifestTool, manifestFromSpecs, manifestSignature,
  sanitizeResultContent, specsFromManifest, validateHostToolSpecs, validateManifestServers, validateToolResultPayload,
} from '../../src/protocol';
import { APPROVAL_DETAIL_LIMIT, HostToolExecutor, HostToolSlots, describeCallForApproval } from '../../src/remote/hostToolExecutor';
import { RemoteHostTools, describeHostToolsForPrompt } from '../../src/remote/hostTools';
import { createLoopbackMcpSource, type HostMcpSource } from '../../src/remote/hostMcpClient';
import { describeDroppedMcp, isLoopbackUrl, partitionExternalMcpServers } from '../../src/remote/mcpPartition';
import { HOST_TOOLS_PLACEHOLDER, applyHostToolsPrompt, buildRemoteEnvironmentPrompt, projectSessionOptions } from '../../src/remote/sessionSpec';
import { HostToolBroker } from '../../daemon/hostTools';
import type { HarnessDynamicTool } from '../../src/HarnessSession';
import type { Thread } from '../../src/types';

const spec = (name: string, server = 'claude_threads', requiresApproval = false) =>
  ({ name, description: 'd', inputSchema: { type: 'object' }, requiresApproval, server });
const dyn = (name: string, requiresApproval = false, text = 'ok'): HarnessDynamicTool =>
  ({ name, description: 'd', inputSchema: { type: 'object' }, requiresApproval, invoke: async () => ({ success: true, text }) });

describe('protocol host-tool rules', () => {
  it('validates names, servers, sizes and uniqueness', () => {
    expect(validateHostToolSpecs([spec('a'), spec('b')])).toBeNull();
    expect(validateHostToolSpecs([spec('a'), spec('a')])).toContain('twice');
    expect(validateHostToolSpecs([{ ...spec('a'), name: 'a b' }])).toContain('name');
    expect(validateHostToolSpecs([{ ...spec('a'), server: 'x/y' }])).toContain('server');
    expect(validateHostToolSpecs([{ ...spec('a'), requiresApproval: 'no' }])).toContain('requiresApproval');
    expect(validateHostToolSpecs([{ ...spec('a'), inputSchema: { x: 'y'.repeat(70_000) } }])).toContain('too large');
    expect(validateHostToolSpecs(Array.from({ length: HOST_TOOL_LIMITS.maxTools + 1 }, (_, i) => spec(`t${i}`)))).toContain('too many');
    expect(validateHostToolSpecs('x')).toContain('array');
  });
  it('validates the manifest form and that keys match', () => {
    expect(validateManifestServers({ claude_threads: [spec('a')], 'google-docs': [spec('r', 'google-docs')] })).toBeNull();
    expect(validateManifestServers({ a: [spec('x', 'b')] })).toContain('must be "a"');
    expect(validateManifestServers(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`s${i}`, []])))).toContain('too many servers');
    expect(validateManifestServers({ a: 'x' })).toContain('array');
  });
  it('round-trips flat <-> manifest and signs deterministically', () => {
    const flat = [spec('a'), spec('r', 'google-docs'), spec('b')];
    const m = manifestFromSpecs(flat);
    expect(Object.keys(m).sort()).toEqual(['claude_threads', 'google-docs']);
    expect(specsFromManifest(m).map((t) => t.name)).toEqual(['a', 'b', 'r']);
    expect(manifestSignature(m)).toBe(manifestSignature(manifestFromSpecs([...flat].reverse().sort((x, y) => (x.name < y.name ? -1 : 1)))));
    expect(manifestSignature(m)).not.toBe(manifestSignature(manifestFromSpecs([spec('a')])));
  });
  it('findManifestTool is exact and ignores prototype keys', () => {
    const m = manifestFromSpecs([spec('a')]);
    expect(findManifestTool(m, 'claude_threads', 'a')?.name).toBe('a');
    expect(findManifestTool(m, 'claude_threads', 'A')).toBeUndefined();
    expect(findManifestTool(m, 'toString', 'a')).toBeUndefined();
    expect(findManifestTool(m, 'constructor', 'a')).toBeUndefined();
    expect(findManifestTool(undefined, 'x', 'a')).toBeUndefined();
  });
  it('bounds inputs and results; results keep only text and bounded images', () => {
    expect(checkCallInput({ a: 1 })).toBeNull();
    expect(checkCallInput([])).toContain('object');
    expect(checkCallInput({ a: 'x'.repeat(300_000) })).toContain('too large');
    expect(clampResultText('abc', 10)).toEqual({ text: 'abc', truncated: false });
    expect(clampResultText('x'.repeat(20), 10).text).toContain('truncated');
    expect(validateToolResultPayload({ text: 'x' })).toBeNull();
    expect(validateToolResultPayload({ text: 5 })).toContain('string');
    expect(validateToolResultPayload({ text: 'x', content: [{}] })).toContain('type');
    const blocks = sanitizeResultContent([
      { type: 'resource', uri: 'file:///etc/passwd' }, { type: 'text', text: 'x' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'image', data: 'AAAA', mimeType: 'text/html' },
      { type: 'image', data: '<script>', mimeType: 'image/png' }, { type: 'image', source: { data: 'BBBB', media_type: 'image/jpeg' } },
    ]);
    expect(blocks).toEqual([{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' }]);
    expect(sanitizeResultContent(Array.from({ length: 20 }, () => ({ type: 'image', data: 'AAAA', mimeType: 'image/png' })))).toHaveLength(HOST_TOOL_LIMITS.maxResultContentBlocks);
  });
});

describe('RemoteHostTools manifest', () => {
  it('offers host-routed built-ins only, honours overrides, and runs the handler', async () => {
    const tools = new RemoteHostTools({
      builtIn: [dyn('vault_search', false, 'found'), dyn('enter_worktree'), dyn('vm_exec'), dyn('github_list_access'), dyn('contributed_x'), dyn('threads_list'), dyn('threads_archive'), dyn('request_secret')],
      overrides: { vault: 'host', threads_archive: 'host', request_secret: 'host' },
    });
    const m = await tools.manifest();
    // threads is not switched on; threads_archive and request_secret are never offered, whatever is listed.
    expect(m.claude_threads.map((t) => t.name)).toEqual(['vault_search']);
    expect(tools.summary.builtIn).toEqual(['vault_search']);
    expect(await tools.invoke('claude_threads', 'vault_search', {})).toEqual({ success: true, text: 'found' });
    expect(await tools.invoke('claude_threads', 'enter_worktree', {})).toMatchObject({ success: false });
  });
  it('lists broker tools, skips drive-files and failing sources, marks unknown tools as needing approval', async () => {
    const ok: HostMcpSource = {
      listTools: async () => [{ name: 'read_doc', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }, { name: 'update_doc', inputSchema: { type: 'object' } }],
      callTool: async () => ({ content: [{ type: 'text', text: 'body' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] }), close: async () => undefined,
    };
    const bad: HostMcpSource = { listTools: async () => { throw new Error('down'); }, callTool: async () => ({ content: [] }), close: async () => undefined };
    const tools = new RemoteHostTools({ mcpSources: { 'google-docs': ok, 'google-drive-files': ok, flaky: bad }, overrides: { mcp: 'host' } });
    const m = await tools.manifest();
    expect(Object.keys(m)).toEqual(['google-docs']);
    expect(m['google-docs'].map((t) => [t.name, t.requiresApproval])).toEqual([['read_doc', false], ['update_doc', true]]);
    expect(tools.summary.skipped.map((s) => s.server).sort()).toEqual(['flaky', 'google-drive-files']);
    expect(await tools.invoke('google-docs', 'read_doc', {})).toEqual({ success: true, text: 'body', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] });
    // Off by default; on by group or by naming the server; a server can be excluded from the group.
    expect(await new RemoteHostTools({ mcpSources: { 'google-docs': ok } }).manifest()).toEqual({});
    expect(Object.keys(await new RemoteHostTools({ mcpSources: { 'google-docs': ok }, overrides: { 'google-docs': 'host' } }).manifest())).toEqual(['google-docs']);
    expect(await new RemoteHostTools({ mcpSources: { 'google-docs': ok }, overrides: { mcp: 'host', 'google-docs': 'absent' } }).manifest()).toEqual({});
  });
  it('offers nothing by default: with no groups switched on the manifest is empty', async () => {
    const tools = new RemoteHostTools({
      builtIn: [dyn('vault_search'), dyn('threads_get_log'), dyn('browser_navigate'), dyn('workspace_get_active_file'), dyn('skills_list_installed')],
      mcpSources: { 'google-docs': { listTools: async () => [{ name: 'read_doc', inputSchema: { type: 'object' } }], callTool: async () => ({ content: [] }), close: async () => undefined } },
    });
    expect(await tools.manifest()).toEqual({});
    expect(tools.summary.builtIn).toEqual([]);
  });
  it('a read group switched on offers its read tools and still never the state-changing ones', async () => {
    const names = ['vault_search', 'vault_restore_file_version', 'vault_add_bridge', 'threads_list', 'threads_send_message', 'host_execute_command', 'CronCreate', 'skills_install', 'browser_eval'];
    const tools = new RemoteHostTools({ builtIn: names.map((n) => dyn(n)), overrides: { vault: 'host', threads: 'host', workspace: 'host', schedule: 'host', skills: 'host', browser: 'host', misc: 'host' } });
    const m = await tools.manifest();
    expect(m.claude_threads.map((t) => t.name).sort()).toEqual(['threads_list', 'vault_search']);
  });
  it('does not hand a thrown error message (paths, loopback addresses) to the daemon', async () => {
    const logs: string[] = [];
    const boom = { ...dyn('vault_search'), invoke: async () => { throw new Error('ENOENT /Users/someone/secret http://127.0.0.1:5555'); } };
    const tools = new RemoteHostTools({ builtIn: [boom], overrides: { vault: 'host' }, log: (m) => logs.push(m) });
    await tools.manifest();
    const out = await tools.invoke('claude_threads', 'vault_search', {});
    expect(out.success).toBe(false);
    expect(out.text).not.toMatch(/Users|127\.0\.0\.1|ENOENT/);
    expect(logs.join(' ')).toContain('ENOENT');
  });
  it('describes what is available for the environment prompt', () => {
    expect(describeHostToolsForPrompt(null, 'Geode').join('\n')).toContain('not available');
    const text = describeHostToolsForPrompt({ builtIn: ['vault_search'], servers: { 'google-docs': ['read_doc'] }, skipped: [] }, 'Geode').join('\n');
    expect(text).toContain('mcp__claude_threads__*: vault_search');
    expect(text).toContain('mcp__google-docs__*: read_doc');
    expect(text).toContain('only while Geode is connected');
    expect(text).toContain('Worktree tools');
  });
  it('the prompt placeholder is filled in or falls back', () => {
    const p = buildRemoteEnvironmentPrompt('/x', 'box', 'Geode', undefined, { hostTools: true });
    expect(p).toContain(HOST_TOOLS_PLACEHOLDER);
    expect(applyHostToolsPrompt(p, { builtIn: ['vault_search'], servers: {}, skipped: [] }, 'Geode')).toContain('vault_search');
    expect(applyHostToolsPrompt(p, null, 'Geode')).not.toContain(HOST_TOOLS_PLACEHOLDER);
    expect(buildRemoteEnvironmentPrompt('/x', 'box', 'Geode')).toContain('not available in this session');
  });
});

describe('HostToolExecutor gate', () => {
  function rig(over: Partial<ConstructorParameters<typeof HostToolExecutor>[0]> = {}, manifest = manifestFromSpecs([spec('read'), spec('write', 'claude_threads', true)])) {
    const results: Array<{ callId: string; success: boolean; text: string }> = [];
    const invoke = vi.fn(async () => ({ success: true, text: 'did it' }));
    const requestPermission = vi.fn(async () => true);
    const ex = new HostToolExecutor({
      manifest: () => manifest, invoke, requestPermission, slots: new HostToolSlots(),
      sendResult: async (callId, r) => { results.push({ callId, ...r }); }, ...over,
    });
    return { ex, results, invoke, requestPermission };
  }
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const call = (callId: string, tool: string, server = 'claude_threads', input: unknown = {}) => ({ callId, threadId: 't', server, tool, input });

  it('runs a manifest tool and returns the result', async () => {
    const { ex, results, invoke } = rig();
    ex.handleCall(call('c1', 'read'));
    await tick();
    expect(invoke).toHaveBeenCalledWith('claude_threads', 'read', {}, expect.anything());
    expect(results).toEqual([{ callId: 'c1', success: true, text: 'did it' }]);
  });
  it('refuses names outside the manifest, wrong servers, and prototype tricks', async () => {
    const { ex, results, invoke } = rig();
    for (const [i, c] of [call('a', 'delete_everything'), call('b', 'read', 'other'), call('c', '__proto__'), call('d', 'read', 'constructor')].entries()) { ex.handleCall(c); void i; }
    await tick();
    expect(invoke).not.toHaveBeenCalled();
    expect(results).toHaveLength(4);
    expect(results.every((r) => !r.success && r.text.includes('not offered'))).toBe(true);
  });
  it('ignores a frame with no usable call id and answers a malformed one', async () => {
    const { ex, results } = rig();
    ex.handleCall(null);
    ex.handleCall({ callId: '' });
    ex.handleCall({ callId: 'x'.repeat(200) });
    ex.handleCall({ callId: 'ok', server: 1, tool: 2 });
    await tick();
    expect(results).toEqual([{ callId: 'ok', success: false, text: 'Malformed host tool call.' }]);
  });
  it('rejects oversized and non-object input', async () => {
    const { ex, results, invoke } = rig();
    ex.handleCall(call('a', 'read', 'claude_threads', 'str'));
    ex.handleCall(call('b', 'read', 'claude_threads', { x: 'y'.repeat(300_000) }));
    await tick();
    expect(invoke).not.toHaveBeenCalled();
    expect(results.map((r) => r.success)).toEqual([false, false]);
  });
  it('gates a requiresApproval tool through the normal permission path, regardless of what the daemon says', async () => {
    const { ex, results, invoke, requestPermission } = rig();
    requestPermission.mockResolvedValueOnce(false);
    ex.handleCall(call('a', 'write'));
    await tick();
    expect(requestPermission).toHaveBeenCalledWith('mcp__claude_threads__write', expect.stringContaining('write'));
    expect(invoke).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ success: false, text: 'The user denied this tool call.' });
    ex.handleCall(call('b', 'write'));
    await tick();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('has no approval carry-over: every call to an approval tool asks again', async () => {
    const { ex, requestPermission, invoke } = rig();
    expect((ex as unknown as { recordApproval?: unknown }).recordApproval).toBeUndefined();
    requestPermission.mockResolvedValue(true);
    ex.handleCall(call('a', 'write'));
    ex.handleCall(call('b', 'write'));
    await tick();
    expect(requestPermission).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('shows an explicit marker and refuses to run input too long to be shown on the card', async () => {
    const { ex, results, invoke, requestPermission } = rig();
    const big = 'x'.repeat(APPROVAL_DETAIL_LIMIT + 5000);
    const card = describeCallForApproval('write', { data: big });
    expect(card.unseenBytes).toBeGreaterThan(4000);
    expect(card.detail).toMatch(/\(\d+ more bytes not shown\)$/);
    ex.handleCall(call('a', 'write', 'claude_threads', { data: big }));
    await tick();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(results[0].success).toBe(false);
    expect(results[0].text).toMatch(/too long to show the user in full/);
  });
  it('shows input between the old 4 KB cap and the new cap in full on the card', async () => {
    const { ex, invoke, requestPermission } = rig();
    requestPermission.mockResolvedValueOnce(true);
    const body = 'y'.repeat(21_000);
    ex.handleCall(call('a', 'write', 'claude_threads', { data: body }));
    await tick();
    expect(requestPermission).toHaveBeenCalledWith('mcp__claude_threads__write', expect.stringContaining(body));
    expect(requestPermission).toHaveBeenCalledWith('mcp__claude_threads__write', expect.not.stringContaining('not shown'));
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('runs pre-approved input of any size without a card, but only asks isPreApproved for tools that need approval', async () => {
    const isPreApproved = vi.fn(() => true);
    const { ex, results, invoke, requestPermission } = rig({ isPreApproved });
    ex.handleCall(call('a', 'write', 'claude_threads', { data: 'z'.repeat(APPROVAL_DETAIL_LIMIT * 2) }));
    await tick();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(results[0].success).toBe(true);
  });
  it('still refuses over-cap input when the call is not pre-approved', async () => {
    const { ex, results, invoke, requestPermission } = rig({ isPreApproved: () => false });
    ex.handleCall(call('a', 'write', 'claude_threads', { data: 'z'.repeat(APPROVAL_DETAIL_LIMIT * 2) }));
    await tick();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(results[0].text).toMatch(/too long to show the user in full/);
  });
  it('runs input that fits the card completely, with no marker', async () => {
    const { ex, invoke, requestPermission } = rig();
    requestPermission.mockResolvedValueOnce(true);
    expect(describeCallForApproval('write', { data: 'short' }).unseenBytes).toBe(0);
    ex.handleCall(call('a', 'write', 'claude_threads', { data: 'short' }));
    await tick();
    expect(requestPermission).toHaveBeenCalledWith('mcp__claude_threads__write', expect.not.stringContaining('not shown'));
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('never forgets a running call when remembering finished ones', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = vi.fn(async (_s: string, tool: string) => { if (tool === 'slow') await gate; return { success: true, text: 'ok' }; });
    const { ex, results } = rig({ invoke: slow as never }, manifestFromSpecs([spec('read'), spec('slow')]));
    ex.handleCall(call('running', 'slow'));
    for (let i = 0; i < 100; i++) { ex.handleCall(call(`f${i}`, 'read')); if (i % 5 === 4) await tick(); }
    await tick();
    ex.handleCall(call('running', 'slow'), true); // reopened while still running: must NOT start a second run
    await tick();
    expect(slow.mock.calls.filter((c) => c[1] === 'slow')).toHaveLength(1);
    release();
    await tick();
    expect(results.some((r) => r.callId === 'running')).toBe(true);
  });
  it('does not run a call id twice; re-sends a finished result when the call is reopened', async () => {
    const { ex, results, invoke } = rig();
    ex.handleCall(call('a', 'read'));
    await tick();
    ex.handleCall(call('a', 'read'), false);
    await tick();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    ex.handleCall(call('a', 'read'), true);
    await tick();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
  });
  it('caps concurrent calls per thread and in total, and calls per minute', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = vi.fn(async () => { await gate; return { success: true, text: 'ok' }; });
    const { ex, results } = rig({ invoke: slow, slots: new HostToolSlots(3) });
    for (let i = 0; i < 5; i++) ex.handleCall(call(`c${i}`, 'read'));
    await tick();
    expect(slow).toHaveBeenCalledTimes(3);
    expect(results.filter((r) => r.text.includes('at once'))).toHaveLength(2);
    release();
    await tick();
    expect(results.filter((r) => r.success)).toHaveLength(3);

    let t = 0;
    const per = rig({ now: () => t });
    for (let i = 0; i < HOST_TOOL_LIMITS.maxCallsPerMinute + 3; i++) { per.ex.handleCall(call(`m${i}`, 'read')); await Promise.resolve(); }
    await tick();
    expect(per.results.filter((r) => r.text.includes('Too many host tool calls in the last minute'))).toHaveLength(3);
    t += 61_000;
    per.ex.handleCall(call('later', 'read'));
    await tick();
    expect(per.results.at(-1)).toMatchObject({ callId: 'later', success: true });
  });
  it('cancels a running call on tool.cancel and clamps oversized results', async () => {
    let seen: AbortSignal | undefined;
    const { ex, results } = rig({
      invoke: async (_s, _t, _i, signal) => { seen = signal; await new Promise((r) => signal.addEventListener('abort', r)); return { success: false, text: 'x'.repeat(2_000_000) }; },
    });
    ex.handleCall(call('a', 'read'));
    await tick();
    ex.handleCancel('a');
    await tick();
    expect(seen?.aborted).toBe(true);
    expect(results[0].text.length).toBeLessThan(1_100_000);
    expect(results[0].text).toContain('truncated');
  });
});

describe('HostToolBroker', () => {
  function rig(over: Partial<ConstructorParameters<typeof HostToolBroker>[0]> = {}) {
    const events: Array<{ threadId: string; event: { name: string; args: Record<string, unknown> } }> = [];
    let n = 0;
    const broker = new HostToolBroker({ graceMs: 50, timeoutMs: 80, emit: (threadId, event) => events.push({ threadId, event: event as never }), newId: () => `id${++n}`, ...over });
    broker.setManifest('t', manifestFromSpecs([spec('a')]));
    return { broker, events };
  }
  it('binds a call id to its thread', async () => {
    const { broker } = rig();
    broker.setAttached('t', true);
    broker.setManifest('u', manifestFromSpecs([spec('a')]));
    broker.setAttached('u', true);
    const p = broker.call('t', 'claude_threads', 'a', {});
    expect(broker.resolve('u', 'id1', { success: true, text: 'spoof' }, 'x')).toBe(false);
    expect(broker.resolve('t', 'id1', { success: true, text: 'real' }, 'x')).toBe(true);
    expect(await p).toEqual({ success: true, text: 'real' });
    expect(broker.resolve('t', 'id1', { success: true, text: 'again' }, 'x')).toBe(false);
  });
  it('fails after the grace period when nobody attaches, and issues on attach inside it', async () => {
    const { broker, events } = rig();
    const lost = await broker.call('t', 'claude_threads', 'a', {});
    expect(lost.success).toBe(false);
    expect(lost.text).toContain("Geode is not connected");
    expect(events.map((e) => e.event.name)).toEqual(['tool.unavailable']);
    const p = broker.call('t', 'claude_threads', 'a', {});
    setTimeout(() => broker.setAttached('t', true), 10);
    await new Promise((r) => setTimeout(r, 25));
    expect(events.at(-1)!.event.name).toBe('tool.call');
    broker.resolve('t', 'id2', { success: true, text: 'late but fine' }, 'x');
    expect((await p).text).toBe('late but fine');
  });
  it('shutdown and cancelThread settle everything', async () => {
    const { broker } = rig();
    broker.setAttached('t', true);
    const p = broker.call('t', 'claude_threads', 'a', {});
    broker.cancelThread('t');
    expect((await p).text).toContain('canceled');
    expect(broker.openCalls('t')).toBe(0);
  });
  it('an aborted signal cancels the call', async () => {
    const { broker, events } = rig();
    broker.setAttached('t', true);
    const ac = new AbortController();
    const p = broker.call('t', 'claude_threads', 'a', {}, ac.signal);
    ac.abort();
    expect((await p).success).toBe(false);
    expect(events.map((e) => e.event.name)).toEqual(['tool.call', 'tool.cancel']);
  });
});

describe('mcpPartition', () => {
  it('passes reachable header-less http/sse, drops stdio, loopback, secrets and credentialed servers with reasons', () => {
    const { passthrough, dropped } = partitionExternalMcpServers({
      docs: { type: 'http', url: 'https://mcp.example.com/x' },
      feed: { type: 'sse', url: 'https://feed.example.com/sse' },
      local: { type: 'http', url: 'http://localhost:9000/x' },
      loop: { type: 'http', url: 'http://127.0.0.1:1/x' },
      prog: { type: 'stdio', command: 'node', args: ['s.js'] },
      secret: { type: 'http', url: 'https://x.example.com', headers: { Authorization: 'Bearer ${TOKEN}' } },
      literal: { type: 'http', url: 'https://y.example.com', headers: { Authorization: 'Bearer abc' } },
    });
    expect(Object.keys(passthrough).sort()).toEqual(['docs', 'feed']);
    const why = Object.fromEntries(dropped.map((d) => [d.name, d.reason]));
    expect(why.local).toContain('on this computer');
    expect(why.loop).toContain('on this computer');
    expect(why.prog).toContain('program');
    expect(why.secret).toContain('secret');
    expect(why.literal).toContain('allowlist');
    expect(describeDroppedMcp(dropped, 'box')).toContain('Not available on box');
    expect(describeDroppedMcp([], 'box')).toBeUndefined();
  });
  it('an allowlist restricts to the listed servers and lets credentialed ones through', () => {
    const stored = {
      docs: { type: 'http' as const, url: 'https://mcp.example.com/x' },
      literal: { type: 'http' as const, url: 'https://y.example.com', headers: { Authorization: 'Bearer abc' } },
    };
    const { passthrough, dropped } = partitionExternalMcpServers(stored, ['literal']);
    expect(Object.keys(passthrough)).toEqual(['literal']);
    expect(passthrough.literal.headers).toEqual({ Authorization: 'Bearer abc' });
    expect(dropped.map((d) => d.name)).toEqual(['docs']);
  });
  it('recognizes loopback spellings', () => {
    for (const u of ['http://localhost/', 'http://a.localhost/', 'http://127.0.0.2/', 'http://[::1]:3/', 'http://0.0.0.0/', 'not a url',
      'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]:8080/x', 'http://[0:0:0:0:0:0:0:1]/', 'http://2130706433/']) expect(isLoopbackUrl(u), u).toBe(true);
    expect(isLoopbackUrl('https://example.com')).toBe(false);
    expect(isLoopbackUrl('http://[::ffff:8.8.8.8]/')).toBe(false);
  });
  it('drops a server whose URL carries a credential unless the user listed it; never sends it otherwise', () => {
    const stored = {
      userinfo: { type: 'http' as const, url: 'https://user:pw@mcp.example.com/x' },
      query: { type: 'http' as const, url: 'https://mcp.example.com/x?api_key=abcdef' },
      opaque: { type: 'sse' as const, url: 'https://mcp.example.com/x?s=Zm9vYmFyMTIzNDU2Nzg5MDEyMzQ1Ng1' },
      plain: { type: 'http' as const, url: 'https://mcp.example.com/x?page=2&q=hello' },
    };
    const { passthrough, dropped } = partitionExternalMcpServers(stored);
    expect(Object.keys(passthrough)).toEqual(['plain']);
    expect(dropped.map((d) => d.name).sort()).toEqual(['opaque', 'query', 'userinfo']);
    expect(dropped.every((d) => d.reason.includes('carries a credential'))).toBe(true);
    expect(Object.keys(partitionExternalMcpServers(stored, ['userinfo']).passthrough)).toEqual(['userinfo']);
  });
  it('projectSessionOptions puts only the vetted remote servers on the wire, never claude.mcpServers', () => {
    const t = { id: 't', remote: { daemonId: 'd', remoteCwd: '/w', lastSeq: 0 } } as unknown as Thread;
    const s = projectSessionOptions({
      cwd: '/w', permissionMode: 'default', extraEnvRaw: 'SECRET=1', callbacks: {} as never,
      claude: {
        mcpServers: { a: { type: 'http', url: 'https://leaky.example.com', headers: { h: 'Bearer leak' } }, b: { type: 'stdio', command: 'x' } } as never,
        remoteMcpServers: { ok: { type: 'http', url: 'https://x', headers: { h: 'v' } } },
      },
    }, t);
    expect(s.mcpServers).toEqual({ ok: { type: 'http', url: 'https://x', headers: { h: 'v' } } });
    expect(JSON.stringify(s)).not.toContain('Bearer leak');
    expect(s.extraEnvRaw).toBe('');
  });
});

describe('loopback MCP source', () => {
  it('connects lazily, lists, calls, and reconnects after a failure', async () => {
    let made = 0;
    const calls: string[] = [];
    const src = createLoopbackMcpSource('http://127.0.0.1:1/', { 'X-Capability-Token': 't' }, () => {
      made++;
      const fail = made === 1;
      return {
        connect: async () => { if (fail) throw new Error('refused'); },
        close: async () => undefined,
        listTools: async () => ({ tools: [{ name: 'x', inputSchema: { type: 'object' } }] }),
        callTool: async (p) => { calls.push(p.name); return { content: [{ type: 'text', text: 'r' }] }; },
      };
    });
    await expect(src.listTools()).rejects.toThrow('refused');
    expect((await src.listTools()).map((t) => t.name)).toEqual(['x']);
    expect((await src.callTool('x', {})).content).toHaveLength(1);
    expect(calls).toEqual(['x']);
    expect(made).toBe(2);
  });
});

/** A loopback source with `n` tools whose schema is `schemaChars` of padding (to model a real server's size). */
const bulkSource = (prefix: string, n: number, schemaChars = 0): HostMcpSource => ({
  listTools: async () => Array.from({ length: n }, (_, i) => ({
    name: `${prefix}_${i}`, description: 'd', inputSchema: { type: 'object', properties: schemaChars ? { p: { type: 'string', description: 'x'.repeat(schemaChars) } } : {} },
  })),
  callTool: async () => ({ content: [] }), close: async () => undefined,
});

describe('host-tool manifest caps', () => {
  it('allows a realistic multi-server manifest (512 tools, as on claude-box) without shedding anything', async () => {
    const tools = new RemoteHostTools({
      builtIn: [dyn('vault_search'), dyn('threads_list')],
      mcpSources: { vercel: bulkSource('v', 238, 1500), compass: bulkSource('c', 197, 1500), 'google-docs': bulkSource('g', 49, 1500), 'hiptrip-new': bulkSource('h', 16, 1500) },
      overrides: { mcp: 'host', vault: 'host', threads: 'host' },
    });
    const m = await tools.manifest();
    const count = Object.values(m).reduce((n, l) => n + l.length, 0);
    expect(count).toBe(2 + 238 + 197 + 49 + 16);
    expect(tools.summary.skipped).toEqual([]);
    expect(validateManifestServers(m)).toBeNull();
    expect(JSON.stringify(m).length).toBeLessThan(HOST_TOOL_LIMITS.maxManifestBytes);
  });

  it('over the tool cap sheds the largest server with a recorded count reason, and the result validates', async () => {
    const tools = new RemoteHostTools({
      mcpSources: { big: bulkSource('b', HOST_TOOL_LIMITS.maxTools - 10), small: bulkSource('s', 20) },
      overrides: { mcp: 'host' },
    });
    const m = await tools.manifest();
    expect(Object.keys(m)).toEqual(['small']);
    expect(tools.summary.skipped).toEqual([expect.objectContaining({ server: 'big', reason: `too many tools (${HOST_TOOL_LIMITS.maxTools + 10} > ${HOST_TOOL_LIMITS.maxTools})`, notify: true })]);
    expect(validateManifestServers(m)).toBeNull();
  });

  it('over the byte cap sheds the largest server by size, never claude_threads', async () => {
    const chunk = 60_000; // under the per-tool schema limit; 25 of them is 1.5 MB per server
    const tools = new RemoteHostTools({
      builtIn: [dyn('vault_search')],
      mcpSources: { fat: bulkSource('f', 25, chunk), fat2: bulkSource('g', 12, chunk), thin: bulkSource('t', 30) },
      overrides: { mcp: 'host', vault: 'host' },
    });
    const m = await tools.manifest();
    expect(Object.keys(m).sort()).toEqual(['claude_threads', 'fat2', 'thin']);
    const shed = tools.summary.skipped.find((s) => s.server === 'fat');
    expect(shed?.reason).toMatch(/^manifest too large \(/);
    expect(shed?.notify).toBe(true);
    expect(validateManifestServers(m)).toBeNull();
  });

  it('only a shed or failed server is flagged for a user notice, not "not turned on"', async () => {
    const boom: HostMcpSource = { listTools: async () => { throw new Error('down'); }, callTool: async () => ({ content: [] }), close: async () => undefined };
    const tools = new RemoteHostTools({ mcpSources: { off: bulkSource('o', 1), flaky: boom, on: bulkSource('n', 1) }, overrides: { 'on': 'host', flaky: 'host' } });
    await tools.manifest();
    const bySrv = Object.fromEntries(tools.summary.skipped.map((s) => [s.server, s]));
    expect(bySrv.off.reason).toBe('not turned on for this daemon');
    expect(bySrv.off.notify).toBeFalsy();
    expect(bySrv.flaky.notify).toBe(true);
  });
});

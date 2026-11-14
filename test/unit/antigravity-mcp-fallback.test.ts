import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import {
  OPENCODE_HOST_TOOLS_SERVER,
  OpenCodeHostToolsBridge,
  handleHostToolsRpc,
  type OpenCodeHostToolsContext,
} from '../../src/OpenCodeHostTools';
import {
  AntigravitySession,
  antigravityToolName,
  antigravityToolSummary,
  type AntigravityBrainOptions,
} from '../../src/AntigravitySession';
import { spawnAcpChannel, type AcpLauncher } from '../../src/AcpClient';
import type {
  HarnessDynamicTool,
  HarnessMcpServerConfig,
  HarnessPermissionMode,
  HarnessSessionOptions,
} from '../../src/HarnessSession';
import type { SessionCallbacks } from '../../src/ClaudeSession';

const AGENT = path.resolve(__dirname, '../helpers/fake-acp-agent.mjs');

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()!();
  }
});

function makeHostTool(
  name: string,
  requiresApproval: boolean,
  impl?: (args: Record<string, unknown>) => Promise<{ success: boolean; text: string }>,
): HarnessDynamicTool & { invoke: ReturnType<typeof vi.fn> } {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    requiresApproval,
    invoke: vi.fn(impl ?? (async (args) => ({ success: true, text: `${name}:${JSON.stringify(args)}` }))),
  };
}

function makeContext(
  mode: HarnessPermissionMode,
  allow: boolean | (() => Promise<boolean>) = true,
): OpenCodeHostToolsContext & { requestPermission: ReturnType<typeof vi.fn> } {
  return {
    permissionMode: () => mode,
    requestPermission: vi.fn(async () => (typeof allow === 'function' ? allow() : allow)),
  };
}

function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

// ── 1. Compact call_mcp_tool schema & host-tool dispatcher ─────────────────

describe('call_mcp_tool opt-in & compact schema', () => {
  it('stays absent by default so OpenCodeHostToolsBridge behavior is unchanged', async () => {
    const tools = [makeHostTool('vault_search', false)];
    const list = await handleHostToolsRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, tools, makeContext('default'));
    expect((list?.result as any).tools.map((t: any) => t.name)).toEqual(['vault_search']);

    const call = await handleHostToolsRpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'call_mcp_tool', arguments: { server: 'agent-threads' } } },
      tools,
      makeContext('default'),
    );
    expect(call?.result).toMatchObject({ isError: true, content: [{ text: 'Unknown Agent Threads tool: call_mcp_tool' }] });
  });

  it('exposes call_mcp_tool when opted in with a serialized declaration strictly under 400 bytes', async () => {
    const tools = [makeHostTool('vault_search', false)];
    const list = await handleHostToolsRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      tools,
      makeContext('default'),
      { enableMcpDispatcher: true },
    );
    const defs = (list?.result as any).tools as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    expect(defs.map((d) => d.name)).toEqual(['vault_search', 'call_mcp_tool']);
    const def = defs.find((d) => d.name === 'call_mcp_tool')!;
    expect(def).toBeDefined();
    expect(def.inputSchema).toEqual({
      type: 'object',
      properties: {
        server: { type: 'string' },
        tool: { type: 'string' },
        argsJson: { type: 'string' },
      },
      required: ['server'],
      additionalProperties: false,
    });
    const serialized = JSON.stringify({ name: def.name, description: def.description, parameters: def.inputSchema });
    expect(serialized.length).toBeLessThan(400);
  });

  it('lists host tools in discovery mode without prompting and reports available servers for unknown names', async () => {
    const tools = [makeHostTool('vault_search', false), makeHostTool('vault_move', true)];
    const ctx = makeContext('default');

    const discovered = await handleHostToolsRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'call_mcp_tool', arguments: { server: 'agent-threads' } } },
      tools,
      ctx,
      { enableMcpDispatcher: true, externalMcpServers: { compass: { type: 'http', url: 'http://127.0.0.1:9/mcp' } } },
    );
    expect(ctx.requestPermission).not.toHaveBeenCalled();
    expect(discovered?.result).toMatchObject({ isError: false });
    const parsed = JSON.parse((discovered?.result as any).content[0].text);
    expect(parsed).toEqual({
      server: 'agent-threads',
      tools: [
        { name: 'vault_search', description: 'vault_search description' },
        { name: 'vault_move', description: 'vault_move description' },
      ],
    });

    const emptyToolDiscovered = await handleHostToolsRpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'call_mcp_tool', arguments: { server: 'agent-threads', tool: '   ' } } },
      tools,
      ctx,
      { enableMcpDispatcher: true },
    );
    expect(emptyToolDiscovered?.result).toMatchObject({ isError: false });

    const unknown = await handleHostToolsRpc(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'call_mcp_tool', arguments: { server: 'missing' } } },
      tools,
      ctx,
      { enableMcpDispatcher: true, externalMcpServers: { compass: { type: 'http', url: 'http://127.0.0.1:9/mcp' } } },
    );
    expect(unknown?.result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('agent-threads') }],
    });
    expect((unknown?.result as any).content[0].text).toContain('compass');
  });

  it('validates server, argsJson (malformed JSON, arrays, primitives), and blocks recursive call_mcp_tool calls', async () => {
    const tools = [makeHostTool('vault_search', false)];
    const ctx = makeContext('default');
    const call = (args: Record<string, unknown>) =>
      handleHostToolsRpc(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'call_mcp_tool', arguments: args } },
        tools,
        ctx,
        { enableMcpDispatcher: true },
      );

    expect((await call({ server: '   ' }))?.result).toMatchObject({ isError: true });
    expect((await call({ server: 'agent-threads', tool: 'vault_search', argsJson: '{bad' }))?.result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('argsJson must be a JSON object string') }],
    });
    expect((await call({ server: 'agent-threads', tool: 'vault_search', argsJson: '[1, 2]' }))?.result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('argsJson must be a JSON object string') }],
    });
    expect((await call({ server: 'agent-threads', tool: 'vault_search', argsJson: 'null' }))?.result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('argsJson must be a JSON object string') }],
    });
    expect((await call({ server: 'agent-threads', tool: 'call_mcp_tool', argsJson: '{}' }))?.result).toMatchObject({
      isError: true,
      content: [{ text: 'Cannot invoke call_mcp_tool recursively.' }],
    });
  });

  it('enforces exact host-tool approval rules across read-only and mutating tools', async () => {
    const search = makeHostTool('vault_search', false);
    const move = makeHostTool('vault_move', true);
    const tools = [search, move];

    // Read-only auto-allows in all modes without prompting and forwards parsed argsJson
    for (const mode of ['default', 'plan', 'dontAsk', 'bypassPermissions'] as const) {
      const ctx = makeContext(mode);
      const reply = await handleHostToolsRpc(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'call_mcp_tool', arguments: { server: 'agent-threads', tool: 'vault_search', argsJson: '{"query":"roadmap"}' } },
        },
        tools,
        ctx,
        { enableMcpDispatcher: true },
      );
      expect(ctx.requestPermission).not.toHaveBeenCalled();
      expect(reply?.result).toEqual({ content: [{ type: 'text', text: 'vault_search:{"query":"roadmap"}' }], isError: false });
    }

    // Also accepts omitted/blank argsJson or direct plain-object `arguments`
    const blankReply = await handleHostToolsRpc(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'call_mcp_tool', arguments: { server: 'agent-threads', tool: 'vault_search', argsJson: '  ' } },
      },
      tools,
      makeContext('default'),
      { enableMcpDispatcher: true },
    );
    expect(blankReply?.result).toEqual({ content: [{ type: 'text', text: 'vault_search:{}' }], isError: false });

    const directObjReply = await handleHostToolsRpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'call_mcp_tool', arguments: { server: 'agent-threads', tool: 'vault_search', arguments: { query: 'direct' } } },
      },
      tools,
      makeContext('default'),
      { enableMcpDispatcher: true },
    );
    expect(directObjReply?.result).toEqual({ content: [{ type: 'text', text: 'vault_search:{"query":"direct"}' }], isError: false });

    // Mutating prompts in default mode: denied -> not invoked; allowed -> invoked
    move.invoke.mockClear();
    const denyCtx = makeContext('default', false);
    const denied = await handleHostToolsRpc(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'call_mcp_tool', arguments: { server: 'agent-threads', tool: 'vault_move', argsJson: '{"from":"a.md","to":"b.md"}' } },
      },
      tools,
      denyCtx,
      { enableMcpDispatcher: true },
    );
    expect(denyCtx.requestPermission).toHaveBeenCalledWith('Agent Threads: vault_move', expect.stringContaining('"from": "a.md"'));
    expect(move.invoke).not.toHaveBeenCalled();
    expect(denied?.result).toMatchObject({ isError: true, content: [{ text: 'Permission denied for vault_move.' }] });

    const allowCtx = makeContext('default', true);
    const allowed = await handleHostToolsRpc(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'call_mcp_tool', arguments: { server: 'agent-threads', tool: 'vault_move', argsJson: '{"from":"a.md","to":"b.md"}' } },
      },
      tools,
      allowCtx,
      { enableMcpDispatcher: true },
    );
    expect(allowCtx.requestPermission).toHaveBeenCalledOnce();
    expect(move.invoke).toHaveBeenCalledWith({ from: 'a.md', to: 'b.md' });
    expect(allowed?.result).toMatchObject({ isError: false });

    // Mutating denies without prompting in plan and dontAsk
    for (const mode of ['plan', 'dontAsk'] as const) {
      move.invoke.mockClear();
      const ctx = makeContext(mode);
      const res = await handleHostToolsRpc(
        { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'call_mcp_tool', arguments: { server: 'agent-threads', tool: 'vault_move' } } },
        tools,
        ctx,
        { enableMcpDispatcher: true },
      );
      expect(ctx.requestPermission).not.toHaveBeenCalled();
      expect(move.invoke).not.toHaveBeenCalled();
      expect(res?.result).toMatchObject({ isError: true, content: [{ text: 'vault_move is unavailable in the current permission mode.' }] });
    }

    // Mutating auto-allows in bypassPermissions and auto
    for (const mode of ['bypassPermissions', 'auto'] as const) {
      move.invoke.mockClear();
      const ctx = makeContext(mode);
      const res = await handleHostToolsRpc(
        { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'call_mcp_tool', arguments: { server: 'agent-threads', tool: 'vault_move' } } },
        tools,
        ctx,
        { enableMcpDispatcher: true },
      );
      expect(ctx.requestPermission).not.toHaveBeenCalled();
      expect(move.invoke).toHaveBeenCalledOnce();
      expect(res?.result).toMatchObject({ isError: false });
    }
  });
});

// ── 2. External Streamable HTTP / SSE MCP Server ───────────────────────────

describe('External HTTP & SSE MCP server fallback', () => {
  async function startFakeHttpMcpServer(mode: 'json' | 'sse' | 'hang') {
    const requests: Array<{ method?: string; headers: http.IncomingHttpHeaders; body: any }> = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        requests.push({ method: body.method, headers: req.headers, body });
        if (mode === 'hang') {
          // Never reply; client timeout should abort cleanly.
          return;
        }
        if (body.method === 'notifications/initialized') {
          res.writeHead(202).end();
          return;
        }
        const sessionId = mode === 'sse' ? 'mcp-sse-session-42' : 'mcp-json-session-7';
        const sendReply = (result: unknown) => {
          const envelope = { jsonrpc: '2.0', id: body.id, result };
          if (mode === 'sse') {
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'mcp-session-id': sessionId,
            });
            // Include comment, unrelated notification, and multi-line data: block per SSE spec
            const prettyLines = JSON.stringify(envelope, null, 2)
              .split('\n')
              .map((line) => `data: ${line}`)
              .join('\n');
            res.write(`: keepalive\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\n${prettyLines}\n\n`);
            res.end();
          } else {
            res.writeHead(200, {
              'content-type': 'application/json',
              'mcp-session-id': sessionId,
            });
            res.end(JSON.stringify(envelope));
          }
        };

        switch (body.method) {
          case 'initialize':
            sendReply({
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'compass-fake', version: '1.0.0' },
            });
            return;
          case 'tools/list':
            if (!body.params?.cursor) {
              sendReply({
                tools: [{ name: 'move_task_status', description: 'Move a task' }],
                nextCursor: 'cursor-page-2',
              });
            } else {
              sendReply({
                tools: [{ name: 'capture_preview', description: 'Capture preview image' }],
              });
            }
            return;
          case 'tools/call':
            if (body.params?.name === 'capture_preview') {
              const fakePng = Buffer.alloc(4096, 1).toString('base64');
              sendReply({
                content: [
                  { type: 'text', text: 'Captured' },
                  { type: 'image', mimeType: 'image/png', data: fakePng },
                ],
                isError: false,
              });
              return;
            }
            if (body.params?.name === 'structured_only') {
              sendReply({
                content: [],
                structuredContent: { ok: true, count: 3 },
                isError: false,
              });
              return;
            }
            sendReply({
              content: [{ type: 'text', text: `moved:${JSON.stringify(body.params?.arguments)}` }],
              isError: false,
            });
            return;
          default:
            res.writeHead(400).end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}/mcp`, requests };
  }

  it.each(['json', 'sse'] as const)(
    'connects lazily over %s Streamable HTTP, tracks Mcp-Session-Id, paginates tools/list, and enforces permission modes',
    async (wireMode) => {
      const remote = await startFakeHttpMcpServer(wireMode);
      let currentMode: HarnessPermissionMode = 'default';
      let allowNext = true;
      const prompts: Array<{ tool: string; detail: string }> = [];

      const bridge = new OpenCodeHostToolsBridge(
        [],
        {
          permissionMode: () => currentMode,
          requestPermission: async (tool, detail) => {
            prompts.push({ tool, detail });
            return allowNext;
          },
        },
        {
          enableMcpDispatcher: true,
          externalMcpServers: {
            compass: {
              type: wireMode === 'sse' ? 'sse' : 'http',
              url: remote.url,
              headers: { Authorization: 'Bearer secret-token' },
            },
          },
        },
      );
      cleanup.push(() => bridge.close());
      await bridge.start();

      // Lazy connection: starting the bridge does not contact the external server yet.
      expect(remote.requests).toHaveLength(0);

      // 1. Discovery mode paginates tools/list without prompting
      const listRes = await postJson(bridge.url, bridge.headers, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'call_mcp_tool', arguments: { server: 'compass' } },
      });
      const listPayload = JSON.parse(listRes.body);
      expect(prompts).toHaveLength(0);
      expect(listPayload.result.isError).toBe(false);
      expect(JSON.parse(listPayload.result.content[0].text)).toEqual({
        server: 'compass',
        tools: [
          { name: 'move_task_status', description: 'Move a task' },
          { name: 'capture_preview', description: 'Capture preview image' },
        ],
      });

      // Verify handshake + session header forwarding + custom Authorization header
      expect(remote.requests.map((r) => r.method)).toEqual([
        'initialize',
        'notifications/initialized',
        'tools/list',
        'tools/list',
      ]);
      expect(remote.requests[0].headers.authorization).toBe('Bearer secret-token');
      expect(remote.requests[0].headers.accept).toContain('application/json');
      expect(remote.requests[0].headers.accept).toContain('text/event-stream');
      const expectedSessionId = wireMode === 'sse' ? 'mcp-sse-session-42' : 'mcp-json-session-7';
      expect(remote.requests[1].headers['mcp-session-id']).toBe(expectedSessionId);
      expect(remote.requests[2].headers['mcp-session-id']).toBe(expectedSessionId);
      expect(remote.requests[3].headers['mcp-session-id']).toBe(expectedSessionId);

      // 2. Default mode prompts with Antigravity: mcp_compass_move_task_status; denial prevents server call
      allowNext = false;
      const beforeDenyCount = remote.requests.length;
      const deniedRes = await postJson(bridge.url, bridge.headers, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'call_mcp_tool',
          arguments: { server: 'compass', tool: 'move_task_status', argsJson: '{"taskId":"TASK-9","status":"DONE"}' },
        },
      });
      expect(prompts).toHaveLength(1);
      expect(prompts[0].tool).toBe('Antigravity: mcp_compass_move_task_status');
      expect(prompts[0].detail).toContain('Run mcp_compass_move_task_status');
      expect(prompts[0].detail).toContain('"taskId": "TASK-9"');
      expect(remote.requests).toHaveLength(beforeDenyCount);
      expect(JSON.parse(deniedRes.body).result).toEqual({
        content: [{ type: 'text', text: 'Permission denied for compass/move_task_status.' }],
        isError: true,
      });

      // 3. Default mode allowed invokes cached session (no second initialize!)
      allowNext = true;
      const allowedRes = await postJson(bridge.url, bridge.headers, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'call_mcp_tool',
          arguments: { server: 'compass', tool: 'move_task_status', argsJson: '{"taskId":"TASK-9","status":"DONE"}' },
        },
      });
      expect(prompts).toHaveLength(2);
      expect(JSON.parse(allowedRes.body).result).toEqual({
        content: [{ type: 'text', text: 'moved:{"taskId":"TASK-9","status":"DONE"}' }],
        isError: false,
      });
      expect(remote.requests.filter((r) => r.method === 'initialize')).toHaveLength(1);

      // 4. dontAsk denies without prompting and without calling server
      currentMode = 'dontAsk';
      const countBeforeDontAsk = remote.requests.length;
      const dontAskRes = await postJson(bridge.url, bridge.headers, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'call_mcp_tool', arguments: { server: 'compass', tool: 'move_task_status', argsJson: '{}' } },
      });
      expect(prompts).toHaveLength(2);
      expect(remote.requests).toHaveLength(countBeforeDontAsk);
      expect(JSON.parse(dontAskRes.body).result).toEqual({
        content: [{ type: 'text', text: 'compass/move_task_status is unavailable in the current permission mode.' }],
        isError: true,
      });

      // 5. bypassPermissions auto-allows without prompting; also verify image placeholder & structuredContent formatting
      currentMode = 'bypassPermissions';
      const imgRes = await postJson(bridge.url, bridge.headers, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'call_mcp_tool', arguments: { server: 'compass', tool: 'capture_preview', argsJson: '{}' } },
      });
      expect(prompts).toHaveLength(2);
      expect(JSON.parse(imgRes.body).result).toEqual({
        content: [{ type: 'text', text: 'Captured\n[image: image/png, 4kB]' }],
        isError: false,
      });

      const structuredRes = await postJson(bridge.url, bridge.headers, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'call_mcp_tool', arguments: { server: 'compass', tool: 'structured_only', argsJson: '{}' } },
      });
      expect(JSON.parse(structuredRes.body).result).toEqual({
        content: [{ type: 'text', text: '{"ok":true,"count":3}' }],
        isError: false,
      });
    },
  );

  it('aborts hung HTTP MCP servers within timeout without stalling forever', async () => {
    const hung = await startFakeHttpMcpServer('hang');
    const bridge = new OpenCodeHostToolsBridge(
      [],
      makeContext('bypassPermissions'),
      {
        enableMcpDispatcher: true,
        externalMcpServers: {
          slow: { type: 'http', url: hung.url, timeout: 80 },
        },
      },
    );
    cleanup.push(() => bridge.close());
    await bridge.start();

    const started = Date.now();
    const res = await postJson(bridge.url, bridge.headers, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'call_mcp_tool', arguments: { server: 'slow', tool: 'ping', argsJson: '{}' } },
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(hung.requests).toHaveLength(1);
    const hungResult = JSON.parse(res.body).result;
    expect(hungResult.isError).toBe(true);
    expect(hungResult.content[0].text).toMatch(/timed out|timeout|aborted/i);
  });
});

// ── 3. External Stdio MCP Server ───────────────────────────────────────────

describe('External Stdio MCP server fallback', () => {
  it('spawns lazily, forwards cwd + env, supports listTools + callTool, and terminates child on bridge.close()', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stdio-mcp-'));
    cleanup.push(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const pidFile = path.join(tempDir, 'server.pid');
    const scriptFile = path.join(tempDir, 'mcp-stdio-server.mjs');
    fs.writeFileSync(
      scriptFile,
      `
import fs from 'node:fs';
import readline from 'node:readline';

fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid), 'utf8');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined || msg.id === null) return;
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  if (msg.method === 'initialize') {
    reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stdio-fake', version: '1.0.0' } });
  } else if (msg.method === 'tools/list') {
    reply({ tools: [{ name: 'inspect_env', description: 'Inspect env and cwd' }] });
  } else if (msg.method === 'tools/call') {
    reply({
      content: [{
        type: 'text',
        text: JSON.stringify({
          cwd: fs.realpathSync(process.cwd()),
          sessionVar: process.env.SESSION_VAR,
          serverVar: process.env.SERVER_VAR,
          args: msg.params?.arguments ?? {},
        }),
      }],
      isError: false,
    });
  }
});
setInterval(() => {}, 1000);
      `.trim(),
      'utf8',
    );

    const bridge = new OpenCodeHostToolsBridge(
      [],
      makeContext('bypassPermissions'),
      {
        enableMcpDispatcher: true,
        cwd: tempDir,
        env: { ...process.env, SESSION_VAR: 'from-session' },
        externalMcpServers: {
          localstdio: {
            type: 'stdio',
            command: process.execPath,
            args: [scriptFile],
            env: { SERVER_VAR: 'from-server' },
          },
        },
      },
    );
    cleanup.push(() => bridge.close());
    await bridge.start();

    // Lazy: child not spawned before first call
    expect(fs.existsSync(pidFile)).toBe(false);

    const listRes = await postJson(bridge.url, bridge.headers, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'call_mcp_tool', arguments: { server: 'localstdio' } },
    });
    expect(JSON.parse(JSON.parse(listRes.body).result.content[0].text)).toEqual({
      server: 'localstdio',
      tools: [{ name: 'inspect_env', description: 'Inspect env and cwd' }],
    });

    const callRes = await postJson(bridge.url, bridge.headers, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'call_mcp_tool', arguments: { server: 'localstdio', tool: 'inspect_env', argsJson: '{"hello":"world"}' } },
    });
    const callData = JSON.parse(JSON.parse(callRes.body).result.content[0].text);
    expect(callData).toEqual({
      cwd: fs.realpathSync(tempDir),
      sessionVar: 'from-session',
      serverVar: 'from-server',
      args: { hello: 'world' },
    });

    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);

    bridge.close();
    await vi.waitFor(() => {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    }, { timeout: 5_000 });
  });
});

// ── 4. AntigravitySession Integration & Tool Card Unwrapping ───────────────

describe('AntigravitySession call_mcp_tool integration', () => {
  function makeSessionHarness(over: Partial<HarnessSessionOptions> & {
    env?: Record<string, string>;
    permission?: (tool: string, detail: string) => Promise<boolean>;
    brainOptions?: AntigravityBrainOptions;
  } = {}) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mcp-test-'));
    const logFile = path.join(tempRoot, 'log.jsonl');
    const brainDir = over.brainOptions?.brainDir ?? path.join(tempRoot, 'brain');
    cleanup.push(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

    const events: string[] = [];
    const toolUses: any[] = [];
    const permissionRequests: Array<{ tool: string; detail: string }> = [];
    const done = vi.fn();

    const callbacks = {
      onToken: () => undefined,
      onToolUse: (r: any) => { toolUses.push(r); },
      onMessage: () => undefined,
      onRecap: () => undefined,
      onDone: (...args: unknown[]) => { events.push('done'); done(...args); },
      onInterrupted: () => { events.push('interrupted'); },
      onError: () => { events.push('error'); },
      onPermissionRequest: async (tool: string, detail: string) => {
        permissionRequests.push({ tool, detail });
        return over.permission ? over.permission(tool, detail) : true;
      },
      onAskUserQuestion: async () => ({}),
      onOpenNewTab: async () => ({ threadId: 'x', title: 'x' }),
      onToolResult: () => undefined,
      onFilesEdited: () => undefined,
      onEnterPlanMode: vi.fn(),
      onCapabilitiesDiscovered: vi.fn(),
      onUsage: vi.fn(),
      onCommandsChanged: vi.fn(),
      onRawEvent: vi.fn(),
      onNotification: vi.fn(),
    } as unknown as SessionCallbacks;

    const env = { FAKE_ACP_LOG: logFile, FAKE_ACP_BRAIN_DIR: brainDir, ...(over.env ?? {}) };
    const options: HarnessSessionOptions = {
      cwd: tempRoot,
      permissionMode: 'default',
      extraEnvRaw: Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'),
      callbacks,
      ...over,
    };
    delete (options as any).env;
    delete (options as any).permission;
    delete (options as any).brainOptions;

    const launcher: AcpLauncher = (launchOpts) =>
      spawnAcpChannel({ ...launchOpts, binaryPath: process.execPath, args: [AGENT] });

    const session = new AntigravitySession('agy', launcher, 15_000, { brainDir, pollIntervalMs: 15, wakeupGraceMs: 150 });
    cleanup.push(() => session.close());

    const received = () =>
      fs.existsSync(logFile)
        ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
        : [];

    const turn = async (text: string) => {
      const before = events.length;
      session.send(text);
      await vi.waitFor(() => expect(events.length).toBeGreaterThan(before), { timeout: 10_000 });
    };

    return { session, options, tempRoot, events, toolUses, permissionRequests, received, turn };
  }

  it('unwraps mcp_agent-threads_call_mcp_tool in antigravityToolName and antigravityToolSummary', () => {
    expect(
      antigravityToolName('mcp_agent-threads_call_mcp_tool', 'other', {
        server: 'agent-threads',
        tool: 'vault_search',
        argsJson: '{"query":"notes"}',
      }),
    ).toBe('vault_search');

    expect(
      antigravityToolName('mcp_agent-threads_call_mcp_tool', 'other', {
        tool: 'enter_worktree',
      }),
    ).toBe('enter_worktree');

    expect(
      antigravityToolName('mcp_agent-threads_call_mcp_tool', 'other', {
        server: 'compass',
        tool: 'move_task_status',
        argsJson: '{}',
      }),
    ).toBe('mcp_compass_move_task_status');

    // Discovery mode keeps call_mcp_tool name
    expect(
      antigravityToolName('mcp_agent-threads_call_mcp_tool', 'other', {
        server: 'compass',
      }),
    ).toBe('call_mcp_tool');

    // 2-arg callers continue working unchanged
    expect(antigravityToolName('mcp_agent-threads_call_mcp_tool', 'other')).toBe('call_mcp_tool');

    // Summaries
    expect(
      antigravityToolSummary({
        name: 'mcp_agent-threads_call_mcp_tool',
        kind: 'other',
        rawInput: { server: 'agent-threads', tool: 'vault_search', argsJson: '{}' },
      }),
    ).toBe('agent-threads/vault_search');

    expect(
      antigravityToolSummary({
        name: 'mcp_agent-threads_call_mcp_tool',
        kind: 'other',
        rawInput: { server: 'compass', tool: 'move_task_status', argsJson: '{}' },
      }),
    ).toBe('compass/move_task_status');

    expect(
      antigravityToolSummary({
        name: 'mcp_agent-threads_call_mcp_tool',
        kind: 'other',
        rawInput: { server: 'compass' },
      }),
    ).toBe('list tools (compass)');

    expect(
      antigravityToolSummary({
        name: 'mcp_agent-threads_call_mcp_tool',
        kind: 'other',
        rawInput: { server: 'compass', tool: 'move_task_status', toolSummary: 'Custom summary' },
      }),
    ).toBe('Custom summary');
  });

  it('starts the bridge when dynamicTools is empty if external mcpServers are configured, and closes stdio MCP children on session.close()', async () => {
    const pidFile = path.join(os.tmpdir(), `agy-ext-stdio-${Date.now()}-${Math.random().toString(36).slice(2)}.pid`);
    const scriptFile = `${pidFile}.mjs`;
    cleanup.push(() => {
      fs.rmSync(pidFile, { force: true });
      fs.rmSync(scriptFile, { force: true });
    });
    fs.writeFileSync(
      scriptFile,
      `
import fs from 'node:fs';
import readline from 'node:readline';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid), 'utf8');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined || msg.id === null) return;
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  if (msg.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ext', version: '1.0.0' } });
  else if (msg.method === 'tools/call') reply({ content: [{ type: 'text', text: 'pong-from-ext' }], isError: false });
});
setInterval(() => {}, 1000);
      `.trim(),
      'utf8',
    );

    const extServers: Record<string, HarnessMcpServerConfig> = {
      ext: { type: 'stdio', command: process.execPath, args: [scriptFile] },
    };
    const h = makeSessionHarness({
      permissionMode: 'bypassPermissions',
      antigravity: { mcpServers: extServers },
    });
    await h.session.start(h.options);

    const mcpServers = h.received().find((m: any) => m.method === 'session/new').params.mcpServers as Array<any>;
    expect(mcpServers.map((s) => s.name)).toEqual(['ext', OPENCODE_HOST_TOOLS_SERVER]);

    // Auto-allows mcp_agent-threads_call_mcp_tool at the ACP permission layer (bridge owns target approval)
    const acpPerm = await h.session.handlePermissionRequest({
      sessionId: 's1',
      toolCall: { toolCallId: 'tc-1', name: 'mcp_agent-threads_call_mcp_tool', kind: 'other', rawInput: { server: 'ext', tool: 'ping' } },
      options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }],
    });
    expect(acpPerm).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    expect(h.permissionRequests).toHaveLength(0);

    // Invoke external stdio MCP tool through the session's live loopback bridge
    const bridgeEntry = mcpServers.find((s) => s.name === OPENCODE_HOST_TOOLS_SERVER)!;
    const bridgeHeaders = Object.fromEntries(bridgeEntry.headers.map((hdr: any) => [hdr.name, hdr.value]));
    const callRes = await postJson(bridgeEntry.url, bridgeHeaders, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'call_mcp_tool', arguments: { server: 'ext', tool: 'ping', argsJson: '{}' } },
    });
    expect(JSON.parse(callRes.body).result).toEqual({
      content: [{ type: 'text', text: 'pong-from-ext' }],
      isError: false,
    });

    // Unwraps tool card in live session updates
    const sessionId = h.received().find((m: any) => m.method === 'session/new') ? 'fake-session-1' : '';
    h.session.handleSessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-live-1',
        name: 'mcp_agent-threads_call_mcp_tool',
        kind: 'other',
        rawInput: { server: 'ext', tool: 'ping', argsJson: '{}' },
        status: 'in_progress',
      },
    });
    expect(h.toolUses[0]).toMatchObject({ name: 'mcp_ext_ping', summary: 'ext/ping' });

    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    h.session.close();
    await vi.waitFor(() => {
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    }, { timeout: 5_000 });
  });

  it('injects the Antigravity MCP fallback note on the first turn when the bridge is active, and re-emits on failed resume/respawn', async () => {
    const hostTool = makeHostTool('vault_search', false);

    // 1. Bridge active without appendSystemPrompt -> emits <system-instructions> with MCP note on turn 1 only
    const hNoSys = makeSessionHarness({ antigravity: { dynamicTools: [hostTool] } });
    await hNoSys.session.start(hNoSys.options);
    await hNoSys.turn('TEXT hello');
    await hNoSys.turn('TEXT second');
    const promptsNoSys = hNoSys.received().filter((m: any) => m.method === 'session/prompt').map((m: any) => m.params.prompt[0].text);
    expect(promptsNoSys[0]).toContain('<system-instructions>');
    expect(promptsNoSys[0]).toContain('mcp_agent-threads_call_mcp_tool');
    expect(promptsNoSys[1]).toBe('TEXT second');

    // 2. Bridge active WITH appendSystemPrompt -> combines both inside <system-instructions>
    const hWithSys = makeSessionHarness({ appendSystemPrompt: 'Be concise.', antigravity: { dynamicTools: [hostTool] } });
    await hWithSys.session.start(hWithSys.options);
    await hWithSys.turn('TEXT first');
    const firstWithSys = hWithSys.received().find((m: any) => m.method === 'session/prompt').params.prompt[0].text;
    expect(firstWithSys).toContain('Be concise.');
    expect(firstWithSys).toContain('mcp_agent-threads_call_mcp_tool');

    // 3. Respawn where session/load fails -> re-emits the MCP note on the fresh session's first turn
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const hFailRespawn = makeSessionHarness({
      env: { FAKE_ACP_FAIL_LOAD: '1' },
      antigravity: { dynamicTools: [hostTool] },
    });
    await hFailRespawn.session.start(hFailRespawn.options);
    await hFailRespawn.turn('TEXT before-respawn');
    await hFailRespawn.session.setPermissionMode('bypassPermissions');
    await hFailRespawn.turn('TEXT after-failed-respawn');
    const respawnPrompts = hFailRespawn.received().filter((m: any) => m.method === 'session/prompt').map((m: any) => m.params.prompt[0].text);
    expect(respawnPrompts[0]).toContain('mcp_agent-threads_call_mcp_tool');
    expect(respawnPrompts[1]).toContain('mcp_agent-threads_call_mcp_tool');
    warn.mockRestore();
  });
});

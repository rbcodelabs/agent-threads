/**
 * Loopback MCP bridge that exposes Agent Threads host tools to an OpenCode session.
 *
 * Claude receives host tools through an in-process SDK MCP server and Codex
 * through its app-server dynamic-tool protocol. OpenCode has neither, but it
 * does connect to remote MCP servers, so each OpenCode session gets a tiny
 * Streamable-HTTP MCP endpoint on 127.0.0.1 guarded by a random capability
 * token. Responses are plain `application/json` (the spec allows this instead
 * of an SSE stream), and approval follows the same `resolveDynamicToolApproval`
 * rules Codex uses, surfaced through the host's permission prompt.
 *
 * Dual-era: `server/discover` (MCP 2026-07-28, sent first by Antigravity) is answered alongside `initialize`.
 *
 * Desktop only: Node's `http`/`crypto` are required lazily inside `start()`.
 */
import type { Server } from 'http';
import {
  resolveDynamicToolApproval,
  type HarnessDynamicTool,
  type HarnessMcpServerConfig,
  type HarnessPermissionMode,
} from './HarnessSession';
import {
  CALL_MCP_TOOL_DEFINITION,
  CALL_MCP_TOOL_NAME,
  ExternalMcpClientPool,
  parseCallMcpToolInput,
  resolveExternalMcpToolPermission,
} from './antigravityMcpFallback';

export const OPENCODE_HOST_TOOLS_SERVER = 'agent-threads';
export const OPENCODE_HOST_TOOLS_TOKEN_HEADER = 'X-Capability-Token';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface OpenCodeHostToolsContext {
  permissionMode(): HarnessPermissionMode;
  requestPermission(toolName: string, detail: string): Promise<boolean>;
}

export interface OpenCodeHostToolsOptions {
  /** Opt-in (Antigravity only): expose compact `call_mcp_tool` to list/invoke non-eager host & external MCP tools. */
  enableMcpDispatcher?: boolean;
  externalMcpServers?: Record<string, HarnessMcpServerConfig>;
  cwd?: string;
  env?: Record<string, string | undefined>;
  externalMcpPool?: ExternalMcpClientPool;
}

type JsonRpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type JsonRpcReply = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };
type ToolCallPayload = { content: Array<{ type: 'text'; text: string }>; isError: boolean };

function textPayload(value: string, isError: boolean): ToolCallPayload {
  return { content: [{ type: 'text', text: value }], isError };
}

async function executeHostTool(
  name: string,
  args: Record<string, unknown>,
  tools: HarnessDynamicTool[],
  context: OpenCodeHostToolsContext,
): Promise<ToolCallPayload> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) return textPayload(`Unknown Agent Threads tool: ${name}`, true);
  const approval = resolveDynamicToolApproval(context.permissionMode(), tool.requiresApproval);
  if (approval === 'deny') return textPayload(`${tool.name} is unavailable in the current permission mode.`, true);
  if (approval === 'prompt') {
    let allowed = false;
    try {
      allowed = await context.requestPermission(
        `Agent Threads: ${tool.name}`,
        `${tool.description}\n\nArguments:\n${JSON.stringify(args, null, 2)}`,
      );
    } catch {
      allowed = false;
    }
    if (!allowed) return textPayload(`Permission denied for ${tool.name}.`, true);
  }
  try {
    const result = await tool.invoke(args);
    return textPayload(result.text, !result.success);
  } catch (error) {
    return textPayload(error instanceof Error ? error.message : String(error), true);
  }
}

async function executeMcpDispatcherCall(
  rawArgs: Record<string, unknown>,
  tools: HarnessDynamicTool[],
  context: OpenCodeHostToolsContext,
  options: OpenCodeHostToolsOptions,
): Promise<ToolCallPayload> {
  const parsed = parseCallMcpToolInput(rawArgs);
  if (!parsed.ok) return textPayload(parsed.error, true);

  const ownedPool = options.externalMcpPool
    ? null
    : new ExternalMcpClientPool({
      servers: options.externalMcpServers,
      cwd: options.cwd,
      env: options.env,
    });
  const pool = options.externalMcpPool ?? ownedPool!;

  try {
    const availableServers = [OPENCODE_HOST_TOOLS_SERVER, ...pool.serverNames()];

    // Discovery mode: `tool` omitted or blank
    if (!parsed.tool) {
      if (parsed.server === OPENCODE_HOST_TOOLS_SERVER) {
        return textPayload(
          JSON.stringify({
            server: OPENCODE_HOST_TOOLS_SERVER,
            tools: tools.map((t) => ({ name: t.name, description: t.description })),
          }),
          false,
        );
      }
      if (pool.hasServer(parsed.server)) {
        try {
          const extTools = await pool.listTools(parsed.server);
          return textPayload(JSON.stringify({ server: parsed.server, tools: extTools }), false);
        } catch (error) {
          return textPayload(error instanceof Error ? error.message : String(error), true);
        }
      }
      return textPayload(`Unknown MCP server "${parsed.server}". Available servers: ${availableServers.join(', ')}`, true);
    }

    // Invocation mode
    if (parsed.server === OPENCODE_HOST_TOOLS_SERVER && parsed.tool === CALL_MCP_TOOL_NAME) {
      return textPayload('Cannot invoke call_mcp_tool recursively.', true);
    }
    if (parsed.server === OPENCODE_HOST_TOOLS_SERVER) {
      return executeHostTool(parsed.tool, parsed.args, tools, context);
    }
    if (pool.hasServer(parsed.server)) {
      const decision = resolveExternalMcpToolPermission(context.permissionMode());
      if (decision === 'deny') {
        return textPayload(`${parsed.server}/${parsed.tool} is unavailable in the current permission mode.`, true);
      }
      if (decision === 'prompt') {
        let allowed = false;
        try {
          allowed = await context.requestPermission(
            `Antigravity: mcp_${parsed.server}_${parsed.tool}`,
            `Run mcp_${parsed.server}_${parsed.tool}\n\nArguments:\n${JSON.stringify(parsed.args, null, 2)}`,
          );
        } catch {
          allowed = false;
        }
        if (!allowed) return textPayload(`Permission denied for ${parsed.server}/${parsed.tool}.`, true);
      }
      try {
        const res = await pool.callTool(parsed.server, parsed.tool, parsed.args);
        return textPayload(res.text, res.isError);
      } catch (error) {
        return textPayload(error instanceof Error ? error.message : String(error), true);
      }
    }
    return textPayload(`Unknown MCP server "${parsed.server}". Available servers: ${availableServers.join(', ')}`, true);
  } finally {
    ownedPool?.close();
  }
}

/** Pure JSON-RPC handler, separated from the HTTP listener so it can be unit tested. */
export async function handleHostToolsRpc(
  message: JsonRpcMessage,
  tools: HarnessDynamicTool[],
  context: OpenCodeHostToolsContext,
  options?: OpenCodeHostToolsOptions,
): Promise<JsonRpcReply | null> {
  // Notifications (no id) never get a response body.
  if (message.id === undefined || message.id === null) return null;
  const id = message.id;
  switch (message.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: OPENCODE_HOST_TOOLS_SERVER, version: '1.0.0' },
        },
      };
    case 'server/discover':
      // MCP 2026-07-28: stateless discovery. The handlers below do not depend on a session, so the bridge serves the
      // modern and the legacy (`initialize`) revisions side by side (a dual-era server). Verified against agy 1.1.13.
      return {
        jsonrpc: '2.0', id,
        result: {
          resultType: 'complete',
          supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
          capabilities: { tools: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: OPENCODE_HOST_TOOLS_SERVER, version: '1.0.0' } },
        },
      };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list': {
      const listed: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      if (options?.enableMcpDispatcher) {
        listed.push({
          name: CALL_MCP_TOOL_DEFINITION.name,
          description: CALL_MCP_TOOL_DEFINITION.description,
          inputSchema: CALL_MCP_TOOL_DEFINITION.inputSchema,
        });
      }
      return { jsonrpc: '2.0', id, result: { tools: listed } };
    }
    case 'tools/call': {
      const name = String(message.params?.name ?? '');
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      if (options?.enableMcpDispatcher && name === CALL_MCP_TOOL_NAME) {
        return { jsonrpc: '2.0', id, result: await executeMcpDispatcherCall(args, tools, context, options) };
      }
      return { jsonrpc: '2.0', id, result: await executeHostTool(name, args, tools, context) };
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${message.method ?? ''}` } };
  }
}

export class OpenCodeHostToolsBridge {
  private server: Server | null = null;
  private token = '';
  private readonly externalMcpPool: ExternalMcpClientPool | null;
  url = '';

  constructor(
    private readonly tools: HarnessDynamicTool[],
    private readonly context: OpenCodeHostToolsContext,
    private readonly options?: OpenCodeHostToolsOptions,
  ) {
    this.externalMcpPool = options?.enableMcpDispatcher
      ? (options.externalMcpPool ?? new ExternalMcpClientPool({
        servers: options.externalMcpServers,
        cwd: options.cwd,
        env: options.env,
      }))
      : null;
  }

  get headers(): Record<string, string> { return { [OPENCODE_HOST_TOOLS_TOKEN_HEADER]: this.token }; }

  async start(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createServer } = require('http') as typeof import('http');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { randomBytes, timingSafeEqual } = require('crypto') as typeof import('crypto');
    this.token = randomBytes(32).toString('hex');
    const expected = Buffer.from(this.token);
    const rpcOptions: OpenCodeHostToolsOptions | undefined = this.options
      ? { ...this.options, ...(this.externalMcpPool ? { externalMcpPool: this.externalMcpPool } : {}) }
      : undefined;
    const server = createServer((req, res) => {
      const presented = Buffer.from(String(req.headers[OPENCODE_HOST_TOOLS_TOKEN_HEADER.toLowerCase()] ?? ''));
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        res.writeHead(401).end();
        return;
      }
      if (req.method !== 'POST') {
        // No server-initiated stream: this endpoint only answers requests.
        res.writeHead(405, { Allow: 'POST' }).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { res.writeHead(413).end(); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (res.writableEnded) return;
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRpcMessage;
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
          return;
        }
        void handleHostToolsRpc(message, this.tools, this.context, rpcOptions).then((reply) => {
          if (res.writableEnded) return;
          if (!reply) { res.writeHead(202).end(); return; }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    this.server = server;
    this.url = `http://127.0.0.1:${port}/mcp`;
  }

  close(): void {
    this.externalMcpPool?.close();
    this.server?.close();
    this.server = null;
  }
}

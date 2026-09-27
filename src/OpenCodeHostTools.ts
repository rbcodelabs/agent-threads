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
 * Desktop only: Node's `http`/`crypto` are required lazily inside `start()`.
 */
import type { Server } from 'http';
import { resolveDynamicToolApproval, type HarnessDynamicTool, type HarnessPermissionMode } from './HarnessSession';

export const OPENCODE_HOST_TOOLS_SERVER = 'agent-threads';
export const OPENCODE_HOST_TOOLS_TOKEN_HEADER = 'X-Capability-Token';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface OpenCodeHostToolsContext {
  permissionMode(): HarnessPermissionMode;
  requestPermission(toolName: string, detail: string): Promise<boolean>;
}

type JsonRpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type JsonRpcReply = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

/** Pure JSON-RPC handler, separated from the HTTP listener so it can be unit tested. */
export async function handleHostToolsRpc(
  message: JsonRpcMessage,
  tools: HarnessDynamicTool[],
  context: OpenCodeHostToolsContext,
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
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return {
        jsonrpc: '2.0', id,
        result: { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) },
      };
    case 'tools/call': {
      const name = String(message.params?.name ?? '');
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      const tool = tools.find((candidate) => candidate.name === name);
      const text = (value: string, isError: boolean) => ({ jsonrpc: '2.0' as const, id, result: { content: [{ type: 'text', text: value }], isError } });
      if (!tool) return text(`Unknown Agent Threads tool: ${name}`, true);
      const approval = resolveDynamicToolApproval(context.permissionMode(), tool.requiresApproval);
      if (approval === 'deny') return text(`${tool.name} is unavailable in the current permission mode.`, true);
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
        if (!allowed) return text(`Permission denied for ${tool.name}.`, true);
      }
      try {
        const result = await tool.invoke(args);
        return text(result.text, !result.success);
      } catch (error) {
        return text(error instanceof Error ? error.message : String(error), true);
      }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${message.method ?? ''}` } };
  }
}

export class OpenCodeHostToolsBridge {
  private server: Server | null = null;
  private token = '';
  url = '';

  constructor(private readonly tools: HarnessDynamicTool[], private readonly context: OpenCodeHostToolsContext) {}

  get headers(): Record<string, string> { return { [OPENCODE_HOST_TOOLS_TOKEN_HEADER]: this.token }; }

  async start(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createServer } = require('http') as typeof import('http');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { randomBytes, timingSafeEqual } = require('crypto') as typeof import('crypto');
    this.token = randomBytes(32).toString('hex');
    const expected = Buffer.from(this.token);
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
        void handleHostToolsRpc(message, this.tools, this.context).then((reply) => {
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
    this.server?.close();
    this.server = null;
  }
}

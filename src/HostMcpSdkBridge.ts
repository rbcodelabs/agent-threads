import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsRequest,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';

/** The deliberately narrow upstream surface used by the bridge and its tests. */
export interface HostMcpBridgeClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(params?: ListToolsRequest['params'], options?: RequestOptions): Promise<ListToolsResult>;
  callTool(params: CallToolRequest['params'], resultSchema?: undefined, options?: RequestOptions): Promise<CallToolResult>;
}

interface HostMcpSdkBridgeDependencies {
  createClient?: (onToolsChanged: () => void) => HostMcpBridgeClient;
}

/**
 * Relays a host-loopback MCP tool server into Claude through the Agent SDK's
 * in-process MCP transport. The guest never sees the loopback URL or headers.
 *
 * Plugin-owned OAuth and Google brokers expose tools only. Accordingly this
 * bridge advertises only the tool capability; prompts, resources, sampling and
 * elicitation fail closed instead of being claimed without protocol-complete
 * forwarding.
 */
export class HostMcpSdkBridge {
  readonly config: McpSdkServerConfigWithInstance;
  private client?: HostMcpBridgeClient;
  private connecting?: Promise<HostMcpBridgeClient>;
  private closed = false;

  constructor(
    name: string,
    private readonly url: URL,
    private readonly headers: Record<string, string>,
    private readonly deps: HostMcpSdkBridgeDependencies = {},
  ) {
    const instance = new McpServer(
      { name: `host-bridge-${name}`, version: '1.0.0' },
      { capabilities: { tools: { listChanged: true } } },
    );
    instance.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      return await (await this.ensureClient(instance)).listTools(request.params, { signal: extra.signal });
    });
    instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      return await (await this.ensureClient(instance)).callTool(request.params, undefined, {
        signal: extra.signal,
        onprogress: progress => {
          const progressToken = extra._meta?.progressToken;
          if (progressToken !== undefined) {
            void extra.sendNotification({ method: 'notifications/progress', params: { ...progress, progressToken } });
          }
        },
      });
    });
    this.config = { type: 'sdk', name, instance };
  }

  private async ensureClient(instance: McpServer): Promise<HostMcpBridgeClient> {
    if (this.closed) throw new Error('Host MCP bridge is closed.');
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    const createClient: NonNullable<HostMcpSdkBridgeDependencies['createClient']> = this.deps.createClient ?? ((onToolsChanged: () => void): HostMcpBridgeClient => {
      const client = new Client(
        { name: 'agent-threads-host-mcp-bridge', version: '1.0.0' },
        { listChanged: { tools: { onChanged: () => { void onToolsChanged(); } } } },
      );
      const transport = new StreamableHTTPClientTransport(this.url, {
        requestInit: { headers: this.headers },
      });
      return {
        connect: () => client.connect(transport),
        close: () => client.close(),
        listTools: (params, options) => client.listTools(params, options),
        callTool: async (params, _schema, options) => await client.callTool(params, undefined, options) as CallToolResult,
      };
    });
    this.connecting = (async () => {
      const client = createClient(() => instance.server.sendToolListChanged());
      try {
        await client.connect();
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      }
      if (this.closed) {
        await client.close().catch(() => undefined);
        throw new Error('Host MCP bridge closed while connecting.');
      }
      this.client = client;
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async invalidateClient(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) await client.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.invalidateClient();
    await this.config.instance.close().catch(() => undefined);
  }
}

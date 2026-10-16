/**
 * A tiny MCP client for the plugin-owned loopback brokers (Google Workspace, OAuth MCP). A remote thread
 * cannot reach those loopback URLs (they are on this computer), so the plugin lists and calls their tools
 * itself and proxies the calls for the daemon; the loopback URL and its capability header never leave here.
 *
 * Tools only, like `HostMcpSdkBridge`: nothing else is forwarded.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

export interface McpCallResult {
  isError?: boolean;
  content: Array<Record<string, unknown>>;
}

export interface HostMcpSource {
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
}

interface ClientLike {
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{ tools: McpToolInfo[] }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }, signal?: AbortSignal): Promise<McpCallResult>;
}

export function createLoopbackMcpSource(
  url: string,
  headers: Record<string, string>,
  makeClient?: () => ClientLike,
): HostMcpSource {
  const create = makeClient ?? ((): ClientLike => {
    const client = new Client({ name: 'agent-threads-remote-host-tools', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
    return {
      connect: () => client.connect(transport),
      close: () => client.close(),
      listTools: async () => (await client.listTools()) as unknown as { tools: McpToolInfo[] },
      callTool: async (params, signal) => (await client.callTool(params, undefined, { signal })) as unknown as McpCallResult,
    };
  });
  let client: ClientLike | undefined;
  let connecting: Promise<ClientLike> | undefined;

  const ensure = async (): Promise<ClientLike> => {
    if (client) return client;
    connecting ??= (async () => {
      const c = create();
      try { await c.connect(); } catch (err) { await c.close().catch(() => undefined); throw err; }
      client = c;
      return c;
    })().finally(() => { connecting = undefined; });
    return connecting;
  };
  const reset = async (): Promise<void> => {
    const c = client;
    client = undefined;
    if (c) await c.close().catch(() => undefined);
  };

  return {
    async listTools() {
      try { return (await (await ensure()).listTools()).tools; } catch (err) { await reset(); throw err; }
    },
    async callTool(name, args, signal) {
      try { return await (await ensure()).callTool({ name, arguments: args }, signal); } catch (err) { await reset(); throw err; }
    },
    close: reset,
  };
}

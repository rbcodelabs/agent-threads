/**
 * A tiny MCP client for the plugin-owned loopback brokers (Google Workspace, OAuth MCP). A remote thread
 * cannot reach those loopback URLs (they are on this computer), so the plugin lists and calls their tools
 * itself and proxies the calls for the daemon; the loopback URL and its capability header never leave here.
 *
 * Tools and resources (list, templates, read), like the local path; prompts and sampling are not forwarded.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

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

export interface McpResourceInfo { uri: string; name?: string; description?: string; mimeType?: string }
export interface McpResourceTemplateInfo { uriTemplate: string; name?: string; description?: string; mimeType?: string }
export interface McpResourceContents { uri: string; mimeType?: string; text?: string; blob?: string }

export interface HostMcpSource {
  listTools(): Promise<McpToolInfo[]>;
  /** Empty (not an error) when the upstream server has no resources. Absent on a source that cannot serve them. */
  listResources?(): Promise<McpResourceInfo[]>;
  /** Empty (not an error) when the upstream server has no resources. */
  listResourceTemplates?(): Promise<McpResourceTemplateInfo[]>;
  /** Rejects when the server has no resources or does not know the uri. */
  readResource?(uri: string): Promise<McpResourceContents[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
}

interface ClientLike {
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{ tools: McpToolInfo[] }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }, signal?: AbortSignal): Promise<McpCallResult>;
  listResources?(params: { cursor?: string }): Promise<{ resources: McpResourceInfo[]; nextCursor?: string }>;
  listResourceTemplates?(params: { cursor?: string }): Promise<{ resourceTemplates: McpResourceTemplateInfo[]; nextCursor?: string }>;
  readResource?(params: { uri: string }): Promise<{ contents: McpResourceContents[] }>;
}

/** Pages followed when listing resources (a runaway cursor must not loop forever). */
const MAX_RESOURCE_PAGES = 10;

/**
 * An upstream server without the resources capability answers `resources/*` with "method not found" (or the SDK
 * refuses locally); both mean "none", not a failure.
 */
function isUnsupported(err: unknown): boolean {
  if (err instanceof McpError && err.code === ErrorCode.MethodNotFound) return true;
  return err instanceof Error && /does not support resources|method not found/i.test(err.message);
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
      listResources: async (params) => (await client.listResources(params)) as unknown as { resources: McpResourceInfo[]; nextCursor?: string },
      listResourceTemplates: async (params) => (await client.listResourceTemplates(params)) as unknown as { resourceTemplates: McpResourceTemplateInfo[]; nextCursor?: string },
      readResource: async (params) => (await client.readResource(params)) as unknown as { contents: McpResourceContents[] },
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

  /** Follow cursors; an upstream without resources yields []. A transport failure resets the connection and rejects. */
  async function listAll<T, K extends string>(
    key: K,
    page: (c: ClientLike, cursor?: string) => Promise<({ nextCursor?: string } & { [P in K]: T[] }) | undefined>,
  ): Promise<T[]> {
    const out: T[] = [];
    try {
      const c = await ensure();
      let cursor: string | undefined;
      for (let i = 0; i < MAX_RESOURCE_PAGES; i++) {
        const r = await page(c, cursor);
        if (!r) return out;
        out.push(...(r[key] ?? []));
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      return out;
    } catch (err) {
      if (isUnsupported(err)) return out;
      await reset();
      throw err;
    }
  }

  return {
    listResources: () => listAll<McpResourceInfo, 'resources'>('resources', (c, cursor) => c.listResources?.({ ...(cursor ? { cursor } : {}) }) ?? Promise.resolve(undefined)),
    listResourceTemplates: () => listAll<McpResourceTemplateInfo, 'resourceTemplates'>('resourceTemplates', (c, cursor) => c.listResourceTemplates?.({ ...(cursor ? { cursor } : {}) }) ?? Promise.resolve(undefined)),
    async readResource(uri) {
      try {
        const c = await ensure();
        if (!c.readResource) throw new Error('This server does not support resources.');
        return (await c.readResource({ uri })).contents ?? [];
      } catch (err) {
        // A server-reported error (unknown uri, no resources) keeps the connection; anything else resets it.
        if (!(err instanceof McpError)) await reset();
        throw err;
      }
    },
    async listTools() {
      try { return (await (await ensure()).listTools()).tools; } catch (err) { await reset(); throw err; }
    },
    async callTool(name, args, signal) {
      try { return await (await ensure()).callTool({ name, arguments: args }, signal); } catch (err) { await reset(); throw err; }
    },
    close: reset,
  };
}

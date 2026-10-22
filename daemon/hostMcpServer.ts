/**
 * Builds the in-process MCP servers a daemon-hosted Claude sees for host tools (design 3.5).
 *
 * `claude_threads` keeps the name it has locally, so `mcp__claude_threads__*` names, always-allow entries and
 * the client's trusted-tool classification stay valid. It holds the LOCAL tools (worktree tools, which must
 * run beside the repo) plus a proxy tool per manifest entry. Other manifest servers (`google-docs`, an OAuth
 * MCP) are proxy-only servers under their own names.
 *
 * The tool list is read from the live manifest on every `tools/list`, and `notifyChanged()` sends
 * `tools/list_changed`, so a manifest update reaches a running session without restarting it.
 */
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema, ErrorCode, ListResourceTemplatesRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema,
  McpError, ReadResourceRequestSchema, type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  HOST_RESOURCE_TOOLS, checkResourceUri, decodeResourceContents, decodeResourceList, decodeResourceTemplates,
  type RemoteHostToolSpec, type ResourceDecode,
} from '../src/protocol';
import type { HostToolOutcome } from './hostTools';

export interface HostMcpServerHandle {
  config: McpSdkServerConfigWithInstance;
  /** The tool list changed: tell the client of this server to re-list. */
  notifyChanged(): void;
}

export interface HostMcpServerOptions {
  name: string;
  /** Tools that run in this process (zod-shaped definitions, as produced by `tool()`). */
  local?: ReadonlyArray<SdkMcpToolDefinition<any>>;
  /** The proxied tools right now (read on every list and call). */
  proxied(): readonly RemoteHostToolSpec[];
  /** Run one proxied tool in the host. Never rejects. */
  call(tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<HostToolOutcome>;
  /**
   * Also serve the MCP resources of this proxied server (`resources/list`, `resources/templates/list`,
   * `resources/read`) by asking the host through `call` with the reserved resource tool names. Off for the
   * `claude_threads` server, whose tools are the app's own and have no resources.
   */
  resources?: boolean;
}

/**
 * Only the daemon's own worktree tools are always loaded (a handful, needed to work in a repo). Proxied tools, which
 * can be many and come from third parties, are deferred: the model finds them through tool search when it needs one.
 */
const ALWAYS_LOAD = { 'anthropic/alwaysLoad': true } as const;

function toResult(outcome: HostToolOutcome): CallToolResult {
  const content: CallToolResult['content'] = [{ type: 'text', text: outcome.text }];
  for (const block of outcome.content ?? []) {
    if (block.type === 'image') content.push({ type: 'image', data: block.data, mimeType: block.mimeType });
  }
  // The Claude CLI hands the model JSON.stringify(structuredContent) instead of the text blocks when it is set, which
  // is what a directly connected MCP server gets too. `isError` is independent of it.
  return { content, ...(outcome.structuredContent ? { structuredContent: outcome.structuredContent } : {}), ...(outcome.success ? {} : { isError: true }) };
}

export function createHostMcpServer(opts: HostMcpServerOptions): HostMcpServerHandle {
  const local = new Map((opts.local ?? []).map((d) => [d.name, d]));
  const instance = new McpServer({ name: `agent-threads-host-${opts.name}`, version: '1.0.0' }, { capabilities: { tools: { listChanged: true }, ...(opts.resources ? { resources: {} } : {}) } });

  instance.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [...local.values()].map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: z.toJSONSchema(z.object(d.inputSchema as z.ZodRawShape)) as { type: 'object' },
      _meta: ALWAYS_LOAD,
    }));
    for (const t of opts.proxied()) {
      if (local.has(t.name)) continue; // a local tool is never shadowed by a proxied one
      tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema as { type: 'object' } } as (typeof tools)[number]);
    }
    return { tools };
  });

  instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const def = local.get(name);
    if (def) {
      const parsed = z.object(def.inputSchema as z.ZodRawShape).safeParse(args);
      if (!parsed.success) return { content: [{ type: 'text', text: `Invalid arguments for ${name}: ${parsed.error.message}` }], isError: true };
      try {
        return (await def.handler(parsed.data as never, {})) as CallToolResult;
      } catch (err) {
        return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    }
    if (!opts.proxied().some((t) => t.name === name)) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    return toResult(await opts.call(name, args, extra.signal));
  });

  if (opts.resources) {
    // The host answers with JSON text (`encodeResource*`); anything it cannot serve is an MCP error the model reads.
    const ask = async <T>(tool: string, input: Record<string, unknown>, decode: (text: string) => ResourceDecode<T>, signal: AbortSignal): Promise<T> => {
      if (opts.proxied().length === 0) throw new McpError(ErrorCode.InvalidRequest, `The host server "${opts.name}" is not available in this session.`);
      const outcome = await opts.call(tool, input, signal);
      if (!outcome.success) throw new McpError(ErrorCode.InternalError, outcome.text);
      const decoded = decode(outcome.text);
      if (!decoded.ok) throw new McpError(ErrorCode.InternalError, decoded.error);
      return decoded.value;
    };
    instance.server.setRequestHandler(ListResourcesRequestSchema, async (_request, extra) => ({
      resources: await ask(HOST_RESOURCE_TOOLS.list, {}, decodeResourceList, extra.signal),
    }));
    instance.server.setRequestHandler(ListResourceTemplatesRequestSchema, async (_request, extra) => ({
      resourceTemplates: await ask(HOST_RESOURCE_TOOLS.templates, {}, decodeResourceTemplates, extra.signal),
    }));
    instance.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      const bad = checkResourceUri(request.params.uri);
      if (bad) throw new McpError(ErrorCode.InvalidParams, bad);
      return { contents: await ask(HOST_RESOURCE_TOOLS.read, { uri: request.params.uri }, decodeResourceContents, extra.signal) };
    });
  }

  return {
    config: { type: 'sdk', name: opts.name, instance } as McpSdkServerConfigWithInstance,
    notifyChanged: () => { void instance.server.sendToolListChanged().catch(() => undefined); },
  };
}

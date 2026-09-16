/**
 * Local authenticated HTTP proxy for one OAuth-gated remote MCP server.
 *
 * Both harnesses see this as a plain `http`-type MCP server with a custom
 * header (`X-Capability-Token`) — the OAuth machinery lives entirely behind
 * it. Modeled on `GoogleWorkspaceMcp.ts` (ephemeral `http.createServer` on
 * 127.0.0.1, per-thread capability tokens, streamed response piping with
 * backpressure) — see that file for the idioms this mirrors.
 *
 * Unlike Google Workspace's fixed `*.googleapis.com` upstream, an OAuth MCP
 * server can be any registered `https://` URL, so `oauthProxyRequest` below
 * generalizes `GoogleWorkspaceMcp.ts`'s Node-`https`-based upstream (chosen
 * there, and here, because Node's http/https client bypasses Electron
 * renderer CSP/CORS and never silently follows redirects, unlike `fetch`).
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { randomBytes } from 'crypto';
import { once } from 'events';

export interface ToolFilter {
  allow?: string[];
  deny?: string[];
}

/** Subset of OAuthTokenStore this proxy depends on — refreshes are the store's concern, not the proxy's. */
export interface ProxyTokenStore {
  getAccessToken(serverName: string): Promise<string | null>;
  refresh(serverName: string): Promise<unknown>;
}

interface UpstreamResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
}

type Upstream = (url: string, options: { method?: string; headers: Record<string, string>; body?: Buffer; signal?: AbortSignal }) => Promise<UpstreamResponse>;

const requestHeaders = ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id'];
const responseHeaders = ['content-type', 'content-encoding', 'mcp-session-id', 'mcp-protocol-version', 'retry-after', 'cache-control'];

/** Node http/https bypasses renderer CSP/CORS; unlike browser fetch it never follows redirects. */
export const oauthProxyRequest: Upstream = (url, options) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const requestFn = target.protocol === 'http:' ? httpRequest : httpsRequest;
  const request = requestFn(url, { method: options.method, headers: options.headers, signal: options.signal }, (incoming) => {
    const status = incoming.statusCode ?? 502;
    if ([301, 302, 303, 307, 308].includes(status)) { incoming.destroy(); reject(new Error('redirect-rejected')); return; }
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const body = [204, 205, 304].includes(status) ? null : incoming;
    if (!body) incoming.resume();
    resolve({ body, status, headers });
  });
  request.on('error', reject);
  if (options.body) request.write(options.body);
  request.end();
});

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: { name?: string; [key: string]: unknown };
}

function tryParseJson(buf: Buffer): JsonRpcMessage | undefined {
  if (buf.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(buf.toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as JsonRpcMessage) : undefined;
  } catch {
    return undefined;
  }
}

function isToolCallRequest(body: JsonRpcMessage | undefined): body is JsonRpcMessage & { params: { name: string } } {
  return !!body && body.method === 'tools/call' && typeof body.params?.name === 'string';
}

function isToolListRequest(body: JsonRpcMessage | undefined): boolean {
  return !!body && body.method === 'tools/list';
}

function isDenied(toolName: string, filter: ToolFilter): boolean {
  if (filter.allow) return !filter.allow.includes(toolName);
  if (filter.deny) return filter.deny.includes(toolName);
  return false;
}

/** Filters `result.tools` in a tools/list JSON-RPC response by the allow/deny list. Passes through anything else unchanged. */
function filterToolListPayload(payload: unknown, filter: ToolFilter): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const result = (payload as { result?: unknown }).result;
  if (!result || typeof result !== 'object' || !Array.isArray((result as { tools?: unknown }).tools)) return payload;
  const tools = (result as { tools: Array<{ name: string }> }).tools;
  return {
    ...(payload as object),
    result: { ...(result as object), tools: tools.filter((tool) => !isDenied(tool.name, filter)) },
  };
}

/** One local HTTP proxy per registered `oauth`-type MCP server. */
export class OAuthMcpProxy {
  private server?: Server;
  private port = 0;
  private capabilityTokens = new Map<string, string>(); // threadId -> token
  private requests = new Set<AbortController>();

  constructor(
    private readonly serverName: string,
    private readonly upstreamUrl: string,
    private readonly tokenStore: ProxyTokenStore,
    private readonly toolFilter?: ToolFilter,
    private readonly upstream: Upstream = oauthProxyRequest,
  ) {}

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => { void this.handle(req, res); });
      this.server = server;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('OAuth MCP proxy failed to bind a port.')); return; }
        this.port = address.port;
        resolve();
      });
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/`;
  }

  /**
   * The thread's capability token, minted on first request and **stable
   * thereafter** for as long as the thread stays active.
   *
   * Stability is load-bearing, not a convenience. The token is handed to the
   * SDK inside the `X-Capability-Token` header of a `mcpServers` entry, and
   * that config is only applied when a harness session is *created*: on a
   * resumed session `ThreadManager.sendMessage` rebuilds the options (calling
   * through to this method) but then discards everything except model and
   * permission mode, because the live Query keeps the headers it was spawned
   * with. So the running MCP client goes on presenting the token from turn 1
   * forever.
   *
   * Re-minting here would therefore overwrite the map entry with a token that
   * nothing in flight is using, and the very next tool call would fail the
   * `threadIdForToken` lookup with "Invalid or missing capability token." —
   * every turn after the first. Mirrors `GoogleWorkspaceMcp.serversForThread`,
   * which likewise mints its capability once per thread binding and reuses it.
   *
   * Revocation stays explicit, via `revokeCapabilityToken`/`retainThreads`.
   */
  capabilityTokenFor(threadId: string): string {
    const existing = this.capabilityTokens.get(threadId);
    if (existing) return existing;
    const token = randomBytes(32).toString('hex');
    this.capabilityTokens.set(threadId, token);
    return token;
  }

  revokeCapabilityToken(threadId: string): void {
    this.capabilityTokens.delete(threadId);
  }

  /** Cleanup sweep (mirrors `GoogleWorkspaceMcp.retainThreads`): revoke tokens for any thread no longer active. */
  retainThreads(activeThreadIds: Set<string>): void {
    for (const threadId of this.capabilityTokens.keys()) {
      if (!activeThreadIds.has(threadId)) this.revokeCapabilityToken(threadId);
    }
  }

  async stop(): Promise<void> {
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    this.capabilityTokens.clear();
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private threadIdForToken(token: string): string | undefined {
    for (const [threadId, value] of this.capabilityTokens) {
      if (value === token) return threadId;
    }
    return undefined;
  }

  private reply(res: ServerResponse, status: number, payload: unknown): void {
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    } else {
      res.destroy();
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const capToken = req.headers['x-capability-token'];
    const threadId = typeof capToken === 'string' ? this.threadIdForToken(capToken) : undefined;
    if (!threadId) { this.reply(res, 403, { error: 'Invalid or missing capability token.' }); return; }

    const controller = new AbortController();
    this.requests.add(controller);
    res.on('close', () => controller.abort());

    try {
      let accessToken = await this.tokenStore.getAccessToken(this.serverName);
      if (!accessToken) {
        this.reply(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'OAuth token expired — re-authorize in Agent Threads settings.' } });
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 10 * 1024 * 1024) { this.reply(res, 413, { error: 'MCP request exceeds 10 MiB.' }); return; }
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      const parsedBody = tryParseJson(body);

      if (this.toolFilter && isToolCallRequest(parsedBody)) {
        const toolName = parsedBody.params.name;
        if (isDenied(toolName, this.toolFilter)) {
          this.reply(res, 200, { jsonrpc: '2.0', id: parsedBody.id, error: { code: -32601, message: `Tool "${toolName}" is blocked by Agent Threads configuration.` } });
          return;
        }
      }

      let response = await this.forward(req, body, accessToken, controller.signal);
      if (response.status === 401) {
        try { await this.tokenStore.refresh(this.serverName); } catch { /* fall through — retry surfaces the same failure if the refresh failed */ }
        accessToken = await this.tokenStore.getAccessToken(this.serverName);
        if (accessToken) response = await this.forward(req, body, accessToken, controller.signal);
      }

      await this.pipeResponse(response, res, parsedBody, controller.signal);
    } catch {
      this.reply(res, 502, { error: 'OAuth MCP proxy request failed.' });
    } finally {
      this.requests.delete(controller);
    }
  }

  private async forward(req: IncomingMessage, body: Buffer, accessToken: string, signal: AbortSignal): Promise<UpstreamResponse> {
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
    for (const name of requestHeaders) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    return this.upstream(this.upstreamUrl, {
      method: req.method,
      headers,
      body: req.method === 'POST' ? body : undefined,
      signal,
    });
  }

  private async readAll(body: AsyncIterable<Uint8Array>): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }

  private async pipeResponse(response: UpstreamResponse, res: ServerResponse, requestBody: JsonRpcMessage | undefined, signal: AbortSignal): Promise<void> {
    const forwarded: Record<string, string> = {};
    for (const name of responseHeaders) {
      const value = response.headers.get(name);
      if (value) forwarded[name] = value;
    }
    const contentType = response.headers.get('content-type') ?? '';

    // Only ever buffer a JSON tools/list response to filter it — SSE and everything
    // else streams through untouched, chunk by chunk, per the MCP streamable-HTTP spec.
    if (this.toolFilter && isToolListRequest(requestBody) && contentType.includes('application/json') && response.body) {
      const text = await this.readAll(response.body);
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { res.writeHead(response.status, forwarded); res.end(text); return; }
      const filtered = filterToolListPayload(payload, this.toolFilter);
      const json = JSON.stringify(filtered);
      res.writeHead(response.status, { ...forwarded, 'content-type': 'application/json' });
      res.end(json);
      return;
    }

    res.writeHead(response.status, forwarded);
    if (response.body) {
      for await (const chunk of response.body) {
        if (signal.aborted) { res.destroy(); return; }
        if (!res.write(chunk)) await once(res, 'drain', { signal });
      }
    }
    res.end();
  }
}

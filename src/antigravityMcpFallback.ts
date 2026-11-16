/**
 * Compact `call_mcp_tool` fallback dispatcher and lazy external MCP client pool for Antigravity (`agy acp`).
 *
 * In `agy acp` (verified on 1.5.8), Antigravity writes every connected MCP server's tool schemas to
 * `<appDataDir>/mcp/<serverName>/<toolName>.json`, then packs tools smallest-schema-first up to ~128 eager native
 * declarations while omitting `call_mcp_tool` and the `Lazy:` catalog in ACP mode. Exposing a tiny (<400 B)
 * `call_mcp_tool` tool on the `agent-threads` loopback bridge guarantees it stays in `Eager:` and lets the model list
 * or invoke any non-eager host tool or external HTTP/SSE/stdio MCP tool after reading its cached schema file.
 *
 * `HttpMcpConnection` speaks MCP Streamable HTTP (`POST` returning `application/json` or `text/event-stream`), matching
 * `OAuthMcpProxy.ts`.
 *
 * Core module: no Obsidian, Electron, or DOM imports. Node's `http`/`https` are required lazily inside the HTTP
 * transport, and stdio reuses `AcpClient` (which lazily requires `child_process`), so importing this module is inert
 * on mobile.
 */
import type { ClientRequest, IncomingMessage } from 'http';
import { AcpClient, type AcpLauncher } from './AcpClient';
import type { HarnessMcpServerConfig, HarnessPermissionMode } from './HarnessSession';

export const CALL_MCP_TOOL_NAME = 'call_mcp_tool';

export const CALL_MCP_TOOL_DEFINITION = {
  name: CALL_MCP_TOOL_NAME,
  description: 'List (omit tool) or invoke any MCP tool omitted from Eager; read <appDataDir>/mcp/<server>/<tool>.json first.',
  inputSchema: {
    type: 'object',
    properties: {
      server: { type: 'string' },
      tool: { type: 'string' },
      argsJson: { type: 'string' },
    },
    required: ['server'],
    additionalProperties: false,
  },
} as const;

export const ANTIGRAVITY_MCP_FALLBACK_NOTE =
  'Antigravity MCP note: agy acp omits call_mcp_tool and tools above its ~128-declaration eager cap, but caches every connected server\'s schemas under <appDataDir>/mcp/<serverName>/<toolName>.json. When an Agent Threads tool (server "agent-threads", e.g. vault_search, enter_worktree, threads_get_messages, ScheduleWakeup) or configured MCP server tool is missing from Eager, read its schema file (or call mcp_agent-threads_call_mcp_tool with {"server":"<serverName>"} to list tools) and invoke it via mcp_agent-threads_call_mcp_tool with {"server":"<serverName>","tool":"<toolName>","argsJson":"{...}"}.';

export const ANTIGRAVITY_EXECUTION_NOTE =
  'Antigravity execution note: Before multi-step tool runs and between major phases, emit a brief 1-sentence prose status update so the user can follow progress live instead of seeing only silent tool calls. Batch independent read, search, and MCP tool calls in parallel within the same turn whenever one call does not depend on another\'s output.';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_CLIENT_INFO = { name: 'agent-threads-antigravity-bridge', version: '1.0.0' };
const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const MAX_TOOL_LIST_PAGES = 10;
const MAX_HTTP_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface ExternalMcpToolSummary {
  name: string;
  description: string;
}

export interface ExternalMcpCallResult {
  isError: boolean;
  text: string;
  structuredContent?: Record<string, unknown>;
}

export interface ExternalMcpPoolOptions {
  servers?: Record<string, HarnessMcpServerConfig>;
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdioLauncher?: AcpLauncher;
}

/**
 * Same permission policy `AntigravitySession` applies to external MCP tools (`kind: 'other'`).
 */
export function resolveExternalMcpToolPermission(mode: HarnessPermissionMode): 'allow' | 'deny' | 'prompt' {
  switch (mode) {
    case 'bypassPermissions':
    case 'auto':
      return 'allow';
    case 'dontAsk':
      return 'deny';
    case 'default':
    case 'acceptEdits':
    case 'plan':
    default:
      return 'prompt';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ParsedCallMcpToolInput =
  | { ok: true; server: string; tool: string; args: Record<string, unknown> }
  | { ok: false; error: string };

/** Validate and normalize `call_mcp_tool` input arguments. */
export function parseCallMcpToolInput(rawArgs: Record<string, unknown>): ParsedCallMcpToolInput {
  const server = typeof rawArgs.server === 'string' ? rawArgs.server.trim() : '';
  if (!server) return { ok: false, error: 'Missing required "server" argument.' };

  if (rawArgs.tool !== undefined && typeof rawArgs.tool !== 'string') {
    return { ok: false, error: '"tool" must be a string when provided.' };
  }
  const tool = typeof rawArgs.tool === 'string' ? rawArgs.tool.trim() : '';

  let parsedArgs: Record<string, unknown> = {};
  if (rawArgs.argsJson !== undefined) {
    if (typeof rawArgs.argsJson !== 'string') {
      return { ok: false, error: 'argsJson must be a JSON object string' };
    }
    const trimmed = rawArgs.argsJson.trim();
    if (trimmed.length > 0) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(trimmed);
      } catch {
        return { ok: false, error: 'argsJson must be a JSON object string' };
      }
      if (!isPlainObject(decoded)) {
        return { ok: false, error: 'argsJson must be a JSON object string' };
      }
      parsedArgs = decoded;
    } else if (rawArgs.arguments !== undefined) {
      if (!isPlainObject(rawArgs.arguments)) {
        return { ok: false, error: 'argsJson must be a JSON object string' };
      }
      parsedArgs = rawArgs.arguments;
    }
  } else if (rawArgs.arguments !== undefined) {
    if (!isPlainObject(rawArgs.arguments)) {
      return { ok: false, error: 'argsJson must be a JSON object string' };
    }
    parsedArgs = rawArgs.arguments;
  }

  return { ok: true, server, tool, args: parsedArgs };
}

function formatImagePlaceholder(item: Record<string, unknown>): string {
  const source = item.source as { media_type?: unknown; data?: unknown } | undefined;
  const mediaType =
    (typeof item.mimeType === 'string' && item.mimeType)
    || (typeof source?.media_type === 'string' && source.media_type)
    || 'image';
  const base64 =
    (typeof item.data === 'string' && item.data)
    || (typeof source?.data === 'string' && source.data)
    || '';
  if (!base64) return `[image: ${mediaType}]`;
  const kb = Math.max(1, Math.round((base64.length * 3) / 4 / 1024));
  return `[image: ${mediaType}, ${kb}kB]`;
}

/**
 * Flatten an MCP `tools/call` result into text, converting base64 image blocks into compact placeholders (matching
 * `ObsidianTools.ts`).
 *
 * `agy acp` feeds ONLY `CallToolResult.content` text blocks to the model — never `CallToolResult.structuredContent` or
 * `_meta`. Tools such as Compass's upload preparers return a human-readable summary in `content` while placing
 * machine-only fields (`clientToken`, `receipt`) exclusively inside object `structuredContent`. We therefore serialize
 * plain-object `structuredContent` into `text` even when `content` is non-empty (skipping duplicate output when
 * `content` already equals the compact or pretty-printed JSON of `structuredContent`, and ignoring non-object
 * `structuredContent` when `content` is non-empty, matching `asStructuredContent` in `src/protocol/hostTools.ts`).
 * `_meta` is never forwarded.
 */
export function formatExternalMcpToolResult(res: unknown): ExternalMcpCallResult {
  const obj = isPlainObject(res) ? res : {};
  const isError = Boolean(obj.isError);
  const blocks = Array.isArray(obj.content) ? obj.content : [];
  let text = blocks
    .map((raw) => {
      if (!isPlainObject(raw)) return String(raw ?? '');
      if (raw.type === 'text') return typeof raw.text === 'string' ? raw.text : '';
      if (raw.type === 'image') return formatImagePlaceholder(raw);
      return JSON.stringify(raw);
    })
    .join('\n');
  const structuredContent = isPlainObject(obj.structuredContent) ? obj.structuredContent : undefined;
  const trimmed = text.trim();
  if (structuredContent !== undefined) {
    try {
      const serialized = JSON.stringify(structuredContent);
      if (typeof serialized === 'string') {
        if (!trimmed) {
          text = serialized;
        } else if (
          trimmed !== serialized
          && !(trimmed.startsWith('{') && trimmed === JSON.stringify(structuredContent, null, 2))
        ) {
          text = `${text}\n\nstructuredContent:\n${serialized}`;
        }
      }
    } catch {
      // Unserializable structuredContent: preserve `content` text without throwing.
    }
  } else if (!trimmed && obj.structuredContent !== undefined && obj.structuredContent !== null) {
    try {
      text = JSON.stringify(obj.structuredContent) ?? text;
    } catch {
      // Ignore unserializable fallback payloads.
    }
  }
  return {
    isError,
    text,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
  };
}

/** Extract joined `data:` payload from one SSE event block (`\n\n`-delimited). */
export function parseSseEventData(frame: string): string | null {
  const dataLines: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    if (rawLine.startsWith('data:')) {
      const value = rawLine.slice(5);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  }
  return dataLines.length > 0 ? dataLines.join('\n') : null;
}

function isJsonRpcReplyEnvelope(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && ('result' in value || 'error' in value);
}

function findMatchingRpcReply(parsed: unknown, requestId: number): Record<string, unknown> | null {
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (isJsonRpcReplyEnvelope(item) && String(item.id) === String(requestId)) return item;
    }
    return null;
  }
  if (isJsonRpcReplyEnvelope(parsed) && String(parsed.id) === String(requestId)) return parsed;
  return null;
}

interface ExternalMcpConnection {
  listTools(): Promise<ExternalMcpToolSummary[]>;
  callTool(tool: string, args: Record<string, unknown>): Promise<ExternalMcpCallResult>;
  close(): void;
}

async function paginateToolsList(
  fetchPage: (cursor?: string) => Promise<any>,
): Promise<ExternalMcpToolSummary[]> {
  const collected: ExternalMcpToolSummary[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
    const res = await fetchPage(cursor);
    const list = Array.isArray(res?.tools) ? res.tools : [];
    for (const item of list) {
      if (item && typeof item.name === 'string' && item.name) {
        collected.push({
          name: item.name,
          description: typeof item.description === 'string' ? item.description : '',
        });
      }
    }
    const nextCursor = typeof res?.nextCursor === 'string' && res.nextCursor ? res.nextCursor : undefined;
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return collected;
}

// ── Streamable HTTP / SSE MCP Client ───────────────────────────────────────

class HttpMcpConnection implements ExternalMcpConnection {
  private nextId = 1;
  private sessionId: string | undefined;
  private negotiatedProtocolVersion: string | undefined;
  private closed = false;
  private readonly activeRequests = new Set<ClientRequest>();
  private readyPromise: Promise<void> | null = null;

  constructor(
    private readonly serverName: string,
    private readonly config: Extract<HarnessMcpServerConfig, { url: string }>,
    private readonly onTransportFailed: () => void,
  ) {}

  private get timeoutMs(): number {
    return this.config.timeout ?? DEFAULT_MCP_TIMEOUT_MS;
  }

  private ensureInitialized(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        const initRes = await this.sendRpc('initialize', {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: MCP_CLIENT_INFO,
        }, true);
        const negotiated = typeof initRes?.protocolVersion === 'string' && initRes.protocolVersion
          ? initRes.protocolVersion
          : MCP_PROTOCOL_VERSION;
        this.negotiatedProtocolVersion = negotiated;
        await this.sendRpc('notifications/initialized', undefined, false);
      })().catch((error) => {
        this.readyPromise = null;
        this.negotiatedProtocolVersion = undefined;
        this.onTransportFailed();
        throw error;
      });
    }
    return this.readyPromise;
  }

  async listTools(): Promise<ExternalMcpToolSummary[]> {
    await this.ensureInitialized();
    return paginateToolsList((cursor) => this.sendRpc('tools/list', cursor ? { cursor } : {}, true));
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<ExternalMcpCallResult> {
    await this.ensureInitialized();
    const res = await this.sendRpc('tools/call', { name: tool, arguments: args }, true);
    return formatExternalMcpToolResult(res);
  }

  close(): void {
    this.closed = true;
    for (const req of [...this.activeRequests]) {
      req.destroy();
    }
    this.activeRequests.clear();
  }

  private buildHeaders(): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.config.headers ?? {})) {
      merged[key] = value;
    }
    const lowerKeys = new Map(Object.keys(merged).map((k) => [k.toLowerCase(), k]));
    const setHeader = (name: string, value: string) => {
      const existing = lowerKeys.get(name.toLowerCase());
      if (existing) delete merged[existing];
      merged[name] = value;
      lowerKeys.set(name.toLowerCase(), name);
    };
    setHeader('content-type', 'application/json');
    setHeader('accept', 'application/json, text/event-stream');
    if (this.sessionId) setHeader('mcp-session-id', this.sessionId);
    if (this.negotiatedProtocolVersion) setHeader('mcp-protocol-version', this.negotiatedProtocolVersion);
    return merged;
  }

  private sendRpc(method: string, params: Record<string, unknown> | undefined, expectReply: boolean, redirectDepth = 0): Promise<any> {
    if (this.closed) return Promise.reject(new Error(`MCP server "${this.serverName}" was closed.`));
    return this.sendRpcToUrl(this.config.url, method, params, expectReply, redirectDepth);
  }

  private sendRpcToUrl(
    targetUrl: string,
    method: string,
    params: Record<string, unknown> | undefined,
    expectReply: boolean,
    redirectDepth: number,
  ): Promise<any> {
    if (this.closed) return Promise.reject(new Error(`MCP server "${this.serverName}" was closed.`));
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    // Lazy Node require so importing this module is completely inert on mobile.
    const requestFn = parsedUrl.protocol === 'https:'
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ? (require('https') as typeof import('https')).request
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      : (require('http') as typeof import('http')).request;

    const requestId = expectReply ? this.nextId++ : undefined;
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      ...(requestId !== undefined ? { id: requestId } : {}),
      method,
      ...(params !== undefined ? { params } : {}),
    });

    const timeoutMs = this.timeoutMs;

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finishResolve = (value: any) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.activeRequests.delete(req);
        resolve(value);
      };

      const finishReject = (error: Error, resetTransport: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.activeRequests.delete(req);
        if (resetTransport) this.onTransportFailed();
        reject(error);
      };

      const req = requestFn(
        parsedUrl,
        {
          method: 'POST',
          headers: {
            ...this.buildHeaders(),
            'content-length': String(Buffer.byteLength(payload, 'utf8')),
          },
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          const location = typeof res.headers.location === 'string' ? res.headers.location : undefined;
          if ((status === 307 || status === 308) && location && redirectDepth < 3) {
            let nextUrl: URL | null = null;
            try {
              nextUrl = new URL(location, parsedUrl);
            } catch {
              nextUrl = null;
            }
            if (nextUrl && nextUrl.origin === parsedUrl.origin) {
              res.resume();
              if (timer) clearTimeout(timer);
              this.activeRequests.delete(req);
              settled = true;
              this.sendRpcToUrl(nextUrl.toString(), method, params, expectReply, redirectDepth + 1).then(resolve, reject);
              return;
            }
          }

          const returnedSessionId = res.headers['mcp-session-id'];
          if (typeof returnedSessionId === 'string' && returnedSessionId.trim()) {
            this.sessionId = returnedSessionId.trim();
          } else if (Array.isArray(returnedSessionId) && returnedSessionId[0]?.trim()) {
            this.sessionId = returnedSessionId[0].trim();
          }

          if (status < 200 || status >= 300) {
            let errBody = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              if (errBody.length < 512) errBody += chunk;
            });
            res.on('end', () => {
              const snippet = errBody.trim() ? `: ${errBody.trim().slice(0, 200)}` : '';
              finishReject(new Error(`MCP server "${this.serverName}" returned HTTP ${status}${snippet}`), true);
            });
            res.on('error', (err) => finishReject(err instanceof Error ? err : new Error(String(err)), true));
            return;
          }

          if (!expectReply || requestId === undefined) {
            res.resume();
            finishResolve(undefined);
            return;
          }

          const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
          res.setEncoding('utf8');

          if (contentType.includes('text/event-stream')) {
            let sseBuffer = '';
            let receivedBytes = 0;

            const tryResolveFromFrame = (frame: string): boolean => {
              const data = parseSseEventData(frame);
              if (!data) return false;
              let decoded: unknown;
              try {
                decoded = JSON.parse(data);
              } catch {
                return false;
              }
              const reply = findMatchingRpcReply(decoded, requestId);
              if (!reply) return false;
              if (isPlainObject(reply.error)) {
                finishReject(new Error(String(reply.error.message ?? `MCP error from ${this.serverName}`)), false);
              } else {
                finishResolve(reply.result);
              }
              res.destroy();
              return true;
            };

            res.on('data', (chunk: string) => {
              if (settled) return;
              receivedBytes += chunk.length;
              if (receivedBytes > MAX_HTTP_RESPONSE_BYTES) {
                finishReject(new Error(`MCP server "${this.serverName}" response exceeded size limit`), true);
                res.destroy();
                return;
              }
              sseBuffer += chunk;
              let match: RegExpExecArray | null;
              while ((match = /\r?\n\r?\n/.exec(sseBuffer)) !== null) {
                const frame = sseBuffer.slice(0, match.index);
                sseBuffer = sseBuffer.slice(match.index + match[0].length);
                if (tryResolveFromFrame(frame)) return;
              }
            });
            res.on('end', () => {
              if (settled) return;
              if (sseBuffer.trim() && tryResolveFromFrame(sseBuffer)) return;
              finishReject(new Error(`MCP server "${this.serverName}" closed SSE stream without answering ${method}`), true);
            });
            res.on('error', (err) => {
              if (!settled) finishReject(err instanceof Error ? err : new Error(String(err)), true);
            });
            return;
          }

          let jsonBody = '';
          let receivedBytes = 0;
          res.on('data', (chunk: string) => {
            if (settled) return;
            receivedBytes += chunk.length;
            if (receivedBytes > MAX_HTTP_RESPONSE_BYTES) {
              finishReject(new Error(`MCP server "${this.serverName}" response exceeded size limit`), true);
              res.destroy();
              return;
            }
            jsonBody += chunk;
          });
          res.on('end', () => {
            if (settled) return;
            let decoded: unknown;
            try {
              decoded = JSON.parse(jsonBody);
            } catch {
              finishReject(new Error(`MCP server "${this.serverName}" returned invalid JSON for ${method}`), true);
              return;
            }
            const reply = findMatchingRpcReply(decoded, requestId)
              ?? (isPlainObject(decoded) && ('result' in decoded || 'error' in decoded) ? decoded : null);
            if (!reply) {
              finishReject(new Error(`MCP server "${this.serverName}" returned a non-JSON-RPC response for ${method}`), true);
              return;
            }
            if (isPlainObject(reply.error)) {
              finishReject(new Error(String(reply.error.message ?? `MCP error from ${this.serverName}`)), false);
              return;
            }
            finishResolve(reply.result);
          });
          res.on('error', (err) => {
            if (!settled) finishReject(err instanceof Error ? err : new Error(String(err)), true);
          });
        },
      );

      this.activeRequests.add(req);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          finishReject(new Error(`MCP server "${this.serverName}" timed out after ${timeoutMs}ms on ${method}`), true);
          req.destroy();
        }, timeoutMs);
      }
      req.on('error', (err) => {
        finishReject(err instanceof Error ? err : new Error(String(err)), true);
      });
      req.write(payload);
      req.end();
    });
  }
}

// ── Stdio MCP Client (reuses AcpClient NDJSON framing) ─────────────────────

class StdioMcpConnection implements ExternalMcpConnection {
  private client: AcpClient | null = null;
  private readyPromise: Promise<AcpClient> | null = null;
  private closed = false;

  constructor(
    private readonly serverName: string,
    private readonly config: Extract<HarnessMcpServerConfig, { command: string }>,
    private readonly poolOptions: ExternalMcpPoolOptions,
    private readonly onTransportFailed: () => void,
  ) {}

  private get timeoutMs(): number {
    return this.config.timeout ?? DEFAULT_MCP_TIMEOUT_MS;
  }

  private ensureClient(): Promise<AcpClient> {
    if (this.closed) return Promise.reject(new Error(`MCP server "${this.serverName}" was closed.`));
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        const timeoutMs = this.timeoutMs;
        const baseEnv = this.poolOptions.env ?? (typeof process !== 'undefined' ? process.env : {});
        const client = new AcpClient({
          binaryPath: this.config.command,
          args: this.config.args ?? [],
          cwd: this.poolOptions.cwd,
          env: { ...baseEnv, ...(this.config.env ?? {}) },
          launcher: this.poolOptions.stdioLauncher,
          startTimeoutMs: timeoutMs,
          label: `MCP server "${this.serverName}"`,
        });
        this.client = client;
        client.onClose(() => {
          if (this.client === client && !this.closed) {
            this.client = null;
            this.readyPromise = null;
            this.onTransportFailed();
          }
        });
        client.spawn();
        await client.request(
          'initialize',
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: MCP_CLIENT_INFO,
          },
          timeoutMs,
        );
        client.notify('notifications/initialized', {});
        return client;
      })().catch((error) => {
        const failedClient = this.client;
        this.client = null;
        this.readyPromise = null;
        failedClient?.close();
        this.onTransportFailed();
        throw error;
      });
    }
    return this.readyPromise;
  }

  async listTools(): Promise<ExternalMcpToolSummary[]> {
    const client = await this.ensureClient();
    const timeoutMs = this.timeoutMs;
    return paginateToolsList((cursor) => client.request('tools/list', cursor ? { cursor } : {}, timeoutMs));
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<ExternalMcpCallResult> {
    const client = await this.ensureClient();
    const res = await client.request('tools/call', { name: tool, arguments: args }, this.timeoutMs);
    return formatExternalMcpToolResult(res);
  }

  close(): void {
    this.closed = true;
    const active = this.client;
    this.client = null;
    this.readyPromise = null;
    active?.close();
  }
}

// ── Pool ───────────────────────────────────────────────────────────────────

export class ExternalMcpClientPool {
  private readonly connections = new Map<string, ExternalMcpConnection>();
  private closed = false;

  constructor(private readonly options: ExternalMcpPoolOptions = {}) {}

  hasServer(name: string): boolean {
    const servers = this.options.servers ?? {};
    return Object.prototype.hasOwnProperty.call(servers, name) && Boolean(servers[name]);
  }

  serverNames(): string[] {
    return Object.keys(this.options.servers ?? {}).filter((k) => Boolean(this.options.servers?.[k]));
  }

  private getOrCreate(name: string): ExternalMcpConnection {
    if (this.closed) throw new Error('External MCP client pool is closed.');
    const existing = this.connections.get(name);
    if (existing) return existing;
    if (!this.hasServer(name)) throw new Error(`Unknown MCP server "${name}".`);
    const config = this.options.servers![name]!;

    let created: ExternalMcpConnection;
    const evict = () => {
      if (this.connections.get(name) === created) {
        this.connections.delete(name);
      }
    };
    if ('url' in config) {
      created = new HttpMcpConnection(name, config, evict);
    } else {
      created = new StdioMcpConnection(name, config, this.options, evict);
    }
    this.connections.set(name, created);
    return created;
  }

  async listTools(serverName: string): Promise<ExternalMcpToolSummary[]> {
    return this.getOrCreate(serverName).listTools();
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<ExternalMcpCallResult> {
    return this.getOrCreate(serverName).callTool(toolName, args);
  }

  close(): void {
    this.closed = true;
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
  }
}

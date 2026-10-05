import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createHash, randomBytes } from 'crypto';
import { once } from 'events';
import { request as httpsRequest } from 'https';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { HostMcpSdkBridge } from './HostMcpSdkBridge';
import { DRIVE_FILES_SERVER, driveHttp, handleDriveFilesRpc, type DriveHttp } from './GoogleDriveFiles';

const DRIVE_FILES_PATH = '/drive-files';
/** Large transfers outlive the 5-minute limit applied to forwarded vendor MCP calls. */
const TRANSFER_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export const GOOGLE_SERVICES = ['docs', 'drive', 'sheets', 'slides', 'gmail', 'calendar'] as const;
type Service = typeof GOOGLE_SERVICES[number];
export type GoogleWorkspaceSelection = Partial<Record<Service, boolean>>;
interface DocsSync {
  settings: { authProxyUrl: string };
  tokenStore: {
    supportsConnectionGuard: boolean;
    get(): { refreshToken: string; accessToken: string } | null;
    getValidAccessToken(): Promise<string>;
  };
}
interface Binding {
  plugin: DocsSync;
  fingerprint: string;
  capability: string;
  services: Service[];
  revoked: boolean;
  ready: Promise<void>;
  metadata: GoogleWorkspaceBinding;
}
export interface GoogleWorkspaceBinding { fingerprint: string; services: Service[]; revoked?: boolean }
interface Persistence { bindings: Record<string, GoogleWorkspaceBinding>; save(): Promise<void> }
interface UpstreamResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | null;
}
type Upstream = (url: string, options: RequestInit) => Promise<UpstreamResponse>;
type Config = { type: 'http'; url: string; headers: Record<string, string> };
const requestHeaders = ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id'];
const responseHeaders = ['content-type', 'content-encoding', 'mcp-session-id', 'mcp-protocol-version', 'retry-after', 'cache-control'];

/** Node HTTPS bypasses renderer CSP/CORS; unlike browser fetch it never follows redirects. */
export const googleWorkspaceRequest: Upstream = (url, options) => new Promise((resolve, reject) => {
  const request = httpsRequest(url, { method: options.method, headers: options.headers as Record<string, string>, signal: options.signal ?? undefined }, incoming => {
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

/** Transport only: Google owns tool discovery, schemas, operations, and results. */
export class GoogleWorkspaceMcp {
  private server?: Server;
  private starting?: Promise<void>;
  private origin = '';
  private enabled: GoogleWorkspaceSelection = {};
  private bindings = new Map<string, Binding>();
  private requests = new Set<AbortController>();
  private closed = false;
  private tokenQueue: Promise<unknown> = Promise.resolve();
  private lastFailure = '';
  private vmBridges = new Map<string, Map<string, HostMcpSdkBridge>>();

  constructor(private readonly getPlugin: () => unknown, private readonly upstream: Upstream = googleWorkspaceRequest, private readonly tokenTimeoutMs = 30_000,
    private readonly persistence: Persistence = { bindings: {}, save: async () => {} },
    /** Local directories a thread may read from / write to with the large-file Drive tools (first = base for relative paths). */
    private readonly rootsForThread: (threadId: string) => string[] = () => [],
    private readonly transferHttp: DriveHttp = driveHttp) {}

  private connection(): DocsSync | undefined {
    const value = this.getPlugin() as Partial<DocsSync> | undefined;
    return value?.settings && value.tokenStore && typeof value.tokenStore.get === 'function'
      && typeof value.tokenStore.getValidAccessToken === 'function' ? value as DocsSync : undefined;
  }

  private fingerprint(plugin: DocsSync): string {
    return createHash('sha256').update(JSON.stringify([plugin.settings.authProxyUrl.trim().replace(/\/+$/, ''), plugin.tokenStore.get()?.refreshToken ?? null])).digest('hex');
  }

  status(): string {
    const plugin = this.connection();
    if (!plugin) return 'Enable Google Docs Sync, then connect your Google account in its settings.';
    if (plugin.tokenStore.supportsConnectionGuard !== true) return 'Update Google Docs Sync to a release with guarded connection refresh support, then restart this plugin.';
    if (!plugin.tokenStore.get()?.refreshToken) return 'Connect your Google account in Google Docs Sync settings.';
    const scopeHint = (['gmail', 'calendar'] as const).some(service => this.enabled[service])
      ? ' Gmail and Calendar need extra permissions: if their tools fail with a 403 or insufficient-scope error, disconnect and reconnect your account in Google Docs Sync.' : '';
    return this.lastFailure || 'Connected through Google Docs Sync. Google validates service access when a thread connects.' + scopeHint;
  }

  async configure(selection: GoogleWorkspaceSelection): Promise<void> {
    this.enabled = { ...selection };
    for (const binding of this.bindings.values()) {
      if (binding.services.some(service => !this.enabled[service])) binding.revoked = true;
    }
    let changed = false;
    for (const binding of Object.values(this.persistence.bindings)) {
      if (Array.isArray(binding.services) && binding.services.some(service => !this.enabled[service]) && !binding.revoked) { binding.revoked = true; changed = true; }
    }
    if (changed) {
      try { await this.persistence.save(); } catch {
        this.lastFailure = 'Google connection changes could not be saved. Check vault storage.';
        return;
      }
    }
    if (this.closed || !GOOGLE_SERVICES.some(service => selection[service]) || this.server?.listening) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve) => {
      const server = createServer((request, response) => { void this.handle(request, response); });
      this.server = server;
      server.requestTimeout = 30_000;
      server.headersTimeout = 15_000;
      server.on('error', () => { this.lastFailure = 'Google Workspace connection could not start. Restart this plugin and try again.'; resolve(); });
      server.listen(0, '127.0.0.1', () => {
        if (this.closed) { server.close(); resolve(); return; }
        const address = server.address();
        if (address && typeof address !== 'string') this.origin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
    await this.starting;
    this.starting = undefined;
  }

  serversForThread(threadId: string): Record<string, Config> {
    let binding = this.bindings.get(threadId);
    if (binding && !this.current(binding)) return {};
    const plugin = this.connection();
    if (!plugin || plugin.tokenStore.supportsConnectionGuard !== true || !plugin.tokenStore.get()?.refreshToken || !this.origin || this.closed) return {};
    if (!binding) {
      const fingerprint = this.fingerprint(plugin);
      const stored = this.persistence.bindings[threadId];
      if (stored && (stored.revoked || stored.fingerprint !== fingerprint || !Array.isArray(stored.services))) {
        this.lastFailure = 'Google connection changed. Start a new thread after reconnecting; existing Google access was revoked.';
        return {};
      }
      const services = stored ? GOOGLE_SERVICES.filter(service => stored.services.includes(service) && this.enabled[service]) : GOOGLE_SERVICES.filter(service => this.enabled[service]);
      if (!services.length) return {};
      this.persistence.bindings[threadId] = { fingerprint, services };
      const ready = Promise.resolve().then(() => this.persistence.save());
      void ready.catch(() => { this.lastFailure = 'Google connection binding could not be saved. Check vault storage and start a new thread.'; });
      binding = { plugin, fingerprint, capability: randomBytes(32).toString('hex'), services, revoked: false, ready, metadata: this.persistence.bindings[threadId] };
      this.bindings.set(threadId, binding);
      this.lastFailure = '';
    }
    const headers = { Authorization: `Bearer ${binding.capability}` };
    return Object.fromEntries(binding.services.flatMap((service): Array<[string, Config]> => [
      [`google-${service}`, { type: 'http', url: `${this.origin}/${service}`, headers }],
      // Same capability and revocation: local-disk transfers ride on the Drive opt-in.
      ...(service === 'drive' ? [[DRIVE_FILES_SERVER, { type: 'http', url: `${this.origin}${DRIVE_FILES_PATH}`, headers }] as [string, Config]] : []),
    ]));
  }

  /** Host-side SDK bridges for Claude sessions that actually start inside a VM. */
  vmServersForThread(threadId: string): Record<string, McpServerConfig> {
    const hostServers = this.serversForThread(threadId);
    let bridges = this.vmBridges.get(threadId);
    if (!bridges) {
      bridges = new Map();
      this.vmBridges.set(threadId, bridges);
    }
    const result: Record<string, McpServerConfig> = {};
    for (const [name, config] of Object.entries(hostServers)) {
      let bridge = bridges.get(name);
      if (!bridge) {
        bridge = new HostMcpSdkBridge(name, new URL(config.url), config.headers);
        bridges.set(name, bridge);
      }
      result[name] = bridge.config;
    }
    return result;
  }

  private current(binding: Binding): boolean {
    if (binding.revoked) return false;
    if (this.connection() !== binding.plugin || binding.plugin.tokenStore.supportsConnectionGuard !== true
      || !binding.plugin.tokenStore.get()?.refreshToken || this.fingerprint(binding.plugin) !== binding.fingerprint) {
      binding.revoked = true;
      binding.metadata.revoked = true;
      void this.persistence.save().catch(() => { this.lastFailure = 'Google connection revocation could not be saved. Check vault storage.'; });
      this.lastFailure = 'Google connection changed. Start a new thread after reconnecting; existing Google access was revoked.';
      return false;
    }
    return true;
  }

  /** Archive/delete cleanup. Call with the manager's retained thread IDs. */
  retainThreads(ids: Set<string>): void {
    for (const [id, binding] of this.bindings) if (!ids.has(id)) { binding.revoked = true; this.bindings.delete(id); }
    for (const [id, bridges] of this.vmBridges) {
      if (ids.has(id)) continue;
      this.vmBridges.delete(id);
      for (const bridge of bridges.values()) void bridge.close();
    }
    let changed = false;
    for (const id of Object.keys(this.persistence.bindings)) if (!ids.has(id)) { delete this.persistence.bindings[id]; changed = true; }
    if (changed) void this.persistence.save().catch(() => { this.lastFailure = 'Google connection cleanup could not be saved. Check vault storage.'; });
  }

  close(): void {
    this.closed = true;
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    for (const binding of this.bindings.values()) binding.revoked = true;
    this.bindings.clear();
    for (const bridges of this.vmBridges.values()) for (const bridge of bridges.values()) void bridge.close();
    this.vmBridges.clear();
    this.server?.closeAllConnections();
    this.server?.close();
    this.origin = '';
  }

  private reply(response: ServerResponse, status: number, message: string): void {
    if (!response.headersSent && !response.destroyed) {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: message }));
    } else response.destroy();
  }

  private abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const cancel = () => reject(new Error('cancelled'));
      if (signal.aborted) { cancel(); return; }
      signal.addEventListener('abort', cancel, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    });
  }

  /**
   * Serialize our refresh calls. The peer guard prevents an in-flight refresh from
   * overwriting a newer connection. Any refresh-token rotation revokes.
   */
  private accessToken(binding: Binding, signal: AbortSignal): Promise<string> {
    const tokenJob = this.tokenQueue.catch(() => {}).then(async () => {
      if (!this.current(binding) || signal.aborted) throw new Error('connection-changed');
      const token = await new Promise<string>((resolve, reject) => {
        const finish = (value?: string) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', cancel);
          if (value) resolve(value); else reject(new Error('token-unavailable'));
        };
        const cancel = () => finish();
        const timer = setTimeout(cancel, this.tokenTimeoutMs);
        signal.addEventListener('abort', cancel, { once: true });
        binding.plugin.tokenStore.getValidAccessToken().then(finish, cancel);
      });
      if (!this.current(binding) || signal.aborted) throw new Error('connection-changed');
      return token;
    });
    this.tokenQueue = tokenJob;
    return this.abortable(tokenJob, signal);
  }

  /**
   * Local MCP endpoint for large Drive transfers. Unlike the vendor endpoints this is not
   * forwarded: the tools run here and move bytes between Drive and the local disk.
   */
  private async handleTransfer(body: Buffer, response: ServerResponse, binding: Binding, controller: AbortController): Promise<void> {
    let parsed: unknown;
    try { parsed = JSON.parse(body.toString('utf8')); } catch { this.reply(response, 400, 'Invalid JSON-RPC request.'); return; }
    const messages = (Array.isArray(parsed) ? parsed : [parsed]) as Array<Parameters<typeof handleDriveFilesRpc>[0]>;
    const threadId = [...this.bindings].find(([, value]) => value === binding)?.[0] ?? '';
    const revoked = () => new Error('Google connection changed or is unavailable. Check Google Docs Sync, and start a new thread if you reconnected.');
    const ctx = {
      http: this.transferHttp,
      roots: this.rootsForThread(threadId),
      signal: controller.signal,
      check: () => { if (!this.current(binding)) throw revoked(); },
      getToken: () => this.accessToken(binding, controller.signal).catch(() => { throw revoked(); }),
    };
    // A transfer can run for minutes. Answer tools/call as an event stream and send comment
    // keepalives so the client never sees an idle connection or a header timeout.
    // Only calls that will get a reply can stream; an id-less notification must answer with a plain 202.
    const streaming = messages.some(message => message?.method === 'tools/call' && message.id !== undefined && message.id !== null);
    let keepalive: ReturnType<typeof setInterval> | undefined;
    if (streaming) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      keepalive = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, 15_000);
    }
    try {
      const replies = [];
      for (const message of messages) {
        const reply = await handleDriveFilesRpc(message, ctx);
        if (reply) replies.push(reply);
      }
      if (!replies.length) { response.writeHead(202); response.end(); return; }
      const payload = JSON.stringify(Array.isArray(parsed) ? replies : replies[0]);
      if (streaming) response.end(`event: message\ndata: ${payload}\n\n`);
      else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(payload); }
    } finally {
      if (keepalive) clearInterval(keepalive);
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.host !== this.origin.slice('http://'.length) || (request.headers.origin && request.headers.origin !== this.origin)) {
      this.reply(response, 403, 'Local native MCP clients only.'); return;
    }
    const transfer = request.url === DRIVE_FILES_PATH;
    const service = transfer ? 'drive' : GOOGLE_SERVICES.find(value => request.url === `/${value}`);
    if (!service) { this.reply(response, 404, 'Unknown Google service.'); return; }
    if (!(transfer ? ['POST'] : ['POST', 'GET', 'DELETE']).includes(request.method ?? '')) { this.reply(response, 405, 'Unsupported MCP method.'); return; }
    const binding = [...this.bindings.values()].find(value => request.headers.authorization === `Bearer ${value.capability}`);
    if (!binding || !binding.services.includes(service)) { this.reply(response, 401, 'Invalid local MCP capability.'); return; }
    if (!this.current(binding)) { this.reply(response, 409, 'Google connection changed. Start a new thread.'); return; }
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), transfer ? TRANSFER_TIMEOUT_MS : 300_000);
    response.on('close', () => controller.abort());
    try {
      await this.abortable(binding.ready, controller.signal);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 10 * 1024 * 1024) { this.reply(response, 413, 'MCP request exceeds 10 MiB.'); return; }
        chunks.push(Buffer.from(chunk));
      }
      if (transfer) { await this.handleTransfer(Buffer.concat(chunks), response, binding, controller); return; }
      const token = await this.accessToken(binding, controller.signal);
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      for (const name of requestHeaders) {
        const value = request.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      const upstream = await this.upstream(`https://${service}mcp.googleapis.com/mcp/v1`, {
        method: request.method, headers, body: request.method === 'POST' ? Buffer.concat(chunks) : undefined,
        redirect: 'error', signal: controller.signal,
      });
      if (!this.current(binding)) { this.reply(response, 409, 'Google connection changed. Start a new thread.'); return; }
      const forwarded: Record<string, string> = {};
      for (const name of responseHeaders) { const value = upstream.headers.get(name); if (value) forwarded[name] = value; }
      response.writeHead(upstream.status, forwarded);
      if (upstream.body) {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          if (!this.current(binding) || controller.signal.aborted) { response.destroy(); return; }
          if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal });
        }
      }
      response.end();
    } catch {
      this.reply(response, binding.revoked ? 409 : 502, binding.revoked ? 'Google connection changed. Start a new thread.' : 'Google Workspace request failed. Check Google Docs Sync connection and Workspace MCP settings.');
    } finally {
      clearTimeout(timeout);
      controller.abort();
      this.requests.delete(controller);
    }
  }
}

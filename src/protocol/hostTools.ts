/**
 * hostTools.ts
 *
 * Wire rules for proxied host tools (design 3.3 / 3.6): the manifest a client offers, the `tool.call`
 * the daemon sends, the `tool.result` that answers it. Pure: shared by the daemon (validate what a
 * client sends, bound what reaches the model) and the plugin (validate what a daemon asks for).
 *
 * Every limit here is a security control, not a nicety. `tool.call` / `tool.result` are a remote-control
 * surface in both directions: a client can feed arbitrary text to the model through a result, and a
 * compromised daemon can ask the client to run any tool it has offered. Bounds on counts, sizes and names
 * keep either side from exhausting the other, and the plugin only ever runs what is in the manifest it sent.
 */
import type { RemoteHostToolSpec } from './spec';

export const HOST_TOOL_LIMITS = {
  /** Servers in one manifest (`claude_threads`, `google-docs`, one per OAuth MCP). */
  maxServers: 16,
  /** Tools across all servers. */
  maxTools: 500,
  maxServerNameChars: 64,
  maxToolNameChars: 128,
  maxDescriptionChars: 8_192,
  /** Serialized JSON Schema of one tool. */
  maxSchemaBytes: 64 * 1024,
  /** Serialized manifest in total. */
  maxManifestBytes: 2 * 1024 * 1024,
  /** Serialized `input` of one `tool.call`; larger is refused to the model, never truncated. */
  maxInputBytes: 256 * 1024,
  /** `tool.result.text` above this is cut with a marker before it reaches the model. */
  maxResultTextChars: 1_000_000,
  /** `tool.result.text` above this is a malformed frame (the client should have cut it). */
  maxResultFrameChars: 8_000_000,
  /** Structured content blocks kept from one result (images), and their total serialized size. */
  maxResultContentBlocks: 8,
  maxResultContentBytes: 4 * 1024 * 1024,
  /** Calls the daemon keeps open per thread, and the plugin accepts at once per thread. */
  maxConcurrentCallsPerThread: 8,
  /** Calls the plugin accepts at once across all its threads. */
  maxConcurrentCallsTotal: 16,
  /** Calls the plugin accepts per thread per minute. */
  maxCallsPerMinute: 240,
} as const;

export const HOST_TOOL_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const HOST_TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const jsonBytes = (v: unknown): number => {
  try { return JSON.stringify(v)?.length ?? 0; } catch { return Number.POSITIVE_INFINITY; }
};

/** Shape check of one manifest entry. Returns a message naming the first problem, or null. */
export function validateHostToolSpec(t: unknown, path = 'tool'): string | null {
  if (!isPlainObject(t)) return `${path} must be an object`;
  const L = HOST_TOOL_LIMITS;
  if (typeof t.name !== 'string' || !HOST_TOOL_NAME.test(t.name)) return `${path}.name must match ${HOST_TOOL_NAME}`;
  if (typeof t.server !== 'string' || !HOST_TOOL_SERVER_NAME.test(t.server)) return `${path}.server must match ${HOST_TOOL_SERVER_NAME}`;
  if (typeof t.description !== 'string' || t.description.length > L.maxDescriptionChars) return `${path}.description must be a string of at most ${L.maxDescriptionChars} characters`;
  if (typeof t.requiresApproval !== 'boolean') return `${path}.requiresApproval must be a boolean`;
  if (!isPlainObject(t.inputSchema)) return `${path}.inputSchema must be an object (JSON Schema)`;
  if (jsonBytes(t.inputSchema) > L.maxSchemaBytes) return `${path}.inputSchema is too large (limit ${L.maxSchemaBytes} bytes)`;
  return null;
}

/** A flat list of entries (the `session.open` spec form): shapes, count, uniqueness per server. */
export function validateHostToolSpecs(specs: unknown, what = 'hostTools'): string | null {
  if (specs === undefined) return null;
  if (!Array.isArray(specs)) return `${what} must be an array`;
  const L = HOST_TOOL_LIMITS;
  if (specs.length > L.maxTools) return `${what} has too many entries (limit ${L.maxTools})`;
  const seen = new Set<string>();
  const servers = new Set<string>();
  for (let i = 0; i < specs.length; i++) {
    const problem = validateHostToolSpec(specs[i], `${what}[${i}]`);
    if (problem) return problem;
    const t = specs[i] as RemoteHostToolSpec;
    const key = `${t.server}\u0000${t.name}`;
    if (seen.has(key)) return `${what} lists ${t.server}/${t.name} twice`;
    seen.add(key);
    servers.add(t.server);
  }
  if (servers.size > L.maxServers) return `${what} names too many servers (limit ${L.maxServers})`;
  if (jsonBytes(specs) > L.maxManifestBytes) return `${what} is too large (limit ${L.maxManifestBytes} bytes)`;
  return null;
}

/** The `tool.manifest` form: server name -> its tools. The key and each entry's `server` must agree. */
export function validateManifestServers(servers: unknown): string | null {
  if (!isPlainObject(servers)) return 'servers must be an object';
  const L = HOST_TOOL_LIMITS;
  const names = Object.keys(servers);
  if (names.length > L.maxServers) return `too many servers (limit ${L.maxServers})`;
  let total = 0;
  for (const name of names) {
    if (!HOST_TOOL_SERVER_NAME.test(name)) return `server name "${name.slice(0, 40)}" must match ${HOST_TOOL_SERVER_NAME}`;
    const list = servers[name];
    if (!Array.isArray(list)) return `servers.${name} must be an array`;
    total += list.length;
    if (total > L.maxTools) return `too many tools (limit ${L.maxTools})`;
    for (let i = 0; i < list.length; i++) {
      const problem = validateHostToolSpec(list[i], `servers.${name}[${i}]`);
      if (problem) return problem;
      if ((list[i] as RemoteHostToolSpec).server !== name) return `servers.${name}[${i}].server must be "${name}"`;
    }
    const names2 = new Set((list as RemoteHostToolSpec[]).map((t) => t.name));
    if (names2.size !== list.length) return `servers.${name} lists a tool twice`;
  }
  if (jsonBytes(servers) > L.maxManifestBytes) return `manifest is too large (limit ${L.maxManifestBytes} bytes)`;
  return null;
}

/** `session.open.spec.hostTools` (flat) -> manifest form. */
export function manifestFromSpecs(specs: readonly RemoteHostToolSpec[] | undefined): Record<string, RemoteHostToolSpec[]> {
  const out: Record<string, RemoteHostToolSpec[]> = {};
  for (const t of specs ?? []) (out[t.server] ??= []).push(t);
  return out;
}

/** manifest form -> flat list (stable: servers sorted, tools in manifest order). */
export function specsFromManifest(servers: Readonly<Record<string, readonly RemoteHostToolSpec[]>>): RemoteHostToolSpec[] {
  return Object.keys(servers).sort().flatMap((name) => servers[name]);
}

/** Cheap change detector for "re-send the manifest": same tools, schemas and flags => same signature. */
export function manifestSignature(servers: Readonly<Record<string, readonly RemoteHostToolSpec[]>>): string {
  return JSON.stringify(Object.keys(servers).sort().map((name) => [name, servers[name].map((t) => [t.name, t.description, t.requiresApproval, t.inputSchema])]));
}

/** Look one tool up in a manifest; the plugin and the daemon both gate on this. */
export function findManifestTool(
  servers: Readonly<Record<string, readonly RemoteHostToolSpec[]>> | undefined,
  server: unknown,
  tool: unknown,
): RemoteHostToolSpec | undefined {
  if (!servers || typeof server !== 'string' || typeof tool !== 'string') return undefined;
  if (!Object.prototype.hasOwnProperty.call(servers, server)) return undefined;
  return servers[server].find((t) => t.name === tool);
}

// ── tool.call input ───────────────────────────────────────────────────────

export function checkCallInput(input: unknown): string | null {
  if (!isPlainObject(input)) return 'input must be a JSON object';
  const bytes = jsonBytes(input);
  if (bytes > HOST_TOOL_LIMITS.maxInputBytes) return `input is too large (${bytes} bytes; limit ${HOST_TOOL_LIMITS.maxInputBytes})`;
  return null;
}

// ── tool.result ───────────────────────────────────────────────────────────

export const TRUNCATION_MARKER = '\n[... output truncated: it exceeded the size limit for a proxied tool result ...]';

/** Cut an over-long result with an explicit marker; never silently. */
export function clampResultText(text: string, max: number = HOST_TOOL_LIMITS.maxResultTextChars): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + TRUNCATION_MARKER, truncated: true };
}

/**
 * Frame-level check of a `tool.result` payload (codec). The text may be up to `maxResultFrameChars` (a
 * client that is well behaved cuts at `maxResultTextChars` first; the daemon cuts again regardless).
 */
export function validateToolResultPayload(p: { text: unknown; content?: unknown }): string | null {
  const L = HOST_TOOL_LIMITS;
  if (typeof p.text !== 'string') return 'text must be a string';
  if (p.text.length > L.maxResultFrameChars) return `text is too large (limit ${L.maxResultFrameChars} characters)`;
  if (p.content !== undefined) {
    if (!Array.isArray(p.content)) return 'content must be an array';
    if (p.content.length > 64) return 'content has too many blocks';
    for (const b of p.content) if (!isPlainObject(b) || typeof b.type !== 'string') return 'content blocks must be objects with a string type';
  }
  return null;
}

export type ResultBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * What of a result's structured content may reach the model: text and (bounded) images only. Anything else
 * a client sends (resources, audio, unknown types) is dropped, so a client cannot smuggle new block kinds
 * into the model's context through this channel.
 */
export function sanitizeResultContent(content: unknown): ResultBlock[] {
  if (!Array.isArray(content)) return [];
  const L = HOST_TOOL_LIMITS;
  const out: ResultBlock[] = [];
  let bytes = 0;
  for (const raw of content) {
    if (out.length >= L.maxResultContentBlocks || !isPlainObject(raw)) continue;
    if (raw.type === 'image') {
      const data = typeof raw.data === 'string' ? raw.data : (isPlainObject(raw.source) && typeof raw.source.data === 'string' ? raw.source.data : '');
      const mime = typeof raw.mimeType === 'string' ? raw.mimeType : (isPlainObject(raw.source) && typeof raw.source.media_type === 'string' ? raw.source.media_type : '');
      if (!data || !IMAGE_MIME.has(mime) || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) continue;
      if (bytes + data.length > L.maxResultContentBytes) continue;
      bytes += data.length;
      out.push({ type: 'image', data, mimeType: mime });
    }
  }
  return out;
}

/** The text the model reads when a host tool cannot run because Geode is not connected. */
export function hostUnavailableText(tool: string, graceSec: number, why: 'detached' | 'timeout' | 'canceled' = 'detached'): string {
  if (why === 'timeout') {
    return `The host tool "${tool}" did not answer in time: the user's Geode did not respond. It may be busy or disconnected; retry later or continue without it.`;
  }
  if (why === 'canceled') return `The host tool "${tool}" was canceled before it finished.`;
  return `The user's Geode is not connected, and "${tool}" needs it (it runs in Geode, not on this machine). `
    + `I waited ${graceSec} seconds for it to reconnect. Retry later, or continue without this tool; the user is told this tool was unavailable.`;
}

/**
 * The plugin's own store of external MCP servers, backed by
 * `PluginSettings.mcpServers` in data.json.
 *
 * This module replaces the former `claudeSettingsMcp.ts` /
 * `claudeSettingsMcpEditor.ts` pair, which read and wrote a `mcpServers` block
 * inside `~/.claude/settings.json`. That was a squat: the file belongs to
 * Claude Code, its schema has no top-level `mcpServers` property, and no CLI or
 * SDK ever read what we put there. Nothing here touches that file.
 *
 * Two halves, deliberately kept apart:
 *
 * - The CRUD half (`listMcpServers` / `saveMcpServer` / `deleteMcpServer`)
 *   operates on the UNRESOLVED config exactly as stored. `${API_KEY}` stays
 *   verbatim, because this is what the settings UI renders.
 * - The resolve half (`resolveMcpServers`) expands `${VAR}` placeholders for a
 *   live session, and REFUSES to emit a server whose placeholders don't
 *   resolve. See the note on that function.
 *
 * No fs or process spawning lives here. Callers own persistence
 * (`saveSettings()`) and reporting; agent registration coordinates injected
 * host confirmation and persistence callbacks.
 */

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { PluginSettings, StoredMcpServer } from './types';
import { z } from 'zod';

const isReservedMcpName = (name: string): boolean =>
  ['claude_threads', 'obsidian', '__proto__', 'constructor', 'prototype'].includes(name.toLowerCase());

/**
 * The only hosts an OAuth callback URI may name. `URL.hostname` returns IPv6
 * literals bracketed (`[::1]`), so both spellings are listed.
 *
 * This is a security boundary, not a convenience check: whatever this URI names
 * is where the authorization server delivers the authorization code, and is the
 * interface we bind a local listener to. Anything outside loopback would either
 * expose the listener beyond this machine (`0.0.0.0`) or hand the code to a
 * remote host.
 */
const LOOPBACK_REDIRECT_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface ParsedRedirectUri {
  /** Host to bind the local callback server to, IPv6 brackets stripped for `server.listen`. */
  hostname: string;
  port: number;
  /** Path the callback must arrive on, e.g. `/callback`. */
  pathname: string;
}

/**
 * Validate and parse an `oauth` entry's `redirectUri` override.
 *
 * Returns a human-readable reason string when the URI is unusable, so the schema
 * can surface exactly which rule failed instead of a generic "invalid config".
 */
export function parseRedirectUri(value: string): { ok: true; parsed: ParsedRedirectUri } | { ok: false; error: string } {
  let url: URL;
  try { url = new URL(value); } catch { return { ok: false, error: 'redirectUri must be a valid absolute URL, e.g. http://localhost:3118/callback.' }; }
  // https is rejected rather than merely discouraged: the local callback server
  // serves plain HTTP and cannot terminate TLS, so an https URI could never be
  // reached at all.
  if (url.protocol !== 'http:') return { ok: false, error: 'redirectUri must use http:// — the local callback server cannot terminate TLS.' };
  if (!LOOPBACK_REDIRECT_HOSTS.has(url.hostname)) {
    return { ok: false, error: 'redirectUri host must be a loopback address (127.0.0.1, localhost or [::1]). Any other host, including 0.0.0.0, would expose the OAuth callback beyond this machine.' };
  }
  if (url.username || url.password) return { ok: false, error: 'redirectUri must not embed credentials.' };
  // The AS appends `code` and `state` to this URI; a query of our own would collide.
  if (url.search) return { ok: false, error: 'redirectUri must not contain a query string — the authorization server appends code and state itself.' };
  if (url.hash) return { ok: false, error: 'redirectUri must not contain a fragment.' };
  // An explicit port is mandatory: we have to know which port to bind, and a
  // portless URI would silently mean :80.
  if (!url.port) return { ok: false, error: 'redirectUri must include an explicit port, e.g. http://localhost:3118/callback.' };
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'redirectUri port must be between 1 and 65535.' };
  return { ok: true, parsed: { hostname: url.hostname.replace(/^\[|\]$/g, ''), port, pathname: url.pathname } };
}

/**
 * The only accepted shape for an `oauth` entry's `clientSecret`: a bare
 * `${NAME}` placeholder naming a keychain secret.
 *
 * Unlike the `placeholder` pattern used for headers/env, no `Bearer `/`Basic `
 * prefix is allowed — a client secret is a raw credential sent as a form
 * parameter or in a Basic-auth header the SDK builds itself, so a prefix here
 * could only be a mistake.
 *
 * Why this field refuses literals when the Settings UI accepts them: a value
 * passed to `mcp_register_server` is an argument in a tool call, which is
 * recorded verbatim in the thread transcript and the raw JSONL log. A human
 * typing into the Settings password field writes only to the keychain, so that
 * path takes a literal and never round-trips it through the schema.
 */
export const CLIENT_SECRET_PLACEHOLDER = /^\$\{([A-Z_][A-Z0-9_]*)\}$/i;

/**
 * The keychain variable an `oauth` entry's `clientSecret` placeholder names, or
 * `undefined` when the value is absent or not a placeholder. Callers resolve the
 * name themselves — this module has no keychain access.
 */
export function clientSecretVariableName(clientSecret: string | undefined): string | undefined {
  return clientSecret === undefined ? undefined : CLIENT_SECRET_PLACEHOLDER.exec(clientSecret)?.[1];
}

/** Shared schema, including direct harness calls which do not parse SDK schemas. */
export const mcpRegistrationSchema = z.object({
  name: z.string().trim().regex(/^[A-Za-z0-9_-]+$/).refine(name =>
    !isReservedMcpName(name)),
  type: z.enum(['stdio', 'http', 'sse', 'oauth']).describe(
    'Transport. Use "oauth" for any remote server that requires its own sign-in ' +
    '(Vercel, Figma, Linear, Notion and similar) — the plugin then brokers OAuth 2.1 + PKCE ' +
    'and opens a consent screen. Use "http"/"sse" only for endpoints that need no sign-in or ' +
    'authenticate with a static header. Use "stdio" for a local command.',
  ),
  command: z.string().trim().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().trim().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** `oauth` only: space-separated scope list requested at authorization. Omit to use the AS default scope. */
  scopes: z.string().optional().describe(
    'oauth only. Space-separated OAuth scopes. Omit to use the authorization server\'s default.',
  ),
  /** `oauth` only: tool allow/deny filtering enforced at the local proxy. `allow` and `deny` are mutually exclusive. */
  tools: z.object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  }).optional().describe(
    'oauth only. Per-tool filtering enforced at the local proxy. Set allow to expose only those ' +
    'tools, or deny to hide them; the two are mutually exclusive.',
  ),
  /** `oauth` only: skip Dynamic Client Registration by supplying a known public client_id. */
  clientId: z.string().optional().describe(
    'oauth only. Skip Dynamic Client Registration with a known public client_id. Usually omitted.',
  ),
  /**
   * `oauth` only: `client_secret` for a confidential client, as a `${NAME}`
   * placeholder resolved from the keychain — never a literal. See
   * `CLIENT_SECRET_PLACEHOLDER` for why this one field refuses literals even
   * though the Settings UI accepts them.
   */
  clientSecret: z.string().trim().optional().describe(
    'oauth only. Client secret for a provider that requires a confidential client (rejects ' +
    'token_endpoint_auth_method "none"). Must be a ${NAME} placeholder naming a secret stored ' +
    'with request_secret — a literal secret is rejected, since a tool call is recorded in the ' +
    'thread transcript. Usually omitted: most servers use a public client with PKCE alone.',
  ),
  /** `oauth` only: skip protected-resource discovery by supplying the AS metadata URL directly. */
  authorizationServerUrl: z.string().trim().url().startsWith('https://').optional().describe(
    'oauth only. Skip protected-resource discovery by naming the authorization server directly. Usually omitted.',
  ),
  /** `oauth` only: use this exact loopback URI as the OAuth callback instead of an ephemeral 127.0.0.1 port. */
  redirectUri: z.string().trim().optional().describe(
    'oauth only. Full loopback redirect URI to use for the OAuth callback, e.g. http://localhost:3118/callback — ' +
    'required by providers (Slack) that register one exact redirect URI. Must be http on a loopback host with an ' +
    'explicit port. Omit to use an ephemeral 127.0.0.1 port.',
  ),
}).strict().superRefine((entry, ctx) => {
  const invalid = () => ctx.addIssue({ code: 'custom', message: 'Invalid MCP configuration. Credentials must use ${NAME} placeholders; use request_secret to store them.' });
  const credentialKey = /authorization|cookie|token|secret|password|credential|api[-_]?key/i;
  const placeholder = /^(?:Bearer\s+|Basic\s+)?\$\{[A-Z_][A-Z0-9_]*\}$/i;
  // scopes/tools/clientId/clientSecret/authorizationServerUrl/redirectUri only make
  // sense for an oauth entry; a non-oauth entry carrying any of them is malformed
  // input, not a silently-ignored extra.
  const oauthOnlyFieldsSet = entry.scopes !== undefined || entry.tools !== undefined
    || entry.clientId !== undefined || entry.clientSecret !== undefined
    || entry.authorizationServerUrl !== undefined
    || entry.redirectUri !== undefined;
  if (entry.type === 'stdio') {
    if (!entry.command || entry.url !== undefined || entry.headers !== undefined || oauthOnlyFieldsSet) invalid();
    for (let i = 0; i < (entry.args?.length ?? 0); i++) {
      const arg = entry.args![i];
      if (arg.startsWith('-') && credentialKey.test(arg.split('=')[0])) {
        const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : entry.args![++i];
        if (!value || !placeholder.test(value)) invalid();
      }
    }
  } else if (entry.type === 'oauth') {
    if (!entry.url || entry.command !== undefined || entry.args !== undefined || entry.env !== undefined || entry.headers !== undefined) invalid();
    try {
      const url = new URL(entry.url ?? '');
      if (url.protocol !== 'https:' || url.username || url.password) invalid();
    } catch { invalid(); }
    if (entry.tools?.allow !== undefined && entry.tools?.deny !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'tools.allow and tools.deny are mutually exclusive.', path: ['tools'] });
    }
    if (entry.redirectUri !== undefined) {
      const result = parseRedirectUri(entry.redirectUri);
      if (!result.ok) ctx.addIssue({ code: 'custom', message: result.error, path: ['redirectUri'] });
    }
    // A literal secret here would be persisted into the thread transcript and the
    // raw JSONL log by the tool call itself, before this plugin ever sees it —
    // rejecting it is the only point at which that is still preventable.
    if (entry.clientSecret !== undefined && !CLIENT_SECRET_PLACEHOLDER.test(entry.clientSecret)) {
      ctx.addIssue({
        code: 'custom',
        message: 'clientSecret must be a ${NAME} placeholder naming a secret stored with request_secret, not a literal secret.',
        path: ['clientSecret'],
      });
    }
  } else {
    if (!entry.url || entry.command !== undefined || entry.args !== undefined || entry.env !== undefined || oauthOnlyFieldsSet) invalid();
    try {
      const url = new URL(entry.url ?? '');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalid();
      url.searchParams.forEach((value, key) => { if (credentialKey.test(key) && !placeholder.test(value)) invalid(); });
    } catch { invalid(); }
  }
  for (const record of [entry.env, entry.headers]) {
    for (const [key, value] of Object.entries(record ?? {})) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || (credentialKey.test(key) && !placeholder.test(value))) invalid();
    }
  }
});

export interface McpRegistrationResult {
  success: boolean;
  status: 'registered' | 'unchanged' | 'conflict' | 'invalid' | 'cancelled' | 'unavailable' | 'failed';
  message: string;
  requiredVariables?: string[];
}

/** One instance per plugin, shared across all per-thread MCP servers. */
export function createMcpRegistration(host: {
  getSettings: () => Pick<PluginSettings, 'mcpServers'>;
  confirm?: (entry: McpServerEntry) => Promise<boolean>;
  save: () => Promise<void>;
}) {
  let queue: Promise<unknown> = Promise.resolve();
  return (input: unknown, interactive = true): Promise<McpRegistrationResult> => {
    const parsed = mcpRegistrationSchema.safeParse(input);
    const result = (status: McpRegistrationResult['status'], message: string): McpRegistrationResult => ({
      success: status === 'registered' || status === 'unchanged', status, message,
    });
    if (!parsed.success) return Promise.resolve(result('invalid', 'Invalid MCP configuration. Check the server name, transport and fields. Credentials must use ${NAME} placeholders; use request_secret to store them.'));
    // OAuth registration needs an async consent flow (discovery, DCR, PKCE, browser
    // round-trip) that this synchronous confirm-then-save transaction can't drive.
    // That flow is separate follow-up work; until it lands, reject here rather than
    // pass an `oauth` entry into toStoredServer(), which only models stdio/http/sse.
    if (parsed.data.type === 'oauth') return Promise.resolve(result('invalid', 'OAuth MCP servers cannot be registered through this flow yet.'));
    const entry = parsed.data as McpServerEntry;
    if (!interactive || !host.confirm) return Promise.resolve(result('unavailable', 'Interactive host confirmation is unavailable. Register this server from an interactive thread.'));
    const config = toStoredServer(entry);
    const variables = new Set<string>();
    collectPlaceholders(config, variables);
    const successResult = (status: 'registered' | 'unchanged', message: string): McpRegistrationResult => ({
      ...result(status, message + (variables.size ? ' Store credential variables with request_secret; missing variables cause the server to be skipped.' : '')),
      requiredVariables: [...variables].sort(),
    });
    // Sorted record keys make semantic retries independent of object insertion order.
    const stable = (value: unknown): string => JSON.stringify(value, (_key, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
    const collision = (): McpRegistrationResult | undefined => {
      const existing = host.getSettings().mcpServers;
      if (!Object.prototype.hasOwnProperty.call(existing ?? {}, entry.name)) return;
      return stable(normalizeStoredServer(existing[entry.name])) === stable(config)
        ? successResult('unchanged', 'An identical global MCP configuration already exists. Newly initialized sessions use it.')
        : result('conflict', 'That MCP server name already exists with a different configuration. No changes were made.');
    };
    const transaction = async (): Promise<McpRegistrationResult> => {
      const prior = collision();
      if (prior) return prior;
      if (!interactive || !host.confirm) return result('unavailable', 'Interactive host confirmation is unavailable. Register this server from an interactive thread.');
      try {
        if (!await host.confirm({ ...entry })) return result('cancelled', 'Registration cancelled. No changes were made.');
      } catch { return result('unavailable', 'Host confirmation could not be shown. No changes were made.'); }
      const after = collision();
      if (after) return after;
      const settings = host.getSettings();
      settings.mcpServers ??= {};
      settings.mcpServers[entry.name] = config;
      try { await host.save(); }
      catch {
        // Preserve settings edits that occurred during the asynchronous save.
        const current = host.getSettings().mcpServers;
        if (current?.[entry.name] === config) delete current[entry.name];
        return result('failed', 'MCP registration could not be saved. Retry after checking settings storage.');
      }
      return successResult('registered', 'Saved globally. Newly initialized sessions can start or connect to this server; the current session is unchanged.');
    };
    const pending = queue.then(transaction);
    queue = pending.catch(() => undefined);
    return pending;
  };
}

/** Server names must be safe to use as a JSON object key / shell-ish identifier. */
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

const PLACEHOLDER_PATTERN = /\$\{([^}]+)\}/g;

/** One entry flattened for the settings UI (name folded in alongside its config). */
export interface McpServerEntry {
  name: string;
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export type SaveResult = { ok: true } | { ok: false; error: string };

function stringRecord(obj: unknown): Record<string, string> | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate one raw value from data.json into a StoredMcpServer, or null if it
 * isn't one. data.json is user-editable, so this never trusts its input.
 */
export function normalizeStoredServer(value: unknown): StoredMcpServer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  const type = c.type;

  if (type === 'http' || type === 'sse') {
    if (typeof c.url !== 'string' || c.url.trim() === '') return null;
    const server: StoredMcpServer = { type, url: c.url };
    const headers = stringRecord(c.headers);
    if (headers) server.headers = headers;
    return server;
  }

  if (type === 'stdio') {
    if (typeof c.command !== 'string' || c.command.trim() === '') return null;
    const server: StoredMcpServer = { type: 'stdio', command: c.command };
    if (Array.isArray(c.args)) {
      const args = c.args.filter((a): a is string => typeof a === 'string');
      if (args.length > 0) server.args = args;
    }
    const env = stringRecord(c.env);
    if (env) server.env = env;
    return server;
  }

  return null;
}

/**
 * Every stored entry, flattened for the UI and sorted by name. Entries that
 * fail validation are reported by name in `invalid` rather than silently
 * dropped, so hand-edited data.json damage is visible instead of vanishing.
 */
export function listMcpServers(
  settings: Pick<PluginSettings, 'mcpServers'>,
): { servers: McpServerEntry[]; invalid: string[] } {
  const stored = settings.mcpServers;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return { servers: [], invalid: [] };
  }

  const servers: McpServerEntry[] = [];
  const invalid: string[] = [];

  for (const [name, raw] of Object.entries(stored)) {
    const normalized = normalizeStoredServer(raw);
    if (!normalized) {
      invalid.push(name);
      continue;
    }
    servers.push({ name, ...normalized });
  }

  servers.sort((a, b) => a.name.localeCompare(b.name));
  invalid.sort((a, b) => a.localeCompare(b));
  return { servers, invalid };
}

/** Strip the UI's flat `name` back off into the stored config shape. */
function toStoredServer(entry: McpServerEntry): StoredMcpServer {
  if (entry.type === 'stdio') {
    const server: StoredMcpServer = { type: 'stdio', command: (entry.command ?? '').trim() };
    if (entry.args && entry.args.length > 0) server.args = entry.args;
    if (entry.env && Object.keys(entry.env).length > 0) server.env = entry.env;
    return server;
  }
  const server: StoredMcpServer = { type: entry.type, url: (entry.url ?? '').trim() };
  if (entry.headers && Object.keys(entry.headers).length > 0) server.headers = entry.headers;
  return server;
}

/**
 * Add or update one entry, mutating `settings.mcpServers` in place. The caller
 * is responsible for persisting (`saveSettings()`). Pass `previousName` when
 * renaming — the old key is removed and the new one inserted.
 */
export function saveMcpServer(
  settings: Pick<PluginSettings, 'mcpServers'>,
  entry: McpServerEntry,
  previousName?: string,
): SaveResult {
  const name = entry.name.trim();
  if (!name) {
    return { ok: false, error: 'Name is required.' };
  }
  if (!NAME_PATTERN.test(name)) {
    return { ok: false, error: 'Name may only contain letters, numbers, hyphens, and underscores.' };
  }
  if (isReservedMcpName(name)) return { ok: false, error: 'That MCP server name is reserved.' };
  if (entry.type !== 'stdio' && entry.type !== 'http' && entry.type !== 'sse') {
    return { ok: false, error: `Unsupported server type: ${String(entry.type)}` };
  }
  if ((entry.type === 'http' || entry.type === 'sse') && !(entry.url ?? '').trim()) {
    return { ok: false, error: 'URL is required.' };
  }
  if (entry.type === 'stdio' && !(entry.command ?? '').trim()) {
    return { ok: false, error: 'Command is required.' };
  }

  if (!settings.mcpServers || typeof settings.mcpServers !== 'object' || Array.isArray(settings.mcpServers)) {
    settings.mcpServers = {};
  }

  const collidesWithDifferentEntry =
    Object.prototype.hasOwnProperty.call(settings.mcpServers, name) && name !== previousName;
  if (collidesWithDifferentEntry) {
    return { ok: false, error: `An MCP server named "${name}" already exists.` };
  }

  if (previousName && previousName !== name) {
    delete settings.mcpServers[previousName];
  }
  settings.mcpServers[name] = toStoredServer({ ...entry, name });
  return { ok: true };
}

/**
 * Remove one entry by name, mutating in place. No-op-safe: removing something
 * that isn't there succeeds without changing anything.
 */
export function deleteMcpServer(
  settings: Pick<PluginSettings, 'mcpServers'>,
  name: string,
): SaveResult {
  if (!settings.mcpServers || typeof settings.mcpServers !== 'object' || Array.isArray(settings.mcpServers)) {
    return { ok: true };
  }
  delete settings.mcpServers[name];
  return { ok: true };
}

/** Collect every `${VAR}` name appearing in any string leaf of `value`. */
function collectPlaceholders(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
      into.add(match[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPlaceholders(item, into);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectPlaceholders(v, into);
  }
}

/**
 * Names of `${VAR}` placeholders in `server` that `env` cannot fill.
 *
 * An empty-string value counts as unresolved on purpose: an `x-api-key` header
 * expanded to `""` is not a working server, it's a silent 401.
 */
export function findUnresolvedPlaceholders(
  server: StoredMcpServer | McpServerEntry,
  env: Record<string, string>,
): string[] {
  const found = new Set<string>();
  collectPlaceholders(server, found);
  return [...found].filter((name) => !env[name]).sort((a, b) => a.localeCompare(b));
}

/** Expand every `${VAR}` in every string leaf. Only called once all resolve. */
function expand(value: unknown, env: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER_PATTERN, (_, varName: string) => env[varName] ?? '');
  }
  if (Array.isArray(value)) return value.map((item) => expand(item, env));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expand(v, env);
    }
    return out;
  }
  return value;
}

export interface ResolvedMcpServers {
  /** Ready to spread into a session's mcpServers option. */
  servers: Record<string, McpServerConfig>;
  /** One human-readable line per server that was refused. */
  warnings: string[];
}

/**
 * Resolve the stored servers for a live session.
 *
 * A server whose `${VAR}` placeholders cannot all be filled is EXCLUDED and
 * reported — never injected with the gaps blanked out. The previous
 * implementation expanded an unknown variable to `''` and injected anyway,
 * which shipped an empty `x-api-key` header on every session for months with
 * no error anywhere: the server appeared to be configured, connected, and then
 * silently failed auth. A missing server the user is told about is strictly
 * better than a present one that cannot work.
 *
 * Never throws — a caller can always spread `.servers`.
 */
export function resolveMcpServers(
  stored: Record<string, StoredMcpServer> | undefined,
  env: Record<string, string>,
): ResolvedMcpServers {
  const servers: Record<string, McpServerConfig> = {};
  const warnings: string[] = [];

  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return { servers, warnings };
  }

  for (const [name, raw] of Object.entries(stored)) {
    const normalized = normalizeStoredServer(raw);
    if (!normalized) {
      warnings.push(`MCP server "${name}" is not a valid entry and was skipped.`);
      continue;
    }

    const missing = findUnresolvedPlaceholders(normalized, env);
    if (missing.length > 0) {
      warnings.push(
        `MCP server "${name}" was not loaded: ${missing.map((m) => `\${${m}}`).join(', ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} unset. ` +
        `Add ${missing.length === 1 ? 'it' : 'them'} under Settings → Secrets.`,
      );
      continue;
    }

    servers[name] = expand(normalized, env) as unknown as McpServerConfig;
  }

  return { servers, warnings };
}

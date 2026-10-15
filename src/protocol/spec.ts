/**
 * spec.ts
 *
 * `RemoteSessionSpec`: the projection of `HarnessSessionOptions` that can cross
 * the wire in `session.open` (design section 3.5). Callbacks, VM routing,
 * secret values and in-process SDK instances are omitted by construction.
 */
import type { HarnessMcpServerConfig, HarnessPermissionMode, HarnessSessionOptions } from '../HarnessSession';
import type { AgentHarness } from '../types';
import { validateHostToolSpecs } from './hostTools';

/** A host tool the daemon proxies back to the attached client (name + schema only, no handler). */
export interface RemoteHostToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiresApproval: boolean;
  /** MCP server name the tool is exposed under (`claude_threads`, `google-docs`, ...). */
  server: string;
}

/** Only transports that work without a local process: http / sse. */
export type RemoteMcpServerConfig = Extract<HarnessMcpServerConfig, { type: 'http' | 'sse' }>;

export interface RemoteSessionSpec {
  harness: AgentHarness;
  cwd: string;
  permissionMode: HarnessPermissionMode;
  model?: string;
  disallowedTools?: string[];
  /** Daemon-side native session id to resume. */
  resume?: string;
  resumeFallbackHistory?: string;
  /** Rebuilt without the Mac vault root by the caller. */
  appendSystemPrompt?: string;
  goal?: string;
  /** Daemon paths only; the vault root is dropped. */
  additionalDirectories?: string[];
  /**
   * `KEY=value` lines. Only names the daemon knows are expanded, and secret
   * VALUES never cross by default (`remoteSecretNames` allowlist, empty).
   */
  extraEnvRaw: string;
  sessionOptions?: {
    thinking?: unknown;
    effort?: string;
    agentProgressSummaries?: boolean;
    betas?: string[];
    persistSession?: boolean;
    agents?: Record<string, unknown>;
  };
  /**
   * Host tools the client offers at open (flat; same entries as `tool.manifest`, which replaces them as the client's
   * tools change). Names and schemas only: the daemon proxies calls back to the client, nothing is executed from here.
   */
  hostTools?: RemoteHostToolSpec[];
  mcpServers?: Record<string, RemoteMcpServerConfig>;
  /** SkillSource ids, never paths: the daemon resolves its own checkouts. */
  skills?: string[];
}

export type SpecDisposition = 'carried' | 'transformed' | 'omitted';

/**
 * Where each `HarnessSessionOptions` field goes. Typed over the keys so a new
 * field forces a decision here (compile error), and the spec test pins the
 * "never crosses the wire" set.
 */
export const SESSION_OPTION_DISPOSITION: Record<keyof HarnessSessionOptions, SpecDisposition> = {
  cwd: 'carried',
  permissionMode: 'carried',
  disallowedTools: 'carried',
  extraEnvRaw: 'transformed',
  resume: 'carried',
  callbacks: 'omitted',
  additionalDirectories: 'transformed',
  model: 'carried',
  appendSystemPrompt: 'transformed',
  resumeFallbackHistory: 'carried',
  secretEnv: 'omitted',
  containerAuthToken: 'omitted',
  claude: 'transformed',
  codex: 'transformed',
  opencode: 'transformed',
};

// ── shape validation (daemon side, before any policy) ─────────────────────

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function stringList(v: unknown, what: string, maxItems: number, maxLen: number): string | null {
  if (v === undefined) return null;
  if (!Array.isArray(v)) return `${what} must be an array of strings`;
  if (v.length > maxItems) return `${what} has too many entries (limit ${maxItems})`;
  for (const item of v) if (typeof item !== 'string' || item.length > maxLen) return `${what} must contain only strings of at most ${maxLen} characters`;
  return null;
}

function optString(obj: Record<string, unknown>, key: string, maxLen: number): string | null {
  const v = obj[key];
  if (v === undefined) return null;
  if (typeof v !== 'string') return `${key} must be a string`;
  return v.length > maxLen ? `${key} is too long (limit ${maxLen} characters)` : null;
}

/**
 * Structural check of a `session.open` spec. Returns a message naming the first problem, or null.
 * This is shape only (types, sizes); what a valid shape is ALLOWED to do (cwd, modes, environment) is
 * the daemon's policy. A malformed element used to reach the driver and throw there.
 */
export function validateSpecShape(spec: unknown): string | null {
  if (!isPlainObject(spec)) return 'spec must be an object';
  if (typeof spec.harness !== 'string' || spec.harness.length === 0 || spec.harness.length > 40) return 'spec.harness must be a short non-empty string';
  if (typeof spec.cwd !== 'string' || spec.cwd.length === 0 || spec.cwd.length > 4096) return 'spec.cwd must be a non-empty string';
  if (typeof spec.permissionMode !== 'string' || spec.permissionMode.length === 0 || spec.permissionMode.length > 40) return 'spec.permissionMode must be a short non-empty string';
  for (const [key, max] of [['model', 200], ['resume', 200], ['goal', 100_000], ['appendSystemPrompt', 1_000_000], ['resumeFallbackHistory', 4_000_000], ['extraEnvRaw', 65_536]] as const) {
    const problem = optString(spec, key, max);
    if (problem) return `spec.${problem}`;
  }
  let problem = stringList(spec.disallowedTools, 'spec.disallowedTools', 500, 200)
    ?? stringList(spec.additionalDirectories, 'spec.additionalDirectories', 100, 4096)
    ?? stringList(spec.skills, 'spec.skills', 200, 200);
  if (problem) return problem;

  const so = spec.sessionOptions;
  if (so !== undefined) {
    if (!isPlainObject(so)) return 'spec.sessionOptions must be an object';
    if (so.effort !== undefined && (typeof so.effort !== 'string' || so.effort.length > 40)) return 'spec.sessionOptions.effort must be a short string';
    if (so.agentProgressSummaries !== undefined && typeof so.agentProgressSummaries !== 'boolean') return 'spec.sessionOptions.agentProgressSummaries must be a boolean';
    if (so.persistSession !== undefined && typeof so.persistSession !== 'boolean') return 'spec.sessionOptions.persistSession must be a boolean';
    problem = stringList(so.betas, 'spec.sessionOptions.betas', 50, 100);
    if (problem) return problem;
    if (so.agents !== undefined) {
      if (!isPlainObject(so.agents)) return 'spec.sessionOptions.agents must be an object';
      for (const [name, def] of Object.entries(so.agents)) if (!isPlainObject(def)) return `spec.sessionOptions.agents.${name} must be an object`;
    }
  }

  problem = validateHostToolSpecs(spec.hostTools, 'spec.hostTools');
  if (problem) return problem;

  if (spec.mcpServers !== undefined) {
    if (!isPlainObject(spec.mcpServers)) return 'spec.mcpServers must be an object';
    const entries = Object.entries(spec.mcpServers);
    if (entries.length > 100) return 'spec.mcpServers has too many entries (limit 100)';
    for (const [name, server] of entries) {
      if (!isPlainObject(server)) return `spec.mcpServers.${name} must be an object`;
      if (server.type !== 'http' && server.type !== 'sse') return `spec.mcpServers.${name}.type must be "http" or "sse"`;
      if (typeof server.url !== 'string' || server.url.length === 0 || server.url.length > 4096) return `spec.mcpServers.${name}.url must be a string`;
      if (server.headers !== undefined) {
        if (!isPlainObject(server.headers)) return `spec.mcpServers.${name}.headers must be an object`;
        for (const v of Object.values(server.headers)) if (typeof v !== 'string') return `spec.mcpServers.${name}.headers must map names to strings`;
      }
    }
  }
  return null;
}

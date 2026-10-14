/**
 * spec.ts
 *
 * `RemoteSessionSpec`: the projection of `HarnessSessionOptions` that can cross
 * the wire in `session.open` (design section 3.5). Callbacks, VM routing,
 * secret values and in-process SDK instances are omitted by construction.
 */
import type { HarnessMcpServerConfig, HarnessPermissionMode, HarnessSessionOptions } from '../HarnessSession';
import type { AgentHarness } from '../types';

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

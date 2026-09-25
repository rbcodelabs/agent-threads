import type { McpServerConfig, Options, SdkBeta } from '@anthropic-ai/claude-agent-sdk';
import type { ImageAttachment, PluginSettings } from './types';
import type { SessionCallbacks } from './ClaudeSession';
import type { AgentProfileMap } from './AgentProfiles';

/**
 * The plugin's own permission vocabulary. Each adapter maps it to native
 * controls (Claude passes it through; Codex maps it to approval policy + sandbox).
 */
export type HarnessPermissionMode = PluginSettings['permissionMode'];

/** A serializable, process-transport MCP server any harness can mirror into its own config. */
export type HarnessMcpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; timeout?: number }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string>; timeout?: number };

/** One row of a context-window breakdown. */
export interface HarnessContextUsageCategory {
  name: string;
  tokens: number;
  color: string;
  /** 'used' occupies the window, 'free' is remaining, 'buffer' is compaction reserve, 'deferred' is out-of-window. */
  kind: 'used' | 'free' | 'buffer' | 'deferred';
}

/** Harness-neutral context-window snapshot rendered by /context. */
export interface HarnessContextUsage {
  categories: HarnessContextUsageCategory[];
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  model: string;
  /** Token count at which the harness auto-compacts, when it reports one. */
  autoCompactThreshold?: number;
}

/** The stable, harness-neutral contract used by ThreadManager. */
export interface HarnessSession {
  readonly turnInFlight: boolean;
  readonly cwd: string | undefined;
  readonly hasPendingPermission: boolean;
  canIdleReap(): boolean;
  start(options: HarnessSessionOptions): Promise<void>;
  /** Optional harness-specific maintenance before a user turn is submitted. */
  prepareForSend?(text: string, images?: ImageAttachment[]): Promise<void>;
  send(text: string, images?: ImageAttachment[], userMessageUuid?: string): void;
  interrupt(): Promise<void>;
  /** Native child-agent controls. Absent unless a harness exposes a directly verified route. */
  sendAgentMessage?(nativeAgentId: string, text: string): Promise<void>;
  interruptAgent?(nativeAgentId: string): Promise<void>;
  close(): void;
  setModel(model: string | undefined): Promise<void>;
  setPermissionMode(mode: HarnessPermissionMode): Promise<void>;
  getContextUsage(): Promise<HarnessContextUsage | null>;
  getUsageSnapshot(includeAccountUsage?: boolean): Promise<import('./Usage').UsageSnapshot | null>;
}

/** Options every harness needs to execute a thread consistently. */
export interface HarnessSessionOptions {
  cwd: string;
  permissionMode: HarnessPermissionMode;
  extraEnvRaw: string;
  resume?: string;
  callbacks: SessionCallbacks;
  additionalDirectories?: string[];
  model?: string;
  appendSystemPrompt?: string;
  /** Canonical transcript replayed on the first turn only if native resume fails. */
  resumeFallbackHistory?: string;
  secretEnv?: Record<string, string>;
  claude?: ClaudeHarnessOptions;
  codex?: CodexHarnessOptions;
  opencode?: OpenCodeHarnessOptions;
}

/** Claude-only capabilities intentionally kept out of the shared contract. */
export interface ClaudeHarnessOptions {
  mcpServers?: Record<string, McpServerConfig>;
  disallowedTools?: string[];
  sessionOptions?: {
    thinking?: Options['thinking'];
    effort?: Options['effort'];
    agentProgressSummaries?: boolean;
    betas?: SdkBeta[];
    persistSession?: boolean;
    plugins?: import('@anthropic-ai/claude-agent-sdk').SdkPluginConfig[];
    agents?: Record<string, import('@anthropic-ai/claude-agent-sdk').AgentDefinition>;
  };
}

/** Codex-specific transport settings; kept separate as its app-server grows. */
export interface CodexHarnessOptions {
  /** Defaults off; true inherits local Codex computer-use configuration. */
  computerUseEnabled?: boolean;
  approvalPolicy: 'untrusted' | 'on-request' | 'never';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Omitted to use the app-server/model default. Ultra enables proactive native agents where supported. */
  effort?: Exclude<import('./types').PluginSettings['codexEffort'], 'default'>;
  /** Standalone skill roots registered for this app-server process. */
  skillRoots?: string[];
  /** Authored skills use local:<name> commands and explicit path-based invocation. */
  localSkillsRoot?: string;
  dynamicTools?: HarnessDynamicTool[];
  /** Serializable external MCP servers to mirror into Codex's thread config. */
  mcpServers?: Record<string, HarnessMcpServerConfig>;
  /** Harness-neutral profiles rendered into Codex delegation instructions. */
  agentProfiles?: AgentProfileMap;
}

/** OpenCode-specific inputs; permission and model use the shared fields. */
export interface OpenCodeHarnessOptions {
  /** Host tools, served to OpenCode through a loopback MCP bridge. */
  dynamicTools?: HarnessDynamicTool[];
  /** Serializable external MCP servers mirrored into OpenCode's `mcp` config. */
  mcpServers?: Record<string, HarnessMcpServerConfig>;
}

/** A host-owned capability exposed through a harness's native tool protocol. */
export interface HarnessDynamicTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Whether this host operation changes state or needs an explicit user decision. */
  requiresApproval: boolean;
  invoke(args: Record<string, unknown>): Promise<{ success: boolean; text: string }>;
}

/** The shared permission-mode behavior for host-owned dynamic tools. */
export function resolveDynamicToolApproval(
  mode: HarnessPermissionMode,
  requiresApproval: boolean,
): 'allow' | 'deny' | 'prompt' {
  if (!requiresApproval) return 'allow';
  switch (mode) {
    case 'plan':
    case 'dontAsk':
      return 'deny';
    case 'bypassPermissions':
    case 'auto':
      return 'allow';
    case 'default':
    case 'acceptEdits':
    default:
      return 'prompt';
  }
}

/**
 * Translate the plugin's shared permission vocabulary to Codex app-server
 * controls. Plan mode is enforced by a read-only sandbox; Claude retains its
 * richer native plan-mode protocol in its own adapter.
 */
export function resolveCodexPermissions(mode: HarnessPermissionMode): CodexHarnessOptions {
  switch (mode) {
    case 'default':
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
    case 'plan':
      return { approvalPolicy: 'on-request', sandbox: 'read-only' };
    case 'bypassPermissions':
    case 'dontAsk':
      return { approvalPolicy: 'never', sandbox: 'workspace-write' };
    case 'acceptEdits':
    case 'auto':
    default:
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  }
}

/**
 * Keep only MCP servers that can be serialized into another process's config.
 * In-process SDK servers (live instances) are dropped; known transport fields
 * are copied so harness-specific extras never leak across the boundary.
 */
export function serializableMcpServers(
  servers: Record<string, { type?: string }> | undefined,
): Record<string, HarnessMcpServerConfig> {
  const result: Record<string, HarnessMcpServerConfig> = {};
  for (const [name, raw] of Object.entries(servers ?? {})) {
    const server = raw as Record<string, unknown> | undefined;
    if (!server) continue;
    const timeout = typeof server.timeout === 'number' ? { timeout: server.timeout } : {};
    if ((server.type === 'http' || server.type === 'sse') && typeof server.url === 'string') {
      result[name] = {
        type: server.type,
        url: server.url,
        ...(server.headers ? { headers: server.headers as Record<string, string> } : {}),
        ...timeout,
      };
    } else if ((server.type === undefined || server.type === 'stdio') && typeof server.command === 'string') {
      result[name] = {
        ...(server.type ? { type: 'stdio' as const } : {}),
        command: server.command,
        ...(Array.isArray(server.args) ? { args: server.args as string[] } : {}),
        ...(server.env ? { env: server.env as Record<string, string> } : {}),
        ...timeout,
      };
    }
  }
  return result;
}

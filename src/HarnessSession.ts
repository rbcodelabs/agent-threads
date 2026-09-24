import type { McpServerConfig, Options, SdkBeta } from '@anthropic-ai/claude-agent-sdk';
import type { ImageAttachment } from './types';
import type { SessionCallbacks } from './ClaudeSession';
import type { AgentProfileMap } from './AgentProfiles';

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
  setPermissionMode(mode: string): Promise<void>;
  getContextUsage(): Promise<import('@anthropic-ai/claude-agent-sdk').SDKControlGetContextUsageResponse | null>;
  getUsageSnapshot(includeAccountUsage?: boolean): Promise<import('./Usage').UsageSnapshot | null>;
}

/** Options every harness needs to execute a thread consistently. */
export interface HarnessSessionOptions {
  cwd: string;
  permissionMode: Options['permissionMode'];
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
  mcpServers?: Record<string, McpServerConfig>;
  /** Harness-neutral profiles rendered into Codex delegation instructions. */
  agentProfiles?: AgentProfileMap;
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
  mode: Options['permissionMode'],
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
export function resolveCodexPermissions(mode: Options['permissionMode']): CodexHarnessOptions {
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

/**
 * Approval policy for peer-contributed agent tools (`extensions.registerAgentTool`).
 *
 * A contribution declares `requiresApproval`, defaulting to true. Two enforcement points consume that flag and
 * must agree, so both go through this module:
 *  - the Codex/OpenCode harness path (`toHarnessDynamicTools` in ObsidianTools.ts), and
 *  - the Claude path's permission pre-approval (`isPermissionPreApprovedForThread` in remoteAlwaysAllow.ts).
 *
 * Pure and dependency-free so it can be loaded on mobile and in the daemon core.
 */

/** The MCP servers the host builds contributed tools onto; the Claude CLI names a tool `mcp__<server>__<tool>`. */
const CONTRIBUTED_TOOL_MCP_PREFIXES: readonly string[] = ['mcp__claude_threads__', 'mcp__obsidian__'];

/** The slice of a contribution this policy needs (satisfied by both a bound tool and a registry entry). */
export interface ApprovalDeclaration {
  readonly name: string;
  readonly requiresApproval: boolean;
}

/**
 * Names of contributions that explicitly opted out of approval. A name that is also a built-in is never included:
 * a contribution cannot shadow a built-in's decision (the registry rejects such names first; this is the backstop).
 */
export function noApprovalContributionNames(
  contributions: Iterable<ApprovalDeclaration>,
  builtInNames: { has(name: string): boolean },
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const contribution of contributions) {
    if (contribution.requiresApproval === false && !builtInNames.has(contribution.name)) names.add(contribution.name);
  }
  return names;
}

/**
 * The contributed tool name behind a Claude-path permission request, or null when the request is not for a tool on
 * the host's own MCP servers. Only the exact `mcp__claude_threads__` / `mcp__obsidian__` prefixes qualify: a
 * look-alike server (`mcp__other__notify_portfolio`) or a bare name never maps to a contribution.
 */
export function contributedToolNameFromPermissionRequest(toolName: string): string | null {
  for (const prefix of CONTRIBUTED_TOOL_MCP_PREFIXES) {
    if (toolName.startsWith(prefix) && toolName.length > prefix.length) return toolName.slice(prefix.length);
  }
  return null;
}

/** True when a Claude-path permission request is for a contributed tool that declared `requiresApproval: false`. */
export function isNoApprovalContributedToolRequest(toolName: string, noApprovalNames: ReadonlySet<string>): boolean {
  const name = contributedToolNameFromPermissionRequest(toolName);
  return name !== null && noApprovalNames.has(name);
}

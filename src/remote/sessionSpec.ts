/**
 * Projection of `HarnessSessionOptions` onto the `RemoteSessionSpec` that
 * crosses the wire in `session.open` (design 3.5).
 *
 * Deliberately conservative for stage 1 ("daemon-local tools only"): anything
 * that names a local path, carries a local secret, or is a live object is left
 * behind. The rest of `SESSION_OPTION_DISPOSITION` is the typed checklist:
 *
 *   carried      cwd, permissionMode, disallowedTools, model, resume, resumeFallbackHistory
 *   transformed  extraEnvRaw (dropped: may hold keychain-derived values and Mac paths),
 *                additionalDirectories (dropped: the vault root is a Mac path),
 *                appendSystemPrompt (caller rebuilds it without the Mac vault root),
 *                claude.sessionOptions (plain JSON subset)
 *   omitted      callbacks, secretEnv, containerAuthToken, claude.mcpServers / vmMcpServers /
 *                vm, codex, opencode
 *
 * Host tools, proxied MCP servers, skills and the secret allowlist arrive in
 * PR 7 and PR 9; until then a remote thread has the daemon's native tools only.
 */
import type { HarnessSessionOptions } from '../HarnessSession';
import type { RemoteSessionSpec } from '../protocol';
import type { Thread } from '../types';

export function projectSessionOptions(options: HarnessSessionOptions, thread: Thread): RemoteSessionSpec {
  const remote = thread.remote;
  if (!remote) throw new Error('projectSessionOptions: thread is not a remote thread');

  const so = options.claude?.sessionOptions;
  const sessionOptions: NonNullable<RemoteSessionSpec['sessionOptions']> = {};
  if (so) {
    if (so.thinking !== undefined) sessionOptions.thinking = so.thinking;
    if (so.effort !== undefined) sessionOptions.effort = so.effort;
    if (so.agentProgressSummaries !== undefined) sessionOptions.agentProgressSummaries = so.agentProgressSummaries;
    if (so.betas?.length) sessionOptions.betas = [...so.betas];
    if (so.persistSession !== undefined) sessionOptions.persistSession = so.persistSession;
    if (so.agents && Object.keys(so.agents).length > 0) sessionOptions.agents = so.agents as Record<string, unknown>;
  }

  // Both lists are deny rules, so sending the union can only make the remote session stricter.
  const disallowed = [...new Set([...(options.claude?.disallowedTools ?? []), ...(options.disallowedTools ?? [])])];

  return {
    // Only the Claude harness runs on the daemon today (the fake harness ignores it).
    harness: 'claude',
    cwd: remote.remoteCwd,
    permissionMode: options.permissionMode,
    ...(options.model ? { model: options.model } : {}),
    ...(disallowed.length > 0 ? { disallowedTools: disallowed } : {}),
    ...(options.resume ? { resume: options.resume } : {}),
    ...(options.resumeFallbackHistory ? { resumeFallbackHistory: options.resumeFallbackHistory } : {}),
    ...(options.appendSystemPrompt ? { appendSystemPrompt: options.appendSystemPrompt } : {}),
    ...(thread.goal ? { goal: thread.goal } : {}),
    extraEnvRaw: '',
    ...(Object.keys(sessionOptions).length > 0 ? { sessionOptions } : {}),
  };
}

/**
 * The environment note a remote Claude gets instead of `buildEnvironmentSystemPrompt`
 * (which leads with the Mac's vault root and the vault_* / editor tools that a
 * remote thread does not have yet).
 */
export function buildRemoteEnvironmentPrompt(
  cwd: string,
  daemonName: string,
  hostName: 'Geode' | 'Obsidian' = 'Obsidian',
): string {
  return [
    `You are running on the remote machine "${daemonName}", driven from the ${hostName} Agent Threads plugin on the user's computer.`,
    '',
    `Working directory: ${cwd}`,
    '',
    'Notes:',
    '- You only have this machine\'s own tools (shell, file read/write, search). The user\'s vault and editor tools (vault_*, host_*, workspace_*) are not available in this session.',
    '- All paths are paths on this remote machine.',
  ].join('\n');
}

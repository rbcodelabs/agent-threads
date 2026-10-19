/**
 * Projection of `HarnessSessionOptions` onto the `RemoteSessionSpec` that
 * crosses the wire in `session.open` (design 3.5).
 *
 * The wire harness is the thread's (`claude`, `codex` or `opencode`); the per-harness option blocks are projected as
 * the daemon's `specToSessionOptions` reads them back: Claude's `sessionOptions` in full, Codex's `effort` only,
 * vetted http/sse MCP servers for all three. Everything the daemon derives itself (Codex approval policy and sandbox
 * from `permissionMode`, OpenCode permissions) is NOT sent.
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
 * Host tools (`hostTools`) are added by the session once it has built the manifest; the http/sse external MCP servers
 * that survive `mcpPartition.ts` ride in `mcpServers`. Skills and the secret allowlist arrive in PR 9.
 */
import type { HarnessSessionOptions } from '../HarnessSession';
import type { RemoteMcpServerConfig, RemoteSessionSpec } from '../protocol';
import { describeHostToolsForPrompt, type HostToolsSummary } from './hostTools';
import type { AgentHarness, RemoteVaultMapping, Thread } from '../types';
import { isUnderRemoteRoot, normalizePosixPath, relativeWithin } from './vaultMapping';

export function projectSessionOptions(options: HarnessSessionOptions, thread: Thread): RemoteSessionSpec {
  const remote = thread.remote;
  if (!remote) throw new Error('projectSessionOptions: thread is not a remote thread');

  const harness: AgentHarness = thread.agentHarness ?? 'claude';
  // Claude carries the full session options; Codex only its reasoning effort (what the daemon's `specToSessionOptions`
  // reads for it); OpenCode has none. Claude-only options (thinking, betas, agents) never ride a non-Claude spec.
  const so = harness === 'claude'
    ? options.claude?.sessionOptions
    : harness === 'codex' && options.codex?.effort ? { effort: options.codex.effort as never } : undefined;
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
  const disallowed = [...new Set([...(harness === 'claude' ? options.claude?.disallowedTools ?? [] : []), ...(options.disallowedTools ?? [])])];

  // Only servers the caller vetted for another machine (mcpPartition.ts) cross; `claude.mcpServers` never does.
  const mcpServers: Record<string, RemoteMcpServerConfig> = {};
  const vetted: Record<string, { type?: string; url?: string; headers?: Record<string, string> }> = harness === 'claude'
    ? options.claude?.remoteMcpServers ?? {}
    : (harness === 'codex' ? options.codex?.mcpServers : options.opencode?.mcpServers) ?? {};
  for (const [name, s] of Object.entries(vetted)) {
    if ((s.type === 'http' || s.type === 'sse') && typeof s.url === 'string') {
      mcpServers[name] = { type: s.type, url: s.url, ...(s.headers ? { headers: s.headers } : {}) };
    }
  }

  return {
    // The thread's own harness; the daemon starts that CLI (the fake harness ignores it).
    harness,
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
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
  };
}

/** What the vault addendum needs to know; absent for threads outside the mirrored vault. */
export interface RemoteVaultContext {
  mapping: RemoteVaultMapping;
  /** Vault-relative folder where completed threads are saved as notes (`settings.vaultFolder`). */
  vaultFolder?: string;
  saveThreadsToVault?: boolean;
}

/**
 * The environment note a remote Claude gets instead of `buildEnvironmentSystemPrompt`
 * (which leads with the Mac's vault root and the vault_* / editor tools that a
 * remote thread does not have yet).
 *
 * When `vault` is given AND the remote cwd is inside its `remoteRoot`, the note
 * also explains that the folder is a synced mirror of the vault and carries the
 * rules vault sessions follow locally.
 */
export function buildRemoteEnvironmentPrompt(
  cwd: string,
  daemonName: string,
  hostName: 'Geode' | 'Obsidian' = 'Obsidian',
  vault?: RemoteVaultContext,
  /** `hostTools: true` leaves a placeholder for the tools paragraph; the session fills it once it knows what is offered. */
  options: { hostTools?: boolean } = {},
): string {
  const lines = [
    `You are running on the remote machine "${daemonName}", driven from the ${hostName} Agent Threads plugin on the user's computer.`,
    '',
    `Working directory: ${cwd}`,
    '',
    'Notes:',
    ...(options.hostTools
      ? [HOST_TOOLS_PLACEHOLDER]
      : ['- You only have this machine\'s own tools (shell, file read/write, search). The user\'s vault and editor tools (vault_*, host_*, workspace_*) are not available in this session.']),
    '- All paths are paths on this remote machine.',
  ];
  const addendum = vault && isUnderRemoteRoot(vault.mapping, cwd) ? buildRemoteVaultAddendum(cwd, vault) : [];
  return [...lines, ...addendum].join('\n');
}

/** Where the host-tools paragraph goes in the remote environment prompt; replaced by `applyHostToolsPrompt`. */
export const HOST_TOOLS_PLACEHOLDER = '{{HOST_TOOLS}}';

/**
 * Fill in (or fall back from) the host-tools paragraph once the manifest is known. `summary` null means this
 * thread has no host tools, which is also what an older plugin build said unconditionally.
 */
export function applyHostToolsPrompt(prompt: string, summary: HostToolsSummary | null, hostName: string, harness: AgentHarness = 'claude'): string {
  if (!prompt.includes(HOST_TOOLS_PLACEHOLDER)) return prompt;
  return prompt.replace(HOST_TOOLS_PLACEHOLDER, describeHostToolsForPrompt(summary, hostName, harness).join('\n'));
}

/** Lines appended to the remote environment prompt for a session working in the mirrored vault. */
export function buildRemoteVaultAddendum(cwd: string, vault: RemoteVaultContext): string[] {
  const root = normalizePosixPath(vault.mapping.remoteRoot) ?? vault.mapping.remoteRoot;
  const inside = relativeWithin(root, cwd);
  const lines = [
    '',
    'Vault (synced mirror):',
    `- The user's Obsidian vault is mirrored on this machine at ${root}${inside ? ` (your working directory is "${inside}" inside it)` : ''}. Vault-relative paths such as "Daily/2026-05-18.md" are relative to that folder; use absolute paths with file tools.`,
    '- This is a COPY kept in sync with the user\'s computer in both directions. Changes propagate with a delay of up to about 5 minutes, and a file the user edits on their computer at the same time as you may end up conflicting. Re-read a file right before you edit it, prefer small targeted edits or new files over rewriting existing notes, and do not assume the user sees your change immediately.',
    '- Never delete or rename vault files unless the user explicitly asks you to.',
    `- When you create a new file in the vault, add a wikilink to it in today's Daily note (${root}/Daily/YYYY-MM-DD.md) under the "## Claude Sessions" heading (append only; create the note or heading if missing).`,
  ];
  if (vault.saveThreadsToVault && vault.vaultFolder) {
    lines.push(`- Conversation history: completed threads are auto-saved as Markdown notes to "${vault.vaultFolder}/YYYY-MM-DD-<title-slug>.md" in the vault (here: ${root}/${vault.vaultFolder}/). Search that folder to look up prior conversations.`);
  }
  return lines;
}

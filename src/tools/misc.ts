/**
 * GitHub discovery, `mcp_register_server`, `host_exec` and `request_secret`.
 * Moved verbatim out of ObsidianTools.ts (one factory over a narrow port); see toolRouting.ts for where each runs.
 */

import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk/browser';
import { mcpRegistrationSchema, type McpRegistrationResult } from '../mcpServerStore';
import { secretStorageKey } from '../secretUtils';
import { GithubConnectionError, isValidRepoFullName, summarizeAccess } from '../githubCredentials';
import { createHostExecHandler } from '../hostExec';
import type { ObsidianMcpServerOptions } from '../ObsidianTools';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { App } from 'obsidian';
import type { CwdTracker } from './cwdTracker';

type ToolDef = SdkMcpToolDefinition<any>;

export interface MiscToolsPort {
  app: Pick<App, 'secretStorage'>;
  cwd: CwdTracker;
  options: Pick<ObsidianMcpServerOptions, 'githubBroker' | 'hostExec' | 'isGithubConnectionEnabled' | 'onRegisterMcpServer' | 'onRequestSecret'>;
}


export function createMiscTools(port: MiscToolsPort): Record<string, ToolDef> {
  const { app, cwd, options } = port;
  // ── GitHub (Geode connection) ──────────────────────────────────────────────
  // Discovery only: repo names, never tokens. Credentials reach git/gh through a
  // helper (see githubCredentialHelper.ts), not through these tools.
  const githubErrorResult = (err: unknown) => {
    const e = err instanceof GithubConnectionError ? err : null;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({
        success: false,
        error: e ? e.message : (err instanceof Error ? err.message : String(err)),
        ...(e ? { code: e.code } : {}),
        ...(e?.installUrl ? { installUrl: e.installUrl } : {}),
      }) }],
      isError: true,
    };
  };

  const boundGithubListAccess = tool(
    'github_list_access',
    [
      'Lists the GitHub repositories the connected Geode GitHub App can access (grouped by account/installation).',
      'Repository names only; no credentials are returned. Once a repo is listed, git over HTTPS and the gh CLI work against it',
      'with no personal access token.',
      'Fails with an actionable message if GitHub is not connected, authorization expired, or Geode is not the host.',
    ].join(' '),
    {},
    async () => {
      try {
        if (!options.githubBroker) throw new GithubConnectionError('unavailable', 'The Geode GitHub connection needs Geode >= 0.25.0.');
        if (options.isGithubConnectionEnabled?.() === false) throw new GithubConnectionError('unavailable', 'The Geode GitHub connection is turned off in Agent Threads settings.');
        const installations = summarizeAccess(await options.githubBroker.listAccess());
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, installations }, null, 2) }] };
      } catch (err) {
        return githubErrorResult(err);
      }
    },
  );

  const boundGithubCheckRepo = tool(
    'github_check_repo',
    [
      'Checks whether the connected Geode GitHub App can access owner/repo.',
      'If not, returns the install URL where the user can grant access (the App must be installed on the repository before clone/push/PR will work).',
    ].join(' '),
    { repo: z.string().describe('Repository in owner/name form, e.g. "octocat/hello-world".') },
    async (args) => {
      try {
        if (!isValidRepoFullName(args.repo)) throw new Error('repo must look like owner/name.');
        if (!options.githubBroker) throw new GithubConnectionError('unavailable', 'The Geode GitHub connection needs Geode >= 0.25.0.');
        if (options.isGithubConnectionEnabled?.() === false) throw new GithubConnectionError('unavailable', 'The Geode GitHub connection is turned off in Agent Threads settings.');
        await options.githubBroker.requireRepo(args.repo);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, repo: args.repo, accessible: true }, null, 2) }] };
      } catch (err) {
        return githubErrorResult(err);
      }
    },
  );

  // ── Secret request tool ──────────────────────────────────────────────────
  // Lets agents ask the user for a credential at runtime without that credential
  // ever appearing in the conversation. The value is stored in the OS keychain
  // and injected into future sessions via secretEnvResolver — and, when the
  // caller restarts the calling thread's session on success (see
  // requestSecretForThread in main.ts), into this same thread's next turn too.

  const boundRegisterMcpServer = tool(
    'mcp_register_server',
    'Register a global external MCP server (stdio, HTTP, SSE, or OAuth). Choose the transport before anything else: if the server requires its own sign-in — Vercel, Figma, Linear, Notion and most hosted vendor MCP servers do — use type "oauth" and the plugin brokers OAuth 2.1 + PKCE for you, opening a consent screen in the Web Viewer. Registering such a server as "http" appears to succeed but produces a server that cannot authenticate. Reserve "http"/"sse" for endpoints needing no sign-in or a static ${NAME} header, and "stdio" for a local command. Requires a separate host confirmation even when tool approvals are bypassed. Creates only: identical retries are unchanged, conflicting names are rejected. Saved settings apply to newly initialized sessions, not the calling session. Use ${NAME} placeholders for every credential and request_secret to store values; all other literals must be nonsecret. No stdio/http/sse server is launched or contacted during registration; an oauth registration does contact the server to discover its authorization metadata. Scheduled threads cannot prompt for confirmation.',
    mcpRegistrationSchema.shape,
    async (args) => {
      // The direct Codex adapter bypasses SDK schema parsing.
      const parsed = mcpRegistrationSchema.safeParse(args);
      let result: McpRegistrationResult;
      if (!parsed.success) result = { success: false, status: 'invalid', message: 'Invalid MCP configuration. Use credential placeholders and request_secret; check name, transport and fields.' };
      else if (!options.onRegisterMcpServer) result = { success: false, status: 'unavailable', message: 'Host MCP registration is unavailable in this context.' };
      else {
        try { result = await options.onRegisterMcpServer(parsed.data); }
        catch { result = { success: false, status: 'failed', message: 'MCP registration failed. No credential or configuration details are returned.' }; }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], ...(!result.success ? { isError: true } : {}) };
    },
    { alwaysLoad: true },
  );

  const boundHostExec = options.hostExec ? tool(
    'host_exec',
    [
      'Runs ONE shell command on the real host machine (the user\'s Mac, outside the local daemon container this session runs in), only after the user explicitly approves it.',
      'Every call shows the user the exact command, working directory and your reason, and they choose Allow once or Deny; this prompt cannot be skipped by any permission mode.',
      'Use only when the task truly needs the host (host-only tools, files outside the mounted workspaces); prefer commands in your own container for everything else.',
      'The working directory defaults to the user\'s vault folder on the Mac; a path under the vault mount in this container is mapped to the same folder on the Mac.',
      'Scheduled or non-interactive threads cannot prompt, so the call is denied.',
      'Runs via /bin/sh -c with a minimal environment (no credentials or API tokens). Returns exit code, stdout and stderr; a non-zero exit is a normal result. Long output is truncated with an explicit marker.',
    ].join(' '),
    {
      command: z.string().min(1).describe('Shell command to run on the host via /bin/sh -c.'),
      cwd: z.string().optional().describe('Absolute host directory to run in. Defaults to the thread\'s working directory on the host. Must already exist.'),
      reason: z.string().min(1).describe('Why this must run on the host. Shown to the user in the approval prompt.'),
      timeoutSeconds: z.number().optional().describe('Deadline in seconds (SIGTERM, then SIGKILL after a short grace). Defaults to 300, capped at 3600.'),
    },
    async (args) => {
      const result = await createHostExecHandler(options.hostExec!, () => cwd.get() || undefined)(args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        ...(!result.success ? { isError: true } : {}),
      };
    },
  ) : undefined;

  const boundRequestSecret = tool(
    'request_secret',
    [
      'Ask the user to provide a secret (API key, token, password) and store it securely in the OS keychain.',
      'Use this when a skill or workflow needs a credential that hasn\'t been configured yet.',
      'The secret is stored under the name you provide and injected into future sessions as an environment variable; a successful save also makes it available to this same thread starting its next turn.',
      'Returns {success: true, secretName, alreadyExisted: boolean} on success, or {success: false, reason} if the user cancelled.',
      'IMPORTANT: never ask the user to paste a secret directly into the conversation — always use this tool.',
      'Use force: true to re-prompt the user even when a secret with this name already exists — useful when a token has been rotated or a stale keychain entry needs replacing.',
    ].join(' '),
    {
      secretName: z.string().describe(
        'The environment variable name for this secret (e.g. LINEAR_API_KEY, JIRA_API_TOKEN). Will be uppercased and sanitized to A-Z0-9_.',
      ),
      reason: z.string().describe(
        'A short, plain-language explanation of why this secret is needed (e.g. "to list your Linear issues"). Shown to the user in the prompt.',
      ),
      force: z.boolean().optional().describe(
        'If true, always prompt the user even if a secret with this name already exists. Use when replacing a stale or invalid token.',
      ),
    },
    async (args, _extra) => {
      const varName = args.secretName.toUpperCase().replace(/[^A-Z0-9_]/g, '_');

      // If the secret is already stored and force is not set, return immediately without prompting.
      if (!args.force) {
        const existing = app.secretStorage.getSecret(secretStorageKey(varName));
        if (existing) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: true, secretName: varName, alreadyExisted: true }),
            }],
          };
        }
      }

      if (!options.onRequestSecret) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, reason: 'Secret request UI is not available in this context.' }),
          }],
          isError: true,
        };
      }

      const saved = await options.onRequestSecret(varName, args.reason, !!args.force);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: saved, secretName: varName, alreadyExisted: false }),
        }],
        ...(saved ? {} : { isError: true }),
      };
    },
    { alwaysLoad: true },
  );

  const toolDefs: Array<ToolDef | undefined> = [
    boundGithubListAccess as ToolDef | undefined,
    boundGithubCheckRepo as ToolDef | undefined,
    boundRegisterMcpServer as ToolDef | undefined,
    boundHostExec as ToolDef | undefined,
    boundRequestSecret as ToolDef | undefined,
  ];
  const toolNames = [
    'github_list_access',
    'github_check_repo',
    'mcp_register_server',
    'host_exec',
    'request_secret',
  ];
  return Object.fromEntries(toolNames.flatMap((name, i): Array<[string, ToolDef]> => (toolDefs[i] ? [[name, toolDefs[i]!]] : [])));
}

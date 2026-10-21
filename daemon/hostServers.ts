/**
 * The MCP servers one daemon session gets for tools that are not the harness's own:
 *
 *   claude_threads   LOCAL worktree tools (`enter_worktree`, `exit_worktree`, `set_working_directory`) running
 *                    here beside the repo, plus a proxy tool for each `claude_threads` entry the client offered
 *   <other>          proxy-only servers for the other manifest servers (`google-docs`, OAuth MCPs)
 *
 * Servers are fixed when the session starts (a name that first appears in a later manifest needs a new session),
 * but each server's TOOL list follows the live manifest.
 */
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { RemoteHostToolSpec } from '../src/protocol';
import { createCwdTracker } from '../src/tools/cwdTracker';
import { createWorktreeTools } from '../src/tools/worktree';
import { createHostMcpServer, type HostMcpServerHandle } from './hostMcpServer';
import type { DriverContext } from './sessionDriver';

export const CLAUDE_THREADS_SERVER = 'claude_threads';

export interface HostServers {
  servers: Record<string, McpSdkServerConfigWithInstance>;
  /** Stop listening for manifest/attach changes. */
  dispose(): void;
}

/** The daemon-local worktree tools for one session (none in a read-only workspace). `onCwdChanged` is how a move reaches the host. */
export function buildLocalToolDefs(ctx: DriverContext): Array<SdkMcpToolDefinition<any>> {
  const local = ctx.localTools;
  const cwd = createCwdTracker(ctx.spec.cwd);
  return local?.enabled === false ? [] : Object.values(createWorktreeTools({
    cwd,
    options: {
      getWorktreeRoot: () => local?.worktreeRoot,
      // On a daemon the agent does not get to choose where worktrees go, and a relative repoPath means "a clone under the repo root".
      lockWorktreeRoot: true,
      ...(local?.repoRoot ? { workspaceRoot: local.repoRoot } : {}),
      validateCwd: local ? (p) => local.checkCwd(p) : undefined,
      onSetCwd: (p, origin) => ctx.onCwdChanged?.(p, origin),
    },
  }));
}

export function buildHostServers(ctx: DriverContext): HostServers {
  const port = ctx.hostTools;
  const localDefs = buildLocalToolDefs(ctx);

  const manifest = (): Record<string, RemoteHostToolSpec[]> => port?.manifest() ?? {};
  const names = new Set<string>(Object.keys(manifest()));
  if (localDefs.length > 0) names.add(CLAUDE_THREADS_SERVER);

  const handles = new Map<string, HostMcpServerHandle>();
  for (const name of names) {
    handles.set(name, createHostMcpServer({
      name,
      local: name === CLAUDE_THREADS_SERVER ? localDefs : undefined,
      proxied: () => manifest()[name] ?? [],
      call: (tool, input, signal) => port
        ? port.call(name, tool, input, signal)
        : Promise.resolve({ success: false, text: 'Host tools are not available in this session.' }),
    }));
  }
  const off = port?.onChange(() => { for (const h of handles.values()) h.notifyChanged(); });
  return {
    servers: Object.fromEntries([...handles].map(([name, h]) => [name, h.config])),
    dispose: () => { off?.(); },
  };
}

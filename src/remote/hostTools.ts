/**
 * The tools a remote thread may use that run HERE (in the plugin), and how they are described and run.
 *
 * `RemoteHostTools` builds the manifest the plugin offers a daemon for one thread and executes a call the
 * daemon later makes against it:
 *
 *   - the thread's built-in `claude_threads` tools (the very handlers a local thread has), filtered by the
 *     routing table (`toolRouting.ts`): only `host` tools are offered, and by default there are none (the user
 *     opts a read-only group in per daemon); worktree tools run on the daemon, the rest is not offered at all;
 *   - the tools of the plugin-owned loopback brokers (Google Workspace, OAuth MCP), listed over MCP and
 *     proxied under their own server names, so `mcp__google-docs__*` stays the same name remotely.
 *
 * Secrets never cross: only tool names, schemas and tool RESULTS go to the daemon. The loopback URL and its
 * capability header stay in the `HostMcpSource`.
 */
import type { HarnessDynamicTool } from '../HarnessSession';
import { HOST_TOOL_LIMITS, validateHostToolSpec, type RemoteHostToolSpec } from '../protocol';
import { routeFor, type RouteOverrides } from '../toolRouting';
import type { HostMcpSource } from './hostMcpClient';

export const CLAUDE_THREADS_SERVER = 'claude_threads';
/** Local-path upload/download: its paths are on this computer, so it is not offered to a remote thread (design 2). */
export const NEVER_PROXIED_SERVERS: ReadonlySet<string> = new Set(['google-drive-files']);

export type HostManifest = Record<string, RemoteHostToolSpec[]>;

export interface HostToolOutput {
  success: boolean;
  text: string;
  /** Image blocks (MCP shape) to hand the model alongside the text. */
  content?: Array<Record<string, unknown>>;
}

export interface RemoteHostToolsDeps {
  /** `harnessTools` of the thread's canonical `claude_threads` server (name, schema, approval flag, handler). */
  builtIn?: readonly HarnessDynamicTool[];
  /** Loopback brokers by MCP server name (`google-docs`, an OAuth server). */
  mcpSources?: Readonly<Record<string, HostMcpSource>>;
  /** The user's per-daemon choices (domain or tool -> host | absent). */
  overrides?: RouteOverrides;
  /** Tools of `NEVER_OFFERED` the user switched on for this (managed local) daemon; see localDaemon/optionalTools.ts. */
  optionalTools?: ReadonlySet<string>;
  /**
   * The user's standing approval for a built-in `claude_threads` tool call (a saved host_exec command prefix), or
   * false. Never consulted for proxied servers. The executor asks it only for a tool in the manifest that needs approval.
   */
  preApprove?: (tool: string, input: Record<string, unknown>) => boolean;
  log?: (message: string) => void;
}

/** What the plugin tells the user and the model is available, for notices and the environment prompt. */
export interface HostToolsSummary {
  /** Canonical tool names offered from `claude_threads`. */
  builtIn: string[];
  /** Proxied server name -> tool names. */
  servers: Record<string, string[]>;
  /** Servers that were configured but could not be offered, with the reason. */
  skipped: Array<{ server: string; reason: string }>;
}

function flatten(content: ReadonlyArray<Record<string, unknown>>): { text: string; images: Array<Record<string, unknown>> } {
  const texts: string[] = [];
  const images: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (block.type === 'text') texts.push(typeof block.text === 'string' ? block.text : '');
    else if (block.type === 'image') images.push(block);
    else texts.push(JSON.stringify(block));
  }
  return { text: texts.join('\n'), images };
}

export class RemoteHostTools {
  private index = new Map<string, { run(input: Record<string, unknown>, signal?: AbortSignal): Promise<HostToolOutput> }>();
  private lastSummary: HostToolsSummary = { builtIn: [], servers: {}, skipped: [] };

  constructor(private readonly deps: RemoteHostToolsDeps) {}

  get summary(): HostToolsSummary { return this.lastSummary; }

  /** See {@link RemoteHostToolsDeps.preApprove}. Only a built-in tool of the thread's own `claude_threads` server qualifies. */
  isPreApproved(server: string, tool: string, input: Record<string, unknown>): boolean {
    if (server !== CLAUDE_THREADS_SERVER || !this.deps.preApprove) return false;
    if (!(this.deps.builtIn ?? []).some((t) => t.name === tool)) return false;
    return this.deps.preApprove(tool, input) === true;
  }

  /** Build the manifest now (proxied servers are listed over the network, so this is async). */
  async manifest(): Promise<HostManifest> {
    const servers: HostManifest = {};
    const index = new Map<string, { run(input: Record<string, unknown>, signal?: AbortSignal): Promise<HostToolOutput> }>();
    const summary: HostToolsSummary = { builtIn: [], servers: {}, skipped: [] };
    const key = (server: string, tool: string): string => `${server}\u0000${tool}`;

    for (const t of this.deps.builtIn ?? []) {
      if (routeFor(t.name, this.deps.overrides, this.deps.optionalTools) !== 'host') continue;
      const spec: RemoteHostToolSpec = {
        name: t.name, description: t.description, inputSchema: t.inputSchema,
        requiresApproval: t.requiresApproval, server: CLAUDE_THREADS_SERVER,
      };
      const problem = validateHostToolSpec(spec);
      if (problem) { this.deps.log?.(`host tool ${t.name} not offered: ${problem}`); continue; }
      (servers[CLAUDE_THREADS_SERVER] ??= []).push(spec);
      summary.builtIn.push(t.name);
      index.set(key(CLAUDE_THREADS_SERVER, t.name), {
        run: async (input) => {
          if (t.invokeContent) {
            const r = await t.invokeContent(input);
            const { text, images } = flatten(r.content);
            return { success: r.success, text, ...(images.length ? { content: images } : {}) };
          }
          return t.invoke(input);
        },
      });
    }

    for (const [server, source] of Object.entries(this.deps.mcpSources ?? {})) {
      if (NEVER_PROXIED_SERVERS.has(server)) { summary.skipped.push({ server, reason: 'uses file paths on this computer' }); continue; }
      // Proxied servers are an opt-in group: the key `mcp` switches all of them on (a server can still be named
      // `absent`), or a server is switched on by its own name. Default: none.
      const o = this.deps.overrides;
      const wanted = o?.[server] === 'host' || (o?.mcp === 'host' && o?.[server] !== 'absent');
      if (!wanted) { summary.skipped.push({ server, reason: 'not turned on for this daemon' }); continue; }
      let listed;
      try {
        listed = await source.listTools();
      } catch (err) {
        this.deps.log?.(`${server}: could not list tools: ${err instanceof Error ? err.message : String(err)}`);
        summary.skipped.push({ server, reason: 'could not list its tools' });
        continue;
      }
      for (const t of listed) {
        const spec: RemoteHostToolSpec = {
          name: t.name, description: t.description ?? '', inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
          // Unknown means "ask": only a tool that says it is read-only skips the approval gate.
          requiresApproval: t.annotations?.readOnlyHint !== true, server,
        };
        const problem = validateHostToolSpec(spec);
        if (problem) { this.deps.log?.(`${server}/${t.name} not offered: ${problem}`); continue; }
        (servers[server] ??= []).push(spec);
        (summary.servers[server] ??= []).push(t.name);
        index.set(key(server, t.name), {
          run: async (input, signal) => {
            const r = await source.callTool(t.name, input, signal);
            const { text, images } = flatten(r.content ?? []);
            return { success: r.isError !== true, text, ...(images.length ? { content: images } : {}) };
          },
        });
      }
    }

    // A manifest over the wire limits would be refused whole; shed whole servers (not tools) until it fits.
    let total = Object.values(servers).reduce((n, l) => n + l.length, 0);
    for (const name of Object.keys(servers).sort((a, b) => servers[b].length - servers[a].length)) {
      if (total <= HOST_TOOL_LIMITS.maxTools && Object.keys(servers).length <= HOST_TOOL_LIMITS.maxServers) break;
      if (name === CLAUDE_THREADS_SERVER) continue;
      total -= servers[name].length;
      delete servers[name];
      delete summary.servers[name];
      summary.skipped.push({ server: name, reason: 'too many tools for one daemon session' });
    }

    this.index = index;
    this.lastSummary = summary;
    return servers;
  }

  /** Run one tool the manifest offered. Never throws: a failure is an unsuccessful output. */
  async invoke(server: string, tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<HostToolOutput> {
    const entry = this.index.get(`${server}\u0000${tool}`);
    if (!entry) return { success: false, text: `The host tool "${server}/${tool}" is not available.` };
    try {
      return await entry.run(input, signal);
    } catch (err) {
      // The message can carry local paths or loopback addresses; it stays here, the daemon gets a plain sentence.
      this.deps.log?.(`${server}/${tool} threw: ${err instanceof Error ? err.message : String(err)}`);
      return { success: false, text: `The host tool "${tool}" failed to run.` };
    }
  }

  dispose(): void {
    this.index.clear();
    for (const source of Object.values(this.deps.mcpSources ?? {})) void source.close().catch(() => undefined);
  }
}

/**
 * The paragraph(s) of the remote environment prompt that say what runs where (design 3.5: the env prompt names
 * the host-tool server). `null` summary = host tools are off for this thread.
 */
export function describeHostToolsForPrompt(summary: HostToolsSummary | null, hostName: string, harness: 'claude' | 'codex' | 'opencode' = 'claude'): string[] {
  const lines: string[] = [
    '- Worktree tools (enter_worktree, exit_worktree, set_working_directory) run on this remote machine, beside the repo.',
  ];
  if (!summary || (summary.builtIn.length === 0 && Object.keys(summary.servers).length === 0)) {
    lines.push(`- The user's ${hostName} tools (vault_*, workspace_*, threads_*, Google Workspace) are not available in this session; the user has not turned any on for this machine. Do not ask for them or try to work around this.`);
    return lines;
  }
  lines.push(
    `- These tools run on the USER'S computer in ${hostName}, not on this machine, and work only while ${hostName} is connected. If it is not, the call fails with a clear message after a wait; carry on without them rather than retrying in a loop:`,
  );
  // Claude sees MCP names (`mcp__server__tool`). Codex and OpenCode get the same tools as plain tools: bare names for
  // claude_threads, `<server>__<tool>` for any other server (the daemon's `hostDynamicTools.ts` naming).
  const named = (server: string, tools: string[]): string =>
    harness === 'claude' ? `mcp__${server}__*: ${tools.join(', ')}` : tools.map((t) => (server === 'claude_threads' ? t : `${server}__${t}`)).join(', ');
  if (summary.builtIn.length) lines.push(`  - ${named('claude_threads', summary.builtIn)}`);
  for (const [server, tools] of Object.entries(summary.servers)) lines.push(`  - ${named(server, tools)}`);
  lines.push('- Everything else (shell, file read/write, search) is this machine\'s own; paths are paths on this machine.');
  return lines;
}

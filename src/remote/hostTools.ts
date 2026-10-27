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
import {
  HOST_RESOURCE_TOOLS, HOST_TOOL_LIMITS, checkResourceUri, encodeResourceContents, encodeResourceList, encodeResourceTemplates,
  isHostResourceTool, asStructuredContent, validateHostToolSpec, type RemoteHostToolSpec,
} from '../protocol';
import { domainOf, routeFor, type RouteOverrides } from '../toolRouting';
import { HOST_EXEC_DISABLED_MESSAGE, type HostExecPolicyAccess } from '../managedPolicy';
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
  /** The tool's MCP `structuredContent`, when it returned a plain object; see `run` of the proxied tools. */
  structuredContent?: Record<string, unknown>;
}

export interface RemoteHostToolsDeps {
  /** `harnessTools` of the thread's canonical `claude_threads` server (name, schema, approval flag, handler). */
  builtIn?: readonly HarnessDynamicTool[];
  /** Loopback brokers by MCP server name (`google-docs`, an OAuth server). */
  mcpSources?: Readonly<Record<string, HostMcpSource>>;
  /**
   * Names of the tools peer plugins contributed (ADR-0008); a subset of `builtIn`, which already carries them. Offered
   * only through the `plugins` route (see `routeFor`); a name that is also a built-in is never treated as contributed.
   */
  contributedTools?: ReadonlySet<string>;
  /** The user's per-daemon choices (domain or tool -> host | absent). */
  overrides?: RouteOverrides;
  /** Tools of `NEVER_OFFERED` the user switched on for this (managed local) daemon; see localDaemon/optionalTools.ts. */
  optionalTools?: ReadonlySet<string>;
  /**
   * The user's standing approval for a built-in `claude_threads` tool call (a saved host_exec command prefix), or
   * false. Never consulted for proxied servers. The executor asks it only for a tool in the manifest that needs approval.
   */
  preApprove?: (tool: string, input: Record<string, unknown>) => boolean;
  /**
   * Managed policy for `host_exec` (docs/managed-policy.md). Read fresh for every manifest and every call: when the
   * administrator disables it the tool is not offered, and a call that arrives anyway (stale manifest, a daemon that
   * ignores the manifest) is refused. Absent = no managed policy.
   */
  hostExecPolicy?: HostExecPolicyAccess;
  log?: (message: string) => void;
}

/** The verdict on one call, from managed policy (see {@link RemoteHostTools.gateCall}). */
export type HostCallGate = { ok: true; allowAlways: boolean } | { ok: false; text: string };

/** What the plugin tells the user and the model is available, for notices and the environment prompt. */
export interface HostToolsSummary {
  /** Canonical tool names offered from `claude_threads`. */
  builtIn: string[];
  /** Proxied server name -> tool names. */
  servers: Record<string, string[]>;
  /** Servers that were configured but could not be offered, with the reason. */
  skipped: Array<{ server: string; reason: string; /** Worth telling the user (a size shed or a failed listing), unlike a server they never turned on. */ notify?: boolean }>;
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
  /** Proxied servers whose MCP resources may be listed and read (the ones offered in the last manifest). */
  private resourceServers = new Set<string>();
  private lastSummary: HostToolsSummary = { builtIn: [], servers: {}, skipped: [] };

  constructor(private readonly deps: RemoteHostToolsDeps) {}

  get summary(): HostToolsSummary { return this.lastSummary; }

  /** See {@link RemoteHostToolsDeps.preApprove}. Only a built-in tool of the thread's own `claude_threads` server qualifies. */
  isPreApproved(server: string, tool: string, input: Record<string, unknown>): boolean {
    if (server !== CLAUDE_THREADS_SERVER || !this.deps.preApprove) return false;
    if (!(this.deps.builtIn ?? []).some((t) => t.name === tool)) return false;
    return this.deps.preApprove(tool, input) === true;
  }

  /** Managed policy for one call, read fresh. `host_exec` is the only tool policy governs here. */
  async gateCall(server: string, tool: string): Promise<HostCallGate> {
    if (server !== CLAUDE_THREADS_SERVER || domainOf(tool) !== 'exec' || !this.deps.hostExecPolicy) return { ok: true, allowAlways: true };
    const state = await this.deps.hostExecPolicy.current();
    return state.enabled ? { ok: true, allowAlways: state.allowAlways } : { ok: false, text: HOST_EXEC_DISABLED_MESSAGE };
  }

  /** Build the manifest now (proxied servers are listed over the network, so this is async). */
  async manifest(): Promise<HostManifest> {
    const execState = this.deps.hostExecPolicy ? await this.deps.hostExecPolicy.current() : undefined;
    const servers: HostManifest = {};
    const index = new Map<string, { run(input: Record<string, unknown>, signal?: AbortSignal): Promise<HostToolOutput> }>();
    const summary: HostToolsSummary = { builtIn: [], servers: {}, skipped: [] };
    const resourceServers = new Set<string>();
    const key = (server: string, tool: string): string => `${server}\u0000${tool}`;

    for (const t of this.deps.builtIn ?? []) {
      if (routeFor(t.name, this.deps.overrides, this.deps.optionalTools, this.deps.contributedTools) !== 'host') continue;
      if (execState && !execState.enabled && domainOf(t.name) === 'exec') continue;
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
        summary.skipped.push({ server, reason: 'could not list its tools', notify: true });
        continue;
      }
      resourceServers.add(server);
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
            // `structuredContent` is forwarded unconditionally when the server returned it (never `_meta`). The Claude CLI
            // then gives the model JSON.stringify(structuredContent) INSTEAD of the text blocks, exactly as it does for
            // the same MCP server connected directly in a local thread, so a remote thread sees what a local one sees
            // (some tools, e.g. an upload token, return data ONLY there). Gating it would leave those tools unusable;
            // a server that wants a terse text result simply should not set it. Passed through unchanged; the executor
            // only checks that it fits the frame (`fitStructuredContent`).
            const structuredContent = asStructuredContent(r.structuredContent);
            return { success: r.isError !== true, text, ...(images.length ? { content: images } : {}), ...(structuredContent ? { structuredContent } : {}) };
          },
        });
      }
    }

    // A manifest over the wire limits would be refused whole by the daemon; shed whole servers (not tools) until it
    // fits: the largest one first (by tool count for the count/server limits, by size for the byte limit).
    const L = HOST_TOOL_LIMITS;
    const bytesOf = (name: string): number => JSON.stringify(servers[name]).length;
    for (;;) {
      const names = Object.keys(servers);
      const total = names.reduce((n, k) => n + servers[k].length, 0);
      const bytes = JSON.stringify(servers).length;
      let reason: string;
      let order: (a: string, b: string) => number;
      if (bytes > L.maxManifestBytes) {
        reason = `manifest too large (${(bytes / 1048576).toFixed(1)} MB > ${(L.maxManifestBytes / 1048576).toFixed(1)} MB)`;
        order = (a, b) => bytesOf(b) - bytesOf(a);
      } else if (total > L.maxTools) {
        reason = `too many tools (${total} > ${L.maxTools})`;
        order = (a, b) => servers[b].length - servers[a].length;
      } else if (names.length > L.maxServers) {
        reason = `too many servers (${names.length} > ${L.maxServers})`;
        order = (a, b) => servers[b].length - servers[a].length;
      } else break;
      const victim = names.filter((n) => n !== CLAUDE_THREADS_SERVER).sort(order)[0];
      if (!victim) break; // only claude_threads left: nothing more to shed
      delete servers[victim];
      delete summary.servers[victim];
      summary.skipped.push({ server: victim, reason, notify: true });
    }
    for (const name of resourceServers) if (!servers[name]) resourceServers.delete(name);

    this.index = index;
    this.resourceServers = resourceServers;
    this.lastSummary = summary;
    return servers;
  }

  /** Run one tool the manifest offered. Never throws: a failure is an unsuccessful output. */
  async invoke(server: string, tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<HostToolOutput> {
    if (isHostResourceTool(tool)) return this.invokeResource(server, tool, input);
    const gate = await this.gateCall(server, tool);
    if (!gate.ok) return { success: false, text: gate.text };
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

  /**
   * `resources/list`, `resources/templates/list` and `resources/read` of a proxied server, as the JSON text the
   * daemon decodes (`encodeResource*`). Read-only, so no approval; only servers offered in the manifest qualify.
   * Never throws.
   */
  private async invokeResource(server: string, tool: string, input: Record<string, unknown>): Promise<HostToolOutput> {
    const source = this.resourceServers.has(server) ? this.deps.mcpSources?.[server] : undefined;
    if (!source) return { success: false, text: `The host server "${server}" has no resources to offer in this session.` };
    try {
      switch (tool) {
        case HOST_RESOURCE_TOOLS.list: return { success: true, text: encodeResourceList(await source.listResources?.() ?? []) };
        case HOST_RESOURCE_TOOLS.templates: return { success: true, text: encodeResourceTemplates(await source.listResourceTemplates?.() ?? []) };
        default: {
          const bad = checkResourceUri(input.uri);
          if (bad) return { success: false, text: `The resource was not read: ${bad}.` };
          if (!source.readResource) return { success: false, text: `The host server "${server}" has no resources to offer in this session.` };
          return { success: true, text: encodeResourceContents(await source.readResource(input.uri as string)) };
        }
      }
    } catch (err) {
      this.deps.log?.(`${server}/${tool} threw: ${err instanceof Error ? err.message : String(err)}`);
      // An MCP error message from the upstream server (unknown uri, ...) is the model's to read; a transport error is not.
      const mcp = err instanceof Error && err.name === 'McpError';
      return { success: false, text: mcp ? `The host server "${server}" refused: ${(err as Error).message.slice(0, 500)}` : `The host server "${server}" could not serve this resource request.` };
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

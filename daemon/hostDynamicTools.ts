/**
 * Host tools for the harnesses that take tools as plain definitions (Codex dynamic tools, OpenCode's loopback
 * bridge) instead of in-process MCP servers: the same set `hostServers.ts` gives Claude, as `HarnessDynamicTool`s.
 *
 *   - the daemon's LOCAL worktree tools (`enter_worktree`, `exit_worktree`, `set_working_directory`) keep the bare
 *     names they have under `claude_threads`; they run here and need an approval in modes that ask;
 *   - each tool the client proxies keeps its bare name for `claude_threads` and is named `<server>__<tool>` for any
 *     other server (`google-docs__create_doc`), so two servers cannot collide;
 *     the user's own app shows the approval card for a proxied call, so no second card is raised here
 *     (the Claude driver's `preApprove` does the same).
 *
 * Unlike Claude's servers the list is fixed when the session starts: Codex registers its dynamic tools in
 * `thread/start`, and neither harness has a list-changed notification we can reach. A call to a tool that has since
 * left the manifest fails with a model-readable error from the broker.
 */
import { z } from 'zod';
import type { HarnessDynamicTool } from '../src/HarnessSession';
import type { RemoteHostToolSpec } from '../src/protocol';
import { CLAUDE_THREADS_SERVER, buildLocalToolDefs } from './hostServers';
import type { DriverContext } from './sessionDriver';

type LocalDef = ReturnType<typeof buildLocalToolDefs>[number];

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

function localTool(def: LocalDef): HarnessDynamicTool {
  const shape = z.object(def.inputSchema as z.ZodRawShape);
  return {
    name: def.name,
    description: def.description,
    inputSchema: z.toJSONSchema(shape) as Record<string, unknown>,
    // These write to the disk (a worktree) or move the session: they ask like any other edit.
    requiresApproval: true,
    async invoke(args) {
      const parsed = shape.safeParse(args);
      if (!parsed.success) return { success: false, text: `Invalid arguments for ${def.name}: ${parsed.error.message}` };
      try {
        const result = (await def.handler(parsed.data as never, {})) as { content?: unknown; isError?: boolean };
        return { success: result.isError !== true, text: textOf(result.content) };
      } catch (err) {
        return { success: false, text: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** The wire name of a proxied tool for a harness that has no server namespace of its own. */
export function proxiedToolName(server: string, tool: string): string {
  return server === CLAUDE_THREADS_SERVER ? tool : `${server}__${tool}`;
}

function proxiedTool(ctx: DriverContext, spec: RemoteHostToolSpec): HarnessDynamicTool {
  return {
    name: proxiedToolName(spec.server, spec.name),
    description: spec.description,
    inputSchema: spec.inputSchema,
    requiresApproval: false,
    async invoke(args) {
      const port = ctx.hostTools;
      if (!port) return { success: false, text: 'Host tools are not available in this session.' };
      const outcome = await port.call(spec.server, spec.name, args);
      return { success: outcome.success, text: outcome.text };
    },
  };
}

/**
 * The tools this session starts with. A proxied tool that shares a name with a local one never shadows it, which is
 * the rule `hostMcpServer.ts` applies too.
 */
export function buildHostDynamicTools(ctx: DriverContext): HarnessDynamicTool[] {
  const local = buildLocalToolDefs(ctx).map(localTool);
  const taken = new Set(local.map((t) => t.name));
  const proxied: HarnessDynamicTool[] = [];
  for (const specs of Object.values(ctx.hostTools?.manifest() ?? {})) {
    for (const spec of specs) {
      const tool = proxiedTool(ctx, spec);
      if (taken.has(tool.name)) continue;
      taken.add(tool.name);
      proxied.push(tool);
    }
  }
  return [...local, ...proxied];
}

/**
 * `EnterDesignMode` as a contributed agent tool — the reference consumer for
 * `extensions.registerAgentTool` (ADR-0008).
 *
 * ADR-0008 forbids shipping contribution surface without a real consumer, and
 * requires the built-in to be routed through the public contract while it
 * still lives in this repository. This module is the single definition of the
 * tool: name, description, schema and error semantics live here, and both the
 * public contribution path (`main.ts`) and the factory's compatibility adapter
 * build from it. There is no second copy to drift.
 *
 * Every existing semantic is preserved deliberately:
 *  - `alwaysLoad: true`.
 *  - `requiresApproval: true` — it writes artifact files, so it must keep the
 *    native harness approval prompt.
 *  - The same name on the canonical and deprecated-alias servers (it is not in
 *    `LEGACY_TO_CANONICAL_TOOL_NAMES`).
 *  - Errors return `isError: true` rather than throwing.
 *  - It sends no message and changes no cwd: the agent continues its turn.
 *
 * The thread id is *not* an argument. The host injects it at invoke time from
 * the per-thread binding, which is the inversion the contribution API exists
 * to provide — a peer's `invoke` is thread-agnostic.
 */

import { z } from 'zod';
import type { AgentToolContribution } from '../../../src/AgentToolContributions';
import type { PeerIdentity } from '../../../src/ArtifactContributions';
import type { DesignModeResult } from './designArtifact';

export const DESIGN_AGENT_TOOL_NAME = 'EnterDesignMode';

export const DESIGN_AGENT_TOOL_DESCRIPTION =
  'Creates or reuses this thread\'s static design artifact, opens its preview and artifact controls, and returns paths and design instructions. Continue editing the artifact in this turn. Requires a desktop filesystem vault and write permission; unavailable during Plan mode or pending plan approval.';

/**
 * Declared as a zod shape rather than JSON Schema so the tool keeps byte-exact
 * validation. `.trim()` rejects a whitespace-only brief at parse time, and it
 * is invisible in JSON Schema output — a round trip would silently drop it.
 * Peers may declare JSON Schema instead; both forms are accepted.
 */
export const DESIGN_AGENT_TOOL_INPUT_SCHEMA = {
  brief: z.string().trim().min(1).describe('The visual design brief or requested revision.'),
};

/** Identity the design tool registers under, as a peer plugin would. */
export const DESIGN_AGENT_TOOL_OWNER: PeerIdentity = Object.freeze({
  pluginId: 'agent-threads.design',
  displayName: 'Agent Threads Design',
});

/** Thread-bound entry the host supplies; `undefined` where design is unavailable. */
export type EnterDesignModeFn = (threadId: string, brief: string) => Promise<DesignModeResult>;

/**
 * Builds the design contribution.
 *
 * `onEnterDesignMode` is omitted on hosts that cannot run design mode at all,
 * in which case the tool still appears and reports why — preserving the
 * existing "unavailable in this host" path rather than vanishing from the
 * catalog, which would read to an agent as a capability that never existed.
 */
export function createDesignAgentTool(onEnterDesignMode?: EnterDesignModeFn): AgentToolContribution {
  return {
    name: DESIGN_AGENT_TOOL_NAME,
    description: DESIGN_AGENT_TOOL_DESCRIPTION,
    inputSchema: DESIGN_AGENT_TOOL_INPUT_SCHEMA,
    alwaysLoad: true,
    requiresApproval: true,
    async invoke(threadId, args) {
      try {
        // Native harnesses invoke handlers directly, bypassing MCP schema parsing.
        if (typeof args?.brief !== 'string' || !args.brief.trim()) throw new Error('A nonblank design brief is required.');
        if (!onEnterDesignMode) throw new Error('Design mode is unavailable in this host.');
        const result = await onEnterDesignMode(threadId, args.brief.trim());
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  };
}

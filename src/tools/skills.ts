/**
 * Skills Manager tools (`skills_*`).
 * Moved verbatim out of ObsidianTools.ts (one factory over a narrow port); see toolRouting.ts for where each runs.
 */

import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk/browser';
import path from 'path';
import type { ObsidianMcpServerOptions } from '../ObsidianTools';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

type ToolDef = SdkMcpToolDefinition<any>;

export interface SkillsToolsPort {
  options: Pick<ObsidianMcpServerOptions, 'onSkillsCheckUpdates' | 'onSkillsCreateLocal' | 'onSkillsGet' | 'onSkillsInstall' | 'onSkillsListInstalled' | 'onSkillsListSources' | 'onSkillsSearch' | 'onSkillsUninstall' | 'onSkillsUpdate' | 'onSkillsUpdateLocal'>;
}


export function createSkillsTools(port: SkillsToolsPort): Record<string, ToolDef> {
  const { options } = port;
  // ── Skills Manager tools ──────────────────────────────────────────────────
  // Expose the same view/search/install/uninstall/update capabilities as the
  // Skills Manager UI (SkillsManagerView.ts) so any agent can manage skill
  // packages, not just a human clicking around. All logic lives in
  // skillManager.ts; these handlers are thin adapters over the onSkillsXxx
  // callbacks, mirroring the Cron tools above.

  const boundSkillsListInstalled = tool(
    'skills_list_installed',
    "Lists skills with name, description, path, qualified identifier, and origin: local (authored), vault (installed), or home (read-only). isEditable/isRemovable describe supported operations. Use the returned identifier with skills_get and skills_uninstall to distinguish duplicate names. Newly authored skills become available in new sessions.",
    {},
    async (_args, _extra) => {
      try {
        if (!options.onSkillsListInstalled) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'skills_list_installed is not available in this context.' }) }], isError: true };
        }
        const skills = await options.onSkillsListInstalled();
        return { content: [{ type: 'text' as const, text: JSON.stringify(skills, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  const boundSkillsSearch = tool(
    'skills_search',
    'Searches the skills.sh marketplace registry for installable skills matching a query. Returns each match\'s name, slug, GitHub source, install count, and whether it is already installed locally.',
    {
      query: z.string().describe('Search query, e.g. a skill name or keyword'),
      limit: z.number().int().positive().optional().describe('Maximum number of results to return (default 15)'),
    },
    async (args, _extra) => {
      try {
        if (!options.onSkillsSearch) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'skills_search is not available in this context.' }) }], isError: true };
        }
        const results = await options.onSkillsSearch(args.query, args.limit);
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  const boundSkillsGet = tool(
    'skills_get',
    'Returns full detail for one skill, whether installed or not. Pass an installed skill\'s name, or a marketplace slug in "owner/repo/skill-id" form (as returned by skills_search). Installed skills include their full SKILL.md content.',
    {
      identifier: z.string().describe('An installed skill\'s name, or a marketplace slug like "owner/repo/skill-id"'),
    },
    async (args, _extra) => {
      try {
        if (!options.onSkillsGet) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'skills_get is not available in this context.' }) }], isError: true };
        }
        const detail = await options.onSkillsGet(args.identifier);
        return { content: [{ type: 'text' as const, text: JSON.stringify(detail, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  const boundSkillsListSources = tool(
    'skills_list_sources',
    'Lists configured skill sources (GitHub-cloned or local-path plugin sources), plus the built-in skills.sh registry, with their id, name, type, and (for GitHub sources) staleness info.',
    {},
    async (_args, _extra) => {
      try {
        if (!options.onSkillsListSources) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'skills_list_sources is not available in this context.' }) }], isError: true };
        }
        const sources = options.onSkillsListSources();
        return { content: [{ type: 'text' as const, text: JSON.stringify(sources, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  const boundSkillsCheckUpdates = tool(
    'skills_check_updates',
    'Checks every configured GitHub-type skill source for upstream commits it is behind (fetches each source; behindCount is 1 when upstream has moved). Returns each source\'s id, name, and either its new behindCount/lastFetched or an error if the check failed.',
    {},
    async (_args, _extra) => {
      try {
        if (!options.onSkillsCheckUpdates) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'skills_check_updates is not available in this context.' }) }], isError: true };
        }
        const results = await options.onSkillsCheckUpdates();
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  const boundSkillsInstall = tool(
    'skills_install',
    "Installs a skill from the skills.sh marketplace into the vault's own skills folder (<vault>/<plugin-dir>/skills/). Never writes to ~/.claude/. Pass the slug/skillId/source/name exactly as returned by skills_search for the skill you want to install.",
    {
      slug: z.string().describe('Full skills.sh id, e.g. "owner/repo/skill-name" (from skills_search results)'),
      skillId: z.string().describe('Bare skill folder name — the install directory basename (from skills_search results)'),
      source: z.string().describe('GitHub "owner/repo" the skill is hosted in (from skills_search results)'),
      name: z.string().describe('Human-readable skill name (from skills_search results)'),
    },
    async (args, _extra) => {
      try {
        if (!options.onSkillsInstall) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'skills_install is not available in this context.' }) }], isError: true };
        }
        const result = await options.onSkillsInstall({
          slug: args.slug,
          skillId: args.skillId,
          source: args.source,
          name: args.name,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  const localFileSchema = z.object({
    path: z.string().describe('Package-relative file path'),
    encoding: z.enum(['utf8', 'base64']),
    content: z.string(),
  });
  const boundSkillsCreateLocal = tool(
    'skills_create_local',
    'Creates a new authored skill in the configured vault folder (default Skills/). Supply a safe skillId, complete SKILL.md with name and description frontmatter, and optional supporting files. Rejects existing packages. Available to newly started sessions; active sessions are not restarted.',
    { skillId: z.string(), skillMd: z.string(), files: z.array(localFileSchema).optional() },
    async args => {
      try {
        if (!options.onSkillsCreateLocal) throw new Error('skills_create_local is not available in this context.');
        return { content: [{ type: 'text' as const, text: JSON.stringify(await options.onSkillsCreateLocal(args)) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error) }) }], isError: true };
      }
    },
  );
  const boundSkillsUpdateLocal = tool(
    'skills_update_local',
    'Patches an existing authored skill in the configured vault folder. Omitted files are preserved; only deleteFiles entries are removed. SKILL.md may be replaced but never deleted. Does not edit installed or external-source packages. Available in newly started sessions. skills_update separately pulls GitHub sources.',
    { skillId: z.string(), files: z.array(localFileSchema).optional(), deleteFiles: z.array(z.string()).optional() },
    async args => {
      try {
        if (!options.onSkillsUpdateLocal) throw new Error('skills_update_local is not available in this context.');
        return { content: [{ type: 'text' as const, text: JSON.stringify(await options.onSkillsUpdateLocal(args)) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error) }) }], isError: true };
      }
    },
  );

  const boundSkillsUninstall = tool(
    'skills_uninstall',
    'Permanently deletes an installed or authored vault skill. Pass a qualified identifier from skills_list_installed, such as local:meeting-notes, in name. Ambiguous names involving authored skills are rejected. Home skills remain read-only.',
    {
      name: z.string().describe('Name of the skill to uninstall (as returned by skills_list_installed, where isRemovable is true)'),
    },
    async (args, _extra) => {
      try {
        if (!options.onSkillsUninstall) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'skills_uninstall is not available in this context.' }) }], isError: true };
        }
        const result = await options.onSkillsUninstall(args.name);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, ...result }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  const boundSkillsUpdate = tool(
    'skills_update',
    'Pulls the latest commits for a configured GitHub-type skill source (fast-forwards its local clone), refreshing every skill it provides. Pass the source id from skills_list_sources — not "registry" (skills.sh has no single-source update; reinstall individual skills instead).',
    {
      sourceId: z.string().describe('id of the GitHub-type skill source to update, from skills_list_sources'),
    },
    async (args, _extra) => {
      try {
        if (!options.onSkillsUpdate) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'skills_update is not available in this context.' }) }], isError: true };
        }
        const result = await options.onSkillsUpdate(args.sourceId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );


  const toolDefs: Array<ToolDef | undefined> = [
    boundSkillsListInstalled as ToolDef | undefined,
    boundSkillsSearch as ToolDef | undefined,
    boundSkillsGet as ToolDef | undefined,
    boundSkillsListSources as ToolDef | undefined,
    boundSkillsCheckUpdates as ToolDef | undefined,
    boundSkillsInstall as ToolDef | undefined,
    boundSkillsCreateLocal as ToolDef | undefined,
    boundSkillsUpdateLocal as ToolDef | undefined,
    boundSkillsUninstall as ToolDef | undefined,
    boundSkillsUpdate as ToolDef | undefined,
  ];
  const toolNames = [
    'skills_list_installed',
    'skills_search',
    'skills_get',
    'skills_list_sources',
    'skills_check_updates',
    'skills_install',
    'skills_create_local',
    'skills_update_local',
    'skills_uninstall',
    'skills_update',
  ];
  return Object.fromEntries(toolNames.flatMap((name, i): Array<[string, ToolDef]> => (toolDefs[i] ? [[name, toolDefs[i]!]] : [])));
}

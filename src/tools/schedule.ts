/**
 * Scheduling tools: `ScheduleWakeup` and the `Cron*` family.
 * Moved verbatim out of ObsidianTools.ts (one factory over a narrow port); see toolRouting.ts for where each runs.
 */

import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk/browser';
import type { CronUpdatePatch, ObsidianMcpServerOptions } from '../ObsidianTools';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

type ToolDef = SdkMcpToolDefinition<any>;

export interface ScheduleToolsPort {
  options: Pick<ObsidianMcpServerOptions, 'onCronCreate' | 'onCronDelete' | 'onCronList' | 'onCronUpdate' | 'onScheduleWakeup'>;
}


export function createScheduleTools(port: ScheduleToolsPort): Record<string, ToolDef> {
  const { options } = port;
  const boundScheduleWakeup = tool(
    'ScheduleWakeup',
    [
      'Schedules a wakeup to resume this conversation after a delay.',
      'When the timer fires, the prompt is injected as a new user message into the same thread, waking the conversation back up.',
      'Use for polling CI status, waiting for deploys to finish, or self-pacing loop work.',
      'The reason field is a human-readable label shown in logs and UI.',
    ].join(' '),
    {
      delaySeconds: z.number().describe('Seconds to wait before waking up'),
      prompt: z.string().describe('The message to inject as a user message when the timer fires'),
      reason: z.string().describe('Human-readable reason for the wakeup (for display/logging)'),
    },
    async (args, _extra) => {
      try {
        await options.onScheduleWakeup?.(args.delaySeconds * 1000, args.prompt, args.reason);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Wakeup scheduled in ${args.delaySeconds}s — ${args.reason}`,
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // ── Cron / Scheduler tools ────────────────────────────────────────────────

  const boundCronCreate = tool(
    'CronCreate',
    "Creates a new scheduled item that fires a prompt into a new thread on a recurring schedule. Use scheduleType 'interval' for every-N-seconds, 'daily' for once per day at a specific time, 'weekly' for specific days of the week. Overlapping runs are prevented automatically: if this item's previous run is still in flight when the next cycle comes due, that cycle is skipped (recorded as 'skipped-busy') and the item resumes on its normal schedule — no gate command is needed to guard against concurrency. Optionally scope it to a local-time active-hours window (e.g. business hours) with activeHoursStart/activeHoursEnd so cycles outside that window are skipped automatically — no thread created, no message sent — instead of firing a thread just to check the clock and bail. Optionally add a deterministic gate command (gateCommand) that runs before each cycle fires: exit 0 fires the agent, exit 1 deliberately skips an empty queue, exit 75 reports an indeterminate evaluation and honors gateFailOpen, and other clean non-zero exits preserve deliberate-skip behavior. On a fire, the gate's stdout is fed into the prompt — it replaces a {{gateOutput}} placeholder if present, otherwise it's appended as a 'Gate output:' block. The gate env includes this item's project-scoped keychain secrets (plus any global ones) plus CRON_LAST_RUN_MS, CRON_ITEM_ID, and CRON_ITEM_NAME.",
    {
      name: z.string().describe('Human-readable name for this scheduled task'),
      prompt: z.string().describe('The prompt to send when this item fires. May contain a {{gateOutput}} placeholder that is replaced with the gate command stdout on a fire.'),
      scheduleType: z.enum(['interval', 'daily', 'weekly']).describe("Schedule type: 'interval', 'daily', or 'weekly'"),
      intervalSeconds: z.number().optional().describe("Required for 'interval': seconds between runs (e.g. 3600 = hourly)"),
      timeOfDay: z.string().optional().describe("HH:MM time string, required for 'daily' and 'weekly'"),
      daysOfWeek: z.array(z.number().int().min(0).max(6)).optional().describe("For 'weekly': day numbers 0=Sun through 6=Sat"),
      cwd: z.string().optional().describe('Working directory override for spawned threads'),
      projectId: z.string().optional().describe('Project ID to assign to new threads'),
      gateCommand: z
        .string()
        .optional()
        .describe(
          "Optional deterministic pre-check shell command run before each cycle fires (runs in the item's cwd). Exit 0 = fire; exit 1 = deliberate empty-queue skip; exit 75 = indeterminate and honors gateFailOpen; other clean non-zero exits preserve deliberate-skip behavior. On a fire, stdout is interpolated into the prompt ({{gateOutput}} placeholder, else appended). Env includes this item's project-scoped keychain secrets (plus any global ones) and CRON_LAST_RUN_MS/CRON_ITEM_ID/CRON_ITEM_NAME. Desktop only.",
        ),
      gateTimeoutSeconds: z
        .number()
        .optional()
        .describe('Max seconds the gate command may run before it is killed. Defaults to 30, capped at 120.'),
      gateFailOpen: z
        .boolean()
        .optional()
        .describe(
          'When the gate cannot be evaluated (exit 75, timeout, or spawn failure such as command-not-found), whether to fire anyway. Defaults to true so a broken check never silently stops a real cron. Other clean non-zero exits are deliberate skips regardless of this flag.',
        ),
      activeHoursStart: z
        .string()
        .optional()
        .describe(
          "Optional HH:MM local time — only fire at/after this time each day (e.g. '07:00'). Must be provided together with activeHoursEnd. Cycles due outside [activeHoursStart, activeHoursEnd) are skipped entirely (no thread created).",
        ),
      activeHoursEnd: z
        .string()
        .optional()
        .describe(
          "Optional HH:MM local time — only fire before this time each day (e.g. '22:00'). Must be provided together with activeHoursStart. Supports overnight windows where start > end (e.g. 22:00-06:00).",
        ),
    },
    async (args, _extra) => {
      try {
        if (!options.onCronCreate) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'CronCreate is not available in this context.' }) }], isError: true };
        }
        if ((args.activeHoursStart !== undefined) !== (args.activeHoursEnd !== undefined)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: 'activeHoursStart and activeHoursEnd must both be provided together, or both omitted.' }),
              },
            ],
            isError: true,
          };
        }
        const item = await options.onCronCreate({
          name: args.name,
          prompt: args.prompt,
          schedule: {
            type: args.scheduleType,
            intervalSeconds: args.intervalSeconds,
            timeOfDay: args.timeOfDay,
            daysOfWeek: args.daysOfWeek,
            activeHours:
              args.activeHoursStart !== undefined && args.activeHoursEnd !== undefined
                ? { start: args.activeHoursStart, end: args.activeHoursEnd }
                : undefined,
          },
          enabled: true,
          cwd: args.cwd,
          projectId: args.projectId,
          gate: args.gateCommand
            ? { command: args.gateCommand, timeoutSeconds: args.gateTimeoutSeconds, failOpen: args.gateFailOpen }
            : undefined,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(item, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundCronList = tool(
    'CronList',
    'Returns all scheduled items with their id, name, prompt, schedule, enabled state, and last/next run times.',
    {},
    async (_args, _extra) => {
      try {
        if (!options.onCronList) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'CronList is not available in this context.' }) }], isError: true };
        }
        const items = options.onCronList().map((item) => {
          const {
            _scheduleRevision: _revision,
            _scheduleClaimToken: _claimToken,
            _scheduleClaimDueAt: _claimDueAt,
            _scheduleClaimRevision: _claimRevision,
            ...publicItem
          } = item;
          return publicItem;
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundCronUpdate = tool(
    'CronUpdate',
    'Updates an existing scheduled item. Only provided fields are changed. To pause/resume a schedule set enabled to false/true. Overlapping runs are already prevented automatically (a cycle whose previous run is still in flight is skipped), so a gate command is not needed to guard against concurrency. Use activeHoursStart/activeHoursEnd to set or change the local-time window this item is allowed to fire in (cycles outside it are skipped automatically); use clearActiveHours to remove that restriction entirely. Use gateCommand/gateTimeoutSeconds/gateFailOpen to set or change the deterministic pre-check that runs before each cycle fires (exit 0 = fire; exit 1 = deliberate empty-queue skip; exit 75 = indeterminate and honors gateFailOpen; other clean non-zero exits preserve deliberate-skip behavior; stdout is interpolated into the prompt via {{gateOutput}}); use clearGate to remove the gate entirely.',
    {
      id: z.string().describe('ID of the scheduled item to update'),
      name: z.string().optional().describe('New human-readable name'),
      prompt: z.string().optional().describe('New prompt text'),
      enabled: z.boolean().optional().describe('Set to false to pause, true to resume'),
      intervalSeconds: z.number().optional().describe("New interval in seconds (for 'interval' type)"),
      timeOfDay: z.string().optional().describe("New HH:MM time (for 'daily' and 'weekly')"),
      daysOfWeek: z.array(z.number().int().min(0).max(6)).optional().describe("New days of week (for 'weekly')"),
      cwd: z.string().optional().describe('New working directory override'),
      projectId: z.string().optional().describe('New project ID'),
      gateCommand: z
        .string()
        .optional()
        .describe(
          "New deterministic pre-check shell command run before each cycle fires. Exit 0 = fire; exit 1 = deliberate empty-queue skip; exit 75 = indeterminate and honors gateFailOpen; other clean non-zero exits preserve deliberate-skip behavior. On a fire, stdout is interpolated into the prompt via {{gateOutput}} (else appended). Env includes this item's project-scoped keychain secrets (plus any global ones) and CRON_LAST_RUN_MS/CRON_ITEM_ID/CRON_ITEM_NAME. Desktop only.",
        ),
      gateTimeoutSeconds: z
        .number()
        .optional()
        .describe('New max seconds the gate command may run before it is killed (default 30, capped at 120). Only applied when a gate command is or becomes set.'),
      gateFailOpen: z
        .boolean()
        .optional()
        .describe('New fail-open behavior: when the gate cannot be evaluated (exit 75, timeout, or spawn failure), whether to fire anyway (default true). Only applied when a gate command is or becomes set.'),
      clearGate: z.boolean().optional().describe('Set to true to remove the gate entirely, so this item fires every cycle without a pre-check.'),
      activeHoursStart: z
        .string()
        .optional()
        .describe(
          'New HH:MM start time for the active-hours window. If the item has no existing window, activeHoursEnd must also be provided (in this call or a previous one).',
        ),
      activeHoursEnd: z
        .string()
        .optional()
        .describe(
          'New HH:MM end time for the active-hours window. If the item has no existing window, activeHoursStart must also be provided.',
        ),
      clearActiveHours: z.boolean().optional().describe('Set to true to remove the active-hours restriction entirely, so this item fires on its normal schedule at any time of day.'),
    },
    async (args, _extra) => {
      try {
        if (!options.onCronUpdate) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'CronUpdate is not available in this context.' }) }], isError: true };
        }
        const { id, name, prompt, enabled, intervalSeconds, timeOfDay, daysOfWeek, cwd, projectId, activeHoursStart, activeHoursEnd, clearActiveHours, gateCommand, gateTimeoutSeconds, gateFailOpen, clearGate } = args;
        const patch: CronUpdatePatch = {};
        if (name !== undefined) patch.name = name;
        if (prompt !== undefined) patch.prompt = prompt;
        if (enabled !== undefined) patch.enabled = enabled;
        if (intervalSeconds !== undefined || timeOfDay !== undefined || daysOfWeek !== undefined) {
          patch.schedule = { ...patch.schedule };
          if (intervalSeconds !== undefined) patch.schedule.intervalSeconds = intervalSeconds;
          if (timeOfDay !== undefined) patch.schedule.timeOfDay = timeOfDay;
          if (daysOfWeek !== undefined) patch.schedule.daysOfWeek = daysOfWeek;
        }
        if (clearActiveHours) {
          patch.schedule = { ...patch.schedule, activeHours: undefined };
        } else if (activeHoursStart !== undefined || activeHoursEnd !== undefined) {
          // activeHours is a nested object, so — unlike the flat sub-fields
          // above — a partial update (only start or only end) needs the
          // other side filled in from the existing item, since Scheduler's
          // merge is a shallow spread over `schedule` and would otherwise
          // clobber the untouched side.
          const existing = options.onCronList?.().find((i) => i.id === id);
          const existingActiveHours = existing?.schedule.activeHours;
          const start = activeHoursStart ?? existingActiveHours?.start;
          const end = activeHoursEnd ?? existingActiveHours?.end;
          if (!start || !end) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error:
                      'Cannot set only one of activeHoursStart/activeHoursEnd when the item has no existing active-hours window to fill in the other side. Provide both.',
                  }),
                },
              ],
              isError: true,
            };
          }
          patch.schedule = { ...patch.schedule, activeHours: { start, end } };
        }
        if (clearGate) {
          // gate is a top-level field (not nested under schedule), so clearing
          // it is a plain patch.gate = undefined — no schedule interaction.
          patch.gate = undefined;
        } else if (gateCommand !== undefined || gateTimeoutSeconds !== undefined || gateFailOpen !== undefined) {
          // Like the activeHours branch above, gate is an object, so a partial
          // update (e.g. only changing the timeout) needs the other sub-fields
          // filled in from the existing item — updateItem replaces the whole
          // gate object via a shallow spread and would otherwise drop them.
          const existing = options.onCronList?.().find((i) => i.id === id);
          const existingGate = existing?.gate;
          const command = gateCommand ?? existingGate?.command;
          if (!command) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error:
                      'Cannot set gateTimeoutSeconds/gateFailOpen without a gate command. Provide gateCommand, or the item must already have a gate.',
                  }),
                },
              ],
              isError: true,
            };
          }
          patch.gate = {
            command,
            timeoutSeconds: gateTimeoutSeconds ?? existingGate?.timeoutSeconds,
            failOpen: gateFailOpen ?? existingGate?.failOpen,
          };
        }
        if (cwd !== undefined) patch.cwd = cwd;
        if (projectId !== undefined) patch.projectId = projectId;
        const item = await options.onCronUpdate(id, patch);
        return { content: [{ type: 'text' as const, text: JSON.stringify(item, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundCronDelete = tool(
    'CronDelete',
    'Permanently deletes a scheduled item by ID.',
    {
      id: z.string().describe('ID of the scheduled item to delete'),
    },
    async (args, _extra) => {
      try {
        if (!options.onCronDelete) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'CronDelete is not available in this context.' }) }], isError: true };
        }
        await options.onCronDelete(args.id);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, deletedId: args.id }) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );


  const toolDefs: Array<ToolDef | undefined> = [
    boundScheduleWakeup as ToolDef | undefined,
    boundCronCreate as ToolDef | undefined,
    boundCronList as ToolDef | undefined,
    boundCronUpdate as ToolDef | undefined,
    boundCronDelete as ToolDef | undefined,
  ];
  const toolNames = [
    'ScheduleWakeup',
    'CronCreate',
    'CronList',
    'CronUpdate',
    'CronDelete',
  ];
  return Object.fromEntries(toolNames.flatMap((name, i): Array<[string, ToolDef]> => (toolDefs[i] ? [[name, toolDefs[i]!]] : [])));
}

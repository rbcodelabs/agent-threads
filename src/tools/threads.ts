/**
 * Thread-coordination and orchestrator tools (`threads_*`).
 * Moved verbatim out of ObsidianTools.ts (one factory over a narrow port); see toolRouting.ts for where each runs.
 */

import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk/browser';
import path from 'path';
import type { ObsidianMcpServerOptions, ProjectUpdatePatch } from '../ObsidianTools';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

type ToolDef = SdkMcpToolDefinition<any>;

export interface ThreadToolsPort {
  options: Pick<ObsidianMcpServerOptions, 'archiveThread' | 'authorizeProjectDestination' | 'authorizeThread' | 'clearThreadProposedReply' | 'createProject' | 'createThread' | 'getAllProjects' | 'getAllThreads' | 'getOrchestratorThreadId' | 'getThreadDetail' | 'isOrchestratorThread' | 'isThreadRunning' | 'openThread' | 'readThreadLog' | 'requestDeferredArchive' | 'sendMessageToThread' | 'setThreadNotes' | 'setThreadProject' | 'setThreadProposedReply' | 'threadId' | 'updateProject'>;
}


export function createThreadTools(port: ThreadToolsPort): Record<string, ToolDef> {
  const { options } = port;
  const boundCreateThread = tool(
    'threads_create',
    [
      'Creates a new persistent thread and immediately queues its initial prompt.',
      'The new thread inherits the current thread\'s working directory and project when those fields are omitted.',
      'Pass projectId: null to create the thread without a project.',
      'Targeting a different project or working directory than the current thread requires user approval and errors if denied.',
      'Returns as soon as the prompt is queued; use threads_wait to wait for its response.',
    ].join(' '),
    {
      prompt: z.string().trim().min(1).describe('The initial prompt to queue in the new thread'),
      title: z.string().min(1).optional().describe('Optional title for the new thread'),
      cwd: z.string().min(1).optional().describe('Optional working directory override'),
      projectId: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Optional project ID override. Omit to inherit the current project; pass null to create without a project.',
        ),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit Project elevation for this creation.'),
    },
    async (args, _extra) => {
      if (!options.createThread) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'createThread is not available in this context.' }) }],
          isError: true,
        };
      }
      try {
        const result = await options.createThread(args);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // ── Thread-coordination tools ────────────────────────────────────────────────

  const boundGetCurrentThread = tool(
    'obsidian_get_current_thread',
    'Returns metadata about the current thread: id, title, status, uiStatus, isRunning, project, cwd, prUrl, scheduledItemId, scheduledItemName, rawLogPath, and message count. Useful for understanding your own context before coordinating with other threads. uiStatus matches the Agents List UI labels (working | new | reviewed | failed | ready). prUrl is the URL of the most recent GitHub PR opened in this thread, if any. scheduledItemId/scheduledItemName identify the cron item that created this thread, if it was created by one. rawLogPath is the vault-relative path to the raw JSONL conversation log (read it with threads_get_log).',
    {},
    async (_args, _extra) => {
      try {
        const { threadId } = options;
        if (!threadId || !options.getThreadDetail) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Thread state not available in this context.' }) }], isError: true };
        }
        const detail = options.getThreadDetail(threadId);
        if (!detail) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Current thread not found: ${threadId}` }) }], isError: true };
        }
        const { messages: _msgs, ...meta } = detail;
        return { content: [{ type: 'text' as const, text: JSON.stringify(meta, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundListThreads = tool(
    'obsidian_list_threads',
    'Returns all threads with their id, title, status, uiStatus, isRunning flag, project, cwd, prUrl, scheduledItemId, scheduledItemName, rawLogPath, updatedAt, and message count. Use this to discover other running threads before coordinating with them. uiStatus matches the Agents List UI labels (working | new | reviewed | failed | ready). prUrl is the URL of the most recent GitHub PR opened in that thread, if any — useful for matching threads to PRs without reading message history. scheduledItemId/scheduledItemName identify the cron item that created a thread, if it was created by one. rawLogPath is the vault-relative path to the thread\'s raw JSONL conversation log (read it with threads_get_log).',
    { projectId: z.string().optional().describe('Portfolio orchestrator only: explicitly elevate this call into one Project.') },
    async (args, _extra) => {
      try {
        if (!options.getAllThreads) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Thread state not available in this context.' }) }], isError: true };
        }
        const threads = options.getAllThreads().filter(thread => options.authorizeThread?.(thread.id, args.projectId, 'read') ?? true);
        return { content: [{ type: 'text' as const, text: JSON.stringify(threads, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundListProjects = tool(
    'obsidian_list_projects',
    'Returns all projects with their id, name, description, vaultFolder, cwdOverride, and resolved effectiveCwd. Projects focus working context but do not restrict the broader vault or configured tool roster.',
    {},
    async (_args, _extra) => {
      try {
        if (!options.getAllProjects) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Project state not available in this context.' }) }], isError: true };
        }
        const projects = options.getAllProjects();
        return { content: [{ type: 'text' as const, text: JSON.stringify(projects, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundCreateProject = tool(
    'obsidian_create_project',
    'Creates a new project with the given name and vault folder. Returns the created project snapshot including its id. Capture the returned id — it is the projectId used by CronCreate, threads_set_project, and other project-aware APIs.',
    {
      name: z.string().describe('Human-readable project name (e.g. "Golden Wealth", "HipTrip", "Personal")'),
      vaultFolder: z
        .string()
        .describe(
          'Vault-relative folder path for this project (e.g. "Projects/GoldenWealth"). Claude threads in this project will default to this folder as their working context.',
        ),
      description: z.string().optional().describe('Optional one-line description of the project'),
      cwdOverride: z
        .string()
        .optional()
        .describe(
          'Optional absolute filesystem path to use as the working directory instead of deriving it from vaultFolder + vault root',
        ),
    },
    async (args, _extra) => {
      try {
        if (!options.createProject) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'createProject is not available in this context.' }) }], isError: true };
        }
        const project = options.createProject(args.name, args.vaultFolder, args.description, args.cwdOverride);
        return { content: [{ type: 'text' as const, text: JSON.stringify(project, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundUpdateProject = tool(
    'obsidian_update_project',
    'Updates a Project name, context description, or working-directory override. Omitted fields are preserved; null clears description or cwdOverride. Existing threads keep their current cwd and live session. New Project threads and dynamic schedules use the updated effective cwd.',
    {
      projectId: z.string().trim().min(1).describe('ID of the Project to update'),
      name: z.string().optional().describe('New human-readable Project name; trimmed and must not be blank'),
      description: z.string().nullable().optional().describe('New Project context description; null clears it'),
      cwdOverride: z.string().nullable().optional().describe('New absolute filesystem cwd; null restores the vault-derived cwd'),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit matching Project elevation for this call.'),
    },
    async (args, _extra) => {
      try {
        if (!options.updateProject) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'updateProject is not available in this context.' }) }], isError: true };
        }
        if (options.authorizeProjectDestination && !options.authorizeProjectDestination(args.projectId, args.elevatedProjectId)) {
          throw new Error('Target is outside coordination scope.');
        }
        const hasName = args.name !== undefined;
        const hasDescription = args.description !== undefined;
        const hasCwdOverride = args.cwdOverride !== undefined;
        if (!hasName && !hasDescription && !hasCwdOverride) throw new Error('At least one editable field is required.');

        const patch: ProjectUpdatePatch = {};
        if (hasName) {
          const name = args.name!.trim();
          if (!name) throw new Error('Project name must not be blank.');
          patch.name = name;
        }
        if (hasDescription) patch.description = args.description ?? undefined;
        if (hasCwdOverride) {
          if (args.cwdOverride === null) {
            patch.cwdOverride = undefined;
          } else {
            const cwdOverride = args.cwdOverride!.trim();
            if (!cwdOverride) throw new Error('cwdOverride must not be blank; pass null to clear it.');
            if (!path.posix.isAbsolute(cwdOverride) && !path.win32.isAbsolute(cwdOverride)) throw new Error('cwdOverride must be an absolute filesystem path.');
            patch.cwdOverride = cwdOverride;
          }
        }
        const project = await options.updateProject(args.projectId, patch);
        return { content: [{ type: 'text' as const, text: JSON.stringify(project, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundSetThreadProject = tool(
    'obsidian_set_thread_project',
    'Assigns a thread to a project or clears its project assignment. Call threads_list_projects first to get a valid projectId. By default only association changes; pass alignCwd: true with a non-null Project to switch cwd safely on the next turn. Detaching never relocates the thread.',
    {
      threadId: z.string().describe('ID of the thread to update'),
      projectId: z
        .string()
        .nullable()
        .describe('Project ID to assign to the thread, or null to clear the project assignment'),
      alignCwd: z.boolean().optional().describe('Also switch the thread to the Project cwd and start a fresh session on the next turn. Defaults to false.'),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit Project elevation for this call.'),
    },
    async (args, _extra) => {
      try {
        if (!options.setThreadProject) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'setThreadProject is not available in this context.' }) }], isError: true };
        }
        if (options.authorizeThread && !options.authorizeThread(args.threadId, args.elevatedProjectId, 'write')) throw new Error('Target is outside coordination scope.');
        if (options.authorizeProjectDestination && !options.authorizeProjectDestination(args.projectId ?? undefined, args.elevatedProjectId, args.threadId)) throw new Error('Destination Project is outside coordination scope.');
        options.setThreadProject(args.threadId, args.projectId, args.alignCwd ?? false);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, threadId: args.threadId, projectId: args.projectId }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundGetThreadMessages = tool(
    'obsidian_get_thread_messages',
    'Returns the live message history of any thread by ID. Use limit to get just the most recent N messages (default 20). Useful for reading what another thread has done or decided before coordinating.',
    {
      threadId: z.string().describe('ID of the thread to read'),
      limit: z.number().int().positive().optional().describe('Return only the last N messages (default 20)'),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit Project elevation for this call.'),
    },
    async (args, _extra) => {
      try {
        if (!options.getThreadDetail) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Thread state not available in this context.' }) }], isError: true };
        }
        if (options.authorizeThread && !options.authorizeThread(args.threadId, args.elevatedProjectId, 'read')) throw new Error('Target is outside coordination scope.');
        const detail = options.getThreadDetail(args.threadId);
        if (!detail) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Thread not found: ${args.threadId}` }) }], isError: true };
        }
        const limit = args.limit ?? 20;
        const messages = detail.messages.slice(-limit);
        return { content: [{ type: 'text' as const, text: JSON.stringify(messages, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundOpenThread = tool(
    'obsidian_open_thread',
    'Opens and focuses a thread by its exact ID. A successful open marks the thread reviewed and persists the active selection.',
    {
      threadId: z.string().describe('ID of the thread to open'),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit Project elevation for this call.'),
    },
    async (args, _extra) => {
      try {
        if (!options.openThread) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Thread navigation is not available in this context.' }) }], isError: true };
        }
        if (options.authorizeThread && !options.authorizeThread(args.threadId, args.elevatedProjectId, 'read')) throw new Error('Target is outside coordination scope.');
        const detail = options.getThreadDetail?.(args.threadId);
        if (!detail) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Thread not found: ${args.threadId}` }) }], isError: true };
        }
        await options.openThread(args.threadId);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, threadId: args.threadId }) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundGetThreadLog = tool(
    'obsidian_get_thread_log',
    'Returns parsed entries from a thread\'s raw JSONL conversation log: tool calls, completed outputs, assistant messages, result events, system events, and a synthetic session_start marker. Each entry is an envelope { ts, threadId, sessionId, type, event }. Completed protocol events are preserved; token deltas are omitted. Codex diff snapshots are coalesced per thread/turn (up to 512 KiB); command and plan deltas retain bounded 64 KiB diagnostic tails when needed. Synthetic codex/log/compacted events identify source, reason, tail, and original/retained/omitted byte counts. Pending updates flush at completion, session shutdown, or memory limits, so this is not a verbatim stream and pending events may be absent while running or after a host crash. Use this for more detail than threads_get_messages. Results are filtered by type (if given) and tailed to the most recent N entries (default 100). The returned `path` is the absolute log file path for all stored entries. Defaults to the current thread when threadId is omitted.',
    {
      threadId: z.string().optional().describe('ID of the thread whose log to read. Defaults to the current thread.'),
      limit: z.number().int().nonnegative().optional().describe('Return only the most recent N entries (default 100). Pass 0 for all entries. Type filtering is applied before tailing.'),
      type: z.string().optional().describe('Only return entries with this envelope type, e.g. "assistant", "user", "result", "system", "session_start", "tool_use_summary".'),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit Project elevation for this call.'),
    },
    async (args, _extra) => {
      try {
        if (!options.readThreadLog) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Raw log access not available in this context.' }) }], isError: true };
        }
        const threadId = args.threadId ?? options.threadId;
        if (!threadId) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No threadId provided and no current thread in context.' }) }], isError: true };
        }
        if (options.authorizeThread && !options.authorizeThread(threadId, args.elevatedProjectId, 'read')) throw new Error('Target is outside coordination scope.');
        const result = await options.readThreadLog(threadId, { limit: args.limit, type: args.type });
        if (!result) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `No raw log found for thread: ${threadId}. Raw logging may be disabled, or the thread has not produced any events yet.` }) }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundWaitForThread = tool(
    'obsidian_wait_for_thread',
    'Blocks until the specified thread finishes processing its current request (isRunning becomes false), then returns. Returns immediately if the thread is already idle. Use after threads_send_message to wait for a response before reading results.',
    {
      threadId: z.string().describe('ID of the thread to wait for'),
      timeoutSeconds: z.number().optional().describe('Maximum seconds to wait before giving up (default 120)'),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit Project elevation for this call.'),
    },
    async (args, _extra) => {
      try {
        if (!options.isThreadRunning) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Thread state not available in this context.' }) }], isError: true };
        }
        if (options.authorizeThread && !options.authorizeThread(args.threadId, args.elevatedProjectId, 'read')) throw new Error('Target is outside coordination scope.');
        const timeoutMs = Math.min((args.timeoutSeconds ?? 120) * 1000, 600_000);
        const start = Date.now();
        const pollMs = 1_000;

        while (options.isThreadRunning(args.threadId)) {
          const elapsed = Date.now() - start;
          if (elapsed >= timeoutMs) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ done: false, timedOut: true, elapsedSeconds: Math.round(elapsed / 1000) }) }],
              isError: true,
            };
          }
          await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ done: true, elapsedSeconds: Math.round((Date.now() - start) / 1000) }) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundSendMessageToThread = tool(
    'obsidian_send_message_to_thread',
    'Sends a user message to another thread, triggering Claude to process it. The call returns as soon as the message is queued — use threads_wait to block until the response is ready. Cannot send to the current thread.',
    {
      threadId: z.string().describe('ID of the thread to send the message to'),
      message: z.string().describe('The message text to send'),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit Project elevation for this call.'),
    },
    async (args, _extra) => {
      try {
        if (!options.sendMessageToThread) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Thread messaging not available in this context.' }) }], isError: true };
        }
        if (args.threadId === options.threadId) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Cannot send a message to the current thread.' }) }], isError: true };
        }
        if (options.authorizeThread && !options.authorizeThread(args.threadId, args.elevatedProjectId, 'write')) throw new Error('Target is outside coordination scope.');
        await options.sendMessageToThread(args.threadId, args.message);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, threadId: args.threadId }) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundArchiveThread = tool(
    'obsidian_archive_thread',
    [
      'Archives a thread by ID — saves it to the vault (if vault persistence is enabled) then removes it from memory.',
      'Use this to close out completed threads, e.g. after merging PRs or finishing release management.',
      'A scheduled thread may archive itself; that archive is deferred until its current run settles.',
      'Other current threads cannot archive themselves.',
      'Archiving the Thread Orchestrator (the thread tracked in settings.orchestratorThreadId) requires confirm: true.',
    ].join(' '),
    {
      threadId: z.string().describe('ID of the thread to archive'),
      confirm: z.boolean().optional().describe('Must be true to archive the orchestrator thread (the thread tracked in settings.orchestratorThreadId). Not required for any other thread.'),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit Project elevation for this call.'),
    },
    async (args, _extra) => {
      try {
        if (!options.archiveThread) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Thread archiving not available in this context.' }) }], isError: true };
        }
        if (options.authorizeThread && !options.authorizeThread(args.threadId, args.elevatedProjectId, 'write')) throw new Error('Target is outside coordination scope.');
        if (args.threadId === options.threadId) {
          if ((options.isOrchestratorThread?.(args.threadId) ?? args.threadId === options.getOrchestratorThreadId?.()) && !args.confirm) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'This is the Thread Orchestrator. Pass confirm: true to archive it anyway — doing so stops automatic thread review until "Open Thread Orchestrator" is run again.' }) }], isError: true };
          }
          const currentThread = options.getThreadDetail?.(args.threadId);
          if (currentThread?.scheduledItemId && options.requestDeferredArchive) {
            options.requestDeferredArchive(args.threadId);
            return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, archivedThreadId: args.threadId, deferred: true }) }] };
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Cannot archive the current thread.' }) }], isError: true };
        }
        if ((options.isOrchestratorThread?.(args.threadId) ?? args.threadId === options.getOrchestratorThreadId?.()) && !args.confirm) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'This is the Thread Orchestrator. Pass confirm: true to archive it anyway — doing so stops automatic thread review until "Open Thread Orchestrator" is run again.' }) }], isError: true };
        }
        await options.archiveThread(args.threadId);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, archivedThreadId: args.threadId }) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }], isError: true };
      }
    },
  );

  // ── Thread-orchestrator tools ────────────────────────────────────────────────
  // Support the bundled thread-orchestrator skill: tracking notes + a proposed
  // reply awaiting human approval. No tool here ever sends a message — approval
  // is always a human clicking Approve & Send in ThreadsView.

  const boundSetThreadNotes = tool(
    'obsidian_set_thread_notes',
    [
      'Sets (overwrites) a thread\'s orchestrator tracking notes — free-form text for',
      'inferred goal, status, and a last-reviewed cursor. Visible in the UI but never',
      'injected into any session\'s context. Pass an empty string to clear.',
    ].join(' '),
    {
      threadId: z.string().describe('ID of the thread to annotate'),
      notes: z.string().describe('Tracking notes text. Pass an empty string to clear existing notes.'),
      elevatedProjectId: z.string().optional().describe('Reserved for explicit portfolio reads; portfolio elevation cannot write Project notes.'),
    },
    async (args, _extra) => {
      try {
        if (!options.setThreadNotes) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'setThreadNotes is not available in this context.' }) }], isError: true };
        }
        if (options.authorizeThread && !options.authorizeThread(args.threadId, args.elevatedProjectId, 'notes')) throw new Error('Target is outside coordination scope.');
        options.setThreadNotes(args.threadId, args.notes);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, threadId: args.threadId }) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundSetThreadProposedReply = tool(
    'obsidian_set_thread_proposed_reply',
    [
      'Sets an AI-proposed next message for a thread, awaiting human approval. Rendered as a',
      'banner in ThreadsView with Approve & Send / Edit / Discard actions — nothing is ever sent',
      'automatically. Distinct from the thread\'s own unsent compose-box draft. Cannot target the',
      'current thread (an orchestrator should never propose a reply to itself).',
    ].join(' '),
    {
      threadId: z.string().describe('ID of the thread to propose a reply for'),
      text: z.string().describe('The proposed reply text'),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit Project elevation for this call.'),
    },
    async (args, _extra) => {
      try {
        if (!options.setThreadProposedReply) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'setThreadProposedReply is not available in this context.' }) }], isError: true };
        }
        if (args.threadId === options.threadId) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Cannot set a proposed reply on the current thread.' }) }], isError: true };
        }
        if (options.authorizeThread && !options.authorizeThread(args.threadId, args.elevatedProjectId, 'write')) throw new Error('Target is outside coordination scope.');
        options.setThreadProposedReply(args.threadId, args.text);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, threadId: args.threadId }) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundClearThreadProposedReply = tool(
    'obsidian_clear_thread_proposed_reply',
    'Clears a thread\'s pending proposed reply, if any, without sending it. Use this when a prior proposal is stale or no longer relevant.',
    {
      threadId: z.string().describe('ID of the thread to clear the proposed reply on'),
      elevatedProjectId: z.string().optional().describe('Portfolio orchestrator only: explicit Project elevation for this call.'),
    },
    async (args, _extra) => {
      try {
        if (!options.clearThreadProposedReply) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'clearThreadProposedReply is not available in this context.' }) }], isError: true };
        }
        if (options.authorizeThread && !options.authorizeThread(args.threadId, args.elevatedProjectId, 'write')) throw new Error('Target is outside coordination scope.');
        options.clearThreadProposedReply(args.threadId);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, threadId: args.threadId }) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );


  const toolDefs: Array<ToolDef | undefined> = [
    boundCreateThread as ToolDef | undefined,
    boundGetCurrentThread as ToolDef | undefined,
    boundListThreads as ToolDef | undefined,
    boundListProjects as ToolDef | undefined,
    boundCreateProject as ToolDef | undefined,
    boundUpdateProject as ToolDef | undefined,
    boundSetThreadProject as ToolDef | undefined,
    boundGetThreadMessages as ToolDef | undefined,
    boundOpenThread as ToolDef | undefined,
    boundGetThreadLog as ToolDef | undefined,
    boundWaitForThread as ToolDef | undefined,
    boundSendMessageToThread as ToolDef | undefined,
    boundArchiveThread as ToolDef | undefined,
    boundSetThreadNotes as ToolDef | undefined,
    boundSetThreadProposedReply as ToolDef | undefined,
    boundClearThreadProposedReply as ToolDef | undefined,
  ];
  const toolNames = [
    'threads_create',
    'obsidian_get_current_thread',
    'obsidian_list_threads',
    'obsidian_list_projects',
    'obsidian_create_project',
    'obsidian_update_project',
    'obsidian_set_thread_project',
    'obsidian_get_thread_messages',
    'obsidian_open_thread',
    'obsidian_get_thread_log',
    'obsidian_wait_for_thread',
    'obsidian_send_message_to_thread',
    'obsidian_archive_thread',
    'obsidian_set_thread_notes',
    'obsidian_set_thread_proposed_reply',
    'obsidian_clear_thread_proposed_reply',
  ];
  return Object.fromEntries(toolNames.flatMap((name, i): Array<[string, ToolDef]> => (toolDefs[i] ? [[name, toolDefs[i]!]] : [])));
}

/**
 * Local daemon: the host tools that write, schedule, install or touch secrets on this Mac, which every daemon is
 * denied (`toolRouting.ts` NEVER_OFFERED) but which threads of the removed per-thread sandbox VM had, because they
 * ran inside the plugin's own tool server.
 *
 * For the MANAGED local daemon (a container on this Mac, run by the same user) they can be switched on, per group,
 * in Settings -> Remote -> Local daemon. Off by default. A group that is on is offered to that daemon's threads, and
 * every call still needs the app's own approval card (these tools all require approval; nothing remembered pre-approves
 * a remote thread's request). Pure: no I/O.
 */

import type { RouteOverrides } from '../toolRouting';

export interface OptionalToolGroup {
  id: string;
  label: string;
  /** What the group lets a thread on the daemon do, in the user's words. */
  description: string;
  /** Canonical tool names (as in `NEVER_OFFERED`). */
  tools: readonly string[];
}

export const OPTIONAL_TOOL_GROUPS: readonly OptionalToolGroup[] = Object.freeze([
  { id: 'threads', label: 'Create and manage threads', description: 'start, message, archive and edit other threads and projects', tools: [
    'threads_create', 'threads_create_project', 'threads_update_project', 'threads_set_project', 'threads_open',
    'threads_send_message', 'threads_archive', 'threads_set_notes', 'threads_set_proposed_reply', 'threads_clear_proposed_reply',
  ] },
  { id: 'schedule', label: 'Schedule work', description: 'create, change and delete scheduled and recurring work, and wake this thread later', tools: [
    'ScheduleWakeup', 'CronCreate', 'CronList', 'CronUpdate', 'CronDelete',
  ] },
  { id: 'secrets', label: 'Secrets and MCP servers', description: 'ask you for secrets (stored in your keychain) and register MCP servers', tools: [
    'request_secret', 'mcp_register_server',
  ] },
  { id: 'skills', label: 'Install and change skills', description: 'install, create, update and uninstall skills on this Mac', tools: [
    'skills_install', 'skills_create_local', 'skills_update_local', 'skills_uninstall', 'skills_update', 'skills_check_updates',
  ] },
  { id: 'vault', label: 'Vault history and bridges', description: 'restore earlier versions of vault files and add vault bridges', tools: [
    'vault_restore_file_version', 'vault_add_bridge',
  ] },
  { id: 'workspace', label: 'Run app commands and drive the editor', description: 'run any app command, open files and URLs, insert text and watch documents', tools: [
    'host_execute_command', 'host_list_commands', 'host_open_url', 'workspace_navigate_to_file', 'workspace_insert_at_cursor',
    'watch_document', 'unwatch_document',
  ] },
  { id: 'browser', label: 'Browser scripts and saved pages', description: 'run JavaScript in the in-app browser and save pages to files on this Mac', tools: [
    'browser_eval', 'browser_save_page',
  ] },
  { id: 'github', label: 'GitHub access discovery', description: 'list the repositories your GitHub connection can reach', tools: [
    'github_list_access', 'github_check_repo',
  ] },
]);

export const OPTIONAL_TOOLS_WARNING =
  'These tools act on THIS Mac with your account, not inside the container. An agent that reads untrusted text (a web page, an issue, a file) '
  + 'could be steered into calling them. Each call still asks you in the app first (never "Always Allow"), but read every card. Leave a group off unless you need it.';

const KNOWN = new Set(OPTIONAL_TOOL_GROUPS.map((g) => g.id));

/** Only known group ids, de-duplicated, in a stable order. */
export function normalizeOptionalGroups(ids: readonly unknown[] | undefined): string[] {
  const wanted = new Set((ids ?? []).filter((v): v is string => typeof v === 'string' && KNOWN.has(v)));
  return OPTIONAL_TOOL_GROUPS.map((g) => g.id).filter((id) => wanted.has(id));
}

/** The tool names the enabled groups cover. */
export function optionalToolsFor(ids: readonly unknown[] | undefined): Set<string> {
  const on = new Set(normalizeOptionalGroups(ids));
  return new Set(OPTIONAL_TOOL_GROUPS.filter((g) => on.has(g.id)).flatMap((g) => g.tools));
}

/** The route overrides for a managed daemon: the user's own routes plus nothing for tools whose group is off. */
export function withOptionalRoutes(routes: RouteOverrides | undefined, ids: readonly unknown[] | undefined): RouteOverrides {
  const out: Record<string, 'host' | 'absent'> = { ...(routes ?? {}) };
  for (const tool of optionalToolsFor(ids)) out[tool] = 'host';
  return out;
}

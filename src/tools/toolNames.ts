/**
 * Tool names by domain: the pure (no `obsidian`, no DOM) source of truth the
 * routing table and the drift tests read. The domain modules in this folder
 * return their tools keyed by these names, and `ObsidianTools.ts` assembles
 * them in `BUILT_IN_TOOL_ORDER`; a test pins both against this file.
 *
 * Names are the LEGACY names the definitions are registered under
 * (`obsidian_search_vault`); `LEGACY_TO_CANONICAL_TOOL_NAMES` renames them
 * for the canonical `claude_threads` server (`vault_search`).
 */

export type ToolDomain =
  | 'worktree' | 'vault' | 'workspace' | 'threads' | 'schedule' | 'skills' | 'misc' | 'browser';

export const LEGACY_TO_CANONICAL_TOOL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  obsidian_search_vault: 'vault_search',
  obsidian_get_note_metadata: 'vault_get_note_metadata',
  obsidian_get_backlinks: 'vault_get_backlinks',
  obsidian_get_outgoing_links: 'vault_get_outgoing_links',
  obsidian_get_file_history: 'vault_get_file_history',
  obsidian_restore_file_version: 'vault_restore_file_version',
  obsidian_list_vault_bridges: 'vault_list_bridges',
  obsidian_add_vault_bridge: 'vault_add_bridge',
  obsidian_get_active_file: 'workspace_get_active_file',
  obsidian_get_open_tabs: 'workspace_get_open_tabs',
  obsidian_navigate_to_file: 'workspace_navigate_to_file',
  obsidian_insert_at_cursor: 'workspace_insert_at_cursor',
  obsidian_list_commands: 'host_list_commands',
  obsidian_execute_command: 'host_execute_command',
  obsidian_open_url: 'host_open_url',
  obsidian_get_current_thread: 'threads_get_current',
  obsidian_list_threads: 'threads_list',
  obsidian_list_projects: 'threads_list_projects',
  obsidian_create_project: 'threads_create_project',
  obsidian_update_project: 'threads_update_project',
  obsidian_set_thread_project: 'threads_set_project',
  obsidian_get_thread_messages: 'threads_get_messages',
  obsidian_open_thread: 'threads_open',
  obsidian_get_thread_log: 'threads_get_log',
  obsidian_wait_for_thread: 'threads_wait',
  obsidian_send_message_to_thread: 'threads_send_message',
  obsidian_archive_thread: 'threads_archive',
  obsidian_set_thread_notes: 'threads_set_notes',
  obsidian_set_thread_proposed_reply: 'threads_set_proposed_reply',
  obsidian_clear_thread_proposed_reply: 'threads_clear_proposed_reply',
});

/** Browser tools are canonical-only (they were never exposed under legacy names). */
export const BROWSER_TOOL_NAMES = [
  'browser_navigate', 'browser_snapshot', 'browser_read_text', 'browser_click', 'browser_type',
  'browser_screenshot', 'browser_status', 'browser_close', 'browser_resize', 'browser_save_page',
  'browser_console', 'browser_network', 'browser_scroll', 'browser_eval',
] as const;

/** Legacy tool names per domain (browser tools use their only name). */
export const TOOL_NAMES_BY_DOMAIN: Readonly<Record<ToolDomain, readonly string[]>> = Object.freeze({
  worktree: ['set_working_directory', 'enter_worktree', 'exit_worktree'],
  vault: [
    'obsidian_search_vault', 'obsidian_get_backlinks', 'obsidian_get_outgoing_links', 'obsidian_get_note_metadata',
    'vault_list', 'obsidian_get_file_history', 'obsidian_restore_file_version', 'obsidian_list_vault_bridges',
    'obsidian_add_vault_bridge',
  ],
  workspace: [
    'obsidian_get_open_tabs', 'obsidian_get_active_file', 'obsidian_navigate_to_file', 'obsidian_insert_at_cursor',
    'obsidian_list_commands', 'obsidian_execute_command', 'obsidian_open_url',
    'watch_document', 'unwatch_document', 'list_watched_documents',
  ],
  threads: [
    'threads_create', 'obsidian_get_current_thread', 'obsidian_list_threads', 'obsidian_list_projects',
    'obsidian_create_project', 'obsidian_update_project', 'obsidian_set_thread_project', 'obsidian_get_thread_messages',
    'obsidian_open_thread', 'obsidian_get_thread_log', 'obsidian_wait_for_thread', 'obsidian_send_message_to_thread',
    'obsidian_archive_thread', 'obsidian_set_thread_notes', 'obsidian_set_thread_proposed_reply',
    'obsidian_clear_thread_proposed_reply',
  ],
  schedule: ['ScheduleWakeup', 'CronCreate', 'CronList', 'CronUpdate', 'CronDelete'],
  skills: [
    'skills_list_installed', 'skills_search', 'skills_get', 'skills_list_sources', 'skills_check_updates',
    'skills_install', 'skills_create_local', 'skills_update_local', 'skills_uninstall', 'skills_update',
  ],
  misc: ['github_list_access', 'github_check_repo', 'request_secret', 'mcp_register_server'],
  browser: BROWSER_TOOL_NAMES,
});

/**
 * The order the built-in roster is registered in (what the model sees). The domain modules return maps,
 * so this list is the single place that fixes the order; a built-in missing from it is a startup error.
 * `obsidian_open_url` and the browser tools are registered conditionally right after
 * `obsidian_execute_command`, so they are not listed.
 */
export const BUILT_IN_TOOL_ORDER: readonly string[] = Object.freeze([
  'obsidian_get_open_tabs', 'obsidian_get_active_file', 'obsidian_navigate_to_file', 'obsidian_search_vault',
  'obsidian_get_backlinks', 'obsidian_get_outgoing_links', 'obsidian_insert_at_cursor', 'obsidian_get_note_metadata',
  'vault_list', 'set_working_directory', 'ScheduleWakeup', 'watch_document', 'unwatch_document',
  'list_watched_documents', 'enter_worktree', 'exit_worktree',
  'github_list_access', 'github_check_repo', 'obsidian_list_commands', 'obsidian_execute_command',
  'threads_create', 'obsidian_get_current_thread', 'obsidian_list_threads', 'obsidian_list_projects',
  'obsidian_create_project', 'obsidian_update_project', 'obsidian_set_thread_project', 'obsidian_get_thread_messages',
  'obsidian_open_thread', 'obsidian_get_thread_log', 'obsidian_wait_for_thread', 'obsidian_send_message_to_thread',
  'obsidian_archive_thread', 'obsidian_set_thread_notes', 'obsidian_set_thread_proposed_reply',
  'obsidian_clear_thread_proposed_reply', 'obsidian_list_vault_bridges', 'obsidian_add_vault_bridge',
  'obsidian_get_file_history', 'obsidian_restore_file_version', 'CronCreate', 'CronList', 'CronUpdate', 'CronDelete',
  'request_secret', 'mcp_register_server', 'skills_list_installed', 'skills_search', 'skills_get',
  'skills_list_sources', 'skills_check_updates', 'skills_install', 'skills_create_local', 'skills_update_local',
  'skills_uninstall', 'skills_update',
]);

/** The canonical name of a tool (identity when it has no legacy alias). */
export const canonicalToolName = (name: string): string => LEGACY_TO_CANONICAL_TOOL_NAMES[name] ?? name;

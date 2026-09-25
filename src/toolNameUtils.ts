/**
 * toolNameUtils.ts
 *
 * Pure string-manipulation helpers for displaying tool names and picking icons.
 * Intentionally has ZERO imports so this module is safe to include in the
 * mobile bundle (which cannot load Node.js built-ins or the Claude SDK).
 *
 * Previously these functions lived in ClaudeSession.ts, which imports the SDK
 * at the top level. That caused a crash on mobile: the SDK's module-level
 * `import { execFile } from "child_process"` became `require('child_process')`
 * in the CJS bundle, which returns null on mobile, immediately throwing
 * TypeError when the bundle tried to destructure it.
 */

interface NormalizedToolName {
  key: string;
  display: string;
}

const CODEX_TOOL_ALIASES: Record<string, NormalizedToolName> = {
  commandExecution: { key: 'Bash', display: 'Bash' },
  fileChange: { key: 'Edit', display: 'Edit' },
  webSearch: { key: 'WebSearch', display: 'WebSearch' },
  // Viewing an image is an input/read operation; generation creates an artifact.
  imageView: { key: 'ImageView', display: 'View Image' },
  imageGeneration: { key: 'ImageGeneration', display: 'Generate Image' },
};

/** Normalize Claude and Codex tool-record names through one display path. */
function normalizeToolName(raw: string): NormalizedToolName {
  const claudeMcpMatch = raw.match(/^mcp__(.+?)__(.+)$/);
  const codexMcpMatch = claudeMcpMatch ? null : raw.match(/^([^:]+):(.+)$/);
  const server = claudeMcpMatch?.[1] ?? codexMcpMatch?.[1] ?? null;
  const bare = claudeMcpMatch?.[2] ?? codexMcpMatch?.[2] ?? raw;
  const key = (server && bare.startsWith(server + '_'))
    ? bare.slice(server.length + 1)
    : bare;
  const alias = server === null ? CODEX_TOOL_ALIASES[key] : undefined;
  if (alias) return alias;
  return { key, display: key.replace(/_/g, ' ') };
}

/** Strip `mcp__<server>__` or `<server>:` prefix and any leading server-name repetition.
 *  e.g. mcp__obsidian__obsidian_search_vault → "search vault"
 *       obsidian:obsidian_search_vault       → "search vault"
 *       mcp__github__create_issue           → "create issue"
 *       Read                                → "Read"
 */
export function formatToolName(raw: string): string {
  return normalizeToolName(raw).display;
}

/** Return a Lucide icon name for a tool. Falls back to 'wrench'. */
export function getToolIcon(raw: string): string {
  const { key } = normalizeToolName(raw);

  switch (key) {
    // Filesystem / code tools
    case 'Read':           return 'file-text';
    case 'Edit':           return 'file-pen';
    case 'Write':          return 'file-plus';
    case 'Glob':           return 'folder-search';
    case 'Grep':           return 'search-code';
    case 'Bash':           return 'terminal';
    case 'REPL':           return 'code-2';
    // Web tools
    case 'WebFetch':       return 'globe';
    case 'WebSearch':      return 'search';
    case 'ImageView':      return 'image';
    case 'ImageGeneration': return 'image-plus';
    // Claude-native
    case 'Agent':          return 'bot';
    case 'OpenNewTab':     return 'plus-square';
    case 'TodoWrite':      return 'list-checks';
    // MCP resource tools
    case 'ListMcpResources':    return 'database';
    case 'ReadMcpResource':     return 'database';
    case 'ReadMcpResourceDir':  return 'folder-open';
    case 'AskUserQuestion': return 'message-circle-question';
    case 'Skill':          return 'puzzle';
    case 'Workflow':       return 'workflow';
    case 'ToolSearch':     return 'search-code';
    // Task tools
    case 'TaskCreate':     return 'clipboard-plus';
    case 'TaskUpdate':     return 'clipboard-pen';
    case 'TaskGet':        return 'clipboard-list';
    case 'TaskList':       return 'list-todo';
    case 'TaskStop':       return 'circle-stop';
    case 'TaskOutput':     return 'scroll-text';
    case 'Monitor':        return 'activity';
    case 'RemoteTrigger':  return 'radio-tower';
    // Built-in vault/workspace tools
    case 'search_vault':
    case 'vault_search':         return 'vault';
    case 'navigate_to_file':     return 'navigation';
    case 'get_active_file':      return 'file-search';
    case 'insert_at_cursor':     return 'text-cursor-input';
    case 'get_note_metadata':    return 'info';
    case 'get_backlinks':        return 'link-2';
    case 'get_outgoing_links':   return 'external-link';
    case 'set_working_directory': return 'folder-symlink';
    case 'enter_worktree':       return 'git-branch-plus';
    case 'exit_worktree':        return 'git-branch';
    case 'enter_vm':             return 'box';
    case 'vm_exec':              return 'terminal';
    case 'exit_vm':              return 'square-x';
    case 'get_open_tabs':        return 'layout-panel-top';
    case 'ScheduleWakeup':       return 'alarm-clock';
    case 'browser_navigate':     return 'globe';
    case 'browser_snapshot':     return 'scan-eye';
    case 'browser_read_text':    return 'file-text';
    case 'browser_click':        return 'mouse-pointer-click';
    case 'browser_type':         return 'keyboard';
    case 'browser_screenshot':   return 'camera';
    case 'browser_status':       return 'activity';
    case 'browser_close':        return 'circle-x';
    default:               return 'wrench';
  }
}

const LEGACY_BUILT_IN_TOOLS = new Set([
  'obsidian_search_vault', 'obsidian_get_note_metadata', 'obsidian_get_backlinks',
  'obsidian_get_outgoing_links', 'obsidian_get_file_history', 'obsidian_restore_file_version',
  'obsidian_list_vault_bridges', 'obsidian_add_vault_bridge', 'obsidian_get_active_file',
  'obsidian_get_open_tabs', 'obsidian_navigate_to_file', 'obsidian_insert_at_cursor',
  'obsidian_list_commands', 'obsidian_execute_command', 'obsidian_open_url',
  'obsidian_get_current_thread', 'obsidian_list_threads', 'obsidian_list_projects',
  'obsidian_create_project', 'obsidian_update_project', 'obsidian_set_thread_project', 'obsidian_get_thread_messages',
  'obsidian_open_thread',
  'obsidian_get_thread_log', 'obsidian_wait_for_thread', 'obsidian_send_message_to_thread',
  'obsidian_archive_thread', 'obsidian_set_thread_notes', 'obsidian_set_thread_proposed_reply',
  'obsidian_clear_thread_proposed_reply',
]);
const CANONICAL_BUILT_IN_TOOLS = new Set([
  'vault_search', 'vault_get_note_metadata', 'vault_get_backlinks', 'vault_get_outgoing_links',
  'vault_get_file_history', 'vault_restore_file_version', 'vault_list_bridges', 'vault_add_bridge',
  'workspace_get_active_file', 'workspace_get_open_tabs', 'workspace_navigate_to_file',
  'workspace_insert_at_cursor', 'host_list_commands', 'host_execute_command', 'host_open_url',
  'threads_get_current', 'threads_list', 'threads_create', 'threads_list_projects', 'threads_create_project', 'threads_update_project',
  'threads_set_project', 'threads_get_messages', 'threads_get_log', 'threads_wait',
  'threads_open',
  'threads_send_message', 'threads_archive', 'threads_set_notes', 'threads_set_proposed_reply',
  'threads_clear_proposed_reply',
  // Agent browser. Canonical-only: these are new tools, so they were never
  // exposed under the legacy obsidian_ names and need no compatibility alias.
  'browser_navigate', 'browser_snapshot', 'browser_read_text', 'browser_click',
  'browser_type', 'browser_screenshot', 'browser_status', 'browser_close',
]);

/** True only for a known first-party tool on the canonical or compatibility server. */
export function isTrustedBuiltInTool(raw: string): boolean {
  const match = raw.match(/^mcp__(.+?)__(.+)$/);
  if (match) {
    if (match[1] === 'claude_threads') return CANONICAL_BUILT_IN_TOOLS.has(match[2]);
    if (match[1] === 'obsidian') return LEGACY_BUILT_IN_TOOLS.has(match[2]);
    return false;
  }
  return CANONICAL_BUILT_IN_TOOLS.has(raw) || LEGACY_BUILT_IN_TOOLS.has(raw);
}

/**
 * Buckets a tool name into a coarse "activity" category so consecutive
 * same-kind tool calls can be visually grouped in the finalized message view
 * (see groupToolCalls below). Reuses the same MCP-prefix-stripping logic as
 * getToolIcon so `mcp__server__Bash`-shaped names classify the same as bare
 * `Bash`.
 */
export type ActivityKind = 'exploring' | 'editing' | 'planning' | 'researching' | 'searching' | 'working';

export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  exploring: 'Exploring',
  editing: 'Editing',
  planning: 'Planning',
  researching: 'Researching',
  searching: 'Searching',
  working: 'Working',
};

export function getActivityKind(raw: string): ActivityKind {
  const { key } = normalizeToolName(raw);

  switch (key) {
    case 'Bash':
    case 'Read':
    case 'Grep':
    case 'Glob':
    case 'ImageView':
      return 'exploring';
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
    case 'ImageGeneration':
      return 'editing';
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'ExitPlanMode':
    case 'EnterPlanMode':
      return 'planning';
    case 'WebFetch':
    case 'WebSearch':
    case 'browser_navigate':
    case 'browser_snapshot':
    case 'browser_read_text':
    case 'browser_click':
    case 'browser_type':
    case 'browser_screenshot':
    case 'browser_status':
    case 'browser_close':
      return 'researching';
    case 'ToolSearch':
    case 'Agent':
      return 'searching';
    default:
      return 'working';
  }
}

/** One entry in the finalized-message tool-call rendering list. */
export type ToolCallGroup =
  | { kind: 'single'; tool: import('./types').ToolCallRecord }
  | { kind: 'group'; activityKind: ActivityKind; tools: import('./types').ToolCallRecord[] };

/**
 * Chunks a flat list of tool calls into runs of consecutive same-activity-kind
 * calls. Runs of length >= 2 become a single collapsible 'group' entry;
 * isolated calls (no same-kind neighbor immediately before/after) stay as
 * 'single' entries so they render exactly as they always have — no pointless
 * one-item collapsibles. Pure function, no DOM access.
 */
export function groupToolCalls(tools: import('./types').ToolCallRecord[]): ToolCallGroup[] {
  const result: ToolCallGroup[] = [];
  let i = 0;
  while (i < tools.length) {
    const kind = getActivityKind(tools[i].name);
    let j = i + 1;
    while (j < tools.length && getActivityKind(tools[j].name) === kind) {
      j++;
    }
    const run = tools.slice(i, j);
    if (run.length >= 2) {
      result.push({ kind: 'group', activityKind: kind, tools: run });
    } else {
      result.push({ kind: 'single', tool: run[0] });
    }
    i = j;
  }
  return result;
}

/**
 * Deterministic key for a LIVE (in-progress) tool-call group's expand/collapse
 * state — used by ThreadsView's renderLiveToolCalls/renderToolGroup so a group
 * a user expands mid-turn stays expanded as more same-kind calls arrive and
 * the group is rebuilt on every debounced re-render.
 *
 * Unlike a finalized group's key (which hashes every member's toolUseId — see
 * ThreadsView.toolGroupKey), a live group's tool list keeps growing as the
 * turn progresses, so the full member list isn't a stable identity. The FIRST
 * call's id is stable though: groupToolCalls scans left-to-right and only
 * ever extends a run at the tail or starts a new one — it never reinterprets
 * an earlier boundary — so pairing the first call's id with the activity kind
 * uniquely and durably identifies "this run" across rebuilds. A kind change
 * always starts a new run (and therefore a new key), matching groupToolCalls'
 * own chunking rule.
 */
export function liveToolGroupKey(tools: import('./types').ToolCallRecord[]): string {
  const first = tools[0];
  return `${first.toolUseId ?? first.timestamp ?? ''}:${getActivityKind(first.name)}`;
}

/**
 * Smooths groupToolCalls()'s output by folding short off-kind interruptions
 * back into their surrounding same-kind groups. A normal coding loop
 * (Read→Edit→Read→TaskUpdate→Bash→...) flips activity kind constantly, so
 * groupToolCalls() alone produces many short runs rendered as flat sibling
 * entries — collapsed-but-numerous is still visual clutter. This folds a
 * short (<=2 tool) interstitial entry into one merged group when it's
 * sandwiched between two 'group' entries of the SAME activity kind, then
 * repeats until no more merges apply (a fixed-point loop), since one merge
 * can expose a new mergeable triple next door.
 *
 * Notes on the merge rule (see trySingleMerge):
 *
 * 1. Checking only `left.activityKind === right.activityKind` (not `mid`'s
 *    kind) is sufficient: groupToolCalls()'s own output never has two
 *    adjacent same-kind entries — by construction, it chunks the flattest
 *    consecutive run of one activity kind into a single entry before moving
 *    on — so `mid` can never already equal both its neighbors' kind. There's
 *    nothing to additionally exclude by inspecting `mid`.
 *
 * 2. v1 limitation: only a SINGLE short interstitial entry merges per step.
 *    Two consecutive short entries between two same-kind groups
 *    (`group, single, single, group`) do NOT merge — neither individually
 *    satisfies "sandwiched between two `kind:'group'` entries" until the
 *    other one is gone first, and trySingleMerge only removes one interstitial
 *    per call. This is a deliberate, documented scope boundary, not a bug.
 *
 * 3. Termination: each successful merge shrinks the array by exactly 2 (the
 *    interstitial entry and one of its neighboring group entries collapse
 *    into the single merged group). So the fixed-point loop terminates in at
 *    most ⌊(n-1)/2⌋ iterations for an input of length n.
 *
 * When no merge applies, returns the ORIGINAL `entries` reference unchanged
 * (a true no-op) so callers can rely on `===` identity.
 */
export function smoothToolGroups(entries: ToolCallGroup[]): ToolCallGroup[] {
  let current = entries;
  while (true) {
    const merged = trySingleMerge(current);
    if (merged === null) return current; // fixed point — return ORIGINAL reference, true no-op
    current = merged;
  }
}

function trySingleMerge(entries: ToolCallGroup[]): ToolCallGroup[] | null {
  for (let i = 1; i < entries.length - 1; i++) {
    const left = entries[i - 1];
    const mid = entries[i];
    const right = entries[i + 1];
    if (left.kind !== 'group' || right.kind !== 'group') continue;
    if (left.activityKind !== right.activityKind) continue;
    const midTools = mid.kind === 'single' ? [mid.tool] : mid.tools;
    if (midTools.length > 2) continue;
    const mergedGroup: ToolCallGroup = {
      kind: 'group',
      activityKind: left.activityKind,
      tools: [...left.tools, ...midTools, ...right.tools],
    };
    return [...entries.slice(0, i - 1), mergedGroup, ...entries.slice(i + 2)];
  }
  return null;
}

/**
 * Picks the tool call to show as "currently executing" in a live-updating
 * header (see ThreadsView.renderOuterToolWrap). The last still-`pending` call
 * is the actual in-flight one; if nothing is pending (e.g. the burst has
 * fully resolved but the turn hasn't finalized yet), falls back to the last
 * call overall so the header still shows something relevant.
 */
export function pickCurrentTool(tools: import('./types').ToolCallRecord[]): import('./types').ToolCallRecord | null {
  if (tools.length === 0) return null;
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i].status === 'pending') return tools[i];
  }
  return tools[tools.length - 1];
}

/**
 * Entry-count threshold above which the finalized/live tool-call list gets a
 * second collapsible "outer wrap" tier (see ThreadsView.renderOuterToolWrap),
 * wrapping the whole post-smoothing entry list instead of leaving it as many
 * flat sibling groups/pills. `> 7` is deliberately calibrated to leave every
 * existing screenshot scene in test/screenshots/tool-call-grouping.spec.ts
 * unchanged: the `thread-tool-grouping` fixture produces exactly 7 entries
 * after groupToolCalls/smoothToolGroups and must stay in the flat
 * (non-wrapped) render path, while the 50-call live-burst fixture collapses
 * to exactly 1 entry via groupToolCalls alone and was never a candidate for
 * wrapping in the first place.
 *
 * Deliberately NOT combined with a raw-tool-count OR-clause — that was
 * considered and rejected because it would force the 50-call single-group
 * fixture behind a redundant second collapse with nothing new to show; entry
 * count (not raw tool count) is the only signal that matters for "is this
 * list itself too long to scan."
 */
export const OUTER_WRAP_ENTRY_THRESHOLD = 7;

export function shouldWrapOuter(entries: ToolCallGroup[]): boolean {
  return entries.length > OUTER_WRAP_ENTRY_THRESHOLD;
}

/**
 * Merges adjacent tool-only assistant messages into single synthetic rows for
 * RENDERING purposes only — it never touches `thread.messages` itself.
 *
 * Context: a fix to ThreadSession.pumpMessages (see commit 7b7d4fb) now
 * persists every tool-only SDK assistant message (no narration text) as its
 * own `ChatMessage` in `thread.messages`, one per real SDK turn — correct for
 * data integrity, but it means a typical Read → Edit → Bash agentic chain
 * produces a separate persisted message per step. groupToolCalls() only ever
 * collapses calls *within* one message's `toolCalls` array, so with one call
 * per message there's nothing for it to group, and the view fragments into a
 * full-height `.ct-message` row per tool call.
 *
 * This function re-merges those adjacent single-tool-call rows back into one
 * row for display, so groupToolCalls() has a multi-call array to work with
 * again — a run of tool-only assistant messages renders as it did before the
 * persistence fix: a handful of collapsible activity groups, not one row per
 * step.
 *
 * A run boundary is any message where `role !== 'assistant' || content !== ''`
 * — real narration, user messages, and `role: 'compact'` dividers all break a
 * run, so merging never spans a real turn boundary or a message that
 * legitimately carries both text and tool calls.
 *
 * Pure and side-effect free: call fresh on every render, never cache the
 * output. Runs of length 1 pass through as the *original object reference*
 * (a true no-op) so callers can rely on `===` identity for those rows; runs of
 * length >= 2 collapse into one freshly-allocated synthetic `ChatMessage`
 * whose `id`/`timestamp` come from the first message in the run, so a merged
 * row's identity stays stable across re-renders as long as the run's first
 * message stays the same — which is exactly how a live run grows (new tool
 * calls append at the tail, the first message in the run never changes).
 */
export function mergeAdjacentToolOnlyMessages(
  messages: import('./types').ChatMessage[],
): import('./types').ChatMessage[] {
  const result: import('./types').ChatMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || msg.content !== '') {
      result.push(msg);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'assistant' && messages[j].content === '') {
      j++;
    }
    const run = messages.slice(i, j);
    if (run.length === 1) {
      result.push(run[0]);
    } else {
      const toolCalls: import('./types').ToolCallRecord[] = [];
      const toolResultImages: NonNullable<import('./types').ChatMessage['toolResultImages']> = [];
      let cost: number | undefined;
      for (const m of run) {
        if (m.toolCalls && m.toolCalls.length > 0) toolCalls.push(...m.toolCalls);
        if (m.toolResultImages && m.toolResultImages.length > 0) toolResultImages.push(...m.toolResultImages);
        if (m.cost !== undefined) cost = m.cost;
      }
      const merged: import('./types').ChatMessage = {
        id: run[0].id,
        timestamp: run[0].timestamp,
        role: 'assistant',
        content: '',
        toolCalls,
      };
      if (toolResultImages.length > 0) merged.toolResultImages = toolResultImages;
      if (cost !== undefined) merged.cost = cost;
      result.push(merged);
    }
    i = j;
  }
  return result;
}

# Agent tools reference

Part of the [Agent Threads README](../README.md). The MCP tools Agent Threads exposes to agents.

## Agent tools reference

Every thread runs with built-in tools for vault access, session control, and — for multi-agent workflows — live coordination with other threads. Claude receives them through the host-neutral `claude_threads` MCP server; Codex receives the same canonical definitions through its dynamic-tool protocol. No configuration is required. The former `obsidian` server and `obsidian_*` names remain callable as deprecated compatibility aliases until the next major release, but new prompts and automation should use the canonical names below.

### Vault tools

Read and search your vault from within any thread.

| Tool | Parameters | Description |
|---|---|---|
| `vault_search` | `query`, `limit?` | Full-text search across all Markdown files. Tokenizes multi-word queries so each term is matched independently. Returns results ranked by relevance (filename hits weighted 10×) with a ~300-char excerpt from the densest matching region. Default limit: 20. |
| `vault_list` | `path?`, `recursive?`, `limit?` | Lists a vault folder, read-only and without a shell, through the vault adapter (or, on hosts whose adapter has no `list()` such as Geode, the vault's file tree). Returns `{ path, entries: [{ path, type: "file" \| "folder", size?, mtime? }], truncated }`, with vault-relative paths sorted by path. `path` is a vault-relative folder (default: vault root); absolute paths and `..` are rejected. `recursive` defaults to `false`; `limit` defaults to 500 (max 2000), and `truncated` is true when more entries exist. The config folder (`.obsidian` / `.geode`) is skipped unless listed explicitly. Auto-allowed like the other read-only vault tools; lets Bash-free skills list folders instead of calling `ls`/`find`. |
| `vault_get_note_metadata` | `path` | Returns the full metadata cache entry for a note: frontmatter, tags, wikilinks, and headings. |
| `vault_get_backlinks` | `path` | Returns all notes that link to the specified file, with source path and original link text. |
| `vault_get_outgoing_links` | `path` | Returns all wikilinks and Markdown links a note makes to other files, with display text and resolved vault paths. |
| `vault_get_file_history` | `path` | Returns the Obsidian Sync version history for a file. Each entry includes a `uid` (for `vault_restore_file_version`), ISO timestamp, size in bytes, and the device that saved it. Requires Obsidian Sync to be active and the file synced. |
| `vault_restore_file_version` | `path`, `uid` | Restores a version from Obsidian Sync history, overwriting the current content — the current content is preserved in sync history first. Use `vault_get_file_history` to find the `uid`. Requires Obsidian Sync to be active. |
| `vault_move` | `from`, `to` | Moves or renames a file or folder and rewrites wikilinks, embeds and markdown links in other notes (Geode `app.fileManager.moveWithLinkUpdate`). Refuses to overwrite; missing parent folders are created. Returns `{ moved: [{ from, to }], updatedNotes: [path, ...] }` (paths after the move). Paths must be vault-relative: no absolute paths, `..`, backslashes, `//`, trailing `/` or dot-prefixed segments (checked client-side first; Geode re-validates). On a host without `moveWithLinkUpdate` it returns an error and moves nothing (no plain-rename fallback). Requires approval; in `NEVER_OFFERED` (not reachable from remote daemons) and the local daemon's `vault` optional group. Legacy alias: `obsidian_move_path`. |
| `sync_list_conflicts` | — | Lists unresolved Geode sync conflicts, each tagged `sibling` (a `.sync-conflict-<timestamp>` copy sits next to the file) or `history` (concurrent heads in append-only sync). Read-only. |
| `sync_inspect_conflict` | `id` | Sibling: local and remote content plus a line diff. History: each head's record ID, device, size and deleted flag, and (for Markdown) each version's text with a diff against local. Read-only. |
| `sync_resolve_conflict` | `id`, `resolution` (`keep-local`/`accept-remote`), `recordId?`, `mergedContent?` | Resolves a conflict. **Asks for your approval on every call** and cannot be set to Always Allow. History conflicts need `recordId` to accept a version; `mergedContent` (sibling only) is written to the file first, then resolved as keep-local. Needs a Geode build that exposes `app.sync`; history inspect/resolve needs the history-conflict methods on `SyncApi`. |

### Workspace and host tools

Interact with the active Obsidian or Geode workspace.

| Tool | Parameters | Description |
|---|---|---|
| `workspace_get_active_file` | — | Returns metadata (path, basename, extension, size, mtime, ctime) for the file currently open in the editor, or `null` if nothing is open. |
| `workspace_get_open_tabs` | — | Returns all open tabs with path, title, view type, and which one is active. |
| `workspace_navigate_to_file` | `path`, `newLeaf?` | Opens a vault file in the editor. Pass `newLeaf: true` to open in a new tab. |
| `workspace_insert_at_cursor` | `text` | Inserts text at the cursor in the active editor, replacing any current selection. |
| `host_list_commands` | `query?` | Returns all registered host commands (id + name), sorted alphabetically. Pass a `query` string to filter. Use this to discover command IDs before calling `host_execute_command`. |
| `host_execute_command` | `commandId` | Runs any host command by its ID (e.g. `obsidian-git:push`, `editor:toggle-bold`). Third-party command IDs are unchanged. |
| `host_open_url` | `url`, `newTab?` | Opens a URL in the host Web Viewer panel. Reuses an existing tab by default; set `newTab: true` to force a fresh tab. |

### Session tools

Control the current thread's session state.

| Tool | Parameters | Description |
|---|---|---|
| `set_working_directory` | `path` | Changes the working directory for this session. Accepts an absolute path; `~` is expanded. Takes effect on the next turn. |
| `EnterDesignMode` | `brief` | Creates or reuses the calling thread's static design artifact, opens its preview and controls, and returns paths and instructions for the current turn. Desktop only; requires write permission and no pending plan approval. |
| `ScheduleWakeup` | `delaySeconds`, `prompt`, `reason` | Schedules a message to be injected into this thread after a delay. Useful for polling CI, waiting for a deploy, or self-pacing loop work. While the wake-up is pending the thread shows a waiting indicator — a "Waiting" group with a live countdown (`Resumes in 4m — <reason>`) in the Agents List and the [Agent Board](usage.md#agent-board). In the thread composer, a compact `Resumes in …` pill opens scheduled activity with the wakeup reason, exact time, and an item-specific **Cancel** control. |
| `EnterWorktree` | `branch?`, `baseBranch?`, `repoPath?` | Creates a git worktree for the current repo and switches the session cwd to it. Automatically routed to the plugin's MCP implementation, which tracks the in-session cwd correctly after `set_working_directory`. |
| `ExitWorktree` | `worktreePath?`, `force?` | Removes the worktree and restores the session cwd to the original repo root. Defaults to the current effective cwd. Pass `force: true` to remove even if there are uncommitted changes. |
| `threads_create` | `prompt`, `title?`, `cwd?`, `projectId?` | Creates a persistent thread and immediately queues its initial prompt. Working directory and project inherit from the caller when omitted; pass `projectId: null` to clear the project. Targeting a different project or `cwd` than the caller raises a permission card for user approval (Allow / Always allow / Deny) and errors if denied. |
| `request_secret` | `secretName`, `reason`, `force?` | Prompts the user (via a modal) to provide a secret value such as an API key. The value is stored in the OS keychain under the plugin's namespace and injected into future sessions as an environment variable — it never appears in the conversation. On success, the calling thread's live session is also flagged to restart at its next turn (conversation history is preserved via session resume), so the new secret becomes available to *this same thread* right away rather than only in later sessions. Returns `{success: true, secretName, alreadyExisted: boolean}` if the user saves, or `{success: false, reason}` if cancelled. If a secret with the same name already exists, returns `alreadyExisted: true` immediately without prompting. Pass `force: true` to always re-prompt (e.g. when rotating a stale token) — the modal will indicate that the existing value will be replaced. On a thread running on the managed local daemon (opt-in group `secrets`, off by default) the value is also sent to the daemon as that thread's environment and the daemon session restarts; the result is only `{success, secretName, status: "saved" \| "cancelled"}`. See [docs/remote-daemon.md](remote-daemon.md#tools-on-your-computer-host-tools). |
| `watch_document` | `path` | Watches a vault note for content changes, owned by the calling thread. Any subsequent edit — from you, another thread, or a sync — sends this thread an injected alert message referencing the file via an `@[[filename]]` mention. Re-watching an already-watched path is a no-op that keeps the existing watch. See [Watch a document](usage.md#watch-a-document). |
| `unwatch_document` | `path?`, `id?` | Removes a watch owned by the calling thread, by path or watch id (at least one required). Never affects another thread's watch on the same path. |
| `list_watched_documents` | — | Returns the calling thread's own active watches: path, watch id, creation time, and last-alerted time. |

| `github_list_access` | — | Lists the GitHub repositories the connected Geode GitHub App can access (names only, never credentials). Geode ≥ 0.25.0 with GitHub connected; see [GitHub via Geode](github-integration.md). |
| `github_check_repo` | `repo` | Checks whether the Geode GitHub App can access `owner/name`; when it cannot, returns the install URL to grant access. |

### Thread coordination tools

Discover, read, and message other running threads. Project threads coordinate only within their Project; unassigned threads coordinate with unassigned threads. The Portfolio Orchestrator sees unassigned work by default and uses explicit per-call Project elevation for raw Project access. One narrow exception: an unassigned thread may place **itself** into any Project via `threads_set_project`, because nothing else can — that is an escape hatch out of statelessness, not a scope hop, and it does not extend to moving other threads or to a Project thread hopping to a different Project.

| Tool | Parameters | Description |
|---|---|---|
| `threads_get_current` | — | Returns this thread's metadata, live status, project, cwd, PR, schedule origin, raw-log path, and message count. |
| `threads_list` | `projectId?` | Returns authorized thread metadata. Portfolio passes a Project id for one-call elevation. |
| `threads_list_projects` | — | Returns configured projects with `cwdOverride` and resolved `effectiveCwd`. |
| `threads_create_project` | `name`, `vaultFolder`, `description?`, `cwdOverride?` | Creates and persists a project. |
| `threads_update_project` | `projectId`, `name?`, `description?`, `cwdOverride?`, `elevatedProjectId?` | Updates the caller's Project name, context, or cwd override and waits for persistence. Pass `null` for description or cwd override to clear it. Existing threads retain their cwd and live session; future Project threads and dynamic schedules use the updated cwd. Portfolio callers must explicitly elevate to the matching Project. |
| `threads_set_project` | `threadId`, `projectId`, `alignCwd?` | Assigns a thread to a project, or detaches it with `null`. Association-only by default; `alignCwd: true` also switches to a non-null Project's cwd on the next safe turn. Detaching never relocates the thread. An unassigned thread may target **itself** with any Project id; every other caller is still held to normal coordination scope, so a Project thread cannot move itself or anyone else into a different Project. |
| `threads_get_messages` | `threadId`, `limit?` | Returns recent user and assistant messages. |
| `threads_open` | `threadId`, `elevatedProjectId?` | Opens and focuses the exact thread UUID. A successful open marks it reviewed and persists the active selection. |
| `threads_get_log` | `threadId?`, `limit?`, `type?` | Returns parsed raw JSONL event-log entries. |
| `threads_wait` | `threadId`, `timeoutSeconds?` | Waits until a target thread becomes idle. |
| `threads_send_message` | `threadId`, `message` | Queues a message on another thread and triggers it. |
| `threads_archive` | `threadId`, `confirm?`, `elevatedProjectId?` | Saves and removes a completed thread. Archiving any referenced orchestrator requires `confirm: true`. |
| `threads_set_notes` | `threadId`, `notes` | Sets owner-scoped orchestrator tracking notes with source/timestamp provenance. |
| `threads_set_proposed_reply` | `threadId`, `text` | Stages a proposed reply for human approval. |
| `threads_clear_proposed_reply` | `threadId` | Clears a stale proposed reply. |
| `threads_post_decision` | `threadId?`, `question`, `header?`, `options` (2-4), `multiSelect?`, `allowOther?` | Asks Rick to decide, inline on the thread's Agent Board card (default: the calling thread). Rick's answer is delivered to the **calling** thread as a user message, never to the target thread. Returns a `decisionId`. |
| `threads_clear_decision` | `threadId?`, `decisionId` | Withdraws a decision the caller posted. Only the author can clear it. |
| `threads_list_orchestrators` | none | **Portfolio orchestrator only.** Lists the Portfolio and every Project orchestrator as `{ id, kind, title, enabled, threadId, projectId? }`. Any other caller gets an error that discloses nothing. |
| `threads_set_orchestrator_enabled` | `projectId`, `enabled?` (default true), `open?` | **Portfolio orchestrator only.** Enables (creating the thread if needed, idempotent) or disables a Project orchestrator; `open: true` also opens its thread when enabling. The Portfolio itself cannot be disabled. Returns the snapshot. Canonical-only (no `obsidian_` alias); in `NEVER_OFFERED` and the `threads` optional-tool group. |

On the Agent Board, cards show an orchestrator's proposed reply (Approve & Send / Edit / Discard), its read-only notes, pending questions and decisions, and a leading **Needs you** lane (with an **Only needs you** filter) collects every thread waiting on you.

These tools back the **thread-orchestrator** skill, which is supplied by the Threads Orchestrator plugin through `extensions.registerSkill` (core no longer bundles it or runs automatic wake-ups), and which lets one thread supervise several peers: it tracks per-thread notes across polling passes and proposes replies for a human to review rather than sending on a peer's behalf.

**`isRunning` vs `status`:** `status` is a persisted field (`waiting`, `active`, `error`, `archived`, `reconnecting`) that reflects the last known state. `isRunning` is a live flag that is `true` only while Claude is actively streaming a response. Use `isRunning` for coordination decisions; use `status` to filter out archived or errored threads. `reconnecting` is a transient state covering two distinct auto-recovery paths that share the same status and visual treatment (an amber "reconnecting" notice in the conversation, not the red error card): (1) the underlying `claude` CLI transport was force-closed mid-tool-call (a spurious "Stream closed" error, not necessarily a real failure), and the plugin auto-fires one follow-up turn so Claude can verify whether the interrupted action actually succeeded before treating it as an error; or (2) the API rejected the turn with a rate-limit/overload error before it was ever processed, in which case the plugin silently retries the exact same turn after a backoff delay (up to 5 attempts, ~3s–90s) with no new message added to the transcript. If a rate-limited turn exhausts its retries, or any other error occurs, the error card shows a short one-line headline with the full stack trace tucked behind a "Show technical details" disclosure instead of a wall of raw text.

#### Coordination pattern

A typical delegation loop:

1. Call `threads_list` to find a peer, or `threads_create` to create a dedicated one
2. Call `threads_send_message` to assign a task
3. Call `threads_wait` to block until the peer finishes
4. Call `threads_get_messages` to read the result

```
Thread A                              Thread B
  │                                      │
  ├─ threads_list                         │
  ├─ threads_send_message ───────────────►│ (Claude receives message)
  ├─ threads_wait                         │
  │   (polls isRunning every 1s)         ├─ ... processes task ...
  │◄────────────────────────────────────┤ (isRunning → false)
  └─ threads_get_messages                 │
       (reads the result)
```

This pattern works across any combination of threads — you can fan out to multiple peers simultaneously by sending messages to several threads before waiting on any of them.

### Peer-plugin API

Enabled desktop plugins can integrate with Agent Threads through the versioned `plugin.api.v1` surface. API v1 exposes immutable thread and message snapshots, thread create/send/wait/open operations, semantic run and message events, Portfolio/Project orchestrator discovery and dispatch, and a transport-neutral `voice-orchestration` tool bundle. It does not expose mutable thread objects, private view state, settings, secrets, or raw event callbacks.

Peer plugins should verify `apiVersion` and the advertised `capabilities`, listen for the host events `claude-threads:api-ready` and `claude-threads:api-stopping`, and reacquire the API after a plugin reload. Every API generation is revocable: calls through a stale reference fail with `PLUGIN_UNAVAILABLE` instead of operating on a replacement plugin instance.

Orchestrator can use the host's `voice-orchestration` bundle to respond to “Archive [thread name]” and “Mark [thread name] reviewed.” The host advertises `threads.archive` and `threads.markReviewed` and supplies `ct_archive_thread` / `ct_mark_reviewed` only when their implementations are available. Agents must resolve an exact thread ID from discovery and clarify ambiguous names. Start a new voice session after updating the host so its tool schemas are refreshed.

- `threads.archive(threadId)` returns `{ status: 'archived' | 'cancelled', threadId }`. It blocks the last remaining thread and displays a host confirmation dialog for running threads and Portfolio/Project orchestrators. It awaits wakeup cancellation, archive persistence and settings persistence before success. Conversation retention follows **Save threads to vault**; disabling that setting means no archive note is written. A failure can leave wakeups cancelled or a saved archive note; it is reported as an error, never success. If state changes during an archive, retry from fresh discovery.
- `threads.markReviewed(threadId)` returns `{ threadId, reviewed: true, changed }`. It accepts idle live threads, saves the reviewed flag and refreshes the Agents List/Board without opening the thread or changing its recency. Repeated calls return `changed: false`. New work invalidates review state.

These are trusted in-process peer-plugin operations, not the internal assistant MCP tools: MCP Project boundaries and approval prompts do not automatically apply to peers. Archive safety checks are enforced by the host API; a model-supplied confirmation flag cannot bypass the dialog. Orchestrator records the invoked tool, exact target and observed result in its conversation transcript. The internal assistant self-archive policy is unchanged.

The TypeScript contract and structured error codes are defined in [`src/PublicApi.ts`](../src/PublicApi.ts), with the standalone consumer declaration in [`api/public-api-v1.d.ts`](../api/public-api-v1.d.ts). API v1 excludes hard-delete operations, cross-Project elevation, and direct access to private views or runtime sessions.

`api.v1.mcp` lets a peer plugin reuse Agent Threads' own MCP-registration and secret-storage machinery instead of reinventing OS-keychain storage or its own MCP config UI:

- **`mcp.register(input)`** registers a global external MCP server (`stdio`, `http`, `sse`, or `oauth` — same shape as the `mcp_register_server` agent tool). Registration **always** shows the same interactive `McpRegistrationModal` confirmation to the human that the agent tool shows — there is no silent or bypassed path for a peer-plugin caller, including for `stdio` servers that can execute an arbitrary local command. An `oauth` entry goes through the identical OAuth 2.1 + PKCE consent flow (`OAuthMcpRegistry`) as agent-initiated oauth registration. If the host has no interactive context available (e.g. the plugin is unloading), it returns `{success: false, status: 'unavailable', ...}` rather than throwing. Returns the same `McpRegistrationResult` shape (`status`: `registered` | `unchanged` | `conflict` | `invalid` | `cancelled` | `unavailable` | `failed`) documented for `mcp_register_server` above.
- **`mcp.listPresets()`** returns the built-in OAuth MCP presets (the same data behind the Add MCP server modal's chips) as a frozen array of `{ id, label, name, url, scopes?, redirectUri?, requiresClientId, requiresClientSecret, notes?, setupUrl?, source }`. Each call returns fresh frozen copies, so a peer can read but never alter the host's list. Feature-detect with `api.capabilities.includes('mcp.listPresets')` and fall back to your own URLs on hosts that lack it.
- **`mcp.registerPreset(id, overrides?)`** merges a preset with caller overrides (`name`, `scopes`, `tools`, `clientId`, `clientSecret`, `authorizationServerUrl`, `redirectUri`, `audience`; overrides win) and hands the result to the same registration path as `mcp.register`, so validation, the consent dialog and the `registered` / `unchanged` / `unavailable` results are identical. `url`, `type` and `grantType` belong to the preset and cannot be overridden — use `mcp.register` for a custom server. `clientSecret` still must be a `${NAME}` placeholder for a secret saved with `mcp.requestSecret`. It throws `INVALID_ARGUMENT` for an unknown id, a non-overridable field, or a preset with `requiresClientId: true` and no `clientId` override. Feature-detect with `'mcp.registerPreset'`.
- **`mcp.requestSecret(input)`** prompts the user, via the same `RequestSecretModal` the `request_secret` agent tool uses, to provide a credential. The value is stored directly in the OS keychain under the plugin's namespace and is **never returned to the caller** — only `{success: true, secretName, alreadyExisted}` or `{success: false, reason}`. If a secret with that name already exists, it short-circuits with `alreadyExisted: true` without prompting again, unless `force: true` is passed.

### Vault Bridges integration

If you have the [Vault Bridges](https://github.com/rbcodelabs/obsidian-vault-bridges) plugin installed, Claude agents can inspect and configure bridges directly via MCP — no config-file editing or host restart required.

| Tool | Parameters | Description |
|---|---|---|
| `vault_list_bridges` | — | Returns all currently configured bridges. Agents should call this first to check what already exists before adding a new one. |
| `vault_add_bridge` | `name`, `repoPath`, `vaultPath`, `sourcePath?`, `branch?`, `autoSync?`, `syncNow?` | Adds a new bridge live via the Vault Bridges API. The bridge is registered immediately and duplicate repo/vault pairs return the existing bridge. |

Both tools return a clear error if the vault-bridges plugin is not installed or not enabled.

#### Bridge-aware edits

When an agent edits files inside a bridged repo (rather than the synced vault copy), Agent Threads detects it automatically at the end of the turn:

- **Auto-pull** — each affected bridge is synced once per turn, so the vault copies update immediately (a notice confirms success or failure).
- **Vault-relative links** — edited-file chips, the focus button, and absolute repo paths in Claude's messages all resolve to the synced vault note: chips show the vault path and open the note in the host workspace, and message paths become clickable internal links (only when the vault copy exists).

Edits made directly to vault files are unaffected — they don't match any bridge root and behave as before. Note that edits made inside a temporary coding-task worktree only reach the vault after merge plus a normal bridge pull.

### Skills Manager tools

Everything the [Skills Manager](usage.md#skills-manager) panel can do — browse the [skills.sh](https://skills.sh) registry, inspect installed skills and configured sources, check for updates, install, uninstall — is also available to agents via MCP, so a thread can manage its own skill packages without a human clicking through the UI.

| Tool | Parameters | Description |
|---|---|---|
| `skills_list_installed` | — | Lists skills with their qualified identifier, name, description, path, origin (`local`, `vault`, or `home`), and edit/remove permissions. |
| `skills_search` | `query`, `limit?` | Searches the skills.sh marketplace registry. Returns each match's name, slug, GitHub source, install count, and whether it's already installed. Default limit: 15. |
| `skills_get` | `identifier` | Returns full detail for one skill, whether installed or not. Pass an installed skill's name, or a marketplace slug in `owner/repo/skill-id` form (as returned by `skills_search`). Installed skills include their full `SKILL.md` content. |
| `skills_list_sources` | — | Lists configured skill sources (GitHub-cloned or local-path plugin sources) plus the built-in skills.sh registry, with id, name, type, and (for GitHub sources) staleness info. |
| `skills_check_updates` | — | Checks every configured GitHub-type skill source for upstream commits it's behind (fetches each source; `behindCount` is 1 when upstream has moved, since clones are shallow). Returns each source's id, name, and either its refreshed `behindCount`/`lastFetched` or an `error` if the check failed (e.g. offline). |
| `skills_install` | `slug`, `skillId`, `source`, `name` | Installs a skill from the marketplace into `<vault>/.obsidian/plugins/claude-threads/skills/`. Pass the four fields exactly as returned by `skills_search` for the skill you want. |
| `skills_uninstall` | `name` | Permanently deletes an installed or authored vault package. Use its qualified identifier to distinguish duplicate names. Home skills remain read-only. |
| `skills_create_local` | `skillId`, `skillMd`, `files?` | Creates a complete authored package in the configured vault folder, available in new sessions. Rejects existing packages. |
| `skills_update_local` | `skillId`, `files?`, `deleteFiles?` | Patches an authored package; preserves omitted files and protects `SKILL.md` from deletion. |
| `skills_update` | `sourceId` | Pulls the latest commits for a configured GitHub-type skill source (fast-forwards its local clone), refreshing every skill it provides. Use the source id from `skills_list_sources` — not `"registry"`, which has no single-source update (reinstall individual skills instead). |


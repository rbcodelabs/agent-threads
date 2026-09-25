# Architecture Notes

## Key Files

| File | Purpose |
|---|---|
| `src/main.ts` | Plugin entry point, MCP server wiring, thread serialization for MCP tools |
| `src/SettingsTab.ts` | Settings panel (tabbed: General / Claude / Tools / Vault / Features / Remote) + key/secret modals |
| `src/ThreadManager.ts` | Thread lifecycle, events, persistence coordination |
| `src/ThreadsView.ts` | Main conversation panel UI |
| `src/AgentDashboard.ts` | Agent dashboard sidebar panel |
| `src/KanbanView.ts` | Kanban board view |
| `src/ObsidianTools.ts` | All MCP tool definitions and TypeScript interfaces |
| `src/skillManager.ts` | Headless list/search/install/uninstall/update logic for `~/.claude/skills/` and configured `SkillSource`s — single source of truth for both `SkillsManagerView.ts` (UI) and the `skills_*` MCP tools in `ObsidianTools.ts` |
| `src/chiefOfStaffOnboarding.ts` | Pure first-run decision logic and the dependency-injected `setUpChiefOfStaff()` flow (spec §10): new vs upgrading install, the "Offer Chief of Staff on first run" setting, adding the `rbcodelabs/chief-of-staff` skill source, clone/harness/thread failure → static-guide fallback, and the idempotent "Set up Chief of Staff" command (home thread id in `settings.chiefOfStaffThreadId`). The pack is cloned at `CHIEF_OF_STAFF_REF` (a tag, recorded as `SkillSource.ref`), **bumped per plugin release** — see `process/release.md` Step 3; pinned sources report as current and "Pull updates" re-syncs them to the ref. The thread runs on Claude or Codex, never OpenCode (its sessions do not load skill sources). No Obsidian/Node deps |
| `src/SkillsManagerView.ts` | Skills Manager panel UI — delegates all list/search/install/uninstall/update logic to `src/skillManager.ts` |
| `src/VaultPersistence.ts` | Vault note save/load/archive |
| `src/types.ts` | Shared TypeScript types (`Thread`, `ThreadStatus`, etc.) |
| `src/DispatchInput.ts` | Reusable dispatch textarea component used across all panels |
| `src/slashCommands.ts` | Single source of truth for built-in slash commands, model aliases, and dispatch directive parsing |
| `src/Scheduler.ts` | Built-in scheduler for cron items and `/loop` recurrences, persisted in `settings.scheduledItems` |
| `src/statusLine.ts` | Pure parser for `statusLineCommand` output (JSON tags or legacy plaintext → `StatusTag[]`) + `derivePrUrl`/`resolveTagIcon`/`planFooter`. No Obsidian/Node deps |
| `src/gitDiffUtils.ts` | Pure helpers for the git diff bar: `parseShortStat`, `parseRemoteToOwnerRepo`, `buildComparePrUrl`, plus `gitDiffBarVisible`/`parsePrNumber`/`prButtonLabel`. No Obsidian/Node deps |
| `src/StatusLineService.ts` | Desktop-only service that polls `statusLineCommand` per thread cwd (coalesced, capped, cached, idle-paused) and writes `statusTags` + derived `prUrl`. See `docs/adr/0001-structured-status-line-tags.md` |
| `src/HarnessSession.ts` | Provider-neutral harness contract (`HarnessSession`, `HarnessPermissionMode`, `HarnessMcpServerConfig`, `HarnessContextUsage`). Adapters map their native types at the boundary |
| `src/HarnessFactory.ts` | Picks the adapter from `thread.agentHarness`: `ThreadSession` (Claude), `CodexSession`, `OpenCodeSession` |
| `src/OpenCodeSession.ts` | OpenCode adapter over a per-session `opencode serve` (HTTP + SSE). Pure mapping helpers are exported for tests. See `docs/adr/0013-opencode-harness.md` |
| `src/OpenCodeHostTools.ts` | Token-guarded loopback MCP endpoint that serves host tools to OpenCode |
| `src/sandboxVm.ts` | Sandbox VM command construction + lifecycle (`SandboxVmManager`) behind Apple's `container` CLI. Pure helpers plus an injectable command seam; no top-level Node requires |
| `sandbox/Dockerfile` | Image for the sandbox VM — `node:22-bookworm-slim` + git, ripgrep, jq, curl, wget, build-essential, python3, openssh-client. Non-root `node` (uid 1000), `WORKDIR /work`, no secrets baked in |

---

## Agent Harnesses

`AgentHarness` (`src/types.ts`) is `'claude' | 'codex' | 'opencode'`; use `AGENT_HARNESSES`, `isAgentHarness` and `agentHarnessLabel` instead of enumerating names. ThreadManager only talks to `HarnessSession`, built by `createHarnessSession()`. Every session callback goes through ThreadManager's generation fence (ADR-0012), so a new adapter gets switching safety without extra work.

**OpenCode (ADR-0013).** One `opencode serve` per session, launched from `opencodeBinaryPath` with per-session config in `OPENCODE_CONFIG_CONTENT`:
- Events: `message.part.delta` → `onToken` (assistant text parts only); completed text part → `onMessage`; tool part `running`/`completed`/`error` → `onToolUse`/`onToolResult` (+ `onFilesEdited` for edit tools); `step-finish` → context usage and cost; `todo.updated` → task tracker; `session.idle` after `busy` → `onDone`; `session.error` `MessageAbortedError` → `onInterrupted`.
- Permissions: config asks for everything but read-only tools; `resolveOpenCodePermission()` answers each `permission.asked` from the live permission mode. Child sessions created by the `task` tool are tracked so their prompts are not dropped.
- Host tools: `OpenCodeHostToolsBridge` registers as remote MCP server `agent-threads` (tools appear as `agent-threads_<tool>`; OpenCode is told to allow them and the bridge applies `resolveDynamicToolApproval`).
- The screenshot harness aliases `http` to a throwing stub (`test/harness/mocks/http.ts`) because ThreadManager pulls the adapter into the bundle.

## Sandbox VM Tools (`enter_vm` / `vm_exec` / `exit_vm`)

Runs a thread's **commands** inside a lightweight Linux VM while file editing stays on the host.

The agent's `Read`/`Write`/`Edit`/`Bash` tools run on the host, so the sandbox cannot own the filesystem. Instead `enter_vm` bind-mounts the thread's effective cwd into the guest at `/work` and `vm_exec` runs commands there. Host edits are visible inside the VM immediately — no sync step, no divergence.

Backed by Apple's `container` CLI (macOS 26+, Apple silicon), where each container is its own VM with a separate kernel and no view of the host filesystem beyond that mount.

**Setup:** `brew install container` → `container system start` → build the image:

```sh
container build --tag claude-threads-coding:1 sandbox/
```

**Networking.** `default` is **full egress** by explicit product decision — `npm install`, git remotes and web access have to work out of the box. `internal` attaches a shared `--internal` network (host reachable, no internet), created on demand; `none` passes `--network none`.

**Settings.** `vmImage` and `vmDefaultNetwork`, read lazily through `getVmImage` / `getVmDefaultNetwork` so a change applies on the next call rather than needing a session restart.

**Execution boundaries.** The mount is read-write and edits persist. Host shell/file
tools are not redirected. Internal-network reuse verifies `configuration.mode`
is `hostOnly`. Commands use guest GNU `timeout` with a five-second kill grace;
the host CLI deadline includes ten seconds of transport grace. See
[`docs/sandbox-vms.md`](../docs/sandbox-vms.md) for setup and limitations.

**No `Thread` field.** The container name is derived deterministically from the thread ID (`claude-threads-vm-<sanitized-id>`), so a container started before a plugin reload is still findable, adoptable by `vm_exec`, and removable by `exit_vm` afterwards. That gets persistence across reloads without persisting ephemeral OS state on the thread.

**Mobile.** `sandboxVm.ts` requires `child_process` inside the runner closure only, so importing it is inert. Every tool returns a clean `{ success: false, error }` with a `brew install container` hint when the CLI is unavailable — it never throws and never affects plugin load.

---

## Session Input-Stream Lifetime & Lingering Sessions

`ClaudeSession.run()` (`src/ClaudeSession.ts`) always drives the Agent SDK's `query()` with an async-generator prompt, never a plain string. This matters because of an SDK internal: passing a string sets `isSingleUserTurn`, which force-closes stdin — the *only* channel carrying permission responses (`canUseTool`, `AskUserQuestion`, `ExitPlanMode`) — the instant the first `result` event arrives. That's fine for a single-generation turn, but background tasks keep the CLI subprocess alive past the first result to stream further generations (routine now — Bash tasks backgrounded via `run_in_background`, workflow/subagent tasks, etc.), and those generations need a working permission channel too. With a string prompt, every later permission round-trip on such a turn was force-rejected with `Stream closed`, even though the CLI process was still very much running.

The fix: the generator yields its one message, then `await`s an internal release promise before returning. Completing the generator (returning) is what makes the SDK call `transport.endInput()` — so *we* control exactly when stdin closes, instead of the SDK closing it unconditionally at the first result. `ClaudeSession` tracks:
- **Pending tasks** (`pendingBgTaskIds`): `task_started` → add; a terminal `task_updated` status or `task_notification` → remove. A non-empty set at `result` time means the CLI is still doing work, so the channel stays open.
- **Notification-in-this-window** (`sawTaskNotificationSinceLastResult`): set by `task_notification`, cleared after every `result`. Verified live against the real CLI: a fast background Bash task can start, finish, *and* notify entirely before the first `result` — so an empty pending set alone is not a sufficient release signal, since the follow-up generation that actually reacts to the notification still streams afterward. Releasing requires one full `result` with **no** new notification since the previous one.

Only when both are clear does the `result` handler release the generator, re-checked on every subsequent `result` the same `run()` call sees. `endInput()` is exposed publicly so a caller can force the release; the `finally` block always releases it too, so no run ever leaks a pending promise. Worst case (a task that never produces a further generation after all) this holds a session open longer than strictly necessary — bounded by `ThreadManager`'s `LINGER_MAX_MS` safety cap below, and invisible to the user since the thread already reads as idle (`onDone` already fired).

Because a turn can now legitimately outlive its first `result` (thread looks idle, `ThreadManager.sessions` no longer has an entry for it), `ThreadManager` tracks **lingering sessions** separately (`lingeringSessions: Map<threadId, ClaudeSession>`), populated in the `onDone` callback and cleared once `session.run()` actually resolves:
- `sendMessage()` checks for a lingering session before starting a new one and gracefully unwinds it first (`endInput()`, poll briefly for the natural unwind, hard `close()` as a fallback) — otherwise two CLI processes could end up resuming the same session id concurrently.
- `interrupt()` falls back to `lingeringSessions` so Stop still works during generation 2+.
- A `LINGER_MAX_MS` (10 min) safety cap force-ends the input stream if a session lingers unreasonably long; the existing `pendingBackgroundTasks` poll remains the fallback for any task that outlives it.
- `isRunning`, `getRunningThreads`, `deleteThread`, `gracefulShutdown`, and `destroy` all treat a lingering session as still "running" so reload/shutdown guards and cleanup don't leak an orphaned process.

---

## Thread Type (`src/types.ts`)

Key fields worth knowing:

| Field | Notes |
|---|---|
| `prUrl?: string` | URL of the thread's GitHub PR. **Derived** by `StatusLineService` from `statusTags` (a `kind:'pr'` tag or `/pull/N` url) — no longer scanned from assistant prose. **Sticky**: only overwritten when a poll finds a PR, never cleared on absence, so the release archive-on-merge flow still matches after merge. Surfaced in `obsidian_list_threads` / `obsidian_get_current_thread`. |
| `statusTags?: StatusTag[]` | Context-footer pills for this thread, set by `StatusLineService` from the `statusLineCommand` output (JSON tags or legacy plaintext, see `src/statusLine.ts`). **Ephemeral** — stripped before persisting to data.json, re-derived each poll; `undefined` on mobile / no script. |
| `titleUserSet?: boolean` | When `true`, the auto-titler will not overwrite the thread's title. Set to `true` only when the user explicitly renames the thread (not on blur/escape with no change). |
| `noteFile?: string` | Vault-relative path of the saved vault note. Used by `VaultPersistence` to detect and delete stale files when the title changes. |
| `cwd?: string` | Working directory for the Claude process. Auto-repaired via `originRepoPath` (if present and still on disk) or else the nearest valid ancestor if the original worktree path no longer exists. |
| `originRepoPath?: string` | Git root of the origin repo a worktree `cwd` was cut from, captured by `enter_worktree` (cleared by `exit_worktree`). Lets project-name resolution (`resolveThreadProjectName` in `pathUtils.ts`) and `ThreadManager.repairStaleCwds()` recover even after the worktree directory itself is deleted. |
| `projectNameOverride?: string` | Display-only project name backfilled by `ThreadManager.backfillLegacyProjectNames()` from `prUrl` for threads orphaned *before* `originRepoPath` existed. Last-resort input to `resolveThreadProjectName()` — never used to derive a real path. |
| `model?: string` | Per-thread model alias set via `/model` (fable, opus, sonnet, haiku). Falls back to the `defaultModel` setting, then the CLI default. |
| `permissionMode?: string` | Per-session permission mode override. One of `'default'`, `'acceptEdits'`, `'bypassPermissions'`, `'plan'`, `'dontAsk'`, `'auto'`. Falls back to `settings.permissionMode`. Scheduler-created sessions automatically receive `'dontAsk'` so cron jobs never stall on a permission dialog. |
| `goal?: string` | Persistent goal set via `/goal`. Injected into the appended system prompt every turn until cleared with `/goal clear`. |
| `rawLogPath?: string` | Vault-relative path to the thread's raw JSONL conversation log (`<vaultFolder>/logs/<thread_id>.jsonl`), written by `RawLogWriter` when the `saveRawLogs` setting is on. Keyed by the stable thread UUID so it never orphans on rename. Read back via the `obsidian_get_thread_log` MCP tool. |

---

## MCP Tool Serialization

`ThreadSnapshot` in `src/ObsidianTools.ts` defines the JSON shape returned by `obsidian_list_threads` and `obsidian_get_current_thread`.

When adding a field to `Thread`:
1. Add it to `ThreadSnapshot` in `ObsidianTools.ts`
2. Add it to both serializers in `main.ts`: `getThreadDetail` and `getAllThreads`
3. Update the tool description strings in `ObsidianTools.ts` to mention the new field

---

## Dispatch Command Directives

The dashboard/kanban dispatch boxes intercept leading `/model`, `/goal`, and `/loop` commands before creating a thread. The flow:

1. `parseDispatchDirective(text)` in `slashCommands.ts` returns a discriminated union (`kind: 'model' | 'goal' | 'loop'`, or `null` for plain prompts). A set `error` field means "recognized command, bad args" — the views show a Notice, restore the draft via `DispatchInput.setValue`, and create nothing.
2. Both views map the directive to `dispatchNewThread(text, images, titleHint, opts)` where `opts` is `{ model?, goal?, loop? }`.
3. `dispatchNewThread` applies the option **before** the first `sendMessage`: `setThreadModel` / `setThreadGoal` / `scheduler.createItem({ targetThreadId })`. For loops, the dispatch itself is iteration 1 — the scheduler's first fire is `now + interval`.

Invariants to preserve:
- `DISPATCH_BUILTIN_COMMANDS` is an allowlist — only commands the dispatch flow actually intercepts may be advertised (enforced by `test/unit/slash-commands.test.ts`). Thread-scoped commands (`/compact`, `/clear`, `/cost`) and management variants (`/goal clear`, `/loop stop`) must not appear there.
- The goal kickoff message comes from `goalKickoffMessage()` — shared by ThreadsView and the dispatch path so the two never drift.
- `MODEL_ALIASES` is the only alias map; ThreadsView and dispatch both import it.

---

## Agent-initiated Design

`EnterDesignMode({ brief })` is registered in the shared MCP catalog, so Claude
and Codex use the same handler and validation. The host binds it to the calling
thread ID; no target thread or artifact path is accepted. It is a mutating tool,
with an additional host guard for read-only Plan mode and pending plan approval.

The tool and in-thread `/design` command share `enterDesignMode` in
`src/designArtifact.ts`. Per-thread serialization covers preparation, persistence,
and preview opening. Metadata is prepared separately, attached before saving, and
restored if saving fails; scaffold files remain retryable. Thread existence is
checked after asynchronous work. A preview failure leaves the saved artifact intact
and returns an explicit `source-revealed` or `unavailable` outcome.

The tool returns `{ artifact, created, preview, instructions }` for the current
turn. It does not send another message or change session cwd. The composer still
owns its design kickoff message. New-thread dispatch retains its provisional-thread
rollback behavior. Artifact controls are refreshed even when the calling thread was
already selected; successful preview results require the actual artifact view type.

## DispatchInput Component

`DispatchInput` only renders the bottom footer row (attach button, mic button) when either `showCwdChip` or `appendFooterActions` is passed. If you want the footer layout without other chips (e.g. in AgentDashboard), pass `appendFooterActions: () => {}` as an empty callback — this sets `needsFooter = true` internally.

---

## Screenshot Harness

The harness (`test/harness/`) renders the plugin against fixture data without a live Obsidian or Claude process. Fixtures live in `test/harness/fixtures.ts`.

New UI states need:
1. A fixture entry that seeds the relevant data/state
2. A new test case in `test/screenshots/ui.spec.ts` with the right setup (hover, `page.evaluate`, etc.)

Flows that require a live session (PTT recording, background task completion, permission modals from real tool calls) cannot be tested in the harness and are intentional skips.

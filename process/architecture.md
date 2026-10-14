# Architecture Notes

> **ADRs live in Compass, not this repo.** Architecture Decision Records for this
> plugin are Compass docs in the "Claude Threads" workspace, nested under
> [Architecture Decision Records](https://compass.rbcodelabs.com/rbcodelabs/claude-threads/docs/5e7c4e86-3075-4417-992d-3251ec3ecc33).
> `docs/adr/` no longer exists in the repo (migrated 2026-09-27). Create new ADRs
> as Compass docs nested under that parent, not as new files here.

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
| `src/StatusLineService.ts` | Desktop-only service that polls `statusLineCommand` per thread cwd (coalesced, capped, cached, idle-paused) and writes `statusTags` + derived `prUrl`. See [ADR-0001](https://compass.rbcodelabs.com/rbcodelabs/claude-threads/docs/445c5f26-1091-4147-8750-0ecfa9b16e40) |
| `src/browserSession.ts` | Pure logic for the chat's **browser session card**: `browserToolSummary`/`parseBrowserToolResult` (what a browser tool call records — url/title/error only, never page content or typed text), the session view-model (`navigating`/`live`/`finished`/`error`/`ended` + the handoff overlay `requested`/`control`/`returned`/`expired`), FIFO screenshot assignment (`assignBrowserScreenshots`: the image for a `browser_screenshot` lands on the NEXT assistant message, so pairing is across rows), and live/last-session detection. Only imports `toolNameUtils`, so it is mobile-bundle safe. Sessions come from `groupToolCalls()` (`{kind:'browser'}` entries, carved out before activity grouping and never smoothed into a group); v1 limitation: a non-browser tool between two browser calls starts a new card |
| `src/BrowserSessionCard.ts` | DOM layer for one card (`renderBrowserSessionCard`) plus the screenshot lightbox `Modal`. Pure presentation over a view-model; returns a handle for in-place frame/countdown updates |
| `src/BrowserSessionPresenter.ts` | View-side glue owned by `ThreadsView`: per-render context (live session, screenshot, handoff overlay), expand/step state, standalone handoff card, composer chip / placeholder / aria-live announcements, focus preservation across row rebuilds |
| `src/agentBrowser/LoginHandoffController.ts` | Plugin-owned login "Take control" state machine ([ADR-0014](https://compass.rbcodelabs.com/rbcodelabs/claude-threads/docs/e9540afa-52a5-485e-865d-93114b8016a9)): per-thread `requested → active → returned/expired`, the Geode popup bridge subscription, the 250ms frame capture loop (only while a visible viewer is attached) and pointer/keyboard forwarding. Shared by `AgentBrowserPreviewView` and the chat card. **Privacy invariant:** login-page frames/keystrokes live only in this object's memory and the DOM — never in a transcript, `toolResultImages`, settings, logs or MCP results (pinned by `test/unit/login-handoff-controller.test.ts` and `browser-session-presenter.test.ts`) |
| `src/GoogleWorkspaceMcp.ts` | Loopback proxy in front of Google's hosted Docs/Drive/Sheets/Slides MCP servers, with per-thread capability tokens and revocation tied to the Google Docs Sync refresh-token fingerprint. Transport only for the four vendor routes; the extra `/drive-files` route (server `google-drive-files`, shares the Drive capability, POST only) is answered locally by `GoogleDriveFiles.ts` with a 6 h timeout and SSE keepalives. Roots for the file tools come from the constructor's `rootsForThread` (thread cwd + vault, wired in `main.ts`) |
| `src/GoogleDriveFiles.ts` | Large-file Drive transfers: `upload_local_file` (resumable 8 MiB chunks, offset-query resume, session URI pinned to googleapis.com, bearer token never sent with chunk PUTs) and `download_to_local_file` (streamed to a `.part` temp file then renamed, size-verified, native files exported). `resolveInRoots` is the path sandbox: realpath containment, `.obsidian`/`.git` blocked, `/work` VM alias. Pure JSON-RPC handler `handleDriveFilesRpc` and an injectable `DriveHttp` seam for tests |
| `src/HarnessSession.ts` | Provider-neutral harness contract (`HarnessSession`, `HarnessPermissionMode`, `HarnessMcpServerConfig`, `HarnessContextUsage`). Adapters map their native types at the boundary |
| `src/HarnessFactory.ts` | Picks the adapter from `thread.agentHarness`: `ThreadSession` (Claude), `CodexSession`, `OpenCodeSession` |
| `src/OpenCodeSession.ts` | OpenCode adapter over a per-session `opencode serve` (HTTP + SSE). Pure mapping helpers are exported for tests. See [ADR-0013](https://compass.rbcodelabs.com/rbcodelabs/claude-threads/docs/d7b8c236-d8ac-48a4-a8e4-6524ff74e886) |
| `src/OpenCodeHostTools.ts` | Token-guarded loopback MCP endpoint that serves host tools to OpenCode |
| `src/sandboxVm.ts` | Sandbox VM command construction + lifecycle (`SandboxVmManager`) behind Apple's `container` CLI. Pure helpers plus an injectable command seam; no top-level Node requires |
| `src/githubCredentials.ts` | Geode GitHub connection broker: bridge over `window.geode.githubAuth`, actionable error codes, commit identity (noreply default), `GithubTokenPublisher` (refresh timer, clears the sink on failure/disconnect), redaction. Pure — no Obsidian/Node deps |
| `src/githubCredentialHelper.ts` | Generated git credential helper + `gh` wrapper scripts, container install/write/clear shell commands, host `GIT_CONFIG_*` env. Pure string builders, tested by executing them |
| `src/githubVmDelivery.ts` | `VmHooks` that install/refresh/remove the token file in a thread's sandbox VM (token over exec stdin only) |
| `src/githubHostDelivery.ts` | Host-side runtime dir + 0600 token file + synchronous `resolveEnv(cwd)` for session env. See [docs/github-integration.md](../docs/github-integration.md) |
| `sandbox/Dockerfile` | Image for the sandbox VM — `node:22-bookworm-slim` + git, ripgrep, jq, curl, wget, build-essential, python3, openssh-client. Non-root `node` (uid 1000), `WORKDIR /work`, no secrets baked in |
| `src/harnessVmRouting.ts` | ADR-0015: decides whether a thread's Claude harness process routes into its sandbox container (`resolveClaudeVmRouting`, capability checks), builds the `container exec` argv for the containerized CLI process, and redacts secrets from any logged argv by content match |
| `src/skillMounts.ts` | Pure (fs injected) skill exposure for VM-routed Claude sessions: `planSkillMounts` realpaths plugin roots plus `~/.claude/skills`/`agents` into deterministic read-only guest mounts (`/skills/<name>-<hash>`, `/home/node/.claude/...`, escaping symlink targets), `mountSignature` (container label for stale-mount detection), `rewritePluginsForGuest` (host `opts.plugins` -> guest paths, dropping unmounted ones). Applied by `ThreadSession` only when routed; host-local sessions untouched. Mounts are fixed at `container run`; `ensureHarnessContainer` recreates only an untracked, harness-labelled container with a different signature — see `docs/sandbox-vms.md` |
| `sandbox/Dockerfile.harness` | `FROM claude-threads-coding:1` + the native Claude Code installer. Separate, opt-in image tag (`claude-threads-harness:1`) so building the coding image alone never enables VM-hosted harnesses |
| `src/sandboxImage.ts` | Image pipeline: `ensureSandboxImages` pulls the published base image (`ghcr.io/rbcodelabs/claude-threads-sandbox:<v>`), tags it `claude-threads-coding:1` (an existing image is kept only if current; a stale one is re-pulled, which also forces a harness rebuild), then builds the embedded harness Dockerfile locally (adds the Claude CLI, stamps the `com.rbcodelabs.claude-threads.image-version` label). `getSandboxImageStatus` reports `ok/missing/stale` plus per-image `detail` (label version, missing tools): an image is `stale` if its label is older OR a tool probe (`container run <img> sh -c 'command -v gh git [claude]'`, cached by image id) shows it lacks `gh`/`git`/`claude`, so an unlabeled gh-less local `:1` is upgraded while an unlabeled complete one is treated as a user build. `checkImageHealth` produces the one-line warning shown at VM start (`resolveClaudeVmRouting` -> `onImageWarning` -> transcript notice; `SandboxVmManager.enter` -> note); `ensureSandboxImages` re-probes after the build and throws step `verify` if a tool is still missing. All commands go through `VmCommandRunner` |
| `sandbox/IMAGE_VERSION` + `.github/workflows/publish-sandbox-image.yml` | Base-image version (integer, bumped only when `sandbox/Dockerfile` changes; must equal `SANDBOX_IMAGE_VERSION`) and the workflow that publishes it to ghcr on push to `main`. Published tags are immutable. The Claude CLI is deliberately NOT in the published image (no redistribution grant). **Owner step:** set the ghcr package to Public after the first publish |

---

## Agent Harnesses

`AgentHarness` (`src/types.ts`) is `'claude' | 'codex' | 'opencode'`; use `AGENT_HARNESSES`, `isAgentHarness` and `agentHarnessLabel` instead of enumerating names. ThreadManager only talks to `HarnessSession`, built by `createHarnessSession()`. Every session callback goes through ThreadManager's generation fence ([ADR-0012](https://compass.rbcodelabs.com/rbcodelabs/claude-threads/docs/61af3355-8c96-4676-8dd7-07f6bd9f648e)), so a new adapter gets switching safety without extra work.

**OpenCode ([ADR-0013](https://compass.rbcodelabs.com/rbcodelabs/claude-threads/docs/d7b8c236-d8ac-48a4-a8e4-6524ff74e886)).** One `opencode serve` per session, launched from `opencodeBinaryPath` with per-session config in `OPENCODE_CONFIG_CONTENT`:
- Events: `message.part.delta` → `onToken` (assistant text parts only); completed text part → `onMessage`; tool part `running`/`completed`/`error` → `onToolUse`/`onToolResult` (+ `onFilesEdited` for edit tools); `step-finish` → context usage and cost; `todo.updated` → task tracker; `session.idle` after `busy` → `onDone`; `session.error` `MessageAbortedError` → `onInterrupted`.
- Permissions: config asks for everything but read-only tools; `resolveOpenCodePermission()` answers each `permission.asked` from the live permission mode. Child sessions created by the `task` tool are tracked so their prompts are not dropped.
- Host tools: `OpenCodeHostToolsBridge` registers as remote MCP server `agent-threads` (tools appear as `agent-threads_<tool>`; OpenCode is told to allow them and the bridge applies `resolveDynamicToolApproval`).
- The screenshot harness aliases `http` to a throwing stub (`test/harness/mocks/http.ts`) because ThreadManager pulls the adapter into the bundle.

## Sandbox VM Tools (`enter_vm` / `vm_exec` / `exit_vm`)

Runs a thread's **commands** inside a lightweight Linux VM while file editing stays on the host.

The agent's `Read`/`Write`/`Edit`/`Bash` tools run on the host, so the sandbox cannot own the filesystem. Instead `enter_vm` bind-mounts the thread's effective cwd into the guest at `/work` and `vm_exec` runs commands there. Host edits are visible inside the VM immediately — no sync step, no divergence.

Backed by Apple's `container` CLI (macOS 26+, Apple silicon), where each container is its own VM with a separate kernel and no view of the host filesystem beyond that mount.

**Setup:** Settings → Claude → **Set up sandbox** (`sandboxSetup.ts` orchestrates `sandboxRuntime.ts` install/start and `sandboxImage.ts` pull/build; UI in `sandboxSetupPanel.ts`, pure text in `sandboxSetupView.ts`, in-thread offer gating in `sandboxSetupPrompt.ts`). Manual fallback: `brew install container` → `container system start` → build the image:

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

## Harness-in-VM Routing (ADR-0015)

Claude-only for now (Codex/OpenCode explicitly deferred — OpenCode's MCP loopback bridge has an unresolved network-reachability gap once `opencode serve` runs inside the container's own namespace; see the ADR §5). Runs a thread's `claude` CLI process **inside** its sandbox container instead of on the host, so a supported Mac only needs Apple's `container` runtime — not a host `claude` install.

**Settings** (`harnessVmMode: 'auto' | 'always' | 'never'`, default `'auto'`; `harnessVmImage`, default `claude-threads-harness:1`). `'auto'` routes into the VM only when all three of: platform is macOS/arm64, `SandboxVmManager.probe()` succeeds, and the harness image exists (`SandboxVmManager.imageExists()`, `container image inspect`) — `checkHarnessVmCapability()` in `harnessVmRouting.ts`. `'always'` forces routing and **throws** instead of silently falling back if any check fails. `'never'` is today's host spawn, unchanged. A mode change or freshly-built image takes effect on the thread's *next* fresh session `start()`, never mid-session — routing is decided once per `ThreadSession.start()` call.

**Wiring.** `ThreadManager.buildClaudeVmRoutingInputs()` attaches `HarnessSessionOptions.claude.vm` (a `ClaudeVmRoutingInputs`) only for Claude threads when `harnessVmMode !== 'never'`. `ThreadSession.start()` calls `resolveClaudeVmRouting()` before building `sdkOptions`; when routed, it sets `sdkOptions.pathToClaudeCodeExecutable` to the container-side path (`/home/node/.local/bin/claude`) and supplies `sdkOptions.spawnClaudeCodeProcess`, which shells out to `container exec --interactive --workdir /work <containerName> <command> <args...>` via a plain `child_process.spawn` on the host — a `ChildProcess` already satisfies the SDK's `SpawnedProcess` interface, and the SDK's `signal` forwards straight into `spawn(..., { signal })`.

**Host-loopback MCP bridge.** `HostMcpSdkBridge` connects on the host to the
token-guarded OAuth/Google loopback brokers and presents their tools as an SDK
MCP server over the Agent SDK control channel. `ThreadManager` builds ordinary
and VM-specific Claude rosters together; `ThreadSession` selects the VM roster
only after routing succeeds, so host fallback, Codex and OpenCode retain the
ordinary serializable configs. Bridges are stable per thread/server and are
disposed by the existing retained-thread sweep and plugin unload. Only tools are
advertised and forwarded; unsupported MCP capabilities fail closed. A failed
`tools/call` is never retried because its side effects may already have occurred.

**Secret scoping is a hard requirement, not a convention.** `sdkOptions.env` for the VM-routed case is built WITHOUT the `...process.env` spread the host path uses — just `CLAUDE_CODE_ENABLE_TODO_TOOLS` + `parseExtraEnv(extraEnvRaw)` + `secretEnv` — and those ride `--env` flags scoped to the harness's own `container exec` invocation only, never `container run`. Forwarding the full host environment, or setting secrets at `run` scope, would leak them to any `vm_exec` command sharing the same container. Any logged exec argv is redacted by **content match** (`redactSecretsInArgv()`), never by array index — a positional slice was the exact bug an early spike hit (see the ADR's "Spike Results").

**One container per thread, shared with `enter_vm`/`vm_exec`/`exit_vm`.** `main.ts` passes `ThreadManager.getSandboxVmManager(threadId)` into `createClaudeThreadsMcpServers`'s options as `sandboxVmManager`, and `ThreadManager` passes the same instance into `ClaudeVmRoutingInputs.vmManager` — the SAME `SandboxVmManager` object backs both, so container ownership is tracked consistently rather than split across two objects that can't see each other's state. `SandboxVmState.origin` (`'agent' | 'harness'`) records who is responsible: `ensureHarnessContainer()` (called from `resolveClaudeVmRouting`) creates-or-adopts the container and marks it `'harness'`; `enter()` attaches to an already-harness-owned container instead of reporting a collision; `exit()` refuses to remove a harness-owned container unless called with `{ allowHarnessOwned: true }` — reserved for `ThreadManager.deleteThread()`'s own teardown, never the agent-facing `exit_vm` tool. `HarnessSession.close()` deliberately does NOT tear the container down (a lingering session or quick restart shouldn't pay container-start latency every turn); only thread deletion/archive does. (Before this ADR, `deleteThread()` had no sandbox VM teardown call at all, for either agent-started or harness-owned containers — confirmed while implementing this, not merely assumed.)

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
| `disallowedTools?: string[]` | Per-thread tool denylist, **restriction-only** (`src/toolRestrictions.ts`). It is merged as a union with `settings.disallowedTools` into Claude's SDK `disallowedTools`, which removes those tools from the model's context. OpenCode: `Bash` becomes `permission.bash: 'deny'` in the launch config, plus a deny in the permission path. Codex: shell-command approval requests are declined without asking; commands Codex's sandbox runs without approval can't be blocked. Inherited by scheduled items the thread creates via CronCreate (copied onto `ScheduledItem.disallowedTools` with `createdByThreadId`, keyed by the creator's id, never by name), by the threads those items spawn, and by threads it creates via `threads_create`. Nothing removes entries. The Chief of Staff home thread is created with `['Bash']`. Absent = no restriction. Not exposed in `ThreadSnapshot`. |
| `ToolCallRecord.browser?` | Optional, additive (absent on all older data): `{ pageUrl?, pageTitle?, error? }` copied from a `browser_*` tool **result** by `ClaudeSession`/`ThreadSession` (`parseBrowserToolResult`). `pageUrl` is origin+path only (query/fragment stripped); no page content or typed text is stored. It rides along in `ChatMessage.toolCalls` through persistence and the relay unchanged (no serializer change needed). Codex does not populate it — its card falls back to the navigate URL |
| `noteFile?: string` | Vault-relative path of the saved vault note. Used by `VaultPersistence` to detect and delete stale files when the title changes. |
| `cwd?: string` | Working directory for the Claude process. Auto-repaired via `originRepoPath` (if present and still on disk) or else the nearest valid ancestor if the original worktree path no longer exists. |
| `originRepoPath?: string` | Git root of the origin repo a worktree `cwd` was cut from, captured by `enter_worktree` (cleared by `exit_worktree`). Lets project-name resolution (`resolveThreadProjectName` in `pathUtils.ts`) and `ThreadManager.repairStaleCwds()` recover even after the worktree directory itself is deleted. |
| `projectNameOverride?: string` | Display-only project name backfilled by `ThreadManager.backfillLegacyProjectNames()` from `prUrl` for threads orphaned *before* `originRepoPath` existed. Last-resort input to `resolveThreadProjectName()` — never used to derive a real path. |
| `model?: string` | Per-thread model alias set via `/model` (fable, opus, sonnet, haiku). Falls back to the `defaultModel` setting, then the CLI default. |
| `permissionMode?: string` | Per-session permission mode override. One of `'default'`, `'acceptEdits'`, `'bypassPermissions'`, `'plan'`, `'dontAsk'`, `'auto'`. Falls back to `settings.permissionMode`. Scheduler-created sessions automatically receive `'dontAsk'` so cron jobs never stall on a permission dialog. |
| `goal?: string` | Persistent goal set via `/goal`. Injected into the appended system prompt every turn until cleared with `/goal clear`. |
| `harnessVmMode?: HarnessVmMode` | Optional per-thread container-routing override (chat menu → Harness → Run in). Effective mode = `resolveEffectiveHarnessVmMode(thread.harnessVmMode, settings.harnessVmMode)`. Set via `ThreadManager.setThreadHarnessVmMode`, which closes the session and, on a host<->container flip, drops `sessionId` and queues a same-harness handoff. Exposed in `ThreadSnapshot`. |
| `rawLogPath?: string` | Vault-relative path to the thread's raw JSONL conversation log (`<vaultFolder>/logs/<thread_id>.jsonl`), written by `RawLogWriter` when the `saveRawLogs` setting is on. Keyed by the stable thread UUID so it never orphans on rename. Read back via the `obsidian_get_thread_log` MCP tool. |

---

## Cross-project `threads_create` Approval

`createAgentThreadCallback` (`src/main.ts`) runs the existing `authorizeProject` coordination check first, then, when the spawn targets a different `projectId` or an explicit `cwd` that differs from the caller's, awaits a human decision before creating anything. The gate calls `ThreadManager.requestToolApproval(threadId, 'threads_create:cross-project', detail)`, which shares the pending-permission bookkeeping and `permission_request`/`permission_resolved` events with SDK tool permissions, so the normal permission card (Allow / Always allow / Deny) renders. The pseudo tool name is not a trusted built-in, so the card shows; "Always allow" persists it in `alwaysAllowedTools` and later cross-project spawns pass silently. Denial throws `Cross-project spawn was denied by the user.`; with no `requestApproval` dep the callback fails closed. In-project spawns stay automatic.

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

## Core boundary (daemon groundwork)

The "core" is the part of the plugin that must run in plain Node, with no Obsidian and no DOM, so a headless daemon can reuse it (design: Option B, boundary enforced in place, no file moves). It is defined as the **runtime import closure** of the entry set `ThreadManager`, `ThreadSession`, `ClaudeSession`, `CodexSession`, `OpenCodeSession`, `Scheduler`, `HarnessFactory`.

| Piece | Role |
|---|---|
| `scripts/core-closure.mts` | Walks the closure (type-only and type-position-only imports are elided, like the compiler does) and writes `core-files.json` and `tsconfig.core.json`. Run `npm run core:update` after changing core imports. |
| `core-files.json` | Committed manifest: entries, every closure file, and an `allowlist` of host-bound files (must be empty; any entry is a tracked TODO and can only shrink). |
| `tsconfig.core.json` | Generated. Node types only, no DOM lib, `obsidian` mapped to `scripts/core/obsidian-forbidden.ts`, whose resolution is a compile error. |
| `test/unit/core-boundary.test.ts` | Fails if a closure file imports `obsidian`/`electron` or touches `window`/`document`, or if the closure drifts from `core-files.json`. |
| `scripts/core-smoke.mjs` | Bundles the entry set for Node with `obsidian` aliased to a throwing stub and loads it in a fresh process; prints `core loads without obsidian`. |

`npm run check:core` runs the manifest check, the core `tsc`, and the smoke bundle (also a CI step).

**Host seams** (`src/host/`) are how core reaches host functionality without importing it. The plugin passes the existing implementations from `main.ts` / the views; a daemon passes its own.

| Seam | Replaces | Plugin implementation |
|---|---|---|
| `YamlParser` | `parseYaml` from `obsidian` (`localSkills.ts`) | `obsidianYamlParser` in `src/host/obsidianHost.ts` |
| `HttpFetch` | `requestUrl` from `obsidian` (`skillManager.ts` marketplace lookups) | `obsidianHttpFetch` in `src/host/obsidianHost.ts` |
| `AttachmentStore` | `AttachmentWriter(App)` built inside the `ThreadManager` constructor | `AttachmentWriter` (passed as the second constructor argument; the default `NULL_ATTACHMENT_STORE` leaves images inline) |

Rules: core files never import `obsidian`; anything host-bound goes behind an interface in `src/host/` and its Obsidian-backed implementation lives in a file outside the closure (`obsidianHost.ts` is the only `src/host/` file that may import `obsidian`). Use `globalThis`-level timers (`setTimeout`), not `window.setTimeout`, in core.

## Daemon protocol (`src/protocol/`)

Pure-TypeScript wire contract for the planned headless daemon (design section 3). It is a core entry (`src/protocol/index.ts`), so the boundary checks cover it and it must never import `obsidian`, DOM or Node-only modules.

| File | Role |
|---|---|
| `relayTypes.ts` | Relay v1 payload types (frozen). `src/relay-protocol.ts` is a re-export shim so `RelayClient`, `MobileThreadStore` and mobile are untouched. |
| `sessionEvents.ts` | `SessionEvent` derived from `SessionCallbacks` (`WireArgs`), request/resolve overrides, `NOT_ON_WIRE`, and `CALLBACK_DISPOSITION` (typed over `keyof SessionCallbacks`). **Adding a callback to `SessionCallbacks` requires classifying it here**; `tsc` and `test/unit/protocol-drift.test.ts` both fail otherwise. |
| `commands.ts`, `spec.ts` | Client commands and `RemoteSessionSpec` (`SESSION_OPTION_DISPOSITION` does the same job for `HarnessSessionOptions`). Additive read-scope discovery commands: `path.check`, `workspaces.list` (reply `WorkspaceInfo[]`: `path, name, readOnly, kind: 'vault'\|'folder', isDefault`), `path.list` (reply `PathListReply`, capped at `PATH_LIST_MAX_ENTRIES`). Older daemons answer `unknown_command`; `welcome.capabilities` also lists `workspaces.list` and `path.list`. |
| `envelope.ts` | Frame shapes, `StreamCursor` (idempotent apply: drop `seq <= lastSeq`). |
| `codec.ts` | `encodeFrame`, `decodeClientFrame`, `decodeServerFrame`: validate and return a result, tolerant of unknown additive fields. |
| `journal.ts`, `journalPolicy.ts` | `Journal` interface plus `InMemoryJournal` (append, replay-after-cursor, ack, compact, checkpoint; per-channel seq never reused). `restore()` rebuilds one from durable storage; `daemon/diskJournal.ts` wraps it. |

Journal rules worth remembering: `lowWater` rises only on size/age **eviction**, never on token compaction; `replay(afterSeq < lowWater)` returns a `resync` checkpoint; compaction drops only `onToken` events that precede an acked `onMessage`/`onDone`/`onInterrupted`/`onError`.


## Daemon (`daemon/`)

The headless server (design sections 3.1, 3.3-3.6, 5.1-5.3). `agent-threads serve` speaks the `src/protocol` wire format over WebSocket. The session behind `session.open` is a real Claude `ThreadSession` (`daemon/claudeDriver.ts`, built through `HarnessFactory`) reached through the `DriverFactory` seam (`daemon/sessionDriver.ts`). The scripted fake (`daemon/fakeHarness.ts`) stays for tests and smoke runs: `serve --fake-harness`, or `harness: 'fake'` in config. Daemon-local tools only: host-tool proxying (vault/editor tools) is PR 7, so a remote thread uses native file tools on the box.

| File | Role |
|---|---|
| `main.ts`, `cli.ts` | Bundle entry and CLI: `serve`, `token create\|list\|revoke`, `--version`. |
| `config.ts` | Flag > env > `config.json` > default. `DATA_DIR` (default `/var/lib/agent-threads` if writable, else `~/.agent-threads`), `--listen` (default `127.0.0.1`; wildcard needs `--i-know-this-is-open`), `--port` (7433), `--allow-origin`. |
| `server.ts` | `GET /healthz` -> `{ok:true,protocol:1}`; `GET /v1/ws` upgrade guards (path, per-IP throttle -> 429, Origin allowlist -> 403, optional `Authorization: Bearer`). |
| `connection.ts` | One client: first-frame `hello{token}` within 5 s else close 4401, scope checks, `cmdId` idempotency, attach (replay + live in one synchronous turn, so no gap or duplicate), ping 20 s / pong 10 s, 4 MB live backpressure -> close 4408. |
| `claudeDriver.ts` | `ClaudeSessionDriver`: a `SessionDriver` over a live `HarnessSession`. Its `SessionCallbacks` are generated from `CALLBACK_DISPOSITION`: plain callbacks append `{name,args}` to the journal; permission / ask-question / plan / elicitation are blocking **requests** with a daemon-owned UUID (journaled, replayed on attach, resolvable until answered, interrupted, closed or the daemon restarts); `onOpenNewTab` is rejected (a daemon session cannot create a Geode thread); `onRawEvent` goes to `logs/<id>.jsonl`, never the wire. Also `specToSessionOptions`, `findClaudeBinary`, credential discovery. |
| `sessionPolicy.ts` | What is refused before anything is spawned: cwd / `additionalDirectories` must resolve (symlinks followed) under a configured workspace; `bypassPermissions` needs `allowBypass`; only the Claude harness; protected env names (`HOME`, `PATH`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_*`, `NODE_OPTIONS`, ...) are stripped from the client's `extraEnvRaw`. |
| `workspaces.ts` | `listWorkspaces` (configured roots, read-write first, de-duplicated by real path; first = default; `kind: 'vault'` when the folder holds a `.geode`, `.obsidian` or `.vault` directory) and `listSubfolders` (`path.list`: allowlist-confined like `path.check`, symlinks resolved before the check, directories only, dot-folders skipped, capped, an outside path returns `allowed:false` and no names). |
| `sessionMeta.ts` | `sessions/<id>.json` (0600): the validated spec plus the harness-native session id, i.e. the recipe for cold-resuming a session whose process is gone. |
| `controlRegistry.ts` | The single read-write seat per thread (see below). |
| `tokenStore.ts` | `tokens.json` holds SHA-256 digests only; scopes `read < control < admin`; compares against every digest with `timingSafeEqual`; re-reads on mtime change so CLI create/revoke apply to a running daemon (open sockets are re-checked each heartbeat). |
| `diskJournal.ts` | `Journal` over `journal/<id>.ndjson` + `.idx`. Wraps `InMemoryJournal` (same replay/compaction semantics as PR 2), 50 ms batched flush, fsync on boundary events, torn-tail repair on open, file rewrite after compaction/eviction. |
| `threadHost.ts` | Owns journals, drivers and session recipes. `recover()` runs at startup: a turn left running gets `onError{name:'daemon_restarted'}` + `onInterrupted` + idle `session.state`, and open requests are closed as `expired`; the native session id survives so the next send resumes. Enforces policy, `maxConcurrentTurns`, the idle reaper, and cold resume. |
| `cmdCache.ts`, `failureThrottle.ts` | 10-minute reply cache keyed by (token, cmdId); 5 failures / 60 s per IP. |

Rules worth remembering:

- **Hardening (review follow-up).** The invariants a change here must keep: (1) *Seat identity* is `(tokenId, instanceId)` (`controlRegistry.ts` `sameClient`): `hello.instanceId` is the plugin's `remoteClientId`, absent = legacy per-token; the idempotency cache is scoped the same way. (2) *Nothing a client sends may throw out of a handler*: `Connection.guarded()` wraps socket and timer handlers (a throw closes only that connection, 1011), a reply that cannot be serialized becomes an `internal` err, `TokenStore` fails closed on a damaged file (`verify` null / `isActive` false, logged once; only its constructor and management methods throw), and `cli.ts` `installCrashGuards` logs `uncaughtException`/`unhandledRejection` and keeps serving once startup succeeded. (3) *Shape before policy*: the codec validates `images` element-by-element (`validateWireImages`: mediaType allowlist, base64, size caps) and `session.open` specs (`validateSpecShape`); `sessionPolicy.ts` then decides what a valid shape may do (workspaces, `KNOWN_PERMISSION_MODES` allowlist, `filterClientEnv`: client env is ignored unless `config.allowedClientEnv` lists the name). The driver's `toAttachments` runs BEFORE `sendAccepted` is raised so a bad element can never leave `turnInFlight` stuck. (4) *Bounds*: `ws` `maxPayload` is 4 KB until `hello` succeeds (`raiseFrameLimit` raises the connection's own receiver limit; it touches an internal of `ws`, guarded by an integration test), `maxConnections` (64) plus 16 unauthenticated, control-reply queue capped at `maxOutboundBytes` (4408), `maxLiveSessions` (8, in `ThreadHost.startDriver`), unanswered requests expire after `requestTimeoutMinutes` (driver timer, journals `request_resolved{outcome:'expired'}`), `path.list` resolves at most `MAX_LINKS_RESOLVED` symlinks and never realpaths plain directories. (5) *Throttle* ignores loopback peers (behind `tailscale serve` every client is 127.0.0.1) unless `DaemonOptions.throttleLoopback`. (6) *Logs*: `auditLog.ts` batches, skips retention acks, rotates by size; `logRetention.ts` sweeps `logs/*.jsonl` by age (`journalTtlDays`) and rotates by size (`journalMaxMb`) on the maintenance timer. (7) `resolve.permission{alwaysAllow}` is acknowledged `{alwaysAllow:'not_supported'}` and never journaled as honoured. (8) `ThreadHost.send` ignores a repeated `userMessageUuid` (last 64 per thread) so a client retry cannot run a turn twice. (9) A damaged line in the middle of a journal file is skipped and logged (file rewritten); only a damaged tail is truncated. Tests: `test/integration/daemon-hardening.test.ts`, `test/integration/remote-hardening.test.ts`, `test/unit/daemon-hardening.test.ts`; `REQUIRED_SCOPE` is exported and a table test fails if a command is added without a scope. Operator-facing consequences: "Security" in `docs/remote-daemon.md`.
- **Boundary.** `daemon/` may use Node (`fs`, `http`, `ws`) and `@anthropic-ai/claude-agent-sdk` (it hosts `ThreadSession`; added to the daemon-boundary allowlist, and the bundle uses the same `/core` entry + `import.meta.url` shim as the plugin) but never `obsidian`, `electron` or DOM globals, and every `src/` file it imports must already be in `core-files.json`. `src/` never imports `daemon/`, so `ws` cannot reach the plugin bundle. Enforced by `tsconfig.daemon.json` (Node types, `obsidian` is a compile error), `test/unit/daemon-boundary.test.ts`, and a bundler plugin in `esbuild.daemon.mjs` that fails the build on an `obsidian`/`electron` import. `npm run check:core` runs all of it plus `npm run check:daemon` (typecheck, bundle, and `scripts/daemon-smoke.mjs`, which runs `node dist/agent-threads.cjs serve --fake-harness` and drives a session round trip).
- **Build.** `npm run build:daemon` produces `dist/agent-threads.cjs` (plain `node dist/agent-threads.cjs serve` works; `bin/agent-threads` is the launcher). The plugin build is untouched.
- **Durability.** The ndjson file is authoritative for entries; the `.idx` sidecar carries `lowWater`/`ackedSeq`. `session.state` events are fsynced (not just done/error/permission_request as in design 3.4) so a `session.send` that was acked is known to the journal after a crash.
- **Backpressure only bounds LIVE data.** A replay backlog is drained lazily as the socket accepts it, so a healthy client replaying more than 4 MB is not penalised.
- **Session lifecycle.** `session.open` is open-or-adopt by threadId; a thread with no live process is started with `resume` = the daemon's stored native session id, else the client's `resume`, else `spec.resume` (the daemon's copy is freshest). The id is learned from every raw SDK event (so a turn killed before its first `onDone` is still resumable) and from `onDone`/`onInterrupted`. `session.send` on a thread with no live process (idle-reaped, `session.close`d, or after a restart) cold-resumes it from `sessions/<id>.json`. **`session.detach` leaves the session and any running turn alone** (the client just stops listening and gives up its seat); **`session.close` stops the process** (history stays attachable). The idle reaper (`idleReapMinutes`, default 30, 0 = off) stops a session that is not in a turn and not waiting on a human, journaling `session.state{closed:'idle'}`. `setModel`/`setPermissionMode` on a stopped session are recorded and apply at the next resume; `setPermissionMode` enforces the bypass policy.
- **Requests.** Ids are UUIDs minted by the daemon. A request that is still open when a client (re)attaches is re-delivered even if its seq is at or below the client's cursor, as an `event` frame with `reopen: true` (a cursor would otherwise drop it as a duplicate); the client re-shows the prompt if it is not already showing it. First resolver wins, a later one gets `not_found`. `session.interrupt` and `session.close` cancel every open request (permission -> deny, question/plan -> rejected, elicitation -> `{action:'cancel'}`) and journal `request_resolved{outcome:'canceled'}`. A daemon restart expires them (`outcome:'expired'`) because the blocked process is gone. `session.interrupt` only reaches the harness while a turn is running (`ThreadSession` latches "interrupted", so an idle interrupt would poison the next turn).
- **One read-write client per thread.** The seat is claimed by `session.open`, by a control-scope `attach`, or implicitly by the first mutating command on a free thread. The same token always takes the seat back (a reconnect must not wait for its dead socket's pong timeout); a different token is refused with `conflict` and observes (`attach` replies `controller:false`). Only the seat holder's `ack` bounds journal retention. The seat frees on `session.detach` or disconnect.
- **Concurrency.** `maxConcurrentTurns` (default 3) bounds turns running at once across all threads; the send beyond it fails with a **retryable** `conflict` (not queued: a queue would be lost on a crash and hide load from the client).
- **Policy and config** (flag > env > `config.json`): `workspaces` (default `/srv/workspaces`; list `~/projects`, `~/vault` explicitly if wanted; `--workspace`, `AGENT_THREADS_WORKSPACES` colon-separated; a flag replaces the whole list), `readOnlyWorkspaces` (`--readonly-workspace`, `AGENT_THREADS_READONLY_WORKSPACES`: allowed as cwd, but `validateSpec` adds `Edit/MultiEdit/Write/NotebookEdit` to `disallowedTools` and refuses `acceptEdits`/`auto`/`bypassPermissions`, at open and at `setPermissionMode`; the most specific root wins, any read-only cwd/additional dir makes the session read-only; Bash is not blocked, so it is a guard rail, not a sandbox), `allowBypass` (`--allow-bypass`), `maxConcurrentTurns`, `idleReapMinutes`, `claudeBinaryPath` (`--claude-binary`; else PATH, `~/.npm-global/bin`, `~/.local/bin`). The fake harness is not policed (it has no side effects).
- **Credentials.** The Claude process inherits the daemon's environment, so by default it reuses the daemon user's logged-in `~/.claude`. `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` in the environment win, and a systemd `LoadCredential=claude-token` file is read as a token. The startup log says which source is in use (never the value). VM routing is never configured (`harnessVmMode: 'never'` by construction).
- **Process supervision.** The daemon spawns one `claude` CLI per live thread. After a `kill -9` of the daemon those CLIs (and any tool they started) are orphaned until they notice EOF on stdin; a supervisor that kills the whole process group (systemd `KillMode=control-group`, the default, or a container) removes them. Packaging (Phase 3) must keep that.
- **Raw log.** `logs/<id>.jsonl` (via `RawLogWriter`, secrets masked by `redactDeep`); the directory is 0700. The journal itself is NOT redacted (it is the client's transcript source and is 0600 / TTL-bounded); redacting it is a deliberate non-goal until we decide what a client may lose.
- **Live check.** `scripts/daemon-live-check.mts` drives a running daemon with a real Claude session using only Node's global WebSocket (run it on the daemon box). Scenarios: stream-to-done, permission allow, disconnect + reopen, `kill -9` + native-session resume. Not part of CI (it spends tokens).
- **Replay fidelity (PR 6).** (a) *Wire:* backlog event frames carry `replay: true` (the client keeps `frame.ts` as the original time; live frames do not); `attach` carries the client's last-seen `epoch` and the ack may carry `rewind` (see Crash recovery below). (b) *Retention:* `config.journalTtlDays` (7) and `journalMaxMb` (64) feed `InMemoryJournal` `maxAgeMs`/`maxBytes`; `ThreadHost.compactAll()` applies them at startup and on a 5-minute timer (`maintenanceMs`), not only after an ack. Eviction raises `lowWater`, which is what makes a stale cursor `resync`. (c) *Crash recovery:* `DiskJournal` keeps an epoch chain in the `.idx` sidecar (`epochs: [{epoch, startSeq}]`, written at open, last 16) where `startSeq` is the seq that survived the previous process. `rewindFor(clientEpoch, afterSeq)` returns the `startSeq` of the restart that follows the client's epoch when the client is past it (it applied events that were never flushed and whose seqs were reused); `attach` then replays from there and replies `rewind`. An epoch the chain does not contain is left alone. (d) *Not yet.* the "Recover from daemon" command (rebuild a lost transcript from the journal or raw log), host-tool proxying and `hostAttached` (PR 7), statusline/git-diff events (PR 8), proxied MCP servers, skills and `remoteSecretNames` (PR 9), Codex/OpenCode (PR 10), `GET /v1/threads|log|blobs`, `ctl` channel events, systemd/Docker packaging (Phase 3). `spec.hostTools`, `spec.skills` and `spec.goal` are accepted and ignored.
- **Behind a proxy.** `tailscale serve`/Caddy make every client look like 127.0.0.1, so the failure throttle is global there; the origin of a Geode renderer for `--allow-origin` is settled by the PR 5 ws/wss spike.

## Remote threads (plugin client, `src/remote/`)

A thread with `Thread.remote` runs on a daemon; `ThreadManager` is otherwise unchanged and owns the transcript (stage 1, `ownership:'client'`). Operator guide and the ws/wss spike result: `docs/remote-daemon.md`.

| File | Role |
|---|---|
| `DaemonClient.ts` | One authenticated WebSocket per daemon, core-safe, transport injected (`WebSocketFactory`). First-frame `hello`, reconnect on `RECONNECT_BACKOFF_MS` (`backoff.ts`, shared with `RelayClient`), re-attach every channel with `afterSeq = cursor.lastSeq`, `StreamCursor` duplicate drop (`reopen` request frames bypass it), commands re-sent with the same `cmdId` after a reconnect, debounced `ack` only when the consumer says it persisted, liveness probe (`attach{ctl}`) because browsers hide WS pings, connection states (`connected/reconnecting/unreachable/unauthorized/incompatible`), `probeDaemon()` for Test connection. Reconnect is single-flight: the retry timer is armed before state listeners run and `openSocket` never replaces a live socket. |
| `RemoteHarnessSession.ts` | (Hardening: only names `CALLBACK_DISPOSITION` marks `'event'` are invoked on the callbacks object, a retryable `conflict` on `session.send` is retried with backoff using the same message id, and a send whose ack never arrived reports *unconfirmed*, not "not delivered", via `DaemonCommandError.unconfirmed`.) `HarnessSession` over the client: commands, `event` frames -> `options.callbacks.on*` in order, request/resolve pairs (permission/question/plan/elicitation), sync getters from mirrored `session.state`, mid-turn sends held locally (the daemon refuses a second send), `detach()` (leave the turn running) vs `close()` (end it on the daemon), `attachOnly` start for re-attaching after a restart. `thread.remote.lastSeq` is the conservative resume cursor (stays before an unfinished assistant message); `turnPending` marks a turn in flight. |
| `sessionSpec.ts` | `HarnessSessionOptions` -> `RemoteSessionSpec`: carries cwd/model/mode/resume/disallowed tools/session options; drops env, secrets, MCP servers, additional dirs, VM routing, callbacks. Also the remote environment prompt (no Mac vault root); when the daemon has a `vaultMapping` and the remote cwd is under its `remoteRoot` it appends the vault-mirror addendum (`buildRemoteVaultAddendum`: synced copy, ~5 min lag, conflicts, never delete/rename, Daily-note link). |
| `vaultMapping.ts` | Pure, lexical (no fs, no symlinks), POSIX, NFC-normalized mapping between this vault and a daemon's vault mirror: `normalizePosixPath`, `mapLocalToRemote`, `isUnderRemoteRoot`, `suggestRemoteCwd` (mapped vault folder, else the daemon's `defaultCwdRoot`). In `core-files.json` because `sessionSpec.ts` uses it. |
| `DaemonRegistry.ts` | One client per configured daemon (`settings.remoteDaemons`), token read from `app.secretStorage` at each connect, `settings.remoteClientId` sent as `hello.instanceId`; `RemoteDaemonResolver` is what `HarnessFactory`/`ThreadManager` see. |
| `pluginWebSocket.ts` | Plugin-only: bundled Node `ws` on desktop (Geode's renderer CSP blocks the global `WebSocket`), global `WebSocket` on mobile. Lazy `require`. |
| `connectionPill.ts`, `threadLocation.ts`, `runOn.ts`, `daemonConfig.ts` | Pure presentation/validation logic (pill states, `host:/path` labels and board grouping, the Run on picker, Settings validation and test-connection wording). |

Rules worth remembering:

- **Routing.** `createHarnessSession(thread, settings, remoteDaemons, hooks)` returns a `RemoteHarnessSession` when `thread.remote` is set; with no resolver or a removed daemon it throws a clear error, it never falls back to running locally.
- **Quit does not kill remote turns.** `ThreadManager.destroy()`/`gracefulShutdown()` call `HarnessSession.detach?.()` (fall back to `close()`), do not interrupt or wait on remote turns, and the reload prompts ignore them. After a restart `resumeRemoteTurns()` (called from `main.ts` on layout ready) re-attaches threads with `turnPending` attach-only, so nothing is spawned just to view a finished turn. `remote_pending_changed` makes the plugin persist the marker immediately.
- **Local-fs guards.** A remote `cwd` is a path on another machine. Skipped for remote threads: `ensureCwdExists`, `repairStaleCwds`, `backfillLegacyProjectNames`, `StatusLineService`/`GitDiffService` (`cwdFor`, `pollAll`, `applyToCwd`; a remote thread sharing a path string with a local one must not receive local results), `resolveThreadProjectName`, Project cwd alignment, VM routing, harness switching, the edited-file opener, dashboard/kanban cwd labels and grouping. The `@file` mention picker is unaffected: it inlines vault file text into the message. `setThreadCwd` keeps `remote.remoteCwd` in step.
- **Vault mapping.** `RemoteDaemonConfig.vaultMapping {localRoot?, remoteRoot}` (Settings -> Remote daemons -> edit; `checkVaultMappingInput` validates, `describeTest` words Test connection). `DispatchInput`'s Run on folder field is pre-filled via `suggestRemoteCwd` from `harnessPicker.getLocalCwd/getVaultRoot` (Project cwd, else default cwd) until the user types in it. Test connection sends the additive read-scope command `path.check {path}` (`probeDaemon({checkPath})`); an older daemon answers `unknown_command`, reported as "too old to check folders". The daemon's reply is `{allowed, exists, isDirectory, readOnly}` and reveals nothing for paths outside its workspaces. Operator steps: `docs/remote-daemon.md`, "Working in the vault".
- **Folder discovery.** The person never types a remote path: Test connection also sends `workspaces.list` (`probeDaemon({listWorkspaces:true})`, result `workspaces: {list}|{unsupported}|{failed}`), and the Run on picker asks `createRemoteFolderSource(registry)` (`folderSource.ts`: `workspaces()` cached 30 s, `subfolders()`; failures are values `{ok:false, reason:'unsupported'|'error'}`). Pure choice rules are in `workspaceChoice.ts`: `pickVaultWorkspace` (exactly one vault-kind folder; else the folder named like this vault, vault-kind first, ambiguity = no pick; else None), `pickDefaultWorkspace`, `applyDiscovery` (fills only empty, untouched fields, so a saved or chosen value always wins). `RemoteDaemonModal` shows dropdowns after a successful test and keeps the raw paths under an **Advanced** disclosure (opened automatically for a daemon that cannot advertise). `DispatchInput` (`harnessPicker.getFolderSource`) renders a workspace `<select>`, a **Browse...** panel (`path.list`, Up stays inside a workspace) and an **Other folder...** text fallback; without a source, or for an old daemon, it is the plain text field. The selection writes the same `vaultMapping`/`defaultCwdRoot` data as before; nothing else is persisted. The repo must stay free of the maintainer's own hosts and paths: `test/unit/no-owner-strings.test.ts` enforces it, use `my-server`, `wss://my-server.tailnet-name.ts.net:8443`, `/home/user/vault`, `/home/user/projects`, `/srv/workspaces` in examples.
- **Replay fidelity (PR 6).** *Clock:* `ThreadManager.now()` (injectable `clock`) is what every session callback stamps with, never `Date.now()` (a source-scan test in `thread-manager-clock.test.ts` guards `buildSessionCallbacks`, `applyTaskEvent` and `clearReconnectingStatus`); `runAtTime(ts, fn)` pins it for a synchronous call, clamped to the real clock, and `touch()` keeps `updatedAt` monotonic. `RemoteHarnessSession` dispatches an event whose frame is flagged `replay` (and a recovered checkpoint message) inside `runAtTime(frame.ts)`; live events use real time. *Cursor:* `advanceCursor` runs BEFORE the callbacks, because a callback may save the thread (the host saves on every `message`) and that snapshot must carry a cursor that already covers the message it holds. *Ack:* `remote/persistAck.ts` `saveThenAck` captures `remote.lastSeq` when the save is requested and acks that value only after the save resolves (`HarnessSession.notifyPersisted(seq)`), never the live cursor. *Resync* (`onResync`): `onStreamReset` (-> `stream_reset` event; `ThreadsView` empties its streaming buffer) then `checkpoint.recentMessages` with `seq` above the persisted cursor are applied at their original `ts` (skipped entirely when the cursor is AHEAD of the journal: the seq spaces are unrelated, so duplicates could not be told apart), then `inFlightText`, open requests (deduped by request id; a locally open one the checkpoint lacks is withdrawn), the mirrored state, and finally a turn we thought was running is closed: `onDone` if messages were recovered, else `onError('Lost track...')`. *Rewind:* `DaemonClient.subscribe(..., epoch)` sends the last-seen epoch on `attach`; an ack with `rewind` lowers the cursor synchronously (`onAck` hook, before the replayed events) and `onRewind` lowers `remote.lastSeq` and drops the stale stream. `detach()` also releases an attach-only re-attach.
- **Settings and keychain.** `settings.remoteDaemons` holds name/url/`tokenSecretName`/`defaultCwdRoot`/`vaultMapping`; the token lives in `app.secretStorage` under `secretStorageKey(tokenSecretName)`.
- **UI.** Settings -> Remote -> Remote daemons (add/edit/test/remove); `DispatchInput` send-button menu **Run on** section (`harnessPicker.getRemoteDaemons`; payload `remote:{daemonId,cwd}` -> `dispatchNewThread`); `.ct-remote-strip` (badge, folder, pill) in `ThreadsView`, always visible because a native view header hides the title row. Fixtures: `test/screenshots/remote-thread.spec.ts`.
- **Tests.** `test/unit/daemon-client.test.ts` (fake transport), `test/integration/remote-session.test.ts`, `remote-thread-manager.test.ts` and `remote-replay.test.ts` (the daemon's real in-process server + a killable TCP proxy; replay uses an injected daemon wall clock, journal caps and `daemon.crash()`), `test/unit/remote-logic.test.ts`, and `scripts/e2e-geode-remote.mts` (hidden real Geode; `npm run e2e:kill` in the Geode checkout cleans up).

---

## DispatchInput Component

`DispatchInput` only renders the bottom footer row (attach button, mic button) when either `showCwdChip` or `appendFooterActions` is passed. If you want the footer layout without other chips (e.g. in AgentDashboard), pass `appendFooterActions: () => {}` as an empty callback — this sets `needsFooter = true` internally.

With `harnessPicker`, the send button doubles as a sticky picker (right-click / long-press / Shift+F10). For Claude it also offers a **Run in** section (Container / Host / Default); the choice travels as `DispatchPayload.harnessVmMode` to `dispatchNewThread`, which applies it via `ThreadManager.setInitialThreadHarnessVmMode` (no session reset — the thread is brand new) before the first message. It is dropped for non-Claude harnesses.

---

## Screenshot Harness

The harness (`test/harness/`) renders the plugin against fixture data without a live Obsidian or Claude process. Fixtures live in `test/harness/fixtures.ts`.

New UI states need:
1. A fixture entry that seeds the relevant data/state
2. A new test case in `test/screenshots/ui.spec.ts` with the right setup (hover, `page.evaluate`, etc.)

Flows that require a live session (PTT recording, background task completion, permission modals from real tool calls) cannot be tested in the harness and are intentional skips.

# Settings reference

Part of the [Agent Threads README](../README.md).

## Settings

Open **Settings → Agent Threads** in Geode or Obsidian. The compact **Settings section** selector groups all eleven desktop sections under Preferences, Workspace, Extensions, and Connectivity. The host keeps its own settings navigation; the plugin does not add a second sidebar. **Projects** and **Secrets** provide searchable lists with a detail editor beside them, stacking vertically when the available settings pane is narrow. Mobile retains its pairing and relay settings screen.

In **Secrets**, choose **Add secret** or select an existing entry. Save the value and its **Global** or **Selected projects** access together with **Add secret** for a new entry or **Save changes** for an existing one; **Cancel** discards the draft. A blank replacement preserves an existing value. Removing a secret requires confirmation. Values stay in OS-backed secret storage, never in `data.json`.

| Setting | Description |
|---|---|
| Claude binary path | Path to the `claude` executable (auto-detected). Below it, Settings shows the detected CLI version and a warning with the exact upgrade command (and a **Copy command** button) when the CLI is older than the plugin's pinned minimum, or a quiet notice when a model the plugin knows about is not reported by your CLI's catalog. The plugin never upgrades the CLI for you. Desktop only; skipped when threads always run in the sandbox VM. |
| Agent harness | Initial Claude or Codex default for new kickoff selectors. A selection made in the Agents List or Agent Board is local to that mounted view and does not rewrite this setting. |
| Codex computer use | Off by default. Disables bundled Codex desktop-control capabilities for newly initialized sessions. On inherits local Codex configuration. Existing sessions require a restart; shared Codex browser REPL capabilities may also be unavailable while off. |
| Default working directory | `cwd` for new threads; defaults to vault root |
| Worktree location | Root directory for worktrees created by `enter_worktree` (default: `~/.geode/worktrees`, laid out as `<repo>/<branch>`). Must be durable storage — a temp directory is cleared on reboot, which deletes the worktree and any uncommitted work in it. |
| AWS profiles for the local daemon | Desktop only. One profile per line: threads on the [local daemon](remote-daemon.md#local-daemon-this-mac-in-a-container) get a trimmed AWS config with only these profiles (plus the `AWS_PROFILE` from Extra environment variables) and the SSO token of each profile's session, copied before each message. Bedrock threads always get their `AWS_PROFILE`. |
| Local daemon: tools that act on this Mac | Under Settings, Remote. Per-group toggles (threads, schedule, secrets/MCP, skills, vault history, app commands/editor, browser scripts, GitHub discovery) that offer tools which write, schedule or touch secrets on this Mac to threads on the local daemon. Off by default, with a security warning; each call still shows an approval card. Applies to the next session. |
| Remote daemons, edit, Tools on this computer: Tools from other plugins | Offers tools that peer plugins add to your threads (such as Design's `EnterDesignMode`) to threads that run on a daemon. On by default for the local (container) daemon, off for daemons you add yourself until you tick it. Tools that change something still ask in the app first; only tools present when the thread starts are offered. Applies to the next session. |
| Local daemon: share all Project folders | Under Settings, Remote. Shares read-write (at `/work/<name>`) every Project working folder outside the vault, including Projects added later, so you need not list them under shared folders. Off by default. Applied when the container is next created (Update). |
| Local daemon memory / CPUs / shared folders | Under Settings, Remote. Memory (`<digits>M\|G`, default `4G`), CPUs (1-64, default `4`) and host folders shared read-write at `/work/<name>`. Applied when the container is next created (Update). |
| Use Geode GitHub connection | Geode only. Lets threads use the GitHub account connected in Geode (Settings → GitHub) for `git` over HTTPS, `gh` and the GitHub API, on the host and in the [local daemon](remote-daemon.md#local-daemon-this-mac-in-a-container), with no personal access token. The token is never put in prompts, logs or environment variables; your own `GH_TOKEN`, `gh auth login` and git credential helpers take priority. See [GitHub via Geode](github-integration.md). |
| GitHub commit email | Geode only. Email for commits made with the connection; empty uses your GitHub noreply address (`ID+login@users.noreply.github.com`). Applied only where a repository has no `user.email`. |
| Save threads to vault | Auto-save readable Markdown notes plus versioned machine recovery snapshots |
| Vault folder | Folder for saved thread notes (default: `Agent Threads/`) |
| Extra environment variables | `KEY=VALUE` pairs injected into Claude's environment (useful for `AWS_PROFILE`, `AWS_REGION`) |
| Secret environment variables | Managed in **Secrets** with explicit Save/Cancel. Values are stored in the OS keychain, never in `data.json`. Each secret defaults to Global (available to every Project and to Project-less threads); choose Selected projects in its detail pane to restrict resolution. MCP server and skill *registration* stays global regardless — only whether a scoped secret's value resolves is gated by Project. |
| Permission mode | How the selected Claude or Codex harness handles tool-use confirmation. Options: `default` (CLI default), `acceptEdits` (auto-approve file edits), `bypassPermissions` (skip all prompts), `plan` (propose a plan first — see [Plan Mode](usage.md#plan-mode)), `dontAsk` (no dialogs; for unattended/scheduled sessions), `auto` (the selected harness decides). See [Permissions](usage.md#permissions). |
| Thinking mode | `disabled` (default), `enabled`, or `auto` — controls whether Claude uses extended thinking for harder problems |
| Thinking budget tokens | Maximum tokens Claude can spend on reasoning when thinking mode is `enabled` (default: 8 000). Only shown when thinking mode is `enabled` |
| Effort level | Provider-aware. Claude supports its CLI effort range through `max`; Codex stores a separate choice through `ultra`. Codex Ultra enables proactive native agents on supported models. `default` uses the selected harness/model default. |
| Agent progress summaries | Whether sub-agent progress is summarised and shown inline (default: on) |
| Enable 1M context (beta) | Opt-in to the 1-million-token context window beta (uses the `interleaved-thinking-2025-05-14` beta flag) |
| Ephemeral session | When on, sessions are not persisted to disk — they cannot be resumed after the thread closes |
| Conversation placement | `Conversation first` (default on new installs) keeps one chat in the main workspace and reuses an adjacent native companion for contextual content, or `Classic sidebar` for the original sidebar layout. Existing installs keep whichever placement they were already using. Desktop only; mobile is unchanged. |
| Layout density | `Comfortable`, `Compact`, or `Spacious` — controls message spacing and padding |
| Enable summarization | Master switch — auto-names threads each completed turn, shows the summarize button, enables the summarize command |
| Auto-summarize after response | Keep refreshing the summary every completed turn even after you rename a thread yourself |
| Summarization model | Model alias for summarization (e.g. `haiku`, `sonnet`) |
| Escalation keyword | Keyword that routes a single turn to the escalation model (default: `/escalate`) |
| Escalation model | Model the escalation keyword targets (default: Opus) |
| Keep computer awake | Prevent the computer from sleeping while Claude is processing; shows ☕ in the status bar |
| Context footer command | Shell command that produces the status-line pills (JSON tags or plaintext). Run per-thread against its cwd; receives `{cwd, workspace, provider}` on stdin. Desktop only. See [Status line](usage.md#status-line-context-footer). |
| Create PR message | Message sent directly to the active agent by the Create PR button or `/create-pr`. Defaults to `/create-pr`; blank also uses that default. |
| Create draft PR message | Independent message sent by the draft action or `/create-pr --draft`. Defaults to `/create-pr --draft`; blank also uses that default. |
| Projects | Group threads and focus their initial cwd/context. Projects do not restrict the broader vault or configured tool roster. |
| Auto-collapse side panel | Collapse the left, right, or both sidebars when the Agent Board opens, restoring them when it closes (default: `None`). See [Agent Board](usage.md#agent-board). |
| Stack scheduled job threads | Collapse repeat runs of the same scheduled/cron job into an expandable rollup in the Agent Board's quiet columns and the Agents List's Scheduled Jobs section (default: on). See [Agent Board](usage.md#agent-board) and [Agents List](usage.md#agents-list). |
| Scheduled work | The dedicated **Scheduled** section groups recurring jobs, thread loops, and wakeups into collapsed rows showing status, cadence, next occurrence, Project, and execution target. Expand one for prompt, working directory, active hours, gate, history, and pause/resume/delete/open controls. |
| Watched documents | **Watched documents** within **Scheduled** lists every active watch (see [Watch a document](usage.md#watch-a-document)) with its path, owning thread, and last-alerted time, plus an unwatch control — the same view whether the watch was created from the file menu or the `watch_document` MCP tool. |
| Diagnostics | Enable the always-on, local-only telemetry layer (counters + renderer CPU/memory samples) that powers the [Diagnostics report](usage.md#diagnostics-report). Nothing leaves your machine; on by default. Desktop only. |
| Remote access | Enable/disable mobile remote access via WebSocket relay |
| Room ID | Shared secret used to pair mobile (rotate to revoke all access) |
| Show pairing QR | Display a QR code for one-time mobile pairing (expires in 5 minutes) |

Thread state in the plugin's `data.json` is canonical during normal startup. When vault saving is enabled, each readable `.md` conversation is accompanied by a versioned `.recovery.json` snapshot containing the canonical thread/session metadata and message history. The Markdown body is presentation-only: it is never parsed back into a live conversation, so callouts, embeds, or manual note edits cannot corrupt a restarted thread. Legacy Markdown archives without a supported snapshot remain readable archives but are not guessed back into live state.


# Agent Threads

## Native agent workspace

Background Claude and Codex agents are first-class, durable participants, and the conversation stays the conversation. While a thread has sub-agents, a compact pill in the composer footer reports how many are working. Clicking it opens a popover with the full agent tree; picking an agent replaces the message pane with that agent's activity timeline behind a breadcrumb that walks back to the main conversation. The Agents List exposes the same agents for navigation and search. Each view shows the exact activity and lifecycle information exposed by the native harness. Active runs that cannot be reconnected after reload are labeled unavailable rather than incorrectly shown as completed.

Direct child-agent messaging and single-agent interruption are capability-gated. They remain unavailable when the harness has no verified host-side control path; Agent Threads never silently routes those actions to the parent. See [the capability matrix and recovery behavior](docs/agent-workspace.md).

A native Obsidian and Geode plugin for running multiple Claude Code sessions in parallel — with streaming markdown responses, tab management, and deep vault integration.

![Agent Threads](https://img.shields.io/badge/Obsidian-Plugin-7C3AED) ![Version](https://img.shields.io/badge/version-0.49.0-blue) [![Roadmap](https://img.shields.io/badge/Roadmap-Compass-6366F1)](https://compass.rbcodelabs.com/portal/rbcodelabs/claude-threads/roadmap)

<p align="center">
  <img src="docs/screenshot-main.png" width="800" alt="Main view: conversation panel with tool calls and Agents List showing thread summaries" />
</p>

<p align="center">
  <img src="docs/screenshot-slash-commands.png" width="800" alt="Slash command autocomplete showing installed skills" />
</p>

<p align="center">
  <img src="docs/screenshot-streaming.png" width="800" alt="Streaming response with live tool call visibility" />
</p>

<p align="center">
  <img src="docs/screenshot-permission.png" width="800" alt="Inline permission dialog — Deny / Allow / Always Allow before Claude writes a file" />
</p>

## What it does

Agent Threads embeds Claude Code directly in your host workspace. Each tab is an independent Claude Code session with its own working directory and conversation history. You can run multiple sessions in parallel — one debugging a bug, another drafting docs, another answering questions about your vault.

**Key features:**

- **Multi-tab sessions** — open as many Claude threads as you need, switch between them instantly
- **Opt-in sandbox VMs** — Claude and Codex can run explicit coding commands in a Linux VM through Apple Container on Apple-silicon Macs with macOS 26+. Only the selected working directory is mounted (writable); ordinary host tools remain outside the VM. See the [setup and safety guide](docs/sandbox-vms.md).
- **Streaming responses** — tokens stream in with live markdown rendering (code blocks, tables, lists, etc.)
- **Responsive conversation width** — wide conversation panes center the complete timeline and composer in a readable-width column, while narrow panes remain full width
- **Clickable links in messages** — both `[[wikilinks]]` and ordinary `[label](path.md)` Markdown links in a response open the target note, in the sidebar and in conversation-first placement alike. Agents writing from outside Obsidian often emit an absolute filesystem path rather than a vault-relative one; when that path lands inside your vault, it still resolves to the right note — heading and block anchors included. A path that points outside the vault says so rather than opening (or creating) anything. An ordinary `http(s)://` link in a message opens the same way status-line pill links do — in a fresh tab in the host's in-app Web Viewer when enabled (in the conversation-first context region when that placement is active), otherwise the system browser; Cmd-click (Ctrl-click) always forces the system browser
- **Persistent conversations** — sessions resume where you left off after restarting the host app
- **Auto-naming** — tabs rename themselves based on what you're working on (powered by the summarizer)
- **Thread summaries** — a header bar shows what each thread is about, auto-updated after each response
- **Agents List** — monitor and dispatch to multiple threads from a compact, responsive two-line list; use the host header's native Search and Group actions to group independently by **Project**, **Status**, or both; attach images or files to dispatched tasks via the paperclip button or drag-and-drop; resolve pending permission requests directly from list rows without switching threads; right-click any row or card to **archive** it — or to bulk-archive every run of a scheduled job; open the **Agent Board** to visualize agent state in a kanban layout (idle, running, waiting, done), or regroup the board into **folder swimlanes** or **project columns** — one lane/column per app/project — to see every conversation for a codebase together; the Agent Board has its own floating dispatch panel so you can launch new tasks without leaving the board view
- **Compressed conversation view** — toggle "Compress view" from the ⋯ menu to collapse an agentic thread's history into one-line summaries per exchange. Consecutive assistant turns (a full agentic run between two user messages) are grouped into a single summary entry. Click the expand arrow on any entry to read the full response. Summaries are generated lazily in a serial background queue so the UI never spawns multiple Claude processes at once
- **Focus edited files** — one click opens the files the active Claude or Codex agent touched. Classic placement keeps its original focus behavior (closing other Markdown tabs); conversation-first opens them through the companion without detaching unrelated leaves
- **Conversation-first workspace** — the default on new installs: keeps one chat in the main area and opens wikilinks, edited or bridged files, Web Viewer pages, artifacts, and agent-triggered navigation in one reusable native companion beside it. Closing the companion restores the conversation's available width. Switch back to the classic sidebar layout any time under Settings → General → Conversation placement; existing installs keep whichever placement they were already using. Desktop only — mobile is unchanged
  - On Geode hosts with durable companion support, the companion survives plugin reloads, workspace restoration, and placement changes. Closing its destination tab while other tabs remain opens the next contextual item in a replacement tab in that same split. Close the whole split to retire it. Older Geode versions and Obsidian retain the existing reload behavior. Previously created unmarked panes are left untouched and may need one-time manual cleanup.
- **Workspace tab syncing** — the host workspace tab title automatically reflects the active thread so you always know which session is which
- **Native document header** — when the conversation is in a main document pane, its title and thread controls use the host's native header instead of adding a second title bar. The compact custom title bar remains available in sidebars, and the view adapts automatically when you drag it between the two
- **Slash commands** — built-in context commands plus every skill the session can see (`~/.claude/skills/`, vault-installed, and plugin sources), browseable with `/`
- **Model switching** — set a persistent model per thread with `/model fable|opus|sonnet|haiku`, or a global default in settings
- **Agent browser** — Claude drives a browser inside Geode using the embedded web view, reading pages as accessibility snapshots and acting on element refs, with no second Chrome process. Sessions are capped, reclaimed when idle, and closed with their thread; a sidebar pane lets you watch one work and stop it. Geode desktop only, off by default
- **Claude or Bedrock** — authenticate with your Claude account or route every session through Amazon Bedrock (one dropdown in settings)
- **Goals and loops** — pin a persistent goal on a thread with `/goal`, or re-run a prompt on an interval with `/loop 10m <prompt>`
- **Task list card** — Claude Code's task checklist (TodoWrite / TaskCreate) and Codex's `update_plan` checklist render live above the input box: completed tasks struck through, the in-progress one highlighted, with done/in-progress/open counts
- **Context compaction** — auto and manual compaction shown as persistent dividers in the conversation
- **Permission dialogs** — Claude asks before writing files or running commands; you approve or deny inline
- **@ file mentions** — type `@` in the input to search vault files by name; selecting one injects its full content into the prompt as context; type `@this` to reference the currently open file without searching
- **Chat about this document** — right-click a note in the file explorer or inside the editor (or run the command from the palette) to start a new thread pre-seeded with an `@` mention of that note
- **Watch a document** — right-click a note (or run the command) to have the active thread watch it for changes; any edit sends that thread an alert, whether the edit came from you, another thread, or an external sync — also callable by agents via the `watch_document` MCP tool
- **Push-to-talk voice input** — hold a configurable hotkey to dictate a message via speech-to-text (uses the Claude Code STT pipeline); transcript populates the input box ready to send or edit
- **Projects** — group threads, choose their initial working directory, and inject shared context into every message (a context aid, not a tool or filesystem security boundary)
- **Draft persistence** — input text and attachments auto-save when switching threads and survive plugin reloads
- **First-run onboarding** — on a brand-new install, Agent Threads opens the conversation and Agents List panels, adds the [Chief of Staff](https://github.com/rbcodelabs/chief-of-staff) skill source (pinned to the pack release that shipped with this plugin version; each plugin release bumps it), and starts a **Chief of Staff** thread that runs `cos-setup` to get you set up. It runs on Claude Code or Codex (OpenCode sessions don't load skill sources yet). If that can't start (offline, git or a supported agent harness not installed yet), you get the static getting-started guide instead. The Chief of Staff thread can't use the shell: Bash is blocked for it and for the scheduled rituals and sub-threads it creates. Run **Set up Chief of Staff** from the command palette any time; it reopens your existing Chief of Staff thread rather than creating a second one. Turn off **Settings → General → Offer Chief of Staff on first run** to always get the static guide.
- **Context recap banner** — when you return to a thread you haven't viewed in over a minute, a floating banner shows the thread summary and how long ago you were last active; auto-dismisses after 10 seconds
- **Keep computer awake** — prevents the computer from sleeping while Claude is active; shows a ☕ indicator in the status bar (uses Geode's native Electron power-save blocker when available, with `caffeinate -i` for Obsidian on macOS and the Web Wake Lock API as fallback)
- **Plan Mode** — Claude and Codex can propose a written plan before making any mutations, and Codex can autonomously invoke `EnterPlanMode` when a task needs investigation first. An inline card lets you **Approve**, **Edit**, or **Reject** the plan with optional revision feedback before execution begins
- **Thinking mode** — enable extended thinking for harder problems, with a configurable token budget for how long Claude reasons before responding
- **Provider-aware effort** — Claude keeps its `low` through `max` effort controls; Codex has a separate setting through `ultra`, where Ultra enables proactive native agents on models that advertise support
- **MCP Elicitation** — when an MCP server needs OAuth or a form filled mid-session, a card appears inline in the conversation (URL auth or structured form fields) so you can respond without leaving Agent Threads
- **Tool call visibility** — see exactly which files the active Claude or Codex agent is reading/writing during each response; tool pills show elapsed time once complete, REPL calls get a dedicated icon and summary, and git operations render as structured pills; files the agent edited that you subsequently modified show a "Modified by user" badge; a tool call that's auto-denied without a prompt (in `auto` or `dontAsk` mode, or by a deny rule) shows a distinct "Auto-denied" annotation so the denial is visible instead of silently swallowed
- **Tool call grouping** — consecutive calls of the same kind (e.g. a run of file reads, or a string of edits) collapse into a single expandable group instead of a long scroll of individual pills, live as the turn runs (not just after it settles) — so a long agentic run never grows an unbounded wall of pills while Claude is still working; the in-progress group shows a "still running" pulse, the group you expand mid-turn stays expanded as more calls arrive, and a group containing a failed call auto-expands and stays flagged so errors are never hidden. Short off-kind interruptions (e.g. a single `TaskUpdate` between two runs of file reads) are folded back into their surrounding group instead of breaking it into extra short entries, and if the list is still long after that smoothing, it collapses one level further into a second "N tool calls, M steps" wrapper — which itself shows a live-updating "currently running" tool name and icon while the turn is in progress, and auto-expands through both levels if a call anywhere inside it fails. Works on both desktop and mobile (mobile gets the smoothing pass only — the second collapsible tier and live header are desktop-only).
- **Inline visualizations** — when Codex's `visualize` skill emits its wrapped `visualize{"path":…}` content reference, the chart renders live and interactive right where it belongs in the message instead of leaking as raw text. Legacy bare `visualize{"path":…}` references in existing conversations remain supported. The HTML fragment is wrapped in a themed document that maps the skill's design tokens onto your theme's colours, so it looks native in both light and dark, and runs in a locked-down sandbox (`allow-scripts` only, no same-origin, no network beyond the skill's documented CDN allowlist). The card sizes itself to its content, and a pop-out button opens it full size in the Web Viewer. Desktop only; on mobile the marker renders as a card with an "Open visualization" button when the file is in your synced vault. Toggle under Settings → Tools → Inline visualizations
- **Cancel and restore** — press Escape (or click Stop) while Claude or Codex is running to cancel; the sent message pops back into the input box ready to edit and re-send
- **Keyboard shortcuts** — navigate tabs without touching the mouse

## Prerequisites

- Obsidian v1.0.0+ or a compatible Geode desktop host
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
  - The plugin auto-detects `claude` at `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, or `~/.local/bin/claude`
  - AWS Bedrock / SSO users: set `AWS_PROFILE` and `AWS_REGION` in the plugin's Extra Environment Variables setting
- Or [OpenAI Codex CLI](https://developers.openai.com/codex/cli/) installed and authenticated
  - Select **OpenAI Codex** in Settings → Agent → Agent harness. The plugin launches Codex's local app-server, so its threads retain Codex session history, streaming output, tool visibility, interruption, and approval prompts.
- Or [OpenCode](https://opencode.ai) installed (desktop only), with at least one provider configured in OpenCode (for example `OPENAI_API_KEY` in your environment or Extra Environment Variables, or `opencode auth login`)
  - Select **OpenCode** in Settings → Agent → Agent harness. Each OpenCode thread runs its own local `opencode serve`, so any provider OpenCode supports can drive a thread. Usage is billed by that provider to your API key.

## Roadmap

Vote on upcoming features and see what's in progress at the [public roadmap](https://compass.rbcodelabs.com/portal/rbcodelabs/claude-threads/roadmap).

## Installation

### Via BRAT (recommended for early access)

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) from Obsidian's Community Plugins
2. Open BRAT settings → **Add Beta Plugin**
3. Enter: `rbcodelabs/obsidian-claude-threads`
4. Enable **Agent Threads** in Settings → Community Plugins

### Manual install

1. Download the latest release from [GitHub Releases](https://github.com/rbcodelabs/obsidian-claude-threads/releases)
2. Extract into your vault's plugin folder: `<vault>/.obsidian/plugins/claude-threads/`
3. Enable **Agent Threads** in Settings → Community Plugins

> **Upgrade compatibility:** the repository, plugin ID, install folder, saved command IDs, workspace view types, and `claude_threads` MCP namespace retain their historical names so existing installations, hotkeys, layouts, and automations continue to work.

## Usage

Click the **message-square** icon in the left ribbon, or run **Open Agent Threads** from the command palette.

### Agent harnesses

New threads use the harness selected in **Settings → Agent → Agent harness**. A thread remembers its harness, so changing the default never mixes Claude, Codex, and OpenCode session IDs. To move an idle existing thread, open its footer menu, choose **Harness**, and select Claude, Codex, or OpenCode. The transcript and thread identity remain in place, while the target starts a fresh native session from a bounded summary and transcript references. Threads with active work, queued input, approvals, plans, questions, or background agents must settle first. Codex uses the `codex` executable on your PATH by default and OpenCode uses `opencode` (auto-detected in Homebrew, `/usr/local/bin`, and `~/.opencode/bin`); set a custom path in the same settings panel when needed. OpenCode model IDs use `provider/model` form (for example `openai/gpt-5`); the thread model menu lists the models OpenCode reports.

| Capability | Claude Code | OpenAI Codex | OpenCode |
|---|---:|---:|---:|
| Persistent sessions, streaming, tools, images, interruption | ✓ | ✓ | ✓ |
| Models, permission modes, and approvals | ✓ | ✓ | ✓ any OpenCode provider |
| Plan review card | ✓ | ✓ | — read-only `plan` agent, no approval card |
| Built-in vault/workspace tools and external stdio/HTTP/SSE MCP servers | ✓ | ✓ | ✓ via a local MCP bridge |
| MCP form/URL elicitation | ✓ | ✓ | — |
| Persisted user-question cards on desktop and mobile | ✓ `AskUserQuestion` | ✓ `request_user_input` | ✓ `question` |
| Context usage and raw event logs | ✓ | ✓ | ✓ |
| Skills and sub-agent/task activity | ✓ Claude-native | ✓ Codex-native | — child sessions run, not shown as agents |
| Monetary API cost attribution | ✓ | — protocol does not report cost | ✓ |

OpenCode permission modes are applied live by Agent Threads: read-only tools (read, glob, grep, list) always run; **Accept edits** auto-approves file edits; **Bypass**/**Auto** approve everything; **Don't ask** denies anything that would prompt (so scheduled runs never stall); **Plan** uses OpenCode's read-only `plan` agent and refuses edits.

Codex JSONL logs compact repetitive protocol updates automatically. Completed items (including command output and plans) are preserved unchanged. The latest diff snapshot per thread/turn is kept; snapshots larger than 512 KiB retain a UTF-8 tail with explicit omission counts. Command-output and plan deltas retain at most 64 KiB per item until completion; when all streamed bytes fit and the completed output contains them, the duplicate is discarded. Otherwise a `codex/log/compacted` diagnostic records the tail, source event, original/retained/omitted byte counts, and flush reason. Pending payload is limited to 4 MiB and 128 entries; older entries flush when either limit is reached. Pending events also flush at turn completion and session close/process exit or error. An abrupt host crash can lose pending buffers. This reduces redundant logging but is not a hard file-size cap, and existing logs are not rewritten.

Harness-native skills and sub-agents use their respective CLI's definitions and event protocol; they are presented through the same slash-command and task UI where the protocols expose equivalent data.

Codex `request_user_input` prompts use the same persisted question card as Claude: option labels and descriptions are preserved, free-form answers use stable Codex question IDs, and secret fields are masked on desktop and mobile. Default-mode questions are enabled only when the installed app-server advertises the required runtime feature; older Codex installations continue normally without that Default-mode capability.

Codex reasoning effort is configured separately from Claude effort. Selecting **Ultra** enables Codex's proactive native-agent behavior on models that advertise Ultra support. Unsupported model/effort combinations fail before a turn starts with a clear error, and Agent Threads never sends Codex's deprecated `multiAgentMode` field.

**Codex computer use** is off by default in **Settings → Agent**. Off requests denied default app access and disables Codex's bundled computer-use plugins and known desktop-capable MCP entry points, including the legacy `node_repl` server. This can also remove the shared Codex browser REPL; Agent Threads' own browser tools are unaffected. On inherits your local Codex configuration, without installing tools or overriding its access restrictions. Changes apply when sessions next start or restart, including resumed threads. Existing running and idle sessions keep their current access; use **Reload plugin (safe)** after active work finishes to apply the choice to all sessions. This setting does not restrict arbitrary third-party automation tools or replace OS permissions.

Agent profiles supplied by installed GitHub plugin sources remain native agent definitions in Claude and are available to Codex as role instructions for delegation.

### Tabs

| Action | How |
|---|---|
| New thread | Click `+` in the tab bar |
| Close thread | Hover a tab → click `×` |
| Rename thread | Right-click the workspace tab → **Rename thread**, click the header pencil, or choose **Rename thread** in the thread switcher. You can also double-click the conversation title (inside the pane). Enter saves; Escape cancels. |
| Switch to tab N | `Cmd+1` through `Cmd+9` |
| Next / previous tab | `Cmd+]` / `Cmd+[` |

Tabs are renamed automatically once the first turn completes, using the thread summarizer — no need to name them yourself. Rename a tab yourself and the auto-naming backs off and leaves it alone. See [Thread summaries](#thread-summaries).

### Sending messages

In the Agents List, the selected thread has an accent-tinted background and a trailing accent bar. Leading status and attention indicators remain visible alongside the selection.

- **Enter** — send message
- **Shift+Enter** — newline
- **`/`** — opens slash command autocomplete
- **Escape** — cancel the running session; the sent message is restored to the input box so you can edit and re-send

**Collapsible input panels.** All three message-input panels (Threads view, Agents List sidebar, and Agent Board dispatch) collapse to a minimal bar at rest — just the textarea and send button. Hover over the panel or click into the textarea to expand secondary controls (context pill, more menu, attach, mic) with a smooth animation. The panel border softens when collapsed so it reads as a quiet background element.

**Composer context pill.** The footer carries a single control naming where the thread is working — `Project · folder`, or just the folder name when the thread has no Project (and just the Project name when the two would read the same). It shrinks and ellipsizes on a narrow pane instead of disappearing, so the working context stays visible where the old separate chips did not. Click it for the full Project name, the full path, and **Change project…** on threads that can be moved.

**Message queue.** If you send a message while Claude is already processing, it goes into a queue — displayed as stacked removable rows above the composer. Each row shows a preview of the queued message and an `×` button to discard it. Click any row to pull it back into the input box for editing (an inline confirm prompt prevents you from accidentally discarding your current draft). The queue drains automatically as Claude finishes each turn. Queued messages survive thread switches and plugin reloads.

<p align="center">
  <img src="docs/screenshot-queue-rows.png" width="800" alt="Message queue rows — stacked removable chips above the composer showing queued messages" />
</p>

**Activity indicator.** While Claude is processing, a typed status card appears above the input area showing what's happening:

- **Active work** — a pulsing spinner with a short label (e.g. "Compacting context…" during automatic compaction, "Retrying API call…" on transient errors). The card disappears as soon as the operation completes.
- **Rate limit** — if the API returns a rate limit response, a card shows in warning or error style depending on whether the request was allowed to proceed or rejected outright.
- **Model escalation tip** — when a turn is routed to the escalation model (e.g. Fable 5 when you send `/escalate`), a brief tooltip pops up from the composer's menu button rather than reshuffling the layout. It fades in, holds for a moment, then fades out automatically — no interaction needed and zero layout shift. For the rest of the escalated turn, the menu's model row reads "Model: \<model\> (this turn)", so you can confirm the escalation at any point until the turn completes.

**Idle spinners pause automatically.** A thread parked at an unanswered plan/permission prompt (or otherwise wedged) stays "running" until you answer it, but its infinite spinner animations freeze after ~45s of no progress instead of compositing forever — this keeps a stuck thread from pinning the renderer's CPU. Answering the prompt resumes progress and the spinner un-freezes. A thread waiting on an ExitPlanMode plan approval also shows the calmer **Awaiting** indicator rather than the aggressive running spinner.

<p align="center">
  <img src="docs/screenshot-status-rail.png" width="800" alt="Status rail — active-work card with spinner above the composer" />
</p>

### Slash commands

Type `/` in the input box to see built-in context commands and your installed Claude Code skills. Navigate with arrow keys, Tab, or Enter.

Enabled peer plugins can also contribute commands to the thread composer and/or new-thread dispatch boxes through `extensions.registerSlashCommand`. Their commands appear immediately, use the same dropdown and command pills, and disappear when the peer disposes its registration. Host commands retain priority. A failed contributed dispatch restores the draft and attachments instead of sending the command text to the agent. `/design` is supplied by the separate **Design for Agent Threads** plugin.

**Built-in commands** (handled by the plugin):

| Command | What it does |
|---|---|
| `/model fable\|opus\|sonnet\|haiku` | Set a persistent model for this thread |
| `/model default` | Reset thread model back to the global default |
| `/model` | Show the current model for this thread |
| `/goal <text>` | Set a persistent goal for this thread — injected into every turn until cleared |
| `/goal clear` | Clear the thread's goal (`/goal` alone shows the current goal) |
| `/loop <interval> <prompt>` | Send a prompt now and re-run it on an interval (e.g. `/loop 10m check CI`); replaces any loop already running on this thread |
| `/loop stop` | Stop the thread's loop (`/loop` alone shows it) |
| `/compact` | Summarize conversation history to free up context window |
| `/clear` | Clear conversation history and start a fresh session |
| `/cost` | Show token usage and cost for the current session |
| `/usage` | Show provider token totals, quota windows/resets, and account activity where available. For Claude subscription sessions the 5-hour and 7-day windows show a live utilization % pulled from the SDK's structured usage API; API-key/Bedrock/Vertex sessions show `—` because plan limits do not apply there. |
| `/context` | Show a per-category token usage breakdown for the active session (tools, system prompt, skills, MCP tools, conversation, etc.) |
| `/create-pr` | Send the configured **Create PR message** to the active agent — same action as the [git diff bar](#git-diff-bar-create-pr)'s Create PR button |
| `/create-pr --draft` | Send the configured **Create draft PR message** — same as the git diff bar's Create draft PR button |
| `/design <brief>` | Start a new design thread from the Agents List or Agent Board, or create or revise a secure static UI artifact in the current thread, and open it in Geode's ArtifactView |
| `/escalate <prompt>` | Route just this turn to the [escalation model](#model-switching) (default `/escalate`, keyword and target model configurable in Settings; only shown when escalation is enabled) |

### Design artifacts in Geode

Install and enable **Design for Agent Threads** alongside Agent Threads to add `/design`, `EnterDesignMode`, previews, capture, and artifact creation. Without it, existing legacy design artifacts remain visible and their source can still be revealed, but new Design commands and tools are not registered.

Starting in v0.43.0, Design is no longer built in. Download [Design v0.1.0](https://github.com/rbcodelabs/threads-design/releases/tag/v0.1.0) and follow its installation instructions; its repository is currently private and requires access. Enable Agent Threads first, then Design. If you need Design but cannot access that repository, keep v0.42.0 until you can obtain the companion plugin. Interactive preview and screenshot capture require Geode; Obsidian reveals the artifact source instead.

Use `/design <brief>` from the Agents List or Agent Board dispatch box to create a new design thread, or use it in an existing thread to create or revise that thread's artifact. Threads creates a zero-install static UI artifact under `.geode/artifacts/` in your vault, and the agent edits ordinary `index.html`, `styles.css`, `app.js`, and local asset files. The artifact card keeps a primary **Preview** button plus icon-only **Capture design screenshot** and **Reveal design source** buttons (hover either for its label) available after the turn and after reopening the thread. Run `/design` with no brief inside a thread to reopen its existing preview; a new-thread dispatch always requires a brief. Design dispatch does not currently accept image or text attachments.

Geode's ArtifactView previews the result with live reload, desktop/tablet/mobile viewport controls, runtime diagnostics, and PNG capture. Artifacts run in an isolated, ephemeral, Node-less guest with network, clipboard, downloads, popups, and external navigation denied. Outside Geode, Threads reveals the source instead of launching the artifact without that sandbox.

**Command pills** — when you complete a built-in command (type `/goal ` or pick one from the dropdown), it turns into a pill chip at the left of the input box. Type the arguments after it; a single Backspace at the start of the input (or clicking the pill's ×) deletes the whole command. After a command, argument autocomplete kicks in — `/model ` offers `fable|opus|sonnet|haiku|default`.

**Skills** — every skill available to the session appears below the built-in commands: your `~/.claude/skills/` library (invoked bare, e.g. `/my-skill`), skills the plugin installed into the vault (namespaced under the `vault` plugin, e.g. `/vault:my-skill`), and skills from any configured plugin source (namespaced after themselves, e.g. `/my-skill:my-skill`). The autocomplete shows the name you actually invoke, so what you pick is what resolves.

### Skills Manager

Open the **Skills Manager** from the ribbon (puzzle icon) or command palette to browse, install, and edit Claude Code skills. New views open in the right sidebar under conversation-first placement (creating it if it isn't open yet), or a main document tab under classic placement — matching where the Agents List opens; if Skills Manager is already open, it is focused without moving it or discarding edits. The list and detail panels are split by a **draggable divider** — drag it to resize, double-click to reset to the default width; your chosen width is remembered next time you open the view.

**In a narrow pane** — a sidebar, a split view, or on mobile — there isn't room for both panels side by side, so the view shows **one at a time**: the list until you pick something, then that item's detail panel with a **← back** button to return to the list. The divider is hidden in this mode, and the panel responds to its own width rather than the window's, so widening the sidebar past roughly 480px restores the two-panel layout on the spot. If you have unsaved edits, going back asks before discarding them.

<p align="center">
  <img src="docs/screenshot-skills-manager.png" width="800" alt="Skills Manager: source tree on the left with skill/agent detail and editor on the right" />
</p>

**Installed tab** — shows everything installed as a collapsible source tree. The top-right corner of the tab bar has two icon buttons (Installed tab only): **Import** (+) opens a menu with **Folder…** and **File (.skill)…**, letting you install a skill directly from a local folder or a packaged `.skill`/`.zip` archive without going through GitHub; and **Check for updates** (↻, shown once you have at least one GitHub plugin source) re-fetches staleness for all GitHub plugin sources in parallel — its icon spins while running, and a toast reports the result when it finishes (including which sources failed to check, e.g. if you're offline). An indicator dot appears on the button afterward if any plugin has updates (hover either button for its full status/tooltip). GitHub plugin sources appear as top-level nodes with a badge (`•N`) when updates are available; clicking one expands it to reveal its skills and opens a detail panel with **Update** (git pull, highlighted when updates are available), **Reload** (re-scan from disk), **Reinstall** (delete and re-clone for broken installs), and **Remove Source**. Two more nodes sit at the bottom. **Vault** lists the skills this plugin installed into your vault — click one to view and edit it, with **Save**, **Reload**, **Reveal in Finder**, and **Uninstall**. **Claude Code** lists everything in `~/.claude/` (skills *and* agent profiles), marked `read-only`: the plugin shows them because the Claude CLI genuinely loads them into every session, but it never writes to that directory, so those panes offer only **Reload** and **Reveal in Finder**. Edit or remove them with the `claude` CLI, or by hand.

> **Where installs go.** Everything the Skills Manager installs or imports lands in `<vault>/.obsidian/plugins/claude-threads/skills/`, beside the plugin's `skill-sources/` clones — never in `~/.claude/`. That folder shares the plugin folder's fate: community-plugin *updates* leave unknown subdirectories alone, but manually uninstalling and reinstalling the plugin will delete your installed skills along with it.

Click a GitHub source's **chevron** to expand or collapse its skills while staying in the list. Click the rest of the source row to open its details. In narrow panes, this lets you browse the expanded skills without switching screens.

#### Authoring local skills

Choose **New skill** in Skills Manager, enter a lowercase identifier such as `meeting-notes`, and edit the starter `SKILL.md`. Authored packages appear under **Local skills** and live in `<vault>/Skills/<identifier>/`. Set **Settings → Skills → Local skills folder** to another vault-relative folder. Changing it does not move files. Marketplace installs, imports, and GitHub source clones retain their existing locations; nothing is migrated.

Agents can use `skills_create_local({ skillId, skillMd, files? })` and `skills_update_local({ skillId, files?, deleteFiles? })`. Each file is `{ path, encoding: "utf8" | "base64", content }`, relative to the package. Creation requires YAML frontmatter with a `name` matching the identifier and a nonempty `description`. Updates preserve omitted files and remove only explicitly listed paths; `SKILL.md` can be replaced but cannot be deleted. Paths cannot traverse outside the package or follow symlinks. Supporting files can be managed through these tools or the filesystem.

Authored skills are available in newly started Claude and Codex sessions as `/local:<identifier>`. Active sessions are not restarted. Installed Claude skills retain `/vault:<name>`. Use qualified identifiers from `skills_list_installed`, such as `local:meeting-notes`, with `skills_get` and `skills_uninstall` to distinguish same-named packages. Ambiguous removal involving an authored skill is rejected. `skills_update` continues to pull configured GitHub sources.

#### Declaring skill sources in config

GitHub skill sources don't have to be added through the UI. A vault whose `data.json` is committed to a config repo can **declare** them, and the plugin materializes each one on load:

```jsonc
"skillSources": [
  { "id": "", "name": "Agentic PM Playbook", "type": "github",
    "repoUrl": "https://github.com/owner/repo" }
]
```

`repoUrl` is the only field that matters. Both machine-specific fields are filled in for you and written back to `data.json` on first load:

- **`id`** — derived deterministically from `repoUrl` (a `gh-<hex>` digest prefix), so the same declared config resolves to the same id, and therefore the same clone directory, on every machine. Sources you add through the UI keep their random UUID.
- **`clonePath`** — computed as `<vault>/<plugin-dir>/skill-sources/<id>`, so an absolute path never has to be committed.

Three things to know about the pass:

- **Clone-if-missing only.** An existing clone is never fetched or pulled on launch — that would add network latency to every startup and swap skills out from under a running session. Updating stays explicit: the **Check for updates** button, **Update** in a source's detail panel, or the `skills_check_updates` / `skills_update` tools.
- **It cannot delay or break startup.** It runs after the workspace is laid out, is never awaited by plugin load, and shells out to `git` asynchronously. Each source is attempted independently: a private repo, an unreachable host, a rate limit, a missing `git` binary or a 60-second timeout is logged to the console and skipped, leaving every other source unaffected. A source still cloning when a thread starts is picked up by the next session.
- **It only creates what it owns.** `type: "local"` sources are left alone, as are hand-edited `clonePath`s pointing outside the managed `skill-sources/` folder.

This also repairs a source whose clone has gone missing — previously a source listed in settings with no directory on disk was silently inert, contributing no skills and no error. Use **Reinstall** in the source's detail panel to force a re-clone of one that is present but broken.

**Browse tab** — search the [skills.sh](https://skills.sh) registry. Results show the skill name, GitHub source, and install count. Click a result to see details and an **Install** button that clones the skill from GitHub into `<vault>/.obsidian/plugins/claude-threads/skills/`. Installed skills are invoked as `/vault:<name>`.

### @ file mentions

Type `@` anywhere in the input box to search vault files by name. A dropdown appears showing up to 20 matching files — navigate with arrow keys and press Tab or Enter to insert.

<p align="center">
  <img src="docs/screenshot-file-mention.png" width="800" alt="@ file mention autocomplete — type @ to search vault files and inject their content as context" />
</p>

Selecting a file inserts `@[[filename]]` into your message. When you send the message, the plugin resolves each mention and appends the file's full content as context for Claude — useful for asking Claude to work with a specific note, doc, or config file without copying and pasting.

Type `@this` (no search needed) to instantly reference the currently active file in the host workspace. It resolves to the same `@[[filename]]` injection at send time.

### Chat about this document

To start from a note rather than from the composer, use **Chat about this document**. It is available from three places:

- **Right-click a note in the file explorer**
- **Right-click inside an open note** (editor context menu)
- **Command palette** → *Chat about this document* (acts on the currently open note; hidden when the active file isn't a note)

All three open the **Agents List** and seed its dispatch box with `@[[<note name>]] `, with the cursor after the mention — type your question and send. Because it seeds the dispatch box, submitting always starts a **new thread** rather than adding to an open one, and the mention resolves to the note's full content exactly like a manually typed `@` mention.

The draft is appended to, never overwritten: if you had already typed something, the mention is added to the end, and triggering the action twice on the same note won't inline it twice. The action only appears on Markdown notes, since that's what the mention resolver can read back.

### Watch a document

To have a thread notice when a note changes without polling it yourself, use **Watch this document**. It is available from the same three places as *Chat about this document*:

- **Right-click a note in the file explorer**
- **Right-click inside an open note** (editor context menu)
- **Command palette** → *Watch this document* / *Stop watching this document* (label flips depending on whether the active thread is already watching the active file)

The watch is owned by whichever thread is currently active when you trigger it — only that thread is alerted, and it stays alerted even if you switch away. If no thread is open, a notice asks you to open or start one first. When the note's content changes — from you, from another thread's edit, from a sync, from anyone — the owning thread receives an injected message referencing the file with the same `@[[filename]]` mention the composer uses, so the full content is right there in the alert. Saving a note with no actual content change (e.g. a no-op resave) does not trigger an alert, and a burst of edits to multiple watched files collapses into one batched message instead of one per file. Renaming a watched file keeps the watch attached; deleting it sends one final alert and removes the watch.

Agents can do all of this without the menu via three MCP tools — see [`watch_document`](#session-tools) below. Manage active watches, see who owns each one, and unwatch from outside the file itself under **Settings → Scheduled → Watched documents**.

### Agent browser

Claude can drive a browser **inside Geode**, using the same embedded web view that powers Web Viewer tabs, instead of launching a separate Chrome. That removes the second browser process entirely — and with it the pile of orphaned Chrome instances that an external automation CLI leaves behind.

Turn it on under **Settings → Tools → Agent browser**, then reload. The toggle is disabled on hosts that can't support it (see *Limits* below).

Pages are read as an **accessibility snapshot** rather than screenshots or raw HTML — a compact list of the things a person could actually interact with:

```
- textbox "What needs doing?" [ref=e1]
- button "Submit the form" [ref=e2]
- link "Documentation" [ref=e3]
```

Claude reads that, hands back a ref, and acts on it. No coordinate guessing, no brittle CSS selectors. Hidden and disabled elements are left out, so every ref is something you could have clicked yourself.

| Tool | What it does |
|---|---|
| `browser_navigate` | Open a URL and return a snapshot |
| `browser_snapshot` | Re-read the current page |
| `browser_read_text` | Visible page prose, for when the snapshot isn't enough |
| `browser_click` / `browser_type` | Act on a ref |
| `browser_screenshot` | PNG of the current page |
| `browser_status` | How many sessions are open, and the cap |
| `browser_close` | End this thread's session |

**Watching it work.** Run **Open Agent Browser** from the command palette for a sidebar pane showing live frames, the page, session age, and a stop button. It streams only while visible, and closing it never closes Claude's session.

**Resource limits.** Each session is a real browser process, so they're capped (2 by default, 4 maximum), reclaimed after 5 minutes idle, recycled after 30 minutes, and closed automatically when their thread is deleted or the plugin unloads. Geode measures file-descriptor pressure, and the browser refuses to start a session when the app is running low — the specific condition under which a sandboxed page process dies on arrival.

**Safety.** Sessions use their own cookie jar, separate from your Web Viewer tabs, so you'll be logged out of most sites. Page text is handed to Claude wrapped as untrusted data rather than as instructions. Typing a stored secret into a page is refused outright. `file:`, `javascript:` and cloud metadata addresses are blocked; private network addresses are behind an opt-in.

**Limits.** Geode desktop only — it needs the process diagnostics Obsidian doesn't expose, and mobile has no embedded web view at all. Top frame only, no iframes, file uploads, or multiple tabs. It also can't drive Electron desktop apps, evade bot detection, or use cloud browsers; the `agent-browser` CLI skill still covers those.

### Model switching

`/model` sets the model for all subsequent turns in a thread:

```
/model fable    → uses Claude Fable 5 for every turn in this thread
/model opus     → uses Claude Opus for every turn in this thread
/model sonnet   → switches to Sonnet
/model haiku    → switches to Haiku
/model default  → resets to the plugin's Default model setting (or the CLI default)
```

A **Default model** dropdown in settings picks the model for threads that have no `/model` override. Family aliases (Fable / Opus / Sonnet / Haiku "latest") are always listed first; pinned model IDs are sourced from the SDK's `capabilities_discovered` event, which fires the first time a thread starts in the current host session. Before any thread has run, the dropdown falls back to a hardcoded list of current models — start a thread and reopen Settings to see the full CLI-sourced list, so no plugin update is needed when Anthropic adds a new model. The Escalation model dropdown is populated the same way.

You can also switch models without typing: open the **menu button** in the conversation footer and pick the **Model** row, which names the model currently in effect. Choosing it opens the Default / Opus / Sonnet / Haiku / Fable list, and it stays in sync with the `/model` command.

The active model is shown as a badge in the thread info bar. You can also use `/escalate` as a one-turn override — it routes just that message to the Escalation model chosen in settings (Fable 5, Opus, Sonnet, or Haiku), then the thread model resumes. Both the keyword and the target model are configurable, and (when escalation is enabled) the current keyword shows up alongside `/model`, `/goal`, etc. in the `/` autocomplete popup so it's discoverable without reading the docs — renaming the keyword or toggling escalation off in Settings updates the popup immediately. While an escalated turn is running, the footer menu's model row names the escalated model and marks it "(this turn)", so you always have visible confirmation that the escalation took effect. The label reverts automatically when the turn finishes.

When Claude refuses a response, Agent Threads shows the SDK-provided notice if Claude retries on a fallback model, and a clear notice when no fallback is available.

### Goals and loops

**Goals** — `/goal <text>` pins a persistent goal on a thread. You can also
right-click your latest text message in the main conversation and choose
**Set as goal**, which is useful when you forgot the `/goal` prefix. Older,
blank, and image-only messages do not offer the action.

Setting a goal does two things:

1. Claude immediately starts working toward it — no separate prompt needed.
2. The goal is injected into the authoritative system/developer context on
   **every subsequent turn**, so it survives context compaction, topic drift,
   and multi-day threads. If the thread is already active, its current work,
   permission request, or background task is allowed to settle before the
   session safely refreshes and starts the latest goal.

`/goal` alone shows the current goal; `/goal clear` (or `off`/`done`) removes it
and refreshes the session context without sending another kickoff.

**Loops** — `/loop <interval> <prompt>` re-sends a prompt to the thread on a schedule:

```
/loop 30s poll the deploy status     → every 30 seconds
/loop 5m check the build             → every 5 minutes
/loop 1h summarize new emails        → every hour
/loop 10 check CI                    → bare numbers mean minutes
```

Like `/goal`, starting a loop sends the prompt immediately — you don't wait for the
first interval to elapse. Intervals below 30 seconds are clamped to 30s. Loops run on
the plugin's built-in scheduler, so they **persist across plugin reloads and host app
restarts**. If a loop tick arrives before the thread's previous turn has finished, it's
retried shortly after rather than piling up as a queued duplicate. A thread can only
have one active loop at a time — starting a new `/loop` replaces whichever loop was
already running there. `/loop` alone lists the thread's loop with its next run time;
`/loop stop` (or `off`/`cancel`/`clear`) stops it. While a loop is active, a compact
scheduled-activity pill in the composer footer shows the interval. Click the pill
to see its next run and prompt, then use the row's **Stop** control. One-time
`ScheduleWakeup` entries appear in the same popover as distinct wakeup rows with
their own **Cancel** controls; when both are present the pill summarizes the next
item and adds a count (for example, `Resumes in 4m · +1`).

### Dispatching with commands

`/model`, `/goal`, and `/loop` also work as prefixes in the Agents List and Agent Board dispatch boxes, applying to the newly created thread:

- `/model opus fix the login bug` — creates the new thread with Opus set as its model and dispatches just the prompt
- `/goal ship the v1 login flow` — creates the thread with that persistent goal and immediately starts working toward it (same kickoff as `/goal` inside a thread)
- `/loop 10m check CI status` — creates the thread, sends the prompt now, and re-runs it every 10 minutes (stop it later with `/loop stop` inside the thread)

A command with bad or missing arguments shows a notice and keeps your draft instead of creating a thread. The thread-management variants (`/goal clear`, `/loop stop`) only work inside an existing thread.

`/escalate <prompt>` (when escalation is enabled) also appears in the dispatch box autocomplete — it creates the new thread and routes its first turn to the escalation model, same as using it mid-thread. A bare `/escalate` with no prompt shows a usage notice instead of dispatching.

### Context compaction

When the context window fills up, Claude compacts the conversation automatically. You can also trigger it manually with `/compact`. Either way, a divider appears in the conversation showing when compaction happened and how many tokens were in context beforehand. Compaction markers are persisted and survive plugin reloads.

### Agents List

Open the **Agents List** from the ribbon or command palette to see all threads at a glance. Its native host header shows the filtered thread count and standard icon actions for Search and Group; search opens in a separate content row so the title bar stays stable. The native Group menu has independent **Project** and **Status** toggles, supporting Project-only, Status-only, or the default Project + Status hierarchy. At least one grouping remains enabled, and the choice is saved for the next session. In Status-only mode, each row shows its resolved Project as context. The dispatch panel's themed **Project** pill opens a checked menu of configured Projects; choose **No Project** to use the global default working directory.

Adaptive two-line rows use **Working**, **Waiting**, **New**, **Reviewed**, **Failed**, and **Ready** status classification. The primary line shows status, title, orchestrator indicator when applicable, and recency; activity, repository/Project context, and agent count share a truncation-safe secondary line. Permission, question, plan, waiting, and AWS reauthentication states expand into dedicated action rows when your attention is required. Child-agent activity is summarized by one accessible agent-count control; it turns green only while at least one child agent is starting, working, or waiting, and otherwise uses the same faint secondary treatment as recency. Click it to open the team picker without losing your current agent selection.

The dispatch button shows the harness that will run the new thread: **Claude** or **Codex**. Click normally to start with the shown harness. Right-click, press and hold, or use `Shift+F10` while the button is focused to open the harness menu; choosing an option changes the button without dispatching. That choice stays with the mounted dashboard while you launch more threads. **Settings → Agent harness** supplies the initial default only—the dashboard choice does not change the global setting. Existing idle threads can be switched separately from the conversation footer menu.

**Live activity (running threads):** While a thread is actively processing, the dashboard shows a live one-line summary of the current tool call or step — so you can see "Reading src/components/Header.tsx" or "Running npm test" without switching to that tab.

**Auto-generated summaries (idle threads):** Once per completed turn, the summarizer runs in a lightweight background process (a separate Claude Code instance using a small model, with no tools or MCP servers loaded) and writes a multi-sentence recap of what that thread worked on. It runs for background and scheduled threads too, so the dashboard stays current for agents you aren't watching. This summary is shown in the dashboard row so you can re-orient yourself to any thread at a glance — what it accomplished, what files it touched, what's left to do.

This combination means you can dispatch several threads in parallel, switch to other work, then return to the dashboard to understand the state of every agent without reading through each conversation.

You can also send messages to any thread directly from the dashboard without switching tabs.

**Background tasks stay "Working."** A thread that spawns a background subagent (`Agent(..., run_in_background: true)`) or runs the `Workflow` tool can have its own turn finish — and its activity line stop updating — before that spawned work actually completes server-side. Rather than misclassifying the thread as New/Reviewed/Ready the moment the outer turn ends, the Agents List (and the [Agent Board](#kanban-board)) keeps it under **Working** until the background task or workflow reports back.

If a background task finishes while its thread is actively streaming, the running turn's live task pill shows the result inline. If it finishes after the thread has gone idle, a ✓/✗ summary is appended directly into that thread's conversation as a subtle notice row (aligned with the tool rows above it), instead of a transient top-right toast — so it's still there if you open the thread later or scroll back, rather than something you had to catch in the moment.

**Scheduled Jobs.** An hourly (or more frequent) recurring cron task (see `CronCreate` / `ScheduleWakeup` below) can produce dozens of quiet threads a day, burying the manually-created ones you actually need to triage. When a run created by the scheduler is unreviewed, reviewed, or empty — never one that's running, awaiting a permission/question, or errored — it's pulled out of its normal group into a **Scheduled Jobs** section at the bottom of the dashboard, one collapsed row per job showing its name, run count, and the latest run's time. Click a row to expand it into the individual runs. Disable via **Settings → Features → Stack scheduled job threads**.

**Archive from the list (right-click).** Right-click any thread row — in the Agents List or on an [Agent Board](#kanban-board) card — for an **Archive thread** action, so you don't have to open a thread just to close it. Archiving writes the thread to its vault note and removes it from the live list, exactly like the `×` on a thread tab; a run with no messages is dropped without leaving an empty note behind.

Right-clicking a **Scheduled Jobs** rollup row (or an Agent Board stack card's header) archives the whole rollup at once — **Archive these N runs**. Because one job's runs can be split across several groups (New, Reviewed, Ready) and Projects, a second item, **Archive all M runs of this job**, appears whenever the job has runs the rollup you clicked isn't showing. That turns "clear 14 runs of last night's cron job" into one action instead of fourteen.

You are asked to confirm only when there is something to lose, and never more than once per action: archiving a thread that is still running (it stops the session), archiving a Portfolio or Project Orchestrator, or archiving more than one run at a time. A combination — say, a bulk archive that includes a running orchestrator — still asks exactly once, in a single dialog listing every reason. Archiving a single idle thread happens immediately. Any pending `ScheduleWakeup` on an archived thread is cancelled, so it can't come back to life afterwards. The last remaining thread can't be archived. This is a desktop-only interaction for now — Obsidian Mobile does not fire a right-click gesture.

### Inline workflow progress

When a thread runs the `Workflow` tool (multi-agent orchestration), a live progress block appears inline in the conversation — pinned above the streaming output — showing:

- **Workflow name** and **current phase** (updates as the workflow transitions between phases)
- **Per-agent rows** — each spawned sub-agent gets a row with a dot (pulsing while running, filled when done, ✗ on failure) and its task description. Rows appear as agents are launched and update in place as they complete; they don't disappear, so you can see the full run at a glance even before the workflow finishes.
- **Done / Failed badge** — when the workflow completes, the block locks into a final state with a "Done" or "Failed" annotation.

<p align="center">
  <img src="docs/screenshot-workflow-progress.png" width="800" alt="Inline workflow progress block — live agent rows with running/done dots and a phase label" />
</p>

The block is rendered entirely from the SDK event stream (no extra API calls), so it appears immediately when the first sub-agent starts and has zero overhead for threads that don't use workflows.

<a id="kanban-board"></a>

### Agent Board

Open the **Agent Board** from its **kanban** icon in the left ribbon, the **Agent Board** button in the Agents List toolbar, or **Open Agent Board** in the command palette. Each thread is a card, bucketed into a column for its agent state: **Working** (also covers a thread whose own turn has ended but a background subagent or `Workflow` task it spawned hasn't reported back yet — see [Agents List](#agents-list)), **Awaiting** (permission), **Waiting** (a `ScheduleWakeup` is pending — shows a live countdown, e.g. "Resumes in 4m — check CI status"), **New** (unreviewed), **Done**, **Failed**, and **Ready** (empty). Columns are sorted most-recently-active first. The board has its own floating dispatch panel at the bottom — type a task and press Enter to launch a new thread without leaving it.

The Agent Board dispatch button uses the same [Claude/Codex kickoff selector](#agents-list): its icon identifies the harness, while right-click, press-and-hold, or `Shift+F10` opens the menu without taking up another permanent control. A card's child-agent count uses the same activity treatment as the Agents List: green while any child is active, faint once all runs are terminal.

Cards support the same right-click **Archive** action as Agents List rows, including the bulk archive for scheduled-job stack cards — right-click the stack card's header row. See [Agents List](#agents-list) for the full behavior.

**Task list on cards.** When a thread has an active Claude `TodoWrite` / `TaskCreate` checklist or Codex `update_plan` checklist, its Agent Board card shows a compact task list: up to 5 items with status icons (✔ completed, ■ in-progress, ○ pending), a "X / Y done" progress line, and "+N more" when there are additional tasks. The list updates live as the agent ticks items off.

<p align="center">
  <img src="docs/screenshot-kanban-status.png" width="800" alt="Agent Board grouped by status — Working, Awaiting, Waiting, New, Done, Failed, and Ready columns, each holding thread cards" />
</p>

**Auto-collapse side panels.** Set **Settings → Features → Agent Board → Auto-collapse side panel** to `Left sidebar`, `Right sidebar`, or `Both sidebars` to automatically collapse the host's sidebar panel(s) when the Agent Board tab opens, giving the board more horizontal room. Only the panel(s) the Agent Board view collapsed are restored when you close the tab, so it won't fight a panel you collapsed or expanded manually. Defaults to `None` (opt-in).

**Group by folder or project.** The group-by toggle in the board header (the icon next to search) cycles through three layouts: **status columns** (the default), **folder swimlanes**, and **project columns**. Each click advances to the next; the choice persists across reloads.

- **Folder swimlanes** — one horizontal lane per app/project, so you can see every conversation for a given codebase together. Each lane is keyed by the thread's assigned **Project**. When no Project is assigned, a thread whose repository root matches a configured Project's effective cwd joins that Project; otherwise it falls back to a working-directory label (git repo name), and an **Unassigned** lane catches threads with no folder. For a thread whose cwd is a temporary `EnterWorktree` worktree, the repo name is remembered from when the worktree was created, so it still groups correctly under the origin repo even after that worktree directory is later deleted. Inside each lane the cards are still grouped into the same status columns (empty columns are hidden to keep lanes compact). Lanes are ordered alphabetically (case-insensitive), with Unassigned pinned last.
- **Project columns** — one vertical column per app/project (same project resolution as folder swimlanes, alphabetical with Unassigned last), with each column's cards grouped under status **section headers** — Working, Waiting, New, Reviewed, Failed, Ready — matching the Agents List sidebar's grouping. Awaiting-permission threads fold into **Working**, and empty sections are omitted. This gives a compact, scannable per-project view where each column reads top-to-bottom like a mini dashboard.

<p align="center">
  <img src="docs/screenshot-kanban-folder.png" width="800" alt="Agent Board grouped by folder — one horizontal swimlane per app/project, each with its own nested status columns" />
</p>

**Stacked scheduled-job threads.** Repeat runs of the same cron job pile up fast — an hourly triage job produces ~24 cards a day, crowding out the threads you started yourself. In the quiet columns only (**New**, **Done**/**Reviewed**, **Ready** — a run that's Working, Awaiting, Waiting, or Failed always stays its own card), runs that share a scheduled job collapse into a single dashed-border rollup card: job name, a "×N" run count, and the latest run's time. Click the card to expand it into the individual run cards, indented beneath. This applies in status-column, folder-swimlane, and project-column mode. Disable via **Settings → Features → Stack scheduled job threads**.

### Push-to-talk voice input

Hold the configured push-to-talk key (default: none — set it in Settings → Push to Talk Hotkey) and speak. The microphone activates while you hold the key; releasing it stops recording and transcribes your speech using the Claude Code STT pipeline. The transcript populates the input box so you can review and edit before sending. The floating input panel highlights while recording so you always know the mic is live.

### Permissions

When Claude or Codex needs to write a file or run a command, a permission card appears inline in the conversation asking you to **Allow**, **Deny**, or **Always Allow**. Always Allow adds the tool to a per-vault allowlist so you're never asked again for that tool. You can also resolve permissions directly from the Agents List without switching threads. The default behavior can be changed globally in **Settings → Tools → Permission Mode**, or **per-thread** via the **Permissions** row in the thread footer's menu — a thread-level override takes precedence over the global setting and is useful when you want plan mode for one specific task without affecting other threads:

| Mode | Behavior |
|---|---|
| `default` | Use the Claude CLI default (prompts for most tool calls) |
| `acceptEdits` | Automatically accept file edits; prompt for commands and other tools |
| `bypassPermissions` | Skip all permission prompts — Claude executes everything without asking |
| `plan` | The selected harness proposes a written plan before taking any action; you approve, edit, or reject it before it proceeds (see [Plan Mode](#plan-mode) below) |
| `dontAsk` | Suppress all interactive permission dialogs; Claude proceeds without confirmation. Intended for scheduled/background sessions that run unattended |
| `auto` | Claude autonomously decides when to prompt vs. proceed based on action risk |

> **Note for scheduled sessions:** threads created by the built-in scheduler automatically use `dontAsk` so cron jobs never stall waiting for a permission dialog that nobody is watching. They also inherit any external MCP servers configured under Settings → MCP (Compass, Helio, or any other user-configured HTTP/SSE/stdio server) alongside the plugin's built-in tools, so scheduled agents have the same tool surface as an interactive thread — `${VAR_NAME}` placeholders in those configs are resolved from environment variables and keychain-stored secrets. Such threads also carry the originating scheduled item's id and name (`scheduledItemId`/`scheduledItemName`), captured once at creation time and surfaced as a "Scheduled: `<name>`" footer pill and in the `threads_get_current`/`threads_list` tool output. If a scheduled run has nothing to report, its prompt may tell it to call `threads_archive` with its own thread ID. The tool acknowledges with `deferred: true`, then saves and archives the thread only after the run has fully settled; interactive threads still cannot archive themselves.

> **Active-hours windows:** a scheduled item can be scoped to a local time-of-day window so it only fires during, say, business hours. Pass `activeHoursStart`/`activeHoursEnd` (24h `HH:MM`) to `CronCreate`, or set/clear them later with `CronUpdate` (`activeHoursStart`/`activeHoursEnd`/`clearActiveHours`). When a cycle comes due outside the window it's skipped **without opening a thread at all** — the scheduler just jumps to the next window-open time — so an every-6h job scoped to `07:00`–`22:00` never wastes an overnight run. Overnight windows (start after end, e.g. `22:00`–`06:00`) wrap past midnight. **Settings → Scheduled** shows the window inline, e.g. *"Every 6 hour(s) (07:00-22:00 only)"*. This replaces baking a `date`-based business-hours check into the prompt itself, which used to burn a whole thread each time it fired just to check the clock and bail.

> **Gate commands:** a scheduled item can carry a deterministic **gate** — a shell command that runs *before* each cycle spawns a thread, so cycles with "nothing to do" are skipped without burning an agent turn. Pass `gateCommand` to `CronCreate` (with optional `gateTimeoutSeconds`, default 30 and capped at 120, and `gateFailOpen`, default `true`), or set/clear it later with `CronUpdate` (`gateCommand`/`gateTimeoutSeconds`/`gateFailOpen`/`clearGate`). **Exit `0` fires the agent; exit `1` deliberately skips an empty queue; reserved exit `75` reports that the gate could not determine whether work exists and honors `gateFailOpen`.** Other clean non-zero exits retain the existing deliberate-skip behavior. A skipped cycle creates no thread, message, or LLM call, while the schedule still advances normally. On a fire, the gate's stdout is fed into the prompt: it replaces a `{{gateOutput}}` placeholder if the prompt has one, otherwise it's appended as a `Gate output:` block (truncated to ~8 KB), so the agent doesn't have to re-derive what the check already found. The gate runs in the item's `cwd` with an ephemeral environment containing the item's Project-scoped keychain secrets (plus any global ones — see [Projects](#projects)), `CRON_LAST_RUN_MS` (epoch ms of the previous run, a natural "since last check" cursor), `CRON_ITEM_ID`, and `CRON_ITEM_NAME`; secret values are never written into schedule data. If the gate can't be evaluated — exit `75`, timeout, or spawn failure such as command-not-found — the item **fails open and fires anyway** by default (set `gateFailOpen: false` to fail closed and skip instead), so a broken check never silently blackholes a real cron. Failed-evaluation diagnostics are stripped of control sequences, redacted against keychain values, bounded to 4 KiB, and retained in run history for troubleshooting. Gates run on desktop only (they're inert on mobile, where a configured gate simply fires). **Settings → Scheduled** flags gated items inline, e.g. *"Every 5 minute(s) · gated"*. Example: `gateCommand: "test -s ~/inbox/pending.txt"` with a prompt of `Process the pending items:\n{{gateOutput}}` fires only when that file is non-empty. Because the gate is an arbitrary command run unattended, it carries the same trust profile as the existing `statusLineCommand` setting: it's authored by the same user who controls the vault.

> **Scheduled work manager:** **Settings → Scheduled** gives every recurring job, thread loop, and one-shot wakeup exactly one row, grouped by type. Each row stays compact by default with its status, cadence, next occurrence, Project, and effective execution target; enabled work is sorted by next occurrence and paused work stays last. Expand a row to inspect its prompt, working directory, active hours, gate, execution details, and recent outcomes, or to pause/resume, delete, and **Open last run**. Gated work says **Next check** because a successful evaluation is not guaranteed to spawn a thread; overdue work says **Overdue — catching up**. Use **Create with Claude** to open a normal thread that helps define and create a schedule conversationally.

### Plan Mode

Set **Permission Mode → `plan`** globally in settings, or use the **Permissions** row in the thread footer's menu to set it for a single thread, to enable Plan Mode. In this mode Claude or Codex reads, researches, and thinks — but doesn't write files or run commands — until it has produced a written plan and you've approved it. Codex can also invoke its built-in `EnterPlanMode` control when it recognizes that a task needs investigation first; Agent Threads finishes the current handoff, switches Codex to a read-only Plan turn at the safe turn boundary, and shows the same approval card.

**The flow:**

1. You send a message as normal.
2. A **"Planning…"** visual state appears in the thread while the agent gathers context.
3. When the agent finishes its plan, an inline card replaces the spinner, showing the full proposed plan text.
4. You pick one of three actions on the card:
   - **Approve** — the agent returns to its normal permission mode and executes the plan immediately.
   - **Edit** — the plan text becomes editable in-place; submitting the edited version sends it back as the confirmed plan before execution.
   - **Reject** — opens an inline feedback field while keeping the proposed plan visible for reference. Add an optional reason and choose **Reject plan** (or press <kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>Enter</kbd>) to send it as the next visible Plan-mode message; press <kbd>Escape</kbd> or choose **Cancel** to return to the original card. An empty reason keeps the existing generic revision prompt. In every case the agent remains in Plan mode and no edits are made.

Plan Mode is useful for risky or large-scale tasks where you want to review the approach before any files are touched.

### MCP Elicitation

Some MCP servers need a credential or a form filled before they can proceed — for example, an OAuth flow or a confirmation dialog. When this happens, Agent Threads renders an elicitation card inline in the conversation rather than silently failing.

- **URL auth card** — displays a clickable link for the OAuth URL. Click it to open the auth page in the host's Web Viewer (or your system browser), complete the flow, then return to the thread. Claude resumes automatically once the server receives the credential.
- **Form card** — renders input fields derived from the server's JSON schema (text fields, selects, checkboxes). Fill in the form and submit; the response is forwarded to the MCP server and the session continues.

Without elicitation support the session would stall indefinitely with no visible feedback. The card makes the situation visible and actionable without leaving Agent Threads.

### Managing MCP servers

#### Google Workspace

On desktop Geode and Obsidian, Settings → **MCP → Google Workspace** offers
**Google Docs**, **Google Drive**, **Google Sheets**, and **Google Slides**.
All four start disabled. Enable the services you want, then start a new thread.
Google's servers supply their complete read and write toolsets and schemas; Claude
Threads does not implement a separate set of Google tools. Interactive and newly
scheduled threads inherit the same selection on Claude and Codex, with their
existing permission behavior.

Install and connect **Google Docs Sync v0.7.1 or later** first. This integration requires its guarded
connection refresh support (`tokenStore.supportsConnectionGuard`); older builds
show an update instruction. The auth service must request the Docs, Drive, Sheets,
and Slides scopes. After updating the auth service, disconnect and reconnect
Google Docs Sync to grant the additional scopes. A corporate auth host can be
selected through Google Docs Sync's **Auth proxy URL** setting; disconnect the
old account before changing it.

Google Workspace MCP is a Developer Preview. Enroll the OAuth client's Cloud
project, enable each selected product API and MCP API, and obtain Workspace
administrator access as needed. See Google's [setup guide](https://developers.google.com/workspace/guides/configure-mcp-servers)
and [preview program](https://developers.google.com/workspace/preview).

Access tokens are refreshed inside Google Docs Sync. The harness receives only an
ephemeral credential for a loopback transport; no Google token is written to MCP
configuration. Missing or incompatible Google Docs Sync does not prevent a thread
from starting; its Google services are omitted and Settings → MCP explains why.
Disabling a service revokes existing Google connections. Reconnecting accounts,
changing auth hosts, or refresh-token rotation requires a new thread; ordinary
access-token refresh remains automatic. Google may report missing scopes, service
enablement, document access, or preview enrollment during discovery/tool calls.
The transport forwards these errors without pretending that initialization alone
validates access. This is an opt-in beta: corporate live validation of all four
services remains pending. For a self-hosted auth service, update its deployment
with the expanded Workspace scopes before reconnecting Google Docs Sync.

#### Custom servers

Settings → **MCP** lists, adds, edits, and removes the external MCP servers referenced above (Compass, Helio, or any other HTTP/SSE/stdio server) — no manual JSON editing required for the common case.

<p align="center">
  <img src="docs/screenshot-mcp-servers.png" width="800" alt="Settings MCP section: a list of configured MCP servers, each with a type badge (stdio, http, sse), a one-line summary, and Edit/Remove buttons, plus an Add MCP server button; one row warns that it will be skipped because its secret is not registered" />
</p>

**These servers are stored in the plugin's own `data.json`** and injected into each session at runtime — on both the Claude and Codex harnesses. Nothing is written to `~/.claude/`, and the `claude` CLI does not see them (register a server with `claude mcp add` if you want it in CLI sessions too). Changes take effect for newly initialized or reinitialized sessions — existing session adapters keep whatever MCP servers they started with.

> Earlier versions kept this list in a `mcpServers` block inside `~/.claude/settings.json`. That was a mistake: Claude Code owns that file, its schema has no top-level `mcpServers` property, and neither the CLI nor the SDK ever read what the plugin wrote there. The plugin no longer reads or writes that file at all. If you have a leftover `mcpServers` block in your `settings.json`, it is inert and safe to delete — re-add those servers here.

For each server you can see its name, a type badge (`stdio`, `http`, or `sse`), and a one-line summary (the command for `stdio`, the URL for `http`/`sse`). Adding or editing a server opens a form for the command/args/env (stdio) or URL/transport/headers (http/sse) — env values and header values support `${VAR_NAME}` placeholders, resolved from environment variables merged with keychain-stored secrets.

A server whose `${VAR_NAME}` placeholders cannot be resolved is **skipped rather than started with blank values**, and the reason is shown both on its row here and as a notice when a session starts. (Previously an unresolvable placeholder expanded to an empty string and the server was started anyway — which meant, for example, an empty `x-api-key` header that failed authentication silently on every session.)

<p align="center">
  <img src="docs/screenshot-mcp-edit-server.png" width="800" alt="Add/edit MCP server form: a type toggle between Command (stdio) and HTTP or SSE, with Name, Command, Arguments, and Environment variables fields, the env field showing a ${NOTES_API_TOKEN} placeholder" />
</p>

Agents can also call `mcp_register_server` to propose a server. A host dialog shows the unresolved configuration and asks you to **Register server** or **Cancel**, including when normal tool permissions are bypassed. Approval saves globally for newly initialized Claude and Codex sessions; it does not launch a command, contact an endpoint, or change the calling session's tools. Scheduled threads return an unavailable result instead of waiting for a dialog.

The tool accepts a flat `name`, `type` (`stdio`, `http`, `sse`, or `oauth`), plus `command`/`args`/`env` for stdio or `url`/`headers` for remote servers. An identical retry is unchanged; a different configuration under an existing name is rejected. Built-in and prototype-related names are reserved. Remote URLs must use HTTP(S) and cannot contain embedded credentials.

#### OAuth-gated servers

A remote MCP server that requires OAuth 2.1 + PKCE (Vercel's, for example) registers with `type: "oauth"` instead of `"http"`. The plugin brokers the whole flow itself — discovery, Dynamic Client Registration, consent, token custody, refresh, and revocation — so neither Claude nor Codex needs any OAuth-specific code; both harnesses see the server as a plain authenticated HTTP endpoint behind a local per-server proxy.

Connect one either way:

- **Settings → MCP → Add MCP server → OAuth.** Fill in a name and the server's URL; scopes, a tool allow/deny filter, and `clientId`/`authorizationServerUrl`/`redirectUri` overrides are optional. Set `redirectUri` for providers that register one exact callback URI instead of accepting any loopback port — Slack's MCP server requires `http://localhost:3118/callback` (note `localhost`, not `127.0.0.1`: exact string matching makes those different URIs).
- **Ask an agent** to call `mcp_register_server` with `type: "oauth"`.

The plugin is a public client by default — PKCE, no secret at all. For the few providers that issue a `client_secret` and then require it at the token endpoint, the OAuth form's Advanced section has a masked **Client secret** field, and the tool takes `clientSecret` as a `${NAME}` placeholder naming a secret already saved with `request_secret` (a literal is rejected, because tool arguments are logged verbatim). Either way the secret lives only in the OS keychain; `data.json` records only that one exists.

Some authorization servers refuse to register a loopback callback at all, which makes the browser flow impossible rather than merely awkward. Set **Grant type → Client credentials** (or `grantType: "client_credentials"`) for those, and for any MCP server that stands for a service rather than a signed-in user: the plugin authenticates as itself with a client ID and secret, so no browser opens and no callback is needed. That grant requires both a client ID and a secret, rejects `redirectUri`, and takes an optional `audience` — nonsecret, passed literally — for providers like Auth0 that mint a token per API. It keeps no refresh token (RFC 6749 §4.4.3 says it shouldn't get one) and re-mints from the keychain secret instead, so its status row reads "Connected · renews in …" and a failure reads "Needs new credentials".

<p align="center">
  <img src="docs/screenshot-mcp-oauth-client-credentials.png" width="800" alt="Add MCP server dialog on the OAuth tab with Grant type set to Client credentials: the Redirect URI field is gone, Advanced is open, and Client ID and Client secret are both labelled required alongside an Audience field" />
</p>

Both run the same flow and the same validation. Unlike the other transports the default grant is asynchronous and interactive: discovery runs, the provider's consent screen opens in the host's Web Viewer, and the flow waits up to 5 minutes for you to finish signing in before exchanging the code for tokens and starting the proxy. Denying consent or letting the window lapse leaves no partial state behind. Client credentials skips all of that and just calls the token endpoint. Either way a scheduled thread gets an `unavailable` result rather than a stalled dialog — a registration that grants the plugin a new outbound connection wants a human present, and the grant without a consent screen wants one more, not less.

Settings → **MCP → OAuth MCP servers** lists every connected server with a live status (connected + expiry countdown, expiring soon, needs re-authorization, or — for a machine-to-machine server — connected + renewal countdown) and a **Disconnect** button, which revokes the tokens upstream, clears the keychain, and stops the proxy. Changing a connected server means disconnecting and reconnecting rather than editing it in place, so the OAuth option appears only when adding. See [`docs/mcp-registration.md`](docs/mcp-registration.md#oauth-gated-servers-type-oauth) for the full field reference. Access and refresh tokens live only in the OS keychain, never in `data.json`.

<p align="center">
  <img src="docs/screenshot-mcp-oauth-servers.png" width="800" alt="Settings MCP section: OAuth MCP servers listing three servers with status dots — one connected with an expiry countdown, one needing re-authorization, and one machine-to-machine server connected with a renewal countdown — and a Disconnect button on each row" />
</p>

Use `${NAME}` for every credential and `request_secret` to save its value securely. Common credential fields are validated, but arbitrary argument strings cannot be reliably classified: all literal values must be nonsecret. Registration returns status and required variable names, never resolved credentials. Missing variables are checked when a future session initializes. See [agent registration details](docs/mcp-registration.md).

### Remote access (mobile)

Agent Threads can mirror your desktop sessions to Obsidian Mobile in real time. Your phone becomes a thin client: you can read the conversation as it streams, send messages, approve permission requests, answer AskUserQuestion prompts, and switch between threads — all over a secure WebSocket relay. The desktop does all the actual Claude work; mobile just shows the state.

**Prerequisites:**

- Obsidian desktop with Agent Threads installed and running
- Obsidian Mobile with Agent Threads installed via [BRAT](https://github.com/TfTHacker/obsidian42-brat)
- Both devices on any internet connection (no LAN required)

**Setup:**

1. On desktop: open Settings > Agent Threads > Remote Access and toggle **Enable remote access** on
2. Click **Show pairing QR code** — a QR code appears with a 5-minute expiry window
3. On mobile: open the Agent Threads ribbon icon, tap **Connect to Desktop**, then scan the QR code (or tap the `claude-threads://pair` link if you're on the same device)
4. The mobile view refreshes to show all your desktop threads

**Manual pairing (URI scheme):**

If you can't scan a QR code, send yourself the pairing link directly:

```
claude-threads://pair?roomId=<ROOM_ID>&relay=<RELAY_URL>
```

Opening this URL on any device with Obsidian Mobile + Agent Threads installed will pair it to your desktop.

**What you can do on mobile:**

- Read streaming conversation output and tool calls in real time
- Send messages, approve or deny permission requests (including **Always Allow**)
- Answer **AskUserQuestion** prompts — single-select and multi-select options plus a free-text "Other" field, same as desktop
- Switch between threads and search the thread list by title or summary
- See each thread's **status rail** — spinner cards for active tool calls, error cards for failed threads
- Copy any assistant message to clipboard with the ⎘ button
- View the thread's **context pill** (Project + working directory), **model**, and **message timestamps**
- See **queue rows** for pending messages (tap to pull back into the composer, × to cancel)
- View **tool pill icons** matching the desktop view

**Limitations:**

- Desktop must be running and connected — mobile cannot start new Claude sessions without desktop
- Mobile is a read-mostly thin client; it cannot access your vault files or run tools directly
- One desktop per room ID; rotate the room ID in settings to revoke all mobile access

<p align="center">
  <img src="docs/screenshot-mobile-connected.png" width="800" alt="Mobile remote access — desktop sessions mirrored to your phone in real time" />
</p>

### Compressed conversation view

Long agentic threads — especially ones with many tool calls spread across dozens of turns — can be hard to scan. Toggle **Compress view** from the `⋯` menu (top-right of the conversation panel) to collapse the history into a scannable list of one-line summaries.

**How it works:**

- Each entry represents one *exchange*: a user message followed by all the consecutive assistant turns that came back before the next user message (i.e., a full agentic run)
- The summary for each entry is generated by running the combined content of all assistant turns through a lightweight background process — so you get one meaningful summary ("Investigated codebase, added 4 MCP tools, wrote tests") rather than N fragments
- Summaries are generated lazily in a serial queue (one at a time) so toggling compress view on a 50-message thread won't spawn 50 simultaneous Claude processes
- Click the **⌄** arrow on any entry to expand it and read the full response with all tool calls intact
- Toggle the menu item again (now labelled **Expand view**) to return to the normal conversation view

Summaries are cached in memory for the session. They regenerate on the next reload — which keeps storage simple while keeping the background work cheap (the in-process model is fast and inexpensive).

### Thread summaries

A summary bar above the messages shows what the thread is about, and the summarizer also names the tab for you.

With **Enable summarization** on (the default), a thread is summarized once per **completed turn** — not once per assistant message, and not once per tool call. It runs for background and scheduled threads too, not just the one you're looking at.

How often it runs depends on **Auto-summarize after response**:

| Auto-summarize | Before you rename the thread | After you rename it |
|---|---|---|
| Off (default) | Summarized every completed turn | Stops entirely — no further summarizer calls |
| On | Summarized every completed turn | Still summarized every completed turn; your title is kept |

Manual summarize (the brain icon, or the "Summarize active thread" command) always applies the new title regardless of what the tab is currently named. If there's nothing new worth summarizing, it leaves the existing summary untouched and says so.

A few things it deliberately won't do: it skips the model entirely when a turn produced no text (a run of pure tool calls), it won't overwrite a good summary with an empty or unparseable response, and it rejects placeholder titles like "Transcript empty". Turns that end in an error or are interrupted don't retitle the thread — the next completed turn does.

Each summarizer call runs in an isolated one-shot subprocess with no tools, no MCP servers, and no settings files loaded, so auto-naming stays cheap no matter how large your `~/.claude/settings.json` is.

When you switch back to a thread you haven't viewed in over a minute, a **context recap banner** floats at the top of the conversation showing the thread summary and how long ago you were last active. It auto-dismisses after 10 seconds or when you send a message.

<p align="center">
  <img src="docs/screenshot-context-recap-banner.png" width="800" alt="Context recap banner — re-orients you to a thread after returning from a break" />
</p>

### Projects

Projects group related threads, choose their initial working directory, inject shared context, and may own a Project Orchestrator. Project coordination tools are operationally scoped; vault tools, MCP server/skill registration, and filesystem access remain broader capabilities rather than a security boundary. Secrets are the one exception: a keychain secret can optionally be restricted to specific Projects (see [Settings](#settings)) — unscoped secrets remain global, and a Project-less thread never receives a Project-scoped secret.

**Creating a project:** Open Settings → Agent Threads, choose **Projects** in the **Settings section** selector, and click **New project**. Enter a project name and vault folder path, then **Create project**. Optionally set a filesystem cwd override for a repo outside the vault. Settings shows the resolved effective cwd; clear the override to derive it from the vault folder again. You can also add a project context prompt — a few sentences describing the project's goals, conventions, and key files that Claude should always keep in mind.

**Opening a thread in a project:** The Agents List and Agent Board kickoff panels have an accessible **Project** selector. Choose a Project before dispatching, or deliberately leave **No Project** in the Agents List (**Unassigned** in Agent Board) to use the global default cwd. Model, goal, loop, attachment, image, and harness kickoff options preserve that selection. The chat view's New Thread flow and agent-created child threads keep their existing Project inheritance behavior.

**Moving an existing thread:** Open the **⋯** menu in the chat view and choose **Move to Project…**, then pick a Project or **(No project)**. This works regardless of coordination scope, so a thread started outside any Project — including one that just created the Project — is never stranded. Moving into a Project switches the thread to that Project's working directory, which starts a fresh session on the next message; detaching leaves the cwd alone. The item is hidden for the Portfolio Orchestrator and for any thread that owns a Project, since neither can be reassigned.

**Managing projects:** Choose **Projects** in Agent Threads settings, search or select a project, and edit its details. **Save changes** applies the draft; **Cancel** discards it. Create or open the Project Orchestrator from the detail pane; the first completed Project thread also creates it automatically without stealing focus. Intentionally archiving a Project Orchestrator disables that automatic recreation (including after a synced-settings reload) until you deliberately choose Create/Open again. Changing a Project cwd affects new dispatches and Project-derived new-thread scheduled jobs that do not store an explicit cwd; it does not silently move existing sessions. Deletion requires confirmation, detaches its threads, clears pending proposals, removes its orchestrator heartbeat, and pins affected schedules to the Project's former effective cwd.

**Giving an orchestrator direction:** A Project's context prompt can act as its goal contract. The headings are optional, but this shape gives the orchestrator the clearest operating boundaries:

```markdown
## Desired outcome
...

## Current priority
...

## Done when
...

## Constraints and non-goals
...

## Risk tolerance
...
```

For each new thread, the orchestrator first looks for an explicit `/goal`, the initiating request, and a concrete completion condition. Clear requests are recorded as **user-stated** and proceed without another interview. If the intended outcome or definition of done is ambiguous, the orchestrator records that it is awaiting direction and asks one focused question in the Project Orchestrator conversation before proposing execution, inspection, or verification. A later answer can make the goal **user-confirmed**; an **inferred** goal may guide the explicit work already underway but never expands its scope.

Orchestrators use each thread's exact `updatedAt` value as their review cursor. Targeted completion events review only the named changed threads, while the hourly heartbeat reconciles activity that an event may have missed. Threads with unchanged state are not reread or rewritten, unanswered goal questions are not repeated, and concluded work stays quiet unless new evidence appears. Verification is limited to one additional orchestrator-requested pass for a substantive implementation state unless a new failure, external change, user direction, or concrete risk justifies another.

**Scheduled work:** Cron items resolve their effective cwd at fire time in this order: explicit scheduled-item cwd, current Project cwd, then the global default. The same resolved path is used for a gate command and its spawned thread. Cron create/update rejects unknown Projects, and a deleted Project reference fails the run rather than dispatching in an unrelated fallback directory.

**Schedule Manager:** Settings → Scheduled presents every non-system item once in two compact groups: recurring jobs, and thread loops/wakeups. Rows are collapsed by default and sorted by next occurrence, with paused work last. The summary shows status, cadence, next run or check, Project, and execution environment; expand a row to inspect its prompt, active hours, effective working directory, gate, run history, and controls. New-thread jobs show the global harness and model they will inherit at fire time (a blank model means the CLI default). Loops and wakeups show the target thread's harness/model; a missing target is called out along with its new-thread fallback.

### Status line (context footer)

A row of pills below the input area shows live context for each thread — git branch, an open PR, a running dev server URL, AWS session status, or anything else you want. It's powered by a shell command (Settings → **Context footer command**) that the plugin runs **per thread, in the background**, against that thread's working directory. Desktop only.

> **Note:** `pr` and `branch` pills are hidden while the [git diff bar](#git-diff-bar-create-pr) is on screen, since that bar already shows the branch and a PR button labelled with the PR number. Your script doesn't need to know about this — emit whatever tags you like and the plugin drops the redundant ones.
>
> **Keep emitting the `pr` tag even though it's usually hidden.** It isn't just a pill: it's the only source of a thread's PR association. The plugin derives `prUrl` from it, which drives the diff bar's **PR #N** button, the Agent Board PR chip, and the archive-on-merge release workflow. Drop the tag to "save" a `gh` call and those all go dark. A `pr` tag whose repo provably differs from the thread's current repo is ignored, so a thread moved between projects won't keep advertising its old PR.

<p align="center">
  <img src="docs/screenshot-status-line.png" width="800" alt="Status-line footer pills — dev URL, git branch, a clickable PR pill, and an AWS status pill below the message input" />
</p>

**Output format.** The command can return either:

- **A JSON array of tags** (recommended) — each pill is a `StatusTag`:

  ```json
  [
    { "label": "http://localhost:3001", "url": "http://localhost:3001", "kind": "dev" },
    { "label": "feat/social-nudge", "kind": "branch" },
    { "label": "PR #225", "url": "https://github.com/acme/app/pull/225", "kind": "pr" },
    { "label": "AWS expired", "tone": "warn", "kind": "aws" }
  ]
  ```

  | Field | Meaning |
  |---|---|
  | `label` | **Required.** Pill text. |
  | `url` | Makes the pill a clickable link (opens in your browser). |
  | `icon` | [Lucide](https://lucide.dev) icon name. Defaults from `kind` if omitted. |
  | `tone` | `normal` (default), `warn`, or `error` — colors the pill. |
  | `kind` | `pr`, `branch`, `dev`, `aws`, or any custom string. A `kind:"pr"` tag (or any `url` ending in `/pull/N`) becomes the thread's PR — shown as the PR pill and surfaced to the Agent Board, MCP tools, and release automation. |

- **Plaintext** (the Claude Code statusline convention) — segments split on 2+ spaces, with heuristic icons (URL→globe, `PR #N`→pull-request, `AWS …`→cloud, else→branch). Existing scripts keep working unchanged.

**Input.** The command receives JSON on stdin: `{ "cwd": "…", "workspace": { "current_dir": "…" }, "provider": "claude" | "bedrock" }`. Use `provider` to gate provider-specific pills — e.g. only emit an AWS pill when `provider == "bedrock"` so a logged-out AWS session doesn't show a spurious warning on a non-Bedrock machine.

**PR detection** is fully script-driven: a `kind:"pr"` tag with a `url` (e.g. from `gh pr view`) populates the thread's `prUrl`, which is **sticky** — it survives after the PR merges so release tooling can still match the thread.

**Opening links:** clicking a pill with a `url` opens it in a fresh tab in the host's in-app **Web Viewer** when available; otherwise it opens in your system browser. **Cmd-click** (Ctrl-click on Windows/Linux) always opens in the system browser, even when the Web Viewer is enabled.

A ready-to-use reference script (branch · PR · dev URL · Bedrock-gated AWS) ships at [`docs/statusline-command.example.sh`](docs/statusline-command.example.sh).

### Git diff bar (Create PR)

Whenever a thread's working directory is a git repo on a feature branch, a bar appears just above the compose box showing the branch name and a live diff stat (`+60 -4`) — the total change between the branch's base (e.g. `main`) and the current working tree, including any uncommitted changes. Unlike the status-line pills above, this needs no configuration: it's computed natively from local `git` commands only (no `gh`, no network), and is desktop only, mirroring the status line's mobile no-op.

A **Create PR** split button sits on the right:

- **Create PR** — sends the configured **Create PR message** directly to the active agent. The default is `/create-pr`.
- **Create draft PR** (dropdown) — sends its independently configured draft message. The default is `/create-pr --draft`, and the action is also available by typing that command.

Configure both messages under **Settings → General → Pull requests**. They may be plain-language prompts or commands backed by skills in your agent system. If a slash command is not defined there, it is still delivered as an ordinary message and the receiving agent decides how to handle it. Leaving either setting blank restores its default when the action runs.
- **Manually create PR** (dropdown) — skips Claude entirely and opens GitHub's compare page (`/compare/<base>...<branch>`) in your browser (Web Viewer or system browser, same convention as status-line pill links), so you can review the diff and open the PR yourself. Only enabled when the repo's `origin` remote points at GitHub.

The bar is hidden when the cwd isn't a git repo, when the branch can't be resolved (e.g. detached HEAD), or when you're already sitting on the base/default branch (nothing to open a PR against).

Once the **current branch** has a PR, the primary button switches to the PR's number — **PR #121** — opening it the same way pill links do, with the full URL as a tooltip, and a **View PR** item is prepended to the dropdown; the other three actions stay available in case you want to open another PR later.

That PR comes from the live `pr` tag emitted by your [context footer command](#status-line-context-footer) (typically a branch-scoped `gh pr view "$branch"`), *not* from the thread's sticky `prUrl`. The distinction matters: `prUrl` is thread-scoped history that is deliberately never cleared — it survives a branch switch and even a `set_working_directory` into a different repository — so that the archive-on-merge release workflow can still match a thread to its PR after the branch is deleted. Reusing a long-lived thread for a second task would otherwise leave the bar advertising a stale, unrelated PR next to the new branch's name. If no context footer command is configured, the button simply stays on **Create PR**.

Because the bar already names the branch and the PR, it is treated as the single surface for that information: while it's visible, the [context footer](#status-line-context-footer) suppresses its own `pr` and `branch` pills so the same branch and PR number aren't printed twice in adjacent rows. This applies both to pills your status-line command emits and to the footer's built-in sticky-`prUrl` pill. The suppression is conditional — as soon as the bar hides (PR merged and the thread is back on the base branch, a non-git cwd, or a detached HEAD), the footer PR pill reappears as the only remaining surface for that PR.

### Safe plugin reload

Use **Agent Threads: Reload plugin (safe)** from the command palette instead of the host's built-in "Reload plugin" button. When no threads are running it reloads immediately. When threads are active it opens a modal showing their names with three choices: **Cancel** (keep working), **Interrupt & Reload** (sends an interrupt signal and waits up to 30 seconds for a clean shutdown), or **Force Reload** (kills sessions immediately). Reloading via any other path (Settings toggle, manifest hot-reload) triggers a graceful 10-second interrupt wait automatically before teardown.

### Diagnostics report

When the host app feels slow — the renderer pinning a core, typing lag, or a machine where an EDR/antivirus agent taxes every subprocess — Agent Threads keeps a small, **always-on, local-only** diagnostics layer running so you can capture what's actually happening. Nothing ever leaves your machine: there are no network calls and no remote reporting.

In the background it tracks a few cheap signals: how often the Agent Board rebuilds vs. how often a render was merely requested (measuring the incremental-render coalescing), how many `git`/status-line subprocesses were spawned, how many settings saves coalesced into actual disk writes, plus a ring of renderer CPU/memory samples (taken only while a plugin view is open) and a summary of any long main-thread tasks. It works identically in real Obsidian and in the Geode desktop app, and is a complete no-op on mobile.

Run **Agent Threads: Generate diagnostics report** from the command palette (or click **Copy diagnostics** in Settings → General → Diagnostics). It:

- copies a **redacted** Markdown report to your clipboard, ready to paste into a GitHub issue, and
- saves that Markdown plus a raw `.json` bundle into an `agent-threads-diagnostics/` folder in your vault root, then shows a Notice with the path.

The report is redacted by construction: it never includes message or file contents, absolute paths are collapsed to `~` or reduced to a basename (so no username or private directory layout leaks), and obvious `SECRET=value` strings are stripped. On mobile the command shows a "desktop only" Notice and does nothing.

You can turn the whole layer off with the **Diagnostics** toggle in Settings → General (it's on by default, which is safe because everything stays local); turning it off stops the sampler and freezes the counters.

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
| `ScheduleWakeup` | `delaySeconds`, `prompt`, `reason` | Schedules a message to be injected into this thread after a delay. Useful for polling CI, waiting for a deploy, or self-pacing loop work. While the wake-up is pending the thread shows a waiting indicator — a "Waiting" group with a live countdown (`Resumes in 4m — <reason>`) in the Agents List and the [Agent Board](#kanban-board). In the thread composer, a compact `Resumes in …` pill opens scheduled activity with the wakeup reason, exact time, and an item-specific **Cancel** control. |
| `EnterWorktree` | `branch?`, `baseBranch?`, `repoPath?` | Creates a git worktree for the current repo and switches the session cwd to it. Automatically routed to the plugin's MCP implementation, which tracks the in-session cwd correctly after `set_working_directory`. |
| `ExitWorktree` | `worktreePath?`, `force?` | Removes the worktree and restores the session cwd to the original repo root. Defaults to the current effective cwd. Pass `force: true` to remove even if there are uncommitted changes. |
| `enter_vm` | `image?`, `network?`, `mountPath?` | Starts a sandbox VM for this thread and bind-mounts the current effective cwd at `/work` inside it. Requires Apple's `container` runtime (macOS 26+, Apple silicon). `network` is one of `default` (full egress — the default), `internal` (no internet, host still reachable), or `none` (no route at all). Because each container is its own lightweight VM, guest code cannot reach any host path other than the mounted directory. |
| `vm_exec` | `command`, `timeoutSeconds?` | Runs a shell command inside this thread's sandbox VM with cwd `/work`. Returns `exitCode`, `stdout`, and `stderr`; a non-zero exit is reported, not thrown. Each stream is truncated at 100,000 characters with an explicit marker. Defaults to a 300s guest deadline plus a five-second kill grace. Edits made on the host with `Read`/`Write`/`Edit` are visible immediately — there is no sync step. |
| `exit_vm` | `force?` | Stops and removes this thread's sandbox VM. Pass `force: true` to skip the graceful stop. |
| `threads_create` | `prompt`, `title?`, `cwd?`, `projectId?` | Creates a persistent thread and immediately queues its initial prompt. Working directory and project inherit from the caller when omitted; pass `projectId: null` to clear the project. |
| `request_secret` | `secretName`, `reason`, `force?` | Prompts the user (via a modal) to provide a secret value such as an API key. The value is stored in the OS keychain under the plugin's namespace and injected into future sessions as an environment variable — it never appears in the conversation. Returns `{success: true, secretName, alreadyExisted: boolean}` if the user saves, or `{success: false, reason}` if cancelled. If a secret with the same name already exists, returns `alreadyExisted: true` immediately without prompting. Pass `force: true` to always re-prompt (e.g. when rotating a stale token) — the modal will indicate that the existing value will be replaced. |
| `watch_document` | `path` | Watches a vault note for content changes, owned by the calling thread. Any subsequent edit — from you, another thread, or a sync — sends this thread an injected alert message referencing the file via an `@[[filename]]` mention. Re-watching an already-watched path is a no-op that keeps the existing watch. See [Watch a document](#watch-a-document). |
| `unwatch_document` | `path?`, `id?` | Removes a watch owned by the calling thread, by path or watch id (at least one required). Never affects another thread's watch on the same path. |
| `list_watched_documents` | — | Returns the calling thread's own active watches: path, watch id, creation time, and last-alerted time. |

See [Sandbox VMs](docs/sandbox-vms.md) for setup and a worktree workflow. Only
`vm_exec` runs commands in the guest; host shell and file tools remain on the
host. The selected directory is writable and guest edits persist after exit.

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

These three tools back the bundled **thread-orchestrator** skill (`resources/skills/thread-orchestrator`), which lets one thread supervise several peers: it tracks per-thread notes across polling passes and proposes replies for a human to review rather than sending on a peer's behalf.

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

The TypeScript contract and structured error codes are defined in [`src/PublicApi.ts`](src/PublicApi.ts), with the standalone consumer declaration in [`api/public-api-v1.d.ts`](api/public-api-v1.d.ts). API v1 excludes hard-delete operations, cross-Project elevation, and direct access to private views or runtime sessions.

`api.v1.mcp` lets a peer plugin reuse Agent Threads' own MCP-registration and secret-storage machinery instead of reinventing OS-keychain storage or its own MCP config UI:

- **`mcp.register(input)`** registers a global external MCP server (`stdio`, `http`, `sse`, or `oauth` — same shape as the `mcp_register_server` agent tool). Registration **always** shows the same interactive `McpRegistrationModal` confirmation to the human that the agent tool shows — there is no silent or bypassed path for a peer-plugin caller, including for `stdio` servers that can execute an arbitrary local command. An `oauth` entry goes through the identical OAuth 2.1 + PKCE consent flow (`OAuthMcpRegistry`) as agent-initiated oauth registration. If the host has no interactive context available (e.g. the plugin is unloading), it returns `{success: false, status: 'unavailable', ...}` rather than throwing. Returns the same `McpRegistrationResult` shape (`status`: `registered` | `unchanged` | `conflict` | `invalid` | `cancelled` | `unavailable` | `failed`) documented for `mcp_register_server` above.
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

Everything the [Skills Manager](#skills-manager) panel can do — browse the [skills.sh](https://skills.sh) registry, inspect installed skills and configured sources, check for updates, install, uninstall — is also available to agents via MCP, so a thread can manage its own skill packages without a human clicking through the UI.

| Tool | Parameters | Description |
|---|---|---|
| `skills_list_installed` | — | Lists skills with their qualified identifier, name, description, path, origin (`local`, `vault`, or `home`), and edit/remove permissions. |
| `skills_search` | `query`, `limit?` | Searches the skills.sh marketplace registry. Returns each match's name, slug, GitHub source, install count, and whether it's already installed. Default limit: 15. |
| `skills_get` | `identifier` | Returns full detail for one skill, whether installed or not. Pass an installed skill's name, or a marketplace slug in `owner/repo/skill-id` form (as returned by `skills_search`). Installed skills include their full `SKILL.md` content. |
| `skills_list_sources` | — | Lists configured skill sources (GitHub-cloned or local-path plugin sources) plus the built-in skills.sh registry, with id, name, type, and (for GitHub sources) staleness info. |
| `skills_check_updates` | — | Checks every configured GitHub-type skill source for upstream commits it's behind (`git fetch` + count). Returns each source's id, name, and either its refreshed `behindCount`/`lastFetched` or an `error` if the check failed (e.g. offline). |
| `skills_install` | `slug`, `skillId`, `source`, `name` | Installs a skill from the marketplace into `<vault>/.obsidian/plugins/claude-threads/skills/`. Pass the four fields exactly as returned by `skills_search` for the skill you want. |
| `skills_uninstall` | `name` | Permanently deletes an installed or authored vault package. Use its qualified identifier to distinguish duplicate names. Home skills remain read-only. |
| `skills_create_local` | `skillId`, `skillMd`, `files?` | Creates a complete authored package in the configured vault folder, available in new sessions. Rejects existing packages. |
| `skills_update_local` | `skillId`, `files?`, `deleteFiles?` | Patches an authored package; preserves omitted files and protects `SKILL.md` from deletion. |
| `skills_update` | `sourceId` | Pulls the latest commits for a configured GitHub-type skill source (`git pull` on its local clone), refreshing every skill it provides. Use the source id from `skills_list_sources` — not `"registry"`, which has no single-source update (reinstall individual skills instead). |

## Settings

Open **Settings → Agent Threads** in Geode or Obsidian. The compact **Settings section** selector groups all eleven desktop sections under Preferences, Workspace, Extensions, and Connectivity. The host keeps its own settings navigation; the plugin does not add a second sidebar. **Projects** and **Secrets** provide searchable lists with a detail editor beside them, stacking vertically when the available settings pane is narrow. Mobile retains its pairing and relay settings screen.

In **Secrets**, choose **Add secret** or select an existing entry. Save the value and its **Global** or **Selected projects** access together with **Add secret** for a new entry or **Save changes** for an existing one; **Cancel** discards the draft. A blank replacement preserves an existing value. Removing a secret requires confirmation. Values stay in OS-backed secret storage, never in `data.json`.

| Setting | Description |
|---|---|
| Claude binary path | Path to the `claude` executable (auto-detected) |
| Agent harness | Initial Claude or Codex default for new kickoff selectors. A selection made in the Agents List or Agent Board is local to that mounted view and does not rewrite this setting. |
| Codex computer use | Off by default. Disables bundled Codex desktop-control capabilities for newly initialized sessions. On inherits local Codex configuration. Existing sessions require a restart; shared Codex browser REPL capabilities may also be unavailable while off. |
| Default working directory | `cwd` for new threads; defaults to vault root |
| Worktree location | Root directory for worktrees created by `enter_worktree` (default: `~/.geode/worktrees`, laid out as `<repo>/<branch>`). Must be durable storage — a temp directory is cleared on reboot, which deletes the worktree and any uncommitted work in it. |
| Sandbox VM image | Container image `enter_vm` starts (default: `claude-threads-coding:1`). Build it from the bundled `sandbox/Dockerfile` with `container build --tag claude-threads-coding:1 sandbox/`. Requires Apple's container runtime on macOS 26+ / Apple silicon: `brew install container`, then `container system start`. |
| Sandbox VM network | Network isolation `enter_vm` applies when a call does not pass one. `Full egress` (default) lets `npm install`, git remotes, and web access work. `Internal` blocks the internet but leaves the host reachable; `None` removes the route entirely. |
| Save threads to vault | Auto-save readable Markdown notes plus versioned machine recovery snapshots |
| Vault folder | Folder for saved thread notes (default: `Agent Threads/`) |
| Extra environment variables | `KEY=VALUE` pairs injected into Claude's environment (useful for `AWS_PROFILE`, `AWS_REGION`) |
| Secret environment variables | Managed in **Secrets** with explicit Save/Cancel. Values are stored in the OS keychain, never in `data.json`. Each secret defaults to Global (available to every Project and to Project-less threads); choose Selected projects in its detail pane to restrict resolution. MCP server and skill *registration* stays global regardless — only whether a scoped secret's value resolves is gated by Project. |
| Permission mode | How the selected Claude or Codex harness handles tool-use confirmation. Options: `default` (CLI default), `acceptEdits` (auto-approve file edits), `bypassPermissions` (skip all prompts), `plan` (propose a plan first — see [Plan Mode](#plan-mode)), `dontAsk` (no dialogs; for unattended/scheduled sessions), `auto` (the selected harness decides). See [Permissions](#permissions). |
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
| Context footer command | Shell command that produces the status-line pills (JSON tags or plaintext). Run per-thread against its cwd; receives `{cwd, workspace, provider}` on stdin. Desktop only. See [Status line](#status-line-context-footer). |
| Create PR message | Message sent directly to the active agent by the Create PR button or `/create-pr`. Defaults to `/create-pr`; blank also uses that default. |
| Create draft PR message | Independent message sent by the draft action or `/create-pr --draft`. Defaults to `/create-pr --draft`; blank also uses that default. |
| Projects | Group threads and focus their initial cwd/context. Projects do not restrict the broader vault or configured tool roster. |
| Auto-collapse side panel | Collapse the left, right, or both sidebars when the Agent Board opens, restoring them when it closes (default: `None`). See [Agent Board](#kanban-board). |
| Stack scheduled job threads | Collapse repeat runs of the same scheduled/cron job into an expandable rollup in the Agent Board's quiet columns and the Agents List's Scheduled Jobs section (default: on). See [Agent Board](#kanban-board) and [Agents List](#agents-list). |
| Scheduled work | The dedicated **Scheduled** section groups recurring jobs, thread loops, and wakeups into collapsed rows showing status, cadence, next occurrence, Project, and execution target. Expand one for prompt, working directory, active hours, gate, history, and pause/resume/delete/open controls. |
| Watched documents | **Watched documents** within **Scheduled** lists every active watch (see [Watch a document](#watch-a-document)) with its path, owning thread, and last-alerted time, plus an unwatch control — the same view whether the watch was created from the file menu or the `watch_document` MCP tool. |
| Diagnostics | Enable the always-on, local-only telemetry layer (counters + renderer CPU/memory samples) that powers the [Diagnostics report](#diagnostics-report). Nothing leaves your machine; on by default. Desktop only. |
| Remote access | Enable/disable mobile remote access via WebSocket relay |
| Room ID | Shared secret used to pair mobile (rotate to revoke all access) |
| Show pairing QR | Display a QR code for one-time mobile pairing (expires in 5 minutes) |

Thread state in the plugin's `data.json` is canonical during normal startup. When vault saving is enabled, each readable `.md` conversation is accompanied by a versioned `.recovery.json` snapshot containing the canonical thread/session metadata and message history. The Markdown body is presentation-only: it is never parsed back into a live conversation, so callouts, embeds, or manual note edits cannot corrupt a restarted thread. Legacy Markdown archives without a supported snapshot remain readable archives but are not guessed back into live state.

## Building from source

### Peer plugins

Geode/Obsidian peer plugins can discover the generation-scoped Agent Threads API at `app.plugins.plugins['claude-threads']?.api?.v1`. It provides immutable thread operations, sanitized trace projection, constrained runs, host-confirmed MCP registration, and contribution surfaces for artifacts, agent tools, and slash commands. `threads.beginProvisional` adds a reversible create transaction for peer-owned workflows: pending threads cannot run, and rollback removes the thread plus storage allocated through `artifacts.allocateStorage`. Design for Agent Threads is the reference peer consumer; Agent Threads itself retains only read-only legacy artifact fallback. `capabilities` is computed from what the host can actually do, so check it before calling. See [Peer Plugin API v1](docs/public-api.md) and the checked-in [type contract](api/public-api-v1.d.ts).

Sibling Geode/Obsidian plugins can also contribute cards, images and self-contained
interactive documents inside assistant replies through
`extensions.registerMessageContentProvider`. The agent places a durable content
reference on its own line, and Threads renders it at that position with
host-owned presentation and named action buttons. Cards stay readable when a
provider is unavailable; streaming and mobile relay views show inert fallbacks.
Embedded documents run in isolated frames with external resources and navigation
blocked. See [Inline message content](docs/public-api.md#inline-message-content)
for registration, reference formatting, lifecycle and image-source details.

```bash
git clone https://github.com/rbcodelabs/obsidian-claude-threads
cd obsidian-claude-threads
npm install
npm run build
# Output is in dist/
```

## Releasing

The project uses a worktree-based workflow — edits directly to the main checkout are blocked by a git hook. Follow these steps:

1. **Create a worktree** for the version bump:
   ```bash
   git worktree add ~/.geode/worktrees/obsidian-claude-threads/chore/bump-version-X.Y.Z -b chore/bump-version-X.Y.Z
   cd ~/.geode/worktrees/obsidian-claude-threads/chore/bump-version-X.Y.Z
   ```

2. **Bump the version** with the repository workflow. This updates `package.json`, `package-lock.json`, and `manifest.json`, then syncs `versions.json`. Update the README version badge to the same version and verify all five files agree:
   ```bash
   npm version X.Y.Z --no-git-tag-version
   npm run sync-versions
   npm run check-versions
   # Confirm the README badge also says X.Y.Z.
   git add manifest.json package.json package-lock.json versions.json README.md
   git commit -m "chore: bump version to vX.Y.Z"
   git push -u origin chore/bump-version-X.Y.Z
   ```

3. **Open and squash-merge a PR** for the version bump:
   ```bash
   gh pr create --title "chore: bump version to vX.Y.Z" --body "Version bump." --base main
   gh pr merge <number> --squash --delete-branch
   ```

4. **Pull main and push the tag** to trigger the release workflow:
   ```bash
   git pull origin main
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. That's it. The [release workflow](.github/workflows/release.yml) verifies the tag and committed `versions.json`, builds the plugin, and publishes a GitHub release with `main.js`, `styles.css`, `manifest.json`, and `versions.json` attached — BRAT will pick it up within a few minutes.

## License

MIT

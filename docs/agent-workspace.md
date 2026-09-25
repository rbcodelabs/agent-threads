# Native agent workspace

Agent Threads preserves harness-native child agents as durable `AgentRun` records. Agent status never crowds out the conversation.

When Claude or Codex reports an agent, a compact pill appears in the composer footer showing how many agents are working (or how many failed, or a plain count once everything has finished). The pill is always visible while agents exist; it disappears, and the footer returns to its normal hover-only behavior, once the thread has no agent runs at all.

Click the pill to open a popover above the composer listing every agent in the thread, indented by parent. Arrow keys move between rows, `Escape` closes it, and clicking outside dismisses it.

Selecting an agent replaces the message pane with that agent's harness-exposed activity, lifecycle, errors, and result, without creating a separate thread. A sticky breadcrumb at the top (`Main conversation › parent › child`) walks back up the tree, and a close button returns to the conversation directly. Your scroll position in the main conversation is restored when you come back.

The composer stays live while a child view is open. Its placeholder notes that a message goes to the main conversation, and sending one visibly returns you there rather than silently redirecting.

## Choosing the harness at kickoff

The Agents List and Agent Board dispatch controls show the harness that will own the new thread. A normal click dispatches with the shown Claude or Codex harness. Right-click, press and hold, or focus the button and press `Shift+F10` to choose the other harness without sending. The selection remains local to that mounted view; the Agent harness setting is only its initial default.

## Switching an existing thread

An idle desktop thread can move between Claude and Codex from **Harness** in the conversation footer menu. The thread ID, transcript, project, working directory, goal, and completed child-agent history stay intact. The target receives a fresh provider-native session, with a one-time bounded summary and references to the thread messages and available raw log/note. Its model override, usage snapshot, task board, and other provider-native state reset.

Established conversations ask for confirmation. Switching is unavailable while a turn, queued send, permission, question, plan, goal transition, background task, or child agent is unsettled; the menu names the blocking condition. Assistant messages retain their provider attribution so mixed Claude/Codex vault transcripts remain accurate.

The Agents List groups conversations by resolved Project and orders adaptive two-line rows into Working, Waiting, New, Reviewed, Failed, and Ready sections. Status, title, and recency occupy the primary line; activity, repository/path, and agent count share a truncation-safe secondary line. Permission, question, plan, waiting, and AWS reauthentication states expand into dedicated action rows when required. Child-agent activity is summarized by one accessible agent-count control that opens the team picker without changing the current selection. The count is green only while at least one child is starting, working, or waiting; otherwise it uses the faint secondary treatment in both the list and Agent Board. Agent role, task, and current activity remain included in list search.

## Codex proactive agents and questions

Codex native agents remain available when the model explicitly delegates work. To let Codex decide proactively when parallel agents help, select **Codex effort level → Ultra** in Agent settings. Agent Threads passes `effort: "ultra"` only when the selected model advertises it; unsupported combinations stop before the turn with a clear error. The deprecated Codex `multiAgentMode` setting is never sent.

Codex can also pause for structured input through its native `request_user_input` protocol. These prompts use the same persisted desktop/mobile card and relay/reload path as Claude questions, while preserving Codex question IDs, option descriptions, free-form behavior, and secret-field masking. Default-mode input is enabled through app-server feature discovery, so older Codex binaries continue to work without receiving unsupported flags.

## Current capability matrix

| Harness | Stable child ID | Lifecycle/activity | Parent linkage | Direct message from UI | Interrupt one agent from UI |
|---|---:|---:|---:|---:|---:|
| Claude Agent SDK 0.3.233 | Yes (`task_id`) | Yes (`task_started`, `task_updated`, `task_progress`, notifications) | Used when `parent_task_id` is present | No verified public `Query` method | No verified public `Query` method |
| Codex app-server | Yes (`receiverThreadIds`, `agentThreadId`) | Yes (`collabAgentToolCall`, `agentsStates`, `subAgentActivity`) | Used when the event provides `senderThreadId`/`parentThreadId` | No verified host-callable path | No verified host-callable path |

The Claude SDK defines model-invoked `SendMessage` and `TaskStop` tool inputs, but its public host-side `Query` surface exposes only whole-query interruption. Agent Threads does not pretend those model tools are direct UI controls. Codex collaboration events similarly prove observation, not a callable host control. Consequently, the agent activity view explains that direct message and single-agent interrupt are unavailable, and never redirects an attempted child action to `main`.

## Persistence and recovery

Agent runs are persisted with their owning thread in plugin data. Terminal history survives reload. A run that was active when Obsidian closed is restored as **unavailable** until its harness reports live activity again. Duplicate native events are replay-safe, and a child whose parent arrives later is reattached automatically.

Background shell jobs and local workflow phases remain ordinary tasks; they are not promoted to conversational agents.

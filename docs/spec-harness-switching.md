# Existing-thread harness switching

## User contract

The conversation footer menu can switch an idle thread between Claude and Codex without creating another thread. Existing conversations require confirmation; empty threads switch immediately. The transcript, thread identity, project, cwd, goal, artifacts, drafts, and terminal agent history are preserved.

The target always starts a fresh native session. A durable one-time handoff contains a bounded maintained or deterministic summary, the Agent Threads thread ID, and only references that exist. It tells the target to use `threads_get_messages` for visible history and, when available, `threads_get_log`, the raw-log path, and the archived note. It never replays recent messages as a prompt.

## Lifecycle

One eligibility check blocks switching during an active or initializing turn, queued or unsettled input, permission/question/plan/elicitation, goal or plan-feedback transition, background task/agent, or another switch. Persistence is transactional: provider ownership and a new session generation are saved before the old idle adapter closes. A failed save restores the source fields. Sends arriving during persistence queue and release against the committed provider.

The handoff survives reload and target startup failure. It clears only after the first successful target completion establishes a target-native session ID. Session callbacks capture harness, generation, and cwd; callbacks from retired generations cannot mutate durable state.

## Provider state

Switching clears the native session ID, per-thread model, usage snapshot, task board, recap, and stale error. Codex uses its native default unless the thread subsequently selects a discovered Codex model; Claude may use the configured Claude default. Assistant messages carry harness attribution for mixed-provider Markdown archives.

# ADR-0009: Orchestration ownership boundary

**Date:** 2026-09-19
**Status:** Accepted

## Context

Two things were independently becoming orchestrators. Inside Agent Threads, orchestration behaviour accumulated across bundled skill instructions, a designated orchestrator thread identity, Project scope, scheduled wakeups, tracking notes, proposed replies and lifecycle policy. Outside it, the Voice plugin grew intent interpretation, delegation, follow-up and notification behaviour, and reached into Threads internals to act on them.

The result was duplicated judgement with no owner. Threads decided what should happen next in some paths, Voice decided in others, and neither could be changed without reasoning about the other. Voice also carried an identity problem: voice is one interaction surface, not the product. Naming the plugin after its input device kept its actual responsibility — deciding what work should run and what happens after — invisible.

## Decision

Apply a single placement rule. If a feature changes how agents execute, it belongs in Agent Threads. If it gives agents something optional to do or present, it belongs in a peer capability plugin. If it decides what should happen next, it belongs in Orchestrator.

Threads keeps execution, permissions, questions, plan approval, persistence, recovery, status, archives, and the generic grouping that thread execution needs. Orchestrator keeps interaction surfaces including voice, intent interpretation, target selection, portfolio and Project coordination policy, follow-up and escalation, notification behaviour, and its own identity and memory. Orchestrator consumes Threads as an execution provider through the public API and peer plugins as capability providers; it does not impersonate an internal orchestrator thread or mutate private manager state.

The capability initially shipped as a renamed successor to Voice rather than a rename in place: plugin id `obsidian-orchestrator`, version reset to `0.1.0`, with a legacy migration that imports the Voice settings file on first load and moves the stored OpenAI key into secret storage. The Voice repository is retained as history.

Its final successor identity is plugin and repository id `threads-orchestrator`, displayed as **Threads Orchestrator**. Version `0.2.0` makes a deliberate breaking rename from `obsidian-orchestrator` so the product name describes its relationship to Agent Threads across both Obsidian and Geode rather than naming one host. The cutover must preserve existing settings and the shared `openai-api-key` secret, recover a saved `obsidian-orchestrator:voice-panel` when the old plugin is disabled, and prevent both plugin identities from controlling the microphone concurrently. Because host APIs cannot migrate updater records or command hotkeys, users must remove the old BRAT or Geode updater entry, install the new identity, verify the import, rebind custom hotkeys, and only then remove the old plugin directory.

Policy moves out of Threads in vertical slices, each with a compatibility window, and Threads must remain a complete manually operated agent workspace with Orchestrator absent or disabled.

## Options considered

| Option | Benefit | Cost |
| --- | --- | --- |
| Keep orchestration inside Threads | No second install; no cross-plugin contract | Threads absorbs unbounded policy; voice and future surfaces still need private access; execution and judgement stay entangled |
| Rename Voice in place, keeping its plugin id | Users keep settings with no migration | Inherits a device-named identity and its settings schema; no clean boundary moment; existing Voice installs silently change behaviour on update |
| Renamed successor with migration path (selected) | Clean identity and schema; both plugins installable side by side during transition | Two install surfaces; migration must be written and must be idempotent |

## Consequences and risks

This resolves the open question of whether the orchestration product keeps either historical plugin id: it keeps neither `obsidian-voice` nor `obsidian-orchestrator`; `threads-orchestrator` is canonical. The migration path is the compatibility obligation created by those choices, and it must tolerate being run against an already-migrated profile, a missing legacy file, and a profile that already carries its own settings. Migration precedence is the new identity's settings, then `obsidian-orchestrator`, then `obsidian-voice`, then defaults; it must remain idempotent and must not retain plaintext API keys.

`orchestrators.list` and `orchestrators.dispatch` remain the seam between the two products. Dispatch resolves a symbolic target to a thread and then reuses the ordinary send path, which means orchestration targeting stays declarative and inherits existing busy-state and run-record behaviour rather than duplicating it. Note that resolution currently creates the orchestrator thread on demand; that side effect is load-bearing for first use and should not be removed casually.

The principal risk is that Orchestrator becomes a second monolith by absorbing the domain logic of every capability it coordinates. The mitigation is structural: capability-specific behaviour belongs to peer plugins under ADR-0008, leaving Orchestrator as a composition and policy layer. A second risk is that speech ambiguity or injected document content triggers destructive actions; the mitigation is that sensitive operations are confirmed by host policy at execution time, never by prompt instruction, and the public API continues to exclude archive, delete and silent cross-Project elevation.

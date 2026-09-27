# ADR-0012: Switch harnesses in place with a fenced fresh session

**Date:** 2026-09-24
**Status:** Accepted

## Context

Threads persist conversation and product context, while Claude and Codex session IDs, models, callbacks, and child-agent IDs are provider-native. Users need to change providers without fragmenting one conversation or accidentally resuming a foreign session.

## Decision

Switch the owning harness on the existing thread only at a settled boundary. Persist a monotonically increasing session generation and a one-time provider-neutral handoff before closing the old adapter. The target starts fresh; captured harness/generation values fence late callbacks and native child-agent identity.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Fork a new thread | Simple isolation | Splits transcript and thread identity |
| Keep parallel provider sessions | Fast switching back | Ambiguous ownership and stale callback risk |
| Fresh target session in place | One conversation, explicit ownership | Requires transactional persistence and handoff |

## Consequences

Visible history and neutral thread context remain continuous, but provider-native model, task, usage, and session state reset. Exact history stays available through Agent Threads tools instead of prompt replay. Switching waits for all unsettled lifecycle state, trading immediacy for deterministic ownership.

## Risks

A summary can omit detail, so the handoff always includes the stable thread ID and only valid transcript/log/note references. Any newly introduced session callback must apply the same generation fence.

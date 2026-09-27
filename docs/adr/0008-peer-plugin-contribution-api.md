# ADR-0008: Versioned peer-plugin contribution API

**Date:** 2026-09-19
**Status:** Accepted and implemented

## Context

Peer plugins reached Agent Threads through `app.plugins.plugins['claude-threads'].manager`, casting private types locally and subscribing to an internal event union of roughly sixty variants. They duplicated status derivation, message serialization, wait behavior and view-mount timing, and they broke whenever an internal refactor landed. Public API v1 (v0.41.0 line, first shipped in v0.33.0) replaced the *consumption* half of that relationship with semantic operations, immutable snapshots, a five-variant public event union, and generation-bound revocation that returns `PLUGIN_UNAVAILABLE` after unload.

The *contribution* half was deliberately excluded and is still documented as a non-goal. Without it, an optional capability cannot be a peer plugin at all: it must be merged into Threads. Design mode is the concrete case — it is optional, domain-specific, and releases on a different cadence than the execution kernel, yet it lives in the kernel because there is no other place for it to live.

An inventory of Design's actual coupling shows the originally drafted sketch — dispatch handler, artifact provider, agent-tool bundle — is incomplete. Design additionally requires a per-thread in-process agent tool, slash-command registration in two catalogs, thread-metadata write-through, effective-permission-mode introspection, and preview brokering through a controller that is entirely private to the host. A contribution API designed from the sketch alone would ship and immediately fail its first real consumer.

## Decision

Extend API v1 additively with an `extensions` namespace, modelled on the existing `mcp.register` precedent rather than on a generic plugin framework: the caller supplies a namespaced owner identity, the host may refuse, the result is a structured value rather than a thrown error, and every registration is disposable and is dropped both on peer unload and on host `stop()`.

Contribution types are added one at a time and proven by a real consumer. Design first ran through the public surface in-repository; it is now extracted to the private `rbcodelabs/threads-design` peer plugin. Agent Threads no longer registers Design commands, tools, or mutable artifact behavior.

The final lifecycle gap is addressed by `threads.beginProvisional(owner, input)`. It returns a generation-bound, immutable commit/rollback handle. Pending threads cannot run. Rollback deletes the provisional thread, restores the prior selection, and releases host-allocated artifact roots; host shutdown rolls back any unresolved handles. This keeps thread deletion and selection repair private while allowing the peer to own create → scaffold → attach → preview → commit → send.

`capabilities` becomes computed from the dependencies actually present at construction rather than a static constant, so discovery stops advertising operations that fail at call time.

## Options considered

| Option | Benefit | Cost |
| --- | --- | --- |
| Continue private manager access | No new surface to design or support | Peers break on every internal refactor; no revocation, no compatibility window; duplicated execution logic across plugins |
| Design a general extension framework up front | One coherent surface; no incremental churn | Speculative and unfalsifiable; the drafted sketch already proved incomplete against the first real consumer |
| Incremental contribution types proven by a reference provider, followed by extraction (selected) | Each addition has a real consumer; the riskiest assumption is falsified before extraction | Requires a temporary in-repo phase and coordinated plugin installation |

## Consequences and risks

The contribution surface required by the reference consumer is: dispatch-handler registration; artifact provider with declarative presentation (ADR-0010); per-thread in-process agent-tool contribution; slash-command registration covering both the composer and the dispatch catalogs; scoped thread-metadata write-through; and effective-permission-mode introspection covering `permissionMode` and `pendingPlan`, neither of which appears on a public snapshot today.

Two couplings are materially harder than the rest and are called out so they are not discovered late. Agent tools are bound per thread inside the MCP server factory, so contributing one means changing how sessions are constructed, not adding a method. Preview placement runs through a private context-panel controller whose leaf ownership and conversation-first policy are host-internal; a peer needs a brokered operation that returns where the view actually landed, because the host may legitimately place it elsewhere.

Three artefacts must stay in sync whenever the surface grows: the runtime capability list, the checked-in consumer type declaration, and the public API documentation. The checked-in declaration has already drifted — it omits the `mcp` namespace shipped in v0.33.0 — so that drift is fixed as part of the first contribution change and a test should pin the two together.

Registrations that outlive their owner are the main new failure mode. Anything registered must be torn down on `stop()` the way event listeners already are, or a plugin reload leaves a stale handler bound to a dead generation. Provider callbacks must be bounded by timeouts and isolated so one peer's exception cannot break thread execution. Both Obsidian and Geode plugins remain trusted in-process code; namespacing and host confirmation organise authority and user-facing behaviour, and are not a sandbox.

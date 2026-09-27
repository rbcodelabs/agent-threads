# ADR-0011: Declarative inline message content providers

**Date:** 2026-09-23
**Status:** Accepted

## Context

Peer plugins can attach artifacts to a thread, but those cards occupy the
composer panel. They cannot present rich content at a specific position in an
assistant reply. The built-in visualization renderer demonstrates inline
placement, while keeping its rendering private to the host.

The required outcome is for sibling plugins to contribute rich cards, images
and interactive documents within normal replies, with persistence and lifecycle
behavior that does not depend on a peer holding host DOM.

## Decision

Add `extensions.registerMessageContentProvider` and
`messageContent.formatReference` to public API v1. A standalone
`agent-content{...}` reference carries the provider ID, stable content ID,
schema version, fallback title and bounded JSON data. It persists as ordinary
message text; no additional content store or Thread schema is required.

Providers describe card, image or document presentations and named actions.
Threads owns the DOM. Providers receive captured thread/message identity and
cancellation signals. The agent returns the reference in its assistant reply
where the presentation belongs; registration does not append a message.

Only assistant transcript messages resolve providers. Streaming references are
inert. Missing or failing providers retain the stored title and an explanation.
Provider removal, message rerender, thread switching and view closure invalidate
pending callbacks and actions.

Documents use nested sandboxed srcdoc frames with a trusted outer document.
The outer policy denies remote child navigation; the inner policy confines
resources to self-contained content. A single sandboxed frame with a meta CSP
does not by itself prohibit its own navigation, so browser tests must verify
this boundary rather than relying on a policy string.

Existing artifact providers and Codex visualization references retain their
existing contracts. Relay clients show fallback cards without forwarding actions
to a desktop provider.

## Options considered

| Option | Benefits | Costs |
|---|---|---|
| Arbitrary DOM callbacks | Maximum provider flexibility | Couples peers to rendering internals and cleanup |
| References to a separate mutable content store | Central updates and asset lifecycle | Adds persistence, mutation and migration contracts |
| Self-contained references with declarative presentations | Small additive API; exact placement; durable fallback | References are immutable; peers own external asset durability |

Choose self-contained references with declarative presentations for this scope.

## Consequences

Providers can return references through existing contributed tools, and agents
can position them in ordinary replies. Host rendering stays consistent.
Messages remain understandable after a provider is removed.

Reference data is part of the transcript and may be archived or relayed: peers
must use non-secret identifiers, keep large assets elsewhere, and validate every
reference before resolving it. A reference is untrusted input, not authorization.
Presentations should be read-only; mutations belong in explicit user actions.

## Risks

Self-contained documents may not satisfy adopters who need authenticated remote
apps. Network permissions or frame-to-host RPC require a separate capability
design. Cancellation cannot roll back side effects already performed by peer
code. Synchronous callbacks cannot be preempted on the host's JavaScript thread.

## Verification

Unit tests cover registration, reference validation/parsing, fault handling and
stale work. Browser tests cover the public registration-to-transcript path,
multiple cards, actions, provider removal, streaming placeholders, reload,
mobile fallback and nested-document isolation. Visual verification covers
desktop, 390px and 375px layouts using the existing chat card hierarchy.

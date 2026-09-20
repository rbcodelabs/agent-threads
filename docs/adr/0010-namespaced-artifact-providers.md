# ADR-0010: Namespaced artifact providers

**Date:** 2026-09-19
**Status:** Accepted

## Context

Design mode is the only artifact producer in the plugin, and every layer of it is specific to design. Artifacts are written as raw filesystem scaffolds under `.geode/artifacts/<id>`, bypassing the vault abstraction. They are stored on the thread as a `DesignArtifact[]` with a hardcoded `kind` discriminator, and persisted incidentally because threads are serialized wholesale. The control card is a bespoke renderer statically imported into the main view, mounted at a fixed position in the panel, with three design-specific buttons. Preview placement runs through the private context-panel controller and a host-provided view type, with an Electron reveal fallback.

None of that is reusable, and more importantly none of it is reachable by a peer plugin. The riskiest assumption in the modular architecture is precisely that an optional plugin can present an artifact without being handed a view instance or arbitrary DOM. That assumption is currently untested, because the only producer is built in and takes the privileged path.

There is also a live defect that the current shape makes easy to miss: deleting a thread removes its attachment directory but leaves `.geode/artifacts/<id>` on disk, because artifact storage has no owner in the deletion path.

## Decision

Introduce a generic, namespaced artifact reference carrying provider id, kind, schema version, id, title and opaque provider data. The host owns storage identity, lifecycle, generic presentation and missing-provider behaviour. The provider owns its data schema, its actions, and its own migrations after the compatibility window.

A provider returns a declarative presentation — a title, metadata and a set of named actions — and never receives a view instance, a workspace leaf, or a DOM node. Preview placement is brokered by an explicit host operation that reports where the view actually landed, because the host legitimately decides between the context panel and a tab according to policy the peer cannot see.

Existing `design-static` artifacts remain readable through a read-only compatibility renderer retained in the host, so upgrading or removing the design plugin never orphans work a user already produced. Artifact storage becomes host-owned for garbage-collection purposes, and thread deletion removes the artifact directory.

## Options considered

| Option | Benefit | Cost |
| --- | --- | --- |
| Provider renders its own DOM into a host-owned slot | Trivial to implement; unlimited provider freedom | Unbounded blast radius — a peer can break thread rendering; no stable contract to test; defeats the assumption this phase exists to falsify |
| Declarative presentation returned by the provider (selected) | Testable contract; provider faults are isolated; identical path for built-in and external providers | Constrains what a provider can render; some design actions must become named actions rather than arbitrary UI |
| Host owns a schema per artifact kind | Simplest rendering; no provider data versioning | No extensibility at all — every new artifact type is a host change, which is the problem being solved |

## Consequences and risks

Routing built-in Design through this contract while it still ships in-repo is what falsifies the riskiest assumption cheaply. If a declarative presentation cannot express preview, capture and reveal, that is discovered before a repository is split, not after. The exit criterion is that built-in Design uses no privileged path unavailable to a peer.

Making storage host-owned fixes the orphaned artifact directory as a side effect, because deletion finally has an owner. Persisted references must carry provider id and schema version even when the provider is absent, so an uninstalled plugin renders an explanatory placeholder rather than vanishing or erroring.

Two existing behaviours must be treated as deliberate rather than incidental. Artifacts are excluded from the relay serialization, so mobile clients never see them; that stays true until a considered decision changes it. Artifact scaffolds are written with an exclusive-create flag so an existing artifact's source is never overwritten on re-entry, and any generic write path must preserve that guarantee.

Duplicate provider ids and dispatch collisions must fail loudly at registration rather than resolving by last-writer-wins, and provider callbacks are bounded and isolated per ADR-0008.

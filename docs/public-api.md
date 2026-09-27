# Peer Plugin API v1

Agent Threads exposes a generation-scoped API to other enabled Geode/Obsidian plugins:

```ts
const api = app.plugins.plugins['claude-threads']?.api?.v1;
```

Listen for `claude-threads:api-ready` and `claude-threads:api-stopping`, reacquire the API after every ready event, and discard an API object after stopping. The checked-in consumer contract is [`api/public-api-v1.d.ts`](../api/public-api-v1.d.ts).

## WikiSkill-safe capabilities

- `threads.create/send/wait/cancel` accepts caller correlation. Supplying both `ownerPluginId` and `idempotencyKey` makes create/send retries idempotent. Keys are bound to their operation, target thread, and an input fingerprint; reuse with different input fails with `IDEMPOTENCY_CONFLICT`. A second distinct active send fails with `THREAD_BUSY`.
- `threads.beginProvisional(owner, input)` creates a persisted but non-runnable thread and returns an immutable `commit()` / `rollback()` handle. `send` fails with `THREAD_BUSY` until commit. Rollback deletes the thread, restores the previous selection, and releases storage allocated through `artifacts.allocateStorage`; unresolved handles are rolled back when the API generation stops. Commit and rollback are serialized and idempotent. This is the transaction boundary for peer-owned create → attach → preview workflows.
- `origin`, `externalJobId`, `ephemeral`, and `background` identify managed work. When an owner is supplied, omitted origin defaults to `ownerPluginId`; a conflicting explicit origin is rejected. Background threads are hidden from both Agent Board views. Threads with an `origin` are excluded from trace sources to prevent self-training loops.
- `traces.listSources/readChunk/subscribe` returns immutable, bounded, sanitized semantic records through opaque cursors. Source discovery uses stable source-ID paging. Chunks always return a byte-offset continuation cursor (including at EOF, so polling can resume after append) bound to the source ID, append-stable revision, and a restart-verifiable byte-boundary fingerprint. `contentHash` changes when content is appended. Skill attribution is maintained by a revision-and-installed-skill-set-bound incremental session state machine that resets at `session_start` and terminal `result`, rather than rescanning history per result. Per-session attribution and simultaneous distinct-source projection work are bounded; overflow fails closed with no partial attribution. `TraceEvent.invokedSkill` is present only when a structured assistant `Skill` request names a currently registered skill and has a correlated, successful `tool_result`; that result carries `skillLoadOutcome: 'loaded'`, which does not imply task success. A terminal `result` event carries `skillRunOutcomes`, with the verified skill name, its source invocation index, and the enclosing run's `success` or `failure` outcome. Failed loads, unregistered skills, and text-only claims remain unattributed. Raw log paths, credentials, known secret fields, and absolute POSIX, Windows drive, UNC, home-relative, and file-URI paths are never returned; ordinary web URLs remain intact.
- `constrainedRuns` provides Claude-only, one-turn, input-only evaluation. It runs in a fresh empty directory with an isolated home/config directory and an authentication-only environment, then removes that directory. Provider credentials are projected from the plugin's keychain-backed resolver through an exact environment-name allowlist; the host configuration is never copied. It loads no tools, MCP servers, settings sources, skills, plugins, host filesystem context, or resumable session. Inputs, budgets, timeouts, persisted state (1 MiB total), and output (100,000 characters) are bounded. Unsupported constraints fail with `CONSTRAINT_UNSUPPORTED`.

`capabilities` is computed from the dependencies actually present at construction, so discovery never advertises an operation that would fail at call time. Check it before optional operations, including `threads.beginProvisional` and anything outside the core thread/orchestrator surfaces.

## Contributions

`extensions.registerArtifactProvider(owner, contribution)` lets a peer present a durable artifact on a thread. It follows the `mcp.register` precedent: the caller supplies a namespaced owner identity, the host may refuse, the result is a structured value rather than a thrown error, and the registration is disposable.

- A provider supplies a namespaced `providerId` (`<publisher>.<capability>`), the artifact `kinds` it owns, a `present(ref)` that returns a declarative presentation, and an `invoke(actionId, ref, host)` that runs one named action. It never receives a view instance, a workspace leaf, or a DOM node.
- `ThreadArtifactRef.data` is opaque to the host: the provider owns its own schema and its own migrations. `present()` returns a title, an optional subtitle and icon, and a list of named actions; the host renders them.
- Actions reach the host only through the `ArtifactActionHost` lent for the duration of that one call: `openView()` (the host decides between the context panel and a tab by its own policy, and reports where the view actually landed), `revealInFolder()`, and `updateArtifact()` (a scoped write-through for that one artifact; host-owned identity fields are not writable).
- Duplicate provider ids fail loudly with `status: 'conflict'` and the existing registration is untouched; a non-namespaced id fails with `status: 'invalid'`. `dispose()` is idempotent, is present on every result, and never retracts a later registration. Every registration is dropped on host `stop()`, so a reload cannot leave a provider bound to a dead generation.
- Provider callbacks are isolated and bounded. A `present()` that throws degrades that one card to an explanatory placeholder; an `invoke()` that throws or exceeds the host timeout becomes an `error` result shown to the user. Neither can break thread rendering or execution.
- A persisted artifact whose provider is not registered still renders, showing its stored title and naming the missing provider, with no actions. The one compatibility exception is legacy `design-static` work: Agent Threads supplies a read-only fallback that can reveal its source. A live Design plugin always overrides that fallback. Uninstalling a plugin never makes prior work vanish.

### Creating and opening an artifact

`extensions.registerArtifactProvider` only covers presentation. The `artifacts` namespace is the entry point: it lets a peer attach an artifact to a thread and invoke one of its actions without a view, DOM, or private manager access.

- `artifacts.attach(owner, threadId, ref)` persists an artifact and returns `attached` or `updated`. It is idempotent on `ref.id`: re-attaching the same id updates in place rather than producing a second card.
- `owner` is explicit on `attach`, `update` and `detach` because the API object is a single shared singleton — the host cannot infer which plugin is calling, so ownership is asserted rather than derived. It is checked against the identity that registered `ref.providerId`, so one plugin cannot write artifacts into another plugin's namespace (`status: 'conflict'`). A provider nobody registered gives `unknown-provider`; a `kind` the provider never declared gives `invalid`.
- `artifacts.invokeAction(threadId, artifactId, actionId)` runs a named action on exactly the path a card click takes, with the same provider isolation, the same invoke timeout and the same `ArtifactActionResult`. It is deliberately ownerless: it runs the owning provider's own code against its own artifact, which is what a user clicking the card already does.
- Unknown thread, unknown artifact, unregistered provider and unknown action id each produce a distinct structured outcome. Nothing in this namespace throws for input a caller could plausibly get wrong; only a revoked generation throws (`PLUGIN_UNAVAILABLE`).
- `ThreadArtifactRef.storageRoot` is optional and is the one deliberately non-opaque field: the host needs it to delete an artifact's files when the owning thread is deleted. It is resolved (through `..` and, where possible, symlinks) and must lie strictly inside `<vault>/.geode/artifacts/`. The artifact root itself, the vault root, relative paths and anything outside the tree are rejected, and a rejected root fails the whole `attach` rather than being silently dropped. `storageRoot` is host-owned thereafter: neither `updateArtifact()` nor provider data can rewrite it, only `artifacts.update` with a freshly validated value.
- Deleting a thread removes the storage of its artifacts, re-validating each root immediately beforehand. A missing or already-deleted directory is not an error. Detaching an artifact deliberately does *not* delete storage — that is removing a card, not deleting a user's work.
- Provider `data` must be a plain JSON-serializable object and is bounded (256 KiB serialized), because it is persisted inside the host's own settings file.
- `artifacts.allocateStorage(threadId, artifactId)` creates that root and returns it, so allocation is a contract rather than a layout a peer has to reproduce from an undisclosed vault path. It reuses the same containment check `attach` and deletion use — not a second copy — and is idempotent: re-allocating an existing root returns it with `status: 'existing'` and clobbers nothing inside. It is ownerless, because allocation necessarily runs before the artifact (and therefore its provider binding) exists; it creates an empty directory and grants nothing. `artifactId` must be a single path segment, so a traversal attempt is rejected twice over.

### Contributing an agent tool

`extensions.registerAgentTool(owner, contribution)` lets a peer add an in-process agent tool that every thread session can call.

- **The host injects the thread id.** A peer writes `invoke(threadId, args, host)` and never names or chooses a thread; the host binds the contribution per thread when it builds that session's MCP servers. A peer never sees, receives or constructs the server factory — that inversion is what makes the tool contributable at all.
- **Names cannot be shadowed.** A name colliding with a host built-in (either its canonical or its deprecated-alias spelling), a core agent tool (`Read`, `Bash`, `Task`, …), or another peer's contribution is rejected with `status: 'conflict'`. It is never last-writer-wins, so a peer cannot take over `Bash` for every thread on both harnesses. The incumbent registration always survives.
- **Schemas cross the boundary as JSON Schema**, so contributing a tool needs no shared zod instance. An object schema with `properties`/`required` is converted by the host; anything it does not recognise degrades to "accepted, unvalidated" rather than refusing to register. A contribution's own `invoke` should re-check its arguments regardless, because native harnesses bypass MCP schema parsing entirely.
- **Approval defaults to required.** A contributed tool is treated as a mutation unless it sets `requiresApproval: false`, so it inherits the native-harness approval prompt rather than silently bypassing it.
- **Faults are isolated and bounded.** A contribution that throws (synchronously or asynchronously), returns a malformed result, or hangs past the host timeout becomes an ordinary tool error for that one call. It cannot take down the session, the thread, or another peer's tools.
- **Registrations do not outlive their owner.** They are dropped on `dispose()` and on host `stop()`, like every other contribution, so a reloaded peer never leaves a phantom tool advertised to sessions built afterwards. A stale `dispose()` cannot retract a later registration of the same name.
- **Already-running sessions are not retrofitted.** Bindings are taken when a session's MCP servers are constructed, so a tool registered before construction is present and one registered afterwards is not; it appears on the next session. This is deliberate — the tool catalog for a turn in flight is already fixed, and mutating it mid-turn would change the tools out from under an agent that has already been told what it has.

`threads.permissions(threadId)` supports this: it returns the effective permission mode and whether a plan approval or question is pending. Neither appears on `ThreadSnapshot`, so without it a peer that writes on a thread's behalf cannot tell whether writing is permitted. The mode is already resolved against the global default, because that default is itself host-private. It returns values only — the pending plan's text and the callbacks that resolve it stay host-side.

The API serializes correlated operations and awaits atomic host persistence before returning their handles. Idempotency mappings and results are retained and evicted as pairs. A provider reload marks an in-flight operation interrupted; a consumer can reacquire v1 and reconcile it by run ID without duplicating work. Cancellation, completion, and provider shutdown use first-terminal-wins semantics.

## Contributing a slash command

Check `api.capabilities.includes('extensions.registerSlashCommand')`, then register one lowercase token (1–64 characters, letters/digits/hyphens, beginning with a letter), without a leading slash:

```ts
const registration = api.extensions.registerSlashCommand({ pluginId: 'example.boards' }, {
  name: 'board',
  thread: {
    description: 'Open the board for this thread',
    async invoke(context, host) {
      if (host.signal.aborted) return { status: 'error', message: 'Cancelled' };
      await openBoard(context.threadId, context.args);
      host.report('Board opened');
      return { status: 'ok' };
    },
  },
});
// On peer unload; also automatically disposed when the host generation stops.
registration.dispose();
```

`thread` and `dispatch` are independent optional descriptors; provide at least one. Each has its own description and `invoke(context, host)` callback. Dispatch commands appear in both Agents List and Agent Board. Registration returns `registered`, `invalid`, `conflict`, or `unavailable`, always with an idempotent `dispose()`; a stopped API generation throws `PLUGIN_UNAVAILABLE`.

The immutable context contains `surface`, original submitted `text`, parsed multiline `args`, `threadId` for the composer, the captured `agentHarness` and `projectId` when available, and `hasImages`/`hasAttachment`. Attachment contents, DOM nodes, views, and private managers are never lent to peers. A dispatch callback receives the selected project as context; it decides what operation to perform. Registration itself grants no additional permission.

Core command names (including `/fork`) and the enabled escalation keyword are reserved, case-insensitively, at registration, discovery, and invocation. Peers cannot shadow each other. Matching consumes the entire command token: `/boardwalk` is not `/board`. Catalog changes update open dropdowns and pills, and a temporarily shadowed skill returns when the contribution is removed.

A handler may also supply `argCompletions`: up to 20 `{ name, description }` entries (name ≤64 characters, description ≤256) offered in the composer's existing argument dropdown once the command name has been typed, e.g. typing `/board ` suggests the entries below the same way the host's own `/model fable|opus|sonnet|haiku|default` does today. A malformed entry rejects the whole registration with `status: 'invalid'`.

```ts
api.extensions.registerSlashCommand({ pluginId: 'example.boards' }, {
  name: 'board',
  dispatch: {
    description: 'Open a board by name',
    argCompletions: [
      { name: 'sprint', description: 'Current sprint board' },
      { name: 'backlog', description: 'Full backlog board' },
      { name: 'archive', description: 'Closed/archived board' },
    ],
    async invoke(context, host) {
      await openBoard(context.args);
      return { status: 'ok' };
    },
  },
});
```

Return `{ status: 'ok' | 'error', message?: string }`; `host.report(message, isError?)` supplies intermediate or deferred feedback scoped to the captured thread. A switched or deleted thread never receives another thread's inline feedback. Exceptions, invalid results, disposal, and the 60-second deadline become structured errors. Dispatch failures restore text and attachments while retaining any newer draft. A matched invocation never falls through to an ordinary agent prompt. Cancellation is cooperative: heed `host.signal`; the host cannot roll back arbitrary peer side effects. Disposal and host shutdown revoke both pending calls and later feedback; an old disposer cannot remove a replacement registration.

Design for Agent Threads is now a separate peer plugin. It registers `/design`, `EnterDesignMode`, and the `agent-threads.design` artifact provider through this API. New-thread dispatch uses `threads.beginProvisional`: pre-commit preparation or preview errors roll back the thread and allocated storage; preview warnings are durable; a kickoff-send failure after commit preserves the artifact and reports the error. When the peer is absent, Agent Threads exposes no Design command or tool and retains only the read-only legacy source fallback.

## Inline message content

`extensions.registerMessageContentProvider(owner, contribution)` lets a sibling
plugin contribute rich content at a specific position in an assistant reply.
Unlike attached artifacts above the composer, these cards live within the
transcript, between the surrounding paragraphs.

Check `capabilities` for `extensions.registerMessageContentProvider`. Register
the provider once per API generation and dispose it when your plugin unloads.
The host owns every card, image, button and sandbox frame; providers never
receive host DOM.

```ts
const registration = api.extensions.registerMessageContentProvider(
  { pluginId: 'example-reports' },
  {
    providerId: 'example.reports',
    present(ref, context) {
      // References are untrusted input. Validate your data/schema before use.
      if (ref.schemaVersion !== 1 || typeof ref.data.reportId !== 'string') {
        throw new Error('Unsupported report reference');
      }
      return {
        kind: 'card',
        title: ref.title,
        subtitle: 'Quarterly review',
        body: 'Open the report to review its supporting details.',
        actions: [{ id: 'open', label: 'Open report', variant: 'primary' }],
      };
    },
    async invoke(actionId, ref, context, host) {
      if (context.signal.aborted || actionId !== 'open') {
        return { status: 'error', message: 'Action unavailable' };
      }
      const placement = await host.openView({
        type: 'example-report-view',
        state: { reportId: ref.data.reportId },
      });
      return placement === 'unavailable'
        ? { status: 'error', message: 'Could not open report' }
        : { status: 'ok' };
    },
  },
);

const reference = api.messageContent.formatReference({
  providerId: 'example.reports',
  id: 'report-q3',
  schemaVersion: 1,
  title: 'Quarterly report',
  data: { reportId: 'report-q3' },
});
// Return reference from a contributed tool and instruct the assistant to put
// it verbatim on its own line, outside a code block, in its reply.
// registration.dispose() on peer unload.
```

The canonical marker is `agent-content` immediately followed by the serialized
JSON object. Use the formatter instead of assembling the marker manually.
Registration and formatting do not send a message or start an agent turn.
A contributed tool can return the reference as text; the assistant chooses its
position in the reply. Both Claude and Codex use the same rendering path.

Presentations are a discriminated union:

| Kind | Content |
|---|---|
| `card` | Title, optional subtitle/icon, optional plain-text body and named actions |
| `image` | Title, image source and alt text, optional subtitle and named actions |
| `document` | Title and self-contained HTML, optional subtitle, bounded height and named actions |

Images accept supported raster data URLs and HTTPS sources; HTTPS images make
an ordinary browser request, so use inline raster data to avoid external loads.
Documents run in nested opaque-origin frames with scripts permitted, but remote
resources, navigation, host access, forms, popups and downloads blocked. Keep
CSS, JavaScript and raster assets within the supplied HTML. Documents have no
bridge to host APIs; expose host operations through named card actions.

Only assistant transcript content activates providers. User messages, code
examples and plan text cannot activate them. During streaming, references show
inert fallback cards; provider callbacks and document scripts begin after the
message settles. The relay mobile view retains readable fallback cards without
executing desktop providers or forwarding their actions.

The reference is persisted as ordinary message content. Its fallback title
remains visible if the provider is absent, removed or fails. References are
immutable; peers own any external assets and schema migrations. Data can be
archived or relayed with the conversation: use identifiers and non-secret values.

Provider callbacks are bounded and receive captured `threadId`, `messageId`
and an abort signal. Thread switching, rerendering, provider disposal and host
shutdown cancel pending work and revoke stale actions. Providers must honor
cancellation and validate reference data; cancellation cannot undo their own
side effects. `present` should resolve display data without performing mutations.
Invalid or duplicate registrations return structured failures; callback errors
degrade the affected card rather than the conversation.

## Security boundary

Trace projection and redaction are owned by Agent Threads. Consumers must still treat trace text as sensitive and apply their own policy before persistence. `constrainedRuns` returns only final text and sanitized usage; SDK events, environment variables, credentials, and session IDs are private.

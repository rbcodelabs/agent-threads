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

## Orchestrators

`orchestrators.list()` returns `OrchestratorSnapshot` entries, each with `enabled: boolean`. The portfolio orchestrator is always `enabled: true`. A Project orchestrator is `enabled: false` when the Project's orchestrator is switched off; a disabled Project is always listed. When it has no orchestrator thread (archiving the orchestrator disables it and clears the thread), the entry is `{ id: 'project:<id>', kind: 'project', projectId, threadId: '', title: '<project name> orchestrator', enabled: false }`: `threadId` is the empty string only for these thread-less disabled entries, so consumers should dispatch by `id`. An enabled Project with no orchestrator thread is absent from the list, which lets a peer tell "disabled" (listed, `enabled: false`) from "never created or creation failed" (absent while its Project exists). Deleted Projects are absent.

`orchestrators.dispatch(target, input)` sends a prompt to an orchestrator thread (created on demand for an enabled target). A target whose `enabled` is `false` fails with `ORCHESTRATOR_NOT_FOUND` before anything is created.

- `input.queueIfBusy?: boolean`. Omitted or `false`: a running target fails with `THREAD_BUSY` (unchanged). `true`: the prompt goes through the same `ThreadManager.sendMessage` path a user-typed message takes on a running thread (it joins the in-flight generation or the host queue; there is no second queue). A non-boolean value fails with `INVALID_ARGUMENT`.
- `runId` for a queued send: a normal run record is created and returned immediately, and `wait(runId)` resolves at the thread's next terminal event (`done`, `error` or `interrupted`). Because the host may coalesce the queued message into the generation already in flight, that terminal event can belong to the earlier turn; the run therefore means "settled at or after the thread's next turn boundary", not "this exact message has finished processing". All active run records of a thread settle on the same terminal event.

### Creating and toggling orchestrators

Orchestrator wake-up, heartbeat and the orchestrator skill are owned by the Threads Orchestrator plugin, not core. Core keeps the threads, ids (`settings.orchestratorThreadId`, `Project.orchestratorThreadId/orchestratorEnabled`), the badge, the "Needs you" inbox, decisions and the `threads_*` coordination tools. Threads work as a manual workspace without the plugin (no automatic wake-ups).

- `orchestrators.ensure(target)` (capability `orchestrators.ensure`): idempotently creates and designates the Portfolio (`{ id: 'portfolio' }`) or a Project (`{ id: 'project:<projectId>' }`) orchestrator thread and returns its `OrchestratorSnapshot`. A disabled Project is re-enabled (an explicit ensure is an opt-in). It does not open a chat view. A malformed target fails `INVALID_ARGUMENT`; an unknown Project fails `ORCHESTRATOR_NOT_FOUND`. `dispatch` still creates an enabled orchestrator on demand through the same path.
- `orchestrators.setEnabled(target, enabled)` (capability `orchestrators.setEnabled`): Project orchestrators only. `true` is `ensure`; `false` sets `orchestratorEnabled: false` without archiving or deleting the thread (the thread reference is kept). The Portfolio orchestrator cannot be disabled: `{ id: 'portfolio' }` fails `INVALID_ARGUMENT`, as does a non-boolean `enabled`. Unknown Project: `ORCHESTRATOR_NOT_FOUND`.

The former `orchestrators.delegateWakeup` / capability `orchestrators.wakeup.delegate` was removed: core no longer has a wake-up policy to delegate. Existing orchestrator heartbeat cron items created by older versions are deleted once at startup.

## Events for runs not started through the API

`run.completed` and `run.failed` are also published for turns that were not started by `threads.send` (for example a user typing in a thread). They carry a synthesized `runId` with no run record, so `wait(runId)` on it fails with `RUN_NOT_FOUND`; use the event itself. These events are published for every thread, including orchestrator threads: a wake-up sent to an orchestrator ends in a `run.completed` for that orchestrator, so a consumer that pings on completion must filter orchestrator threads (see `orchestrators.list`) or it can feed itself in a loop. `run.started` is not published for such turns. `message.completed` was already published for every assistant message; its `runId` is the thread's latest API run when one exists.

## Registering a skill

`extensions.registerSkill(owner: { pluginId: string }, spec: { name: string; description: string; content: string }): Disposable` (capability `extensions.registerSkill`). Core injects every registered skill into new sessions as a local SDK plugin (where it used to inject its bundled `thread-orchestrator` skill); core writes the `SKILL.md` frontmatter from `name`/`description`, `content` is the body. Limits: `name` matches `/^[a-z0-9][a-z0-9-]{0,63}$/`, `description` 1-1024 characters, `content` 1-100000 characters. Violations, a missing `owner.pluginId` and a name already registered by a different plugin throw `INVALID_ARGUMENT`. The same plugin re-registering a name replaces it. **Trust model.** The caller is a trusted same-process peer plugin, and `owner.pluginId` is self-asserted (not authenticated). A registered skill's text becomes instructions in every new session, and its `description` is visible in every skill list, so only register content you would put in a session prompt yourself. Reserved names (`vault`, `local`) and more than 16 registrations per plugin fail with `INVALID_ARGUMENT`. Dispose, or the API generation stopping (plugin unload), removes the skill; already-running sessions keep what they loaded.

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
- `ThreadArtifactRef.storageRoot` is optional and is the one deliberately non-opaque field: the host needs it to delete an artifact's files when the owning thread is deleted. It is resolved (through `..` and, where possible, symlinks) and must lie strictly inside `<vault>/.geode/artifacts/` or inside a namespace of the host's visible root, `<vault>/<root>/<namespace>/` (the allowlist, `src/artifactStorage.ts`; `<root>` is the configurable "Visible artifact folder" setting, default `Artifacts`). The hidden root, the bare visible root, a bare namespace folder, the vault root, relative paths and anything outside the tree are rejected, and a rejected root fails the whole `attach` rather than being silently dropped. `storageRoot` is host-owned thereafter: neither `updateArtifact()` nor provider data can rewrite it, only `artifacts.update` with a freshly validated value.
- Deleting a thread removes the storage of its artifacts, re-validating each root immediately beforehand. A missing or already-deleted directory is not an error. Detaching an artifact deliberately does *not* delete storage — that is removing a card, not deleting a user's work.
- Provider `data` must be a plain JSON-serializable object and is bounded (256 KiB serialized), because it is persisted inside the host's own settings file.
- `artifacts.allocateStorage(threadId, artifactId, options?)` creates that root and returns it, so allocation is a contract rather than a layout a peer has to reproduce from an undisclosed vault path. It reuses the same containment check `attach` and deletion use — not a second copy — and is idempotent: re-allocating an existing root returns it with `status: 'existing'` and clobbers nothing inside. It is ownerless, because allocation necessarily runs before the artifact (and therefore its provider binding) exists; it creates an empty directory and grants nothing. `artifactId` must be a single path segment, so a traversal attempt is rejected twice over.
- `options` (capability `artifacts.visibleStorage`; hosts without it ignore the argument and allocate hidden, so feature-detect): `{ location?: 'hidden' | 'visible'; folderName?: string; owner?: PeerIdentity }`. With no options or `location: 'hidden'` the behavior is unchanged: `<vault>/.geode/artifacts/<artifactId>`, and `folderName` is ignored. With `location: 'visible'` the host creates `<vault>/<root>/<namespace>/<folderName>` so the user can see and browse the files. `<root>` is one host-owned folder whose name is the "Visible artifact folder" setting (default `Artifacts`; sanitized to a single path segment, falling back to `Artifacts` when empty or invalid). `<namespace>` is `owner.pluginId`, so two plugins never share a folder; it is derived from `owner`, never passed separately. `owner` is required for `visible` (a missing, empty or unsafe `pluginId`, i.e. anything outside `[A-Za-z0-9][A-Za-z0-9._-]*`, longer than 80 characters or containing `..`, is rejected with `status: 'invalid'`) and ignored for `hidden`. **`owner` is self-declared**: like the `owner` on `attach`/`update`, it is advisory and not authenticated, because the API object is a shared singleton and the host cannot tell which plugin is calling. Per-plugin API handles are the future enforcement path. Tools contributed with `registerAgentTool` are different: `AgentToolHost.allocateStorage` injects the tool's registered owner and overwrites any `owner` the tool passes, so that path is host-derived. The host owns the name: path separators become spaces, `..` runs, control characters, leading dots and characters illegal on common filesystems are removed, whitespace is collapsed, the result is capped at 80 characters, and an empty result falls back to `artifactId`. If that directory exists and is not this artifact's own root, `-2`, `-3`… is appended. Re-allocating the same thread and `artifactId` returns the same path with `status: 'existing'` (the artifact's persisted `storageRoot` is honored after a restart) regardless of the `folderName` or `owner` passed the second time. A root allocated inside a provisional thread is released on rollback like a hidden one, and thread deletion removes visible roots through the same re-validated delete — never the visible root or a namespace folder itself. Changing the setting affects new allocations only: existing artifacts keep their stored `storageRoot`, which stays trusted (and garbage-collected) only while it lies under the current root or the default `Artifacts`. Artifacts under a root that is neither are left on disk untouched, which fails safe.

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

## Contributing help

`extensions.registerHelpProvider(owner, contribution)` adds reference documentation to the read-only `agent_threads_help` agent tool, so a session can search and read your plugin's guidance on demand. Nothing is injected into the prompt: content costs context only when an agent asks for it.

Check `api.capabilities.includes('extensions.registerHelpProvider')` first; an older host has no such member and calling it throws. `help.docRoots` is a second capability for the `docRoots` option.

```ts
if (api.capabilities.includes('extensions.registerHelpProvider')) {
  const registration = api.extensions.registerHelpProvider({ pluginId: 'example.boards' }, {
    providerId: 'example.boards',             // '<publisher>.<capability>', lowercase, at most 64 characters
    title: 'Boards',
    summary: 'How to build and automate boards.',
    docRoots: ['/path/to/vault/.geode/plugins/example.boards/docs'], // zero-code path: the host indexes the .md files
  });
  if (registration.success) this.register(() => registration.dispose());
}
```

- **Two ways to supply content, or both.** `docRoots` (absolute directories of Markdown) is indexed by the host and split on H2/H3 headings; or implement `search(query, signal)` and `get(docId, { offset, maxChars }, signal)` (plus optional `topics()`). With both, search hits are merged and `get` tries your callback first.
- **`docRoots` are restricted** to your own plugin directory (`<vault>/<config dir>/plugins/<pluginId>`) and the vault. The real path must lie inside; `/`, `/etc`, `..` and symlinks pointing out are refused with `status: 'invalid'`. Only plain, non-hidden `.md` files up to 2 MB are read, at most 2,000 per root; symlinked entries are skipped.
- **Ids and ownership.** A duplicate `providerId` is `status: 'conflict'` and the incumbent always wins; a stale `dispose()` cannot retract a later registration. `agent-threads.*` and `geode.*` ids are reserved for their publishers (`invalid` otherwise). Owner identity is self-declared, like the rest of the API.
- **Host-enforced limits.** Providers are never trusted: 20 hits per call, 240-character snippets, 200-character titles, 16,000-character `get` pages, 40,000 characters per response, 500 hits accepted per provider, 64 providers. Callbacks time out after 2 s (`search`) or 5 s (`get`) and receive an `AbortSignal`; a throw, timeout or malformed result marks only your provider unavailable for that call.
- **Ranking is the host's.** Your `score` (0..1) is only a provider-local hint; the host adds a title-match boost and interleaves providers round-robin so one cannot fill the page.
- **Content is untrusted reference text.** It reaches the model only as a tool result, framed with its source, and is never executed or fetched. Do not return content derived from user data (vault search, thread logs): the tool is on by default for remote daemon sessions too.
- **Lifetime.** Registrations are dropped on `dispose()`, on peer unload and on host `stop()`. Unlike agent tools, providers are resolved on every call, so a provider added or removed mid-session is visible to the next `agent_threads_help` call.

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

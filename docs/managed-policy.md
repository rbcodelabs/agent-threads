# Managed policy (enterprise controls)

For administrators who deploy Geode with a managed policy file. This page says what Agent Threads enforces from the
`threadExecution` area, how, and what it cannot enforce. The policy file format, location and layering are documented in
Geode (`docs/design/enterprise-controls.md`); this page covers the plugin side only.

Agent Threads reads the already-validated, already-layered policy from Geode (`window.geode.getEffectivePolicy()`).
It never reads the policy file itself.

## Principles

- **Fail open.** No policy file, an Obsidian host, an older Geode, a host call that throws, or a reply in an unexpected
  shape all mean "no restriction". A console warning is written for the throwing and unexpected-shape cases.
- **Evaluated at use, not at startup.** Every thread start, resume, move and harness switch asks the host again. A
  last-seen snapshot exists only for advisory UI (dimmed menu items, notes) and is never used to authorize anything on
  its own. Settings in the plugin's `data.json` are user-writable and are never consulted to decide policy.
- **A gate, not a mutation.** Policy never deletes a thread, daemon, container, paired device or setting. Relaxing the
  policy restores the previous behavior with no user action.
- **Running threads are not killed.** A thread that is already running keeps running; its next send (or the next
  resume after a restart) is refused.

## What is enforced

A thread may start only if the target is enabled, its harness is in the global `harnesses` list, and its harness is in
the target's own `harnesses` list. An absent list or flag is no restriction. An empty list, or one holding only the
`!none` sentinel, allows nothing. Harness ids this plugin does not know are ignored.

| Policy field | Enforcement |
|---|---|
| `machine`, `localDaemon`, `remoteDaemon` `.enabled` / `.harnesses`, global `harnesses` | Refused in `ThreadManager.sendMessage` before anything else (so before the daemon is started, secrets are pushed, MCP or skills are synced); at `createHarnessSession` (a last-resort synchronous guard fed by the snapshot read in the same call); on re-attach after restart; in `dispatchNewThread`, `createRemoteThread`, `switchHarness` and `moveThreadExecution`; for public-API, agent-created, mobile-created and scheduled threads. |
| `remoteDaemon.hosts` | Exact `scheme://host:port` match (see below) for registering, testing, connecting to, pushing secrets to, syncing skills or MCP servers to, and starting threads on a remote daemon. |
| `hostExec.enabled` | `host_exec` is removed from the manifest offered to a daemon, the handler is not built for new sessions, and a `tool.call` that arrives anyway is refused in the executor before any approval card. |
| `hostExec.allowAlways` | The per-call approval stays; the "Always allow" option is removed in the thread view, dashboard and board, and saved command prefixes are ignored (kept in settings). |
| `mobileRemoteAccess` | The desktop relay connection is not opened (and an open one is closed within 15 s of a live change); a command from a phone is checked when it arrives. Pairing state in `remoteAccess` is untouched and resumes when relaxed. |

Where a thread runs is decided from its target: no `remote` field means this computer; the managed container daemon
(fixed id, `managed: 'local-container'`, loopback address) is the local daemon; every other daemon is a remote daemon.
A settings edit cannot make a remote host count as the local daemon.

### Remote host matching

`remoteDaemon.hosts` entries and the daemon URL are compared as exact origins: scheme, host and port. The host is
case-insensitive; a default port is implied (`wss://h` equals `wss://h:443`); `ws` and `wss` differ; a trailing dot on
the host does not match; a URL carrying user info (`wss://user@host`, `wss://allowed@evil`) never matches. `http(s)` is
mapped to `ws(s)` exactly as the connection code does. An entry that does not parse matches nothing, and an empty list
allows no host.

### Scheduled items

A scheduled item always starts a local thread with the default harness. If the policy forbids the machine target or
that harness, the cycle records an error run on the item with the policy's reason (visible in the item's run history)
and the scheduler carries on; the item resumes by itself when the policy is relaxed.

### Local daemon lifecycle

Set up, start, restart, update, reset and sign-in of the local daemon are refused when the local-daemon target is not
usable (disabled, or no harness left), and "ensure running" does not attach to an existing container. Stop, kill and
remove remain available. An existing container is left exactly as it is.

### What users see

- New-conversation composer: harnesses and "Run on" targets the policy removed are disabled and marked "managed by your
  administrator". When nothing at all may run, a note says "Claude Threads is disabled by your administrator." and
  sending refuses with the same words (existing threads show it as a send error).
- Right-click menu: the harness switch and "Run on" entries follow the same rules.
- Settings: default harness options, the Remote tab (daemons, Add daemon, remote access toggle), the Local daemon block
  (buttons disabled with a note) and the saved host-command prefixes (note when they are ignored).

## What is not enforced (read this before relying on it)

- **Plugin code is not a security boundary.** Agent Threads runs with full Node access in the renderer. A user who can
  install or modify plugin code can bypass every check on this page. This control is meaningful together with the Geode
  `plugins` allowlist that pins this plugin (and ideally its version).
- **`host_exec` has no daemon-side enforcement.** It is enforced in this plugin only. A daemon cannot be made to refuse
  it, and a daemon that is not driven by this plugin is out of scope.
- **`data.json` is user-writable**, which is why policy is re-read at use rather than copied into settings. It still
  means a user can repoint a daemon entry (for example, make a loopback address forward to a remote machine); the
  local-daemon classification requires the fixed id, the managed marker and a loopback address, but cannot see where a
  forwarded port leads.
- **Non-thread `claude` subprocesses on this computer.** These are not threads and are handled as follows:

  | Process | Policy |
  |---|---|
  | In-process summarizer (titles, summaries) | Refused when `machine` forbids the Claude harness (it runs a `claude` turn here). Cosmetic: titles and summaries simply stay as they were. |
  | Constrained runs for peer plugins (`constrainedRuns`) | Same rule, same reason. |
  | Version probes, `claude` sign-in CLI, auth recovery | **Not gated.** They do not run an agent turn. |
  | Marketplace and skills tooling | Out of scope for this area. |

  The conservative choice was made for the two that run a turn: disabling `machine` means no agent execution on the
  host.
- **Threads that are created but never sent.** The thread record is local metadata. Private chat, Chief of Staff and
  orchestrator creation do not check policy at creation (they are refused at the first send); the creation paths a user
  or peer can reach (composer, public API, mobile `create_thread`, scheduler, agent tool) do.
- **The pairing relay service** (the worker that relays between desktop and phone) is out of scope.
- **`github.deliverToRemoteDaemon`.** This plugin has no remote-daemon GitHub delivery; the field is not read by
  anything that sends a token. `githubDeliveryToRemoteDaemonAllowed()` in `src/managedPolicy.ts` is the one helper any
  future code must consult first; a test pins that nothing under `src/remote/` touches the GitHub token path.
- **A policy change is noticed on the next use**, or within about 30 seconds for advisory UI and background work.

## Code map

| File | Role |
|---|---|
| `src/managedPolicy.ts` | Pure evaluator, host matching, bridge (`resolvePolicyBridge`) and the live reader (`ManagedPolicyService`). In the daemon core closure, so it imports nothing but `types.ts`. |
| `src/HarnessFactory.ts` | `createHarnessSession` last-resort guard. |
| `src/ThreadManager.ts` | `sendMessage`, `resumeRemoteTurns`, `switchHarness`, `moveThreadExecution`, `createRemoteThread`, `checkLaunch`. |
| `src/main.ts` | Wiring: `managedPolicy` service, `dispatchNewThread`, relay, scheduler, daemon registry and sync services. |
| `src/remote/hostTools.ts`, `hostToolExecutor.ts` | `host_exec` manifest and call gate. |
| `src/RelayClient.ts` | `mobileRemoteAccess`. |
| `src/localDaemon/controller.ts` | Local daemon operations. |

Tests: `test/unit/managed-policy*.test.ts`.

# Sandbox VMs

`enter_vm`, `vm_exec`, and `exit_vm` give a thread a disposable Linux environment
on macOS 26 or later with Apple silicon. Both Claude and Codex can use these tools.
They require Apple's `container` runtime; they are unavailable on mobile.

## Setup (one click)

Open **Settings → Claude → Sandbox setup** and press **Set up sandbox**. Agent Threads then:

1. installs Apple's `container` runtime (a pinned, SHA-256-verified copy of the signed installer, unpacked without admin rights into `~/Library/Application Support/claude-threads/runtime` — outside the vault, and only used when no system copy exists);
2. starts the runtime's service (the first start downloads a Linux kernel, about 29 MB);
3. pulls the published base image and builds the local Claude layer.

A confirmation states what will be downloaded before anything starts (the runtime installer is about 118 MB, the base image several hundred MB), progress is shown live, and **Cancel** stops it. Every step is skipped when already satisfied, so it is safe to run twice. The button reads **Set up sandbox**, **Finish setup** or **Update sandbox** depending on what is left. It is hidden on unsupported Macs (the reason is shown instead) and on mobile.

**Updating the image.** The published base image carries a version label (`sandbox/IMAGE_VERSION`, currently 2). An image is treated as **out of date** when either (a) it carries an older version label (for example version 1, which predates the GitHub CLI `gh`), or (b) regardless of any label, running it shows it lacks a required tool: `gh` and `git` in `claude-threads-coding:1`, plus `claude` in the harness image. Check (b) is what catches a `claude-threads-coding:1` built locally from an old Dockerfile (no label) and a harness image rebuilt on top of it (which carries a current-looking label but still has no `gh`). An unlabeled image that has every tool is treated as your own build and is kept. When an image is out of date, Settings → Claude → Sandbox setup shows **Update available**, an **Image version** line (for example `Image unlabeled → v2 available (missing gh)`), and an **Update sandbox** button that pulls the current base over it and rebuilds the Claude layer. The check runs whenever that settings block renders. When a thread starts in a VM whose image is out of date, a notice in the transcript (or a note on the `enter_vm` result) names the problem and points at the button; the VM still starts. After an update, the result is re-probed and a clear error is raised if a tool is still missing. A probe that cannot run (runtime hiccup) is treated as unknown, never as out of date, so a flaky check cannot trigger a re-download.

**Reset sandbox.** Once the runtime is installed, **Reset sandbox** sits next to the setup button. After a confirmation it removes the local base and harness images (the harness tag from Settings → Tools) and runs setup again, so both are pulled and rebuilt from scratch. Stop running sandbox VMs first: an image in use cannot be removed, and the reset then stops with a message naming the image instead of rebuilding on a half-removed state. A reset also discards a hand-built `claude-threads-coding:1`.

When a Claude thread starts on the host because the sandbox is not set up, a one-time card in that thread offers the same setup (`Set up sandbox` / `Not now` / `Don't ask again`). The thread keeps running on your Mac meanwhile; a finished setup applies from its next fresh session start.

### Manual fallback (advanced)

If you prefer to manage the runtime yourself, or the automatic setup cannot run:

```sh
brew install container
container system start
container build --tag claude-threads-coding:1 sandbox/
```

A system copy of the runtime (Homebrew or Apple's installer) always takes precedence over the managed one.

The image includes Node 22, npm, Git, the GitHub CLI (`gh`, in images built from the current
`sandbox/Dockerfile`), ripgrep, jq, curl, Python, and native build tools. It runs as the
non-root `node` user. Project dependencies are installed
per workspace; the image does not include every project's dependency cache.
Custom images must provide Bash, GNU `timeout`, and `sleep infinity`.

Create a disposable Git worktree, call `enter_vm`, then use `vm_exec` for installs,
tests, and builds. The effective working directory is mounted read-write at
`/work`. An explicit absolute `mountPath` can select another existing directory;
paths containing colons are rejected because the runtime treats them as volume
delimiters. Mount only the directory intended for the task.

The tools do not move the agent itself into the VM. Normal file tools and shell
tools still run on the host. Only commands sent through `vm_exec` run in Linux.
Guest commands can modify or delete files in the mounted directory, and those
changes persist after `exit_vm`. Do not put secrets in that directory. Besides
the selected workspace, the **vault is always mounted read-write at `/vault`**
(fixed guest path, regardless of the thread's working directory), so guest
commands, and anything running in the harness container, can read, modify, and
delete any note in your vault. This is intentional, so agents working in a
disposable worktree can still edit notes, but it means a VM is not a boundary
protecting the vault; keep vault backups or sync history. If the thread's
working directory is the vault itself, it is mounted twice (`/work` and
`/vault`). The mount is skipped silently when the host exposes no vault
filesystem path. A harness-owned container created before this mount existed is
preserved to keep its native conversation history; new thread containers include
the mount. For an agent-owned `enter_vm`, call `exit_vm` and enter again. If the
working directory is your home, that directory becomes the `/work` mount; select
a disposable worktree first. The SSH agent and host credentials are not automatically
forwarded, but files inside the mount are exposed. The one exception is Geode's
GitHub connection: when enabled, `git` (HTTPS) and `gh` inside the VM are
authenticated through a short-lived private file that is never under `/work`
(see [GitHub via Geode](github-integration.md)).
A Git worktree's `.git` file can point outside the mount, so guest Git commands
may fail; use host Git tools or a standalone checkout when guest Git is needed.
Avoid sharing host `node_modules` with Linux; native dependencies differ.

Choose networking on each `enter_vm` call or under Settings → Agent:

| Mode | Access |
| --- | --- |
| `default` | Full internet and host-network access; the default for dependency installs. |
| `internal` | No internet routing; the host gateway and peers on the shared internal network remain reachable. |
| `none` | No network attachment. Preinstall dependencies before using this mode. |

The internal network's runtime configuration is verified before use. An existing
network with the same name but a different mode is rejected. Network restrictions
apply to guest traffic, not host tools or runtime image pulls.

### Memory and CPUs

Each container gets a 4G memory ceiling and 4 CPUs by default (Apple's 1 GiB
default OOM-kills `pnpm`/`tsc`/tests). Change them under Settings → Agent →
**Sandbox VM memory** (`<digits>M|G`, e.g. `8G`) and **Sandbox VM CPUs**
(whole number, 1–64). Invalid values fall back to the defaults. They apply only
to newly created containers: remove an existing one to pick up a change with
`container rm --force claude-threads-vm-<thread-id>`; it is recreated on next use.
Removing a harness container also discards its native Claude history. If that
history is missing, the thread can recover with a fresh session and recent saved
conversation context; this does not recreate the complete native transcript.

`vm_exec` returns the command exit code and bounded stdout/stderr. A nonzero exit
is a normal tool result. The default deadline is 300 seconds (1–3600 accepted);
GNU `timeout` sends TERM inside the guest, then KILL after five seconds. A timeout
normally returns 124, or 137 when escalation is necessary. This is a command
deadline, not a security boundary against deliberately detached processes.

Call `exit_vm` when finished. It removes the VM's ephemeral filesystem and leaves
the mounted host files intact. Detached VMs survive plugin reloads; the same
thread can reconnect with `vm_exec` or remove its VM with `exit_vm`. Deleting or
archiving a thread removes its container automatically, so `exit_vm` first is
optional. As a safety net for containers leaked by older versions or by a reload
that interrupted a delete, the plugin also runs a one-time sweep about a minute
after startup (desktop only, best-effort). It removes only `claude-threads-vm-*`
containers whose thread no longer exists, and leaves anything it cannot match
alone. Changing working directory does not change an existing mount: exit and
enter again to switch workspaces.

### Opening a server running in the VM from the host browser

The browser tools (`browser_navigate`, `host_open_url` / `obsidian_open_url`)
run on your Mac, so `http://localhost:8000/` there is the Mac — not the VM where
the agent just started `python3 -m http.server 8000`. For a thread that has a
sandbox container, those tools therefore **forward the port automatically**:

1. A loopback URL (`localhost`, `127.x.x.x`, `[::1]`, `0.0.0.0`, `*.localhost`) is
   checked against the thread's container (`container exec … node` connect probe).
2. If something listens on that port inside the VM, a listener is opened on an
   **ephemeral port of the Mac's 127.0.0.1 only** (never other interfaces), and
   each connection is relayed through one `container exec --interactive` running
   a tiny Node relay in the guest. The tool opens the rewritten URL
   (`http://127.0.0.1:<port>/…`) and reports `requestedUrl` and a `note`.
3. If nothing listens in the VM but the Mac itself has a server on that port, the
   URL is opened unchanged (host server intended).
4. If neither side listens, the tool fails with an actionable error instead of a
   browser `ERR_CONNECTION_REFUSED`: start the server first, and run it in the
   background (`nohup … &`) because `vm_exec` returns when its command ends.

Works for servers bound to `127.0.0.1`, `0.0.0.0`, or `::1` in the guest. (The
VM's own IP, shown by `container ls`, only reaches `0.0.0.0` binds, and
`container run --publish` is fixed at creation and has the same limit, which is
why a relay is used.) Threads without a sandbox container, and non-loopback URLs,
are untouched. Listeners are closed when the VM is removed or the thread is
deleted. Limits: the page's origin is the forwarded port, so absolute links that
name the original port will not resolve (use relative links); the relay needs
`node` in the image (both bundled images have it); it is a plain TCP relay (WebSockets and
HTTPS are not specially handled and were not exercised in testing).

For an opt-in live check on a supported Mac, build the image, then run:

```sh
node scripts/smoke-sandbox-vm.mjs
```

The smoke script uses disposable fixtures and exercises the real runtime. Unit
tests mock the runtime; screenshot tests cover settings, not live VM execution.

## Running the Claude harness inside the VM (ADR-0015)

By default, using Agent Threads requires the `claude` CLI installed on the
host. Per ADR-0015, the plugin can instead run a thread's Claude harness
process **inside its sandbox container** — so a supported Mac only needs
Apple's `container` runtime, not a host `claude` install. This is **Claude
only** for now; Codex and OpenCode still spawn on the host regardless of this
setting (OpenCode in particular has an unresolved MCP-loopback-bridge gap —
see the ADR).

**Set up sandbox** (above) builds the second, separate image for you. Manual fallback:

```sh
container build --tag claude-threads-harness:1 -f sandbox/Dockerfile.harness sandbox/
```

This image is deliberately a different tag from `claude-threads-coding:1` — it
adds the native Claude Code CLI (`curl -fsSL https://claude.ai/install.sh | bash`)
on top of the same base. Having it is the entire opt-in step: **shipping
this feature changes nothing for any existing user until the image exists**
(via **Set up sandbox** or a manual build), because `harnessVmMode: 'auto'`'s
capability check includes "does this image exist," which is false until then.

Configure under Settings → Tools, next to the sandbox VM image/network
controls:

| Setting | Behavior |
| --- | --- |
| `harnessVmMode: 'auto'` (default) | Routes into the VM only when the platform supports it (macOS on Apple silicon), the container CLI probes successfully, and the harness image exists. Silently falls back to host-local spawn if any of those fail. |
| `harnessVmMode: 'always'` | Forces VM routing. Surfaces a clear error — never a silent host fallback — if any prerequisite is missing. Useful for testing, or when you want the isolation guarantee enforced. |
| `harnessVmMode: 'never'` | Exactly today's host-local spawn. The rollback lever. |

**Per-thread override.** In a Claude thread, the chat's menu (Harness) has a **Run in** section: *Container* (`always`), *Host (no container)* (`never`), or *Default (follows settings)*. The choice is saved on the thread and applies from the next turn. Switching between container and host resets the native Claude session (it cannot be resumed across the two environments); the conversation continues from a summary and transcript references, like a harness switch. It is unavailable while a turn is running or other work is pending.
| Harness VM image | The image tag to route into. Blank falls back to `claude-threads-harness:1`. |

Settings shows a live status block next to these controls (runtime, service,
image), so "why isn't this using the VM" is self-diagnosing. Internally a host
fallback carries a machine-readable reason (`unsupported`, `runtime-missing`,
`runtime-stopped`, `image-missing`, `start-failed`, `never`); only the three
setup-fixable ones (`runtime-missing`, `runtime-stopped`, `image-missing`) in
`auto` mode trigger the in-thread offer, at most once per thread per app session.

**One container per thread, shared.** A VM-routed thread's harness process and
its `vm_exec` tool use the *same* container — the
harness is just another thing `container exec` runs inside it. This means a
`vm_exec` command now runs alongside a process holding live Anthropic
credentials in its environment; those credentials are passed via `--env` flags
scoped to the harness's own `container exec` invocation only, never to
`container run`, so an ordinary `vm_exec ; env` does not print them — but be
aware the boundary is narrower than an agent-only sandbox. VM-routed sessions
omit `enter_vm` and `exit_vm` from both MCP surfaces and their tool aliases:
the harness already runs inside the container, and its native shell and file
tools use the guest filesystem. Host-local sessions, including automatic
fallbacks, retain all three tools. The underlying lifecycle guard still refuses to
remove a container the harness is still attached to; it is torn down
automatically when the thread is deleted or archived, not at ordinary session
close (so a lingering or quickly-restarted session doesn't pay container-start
latency every turn).
If the container is found stopped (for example after a Mac reboot), it is
started again rather than recreated.

A mode change or a freshly-built image takes effect on a thread's *next* fresh
session start (harness switch, restart, or new thread) — never mid-session.

### Skills in a VM-routed Claude session

Skill plugins are host directories, and the containerized CLI only sees the
thread folder at `/work`. So when a session is VM-routed the plugin bind-mounts
the skill directories into the container **read-only** and rewrites the
session's plugin paths to the guest paths (`src/skillMounts.ts`; a host-local
session is untouched):

| Host | Guest |
| --- | --- |
| each skill plugin root (configured sources, vault skills, bundled skills) | `/skills/<name>-<hash of real path>` (deterministic, so a resumed session sees the same paths) |
| `~/.claude/skills` | `/home/node/.claude/skills` (the CLI reads this from `$HOME`) |
| `~/.claude/agents` | `/home/node/.claude/agents` |
| symlink targets that point outside a mounted skills root (e.g. `~/.claude/skills/x -> ../../.agents/skills/x`) | where the link resolves inside the guest, limited to `/skills`, `/home/node` and the host home path |

Paths are resolved with `realpath` before mounting, deduped, and skipped when
missing or when they contain `:`. Mounts are `--volume host:guest:ro`; the
plugin never writes into `~/.claude`. Because `vm_exec` shares the container,
**the agent can read these mounts** (skills may contain instructions or
scripts you consider private).

Mounts are fixed when `container run` executes, so the container records its
mount set in a label (`claude-threads.mounts`, plus `claude-threads.origin`).
When a fresh session finds an existing container:

- Mount set matches: reused.
- Mount set differs: the container is **kept**, including after a plugin
  reload. Claude stores its native conversation history inside the guest;
  recreating the container would discard that history and break session resume.
  Plugins whose guest path is not mounted are dropped from that session instead
  of pointing at nothing. Newly added mount paths are available in new thread
  containers; a plugin reload preserves existing containers and their history.

### MCP servers in a VM-routed Claude session

Agent Threads' OAuth MCP registrations and Google Workspace MCP services remain
host-owned: their refresh tokens, access tokens, and per-thread capability
credentials never enter the VM. When Claude is actually routed into a VM, the
plugin relays these brokers through the Agent SDK's in-process MCP channel. An
automatic fallback to host-local Claude keeps using their ordinary loopback HTTP
endpoints.

The relay exposes the brokers' tool surface only (including pagination, rich
tool results, progress, cancellation, and tool-list changes). It does not claim
prompt, resource, sampling, or elicitation capabilities. Other MCP servers are
unchanged: built-in SDK servers stay in process, remote HTTP/SSE servers use the
VM's network, and stdio servers run inside Linux with `/work` as the workspace.
Consequently `network: none` still permits the host-owned SDK-relayed brokers but
does not give the guest a general path to the host network.

### Signing in to Claude inside the container

A VM-routed thread's `claude` process runs in an environment deliberately
built WITHOUT the host's environment (see "Secret scoping" above) — so the
host's own `claude auth login` keychain entry never reaches it, no matter how
many times you sign in on the host. The point of this ADR is to not require a
host `claude` install at all, so sign-in has to happen **inside the
container** too.

`claude setup-token` (run as `container exec -i -t <container> claude
setup-token`) is the CLI's own answer for exactly this shape of environment —
container, SSH, WSL2, anywhere a browser can't redirect back to a local
callback port. It prints a URL to open in your own browser; after you
authorize there, the browser shows a **login code** instead of redirecting
anywhere, and that code has to be typed back into the CLI to finish. That
interactive prompt renders nothing at all without a real pseudo-terminal on
the CLI's own end. Rather than a native pty module — this plugin's release
workflow only ships `dist/main.js`/`styles.css`/`manifest.json`/`versions.json`,
never `node_modules/`, so a compiled native binary could never reach a real
install — this flow shells out to `/usr/bin/expect`'s `spawn ...; interact`,
which allocates the pty the container's CLI needs and relays its I/O back out
through completely ordinary stdin/stdout pipes on the Node side. `expect`
ships standard on every macOS install, which this whole feature already
requires. See `src/claudeContainerAuthCli.ts` for the implementation.

When a VM-routed thread's session hits an expired/missing sign-in, the
in-thread "Sign in to Claude" card uses this container flow instead of the
host `claude auth login` flow. The choice is made when you click the button
(not when the card is drawn), from the thread's real routing — the card is
rebuilt from saved state after a plugin reload, before any session has
started, and picking the host flow there could never authenticate a container
session. The card opens the printed URL for you, then shows a "paste the login
code" field; submitting the code finishes the sign-in inside the container.

The resulting long-lived token is kept in the plugin's secret storage as its
**own credential**, not as a general `CLAUDE_CODE_OAUTH_TOKEN` secret. A
general secret is injected into every session, including host-spawned ones, and
an environment `CLAUDE_CODE_OAUTH_TOKEN` overrides the host keychain login —
so a container-only token there would break every host thread the moment it
expired. Instead it is passed via `--env` only to VM-routed sessions, and only
on their own `container exec` (never `container run`, so a `vm_exec` call
cannot read it from the container's environment). It is global rather than
per-project — it is your own Claude login — so one sign-in covers every
container-routed thread and survives containers being recreated.

Two implementation details worth knowing, both learned the hard way from live
runs: the CLI renders its prompt in a terminal whose size must be set on the
wrapper's own pty (an `stty` run inside the container is reset to 0×0 by
`container exec`, and at 80 columns the CLI wraps the ~108-character token
across two lines), and a long code must be sent as text followed by a
*separate* Enter (sent together, the terminal treats the burst as a paste and
swallows the Enter).

## Host commands from a sandboxed thread (`host_exec`)

A thread whose Claude harness runs inside the container (ADR-0015) cannot touch
anything outside `/work`. When a task genuinely needs the real machine (a
host-only tool, a file outside the mounted workspace), the agent can call
`host_exec({ command, cwd?, reason, timeoutSeconds? })` to run **one** command
on the host.

- **Exposure.** The tool is registered only on a desktop session that is
  actually VM-routed. Host-spawned threads (including a thread that fell back
  to a host spawn), Codex/OpenCode threads and mobile never see it.
- **Approval, every time.** Each call shows the standard inline permission card in the
  thread (desktop and mobile) with the command as the headline and the
  directory, reason and timeout under Details, with **Allow once** and
  **Deny**. There is no pop-up dialog. The card never offers "Always allow", and a
  previously saved always-allow entry for `host_exec` is ignored. This gate is
  separate from the harness permission path, so `bypassPermissions`, `dontAsk` and auto-approve do not
  skip it, the same as `mcp_register_server`. There is no "always allow" and no
  allowlist. Scheduled or otherwise non-interactive threads cannot prompt, so
  the call is denied with an explanatory result and nothing runs.
- **Execution.** `/bin/sh -c <command>` on the host, in `cwd` (an existing
  absolute directory; defaults to the thread's current directory). The
  environment is an allowlist (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`,
  `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `TMPDIR`): harness credentials and
  Anthropic tokens are never passed. Each of stdout and stderr is truncated at
  64 KiB with an explicit marker. The default deadline is 300s (max 3600s):
  SIGTERM, then SIGKILL after five seconds. A non-zero exit is a normal result.
- **Transcript.** The call and its result (including `decision`, exit code and
  output, or the denial) appear as an ordinary tool call in the thread.

The command runs with your account's permissions, so read the card before
allowing it.

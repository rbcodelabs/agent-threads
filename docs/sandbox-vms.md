# Sandbox VMs

`enter_vm`, `vm_exec`, and `exit_vm` give a thread a disposable Linux environment
on macOS 26 or later with Apple silicon. Both Claude and Codex can use these tools.
They require Apple's `container` runtime; they are unavailable on mobile.

Install and start the runtime, then build the coding image from this repository:

```sh
brew install container
container system start
container build --tag claude-threads-coding:1 sandbox/
```

The image includes Node 22, npm, Git, ripgrep, jq, curl, Python, and native build
tools. It runs as the non-root `node` user. Project dependencies are installed
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
changes persist after `exit_vm`. Do not put secrets in that directory. No host
directories are mounted beyond the selected workspace. If the thread's working
directory is your vault or home, that directory becomes the mount; select a
disposable worktree first. The SSH agent and host credentials are not automatically
forwarded, but files inside the mount are exposed.
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

`vm_exec` returns the command exit code and bounded stdout/stderr. A nonzero exit
is a normal tool result. The default deadline is 300 seconds (1–3600 accepted);
GNU `timeout` sends TERM inside the guest, then KILL after five seconds. A timeout
normally returns 124, or 137 when escalation is necessary. This is a command
deadline, not a security boundary against deliberately detached processes.

Call `exit_vm` when finished. It removes the VM's ephemeral filesystem and leaves
the mounted host files intact. Detached VMs survive plugin reloads; the same
thread can reconnect with `vm_exec` or remove its VM with `exit_vm`. Cleanup is
explicit, so call `exit_vm` before deleting the thread. Changing working directory
does not change an existing mount: exit and enter again to switch workspaces.

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

Opt in by building a second, separate image:

```sh
container build --tag claude-threads-harness:1 -f sandbox/Dockerfile.harness sandbox/
```

This image is deliberately a different tag from `claude-threads-coding:1` — it
adds the native Claude Code CLI (`curl -fsSL https://claude.ai/install.sh | bash`)
on top of the same base. Building it is the entire opt-in step: **shipping
this feature changes nothing for any existing user until they build this
image**, because `harnessVmMode: 'auto'`'s capability check includes "does
this image exist," which is false until you build it.

Configure under Settings → Tools, next to the sandbox VM image/network
controls:

| Setting | Behavior |
| --- | --- |
| `harnessVmMode: 'auto'` (default) | Routes into the VM only when the platform supports it (macOS on Apple silicon), the container CLI probes successfully, and the harness image exists. Silently falls back to host-local spawn if any of those fail. |
| `harnessVmMode: 'always'` | Forces VM routing. Surfaces a clear error — never a silent host fallback — if any prerequisite is missing. Useful for testing, or when you want the isolation guarantee enforced. |
| `harnessVmMode: 'never'` | Exactly today's host-local spawn. The rollback lever. |
| Harness VM image | The image tag to route into. Blank falls back to `claude-threads-harness:1`. |

Settings shows a live readiness check next to these controls (CLI probe +
image existence), so "why isn't this using the VM" is self-diagnosing.

**One container per thread, shared.** A VM-routed thread's harness process and
its `enter_vm`/`vm_exec`/`exit_vm` tools use the *same* container — the
harness is just another thing `container exec` runs inside it. This means a
`vm_exec` command now runs alongside a process holding live Anthropic
credentials in its environment; those credentials are passed via `--env` flags
scoped to the harness's own `container exec` invocation only, never to
`container run`, so an ordinary `vm_exec ; env` does not print them — but be
aware the boundary is narrower than an agent-only sandbox. `exit_vm` refuses to
remove a container the harness is still attached to; it is torn down
automatically when the thread is deleted or archived, not at ordinary session
close (so a lingering or quickly-restarted session doesn't pay container-start
latency every turn).

A mode change or a freshly-built image takes effect on a thread's *next* fresh
session start (harness switch, restart, or new thread) — never mid-session.

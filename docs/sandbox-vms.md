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
changes persist after `exit_vm`. Do not put secrets in that directory. The tools
do not mount the vault, home directory, SSH agent, or credentials automatically.
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

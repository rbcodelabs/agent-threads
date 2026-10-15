# Remote daemon: run threads on another machine

A thread can run on an `agent-threads` daemon on another machine (a homelab box, a VM) and stream into
Geode. The turn keeps running there when Geode quits; reopening Geode re-attaches and the transcript
completes. This is stage 1 of the daemon design: Geode still owns the transcript, the daemon owns the
process and a replay journal.

What a remote thread has today: the **daemon machine's own tools** (shell, file read/write, search) and
its own `claude` login. It does not have the vault/editor tools, your MCP servers, skills, or keychain
secrets (those arrive in later PRs). Claude only. A message sent while a turn is running is held by the
plugin and sent when the turn ends.

## ws:// vs wss:// from Geode (spike findings)

Measured with the real Geode renderer (v0.27.1, headless, throwaway profile) against a throwaway daemon on a
Linux box reached over Tailscale:

| Transport | Renderer global `WebSocket` | Node `ws` module in the renderer |
|---|---|---|
| `ws://<tailscale-ip>:<port>` (raw tailnet TCP) | **blocked** | connects, `welcome` received |
| `ws://<machine-name>:<port>` (MagicDNS short name) | **blocked** | connects |
| `wss://<machine>.<tailnet>.ts.net:8443` (`tailscale serve`) | **blocked** | connects |

Why: the renderer ships `Content-Security-Policy: default-src 'self'; ...` with no `connect-src`, so
`connect-src` falls back to `'self'` and the console reports `Connecting to 'wss://...' violates the
following Content Security Policy directive: "default-src 'self'"`. It is the CSP, not mixed content:
`wss://` is blocked too. Consequence: **the plugin does not use the global `WebSocket` on desktop.** It uses
the bundled Node `ws` package (`src/remote/pluginWebSocket.ts`), which Geode's nodeIntegration renderer
allows, which is not subject to the page CSP, and which sends no `Origin` header, so the daemon's
`--allow-origin` list is irrelevant to it. Both `ws://` and `wss://` work. (The global `WebSocket` is only
used where there is no Node, i.e. mobile.)

Also worth knowing: a machine whose `tailscaled` runs with `--tun=userspace-networking` has **no tailnet
interface**. A daemon cannot bind the Tailscale IP (`EADDRNOTAVAIL`); inbound tailnet traffic only reaches it
through `tailscale serve`. So: run the daemon on `127.0.0.1` and publish it with `tailscale serve` (needs
`sudo` unless `tailscale set --operator=$USER` was run). If you already serve something on HTTPS port 443,
use another HTTPS port (8443) rather than touching it.

Recommended: `wss://<machine>.<tailnet>.ts.net:8443` (TLS from Tailscale). Fallback: `ws://<machine>:7598`
via `tailscale serve --tcp` (plain, but inside the WireGuard tunnel).

## Install on the daemon machine

Build from a checkout of this repository, at the release or commit you intend to run (the daemon and the plugin
must come from the same version, because the daemon refuses a plugin older than its `minClientVersion`):

```bash
git clone https://github.com/rbcodelabs/agent-threads.git
cd agent-threads
git checkout <release tag or commit>
npm ci
npm run build:daemon          # -> dist/agent-threads.cjs (one file, plain node)
npm run build                 # -> dist/main.js, manifest.json, styles.css (the plugin)
scp dist/agent-threads.cjs my-server:~/agent-threads/agent-threads.cjs
```

On the daemon machine (needs Node 22+ and a logged-in `claude`):

```bash
mkdir -p ~/agent-threads/data && cd ~/agent-threads
# a control-scope token for Geode (read < control < admin); shown once, only its hash is stored.
# `control` is all Geode needs. Keep `admin` for operator tooling: it adds nothing Geode uses.
node agent-threads.cjs token create --name geode --scope control --data-dir ~/agent-threads/data

# Run the daemon in the foreground to try it. For a service that survives reboots, use the systemd
# or Docker setups below ("Install as a service").
# --workspace: folders sessions may run in. Add your vault folder if you want threads there.
node agent-threads.cjs serve \
  --data-dir ~/agent-threads/data \
  --listen 127.0.0.1 --port 7433 \
  --workspace /home/user/projects --workspace /home/user/vault
curl -s http://127.0.0.1:7433/healthz     # {"ok":true,"protocol":1}

# Publish it on the tailnet as wss:// on 8443 (leaves the hub on :443 alone)
sudo tailscale serve --bg --https=8443 http://127.0.0.1:7433
tailscale serve status
```

Use `--fake-harness` on `serve` for a no-tokens-spent dry run (a scripted stand-in for Claude; send
`/tokens 60 burst=1 delay=40` to watch streaming).

To remove the tailnet exposure: `sudo tailscale serve --https=8443 off`.

## Install as a service

Pick one. All three run the same single-file bundle (`agent-threads.cjs`) and keep state in one data directory.
Whatever you pick, finish with the same three steps: create a token, give the daemon a Claude credential, run
`agent-threads doctor`.

### A. Script + systemd user service (a Linux box you log in to)

Needs Node 22+ and `curl`. No root.

```bash
curl -fsSL https://raw.githubusercontent.com/rbcodelabs/agent-threads/main/deploy/install.sh | bash
# a specific release:  AGENT_THREADS_VERSION=0.63.0 bash deploy/install.sh
```

`install.sh` downloads the bundle from the GitHub release, **verifies its SHA-256** (it refuses to continue on a
mismatch), puts it under `~/.local/share/agent-threads/`, links `~/.local/bin/agent-threads`, and runs
`agent-threads install`. That second step is also available on its own (`--dry-run` shows what it would do):

```bash
agent-threads install --dry-run
agent-threads install            # idempotent: run it again after an upgrade
```

It creates `~/.config/agent-threads/{env,claude-token}` (mode 0600, **never overwritten**), a `~/workspaces` folder,
and `~/.config/systemd/user/agent-threads.service`, then enables and starts it. It refuses to overwrite a unit it did
not write (use `--force`), and it prints the next steps:

```bash
agent-threads token create --name geode --scope control    # shown once: paste it into Geode
agent-threads token create --name cli --scope control --save   # lets list/attach/run on this machine find it
loginctl enable-linger "$USER"                              # keep the service running after you log out
sudo tailscale serve --bg --https=8443 http://127.0.0.1:7433   # reach it from Geode over wss://
systemctl --user status agent-threads
agent-threads doctor
```

Local changes to the unit belong in a drop-in (`systemctl --user edit agent-threads`), which `agent-threads install`
leaves alone. Logs: `journalctl --user -u agent-threads -f`.

### B. systemd, system-wide (a dedicated VM)

The reference units are in `deploy/`: `agent-threads.service` (system) and `agent-threads.user.service` (the user
unit that `agent-threads install` writes). The system unit runs as its own unprivileged user:

```bash
sudo useradd --system --home-dir /var/lib/agent-threads/home --shell /bin/bash agent-threads
sudo install -d -o agent-threads -g agent-threads /srv/workspaces
sudo install -d -m 0755 /opt/agent-threads/dist
sudo install -m 0644 agent-threads.cjs /opt/agent-threads/dist/agent-threads.cjs   # from the release, or your build
sudo install -d -m 0755 /etc/agent-threads
sudo install -m 0600 /dev/null /etc/agent-threads/env            # optional: CLAUDE_CODE_OAUTH_TOKEN=..., GH_TOKEN=...
sudo install -m 0600 /dev/null /etc/agent-threads/claude-token   # the token alone (may stay empty if you sign in with `claude`)
sudo install -m 0644 deploy/agent-threads.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agent-threads
sudo -u agent-threads env HOME=/var/lib/agent-threads/home DATA_DIR=/var/lib/agent-threads \
  node /opt/agent-threads/dist/agent-threads.cjs token create --name geode --scope control
```

What the unit sets, and why:

| Setting | Why |
|---|---|
| `Restart=on-failure` | comes back after a crash, stays down after `systemctl stop` |
| `KillMode=control-group` | **critical.** Each live session is a `claude` child process. If the daemon dies by SIGKILL, those children are orphaned (and keep running, spending tokens) unless systemd reaps the whole cgroup. Do not change this to `process`. |
| `EnvironmentFile=-/etc/agent-threads/env` | the Claude token and `GH_TOKEN`, in a file only root and the unit can read (0600) |
| `LoadCredential=claude-token:...` | the token as a systemd credential (`$CREDENTIALS_DIRECTORY/claude-token`), which the daemon reads itself; the file must exist, and may be empty |
| `StateDirectory=agent-threads` | `/var/lib/agent-threads` (tokens, journals, raw logs, the `claude` login), created and owned by systemd |
| `ProtectSystem=strict` + `ReadWritePaths=` | the unit can only write to its state and workspaces. This limits *where* an agent writes, not *what* it runs (it must run builds and install packages); the VM is the real boundary |

To run in a different workspace, edit with a drop-in (`sudo systemctl edit agent-threads`): clear `ExecStart=` and
set your own, adding the folder to `ReadWritePaths=` too.

### C. Docker and Compose

The image (`sandbox/Dockerfile.daemon`) is Node 22 plus git, gh, ripgrep, jq, curl, build-essential, the bundle, and
the native Claude Code installer; it runs as a non-root user, with `/srv/workspaces` as the working directory and
`/var/lib/agent-threads` as state. No secret is baked in. Build and run from a checkout:

```bash
cp deploy/compose.env.example deploy/.env && chmod 600 deploy/.env     # then edit it
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml exec agent-threads agent-threads token create --name geode --scope control
docker compose -f deploy/compose.yaml exec agent-threads agent-threads doctor
```

Things that differ from a host install:

- **The port is published on the host's loopback only** (`127.0.0.1:7433`). Inside the container the daemon binds
  `0.0.0.0` (it has to, for the published port to reach it), so never publish it as `-p 7433:7433` on a host other
  machines can reach. Use `tailscale serve` on the host for `wss://`.
- Every client reaches the daemon from the container network's gateway address, which is not loopback, so the
  per-address bad-token throttle (5 failures in 60 s) applies to all clients together. A mistyped token on one
  device can briefly lock the others out.
- `docker compose exec agent-threads claude` signs in interactively; the login persists in the data volume. Or set
  `CLAUDE_CODE_OAUTH_TOKEN` in `deploy/.env`.
- `docker run` users: the entrypoint is `agent-threads serve`, so run other commands with
  `--entrypoint agent-threads` (for example `docker run --rm --entrypoint agent-threads IMAGE doctor`), or use `exec`.

**The published image does not contain the Claude CLI.** Releases publish `ghcr.io/rbcodelabs/agent-threads-daemon:<version>`
(the `base` stage, `linux/amd64` and `linux/arm64`), because Claude Code has no redistribution grant. Add the CLI on
your own machine with the thin layer built from the same Dockerfile:

```bash
docker build -f sandbox/Dockerfile.daemon \
  --build-arg BASE_IMAGE=ghcr.io/rbcodelabs/agent-threads-daemon:0.63.0 -t agent-threads-daemon:0.63.0 .
```

(Building the Dockerfile without `BASE_IMAGE` builds everything from the checkout, with the CLI.) The package is
private until the repository owner sets its visibility to Public once, after the first publish.

## CLI

The same `agent-threads` binary is also a client. It uses the daemon's wire protocol (the same `DaemonClient` the
Geode plugin uses), so anything it shows is exactly what Geode would show.

**Connecting.** `--url` > `AGENT_THREADS_URL` > `ws://127.0.0.1:7433` (or the port in the local data directory's
`config.json`). `--token` > `AGENT_THREADS_TOKEN` > `<data-dir>/cli-token`. The daemon stores only token *hashes*, so
the same-machine default needs a plaintext copy that you ask for once:

```bash
agent-threads token create --name cli --scope control --save    # writes <data-dir>/cli-token, mode 0600
agent-threads list
```

That file is readable only by the daemon's own user, who can already read every journal and run `claude`; it is the
same trust as the data directory. For another machine, pass `--url wss://my-server.tailnet-name.ts.net:8443` and a
token created for that purpose. Nothing is ever put in the URL.

| Command | What it does |
|---|---|
| `agent-threads list [--json]` | the daemon's threads: id, state (`waiting` for an answer, `running`, `idle`, `closed`), last sequence, folder. Needs a `read` token. |
| `agent-threads attach <thread> [--from N\|end] [--claim] [--until-idle] [--json]` | follow a thread. Replays the journal after `--from` (default `0`: everything the daemon still holds; `end`: live only), then streams live. A unique id prefix is enough. |
| `agent-threads run [options] "<prompt>"` | open a new session, send one prompt, stream the answer, exit with a code for how it ended. |
| `agent-threads token create\|list\|revoke` | manage tokens (`--json` for scripts; `create --save` as above). |
| `agent-threads doctor` | check the machine and the daemon (below). |
| `agent-threads install` | set up the systemd user service (above). |

**attach and the one-writer seat.** A thread has one read-write client at a time (see "Known limits"). `attach` is a
**read-only observer by default**: it never takes the seat, so watching a thread from a terminal cannot lock Geode out
of it; an open permission prompt is shown but not asked. `--claim` takes the seat when it is free and lets you answer
permission, question and plan prompts at the terminal (`y`/`N`, an option number, ...). If Geode (or another terminal)
holds the seat, `--claim` says so and keeps observing; to take over, detach it there first. If someone else answers a
prompt first, the daemon's `request_resolved` event withdraws yours ("answered elsewhere") and a late answer is refused:
first resolver wins. Prompts are only asked once the replayed backlog has been delivered, so a request that was
answered while you were away is never asked again.

**run.** `--cwd` is a folder **on the daemon machine** (default: the shell's folder when the daemon is local and
allows it, else the daemon's default workspace); `--permission-mode` (default `default`, `dontAsk` with
`--unattended`); `--model`; `--thread <id>` to continue a thread. `--detach` sends the prompt, prints the thread id and
exits, leaving the turn running on the daemon; `agent-threads attach <id>` replays all of it later. The session is
ephemeral: when the turn ends, `run` closes the session (stopping its `claude` process); the journal stays for
`attach` until retention drops it. `--unattended` means nobody is there: a permission, question or plan request fails
the run at once (the request is refused and the turn interrupted). The same applies with no terminal (stdin not a TTY)
and no `--json`. Ctrl-C interrupts the turn (a second Ctrl-C leaves it running and detaches).

| Exit code | Meaning |
|---|---|
| 0 | the turn finished (`attach --until-idle`: nothing is running, last turn fine) |
| 1 | the turn or the command failed |
| 2 | usage error |
| 3 | the daemon could not be reached |
| 4 | the token was rejected, or its scope is too low |
| 5 | protocol mismatch: use a CLI that matches the daemon |
| 6 | the turn was interrupted |
| 7 | (`run`) a request needed an answer and nobody could give it |
| 130 | Ctrl-C |

**`--json` (NDJSON).** One JSON object per line on stdout; text and prompts go to stderr. Daemon frames are passed
through *verbatim* (`type` is `event` or `resync`, with the protocol's own `ch`, `seq`, `ts`, `name`, `args`, plus
`replay`/`reopen` when set), so they are additive-only within protocol v1. The CLI's own records have
`"type":"cli"` and a `kind`:

| `kind` | When | Fields |
|---|---|---|
| `attached` | first line of attach/run | `threadId, controller, lastSeq, lowWater, resync, epoch` |
| `started` | `run`, before sending | `threadId, cwd, permissionMode, detach` |
| `note` | a human-readable remark | `text` |
| `connection` | the socket dropped | `status, detail` |
| `command_result` | answer to a stdin command | `cmd, requestId?, ok, error?` |
| `detached` | `run --detach` | `threadId` |
| `end` | last line | `outcome` (`done, idle, error, interrupted, needs_input, stopped, failed`), `exitCode`, `lastSeq`, `threadId?`, `message?` |

With `--json`, when you hold the seat (`run`, or `attach --claim`) the CLI reads NDJSON **commands from stdin**:
`{"cmd":"resolve.permission","requestId":"...","allow":true}`, `resolve.question` (`answers`), `resolve.plan`
(`approve`), `resolve.elicitation` (`result`), `{"cmd":"interrupt"}`, `{"cmd":"send","text":"..."}`. If stdin ends
while a `run` has a request open, the request is refused and the run fails with exit 7.

`list --json` prints one object per thread: `threadId, state, lastSeq, open, turnInFlight, hasPendingPermission, cwd,
nativeSessionId, lastActivityAt`.

## doctor

`agent-threads doctor [--strict] [--json]` checks, with a PASS / WARN / FAIL / SKIP line and a `fix:` for each problem:
Node 22+; the `claude` CLI; `git`; `gh` and whether it is logged in; `rg`; the listen address (warns on a wildcard or
non-loopback address); whether the daemon answers `/healthz`; data directory ownership and permissions (0700), token
and `cli-token` file modes; `tokens.json` readable with at least one active token (and `cli-token` still valid);
a Claude credential (environment, systemd credential, env file, or an existing `~/.claude` login; values are never
printed); workspaces exist and are writable; free disk space (warns under 5 GiB, fails under 500 MiB); clock skew
against the daemon's HTTP `Date` header; and Tailscale (installed, running, serving the port). The exit code is 1 if
anything FAILed (`--strict`: or warned), else 0; SKIP never counts. Run it as the user the daemon runs as, and pass
`--data-dir` / `--url` when the daemon uses non-default ones. `--json` prints one `{"type":"check",...}` line per check
and a `{"type":"summary",...}` line.

## Upgrade

The daemon and the plugin are released together; the daemon refuses a plugin older than its `minClientVersion`, so
upgrade the daemon first (or together).

- **Script / user service:** `AGENT_THREADS_VERSION=<new> bash deploy/install.sh` (re-downloads, verifies, re-runs
  `agent-threads install`), then `systemctl --user restart agent-threads`.
- **System unit:** replace `/opt/agent-threads/dist/agent-threads.cjs`, then `sudo systemctl restart agent-threads`.
- **Docker:** pull the new tag (or rebuild) and `docker compose up -d`.

A restart stops live `claude` processes: a running turn is closed as `daemon_restarted`, Geode shows it, and the next
message resumes the same native session. Do it between turns when you can (`agent-threads list` shows what is running).

## Backup

Everything worth keeping is in the data directory: `tokens.json` (hashes), `config.json` (daemon id), `journal/`
and `sessions/` (replay history and how to resume each session), `logs/` (raw logs), and `home/` (the `claude`
login and its session files, in the Docker and system layouts). The repositories are in the workspaces. To back up:

```bash
systemctl --user stop agent-threads        # or: sudo systemctl stop agent-threads / docker compose stop
tar -C "$(dirname "$DATA_DIR")" -czf agent-threads-backup.tgz "$(basename "$DATA_DIR")"   # 0600 it: it holds journals
systemctl --user start agent-threads
```

A Proxmox snapshot of the VM does the same job and also covers the workspaces. Restoring the directory brings back
tokens, history and resumable sessions; a Geode that was ahead of a restored journal resyncs by itself. The archive
contains prompts and tool output: store it like the data directory itself.

## Uninstall

```bash
systemctl --user disable --now agent-threads          # system unit: sudo systemctl disable --now agent-threads
rm ~/.config/systemd/user/agent-threads.service && systemctl --user daemon-reload
sudo tailscale serve --https=8443 off                 # if you published it
rm -rf ~/.config/agent-threads ~/.local/share/agent-threads ~/.local/bin/agent-threads   # config, bundle, link
rm -rf "$DATA_DIR"                                    # tokens, journals, logs: only if you do not want them
docker compose -f deploy/compose.yaml down -v         # Docker: -v also deletes the data and workspace volumes
```

Then remove the daemon in Geode (Settings, Remote, Remote daemons). Threads that ran there stay in the transcript but
can no longer be resumed.

## Smoke test

`scripts/smoke-daemon.mts` checks a running daemon (a container, a service, a VM) without spending tokens when it runs
the fake harness: `/healthz`, a wrong token being rejected, and a short ordered stream.

```bash
AGENT_THREADS_SMOKE_URL=http://127.0.0.1:7433 AGENT_THREADS_SMOKE_TOKEN=atd_... node scripts/smoke-daemon.mts
# against a real daemon: --no-stream (health + auth only) or --real (one short real prompt; spends a few tokens)
```

## Security

Read this before exposing the daemon beyond `127.0.0.1`.

- **A control token is shell access as the daemon user.** A `control` (or `admin`) client can start sessions that run
  `claude` with shell and file tools on that machine, as the user the daemon runs as. Treat the token like an SSH key,
  create one per client, and revoke it (`agent-threads token revoke <id|name>`) when a device is lost. Run the daemon as a
  dedicated, unprivileged user, ideally on a machine (VM) with nothing on it you cannot lose.
- **Workspaces are a working-directory guard, not a sandbox.** `--workspace` decides where a session may *start*
  (symlinks are resolved first). It does not stop the agent from reading or writing elsewhere once it is running a shell
  command. `--readonly-workspace` only removes the harness's edit tools; shell commands are not blocked.
- **A `read` token sees everything.** It can attach to any thread and receive its transcript and tool output (file
  contents, command output, anything the agent printed). It cannot send or resolve anything.
- **The journal and raw logs are not redacted for content.** `<data-dir>/journal` and `<data-dir>/logs` hold prompts, replies
  and tool output. Known credentials are masked in the raw log, but a secret the agent prints (a `.env` it reads, an
  environment dump) is stored. Files are `0600` in a `0700` directory; the retention settings below bound how long they
  live. Deleting a thread in Geode does not delete its daemon-side files.
- **`tailscale serve` exposes the daemon to your whole tailnet.** Anyone on the tailnet can reach the port and try
  tokens (256-bit tokens make guessing infeasible, but reachability should still be deliberate). Restrict who can reach
  the machine with a Tailscale ACL (`tag:`-based `accept` rule limited to your devices, and the daemon's port) rather than
  relying on the token alone.
- **Plain `ws://` sends the token in the clear.** `wss://` (for example through `tailscale serve`) is encrypted by
  Tailscale. `ws://` to a raw port is only acceptable inside a VPN tunnel. Geode's Add/Edit daemon dialog shows a warning
  when the address is `ws://` (or `http://`) and the host is not loopback, `*.ts.net`, or a Tailscale address.
- **Environment is not client-controlled.** A client's environment (`extraEnvRaw`) is ignored by default. Variables such
  as `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, `BASH_ENV` or `GIT_SSH_COMMAND` would let a client redirect the agent's traffic or
  commands. If you really need one, list the names the operator permits in `config.json`
  (`"allowedClientEnv": ["MY_FLAG"]`, or `AGENT_THREADS_ALLOWED_CLIENT_ENV`, colon separated). Credential-carrying and
  process-altering names (`HOME`, `PATH`, `NODE_OPTIONS`, `ANTHROPIC_*` keys, ...) stay refused even if listed.
- **Permission modes are an allowlist.** Only `default`, `acceptEdits`, `plan`, `dontAsk`, `auto` (and `bypassPermissions` when
  you set `allowBypass`) are accepted; anything else is refused.
- **Throttling behind a proxy.** Behind `tailscale serve` (or any local reverse proxy) every client reaches the daemon from
  `127.0.0.1`, so a per-address failure counter would let one peer's bad tokens lock the owner out. Loopback peers are
  therefore **not** throttled; protection there is the 256-bit token plus the tailnet ACL. When the daemon is bound to a
  non-loopback address directly, bad-token attempts are throttled per address (5 in 60 s). A daemon does not trust a
  forwarded-address header.
- **Revocation is not instant for a connection that is already open.** A new connection with a revoked token is refused
  immediately; an open connection is dropped at its next heartbeat, up to 20 seconds later.
- **If `tokens.json` is damaged** the daemon rejects *all* authentication (and says so once in its log) until the file is
  fixed, rather than crashing or guessing. Starting the daemon with a damaged file fails.

Limits that keep one bad client from exhausting the machine (all in `config.json`, env or flags): at most 64 sockets
(`maxConnections`) and 16 not-yet-authenticated ones; frames before `hello` are capped at 4 KB; a client that stops reading
replies is dropped like a slow event consumer; at most 8 live sessions (`maxLiveSessions`); an unanswered permission or
question is canceled after 60 minutes (`requestTimeoutMinutes`, 0 = never) so a forgotten prompt cannot block a turn
forever. The audit log (`audit.ndjson`) is batched, does not record per-event acknowledgements, and rotates at 5 MB keeping
three old files. Raw logs (`logs/<thread>.jsonl`) follow the journal retention: files older than `journalTtlDays` are
deleted and a file past `journalMaxMb` is rotated to `.jsonl.1` (so at most about twice the cap per thread).

## Connect from Geode

1. Install the build: copy `dist/main.js`, `dist/manifest.json`, `dist/styles.css` into
   `<vault>/.geode/plugins/claude-threads/` (never `data.json`), then run **Reload plugin (safe)**.
   Commit and push the branch first (see `process/development.md`, "Dev Builds in the Live Vault").
2. Settings, Remote, **Remote daemons**, **Add daemon**: a name (for example `my-server`), the address
   (for example `wss://my-server.tailnet-name.ts.net:8443`) and the token. Press **Test connection**: it
   should say `Connected: agent-threads <version>, protocol 1`, and the dialog then offers the folders the
   daemon itself advertises (next section). You do not type any path on the daemon machine.
3. In the Agents list composer, right-click (or hold) the send button: under **Run on** choose
   `my-server`. The folder is a dropdown of the daemon's own folders (with **Browse...** to pick a
   subfolder); send. The thread shows a `my-server` badge, the remote folder and a connection pill.
4. Quit Geode mid-turn, wait, reopen: the transcript completes without any action.

## Folders are discovered, not typed

A current daemon tells Geode which folders it allows, so you never type a remote path from memory. Two
additive, read-scope commands do this (an older daemon answers `unknown_command` and Geode falls back to text
fields):

- `workspaces.list` returns the configured workspaces: `{path, name, readOnly, kind, isDefault}`. `kind` is
  `vault` when the folder contains a `.geode`, `.obsidian` or `.vault` directory, otherwise `folder`.
  `isDefault` marks the daemon's first read-write workspace. Capabilities `workspaces.list` and `path.list` are
  advertised in `welcome`.
- `path.list {path}` returns the subfolders of an allowed folder (directories only, dot-folders skipped, at
  most 300). A path outside every workspace gets `allowed:false` and no names; symlinks are resolved before
  the check, so a link that leads outside a workspace is neither listed nor enterable. File names and
  contents are never returned.

What Geode does with it:

- **Add / Edit daemon, after Test connection succeeds:** the vault folder and default folder become dropdowns
  of the daemon's workspaces (plus None). The vault folder is chosen for you: if exactly one advertised
  folder looks like a vault it is used; otherwise the folder whose name equals this vault's folder name;
  otherwise it stays on None with a hint. The default folder starts as the daemon's default workspace. A value
  you already saved or chose yourself is never overwritten. The raw text fields live under **Advanced** (and
  open by themselves when the daemon is too old to advertise folders).
- **Run on:** the folder is a dropdown of the daemon's workspaces. A vault thread with a mapping has its
  mapped folder preselected. **Browse...** lists subfolders (`path.list`) to descend into and **Use this
  folder** selects one. **Other folder...** switches to typing.

## Working in the vault

A daemon can hold a synced copy of your vault (for example `/home/user/vault`, kept in sync with your
main machine by a file-sync tool every few minutes). Vault threads can then run there with the same
folder they would use on the Mac.

**Caveats, read these first.** The daemon works on a *copy*, not the live vault:

- Changes propagate in both directions with a delay of up to about 5 minutes. A file edited in the last few
  seconds on either side is "unsettled" and waits for the next sync run.
- If you and a remote thread edit the same file in that window, the sync can conflict (one side's edit is
  lost or a conflict copy appears). Remote sessions are told to re-read before editing, prefer small edits
  and new files over rewrites, and never delete or rename vault files unless you ask.
- The vault_* / editor tools are not available remotely; the session uses its shell and file tools on the copy.

**1. Let the daemon use the folder.** Sessions may only run under a `--workspace` folder. `--workspace` is
repeatable and a flag *replaces* the whole list (flag > `AGENT_THREADS_WORKSPACES` > `config.json`), so
repeat every folder you already use. Change the unit with a drop-in (`systemctl --user edit agent-threads`, or `sudo systemctl edit agent-threads` for a
system unit; `agent-threads install` leaves drop-ins alone):

```ini
[Service]
ExecStart=
ExecStart=/usr/bin/node /home/user/agent-threads/agent-threads.cjs serve \
  --data-dir /home/user/agent-threads/data --listen 127.0.0.1 --port 7433 \
  --workspace /home/user/projects \
  --workspace /home/user/vault
```

(Keep your existing flags and paths; only add the `--workspace /home/user/vault` line. A system unit also needs the folder in `ReadWritePaths=`.) Then
`systemctl --user daemon-reload && systemctl --user restart agent-threads` (system unit: drop `--user` and
use `sudo`). Alternatives with the same effect: `AGENT_THREADS_WORKSPACES=/home/user/projects:/home/user/vault`
in the unit's `Environment=`, or `"workspaces": [...]` in `<data-dir>/config.json`. Restarting stops live `claude` processes (a running turn is marked interrupted); threads resume on the next message.

The workspace check follows symlinks before comparing, so `~/vault` may itself be a link to another disk, but
a link *inside* the vault that points outside it is refused as a cwd.

**Optional: read-only.** `--readonly-workspace /home/user/vault` (env `AGENT_THREADS_READONLY_WORKSPACES`,
config `readOnlyWorkspaces`) allows sessions there but denies the harness's edit tools (`Edit`, `MultiEdit`,
`Write`, `NotebookEdit`) and refuses the `acceptEdits`, `auto` and `bypassPermissions` modes (Geode's default setting
is `acceptEdits`, so such a thread must use the default or plan permission mode). This is a guard rail, not a sandbox: shell commands
(`Bash`) are not blocked. Use it together with `--workspace` for other folders (a read-write workspace nested
inside a read-only one stays writable).

**2. Tell Geode.** Settings, Remote, Remote daemons, edit your daemon and press **Test connection**. With a
current daemon the **Vault folder on this daemon** dropdown fills itself in (see the previous section); you
only confirm it. Under **Advanced**, **Local folder it mirrors** stays blank to use this vault, or names a
subfolder of it if only part of the vault is mirrored. **Test connection** also checks the chosen folder: it
reports whether the daemon allows it and whether it exists (an older daemon says it cannot check folders).

**3. Use it.** In the composer, choose **Run on** your daemon: when the thread's folder (the selected
Project's folder, otherwise the default folder) is inside this vault, the remote folder is preselected as the
same relative path under the vault folder, with a note saying so. Pick another folder if you want something
else. Folders outside the vault keep the daemon's default folder. Threads whose remote folder is inside the
vault folder get a system-prompt addendum describing the points above.

## States you will see

| Pill | Meaning |
|---|---|
| Connected | socket up |
| Reconnecting | dropped; retrying on the 1s/2s/4s/8s/16s/30s ladder; a running turn continues on the daemon |
| Daemon unreachable | 3+ failed attempts; keeps retrying |
| Protocol too old | plugin and daemon do not speak the same protocol (or the plugin is older than the daemon's minimum); retrying will not help, update the older side |
| Token rejected | the daemon refused the token (Settings, Remote daemons) |

## Catching up after being away

Quit Geode mid-turn, come back hours later: the transcript completes and every message shows the time it
actually happened, not "just now". What makes that work:

- **Original times.** The daemon stamps each event when it happens. Events delivered from its backlog are
  flagged `replay`, and Geode records them at that time; an event delivered live is stamped with Geode's own
  clock. `ThreadManager.now()` / `runAtTime()` carry this, and every timestamp the session callbacks write
  (messages, compact markers, `updatedAt`, agent runs, the sign-in banner) goes through it.
- **Acks follow the save.** Geode tells the daemon it may drop history only after the transcript is written to
  `data.json`, and only up to the position that save covered (not whatever arrived while it was writing). The
  saved position also never lags the saved transcript, so a quit right after a message is saved cannot replay
  that message into the transcript twice.
- **The daemon forgets, within limits.** Acked turns are compacted: their streamed tokens go (the finished
  message stays) and the file on disk shrinks. Independent of acks, history older than `--journal-ttl-days`
  (default 7, 0 = keep) or beyond `--journal-max-mb` (default 64 per thread, 0 = no cap) is dropped, checked
  on startup and every few minutes. Config: `journalTtlDays` / `journalMaxMb` in `config.json`, or
  `AGENT_THREADS_JOURNAL_TTL_DAYS` / `AGENT_THREADS_JOURNAL_MAX_MB`.
- **Resync.** A client whose position is older than what the daemon still holds gets the daemon's folded state
  instead of the missing events. Geode discards the half-streamed text of the unfinished message (it
  re-streams from the checkpoint), keeps the finished transcript, adds the messages it missed exactly once (at
  their original times), shows an open permission/question prompt once (and withdraws one the daemon no longer
  has open), and closes a turn that ended unseen.
- **Daemon crash.** A `kill -9` can lose events that were streamed live but not yet written, and the restarted
  daemon reuses their numbers. Geode sends the daemon epoch it last saw with each attach; if the daemon
  restarted and the client is ahead of where history resumed, the daemon tells the client to rewind and replay
  from there, so the client sees the `daemon_restarted` notice instead of silently dropping it.

## Known limits of this stage

- One writer per thread. The seat is held by (token, Geode install): the same install reconnecting takes its own seat back
  at once, a second install using the same token is an observer and gets `conflict` on writes. Installs identify
  themselves with the `remoteClientId` in their settings; an older plugin sends none and is treated as one install per token.
- "Always allow" on a permission prompt is **not supported** on a daemon session: the answer applies once, and the
  daemon's acknowledgement says `alwaysAllow: "not_supported"`. Nothing in the journal claims a standing rule.
- A remote thread cannot be forked (Fork conversation and `/fork` are refused with an explanation): a fork is a local
  thread and would start in the daemon's folder on the wrong machine.
- A send the daemon answers with a retryable `conflict` (it is running its maximum number of turns) is retried
  automatically with backoff (1 s doubling to 30 s, six tries). A send whose acknowledgement never comes back within 30 s
  is reported as *unconfirmed*, not "not delivered": the daemon may have run it. The thread stays attached, so what
  actually happened appears when the connection catches up; the daemon ignores a repeat of a message id it already
  accepted, so a retry cannot run a turn twice.
- A journal line that is damaged in the middle of the file is skipped and logged, and the entries after it are kept (the
  file is rewritten without it); only a damaged *tail* is dropped.

- Host tools (vault/editor), proxied MCP servers, skills, secrets: not forwarded (PR 7 and PR 9).
- The CLI is a client of the same protocol: `attach` is read-only unless `--claim`, and `--claim` cannot take a seat another client holds.
- A `resync` (Geode was away longer than the daemon keeps history) restores the last 20 finished messages
  only; anything older that was missed is in the daemon's raw log (`<data-dir>/logs/<thread>.jsonl`), not in
  the transcript. There is no "Recover from daemon" command yet.
- A replayed message keeps the daemon's clock reading of when it happened. If the two machines' clocks
  differ a lot, replayed times are off by that difference (never later than "now"); live messages always use
  this machine's clock.
- Deleting a thread in Geode does not delete its daemon-side journal.
- A prompt left on screen after another client answered it, or after a daemon restart, is dismissed by
  answering it; the answer is ignored.
- The e2e: `node scripts/e2e-geode-remote.mts` (hidden Geode against a local `--fake-harness` daemon;
  needs a Geode checkout, `GEODE_REPO`).

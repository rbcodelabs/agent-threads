# Remote daemon: run threads on another machine

A thread can run on an `agent-threads` daemon on another machine (a homelab box, a VM) and stream into
Geode. The turn keeps running there when Geode quits; reopening Geode re-attaches and the transcript
completes. This is stage 1 of the daemon design: Geode still owns the transcript, the daemon owns the
process and a replay journal.

What a remote thread has today: the **daemon machine's own tools** (shell, file read/write, search, git worktrees) and
its own `claude`, `codex` or `opencode` login, plus the tools of your computer proxied back to the app while it is connected ("Tools on your
computer" below). It does not have skills or keychain secrets (later PRs). Which harness a thread uses is chosen per session (see "Harnesses" below). A message sent while a turn is running is held by the
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

## Local daemon: this Mac, in a container

Settings -> Remote -> **Local daemon** runs the daemon on the Mac you are sitting at, inside Apple's `container`
runtime, with one click and no token pasting. It is an ordinary entry in "Remote daemons" (named *This Mac
(container)*, marked managed), so everything above applies: threads keep running when Geode quits, and reopening
Geode re-attaches. It is desktop-only and the whole block is hidden on mobile and on a Mac that cannot run the runtime
(Intel, macOS older than 26). Design and decisions: [`local-daemon-design.md`](local-daemon-design.md).

It is one shared VM per vault, started once and left running. (Earlier versions could also start a throwaway container
per thread, "Run in: Container"; that was removed in favour of this.)

**What Set up does** (after a confirmation that names the downloads, the vault path and "read-write"):

1. installs and starts the container runtime if needed (a pinned, checksum-verified copy kept outside the vault);
2. pulls `ghcr.io/rbcodelabs/agent-threads-daemon:<plugin version>` and builds a thin local layer that adds the CLIs of the
   harnesses you turned on (Claude from Anthropic; Codex and OpenCode from npm). The published image has none of them
   (no redistribution grant), so they are installed on your machine, at build time;
3. creates two named volumes (data and workspaces) and fixes their ownership with a one-shot (named volumes start
   root-owned; the daemon runs as uid 10001);
4. starts the container, publishing `127.0.0.1:<port>` only (7433, or the next free port) and waits for `/healthz`;
5. creates a `control` token **inside** the container, stores it in the OS keychain (never in `data.json`, argv or logs),
   and adds the Remote daemons entry with the vault mapped to `/vault`.

Every step is skipped when already satisfied and a failure resumes from the real state, so Set up can be re-run safely.
The VM is started lazily: nothing runs until you use it or press Start, and sending a message in a thread that runs
there starts it for you. Quitting Geode leaves it running.

**Folders.** The vault is mounted read-write at `/vault` (the daemon's `--workspace`), with `<vault>/.geode` and
`<vault>/.obsidian` mounted **read-only on top** so a process in the VM cannot rewrite plugin code that Geode would
later load. Notes are fully writable: keep vault backups or sync history. Paths containing `:` cannot be mounted and are
refused. The VM has full outbound network access.

**Harnesses (Claude, Codex, OpenCode).** The block has a toggle per harness; **Claude is on by default**. Each toggle adds
that CLI to the image layer (npm into `/opt/harnesses`, outside the volumes, like the Claude CLI) and the daemon in the
container is started with `AGENT_THREADS_HARNESSES` set to the same list, so a session for a harness you left off is refused
at the door. Changing a toggle only stores the choice: the daemon shows it as pending, and **Apply changes** (or
Start, when stopped) rebuilds the layer under its own image tag (`agent-threads-daemon-local:<version>-claude-codex`) and
replaces the container, keeping the volumes, token and sessions. At least one harness stays on. Under each toggle the panel
shows whether the CLI is in the image and whether it is signed in (checked while the daemon runs; "unknown" otherwise).

- **Claude:** the sign-in below (a token in the keychain, written into the data volume).
- **Codex:** **Sign in to Codex** runs `codex login --device-auth` inside the container: the panel shows the page and a
  one-time code, you approve in your browser, nothing is pasted back. The login is written by the CLI into the daemon's
  HOME in the data volume (`~/.codex/auth.json` under `/var/lib/agent-threads/home`), so it survives restarts and updates,
  and Geode never sees, stores or logs it. This flow was written against the CLI's documented behaviour and is covered by
  tests with a fake process; if it does not work on your Mac the panel shows the CLI's error and the exact command below.
- **OpenCode:** `opencode auth login` is an interactive provider picker with no headless mode, so the panel does not run
  it. It shows the exact line instead, with the managed `container` path quoted:
  `'<...>/runtime/<version>/bin/container' exec -it --user 10001 agent-threads-local-<id> /opt/harnesses/bin/opencode auth login`.
  Any failure to sign in also prints the matching command; none fails silently.

Only the Claude token is a secret this plugin holds (the keychain, as before). Codex and OpenCode logins live only in
the data volume, and the `localDaemon` settings carry just the toggles. **Reset daemon data** removes them with the volume.

**More folders.** Besides the vault: **Settings, Remote, Local daemon shared folders** lists host folders to share
READ-WRITE at `/work/<folder name>` (for example a repository outside the vault; they appear under "Run on" as
workspaces), and Geode's connected external roots are mounted READ-ONLY at `/ext/<name>` and offered as read-only
workspaces (the daemon denies the edit tools there). A folder that is both a shared folder and an external root (or one inside the other) is mounted once, read-write, at `/work`: a folder cannot be shared with two modes at the same time. Mounts are fixed when the container is created, so a change shows as
"settings changed" and is applied by **Update** (or the next start of a stopped container). The consent text lists every
mount. Memory and CPUs (**Local daemon memory** / **CPUs**, defaults 4G and 4) work the same way.

**Environment and keychain secrets.** The daemon never receives your keychain or shell. Before each message to a thread on
it, Agent Threads pushes that project's **Extra environment variables** (`AWS_PROFILE`, `CLAUDE_CODE_USE_BEDROCK`, ...) and
keychain secrets as a credential kind `sessenv-<project>` (`agent-threads creds push`, over stdin, 24 hour expiry,
refreshed on every send). The session spec carries only the kind's name; the daemon reads the values when the session
starts, so they are never in a spec, a journal, `config.json` or a log, and the daemon redacts them from its output.
Variables that describe this Mac's shell (`PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, `DYLD_*`/`LD_*`, ...) are not
sent. A spec cannot name any other credential kind as its environment.

**Skills.** The skill plugin directories a host thread would load and `~/.claude/skills` / `~/.claude/agents` are copied
into the daemon's data volume (`<data>/skills/<name>-<hash>`, `<data>/home/.claude/...`) before a session starts, by a
small script run inside the container; unchanged directories are not copied again, and the session spec carries the guest
paths (the daemon keeps only paths under its skills folder). Trees are followed through symlinks, skip `.git` and
`node_modules`, and are capped (2000 files, 20 MiB). The agent can read them.

**AWS (Amazon Bedrock, deploys).** For a Bedrock thread, or when **AWS profiles for the local daemon** is set, a trimmed
`~/.aws/config` (only those profiles, their `source_profile` chain and their `sso-session` blocks, allowlisted keys only,
never keys, session tokens or `credential_process`) and the single SSO token file of each profile's session are copied into
the daemon user's home before each message, so a fresh `aws sso login` on this Mac reaches the daemon within minutes.
`AWS_EC2_METADATA_DISABLED=true` is sent so a missing login fails fast with "Could not load AWS credentials" (which shows the
AWS sign-in card) instead of retrying for minutes. Narrower than the removed sandbox VM, which mounted the whole token cache.

**Tools that run on this Mac.** A new local daemon entry starts with the read groups (`vault`, `workspace`, `threads`,
`skills`, `browser`), your Google and OAuth MCP servers (`mcp`) and `host_exec` turned on (Settings, Remote, edit daemon
changes any of it; later edits are kept). `host_exec` runs ONE command on this Mac after an Allow once / Always allow `<prefix>` / Deny card
(see "Always allow a command prefix" below; never the generic "Always allow", whatever the permission mode); its directory defaults to the thread's folder on the Mac. Tools
that write, schedule or touch secrets are off for every daemon unless you switch a group on for THIS daemon (Settings, Remote, **Local daemon: tools that act on this Mac**: threads, schedule, secrets and MCP registration, skills, vault history, app commands and editor, browser scripts, GitHub discovery). Off by default; every call still asks you in the app first. **They act on this Mac with your account, not in the container**: an agent that read untrusted text could be steered into calling them, so leave a group off unless you need it. A change applies to the next thread session you open (see "Tools on your computer (host tools)" below).
`browser_navigate` forwards `localhost` URLs of a server the agent started in the container to a loopback port on this
Mac (relay through `container exec`, loopback only), so the page opens; start such servers in the background.

**Always allow a command prefix (`host_exec`).** For a simple command the card also offers **Always allow `<prefix>`**:
the program (`ls`, `brew`), or program plus subcommand for `npm`, `pnpm`, `yarn`, `git` and `cargo` (`git status`,
`npm test`, `npm run build`). Later `host_exec` calls whose command splits into the same leading tokens run on this Mac
without a card; matching is on whole tokens, so `git status` covers `git status -sb` but not `git push`, `git-lfs` or
`gitk`. Prefixes are kept in Settings, Tools, **Always-allowed host commands**, where each can be removed (it applies to
the next call). Limits, all fail-closed (the card is shown as before):

- A command with shell syntax (`;`, `&&`, pipes, redirects, quotes, `$`, backticks, globs, newlines), a `VAR=x` prefix or
  a path-qualified program is never offered and never auto-approved.
- Programs that run other programs or are broadly destructive (shells, `sudo`, `env`, `xargs`, `ssh`, `curl`, `rm`,
  interpreters such as `python` and `node`, ...) and subcommands such as `npm exec` or `git push` are never offered.
- Scheduled and other headless threads get no pre-approval, and `host_exec` still refuses them.
- `host_exec` is never added to the generic always-allowed tools.
- An approved program still runs whatever arguments the agent passes it, and the denylist is best-effort. Save only
  prefixes you are happy for an agent to run with any arguments.

**Run on, and moving a thread.** The kickoff picker's **Run on** section lists "This Mac (container)"; before it is set up
it shows "This Mac (container) - set up..." which opens this block. A Claude thread's menu (Harness, **Run on**) moves it
between this computer and a daemon that can see its folder (vault or a shared folder); the native session cannot move, so the
conversation continues from a summary and transcript references.

**GitHub.** If you use Geode's GitHub connection, a short-lived GitHub token (15 minute expiry, refreshed while Geode is
open) is pushed into the daemon so `git` over HTTPS and `gh` work there, along with your commit identity. How it works
and what it can reach: [GitHub via Geode](github-integration.md#local-daemon).

**Claude sign-in.** If the keychain already holds a container sign-in, that token is reused with no prompt. Otherwise the
status reads *Running, needs Claude sign-in*; **Sign in to Claude** runs the
same in-container `claude setup-token` flow once (open a page, paste back a code). When a token expires, the thread's
"Sign in to Claude" card (threads on the daemon only) runs the same flow with a forced fresh token and then retries the
message. The token is kept in the keychain
under the shared container sign-in secret and written into the data volume through stdin (not argv or the environment),
where the daemon reads it at start. A daemon only reads it at start, so applying a new sign-in restarts the daemon.

**Buttons.** Set up, Start, Stop, Restart, **Update available** (prompt only, never automatic: it downloads hundreds of MB
and interrupts running turns), **Reset daemon data** (wipes the volumes and token, sets up again) and **Remove** (deletes
the container, volumes and token and the Remote daemons entry; your Claude sign-in is kept). Updating replaces the
container but keeps the volumes, so the token, sessions and journals survive. The daemon image version always equals the
plugin version; if that image is not published yet you are told so and the running version keeps working.

**Failures say what to do.** A package that is not public ("not publicly pullable": the maintainer must set the GHCR package
to Public), an image not published yet, no network, no disk space, a port in use (the next one is used and remembered),
a container with our name that Agent Threads did not create (left alone), a daemon that never answers (with the log tail),
and a token the daemon rejected (a new one is created) each have their own message.

**Not in this version:** exposing the daemon to other devices, stop-on-idle, network isolation modes (the agent inside needs
the network to reach Claude), and write/scheduling host tools for daemon threads (policy, see above).
Old per-toggle image tags are not garbage-collected until Remove (they only cost disk). The harness CLIs are installed from npm without a lockfile (`CODEX_VERSION` defaults to `latest`, `OPENCODE_VERSION` to the
version the adapter is verified against); the OpenCode install explicitly allows only `opencode-ai`'s postinstall for npm
versions that block install scripts, and the build fails if either CLI is not runnable.

Troubleshooting: the runtime ships with the plugin and is not on your `PATH`; the CLI is at
`~/Library/Application Support/claude-threads/runtime/<version>/bin/container` (`container ls -a` shows
`agent-threads-local-<id>`). Unit tests use a fake `container` binary (`test/helpers/fake-container.mjs`).

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
curl -fsSL https://raw.githubusercontent.com/rbcodelabs/agent-threads/v0.63.0/deploy/install.sh | bash
# a specific release, from a checkout:  AGENT_THREADS_VERSION=0.63.0 bash deploy/install.sh
```

Pin the script URL to a release tag (replace `v0.63.0` with the release you want) rather than `main`: you then run the
reviewed file of that release, and a later change on `main` cannot alter what you pipe into your shell.

`install.sh` downloads the bundle from the GitHub release and **verifies its SHA-256** (it refuses to continue on a
mismatch). The checksum is published next to the bundle in the same release, so it catches a damaged or truncated
download, not a compromised release or account; trust comes from the tag you pin and HTTPS to github.com. It then puts the bundle under `~/.local/share/agent-threads/`, links `~/.local/bin/agent-threads`, and runs
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
sudo install -m 0600 /dev/null /etc/agent-threads/claude-token   # REQUIRED to exist (the unit will not start without it); may stay empty if you sign in with `claude`
sudo install -m 0644 deploy/agent-threads.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agent-threads
sudo -u agent-threads env HOME=/var/lib/agent-threads/home DATA_DIR=/var/lib/agent-threads \
  node /opt/agent-threads/dist/agent-threads.cjs token create --name geode --scope control
```

What the unit sets, and why:

| Setting | Why |
|---|---|
| `Restart=on-failure` | comes back after a crash, stays down after `systemctl stop` |
| `KillMode=mixed` | **critical.** `SIGTERM` goes to the daemon alone, so it can close its sessions and flush its journals; systemd then `SIGKILL`s whatever is left in the unit's cgroup. Each live session is a `claude` child process: if the daemon dies by SIGKILL, those children would be orphaned (and keep running, spending tokens) unless systemd reaps the cgroup. Verified on systemd 259: with `mixed`, both `systemctl stop` and a SIGKILL of the daemon leave no child alive. Do not change this to `process` or `none`. |
| `EnvironmentFile=-/etc/agent-threads/env` | the Claude token and `GH_TOKEN`, in a file only root and the unit can read (0600) |
| `LoadCredential=claude-token:...` | the token as a systemd credential (`$CREDENTIALS_DIRECTORY/claude-token`), which the daemon reads itself. The file **must exist** (it may be empty): systemd refuses to start the unit without it (status `243/CREDENTIALS`) and has no optional form. `agent-threads install` creates it; for the system unit the `install -m 0600 /dev/null /etc/agent-threads/claude-token` line above does |
| `ExecStart="..."` | every path is quoted and `%` / `$` are escaped (a path with a space or a `%` works); a newline in `--workspace` is refused by `agent-threads install` |
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
- **The Claude CLI lives at `/opt/claude/.local/bin/claude`, outside every volume**, so an image upgrade really upgrades it
  (under the data volume it would be copied in once and frozen there, or hidden by a bind mount); only the login and the
  sessions are in the persisted home. Its self-updater is switched off (`DISABLE_AUTOUPDATER=1`): rebuild to update.
- **The port follows `AGENT_THREADS_PORT`** (default 7433): the daemon, the health check and the published port all use the
  same value, so setting it in `deploy/.env` changes all three. Compose drops every capability (`cap_drop: [ALL]`) and sets
  `no-new-privileges`; the daemon runs as a non-root user on a high port and needs neither. A `.dockerignore` keeps
  `deploy/.env`, `.git`, `node_modules` and local worktrees out of the build context. If you build with Podman, add
  `--format docker`, or the image format drops the `HEALTHCHECK`.
- `docker run` users: the entrypoint is `agent-threads serve`, so run other commands with
  `--entrypoint agent-threads` (for example `docker run --rm --entrypoint agent-threads IMAGE doctor`), or use `exec`.

**The published image does not contain the Claude CLI.** Releases publish `ghcr.io/rbcodelabs/agent-threads-daemon:<version>`
(the `base` stage, `linux/amd64` and `linux/arm64`), because Claude Code has no redistribution grant. Add the CLI on
your own machine with the thin layer built from the same Dockerfile:

```bash
docker build -f sandbox/Dockerfile.daemon \
  --build-arg BASE_IMAGE=ghcr.io/rbcodelabs/agent-threads-daemon:0.63.0 -t agent-threads-daemon:0.63.0 .
```

(Building the Dockerfile without `BASE_IMAGE` builds everything from the checkout, with the CLI.)

**Codex and OpenCode in the image.** A separate, opt-in `with-harnesses` stage, declared before `with-claude` so the default
target (and the Claude layer the app builds) is unchanged. Build it with `--target with-harnesses` and
`--build-arg INSTALL_CODEX=1` (npm `@openai/codex`, `CODEX_VERSION`, default `latest`) and/or `--build-arg INSTALL_OPENCODE=1`
(npm `opencode-ai`, `OPENCODE_VERSION`, default the version the adapter is verified against); add
`--build-arg BASE_IMAGE=ghcr.io/...:<version>` to start from the published image. For all three, layer Claude on top by
building the default target with `--build-arg BASE_IMAGE=<the with-harnesses image>`. The CLIs install into
`/opt/harnesses` outside the volumes, like the Claude CLI; their logins and config live in the persisted HOME
(`~/.codex`, `~/.local/share/opencode`) or come from env keys. The published image never contains any of the three CLIs:
the workflow builds the `base` stage only and passes no build args. The package is
private until the repository owner sets its visibility to Public once, after the first publish.

## CLI

The same `agent-threads` binary is also a client. It uses the daemon's wire protocol (the same `DaemonClient` the
Geode plugin uses), so anything it shows is exactly what Geode would show.

**Connecting.** `--url` > `AGENT_THREADS_URL` > `ws://127.0.0.1:7433` (or the port in the local data directory's
`config.json`). `--token` > `AGENT_THREADS_TOKEN` > `<data-dir>/cli-token`. A token given with `--token` is visible to other users in `ps` and stays in your shell history: prefer the environment variable or the saved file (`token create --save`, mode 0600). A plain `ws://` address that is not this machine prints a warning (the token and prompts travel in the clear). The daemon stores only token *hashes*, so
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
| `agent-threads creds push <kind> [NAME...] [--stdin] [--ttl T] [--remove]` | send credentials to the daemon (`admin` token). See "Pushing credentials from the CLI". |
| `agent-threads mcp sync --stdin [--clear] [--strict]` | replace the MCP servers synced to the daemon (`admin` token): JSON `name -> definition` on stdin. See "MCP servers synced from the app". |
| `agent-threads token create\|list\|revoke` | manage tokens (`--json` for scripts; `create --save` as above). |
| `agent-threads doctor` | check the machine and the daemon (below). |
| `agent-threads install` | set up the systemd user service (above). |
| `agent-threads update --check\|--apply [--now] [--json]` | compare with the latest stable release, or install it in place; see "Automatic updates". |

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
exits, leaving the turn running on the daemon; `agent-threads attach <id>` replays all of it later. A session `run` creates
itself (no `--thread`) is ephemeral: when the turn ends, `run` closes it (stopping its `claude` process); the journal
stays for `attach` until retention drops it. A session you name with `--thread` is yours and is left open. `--unattended`
means nobody is there and defaults to the `dontAsk` mode, which **denies** every tool that is not pre-approved (the agent
is told and carries on; nothing is raised). If a permission, question or plan request is raised anyway (an explicit
`--permission-mode` that asks), it is refused, the turn is interrupted and the run exits 7. The same applies with no
terminal (stdin not a TTY) and no `--json`. Ctrl-C interrupts the turn (a second Ctrl-C leaves it running and detaches).

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
the auto-update state (skipped when off; warns when it is on but this install cannot update itself, or a release is held or was rolled back); a Claude credential **as seen from the shell you ran it in** (environment, systemd credential, env file, or an existing `~/.claude` login; values are never
printed). It cannot see the environment of a service started by systemd or a container: run it as the daemon user, or inside the container, and remember that a finding about the credential describes this shell, not the service; workspaces exist and are writable; free disk space (warns under 5 GiB, fails under 500 MiB); clock skew
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

### Automatic updates (opt in)

Off by default. With it on, the daemon follows the newest **stable** GitHub release of `rbcodelabs/agent-threads`
(drafts and pre-releases are ignored, and it never moves to an older version) and applies it **only when idle**.

```bash
agent-threads serve --auto-update                 # or AGENT_THREADS_AUTO_UPDATE=1, or "autoUpdate": true in config.json
#   --auto-update-interval-minutes N   how often to look (default 360, minimum 15)
#   --auto-update-quiet-minutes N      quiet time required before the restart (default 2)
agent-threads update --check                      # current vs latest, whether it is on and possible here, when it would apply
agent-threads update --apply [--now]              # the same safe procedure, by hand
```

For the systemd user service, add `--auto-update` to the unit with a drop-in (`systemctl --user edit agent-threads`,
clear and re-set `ExecStart=`), or put `AGENT_THREADS_AUTO_UPDATE=1` in `~/.config/agent-threads/env`.

**Where it works.** Only where the daemon can replace its own bundle *and* something will start it again. It checks, it
does not assume: it runs from the release bundle (`agent-threads.cjs`), is not in a container, can write the directory the
bundle lives in, runs under a systemd unit, and that unit's `Restart=` is `on-failure` or `always` (read with
`systemctl show`). The script install of section A qualifies. The system-wide unit of section B normally does not (the
bundle is root-owned and `ProtectSystem=strict` makes it read-only for the service): upgrade it by hand. Anywhere else it logs once that
auto-update is unavailable and why, makes no request to GitHub and changes nothing; `agent-threads doctor` and
`agent-threads update --check` show the reason.

**Docker and Compose never self-update.** A container's image is the unit of deployment: rewriting the bundle inside it
would be lost on the next recreate and would drift from the image tag. Pull the new tag instead (`docker compose pull &&
docker compose up -d`), pin a tag you trust, or run a watchtower-style updater that does this for you. The same applies
to read-only or unknown installs.

**The procedure.** Every `--auto-update-interval-minutes` it asks the GitHub releases API (no token; conditional
requests, so an unchanged answer does not use the rate limit; failures back off 1, 2, 4 minutes and so on up to the
interval, and a rate-limit reply is waited out). For a newer release it:

1. downloads `agent-threads.cjs` and `agent-threads.cjs.sha256` (HTTPS to github.com hosts only, every redirect hop
   re-checked, size capped) and verifies the SHA-256;
2. writes the bundle to a temp file next to the running one (same permissions) and runs
   `node <new> --version --json`, which must print the expected version. This is the only time a downloaded file runs,
   and only after the checksum matched;
3. keeps the old bundle as `agent-threads.cjs.prev-<old version>` (the last two are kept);
4. renames the new file into place (atomic: the old or the new file, never half of one).

A failure in any step leaves the running bundle untouched, is logged and audited (`audit.ndjson`: `update_check`,
`update_apply`, `update_restart`, `update_failed`, `update_held`, `update_rollback`) and is retried with backoff. A release
that is a **major** version bump, or whose bundle reports a different wire protocol, is **reported and held**, never
applied automatically (`update --check` says so); upgrade the daemon and the Geode plugin together by hand.

**When it restarts.** The new bundle is on disk but the old one keeps running until the daemon is idle: no turn in
flight, no permission/question/plan/elicitation or host-tool call waiting, and no session activity or client command for
`--auto-update-quiet-minutes`. It re-checks every 15 seconds; a new turn or request resets the quiet time; a running turn
is never interrupted (it can wait as long as it takes). Then it shuts down cleanly (sockets closed, journals flushed) and
exits with code **75**. That is deliberately non-zero: the units use `Restart=on-failure`, which does **not** restart a
clean exit 0, so a clean exit would leave the daemon down. `systemctl status` will show the 75 as "failed" for the instant
before the restart; that is expected, and the units need no change. On start the usual recovery applies (a thread that
was idle is untouched; sessions are cold-resumed on the next message). Not detected: a client command that is
mid-flight asynchronously (for example a long `repos.sync`); most commands are handled synchronously on the event loop,
so the check and the shutdown cannot interleave with them.

**If the new version does not start.** The install leaves a `pendingUpgrade` marker (`<data-dir>/update.json`). The new
version counts each start; if it dies before it has been listening for 60 seconds twice, the third start puts the saved
`.prev` bundle back instead, exits 75 to be restarted into it, and pauses auto-update until a release other than the failed one
is published (logged and audited). Limits, honestly: the guard is part of the new bundle, so it cannot catch a bundle
that fails before its first line runs (the `--version` check before the swap is what covers that); only one level of
rollback exists (the version that was running before); any failure to become healthy counts, including an environment
problem such as the port being taken, which a rollback will not fix (auto-update then pauses, and says why).

**Manual apply.** `agent-threads update --apply` runs the same steps from a shell (it needs the same install to be
updatable), then asks the running daemon, through a request file in the data directory, to restart when idle, even if
that daemon has auto-update off. `--now` skips only the idle wait (an explicit choice: a running turn is closed as
`daemon_restarted`). With no running daemon it tells you to restart it yourself.

**Security.** The checksum is published next to the bundle **in the same release**, so it detects a damaged or truncated
download, not a compromised release or GitHub account: trust comes from HTTPS to github.com and from the repository's
release process (the same caveat as `deploy/install.sh`, which has you pin a tag). Auto-update extends that trust to
"whatever is published as the latest stable release", on a schedule, with no one watching: turn it on only if you accept
that. It runs no shell, sends nothing but the GitHub requests (no telemetry, no token), and only ever replaces the bundle
file it is running from. The wire protocol advertises `update.auto` in `welcome.capabilities` when it is on and possible.

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

- **Host tools are a remote-control channel in both directions.** `tool.call` / `tool.result` are new, so they have their own threat model.
  - *A client lying to the daemon* (a stolen `control` token): it can feed the model any text through a `tool.result`, which is no more power than the same token has through `session.send`. It can only answer calls made for a thread it holds the seat of (call ids are random UUIDs bound to one thread, a repeat or another thread's id is refused), its manifest and results are validated and size-capped (500 tools, 2 MB manifest, results cut at 100K characters, only text and bounded images reach the model), and read-scope tokens cannot send either.
  - *A compromised daemon asking the app to run tools* is the dangerous direction: the app runs your vault, threads, scheduler and browser tools. The app therefore trusts nothing in a `tool.call`. It runs only a tool in the manifest it sent for that thread (exact server and name; anything else is refused and logged), caps input size, calls in flight (8 per thread, 16 overall) and calls per minute (240), and shows its **own** approval card (with the real input) for any tool that needs one, whatever the daemon claims happened on its side: a card the daemon wrote is never accepted as an approval, input too long to show in full is refused, and nothing remembered locally (always-allow, trusted built-ins) pre-approves a remote thread's request. Host tools are **off by default**, only read-only groups can be switched on (the tools that write, run commands, schedule, install, send or read secrets are never offered), and only the seat holder acts on a call. The remaining exposure is the groups you switched on: a hostile daemon can read what they expose (`vault` is your whole vault, `threads` your other threads' transcripts, `mcp` your Google data) and ask for any read-only tool that does not require approval. Keep the daemon on a machine you trust and switch on only the groups it needs.
  - *What never crosses to the daemon:* keychain values, broker addresses and capability headers, the token, and MCP servers that need a secret or run a program on your computer. Only names, schemas and results do. Results of a host tool are stored in the daemon's journal and raw log like any other tool output (see above).
  - *Never hangs:* with the app disconnected a call waits at most `hostToolGraceSec`, then fails with a readable message; an issued call waits at most `hostToolTimeoutSec`. Both are audited (`audit.ndjson` records server, tool, sizes and outcome, never inputs or results).

Limits that keep one bad client from exhausting the machine (all in `config.json`, env or flags): at most 64 sockets
(`maxConnections`) and 16 not-yet-authenticated ones; frames before `hello` are capped at 4 KB; a client that stops reading
replies is dropped like a slow event consumer; at most 8 live sessions (`maxLiveSessions`); an unanswered permission or
question is canceled after 60 minutes (`requestTimeoutMinutes`, 0 = never) so a forgotten prompt cannot block a turn
forever. The audit log (`audit.ndjson`) is batched, does not record per-event acknowledgements, and rotates at 5 MB keeping
three old files. Raw logs (`logs/<thread>.jsonl`) follow the journal retention: files older than `journalTtlDays` are
deleted and a file past `journalMaxMb` is rotated to `.jsonl.1` (so at most about twice the cap per thread).

## Tools on your computer (host tools)

A remote thread keeps the daemon machine's own tools (shell, file read/write, search). It can ALSO reach read-only
tools that only exist in the app on your computer, while the app is connected, **but only if you turn that on**:
**host tools are off by default for every daemon you add yourself**, and when you turn them on nothing is offered until you list a group. (The managed local daemon, a container on this Mac, starts with the read groups, `mcp` and `exec` listed.)

| Runs | Tools |
|---|---|
| On the daemon, beside the repo | `enter_worktree`, `exit_worktree`, `set_working_directory` (worktrees go under `<first workspace>/.worktrees`, or `worktreeRoot`). These refuse a folder in a read-only workspace, and the repo and git root they work on are checked like the target. |
| In the app on your computer, opt-in groups (all off until listed) | `vault` (search, backlinks, links, note metadata, file history, list, bridge list), `workspace` (open tabs, active file, watched documents), `threads` (list, current, projects, messages, log, wait), `skills` (list, search, get, sources), `browser` (the in-app browser tools except `browser_eval` and `browser_save_page`), `mcp` (your Google Workspace and OAuth MCP servers, under their own names, for example `mcp__google-docs__*`; or name one server) |
| One command on your computer, opt-in group `exec` | `host_exec`: runs ONE shell command on your computer; every call shows an Allow once / Always allow `<prefix>` / Deny card with the exact command, folder and reason, no permission mode or generic remembered answer skips it (only a command prefix you saved can; see "Always allow a command prefix"), and its environment is scrubbed (no credentials). On for the managed local daemon only by default. |
| Never offered to a daemon you add yourself; the managed local daemon can opt in per group | (same list) |
| Never offered, whatever you set | everything that writes, executes, schedules, installs, sends or reads a secret on your computer: `request_secret`, `mcp_register_server`, `host_execute_command` / `host_list_commands` / `host_open_url`, `workspace_navigate_to_file` / `workspace_insert_at_cursor`, `watch_document`, `vault_restore_file_version`, `vault_add_bridge`, `sync_resolve_conflict`, `threads_create` / `threads_send_message` / `threads_archive` / `threads_open` and every `threads_set_*` / project setter, `skills_install` / `create` / `update` / `uninstall` / `check_updates`, `Cron*` / `ScheduleWakeup`, `browser_eval`, `browser_save_page` |
| Not offered either | `github_*` (the discovery tools run against Geode's connection; the daemon gets the token itself, not the tools), `google-drive-files` (its paths are on your computer), tools contributed by other plugins |

The names are the ones a local thread has (`mcp__claude_threads__vault_search`). The remote session's system prompt lists
exactly which tools run on your computer (or says none do).

- **The app's own card is the only approval that counts.** A tool that needs approval asks you in the app with a card
  that shows the real input. An allow you gave on a card the **daemon** wrote (a `permission_request` it journaled) is never
  carried over to a host tool call, and nothing remembered on this computer ("Always Allow", trusted built-ins) pre-approves a
  request that comes from a remote thread; "Always Allow" is not offered on a remote thread's card. The daemon itself lets a
  proxied host tool through without its own card (it does not ask twice); the app is where you are asked.
  The card shows up to 4000 characters of the input; a call whose input is longer than that is **refused** (the agent is told
  to call again with less) rather than run with part of it unseen.
- **Permission modes.** The approval gate for host tools is the app's card, not the thread's permission mode: the app
  does not consult `plan`, `dontAsk` or `bypassPermissions` for a host tool, because it does not trust a mode the daemon
  reports. A tool that requires approval always shows a card. On the daemon side, the mode applies to the daemon's own tools
  as usual (`plan` cannot edit; `dontAsk` denies what is not pre-approved), and the proxied host tools are pre-approved there.
- **When the app is not connected** a call waits up to `hostToolGraceSec` (default 60; config `hostToolGraceSec`, env
  `AGENT_THREADS_HOST_TOOL_GRACE_SEC`) for it to reconnect, then the agent is told, in words, that your computer is not
  connected and that the tool needs it, so it carries on instead of looping. The turn is never held longer than that plus
  `hostToolTimeoutSec` (default 300) for a slow answer. When you reopen the app a transcript row says which host tools were
  unavailable. Nothing is queued: the call is not run later.
- **Choose what is offered.** Settings, Remote daemons, edit, Advanced: switch on "Tools on this computer" for the daemon,
  then list the groups to allow under "Tool groups to allow" (`vault`, `workspace`, `threads`, `skills`, `browser`, `mcp`;
  you can also name one read tool, or one proxied server). Anything unlisted is off. Upgrading from a build where host tools
  were on by default: they are now off until you do this. If the daemon holds its own synced copy of the vault leave `vault`
  off so the agent uses its file tools on the copy (see "Working in the vault"; the two are different views of the same notes).
- **Seat and manifest.** Only the client that holds the thread's read-write seat acts on `tool.call`; a second install or
  a terminal viewing the thread ignores it. The daemon treats a thread as having host tools only while the seat holder is
  the connection that sent the current manifest, so after a terminal claims the seat (`attach --claim`, `run --thread`) a
  call fails after the grace period with the "your computer is not connected" message instead of waiting for an answer
  that cannot come. Results are cut at 100,000 characters (with a marker), images are bounded, and a large screenshot is
  dropped rather than allowed to exceed the frame limit.
- **Your MCP servers.** By default servers that start a program on your computer (stdio), use an address on your computer, or
  need a secret from your keychain cannot work on the daemon and are not sent; a server with headers (usually credentials) is
  sent only if you list it under "MCP servers it may receive". Each dropped server is named in a transcript row with the
  reason. Other http/sse servers the daemon can reach are passed through. To run one of your Settings servers ON the daemon
  (including a stdio server with a keychain secret), opt it in per daemon: see "MCP servers synced from the app".
- **Secrets stay here.** Only tool names, descriptions, schemas and tool *results* cross to the daemon. Keychain values, the
  loopback addresses and capability headers of your Google and OAuth brokers, and the token never do.
- **Limits.** A new proxied server that first appears after a session started needs a new session (tools of servers already
  present update live). `request_secret` stores the value in your keychain; it does not reach the daemon, so the remote
  agent cannot read it. A tool call that was running when the app quit may be re-run after a restart only if the daemon
  still shows it as open.

## Harnesses: Claude, Codex, OpenCode

The daemon hosts all three harnesses side by side. The harness is chosen per session from `spec.harness` (`agent-threads
run --harness codex "..."`; the app sends the thread's harness), and the daemon starts that harness's own CLI for the
session.

| Setting | Meaning |
|---|---|
| `harnesses` (`--harnesses claude,codex`, env `AGENT_THREADS_HARNESSES`, config.json) | Harnesses a client may request. Default: all three. A session for any other harness is refused (`bad_frame`) before anything starts. |
| `harness` (`--harness`, env `AGENT_THREADS_HARNESS`) | The default for `agent-threads run`. Given alone it also restricts the daemon to that one harness (so an old `AGENT_THREADS_HARNESS=claude` keeps meaning Claude only). `--fake-harness` is the scripted test stand-in and ignores the set. |
| `claudeBinaryPath`, `codexBinaryPath`, `opencodeBinaryPath` (`--claude-binary`, `--codex-binary`, `--opencode-binary`; env `AGENT_THREADS_CLAUDE_BINARY`, `_CODEX_BINARY`, `_OPENCODE_BINARY`) | Explicit CLI path. Otherwise PATH, `~/.npm-global/bin`, `~/.local/bin` and `/usr/local/bin` are searched. |

`agent-threads doctor` checks the Codex and OpenCode CLIs for the harnesses in the allowed set (a missing one is a warning). A harness whose CLI is missing does not stop the daemon: startup logs a warning and each `session.open` for it fails with
`<cli> CLI not found: ... set <configKey> / <ENV_VAR>` while the other harnesses keep working. `welcome.capabilities` lists
`harness.<kind>` for every enabled harness plus `harness.<kind>.<feature>` for what it supports (`set_model`,
`set_permission_mode`, `usage`, `context_usage`, `host_tools`, and for Claude `mcp_status` and `session_options`). It lists
what the daemon is configured for, not which CLIs are installed.

**Credentials.** Like Claude, Codex and OpenCode inherit the daemon's environment and HOME and reuse a login made once as
the daemon user. The startup log says which source each harness will use (never the value).

| Harness | Login (as the daemon user) | Environment |
|---|---|---|
| Claude | `claude` | `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`, or the `claude-token` systemd credential |
| Codex | `codex login` (`~/.codex/auth.json`, or `$CODEX_HOME`) | `CODEX_API_KEY` or `OPENAI_API_KEY` |
| OpenCode | `opencode auth login` (`~/.local/share/opencode/auth.json`, plus config in `~/.config/opencode`) | the provider's key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, ...) |

Put keys in the service environment file (`/etc/agent-threads/env` or `~/.config/agent-threads/env`). Only the Claude token
has a systemd `LoadCredential=` form; the others are read from the environment. A Claude token that comes from the
`claude-token` credential file is passed only to Claude sessions, but a key set in the service environment is inherited by
every harness process and by the shell commands they run, so list only keys you are happy for all of them to see. A client cannot set `CODEX_HOME`,
`OPENAI_*`, `CODEX_API_KEY`, `OPENCODE_CONFIG*`, `XDG_CONFIG_HOME` or `XDG_DATA_HOME` through `extraEnvRaw`, even if the
operator lists them in `allowedClientEnv`. The CLIs are not installed by the packaging: install them for the daemon
user (`npm i -g @openai/codex opencode-ai`), or add a layer to the image the same way the Claude CLI is added.

**Daemon tools on every harness.** The daemon's own `claude_threads` tools (the worktree tools) and the tools your app
proxies are offered to each harness in the form it understands: Claude gets in-process MCP servers that follow the live tool
list; Codex gets dynamic tools and OpenCode gets them through its loopback MCP bridge, with the list fixed when the session
starts (a tool that first appears in a later manifest needs a new session). Outside `claude_threads`, a proxied tool is named
`<server>__<tool>` for Codex and OpenCode (they have no per-server namespace of their own). The reserved names
`claude_threads` and `obsidian`, the names of proxied servers, and operator-configured `mcpServers` cannot be taken over by
a client-supplied server on any harness (for OpenCode its bridge name `agent-threads` is reserved too). Operator-configured
and client-supplied MCP servers are mirrored into each harness's own config (Codex `mcp_servers`, OpenCode `mcp`).

**Choosing the harness from Geode.** A remote thread carries the harness picked on the send button (Claude, Codex or
OpenCode); "Run on" is offered for all three. The choice is checked against the daemon's `welcome.capabilities`: a daemon
that does not advertise `harness.<kind>` is shown disabled with the reason (and the harnesses it lacks are disabled once it
is selected), instead of failing at `session.open`. A daemon that advertises no `harness.*` at all is an older one and is
treated as Claude only. A daemon not reached yet is not blocked on a guess: opening the menu connects to it so the
capabilities arrive, and a refusal at open is still reported. The session spec carries `harness` and the per-harness
options the daemon reads (Claude: all of `sessionOptions`; Codex: `effort` from Settings' Codex effort; OpenCode: none;
vetted http/sse MCP servers for all). Claude's default model alias is not sent to Codex or OpenCode. Host-tools text in
the system prompt uses the names the harness sees (`vault_search`, `google-docs__create_doc` for Codex and OpenCode;
`mcp__claude_threads__*` for Claude). Switching harness on a remote thread (hand-off) works like a local one: the old
session is closed on the daemon, the next message opens the new harness there with the conversation summary, and the
daemon never resumes one harness's native session with another.

**What differs by harness.** Claude honours all of `spec.sessionOptions` (thinking, effort, agents, betas). Codex honours
`effort` only; the rest is dropped. OpenCode honours none of it. Neither has native child-agent controls
(`session.sendAgentMessage` / `interruptAgent` are refused for them, as they are today for Claude's local sessions) nor
MCP server status. The Codex goal/skills/agent-profile extras a local Codex thread gets are not set on a daemon session.

**Read-only workspaces per harness.** Edit-tool names differ, so each harness is restricted in its own way: Claude gets
the `Edit`/`MultiEdit`/`Write`/`NotebookEdit` denylist; OpenCode turns that denylist into its native `edit` permission
(`deny`, which covers edit, write and patch); Codex has no per-tool denylist, so its **sandbox is pinned to `read-only`
for the life of the session** (even across a later permission-mode change). That is stronger than for the other two,
because Codex's sandbox also stops shell commands from writing, but it also means Codex cannot write temp files in the
workspace there. For Claude and OpenCode, shell commands are still not blocked. The worktree tools are not offered in a
read-only workspace on any harness. `acceptEdits`, `auto` and `bypassPermissions` are refused there for all three.

## MCP servers that need secrets (daemon-side)

Some MCP servers need a key the daemon must hold itself (a hosted docs server, a database tool). List them in the daemon's
`<data-dir>/config.json` and refer to each secret as `${NAME}`:

```json
{
  "mcpServers": {
    "docs":  { "type": "http", "url": "https://docs.example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } },
    "tools": { "command": "npx", "args": ["-y", "some-mcp-server"], "env": { "API_KEY": "${TOOLS_KEY}" } }
  }
}
```

`type` is `stdio` (the default, with `command`, `args`, `env`), `http` or `sse`. `claude_threads` and `obsidian` are reserved.
A daemon-listed server replaces a same-named server sent by the app (and a same-named synced server; see "MCP servers synced from the app"). They are started for every harness (Claude, Codex, OpenCode).

Secret values are sent with the `creds.push` protocol command (`{ kind, ttlSec, fields }`), which needs an **admin** token.
They are stored on the daemon as `<data-dir>/creds/<kind>.json` (directory 0700, files 0600), never in `config.json` or in a
thread's saved spec, and masked in the daemon's logs. Push them with `agent-threads creds push` (below) or from any admin
client on the wire protocol; there is no settings screen for it yet.

A push replaces the whole kind; pushing no fields removes it; `ttlSec` (0 = no expiry) makes it lapse on its own. Placeholders
are filled when a session starts, so a rotated secret reaches the next session without a daemon restart. A server whose
secret is missing is not started and shows as **failed** ("missing credential NAME").

### Pushing credentials from the CLI

```bash
# values come from the environment (not argv), one kind per push; ttl is seconds or 15m / 24h / 7d
DOCS_TOKEN=... TOOLS_KEY=... agent-threads creds push mcp DOCS_TOKEN TOOLS_KEY --ttl 30d

# or as JSON on standard input
echo '{"DOCS_TOKEN":"..."}' | agent-threads creds push mcp --stdin

# delete a kind (a push with no fields is never sent by accident)
agent-threads creds push mcp --remove
```

Secrets never go on the command line: `NAME=value` arguments are refused (they would show in `ps` and shell history) unless
you pass `--allow-argv`, which warns. A name with no value in the environment or on stdin is a usage error (exit 2) that
names the field. The output lists field names and the expiry, never a value (`--json` prints
`{kind, fields, removed, expiresAt}`). It needs an `admin` token (exit 4 otherwise). A push replaces the whole kind.

Settings, Remote shows each daemon's MCP servers (connected / failed / needs sign-in) as last reported by its sessions;
a server that dies mid-session turns to failed at the end of the next turn.

## MCP servers synced from the app

Settings, MCP lists a **Runs on** line under each Custom MCP server: This computer, plus a checkbox per remote daemon. Ticking
one runs that server on the daemon for every thread there (Claude, Codex and OpenCode alike: the daemon hands one resolved
server map to whichever harness a session uses). Nothing is synced until you tick it.

**What you are asked first.** The first time (and after any later change to the command, arguments, environment, URL or headers)
a dialog shows the exact command and arguments (or the URL), the *names* of environment variables and headers, the daemon, and
the names of the keychain secrets whose values will leave this Mac. A definition you have not confirmed in its current form is
not synced, and the old copy is removed from the daemon.

**What is sent.**

- The definition, over `mcp.sync`, with `${NAME}` placeholders rewritten to `${mcpsync-<project>.NAME}` and left unresolved.
- Exactly the keychain secrets those definitions reference (no others are even read), over `creds.push`, as credential kind
  `mcpsync-global` (or `mcpsync-p-<project>` when the secret is limited to one project). They get a 30 day lifetime, renewed
  when the daemon connects, when a thread starts there more than 12 hours after the last sync, and on every Settings edit. Rotating a secret in Settings reaches the
  daemon's next session. Turning a server off, or removing it, re-syncs the smaller set and deletes a kind that is no longer used.
- Never: oauth servers, anything pointing at an address on this computer (this includes the Google and OAuth proxies), a
  placeholder that is not a stored keychain secret (environment variables of this Mac are never sent), a literal credential
  typed into a header or `*_KEY`/`*_TOKEN` variable (move it to Settings, Secrets), and secrets limited to *different* projects
  in one server (a daemon cannot tell projects apart; a secret limited to one project is allowed, with a warning in the dialog).

**When a toggle is disabled** the reason is shown: the daemon is too old (no `mcp.sync` capability), needs an admin token (the
token stored for a daemon you added must have scope `admin`; the managed local daemon needs nothing, its admin token lives in
its container), the daemon does not accept programs from the app (stdio), the server is OAuth, loopback-only, or uses a secret
that is not stored. With a daemon that is too old nothing changes: dropped servers are dropped with the usual reason.

**Status.** Each ticked daemon shows a chip from what its sessions report (Connected, Needs sign-in, Failed with the daemon's
message). A server whose credential lapsed or was never delivered shows `Failed: missing credential ...` with **Push now**.
`Shadowed by config.json` means the daemon's operator defines a server of the same name, which wins.

**Operator side.**

- `mcp.sync` needs an admin token and replaces the whole synced set. `agent-threads mcp sync --stdin [--clear] [--strict]` does the
  same from a shell: standard input is a JSON object of `name -> definition` (the `mcpServers` shape above) and the output lists
  names and reasons, never a value. Once the app syncs to a daemon it owns that set, so a set made with the CLI is replaced.
- Replace semantics. The accepted servers of a request become the whole set; a name that is absent, or that is rejected now,
  is removed (a rejected name does not keep its old definition: it was superseded by one the daemon refuses, and the client
  has been told it is not running). **Exception: if the request names at least one server and the daemon accepts none, the
  previous set is KEPT unchanged** (`synced-mcp.json` is not rewritten, no `removed` audit entry) and the reply carries
  `kept: true` beside the usual `rejected` reasons. A bad placeholder, a stdio server after the operator turned
  `allowSyncedStdio` off, or an allowlist miss therefore cannot wipe a working set. Audit entry for that case:
  `mcp_sync_rejected` with the rejected names only. `agent-threads mcp sync` prints that the previous set was kept and exits 1
  (`--json` prints the reply, `kept` included); partial rejection exits 0 unless `--strict`.
- Clearing is explicit. `mcp.sync` takes an optional `clear: true` (additive within v1; valid only with an empty `servers`,
  otherwise `bad_frame`). The CLI sends it for `--clear`, and the app sends it whenever its set is empty (the user turned the
  last server off). A daemon from before this field, and this one, also treat an empty `servers` without `clear` as a clear, so
  the shipped app keeps working; `clear` lets a future daemon refuse the unflagged form. The app, on a `kept` reply, shows the
  rejection reasons in the server's sync status instead of "synced", does not record the names as synced, leaves the pushed
  credentials alone (the kept set may still use them) and tries again on the next trigger.
- Definitions are stored in `<data-dir>/synced-mcp.json` (0600) with, per server, the id of the token that synced it and a hash.
  They are never copied into a thread's saved spec (`sessions/<id>.json`). Audit entry: `mcp_sync` with names only.
- `allowSyncedStdio` (config.json, flag-free; env `AGENT_THREADS_ALLOW_SYNCED_STDIO=1`; default **false**) lets stdio definitions
  in: they start a program on this machine as the daemon user. `syncedCommandAllowlist` (bare command names, which match only a
  bare command, or absolute paths, which match only that command) narrows it; note that an allowlisted `npx` can still run any
  package. With the flag off stdio definitions are rejected with a named reason and http/sse are accepted. The daemon advertises
  `mcp.sync` always and `mcp.sync.stdio` when the flag is on. The policy is applied again when a session starts.
- A synced definition may only refer to credentials as `${mcpsync-<project>.NAME}`. A bare `${NAME}` searches every stored kind and
  would let an admin token read the GitHub token or another project's secrets back through a server URL it chooses; the
  daemon refuses such a definition, and a `${...}` inside a stdio `command` (it would bypass the allowlist). `config.json` servers
  keep the bare form: they are operator-trusted.
- Precedence when a session starts, lowest to highest: servers in the session spec, synced servers, `config.json` servers, the
  daemon's own host servers (`claude_threads` and `obsidian` are reserved). A missing or lapsed credential means the server is not
  started and shows as `failed (missing credential mcpsync-<project>.NAME)`.
- The managed local daemon: the app syncs through the container (`agent-threads mcp sync` and `creds push` run inside it with its
  own admin token). Stdio servers need Settings, Remote, "Local daemon: allow MCP servers that start programs", then Update to
  recreate the container.

## Repositories the daemon keeps cloned

A daemon can hold clones of your repositories, so a thread there can start on code without anyone logging in to the
machine. List them in Settings, Remote, edit the daemon, **Repositories** (one per line: `<url> [branch] [as name]`), then
**Save and sync**. Or send `repos.sync` yourself:

```json
{ "type": "repos.sync", "repos": [{ "name": "agent-threads", "url": "https://github.com/me/agent-threads.git", "branch": "main" }] }
```

- **Where.** `<data-dir>/workspace/<name>` (`repoRoot` in `config.json` moves it). That folder is always an allowed
  session folder, whatever `--workspace` says; nothing else under the data directory is (credentials, journals).
- **Stored.** The list lives in the daemon's `config.json` under `repos` (you can also edit it there; it is read at start).
  Removing a repository from the list keeps its clone on disk: it may hold unpushed work.
- **When it syncs.** Immediately on `repos.sync` (the reply says `syncing`; look again with `repos.status`, or pass
  `"wait": true` to hold the reply), when the daemon starts, and when a session starts inside a clone whose last fetch is
  over five minutes old. A sync clones what is missing (into a scratch folder that is renamed on success, so a failed clone
  leaves nothing half-done) and fetches the rest. A clean checkout of the tracked branch is fast-forwarded; a dirty or
  diverged one is only fetched.
- **Private repositories.** Push one fine-grained token (contents and pull requests: write) with
  `GH_TOKEN=... agent-threads creds push github GH_TOKEN`. Git gets it only through the environment of the git process,
  answered by a generated `GIT_ASKPASS` script (`<data-dir>/repos/askpass.sh`, mode 0700, holds no secret) that replies only
  for the hosts of your repositories and github.com. It is never on a command line, in a clone URL or in `.git/config`, and a
  URL that contains credentials is refused. The agent's own process gets the same token as `GH_TOKEN` (for `gh`) plus the
  askpass settings (so `git push` over https works); nothing else does.
  **Durable fallback:** if no pushed credential is live (never pushed, or its TTL lapsed because the host stopped
  refreshing it), the daemon uses its own `GH_TOKEN` / `GITHUB_TOKEN` environment (for example from the systemd
  `EnvironmentFile` or `deploy/compose.env`). A pushed credential always wins while it is valid. The environment token is
  scrubbed from logs and transcripts like any other secret. When neither exists and `gh auth status` fails, a session
  start shows a one-time "GitHub auth unavailable in the daemon" notice in the thread (the probe is cached for 60 s and
  never delays the session).
- **Status** (`repos.status`, `read` scope): `cloned`, `stale` (last good fetch over 24 hours ago, or the last fetch failed),
  `auth failed` (the remote refused the token, or none is stored), `not cloned yet`, `syncing`, or `failed` (any other git
  error, scrubbed of the token). Changing the list needs an `admin` token, like `creds.push`; a `control` token can only look.
- **Local paths.** A repository URL that is a path on the daemon's own disk is refused unless `allowLocalRepoUrls` is true
  in `config.json` (https and ssh remotes only, otherwise).

**Worktrees.** `enter_worktree` on a daemon takes `repoPath` relative to the repo root (`"repoPath": "agent-threads"`) and
creates the worktree under `<repo root>/.worktrees/<repo>/<branch>`. The path the agent names and the git root git finds
for it must both be inside an allowed folder; they are checked before anything is created. A `worktreeRoot` argument from
the agent is ignored here: where worktrees go is yours to set (`worktreeRoot` in `config.json`). Start new work from
`origin/<branch>`, which each fetch updates.

**Pruning.** At daemon start, a worktree under the repo root's `.worktrees` (or your `worktreeRoot`) that nothing has touched
for 14 days (`worktreePruneDays` in `config.json`, `0` = never) is removed with plain `git worktree remove`. Only a worktree
that is also clean, fully pushed and not locked goes; anything else is left and logged. Branches are never deleted.

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
- The `vault_*` / editor tools run in the app on your computer (against the live vault) while it is connected; the session's shell and file tools work on the copy. Turn the `vault` group off for this daemon if you want only the copy.

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
`Write`, `NotebookEdit`; see "Harnesses" for how Codex and OpenCode map this) and refuses the `acceptEdits`, `auto` and `bypassPermissions` modes (Geode's default setting
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
  daemon's acknowledgement says `alwaysAllow: "not_supported"`. Nothing in the journal claims a standing rule. The app does
  not offer it on a remote thread's card either, and an always-allow entry made for a local thread never applies to one.
- A remote thread cannot be forked (Fork conversation and `/fork` are refused with an explanation): a fork is a local
  thread and would start in the daemon's folder on the wrong machine.
- A send the daemon answers with a retryable `conflict` (it is running its maximum number of turns) is retried
  automatically with backoff (1 s doubling to 30 s, six tries). A send whose acknowledgement never comes back within 30 s
  is reported as *unconfirmed*, not "not delivered": the daemon may have run it. The thread stays attached, so what
  actually happened appears when the connection catches up; the daemon ignores a repeat of a message id it already
  accepted, so a retry cannot run a turn twice.
- A journal line that is damaged in the middle of the file is skipped and logged, and the entries after it are kept (the
  file is rewritten without it); only a damaged *tail* is dropped.

- Skills and keychain secrets are not forwarded (PR 9). Host tools need the app connected (see above); there is no queue for tools that were unavailable.
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

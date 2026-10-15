# Remote daemon: run threads on another machine

A thread can run on an `agent-threads` daemon on another machine (a homelab box, a VM) and stream into
Geode. The turn keeps running there when Geode quits; reopening Geode re-attaches and the transcript
completes. This is stage 1 of the daemon design: Geode still owns the transcript, the daemon owns the
process and a replay journal.

What a remote thread has today: the **daemon machine's own tools** (shell, file read/write, search, git worktrees) and
its own `claude` login, plus the tools of your computer proxied back to the app while it is connected ("Tools on your
computer" below). It does not have skills or keychain secrets (later PRs). Claude only. A message sent while a turn is running is held by the
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

# Run the daemon (use tmux/screen for now; a systemd unit comes with the packaging PR).
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
  - *A client lying to the daemon* (a stolen `control` token): it can feed the model any text through a `tool.result`, which is no more power than the same token has through `session.send`. It can only answer calls made for a thread it holds the seat of (call ids are random UUIDs bound to one thread, a repeat or another thread's id is refused), its manifest and results are validated and size-capped (500 tools, 2 MB manifest, results cut at 1 MB, only text and bounded images reach the model), and read-scope tokens cannot send either.
  - *A compromised daemon asking the app to run tools* is the dangerous direction: the app runs your vault, threads, scheduler and browser tools. The app therefore trusts nothing in a `tool.call`. It runs only a tool in the manifest it sent for that thread (exact server and name; anything else is refused and logged), caps input size, calls in flight (8 per thread, 16 overall) and calls per minute (240), and applies the **same approval gate as a local agent** itself (the thread's permission mode and the approval card), whatever the daemon claims happened on its side. The remaining exposure is what you have already allowed: tools your permission mode runs without asking, and always-allow entries, are callable by a hostile daemon exactly as they are by a local agent. Keep the daemon on a machine you trust, turn off groups you do not want it to reach (Settings, Remote daemons, Advanced), and leave `vault` / `threads` / `schedule` off for a daemon you do not fully trust.
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

A remote thread keeps the daemon machine's own tools (shell, file read/write, search) and now also reaches the tools that
only exist in the app on your computer, as long as the app is connected:

| Runs | Tools |
|---|---|
| On the daemon, beside the repo | `enter_worktree`, `exit_worktree`, `set_working_directory` (worktrees go under `<first workspace>/.worktrees`, or `worktreeRoot`) |
| In the app on your computer (proxied) | `vault_*`, `workspace_*`, `host_*` (command palette, Web Viewer), `threads_*`, `Cron*` / `ScheduleWakeup`, `skills_*`, `browser_*`, `request_secret`, `mcp_register_server`, your Google Workspace and OAuth MCP servers (under their own names, for example `mcp__google-docs__*`) |
| Not offered | `enter_vm` / `vm_exec` / `exit_vm` (the daemon machine is the sandbox), `host_exec`, `github_*` (the GitHub connection has no credential on the daemon), `google-drive-files` (its paths are on your computer), tools contributed by other plugins |

The names are the ones a local thread has (`mcp__claude_threads__vault_search`), so always-allow entries and approval rules
carry over. The remote session's system prompt lists exactly which tools run on your computer.

- **Approvals are the same as a local thread.** A tool that needs approval asks you in the app, through the same card and
  permission mode. If you already allowed that tool on the card the daemon opened, that one allow is reused for one call.
- **When the app is not connected** a call waits up to `hostToolGraceSec` (default 60; config `hostToolGraceSec`, env
  `AGENT_THREADS_HOST_TOOL_GRACE_SEC`) for it to reconnect, then the agent is told, in words, that your computer is not
  connected and that the tool needs it, so it carries on instead of looping. The turn is never held longer than that plus
  `hostToolTimeoutSec` (default 300) for a slow answer. When you reopen the app a transcript row says which host tools were
  unavailable. Nothing is queued: the call is not run later.
- **Choose what is offered.** Settings, Remote daemons, edit, Advanced: turn host tools off for a daemon, or turn off groups
  (`vault`, `workspace`, `threads`, `schedule`, `skills`, `misc`, `browser`, `mcp`) or single tools. If the daemon holds its
  own synced copy of the vault you may want `vault` off so the agent uses its file tools on the copy (see "Working in the
  vault"; the two are different views of the same notes).
- **Your MCP servers.** Servers that start a program on your computer (stdio), use an address on your computer, or need a
  secret from your keychain cannot work on the daemon and are not sent; a server with headers (usually credentials) is sent
  only if you list it under "MCP servers it may receive". Each dropped server is named in a transcript row with the reason.
  Other http/sse servers the daemon can reach are passed through.
- **Secrets stay here.** Only tool names, descriptions, schemas and tool *results* cross to the daemon. Keychain values, the
  loopback addresses and capability headers of your Google and OAuth brokers, and the token never do.
- **Limits.** A new proxied server that first appears after a session started needs a new session (tools of servers already
  present update live). `request_secret` stores the value in your keychain; it does not reach the daemon, so the remote
  agent cannot read it. A tool call that was running when the app quit may be re-run after a restart only if the daemon
  still shows it as open.

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
repeat every folder you already use. Edit the unit (find it with `systemctl --user cat agent-threads`, or
`systemctl cat agent-threads` for a system unit) with `systemctl --user edit --full agent-threads`:

```ini
[Service]
ExecStart=
ExecStart=/usr/bin/node /home/user/agent-threads/agent-threads.cjs serve \
  --data-dir /home/user/agent-threads/data --listen 127.0.0.1 --port 7433 \
  --workspace /home/user/projects \
  --workspace /home/user/vault
```

(Keep your existing flags and paths; only add the `--workspace /home/user/vault` line.) Then
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

- Skills and keychain secrets are not forwarded (PR 9). Host tools need the app connected (see above); there is no queue for tools that were unavailable.
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

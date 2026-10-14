# Remote daemon: run threads on another machine

A thread can run on an `agent-threads` daemon on another machine (a homelab box, a VM) and stream into
Geode. The turn keeps running there when Geode quits; reopening Geode re-attaches and the transcript
completes. This is stage 1 of the daemon design: Geode still owns the transcript, the daemon owns the
process and a replay journal.

What a remote thread has today: the **daemon machine's own tools** (shell, file read/write, search) and
its own `claude` login. It does not have the vault/editor tools, your MCP servers, skills, or keychain
secrets (those arrive in later PRs). Claude only. A message sent while a turn is running is held by the
plugin and sent when the turn ends.

## ws:// vs wss:// from Geode (spike result, 2026-10-14)

Measured with the real Geode renderer (v0.27.1, headless, throwaway profile) against a throwaway daemon on
`claude-box` reached over Tailscale:

| Transport | Renderer global `WebSocket` | Node `ws` module in the renderer |
|---|---|---|
| `ws://100.113.251.93:7598` (raw tailnet TCP) | **blocked** | connects, `welcome` received |
| `ws://claude-box:7598` (MagicDNS) | **blocked** | connects |
| `wss://claude-box.taila7fd11.ts.net:8443` (`tailscale serve`) | **blocked** | connects |

Why: the renderer ships `Content-Security-Policy: default-src 'self'; ...` with no `connect-src`, so
`connect-src` falls back to `'self'` and the console reports `Connecting to 'wss://...' violates the
following Content Security Policy directive: "default-src 'self'"`. It is the CSP, not mixed content:
`wss://` is blocked too. Consequence: **the plugin does not use the global `WebSocket` on desktop.** It uses
the bundled Node `ws` package (`src/remote/pluginWebSocket.ts`), which Geode's nodeIntegration renderer
allows, which is not subject to the page CSP, and which sends no `Origin` header, so the daemon's
`--allow-origin` list is irrelevant to it. Both `ws://` and `wss://` work. (The global `WebSocket` is only
used where there is no Node, i.e. mobile.)

Also found on `claude-box`: `tailscaled` runs with `--tun=userspace-networking`, so the machine has **no
tailnet interface**. A daemon cannot bind the Tailscale IP (`EADDRNOTAVAIL`); inbound tailnet traffic only
reaches it through `tailscale serve`. So: run the daemon on `127.0.0.1` and publish it with `tailscale
serve` (needs `sudo` unless `tailscale set --operator=$USER` was run). The existing hub already uses
`https://claude-box...:443`, so use another HTTPS port (8443) rather than touching it.

Recommended: `wss://claude-box.taila7fd11.ts.net:8443` (TLS from Tailscale). Fallback: `ws://claude-box:7598`
via `tailscale serve --tcp` (plain, but inside the WireGuard tunnel).

## Install on claude-box

Build on your Mac from this branch:

```bash
cd ~/.geode/worktrees/agent-threads/feat/remote-threads   # or your checkout of feat/remote-threads
npm ci
npm run build:daemon          # -> dist/agent-threads.cjs (one file, plain node)
npm run build                 # -> dist/main.js, manifest.json, styles.css (the plugin)
scp dist/agent-threads.cjs claude-box:~/agent-threads/agent-threads.cjs
```

On `claude-box` (Node 22+ and a logged-in `claude`; both already there):

```bash
mkdir -p ~/agent-threads/data && cd ~/agent-threads
# one admin token for Geode; shown once, only its hash is stored
node agent-threads.cjs token create --name geode --scope control --data-dir ~/agent-threads/data

# Run the daemon (use tmux/screen for now; a systemd unit comes with the packaging PR).
# --workspace: folders sessions may run in. Add ~/vault if you want threads there.
node agent-threads.cjs serve \
  --data-dir ~/agent-threads/data \
  --listen 127.0.0.1 --port 7433 \
  --workspace /home/rick/projects --workspace /home/rick/vault
curl -s http://127.0.0.1:7433/healthz     # {"ok":true,"protocol":1}

# Publish it on the tailnet as wss:// on 8443 (leaves the hub on :443 alone)
sudo tailscale serve --bg --https=8443 http://127.0.0.1:7433
tailscale serve status
```

Use `--fake-harness` on `serve` for a no-tokens-spent dry run (a scripted stand-in for Claude; send
`/tokens 60 burst=1 delay=40` to watch streaming).

To remove the tailnet exposure: `sudo tailscale serve --https=8443 off`.

## Connect from Geode

1. Install the build: copy `dist/main.js`, `dist/manifest.json`, `dist/styles.css` into
   `<vault>/.geode/plugins/claude-threads/` (never `data.json`), then run **Reload plugin (safe)**.
   Commit and push the branch first (see `process/development.md`, "Dev Builds in the Live Vault").
2. Settings, Remote, **Remote daemons**, **Add daemon**: name `claude-box`, address
   `wss://claude-box.taila7fd11.ts.net:8443`, the token, default folder `/home/rick/projects`.
   **Test connection** should say `Connected: agent-threads <version>, protocol 1`.
3. In the Agents list composer, right-click (or hold) the send button: under **Run on** choose
   `claude-box`, type the folder on that machine, send. The thread shows a `claude-box` badge, the remote
   folder and a connection pill.
4. Quit Geode mid-turn, wait, reopen: the transcript completes without any action.

## States you will see

| Pill | Meaning |
|---|---|
| Connected | socket up |
| Reconnecting | dropped; retrying on the 1s/2s/4s/8s/16s/30s ladder; a running turn continues on the daemon |
| Daemon unreachable | 3+ failed attempts; keeps retrying |
| Protocol too old | plugin and daemon do not speak the same protocol (or the plugin is older than the daemon's minimum); retrying will not help, update the older side |
| Token rejected | the daemon refused the token (Settings, Remote daemons) |

## Known limits of this stage

- Host tools (vault/editor), proxied MCP servers, skills, secrets: not forwarded (PR 7 and PR 9).
- No `resync` reconciliation beyond showing the checkpoint text; replayed messages are stamped with the
  replay time, not the original time (PR 6).
- Deleting a thread in Geode does not delete its daemon-side journal.
- A prompt left on screen after another client answered it, or after a daemon restart, is dismissed by
  answering it; the answer is ignored.
- The e2e: `node scripts/e2e-geode-remote.mts` (hidden Geode against a local `--fake-harness` daemon;
  needs a Geode checkout, `GEODE_REPO`).

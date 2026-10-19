# GitHub via Geode's connection

Threads can use the GitHub account you connected in **Geode → Settings → GitHub**
(Geode ≥ 0.25.0) for `git` over HTTPS, the `gh` CLI, and the GitHub API. No
personal access token is needed. This works on the host and on the managed
[local daemon](remote-daemon.md#local-daemon-this-mac-in-a-container) (threads
started with **Run on: This Mac (container)**). On Obsidian, or on a Geode without
the GitHub connection, nothing changes and your own credentials keep working.

## Setup

1. In Geode, open **Settings → GitHub** and choose **Connect** (device flow).
2. Install the Geode GitHub App on the account/org and repositories you want
   threads to reach. Only repositories the App is installed on are accessible.
3. In Agent Threads settings, **Use Geode GitHub connection** is on by default
   (shown only in Geode).

Then ask a thread to run `github_list_access` (repository names the App can
reach) or `github_check_repo` (`owner/name`, with the install URL when the App
is not installed there).

## What a thread gets

| Where | git (HTTPS, github.com) | `gh` | Commit identity |
| --- | --- | --- | --- |
| Host sessions and their Bash tool | credential helper, added after your existing helpers | wrapper on `PATH`; yields to `GH_TOKEN`/`GITHUB_TOKEN` and to `gh auth login` | env config, only for fields the repo has not set |
| Local daemon (container) | the daemon's `GIT_ASKPASS` script (answers only github.com and your configured repository hosts) | `GH_TOKEN` in the agent's process environment | the daemon user's global `~/.gitconfig`, which a repository's own config overrides |

Commit identity is separate from authentication. The name is your GitHub display
name (falling back to your login). The email is your GitHub **noreply** address,
`ID+login@users.noreply.github.com`, so your real email stays private and
commits are attributed to your account. Override it with **GitHub commit email**
in settings. A repository's own `user.name` / `user.email` always wins.

## What the token is (and is not)

`getToken()` returns a GitHub App **user-to-server token** (`ghu_…`, ~8 hours).
It is **not** limited to one repository: it can reach every repository, in every
installation of the Geode App, that you can access, within the App's permissions
(Contents read/write, Pull requests read/write, Actions read, Metadata read).
Treat any thread that has it as able to act on all of those repositories.
Narrowing it to a single repository would need an installation token from Geode,
which does not exist yet (see Limitations).

## How the token is handled

### Host

- **Never** placed in prompts, tool results, logs, vault files, git config,
  environment variables or command-line arguments.
- It is written to a mode-`0600` file in a per-process mode-`0700` host temp dir.
- A small git credential helper (answers only `https://github.com`) and a `gh`
  wrapper read the file at the moment they are used. `gh` gets `GH_TOKEN` for that
  one process only.
- **Refresh:** Geode refreshes the token when under five minutes remain. Agent
  Threads re-reads it every four minutes, so long threads keep working across the
  8-hour expiry.
- **Lifetime/cleanup:** the file is deleted on plugin unload, when the setting is
  turned off, and whenever a token cannot be obtained.
- **Disconnect / expiry:** on the next refresh the file is removed. Git then prints
  `no GitHub token available. Connect GitHub in Geode…`. Reconnecting recovers
  automatically.

### Local daemon

The daemon already accepts credentials with `agent-threads creds push` (kind
`github`, field `GH_TOKEN`) and hands them to git and to the agent's process
(`daemon/repos.ts`). Agent Threads is the producer
(`src/localDaemon/githubDelivery.ts`):

- Before a message is sent to a thread on the managed daemon (after the daemon is
  running, and only when the last push is more than a minute old), and then every
  four minutes while Geode is open, Agent Threads runs `agent-threads creds push
  github --stdin --ttl 900` **inside the container** (`container exec -i`). The
  token is the exec's stdin; it is never in `argv`, an environment variable, a
  log line or an error message.
- `creds push` needs an admin-scope token. Agent Threads mints one **inside the
  container** (`agent-threads token create --scope admin --save`), which stores
  it as `cli-token` in the daemon's data volume, where the CLI picks it up by
  itself. It never reaches Geode or your keychain. Anything that can read it can
  already read the daemon's journals and credentials (same user), so it adds no
  capability.
- The pushed credential **expires after 15 minutes**. Quitting Geode therefore
  leaves a usable token behind for at most that long. It is also deleted when the
  setting is turned off and on plugin unload.
- A daemon session reads the credential when it starts. A single turn that runs
  longer than the token's own validity (about eight hours) keeps the token it
  started with.
- The commit identity is written once per change with `git config --file
  ~/.gitconfig` as the daemon user (the daemon's home is in its data volume, so
  it survives updates).

## Errors you may see

| Message | Meaning / fix |
| --- | --- |
| `GitHub is not connected…` | Geode → Settings → GitHub → Connect |
| `GitHub authorization expired or was revoked…` | Reconnect in the same place |
| `Geode cannot store GitHub tokens because no OS keychain…` | Geode refuses to store tokens without one |
| `The Geode GitHub App cannot access owner/repo. Grant it at …` | Install the App on that repository (URL included) |
| `…not available in this host (needs Geode ≥ 0.25.0)` | Obsidian / old Geode: use your own `GH_TOKEN` |
| `pushing the token to the local daemon failed…` (debug log) | The daemon is stopped or too old to know `creds push`; start or update it in Settings → Remote → Local daemon |

## Your own credentials still win

On the host the helper is appended after your existing `credential.helper`
entries, so `osxkeychain`, `store`, or a PAT you configured is tried first. The
`gh` wrapper does nothing if `GH_TOKEN`/`GITHUB_TOKEN` is set or you are logged in
with `gh auth login`. Nothing in `~/.gitconfig` or a repository's config is
modified on the host.

## Limitations

- The token is user-wide across the App's installations, not per-repository.
- The App has no permission to read private emails, so the default commit email
  is the noreply address (set an override if you want another).
- Terminal sessions outside Agent Threads are not covered.
- On the host the token file is plaintext (0600) in the OS temp dir while the
  plugin runs, unlike Geode's encrypted keychain store. It is removed on unload.
- Read the GitHub App's permissions above: it can push to any installed repo, so
  keep the App installed only where threads should act.
- Remote daemons you run yourself (other machines) are not given the connection;
  push a token to them yourself with `agent-threads creds push github GH_TOKEN`.

## Verifying by hand

```sh
# On the host, in a thread, after connecting GitHub in Geode
gh auth status
git clone https://github.com/<owner>/<repo>.git && cd <repo> && git log -1 --format='%an <%ae>'

# On the local daemon: the credential the plugin pushed (field names only, never the value)
container exec --user 10001 <agent-threads-local-…> ls /var/lib/agent-threads/creds
```

**Fallback when pushes stop.** The pushed credential expires after 15 minutes
(`GITHUB_CREDS_TTL_SEC`), so a sleeping host or a failed refresh would otherwise leave the
daemon with no token. The daemon then falls back to its own `GH_TOKEN` / `GITHUB_TOKEN`
environment (set it in the service `EnvironmentFile` or `deploy/compose.env`); a valid
pushed credential still takes precedence. If neither exists and `gh auth status` fails, new
sessions show a one-time notice: "GitHub auth unavailable in the daemon: push/PR commands
will fail." Note the environment is read when a session starts, so an already-running
session does not pick up a token that appears later.


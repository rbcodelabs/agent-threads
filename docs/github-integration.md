# GitHub via Geode's connection

Threads can use the GitHub account you connected in **Geode → Settings → GitHub**
(Geode ≥ 0.25.0) for `git` over HTTPS, the `gh` CLI, and the GitHub API. No
personal access token is needed. This works on the host and inside the
[sandbox VM](sandbox-vms.md). On Obsidian, or on a Geode without the GitHub
connection, nothing changes and your own credentials keep working.

## Setup

1. In Geode, open **Settings → GitHub** and choose **Connect** (device flow).
2. Install the Geode GitHub App on the account/org and repositories you want
   threads to reach. Only repositories the App is installed on are accessible.
3. (Sandbox VM) Rebuild the image once so it includes `gh`, and point the
   setting at it: `container build --tag claude-threads-coding:1 sandbox/`.
   Existing installs keep their saved `claude-threads-coding:1` image: git over
   HTTPS still works there, and `enter_vm` tells you `gh` is missing.
4. In Agent Threads settings, **Use Geode GitHub connection** is on by default
   (shown only in Geode).

Then ask a thread to run `github_list_access` (repository names the App can
reach) or `github_check_repo` (`owner/name`, with the install URL when the App
is not installed there).

## What a thread gets

| Where | git (HTTPS, github.com) | `gh` | Commit identity |
| --- | --- | --- | --- |
| Sandbox VM (`vm_exec`) | credential helper | wrapper on `PATH` | container-local `~/.gitconfig` if unset |
| Host sessions and their Bash tool | credential helper, added after your existing helpers | wrapper on `PATH`; yields to `GH_TOKEN`/`GITHUB_TOKEN` and to `gh auth login` | env config, only for fields the repo has not set |

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

- **Never** placed in prompts, tool results, logs, vault files, git config,
  container images, environment variables, command-line arguments, or the
  bind-mounted `/work` directory. `vm_exec` output is additionally scrubbed of
  anything token-shaped.
- It is written to a mode-`0600` file in a mode-`0700` directory: container
  tmpfs (`/dev/shm/claude-threads-github`; when `/dev/shm` is mounted `noexec`, as in the default
  sandbox image, scripts cannot run there, so it falls back to `/tmp/claude-threads-github`) or a
  per-process host temp dir. Inside the VM it travels over the `exec` stdin.
- A small git credential helper (answers only `https://github.com`) and a `gh`
  wrapper read the file at the moment they are used. `gh` gets `GH_TOKEN` for that
  one process only.
- **Refresh:** Geode refreshes the token when under five minutes remain. Agent
  Threads re-reads it every four minutes (and before each `vm_exec`), so long
  threads and long commands keep working across the 8-hour expiry.
- **Lifetime/cleanup:** the file is deleted on `exit_vm`, on plugin unload, when
  the setting is turned off, and whenever a token cannot be obtained.
- **Disconnect / expiry:** on the next refresh the file is removed. Git then prints
  `no GitHub token available. Connect GitHub in Geode…` and the next `vm_exec`
  returns a note with the same instruction. Reconnecting recovers automatically.

## Errors you may see

| Message | Meaning / fix |
| --- | --- |
| `GitHub is not connected…` | Geode → Settings → GitHub → Connect |
| `GitHub authorization expired or was revoked…` | Reconnect in the same place |
| `Geode cannot store GitHub tokens because no OS keychain…` | Geode refuses to store tokens without one |
| `The Geode GitHub App cannot access owner/repo. Grant it at …` | Install the App on that repository (URL included) |
| `…not available in this host (needs Geode ≥ 0.25.0)` | Obsidian / old Geode: use your own `GH_TOKEN` |
| `The gh CLI is not installed in this VM image…` | Rebuild the image (`claude-threads-coding:1`) |

## Your own credentials still win

The helper is appended after your existing `credential.helper` entries, so
`osxkeychain`, `store`, or a PAT you configured is tried first. The `gh` wrapper
does nothing if `GH_TOKEN`/`GITHUB_TOKEN` is set or you are logged in with
`gh auth login`. Nothing in `~/.gitconfig` or a repository's config is modified
on the host.

## Limitations

- The token is user-wide across the App's installations, not per-repository.
- The App has no permission to read private emails, so the default commit email
  is the noreply address (set an override if you want another).
- Terminal sessions outside Agent Threads are not covered.
- A VM that outlives the plugin (reload/quit without `exit_vm`) keeps its last
  token until it expires (≤ 8h); it is no longer refreshed.
- On the host the token file is plaintext (0600) in the OS temp dir while the
  plugin runs, unlike Geode's encrypted keychain store. It is removed on unload.
- Read the GitHub App's permissions above: it can push to any installed repo, so
  keep the App installed only where threads should act.

## Verifying by hand

```sh
# in a thread, after connecting GitHub in Geode
enter_vm
vm_exec  gh auth status   # (uses GH_TOKEN from the wrapper)
vm_exec  git clone https://github.com/<owner>/<repo>.git && cd <repo> && git log -1 --format='%an <%ae>'
```

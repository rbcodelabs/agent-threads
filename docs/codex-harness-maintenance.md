# Updating the local daemon Codex pin

Agent Threads builds the managed local daemon with the exact Codex version in
[`sandbox/codex-version.json`](../sandbox/codex-version.json). The npm package
specifies exact platform-specific binaries. Codex is added when the harness layer
is built on the user's computer.

## Propose a pin update

From an isolated worktree, run:

```sh
node scripts/codex-harness-version.mjs
```

The command reads the public npm `latest` tag for `@openai/codex` and compares it
with the pin. It requires an exact stable version. When a newer stable version is
available, review the [Codex release notes](https://github.com/openai/codex/releases)
and use the same command with `--write` to update the pin. Inspect
`git diff -- sandbox/codex-version.json` before committing. An equal or older
registry version leaves the pin unchanged.

Open a PR with the old and new versions, the upstream release link, and any
compatibility notes. The **Codex harness candidate** PR check builds and tests the
pin on native Linux amd64 and arm64 runners. A maintainer can also run that
workflow manually. Review both job logs and the repository's usual CI before
approving the pin change.

## Verify locally

On a Linux Docker host with Node 22, run the same check using a throwaway image.

```sh
node --test test/integration/codex-harness-maintenance.test.mjs
bash scripts/check-codex-candidate.sh
```

Set `CONTAINER_ENGINE=podman` to run the same check with Podman. The image starts an
isolated daemon and the real Codex app-server. A loopback Responses API fixture
drives two streamed turns, with a session close and a cold resume between them.
The check confirms the exact CLI version, the native session ID, and that the
resumed request includes the prior transcript. The smoke container has only
loopback networking and uses temporary daemon and Codex state. It verifies
protocol compatibility with the fixture. Availability of specific models for a
signed-in account needs a separate authenticated check.

Pin changes follow the ordinary Agent Threads release process. The candidate
workflow builds and removes a local image in each job and leaves installation to
the operator in Local daemon settings.

## Claude and Antigravity

The local daemon uses reviewed CLI versions for Claude Code and Google
Antigravity. The Claude CLI pin is separate from the bundled Agent SDK.
Antigravity is pinned to Google's versioned release archive and SHA-512 for
each supported Linux architecture.

Run `node scripts/managed-harness-versions.mjs` to inspect upstream releases,
or add `--write` to prepare a pin diff for review. The two Antigravity
architectures must agree on the release version.

In Local daemon settings, **Update harnesses** previews the measured and
target versions for the enabled managed harnesses. The idle-only update
replaces the shared container and reuses its named volumes. A failed
startup or version check triggers restoration of the prior image.

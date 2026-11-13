# Building and releasing

Part of the [Agent Threads README](../README.md).

## Building from source

### Peer plugins

Geode/Obsidian peer plugins can discover the generation-scoped Agent Threads API at `app.plugins.plugins['claude-threads']?.api?.v1`. It provides immutable thread operations, sanitized trace projection, constrained runs, host-confirmed MCP registration, and contribution surfaces for artifacts, agent tools, and slash commands. `threads.beginProvisional` adds a reversible create transaction for peer-owned workflows: pending threads cannot run, and rollback removes the thread plus storage allocated through `artifacts.allocateStorage`. Artifacts for Agent Threads (`threads-artifacts`) is the reference peer consumer; Agent Threads itself retains only read-only legacy artifact fallback. `capabilities` is computed from what the host can actually do, so check it before calling. Orchestrator peers can call `orchestrators.list` (each entry reports `enabled`; a disabled Project is always listed, with `threadId: ''` when it has no thread), `orchestrators.dispatch` (optionally with `queueIfBusy`), and `orchestrators.delegateWakeup`, which pauses the built-in wake-up pings for as long as the peer owns them and resumes them automatically if it unloads. See [Peer Plugin API v1](public-api.md) and the checked-in [type contract](../api/public-api-v1.d.ts).

Sibling Geode/Obsidian plugins can also contribute cards, images and self-contained
interactive documents inside assistant replies through
`extensions.registerMessageContentProvider`. The agent places a durable content
reference on its own line, and Threads renders it at that position with
host-owned presentation and named action buttons. Cards stay readable when a
provider is unavailable; streaming and mobile relay views show inert fallbacks.
Embedded documents run in isolated frames with external resources and navigation
blocked. See [Inline message content](public-api.md#inline-message-content)
for registration, reference formatting, lifecycle and image-source details.

```bash
git clone https://github.com/rbcodelabs/agent-threads
cd agent-threads
npm install
npm run build
# Output is in dist/
```

## Releasing

The project uses a worktree-based workflow — edits directly to the main checkout are blocked by a git hook. Follow these steps:

1. **Create a worktree** for the version bump:
   ```bash
   git worktree add ~/.geode/worktrees/agent-threads/chore/bump-version-X.Y.Z -b chore/bump-version-X.Y.Z
   cd ~/.geode/worktrees/agent-threads/chore/bump-version-X.Y.Z
   ```

2. **Bump the version** with the repository workflow. This updates `package.json`, `package-lock.json`, and `manifest.json`, then syncs `versions.json`. Update the README version badge to the same version and verify all five files agree:
   ```bash
   npm version X.Y.Z --no-git-tag-version
   npm run sync-versions
   npm run check-versions
   # Confirm the README badge also says X.Y.Z.
   git add manifest.json package.json package-lock.json versions.json README.md
   git commit -m "chore: bump version to vX.Y.Z"
   git push -u origin chore/bump-version-X.Y.Z
   ```

3. **Open and squash-merge a PR** for the version bump:
   ```bash
   gh pr create --title "chore: bump version to vX.Y.Z" --body "Version bump." --base main
   gh pr merge <number> --squash --delete-branch
   ```

4. **Pull main and push the tag** to trigger the release workflow:
   ```bash
   git pull origin main
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. That's it. The [release workflow](../.github/workflows/release.yml) verifies the tag and committed `versions.json`, builds the plugin, and publishes a GitHub release with `main.js`, `styles.css`, `manifest.json`, and `versions.json` attached — BRAT will pick it up within a few minutes.


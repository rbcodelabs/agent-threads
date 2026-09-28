# Claude Code — obsidian-claude-threads

An Obsidian plugin that runs multi-threaded Claude Code sessions inside the vault, with an MCP server so agents can coordinate across threads.

## Process Docs

Full step-by-step guides live in `process/` (also available as an Obsidian vault bridge):

| Guide | Contents |
|---|---|
| [`process/development.md`](process/development.md) | Worktree workflow, quality gate, unit tests, screenshot tests |
| [`process/release.md`](process/release.md) | Full release checklist — merge PRs, bump version, tag, auto-publish, PR comments, thread cleanup |
| [`process/architecture.md`](process/architecture.md) | Key files, Thread type fields, MCP serialization pattern, DispatchInput footer convention |

## Quick Reference

**Before any code change:** create a worktree — never edit the main checkout directly.

**Before every push:** invoke the `pr-checklist` skill (`Skill: "pr-checklist"`). Gate: `npx tsc --noEmit && npm test`, locally or on dev-builder when the Mac is loaded. **Do not run the screenshot suite on the Mac** — baselines are Linux renders and a Mac render never matches. Run screenshots on dev-builder with `npm run test:screenshots:remote` (`:remote:update` to regenerate), or trust the PR's "Screenshot Tests" CI job. If dev-builder is unreachable, a local Mac run is advisory only. See "Screenshot Tests" in `process/development.md`.

**Before deploying a dev build to the live vault:** commit and push the branch first (draft PR is fine). The next BRAT release update overwrites the installed plugin — an uncommitted dev build is the only copy of the work and it silently evaporates. See "Dev Builds in the Live Vault" in `process/development.md`.

**After every release:** post "Shipped in vX.Y.Z" on each merged PR; archive threads whose `prUrl` matches a shipped PR via `obsidian_archive_thread`.

**Plugin type:** Obsidian desktop + mobile. Build with `npm run build`. Artifacts in `dist/`. Released via GitHub Actions on tag push — do not manually upload artifacts.

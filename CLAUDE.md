# Claude Code — agent-threads

A Geode (Obsidian-compatible) plugin that runs multi-threaded Claude Code sessions inside the vault, with an MCP server so agents can coordinate across threads.

## Process Docs

Full step-by-step guides live in `process/` (also available as an Obsidian vault bridge):

| Guide | Contents |
|---|---|
| [`process/development.md`](process/development.md) | Worktree workflow, quality gate, unit tests, screenshot tests |
| [`process/release.md`](process/release.md) | Full release checklist — merge PRs, bump version, tag, auto-publish, PR comments, thread cleanup |
| [`process/architecture.md`](process/architecture.md) | Key files, Thread type fields, MCP serialization pattern, DispatchInput footer convention |

## Quick Reference

**Before any code change:** create a worktree — never edit the main checkout directly.

**Before every push:** invoke the `pr-checklist` skill (`Skill: "pr-checklist"`). Gate: `npx tsc --noEmit && npm test`, locally or on dev-builder when the Mac is loaded. **Screenshots:** prefer dev-builder (`npm run test:screenshots:remote`, `:remote:update` to regenerate) because baselines are Linux renders. **If dev-builder is unreachable, always run the suite locally instead of skipping it.** A Mac render won't match the Linux baselines, so treat it as a visual QA artifact (inspect the images) and don't commit baselines regenerated on the Mac; the PR's "Screenshot Tests" CI job stays the baseline authority. See "Screenshot Tests" in `process/development.md`.

**Before deploying a dev build to the live vault:** commit and push the branch first (draft PR is fine). The next BRAT release update overwrites the installed plugin — an uncommitted dev build is the only copy of the work and it silently evaporates. See "Dev Builds in the Live Vault" in `process/development.md`.

**After every release:** post "Shipped in vX.Y.Z" on each merged PR; archive threads whose `prUrl` matches a shipped PR via `obsidian_archive_thread`.

**Default host is Geode, not Obsidian.** Verify and word user-facing test steps around Geode: the plugin lives at `<vault>/.geode/plugins/claude-threads/`, enabled via `<vault>/.geode/plugins.json`. For hidden real-app runs use `~/projects/geode` with `GEODE_HEADLESS=1` and a throwaway `--user-data-dir` (pattern in its `tests/e2e/threads-projects.spec.ts`; CDP probe `scripts/cdp-probe.mts`; clean up with `npm run e2e:kill`). Mention Obsidian/BRAT only for behaviour that is specifically Obsidian-compat.

**ADRs live in Compass, not the repo.** File new ADRs as Compass Docs (check the product pm-config first). When touching an old `docs/adr/*` file, migrate it to Compass and leave a pointer instead of editing in place.

**Prefer SDK-native patterns over timers.** For thread lifecycle / state-tracking bugs (stuck "working", lingering sessions, missed edge events), don't add another timer, backstop delay or heuristic. First look for a native Claude Agent SDK mechanism (e.g. a long-lived streaming query per thread) that removes the need to guess; only fall back to a timer if none exists, and say so explicitly.

**Bundled container runtime.** The Apple `container` CLI ships with the plugin (`src/sandboxRuntime.ts`) at `~/Library/Application Support/claude-threads/runtime/<ver>/bin/container` (v1.5.0 at time of writing), not on PATH. An empty `which container` is expected; check that dir and `container ls -a` before claiming the runtime is missing.

**Plugin type:** Obsidian desktop + mobile. Build with `npm run build`. Artifacts in `dist/`. Released via GitHub Actions on tag push — do not manually upload artifacts.

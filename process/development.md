# Development Workflow

## Worktree Workflow (Required)

Never edit files in the main checkout. Always work in a git worktree:

```bash
# 1. Create worktree on a new branch
git -C ~/projects/obsidian-claude-threads \
  worktree add ~/.geode/worktrees/obsidian-claude-threads/<branch> -b <branch>

# 2. Commit the first meaningful change immediately — do not accumulate
#    uncommitted work (see "Commit early" below)
# 3. Push branch, open PR — leave worktree in place until the PR merges
```

`enter_worktree` uses this same location automatically (`~/.geode/worktrees/<repo>/<branch>`,
overridable via **Settings → Worktree location**). The root is named for the app, not a
harness, because Codex sessions call `enter_worktree` just as Claude sessions do.

### Commit early — worktrees are not backups

Uncommitted work in a worktree has exactly one copy, and several routine things
delete worktrees: `exit_worktree`, the `worktree-cleanup` skill, and the Agent
tool's auto-cleanup.

Historically the worst offender was storage: worktrees were created under
`os.tmpdir()`, which macOS **clears on reboot**. That is not a grace-period
reaper — the next restart takes everything, silently. A full feature
implementation was lost this way (see the `feat/per-thread-persistence`
post-mortem): the branch was created, the work was finished, nothing was ever
committed, and a reboot ~6 hours later erased it. `git reflog` showed the branch
with zero commits.

The default root is now durable, which removes the reboot hazard — but the rule
stands regardless of location:

- **Commit before any verification/QA phase begins.** "Implementation complete,
  uncommitted, no push" is a blocker, not a status line.
- **Push the branch (draft PR is fine) before deploying a dev build anywhere.**

Branch naming conventions:
- `feat/<short-description>` — new features
- `fix/<short-description>` — bug fixes
- `chore/<description>` — version bumps, tooling, docs
- `docs/<description>` — documentation only

---

## Quality Gate (Before Every Push)

Run all three checks before pushing. The PostToolUse hook will remind you if you forget.

```bash
cd <worktree-path>
npx tsc --noEmit          # type-check (esbuild strips types silently — TSC catches the real errors)
npm test                  # unit tests via vitest
npm run test:screenshots  # Playwright screenshot tests (2 intentional skips are normal)
```

Pass criteria: zero type errors, all unit tests green, screenshot count unchanged (or new tests added for new UI).

---

## Test Vaults

For live integration testing, spin up an isolated Obsidian vault with the current plugin build:

```bash
npm run vault           # build + create test vault (first time)
npm run vault:update    # rebuild + re-copy dist into existing vault
npm run vault:open      # build + create + open in Obsidian
```

Each worktree branch gets its own vault at `~/.claude/test-vaults/ct-<branch-name>/`.
Vaults are pre-seeded with `Testing Notes.md` and `Branch Changes.md`.
Multiple test vaults can be open in separate Obsidian windows simultaneously.

**First open:** Obsidian will prompt to enable community plugins once per vault. Click "Turn off Restricted Mode."

**Iteration workflow:**
1. Make code changes in the worktree
2. Run `npm run vault:update` to rebuild and re-copy
3. In Obsidian, run **Reload app without saving** (Cmd+R) to pick up the new build

---

## Dev Builds in the Live Vault

Sometimes a feature needs to be tested in the real vault rather than a test vault.

**Get the target directory right — it is host-specific, and the wrong one fails silently.** The plugin appears to deploy, the app is restarted, and the feature simply is not there:

| Host | Plugin directory |
|---|---|
| **Geode** | `<vault>/.geode/plugins/claude-threads/` |
| Obsidian | `<vault>/.obsidian/plugins/claude-threads/` |

Both directories usually exist in the same vault, and both can contain a `claude-threads` install, so the presence of one proves nothing about which the running app loads. Confirm before copying:

```bash
# Which vault is Geode actually in?
cat ~/Library/Application\ Support/geode/geode.json   # → lastVault
# Which install is live? Compare mtimes; the running host writes data.json constantly.
ls -la "<vault>/.geode/plugins/claude-threads" "<vault>/.obsidian/plugins/claude-threads"
```

Also resolve `<vault>` against the real vault root. On the primary machine that is the iCloud path (`~/Library/Mobile Documents/com~apple~CloudDocs/Documents/Personal`); `~/Documents/Personal` is a *different* directory that shadows it, so writes there land somewhere nothing reads.

After copying, verify by grepping the installed bundle for a string unique to the change rather than trusting the copy:

```bash
grep -c "someNewSymbol" "<vault>/.geode/plugins/claude-threads/main.js"
```

Copy only `main.js`, `manifest.json`, and `styles.css`. **Never copy `data.json`** — it is live settings and conversation state, written continuously by the running app.

**Rule: commit the work and push a branch (draft PR is fine) BEFORE copying a dev build into the live vault.** The installed plugin is overwritten by the next BRAT release update — an uncommitted dev build is the only copy of the work, and it silently evaporates.

This is not hypothetical: the footer model switcher was built, deployed to the live vault for testing, and never committed. The v0.15.2 release overwrote it, and it had to be rescued from a stale worktree's uncommitted diff (#217).

Checklist when deploying a dev build:
1. `git add` + `git commit` in the worktree
2. `git push -u origin <branch>` (open a draft PR if review isn't ready)
3. Then copy `dist/` into the live vault for testing

---

## Reloading the Plugin Safely

Reloading the plugin while agent threads are running kills them immediately.  Use the **"Reload plugin (safe)"** command (command palette) instead of toggling the plugin in Settings:

- **No active threads** → reloads immediately (same as toggling off/on)
- **Active threads present** → shows a modal listing the running threads with three options:
  - **Cancel** — dismiss, do nothing
  - **Interrupt & Reload** — sends interrupt to all threads and waits up to 30 s for clean shutdown before reloading
  - **Force Reload** — reloads immediately, killing all threads (same as the old behavior)

For unguarded reloads triggered by manifest edits (hot-reload) or toggling in Settings, `onunload()` provides a best-effort 10-second graceful shutdown: it interrupts all sessions and waits for them to drain before proceeding.

---

## Unit Tests

```bash
npm test
```

Located in `test/unit/`. Use vitest. Mock Obsidian APIs are in `test/mocks/`.

When adding a new MCP tool or modifying serialization logic, add a corresponding test file in `test/unit/`.

---

## Screenshot Tests

```bash
npm run test:screenshots          # verify snapshots unchanged
npm run test:screenshots:update   # regenerate snapshots (run before a release)
```

Located in `test/screenshots/`. Uses Playwright against a headless harness in `test/harness/`.
Snapshots are committed to `test/screenshots/snapshots/` and copied to `docs/*.png` on update.

The harness renders the plugin against mock data in `test/harness/fixtures.ts` — it cannot test flows that require a live Claude session (PTT, background tasks, etc.). Those are noted as intentional skips in the spec.

New UI states need both a fixture entry and a new test case in `test/screenshots/ui.spec.ts`.

### Harness icons

Harness icons are generated, not hand-written. `scripts/gen-harness-icons.mts`
scans `src/` for icon names, pulls each glyph from the exactly-pinned
`lucide-static` dependency, and writes `test/harness/lucide-icons.generated.ts`
(committed, so `tsc` and editors stay happy). The generator runs automatically
at the top of `test/harness/esbuild.mjs`, so it fires on `npm run build:harness`
and therefore on both `pretest:screenshots` hooks — the map cannot drift from
`src/`. Run it directly with `npm run gen:harness-icons`.

A new icon name in `src/` is picked up on the next harness build with no manual
step. Names the scan genuinely cannot see — built by string concatenation, say —
go in the `EXTRA_ICONS` array at the top of the generator.

Unknown names fail loudly rather than degrading quietly. `setIcon()` in
`test/harness/obsidian-mock.ts` draws a magenta crossed square, logs a warning,
and records the name on `window.__ctMissingIcons`; an `afterEach` hook in
`test/screenshots/ui.spec.ts` fails the run and names the offender. This
replaces a grey-circle fallback that read as a legitimate glyph and let 46
unmapped icons sit in the baselines unnoticed.

`test/harness/obsidian-base.css` carries the `--icon-*` variables and the
`svg.svg-icon` sizing rule extracted from the real Obsidian `app.css`. It must
be linked immediately *before* `styles.css` in every harness HTML page: the two
rulesets have equal specificity, so the plugin's has to come second to win, the
same way app.css loads before a plugin's styles.css in the real app.

**Known limitations.** The harness approximates Obsidian, it does not reproduce
it. The pinned `lucide-static` version is not guaranteed to match the Lucide
version Obsidian bundles — Obsidian still ships older names such as
`lucide-alert-circle` — so a glyph can differ in detail from what users see.
`obsidian-base.css` is a small hand-maintained subset of app.css, not the whole
stylesheet. And icons the plugin registers through `addIcon()` in `src/main.ts`
are resolved from Lucide here, because the harness mounts views directly and
never runs the plugin's `onload()`.

### Harness entry points

Each top-level view that doesn't fit the main conversation harness gets its own
bundle + HTML page. To add one: create `test/harness/<name>-index.ts` (mount the
view against fixtures, expose it on `window`), a `<name>.html` (copy an existing
page, point `<script>` at `dist/<name>-bundle.js`, size `#app` for the view), and
add a `build()` block in `test/harness/esbuild.mjs`. Current pages:

| Page | Bundle | View |
|---|---|---|
| `index.html` | `bundle.js` | `ThreadsView` (conversation) |
| `skills.html` | `skills-bundle.js` | `SkillsManagerView` |
| `settings.html` | `settings-bundle.js` | settings tabs |
| `kanban.html` | `kanban-bundle.js` | `KanbanView` (status board + folder swimlanes) |

Running/awaiting state isn't stored on `Thread` — it lives in the
`ThreadManager`'s private `sessions` / `pendingPermissions` maps. The kanban
harness seeds those directly (see `kanban-index.ts`) to populate the Working and
Awaiting columns deterministically.

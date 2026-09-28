# PR Guidelines — obsidian-claude-threads

## Commands

| Task | Command |
|---|---|
| Type-check | `npx tsc --noEmit` |
| Unit tests | `pnpm test` |
| Screenshots, from a Mac (runs on dev-builder) | `npm run test:screenshots:remote` |
| Update screenshots (runs on dev-builder) | `npm run test:screenshots:remote:update` |
| Screenshots, already on Linux / in CI | `npm run test:screenshots` |
| Build | `pnpm build` |

## Coverage Requirements

- All existing tests must pass — do not skip or delete tests
- New unit tests for any new utility functions added
- Screenshot tests cover desktop views only; mobile changes verified manually on device

## Visual Verification

Whenever any UI file is touched, verify at these viewports before opening a PR:

- **Desktop:** 1280x800 (Playwright screenshots cover this automatically)
- **Mobile:** 390x844 (iPhone 14 portrait) — manual verification on device or Obsidian mobile simulator
- **Mobile SE:** 375x667 (iPhone SE) — verify no overflow on narrow screen when touching mobile CSS

For each viewport, confirm:
- [ ] Layout is not broken (no overflow, no collapsed sections)
- [ ] Interactive elements are reachable and usable (44px minimum tap targets)
- [ ] No visual regressions from the diff

## Docs Location

User-facing docs live in `docs/` and `README.md`. Update any doc page related to changed features.

### Public Docs Site (claude-threads-site) — Maintenance Gate

The plugin also has a public docs site in a separate repo, `claude-threads-site`
(`src/content/docs/**`). **Any PR that changes user-facing plugin
behavior** — a new feature, a changed flow, a renamed setting, an
added/removed command, or any UI surface a user would notice — **must update
or create the corresponding page(s)** in `claude-threads-site/src/content/docs/`
before the PR here is considered done. It doesn't have to land in the same
commit or even the same PR, but it must happen in the same work session — do
not merge a behavior-changing PR and leave the public docs describing the old
behavior.

If the change has no user-visible effect (internal refactor, test-only
change, etc.), note that explicitly in the PR description instead of skipping
this silently.

## Screenshot Tooling

Baselines are platform-neutral Linux renders from the pinned Playwright container. **Never run or regenerate them on the Mac** — a Mac render never matches. Run `npm run test:screenshots:remote:update` (dev-builder) after any desktop UI change to regenerate committed screenshots. Do NOT update screenshots for mobile-only CSS changes (the Playwright tests run against the desktop view).

## Project-Specific Gates

- `npx tsc --noEmit` must be clean (strict mode, no errors)
- All Vitest unit tests must pass: `pnpm test`
- Playwright screenshot tests must not regress: `npm run test:screenshots:remote` on dev-builder, or the PR's "Screenshot Tests" CI job. If dev-builder is unreachable, a local Mac run is advisory only — say so in the PR and rely on CI
- For mobile-only changes: screenshot tests still run to confirm desktop is unaffected
- Build must succeed: `pnpm build`

### Cross-Repo CSS Gotcha: Tailwind v4 `@layer components` (Astro docs site)

This plugin repo doesn't ship Tailwind CSS itself, but its docs live in the
`claude-threads-site` Astro repo, which does — and a Tailwind v4 + Astro
pattern has bitten that repo twice, so it's worth knowing if you ever touch
CSS there while syncing docs for a plugin change:

**The gotcha:** in Tailwind v4, custom/plain CSS rules placed *outside*
`@layer components` can silently beat Tailwind utility classes (e.g.
`hidden`) **regardless of source order**. Cascade layers give unlayered CSS
higher priority than any `@layer`-wrapped CSS, so a plain selector written
*after* a utility class in the file can still lose if the utility is itself
inside a layer — and just as often, a plain selector written *before* a
`@layer components` rule will still win over it. Source order intuition from
plain CSS doesn't apply once layers are involved.

**Where this bit us:**
1. A nav CTA button using `hidden sm:inline-flex` stayed visible on mobile
   because a custom component rule for the button lived outside
   `@layer components` in `global.css`.
2. The mobile table-scroll rule for rendered docs content
   (`.docs-content table { display: block; overflow-x: auto; ... }` inside a
   `@media (max-width: 640px)` block in `src/styles/global.css`) had the same
   problem during the claude-threads-site PR #2 docs build-out — it needed to
   be moved inside `@layer components` for the mobile overflow fix to
   actually apply.

**Fix / rule going forward:** always put custom component CSS classes inside
`@layer components` in `global.css`. This is already documented as the
authoritative pattern in `claude-threads-site`'s own guidelines — see
`claude-threads-site/.claude/pr-guidelines.md` (Visual Verification section)
for the canonical writeup. This section exists here only so contributors
working across both repos (plugin + docs site) don't rediscover the same bug
a third time.

## Final PR Checklist

### QA evidence in the PR

Use `.github/pull_request_template.md` and make the PR description self-contained:

- Summarize the behavior checked and the observed outcome. List checks actually run with pass/fail counts, intentional skips, and limitations. For existing failures, include the unchanged comparison commit and reproduction evidence; do not describe the suite as passing.
- For UI changes, embed representative screenshots with Markdown image syntax so reviewers can see them in the PR. Label each image with its viewport, UI state, and capture source (for example, Playwright harness or live Obsidian). Use synthetic fixtures and check images for private content before publishing.
- For committed PNGs, use a commit-pinned URL such as `https://raw.githubusercontent.com/rbcodelabs/obsidian-claude-threads/<full-commit-sha>/<path-to-image.png>`. Images must match the reviewed behavior; refresh their links when the pictured UI changes.
- Local filesystem paths, vault notes, and descriptions of images are not substitutes for rendered screenshots or QA outcomes. A vault report may supplement the PR, but reviewers must not need vault access.
- Distinguish harness coverage from live-app or device verification. Claim only checks actually performed. For changes without UI impact, mark screenshots **N/A** and briefly explain why.

Present this as a completed checklist before opening any PR. Every item is mandatory — do not open a PR until all are checked:

- [ ] `npx tsc --noEmit` — no errors
- [ ] `pnpm test` — all passing, new tests written for new logic
- [ ] Screenshots — no regressions (`npm run test:screenshots:remote` on dev-builder, or the PR's Screenshot Tests CI job is green)
- [ ] `pnpm build` — clean build
- [ ] **README.md / docs/ updated** — any new user-facing behavior or UI change is documented; if you touched a feature, re-read the relevant README section and update it
- [ ] **claude-threads-site docs updated** — if this PR changes user-facing plugin behavior, the corresponding page(s) in `claude-threads-site/src/content/docs/` are updated or created (or the PR description explicitly states no public doc page is affected)
- [ ] Screenshots regenerated (`npm run test:screenshots:remote:update`) if desktop UI changed
- [ ] PR includes self-contained QA outcomes and rendered, labeled screenshots for UI changes (or an explicit N/A reason)
- [ ] PR title and description explain the *why*, not just the *what*

# Thread lifecycle review-state evidence

Captured 2026-09-23 using the local Playwright harness and synthetic fixtures on
`fix/orchestrator-lifecycle`, based on `fcde666` (v0.44.0). The captures show the
rendered result after `reviewed_changed` moves “Draft Q3 planning notes” from New
to Reviewed/Done without navigation or a recency change.

| Capture | Viewport | State |
| --- | --- | --- |
| `list-desktop.png` | 1280 × 800 | Agents List, reviewed |
| `list-mobile.png` | 390 × 844 | Agents List, reviewed |
| `board-desktop.png` | 1280 × 800 | Agent Board, reviewed |
| `board-mobile.png` | 390 × 844 | Agent Board, reviewed |

Reproduce with `pnpm build:harness` then
`pnpm exec playwright test test/screenshots/public-review.spec.ts`.
These are local harness captures, not live-app or device verification.

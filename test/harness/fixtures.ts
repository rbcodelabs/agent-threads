import type { Thread, ChatMessage, Project } from '../../src/types';

// Timestamps: Thread 1 most recent (active by default), Thread 3 oldest.
// Pinned to a fixed wall-clock time so screenshot baselines are stable
// across runs — never use Date.now() here.
const EPOCH = new Date('2026-01-15T10:00:00Z').getTime();
const T1 = EPOCH - 5 * 60 * 1000;      // 9:55 AM UTC
const T2 = EPOCH - 45 * 60 * 1000;     // 9:15 AM UTC
const T3 = EPOCH - 2 * 60 * 60 * 1000; // 8:00 AM UTC

// ─── Thread 1: Fix auth middleware ───────────────────────────────────────────

const thread1Messages: ChatMessage[] = [
  {
    id: 'msg-t1-1',
    role: 'user',
    content: 'The auth middleware is throwing 401s in staging but not locally. Can you take a look?',
    timestamp: T1 + 0,
  },
  {
    id: 'msg-t1-2',
    role: 'assistant',
    content: `I found the issue. The \`JWT_SECRET\` environment variable isn't set in staging, causing token verification to fail silently.

**Root cause** in \`src/middleware/auth.ts\`:

\`\`\`typescript
// Before (broken — falls back to empty string, always invalid)
const secret = process.env.JWT_SECRET || '';
const decoded = jwt.verify(token, secret); // never throws, always fails

// After (correct — fail fast on startup)
const secret = process.env.JWT_SECRET;
if (!secret) throw new Error('JWT_SECRET is not set');
const decoded = jwt.verify(token, secret);
\`\`\`

The empty-string fallback means \`jwt.verify\` runs with \`''\` as the secret, which always produces an invalid signature error — exactly what you're seeing as 401s.

**Fix:** Add \`JWT_SECRET\` to your Vercel staging environment variables:
1. Go to your Vercel project → Settings → Environment Variables
2. Add \`JWT_SECRET\` with a strong random value (e.g., \`openssl rand -base64 32\`)
3. Make sure it's scoped to the **Preview** environment
4. Redeploy to pick up the new variable`,
    timestamp: T1 + 90000,
    toolCalls: [
      { name: 'Read', summary: 'Read: src/middleware/auth.ts' },
      { name: 'Read', summary: 'Read: .env.example' },
    ],
    cost: 0.0023,
    summary: 'Found JWT_SECRET missing in staging; fixed auth.ts to fail fast and documented the Vercel env var steps.',
  },
  {
    id: 'msg-t1-3',
    role: 'user',
    content: 'Perfect. Can you also add a test for this?',
    timestamp: T1 + 3 * 60 * 1000,
  },
  {
    id: 'msg-t1-4',
    role: 'assistant',
    content: `Added a test suite in \`src/middleware/__tests__/auth.test.ts\`:

\`\`\`typescript
import { verifyAuth } from '../auth';

describe('auth middleware', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('throws on startup when JWT_SECRET is missing', () => {
    delete process.env.JWT_SECRET;
    expect(() => verifyAuth('any-token')).toThrow('JWT_SECRET is not set');
  });

  it('returns decoded payload for a valid token', () => {
    process.env.JWT_SECRET = 'test-secret-do-not-use';
    const token = jwt.sign({ userId: 42 }, 'test-secret-do-not-use');
    const result = verifyAuth(token);
    expect(result.userId).toBe(42);
  });

  it('throws for an invalid token', () => {
    process.env.JWT_SECRET = 'test-secret-do-not-use';
    expect(() => verifyAuth('bad.token.here')).toThrow();
  });
});
\`\`\`

Run with \`npm test -- --testPathPattern=auth\` to verify. All three cases should pass once you apply the fix from the previous message.`,
    timestamp: T1 + 5 * 60 * 1000,
    toolCalls: [
      { name: 'Write', summary: 'Write: src/middleware/__tests__/auth.test.ts' },
      { name: 'Edit', summary: 'Edit: src/middleware/auth.ts' },
    ],
    cost: 0.0041,
    summary: 'Added three-case Jest test suite for auth middleware covering missing secret, valid token, and invalid token.',
  },
  {
    id: 'msg-t1-5',
    role: 'user',
    content: 'Can you show me what the logo looks like?',
    timestamp: T1 + 6 * 60 * 1000,
  },
  {
    id: 'msg-t1-6',
    role: 'assistant',
    content: 'Here is the logo file:',
    timestamp: T1 + 7 * 60 * 1000,
    toolCalls: [
      { name: 'Read', summary: 'Read: assets/logo.png' },
    ],
    toolResultImages: [
      // 4×4 teal PNG — minimal valid image for screenshot fixture
      { mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAD0lEQVR4nGNgaGhAIOI4AJhDEAHnXAP7AAAAAElFTkSuQmCC' },
    ],
    cost: 0.0008,
    summary: 'Displayed the logo PNG inline.',
  },
];

// ─── Thread 2: HipTrip feature brainstorm ────────────────────────────────────

const thread2Messages: ChatMessage[] = [
  {
    id: 'msg-t2-1',
    role: 'user',
    content: '/brainstorm What are some ways we could make trip planning more social?',
    timestamp: T2 + 0,
  },
  {
    id: 'msg-t2-2',
    role: 'assistant',
    content: `Here are some high-leverage ideas for making HipTrip more social, ranked by impact/effort:

| Feature | Impact | Effort |
|---|---|---|
| **Trip co-planning** — shared drafts with real-time cursors (like Figma for itineraries) | High | High |
| **"Going too?" social layer** — see which friends have saved the same destination, nudge to coordinate | High | Medium |
| **Public trip reviews** — after a trip, publish a structured recap with places rated by vibe, not stars | Medium | Low |
| **Curated packs** — let power users publish themed trip packs (e.g., "Best 48h in Lisbon for jazz lovers") | High | Medium |

**My top pick:** the social-layer nudge feature. It has a viral loop (you see a friend's saved destination → you reach out → they invite you → you both have a better trip → you both post recaps) with relatively low infrastructure cost since you're just indexing existing saves.

The co-planning feature is the most ambitious but could be a real differentiator — no one does async collaborative itinerary editing well right now.`,
    timestamp: T2 + 60000,
    summary: 'Proposed four social features for HipTrip; recommended the "Going too?" destination-matching nudge as the best impact/effort pick.',
  },
];

// ─── Thread 3: Empty / freshly created ───────────────────────────────────────

const thread3Messages: ChatMessage[] = [];

// ─── Thread 4: Agentic run — consecutive assistant messages ──────────────────
// Used by compress-view screenshot tests: grouping consecutive assistant
// messages into a single collapsible block requires 2+ in a row.

const thread4Messages: ChatMessage[] = [
  {
    id: 'msg-t4-1',
    role: 'user',
    content: 'Refactor the database module to use connection pooling.',
    timestamp: T3 + 0,
  },
  {
    id: 'msg-t4-2',
    role: 'assistant',
    content: `Starting the refactor. Let me read the current implementation first.`,
    timestamp: T3 + 10000,
    toolCalls: [
      { name: 'Read', summary: 'Read: src/db/index.ts' },
      { name: 'Read', summary: 'Read: src/db/queries.ts' },
    ],
    summary: 'Read the database module to understand the current implementation.',
  },
  {
    id: 'msg-t4-3',
    role: 'assistant',
    content: `The current module opens a new connection per query. I'll replace it with a \`pg.Pool\` and update all callers.`,
    timestamp: T3 + 25000,
    toolCalls: [
      { name: 'Edit', summary: 'Edit: src/db/index.ts — replace Client with Pool' },
      { name: 'Edit', summary: 'Edit: src/db/queries.ts — use pool.query()' },
    ],
    summary: 'Replaced per-query Client with a shared Pool; updated all query callers.',
  },
  {
    id: 'msg-t4-4',
    role: 'assistant',
    content: `Done! Here's what changed:

- **\`src/db/index.ts\`** — exports a singleton \`Pool\` instead of a factory function. Pool size defaults to 10; configurable via \`DB_POOL_SIZE\` env var.
- **\`src/db/queries.ts\`** — all functions now call \`pool.query()\` directly instead of creating and destroying a \`Client\` per call.

Idle connections are released after 30 s. Run \`npm test\` — all existing DB tests should still pass since the query API is unchanged.`,
    timestamp: T3 + 40000,
    cost: 0.0031,
    summary: 'Completed connection-pool refactor; documented changes and next steps.',
  },
];

// ─── Thread 5: Wikilink rendering ────────────────────────────────────────────
// Used by the wikilink-rendering screenshot test to verify that [[wikilinks]]
// in assistant messages render as clickable internal links, not raw text.

const thread5Messages: ChatMessage[] = [
  {
    id: 'msg-t5-1',
    role: 'user',
    content: 'Where did we put the golden wealth research?',
    timestamp: T3 + 0,
  },
  {
    id: 'msg-t5-2',
    role: 'assistant',
    content: `The research is saved in your vault. Here are the relevant notes:

- [[Claude/golden-wealth-amplify-teardown-2026-06-06]] — full teardown with recommendations
- [[Projects/HipTrip/Market Research]] — supporting competitive context
- See also [[Daily/2026-06-06|today's daily note]] for the session link

You can open any of them directly from here.`,
    timestamp: T3 + 15000,
    cost: 0.0008,
    summary: 'Pointed to three relevant vault notes using Obsidian wikilinks.',
  },
];

// Opt-in peer content fixture; kept out of fixtureThreads to avoid changing
// unrelated thread-list screenshots.
export const inlineContentMessages: ChatMessage[] = [
  { id: 'inline-user', role: 'user', content: 'Show the quarterly report and campaign preview.', timestamp: T3 },
  {
    id: 'inline-assistant', role: 'assistant', timestamp: T3 + 12000,
    content: [
      'The quarterly report is ready.',
      'agent-content{"providerId":"example.reports","id":"report","schemaVersion":1,"title":"Quarterly report","data":{"kind":"card"}}',
      'Here is the campaign preview.',
      'agent-content{"providerId":"example.reports","id":"image","schemaVersion":1,"title":"Campaign preview","data":{"kind":"image"}}',
      'Explore the breakdown below.',
      'agent-content{"providerId":"example.reports","id":"document","schemaVersion":1,"title":"Revenue by region","data":{"kind":"document"}}',
      'Saved references remain available when a plugin is removed.',
      'agent-content{"providerId":"example.research","id":"missing","schemaVersion":1,"title":"Research notes","data":{}}',
    ].join('\n\n'),
  },
];

// ─── Thread: inline visualization ────────────────────────────────────────────
// Used by ui.spec.ts's "inline visualization card" test. Codex's `visualize`
// skill emits a canonical wrapped content reference on its own line where the
// visual belongs; without the inline renderer it leaks into the bubble as raw
// text. The fragment path is served by test/harness/mocks/fs.ts.

const threadVisualizeMessages: ChatMessage[] = [
  {
    id: 'msg-viz-1',
    role: 'user',
    content: 'How did revenue break down by region last quarter?',
    timestamp: T3 + 0,
  },
  {
    id: 'msg-viz-2',
    role: 'assistant',
    content: `North America still carries the quarter, but APAC is the fastest riser off a small base.

visualize{"path":"/Users/mock/viz/quarterly-revenue.html","title":"Quarterly revenue"}

Europe is flat quarter over quarter.`,
    timestamp: T3 + 12000,
    cost: 0.0012,
    summary: 'Broke down quarterly revenue by region with an inline visualization.',
  },
];

// ─── Thread: background-task notice row ──────────────────────────────────────
// Used by ui.spec.ts's "background task notice row" test. Exercises the
// persisted `notice` message rendered when a background subagent/Workflow
// completes on an idle thread (see ThreadsView.ts renderMessage, role === 'notice').
// One completed (✓) and one failed (✗) notice so both icon states are covered
// in a single snapshot.

const threadNoticeMessages: ChatMessage[] = [
  {
    id: 'msg-tn-1',
    role: 'user',
    content: 'Kick off the background lint sweep and the flaky-test hunt while I step away.',
    timestamp: T3 + 0,
  },
  {
    id: 'msg-tn-2',
    role: 'assistant',
    content: `Both background tasks are running now — I'll post here when they finish.`,
    timestamp: T3 + 5000,
    // A leading tool row lets the screenshot (and layout assertion) show the
    // notice icons sitting in the same column as the tool-row icons.
    toolCalls: [{ name: 'Bash', summary: 'npm run lint -- --fix &', toolUseId: 'tn-1', timestamp: T3 + 4000, status: 'success' }],
  },
  {
    id: 'msg-tn-3',
    role: 'notice',
    content: 'Background task ✓: Lint sweep — fixed 4 files, 0 remaining warnings',
    noticeStatus: 'completed',
    timestamp: T3 + 60000,
  },
  {
    id: 'msg-tn-4',
    role: 'notice',
    content: 'Background task ✗: Flaky-test hunt — could not reproduce after 20 runs',
    noticeStatus: 'failed',
    timestamp: T3 + 90000,
  },
];

// ─── Thread 6: Tool-call grouping ────────────────────────────────────────────
// Used by test/screenshots/tool-call-grouping.spec.ts. A single assistant
// message carrying 15 tool calls spanning multiple activity kinds (several
// Reads, several Edits, a Bash, a WebFetch, plus planning/searching calls),
// with one Edit failing (status: 'error') so the auto-expand-on-error path
// is exercised. Also includes isolated calls (WebFetch, Write, the trailing
// Read) between groups so the "isolated pills render unchanged" regression
// case is covered in the same fixture.

const thread6Messages: ChatMessage[] = [
  {
    id: 'msg-t6-1',
    role: 'user',
    content: 'Update the API client to retry on 429s, and cover it with tests.',
    timestamp: T3 + 0,
  },
  {
    id: 'msg-t6-2',
    role: 'assistant',
    content: `Added retry-with-backoff to the API client and updated the tests. One edit failed to apply cleanly on the first pass — see below.`,
    timestamp: T3 + 30000,
    toolCalls: [
      // group(exploring, 5): Read,Read,Read,Grep,Bash
      { name: 'Read', summary: 'Read: src/api/client.ts', toolUseId: 't6-1', timestamp: T3 + 1000, status: 'success' },
      { name: 'Read', summary: 'Read: src/api/types.ts', toolUseId: 't6-2', timestamp: T3 + 2000, status: 'success' },
      { name: 'Read', summary: 'Read: src/api/utils.ts', toolUseId: 't6-3', timestamp: T3 + 3000, status: 'success' },
      { name: 'Grep', summary: "Grep: 'fetchUser' in src/api", toolUseId: 't6-4', timestamp: T3 + 4000, status: 'success' },
      { name: 'Bash', summary: 'npm run lint -- src/api', toolUseId: 't6-5', timestamp: T3 + 5000, status: 'success' },
      // isolated single: researching
      { name: 'WebFetch', summary: 'https://http.dev/429 — retry-after semantics', toolUseId: 't6-6', timestamp: T3 + 6000, status: 'success' },
      // group(editing, 3) — includes one error, so this group auto-expands
      { name: 'Edit', summary: 'Edit: src/api/client.ts — add retry-with-backoff', toolUseId: 't6-7', timestamp: T3 + 7000, status: 'success' },
      { name: 'Edit', summary: 'Edit: src/api/types.ts — add RetryOptions type', toolUseId: 't6-8', timestamp: T3 + 8000, status: 'success' },
      { name: 'Edit', summary: 'Edit: src/api/utils.ts — extract backoff helper', toolUseId: 't6-9', timestamp: T3 + 9000, status: 'error' },
      // group(planning, 2)
      { name: 'TaskCreate', summary: 'Task: Add tests for retry behavior', toolUseId: 't6-10', timestamp: T3 + 10000, status: 'success' },
      { name: 'TaskUpdate', summary: 'Task #1 → in_progress', toolUseId: 't6-11', timestamp: T3 + 11000, status: 'success' },
      // isolated single: editing (Write, no same-kind neighbor)
      { name: 'Write', summary: 'Write: tests/api/client.retry.test.ts', toolUseId: 't6-12', timestamp: T3 + 12000, status: 'success' },
      // group(searching, 2)
      { name: 'ToolSearch', summary: "ToolSearch: 'retry backoff helper'", toolUseId: 't6-13', timestamp: T3 + 13000, status: 'success' },
      { name: 'Agent', summary: 'Agent: verify retry backoff against flaky network mocks', toolUseId: 't6-14', timestamp: T3 + 14000, status: 'success' },
      // isolated single: exploring (Read, trailing — no same-kind neighbor)
      { name: 'Read', summary: 'Read: tests/api/client.retry.test.ts', toolUseId: 't6-15', timestamp: T3 + 15000, status: 'success' },
    ],
    summary: 'Added retry-with-backoff to the API client; one edit failed on the first pass.',
  },
];

// ─── Thread 7: Fragmented tool-only messages (post-7b7d4fb regression shape) ──
// Used by test/screenshots/tool-call-grouping.spec.ts to reproduce the ACTUAL
// bug shape: a Read → Edit → Bash → Read → Edit agentic chain persisted as 5
// SEPARATE ChatMessage objects (role: 'assistant', content: '', exactly one
// toolCall each) — one per real SDK turn, per the 7b7d4fb tool-only-message
// persistence fix. This is distinct from thread6Messages above, which has ONE
// message carrying many tool calls — that shape was never broken by the
// regression this fixture targets (mergeAdjacentToolOnlyMessages).

const thread7Messages: ChatMessage[] = [
  {
    id: 'msg-t7-1',
    role: 'user',
    content: 'Rename the legacy `fetchUser` helper to `getUserById` everywhere.',
    timestamp: T3 + 0,
  },
  {
    id: 'msg-t7-2',
    role: 'assistant',
    content: '',
    timestamp: T3 + 1000,
    toolCalls: [{ name: 'Read', summary: 'Read: src/api/user.ts', toolUseId: 't7-1', timestamp: T3 + 1000, status: 'success' }],
  },
  {
    id: 'msg-t7-3',
    role: 'assistant',
    content: '',
    timestamp: T3 + 2000,
    toolCalls: [{ name: 'Grep', summary: "Grep: 'fetchUser' across src/", toolUseId: 't7-2', timestamp: T3 + 2000, status: 'success' }],
  },
  {
    id: 'msg-t7-4',
    role: 'assistant',
    content: '',
    timestamp: T3 + 3000,
    toolCalls: [{ name: 'Edit', summary: 'Edit: src/api/user.ts — rename fetchUser', toolUseId: 't7-3', timestamp: T3 + 3000, status: 'success' }],
  },
  {
    id: 'msg-t7-5',
    role: 'assistant',
    content: '',
    timestamp: T3 + 4000,
    toolCalls: [{ name: 'Edit', summary: 'Edit: src/api/userController.ts — update call site', toolUseId: 't7-4', timestamp: T3 + 4000, status: 'success' }],
  },
  {
    id: 'msg-t7-6',
    role: 'assistant',
    content: '',
    timestamp: T3 + 5000,
    toolCalls: [{ name: 'Bash', summary: 'npm run lint', toolUseId: 't7-5', timestamp: T3 + 5000, status: 'success' }],
  },
];

// Codex persists its native lower-camel item types in ToolCallRecord.name.
// Keep this fixture native rather than pre-normalizing it so the screenshot
// harness covers both live and already-persisted Codex records.
const codexNativeToolMessages: ChatMessage[] = [
  {
    id: 'msg-codex-tools-1',
    role: 'user',
    content: 'Run the verification commands for this change.',
    timestamp: T3 + 0,
  },
  {
    id: 'msg-codex-tools-2',
    role: 'assistant',
    content: '',
    timestamp: T3 + 3000,
    toolCalls: [
      { name: 'commandExecution', summary: "npm run typecheck", toolUseId: 'codex-tool-1', timestamp: T3 + 1000, status: 'success' },
      { name: 'commandExecution', summary: "npm run test:unit", toolUseId: 'codex-tool-2', timestamp: T3 + 2000, status: 'success' },
      { name: 'commandExecution', summary: "npm run build", toolUseId: 'codex-tool-3', timestamp: T3 + 3000, status: 'success' },
    ],
  },
];

// ─── Thread 8: Outer-wrap tool calls (post-smoothing entry count > 7) ────────
// Used by test/screenshots/tool-call-grouping.spec.ts's outer-wrap scenes.
// Split across TWO assistant messages rather than one, for a structural
// reason: renderOuterToolWrap's hasError is computed over the ENTIRE flat
// tool list passed to it (mirroring renderToolGroup's own per-group rule,
// just one level up — see that function's doc comment), so a tool list that
// contains ANY error forces the outer wrap to start expanded. That makes
// "collapsed by default" and "auto-expands because of a buried error"
// mutually exclusive outcomes for the SAME tool list — they can't both be
// demonstrated from one message the way two independent .ct-tool-group
// elements can each have their own collapse state within one message (as
// thread6Messages does above). So:
//   - msg-t8-2 (22 raw tool calls, no error) drives the collapsed-by-default
//     and click-to-expand scenes, AND covers the smoothing/isolated-single
//     composition requirements.
//   - msg-t8-3 (13 raw tool calls, one buried error) drives the
//     auto-expand-through-both-tiers scene.
// Both independently exceed OUTER_WRAP_ENTRY_THRESHOLD (7) post-smoothing,
// so each renders its own .ct-tool-outer-wrap — nth(0) and nth(1) in DOM order.
//
// msg-t8-2 expected entry composition (0-indexed among the post-smoothing
// entries msg-t8-2's outer wrap renders) — 22 raw tool calls -> 10 entries:
//   0 = group(exploring, 6)   — Read,Read,Bash,[TaskUpdate interstitial],Read,Read
//                                merged by smoothToolGroups: raw groupToolCalls
//                                output here is 3 SEPARATE entries
//                                (group(exploring,3), single(TaskUpdate),
//                                group(exploring,2)) that fold into one —
//                                this is the "smoothing visibly does
//                                something" case.
//   1 = single(WebFetch)       — researching, isolated: flanked by an
//                                exploring group and an editing group (both
//                                different kinds), so it does NOT merge —
//                                the "genuinely non-mergeable isolated
//                                single" case.
//   2 = group(editing, 3)      — Edit,Edit,Edit
//   3 = group(planning, 2)     — TaskCreate,TaskUpdate
//   4 = single(Write)          — editing, isolated (flanked by planning and
//                                searching groups — different kinds)
//   5 = group(searching, 2)    — ToolSearch,Agent
//   6 = single(Read)           — exploring, isolated (flanked by searching
//                                and researching groups — different kinds)
//   7 = group(researching, 2)  — WebFetch,WebSearch
//   8 = group(working, 2)      — Skill,TodoWrite
//   9 = group(exploring, 2)    — Grep,Glob (trailing, isolated from entry 0's
//                                exploring group by 8 entries in between)
// 22 raw in, 10 entries out (12 pre-smoothing groupToolCalls chunks, minus 2
// from the single merge at index 0) — 7 groups, 3 isolated singles.
//
// msg-t8-3 expected entry composition — 13 raw tool calls -> 8 entries, no
// smoothing opportunities (deliberately, so this message's ONLY job is the
// buried-error scene):
//   0 = group(exploring, 2)    — Read,Read
//   1 = single(TaskCreate)     — planning, isolated
//   2 = group(editing, 3)      — Edit,Edit,Edit — the MIDDLE Edit has
//                                 status: 'error', buried inside this inner
//                                 group, which is itself buried inside the
//                                 outer wrap — exercises auto-expand through
//                                 BOTH collapsible tiers.
//   3 = single(WebFetch)       — researching, isolated
//   4 = group(searching, 2)    — ToolSearch,Agent
//   5 = single(Write)          — editing, isolated
//   6 = group(working, 2)      — Skill,TodoWrite
//   7 = single(Grep)           — exploring, isolated (trailing)
// 4 groups, 4 isolated singles — .ct-tool-group index 1 (0-indexed) is the
// one carrying the buried error.

const thread8Messages: ChatMessage[] = [
  {
    id: 'msg-t8-1',
    role: 'user',
    content: 'Do a big sweep across the API layer: explore, fix the retry bug, add tests, and search for related callers.',
    timestamp: T3 + 0,
  },
  {
    id: 'msg-t8-2',
    role: 'assistant',
    content: `Swept the API layer end to end.`,
    timestamp: T3 + 30000,
    toolCalls: [
      // group(exploring, 3) — merges with the two entries below via smoothToolGroups
      { name: 'Read', summary: 'Read: src/api/client.ts', toolUseId: 't8-1', timestamp: T3 + 1000, status: 'success' },
      { name: 'Read', summary: 'Read: src/api/types.ts', toolUseId: 't8-2', timestamp: T3 + 2000, status: 'success' },
      { name: 'Bash', summary: 'npm run lint -- src/api', toolUseId: 't8-3', timestamp: T3 + 3000, status: 'success' },
      // single(planning) interstitial — merge candidate, folded into the exploring run above
      { name: 'TaskUpdate', summary: 'Task #1 → in_progress', toolUseId: 't8-4', timestamp: T3 + 4000, status: 'success' },
      // group(exploring, 2) — merges with the run above via smoothToolGroups
      { name: 'Read', summary: 'Read: src/api/utils.ts', toolUseId: 't8-5', timestamp: T3 + 5000, status: 'success' },
      { name: 'Read', summary: 'Read: src/api/retry.ts', toolUseId: 't8-6', timestamp: T3 + 6000, status: 'success' },
      // isolated single: researching — does NOT merge (neighbors are exploring/editing)
      { name: 'WebFetch', summary: 'https://http.dev/429 — retry-after semantics', toolUseId: 't8-7', timestamp: T3 + 7000, status: 'success' },
      // group(editing, 3)
      { name: 'Edit', summary: 'Edit: src/api/client.ts — add retry-with-backoff', toolUseId: 't8-8', timestamp: T3 + 8000, status: 'success' },
      { name: 'Edit', summary: 'Edit: src/api/retry.ts — extract backoff helper', toolUseId: 't8-9', timestamp: T3 + 9000, status: 'success' },
      { name: 'Edit', summary: 'Edit: src/api/types.ts — add RetryOptions type', toolUseId: 't8-10', timestamp: T3 + 10000, status: 'success' },
      // group(planning, 2)
      { name: 'TaskCreate', summary: 'Task: Add tests for retry behavior', toolUseId: 't8-11', timestamp: T3 + 11000, status: 'success' },
      { name: 'TaskUpdate', summary: 'Task #2 → in_progress', toolUseId: 't8-12', timestamp: T3 + 12000, status: 'success' },
      // isolated single: editing — does NOT merge (neighbors are planning/searching)
      { name: 'Write', summary: 'Write: tests/api/client.retry.test.ts', toolUseId: 't8-13', timestamp: T3 + 13000, status: 'success' },
      // group(searching, 2)
      { name: 'ToolSearch', summary: "ToolSearch: 'retry backoff helper'", toolUseId: 't8-14', timestamp: T3 + 14000, status: 'success' },
      { name: 'Agent', summary: 'Agent: verify retry backoff against flaky network mocks', toolUseId: 't8-15', timestamp: T3 + 15000, status: 'success' },
      // isolated single: exploring — does NOT merge (neighbors are searching/researching)
      { name: 'Read', summary: 'Read: tests/api/client.retry.test.ts', toolUseId: 't8-16', timestamp: T3 + 16000, status: 'success' },
      // group(researching, 2)
      { name: 'WebFetch', summary: 'https://http.dev/backoff-jitter', toolUseId: 't8-17', timestamp: T3 + 17000, status: 'success' },
      { name: 'WebSearch', summary: 'exponential backoff jitter best practices', toolUseId: 't8-18', timestamp: T3 + 18000, status: 'success' },
      // group(working, 2)
      { name: 'Skill', summary: 'Skill: pr-checklist', toolUseId: 't8-19', timestamp: T3 + 19000, status: 'success' },
      { name: 'TodoWrite', summary: 'Updated task list', toolUseId: 't8-20', timestamp: T3 + 20000, status: 'success' },
      // group(exploring, 2) — trailing, not adjacent to entry 0's exploring group
      { name: 'Grep', summary: "Grep: 'RetryOptions' across src/api", toolUseId: 't8-21', timestamp: T3 + 21000, status: 'success' },
      { name: 'Glob', summary: 'Glob: src/api/**/*.test.ts', toolUseId: 't8-22', timestamp: T3 + 22000, status: 'success' },
    ],
    summary: 'Swept the API layer: explored, fixed retry-with-backoff, added tests, searched related callers.',
  },
  {
    id: 'msg-t8-3',
    role: 'assistant',
    content: `A follow-up sweep turned up one edit that failed to apply cleanly — see below.`,
    timestamp: T3 + 60000,
    toolCalls: [
      // group(exploring, 2)
      { name: 'Read', summary: 'Read: src/api/backoff.ts', toolUseId: 't8-23', timestamp: T3 + 23000, status: 'success' },
      { name: 'Read', summary: 'Read: src/api/jitter.ts', toolUseId: 't8-24', timestamp: T3 + 24000, status: 'success' },
      // isolated single: planning
      { name: 'TaskCreate', summary: 'Task: Fix jitter overflow', toolUseId: 't8-25', timestamp: T3 + 25000, status: 'success' },
      // group(editing, 3) — middle Edit errors; buried inside the outer wrap
      { name: 'Edit', summary: 'Edit: src/api/backoff.ts — cap max delay', toolUseId: 't8-26', timestamp: T3 + 26000, status: 'success' },
      { name: 'Edit', summary: 'Edit: src/api/jitter.ts — fix overflow', toolUseId: 't8-27', timestamp: T3 + 27000, status: 'error' },
      { name: 'Edit', summary: 'Edit: src/api/backoff.ts — clamp jitter range', toolUseId: 't8-28', timestamp: T3 + 28000, status: 'success' },
      // isolated single: researching
      { name: 'WebFetch', summary: 'https://http.dev/jitter-overflow-cases', toolUseId: 't8-29', timestamp: T3 + 29000, status: 'success' },
      // group(searching, 2)
      { name: 'ToolSearch', summary: "ToolSearch: 'jitter overflow'", toolUseId: 't8-30', timestamp: T3 + 30000, status: 'success' },
      { name: 'Agent', summary: 'Agent: verify jitter fix against edge-case delays', toolUseId: 't8-31', timestamp: T3 + 31000, status: 'success' },
      // isolated single: editing
      { name: 'Write', summary: 'Write: tests/api/jitter.overflow.test.ts', toolUseId: 't8-32', timestamp: T3 + 32000, status: 'success' },
      // group(working, 2)
      { name: 'Skill', summary: 'Skill: pr-checklist', toolUseId: 't8-33', timestamp: T3 + 33000, status: 'success' },
      { name: 'TodoWrite', summary: 'Updated task list', toolUseId: 't8-34', timestamp: T3 + 34000, status: 'success' },
      // isolated single: exploring (trailing)
      { name: 'Grep', summary: "Grep: 'jitter' across src/api", toolUseId: 't8-35', timestamp: T3 + 35000, status: 'success' },
    ],
    summary: 'Follow-up sweep found one edit that failed to apply on the first pass.',
  },
];

// ─── Exported fixtures ────────────────────────────────────────────────────────

export const fixtureThreads: Thread[] = [
  {
    id: 'thread-fix-auth',
    title: 'Fix auth middleware',
    cwd: '/Users/mock/projects/hip-trip',
    messages: thread1Messages,
    createdAt: T1,
    updatedAt: T1 + 5 * 60 * 1000,
    summary: 'Debugged 401s in staging caused by a missing JWT_SECRET env var. Fixed auth.ts to throw on startup rather than silently fall back to an empty string. Added Jest tests covering the missing-secret, valid-token, and invalid-token cases.',
    recap: 'Read auth.ts and .env.example, then wrote a test file and edited the middleware.',
    editedFiles: [
      '/Users/mock/projects/hip-trip/src/middleware/auth.ts',
      '/Users/mock/projects/hip-trip/src/middleware/__tests__/auth.test.ts',
    ],
  },
  {
    id: 'thread-brainstorm',
    title: 'HipTrip feature ideas',
    cwd: '/Users/mock/projects/hip-trip',
    messages: thread2Messages,
    createdAt: T2,
    updatedAt: T2 + 60000,
  },
  {
    id: 'thread-new',
    title: 'Thread 3',
    cwd: '/Users/mock/projects/hip-trip',
    messages: thread3Messages,
    createdAt: T3,
    updatedAt: T3,
  },
  {
    id: 'thread-agentic',
    title: 'DB connection pooling refactor',
    cwd: '/Users/mock/projects/hip-trip',
    messages: thread4Messages,
    createdAt: T3 - 60000,
    updatedAt: T3 + 40000,
  },
  {
    id: 'thread-wikilinks',
    title: 'Wikilink rendering test',
    cwd: '/Users/mock/projects/hip-trip',
    messages: thread5Messages,
    createdAt: T3 - 120000,
    updatedAt: T3 + 15000,
  },
  {
    id: 'thread-visualize',
    title: 'Inline visualization',
    cwd: '/Users/mock/projects/hip-trip',
    messages: threadVisualizeMessages,
    createdAt: T3 - 130000,
    updatedAt: T3 + 12000,
  },
  {
    id: 'thread-tasks',
    title: 'Hip provenance initiative',
    cwd: '/Users/mock/projects/hip-trip',
    messages: thread1Messages,
    createdAt: T3 - 60000,
    updatedAt: T3 + 30000,
    tasks: [
      { id: '1', content: 'Write discerning-traveler initiative doc (ideas + design direction)', status: 'completed' },
      { id: '2', content: 'Implement Hip Provenance — "why this place" editorial layer in itinerary view', status: 'completed' },
      { id: '3', content: 'Enhance locked preview with curation quality signals', status: 'completed' },
      { id: '4', content: 'Add hip context to public share view (/i/[slug])', status: 'completed' },
      { id: '5', content: 'Verify: types, unit tests, build, visual check', status: 'in_progress' },
    ],
  },
  {
    id: 'thread-notice',
    title: 'Background task notice row',
    cwd: '/Users/mock/projects/hip-trip',
    messages: threadNoticeMessages,
    createdAt: T3 - 30000,
    updatedAt: T3 + 90000,
  },
  {
    id: 'thread-tool-grouping',
    title: 'API client retry + tests',
    cwd: '/Users/mock/projects/hip-trip',
    messages: thread6Messages,
    createdAt: T3 - 60000,
    updatedAt: T3 + 30000,
  },
  {
    id: 'thread-codex-native-tool-calls',
    title: 'Codex verification commands',
    cwd: '/Users/mock/projects/claude-threads',
    messages: codexNativeToolMessages,
    createdAt: T3 - 60000,
    updatedAt: T3 + 3000,
  },
  {
    // Deliberately empty — used by tool-call-grouping.spec.ts's LIVE-rendering
    // tests, which drive tool_use/tool_result_status events in directly via
    // window.__emitEvent rather than relying on any pre-seeded message/tool
    // state. An empty thread keeps those tests self-contained and avoids
    // coupling live-mode assertions to whatever thread6Messages happens to
    // contain.
    id: 'thread-live-tool-grouping',
    title: 'Live tool-call grouping test',
    cwd: '/Users/mock/projects/hip-trip',
    messages: [],
    createdAt: T3 - 30000,
    updatedAt: T3 - 30000,
  },
  {
    id: 'thread-fragmented-tool-calls',
    title: 'Rename fetchUser helper',
    cwd: '/Users/mock/projects/hip-trip',
    messages: thread7Messages,
    createdAt: T3 - 60000,
    updatedAt: T3 + 5000,
  },
  {
    id: 'thread-outer-wrap-tool-calls',
    title: 'API layer sweep',
    cwd: '/Users/mock/projects/hip-trip',
    messages: thread8Messages,
    createdAt: T3 - 60000,
    updatedAt: T3 + 30000,
  },
  {
    // Exercises the inline proposed-reply card (test/screenshots/ui.spec.ts,
    // 'proposed reply — inline card'). A moderately long, multi-paragraph
    // markdown reply so the screenshot actually demonstrates the scrollable,
    // full-width card — the whole point of moving it out of the old
    // collapsible floating-panel banner.
    id: 'thread-proposed-reply',
    title: 'Support escalation — billing webhook',
    cwd: '/Users/mock/projects/hip-trip',
    messages: thread2Messages,
    createdAt: T3 - 40000,
    updatedAt: T3 + 20000,
    proposedReply: {
      text: [
        '## Summary',
        '',
        'I dug through the Stripe webhook logs for the last 48 hours and found the root cause of the duplicate-charge reports.',
        '',
        '### What happened',
        '',
        '- The `checkout.session.completed` handler was retried by Stripe after a 5xx from our endpoint (a transient DB connection timeout).',
        '- Our handler was **not idempotent** — it created a new `Order` row on every delivery instead of upserting on `stripe_session_id`.',
        '- Three customers ended up with two orders each for the same checkout session, and were billed twice by our downstream fulfillment job.',
        '',
        '### Fix I\'m proposing',
        '',
        '1. Add a unique constraint on `orders.stripe_session_id`.',
        '2. Wrap the handler in an upsert (`ON CONFLICT DO NOTHING`) so retried deliveries are no-ops.',
        '3. Backfill: refund the three duplicate charges and merge the duplicate `Order` rows.',
        '',
        '```sql',
        'ALTER TABLE orders',
        '  ADD CONSTRAINT orders_stripe_session_id_key UNIQUE (stripe_session_id);',
        '```',
        '',
        '### Next steps',
        '',
        "I'll open a PR with the migration and handler fix today, and file a follow-up ticket for the refunds since those need finance sign-off before we touch Stripe.",
        '',
        'Let me know if you want me to loop in support so they can proactively reach out to the three affected customers before we process the refunds.',
      ].join('\n'),
      generatedAt: T3 + 25000,
      sourceThreadId: 'thread-brainstorm',
    },
  },
];

// ─── Kanban board fixtures ────────────────────────────────────────────────────
// A dedicated fixture set for the Kanban harness (test/harness/kanban-index.ts).
// Kept separate from `fixtureThreads` so the conversation-view snapshots don't
// churn. Designed to populate every status column AND span multiple folders so
// both the status board and the folder-swimlane layout render meaningfully.
//
// Folder grouping resolves to: assigned Project name → working-directory label
// → "Unassigned". These fixtures cover all three:
//   • HipTrip       (project)   — Working, Awaiting, New, Done
//   • Agent Threads (project)  — New, Failed, Ready
//   • acme-api      (cwd only)  — Done
//   • Unassigned    (no cwd)    — New
//
// Running / Awaiting state is not stored on the Thread — it lives in the
// ThreadManager's private session/permission maps. kanban-index.ts seeds those
// maps for `k-hiptrip-running` and `k-hiptrip-awaiting` so those two land in
// the Working and Awaiting columns respectively.

const KT = EPOCH; // kanban fixtures anchor to the same pinned epoch

const userMsg = (id: string, content: string, ts: number): ChatMessage => ({ id, role: 'user', content, timestamp: ts });
const asstMsg = (id: string, content: string, ts: number, summary?: string): ChatMessage => ({
  id, role: 'assistant', content, timestamp: ts, summary,
});

export const kanbanFixtureProjects: Project[] = [
  { id: 'proj-hiptrip', name: 'HipTrip', vaultFolder: 'Projects/HipTrip', createdAt: KT - 7 * 24 * 60 * 60 * 1000 },
  { id: 'proj-threads', name: 'Agent Threads', vaultFolder: 'Projects/AgentThreads', createdAt: KT - 5 * 24 * 60 * 60 * 1000 },
];

// Thread ids whose running / pending-permission state the harness must seed.
export const kanbanRunningThreadId = 'k-hiptrip-running';
export const kanbanAwaitingThreadId = 'k-hiptrip-awaiting';
export const kanbanAwaitingPermission = { toolName: 'Bash', detail: 'npm run deploy --prod' };
export const kanbanRunningActivity = 'Editing src/itinerary/PlaceCard.tsx';

// Thread with a pending ScheduleWakeup, seeded (not running) — exercises the
// Kanban "Waiting" column added in fix/scheduled-wakeup-visibility.
export const kanbanWaitingThreadId = 'k-hiptrip-waiting';
export const kanbanWaitingFireAt = KT + 4 * 60 * 1000; // 4 minutes from the pinned clock
export const kanbanWaitingReason = 'check CI status';

// A scheduled/cron job whose repeat runs share `scheduledItemId` — exercises
// the Kanban stacking feature (quiet columns collapse repeat runs into one
// expandable rollup card). Three quiet, unreviewed runs is enough to clear
// the default minCount=2 threshold.
export const kanbanScheduledJobId = 'sched-hourly-triage';
export const kanbanScheduledJobName = 'Hourly Triage';

export const kanbanFixtureThreads: Thread[] = [
  // ── HipTrip lane (most-recent activity → top lane) ──────────────────────────
  {
    id: kanbanRunningThreadId,
    title: 'Add "why this place" provenance layer',
    cwd: '/Users/mock/projects/hip-trip',
    projectId: 'proj-hiptrip',
    messages: [userMsg('k1', 'Add an editorial provenance layer to the itinerary card.', KT - 60_000)],
    createdAt: KT - 60_000,
    updatedAt: KT - 30_000,
    editedFiles: ['/Users/mock/projects/hip-trip/src/itinerary/PlaceCard.tsx'],
  },
  {
    id: kanbanAwaitingThreadId,
    title: 'Deploy curation quality signals',
    cwd: '/Users/mock/projects/hip-trip',
    projectId: 'proj-hiptrip',
    messages: [userMsg('k2', 'Ship the curation-quality changes to prod.', KT - 4 * 60_000)],
    createdAt: KT - 4 * 60_000,
    updatedAt: KT - 90_000,
  },
  {
    id: kanbanWaitingThreadId,
    title: 'Auto-retry flaky preview deploys',
    cwd: '/Users/mock/projects/hip-trip',
    projectId: 'proj-hiptrip',
    messages: [userMsg('k-wait-1', 'Watch the preview deploy and retry once if it flakes.', KT - 2 * 60_000)],
    createdAt: KT - 2 * 60_000,
    updatedAt: KT - 60_000,
  },
  {
    id: 'k-hiptrip-new',
    title: 'Social "Going too?" nudge',
    cwd: '/Users/mock/projects/hip-trip',
    projectId: 'proj-hiptrip',
    messages: [
      userMsg('k3', 'Sketch the destination-matching nudge.', KT - 20 * 60_000),
      asstMsg('k4', 'Proposed an index over existing saves with a low-cost viral loop.', KT - 19 * 60_000,
        'Proposed the "Going too?" destination-matching nudge built on existing saves.'),
    ],
    createdAt: KT - 20 * 60_000,
    updatedAt: KT - 19 * 60_000,
    summary: 'Proposed the "Going too?" destination-matching nudge built on existing saves.',
    reviewed: false,
  },
  {
    id: 'k-hiptrip-done',
    title: 'Fix auth middleware 401s',
    cwd: '/Users/mock/projects/hip-trip',
    projectId: 'proj-hiptrip',
    messages: [
      userMsg('k5', 'Auth middleware throws 401s in staging.', KT - 60 * 60_000),
      asstMsg('k6', 'Fixed: JWT_SECRET was missing; auth.ts now fails fast on startup.', KT - 59 * 60_000,
        'Fixed missing JWT_SECRET in staging; auth.ts now fails fast.'),
    ],
    createdAt: KT - 60 * 60_000,
    updatedAt: KT - 59 * 60_000,
    summary: 'Fixed missing JWT_SECRET in staging; auth.ts now fails fast.',
    reviewed: true,
    prUrl: 'https://github.com/acme/hip-trip/pull/482',
    editedFiles: ['/Users/mock/projects/hip-trip/src/middleware/auth.ts'],
  },

  // Three quiet, unreviewed runs of the same hourly cron job — the "why we
  // built stacking" scenario. Together with kanbanScheduledJobId's shared
  // id these collapse into one rollup card in the New column instead of
  // burying the manually-created cards above/below.
  {
    id: 'k-hiptrip-sched-1',
    title: 'Hourly Triage — run 1',
    cwd: '/Users/mock/projects/hip-trip',
    projectId: 'proj-hiptrip',
    messages: [asstMsg('k-sched-1', 'No new feedback items to triage this hour.', KT - 3 * 60 * 60_000,
      'No new feedback items to triage this hour.')],
    createdAt: KT - 3 * 60 * 60_000,
    updatedAt: KT - 3 * 60 * 60_000,
    summary: 'No new feedback items to triage this hour.',
    reviewed: false,
    scheduledItemId: kanbanScheduledJobId,
    scheduledItemName: kanbanScheduledJobName,
  },
  {
    id: 'k-hiptrip-sched-2',
    title: 'Hourly Triage — run 2',
    cwd: '/Users/mock/projects/hip-trip',
    projectId: 'proj-hiptrip',
    messages: [asstMsg('k-sched-2', 'Triaged 2 feedback items — both linked to existing opportunities.', KT - 2 * 60 * 60_000,
      'Triaged 2 feedback items — both linked to existing opportunities.')],
    createdAt: KT - 2 * 60 * 60_000,
    updatedAt: KT - 2 * 60 * 60_000,
    summary: 'Triaged 2 feedback items — both linked to existing opportunities.',
    reviewed: false,
    scheduledItemId: kanbanScheduledJobId,
    scheduledItemName: kanbanScheduledJobName,
  },
  {
    id: 'k-hiptrip-sched-3',
    title: 'Hourly Triage — run 3',
    cwd: '/Users/mock/projects/hip-trip',
    projectId: 'proj-hiptrip',
    messages: [asstMsg('k-sched-3', 'No new feedback items to triage this hour.', KT - 60_000 * 30,
      'No new feedback items to triage this hour.')],
    createdAt: KT - 60_000 * 30,
    updatedAt: KT - 60_000 * 30,
    summary: 'No new feedback items to triage this hour.',
    reviewed: false,
    scheduledItemId: kanbanScheduledJobId,
    scheduledItemName: kanbanScheduledJobName,
  },

  // ── Agent Threads lane ─────────────────────────────────────────────────────
  {
    id: 'k-threads-new',
    title: 'Kanban folder swimlanes',
    cwd: '/Users/mock/projects/obsidian-claude-threads',
    projectId: 'proj-threads',
    messages: [
      userMsg('k7', 'Group the kanban board by working folder.', KT - 40 * 60_000),
      asstMsg('k8', 'Added a Group by: Status / Folder toggle rendering folder swimlanes.', KT - 39 * 60_000,
        'Added folder-swimlane grouping to the Kanban board.'),
    ],
    createdAt: KT - 40 * 60_000,
    updatedAt: KT - 39 * 60_000,
    summary: 'Added folder-swimlane grouping to the Kanban board.',
    reviewed: false,
  },
  {
    id: 'k-threads-failed',
    title: 'Relay reconnect backoff',
    cwd: '/Users/mock/projects/obsidian-claude-threads',
    projectId: 'proj-threads',
    messages: [userMsg('k9', 'The relay client never reconnects after a drop.', KT - 80 * 60_000)],
    createdAt: KT - 80 * 60_000,
    updatedAt: KT - 79 * 60_000,
    lastError: 'WebSocket closed (1006) — exhausted reconnect attempts',
  },
  {
    id: 'k-threads-ready',
    title: 'Mobile layout polish',
    cwd: '/Users/mock/projects/obsidian-claude-threads',
    projectId: 'proj-threads',
    messages: [],
    createdAt: KT - 100 * 60_000,
    updatedAt: KT - 100 * 60_000,
  },

  // ── acme-api lane (no project → working-directory label) ────────────────────
  {
    id: 'k-acme-tasks',
    title: 'Migrate auth tokens to short-lived JWTs',
    cwd: '/Users/mock/projects/acme-api',
    messages: [
      userMsg('k14', 'Migrate legacy API keys to short-lived JWTs.', KT - 2 * 60 * 60_000),
      asstMsg('k15', 'Working on it — 3 of 5 steps done.', KT - 2 * 60 * 60_000 + 30_000,
        'Migrating to short-lived JWTs — 3 of 5 steps done.'),
    ],
    createdAt: KT - 2 * 60 * 60_000,
    updatedAt: KT - 2 * 60 * 60_000 + 30_000,
    summary: 'Migrating to short-lived JWTs — 3 of 5 steps done.',
    tasks: [
      { id: 't1', content: 'Add JWT signing key to secrets manager', status: 'completed' },
      { id: 't2', content: 'Implement token generation in AuthService', status: 'completed' },
      { id: 't3', content: 'Update middleware to verify JWTs', status: 'completed' },
      { id: 't4', content: 'Migrate existing API key sessions', status: 'in_progress' },
      { id: 't5', content: 'Remove legacy API key validation code', status: 'pending' },
    ],
  },
  {
    id: 'k-acme-done',
    title: 'Add rate limiting to /v1/search',
    cwd: '/Users/mock/projects/acme-api',
    messages: [
      userMsg('k10', 'Rate-limit the search endpoint.', KT - 3 * 60 * 60_000),
      asstMsg('k11', 'Added a token-bucket limiter at 20 req/s per key.', KT - 3 * 60 * 60_000 + 60_000,
        'Added a token-bucket rate limiter to /v1/search.'),
    ],
    createdAt: KT - 3 * 60 * 60_000,
    updatedAt: KT - 3 * 60 * 60_000 + 60_000,
    summary: 'Added a token-bucket rate limiter to /v1/search.',
    reviewed: true,
  },

  // ── Unassigned lane (no cwd → catch-all, always sorts last) ─────────────────
  {
    id: 'k-unassigned-new',
    title: 'Draft Q3 planning notes',
    cwd: '',
    messages: [
      userMsg('k12', 'Help me outline the Q3 planning doc.', KT - 10 * 60_000),
      asstMsg('k13', 'Outlined goals, bets, and risks across three sections.', KT - 9 * 60_000,
        'Outlined the Q3 planning doc — goals, bets, risks.'),
    ],
    createdAt: KT - 10 * 60_000,
    updatedAt: KT - 9 * 60_000,
    summary: 'Outlined the Q3 planning doc — goals, bets, risks.',
    reviewed: false,
  },
];

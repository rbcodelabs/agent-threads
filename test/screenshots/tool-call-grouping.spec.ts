import { test, expect } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

// Fixture: 'thread-tool-grouping' (test/harness/fixtures.ts) — a single
// assistant message with 15 tool calls spanning exploring/editing/planning/
// researching/searching activity kinds, including one failed Edit (so the
// editing group auto-expands) and three isolated calls (WebFetch, Write, a
// trailing Read) that fall outside any group.
//
// Group order in the fixture (0-indexed among .ct-tool-group elements):
//   0 = exploring (Read,Read,Read,Grep,Bash) — collapsed by default, no error
//   1 = editing (Edit,Edit,Edit) — has an error, auto-expanded
//   2 = planning (TaskCreate,TaskUpdate) — collapsed by default, no error
//   3 = searching (ToolSearch,Agent) — collapsed by default, no error

test.describe('Tool-call grouping', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__view.focusThread('thread-tool-grouping'));
    await page.waitForSelector('.ct-tool-group');
    await page.waitForTimeout(200);
  });

  test('groups render collapsed by default, except the group containing an error', async ({ page }) => {
    // Non-error groups start collapsed (.ct-full-content has .ct-hidden)
    const exploringGroup = page.locator('.ct-tool-group').nth(0);
    await expect(exploringGroup.locator('.ct-full-content')).toHaveClass(/ct-hidden/);

    // The editing group contains a failed Edit and should already be expanded
    const editingGroup = page.locator('.ct-tool-group').nth(1);
    await expect(editingGroup.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);

    await shot(page, 'tool-call-grouping-collapsed.png', { fullPage: true });
  });

  test('clicking a group header expands it', async ({ page }) => {
    const exploringGroup = page.locator('.ct-tool-group').nth(0);
    await exploringGroup.locator('.ct-expand-btn').click();
    await expect(exploringGroup.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);
    await page.waitForTimeout(200);
    await shot(page, 'tool-call-grouping-expanded.png', { fullPage: true });
  });

  test('error group auto-expands and is visually flagged', async ({ page }) => {
    const editingGroup = page.locator('.ct-tool-group').nth(1);
    await expect(editingGroup.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);
    await expect(editingGroup.locator('.ct-tool-group-header')).toHaveClass(/ct-tool-error/);
    // At least one pill inside the group carries the error tint class.
    await expect(editingGroup.locator('.ct-tool-pill.ct-tool-error')).toHaveCount(1);
    await shot(editingGroup, 'tool-call-grouping-error-expanded.png');
  });

  test('isolated calls still render as plain ungrouped pills', async ({ page }) => {
    // Direct .ct-tool-pill children of .ct-tools are the isolated (non-grouped)
    // calls — WebFetch, Write, and the trailing Read in this fixture.
    const isolatedPills = page.locator('.ct-tools > .ct-tool-pill');
    await expect(isolatedPills).toHaveCount(3);
    await shot(isolatedPills.first(), 'tool-call-grouping-isolated-pill.png');
  });
});

test.describe('Codex-native tool-call rendering', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.evaluate(() => (window as any).__view.focusThread('thread-codex-native-tool-calls'));
    await page.waitForSelector('.ct-tool-group');
  });

  test('renders commandExecution as an Exploring group with terminal icons and readable labels', async ({ page }) => {
    const group = page.locator('.ct-tool-group').first();
    await expect(group.locator('.ct-compressed-summary')).toHaveText('Ran 3 commands');
    await expect(group.locator('.ct-tool-group-header .lucide-terminal')).toHaveCount(1);

    await group.locator('.ct-expand-btn').click();
    await expect(group.locator('.ct-tool-pill-name')).toHaveText(['Bash', 'Bash', 'Bash']);
    await expect(group.locator('.ct-full-content .lucide-terminal')).toHaveCount(3);

    await shot(page, 'tool-call-grouping-codex-native.png', { fullPage: true });
  });
});

// ─── Outer-wrap tier (post-smoothing entry count > OUTER_WRAP_ENTRY_THRESHOLD) ──
// Fixture: 'thread-outer-wrap-tool-calls' (test/harness/fixtures.ts) — TWO
// assistant messages, each with enough tool calls that
// groupToolCalls()+smoothToolGroups() puts them comfortably above the
// threshold (7), so ThreadsView.renderOuterToolWrap wraps each one in its
// own second collapsible tier:
//   - msg-t8-2 (22 raw -> 10 entries, no error) -> .ct-tool-outer-wrap nth(0)
//   - msg-t8-3 (13 raw -> 8 entries, one buried error) -> nth(1)
// Split into two messages deliberately — see the fixture's own doc comment
// for why "collapsed by default" and "auto-expands due to a buried error"
// can't both be demonstrated from a single tool list (hasError is computed
// over the WHOLE flat list passed to the outer wrap, same rule
// renderToolGroup already applies one level up).

test.describe('Outer-wrap tool-call grouping (finalized)', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__view.focusThread('thread-outer-wrap-tool-calls'));
    await page.waitForSelector('.ct-tool-outer-wrap');
    await page.waitForTimeout(200);
  });

  test('outer wrap is collapsed by default (no error)', async ({ page }) => {
    const outerWraps = page.locator('.ct-tool-outer-wrap');
    await expect(outerWraps).toHaveCount(2);
    const outerWrap = outerWraps.nth(0); // msg-t8-2 — no error
    await expect(outerWrap.locator(':scope > .ct-full-content')).toHaveClass(/ct-hidden/);
    await expect(outerWrap.locator('.ct-tool-outer-wrap-header .ct-compressed-summary')).toHaveText('22 tool calls, 10 steps');
    await shot(page, 'tool-call-grouping-outer-wrap-collapsed.png', { fullPage: true });
  });

  test('clicking the outer expand button reveals content structurally identical to the flat path', async ({ page }) => {
    const outerWrap = page.locator('.ct-tool-outer-wrap').nth(0); // msg-t8-2 — no error
    await outerWrap.locator(':scope > .ct-tool-outer-wrap-header > .ct-expand-btn').click();
    await expect(outerWrap.locator(':scope > .ct-full-content')).not.toHaveClass(/ct-hidden/);

    // 10 post-smoothing entries: 7 groups, 3 isolated singles rendered
    // directly as .ct-tool-pill children of .ct-full-content — exactly what
    // the flat (non-wrapped) render path produces for the identical
    // post-smoothing entry list (see renderGroupedEntries, shared by both).
    const fullContent = outerWrap.locator(':scope > .ct-full-content');
    await expect(fullContent.locator(':scope > .ct-tool-group')).toHaveCount(7);
    await expect(fullContent.locator(':scope > .ct-tool-pill')).toHaveCount(3);

    await page.waitForTimeout(200);
    await shot(page, 'tool-call-grouping-outer-wrap-expanded.png', { fullPage: true });
  });

  test('a buried error auto-expands BOTH the outer wrap and the inner group containing it', async ({ page }) => {
    const outerWrap = page.locator('.ct-tool-outer-wrap').nth(1); // msg-t8-3 — buried error
    // No click needed — hasError on the full flat tool list forces both tiers open.
    await expect(outerWrap.locator(':scope > .ct-tool-outer-wrap-header')).toHaveClass(/ct-tool-error/);
    await expect(outerWrap.locator(':scope > .ct-full-content')).not.toHaveClass(/ct-hidden/);

    // The editing group (buried error) is the 2nd .ct-tool-group in DOM order
    // — see the fixture's doc comment for msg-t8-3: entry 0 (exploring,2) is
    // a group, entry 1 (TaskCreate) is a single, entry 2 (editing,3, has the
    // error) is the next group.
    const editingGroup = outerWrap.locator('.ct-tool-group').nth(1);
    await expect(editingGroup.locator('.ct-tool-group-header')).toHaveClass(/ct-tool-error/);
    await expect(editingGroup.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);
    await expect(editingGroup.locator('.ct-tool-pill.ct-tool-error')).toHaveCount(1);

    await shot(page, 'tool-call-grouping-outer-wrap-error-auto-expanded.png', { fullPage: true });
  });
});

// ─── Fragmented tool-only messages (post-7b7d4fb regression shape) ─────────
// Fixture: 'thread-fragmented-tool-calls' (test/harness/fixtures.ts) — 5
// SEPARATE ChatMessage objects (role: 'assistant', content: '', exactly one
// toolCall each: Read, Grep, Edit, Edit, Bash), reproducing the actual
// persisted shape after 7b7d4fb ("fix: persist tool-only assistant messages
// instead of silently dropping them"). Before mergeAdjacentToolOnlyMessages,
// this rendered as 5 separate full-height `.ct-message` rows — one per raw
// persisted turn — instead of a couple of collapsible activity groups.

test.describe('Fragmented tool-only messages (view-layer merge)', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
  });

  test('renderMessages() merges 5 separate tool-only ChatMessages into a compact grouped view, not one row per message', async ({ page }) => {
    await page.evaluate(() => (window as any).__view.focusThread('thread-fragmented-tool-calls'));
    await page.waitForSelector('.ct-tool-group');
    await page.waitForTimeout(200);

    // Fixture has 1 user message + 5 separate tool-only assistant messages.
    // Post-merge (mergeAdjacentToolOnlyMessages) those 5 collapse into ONE
    // assistant row, so the total `.ct-message` count must be far below the
    // 6 raw fixture messages — specifically 1 user bubble + 1 merged row.
    await expect(page.locator('.ct-message')).toHaveCount(2);

    // Read+Grep (both 'exploring') and Edit+Edit (both 'editing') each form a
    // group; the trailing Bash is isolated (not adjacent to another
    // 'exploring' call in the concatenated tool list) — 2 groups total.
    await expect(page.locator('.ct-tool-group')).toHaveCount(2);

    await shot(page, 'tool-call-grouping-fragmented-merged.png', { fullPage: true });
  });
});

// ─── Live (in-progress turn) tool-call grouping ─────────────────────────────
// Drives real ThreadEvents via window.__emitEvent (test/harness/index.ts) into
// an empty thread (fixture 'thread-live-tool-grouping') to exercise the LIVE
// rendering path (ThreadsView.renderLiveToolCalls/scheduleLiveToolsRender),
// not just the finalized-message path covered above. This is the actual pain
// point the feature closes: before this change, tool calls only grouped after
// a message settled — during a long-running turn they rendered as an
// ever-growing flat pill list with no cap.

test.describe('Live tool-call grouping', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__view.focusThread('thread-live-tool-grouping'));
    await page.waitForTimeout(200);
    // Fire the user message that kicks off the turn, exactly like a real send
    // would — this both matches production event ordering and clears the
    // "Ask Claude anything" empty-state placeholder (handled by the
    // 'user_message_added' case, which no other event in this suite touches)
    // so the live tool-call area renders against a realistic, non-empty view.
    await page.evaluate(() => {
      const manager = (window as any).__manager;
      const threadId = 'thread-live-tool-grouping';
      const message = { id: 'live-user-msg', role: 'user', content: 'Do the thing', timestamp: Date.now() };
      manager.getThread(threadId).messages.push(message);
      (window as any).__emitEvent(threadId, { type: 'user_message_added', message });
    });
    await page.waitForTimeout(100);
  });

  test('a burst of same-kind live tool calls collapses into one bounded group instead of growing 1:1 with event count', async ({ page }) => {
    await page.evaluate(() => {
      const emit = (window as any).__emitEvent;
      const threadId = 'thread-live-tool-grouping';
      emit(threadId, { type: 'streaming_start' });
      // Multiple tool NAMES, all classified as the 'exploring' activity kind
      // (see getActivityKind in src/toolNameUtils.ts) so they all merge into
      // a single run.
      const names = ['Read', 'Grep', 'Bash', 'Glob'];
      for (let i = 0; i < 50; i++) {
        emit(threadId, {
          type: 'tool_use',
          record: {
            name: names[i % names.length],
            summary: `call #${i}`,
            timestamp: Date.now(),
            toolUseId: `live-${i}`,
            status: 'pending',
          },
        });
      }
    });
    // scheduleLiveToolsRender debounces at 80ms — wait past it with margin.
    await page.waitForTimeout(300);

    // All 50 calls collapse into exactly one live group: top-level .ct-tools
    // children stay bounded instead of growing 1:1 with the event count.
    await expect(page.locator('.ct-tools > *')).toHaveCount(1);
    const group = page.locator('.ct-tool-group').first();
    await expect(group).toBeVisible();
    await expect(group.locator('.ct-compressed-summary')).toHaveText('Exploring');
    await expect(group.locator('.ct-tool-group-count')).toHaveText('50');
    // "Still running" affordance on the header — every child is still pending.
    await expect(group.locator('.ct-tool-group-header')).toHaveClass(/ct-tool-active/);
    await expect(group.locator('.ct-tool-group-header')).toHaveAttribute('aria-expanded', 'true');
    // A RUNNING group stays open so live progress is visible.
    await expect(group.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);

    await shot(page, 'tool-call-grouping-live-running.png', { fullPage: true });
  });

  test('the in-flight tool still shows its own active indicator alongside resolved siblings', async ({ page }) => {
    await page.evaluate(() => {
      const emit = (window as any).__emitEvent;
      const threadId = 'thread-live-tool-grouping';
      emit(threadId, { type: 'streaming_start' });
      emit(threadId, { type: 'tool_use', record: { name: 'Read', summary: 'a.ts', timestamp: Date.now(), toolUseId: 'live-1', status: 'pending' } });
      emit(threadId, { type: 'tool_use', record: { name: 'Read', summary: 'b.ts', timestamp: Date.now(), toolUseId: 'live-2', status: 'pending' } });
    });
    await page.waitForTimeout(300);
    // In real usage, ClaudeSession finds the ToolCallRecord by toolUseId and
    // mutates `record.status` IN PLACE on the same object instance already
    // held in streamingBuffers — the tool_result_status event that follows
    // carries no status data of its own for ThreadsView to apply; it's purely
    // a "go re-render" signal (see the handler's comment in ThreadsView.ts).
    // The harness has no real ClaudeSession, so replicate that same-object
    // mutation here before firing the event, or the pill would never flip.
    await page.evaluate(() => {
      const view = (window as any).__view;
      const buf = view['streamingBuffers'].get('thread-live-tool-grouping');
      const record = buf.tools.find((t: any) => t.toolUseId === 'live-1');
      record.status = 'success';
      (window as any).__emitEvent('thread-live-tool-grouping', { type: 'tool_result_status', toolUseId: 'live-1', status: 'success' });
    });
    await page.waitForTimeout(300);

    // The group still has a pending member, so it is already open.
    const group = page.locator('.ct-tool-group').first();
    await expect(group.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);

    const pills = group.locator('.ct-full-content .ct-tool-pill');
    await expect(pills).toHaveCount(2);
    await expect(pills.nth(0)).toHaveClass(/ct-tool-success/);
    await expect(pills.nth(1)).toHaveClass(/ct-tool-active/);
  });

  test('a group the user collapsed mid-turn stays collapsed as more same-kind calls arrive (stable liveToolGroupKey)', async ({ page }) => {
    await page.evaluate(() => {
      const emit = (window as any).__emitEvent;
      const threadId = 'thread-live-tool-grouping';
      emit(threadId, { type: 'streaming_start' });
      for (let i = 0; i < 3; i++) {
        emit(threadId, { type: 'tool_use', record: { name: 'Read', summary: `#${i}`, timestamp: Date.now(), toolUseId: `live-${i}`, status: 'pending' } });
      }
    });
    await page.waitForTimeout(300);

    // Running groups default open; the user collapses this one.
    const group = page.locator('.ct-tool-group').first();
    await expect(group.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);
    await group.locator('.ct-tool-group-header').click();
    await expect(group.locator('.ct-full-content')).toHaveClass(/ct-hidden/);
    await expect(group.locator('.ct-tool-group-header')).toHaveAttribute('aria-expanded', 'false');

    // More same-kind calls arrive — the group rebuilds from scratch (fresh DOM
    // nodes every debounced render), but since it's keyed by the first call's
    // toolUseId + activity kind (liveToolGroupKey), the SAME group identity
    // persists across rebuilds and the freshly-built header/full-content
    // still read as "expanded".
    await page.evaluate(() => {
      const emit = (window as any).__emitEvent;
      const threadId = 'thread-live-tool-grouping';
      for (let i = 3; i < 8; i++) {
        emit(threadId, { type: 'tool_use', record: { name: 'Bash', summary: `#${i}`, timestamp: Date.now(), toolUseId: `live-${i}`, status: 'pending' } });
      }
    });
    await page.waitForTimeout(300);

    const groupAfter = page.locator('.ct-tool-group').first();
    await expect(groupAfter.locator('.ct-compressed-summary')).toHaveText('Exploring');
    await expect(groupAfter.locator('.ct-tool-group-count')).toHaveText('8');
    // The user's collapse of the running group survives the live rebuild.
    await expect(groupAfter.locator('.ct-full-content')).toHaveClass(/ct-hidden/);
  });

  test('switching away and back mid-turn restores the same grouped view, not a flat replay', async ({ page }) => {
    await page.evaluate(() => {
      const emit = (window as any).__emitEvent;
      const threadId = 'thread-live-tool-grouping';
      // beforeEach already seeded a user message (thread.messages is non-empty),
      // which matters here specifically: renderMessages() early-returns to the
      // empty-state placeholder when thread.messages IS empty — before it even
      // checks isRunning — so without that seed the restore-on-switch path
      // below would never be reached.
      // Mark the thread as running so renderMessages()'s restore-on-switch
      // path (gated on manager.isRunning) actually fires when we switch back.
      (window as any).__setThreadRunning(threadId, true);
      emit(threadId, { type: 'streaming_start' });
      for (let i = 0; i < 6; i++) {
        emit(threadId, { type: 'tool_use', record: { name: 'Read', summary: `#${i}`, timestamp: Date.now(), toolUseId: `live-${i}`, status: 'pending' } });
      }
    });
    await page.waitForTimeout(300);
    await expect(page.locator('.ct-tools > *')).toHaveCount(1);

    await page.evaluate(() => (window as any).__view.focusThread('thread-fix-auth'));
    await page.waitForTimeout(200);
    await page.evaluate(() => (window as any).__view.focusThread('thread-live-tool-grouping'));
    await page.waitForTimeout(200);

    // Restored view groups exactly like the live view did before the switch —
    // no flat per-tool-pill replay.
    await expect(page.locator('.ct-tools > *')).toHaveCount(1);
    const group = page.locator('.ct-tool-group').first();
    await expect(group.locator('.ct-compressed-summary')).toHaveText('Exploring');
  });

  // Regression guard for the actual bug shape: post-7b7d4fb, each tool-only
  // SDK turn arrives as its OWN 'message' event (not as tool_use events
  // accumulating into one flush at turn end — that path was covered by the
  // tests above and was never broken). This drives that exact sequence —
  // one 'message' event per raw tool-only ChatMessage, mirroring what
  // ThreadManager.onMessage really does — and confirms mergeAdjacentToolOnlyMessages
  // + the in-place tail-row rebuild (R3) keep the DOM bounded instead of
  // fragmenting 1:1 with events, and that R4's live keying keeps a mid-run
  // expand alive across further extensions of the SAME row.
  test('a sequence of per-turn "message" events (post-7b7d4fb persisted shape) merges into one bounded row and survives a mid-run expand', async ({ page }) => {
    const pushToolOnlyMessage = async (id: string, toolName: string, toolUseId: string) => {
      await page.evaluate(({ id, toolName, toolUseId }) => {
        const manager = (window as any).__manager;
        const threadId = 'thread-live-tool-grouping';
        const message = {
          id,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          toolCalls: [{ name: toolName, summary: `call ${id}`, toolUseId, status: 'success' }],
        };
        manager.getThread(threadId).messages.push(message);
        (window as any).__emitEvent(threadId, { type: 'message', message });
      }, { id, toolName, toolUseId });
    };

    await page.evaluate(() => {
      (window as any).__emitEvent('thread-live-tool-grouping', { type: 'streaming_start' });
    });
    await pushToolOnlyMessage('frag-1', 'Read', 'frag-tu-1');
    await pushToolOnlyMessage('frag-2', 'Read', 'frag-tu-2');
    await page.waitForTimeout(200);

    // Two separate raw messages, one Read call each — merged into ONE row
    // with ONE grouped tool entry, not two `.ct-message` rows.
    await expect(page.locator('.ct-message')).toHaveCount(2); // seeded user bubble + 1 merged assistant row
    const group = page.locator('.ct-tool-group').first();
    await expect(group).toBeVisible();
    await expect(group.locator('.ct-compressed-summary')).toHaveText('Read 2 files');

    // Expand the group mid-run.
    await group.locator('.ct-expand-btn').click();
    await expect(group.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);

    const messageCountBefore = await page.locator('.ct-message').count();

    // Three more tool-only turns arrive, each its own 'message' event.
    await pushToolOnlyMessage('frag-3', 'Grep', 'frag-tu-3');
    await pushToolOnlyMessage('frag-4', 'Bash', 'frag-tu-4');
    await pushToolOnlyMessage('frag-5', 'Read', 'frag-tu-5');
    await page.waitForTimeout(200);

    // DOM element count stays bounded rather than growing 1:1 with the 5
    // 'message' events fired in this test — exactly the regression this fix
    // closes (previously one full-height `.ct-message` per raw event).
    await expect(page.locator('.ct-message')).toHaveCount(messageCountBefore);

    // The group expanded mid-sequence must STILL be expanded after the run
    // extended further — regression guard for R4 (liveToolGroupKey keying).
    const groupAfter = page.locator('.ct-tool-group').first();
    await expect(groupAfter.locator('.ct-compressed-summary')).toHaveText('Read 3 files, searched 1 pattern, ran 1 command');
    await expect(groupAfter.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);

    await shot(page, 'tool-call-grouping-fragmented-live-merged.png', { fullPage: true });
  });

  // ─── Outer-wrap tier while LIVE — the live-updating "current tool" header ──
  // Fires 8 alternating-activity-kind tool_use events (each its own isolated
  // 'single' entry post-groupToolCalls/smoothToolGroups — alternating kinds
  // never merge, so this is a direct, simple way to push the post-smoothing
  // entry count past OUTER_WRAP_ENTRY_THRESHOLD without needing same-kind
  // runs) so the LIVE outer wrap kicks in, then proves its header text
  // actually tracks pickCurrentTool as new calls arrive — not just a
  // snapshot taken once at initial render.
  test('the outer wrap shows a live-updating current-tool header while calls are still pending, past the threshold', async ({ page }) => {
    await page.evaluate(() => {
      const emit = (window as any).__emitEvent;
      const threadId = 'thread-live-tool-grouping';
      emit(threadId, { type: 'streaming_start' });
      // 8 raw calls, each a different activity kind from its predecessor ->
      // 8 isolated 'single' entries, all still pending (no group entries to
      // sandwich, so smoothToolGroups is a no-op here) -> 8 > 7 -> wraps.
      const names = ['Read', 'Edit', 'TaskCreate', 'WebFetch', 'ToolSearch', 'Skill', 'Read', 'Edit'];
      names.forEach((name, i) => {
        emit(threadId, {
          type: 'tool_use',
          record: { name, summary: `call #${i}`, timestamp: Date.now(), toolUseId: `live-ow-${i}`, status: 'pending' },
        });
      });
    });
    await page.waitForTimeout(300);

    await expect(page.locator('.ct-tools > *')).toHaveCount(1);
    const outerWrap = page.locator('.ct-tool-outer-wrap').first();
    await expect(outerWrap).toBeVisible();
    const header = outerWrap.locator('.ct-tool-outer-wrap-header');
    await expect(header).toHaveClass(/ct-tool-active/);
    // Last call (index 7) is 'Edit' and still pending -> pickCurrentTool picks it.
    await expect(header.locator('.ct-tool-outer-wrap-live-summary .ct-tool-pill-name')).toHaveText('Edit');
    await expect(header.locator('.ct-tool-outer-wrap-live-summary .ct-tool-pill-text')).toHaveText('call #7');

    await shot(page, 'tool-call-grouping-outer-wrap-live-current-command.png', { fullPage: true });

    // Fire one more tool_use event for a DIFFERENT tool — concrete proof the
    // header live-updates rather than freezing at its first render.
    await page.evaluate(() => {
      (window as any).__emitEvent('thread-live-tool-grouping', {
        type: 'tool_use',
        record: { name: 'Bash', summary: 'call #8', timestamp: Date.now(), toolUseId: 'live-ow-8', status: 'pending' },
      });
    });
    await page.waitForTimeout(300);

    const headerAfter = page.locator('.ct-tool-outer-wrap-header').first();
    await expect(headerAfter.locator('.ct-tool-outer-wrap-live-summary .ct-tool-pill-name')).toHaveText('Bash');
    await expect(headerAfter.locator('.ct-tool-outer-wrap-live-summary .ct-tool-pill-text')).toHaveText('call #8');
  });

  // Proves the live outer-wrap header cleanly reverts to the static
  // "N tool calls, M steps" format once the turn finalizes — no stale
  // "currently running" text or duplicated header left behind. Mirrors the
  // "per-turn 'message' events" test above's finalization pattern: push a
  // real ChatMessage onto thread.messages and fire a 'message' event, which
  // is what actually settles a live run into the finalized render path.
  test('the outer wrap header reverts to the static format with no stale text after the turn finalizes', async ({ page }) => {
    const names = ['Read', 'Edit', 'TaskCreate', 'WebFetch', 'ToolSearch', 'Skill', 'Read', 'Edit', 'Bash'];
    await page.evaluate((names) => {
      const emit = (window as any).__emitEvent;
      const threadId = 'thread-live-tool-grouping';
      emit(threadId, { type: 'streaming_start' });
      names.forEach((name: string, i: number) => {
        emit(threadId, {
          type: 'tool_use',
          record: { name, summary: `call #${i}`, timestamp: Date.now(), toolUseId: `live-fin-${i}`, status: 'pending' },
        });
      });
    }, names);
    await page.waitForTimeout(300);
    await expect(page.locator('.ct-tool-outer-wrap-header')).toHaveCount(1);
    await expect(page.locator('.ct-tool-outer-wrap-header')).toHaveClass(/ct-tool-active/);

    await page.evaluate((names) => {
      const manager = (window as any).__manager;
      const threadId = 'thread-live-tool-grouping';
      const message = {
        id: 'live-fin-msg',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: names.map((name: string, i: number) => ({
          name,
          summary: `call #${i}`,
          toolUseId: `live-fin-${i}`,
          status: 'success',
        })),
      };
      manager.getThread(threadId).messages.push(message);
      (window as any).__emitEvent(threadId, { type: 'message', message });
    }, names);
    await page.waitForTimeout(300);

    // Exactly one outer-wrap header survives finalization — no duplicate from
    // the live view lingering alongside the newly-appended finalized row.
    const headers = page.locator('.ct-tool-outer-wrap-header');
    await expect(headers).toHaveCount(1);
    await expect(headers).not.toHaveClass(/ct-tool-active/);
    // 9 raw calls, all isolated singles (alternating kinds) -> 9 entries, 9 steps.
    await expect(headers.locator('.ct-compressed-summary')).toHaveText('9 tool calls, 9 steps');
    await expect(headers.locator('.ct-tool-outer-wrap-live-summary')).toHaveCount(0);
  });
});

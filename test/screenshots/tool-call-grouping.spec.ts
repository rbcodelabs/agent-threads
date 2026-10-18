import { test, expect } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

// Grouping model (src/toolNameUtils.ts groupToolRuns): every unbroken run of
// non-browser tool calls is ONE group, whatever the commands are; a lone call
// is a group of one. Groups are COLLAPSED by default whether running, finished
// or failed — a failure only turns the header red. A group stays open only
// when the user opened it.
//
// Fixture: 'thread-tool-grouping' (test/harness/fixtures.ts) — a single
// assistant message with 15 mixed-kind tool calls (one failed Edit). Unbroken,
// so it renders as exactly ONE collapsed group.

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

  test('an unbroken mixed-kind run is ONE group, collapsed by default', async ({ page }) => {
    await expect(page.locator('.ct-tool-group')).toHaveCount(1);
    const group = page.locator('.ct-tool-group').first();
    await expect(group.locator('.ct-tool-group-count')).toHaveText('15');
    await expect(group.locator('.ct-tool-group-header')).toHaveAttribute('aria-expanded', 'false');
    await expect(group.locator('.ct-full-content')).toHaveClass(/ct-hidden/);
    await shot(page, 'tool-call-grouping-collapsed.png', { fullPage: true });
  });

  test('clicking a group header expands it', async ({ page }) => {
    const group = page.locator('.ct-tool-group').first();
    await group.locator('.ct-tool-group-header').click();
    await expect(group.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);
    await expect(group.locator('.ct-full-content .ct-tool-pill')).toHaveCount(15);
    await page.waitForTimeout(200);
    await shot(page, 'tool-call-grouping-expanded.png', { fullPage: true });
  });

  test('a failed call flags the header red but does NOT open the group', async ({ page }) => {
    const group = page.locator('.ct-tool-group').first();
    await expect(group.locator('.ct-tool-group-header')).toHaveClass(/ct-tool-error/);
    await expect(group.locator('.ct-tool-group-status.ct-tool-state-error')).toHaveCount(1);
    await expect(group.locator('.ct-full-content')).toHaveClass(/ct-hidden/);
    await shot(group, 'tool-call-grouping-error-collapsed.png');

    // Opening it reveals exactly one red row.
    await group.locator('.ct-tool-group-header').click();
    await expect(group.locator('.ct-tool-pill.ct-tool-error')).toHaveCount(1);
  });

  test('there are no bare tool rows: every call lives inside a group', async ({ page }) => {
    await expect(page.locator('.ct-tools > .ct-tool-pill')).toHaveCount(0);
    await expect(page.locator('.ct-tools > .ct-tool-group')).toHaveCount(1);
    await expect(page.locator('.ct-tool-outer-wrap')).toHaveCount(0);
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

// ─── Long mixed runs (formerly the "outer wrap" tier) ───────────────────────
// Fixture: 'thread-outer-wrap-tool-calls' — TWO assistant messages with 22 and
// 13 tool calls spanning many kinds. There is no second collapsible tier any
// more: each message's unbroken run is ONE collapsed group whose header
// summarizes per kind.
//   - msg-t8-2 (22 calls, no error) -> .ct-tool-group nth(0)
//   - msg-t8-3 (13 calls, one buried error) -> nth(1); red header, still collapsed

test.describe('Long mixed runs (finalized)', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__view.focusThread('thread-outer-wrap-tool-calls'));
    await page.waitForSelector('.ct-tool-group');
    await page.waitForTimeout(200);
  });

  test('each message is one collapsed group; the obsolete outer wrap is gone', async ({ page }) => {
    await expect(page.locator('.ct-tool-outer-wrap')).toHaveCount(0);
    const groups = page.locator('.ct-tool-group');
    await expect(groups).toHaveCount(2);
    const first = groups.nth(0);
    await expect(first.locator('.ct-tool-group-count')).toHaveText('22');
    await expect(first.locator('.ct-tool-group-header')).toHaveAttribute('aria-expanded', 'false');
    await expect(first.locator('.ct-full-content')).toHaveClass(/ct-hidden/);
    await shot(page, 'tool-call-grouping-long-run-collapsed.png', { fullPage: true });
  });

  test('expanding shows every call as a plain row in the one group', async ({ page }) => {
    const first = page.locator('.ct-tool-group').nth(0);
    await first.locator('.ct-tool-group-header').click();
    await expect(first.locator('.ct-full-content > .ct-tool-pill')).toHaveCount(22);
    await page.waitForTimeout(200);
    await shot(page, 'tool-call-grouping-long-run-expanded.png', { fullPage: true });
  });

  test('a buried error turns the header red but leaves the group collapsed', async ({ page }) => {
    const second = page.locator('.ct-tool-group').nth(1);
    await expect(second.locator('.ct-tool-group-count')).toHaveText('13');
    await expect(second.locator('.ct-tool-group-header')).toHaveClass(/ct-tool-error/);
    await expect(second.locator('.ct-tool-group-header')).toHaveAttribute('aria-expanded', 'false');
    await expect(second.locator('.ct-full-content')).toHaveClass(/ct-hidden/);
    await shot(page, 'tool-call-grouping-long-run-error-collapsed.png', { fullPage: true });
  });
});

// ─── Fragmented tool-only messages (post-7b7d4fb regression shape) ─────────
// Fixture: 'thread-fragmented-tool-calls' (test/harness/fixtures.ts) — 5
// SEPARATE ChatMessage objects (role: 'assistant', content: '', exactly one
// toolCall each: Read, Grep, Edit, Edit, Bash), reproducing the actual
// persisted shape after 7b7d4fb ("fix: persist tool-only assistant messages
// instead of silently dropping them"). Before mergeAdjacentToolOnlyMessages,
// this rendered as 5 separate full-height `.ct-message` rows — one per raw
// persisted turn — instead of a single collapsible activity group.

test.describe('Fragmented tool-only messages (view-layer merge)', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
  });

  test('renderMessages() merges 5 separate tool-only ChatMessages into ONE collapsed group, not one row per message', async ({ page }) => {
    await page.evaluate(() => (window as any).__view.focusThread('thread-fragmented-tool-calls'));
    await page.waitForSelector('.ct-tool-group');
    await page.waitForTimeout(200);

    // 1 user bubble + 1 merged assistant row (not the 6 raw fixture messages).
    await expect(page.locator('.ct-message')).toHaveCount(2);

    // Read, Grep, Edit, Edit, Bash is one unbroken run: a single group.
    await expect(page.locator('.ct-tool-group')).toHaveCount(1);
    const group = page.locator('.ct-tool-group').first();
    await expect(group.locator('.ct-tool-group-count')).toHaveText('5');
    await expect(group.locator('.ct-full-content')).toHaveClass(/ct-hidden/);

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
    // Collapsed by default even while running; the header carries the live progress.
    await expect(group.locator('.ct-tool-group-header')).toHaveAttribute('aria-expanded', 'false');
    await expect(group.locator('.ct-full-content')).toHaveClass(/ct-hidden/);
    await expect(group.locator('.ct-tool-group-status.ct-tool-state-pending')).toHaveCount(1);

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

    // The group still has a pending member but is collapsed; open it to inspect rows.
    const group = page.locator('.ct-tool-group').first();
    await expect(group.locator('.ct-full-content')).toHaveClass(/ct-hidden/);
    await expect(group.locator('.ct-tool-group-header')).toHaveClass(/ct-tool-active/);
    await group.locator('.ct-tool-group-header').click();
    await expect(group.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);

    const pills = group.locator('.ct-full-content .ct-tool-pill');
    await expect(pills).toHaveCount(2);
    await expect(pills.nth(0)).toHaveClass(/ct-tool-success/);
    await expect(pills.nth(1)).toHaveClass(/ct-tool-active/);
  });

  test('a group the user opened mid-turn stays open as more calls arrive (stable liveToolGroupKey)', async ({ page }) => {
    await page.evaluate(() => {
      const emit = (window as any).__emitEvent;
      const threadId = 'thread-live-tool-grouping';
      emit(threadId, { type: 'streaming_start' });
      for (let i = 0; i < 3; i++) {
        emit(threadId, { type: 'tool_use', record: { name: 'Read', summary: `#${i}`, timestamp: Date.now(), toolUseId: `live-${i}`, status: 'pending' } });
      }
    });
    await page.waitForTimeout(300);

    // Running groups are collapsed by default; the user opens this one.
    const group = page.locator('.ct-tool-group').first();
    await expect(group.locator('.ct-full-content')).toHaveClass(/ct-hidden/);
    await group.locator('.ct-tool-group-header').click();
    await expect(group.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);
    await expect(group.locator('.ct-tool-group-header')).toHaveAttribute('aria-expanded', 'true');

    // More calls arrive — the group rebuilds from scratch (fresh DOM nodes every
    // debounced render), but it is keyed by the first call's toolUseId
    // (liveToolGroupKey), so the freshly-built group still reads as opened.
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
    await expect(groupAfter.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);
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

  // ─── Mixed-kind runs, live and finalized ───────────────────────────────────
  // Alternating activity kinds used to split into many entries (and trip the
  // outer wrap). They are now ONE group: "Working" while running, a per-kind
  // summary once finished.
  test('alternating-kind live calls stay ONE collapsed group labelled Working', async ({ page }) => {
    await page.evaluate(() => {
      const emit = (window as any).__emitEvent;
      const threadId = 'thread-live-tool-grouping';
      emit(threadId, { type: 'streaming_start' });
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
    await expect(page.locator('.ct-tool-outer-wrap')).toHaveCount(0);
    const group = page.locator('.ct-tool-group').first();
    await expect(group.locator('.ct-tool-group-header')).toHaveClass(/ct-tool-active/);
    await expect(group.locator('.ct-compressed-summary')).toHaveText('Working');
    await expect(group.locator('.ct-tool-group-count')).toHaveText('8');
    await expect(group.locator('.ct-full-content')).toHaveClass(/ct-hidden/);
    await shot(page, 'tool-call-grouping-live-mixed-running.png', { fullPage: true });

    // One more call of yet another kind grows the same group.
    await page.evaluate(() => {
      (window as any).__emitEvent('thread-live-tool-grouping', {
        type: 'tool_use',
        record: { name: 'Bash', summary: 'call #8', timestamp: Date.now(), toolUseId: 'live-ow-8', status: 'pending' },
      });
    });
    await page.waitForTimeout(300);
    await expect(page.locator('.ct-tool-group')).toHaveCount(1);
    await expect(page.locator('.ct-tool-group-count')).toHaveText('9');
  });

  test('a finalized mixed-kind run is ONE collapsed group summarised per kind', async ({ page }) => {
    await page.evaluate(() => {
      const manager = (window as any).__manager;
      const threadId = 'thread-live-tool-grouping';
      const message = {
        id: 'mixed-msg',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [
          { name: 'Read', summary: 'a.ts', toolUseId: 'mix-1', status: 'success' },
          { name: 'Read', summary: 'b.ts', toolUseId: 'mix-2', status: 'success' },
          { name: 'Edit', summary: 'a.ts', toolUseId: 'mix-3', status: 'success' },
        ],
      };
      manager.getThread(threadId).messages.push(message);
      (window as any).__emitEvent(threadId, { type: 'message', message });
    });
    await page.waitForTimeout(300);

    await expect(page.locator('.ct-tool-group')).toHaveCount(1);
    const group = page.locator('.ct-tool-group').first();
    await expect(group.locator('.ct-compressed-summary')).toHaveText('Read 2 files, edited 1 file');
    await expect(group.locator('.ct-tool-group-count')).toHaveText('3');
    await expect(group.locator('.ct-tool-group-header')).toHaveAttribute('aria-expanded', 'false');
    await expect(group.locator('.ct-full-content')).toHaveClass(/ct-hidden/);
    await shot(page, 'tool-call-grouping-mixed-kind-collapsed.png', { fullPage: true });
  });

  test('a group already on screen repaints IN PLACE when a result lands (no rebuild)', async ({ page }) => {
    // A row committed while a call is still pending: its DOM is drawn as running
    // and is NOT rebuilt when the result arrives.
    await page.evaluate(() => {
      const manager = (window as any).__manager;
      const threadId = 'thread-live-tool-grouping';
      const message = {
        id: 'inplace-msg',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [
          { name: 'Read', summary: 'a.ts', toolUseId: 'ip-1', status: 'success' },
          { name: 'Bash', summary: 'npm test', toolUseId: 'ip-2', status: 'pending' },
        ],
      };
      manager.getThread(threadId).messages.push(message);
      (window as any).__emitEvent(threadId, { type: 'message', message });
    });
    await page.waitForTimeout(300);

    const group = page.locator('.ct-tool-group').first();
    await expect(group.locator('.ct-tool-group-header')).toHaveClass(/ct-tool-active/);
    await expect(group.locator('.ct-tool-group-status.ct-tool-state-pending')).toHaveCount(1);
    await expect(group.locator('.ct-tool-group-running')).toHaveCount(1);
    // Tag the live element so we can prove it was repainted, not replaced.
    await group.evaluate((el) => el.setAttribute('data-keep', 'same-node'));

    // The session mutates the record in place, then emits the status event.
    await page.evaluate(() => {
      const manager = (window as any).__manager;
      const threadId = 'thread-live-tool-grouping';
      const msg = manager.getThread(threadId).messages.find((m: any) => m.id === 'inplace-msg');
      msg.toolCalls[1].status = 'success';
      (window as any).__emitEvent(threadId, { type: 'tool_result_status', toolUseId: 'ip-2', status: 'success' });
    });
    await page.waitForTimeout(300);

    const same = page.locator('.ct-tool-group[data-keep="same-node"]');
    await expect(same).toHaveCount(1);
    await expect(same.locator('.ct-tool-group-header')).not.toHaveClass(/ct-tool-active/);
    await expect(same.locator('.ct-tool-group-status.ct-tool-state-success')).toHaveCount(1);
    await expect(same.locator('.ct-tool-group-status.ct-tool-state-pending')).toHaveCount(0);
    await expect(same.locator('.ct-tool-group-running')).toHaveCount(0);
    await expect(same.locator('.ct-full-content')).toHaveClass(/ct-hidden/);
    await expect(same.locator('.ct-compressed-summary')).toHaveText('Read 1 file, ran 1 command');

    // And a failing result turns the header red without opening the group.
    await page.evaluate(() => {
      const manager = (window as any).__manager;
      const threadId = 'thread-live-tool-grouping';
      const msg = manager.getThread(threadId).messages.find((m: any) => m.id === 'inplace-msg');
      msg.toolCalls[1].status = 'error';
      (window as any).__emitEvent(threadId, { type: 'tool_result_status', toolUseId: 'ip-2', status: 'error' });
    });
    await expect(same.locator('.ct-tool-group-header')).toHaveClass(/ct-tool-error/);
    await expect(same.locator('.ct-full-content')).toHaveClass(/ct-hidden/);
    await shot(page, 'tool-call-grouping-inplace-failed.png', { fullPage: true });
  });

  test('the live group header reverts to the static summary with no stale text after the turn finalizes', async ({ page }) => {
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
    await expect(page.locator('.ct-tool-group-header')).toHaveCount(1);
    await expect(page.locator('.ct-tool-group-header')).toHaveClass(/ct-tool-active/);

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

    // Exactly one group survives finalization — no duplicate from the live view.
    const headers = page.locator('.ct-tool-group-header');
    await expect(headers).toHaveCount(1);
    await expect(headers).not.toHaveClass(/ct-tool-active/);
    await expect(headers.locator('.ct-tool-group-running')).toHaveCount(0);
    await expect(headers.locator('.ct-tool-group-count')).toHaveText('9');
    await expect(headers.locator('.ct-compressed-summary')).not.toHaveText('Working');
  });
});

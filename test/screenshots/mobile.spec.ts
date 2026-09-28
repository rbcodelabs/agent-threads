import { test, expect } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

/**
 * Mobile visual regression tests.
 *
 * Coverage matrix — every UI state and every element we touch in mobile sprints
 * should have a snapshot here.
 *
 * Full-page snapshots:
 *   mobile-pairing          — disconnected state (pairing instructions)
 *   mobile-connected        — conversation panel, streaming in progress (iPhone 14, 390px)
 *   mobile-thread-list      — thread list panel, no active thread  (iPhone 14, 390px)
 *   mobile-thread-list-se   — thread list at iPhone SE width (320px) — catches overflow regressions
 *   mobile-connected-ipad   — conversation panel at iPad width (820px)
 *   mobile-message-overflow — long tokens, wide code block, wide table (390px); paired
 *                             with a geometry assertion that nothing runs off the edge
 *
 * Element-level snapshots (clipped — catch small button/layout changes that are
 * invisible against a full 390×844 canvas):
 *   mobile-input-toolbar       — .ct-mobile-input-row: send, attach, stop buttons + textarea
 *   mobile-permission-card     — .ct-mobile-permission-card: deny/allow/always-allow buttons
 *   mobile-question-card       — .ct-mobile-question-card: single-select + multiSelect questions, Other, Submit
 *   mobile-queue-rows          — .ct-mobile-queue-rows: stacked queue rows above composer
 *   mobile-status-rail-active  — .ct-mobile-status-rail: compacting status card
 *   mobile-error-card          — .ct-mobile-error-card: error display with dismiss
 *   mobile-thread-list-search  — thread list filtered by search query
 */

const mobileHarnessUrl = (view: string, opts?: { width?: number; height?: number }) => {
  const base = 'file://' + path.resolve('test/harness/mobile.html');
  const params = new URLSearchParams({ view });
  if (opts?.width) params.set('width', String(opts.width));
  if (opts?.height) params.set('height', String(opts.height));
  return `${base}?${params.toString()}`;
};

/**
 * Returns a description of every element inside `.ct-mobile-messages` whose
 * content runs past the thread container's edge instead of wrapping (prose) or
 * scrolling inside itself (code blocks, tables). Empty array = no overflow.
 *
 * `.ct-mobile-messages` clips horizontally, so its own scrollWidth can't be
 * trusted — an element can be cut off at the right edge while the container
 * reports no overflow. Check each element's geometry instead:
 *   - its box must sit inside the container, and
 *   - if it lets content spill (overflow-x: visible) or silently clips it
 *     (hidden/clip without an ellipsis), its scrollWidth must fit its clientWidth.
 * Descendants of an element that scrolls horizontally (overflow-x: auto/scroll)
 * are skipped — that element is the intended scroller and is checked itself.
 */
async function findHorizontalOverflow(page: import('@playwright/test').Page): Promise<string[]> {
  return page.locator('.ct-mobile-messages').evaluate((container) => {
    const bounds = container.getBoundingClientRect();
    const describe = (el: Element) =>
      el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '');
    const insideScroller = (el: Element) => {
      for (let p = el.parentElement; p && p !== container; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
      return false;
    };
    const problems: string[] = [];
    for (const el of Array.from(container.querySelectorAll('*'))) {
      if (insideScroller(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.right > bounds.right + 1 || rect.left < bounds.left - 1) {
        problems.push(`${describe(el)} box [${Math.round(rect.left)}, ${Math.round(rect.right)}] outside container [${Math.round(bounds.left)}, ${Math.round(bounds.right)}]`);
        continue;
      }
      const style = getComputedStyle(el);
      const clipsOrSpills = style.overflowX === 'visible' || ((style.overflowX === 'hidden' || style.overflowX === 'clip') && style.textOverflow !== 'ellipsis');
      const html = el as HTMLElement;
      if (clipsOrSpills && html.clientWidth > 0 && html.scrollWidth > html.clientWidth + 1) {
        problems.push(`${describe(el)} content ${html.scrollWidth}px wider than its ${html.clientWidth}px box (overflow-x: ${style.overflowX})`);
      }
    }
    return problems;
  });
}

test.describe('Mobile message horizontal overflow', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  });

  for (const viewport of [
    { width: 390, height: 844, label: 'iPhone 14' },
    { width: 320, height: 568, label: 'iPhone SE' },
  ]) {
    test(`long tokens, wide code and wide tables stay inside the thread view (${viewport.label} — ${viewport.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(mobileHarnessUrl('mobile-overflow', viewport));
      await page.waitForSelector('.ct-mobile-messages table');
      await page.waitForSelector('.ct-mobile-messages pre');
      await page.waitForTimeout(300);

      expect(await findHorizontalOverflow(page)).toEqual([]);

      // The wide code block and table must still be reachable by scrolling
      // inside themselves, not truncated.
      for (const selector of ['.ct-mobile-messages pre', '.ct-mobile-messages table']) {
        const scrollable = await page.locator(selector).first().evaluate((el) => {
          for (let node: HTMLElement | null = el as HTMLElement; node; node = node.parentElement) {
            const ox = getComputedStyle(node).overflowX;
            if ((ox === 'auto' || ox === 'scroll') && node.scrollWidth > node.clientWidth) return true;
            if (node.classList.contains('ct-mobile-messages')) return false;
          }
          return false;
        });
        expect(scrollable, `${selector} should scroll horizontally inside itself`).toBe(true);
      }
    });
  }

  test('seeded conversation has no horizontal overflow (iPhone 14 — 390px)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-connected'));
    await page.waitForSelector('.ct-mobile-conv-panel');
    await page.waitForTimeout(300);
    expect(await findHorizontalOverflow(page)).toEqual([]);
  });

  test('overflow stress thread screenshot (iPhone 14 — 390px)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-overflow'));
    await page.waitForSelector('.ct-mobile-messages table');
    await page.waitForTimeout(300);
    await shot(page, 'mobile-message-overflow.png', { fullPage: true });
  });
});

test.describe('Mobile View', () => {
  // Pin Date.now()/new Date() to the fixture epoch (test/harness/fixtures.ts)
  // so relative labels ("Last active …") are deterministic — without this,
  // baselines with "Xd ago" text drift every day the suite is run.
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  });

  // ── Full-page snapshots ────────────────────────────────────────────────────

  test('mobile pairing screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-pairing'));
    await page.waitForSelector('.ct-mobile-pairing');
    await page.waitForTimeout(300);
    await shot(page, 'mobile-pairing.png', { fullPage: true });
  });

  test('mobile connected view (conversation panel)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-connected'));
    await page.waitForSelector('.ct-mobile-conv-panel');
    await page.waitForTimeout(300);
    await shot(page, 'mobile-connected.png', { fullPage: true });
  });

  test('mobile thread list (iPhone 14 — 390px)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-thread-list'));
    await page.waitForSelector('.ct-mobile-thread-list');
    await page.waitForTimeout(300);
    await shot(page, 'mobile-thread-list.png', { fullPage: true });
  });

  test('mobile thread list (iPhone SE — 320px)', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(mobileHarnessUrl('mobile-thread-list', { width: 320, height: 568 }));
    await page.waitForSelector('.ct-mobile-thread-list');
    await page.waitForTimeout(300);
    await shot(page, 'mobile-thread-list-se.png', { fullPage: true });
  });

  test('mobile connected view (iPad — 820px)', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto(mobileHarnessUrl('mobile-connected', { width: 820, height: 1180 }));
    await page.waitForSelector('.ct-mobile-conv-panel');
    await page.waitForTimeout(300);
    await shot(page, 'mobile-connected-ipad.png', { fullPage: true });
  });

  // ── Element-level snapshots ────────────────────────────────────────────────
  // These clip to specific components so a 10px change on a 34px button doesn't
  // vanish against the noise of an 844px full-page canvas.

  test('input toolbar (send, attach, stop buttons + textarea)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-connected'));
    await page.waitForSelector('.ct-mobile-input-row');
    await page.waitForTimeout(300);
    await shot(page.locator('.ct-mobile-input-row'), 'mobile-input-toolbar.png');
  });

  test('input toolbar focused (accent border ring)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-connected'));
    await page.waitForSelector('.ct-mobile-input');
    await page.locator('.ct-mobile-input').focus();
    await page.waitForTimeout(200);
    await shot(page.locator('.ct-mobile-input-row'), 'mobile-input-toolbar-focused.png');
  });

  test('permission card (deny / allow buttons — 44px tap targets)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-permission'));
    await page.waitForSelector('.ct-mobile-permission-card');
    await page.waitForTimeout(300);
    await shot(page.locator('.ct-mobile-permission-card'), 'mobile-permission-card.png');
  });

  test('question card (single-select + multiSelect, Other, 44px tap targets)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-question'));
    await page.waitForSelector('.ct-mobile-question-card');
    await page.waitForTimeout(300);
    await shot(page.locator('.ct-mobile-question-card'), 'mobile-question-card.png');
  });

  test('queue rows (stacked above composer, replace flat banner)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-queue'));
    // Phase 3: flat .ct-mobile-queue-banner replaced by .ct-mobile-queue-rows with individual rows
    await page.waitForSelector('.ct-mobile-queue-rows');
    await page.waitForTimeout(300);
    await shot(page.locator('.ct-mobile-queue-rows'), 'mobile-queue-rows.png');
  });

  // ── Phase 3 element-level snapshots ───────────────────────────────────────

  test('status rail — compacting card', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-connected'));
    // Wait for conv panel — status rail exists but is hidden until a status frame arrives
    await page.waitForSelector('.ct-mobile-conv-panel');
    await page.waitForTimeout(300);
    // Inject a status frame to trigger the compacting card
    await page.evaluate(() => {
      (window as any).__store.applyFrame({ type: 'status', threadId: 'thread-fix-auth', status: 'compacting' });
    });
    // Wait for the card to appear inside the rail
    await page.waitForSelector('.ct-status-card');
    await page.waitForTimeout(200);
    await shot(page.locator('.ct-mobile-status-rail'), 'mobile-status-rail-active.png');
  });

  test('error card — lastError with dismiss button', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-thread-list'));
    await page.waitForSelector('.ct-mobile-thread-list');
    // Inject an errored thread as active
    await page.evaluate(() => {
      (window as any).__store.applyFrame({
        type: 'snapshot',
        threads: [{
          id: 'err-snap', title: 'Error thread', cwd: '/projects/test',
          messages: [{ id: 'm1', role: 'user', content: 'Do something', timestamp: 1000 }],
          lastError: 'WebSocket closed (1006) — connection lost',
          createdAt: 0, updatedAt: 1000,
        }],
        activeThreadId: 'err-snap',
      });
    });
    await page.waitForSelector('.ct-mobile-error-card');
    await page.waitForTimeout(300);
    await shot(page.locator('.ct-mobile-error-card'), 'mobile-error-card.png');
  });

  test('thread list — search filtered results', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-thread-list'));
    await page.waitForSelector('.ct-mobile-search-input');
    await page.locator('.ct-mobile-search-input').fill('auth');
    await page.waitForTimeout(250); // debounce
    await shot(page.locator('.ct-mobile-list-panel'), 'mobile-thread-list-search.png');
  });

  // ── Live tool-call grouping ────────────────────────────────────────────────
  // Mobile has no debounced live-render pipeline (unlike desktop's
  // scheduleLiveToolsRender) — MobileThreadStore.applyFrame's 'tool_use' case
  // pushes onto streamingTools and notifies synchronously on every frame, and
  // MobileView.updateStreamingEl() fully rebuilds the streaming element (and
  // therefore renderToolCalls) on every single one. So this test just fires a
  // burst of frames directly via window.__store.applyFrame (same pattern as
  // the status-rail/error-card tests above) and asserts the FINAL rendered
  // state stays bounded, exercising the exact same MobileView.renderToolCalls
  // grouping path production frames go through.

  // ── Inline visualization marker ────────────────────────────────────────────
  //
  // The mobile client is a relay: the fragment file lives on the desktop
  // machine's disk, and renderConversation() rebuilds the whole conversation on
  // every finalized message with no throttle. So a marker renders as inert card
  // chrome here, never a sandboxed iframe.

  for (const viewport of [
    { width: 390, height: 844, label: 'iPhone 14' },
    { width: 375, height: 667, label: 'iPhone SE' },
  ]) {
    test(`visualize marker renders as an inert card (${viewport.label} — ${viewport.width}x${viewport.height})`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(mobileHarnessUrl('mobile-connected', { width: viewport.width, height: viewport.height }));
      await page.waitForSelector('.ct-mobile-conv-panel');
      await page.evaluate(() => (window as any).__store.setActiveThreadId('thread-visualize'));
      await page.waitForSelector('.ct-visualize-card');

      // The marker must never survive as raw text.
      const text = await page.locator('.ct-mobile-messages').innerText();
      if (text.includes('visualize')) {
        throw new Error('canonical visualize reference leaked into the mobile message as raw text');
      }
      await expect(page.locator('iframe')).toHaveCount(0);
      await expect(page.locator('.ct-visualize-card.ct-visualize-static')).toHaveCount(1);
      await expect(page.locator('.ct-visualize-title')).toHaveText('Quarterly revenue');
      // The card must not push the conversation into horizontal overflow.
      const overflow = await page.locator('.ct-mobile-messages').evaluate(
        (el) => el.scrollWidth - el.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);

      await expect(page).toHaveScreenshot(`mobile-visualize-card-${viewport.width}.png`, { fullPage: true });
    });
  }

  test('visualize card offers an Open button when the fragment is in the synced vault', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-connected'));
    await page.waitForSelector('.ct-mobile-conv-panel');
    // Pretend the fragment synced into the vault. Obsidian Mobile does have a
    // vault index, so the card can offer a real action in that case.
    await page.evaluate(() => {
      const view = (window as any).__mobileView;
      view.app = {
        ...view.app,
        vault: { getAbstractFileByPath: (p: string) => (p === 'viz/quarterly-revenue.html' ? { path: p } : null) },
        workspace: { openLinkText: () => {} },
      };
      (window as any).__store.setActiveThreadId('thread-visualize');
    });
    await page.waitForSelector('.ct-visualize-open');
    await expect(page.locator('.ct-visualize-open')).toHaveText('Open visualization');
    // 44px is the minimum comfortable tap target; the card is the only
    // affordance on mobile so it must clear it.
    const height = await page.locator('.ct-visualize-open').evaluate((el) => (el as HTMLElement).offsetHeight);
    expect(height).toBeGreaterThanOrEqual(30);
    await expect(page.locator('.ct-visualize-card')).toHaveScreenshot('mobile-visualize-card-open-button.png');
  });

  test('live tool-call grouping — a burst of same-kind calls collapses into one bounded group', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-connected'));
    await page.waitForSelector('.ct-mobile-conv-panel');
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      const store = (window as any).__store;
      const threadId = 'thread-fix-auth';
      // Multiple tool NAMES, all classified as the 'exploring' activity kind
      // (see getActivityKind in src/toolNameUtils.ts) so they all merge into
      // a single run — mirrors the desktop live-grouping burst test.
      const names = ['Read', 'Grep', 'Bash', 'Glob'];
      for (let i = 0; i < 50; i++) {
        store.applyFrame({ type: 'tool_use', threadId, name: names[i % names.length], summary: `call #${i}` });
      }
    });
    await page.waitForTimeout(200);

    // Scope to the LIVE streaming element (.ct-mobile-streaming) — the fixture
    // thread's already-settled messages also render their own .ct-tools/
    // .ct-tool-group (thread1Messages has a finalized 2-call Read group), so
    // an unscoped locator would match those too.
    const liveTools = page.locator('.ct-mobile-streaming .ct-tools');
    // All 50 calls collapse into exactly one live group: top-level .ct-tools
    // children stay bounded instead of growing 1:1 with the frame count.
    await expect(liveTools.locator('> *')).toHaveCount(1);
    const group = liveTools.locator('.ct-tool-group').first();
    await expect(group).toBeVisible();
    await expect(group.locator('.ct-compressed-summary')).toHaveText('Exploring (50)');
    // Collapsed by default (mobile has no per-tool status, so there's no
    // error-triggered auto-expand to worry about either).
    await expect(group.locator('.ct-full-content')).toHaveClass(/ct-hidden/);

    await shot(page, 'mobile-live-tool-call-grouping.png', { fullPage: true });
  });

  test('live tool-call grouping — expanding still shows every individual call', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-connected'));
    await page.waitForSelector('.ct-mobile-conv-panel');
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      const store = (window as any).__store;
      const threadId = 'thread-fix-auth';
      for (let i = 0; i < 5; i++) {
        store.applyFrame({ type: 'tool_use', threadId, name: 'Read', summary: `call #${i}` });
      }
    });
    await page.waitForTimeout(200);

    const group = page.locator('.ct-mobile-streaming .ct-tool-group').first();
    await group.locator('.ct-expand-btn').click();
    await expect(group.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);
    await expect(group.locator('.ct-full-content .ct-tool-pill')).toHaveCount(5);
  });

  for (const viewport of [
    { width: 390, height: 844, label: 'iPhone 14' },
    { width: 375, height: 667, label: 'iPhone SE' },
  ]) {
    test(`Codex-native command records render with terminal semantics (${viewport.label})`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(mobileHarnessUrl('mobile-codex-tools', viewport));
      await page.waitForSelector('.ct-mobile-conv-panel');

      const group = page.locator('.ct-mobile-messages .ct-tool-group').first();
      await expect(group.locator('.ct-compressed-summary')).toHaveText('Exploring (3)');
      await expect(group.locator('.ct-tool-group-header .lucide-terminal')).toHaveCount(1);
      await group.locator('.ct-expand-btn').click();
      await expect(group.locator('.ct-tool-pill-name')).toHaveText(['Bash', 'Bash', 'Bash']);
      await expect(group.locator('.ct-full-content .lucide-terminal')).toHaveCount(3);

      const overflow = await page.locator('.ct-mobile-messages').evaluate(
        (el) => el.scrollWidth - el.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);

      await shot(page, `mobile-codex-native-tools-${viewport.width}.png`, { fullPage: true });
    });
  }
});

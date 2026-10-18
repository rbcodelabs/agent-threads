import { test, expect, type Page } from '@playwright/test';
import path from 'path';

/**
 * Functional + visual QA for the "Tool call style" setting and sequential,
 * collapsed-by-default tool groups, at the real viewports the PR guidelines
 * require (desktop 1280x800, mobile 390x844, mobile SE 375x667).
 *
 * Unlike tool-call-styles.spec.ts (420px, pixel baselines) this spec asserts
 * behaviour and geometry only — no committed baselines. When QA_SHOTS_DIR is
 * set it also writes PNGs there for human review; otherwise screenshots are
 * skipped so the default `npm run test:screenshots` run stays baseline-only.
 */

const STYLES = ['chips', 'tree', 'cards'] as const;
type Style = (typeof STYLES)[number];

const desktopUrl = 'file://' + path.resolve('test/harness/index.html');
const mobileUrl = (width: number, height: number) => {
  const params = new URLSearchParams({ view: 'mobile-thread-list', width: String(width), height: String(height) });
  return `file://${path.resolve('test/harness/mobile.html')}?${params.toString()}`;
};

async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.QA_SHOTS_DIR;
  if (!dir) return;
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: false });
}

/** Elements inside `scope` whose box pokes outside it horizontally (clipping/overflow). */
async function horizontalOverflow(page: Page, scopeSel: string): Promise<string[]> {
  return page.locator(scopeSel).first().evaluate((container) => {
    const b = container.getBoundingClientRect();
    const bad: string[] = [];
    for (const el of Array.from(container.querySelectorAll('.ct-tool-group, .ct-tool-group *'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      // Skip anything in a horizontal scroller or hidden subtree.
      let skip = false;
      for (let p = el.parentElement; p && p !== container; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') skip = true;
      }
      if (skip) continue;
      if (r.right > b.right + 1 || r.left < b.left - 1) {
        bad.push(`${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).trim().split(/\s+/).join('.')} [${Math.round(r.left)},${Math.round(r.right)}] vs [${Math.round(b.left)},${Math.round(b.right)}]`);
      }
    }
    return bad;
  });
}

/**
 * The state indicator is style-specific by design (styles.css): chips show the
 * status icon, tree shows a dot, cards hide the icon and signal state with the
 * group border/top bar (ct-tool-group-<state>) and a red icon on failure.
 */
async function expectGroupState(group: import("@playwright/test").Locator, style: Style, state: "pending" | "success" | "error"): Promise<void> {
  await expect(group).toHaveClass(new RegExp("ct-tool-group-" + state));
  const status = group.locator(".ct-tool-group-status.ct-tool-state-" + state);
  await expect(status).toHaveCount(1);
  if (style === "cards") await expect(status).toBeHidden();
  else await expect(status).toBeVisible();
}

// ───────────────────────── Desktop 1280x800 ─────────────────────────────

test.describe('Desktop 1280x800: tool call styles', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(desktopUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
  });

  const setStyle = async (page: Page, s: Style) => {
    await page.evaluate((style) => {
      const v = (window as any).__view;
      v.plugin.settings.toolCallStyle = style;
      v.applyToolCallStyle();
    }, s);
    await page.waitForTimeout(100);
  };

  const injectMessage = (page: Page, id: string, toolCalls: Array<Record<string, unknown>>) =>
    page.evaluate(([id, toolCalls]) => {
      const manager = (window as any).__manager;
      const threadId = 'thread-live-tool-grouping';
      const message = { id, role: 'assistant', content: '', timestamp: Date.now(), toolCalls };
      manager.getThread(threadId).messages.push(message);
      (window as any).__emitEvent(threadId, { type: 'message', message });
    }, [id, toolCalls] as const);

  const startLiveThread = async (page: Page) => {
    await page.evaluate(() => (window as any).__view.focusThread('thread-live-tool-grouping'));
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const manager = (window as any).__manager;
      const threadId = 'thread-live-tool-grouping';
      const message = { id: 'qa-user', role: 'user', content: 'Do the thing', timestamp: Date.now() };
      manager.getThread(threadId).messages.push(message);
      (window as any).__emitEvent(threadId, { type: 'user_message_added', message });
    });
    await page.waitForTimeout(100);
  };

  for (const style of STYLES) {
    test(`${style}: finished + failed group collapsed, expanded, no overflow`, async ({ page }) => {
      await page.evaluate(() => (window as any).__view.focusThread('thread-tool-grouping'));
      await page.waitForSelector('.ct-tool-group');
      await page.waitForTimeout(800);
      await setStyle(page, style);

      const group = page.locator('.ct-tool-group').first();
      const header = group.locator('.ct-tool-group-header');
      await expect(header).toHaveAttribute('aria-expanded', 'false');
      await expect(header).toHaveClass(/ct-tool-error/);
      await expectGroupState(group, style, 'error');
      await expect(group.locator('.ct-full-content')).toHaveClass(/ct-hidden/);
      expect(await horizontalOverflow(page, '.ct-messages')).toEqual([]);
      await snap(page, `desktop-${style}-failed-collapsed`);

      await header.click();
      await expect(header).toHaveAttribute('aria-expanded', 'true');
      await expect(group.locator('.ct-tool-pill')).toHaveCount(15);
      expect(await horizontalOverflow(page, '.ct-messages')).toEqual([]);
      await snap(page, `desktop-${style}-failed-expanded`);
    });

    test(`${style}: running group is collapsed with visible spinner; mixed run labelled; opens on click`, async ({ page }) => {
      await startLiveThread(page);
      await setStyle(page, style);
      await page.evaluate(() => {
        const emit = (window as any).__emitEvent;
        const t = 'thread-live-tool-grouping';
        emit(t, { type: 'streaming_start' });
        [['Read', 'src/a.ts', 'success'], ['Edit', 'src/a.ts', 'success'], ['Bash', 'npm test', 'pending']].forEach(([name, summary, status], i) =>
          emit(t, { type: 'tool_use', record: { name, summary, timestamp: Date.now(), toolUseId: `qa-run-${i}`, status } }));
      });
      await page.waitForTimeout(300);
      const group = page.locator('.ct-tool-group').first();
      await expect(page.locator('.ct-tool-group')).toHaveCount(1);
      await expect(group.locator('.ct-tool-group-header')).toHaveAttribute('aria-expanded', 'false');
      await expectGroupState(group, style, 'pending');
      await expect(group.locator('.ct-tool-group-running')).toHaveCount(1);
      expect(await horizontalOverflow(page, '.ct-messages')).toEqual([]);
      await snap(page, `desktop-${style}-running-collapsed`);
      await group.locator('.ct-tool-group-header').click();
      await expect(group.locator('.ct-tool-pill')).toHaveCount(3);
      await expect(group.locator('.ct-tool-pill .ct-tool-state-pending')).toHaveCount(1);
      await snap(page, `desktop-${style}-running-expanded`);
    });

    test(`${style}: lone call is a group of one, collapsed`, async ({ page }) => {
      await startLiveThread(page);
      await setStyle(page, style);
      await injectMessage(page, 'qa-lone', [{ name: 'Read', summary: 'src/only.ts', toolUseId: 'lone-1', status: 'success' }]);
      await page.waitForTimeout(300);
      await expect(page.locator('.ct-tools > .ct-tool-pill')).toHaveCount(0);
      const group = page.locator('.ct-tool-group').first();
      await expect(page.locator('.ct-tool-group')).toHaveCount(1);
      await expect(group.locator('.ct-tool-group-count')).toHaveText('1');
      await expect(group.locator('.ct-tool-group-header')).toHaveAttribute('aria-expanded', 'false');
      await expectGroupState(group, style, 'success');
      await snap(page, `desktop-${style}-lone-collapsed`);
      await group.locator('.ct-tool-group-header').click();
      await expect(group.locator('.ct-tool-pill')).toHaveCount(1);
      await snap(page, `desktop-${style}-lone-expanded`);
    });

    test(`${style}: finished mixed-kind run summarised "Read 2 files, edited 1 file"`, async ({ page }) => {
      await startLiveThread(page);
      await setStyle(page, style);
      await injectMessage(page, 'qa-mixed', [
        { name: 'Read', summary: 'a.ts', toolUseId: 'qm-1', status: 'success' },
        { name: 'Read', summary: 'b.ts', toolUseId: 'qm-2', status: 'success' },
        { name: 'Edit', summary: 'a.ts', toolUseId: 'qm-3', status: 'success' },
      ]);
      await page.waitForTimeout(300);
      await expect(page.locator('.ct-compressed-summary')).toHaveText('Read 2 files, edited 1 file');
      await snap(page, `desktop-${style}-mixed-collapsed`);
    });

    test(`${style}: result lands in place — same node, spinner gone, user-opened group stays open`, async ({ page }) => {
      await startLiveThread(page);
      await setStyle(page, style);
      await injectMessage(page, 'qa-land', [
        { name: 'Read', summary: 'a.ts', toolUseId: 'land-1', status: 'success' },
        { name: 'Bash', summary: 'npm test', toolUseId: 'land-2', status: 'pending' },
      ]);
      await page.waitForTimeout(300);
      const group = page.locator('.ct-tool-group').first();
      await group.evaluate((el) => el.setAttribute('data-keep', 'same-node'));
      await expectGroupState(group, style, 'pending');
      await snap(page, `desktop-${style}-landing-before`);
      // User opens the group while it is still running.
      await group.locator('.ct-tool-group-header').click();
      await expect(group.locator('.ct-tool-pill .ct-tool-state-pending')).toHaveCount(1);
      await snap(page, `desktop-${style}-landing-before-open`);

      await page.evaluate(() => {
        const m = (window as any).__manager.getThread('thread-live-tool-grouping').messages.find((x: any) => x.id === 'qa-land');
        m.toolCalls[1].status = 'success';
        (window as any).__emitEvent('thread-live-tool-grouping', { type: 'tool_result_status', toolUseId: 'land-2', status: 'success' });
      });
      await page.waitForTimeout(300);
      const same = page.locator('.ct-tool-group[data-keep="same-node"]');
      await expect(same).toHaveCount(1);
      await expect(page.locator('.ct-tool-state-pending')).toHaveCount(0);
      await expect(page.locator('.ct-tool-group-running')).toHaveCount(0);
      await expect(page.locator('.ct-tool-active')).toHaveCount(0);
      await expect(same.locator('.ct-tool-group-header')).toHaveAttribute('aria-expanded', 'true');
      await expect(same.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);
      await snap(page, `desktop-${style}-landing-after-open`);
    });

    test(`${style}: failure landing on a collapsed running group turns it red without opening`, async ({ page }) => {
      await startLiveThread(page);
      await setStyle(page, style);
      await injectMessage(page, 'qa-fail', [
        { name: 'Read', summary: 'a.ts', toolUseId: 'f-1', status: 'success' },
        { name: 'Bash', summary: 'npm test', toolUseId: 'f-2', status: 'pending' },
      ]);
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        const m = (window as any).__manager.getThread('thread-live-tool-grouping').messages.find((x: any) => x.id === 'qa-fail');
        m.toolCalls[1].status = 'error';
        (window as any).__emitEvent('thread-live-tool-grouping', { type: 'tool_result_status', toolUseId: 'f-2', status: 'error' });
      });
      await page.waitForTimeout(300);
      const group = page.locator('.ct-tool-group').first();
      await expect(group.locator('.ct-tool-group-header')).toHaveClass(/ct-tool-error/);
      await expect(group.locator('.ct-tool-group-header')).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('.ct-tool-state-pending')).toHaveCount(0);
      await snap(page, `desktop-${style}-landing-failed`);
    });
  }

  test('switching threads (renderMessages) resets groups to collapsed, even one the user had open', async ({ page }) => {
    await page.evaluate(() => (window as any).__view.focusThread('thread-tool-grouping'));
    await page.waitForSelector('.ct-tool-group');
    const header = page.locator('.ct-tool-group-header').first();
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await page.evaluate(() => (window as any).__view.focusThread('thread-live-tool-grouping'));
    await page.waitForTimeout(200);
    await page.evaluate(() => (window as any).__view.focusThread('thread-tool-grouping'));
    await page.waitForSelector('.ct-tool-group');
    await page.waitForTimeout(300);
    await expect(page.locator('.ct-tool-group-header').first()).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.ct-tool-group .ct-full-content').first()).toHaveClass(/ct-hidden/);
    await snap(page, 'desktop-switch-thread-back-collapsed');
  });

  test('style switch applies live to an on-screen group without re-render (node identity kept)', async ({ page }) => {
    await page.evaluate(() => (window as any).__view.focusThread('thread-tool-grouping'));
    await page.waitForSelector('.ct-tool-group');
    await page.locator('.ct-tool-group').first().evaluate((el) => el.setAttribute('data-keep', 'same-node'));
    const seen: string[] = [];
    for (const s of STYLES) {
      await setStyle(page, s);
      await expect(page.locator('.ct-root')).toHaveClass(new RegExp(`ct-tools-${s}\\b`));
      await expect(page.locator('.ct-tool-group[data-keep="same-node"]')).toHaveCount(1);
      // Style actually changes presentation: record header computed layout fingerprint.
      seen.push(await page.locator('.ct-tool-group-header').first().evaluate((el) => {
        const cs = getComputedStyle(el);
        return [cs.backgroundColor, cs.borderRadius, cs.borderTopWidth, cs.paddingLeft, cs.display].join('|');
      }));
    }
    expect(new Set(seen).size, `three styles should render distinct headers, got ${JSON.stringify(seen)}`).toBe(3);
  });
});

// ───────────────────────── Mobile 390x844 + 375x667 ─────────────────────

const MOBILE_VIEWPORTS = [
  { name: '390x844', width: 390, height: 844 },
  { name: '375x667', width: 375, height: 667 },
] as const;

const T0 = 1768471200000;

for (const vp of MOBILE_VIEWPORTS) {
  test.describe(`Mobile ${vp.name}: tool call styles`, () => {
    test.beforeEach(async ({ page }) => {
      await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(mobileUrl(vp.width, vp.height));
      await page.waitForSelector('.ct-mobile-root, [class*="ct-mobile"]');
      await page.waitForTimeout(400);
    });

    const openThread = (page: Page, tools: Array<{ name: string; summary: string; status?: string }>, extra?: { live?: boolean }) =>
      page.evaluate(([tools, live, T0]) => {
        const store = (window as any).__store;
        const messages = [
          { id: 'u1', role: 'user', content: 'Please fix the retry logic', timestamp: T0 },
        ];
        if (!live) messages.push({ id: 'a1', role: 'assistant', content: 'Done, here is what I did.', timestamp: T0 + 1000, toolCalls: tools } as any);
        store.applyFrame({
          type: 'snapshot', activeThreadId: 'qa-thread',
          threads: [{ id: 'qa-thread', title: 'QA tool calls', messages, createdAt: T0, updatedAt: T0 + 2000 }],
        });
        if (live) {
          store.applyFrame({ type: 'streaming_start', threadId: 'qa-thread' });
          for (const t of tools) store.applyFrame({ type: 'tool_use', threadId: 'qa-thread', name: t.name, summary: t.summary });
        }
      }, [tools, !!extra?.live, T0] as const);

    const setMobileStyle = (page: Page, s: Style) =>
      page.evaluate((style) => {
        const v = (window as any).__mobileView;
        v.getToolCallStyle = () => style;
        v.applyToolCallStyle();
      }, s);

    const FINISHED = [
      { name: 'Read', summary: '/Users/mock/projects/hip-trip/src/api/client.ts' },
      { name: 'Read', summary: '/Users/mock/projects/hip-trip/src/api/retry.ts' },
      { name: 'Edit', summary: '/Users/mock/projects/hip-trip/src/api/client.ts' },
      { name: 'Bash', summary: 'npm test -- --reporter=verbose --coverage' },
    ];

    for (const style of STYLES) {
      test(`${style}: finished mixed run collapsed by default, expands, no overflow`, async ({ page }) => {
        await openThread(page, FINISHED);
        await setMobileStyle(page, style);
        await page.waitForSelector('.ct-tool-group');
        await expect(page.locator('.ct-tool-group')).toHaveCount(1);
        const header = page.locator('.ct-tool-group-header').first();
        await expect(header).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('.ct-tool-group .ct-full-content').first()).toHaveClass(/ct-hidden/);
        await expect(page.locator('.ct-compressed-summary').first()).toHaveText('Read 2 files, ran 1 command, edited 1 file');
        const box = (await header.boundingBox())!;
        test.info().annotations.push({ type: 'header-height', description: String(box.height) });
        expect(await horizontalOverflow(page, '.ct-mobile-messages')).toEqual([]);
        await snap(page, `mobile-${vp.name}-${style}-mixed-collapsed`);

        await header.click();
        await expect(header).toHaveAttribute('aria-expanded', 'true');
        await expect(page.locator('.ct-tool-group .ct-tool-pill')).toHaveCount(4);
        await snap(page, `mobile-${vp.name}-${style}-mixed-expanded`);
        const rows = await page.locator('.ct-tool-group .ct-tool-pill').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
        // Rows are not primary tap targets (the header is) but record heights for the report.
        test.info().annotations.push({ type: 'row-heights', description: rows.map(Math.round).join(',') });
      });

      // KNOWN BUG (QA 2026-10-18): at 375px an EXPANDED tree/cards group runs
      // 2-4px past the right edge (group/header/rows span x 12..377/379 in a
      // 375px viewport; cards loses its right border). Fine at 390px; chips fine.
      test(`${style}: expanded group fits the ${vp.name} viewport${vp.width === 375 && style !== 'chips' ? ' (KNOWN BUG, expected to fail)' : ''}`, async ({ page }) => {
        if (vp.width === 375 && style !== 'chips') test.fail();
        await openThread(page, FINISHED);
        await setMobileStyle(page, style);
        await page.waitForSelector('.ct-tool-group');
        await page.locator('.ct-tool-group-header').first().click();
        await expect(page.locator('.ct-tool-group .ct-tool-pill')).toHaveCount(4);
        expect(await horizontalOverflow(page, '.ct-mobile-messages')).toEqual([]);
      });

      // KNOWN BUG (QA 2026-10-18): the mobile group header is 24px (tree), 26px
      // (chips) and 42px (cards) tall; main already had min-height 28px. The PR
      // guidelines require 44px. test.fail() keeps CI green while the bug exists
      // and turns RED the moment it is fixed, prompting removal of the marker.
      test(`${style}: group header is a >= 44px tap target (KNOWN BUG, expected to fail)`, async ({ page }) => {
        test.fail();
        await openThread(page, FINISHED);
        await setMobileStyle(page, style);
        await page.waitForSelector('.ct-tool-group');
        const box = (await page.locator('.ct-tool-group-header').first().boundingBox())!;
        expect(box.height, `header height ${box.height}`).toBeGreaterThanOrEqual(44);
      });

      test(`${style}: running (streaming) group is collapsed with visible spinner`, async ({ page }) => {
        await openThread(page, FINISHED.slice(0, 3), { live: true });
        await setMobileStyle(page, style);
        await page.waitForSelector('.ct-tool-group');
        const group = page.locator('.ct-tool-group').first();
        await expect(page.locator('.ct-tool-group')).toHaveCount(1);
        await expect(group.locator('.ct-tool-group-header')).toHaveAttribute('aria-expanded', 'false');
        await expectGroupState(group, style, 'pending');
      await expect(group.locator('.ct-tool-group-running')).toHaveCount(1);
        expect(await horizontalOverflow(page, '.ct-mobile-messages')).toEqual([]);
        await snap(page, `mobile-${vp.name}-${style}-running-collapsed`);
        await group.locator('.ct-tool-group-header').click();
        await expect(group.locator('.ct-tool-pill')).toHaveCount(3);
        await snap(page, `mobile-${vp.name}-${style}-running-expanded`);
      });

      test(`${style}: lone call is a group of one`, async ({ page }) => {
        await openThread(page, [{ name: 'Read', summary: '/Users/mock/projects/hip-trip/src/only.ts' }]);
        await setMobileStyle(page, style);
        await page.waitForSelector('.ct-tool-group');
        await expect(page.locator('.ct-tools > .ct-tool-pill')).toHaveCount(0);
        await expect(page.locator('.ct-tool-group-count')).toHaveText('1');
        await expect(page.locator('.ct-tool-group-header')).toHaveAttribute('aria-expanded', 'false');
        await snap(page, `mobile-${vp.name}-${style}-lone-collapsed`);
      });

      test(`${style}: failed finished call flags header red, stays collapsed`, async ({ page }) => {
        await openThread(page, [
          { name: 'Read', summary: '/Users/mock/projects/hip-trip/src/a.ts', status: 'success' },
          { name: 'Bash', summary: 'npm test', status: 'error' },
        ]);
        await setMobileStyle(page, style);
        await page.waitForSelector('.ct-tool-group');
        const header = page.locator('.ct-tool-group-header').first();
        await expect(header).toHaveAttribute('aria-expanded', 'false');
        await expect(header).toHaveClass(/ct-tool-error/);
        await expectGroupState(page.locator('.ct-tool-group').first(), style, 'error');
        await snap(page, `mobile-${vp.name}-${style}-failed-collapsed`);
      });

      test(`${style}: streaming group finalizes with nothing left spinning`, async ({ page }) => {
        await openThread(page, FINISHED.slice(0, 3), { live: true });
        await setMobileStyle(page, style);
        await page.waitForSelector('.ct-tool-group-running', { state: 'attached' });
        await page.evaluate(([tools, T0]) => {
          (window as any).__store.applyFrame({
            type: 'message', threadId: 'qa-thread',
            message: { id: 'a-final', role: 'assistant', content: 'All done.', timestamp: T0 + 5000, toolCalls: tools },
          });
          (window as any).__store.applyFrame({ type: 'done', threadId: 'qa-thread' });
        }, [FINISHED.slice(0, 3), T0] as const);
        await page.waitForTimeout(300);
        await expect(page.locator('.ct-tool-state-pending')).toHaveCount(0);
        await expect(page.locator('.ct-tool-group-running')).toHaveCount(0);
        await expect(page.locator('.ct-tool-active')).toHaveCount(0);
        await expect(page.locator('.ct-tool-group')).toHaveCount(1);
        await expect(page.locator('.ct-tool-group-header').first()).toHaveAttribute('aria-expanded', 'false');
        await snap(page, `mobile-${vp.name}-${style}-finalized`);
      });
    }

    test('thread switch rebuilds groups collapsed', async ({ page }) => {
      await openThread(page, FINISHED);
      await page.waitForSelector('.ct-tool-group');
      const header = page.locator('.ct-tool-group-header').first();
      await header.click();
      await expect(header).toHaveAttribute('aria-expanded', 'true');
      await page.evaluate(([T0]) => {
        const store = (window as any).__store;
        store.applyFrame({
          type: 'snapshot', activeThreadId: 'qa-other',
          threads: [
            { id: 'qa-other', title: 'Other', messages: [{ id: 'o1', role: 'user', content: 'hi', timestamp: T0 }], createdAt: T0, updatedAt: T0 },
          ],
        });
      }, [T0] as const);
      await page.waitForTimeout(200);
      await page.evaluate(([T0]) => {
        (window as any).__store.applyFrame({
          type: 'snapshot', activeThreadId: 'qa-thread',
          threads: [{ id: 'qa-thread', title: 'QA tool calls', messages: [
            { id: 'u1', role: 'user', content: 'Please fix', timestamp: T0 },
            { id: 'a1', role: 'assistant', content: 'Done', timestamp: T0 + 1000, toolCalls: [{ name: 'Read', summary: 'a.ts' }, { name: 'Edit', summary: 'a.ts' }] },
          ], createdAt: T0, updatedAt: T0 + 2000 }],
        });
      }, [T0] as const);
      await page.waitForSelector('.ct-tool-group');
      await page.waitForTimeout(200);
      await expect(page.locator('.ct-tool-group-header').first()).toHaveAttribute('aria-expanded', 'false');
      await snap(page, `mobile-${vp.name}-thread-switch-collapsed`);
    });
  });
}

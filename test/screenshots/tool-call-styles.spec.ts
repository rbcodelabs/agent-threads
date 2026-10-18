import { test, expect } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');
const STYLES = ['chips', 'tree', 'cards'] as const;

// Fixture 'thread-tool-grouping': one finished group of 15 mixed calls with a
// failed Edit (red header, still collapsed). Fixture 'thread-live-tool-grouping'
// is driven live for the running-group state (also collapsed by default).

async function setStyle(page: import('@playwright/test').Page, style: (typeof STYLES)[number]) {
  await page.evaluate((s) => {
    const view = (window as any).__view;
    view.plugin.settings.toolCallStyle = s;
    view.applyToolCallStyle();
  }, style);
}

test.describe('Tool call styles', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
  });

  test('tree is the default style', async ({ page }) => {
    await expect(page.locator('.ct-root')).toHaveClass(/ct-tools-tree/);
  });

  test('switching the style class applies live without a reload', async ({ page }) => {
    await page.evaluate(() => (window as any).__view.focusThread('thread-tool-grouping'));
    await page.waitForSelector('.ct-tool-group');
    for (const style of STYLES) {
      await setStyle(page, style);
      await expect(page.locator('.ct-root')).toHaveClass(new RegExp(`ct-tools-${style}`));
      for (const other of STYLES.filter((s) => s !== style)) {
        await expect(page.locator('.ct-root')).not.toHaveClass(new RegExp(`ct-tools-${other}\\b`));
      }
    }
  });

  for (const style of STYLES) {
    test(`${style}: finished group collapsed, header is a button, failure red but still collapsed`, async ({ page }) => {
      await page.evaluate(() => (window as any).__view.focusThread('thread-tool-grouping'));
      await page.waitForSelector('.ct-tool-group');
      // Let async footer chrome (edited-files chips) settle so layout is stable.
      await page.waitForTimeout(800);
      await setStyle(page, style);
      await page.waitForTimeout(150);

      await expect(page.locator('.ct-tool-group')).toHaveCount(1);
      const group = page.locator('.ct-tool-group').first();
      const header = group.locator('.ct-tool-group-header');
      expect(await header.evaluate((el) => el.tagName)).toBe('BUTTON');
      await expect(header).toHaveAttribute('aria-expanded', 'false');
      await expect(group.locator('.ct-full-content')).toHaveClass(/ct-hidden/);
      // The failure flags the header (red status dot) but does not open the group.
      await expect(group.locator('.ct-tool-group-status.ct-tool-state-error')).toHaveCount(1);
      await expect(header).toHaveClass(/ct-tool-error/);

      await shot(page, `tool-call-style-${style}-finished.png`, { fullPage: true });

      await header.focus();
      await page.keyboard.press('Enter');
      await expect(header).toHaveAttribute('aria-expanded', 'true');
      await expect(group.locator('.ct-tool-pill.ct-tool-error .ct-tool-status.ct-tool-state-error')).toHaveCount(1);
      await page.waitForTimeout(150);
      await shot(page, `tool-call-style-${style}-expanded.png`, { fullPage: true });
    });

    test(`${style}: running group is collapsed with a running indicator; opening shows rows`, async ({ page }) => {
      await page.evaluate(() => (window as any).__view.focusThread('thread-live-tool-grouping'));
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        const manager = (window as any).__manager;
        const threadId = 'thread-live-tool-grouping';
        const message = { id: 'live-user-msg', role: 'user', content: 'Do the thing', timestamp: Date.now() };
        manager.getThread(threadId).messages.push(message);
        (window as any).__emitEvent(threadId, { type: 'user_message_added', message });
        const emit = (window as any).__emitEvent;
        emit(threadId, { type: 'streaming_start' });
        const calls: Array<[string, string, string]> = [
          ['Read', '/Users/mock/projects/hip-trip/src/api/client.ts', 'success'],
          ['Read', '/Users/mock/projects/hip-trip/src/api/retry.ts', 'success'],
          ['Read', '/Users/mock/projects/hip-trip/src/api/utils.ts', 'pending'],
        ];
        calls.forEach(([name, summary, status], i) =>
          emit(threadId, { type: 'tool_use', record: { name, summary, timestamp: Date.now(), toolUseId: `style-${i}`, status } }));
      });
      await page.waitForTimeout(300);
      await setStyle(page, style);
      await page.waitForTimeout(150);

      const group = page.locator('.ct-tool-group').first();
      await expect(group.locator('.ct-tool-group-header')).toHaveAttribute('aria-expanded', 'false');
      await expect(group.locator('.ct-tool-group-status.ct-tool-state-pending')).toHaveCount(1);
      await expect(group.locator('.ct-tool-group-running')).toHaveCount(1);
      await shot(page, `tool-call-style-${style}-running.png`, { fullPage: true });

      await group.locator('.ct-tool-group-header').click();
      await expect(group.locator('.ct-tool-pill')).toHaveCount(3);
      await page.waitForTimeout(150);
      await shot(page, `tool-call-style-${style}-running-open.png`, { fullPage: true });
    });
  }
});

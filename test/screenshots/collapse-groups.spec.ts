import { test, expect } from '@playwright/test';
import path from 'path';

const kanbanUrl = 'file://' + path.resolve('test/harness/kanban.html');

test.describe('agents list — collapsible groups', () => {
  test('project and status groups collapse and expand', async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 820 });
    await page.goto(kanbanUrl + '?dashboard=1');
    await page.waitForSelector('.ct-agents-project');
    const out = process.env.SHOT_DIR;
    if (out) await page.screenshot({ path: path.join(out, '1-expanded.png') });

    const hiptrip = page.locator('.ct-agents-project').filter({
      has: page.locator('.ct-agents-project-name', { hasText: 'HipTrip' }),
    });
    const rows = hiptrip.locator('.ct-agents-row');
    const before = await rows.count();
    expect(before).toBeGreaterThan(1);

    if (out) {
      await hiptrip.locator('.ct-agents-group-label').filter({ hasText: 'Waiting' }).hover();
      await page.screenshot({ path: path.join(out, '1b-hover.png') });
      await hiptrip.locator('.ct-agents-project-header').focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await page.mouse.move(0, 0);
      await page.screenshot({ path: path.join(out, '1c-focus.png') });
    }

    // Collapse one status group inside the project.
    const newLabel = hiptrip.locator('.ct-agents-group-label').filter({ hasText: 'Working' }).first();
    await newLabel.click();
    await expect.poll(() => rows.count()).toBeLessThan(before);
    await expect(hiptrip.locator('.ct-agents-group-label[aria-expanded="false"]')).toHaveCount(1);
    if (out) await page.screenshot({ path: path.join(out, '2-status-collapsed.png') });

    // Collapse the whole project.
    await hiptrip.locator('.ct-agents-project-header').click();
    await expect(rows).toHaveCount(0);
    await expect(hiptrip.locator('.ct-agents-project-header')).toHaveAttribute('aria-expanded', 'false');
    if (out) await page.screenshot({ path: path.join(out, '3-project-collapsed.png') });

    // Expand again: the earlier status collapse is remembered.
    await hiptrip.locator('.ct-agents-project-header').click();
    await expect(hiptrip.locator('.ct-agents-group-label[aria-expanded="false"]')).toHaveCount(1);
    await expect.poll(() => rows.count()).toBeLessThan(before);
  });
});

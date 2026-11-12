import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

/**
 * The new-conversation (Dispatch) composer must offer the same /skill list as the thread composer:
 * skills from the local / vault / source skill roots (extraSkillDirs), not just ~/.claude/skills and
 * the built-ins. `?localskills=1` seeds `demo-skill` under the harness's local skills root, which
 * ThreadsView.computeExtraSkillDirs() registers with the `local` prefix.
 */
const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

async function openNewConversation(page: Page, query: string, width: number, height: number): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  await page.setViewportSize({ width, height });
  await page.goto(harnessUrl + query);
  await page.waitForSelector('.ct-title-row');
  await page.waitForSelector('.ct-messages');
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'New thread' }).first().click();
  await expect(page.locator('[data-testid="new-conversation"]')).toBeVisible();
  await page.locator('.ct-new-conv-row textarea').click();
  await page.keyboard.type('/');
  await page.locator('.ct-skill-dropdown').waitFor({ state: 'visible' });
}

const viewports = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

test.describe('new-conversation composer /skill autocomplete', () => {
  for (const vp of viewports) {
    test(`lists local:demo-skill from the extra skill dirs at ${vp.width}x${vp.height}`, async ({ page }) => {
      await openNewConversation(page, '?projects=1&localskills=1', vp.width, vp.height);
      const dropdown = page.locator('.ct-skill-dropdown');
      await expect(dropdown.locator('.ct-skill-name', { hasText: 'local:demo-skill' })).toHaveCount(1);
      await expect(dropdown).toContainText('Demo skill from the local skills root');
      // Still offers the dispatch built-ins and the ~/.claude/skills entries.
      await expect(dropdown).toContainText('goal');
      await expect(dropdown).toContainText('brain-dump');

      const box = await dropdown.boundingBox();
      expect(box!.x, 'dropdown left edge inside viewport').toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, 'dropdown right edge inside viewport').toBeLessThanOrEqual(vp.width);
      expect(await dropdown.evaluate((el) => el.scrollWidth <= el.clientWidth), 'no horizontal overflow in dropdown').toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no page-level horizontal overflow').toBe(true);

      // The list is taller than the dropdown; scroll the extra-dir entry into view so the capture shows it.
      await dropdown.locator('.ct-skill-item', { hasText: 'local:demo-skill' }).scrollIntoViewIfNeeded();
      await expect(dropdown.locator('.ct-skill-item', { hasText: 'local:demo-skill' })).toBeInViewport();
      await shot(page, `new-conversation-skills-${vp.name}.png`);
    });
  }

  test('typing a prefix narrows to the extra-dir skill and Tab inserts its namespaced name', async ({ page }) => {
    await openNewConversation(page, '?projects=1&localskills=1', 520, 760);
    await page.keyboard.type('local:d');
    const dropdown = page.locator('.ct-skill-dropdown');
    await expect(dropdown.locator('.ct-skill-item')).toHaveCount(1);
    await expect(dropdown).toContainText('local:demo-skill');
    await page.keyboard.press('Tab');
    await expect(page.locator('.ct-new-conv-row textarea')).toHaveValue(/^\/local:demo-skill /);
  });

  test('without a local skills root the extra-dir skill is not offered', async ({ page }) => {
    await openNewConversation(page, '?projects=1', 520, 760);
    await expect(page.locator('.ct-skill-dropdown')).toContainText('brain-dump');
    await expect(page.locator('.ct-skill-dropdown')).not.toContainText('demo-skill');
  });
});

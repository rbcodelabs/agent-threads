import { test, expect, type Page } from '@playwright/test';
import path from 'path';

/**
 * Agent Board "quiet concluded threads": concluded, unchanged threads collapse
 * into a "Concluded (N)" row (status lane / per-project column) and the
 * "Show concluded" chip restores them. Predicate rules are unit-tested in
 * test/unit/quiet-threads.test.ts; this covers the DOM.
 */
const kanbanUrl = 'file://' + path.resolve('test/harness/kanban.html');
const shotDir = process.env.SHOT_DIR;

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
});

async function open(page: Page, size: { width: number; height: number }, groupBy: 'status' | 'project') {
  await page.setViewportSize(size);
  const narrow = size.width < 640 ? '&narrow=1&mobile=1' : '';
  await page.goto(`${kanbanUrl}?quiet=1${narrow}`);
  await page.waitForSelector('.ct-kanban-board');
  if (groupBy === 'project') {
    await page.evaluate(() => (window as any).__setGroupBy?.('project'));
    await page.waitForSelector('.ct-kanban-project-col');
  }
}

const card = (page: Page, title: string) => page.locator('.ct-kanban-card-title', { hasText: title });
const row = (page: Page) => page.getByTestId('kanban-concluded-row');
const toggle = (page: Page) => page.getByTestId('kanban-show-concluded-toggle');

test.describe('board: quiet concluded threads', () => {
  test('status board: collapsed Concluded (3) lane, failed stays visible, expand and toggle', async ({ page }) => {
    await open(page, { width: 1280, height: 800 }, 'status');

    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(row(page)).toHaveCount(1);
    await expect(page.locator('.ct-kanban-concluded-label')).toHaveText('Concluded (3)');
    // Newest concluded title (Kanban folder swimlanes, 2d) shows while collapsed; no quiet cards rendered.
    await expect(page.locator('.ct-kanban-concluded-newest')).toHaveText('Kanban folder swimlanes');
    await expect(card(page, 'Fix auth middleware 401s')).toHaveCount(0);
    await expect(card(page, 'Add rate limiting to /v1/search')).toHaveCount(0);
    // Crashes are never quiet, even when concluded.
    await expect(card(page, 'Relay reconnect backoff')).toHaveCount(1);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'status-collapsed-1280x800.png') });

    // Expand in place.
    await page.getByTestId('kanban-concluded-toggle').click();
    await expect(page.getByTestId('kanban-concluded-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(row(page).locator('.ct-kanban-card')).toHaveCount(3);
    await expect(card(page, 'Fix auth middleware 401s')).toHaveCount(1);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'status-expanded-1280x800.png') });
    await page.getByTestId('kanban-concluded-toggle').click();
    await expect(row(page).locator('.ct-kanban-card')).toHaveCount(0);

    // Show concluded: no collapsing, cards back in their usual columns.
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(row(page)).toHaveCount(0);
    await expect(card(page, 'Fix auth middleware 401s')).toHaveCount(1);
    await expect(card(page, 'Kanban folder swimlanes')).toHaveCount(1);
    await toggle(page).click();
    await expect(row(page)).toHaveCount(1);
  });

  test('search still finds quiet threads and shows them normally', async ({ page }) => {
    await open(page, { width: 1280, height: 800 }, 'status');
    await page.locator('.ct-agents-search-btn').click();
    await page.locator('.ct-agents-search-input').fill('rate limiting');
    await expect(card(page, 'Add rate limiting to /v1/search')).toHaveCount(1);
    await expect(row(page)).toHaveCount(0);
  });

  test('project columns: one collapsed Concluded row per project column', async ({ page }) => {
    await open(page, { width: 1280, height: 800 }, 'project');
    const rows = row(page);
    await expect(rows).toHaveCount(3);
    for (const label of await page.locator('.ct-kanban-concluded-label').allTextContents()) {
      expect(label).toMatch(/^Concluded \(\d+\)$/);
    }
    await expect(card(page, 'Fix auth middleware 401s')).toHaveCount(0);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'project-collapsed-1280x800.png') });
    await rows.first().getByTestId('kanban-concluded-toggle').click();
    await expect(rows.first().locator('.ct-kanban-card')).not.toHaveCount(0);
    await toggle(page).click();
    await expect(row(page)).toHaveCount(0);
  });

  test('mobile 390x844 and 375x667: row and chip stay inside the viewport', async ({ page }) => {
    for (const size of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
      await open(page, size, 'status');
      await expect(row(page)).toHaveCount(1);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      if (shotDir) await page.screenshot({ path: path.join(shotDir, `status-collapsed-${size.width}x${size.height}.png`) });
    }
  });
});

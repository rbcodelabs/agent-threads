import { test, expect, type Page } from '@playwright/test';
import path from 'path';

/**
 * Agent Board archive suggestions: quiet threads unchanged for 3+ days are
 * offered in a drawer opened from the Concluded row, with nothing preselected
 * and a confirm before anything is archived. Candidate rules are unit-tested in
 * test/unit/archive-suggestions.test.ts. ?quiet=1 fixtures: concluded 3d
 * (HipTrip), 2d (not suggested yet), 4d (Acme, PR #321); a 5d failed thread never qualifies.
 */
const kanbanUrl = 'file://' + path.resolve('test/harness/kanban.html');
const shotDir = process.env.SHOT_DIR;

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
});

async function open(page: Page, size: { width: number; height: number }, query = 'quiet=1', groupBy: 'status' | 'project' | 'folder' = 'status') {
  await page.setViewportSize(size);
  const narrow = size.width < 640 ? '&narrow=1&mobile=1' : '';
  await page.goto(`${kanbanUrl}?${query}${narrow}`);
  await page.waitForSelector('.ct-kanban-board');
  if (groupBy !== 'status') {
    await page.evaluate((g) => (window as any).__setGroupBy?.(g), groupBy);
    await page.waitForSelector(groupBy === 'project' ? '.ct-kanban-project-col' : '.ct-kanban-board');
  }
}

const entry = (page: Page) => page.getByTestId('kanban-archive-suggestions').first();
const items = (page: Page) => page.getByTestId('archive-item');
const archiveBtn = (page: Page) => page.getByTestId('archive-selected');
const card = (page: Page, title: string) => page.locator('.ct-kanban-card-title', { hasText: title });
const archived = (page: Page) => page.evaluate(() => (window as any).__archivedThreadIds as string[]);

test.describe('board: archive suggestions', () => {
  test('entry is visible only when there are candidates, and not in folder mode', async ({ page }) => {
    await open(page, { width: 1280, height: 800 });
    await expect(entry(page)).toHaveText('Archive suggestions (2)');
    // Nothing quiet at all (no ?quiet=1): no Concluded row, no entry.
    await open(page, { width: 1280, height: 800 }, 'x=1');
    await expect(page.getByTestId('kanban-archive-suggestions')).toHaveCount(0);
    await open(page, { width: 1280, height: 800 }, 'quiet=1', 'folder');
    await expect(page.getByTestId('kanban-archive-suggestions')).toHaveCount(0);
  });

  test('drawer lists candidates oldest first, nothing preselected, Archive disabled until one is checked', async ({ page }) => {
    await open(page, { width: 1280, height: 800 });
    await entry(page).click();
    await expect(items(page)).toHaveCount(2);
    await expect(items(page).nth(0)).toContainText('concluded 4d ago · PR #321');
    await expect(items(page).nth(1)).toContainText('concluded 3d ago');
    await expect(page.locator('.ct-archive-suggestions input[type="checkbox"]:checked')).toHaveCount(0);
    await expect(archiveBtn(page)).toBeDisabled();
    await expect(archiveBtn(page)).toHaveText('Archive 0 selected');
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'drawer-1280x800.png') });
    await items(page).nth(0).locator('input').check();
    await expect(archiveBtn(page)).toBeEnabled();
    await expect(archiveBtn(page)).toHaveText('Archive 1 selected');
    await page.getByTestId('archive-select-all').click();
    await expect(archiveBtn(page)).toHaveText('Archive 2 selected');
    await page.getByTestId('archive-clear').click();
    await expect(archiveBtn(page)).toBeDisabled();
  });

  test('confirm Cancel archives nothing; confirm Archive removes only the selected card', async ({ page }) => {
    await open(page, { width: 1280, height: 800 });
    await page.getByTestId('kanban-show-concluded-toggle').first().click(); // show concluded so the cards are visible
    await expect(card(page, 'Fix auth middleware 401s')).toHaveCount(1);
    await expect(card(page, 'Add rate limiting to /v1/search')).toHaveCount(1);
    const savesBefore = await page.evaluate(() => (window as any).__getSaveSettingsCalls());
    await entry(page).click();
    await items(page).nth(1).locator('input').check(); // the 3d one
    await archiveBtn(page).click();
    await expect(page.locator('.modal-container', { hasText: 'Their notes are kept in the vault.' })).toContainText('Archive 1 thread?');
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'confirm-1280x800.png') });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await archived(page)).toEqual([]);
    await expect(items(page)).toHaveCount(2);
    await expect(items(page).nth(1).locator('input')).toBeChecked();
    expect(await page.evaluate(() => (window as any).__getSaveSettingsCalls())).toBe(savesBefore); // cancel persists nothing

    await archiveBtn(page).click();
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(page.getByTestId('archive-result')).toHaveText('Archived 1 thread.');
    // archiveThreadById does not persist; the bulk run must save once.
    expect(await page.evaluate(() => (window as any).__getSaveSettingsCalls())).toBe(savesBefore + 1);
    expect(await archived(page)).toEqual(['k-hiptrip-done']);
    await expect(items(page)).toHaveCount(1);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'result-1280x800.png') });
    await page.keyboard.press('Escape');
    await expect(page.locator('.ct-archive-suggestions')).toHaveCount(0);
    await expect(card(page, 'Add rate limiting to /v1/search')).toHaveCount(1);
    await expect(card(page, 'Kanban folder swimlanes')).toHaveCount(1);
  });

  test('skips a thread that changed after the list was opened', async ({ page }) => {
    await open(page, { width: 1280, height: 800 });
    await entry(page).click();
    await page.getByTestId('archive-select-all').click();
    // The oldest thread (Acme, 4d) gets new activity while the drawer is open.
    await page.evaluate(() => { (window as any).__manager.getThread('k-acme-done').updatedAt = Date.now(); });
    await archiveBtn(page).click();
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(page.getByTestId('archive-result')).toHaveText('Archived 1 thread. 1 skipped, changed since you opened the list.');
    expect(await archived(page)).toEqual(['k-hiptrip-done']);
  });

  const inDrawer = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('.ct-archive-suggestions'));

  for (const how of ['Escape', 'click outside'] as const) {
    test(`dismissing the confirm with ${how} keeps the drawer open and Tab trapped inside it`, async ({ page }) => {
      await open(page, { width: 1280, height: 800 });
      await entry(page).click();
      await items(page).nth(0).locator('input').check();
      await archiveBtn(page).click();
      await expect(page.locator('.modal-container', { hasText: 'Their notes are kept in the vault.' })).toHaveCount(1);
      if (how === 'Escape') await page.keyboard.press('Escape');
      else await page.mouse.click(5, 5);
      await expect(page.locator('.modal-container', { hasText: 'Their notes are kept in the vault.' })).toHaveCount(0);
      await expect(page.locator('.ct-archive-suggestions')).toHaveCount(1);
      expect(await archived(page)).toEqual([]);
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press('Tab');
        expect(await inDrawer(page)).toBe(true);
      }
      await page.keyboard.press('Shift+Tab');
      expect(await inDrawer(page)).toBe(true);
      // Even if focus is dropped on <body> again, Tab comes back into the drawer.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('Tab');
      expect(await inDrawer(page)).toBe(true);
    });
  }

  test('a thread deleted while the drawer is open is reported as no longer on the board', async ({ page }) => {
    await open(page, { width: 1280, height: 800 });
    await entry(page).click();
    await page.getByTestId('archive-select-all').click();
    await page.evaluate(() => (window as any).__manager.deleteThread('k-acme-done'));
    await archiveBtn(page).click();
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(page.getByTestId('archive-result')).toHaveText('Archived 1 thread. 1 no longer on the board.');
  });

  test('keyboard: focus moves in, Escape closes and focus returns to the entry', async ({ page }) => {
    await open(page, { width: 1280, height: 800 });
    await entry(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.ct-archive-suggestions')).toHaveCount(1);
    expect(await page.evaluate(() => !!document.activeElement?.closest('.ct-archive-suggestions'))).toBe(true);
    await page.keyboard.press('Space');
    await expect(archiveBtn(page)).toHaveText('Archive 1 selected');
    await page.keyboard.press('Escape');
    await expect(page.locator('.ct-archive-suggestions')).toHaveCount(0);
    await expect(entry(page)).toBeFocused();
    expect(await archived(page)).toEqual([]);
  });

  test('project columns and the Concluded-shown bar also offer the entry', async ({ page }) => {
    await open(page, { width: 1280, height: 800 }, 'quiet=1', 'project');
    // Each project column shows its own count (HipTrip 1, acme-api 1); the Threads column has a quiet thread
    // that is not yet 3 days old, so no entry; the drawer still lists the whole board.
    const perColumn = await page.locator('.ct-kanban-project-col').evaluateAll((cols) => cols.map((c) => ({
      col: c.querySelector('.ct-kanban-col-label')?.textContent ?? '',
      entry: c.querySelector('[data-testid="kanban-archive-suggestions"]')?.textContent ?? null,
    })));
    expect(perColumn.filter((c) => c.entry !== null).map((c) => c.entry)).toEqual(['Archive suggestions (1)', 'Archive suggestions (1)']);
    expect(perColumn.filter((c) => c.entry === null)).toHaveLength(1);
    await entry(page).click();
    await expect(items(page)).toHaveCount(2);
    await page.keyboard.press('Escape');
    await page.getByTestId('kanban-show-concluded-toggle').first().click();
    await expect(page.getByTestId('kanban-concluded-shown').getByTestId('kanban-archive-suggestions').first()).toBeVisible();
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'project-shown-1280x800.png') });
  });

  test('mobile 390x844 and 375x667: entry, drawer and confirm stay inside the viewport', async ({ page }) => {
    for (const size of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
      await open(page, size);
      await expect(entry(page)).toBeVisible();
      await entry(page).click();
      await expect(items(page)).toHaveCount(2);
      await items(page).nth(0).locator('input').check();
      const box = await page.locator('.ct-archive-suggestions').boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(size.width);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      if (shotDir) await page.screenshot({ path: path.join(shotDir, `drawer-${size.width}x${size.height}.png`) });
      await page.keyboard.press('Escape');
    }
  });
});

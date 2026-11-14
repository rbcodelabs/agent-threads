import { test, expect, type Page } from '@playwright/test';
import path from 'path';

/**
 * TASK-29 / SOL-25 / RM-12 functional behaviour: orchestrator target menu.
 * Pixel baselines live in `test/screenshots/orchestrator-dock-targets.spec.ts`.
 */
const kanbanUrl = 'file://' + path.resolve('test/harness/kanban.html');
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
});

const DESKTOP = { width: 1280, height: 800 };
const NARROW = { width: 390, height: 844 };

async function open(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  const narrow = size.width < 640 ? '&narrow=1&mobile=1' : '';
  await page.goto(`${kanbanUrl}?orch=idle&tx=conversation&orchprojects=1${narrow}`);
  await page.waitForSelector('.ct-kanban-dispatch .ct-orch-dock');
}
const sheet = (page: Page) => page.locator('.ct-orch-sheet');
const titleBtn = (page: Page) => page.locator('.ct-orch-title-btn');
const menu = (page: Page) => page.locator('.ct-orch-menu');

test.describe('orchestrator menu — behaviour in a real browser', () => {
  test('Escape closes the menu first, then the sheet; focus lands on the title button, with a visible focus ring', async ({ page }) => {
    await open(page, DESKTOP);
    await page.evaluate(() => (window as any).__openSheet());
    await titleBtn(page).focus();
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeVisible();
    await expect(page.locator('.ct-orch-menu [role="option"][aria-selected="true"]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(sheet(page)).toBeVisible();
    await expect(titleBtn(page)).toBeFocused();
    const ring = await titleBtn(page).evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(ring).not.toBe('none');
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toBeHidden();
  });

  test('narrow: menu rows are at least 44px tall', async ({ page }) => {
    await open(page, NARROW);
    await page.evaluate(() => (window as any).__openSheet());
    await titleBtn(page).click();
    const heights = await page.locator('.ct-orch-menu [role="option"]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(heights.length).toBe(3);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
  });

  test('a streaming Project orchestrator never leaks into the Portfolio view', async ({ page }) => {
    await open(page, DESKTOP);
    await page.evaluate(() => { (window as any).__orchStreamTo('k-orch-threads', 'AGENT-THREADS-ONLY'); (window as any).__openSheet(); });
    await expect(page.locator('[data-streaming="true"]')).toHaveCount(0);
    await titleBtn(page).click();
    await page.locator('.ct-orch-menu [role="option"][data-target-id="k-orch-threads"]').click();
    await expect(page.locator('[data-streaming="true"]')).toContainText('AGENT-THREADS-ONLY');
    await titleBtn(page).click();
    await page.locator('.ct-orch-menu [role="option"][data-target-id="k-orchestrator"]').click();
    await expect(page.locator('[data-streaming="true"]')).toHaveCount(0);
  });

  test('QA: at 390 the default title is not truncated, and a short viewport keeps the menu inside the sheet', async ({ page }) => {
    await open(page, { width: 390, height: 420 });
    await page.evaluate(() => (window as any).__openSheet());
    const clipped = await page.locator('.ct-orch-title-label').evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(clipped).toBe(false);
    await titleBtn(page).click();
    const [s, m] = await Promise.all([sheet(page).boundingBox(), menu(page).boundingBox()]);
    expect(m!.y + m!.height).toBeLessThanOrEqual(s!.y + s!.height + 1);
    expect(m!.y).toBeGreaterThanOrEqual(s!.y);
  });

  test('QA: another orchestrator replying while the sheet is open shows no (hidden) peek', async ({ page }) => {
    await open(page, DESKTOP);
    await page.evaluate(() => { (window as any).__openSheet(); (window as any).__orchSayTo('k-orch-hiptrip', 'HipTrip finished'); });
    await expect(page.locator('.ct-orch-peek')).toBeHidden();
    await titleBtn(page).click();
    await expect(page.locator('.ct-orch-menu [data-target-id="k-orch-hiptrip"] .ct-orch-opt-unread')).toHaveText('1');
  });

  test('without a Project orchestrator the title stays a plain heading', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto(`${kanbanUrl}?orch=idle&tx=conversation`);
    await page.waitForSelector('.ct-kanban-dispatch .ct-orch-dock');
    await page.evaluate(() => (window as any).__openSheet());
    await expect(page.locator('h2.ct-orch-sheet-title')).toHaveText('Portfolio orchestrator');
    await expect(titleBtn(page)).toHaveCount(0);
  });
});

import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

/**
 * TASK-29 / SOL-25 / RM-12: the dock's sheet title is a menu of orchestrators (Portfolio first, then every Project orchestrator).
 * Served from test/harness/kanban.html with `?orchprojects=1`, which gives the HipTrip and Agent Threads projects their own
 * orchestrator threads (k-orch-hiptrip, k-orch-threads). Without that param no project has one and the dock is unchanged, which is
 * why the existing dock baselines do not move.
 *
 * Visual specs carry NEW baselines only (menu open with a Project target selected: 2 themes x 2 widths); behaviour specs carry none.
 */
const kanbanUrl = 'file://' + path.resolve('test/harness/kanban.html');
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
});

const DESKTOP = { width: 1280, height: 800 };
const NARROW = { width: 390, height: 844 };
const DOCK_SHOT = { threshold: 0.05 } as const;
const SIZES = [{ label: '1280x800', size: DESKTOP }, { label: '390x844', size: NARROW }];

async function open(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  const narrow = size.width < 640 ? '&narrow=1&mobile=1' : '';
  await page.goto(`${kanbanUrl}?orch=idle&tx=conversation&orchprojects=1${narrow}`);
  await page.waitForSelector('.ct-kanban-dispatch .ct-orch-dock');
}
const sheet = (page: Page) => page.locator('.ct-orch-sheet');
const titleBtn = (page: Page) => page.locator('.ct-orch-title-btn');
const menu = (page: Page) => page.locator('.ct-orch-menu');

/** Same variables as orchestrator-dock-sheet.spec.ts: the harness is dark by default. */
async function setLight(page: Page) {
  await page.evaluate(() => {
    document.body.classList.remove('theme-dark');
    document.body.classList.add('theme-light');
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries({
      '--background-primary': '#ffffff', '--background-secondary': '#f3f4f6', '--background-secondary-alt': '#eceef1',
      '--background-modifier-border': '#d4d7dd', '--background-modifier-hover': 'rgba(0,0,0,0.05)',
      '--text-normal': '#222226', '--text-muted': '#5c5c64', '--text-faint': '#85858e',
    })) root.setProperty(k, v);
  });
}

/** Opens the sheet on the Portfolio, switches to the Agent Threads orchestrator, then opens the menu again. */
async function menuOpenOnProject(page: Page) {
  // HipTrip replies while nobody is looking: an unread count on its row. Agent Threads is mid-stream: the running dot.
  await page.evaluate(() => {
    (window as any).__orchSayTo('k-orch-hiptrip', 'HipTrip: 1 deploy approval is waiting.');
    (window as any).__orchStreamTo('k-orch-threads', 'Checking the dock menu PR…');
  });
  await page.evaluate(() => (window as any).__openSheet());
  await expect(sheet(page)).toBeVisible();
  await expect(titleBtn(page)).toHaveText(/Portfolio orchestrator/);
  await titleBtn(page).click();
  await page.locator('.ct-orch-menu [role="option"][data-target-id="k-orch-threads"]').click();
  await expect(titleBtn(page)).toHaveText(/Agent Threads orchestrator/);
  await titleBtn(page).click();
  await expect(menu(page)).toBeVisible();
}

test.describe('orchestrator menu — screenshots', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const { label, size } of SIZES) {
      test(`menu open, Project target selected @ ${theme} ${label}`, async ({ page }) => {
        await open(page, size);
        if (theme === 'light') await setLight(page);
        await menuOpenOnProject(page);
        await expect(page.locator('.ct-orch-menu [role="option"]')).toHaveCount(3);
        await shot(page, `orchestrator-target-menu-${theme}-${label}.png`, DOCK_SHOT);
      });
    }
  }
});

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

  test('without a Project orchestrator the title stays a plain heading', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto(`${kanbanUrl}?orch=idle&tx=conversation`);
    await page.waitForSelector('.ct-kanban-dispatch .ct-orch-dock');
    await page.evaluate(() => (window as any).__openSheet());
    await expect(page.locator('h2.ct-orch-sheet-title')).toHaveText('Portfolio orchestrator');
    await expect(titleBtn(page)).toHaveCount(0);
  });
});

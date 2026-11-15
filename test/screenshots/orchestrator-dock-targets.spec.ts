import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

/**
 * TASK-29 / SOL-25 / RM-12 visual baselines: the dock's sheet title menu of orchestrators.
 * Non-pixel functional specs live in `test/browser/orchestrator-dock-targets.spec.ts`.
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

async function menuOpenOnProject(page: Page) {
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

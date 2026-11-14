import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

/**
 * K2 OrchestratorDock P5 visual baselines @ 375x667.
 * Non-pixel mobile geometry, soft-keyboard, and reduced-motion specs live in
 * `test/browser/orchestrator-dock-mobile.spec.ts`.
 */
const kanbanUrl = 'file://' + path.resolve('test/harness/kanban.html');
const DOCK_SHOT = { threshold: 0.05 } as const;

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
});

type Size = { width: number; height: number };

async function open(page: Page, query: string, size: Size) {
  await page.setViewportSize(size);
  await page.goto(`${kanbanUrl}?${query}&narrow=1&mobile=1`);
  await page.waitForSelector('.ct-kanban-dispatch .ct-orch-dock');
}
const sheet = (page: Page) => page.locator('.ct-orch-sheet');
const isNarrow = (s: Size) => s.width < 640;
async function openSheet(page: Page, size: Size) {
  if (isNarrow(size)) await page.locator('.ct-orch-orb').click(); else await page.evaluate(() => (window as any).__openSheet());
  await expect(sheet(page)).toBeVisible();
}

test.describe('mobile — key states with baselines @ 375x667', () => {
  const size = { width: 375, height: 667 };
  test('idle pill', async ({ page }) => {
    await open(page, 'orch=idle&tx=conversation', size);
    await shot(page.locator('.ct-kanban-dispatch'), 'orchestrator-dock-mobile-idle-375x667.png', DOCK_SHOT);
  });
  test('sheet with transcript and tray', async ({ page }) => {
    await open(page, 'orch=idle&tx=conversation&tray=1', size);
    await openSheet(page, size);
    await expect(page.locator('.ct-orch-tray')).toBeVisible();
    await shot(page, 'orchestrator-dock-mobile-sheet-tray-375x667.png', DOCK_SHOT);
  });
  test('error status row', async ({ page }) => {
    await open(page, 'orch=error', size);
    await expect(page.locator('.ct-orch-status')).toBeVisible();
    await shot(page.locator('.ct-kanban-dispatch'), 'orchestrator-dock-mobile-error-375x667.png', DOCK_SHOT);
  });
});

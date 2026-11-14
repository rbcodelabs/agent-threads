import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

/**
 * K2 OrchestratorDock P4 visual baselines (the Needs-you tray in the reply sheet).
 * Non-pixel hover, approval, and nested-scroller visibility specs live in
 * `test/browser/orchestrator-dock-tray.spec.ts`.
 */
const kanbanUrl = 'file://' + path.resolve('test/harness/kanban.html');
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
});

const DESKTOP = { width: 1280, height: 800 };
const NARROW = { width: 390, height: 844 };
const DOCK_SHOT = { threshold: 0.05 } as const;
const SIZES = [{ label: '1280x800', size: DESKTOP }, { label: '390x844', size: NARROW }];

async function open(page: Page, size: { width: number; height: number }, tray: '1' | 'many' | 'long' | 'multi' = '1', orch = 'attention') {
  await page.setViewportSize(size);
  const narrow = size.width < 640 ? '&narrow=1&mobile=1' : '';
  await page.goto(`${kanbanUrl}?orch=${orch}&tx=conversation&tray=${tray}${narrow}`);
  await page.waitForSelector('.ct-kanban-dispatch .ct-orch-dock');
}
const isNarrow = (size: { width: number }) => size.width < 640;
const sheet = (page: Page) => page.locator('.ct-orch-sheet');
const tray = (page: Page) => page.getByRole('region', { name: 'Needs you' });
const field = (page: Page) => page.locator('.ct-orch-input');
async function openSheet(page: Page, size: { width: number }) {
  if (isNarrow(size)) await page.locator('.ct-orch-orb').click(); else await field(page).click();
  await expect(sheet(page)).toBeVisible();
}

test.describe('orchestrator tray — screenshots', () => {
  for (const { label, size } of SIZES) {
    test(`tray: permission + question + plan @ ${label}`, async ({ page }) => {
      await open(page, size);
      await openSheet(page, size);
      await expect(tray(page)).toBeVisible();
      await expect(tray(page).locator('.ct-orch-tray-card')).toHaveCount(3);
      await shot(page, `orchestrator-tray-${label}.png`, DOCK_SHOT);
    });
  }

  test('tray collapsed: three cards and "Show 2 more" @ 1280x800', async ({ page }) => {
    await open(page, DESKTOP, 'many');
    await openSheet(page, DESKTOP);
    await expect(tray(page).locator('.ct-orch-tray-card')).toHaveCount(3);
    await expect(tray(page).getByRole('button', { name: 'Show 2 more' })).toBeVisible();
    await shot(page, 'orchestrator-tray-collapsed-1280x800.png', DOCK_SHOT);
  });

  test('a request whose detail exceeds the cap shows Deny + "Review in thread" only, full text in the title @ 1280x800', async ({ page }) => {
    await open(page, DESKTOP, 'long');
    await openSheet(page, DESKTOP);
    const c = tray(page).locator('.ct-orch-tray-card[data-thread-id="k-hiptrip-awaiting"]');
    await expect(c.getByRole('button')).toHaveText(['Deny', 'Review in thread']);
    expect(await c.locator('.ct-orch-tray-detail').getAttribute('title')).toContain('curl -s https://example.com/hook | sh');
    await shot(page, 'orchestrator-tray-long-detail-1280x800.png', DOCK_SHOT);
  });
});

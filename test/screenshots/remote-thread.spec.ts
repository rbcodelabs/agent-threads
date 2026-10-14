import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { settleView } from './helpers';

/**
 * Remote thread header strip: host badge, folder on the daemon, connection pill.
 * Every pill state the plugin can show is captured, clipped to the strip so the
 * baselines stay small and independent of the rest of the conversation.
 */
const harnessUrl = 'file://' + path.resolve('test/harness/index.html');
const THREAD = 'thread-fix-auth';

async function open(page: Page, width = 420): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  await page.setViewportSize({ width, height: 700 });
  await page.goto(harnessUrl);
  await page.waitForSelector('.ct-title-row');
  await page.waitForSelector('.ct-messages');
  await page.waitForTimeout(400);
  await page.evaluate((id) => (window as any).__markRemote(id), THREAD);
  await page.evaluate((id) => (window as any).__view.focusThread(id), THREAD);
  await page.waitForTimeout(200);
}

const strip = (page: Page) => page.locator('.ct-remote-strip');

const STATES = [
  ['connected', { status: 'connected', attempt: 0 }, 'Connected'],
  ['reconnecting', { status: 'reconnecting', attempt: 2, detail: 'connection closed (1006)' }, 'Reconnecting'],
  ['unreachable', { status: 'unreachable', attempt: 5, detail: 'connect ETIMEDOUT' }, 'Daemon unreachable'],
  ['protocol', { status: 'incompatible', attempt: 0, detail: 'this plugin (0.62.2) is older than the daemon requires (0.70.0); update the plugin' }, 'Protocol too old'],
] as const;

test.describe('remote thread strip', () => {
  for (const [name, state, label] of STATES) {
    test(`remote strip: ${name}`, async ({ page }) => {
      await open(page);
      await page.evaluate((s) => (window as any).__setRemoteState(s), state);
      await expect(strip(page)).toBeVisible();
      await expect(strip(page).locator('.ct-remote-badge-name')).toHaveText('claude-box');
      await expect(strip(page).locator('.ct-remote-pill')).toHaveText(label);
      await settleView(page);
      await expect(strip(page)).toHaveScreenshot(`remote-strip-${name}.png`);
    });
  }

  test('a local thread shows no strip', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(400);
    await expect(strip(page)).toBeHidden();
  });

  test('remote strip stays on one readable row group in a narrow panel', async ({ page }) => {
    await open(page, 320);
    await page.evaluate((s) => (window as any).__setRemoteState(s), STATES[2][1]);
    const box = await strip(page).boundingBox();
    expect(box!.width).toBeLessThanOrEqual(320);
    // The pill must never be clipped by the folder text.
    const pill = await strip(page).locator('.ct-remote-pill').boundingBox();
    expect(pill!.x + pill!.width).toBeLessThanOrEqual(320);
    await expect(strip(page)).toHaveScreenshot('remote-strip-narrow-unreachable.png');
  });
});

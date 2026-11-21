import { expect, test, type Page } from '@playwright/test';
import path from 'path';
import { CODEX_VERSION, MANAGED_HARNESS_TARGETS } from '../../src/localDaemon/spec';

test.use({ viewport: { width: 1280, height: 800 } });

async function openHarnessSettings(page: Page, state: 'idle' | 'busy') {
  await page.goto(`file://${path.resolve('test/harness/settings.html')}?localDaemonHarnesses=${state}`);
  await page.getByLabel('Settings section').selectOption('remote');
  await expect(page.locator('.ct-local-daemon-harness-codex')).toContainText('Codex 0.1.0');
}

const updates = (page: Page) => page.evaluate(() => (window as any).__harnessUpdates);

test('Local daemon shows the installed Codex version and requires confirming the pinned update', async ({ page }) => {
  await openHarnessSettings(page, 'idle');
  const update = page.getByRole('button', { name: 'Update harnesses' });
  await update.click();
  await expect(page.getByText(`Update Codex from 0.1.0 to ${CODEX_VERSION}?`, { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await updates(page)).toEqual([]);
  await update.click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('.ct-local-daemon-harness-codex')).toContainText(`Codex ${CODEX_VERSION}`);
  await expect(update).toHaveCount(0);
  expect(await updates(page)).toEqual([{ from: '0.1.0', to: CODEX_VERSION, availability: 'idle' }]);
});

test('Local daemon disables the harness update while work is active', async ({ page }) => {
  await openHarnessSettings(page, 'busy');
  await expect(page.getByRole('button', { name: 'Update harnesses' })).toBeDisabled();
  await expect(page.locator('.ct-local-daemon-hint')).toContainText('Wait for the daemon to finish active work');
  expect(await updates(page)).toEqual([]);
});


for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 375, height: 667 }]) {
  test(`previews both Claude and Antigravity at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`file://${path.resolve('test/harness/settings.html')}?localDaemonHarnesses=mixed`);
    await page.getByLabel('Settings section').selectOption('remote');
    await expect(page.locator('.ct-local-daemon-harness-claude')).toContainText('Claude 2.0.0');
    await expect(page.locator('.ct-local-daemon-harness-antigravity')).toContainText('version unknown');
    await page.getByRole('button', { name: 'Update harnesses' }).click();
    await expect(page.getByText(`Claude from 2.0.0 to ${MANAGED_HARNESS_TARGETS.claude}, Antigravity from unknown to ${MANAGED_HARNESS_TARGETS.antigravity}`, { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  });
}

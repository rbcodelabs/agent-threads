import { expect, test, type Page } from '@playwright/test';
import path from 'path';

/**
 * Functional (non-pixel) spec for Settings -> Remote -> "Local daemon: share all Project folders".
 * Drives the real SettingsTab against the settings harness (local daemon controller stubbed): the toggle renders
 * between the memory field and the shared-folders textarea, is off by default, persists localDaemon.shareProjectFolders
 * when switched on, and clears the value again (rather than storing false) when switched off, leaving other
 * local daemon settings alone. No toHaveScreenshot, so no baselines to maintain.
 */
const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
const NAME = 'Local daemon: share all Project folders';

async function openRemote(page: Page) {
  await page.goto(settingsUrl);
  await page.waitForSelector('.ct-settings-shell');
  await page.getByLabel('Settings section').selectOption('remote');
  await expect(page.locator('.setting-item-name', { hasText: NAME })).toBeVisible();
}

const row = (page: Page) => page.locator('.setting-item', { hasText: NAME });
const stored = (page: Page) => page.evaluate(() => (window as any).__settings.localDaemon as Record<string, unknown> | undefined);

test.describe('Local daemon: share all Project folders', () => {
  test('is off by default and sits between the memory field and the shared folders textarea', async ({ page }) => {
    await openRemote(page);
    await expect(row(page).locator('.checkbox-container')).not.toHaveClass(/is-enabled/);
    expect((await stored(page))?.shareProjectFolders).toBeUndefined();
    const names = await page.locator('.setting-item-name').allTextContents();
    const clean = names.map((n) => n.replace(/i$/, '').trim());
    const memory = clean.indexOf('Local daemon memory');
    const toggle = clean.indexOf(NAME);
    const folders = clean.indexOf('Local daemon shared folders');
    expect(memory).toBeGreaterThanOrEqual(0);
    expect(toggle).toBe(memory + 1);
    expect(folders).toBe(toggle + 1);
  });

  test('persists shareProjectFolders=true when switched on, keeping other local daemon settings', async ({ page }) => {
    await openRemote(page);
    await page.evaluate(() => { (window as any).__settings.localDaemon = { enabled: false, port: 7500, memory: '8G' }; });
    await page.getByLabel('Settings section').selectOption('general');
    await page.getByLabel('Settings section').selectOption('remote');
    await row(page).locator('.checkbox-container').click();
    await expect.poll(() => stored(page)).toEqual({ enabled: false, port: 7500, memory: '8G', shareProjectFolders: true });
    await expect(row(page).locator('.checkbox-container')).toHaveClass(/is-enabled/);
  });

  test('stores nothing (not false) when switched back off, and the state survives re-rendering the tab', async ({ page }) => {
    await openRemote(page);
    await row(page).locator('.checkbox-container').click();
    await expect.poll(async () => (await stored(page))?.shareProjectFolders).toBe(true);
    await page.getByLabel('Settings section').selectOption('general');
    await page.getByLabel('Settings section').selectOption('remote');
    await expect(row(page).locator('.checkbox-container')).toHaveClass(/is-enabled/);
    await row(page).locator('.checkbox-container').click();
    // undefined (dropped by JSON.stringify in data.json), never a stored false.
    await expect.poll(async () => (await stored(page))?.shareProjectFolders).toBeUndefined();
    await expect(row(page).locator('.checkbox-container')).not.toHaveClass(/is-enabled/);
  });

  test('warns that the folders are shared read-write at /work/<folder name>', async ({ page }) => {
    await openRemote(page);
    await expect(row(page).locator('.setting-item-description')).toContainText('READ-WRITE');
    await expect(row(page).locator('.setting-item-description')).toContainText('/work/<folder name>');
  });
});

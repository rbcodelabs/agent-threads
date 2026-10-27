import { expect, test, type Page } from '@playwright/test';
import path from 'path';
import { settleView } from './helpers';

/**
 * Per-daemon availability of proxied (OAuth, Google Workspace) MCP servers: the "Available on" row in Settings, MCP and
 * the checklist in the daemon editor. Both write the same `hostTools` (src/hostToolsChecklist.ts).
 */
const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');

const saved = (page: Page, id: string) => page.evaluate((i) => (window as any).__settings.remoteDaemons.find((d: any) => d.id === i).hostTools, id);

async function openMcp(page: Page) {
  await page.setViewportSize({ width: 900, height: 1500 });
  await page.goto(settingsUrl + '?mcpSync=1');
  await page.waitForSelector('.ct-settings-shell');
  await page.getByLabel('Settings section').selectOption('mcp');
  await page.waitForSelector('.ct-mcp-available');
}

test.describe('Settings, MCP: Available on (OAuth servers)', () => {
  test('a toggle opts one server in for one daemon, naming only that server', async ({ page }) => {
    await openMcp(page);
    const row = page.locator('.setting-item', { has: page.locator('.setting-item-name', { hasText: /^vercel/ }) });
    await expect(row).toContainText('Runs on this computer and is proxied to the daemon');
    await expect(row).toContainText('Not available on Homelab.');
    await page.getByLabel('Make vercel available on Homelab').check();
    await expect.poll(() => saved(page, 'homelab')).toEqual({ enabled: true, routes: { vercel: 'host' } });
    await expect(page.getByLabel('Make vercel available on Homelab')).toBeChecked();
    expect(await saved(page, 'plain-box')).toBeUndefined();
    await settleView(page);
    await expect(page.locator('.ct-oauth-mcp-servers-list')).toHaveScreenshot('mcp-oauth-available-on.png');
    // The explicit "Turn on" button does the same for another daemon, and off cleans up completely.
    await page.getByLabel('Make vercel available on Plain box').check();
    await expect.poll(() => saved(page, 'plain-box')).toEqual({ enabled: true, routes: { vercel: 'host' } });
    await page.getByLabel('Make vercel available on Plain box').uncheck();
    await expect.poll(() => saved(page, 'plain-box')).toBeUndefined();
  });
});

test.describe('Daemon editor: tools checklist', () => {
  async function openModal(page: Page, opts: Record<string, unknown>) {
    await page.setViewportSize({ width: 760, height: 1700 });
    await page.goto(settingsUrl);
    await page.waitForSelector('.vertical-tab-content');
    await page.evaluate((o) => (window as any).__openRemoteDaemonModal(o), opts);
    await page.waitForSelector('.modal-container');
    await page.locator('summary', { hasText: 'Advanced' }).click();
  }

  test('items are greyed out until the master switch is on; no free-text boxes remain', async ({ page }) => {
    await openModal(page, {});
    const modal = page.locator('.modal-container');
    await expect(modal.getByLabel('Notes in this vault')).toBeDisabled();
    await expect(modal).toContainText('Turn on "Tools on this computer"');
    await expect(modal.getByPlaceholder('vault, mcp')).toHaveCount(0);
    await expect(modal.getByPlaceholder('docs, search')).toHaveCount(0);
    await modal.locator('.setting-item', { hasText: 'Tools on this computer' }).locator('.checkbox-container').click();
    await modal.getByLabel('Notes in this vault').check();
    await modal.getByLabel('hiptrip-new').check();
    await modal.getByRole('button', { name: /save/i }).evaluate((b: HTMLElement) => b.click());
    expect((await page.evaluate(() => (window as any).__savedDaemon)).hostTools).toEqual({ enabled: true, routes: { vault: 'host', 'hiptrip-new': 'host' } });
  });

  test('"Tools from other plugins" ticks to plugins: host', async ({ page }) => {
    await openModal(page, {});
    const modal = page.locator('.modal-container');
    await modal.locator('.setting-item', { hasText: 'Tools on this computer' }).locator('.checkbox-container').click();
    const row = modal.getByLabel('Tools from other plugins');
    await expect(row).not.toBeChecked();
    await row.check();
    await modal.getByRole('button', { name: /save/i }).evaluate((b: HTMLElement) => b.click());
    expect((await page.evaluate(() => (window as any).__savedDaemon)).hostTools).toEqual({ enabled: true, routes: { plugins: 'host' } });
  });

  test('a legacy config shows custom rows and saves back unchanged', async ({ page }) => {
    const hostTools = { enabled: true, routes: { vault: 'host', mcp: 'host', old_tool: 'host' }, mcpAllowlist: ['docs', 'gone'] };
    await openModal(page, { hostTools });
    const modal = page.locator('.modal-container');
    await expect(modal.getByLabel('mcp', { exact: true })).toBeChecked();
    await expect(modal.getByLabel('old_tool')).toBeChecked();
    await expect(modal.getByLabel('gone')).toBeChecked();
    await expect(modal.getByLabel('hiptrip-new')).toBeChecked();
    await settleView(page);
    await expect(page).toHaveScreenshot('daemon-editor-tools-checklist.png', { fullPage: true });
    await modal.getByRole('button', { name: /save/i }).evaluate((b: HTMLElement) => b.click());
    expect((await page.evaluate(() => (window as any).__savedDaemon)).hostTools).toEqual(hostTools);
  });
});

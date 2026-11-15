import { expect, test, type Page } from '@playwright/test';
import path from 'path';

/**
 * Functional (non-pixel) spec for Settings -> MCP -> "Runs on". Drives the real SettingsTab and the real McpSyncEngine
 * against the settings harness (?mcpSync=1): three stand-in daemons (Homelab takes stdio, Plain box does not, Old box
 * predates mcp.sync) and a recording transport in place of the socket. Pixels are covered by ui.spec.ts.
 */
const url = 'file://' + path.resolve('test/harness/settings.html') + '?mcpSync=1';

async function open(page: Page) {
  await page.goto(url);
  await page.waitForSelector('.ct-settings-shell');
  await page.getByLabel('Settings section').selectOption('mcp');
  await page.waitForSelector('.ct-mcp-runson');
}

const box = (page: Page, server: string, daemon: string) => page.getByLabel(`Run ${server} on ${daemon}`);
const calls = (page: Page) => page.evaluate(() => (window as any).__mcpSyncCalls as { creds: Array<{ daemonId: string; kind: string; fields: string[]; ttlSec: number }>; servers: Array<{ daemonId: string; names: string[] }> });
const row = (page: Page, server: string) => page.locator('.setting-item', { has: page.locator('.setting-item-name', { hasText: new RegExp(`^${server}`) }) });

test.describe('Settings, MCP: Runs on', () => {
  test('shows the saved opt-ins with the daemon\'s own status, and the reason a toggle is disabled', async ({ page }) => {
    await open(page);
    await expect(box(page, 'team_events', 'Homelab')).toBeChecked();
    await expect(row(page, 'team_events').locator('.ct-mcp-runson-chip--ok')).toHaveText('Connected');
    // The daemon reported the credential missing: failed, with a way to push it now.
    await expect(row(page, 'obsidian_notes').locator('.ct-mcp-runson-chip--bad')).toContainText('missing credential mcpsync-global.NOTES_API_TOKEN');
    await expect(row(page, 'obsidian_notes').getByRole('button', { name: /Push obsidian_notes credentials to Homelab now/ })).toBeVisible();
    // Reasons.
    await expect(box(page, 'team_events', 'Old box')).toBeDisabled();
    await expect(row(page, 'team_events')).toContainText('too old');
    await expect(box(page, 'obsidian_notes', 'Plain box')).toBeDisabled();
    await expect(row(page, 'obsidian_notes')).toContainText('allowSyncedStdio');
    await expect(box(page, 'compass', 'Homelab')).toBeDisabled();
    await expect(row(page, 'compass')).toContainText('COMPASS_API_KEY');
  });

  test('Push now sends the credentials and definitions again', async ({ page }) => {
    await open(page);
    await row(page, 'obsidian_notes').getByRole('button', { name: /Push obsidian_notes credentials/ }).click();
    await expect.poll(async () => (await calls(page)).creds).toEqual([{ daemonId: 'homelab', kind: 'mcpsync-global', fields: ['NOTES_API_TOKEN'], ttlSec: 30 * 86400 }]);
    expect((await calls(page)).servers.at(-1)).toEqual({ daemonId: 'homelab', names: ['obsidian_notes', 'team_events'] });
  });

  test('the first enable asks, showing the exact command, env names and secret names, and cancel changes nothing', async ({ page }) => {
    await open(page);
    // Homelab already has obsidian_notes; use Plain box for an http server and Homelab's compass is blocked, so test the stdio modal via Plain box team_events.
    await box(page, 'team_events', 'Plain box').check();
    const modal = page.locator('.ct-mcp-sync-confirm');
    await expect(modal).toContainText('Run "team_events" on Plain box?');
    await expect(modal).toContainText('https://events.example.com/sse');
    await expect(modal).toContainText('Secrets that leave this Mac');
    await expect(modal).toContainText('None');
    await modal.getByRole('button', { name: 'Cancel' }).click();
    await expect(box(page, 'team_events', 'Plain box')).not.toBeChecked();
    expect(await calls(page)).toEqual({ creds: [], servers: [] });

    await box(page, 'team_events', 'Plain box').check();
    await modal.getByRole('button', { name: 'Run on Plain box' }).click();
    await expect.poll(async () => (await calls(page)).servers).toEqual([{ daemonId: 'plain-box', names: ['team_events'] }]);
    expect((await calls(page)).creds).toEqual([]);
    await expect(box(page, 'team_events', 'Plain box')).toBeChecked();
    const stored = await page.evaluate(() => (window as any).__settings.remoteDaemons.find((d: any) => d.id === 'plain-box').mcpSync);
    expect(stored.team_events.enabled).toBe(true);
    expect(typeof stored.team_events.confirmedHash).toBe('string');
  });

  test('turning a server off re-syncs the smaller set; turning it back on needs no second prompt', async ({ page }) => {
    await open(page);
    await box(page, 'team_events', 'Homelab').uncheck();
    await expect.poll(async () => (await calls(page)).servers.at(-1)).toEqual({ daemonId: 'homelab', names: ['obsidian_notes'] });
    await box(page, 'team_events', 'Homelab').check();
    await expect(page.locator('.ct-mcp-sync-confirm')).toHaveCount(0);
    await expect.poll(async () => (await calls(page)).servers.at(-1)).toEqual({ daemonId: 'homelab', names: ['obsidian_notes', 'team_events'] });
  });

  test('a changed definition is not synced until it is reviewed again', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      (window as any).__settings.mcpServers.team_events.url = 'https://events.example.com/changed';
      (window as any).__settingsPlugin.onMcpSyncInputsChanged();
    });
    await expect.poll(async () => (await calls(page)).servers.at(-1)).toEqual({ daemonId: 'homelab', names: ['obsidian_notes'] });
    await page.getByLabel('Settings section').selectOption('general');
    await page.getByLabel('Settings section').selectOption('mcp');
    await expect(row(page, 'team_events').locator('.ct-mcp-runson-chip--warn')).toContainText('Changed');
    await row(page, 'team_events').getByRole('button', { name: /Review the changed team_events/ }).click();
    await expect(page.locator('.ct-mcp-sync-confirm')).toContainText('https://events.example.com/changed');
    await page.locator('.ct-mcp-sync-confirm').getByRole('button', { name: 'Run on Homelab' }).click();
    await expect.poll(async () => (await calls(page)).servers.at(-1)).toEqual({ daemonId: 'homelab', names: ['obsidian_notes', 'team_events'] });
  });
});

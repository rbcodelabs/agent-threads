import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { settleView } from './helpers';

/**
 * A remote thread's daemon cannot run every MCP server the user has configured (stdio programs, loopback URLs,
 * secrets). That is shown as a yellow warnings pill in the daemon header strip, with the reasons in its tooltip,
 * and NOT as a "Not available on ..." notice in the transcript.
 */
const harnessUrl = 'file://' + path.resolve('test/harness/index.html');
const THREAD = 'thread-fix-auth';

const SERVERS = {
  'local-files': { type: 'stdio', command: 'npx', args: ['-y', 'files-mcp'] },
  'dev-db': { type: 'http', url: 'http://localhost:8080/mcp' },
  'private-api': { type: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer ${API_TOKEN}' } },
  docs: { type: 'http', url: 'https://docs.example.com/mcp' },
};

async function open(page: Page, width: number, servers: Record<string, unknown>): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  await page.setViewportSize({ width, height: 700 });
  await page.goto(harnessUrl);
  await page.waitForSelector('.ct-title-row');
  await page.waitForSelector('.ct-messages');
  await page.waitForTimeout(400);
  await page.evaluate((id) => (window as any).__markRemote(id), THREAD);
  await page.evaluate(([s, id]) => (window as any).__setMcpServers(s, id), [servers, THREAD] as const);
  await page.waitForTimeout(200);
}

const strip = (page: Page) => page.locator('.ct-remote-strip');
const warn = (page: Page) => page.locator('[data-testid="remote-warnings"]');

const VIEWPORTS = [
  ['desktop', 900],
  ['mobile', 360],
] as const;

test.describe('remote thread header: dropped MCP servers pill', () => {
  for (const [label, width] of VIEWPORTS) {
    test(`shows the count and reasons for servers the daemon cannot use, not a transcript notice (${label})`, async ({ page }) => {
      await open(page, width, SERVERS);
      await expect(strip(page)).toBeVisible();
      await expect(warn(page)).toBeVisible();
      await expect(warn(page)).toHaveText('3'); // docs passes through; the other three are dropped
      const title = (await warn(page).getAttribute('title')) ?? '';
      expect(title).toContain('Not available on my-server');
      expect(title).toContain('local-files: it starts a program on this computer');
      expect(title).toContain('dev-db: its address is on this computer');
      expect(title).toContain('private-api:');
      expect(title).not.toContain('docs:');
      // The old transcript notice must be gone from the message pane.
      await expect(page.locator('.ct-messages')).not.toContainText('Not available on');
      await expect(page.locator('.ct-notice-row')).toHaveCount(0);
      // Layout: nothing in the strip spills out of the panel, and the pill sits before the connection pill.
      const viewport = page.viewportSize()!;
      const w = (await warn(page).boundingBox())!;
      const conn = (await strip(page).locator('.ct-remote-pill').boundingBox())!;
      expect(w.x).toBeGreaterThanOrEqual(0);
      expect(w.x + w.width).toBeLessThanOrEqual(viewport.width);
      expect(conn.x + conn.width).toBeLessThanOrEqual(viewport.width);
      expect(w.x + w.width).toBeLessThanOrEqual(conn.x + 1);
      await settleView(page);
      await expect(strip(page)).toHaveScreenshot(`remote-mcp-warnings-${label}.png`);
    });

    test(`shows no pill when every server reaches the daemon (${label})`, async ({ page }) => {
      await open(page, width, { docs: SERVERS.docs });
      await expect(strip(page)).toBeVisible();
      await expect(warn(page)).toHaveCount(0);
      await expect(page.locator('.ct-messages')).not.toContainText('Not available on');
      await settleView(page);
      await expect(strip(page)).toHaveScreenshot(`remote-mcp-warnings-none-${label}.png`);
    });
  }

  test('a local thread never shows the pill, even with unusable servers configured', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(400);
    await page.evaluate(([s, id]) => (window as any).__setMcpServers(s, id), [SERVERS, THREAD] as const);
    await expect(warn(page)).toHaveCount(0);
  });
});

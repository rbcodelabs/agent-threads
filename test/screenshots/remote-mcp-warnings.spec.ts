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
  ['1280', 1280],
  ['390', 390],
  ['375', 375],
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
      const noOverflow = await strip(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
      expect(noOverflow, 'strip content must not overflow its box').toBe(true);
      test.info().annotations.push({ type: 'pill-box', description: `${Math.round(w.width)}x${Math.round(w.height)}` });
      await settleView(page);
      await expect(strip(page)).toHaveScreenshot(`remote-mcp-warnings-${label}.png`);
      await expect(page).toHaveScreenshot(`remote-mcp-warnings-page-${label}.png`);
    });

    test(`the pill has a 44x44 tap target that does not steal clicks from neighbours (${label})`, async ({ page }) => {
      await open(page, width, SERVERS);
      const w = (await warn(page).boundingBox())!;
      const cx = w.x + w.width / 2;
      const cy = w.y + w.height / 2;
      const hits = (x: number, y: number) => page.evaluate(([px, py]) => { const el = document.elementFromPoint(px, py); return !!el?.closest('[data-testid="remote-warnings"]'); }, [x, y]);
      // The box reaches 6px above the pill (clear of the title button) and 20px below; 43px of that 44px is probed.
      for (const dx of [-21, 0, 21]) for (const y of [w.y - 5.5, w.y + 9, w.y + 37.5]) expect(await hits(cx + dx, y), `point (${dx}, ${(y - w.y).toFixed(1)}) from the pill top-left`).toBe(true);
      // Neighbours keep their own area: the badge and the connection pill resolve to themselves.
      const owner = (sel: string) => page.evaluate(([s]) => { const r = document.querySelector(s)!.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(s) === document.querySelector(s); }, [sel]);
      expect(await owner('[data-testid="remote-badge"]')).toBe(true);
      expect(await owner('[data-testid="remote-pill"]')).toBe(true);
      const conn = (await strip(page).locator('.ct-remote-pill').boundingBox())!;
      expect(await hits(conn.x + 1, cy), 'left edge of the connection pill').toBe(false);
      // The extended area must not reach the title-row controls above the strip.
      const area = { top: w.y - 6, bottom: w.y + 38, left: cx - 22, right: cx + 22 };
      const controls = await page.locator('.ct-title-row button, .ct-title-row [role="button"], .ct-title-row .clickable-icon').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent).map((e) => e.getBoundingClientRect().toJSON()));
      for (const c of controls) {
        const overlap = c.left < area.right && c.right > area.left && c.top < area.bottom && c.bottom > area.top;
        expect(overlap, `title-row control at x=${Math.round(c.left)} overlaps the pill hit area`).toBe(false);
      }
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

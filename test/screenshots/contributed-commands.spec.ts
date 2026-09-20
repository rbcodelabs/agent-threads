import { test, expect } from '@playwright/test';
import path from 'path';
import { anchorFocusedComposerToBottom, shot } from './helpers';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

test('a public peer registration is live, executes via the composer, and disposes without losing text', async ({ page }) => {
  await page.goto(harnessUrl);
  const input = page.locator('.ct-input');
  await input.fill('/');
  await page.evaluate(() => {
    const w = window as any;
    w.__peerCalls = [];
    w.__peerCommand = w.__api.extensions.registerSlashCommand({ pluginId: 'example.boards' }, {
      name: 'board', thread: { description: 'Open a peer board', invoke: async (context: unknown, host: any) => {
        w.__peerCalls.push(context);
        host.report('Peer board opened');
        return { status: 'ok' };
      } },
    });
  });
  await expect(page.locator('.ct-skill-dropdown')).toContainText('Open a peer board');
  await input.fill('/board ');
  await input.press('End');
  await input.press('x');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__peerCalls.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__peerCalls[0])).toMatchObject({ surface: 'thread', args: 'x', hasImages: false, hasAttachment: false });
  await expect(page.getByText('Peer board opened', { exact: true })).toBeVisible();
  await input.fill('/board draft');
  await input.press('End');
  await input.press(' ');
  await expect(page.locator('.ct-command-pill')).toContainText('/board');
  await page.evaluate(() => (window as any).__peerCommand.dispose());
  await expect(page.locator('.ct-command-pill')).toHaveCount(0);
  await expect(input).toHaveValue('/board draft ');
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 375, height: 667 }]) {
  test(`Design remains discoverable and keyboard-selectable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.goto(harnessUrl);
    await page.evaluate(() => {
      const app = document.querySelector<HTMLElement>('#app')!;
      app.style.width = `${window.innerWidth}px`;
      app.style.height = `${window.innerHeight}px`;
    });
    const input = page.locator('.ct-input');
    await input.fill('/des');
    await expect(page.locator('.ct-skill-dropdown')).toContainText('Create or revise a live static UI artifact');
    await input.press('Tab');
    await expect(page.locator('.ct-command-pill')).toContainText('/design');
    await expect(input).toBeVisible();
    await expect(input).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await anchorFocusedComposerToBottom(page);
    await shot(page, `design-command-${viewport.width}.png`);
  });
}

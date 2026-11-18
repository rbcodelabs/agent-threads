import { test, expect } from '@playwright/test';
import { openCodexNetworkSettings, networkRow, chooseNetworkAccess } from '../harness/codex-network-access';

for (const [width, height] of [[1280, 800], [390, 844], [375, 667]]) {
  test(`local Codex network defaults off and persists choices at ${width}px`, async ({ page }) => {
    await openCodexNetworkSettings(page, width, height);
    await expect(networkRow(page)).toContainText('Off');
    await networkRow(page).click();
    await expect(page.getByRole('menuitemradio', { name: 'Off', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.ct-sp-note')).toContainText('Plan mode still denies network access');
    await chooseNetworkAccess(page, true);
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
      await (window as any).__view.focusThread('thread-brainstorm');
      await (window as any).__view.focusThread('thread-fix-auth');
    });
    await page.locator('.ct-thread-more-btn').click();
    await expect(networkRow(page)).toContainText('On');
    await networkRow(page).click();
    await chooseNetworkAccess(page, false);
    await page.getByRole('menuitem', { name: 'Network access', exact: true }).click();
    await expect(networkRow(page)).toContainText('Off');
    const bounds = await networkRow(page).boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
  });
}

for (const harness of ['claude', 'remote-codex']) {
  test(`network choice is hidden for ${harness}`, async ({ page }) => {
    await openCodexNetworkSettings(page);
    await page.keyboard.press('Escape');
    await page.evaluate(async (kind) => {
      const host = window as any;
      const thread = host.__manager.getThread('thread-fix-auth');
      if (kind === 'claude') thread.agentHarness = 'claude';
      else thread.remote = { daemonId: 'fixture-daemon', threadId: 'fixture-thread' };
      await host.__view.focusThread(thread.id);
    }, harness);
    await page.locator('.ct-thread-more-btn').click();
    await expect(page.locator('[data-ct-key="row:model"]')).toBeVisible();
    await expect(networkRow(page)).toHaveCount(0);
  });
}

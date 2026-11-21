import { test, expect } from '@playwright/test';
import { openCodexNetworkSettings, networkRow, chooseNetworkAccess } from '../harness/codex-network-access';
import { shot } from './helpers';
import path from 'path';

for (const [width, height] of [[1280, 800], [390, 844], [375, 667]]) {
  test(`Codex network access choices at ${width}px`, async ({ page }) => {
    await openCodexNetworkSettings(page, width, height);
    await expect(networkRow(page)).toContainText('Use default (Off)');
    await networkRow(page).click();
    await shot(page, `codex-network-access-default-${width}.png`);
    await chooseNetworkAccess(page, false);
    await shot(page, `codex-network-access-off-${width}.png`);
    await chooseNetworkAccess(page, true);
    await shot(page, `codex-network-access-on-${width}.png`);
    await chooseNetworkAccess(page, undefined);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
      const host = window as any;
      host.__view.plugin.settings.codexNetworkAccessDefault = true;
      host.__manager.updateSettings(host.__view.plugin.settings);
      await host.__view.focusThread('thread-fix-auth');
    });
    await page.locator('.ct-thread-more-btn').click();
    await expect(networkRow(page)).toContainText('Use default (On)');
    await networkRow(page).click();
    await shot(page, `codex-network-access-default-on-${width}.png`);
  });

  test(`shared Codex network default at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('file://' + path.resolve('test/harness/settings.html'));
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('#app')!.style.width = 'min(760px, 100vw)';
    });
    await page.getByLabel('Settings section').selectOption('claude');
    await page.getByRole('tab', { name: /OpenAI Codex/ }).click();
    const setting = page.locator('.setting-item').filter({ hasText: 'Codex network access default' });
    const toggle = setting.locator('.checkbox-container');
    await setting.scrollIntoViewIfNeeded();
    await expect(toggle).not.toHaveClass(/is-enabled/);
    await shot(setting, `codex-network-default-off-${width}.png`);
    await toggle.click();
    await expect(toggle).toHaveClass(/is-enabled/);
    await shot(setting, `codex-network-default-on-${width}.png`);
  });
}

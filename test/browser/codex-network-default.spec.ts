import { test, expect } from '@playwright/test';
import path from 'path';

for (const [width, height] of [[1280, 800], [390, 844], [375, 667]]) {
  test(`shared Codex network default persists without rewriting thread choices at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('file://' + path.resolve('test/harness/settings.html'));
    await page.evaluate(() => {
      const host = window as any;
      host.__networkDefaultSaves = [];
      host.__settings.threads = [{ id: 'explicit-on', codexNetworkAccessEnabled: true }, { id: 'explicit-off', codexNetworkAccessEnabled: false }, { id: 'inherited' }];
      host.__settingsPlugin.saveSettings = async () => {
        host.__networkDefaultSaves.push(host.__settings.codexNetworkAccessDefault);
      };
      document.querySelector<HTMLElement>('#app')!.style.width = 'min(760px, 100vw)';
    });
    await page.getByLabel('Settings section').selectOption('claude');
    await page.getByRole('tab', { name: /OpenAI Codex/ }).click();
    const setting = page.locator('.setting-item').filter({ hasText: 'Codex network access default' });
    const toggle = setting.locator('.checkbox-container');
    await expect(toggle).not.toHaveClass(/is-enabled/);
    await expect(setting).toContainText('existing sessions keep their current access');
    await expect(setting).toContainText('remote threads are unchanged');
    await toggle.click();
    await expect(toggle).toHaveClass(/is-enabled/);
    await expect.poll(() => page.evaluate(() => (window as any).__networkDefaultSaves)).toEqual([true]);
    await page.getByLabel('Settings section').selectOption('general');
    await page.getByLabel('Settings section').selectOption('claude');
    await expect(toggle).toHaveClass(/is-enabled/);
    expect(await page.evaluate(() => (window as any).__settings.threads)).toEqual([
      { id: 'explicit-on', codexNetworkAccessEnabled: true },
      { id: 'explicit-off', codexNetworkAccessEnabled: false },
      { id: 'inherited' },
    ]);
    await toggle.click();
    await expect.poll(() => page.evaluate(() => (window as any).__networkDefaultSaves)).toEqual([true, false]);
  });
}

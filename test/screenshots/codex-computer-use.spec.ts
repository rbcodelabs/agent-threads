import { test, expect } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

for (const width of [1280, 390]) {
  test(`Codex computer use defaults off and saves opt-in at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await page.goto('file://' + path.resolve('test/harness/settings.html'));
    await page.evaluate(() => {
      const host = window as any;
      host.__computerUseSaves = [];
      host.__settingsPlugin.saveSettings = async () => {
        host.__computerUseSaves.push(host.__settings.codexComputerUseEnabled);
      };
      document.querySelector<HTMLElement>('#app')!.style.width = 'min(760px, 100vw)';
    });
    await page.locator('.ct-settings-tab-btn').filter({ hasText: /^Agent$/ }).click();
    const setting = page.locator('.setting-item').filter({ hasText: 'Codex computer use' });
    const toggle = setting.locator('.checkbox-container');
    await expect(toggle).not.toHaveClass(/is-enabled/);
    await expect(setting).toContainText('existing sessions keep their current access');
    await setting.scrollIntoViewIfNeeded();
    const bounds = await toggle.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await shot(setting, `codex-computer-use-off-${width}.png`);
    await toggle.click();
    await expect(toggle).toHaveClass(/is-enabled/);
    await expect.poll(() => page.evaluate(() => (window as any).__computerUseSaves)).toEqual([true]);
    await page.locator('.ct-settings-tab-btn').filter({ hasText: /^General$/ }).click();
    await page.locator('.ct-settings-tab-btn').filter({ hasText: /^Agent$/ }).click();
    await expect(toggle).toHaveClass(/is-enabled/);
    await shot(setting, `codex-computer-use-on-${width}.png`);
    await toggle.click();
    await expect.poll(() => page.evaluate(() => (window as any).__computerUseSaves)).toEqual([true, false]);
    await expect(toggle).not.toHaveClass(/is-enabled/);
  });
}

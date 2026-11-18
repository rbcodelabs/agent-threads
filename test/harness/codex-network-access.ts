import { expect, type Page } from '@playwright/test';
import path from 'path';

export const networkRow = (page: Page) => page.locator('[data-ct-key="row:codex-network-access"]');

export async function openCodexNetworkSettings(page: Page, width = 1280, height = 800): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  await page.setViewportSize({ width, height });
  await page.goto('file://' + path.resolve('test/harness/index.html') + (width < 600 ? '?mobile=1' : ''));
  await page.waitForSelector('.ct-title-row');
  await page.evaluate(async () => {
    const host = window as any;
    const thread = host.__manager.getThread('thread-fix-auth');
    thread.agentHarness = 'codex';
    delete thread.codexNetworkAccessEnabled;
    // Keep the real manager setter and save boundary; replace only disk persistence.
    host.__networkSaves = [];
    host.__view.plugin.saveSettings = async () => {
      host.__networkSaves.push(host.__manager.getThread(thread.id).codexNetworkAccessEnabled);
    };
    const app = document.querySelector<HTMLElement>('#app')!;
    app.style.width = 'min(760px, 100vw)';
    app.style.height = 'min(700px, 100vh)';
    await host.__view.focusThread(thread.id);
  });
  await page.locator('.ct-thread-more-btn').click();
}

export async function chooseNetworkAccess(page: Page, enabled: boolean): Promise<void> {
  const savesBeforeChoice = await page.evaluate(() => (window as any).__networkSaves.length as number);
  await page.getByRole('menuitemradio', { name: enabled ? 'On' : 'Off', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__manager.getThread('thread-fix-auth').codexNetworkAccessEnabled)).toBe(enabled);
  // Focusing threads and other view updates also save settings. Require this
  // choice to reach persistence without imposing a count on unrelated saves.
  await expect.poll(() => page.evaluate((start) => (window as any).__networkSaves.slice(start), savesBeforeChoice)).toContain(enabled);
  await expect(networkRow(page)).toContainText(enabled ? 'On' : 'Off');
  await networkRow(page).click();
  await expect(page.getByRole('menuitemradio', { name: enabled ? 'On' : 'Off', exact: true })).toHaveAttribute('aria-checked', 'true');
}

/**
 * Playwright coverage for AgentBrowserPreviewView's login-handoff banner
 * (ADR-0014, PR #631).
 *
 * PR #631 shipped this UI without browser-level coverage — its description
 * said triggering the banner "was not possible in this environment" because
 * it requires simulating Geode's `window.geode.onAgentBrowserWindowOpen`
 * popup bridge and Electron's `ipcRenderer` close/focus channels. Both are
 * dependency-injected on purpose (see `AgentBrowserLoginBridge.ts`'s doc
 * comment): `window.geode` is a plain object a page can define before the
 * view mounts, and `ipcRenderer` resolves through the existing esbuild
 * `electron` alias. `test/harness/agent-browser-preview-index.ts` wires both
 * up and exposes `window.__fireLoginOpen` / `__fireIpcClose` / `__fireIpcFocus`
 * so this file drives the real production wiring, not a re-implementation of
 * it — the same way the vitest coverage in
 * test/unit/agent-browser-preview.test.ts already fakes `window.geode` for
 * unit-level assertions.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

const harnessUrl = 'file://' + path.resolve('test/harness/agent-browser-preview.html');

test.describe('AgentBrowserPreviewView — login handoff banner (ADR-0014)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 460, height: 420 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-browser-preview');
  });

  test('no banner by default', async ({ page }) => {
    await expect(page.locator('.ct-browser-login-banner')).toBeHidden();
    await shot(page.locator('#app'), 'agent-browser-preview-idle.png');
  });

  test('shows a "take control" banner when the primary guest is denied a popup', async ({ page }) => {
    await page.evaluate(() => (window as any).__fireLoginOpen('https://accounts.example.com/login'));

    const banner = page.locator('.ct-browser-login-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('sign in');
    await expect(banner).toContainText('accounts.example.com');
    await expect(page.locator('.ct-browser-login-banner-action:visible')).toHaveCount(1);
    await expect(page.locator('.ct-browser-login-banner-action', { hasText: 'Take control' })).toBeVisible();
    await shot(page.locator('#app'), 'agent-browser-preview-pending-login.png');
  });

  test('ignores a popup denial for a guest the pool does not recognise', async ({ page }) => {
    await page.evaluate(() => (window as any).__fireLoginOpen('https://evil.example.com', 999));
    await expect(page.locator('.ct-browser-login-banner')).toBeHidden();
  });

  test('"Take control" acquires the login guest, hides the stop button, and starts capturing it', async ({ page }) => {
    await page.evaluate(() => (window as any).__fireLoginOpen('https://accounts.example.com/login'));
    await page.locator('.ct-browser-login-banner-action', { hasText: 'Take control' }).click();

    await expect.poll(() => page.evaluate(() => (window as any).__getAcquireLoginGuestCalls())).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as any).__getLoginGuestFocusCalls())).toBe(1);
    await expect(page.locator('.ct-browser-preview-stop')).toHaveClass(/is-hidden/);
    await expect(page.locator('.ct-browser-login-banner')).toContainText('You are signing in');
    await expect(page.locator('.ct-browser-preview-detail')).toContainText('you have control of this page');

    await shot(page.locator('#app'), 'agent-browser-preview-handoff-active.png');
  });

  test('"Return control" releases the login guest and restores the primary view', async ({ page }) => {
    await page.evaluate(() => (window as any).__fireLoginOpen('https://accounts.example.com/login'));
    await page.locator('.ct-browser-login-banner-action', { hasText: 'Take control' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__getAcquireLoginGuestCalls())).toBe(1);

    await page.locator('.ct-browser-login-banner-action', { hasText: 'Return control' }).click();

    const releaseCalls = await page.evaluate(() => (window as any).__getReleaseLoginGuestCalls());
    expect(releaseCalls).toEqual([{ threadId: 'thread-1', reason: 'login-complete' }]);
    await expect(page.locator('.ct-browser-preview-stop')).not.toHaveClass(/is-hidden/);
    await expect(page.locator('.ct-browser-login-banner')).toBeHidden();
  });

  test('the login guest closing itself over IPC returns control automatically', async ({ page }) => {
    await page.evaluate(() => (window as any).__fireLoginOpen('https://accounts.example.com/login'));
    await page.locator('.ct-browser-login-banner-action', { hasText: 'Take control' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__getAcquireLoginGuestCalls())).toBe(1);

    // The real Electron main process relays the login popup's own
    // window.close() over this channel — see AgentBrowserLoginBridge.handleClose.
    await page.evaluate(() => (window as any).__fireIpcClose());

    await expect.poll(() => page.evaluate(() => (window as any).__getReleaseLoginGuestCalls())).toEqual([
      { threadId: 'thread-1', reason: 'login-complete' },
    ]);
    await expect(page.locator('.ct-browser-login-banner')).toBeHidden();
  });

  test('an IPC close for an unrecognised webContentsId is ignored', async ({ page }) => {
    await page.evaluate(() => (window as any).__fireLoginOpen('https://accounts.example.com/login'));
    await page.locator('.ct-browser-login-banner-action', { hasText: 'Take control' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__getAcquireLoginGuestCalls())).toBe(1);

    await page.evaluate(() => (window as any).__fireIpcClose(9999));

    // Still mid-handoff — no release triggered by a webContentsId nobody owns.
    await expect(page.locator('.ct-browser-login-banner')).toContainText('You are signing in');
    expect(await page.evaluate(() => (window as any).__getReleaseLoginGuestCalls())).toEqual([]);
  });

  test('the login guest regaining OS focus over IPC reveals the preview leaf', async ({ page }) => {
    await page.evaluate(() => (window as any).__fireLoginOpen('https://accounts.example.com/login'));
    await page.locator('.ct-browser-login-banner-action', { hasText: 'Take control' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__getAcquireLoginGuestCalls())).toBe(1);

    await page.evaluate(() => (window as any).__fireIpcFocus());

    await expect.poll(() => page.evaluate(() => (window as any).__getRevealLeafCalls())).toBe(1);
  });

  test('an expired request explains itself instead of just disappearing', async ({ page }) => {
    // Installing the clock now (post-navigation) still virtualizes the timer
    // AgentBrowserLoginBridge's 30s TTL runs on; only Date/timer state from
    // this point forward needs to be fake, and the view is already mounted.
    await page.clock.install();
    await page.evaluate(() => (window as any).__fireLoginOpen('https://accounts.example.com/login'));
    await expect(page.locator('.ct-browser-login-banner')).toContainText('sign in');

    await page.clock.fastForward('00:31');

    await expect(page.locator('.ct-browser-login-banner')).toContainText('expired');
    await expect(page.locator('.ct-browser-login-banner-action:visible')).toHaveCount(0);
  });
});

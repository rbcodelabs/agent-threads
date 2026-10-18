import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { settleView } from './helpers';

/**
 * Remote thread header strip: host badge, folder on the daemon, connection pill.
 * Every pill state the plugin can show is captured, clipped to the strip so the
 * baselines stay small and independent of the rest of the conversation.
 */
const harnessUrl = 'file://' + path.resolve('test/harness/index.html');
const THREAD = 'thread-fix-auth';

async function open(page: Page, width = 420): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  await page.setViewportSize({ width, height: 700 });
  await page.goto(harnessUrl);
  await page.waitForSelector('.ct-title-row');
  await page.waitForSelector('.ct-messages');
  await page.waitForTimeout(400);
  await page.evaluate((id) => (window as any).__markRemote(id), THREAD);
  await page.evaluate((id) => (window as any).__view.focusThread(id), THREAD);
  await page.waitForTimeout(200);
}

const strip = (page: Page) => page.locator('.ct-remote-strip');

const STATES = [
  ['connected', { status: 'connected', attempt: 0 }, 'Connected'],
  ['reconnecting', { status: 'reconnecting', attempt: 2, detail: 'connection closed (1006)' }, 'Reconnecting'],
  ['unreachable', { status: 'unreachable', attempt: 5, detail: 'connect ETIMEDOUT' }, 'Daemon unreachable'],
  ['protocol', { status: 'incompatible', attempt: 0, detail: 'this plugin (0.62.2) is older than the daemon requires (0.70.0); update the plugin' }, 'Protocol too old'],
] as const;

test.describe('remote thread strip', () => {
  for (const [name, state, label] of STATES) {
    test(`remote strip: ${name}`, async ({ page }) => {
      await open(page);
      await page.evaluate((s) => (window as any).__setRemoteState(s), state);
      await expect(strip(page)).toBeVisible();
      await expect(strip(page).locator('.ct-remote-badge-name')).toHaveText('my-server');
      await expect(strip(page).locator('.ct-remote-pill')).toHaveText(label);
      await settleView(page);
      await expect(strip(page)).toHaveScreenshot(`remote-strip-${name}.png`);
    });
  }

  test('a local thread shows no strip', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(400);
    await expect(strip(page)).toBeHidden();
  });

  test('remote strip stays on one readable row group in a narrow panel', async ({ page }) => {
    await open(page, 320);
    await page.evaluate((s) => (window as any).__setRemoteState(s), STATES[2][1]);
    const box = await strip(page).boundingBox();
    expect(box!.width).toBeLessThanOrEqual(320);
    // The pill must never be clipped by the folder text.
    const pill = await strip(page).locator('.ct-remote-pill').boundingBox();
    expect(pill!.x + pill!.width).toBeLessThanOrEqual(320);
    await expect(strip(page)).toHaveScreenshot('remote-strip-narrow-unreachable.png');
  });
});

test.describe('Run on a daemon: folders come from the daemon', () => {
  const dashboardUrl = 'file://' + path.resolve('test/harness/kanban.html') + '?dashboard=1&remote=1';

  async function openRunOn(page: Page, daemon: string, ready = '.ct-run-on-folder-select'): Promise<void> {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.setViewportSize({ width: 420, height: 760 });
    await page.goto(dashboardUrl);
    await page.waitForSelector('.ct-agents-dispatch-btn');
    await page.locator('.ct-agents-dispatch-btn').dispatchEvent('contextmenu');
    await page.locator(`.ct-run-on-item[data-run-on="${daemon}"]`).click();
    await page.waitForSelector(ready);
  }

  test('a vault thread preselects the mapped folder from the daemon\'s own list, with no typing', async ({ page }) => {
    await openRunOn(page, 'my-server');
    const select = page.locator('.ct-run-on-folder-select');
    await expect(select).toHaveValue('/home/user/vault/Products/Agent Threads');
    await expect(select.locator('option')).toHaveText([
      'projects - /home/user/projects',
      'vault (vault) - /home/user/vault',
      '/home/user/vault/Products/Agent Threads',
      'Other folder…',
    ]);
    await expect(page.locator('.ct-run-on-folder-input')).toHaveCount(0);
    await expect(page.locator('[data-testid="run-on-folder-hint"]')).toBeVisible();
    await settleView(page);
    await expect(page.locator('.ct-harness-menu')).toHaveScreenshot('run-on-vault-folder.png');
  });

  test('Browse starts at the chosen folder, goes up inside the workspace, and Use this folder selects one', async ({ page }) => {
    await openRunOn(page, 'my-server');
    await page.locator('.ct-run-on-browse-btn').click();
    await expect(page.locator('.ct-run-on-browser-path')).toHaveText('/home/user/vault/Products/Agent Threads');
    await page.locator('.ct-run-on-browse-up').click();
    await expect(page.locator('.ct-run-on-browse-item')).toHaveText(['Agent Threads', 'Other Product']);
    await settleView(page);
    await expect(page.locator('.ct-harness-menu')).toHaveScreenshot('run-on-browse.png');
    await page.locator('.ct-run-on-browse-item[data-path="/home/user/vault/Products/Other Product"]').click();
    await expect(page.locator('.ct-run-on-browse-item')).toHaveText(['Notes', 'Specs']);
    await page.locator('.ct-run-on-browse-use').click();
    await expect(page.locator('.ct-run-on-folder-select')).toHaveValue('/home/user/vault/Products/Other Product');
  });

  test('a daemon too old to list folders keeps the text field with its default folder and says why', async ({ page }) => {
    await openRunOn(page, 'plain-box', '.ct-run-on-folder-input');
    await expect(page.locator('.ct-run-on-folder-input')).toHaveValue('/srv/workspaces');
    await expect(page.locator('[data-testid="run-on-folder-note"]')).toContainText('too old');
    await expect(page.locator('[data-testid="run-on-folder-hint"]')).toBeHidden();
  });
});

test.describe('Remote daemon dialog: folders are chosen from what the daemon advertises', () => {
  async function openModal(page: Page, opts: Record<string, unknown>): Promise<void> {
    await page.setViewportSize({ width: 760, height: 1400 });
    await page.goto('file://' + path.resolve('test/harness/settings.html'));
    await page.waitForSelector('.vertical-tab-content');
    await page.evaluate((o) => (window as any).__openRemoteDaemonModal(o), opts);
    await page.waitForSelector('.modal-container');
  }

  test('after Test connection the only vault is selected for you; the raw paths are under Advanced', async ({ page }) => {
    await openModal(page, {});
    const modal = page.locator('.modal-container');
    await expect(modal.locator('.ct-remote-folders-hint')).toContainText('Test the connection');
    await expect(modal.locator('details.ct-remote-advanced')).not.toHaveAttribute('open', '');
    await modal.getByRole('button', { name: 'Test connection' }).click();
    const vault = modal.getByLabel('Vault folder on this daemon');
    await expect(vault).toHaveValue('/home/user/vault');
    await expect(modal.getByLabel('Default folder')).toHaveValue('/home/user/projects');
    await expect(modal.getByText('Chosen for you: the only vault on my-server.')).toBeVisible();
    await settleView(page);
    await expect(modal).toHaveScreenshot('remote-daemon-dialog-autodetect.png');
    // The raw field mirrors the dropdown, under Advanced.
    await modal.locator('summary', { hasText: 'Advanced' }).click();
    await expect(modal.locator('input[placeholder="/home/user/vault"]')).toHaveValue('/home/user/vault');
  });

  test('a saved choice is kept, not replaced by discovery', async ({ page }) => {
    await openModal(page, { saved: true });
    const modal = page.locator('.modal-container');
    await modal.getByRole('button', { name: 'Test connection' }).click();
    await expect(modal.getByLabel('Vault folder on this daemon')).toHaveValue('/home/user/vault');
    await expect(modal.getByLabel('Default folder')).toHaveValue('/home/user/projects');
  });

  test('plain ws:// to a host outside the tailnet warns that the token is sent in the clear', async ({ page }) => {
    await openModal(page, { url: 'ws://files.example.org:7433' });
    const modal = page.locator('.modal-container');
    await expect(modal.locator('.ct-remote-cleartext-warning')).toContainText('plain ws://');
    // No baseline image yet: it must be rendered on the Linux renderer (npm run test:screenshots:remote:update),
    // and a Mac render must not be committed. The DOM assertions above and below cover the behaviour meanwhile.
    // Switching to a TLS address clears it.
    const address = modal.locator('input[placeholder="wss://my-server.tailnet-name.ts.net:8443"]');
    await address.fill('wss://files.example.org:8443');
    await expect(modal.locator('.ct-remote-cleartext-warning')).toBeEmpty();
  });

  test('no warning for wss:// or for a tailnet / loopback ws:// address', async ({ page }) => {
    await openModal(page, {});
    const modal = page.locator('.modal-container');
    const address = modal.locator('input[placeholder="wss://my-server.tailnet-name.ts.net:8443"]');
    for (const ok of ['wss://my-server.tailnet-name.ts.net:8443', 'ws://100.101.102.103:7598', 'ws://my-server.tailnet-name.ts.net:7598', 'ws://127.0.0.1:7433', 'ws://localhost:7433']) {
      await address.fill(ok);
      await expect(modal.locator('.ct-remote-cleartext-warning'), ok).toBeEmpty();
    }
  });

  test('a daemon too old to advertise folders opens Advanced with the raw fields', async ({ page }) => {
    await openModal(page, { advertise: 'old' });
    const modal = page.locator('.modal-container');
    await modal.getByRole('button', { name: 'Test connection' }).click();
    await expect(modal.locator('.ct-remote-folders-hint')).toContainText('too old to list its folders');
    await expect(modal.locator('details.ct-remote-advanced')).toHaveAttribute('open', '');
    await expect(modal.getByLabel('Vault folder on this daemon')).toHaveCount(0);
    await expect(modal.locator('input[placeholder="/home/user/vault"]')).toBeVisible();
  });
});

test.describe('Run on: set up the local daemon from the picker', () => {
  const offerUrl = 'file://' + path.resolve('test/harness/kanban.html') + '?dashboard=1&daemonoffer=1';

  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`offers "This Mac (container) - set up" before the daemon exists, and opens its settings at ${viewport.width}`, async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.setViewportSize(viewport);
    await page.goto(offerUrl);
    await page.waitForSelector('.ct-agents-dispatch-btn');
    await page.locator('.ct-agents-dispatch-btn').dispatchEvent('contextmenu');
    const item = page.locator('.ct-run-on-item[data-run-on="setup-local"]');
    await expect(item).toBeVisible();
    await expect(item).toContainText('This Mac (container)');
    await settleView(page);
    await expect(page.locator('.ct-harness-menu')).toHaveScreenshot(`run-on-setup-local-offer-${viewport.width}.png`);
    await item.click();
    expect(await page.evaluate(() => (window as any).__localDaemonSettingsOpened)).toBe(true);
    await expect(page.locator('.ct-harness-menu')).toHaveCount(0);
  });
  }

  test('shows no Run on section when the daemon is not offered', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 760 });
    await page.goto('file://' + path.resolve('test/harness/kanban.html') + '?dashboard=1');
    await page.waitForSelector('.ct-agents-dispatch-btn');
    await page.locator('.ct-agents-dispatch-btn').dispatchEvent('contextmenu');
    await expect(page.locator('.ct-run-on-item')).toHaveCount(0);
  });
});

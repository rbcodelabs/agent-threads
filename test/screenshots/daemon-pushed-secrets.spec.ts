import { expect, test, type Page } from '@playwright/test';
import path from 'path';
import { settleView } from './helpers';

/**
 * Daemon editor: "Secrets to send to this daemon" (RemoteDaemonConfig.pushedSecrets, parser in src/remote/daemonConfig.ts).
 * Functional checks drive the real modal; the two viewport screenshots are written to test-results/ for visual QA (not baselines).
 */
const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
const FIELD = 'Secrets to send to this daemon';
// Deliberately secret-looking: asserts the error never echoes the entry.
const SECRET_VALUE = 'ghp_ABCDEF0123456789zzzzSECRETVALUE';

async function openModal(page: Page, opts: Record<string, unknown> = {}, viewport = { width: 760, height: 1700 }) {
  await page.setViewportSize(viewport);
  await page.goto(settingsUrl);
  await page.waitForSelector('.vertical-tab-content');
  await page.evaluate((o) => { (window as any).__savedDaemon = undefined; (window as any).__openRemoteDaemonModal(o); }, opts);
  await page.waitForSelector('.modal-container');
  await page.locator('summary', { hasText: 'Advanced' }).click();
}
const save = (page: Page) => page.locator('.modal-container').getByRole('button', { name: /save/i }).evaluate((b: HTMLElement) => b.click());
const savedDaemon = (page: Page) => page.evaluate(() => (window as any).__savedDaemon);
const status = (page: Page) => page.locator('.modal-container .ct-remote-daemon-test.mod-warning');

test.describe('Daemon editor: secrets to send', () => {
  test('NAME and project/NAME lines save as pushedSecrets, trimmed and de-duplicated', async ({ page }) => {
    await openModal(page);
    await page.getByLabel(FIELD).fill('GH_TOKEN\n  proj-1/NPM_TOKEN  \nGH_TOKEN, OTHER_KEY');
    await save(page);
    expect((await savedDaemon(page)).pushedSecrets).toEqual(['GH_TOKEN', 'proj-1/NPM_TOKEN', 'OTHER_KEY']);
  });

  for (const bad of [`GH_TOKEN=${SECRET_VALUE}`, SECRET_VALUE + ' extra words', 'has space', '1STARTS_WITH_DIGIT', 'a/b/c']) {
    test(`rejects ${JSON.stringify(bad.length > 12 ? bad.slice(0, 8) + '...' : bad)} without echoing it and without saving`, async ({ page }) => {
      await openModal(page);
      await page.getByLabel(FIELD).fill(`GOOD_NAME\n${bad}`);
      await save(page);
      await expect(status(page)).toContainText('entry 2');
      await expect(status(page)).toContainText('never the secret itself');
      const text = (await page.locator('.modal-container').innerText());
      expect(text).not.toContain(SECRET_VALUE);
      expect(text).not.toContain('ghp_');
      // Error text itself must not contain the bad entry (the textarea legitimately still holds it).
      expect(await status(page).innerText()).not.toContain(bad.split('\n')[0].slice(0, 6) === 'GH_TOK' ? 'GH_TOKEN=' : bad);
      expect(await savedDaemon(page)).toBeUndefined();
      await expect(page.locator('.modal-container')).toBeVisible();
    });
  }

  test('an empty (or whitespace-only) box saves no pushedSecrets key at all', async ({ page }) => {
    await openModal(page);
    await save(page);
    expect(await savedDaemon(page)).not.toHaveProperty('pushedSecrets');
    await openModal(page);
    await page.getByLabel(FIELD).fill('  \n , \n');
    await save(page);
    expect(await savedDaemon(page)).not.toHaveProperty('pushedSecrets');
  });

  test('clearing a previously saved list removes the key', async ({ page }) => {
    await openModal(page, { pushedSecrets: ['GH_TOKEN'] });
    await expect(page.getByLabel(FIELD)).toHaveValue('GH_TOKEN');
    await page.getByLabel(FIELD).fill('');
    await save(page);
    expect(await savedDaemon(page)).not.toHaveProperty('pushedSecrets');
  });

  test('a legacy config without the field loads with an empty box and saves with no new keys', async ({ page }) => {
    await openModal(page, { saved: true });
    await expect(page.getByLabel(FIELD)).toHaveValue('');
    await save(page);
    const cfg = await savedDaemon(page);
    expect(cfg).not.toHaveProperty('pushedSecrets');
    expect(cfg).toEqual({
      id: 'my-server', name: 'my-server', url: 'wss://my-server.tailnet-name.ts.net:8443', tokenSecretName: 'T',
      defaultCwdRoot: '/home/user/projects', vaultMapping: { remoteRoot: '/home/user/vault' },
    });
  });

  test('an existing list round-trips unchanged', async ({ page }) => {
    await openModal(page, { pushedSecrets: ['GH_TOKEN', 'proj/NPM_TOKEN'] });
    await save(page);
    expect((await savedDaemon(page)).pushedSecrets).toEqual(['GH_TOKEN', 'proj/NPM_TOKEN']);
  });

  for (const [label, viewport, file] of [
    ['desktop', { width: 1280, height: 800 }, 'daemon-pushed-secrets-desktop-1280x800.png'],
    ['mobile', { width: 390, height: 844 }, 'daemon-pushed-secrets-mobile-390x844.png'],
  ] as const) {
    test(`${label}: field is fully visible inside the modal and does not overlap its neighbours`, async ({ page }) => {
      await openModal(page, { pushedSecrets: ['GH_TOKEN', 'proj/NPM_TOKEN'] }, viewport);
      const field = page.getByLabel(FIELD);
      await field.scrollIntoViewIfNeeded();
      await settleView(page);
      const box = (await field.boundingBox())!;
      const modal = (await page.locator('.modal-container').boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(modal.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(modal.x + modal.width + 1);
      expect(box.width).toBeGreaterThan(120);
      const adminBox = (await page.getByLabel('Admin token for sending secrets').boundingBox())!;
      const overlaps = box.y < adminBox.y + adminBox.height && adminBox.y < box.y + box.height && box.x < adminBox.x + adminBox.width && adminBox.x < box.x + box.width;
      expect(overlaps, 'secrets textarea overlaps admin token input').toBe(false);
      await page.screenshot({ path: `test-results/${file}` });
      await page.locator('.modal-container').screenshot({ path: `test-results/modal-${file}` });
    });
  }
});

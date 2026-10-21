import { expect, test, type Page } from '@playwright/test';
import path from 'path';
import { settleView } from './helpers';

/**
 * Daemon editor: "Secrets to send to this daemon" checklist (RemoteDaemonConfig.pushedSecrets; logic in src/remote/pushedSecretPicker.ts).
 * Functional checks drive the real modal; the two viewport screenshots are written to test-results/ for visual QA (not baselines).
 */
const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
const FIELD = 'Secrets to send to this daemon';
// Deliberately secret-looking: asserts the Add-by-name error never echoes the entry.
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

const box = (page: Page, name: string) => page.getByRole('checkbox', { name, exact: true });
// The harness modal scrolls inside a short viewport; a DOM click toggles the box without needing it on screen.
const setChecked = (page: Page, name: string, on: boolean) =>
  box(page, name).evaluate((b: HTMLInputElement, v) => { if (b.checked !== v) { b.checked = v; b.dispatchEvent(new Event('change')); } }, on);
const addInput = (page: Page) => page.getByLabel('Add a secret by name');
const add = (page: Page) => page.locator('.modal-container').getByRole('button', { name: 'Add', exact: true }).evaluate((b: HTMLElement) => b.click());

test.describe('Daemon editor: secrets to send', () => {
  test('lists forwardable names only (no PATH), project-scoped as project/NAME, all unticked by default', async ({ page }) => {
    await openModal(page);
    for (const n of ['GH_TOKEN', 'LINEAR_API_KEY', 'OTHER_KEY', 'proj/NPM_TOKEN']) {
      await expect(box(page, n)).toBeVisible();
      await expect(box(page, n)).not.toBeChecked();
    }
    await expect(box(page, 'PATH')).toHaveCount(0);
    await expect(box(page, 'NPM_TOKEN')).toHaveCount(0);
  });

  test('ticked names save as pushedSecrets in list order', async ({ page }) => {
    await openModal(page);
    await setChecked(page, 'proj/NPM_TOKEN', true);
    await setChecked(page, 'GH_TOKEN', true);
    await save(page);
    expect((await savedDaemon(page)).pushedSecrets).toEqual(['GH_TOKEN', 'proj/NPM_TOKEN']);
  });

  test('a saved name nothing provides stays, ticked and flagged not found, and can be unticked', async ({ page }) => {
    await openModal(page, { pushedSecrets: ['GH_TOKEN', 'GONE_KEY'] });
    await expect(box(page, 'GH_TOKEN')).toBeChecked();
    await expect(box(page, 'GONE_KEY')).toBeChecked();
    await expect(page.locator('.ct-pushed-secrets')).toContainText('Not found');
    await save(page);
    expect((await savedDaemon(page)).pushedSecrets).toEqual(['GH_TOKEN', 'GONE_KEY']);
    await openModal(page, { pushedSecrets: ['GH_TOKEN', 'GONE_KEY'] });
    await setChecked(page, 'GONE_KEY', false);
    await save(page);
    expect((await savedDaemon(page)).pushedSecrets).toEqual(['GH_TOKEN']);
  });

  test('Add by name appends a ticked row and saves it', async ({ page }) => {
    await openModal(page);
    await addInput(page).fill('  proj-1/NEW_TOKEN ');
    await add(page);
    await expect(box(page, 'proj-1/NEW_TOKEN')).toBeChecked();
    await expect(addInput(page)).toHaveValue('');
    await save(page);
    expect((await savedDaemon(page)).pushedSecrets).toEqual(['proj-1/NEW_TOKEN']);
  });

  for (const bad of [`GH_TOKEN=${SECRET_VALUE}`, SECRET_VALUE + ' extra words', 'has space', '1STARTS_WITH_DIGIT', 'a/b/c']) {
    test(`Add by name rejects ${JSON.stringify(bad.length > 12 ? bad.slice(0, 8) + '...' : bad)} without echoing it`, async ({ page }) => {
      await openModal(page);
      await addInput(page).fill(bad);
      await add(page);
      const msg = page.locator('.ct-pushed-secrets [role=status]');
      await expect(msg).toContainText('never the secret itself');
      expect(await msg.innerText()).not.toContain('ghp_');
      expect(await page.locator('.ct-pushed-secrets').innerText()).not.toContain(SECRET_VALUE);
      await save(page);
      expect(await savedDaemon(page)).not.toHaveProperty('pushedSecrets');
    });
  }

  test('nothing ticked saves no pushedSecrets key; unticking everything removes a saved list', async ({ page }) => {
    await openModal(page);
    await save(page);
    expect(await savedDaemon(page)).not.toHaveProperty('pushedSecrets');
    await openModal(page, { pushedSecrets: ['GH_TOKEN'] });
    await setChecked(page, 'GH_TOKEN', false);
    await save(page);
    expect(await savedDaemon(page)).not.toHaveProperty('pushedSecrets');
  });

  test('a legacy config without the field loads with nothing ticked and saves with no new keys', async ({ page }) => {
    await openModal(page, { saved: true });
    await expect(page.getByRole('checkbox', { name: 'GH_TOKEN', exact: true })).not.toBeChecked();
    await save(page);
    const cfg = await savedDaemon(page);
    expect(cfg).toEqual({
      id: 'my-server', name: 'my-server', url: 'wss://my-server.tailnet-name.ts.net:8443', tokenSecretName: 'T',
      defaultCwdRoot: '/home/user/projects', vaultMapping: { remoteRoot: '/home/user/vault' },
    });
  });

  for (const [label, viewport, file] of [
    ['desktop', { width: 1280, height: 800 }, 'daemon-pushed-secrets-desktop-1280x800.png'],
    ['mobile', { width: 390, height: 844 }, 'daemon-pushed-secrets-mobile-390x844.png'],
  ] as const) {
    test(`${label}: checklist stays inside the modal and does not overlap the admin token field`, async ({ page }) => {
      await openModal(page, { pushedSecrets: ['GH_TOKEN', 'GONE_KEY'] }, viewport);
      const list = page.getByRole('group', { name: FIELD });
      await list.scrollIntoViewIfNeeded();
      await settleView(page);
      const b = (await list.boundingBox())!;
      const modal = (await page.locator('.modal-container').boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(modal.x - 1);
      expect(b.x + b.width).toBeLessThanOrEqual(modal.x + modal.width + 1);
      const adminBox = (await page.getByLabel('Admin token for sending secrets').boundingBox())!;
      const overlaps = b.y < adminBox.y + adminBox.height && adminBox.y < b.y + b.height && b.x < adminBox.x + adminBox.width && adminBox.x < b.x + b.width;
      expect(overlaps, 'secrets checklist overlaps admin token input').toBe(false);
      await page.screenshot({ path: `test-results/${file}` });
      await page.locator('.modal-container').screenshot({ path: `test-results/modal-${file}` });
    });
  }
});

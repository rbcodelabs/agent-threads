import { expect, test, type Page } from '@playwright/test';
import path from 'path';

/**
 * Functional (non-pixel) spec for the Project "Overview note" setting.
 * Asserts behaviour through the real SettingsTab against the settings harness:
 * the field renders, edits mark the form dirty, Save persists overviewPath,
 * blank restores the default (undefined), and New project passes it through.
 * No toHaveScreenshot here, so there are no baselines to maintain.
 */
const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');

async function openProjects(page: Page) {
  await page.goto(settingsUrl);
  await page.waitForSelector('.ct-settings-shell');
  await page.getByLabel('Settings section').selectOption('projects');
  await expect(page.getByLabel('Project name')).toBeVisible();
}

const overviewOf = (page: Page, index: number) =>
  page.evaluate((i) => (window as any).__settings.projects[i].overviewPath as string | undefined, index);

test.describe('Project overview note setting', () => {
  test('renders an Overview note input with default placeholder and help text', async ({ page }) => {
    await openProjects(page);
    const input = page.getByLabel('Overview note');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('');
    await expect(input).toHaveAttribute('placeholder', 'Defaults to <vault folder>/_overview.md');
    await expect(page.locator('.ct-manager-field', { hasText: 'Overview note' }).locator('small'))
      .toContainText('injected into the system prompt');
  });

  test('persists a custom overview path on Save and marks the form dirty on edit', async ({ page }) => {
    await openProjects(page);
    await expect(page.getByText('No unsaved changes')).toBeVisible();
    await page.getByLabel('Overview note').fill('  Work/Acme/Docs/overview.md  ');
    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => overviewOf(page, 0)).toBe('Work/Acme/Docs/overview.md');
    // The re-rendered form shows the saved (trimmed) value.
    await expect(page.getByLabel('Overview note')).toHaveValue('Work/Acme/Docs/overview.md');
  });

  test('clearing the field on Save restores the default (overviewPath undefined)', async ({ page }) => {
    await openProjects(page);
    await page.getByLabel('Overview note').fill('Custom/note.md');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => overviewOf(page, 0)).toBe('Custom/note.md');
    await page.getByLabel('Overview note').fill('   ');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => overviewOf(page, 0)).toBeUndefined();
    await expect(page.getByLabel('Overview note')).toHaveValue('');
  });

  test('New project form passes the overview path through to createProject', async ({ page }) => {
    await openProjects(page);
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Project name').fill('Overview QA');
    await page.getByLabel('Vault folder').fill('QA/Overview');
    await page.getByLabel('Overview note').fill('QA/Overview/grounding.md');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect.poll(() => page.evaluate(() => {
      const projects = (window as any).__settings.projects as Array<{ name: string; overviewPath?: string }>;
      return projects.find((p) => p.name === 'Overview QA')?.overviewPath;
    })).toBe('QA/Overview/grounding.md');
  });

  test('a narrow 390px viewport keeps the field reachable without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openProjects(page);
    const input = page.getByLabel('Overview note');
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeVisible();
    const box = await input.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});

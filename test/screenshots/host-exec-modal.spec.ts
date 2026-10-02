import { expect, test } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');

test.describe('HostExecModal', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(settingsUrl);
    await page.evaluate(() => (window as any).__openHostExecApproval());
    await expect(page.locator('.ct-mcp-registration')).toBeVisible();
  });

  test('shows the exact host request and records one-call approval', async ({ page }) => {
    const modal = page.locator('.modal-container');
    await expect(modal).toContainText('Run command on your computer?');
    await expect(modal).toContainText('pnpm test -- --run test/unit/hostExec.test.ts');
    await expect(modal).toContainText('/Users/example/projects/agent-threads');
    await expect(modal).toContainText('Verify the host execution safety checks');
    await expect(modal).toContainText('Times out after 120s');

    for (const name of ['Deny', 'Allow once']) {
      const button = page.getByRole('button', { name, exact: true });
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }

    await shot(page, 'host-exec-modal.png');
    await page.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(modal).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__hostExecApprovalResult)).toBe(true);
  });
});

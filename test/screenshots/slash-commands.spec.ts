import { test, expect } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

// Visual baseline for the slash-command pill; functional completion tests live
// in test/browser/slash-commands.spec.ts.

test('completed builtin command becomes a pill', async ({ page }) => {
  await page.goto(harnessUrl);
  await page.waitForSelector('.ct-input');
  await page.click('.ct-input');
  await page.type('.ct-input', '/goal ');
  const pill = page.locator('.ct-command-pill');
  await pill.waitFor({ state: 'visible' });
  await expect(pill).toContainText('/goal');
  await expect(page.locator('.ct-input')).toHaveValue('');
  await page.type('.ct-input', 'ship the release');
  await shot(page, 'command-pill.png');
});

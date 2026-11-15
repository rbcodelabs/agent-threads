import { test, expect } from '@playwright/test';
import path from 'path';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

// Functional regression tests for the slash-command dropdown (no screenshots):
// built-in command completion, the /goal and /loop commands, and argument
// completion for /model. Visual baseline lives in test/screenshots/slash-commands.spec.ts.

test('builtin /model command completes', async ({ page }) => {
  await page.goto(harnessUrl);
  await page.waitForSelector('.ct-input');
  await page.click('.ct-input');
  await page.type('.ct-input', '/model');
  const dropdown = page.locator('.ct-skill-dropdown');
  await dropdown.waitFor({ state: 'visible' });
  await expect(dropdown).toContainText('model');
});

test('builtin /goal and /loop appear in the command list', async ({ page }) => {
  await page.goto(harnessUrl);
  await page.waitForSelector('.ct-input');
  await page.click('.ct-input');
  await page.type('.ct-input', '/');
  const dropdown = page.locator('.ct-skill-dropdown');
  await dropdown.waitFor({ state: 'visible' });
  await expect(dropdown).toContainText('goal');
  await expect(dropdown).toContainText('loop');
});

test('/model argument completion offers model aliases', async ({ page }) => {
  await page.goto(harnessUrl);
  await page.waitForSelector('.ct-input');
  await page.click('.ct-input');
  await page.type('.ct-input', '/model ');
  const dropdown = page.locator('.ct-skill-dropdown');
  await dropdown.waitFor({ state: 'visible' });
  await expect(dropdown).toContainText('fable');
  await expect(dropdown).toContainText('opus');
  await expect(dropdown).toContainText('sonnet');
  await expect(dropdown).toContainText('haiku');
  await expect(dropdown).toContainText('default');
});

test('/model argument completion filters and inserts on Tab', async ({ page }) => {
  await page.goto(harnessUrl);
  await page.waitForSelector('.ct-input');
  await page.click('.ct-input');
  // '/model ' becomes a pill; the argument is typed after it
  await page.type('.ct-input', '/model fa');
  const dropdown = page.locator('.ct-skill-dropdown');
  await dropdown.waitFor({ state: 'visible' });
  await expect(dropdown).toContainText('fable');
  await expect(dropdown).not.toContainText('opus');
  await page.keyboard.press('Tab');
  await expect(page.locator('.ct-command-pill')).toContainText('/model');
  await expect(page.locator('.ct-input')).toHaveValue('fable ');
});

test('argument completion hides for free-text arguments', async ({ page }) => {
  await page.goto(harnessUrl);
  await page.waitForSelector('.ct-input');
  await page.click('.ct-input');
  await page.type('.ct-input', '/goal finish the rep');
  await expect(page.locator('.ct-skill-dropdown')).toHaveCount(0);
});

test('selecting a builtin from the dropdown creates a pill', async ({ page }) => {
  await page.goto(harnessUrl);
  await page.waitForSelector('.ct-input');
  await page.click('.ct-input');
  await page.type('.ct-input', '/goa');
  await page.locator('.ct-skill-dropdown').waitFor({ state: 'visible' });
  await page.keyboard.press('Tab');
  await expect(page.locator('.ct-command-pill')).toContainText('/goal');
  await expect(page.locator('.ct-input')).toHaveValue('');
});

test('backspace at input start removes the pill', async ({ page }) => {
  await page.goto(harnessUrl);
  await page.waitForSelector('.ct-input');
  await page.click('.ct-input');
  await page.type('.ct-input', '/goal finish it');
  await expect(page.locator('.ct-command-pill')).toBeVisible();
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  await expect(page.locator('.ct-command-pill')).toHaveCount(0);
  // The typed argument text survives pill removal
  await expect(page.locator('.ct-input')).toHaveValue('finish it');
});

test('pill removal via the × button', async ({ page }) => {
  await page.goto(harnessUrl);
  await page.waitForSelector('.ct-input');
  await page.click('.ct-input');
  await page.type('.ct-input', '/loop ');
  await expect(page.locator('.ct-command-pill')).toBeVisible();
  await page.locator('.ct-command-pill-x').dispatchEvent('mousedown');
  await expect(page.locator('.ct-command-pill')).toHaveCount(0);
});

test('arg completion still works with an active pill', async ({ page }) => {
  await page.goto(harnessUrl);
  await page.waitForSelector('.ct-input');
  await page.click('.ct-input');
  await page.type('.ct-input', '/model ');
  await expect(page.locator('.ct-command-pill')).toContainText('/model');
  const dropdown = page.locator('.ct-skill-dropdown');
  await dropdown.waitFor({ state: 'visible' });
  await expect(dropdown).toContainText('fable');
  await page.type('.ct-input', 'fa');
  await page.keyboard.press('Tab');
  await expect(page.locator('.ct-input')).toHaveValue('fable ');
});

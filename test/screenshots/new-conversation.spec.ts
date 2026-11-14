import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

/**
 * Visual baselines for new-conversation mode, the searchable Project picker,
 * and the kickoff harness / settings popover. Behavioral interaction tests live
 * in test/browser/new-conversation.spec.ts.
 */
const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

const threadComposer = (page: Page) => page.locator('.ct-input-row:not(.ct-new-conv-row)');
const composer = (page: Page) => page.locator('.ct-new-conv-row');
const input = (page: Page) => composer(page).locator('textarea');
const chip = (page: Page) => composer(page).locator('.ct-footer-context');
const picker = (page: Page) => page.locator('.ct-project-picker');
const pickerLabels = (page: Page) => picker(page).locator('[role="option"] .ct-project-picker-row-name').allInnerTexts();

async function open(page: Page, query = '?projects=1', width = 520, height = 760): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  await page.setViewportSize({ width, height });
  await page.goto(harnessUrl + query);
  await page.waitForSelector('.ct-title-row');
  await page.waitForSelector('.ct-messages');
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'New thread' }).first().click();
  await expect(page.locator('[data-testid="new-conversation"]')).toBeVisible();
}

const threadCount = (page: Page) => page.evaluate(() => (window as any).__manager.getThreads().length as number);
const dispatchCalls = (page: Page) => page.evaluate(() => (window as any).__dispatchCalls as unknown[][]);

test.describe('new-conversation mode', () => {
  test('New thread swaps in the dispatch composer and creates no thread', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.setViewportSize({ width: 520, height: 760 });
    await page.goto(harnessUrl + '?projects=1');
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(400);
    const before = await threadCount(page);

    await page.getByRole('button', { name: 'New thread' }).first().click();

    await expect(page.locator('[data-testid="new-conversation"]')).toBeVisible();
    await expect(page.locator('.ct-title-text')).toHaveText('New conversation');
    await expect(page.locator('.ct-floating-panel')).toHaveClass(/ct-new-conversation/);
    await expect(threadComposer(page)).toBeHidden();
    await expect(composer(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
    await expect(chip(page).locator('.ct-footer-context-name')).toHaveText('No project');
    await expect(chip(page)).toBeVisible();
    expect(await threadCount(page)).toBe(before);
    expect(await page.evaluate(() => (window as any).__view.getActiveThreadId())).toBeNull();
    await shot(page, 'new-conversation-empty.png');
  });
});

test.describe('searchable Project picker', () => {
  test('opens with a focused filter and lists Projects most-recently-used first', async ({ page }) => {
    await open(page);
    await chip(page).click();
    await expect(picker(page)).toBeVisible();
    await expect(picker(page).getByRole('combobox', { name: 'Filter projects' })).toBeFocused();
    expect(await pickerLabels(page)).toEqual(['No Project', 'Golden Wealth', 'Agent Threads', 'Compass', 'HipTrip', 'Zebra Notes', 'New Project…']);
    await expect(picker(page).getByRole('button', { name: 'Sort by most recently used' })).toHaveAttribute('aria-pressed', 'true');
    await shot(page, 'new-conversation-project-picker.png');
  });

  test('typing filters the list; the first match is highlighted and Enter picks it', async ({ page }) => {
    await open(page);
    await chip(page).click();
    await page.keyboard.type('gol');
    expect(await pickerLabels(page)).toEqual(['Golden Wealth', 'New Project…']);
    await expect(picker(page).locator('.is-highlighted .ct-project-picker-row-name')).toHaveText('Golden Wealth');
    await shot(page, 'new-conversation-project-picker-filtered.png');
    await page.keyboard.press('Enter');
    await expect(picker(page)).toHaveCount(0);
    await expect(chip(page).locator('.ct-footer-context-name')).toHaveText('Golden Wealth');
    await expect(input(page)).toBeFocused();
  });

  test('arrow keys navigate and the sort toggle switches to alphabetical and persists', async ({ page }) => {
    await open(page);
    await chip(page).click();
    await page.keyboard.press('ArrowDown');
    await expect(picker(page).locator('.is-highlighted .ct-project-picker-row-name')).toHaveText('Golden Wealth');

    await picker(page).getByRole('button', { name: 'Sort alphabetically' }).click();
    expect(await pickerLabels(page)).toEqual(['No Project', 'Agent Threads', 'Compass', 'Golden Wealth', 'HipTrip', 'Zebra Notes', 'New Project…']);
    await expect(picker(page).getByRole('button', { name: 'Sort alphabetically' })).toHaveAttribute('aria-pressed', 'true');
    await shot(page, 'new-conversation-project-picker-alphabetical.png');

    await page.keyboard.press('Escape');
    await chip(page).click();
    await expect(picker(page).getByRole('button', { name: 'Sort alphabetically' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('fits a 320px pane', async ({ page }) => {
    await open(page, '?projects=1', 320, 640);
    await chip(page).click();
    const box = await picker(page).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    expect(await picker(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await shot(page, 'new-conversation-project-picker-narrow.png');
  });
});

test.describe('kickoff harness picker (moved from the Kanban dispatch box)', () => {
  const sendBtn = (page: Page) => composer(page).locator('.ct-settings-indicator');
  const popover = (page: Page) => page.locator('.ct-settings-popover');
  const drill = (page: Page, id: string) => page.locator(`[data-ct-key="row:${id}"]`).click();

  test('root lists Model, Permissions and Harness; selecting OpenCode shows its mark and does not dispatch', async ({ page }) => {
    await open(page, '?projects=1', 900, 760);
    await sendBtn(page).click();
    await expect(popover(page).locator('.ct-sp-row .ct-sp-label')).toHaveText(['Model', 'Permissions', 'Harness']);
    await expect(page.locator('[data-ct-key="row:harness"] .ct-sp-value')).toHaveText('Claude');
    await shot(popover(page), 'new-conversation-settings-popover-root.png');
    await drill(page, 'harness');
    await expect(popover(page).locator('.ct-sp-back')).toContainText('Harness');
    await expect(popover(page).getByRole('menuitemradio', { name: 'OpenCode' }).locator('.ct-sp-icon[data-icon="opencode-mark"] svg')).toHaveCount(1);
    await shot(popover(page), 'new-conversation-settings-popover-harness.png');
    await popover(page).getByRole('menuitemradio', { name: 'OpenCode' }).click();
    await expect(popover(page)).toHaveCount(0);
    await expect(sendBtn(page)).toHaveAttribute('aria-label', /OpenCode/);
    await expect(sendBtn(page).locator('.ct-si-provider')).toHaveAttribute('data-glyph', 'opencode');
    await expect(composer(page).locator('.ct-send-btn')).toHaveText('↵');
    expect((await dispatchCalls(page)).length).toBe(0);
    await shot(composer(page), 'new-conversation-harness-picker-opencode.png');
  });
});

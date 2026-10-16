import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

/**
 * New-conversation mode: the dispatch composer that used to sit in the Agents List and the
 * Kanban board now lives in the message panel. "New thread" swaps the thread composer for it;
 * the thread is only created by the first send. Includes the searchable Project picker
 * (filter + most-recent / alphabetical sort) and the kickoff harness / Run in picker that
 * moved with the composer.
 */
const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

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
    await expect(page.locator('.ct-input-row')).toBeHidden();
    await expect(composer(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
    await expect(chip(page).locator('.ct-footer-context-name')).toHaveText('No project');
    // The Project chip is visible at rest (the thread footer is hover-only).
    await expect(chip(page)).toBeVisible();
    expect(await threadCount(page)).toBe(before);
    expect(await page.evaluate(() => (window as any).__view.getActiveThreadId())).toBeNull();
    await shot(page, 'new-conversation-empty.png');
  });

  test('Back returns to the thread we came from', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: /Back to Fix auth middleware/ }).click();
    await expect(page.locator('.ct-title-text')).toContainText('Fix auth middleware');
    await expect(page.locator('.ct-floating-panel')).not.toHaveClass(/ct-new-conversation/);
    await expect(page.locator('.ct-input-row')).toBeVisible();
    await expect(composer(page)).toBeHidden();
  });

  test('picking another thread leaves the mode', async ({ page }) => {
    await open(page);
    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));
    await expect(page.locator('.ct-title-text')).toContainText('HipTrip feature');
    await expect(composer(page)).toBeHidden();
    await expect(page.locator('.ct-input-row')).toBeVisible();
  });

  test('offers the dispatch slash commands, not the thread-only ones', async ({ page }) => {
    await open(page);
    await input(page).click();
    await page.keyboard.type('/');
    const dropdown = page.locator('.ct-skill-dropdown');
    await dropdown.waitFor({ state: 'visible' });
    for (const name of ['model', 'goal', 'loop', 'design']) await expect(dropdown).toContainText(name);
    for (const name of ['compact', 'context', 'ephemeral']) await expect(dropdown).not.toContainText(name);
  });

  test('first send creates the thread with the chosen Project and switches to it', async ({ page }) => {
    await open(page);
    await chip(page).click();
    await picker(page).getByRole('option', { name: 'HipTrip' }).click();
    await expect(chip(page).locator('.ct-footer-context-name')).toHaveText('HipTrip');

    await input(page).fill('Plan the next HipTrip release');
    await input(page).press('Enter');

    await expect.poll(async () => (await dispatchCalls(page)).length).toBe(1);
    const [text, , title, opts] = (await dispatchCalls(page))[0] as [string, unknown, string, Record<string, unknown>];
    expect(text).toBe('Plan the next HipTrip release');
    expect(title).toBe('Plan the next HipTrip release');
    expect(opts).toMatchObject({ projectId: 'proj-hiptrip', agentHarness: 'claude' });
    await expect(page.locator('.ct-title-text')).toHaveText('Plan the next HipTrip release');
    await expect(page.locator('.ct-floating-panel')).not.toHaveClass(/ct-new-conversation/);
    await expect(composer(page)).toBeHidden();
  });

  test('a /model directive is applied to the new thread and not sent as text', async ({ page }) => {
    await open(page);
    await input(page).fill('/model opus fix the login bug');
    await input(page).press('Enter');
    await expect.poll(async () => (await dispatchCalls(page)).length).toBe(1);
    const [text, , , opts] = (await dispatchCalls(page))[0] as [string, unknown, string, Record<string, unknown>];
    expect(text).toBe('fix the login bug');
    expect(opts.model).toBeTruthy();
  });

  test('a malformed directive keeps the draft and creates nothing', async ({ page }) => {
    await open(page);
    const before = await threadCount(page);
    await input(page).fill('/goal');
    await input(page).press('Enter');
    await expect(input(page)).toHaveValue('/goal');
    expect(await threadCount(page)).toBe(before);
    expect((await dispatchCalls(page)).length).toBe(0);
    await expect(page.locator('[data-testid="new-conversation"]')).toBeVisible();
  });

  test('the Project chip follows rename and delete of the selected Project', async ({ page }) => {
    await open(page);
    await chip(page).click();
    await picker(page).getByRole('option', { name: 'HipTrip' }).click();
    await page.evaluate(() => (window as any).__manager.updateProject('proj-hiptrip', { name: 'HipTrip Studio' }));
    await expect(chip(page).locator('.ct-footer-context-name')).toHaveText('HipTrip Studio');
    await page.evaluate(() => (window as any).__manager.deleteProject('proj-hiptrip'));
    await expect(chip(page).locator('.ct-footer-context-name')).toHaveText('No project');
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

  test('a filter with no match says so and Escape closes without changing the Project', async ({ page }) => {
    await open(page);
    await chip(page).click();
    await page.keyboard.type('qqq');
    await expect(picker(page).locator('.ct-project-picker-empty')).toContainText('qqq');
    await page.keyboard.press('Escape');
    await expect(picker(page)).toHaveCount(0);
    await expect(chip(page).locator('.ct-footer-context-name')).toHaveText('No project');
    await expect(page.locator('[data-testid="new-conversation"]')).toBeVisible();
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

    // Reopening remembers the choice.
    await page.keyboard.press('Escape');
    await chip(page).click();
    await expect(picker(page).getByRole('button', { name: 'Sort alphabetically' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('the selected Project is checked when reopened', async ({ page }) => {
    await open(page);
    await chip(page).click();
    await picker(page).getByRole('option', { name: 'Compass' }).click();
    await chip(page).click();
    await expect(picker(page).getByRole('option', { name: 'Compass' })).toHaveAttribute('aria-selected', 'true');
    await expect(picker(page).getByRole('option', { name: 'No Project' })).toHaveAttribute('aria-selected', 'false');
  });

  test('a pick moves that Project to the top of the recent order', async ({ page }) => {
    await open(page);
    await chip(page).click();
    await picker(page).getByRole('option', { name: 'Zebra Notes' }).click();
    await chip(page).click();
    expect((await pickerLabels(page)).slice(0, 3)).toEqual(['No Project', 'Zebra Notes', 'Golden Wealth']);
  });

  test('New Project… asks the plugin to open the Projects settings', async ({ page }) => {
    await open(page);
    await chip(page).click();
    await picker(page).getByRole('option', { name: 'New Project…' }).click();
    expect(await page.evaluate(() => (window as any).__newProjectRequests.length)).toBe(1);
    await expect(picker(page)).toHaveCount(0);
  });

  test('clicking outside closes it', async ({ page }) => {
    await open(page);
    await chip(page).click();
    await expect(picker(page)).toBeVisible();
    await page.locator('.ct-messages').click({ position: { x: 10, y: 10 } });
    await expect(picker(page)).toHaveCount(0);
  });

  test('Change project… on an existing thread uses the same picker', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.setViewportSize({ width: 520, height: 760 });
    await page.goto(harnessUrl + '?projects=1');
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(400);
    await page.locator('.ct-input-row .ct-footer-context').dispatchEvent('click');
    await page.locator('.menu').getByText('Change project…').click();
    await expect(picker(page)).toBeVisible();
    expect(await pickerLabels(page)).toContain('Golden Wealth');
    await picker(page).getByRole('option', { name: 'Compass' }).click();
    await expect(page.locator('.ct-input-row .ct-footer-context-name')).toContainText('Compass');
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
  const sendBtn = (page: Page) => composer(page).locator('.ct-harness-send-btn');

  test('selects OpenCode with its brand mark, without dispatching', async ({ page }) => {
    await open(page, '?projects=1', 900, 760);
    await sendBtn(page).click({ button: 'right' });
    const menu = page.locator('.ct-harness-menu');
    await expect(menu.getByRole('menuitemradio', { name: 'OpenCode' }).locator('.ct-harness-mark-opencode svg')).toHaveCount(1);
    await menu.getByRole('menuitemradio', { name: 'OpenCode' }).click();
    await expect(menu).toHaveCount(0);
    await expect(sendBtn(page)).toHaveAttribute('aria-label', /OpenCode/);
    await expect(sendBtn(page).locator('.ct-harness-mark-opencode')).toHaveAttribute('data-icon', 'opencode-mark');
    expect((await dispatchCalls(page)).length).toBe(0);
    await shot(composer(page), 'new-conversation-harness-picker-opencode.png');
  });

  test('offers Run in (container/host) for Claude and badges the button', async ({ page }) => {
    await open(page, '?projects=1', 900, 760);
    await sendBtn(page).click({ button: 'right' });
    const menu = page.locator('.ct-harness-menu');
    await expect(menu.locator('.ct-run-mode-item')).toHaveCount(3);
    await shot(menu, 'new-conversation-run-mode-menu.png');
    await menu.locator('.ct-run-mode-item[data-run-mode="always"]').click();
    await expect(menu).toHaveCount(0);
    await expect(sendBtn(page)).toHaveAttribute('aria-label', /in a container/);
    await expect(sendBtn(page).locator('.ct-run-mode-badge')).toHaveCount(1);
    await shot(composer(page), 'new-conversation-run-mode-badge.png');

    await sendBtn(page).click({ button: 'right' });
    await menu.getByRole('menuitemradio', { name: 'Codex' }).click();
    await expect(sendBtn(page).locator('.ct-run-mode-badge')).toHaveCount(0);
    expect((await dispatchCalls(page)).length).toBe(0);
  });

  test('the chosen harness and run mode travel with the first send', async ({ page }) => {
    await open(page, '?projects=1', 900, 760);
    await sendBtn(page).click({ button: 'right' });
    await page.locator('.ct-harness-menu').getByRole('menuitemradio', { name: 'Codex' }).click();
    await input(page).fill('Review the diff');
    await input(page).press('Enter');
    await expect.poll(async () => (await dispatchCalls(page)).length).toBe(1);
    expect((await dispatchCalls(page))[0][3]).toMatchObject({ agentHarness: 'codex' });
  });

  test('the harness menu items are touch sized', async ({ page }) => {
    await open(page, '?projects=1', 900, 760);
    await sendBtn(page).click({ button: 'right' });
    const menu = page.locator('.ct-harness-menu');
    await expect(menu.getByRole('menuitemradio', { name: 'Claude' })).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('menuitemradio', { name: 'Codex' })).toHaveCSS('min-height', '44px');
    await shot(menu, 'new-conversation-harness-picker.png');
  });
});

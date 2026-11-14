import { test, expect } from '@playwright/test';
import path from 'path';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

/**
 * Regression tests for the "dispatch from Agent Dashboard doesn't select the new thread" bug.
 *
 * The harness fixture loads three threads sorted by createdAt ascending:
 *   thread-new         (T3 = 2 h ago)  ← oldest — was incorrectly selected before the fix
 *   thread-brainstorm  (T2 = 45 m ago)
 *   thread-fix-auth    (T1 = 5 m ago)  ← newest — should be selected after the fix
 */

test.describe('ThreadsView — initial thread selection', () => {
  test('defaults to the most recently created thread on open, not the oldest', async ({ page }) => {
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');

    const activeId: string = await page.evaluate(() => (window as any).__view.getActiveThreadId());

    // After the fix: should be the newest thread
    expect(activeId).toBe('thread-fix-auth');

    // Regression guard: the OLD buggy default was threads[0] = oldest thread
    expect(activeId).not.toBe('thread-new');
  });

  test('active tab in the UI matches the most recently created thread', async ({ page }) => {
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(200);

    // The title button shows the active thread title
    const titleEl = page.locator('.ct-title-text');
    await expect(titleEl).toContainText('Fix auth middleware');
  });

  test('focusThread switches to the targeted thread', async ({ page }) => {
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');

    // Simulate focusThread being called (e.g. from openThreadInChatView)
    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));

    const activeId: string = await page.evaluate(() => (window as any).__view.getActiveThreadId());
    expect(activeId).toBe('thread-brainstorm');

    const titleEl = page.locator('.ct-title-text');
    await expect(titleEl).toContainText('HipTrip feature');
  });

  test('exact UUID focus marks an unreviewed target reviewed and persists it', async ({ page }) => {
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');

    const before = await page.evaluate(() => {
      const target = (window as any).__manager.getThread('thread-brainstorm');
      target.reviewed = false;
      (window as any).__saveSettingsCalls = 0;
      return target.reviewed;
    });
    expect(before).toBe(false);

    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));

    const state = await page.evaluate(() => ({
      activeId: (window as any).__view.getActiveThreadId(),
      reviewed: (window as any).__manager.getThread('thread-brainstorm').reviewed,
      saveSettingsCalls: (window as any).__saveSettingsCalls,
    }));
    expect(state).toEqual({ activeId: 'thread-brainstorm', reviewed: true, saveSettingsCalls: expect.any(Number) });
    expect(state.saveSettingsCalls).toBeGreaterThan(0);
    await expect(page.locator('.ct-title-text')).toContainText('HipTrip feature');
  });

  test('exact UUID focus keeps an already-reviewed target reviewed', async ({ page }) => {
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');

    const state = await page.evaluate(async () => {
      const target = (window as any).__manager.getThread('thread-brainstorm');
      target.reviewed = true;
      await (window as any).__view.focusThread('thread-brainstorm');
      return {
        activeId: (window as any).__view.getActiveThreadId(),
        reviewed: target.reviewed,
      };
    });

    expect(state).toEqual({ activeId: 'thread-brainstorm', reviewed: true });
  });

  test('composer placeholder follows the active thread harness', async ({ page }) => {
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');

    await page.evaluate(() => {
      (window as any).__manager.getThread('thread-fix-auth').agentHarness = 'codex';
      (window as any).__manager.getThread('thread-brainstorm').agentHarness = 'claude';
      return (window as any).__view.focusThread('thread-fix-auth');
    });
    await expect(page.locator('.ct-input')).toHaveAttribute('placeholder', 'Message Codex');

    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));
    await expect(page.locator('.ct-input')).toHaveAttribute('placeholder', 'Message Claude');
  });
});

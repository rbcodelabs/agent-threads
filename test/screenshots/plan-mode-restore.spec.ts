/**
 * Playwright tests for the restored plan card.
 *
 * Covers the path where a thread has a persisted pendingPlan (from a session
 * that died before the user could act) and restorePendingPlanCard() re-renders
 * it on focus. Tests both the rendering and the button-action wiring.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

const PLAN_TEXT = [
  '## Plan: Refactor auth middleware',
  '',
  '**Step 1:** Read `src/middleware/auth.ts` — understand current shape.',
  '**Step 2:** Extract JWT verification into a standalone `verifyToken()` helper.',
  '**Step 3:** Add unit tests for the helper.',
  '**Step 4:** Swap the inline logic for the helper call.',
  '**Step 5:** Run `npm test` to confirm green.',
].join('\n');

test.describe('Plan mode — restored card (pendingPlan)', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  });

  test('plan card renders when thread has pendingPlan and no active session', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    // Pre-seed the active thread with a pendingPlan (simulates a persisted plan
    // from a session that was killed before the user approved or rejected it).
    await page.evaluate((planText) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.pendingPlan = planText;
      // Re-focus the thread to trigger restorePendingPlanCard()
      view.focusThread(activeId);
    }, PLAN_TEXT);

    await page.waitForSelector('.ct-plan-card');
    await page.waitForSelector('.ct-plan-md', { state: 'visible' });
    await page.waitForTimeout(200);

    // Card and all three buttons should be visible
    await expect(page.locator('.ct-plan-card')).toBeVisible();
    await expect(page.locator('.ct-plan-approve')).toBeVisible();
    await expect(page.locator('.ct-plan-edit')).toBeVisible();
    await expect(page.locator('.ct-plan-reject')).toBeVisible();

    // Default view: rendered markdown, no textarea
    await expect(page.locator('.ct-plan-md')).toBeVisible();
    await expect(page.locator('.ct-plan-textarea')).not.toBeVisible();

    await shot(page, 'plan-mode-restored.png', { fullPage: true });
  });

  test('approve calls sendMessage with plan text and clears pendingPlan', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    await page.evaluate((planText) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.pendingPlan = planText;
      // Replace sendMessage with a spy so we can inspect calls without actually running Claude
      (window as any).__sendMessageCalls = [];
      manager.sendMessage = async (threadId: string, text: string) => {
        (window as any).__sendMessageCalls.push({ threadId, text });
      };
      view.focusThread(activeId);
    }, PLAN_TEXT);

    await page.waitForSelector('.ct-plan-card');
    await page.waitForSelector('.ct-plan-md', { state: 'visible' });

    // Click Approve
    await page.locator('.ct-plan-approve').click();

    // Card should be gone
    await expect(page.locator('.ct-plan-card')).not.toBeAttached();

    // sendMessage should have been called with the approval message containing the plan
    const calls = await page.evaluate(() => (window as any).__sendMessageCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('approved');
    expect(calls[0].text).toContain('Refactor auth middleware');

    // pendingPlan should be cleared on the thread
    const pendingPlan = await page.evaluate(() => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const thread = manager.getThread(view['activeThreadId']);
      return thread.pendingPlan;
    });
    expect(pendingPlan).toBeUndefined();
  });

  test('reject keeps pendingPlan until explicit feedback is submitted, then clears it once', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    await page.evaluate((planText) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.pendingPlan = planText;
      (window as any).__sendMessageCalls = [];
      manager.sendMessage = async (threadId: string, text: string) => {
        (window as any).__sendMessageCalls.push({ threadId, text });
      };
      view.focusThread(activeId);
    }, PLAN_TEXT);

    await page.waitForSelector('.ct-plan-card');
    await page.waitForSelector('.ct-plan-md', { state: 'visible' });

    await page.locator('.ct-plan-reject').click();

    await expect(page.locator('.ct-plan-card')).toBeVisible();
    await expect(page.getByLabel('Why are you rejecting this plan?')).toBeFocused();
    expect(await page.evaluate(() => (window as any).__sendMessageCalls)).toHaveLength(0);
    expect(await page.evaluate(() => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      return manager.getThread(view['activeThreadId']).pendingPlan;
    })).toBe(PLAN_TEXT);

    await page.getByLabel('Why are you rejecting this plan?').fill('  Keep the middleware change smaller.  ');
    await page.locator('.ct-plan-rejection-submit').click();

    await expect(page.locator('.ct-plan-card')).not.toBeAttached();

    const calls = await page.evaluate(() => (window as any).__sendMessageCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe('Keep the middleware change smaller.');

    const pendingPlan = await page.evaluate(() => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const thread = manager.getThread(view['activeThreadId']);
      return thread.pendingPlan;
    });
    expect(pendingPlan).toBeUndefined();
  });

  test('edit flow sends edited plan on approve', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    await page.evaluate((planText) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.pendingPlan = planText;
      (window as any).__sendMessageCalls = [];
      manager.sendMessage = async (threadId: string, text: string) => {
        (window as any).__sendMessageCalls.push({ threadId, text });
      };
      view.focusThread(activeId);
    }, PLAN_TEXT);

    await page.waitForSelector('.ct-plan-card');
    await page.waitForSelector('.ct-plan-md', { state: 'visible' });

    // Click Edit to switch to textarea
    await page.locator('.ct-plan-edit').click();
    await page.waitForSelector('.ct-plan-textarea', { state: 'visible' });

    // Modify the plan text
    await page.locator('.ct-plan-textarea').fill('Simplified plan: just do step 1 and 3');

    // Approve the edited version
    await page.locator('.ct-plan-approve').click();

    await expect(page.locator('.ct-plan-card')).not.toBeAttached();

    const calls = await page.evaluate(() => (window as any).__sendMessageCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('edits');
    expect(calls[0].text).toContain('Simplified plan: just do step 1 and 3');
  });

  test('no card rendered when thread has no pendingPlan', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    // Focus a thread with no pendingPlan (default state)
    await page.evaluate(() => {
      const view = (window as any).__view;
      view.focusThread(view['activeThreadId']);
    });

    await page.waitForTimeout(200);
    await expect(page.locator('.ct-plan-card')).not.toBeAttached();
  });

  test('no duplicate card when focusThread is called twice', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    await page.evaluate((planText) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.pendingPlan = planText;
      manager.sendMessage = async () => {};
      // Focus twice
      view.focusThread(activeId);
      view.focusThread(activeId);
    }, PLAN_TEXT);

    await page.waitForSelector('.ct-plan-card');
    await page.waitForTimeout(200);

    // Only one card should exist
    await expect(page.locator('.ct-plan-card')).toHaveCount(1);
  });
});

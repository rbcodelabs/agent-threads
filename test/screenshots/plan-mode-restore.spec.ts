/**
 * Visual baseline test for the restored plan card.
 * Behavioral button-action tests live in test/browser/plan-mode-restore.spec.ts.
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

    await page.evaluate((planText) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.pendingPlan = planText;
      view.focusThread(activeId);
    }, PLAN_TEXT);

    await page.waitForSelector('.ct-plan-card');
    await page.waitForSelector('.ct-plan-md', { state: 'visible' });
    await page.waitForTimeout(200);

    await expect(page.locator('.ct-plan-card')).toBeVisible();
    await expect(page.locator('.ct-plan-approve')).toBeVisible();
    await expect(page.locator('.ct-plan-edit')).toBeVisible();
    await expect(page.locator('.ct-plan-reject')).toBeVisible();

    await expect(page.locator('.ct-plan-md')).toBeVisible();
    await expect(page.locator('.ct-plan-textarea')).not.toBeVisible();

    await shot(page, 'plan-mode-restored.png', { fullPage: true });
  });
});

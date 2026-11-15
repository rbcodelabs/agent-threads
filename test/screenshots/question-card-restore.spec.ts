/**
 * Visual baseline test for the inline AskUserQuestion card.
 * Behavioral interaction tests live in test/browser/question-card-restore.spec.ts.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

const SAMPLE_QUESTIONS = [
  {
    question: 'Which approach should I take?',
    header: 'Implementation approach',
    options: [
      { label: 'Rewrite the module', description: 'Cleaner, but touches more files.' },
      { label: 'Patch in place', description: 'Faster, smaller diff.' },
    ],
    multiSelect: false,
  },
];

test.describe('AskUserQuestion — inline card (pendingQuestions)', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  });

  test('question card renders when thread has pendingQuestions and no active session', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    // Pre-seed the active thread with pendingQuestions (simulates a persisted
    // question set from a session that was killed before the user answered).
    await page.evaluate((questions) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.pendingQuestions = questions;
      // Re-focus the thread to trigger restorePendingQuestionCard()
      view.focusThread(activeId);
    }, SAMPLE_QUESTIONS);

    await page.waitForSelector('.ct-question-card');
    await page.waitForTimeout(200);

    await expect(page.locator('.ct-question-card')).toBeVisible();
    await expect(page.locator('.ct-question-card-submit')).toBeVisible();
    await expect(page.locator('.ct-question-header')).toHaveText('Implementation approach');
    // 2 fixed options + the always-present "Other" free-text row.
    await expect(page.locator('.ct-question-option')).toHaveCount(3);
    await expect(page.locator('.ct-question-option-other')).toHaveCount(1);

    await shot(page, 'question-card-restored.png', { fullPage: true });
  });
});

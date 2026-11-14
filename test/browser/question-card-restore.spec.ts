/**
 * Playwright behavioral tests for the inline AskUserQuestion card.
 *
 * Covers the path where a thread has a persisted pendingQuestions (from a
 * session that died before the user could answer) and restorePendingQuestionCard()
 * re-renders it on focus — the question-card counterpart to
 * plan-mode-restore.spec.ts. Visual baseline lives in
 * test/screenshots/question-card-restore.spec.ts.
 */
import { test, expect } from '@playwright/test';
import path from 'path';

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

  test('typing a custom answer in "Other" implicitly selects it and is sent verbatim', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    await page.evaluate((questions) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.pendingQuestions = questions;
      (window as any).__sendMessageCalls = [];
      manager.sendMessage = async (threadId: string, text: string) => {
        (window as any).__sendMessageCalls.push({ threadId, text });
      };
      view.focusThread(activeId);
    }, SAMPLE_QUESTIONS);

    await page.waitForSelector('.ct-question-card');

    // Type directly into the "Other" text field without clicking its radio first —
    // typing should implicitly select it.
    await page.locator('.ct-question-other-text').fill('Do neither, ask the user first');
    await expect(page.locator('.ct-question-option-other input[type="radio"]')).toBeChecked();

    await page.locator('.ct-question-card-submit').click();
    await expect(page.locator('.ct-question-card')).not.toBeAttached();

    const calls = await page.evaluate(() => (window as any).__sendMessageCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('Do neither, ask the user first');
  });

  test('submit sends formatted answers and clears pendingQuestions', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    await page.evaluate((questions) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.pendingQuestions = questions;
      (window as any).__sendMessageCalls = [];
      manager.sendMessage = async (threadId: string, text: string) => {
        (window as any).__sendMessageCalls.push({ threadId, text });
      };
      view.focusThread(activeId);
    }, SAMPLE_QUESTIONS);

    await page.waitForSelector('.ct-question-card');

    // Pick the first radio option, then submit.
    await page.locator('.ct-question-option input[type="radio"]').first().click();
    await page.locator('.ct-question-card-submit').click();

    // Card should be gone
    await expect(page.locator('.ct-question-card')).not.toBeAttached();

    const calls = await page.evaluate(() => (window as any).__sendMessageCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('Which approach should I take?');
    expect(calls[0].text).toContain('Rewrite the module');

    const pendingQuestions = await page.evaluate(() => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const thread = manager.getThread(view['activeThreadId']);
      return thread.pendingQuestions;
    });
    expect(pendingQuestions).toBeUndefined();
  });

  test('clicking anywhere on an option row selects it, not just the radio button', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    await page.evaluate((questions) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.pendingQuestions = questions;
      view.focusThread(activeId);
    }, SAMPLE_QUESTIONS);

    await page.waitForSelector('.ct-question-card');

    // Click the option's label text, not the radio input itself — the row
    // should still select, and the other radio in the group should clear.
    const secondOption = page.locator('.ct-question-option').nth(1);
    await secondOption.locator('.ct-question-opt-name').click();

    await expect(secondOption.locator('input[type="radio"]')).toBeChecked();
    await expect(page.locator('.ct-question-option').first().locator('input[type="radio"]')).not.toBeChecked();
  });

  test('clicking a multiSelect row toggles its checkbox on and off', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    const MULTI_QUESTIONS = [
      {
        question: 'Which features should ship?',
        options: [{ label: 'Dark mode' }, { label: 'Offline sync' }],
        multiSelect: true,
      },
    ];

    await page.evaluate((questions) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.pendingQuestions = questions;
      view.focusThread(activeId);
    }, MULTI_QUESTIONS);

    await page.waitForSelector('.ct-question-card');

    const row = page.locator('.ct-question-option').first();
    const checkbox = row.locator('input[type="checkbox"]');

    // Click the row's label text (not the checkbox) to select it.
    await row.locator('.ct-question-opt-name').click();
    await expect(checkbox).toBeChecked();

    // Clicking it again should un-toggle it, matching native checkbox behavior.
    await row.locator('.ct-question-opt-name').click();
    await expect(checkbox).not.toBeChecked();
  });

  test('Codex secret questions use stable IDs without exposing the ID in restored follow-up text', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.pendingQuestions = [{
        id: 'api_token', source: 'codex', question: 'Enter the API token', header: 'Token',
        options: [], multiSelect: false, allowOther: true, isSecret: true,
      }];
      (window as any).__sendMessageCalls = [];
      manager.sendMessage = async (threadId: string, text: string) => {
        (window as any).__sendMessageCalls.push({ threadId, text });
      };
      view.focusThread(activeId);
    });

    await page.waitForSelector('.ct-question-card');
    await expect(page.locator('.ct-question-card-label')).toHaveText('Codex needs your input');
    await expect(page.locator('.ct-question-other-text')).toHaveAttribute('type', 'password');
    await page.locator('.ct-question-other-text').fill('s3cret');
    await page.locator('.ct-question-card-submit').click();

    const calls = await page.evaluate(() => (window as any).__sendMessageCalls);
    expect(calls[0].text).not.toContain('s3cret');
    expect(calls[0].text).toContain('request the secret again with request_user_input');
  });

  test('no card rendered when thread has no pendingQuestions', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      const view = (window as any).__view;
      view.focusThread(view['activeThreadId']);
    });

    await page.waitForTimeout(200);
    await expect(page.locator('.ct-question-card')).not.toBeAttached();
  });

  test('no duplicate card when a live resolver is already registered for the backgrounded thread', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    await page.evaluate((questions) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.pendingQuestions = questions;
      const resolver = () => {};
      manager.registerQuestionResolver(activeId, resolver);
      view['pendingQuestions'].set(activeId, { questions, resolve: resolver, cardEl: null });
      view.focusThread(activeId);
    }, SAMPLE_QUESTIONS);

    await page.waitForSelector('.ct-question-card');
    await page.waitForTimeout(200);

    await expect(page.locator('.ct-question-card')).toHaveCount(1);
  });

  test('no duplicate card when focusThread is called twice', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    await page.evaluate((questions) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.pendingQuestions = questions;
      manager.sendMessage = async () => {};
      view.focusThread(activeId);
      view.focusThread(activeId);
    }, SAMPLE_QUESTIONS);

    await page.waitForSelector('.ct-question-card');
    await page.waitForTimeout(200);

    await expect(page.locator('.ct-question-card')).toHaveCount(1);
  });
});

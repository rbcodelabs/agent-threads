/**
 * Visual baseline test for the inline AskUserQuestion card.
 * Behavioral interaction tests live in test/browser/question-card-restore.spec.ts.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { parseAntigravityElicitation } from '../../src/AntigravitySession';
import { shot } from './helpers';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');
const agyFixture = JSON.parse(
  fs.readFileSync(path.resolve('test/fixtures/antigravity/ask-question-elicitation.json'), 'utf8'),
);

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

  test('Antigravity elicitation question card renders on desktop (1280x800)', async ({ page }) => {
    const fields = parseAntigravityElicitation(agyFixture.elicitationRequest.params)!;
    const questions = fields.map((f) => f.askQuestion);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    await page.evaluate((agyQuestions) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.agentHarness = 'antigravity';
      thread.model = 'gemini-3.1-pro-high';
      thread.messages.push({
        id: 'msg-agy-ask',
        role: 'assistant',
        content: 'Before implementing live alerts, please confirm your trigger and delivery preferences.',
        timestamp: 1768471200000,
        agentHarness: 'antigravity',
        toolCalls: [
          {
            name: 'AskUserQuestion',
            summary: 'Which events should pop a live alert?',
            toolUseId: 'call_ask_question_1',
            status: 'pending',
          },
        ],
      });
      thread.pendingQuestions = agyQuestions;
      view.focusThread(activeId);
    }, questions);

    const card = page.locator('.ct-question-card');
    await card.waitFor();
    await expect(page.locator('.ct-question-card-label')).toHaveText('Antigravity needs your input');

    // Populate representative single-select + comma-bearing multi-select + Other write-in states.
    await card.locator('.ct-question').nth(0).locator('.ct-question-option').nth(1).click();
    await card.locator('.ct-question').nth(1).locator('.ct-question-option').nth(0).click();
    const otherInput = card.locator('.ct-question').nth(1).locator('.ct-question-other-text');
    await otherInput.fill('Olives, kalamata');
    await otherInput.blur();
    await page.waitForTimeout(200);

    expect(await card.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
    await shot(page, 'question-card-antigravity-desktop.png');
  });
});

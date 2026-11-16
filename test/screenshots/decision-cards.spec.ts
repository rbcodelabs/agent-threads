/**
 * Visual baseline test for inline orchestrator decision cards in Conversation View.
 * Behavioral & viewport interaction tests live in test/browser/decision-cards.spec.ts.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

const SAMPLE_OPTIONS = [
  { label: 'Roll out behind feature flag', description: 'Zero-downtime rollout to staging first.' },
  { label: 'Deploy straight to production', description: 'Faster, skips staging bake window.' },
];

test.describe('Orchestrator decision card — Conversation View', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  });

  test('decision card renders inline at bottom of Conversation View', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    await page.evaluate((options) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'] as string;
      const orch = manager.createThread('Portfolio Orchestrator', '/tmp');
      manager.postDecision(activeId, orch.id, {
        question: 'How should we roll out the auth middleware fix?',
        header: 'Rollout strategy',
        options,
      });
    }, SAMPLE_OPTIONS);

    await page.waitForSelector('.ct-decision-card');
    await page.waitForTimeout(200);

    await expect(page.locator('.ct-decision-card')).toBeVisible();
    await expect(page.locator('.ct-decision-card-label')).toHaveText('Decision for you · Portfolio Orchestrator');
    await expect(page.locator('.ct-decision-card-submit')).toBeVisible();
    await expect(page.locator('.ct-decision-card .ct-question-header')).toHaveText('Rollout strategy');
    await expect(page.locator('.ct-decision-card .ct-question-option')).toHaveCount(3);
    await expect(page.locator('.ct-decision-card .ct-question-option-other')).toHaveCount(1);

    await shot(page, 'decision-card-conversation.png', { fullPage: true });
  });
});

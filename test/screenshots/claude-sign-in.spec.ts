/**
 * The in-thread "Sign in to Claude" card, shown when a turn failed to
 * authenticate even after ThreadSession's silent fresh-process retry
 * (claudeAuthRecovery.ts). Covers the restore path — a thread whose
 * persisted `authRequired` state is re-rendered on focus — and the Retry
 * action. The real `claude auth login` browser flow is not driven here; it
 * is covered by test/unit/claudeAuthCli.test.ts with a mocked spawn.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

const MESSAGE = 'Claude sign-in expired — run `claude auth login`\n\n'
  + 'Failed to authenticate: OAuth session expired and could not be refreshed';

test.describe('Claude sign-in expired card', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);
    await page.evaluate((message) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.messages.push({ id: 'auth-pending', role: 'user', content: 'Summarize the open PRs', timestamp: Date.now() });
      thread.status = 'error';
      thread.lastError = message;
      thread.authRequired = { message, at: Date.now() };
      (window as any).__retryCalls = [];
      manager.retryAfterSignIn = async (threadId: string) => {
        (window as any).__retryCalls.push(threadId);
        return true;
      };
      view.focusThread(activeId);
    }, MESSAGE);
    await page.waitForSelector('.ct-auth-required');
  });

  test('renders the sign-in card with Sign in and Retry actions', async ({ page }) => {
    const card = page.locator('.ct-auth-required');
    await expect(card.locator('.ct-error-text')).toHaveText('Claude sign-in expired');
    await expect(card.getByRole('button', { name: 'Sign in to Claude' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Retry' })).toBeVisible();
    await shot(page, 'claude-sign-in-required.png', { fullPage: true });
  });

  test('Retry resends the pending message and dismisses the card', async ({ page }) => {
    await page.locator('.ct-auth-required').getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('.ct-auth-required')).toHaveCount(0);
    const calls = await page.evaluate(() => (window as any).__retryCalls);
    expect(calls).toHaveLength(1);
  });
});

const AWS_MESSAGE = 'AWS sign-in expired — sign in to AWS SSO again\n\n'
  + "API Error: Could not load AWS credentials · The SSO session token associated with profile=bedrock-dev was not found or is invalid. To refresh this SSO session run 'aws sso login' with the corresponding profile.";

test.describe('AWS sign-in expired card (Bedrock)', () => {
  test('renders the AWS sign-in card with Sign in to AWS and Retry actions', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);
    await page.evaluate((message) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.messages.push({ id: 'auth-pending', role: 'user', content: 'Summarize the open PRs', timestamp: Date.now() });
      thread.status = 'error';
      thread.lastError = message;
      thread.authRequired = { message, at: Date.now() };
      view.focusThread(activeId);
    }, AWS_MESSAGE);
    await page.waitForSelector('.ct-auth-required');
    const card = page.locator('.ct-auth-required');
    await expect(card.locator('.ct-error-text')).toHaveText('AWS sign-in expired');
    await expect(card.getByRole('button', { name: 'Sign in to AWS' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Sign in to Claude' })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});

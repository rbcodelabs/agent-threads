import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');
const outDir = path.resolve('test-results/cross-project-spawn');
const SOURCE = 'thread-fix-auth';
const SOURCE_CWD = '/Users/mock/projects/hip-trip';

// Real: createAgentThreadCallback (src/agentThreadCreation.ts), ThreadManager
// (requestToolApproval, createThread, projects) and the ThreadsView permission
// card + Allow/Deny buttons. Stubbed: saveSettings, sendMessage (no agent turn),
// and the errored tool call shown after Deny (see __spawnFromThread).
test.describe('cross-project threads_create approval', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    // Put the source thread in a project so "same project" is well defined.
    await page.evaluate((id) => {
      (window as any).__manager.getThread(id).projectId = 'proj-hiptrip';
    }, SOURCE);
    await page.waitForTimeout(300);
  });

  async function capture(page: Page, name: string, file: string) {
    await shot(page, name, { fullPage: true });
    await page.screenshot({ path: path.join(outDir, file), fullPage: true });
  }

  const spawn = (page: Page, params: object) =>
    page.evaluate(([id, p]) => (window as any).__spawnFromThread(id, p), [SOURCE, params] as const);
  const outcome = (page: Page) => page.evaluate(() => ({ ...(window as any).__spawnOutcome }));
  const threadCount = (page: Page) =>
    page.evaluate(() => (window as any).__manager.getThreads().length as number);

  test('in-project spawn needs no approval', async ({ page }) => {
    const before = await threadCount(page);
    await spawn(page, { prompt: 'Add a regression test for the JWT_SECRET startup check', cwd: SOURCE_CWD });
    await expect.poll(async () => (await outcome(page)).done).toBe(true);
    expect((await outcome(page)).error).toBeUndefined();
    expect(await threadCount(page)).toBe(before + 1);
    await expect(page.locator('.ct-permission-card')).toHaveCount(0);
    await capture(page, 'cross-project-01-in-project.png', '01-in-project.png');
  });

  test('cross-project spawn raises the card, Deny blocks it', async ({ page }) => {
    const before = await threadCount(page);
    await spawn(page, {
      prompt: 'Draft release notes for v2.4\nInclude all merged PRs',
      projectId: 'proj-threads',
      cwd: '/Users/mock/projects/claude-threads',
    });
    const card = page.locator('.ct-permission-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Spawn thread in another project');
    // Detail keeps its line breaks (one row per field), not a run-on line.
    expect(await card.locator('.ct-permission-detail').innerText()).toContain('\nWorking directory:');
    await expect(card).toContainText('Project: Agent Threads');
    await expect(card).toContainText('Working directory: /Users/mock/projects/claude-threads');
    await expect(card).toContainText('Prompt: Draft release notes for v2.4');
    await expect(card).not.toContainText('Include all merged PRs');
    await capture(page, 'cross-project-02-card.png', '02-card.png');

    await card.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect.poll(async () => (await outcome(page)).done).toBe(true);
    expect((await outcome(page)).error).toBe('Cross-project spawn was denied by the user.');
    expect(await threadCount(page)).toBe(before);
    await expect(page.locator('.ct-messages')).toContainText('Cross-project spawn was denied by the user.');
    await capture(page, 'cross-project-03-denied.png', '03-denied.png');
  });

  test('cross-project spawn, Allow creates the thread in the other project', async ({ page }) => {
    const before = await threadCount(page);
    await spawn(page, {
      prompt: 'Draft release notes for v2.4\nInclude all merged PRs',
      projectId: 'proj-threads',
      cwd: '/Users/mock/projects/claude-threads',
    });
    const card = page.locator('.ct-permission-card');
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect.poll(async () => (await outcome(page)).done).toBe(true);
    const result = await outcome(page);
    expect(result.error).toBeUndefined();
    expect(await threadCount(page)).toBe(before + 1);
    const created = await page.evaluate((id) => {
      const t = (window as any).__manager.getThread(id);
      return { projectId: t.projectId, cwd: t.cwd, title: t.title };
    }, result.threadId);
    expect(created).toEqual({
      projectId: 'proj-threads',
      cwd: '/Users/mock/projects/claude-threads',
      title: 'Draft release notes for v2.4',
    });
    await capture(page, 'cross-project-04-allowed.png', '04-allowed.png');

    // Also show the spawned thread itself, now living in the other project.
    await page.evaluate((id) => (window as any).__view.focusThread(id), result.threadId);
    await expect(page.locator('.ct-title-row')).toContainText('Draft release notes for v2.4');
    await capture(page, 'cross-project-05-new-thread.png', '05-new-thread.png');
  });
});

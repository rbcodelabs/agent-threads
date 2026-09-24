import { test, expect } from '@playwright/test';
import path from 'node:path';

for (const dashboard of [true, false]) {
  for (const width of [1280, 390]) {
  test(`reviewed_changed moves a thread from New to Reviewed in ${dashboard ? 'list' : 'board'} at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.goto('file://' + path.resolve('test/harness/kanban.html') + (dashboard ? '?dashboard=1' : ''));
    const title = 'Draft Q3 planning notes';
    const group = dashboard ? '.ct-agents-group' : '.ct-kanban-col';
    const label = dashboard ? '.ct-agents-group-label' : '.ct-kanban-col-label';
    const newGroup = page.locator(group).filter({ has: page.locator(label, { hasText: /^New/ }) });
    const reviewedGroup = page.locator(group).filter({ has: page.locator(label, { hasText: dashboard ? /^Reviewed/ : /^Done/ }) });
    await expect(newGroup.getByText(title, { exact: true })).toBeVisible();
    const before = await page.evaluate(() => {
      const manager = (window as any).__manager;
      return { selected: manager.activeThreadId, updatedAt: manager.getThread('k-unassigned-new').updatedAt };
    });
    await page.evaluate(() => {
      const manager = (window as any).__manager;
      manager.getThread('k-unassigned-new').reviewed = true;
      manager.notifyReviewedChanged('k-unassigned-new');
    });
    await expect(reviewedGroup.getByText(title, { exact: true })).toBeVisible();
    await expect(newGroup.getByText(title, { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => {
      const manager = (window as any).__manager;
      return { selected: manager.activeThreadId, updatedAt: manager.getThread('k-unassigned-new').updatedAt };
    })).toEqual(before);
    await page.screenshot({ path: testInfo.outputPath('reviewed.png'), fullPage: true });
  });
  }
}

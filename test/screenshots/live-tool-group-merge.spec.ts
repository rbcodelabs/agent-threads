import { test, expect } from '@playwright/test';
import path from 'path';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

// Remote sessions replay wire events: the streamed record and the committed
// message's record are SEPARATE copies. Step N's calls must land in the same
// group as the previous tool-only row while the turn is still live.
test.describe('Live tool groups across steps', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 520, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.evaluate(async () => {
      const w = window as any;
      await w.__view.focusThread('thread-new');
      w.__setThreadRunning('thread-new', true);
      w.__emitEvent('thread-new', { type: 'streaming_start' });
      w.__step = (ids: string[]) => {
        const thread = w.__manager.getThread('thread-new');
        const recs = ids.map((id) => ({ name: 'Read', summary: `Read: /a/${id}.ts`, timestamp: Date.now(), toolUseId: id, status: 'pending' }));
        for (const r of recs) w.__emitEvent('thread-new', { type: 'tool_use', record: r });
        return recs;
      };
      w.__commit = (recs: any[], tag: string) => {
        const thread = w.__manager.getThread('thread-new');
        const message = { id: 'm-' + tag, role: 'assistant', content: '', timestamp: Date.now(), toolCalls: recs.map((r) => ({ ...r })) };
        thread.messages.push(message);
        w.__emitEvent('thread-new', { type: 'message', message });
      };
    });
  });

  test('second step joins the first step group instead of a second group', async ({ page }) => {
    await page.evaluate(() => { const w = window as any; w.__s1 = w.__step(['a1', 'a2', 'a3']); });
    await page.waitForTimeout(200);
    await expect(page.locator('.ct-tool-group')).toHaveCount(1);
    await page.evaluate(() => { const w = window as any; w.__commit(w.__s1, '1'); });
    await page.waitForTimeout(200);
    await expect(page.locator('.ct-tool-group')).toHaveCount(1);
    await page.evaluate(() => { const w = window as any; w.__s2 = w.__step(['b1', 'b2', 'b3', 'b4']); });
    await page.waitForTimeout(300);
    await expect(page.locator('.ct-tool-group')).toHaveCount(1);
    await expect(page.locator('.ct-tool-group-count')).toHaveText('7');
    await page.evaluate(() => { const w = window as any; w.__commit(w.__s2, '2'); });
    await page.waitForTimeout(300);
    await expect(page.locator('.ct-tool-group')).toHaveCount(1);
    await expect(page.locator('.ct-tool-group-count')).toHaveText('7');
  });

  test('an opened group stays open as the next step extends it', async ({ page }) => {
    await page.evaluate(() => { const w = window as any; w.__s1 = w.__step(['a1', 'a2']); w.__commit(w.__s1, '1'); });
    await page.waitForTimeout(200);
    await page.locator('.ct-tool-group-header').first().click();
    await page.evaluate(() => { const w = window as any; w.__step(['b1']); });
    await page.waitForTimeout(300);
    await expect(page.locator('.ct-tool-group')).toHaveCount(1);
    await expect(page.locator('.ct-tool-group-header')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.ct-tool-group .ct-tool-pill')).toHaveCount(3);
  });

  test('text between steps still starts a new group', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as any;
      w.__commit(w.__step(['a1', 'a2']), '1');
      const thread = w.__manager.getThread('thread-new');
      const message = { id: 'm-text', role: 'assistant', content: 'Now the next part.', timestamp: Date.now() };
      thread.messages.push(message);
      w.__emitEvent('thread-new', { type: 'message', message });
      w.__step(['b1', 'b2']);
    });
    await page.waitForTimeout(300);
    await expect(page.locator('.ct-tool-group')).toHaveCount(2);
  });
});

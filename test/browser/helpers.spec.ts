import { expect, test } from '@playwright/test';
import { anchorFocusedComposerToBottom, settleView } from './helpers';

test('bottom anchor corrects clipping after a delayed composer expansion', async ({ page }) => {
  await page.setContent(`
    <style>
      #main { display: flex; flex-direction: column; height: 200px; }
      .ct-messages { flex: 1; min-height: 0; overflow-y: auto; }
      #content { position: relative; height: 400px; }
      #last { position: absolute; bottom: 0; height: 20px; }
      .ct-input-footer {
        height: 50px;
        max-height: 0;
        overflow: hidden;
        transition: max-height 100ms linear 200ms;
      }
      .ct-floating-panel:focus-within .ct-input-footer { max-height: 50px; }
    </style>
    <div id="main">
      <div class="ct-messages"><div id="content"><div id="last">Last message</div></div></div>
      <div class="ct-floating-panel">
        <input class="ct-input" />
        <div class="ct-input-footer">Footer</div>
      </div>
    </div>
  `);

  await page.evaluate(() => {
    const messages = document.querySelector<HTMLElement>('.ct-messages')!;
    messages.scrollTop = messages.scrollHeight;
  });
  await page.locator('.ct-input').focus();

  await settleView(page);
  await expect.poll(() => page.locator('.ct-input-footer').evaluate(
    (element) => getComputedStyle(element).maxHeight,
  )).toBe('50px');
  await anchorFocusedComposerToBottom(page, '50px');

  const state = await page.evaluate(() => ({
    bottomGap: (() => {
      const messages = document.querySelector<HTMLElement>('.ct-messages')!;
      return messages.scrollHeight - messages.clientHeight - messages.scrollTop;
    })(),
    lastVisible: (() => {
      const messages = document.querySelector<HTMLElement>('.ct-messages')!.getBoundingClientRect();
      const last = document.querySelector<HTMLElement>('#last')!.getBoundingClientRect();
      return last.bottom <= messages.bottom + 1;
    })(),
  }));
  expect(state).toEqual({ bottomGap: 0, lastVisible: true });
});

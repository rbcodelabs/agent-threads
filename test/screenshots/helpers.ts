import { expect, type Page, type Locator } from '@playwright/test';

/**
 * Wait for the view to reach a steady visual state before capturing pixels.
 *
 * Why this is needed: message rendering is async, and `scrollToBottom()`
 * schedules a single rAF that reads `scrollHeight` when it fires. If more
 * content lands after that frame, the scroller is left parked at a *stale*
 * bottom and nothing re-scrolls it. Both outcomes are stable resting
 * positions, so Playwright's built-in "two consecutive matching screenshots"
 * stability check happily captures the wrong one — it is looking for motion,
 * and there is none.
 *
 * Measured on `permission card` before this helper existed: 6 runs produced
 * scrollTop 1418 or 1269 (a 149px swing) with no other input change. That
 * 149px offset re-rasterises every glyph on the page, which is why the diffs
 * looked like uniform antialiasing noise (~7000px) rather than a shifted
 * layout.
 *
 * So: wait until every scroll position has stopped changing across
 * consecutive frames, and until webfonts are done, then capture.
 */
export async function settleView(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // The bundled harness fonts (test/harness/fonts.css) load lazily per
    // unicode-range subset, and a late swap reflows text. Wait for them
    // before measuring scroll stability, not only after.
    await (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
    const scrollers = [
      document.scrollingElement,
      ...Array.from(document.querySelectorAll('*')),
    ].filter((el): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false;
      return el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth;
    });

    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
    // Track content height as well as scroll offset. Waiting only on scrollTop
    // is not enough: markdown/table content keeps reflowing after the scroller
    // has stopped moving, so scrollHeight was still swinging up to 15px
    // between runs while scrollTop sat perfectly still at 1269. That reflow
    // shifts every glyph in the viewport by a fraction of a pixel, which is
    // what produced the residual ~2300px "antialiasing" diffs.
    const snapshot = () =>
      scrollers
        .map((el) => `${el.scrollTop},${el.scrollLeft},${el.scrollHeight},${el.scrollWidth}`)
        .join('|');

    let last = '';
    let stableFrames = 0;
    // 120 frames (~2s at 60fps) is a generous ceiling; in practice this settles
    // in a handful of frames. Bailing out rather than hanging keeps a genuinely
    // animating page from turning into a timeout with no diagnostic.
    for (let i = 0; i < 120 && stableFrames < 4; i++) {
      await frame();
      const now = snapshot();
      stableFrames = now === last ? stableFrames + 1 : 0;
      last = now;
    }

    await (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
    // One more frame so any font-driven reflow is painted before we capture.
    await frame();
  });
}

export async function anchorFocusedComposerToBottom(
  page: Page,
  expectedMaxHeight?: string,
): Promise<void> {
  const root = page.locator('.ct-root');
  const isMobile = await root.count() > 0
    && await root.evaluate((element) => element.classList.contains('ct-mobile'));
  const canonicalMaxHeight = expectedMaxHeight
    ?? (isMobile ? '58px' : '50px');
  const footer = page.locator('.ct-input-footer');

  await expect.poll(() => footer.evaluate(
    (element) => getComputedStyle(element).maxHeight,
  )).toBe(canonicalMaxHeight);

  const messages = page.locator('.ct-messages');
  await messages.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => messages.evaluate(
    (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
  )).toBeLessThanOrEqual(1);
}

/**
 * Settle the view, then assert a screenshot. Use this instead of calling
 * `expect(page).toHaveScreenshot(...)` directly so new tests inherit the
 * stability guarantee by default.
 */
export async function shot(
  target: Page | Locator,
  name: string,
  options?: Parameters<ReturnType<typeof expect<Page>>['toHaveScreenshot']>[1],
): Promise<void> {
  const page: Page = 'goto' in target ? (target as Page) : (target as Locator).page();
  await settleView(page);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await expect(target as any).toHaveScreenshot(name, options);
}

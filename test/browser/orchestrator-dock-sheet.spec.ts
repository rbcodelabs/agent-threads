import { test, expect, type Page } from '@playwright/test';
import path from 'path';

/**
 * K2 OrchestratorDock P3 functional & scroll invariants (no pixel baselines).
 * Pixel baselines live in `test/screenshots/orchestrator-dock-sheet.spec.ts`.
 */
const kanbanUrl = 'file://' + path.resolve('test/harness/kanban.html');
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
});

const DESKTOP = { width: 1280, height: 800 };
const NARROW = { width: 390, height: 844 };
const SIZES = [{ label: '1280x800', size: DESKTOP }, { label: '390x844', size: NARROW }];

async function open(page: Page, orch: string, tx: string, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  const narrow = size.width < 640 ? '&narrow=1&mobile=1' : '';
  await page.goto(`${kanbanUrl}?orch=${orch}&tx=${tx}${narrow}`);
  await page.waitForSelector('.ct-kanban-dispatch .ct-orch-dock');
}
const sheet = (page: Page) => page.locator('.ct-orch-sheet');
const field = (page: Page) => page.locator('.ct-orch-input');
const isNarrow = (size: { width: number }) => size.width < 640;
async function focusComposer(page: Page, size: { width: number }) {
  if (isNarrow(size)) await page.locator('.ct-orch-orb').click(); else await field(page).click();
}
async function send(page: Page, size: { width: number }, text: string) {
  if (isNarrow(size) && !(await sheet(page).isVisible())) await page.locator('.ct-orch-orb').click();
  await field(page).fill(text);
  await page.keyboard.press('Enter');
}

test.describe('orchestrator sheet — functional (no baselines)', () => {
  test('a tool group (the main panel\'s own) expands to its pills and collapses again', async ({ page }) => {
    await open(page, 'idle', 'transcript', DESKTOP);
    await focusComposer(page, DESKTOP);
    const toggle = page.locator('.ct-tool-group-header').first();
    const body = page.locator('.ct-tool-group .ct-full-content').first();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(body).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.ct-tool-group .ct-tool-pill').first()).toBeVisible();
    await toggle.click();
    await expect(body).toBeHidden();
  });

  for (const { label, size } of SIZES) {
    test(`stays open when the board is clicked; Esc closes and focus returns @ ${label}`, async ({ page }) => {
      await open(page, 'idle', 'conversation', size);
      await focusComposer(page, size);
      await expect(sheet(page)).toBeVisible();
      await page.mouse.click(60, 120);
      await expect(sheet(page)).toBeVisible();
      await field(page).focus();
      await page.keyboard.press('Escape');
      await expect(sheet(page)).toBeHidden();
      await expect(isNarrow(size) ? page.locator('.ct-orch-orb') : field(page)).toBeFocused();
    });

    test(`Enter sends once, opens the sheet, and never opens the thread @ ${label}`, async ({ page }) => {
      await open(page, 'idle', 'empty', size);
      await send(page, size, 'What needs me?');
      await expect(sheet(page)).toBeVisible();
      await expect(page.locator('.ct-orch-sheet-log > [data-role="user"]')).toContainText('What needs me?');
      expect(await page.evaluate(() => (window as any).__sentMessages)).toEqual([expect.objectContaining({ text: 'What needs me?' })]);
      expect(await page.evaluate(() => (window as any).__openedThreadIds.length)).toBe(0);
    });

    test(`rapid Enter does not double-send @ ${label}`, async ({ page }) => {
      await open(page, 'idle', 'empty', size);
      if (isNarrow(size)) await page.locator('.ct-orch-orb').click();
      await field(page).fill('only once');
      await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
      await expect(page.locator('.ct-orch-sheet-log > [data-role="user"]')).toHaveCount(1);
      expect(await page.evaluate(() => (window as any).__sentMessages.length)).toBe(1);
    });

    test(`mid-turn send says "Sent, will be picked up" and never "queued" @ ${label}`, async ({ page }) => {
      await open(page, 'working', 'conversation', size);
      await focusComposer(page, size);
      await send(page, size, 'also check CI');
      await expect(page.locator('.ct-orch-pickup')).toHaveText('Sent, will be picked up');
      expect((await sheet(page).innerText()).toLowerCase()).not.toContain('queued');
      expect((await sheet(page).innerHTML()).toLowerCase()).not.toContain('queued');
    });

    test(`Stop interrupts, and the rolled-back user message leaves the transcript @ ${label}`, async ({ page }) => {
      await open(page, 'working', 'conversation', size);
      await focusComposer(page, size);
      await send(page, size, 'this will be rolled back');
      await expect(page.locator('.ct-orch-sheet-log > [data-role="user"]', { hasText: 'this will be rolled back' })).toBeVisible();
      await page.locator('.ct-orch-stop').click();
      await expect(page.locator('.ct-orch-sheet-log > [data-role="user"]', { hasText: 'this will be rolled back' })).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).__interruptCalls)).toEqual(['k-orchestrator']);
      await expect(page.locator('.ct-orch-stop')).toBeHidden();
    });

    test(`the waiting-to-send list removes an item @ ${label}`, async ({ page }) => {
      await open(page, 'idle', 'conversation', size);
      await page.evaluate(() => { (window as any).__orchQueue('first held'); (window as any).__orchQueue('second held'); });
      await focusComposer(page, size);
      await expect(page.locator('.ct-orch-waiting li')).toHaveCount(2);
      await page.locator('.ct-orch-waiting li').first().getByRole('button').click();
      await expect(page.locator('.ct-orch-waiting li')).toHaveCount(1);
      await expect(page.locator('.ct-orch-waiting')).toContainText('second held');
    });

    test(`a thread link opens that thread @ ${label}`, async ({ page }) => {
      await open(page, 'idle', 'conversation', size);
      await focusComposer(page, size);
      await page.locator('.ct-orch-sheet a.internal-link[data-href^="thread:"]').first().click();
      expect(await page.evaluate(() => (window as any).__openedThreadIds.length)).toBe(1);
    });

    test(`unread peek: Open shows the sheet and clears the dot @ ${label}`, async ({ page }) => {
      await open(page, 'idle', 'conversation', size);
      await page.evaluate(() => (window as any).__orchSay('Fresh news'));
      await expect(page.locator('.ct-orch-dot')).toHaveClass(/ct-orch-dot-attention/);
      await page.locator('.ct-orch-peek').getByRole('button', { name: 'Open' }).click();
      await expect(sheet(page)).toBeVisible();
      await expect(page.locator('.ct-orch-peek')).toBeHidden();
      await expect(page.locator('.ct-orch-dot')).not.toHaveClass(/ct-orch-dot-attention/);
    });
  }

  test('wide: the sheet sits above the pill, inside the view, and follows the pill when search expands', async ({ page }) => {
    await open(page, 'idle', 'conversation', DESKTOP);
    await field(page).click();
    const before = await sheet(page).boundingBox();
    const pillBefore = await page.locator('.ct-kanban-dispatch').boundingBox();
    expect(before!.y + before!.height).toBeLessThanOrEqual(pillBefore!.y);
    expect(before!.height).toBeLessThanOrEqual(DESKTOP.height * 0.6 + 2);
    await page.locator('.ct-agents-search-btn').click();
    const after = await sheet(page).boundingBox();
    const pillAfter = await page.locator('.ct-kanban-dispatch').boundingBox();
    expect(pillAfter!.y).toBeLessThan(pillBefore!.y);
    expect(after!.y + after!.height).toBeLessThanOrEqual(pillAfter!.y);
  });

  test('narrow: a bottom sheet with a grab handle, 44px targets, inside the viewport', async ({ page }) => {
    await open(page, 'idle', 'conversation', NARROW);
    await page.locator('.ct-orch-orb').click();
    const box = await sheet(page).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(NARROW.width + 1);
    expect(Math.round(box!.y + box!.height)).toBe(NARROW.height);
    await expect(page.locator('.ct-orch-sheet-handle')).toBeVisible();
    for (const sel of ['.ct-orch-sheet-head button', '.ct-orch-send']) {
      for (const b of await page.locator(sel).all()) {
        if (!(await b.isVisible())) continue;
        const bb = await b.boundingBox();
        expect(bb!.height, sel).toBeGreaterThanOrEqual(44);
        expect(bb!.width, sel).toBeGreaterThanOrEqual(44);
      }
    }
  });

  test('wide: error — the field shows the reason, and the orb opens the transcript', async ({ page }) => {
    await open(page, 'error', 'conversation', DESKTOP);
    await expect(field(page)).toHaveCount(0);
    await page.locator('.ct-orch-orb').click();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page)).toContainText('What needs me right now?');
  });

  test('the sheet is a labelled dialog with a polite live region; streaming bubble itself is not announced', async ({ page }) => {
    await open(page, 'working', 'conversation', DESKTOP);
    await page.evaluate(() => (window as any).__orchStream('partial', 'Working'));
    await field(page).click();
    await expect(page.getByRole('dialog', { name: 'Portfolio orchestrator' })).toBeVisible();
    await expect(page.locator('.ct-orch-live')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('[data-streaming]')).toHaveAttribute('aria-live', 'off');
  });

  test('contrast: sheet text meets 4.5:1 against its background (dark harness theme)', async ({ page }) => {
    await open(page, 'idle', 'rich', DESKTOP);
    await page.evaluate(() => (window as any).__orchQueue('held message'));
    await field(page).click();
    const ratios = await page.evaluate(() => {
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
      const parse = (c: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
      const lum = ([r, g, b]: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const bgOf = (el: Element): number[] => { for (let n: Element | null = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c.length === 3 || (c.length === 4 && c[3] > 0.95)) return c; } return [30, 30, 30]; };
      const out: Record<string, number> = {};
      for (const sel of ['.ct-orch-sheet-head h2', '.ct-orch-sheet-log > [data-role="user"] .ct-message-content', '.ct-orch-sheet-log > [data-role="assistant"] .ct-message-content', '.ct-orch-waiting', '.ct-orch-sheet-head button']) {
        const el = document.querySelector(sel); if (!el) continue;
        const fg = parse(getComputedStyle(el).color); const bg = bgOf(el);
        const [L1, L2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
        out[sel] = (L1 + 0.05) / (L2 + 0.05);
      }
      return out;
    });
    for (const [sel, r] of Object.entries(ratios)) expect(r, sel).toBeGreaterThanOrEqual(4.5);
  });

  test('QA D2/D6: a long code line scrolls inside the bubble; tables scroll and never break words', async ({ page }) => {
    await open(page, 'idle', 'rich', DESKTOP);
    await field(page).click();
    const m = await page.evaluate(() => {
      const scroll = document.querySelector('.ct-orch-sheet-scroll') as HTMLElement;
      const pre = document.querySelector('.ct-message-content pre') as HTMLElement;
      const bubble = pre.closest('.ct-message-content') as HTMLElement;
      const th = [...document.querySelectorAll('.ct-message-content th')].find((e) => e.textContent === 'Owner') as HTMLElement;
      const lh = parseFloat(getComputedStyle(th).lineHeight) || 20;
      return {
        scrollOverflow: scroll.scrollWidth - scroll.clientWidth,
        preScrolls: pre.scrollWidth > pre.clientWidth,
        preOverflowX: getComputedStyle(pre).overflowX,
        preInside: pre.getBoundingClientRect().right <= bubble.getBoundingClientRect().right + 1,
        ownerOneLine: th.getBoundingClientRect().height < lh * 2,
      };
    });
    expect(m.scrollOverflow).toBeLessThanOrEqual(0);
    expect(m.preScrolls).toBe(true);
    expect(m.preOverflowX).toBe('auto');
    expect(m.preInside).toBe(true);
    expect(m.ownerOneLine).toBe(true);
  });

  for (const { label, size } of SIZES) {
    test(`QA D1: opening a long transcript lands on the latest message @ ${label}`, async ({ page }) => {
      await open(page, 'idle', 'conversation', size);
      await page.evaluate(() => { for (let i = 0; i < 16; i++) (window as any).__orchSay(`Reply number ${i} with enough words to take a line or two in the sheet.`); });
      await focusComposer(page, size);
      await expect(sheet(page)).toBeVisible();
      await expect.poll(() => page.locator('.ct-orch-sheet-scroll').evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThanOrEqual(1);
      await page.locator('.ct-orch-sheet-scroll').evaluate((e) => { e.scrollTop = 0; });
      await send(page, size, 'and now?');
      await expect.poll(() => page.locator('.ct-orch-sheet-scroll').evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThanOrEqual(1);
    });
  }

  test('B1 (harness mocks): a [[note]] opens in a NEW tab (never the board leaf) when it resolves, an unresolved one opens nothing, and the board and sheet stay', async ({ page }) => {
    await open(page, 'idle', 'rich', DESKTOP);
    await field(page).click();
    const notes = page.locator('.ct-orch-sheet a.internal-link:not([data-href^="thread:"])');
    await expect(notes).toHaveCount(2);
    await notes.filter({ hasText: 'Real note' }).click();
    expect(await page.evaluate(() => (window as any).__openedLinks)).toEqual([{ via: 'workspace', href: 'Real note', sourcePath: '', newLeaf: 'tab' }]);
    await expect(sheet(page)).toBeVisible();
    await expect(page.locator('.ct-kanban-board')).toBeVisible();
    await notes.filter({ hasText: 'Ghost note' }).click();
    expect((await page.evaluate(() => (window as any).__openedLinks)).length).toBe(1);
  });

  test('N1: streaming_start + a long first token in the same task keeps the sheet pinned to the bottom', async ({ page }) => {
    for (const size of [DESKTOP, NARROW]) {
      await open(page, 'idle', 'conversation', size);
      await focusComposer(page, size);
      await expect(sheet(page)).toBeVisible();
      await page.evaluate(() => (window as any).__orchStream('A long first token. '.repeat(40), 'Working'));
      await expect.poll(() => page.locator('.ct-orch-sheet-scroll').evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThanOrEqual(1);
      await page.evaluate(() => (window as any).__orchStream(' and more', 'Working'));
      await expect.poll(() => page.locator('.ct-orch-sheet-scroll').evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThanOrEqual(1);
    }
  });

  test('N4: a slow wheel scroll-up (-12px per frame) while tokens stream every 40ms stays where the user put it', async ({ page }) => {
    await open(page, 'working', 'conversation', DESKTOP);
    await page.evaluate(() => { for (let i = 0; i < 20; i++) (window as any).__orchSay(`Earlier reply ${i} with a few words so the sheet scrolls.`); });
    await field(page).click();
    await expect(sheet(page)).toBeVisible();
    await page.evaluate(() => { (window as any).__orchStream('Streaming '); (window as any).__tokTimer = setInterval(() => (window as any).__orchToken('more tokens arrive here '), 40); });
    const box = await page.locator('.ct-orch-sheet-scroll').boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    const frames = 20;
    for (let i = 0; i < frames; i++) {
      await page.mouse.wheel(0, -12);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
      await page.waitForTimeout(25);
    }
    const distance = await page.locator('.ct-orch-sheet-scroll').evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop);
    await page.evaluate(() => clearInterval((window as any).__tokTimer));
    expect(distance).toBeGreaterThanOrEqual(12 * frames * 0.8);
  });

  test('N5: resizing 390 -> 700 with the sheet open never drops focus to the page', async ({ page }) => {
    await open(page, 'idle', 'conversation', NARROW);
    await page.locator('.ct-orch-orb').click();
    await expect(sheet(page)).toBeVisible();
    await page.locator('.ct-orch-send').focus();
    await page.setViewportSize({ width: 700, height: 800 });
    await expect(page.locator('.ct-orch-dock')).toHaveAttribute('data-mode', 'pill');
    await expect(field(page)).toBeFocused();
  });

  for (const { label, size } of SIZES) {
    test(`QA N6: back to the exact bottom while the stream is idle, then tokens resume: follows @ ${label}`, async ({ page }) => {
      await open(page, 'working', 'conversation', size);
      await page.evaluate(() => { for (let i = 0; i < 20; i++) (window as any).__orchSay(`Earlier reply ${i} with a few words so the sheet scrolls.`); });
      await focusComposer(page, size);
      await expect(sheet(page)).toBeVisible();
      await page.evaluate(() => (window as any).__orchStream('Streaming '));
      const box = (await page.locator('.ct-orch-sheet-scroll').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -300);
      await page.waitForTimeout(100);
      await page.mouse.wheel(0, 5000);
      await page.waitForTimeout(100);
      await page.evaluate(() => (window as any).__orchToken('tokens resume here '.repeat(20)));
      await expect.poll(() => page.locator('.ct-orch-sheet-scroll').evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThanOrEqual(1);
    });
  }

  test('QA N7: End during fast streaming (tokens with paragraph breaks) re-pins and keeps following', async ({ page }) => {
    await open(page, 'working', 'conversation', DESKTOP);
    await page.evaluate(() => { for (let i = 0; i < 20; i++) (window as any).__orchSay(`Earlier reply ${i} with a few words so the sheet scrolls.`); });
    await field(page).click();
    await page.evaluate(() => { (window as any).__orchStream('Start. '); (window as any).__tokTimer = setInterval(() => (window as any).__orchToken('Some streamed words here.\n\nNext paragraph begins. '), 80); });
    const box = (await page.locator('.ct-orch-sheet-scroll').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(150);
    await page.locator('.ct-orch-sheet-scroll').focus();
    await page.keyboard.press('End');
    await page.waitForTimeout(550);
    const distance = await page.locator('.ct-orch-sheet-scroll').evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop);
    await page.evaluate(() => clearInterval((window as any).__tokTimer));
    expect(distance).toBeLessThanOrEqual(2);
  });

  test('QA N9: End with focus on a thread link inside the log re-pins during fast streaming', async ({ page }) => {
    await open(page, 'working', 'conversation', DESKTOP);
    await page.evaluate(() => { for (let i = 0; i < 20; i++) (window as any).__orchSay(`Earlier reply ${i} see [[thread:k-orchestrator|Portfolio Orchestrator]]`); });
    await field(page).click();
    await page.evaluate(() => { (window as any).__orchStream('Start. '); (window as any).__tokTimer = setInterval(() => (window as any).__orchToken('word '.repeat(12) + '\n\n'), 30); });
    const box = (await page.locator('.ct-orch-sheet-scroll').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(150);
    await page.locator('.ct-orch-sheet-scroll a.internal-link[data-href^="thread:"]').first().focus();
    await page.keyboard.press('End');
    await page.waitForTimeout(450);
    const distance = await page.locator('.ct-orch-sheet-scroll').evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop);
    await page.evaluate(() => clearInterval((window as any).__tokTimer));
    expect(distance).toBeLessThanOrEqual(2);
  });

  test('N2: narrow, Enter on the focused orb opens the sheet and typing lands in the composer', async ({ page }) => {
    await open(page, 'idle', 'conversation', NARROW);
    await page.locator('.ct-orch-orb').focus();
    await page.keyboard.press('Enter');
    await expect(sheet(page)).toBeVisible();
    await page.keyboard.type('typed with no click');
    await expect(field(page)).toHaveValue('typed with no click');
  });

  test('QA D5/D4: desktop Tab from the field reaches the sheet next; chips are reachable and stay visible', async ({ page }) => {
    await open(page, 'idle', 'conversation', DESKTOP);
    await field(page).click();
    await expect(sheet(page)).toBeVisible();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.ct-orch-sheet'))).toBe(true);
    await open(page, 'attention', 'empty', DESKTOP);
    await field(page).focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('.ct-orch-chips')).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement?.closest('.ct-orch-chips'))).toBe(true);
  });

  test('QA D5: narrow, Tab stays inside the modal bottom sheet', async ({ page }) => {
    await open(page, 'idle', 'conversation', NARROW);
    await page.locator('.ct-orch-orb').click();
    await expect(sheet(page)).toHaveAttribute('aria-modal', 'true');
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('.ct-orch-sheet'))).toBe(true);
    }
  });

  test('focus-visible ring on sheet controls', async ({ page }) => {
    await open(page, 'idle', 'conversation', DESKTOP);
    await field(page).click();
    await page.locator('.ct-orch-sheet-head button').first().focus();
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    const outline = await page.locator('.ct-orch-sheet-head button').first().evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe('none');
  });
});

import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

/**
 * K2 OrchestratorDock P3 (the reply sheet). Served from test/harness/kanban.html.
 *   ?orch=idle|working|error|offline ...   as in orchestrator-dock.spec.ts
 *   &tx=empty|conversation                 seeds the orchestrator transcript (default: one short assistant line)
 * Harness hooks (window): __orchSay, __orchStream, __orchSettle, __orchQueue, __orchTool, __openSheet, __sentMessages,
 * __interruptCalls, __openedThreadIds. The harness sendMessage appends the user message and emits
 * `user_message_added` like the real manager; interrupt rolls unresolved user messages back with no per-message event.
 * Visual specs carry baselines (6 states, both widths); behaviour specs carry none.
 */
const kanbanUrl = 'file://' + path.resolve('test/harness/kanban.html');
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
/** Wide: the pill's field is the composer. Narrow: tap the orb, the bottom sheet hosts the textarea. */
async function focusComposer(page: Page, size: { width: number }) {
  if (isNarrow(size)) await page.locator('.ct-orch-orb').click(); else await field(page).click();
}
async function send(page: Page, size: { width: number }, text: string) {
  if (isNarrow(size) && !(await sheet(page).isVisible())) await page.locator('.ct-orch-orb').click();
  await field(page).fill(text);
  await page.keyboard.press('Enter');
}

test.describe('orchestrator sheet — screenshots', () => {
  for (const { label, size } of SIZES) {
    test(`focused, empty transcript: suggestion chips @ ${label}`, async ({ page }) => {
      await open(page, 'attention', 'empty', size);
      if (isNarrow(size)) await page.locator('.ct-orch-orb').click(); else await field(page).focus();
      await expect(page.locator(isNarrow(size) ? '.ct-orch-sheet .ct-orch-empty button' : '.ct-orch-chips button').first()).toBeVisible();
      await shot(page, `orchestrator-sheet-chips-${label}.png`);
    });

    test(`streaming reply with activity line and Stop @ ${label}`, async ({ page }) => {
      await open(page, 'working', 'conversation', size);
      await page.evaluate(() => (window as any).__orchStream('Two things are waiting on you:', 'Reading 14 threads · checking pending approvals…'));
      await focusComposer(page, size);
      await expect(sheet(page)).toBeVisible();
      await expect(page.locator('.ct-orch-stop')).toBeVisible();
      await shot(page, `orchestrator-sheet-streaming-${label}.png`);
    });

    test(`conversation with thread links and a waiting-to-send list @ ${label}`, async ({ page }) => {
      await open(page, 'idle', 'conversation', size);
      await page.evaluate(() => (window as any).__orchQueue('ship it after the plan'));
      await focusComposer(page, size);
      await expect(page.locator('.ct-orch-sheet a.ct-thread-link').first()).toBeVisible();
      await expect(page.locator('.ct-orch-waiting')).toBeVisible();
      await shot(page, `orchestrator-sheet-conversation-${label}.png`);
    });

    test(`unread reply: peek above the pill and the dot @ ${label}`, async ({ page }) => {
      await open(page, 'idle', 'conversation', size);
      await page.evaluate(() => (window as any).__orchSay('Deploy approval and 1 mobile question need you.'));
      await expect(page.locator('.ct-orch-peek')).toBeVisible();
      await shot(page, `orchestrator-sheet-unread-${label}.png`);
    });

    test(`offline with the sheet open: reason + action, input disabled @ ${label}`, async ({ page }) => {
      await open(page, 'offline', 'conversation', size);
      await page.evaluate(() => (window as any).__openSheet());
      await expect(sheet(page)).toBeVisible();
      await expect(page.locator('.ct-orch-reason').first()).toBeVisible();
      await shot(page, `orchestrator-sheet-offline-${label}.png`);
    });
  }
});

test.describe('orchestrator sheet — functional (no baselines)', () => {
  for (const { label, size } of SIZES) {
    test(`stays open when the board is clicked; Esc closes and focus returns @ ${label}`, async ({ page }) => {
      await open(page, 'idle', 'conversation', size);
      await focusComposer(page, size);
      await expect(sheet(page)).toBeVisible();
      await page.locator('.ct-kanban-board').click({ position: { x: 60, y: 120 } });
      await expect(sheet(page)).toBeVisible();
      if (isNarrow(size)) await field(page).focus(); else await field(page).focus();
      await page.keyboard.press('Escape');
      await expect(sheet(page)).toBeHidden();
      await expect(isNarrow(size) ? page.locator('.ct-orch-orb') : field(page)).toBeFocused();
    });

    test(`Enter sends once, opens the sheet, and never opens the thread @ ${label}`, async ({ page }) => {
      await open(page, 'idle', 'empty', size);
      await send(page, size, 'What needs me?');
      await expect(sheet(page)).toBeVisible();
      await expect(page.locator('.ct-orch-msg[data-role="user"]')).toContainText('What needs me?');
      expect(await page.evaluate(() => (window as any).__sentMessages)).toEqual([expect.objectContaining({ text: 'What needs me?' })]);
      expect(await page.evaluate(() => (window as any).__openedThreadIds.length)).toBe(0);
    });

    test(`rapid Enter does not double-send @ ${label}`, async ({ page }) => {
      await open(page, 'idle', 'empty', size);
      if (isNarrow(size)) await page.locator('.ct-orch-orb').click();
      await field(page).fill('only once');
      await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
      await expect(page.locator('.ct-orch-msg[data-role="user"]')).toHaveCount(1);
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
      await expect(page.locator('.ct-orch-msg[data-role="user"]', { hasText: 'this will be rolled back' })).toBeVisible();
      await page.locator('.ct-orch-stop').click();
      await expect(page.locator('.ct-orch-msg[data-role="user"]', { hasText: 'this will be rolled back' })).toHaveCount(0);
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
      await page.locator('.ct-orch-sheet a.ct-thread-link').first().click();
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
    await open(page, 'idle', 'conversation', DESKTOP);
    await page.evaluate(() => (window as any).__orchQueue('held message'));
    await field(page).click();
    const ratios = await page.evaluate(() => {
      // Computed colours may be `color(srgb ...)` (color-mix): rasterise through a canvas to get plain RGBA.
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
      const parse = (c: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
      const lum = ([r, g, b]: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const bgOf = (el: Element): number[] => { for (let n: Element | null = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c.length === 3 || (c.length === 4 && c[3] > 0.95)) return c; } return [30, 30, 30]; };
      const out: Record<string, number> = {};
      for (const sel of ['.ct-orch-sheet-head h2', '.ct-orch-msg[data-role="user"] .ct-orch-bubble', '.ct-orch-msg[data-role="assistant"] .ct-orch-bubble', '.ct-orch-waiting', '.ct-orch-sheet a.ct-thread-link', '.ct-orch-sheet-head button']) {
        const el = document.querySelector(sel); if (!el) continue;
        const fg = parse(getComputedStyle(el).color); const bg = bgOf(el);
        const [L1, L2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
        out[sel] = (L1 + 0.05) / (L2 + 0.05);
      }
      return out;
    });
    for (const [sel, r] of Object.entries(ratios)) expect(r, sel).toBeGreaterThanOrEqual(4.5);
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

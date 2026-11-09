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
 * Visual specs carry baselines (5 states x 2 widths = 10); behaviour specs carry none.
 */
const kanbanUrl = 'file://' + path.resolve('test/harness/kanban.html');
// Same pin as ui.spec.ts / orchestrator-dock.spec.ts: the board's relative "Xd ago" chips drift with the wall clock.
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
});

const DESKTOP = { width: 1280, height: 800 };
const NARROW = { width: 390, height: 844 };
/** Same tight per-pixel colour tolerance as the P2 dock shots (Playwright's default 0.2 hides tint changes). */
const DOCK_SHOT = { threshold: 0.05 } as const;
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
      await shot(page, `orchestrator-sheet-chips-${label}.png`, DOCK_SHOT);
    });

    test(`streaming reply with activity line and Stop @ ${label}`, async ({ page }) => {
      await open(page, 'working', 'conversation', size);
      await page.evaluate(() => (window as any).__orchStream('Two things are waiting on you:', 'Reading 14 threads · checking pending approvals…'));
      await focusComposer(page, size);
      await expect(sheet(page)).toBeVisible();
      await expect(page.locator('.ct-orch-stop')).toBeVisible();
      await shot(page, `orchestrator-sheet-streaming-${label}.png`, DOCK_SHOT);
    });

    test(`conversation with thread links and a waiting-to-send list @ ${label}`, async ({ page }) => {
      await open(page, 'idle', 'conversation', size);
      await page.evaluate(() => (window as any).__orchQueue('ship it after the plan'));
      await focusComposer(page, size);
      await expect(page.locator('.ct-orch-sheet a.ct-thread-link').first()).toBeVisible();
      await expect(page.locator('.ct-orch-waiting')).toBeVisible();
      await shot(page, `orchestrator-sheet-conversation-${label}.png`, DOCK_SHOT);
    });

    test(`unread reply: peek above the pill and the dot @ ${label}`, async ({ page }) => {
      await open(page, 'idle', 'conversation', size);
      await page.evaluate(() => (window as any).__orchSay('Deploy approval and 1 mobile question need you.'));
      await expect(page.locator('.ct-orch-peek')).toBeVisible();
      await shot(page, `orchestrator-sheet-unread-${label}.png`, DOCK_SHOT);
    });

    test(`offline with the sheet open: reason + action, input disabled @ ${label}`, async ({ page }) => {
      await open(page, 'offline', 'conversation', size);
      await page.evaluate(() => (window as any).__openSheet());
      await expect(sheet(page)).toBeVisible();
      await expect(page.locator('.ct-orch-reason').first()).toBeVisible();
      await shot(page, `orchestrator-sheet-offline-${label}.png`, DOCK_SHOT);
    });
  }
});

test.describe('orchestrator sheet — functional (no baselines)', () => {
  for (const { label, size } of SIZES) {
    test(`stays open when the board is clicked; Esc closes and focus returns @ ${label}`, async ({ page }) => {
      await open(page, 'idle', 'conversation', size);
      await focusComposer(page, size);
      await expect(sheet(page)).toBeVisible();
      // A raw mouse click at a board position: on narrow the board is inert behind the modal sheet, so an element click would wait forever.
      await page.mouse.click(60, 120);
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
    await open(page, 'idle', 'rich', DESKTOP);
    await page.evaluate(() => (window as any).__orchQueue('held message'));
    await field(page).click();
    const ratios = await page.evaluate(() => {
      // Computed colours may be `color(srgb ...)` (color-mix): rasterise through a canvas to get plain RGBA.
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
      const parse = (c: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
      const lum = ([r, g, b]: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const bgOf = (el: Element): number[] => { for (let n: Element | null = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c.length === 3 || (c.length === 4 && c[3] > 0.95)) return c; } return [30, 30, 30]; };
      const out: Record<string, number> = {};
      for (const sel of ['.ct-orch-sheet-head h2', '.ct-orch-msg[data-role="user"] .ct-orch-bubble', '.ct-orch-msg[data-role="assistant"] .ct-orch-bubble', '.ct-orch-waiting', '.ct-orch-sheet a.ct-thread-link', '.ct-orch-sheet-head button', '.ct-orch-bubble a:not(.ct-thread-link)']) {
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
      const pre = document.querySelector('.ct-orch-bubble pre') as HTMLElement;
      const bubble = pre.closest('.ct-orch-bubble') as HTMLElement;
      const th = [...document.querySelectorAll('.ct-orch-bubble th')].find((e) => e.textContent === 'Owner') as HTMLElement;
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

  test('N3: an untrusted reply makes ZERO requests to a remote host (markdown img, raw img, video poster, srcset, svg image, style url)', async ({ page }) => {
    const hits: string[] = [];
    await page.route(/evil\.example/, (route) => { hits.push(route.request().url()); return route.abort(); });
    page.on('request', (r) => { if (r.url().includes('evil.example')) hits.push(`seen:${r.url()}`); });
    await open(page, 'idle', 'evil', DESKTOP);
    await field(page).click();
    await expect(page.locator('.ct-orch-bubble').filter({ hasText: 'Evil reply text.' })).toBeVisible();
    await expect(page.locator('.ct-orch-bubble').filter({ hasText: 'styled' })).toBeVisible();
    await page.waitForTimeout(800);
    expect(hits).toEqual([]);
    expect(await page.locator('.ct-orch-sheet img, .ct-orch-sheet video, .ct-orch-sheet picture, .ct-orch-sheet svg image, .ct-orch-sheet [style*="url("]').count()).toBe(0);
  });

  test('B1 (harness mocks): a resolvable [[note]] opens in a NEW tab, an unresolved one is inert, and the board and sheet stay', async ({ page }) => {
    await open(page, 'idle', 'rich', DESKTOP);
    await field(page).click();
    await expect(page.locator('.ct-orch-sheet a.internal-link')).toHaveCount(1);
    await expect(page.locator('.ct-orch-sheet .ct-orch-wikilink-unresolved')).toHaveText('Ghost note');
    await page.locator('.ct-orch-sheet a.internal-link').click();
    expect(await page.evaluate(() => (window as any).__openedLinks)).toEqual([{ via: 'workspace', href: 'Real note', sourcePath: '', newLeaf: 'tab' }]);
    await expect(sheet(page)).toBeVisible();
    await expect(page.locator('.ct-kanban-board')).toBeVisible();
    await page.locator('.ct-orch-sheet .ct-orch-wikilink-unresolved').click();
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
    const frames = 40; // ~2s
    for (let i = 0; i < frames; i++) {
      await page.mouse.wheel(0, -12);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
      await page.waitForTimeout(30);
    }
    const distance = await page.locator('.ct-orch-sheet-scroll').evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop);
    await page.evaluate(() => clearInterval((window as any).__tokTimer));
    // The user moved up 12px x 40 frames; the stream growing below must not have pulled them back toward the bottom.
    expect(distance).toBeGreaterThanOrEqual(12 * frames * 0.8);
  });

  test('N5: resizing 390 -> 700 with the sheet open never drops focus to the page', async ({ page }) => {
    await open(page, 'idle', 'conversation', NARROW);
    await page.locator('.ct-orch-orb').click();
    await expect(sheet(page)).toBeVisible();
    await page.locator('.ct-orch-send').focus();
    await page.setViewportSize({ width: 700, height: 800 });
    await expect(page.locator('.ct-orch-dock')).toHaveAttribute('data-mode', 'pill');
    expect(await page.evaluate(() => document.activeElement && document.activeElement !== document.body)).toBe(true);
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

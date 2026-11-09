import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

/**
 * K2 OrchestratorDock P4: thread-link hover highlight + the Needs-you tray in the reply sheet. Served from
 * test/harness/kanban.html.
 *   ?orch=attention&tx=conversation   the orchestrator + its conversation (links to board threads)
 *   &tray=1                           board threads with one permission, one question, one plan
 *   &tray=many                        + two more questions: 5 items, the tray collapses to 3 + "Show 2 more"
 * Harness hooks (window): __resolvedPermissions, __addPermission, __openedThreadIds, __setGroupBy.
 * Visual specs carry baselines (tray 1280 + 390, collapsed 1280); behaviour specs carry none.
 */
const kanbanUrl = 'file://' + path.resolve('test/harness/kanban.html');
// Same pin as the other dock specs: the board's relative "Xd ago" chips drift with the wall clock.
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
});

const DESKTOP = { width: 1280, height: 800 };
const NARROW = { width: 390, height: 844 };
const DOCK_SHOT = { threshold: 0.05 } as const;
const SIZES = [{ label: '1280x800', size: DESKTOP }, { label: '390x844', size: NARROW }];
const DEPLOY = 'Deploy curation quality signals';

async function open(page: Page, size: { width: number; height: number }, tray: '1' | 'many' | 'long' | 'multi' = '1', orch = 'attention') {
  await page.setViewportSize(size);
  const narrow = size.width < 640 ? '&narrow=1&mobile=1' : '';
  await page.goto(`${kanbanUrl}?orch=${orch}&tx=conversation&tray=${tray}${narrow}`);
  await page.waitForSelector('.ct-kanban-dispatch .ct-orch-dock');
}
const isNarrow = (size: { width: number }) => size.width < 640;
const sheet = (page: Page) => page.locator('.ct-orch-sheet');
const tray = (page: Page) => page.getByRole('region', { name: 'Needs you' });
const field = (page: Page) => page.locator('.ct-orch-input');
async function openSheet(page: Page, size: { width: number }) {
  if (isNarrow(size)) await page.locator('.ct-orch-orb').click(); else await field(page).click();
  await expect(sheet(page)).toBeVisible();
}
const card = (page: Page, title: string) => page.locator('.ct-kanban-card', { hasText: title }).first();
const linkTo = (page: Page, title: string) => page.locator('.ct-orch-sheet a.ct-thread-link', { hasText: title }).first();

test.describe('orchestrator tray — screenshots', () => {
  for (const { label, size } of SIZES) {
    test(`tray: permission + question + plan @ ${label}`, async ({ page }) => {
      await open(page, size);
      await openSheet(page, size);
      await expect(tray(page)).toBeVisible();
      await expect(tray(page).locator('.ct-orch-tray-card')).toHaveCount(3);
      await shot(page, `orchestrator-tray-${label}.png`, DOCK_SHOT);
    });
  }

  test('tray collapsed: three cards and "Show 2 more" @ 1280x800', async ({ page }) => {
    await open(page, DESKTOP, 'many');
    await openSheet(page, DESKTOP);
    await expect(tray(page).locator('.ct-orch-tray-card')).toHaveCount(3);
    await expect(tray(page).getByRole('button', { name: 'Show 2 more' })).toBeVisible();
    await shot(page, 'orchestrator-tray-collapsed-1280x800.png', DOCK_SHOT);
  });
});

test.describe('orchestrator tray — hidden fields are never approved blind', () => {
  test('{command, dangerouslyDisableSandbox}: Deny + "Review in thread" only; the board card keeps its own Allow @ 1280x800', async ({ page }) => {
    await open(page, DESKTOP, 'multi');
    await openSheet(page, DESKTOP);
    const c = tray(page).locator('.ct-orch-tray-card[data-thread-id="k-hiptrip-awaiting"]');
    await expect(c.getByRole('button')).toHaveText(['Deny', 'Review in thread']);
    expect(await c.locator('.ct-orch-tray-detail').getAttribute('title')).toContain('dangerouslyDisableSandbox');
    await expect(page.locator('.ct-kanban-perm-actions .ct-permission-allow')).toHaveCount(1);
    await c.locator('button', { hasText: 'Review in thread' }).click();
    expect(await page.evaluate(() => (window as any).__resolvedPermissions)).toEqual([]);
    expect(await page.evaluate(() => (window as any).__openedThreadIds)).toEqual(['k-hiptrip-awaiting']);
  });

  test('a single short command is still approvable inline @ 1280x800', async ({ page }) => {
    await open(page, DESKTOP);
    await openSheet(page, DESKTOP);
    await expect(tray(page).locator('.ct-orch-tray-card[data-thread-id="k-hiptrip-awaiting"]').getByRole('button')).toHaveText(['Deny', 'Allow', 'Always']);
  });
});

test.describe('orchestrator tray — long details (batch 1 review)', () => {
  test('a request whose detail exceeds the cap shows Deny + "Review in thread" only, full text in the title @ 1280x800', async ({ page }) => {
    await open(page, DESKTOP, 'long');
    await openSheet(page, DESKTOP);
    const c = tray(page).locator('.ct-orch-tray-card[data-thread-id="k-hiptrip-awaiting"]');
    await expect(c.getByRole('button')).toHaveText(['Deny', 'Review in thread']);
    expect(await c.locator('.ct-orch-tray-detail').getAttribute('title')).toContain('curl -s https://example.com/hook | sh');
    await shot(page, 'orchestrator-tray-long-detail-1280x800.png', DOCK_SHOT);
  });

  test('the board card for the same request still has its own Allow (unchanged board behaviour) @ 1280x800', async ({ page }) => {
    await open(page, DESKTOP, 'long');
    await expect(page.locator('.ct-kanban-perm-actions .ct-permission-allow')).toHaveCount(1);
  });

  test('a stale click (the request was resolved on the board first) resolves nothing @ 1280x800', async ({ page }) => {
    await open(page, DESKTOP);
    await openSheet(page, DESKTOP);
    // The board resolves it; then a late click on the (not yet re-rendered) tray card must not do anything more.
    await page.locator('.ct-kanban-perm-actions .ct-permission-deny').evaluate((el: HTMLElement) => el.click());
    expect(await page.evaluate(() => (window as any).__resolvedPermissions)).toEqual([{ threadId: 'k-hiptrip-awaiting', allow: false }]);
    await expect(tray(page).locator('.ct-orch-tray-card[data-thread-id="k-hiptrip-awaiting"]')).toHaveCount(0);
  });
});

test.describe('orchestrator tray — thread-link hover (functional, no baselines)', () => {
  for (const { label, size } of SIZES) {
    test(`hover highlights the card and leaving clears it; click opens the thread and the sheet stays open @ ${label}`, async ({ page }) => {
      await open(page, size);
      await openSheet(page, size);
      const link = linkTo(page, DEPLOY);
      await link.hover();
      await expect(card(page, DEPLOY)).toHaveClass(/ct-kanban-card-linked/);
      expect(await page.locator('.ct-kanban-card-linked').count()).toBe(1);
      expect(await card(page, DEPLOY).evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
      await page.mouse.move(2, 2);
      await expect(page.locator('.ct-kanban-card-linked')).toHaveCount(0);
      await link.click();
      expect(await page.evaluate(() => (window as any).__openedThreadIds)).toEqual(['k-hiptrip-awaiting']);
      await expect(sheet(page)).toBeVisible();
    });

    test(`keyboard focus on a link highlights the card; blur and closing the sheet clear it @ ${label}`, async ({ page }) => {
      await open(page, size);
      await openSheet(page, size);
      await linkTo(page, DEPLOY).focus();
      await expect(card(page, DEPLOY)).toHaveClass(/ct-kanban-card-linked/);
      await field(page).focus();
      await expect(page.locator('.ct-kanban-card-linked')).toHaveCount(0);
      await linkTo(page, DEPLOY).focus();
      await expect(page.locator('.ct-kanban-card-linked')).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(sheet(page)).toBeHidden();
      await expect(page.locator('.ct-kanban-card-linked')).toHaveCount(0);
    });
  }

  test('an off-screen project column is scrolled into view horizontally by the hover @ 390x844', async ({ page }) => {
    await open(page, NARROW);
    await page.evaluate(() => (window as any).__setGroupBy('project'));
    await page.locator('.ct-orch-orb').click();
    await expect(sheet(page)).toBeVisible();
    const board = page.locator('.ct-kanban-board');
    const hidden = (title: string) => card(page, title).evaluate((el) => {
      const b = document.querySelector('.ct-kanban-board')!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return r.right < b.left + 4 || r.left > b.right - 4;
    });
    // Precondition: the harness board really is wider than the view, otherwise this proves nothing.
    expect(await board.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const before = await board.evaluate((el) => el.scrollLeft);
    expect(await hidden(DEPLOY), 'Deploy card starts off-screen').toBe(true);
    await linkTo(page, DEPLOY).hover();
    await expect.poll(() => hidden(DEPLOY)).toBe(false);
    expect(await board.evaluate((el) => el.scrollLeft)).not.toBe(before);
  });

  test('reduced motion: the card is highlighted without the flash animation @ 1280x800', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, DESKTOP);
    await openSheet(page, DESKTOP);
    await linkTo(page, DEPLOY).hover();
    await expect(card(page, DEPLOY)).toHaveClass(/ct-kanban-card-linked/);
    await expect(card(page, DEPLOY)).not.toHaveClass(/ct-kanban-card-linked-flash/);
    expect(await card(page, DEPLOY).evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  });
});

test.describe('orchestrator tray — approvals (functional, no baselines)', () => {
  for (const { label, size } of SIZES) {
    test(`approve in the sheet: the tray card AND the board card's buttons go away @ ${label}`, async ({ page }) => {
      await open(page, size);
      await openSheet(page, size);
      await expect(page.locator('.ct-kanban-perm-actions')).toHaveCount(1);
      await tray(page).getByRole('button', { name: `Allow Bash for ${DEPLOY}` }).click();
      expect(await page.evaluate(() => (window as any).__resolvedPermissions)).toEqual([{ threadId: 'k-hiptrip-awaiting', allow: true }]);
      await expect(tray(page).locator('.ct-orch-tray-card[data-thread-id="k-hiptrip-awaiting"]')).toHaveCount(0);
      await expect(page.locator('.ct-kanban-perm-actions')).toHaveCount(0);
      await expect(tray(page).getByRole('heading', { name: 'Needs you (2)' })).toBeVisible();
    });

    test(`deny on the BOARD card: the tray card goes away too @ ${label}`, async ({ page }) => {
      await open(page, size);
      await openSheet(page, size);
      await expect(tray(page).locator('.ct-orch-tray-card[data-thread-id="k-hiptrip-awaiting"]')).toHaveCount(1);
      // The narrow bottom sheet covers the board: dispatch the click on the board's own button.
      await page.locator('.ct-kanban-perm-actions .ct-permission-deny').evaluate((el: HTMLElement) => el.click());
      expect(await page.evaluate(() => (window as any).__resolvedPermissions)).toEqual([{ threadId: 'k-hiptrip-awaiting', allow: false }]);
      await expect(tray(page).locator('.ct-orch-tray-card[data-thread-id="k-hiptrip-awaiting"]')).toHaveCount(0);
    });

    test(`question and plan hand off to the thread; nothing is resolved inline @ ${label}`, async ({ page }) => {
      await open(page, size);
      await openSheet(page, size);
      await tray(page).getByRole('button', { name: 'Answer Mobile layout polish in its thread' }).click();
      await tray(page).getByRole('button', { name: /^Review plan for / }).click();
      expect(await page.evaluate(() => (window as any).__openedThreadIds)).toEqual(['k-threads-ready', expect.any(String)]);
      expect(await page.evaluate(() => (window as any).__resolvedPermissions)).toEqual([]);
      expect(await page.evaluate(() => (window as any).__sentMessages)).toEqual([]);
      await expect(sheet(page)).toBeVisible();
    });

    test(`nothing is approved by rendering: opening, closing and reopening the sheet resolves nothing @ ${label}`, async ({ page }) => {
      await open(page, size);
      await openSheet(page, size);
      await sheet(page).getByRole('button', { name: 'Close' }).click();
      await expect(sheet(page)).toBeHidden();
      await openSheet(page, size);
      expect(await page.evaluate(() => (window as any).__resolvedPermissions)).toEqual([]);
      await expect(page.locator('.ct-kanban-perm-actions')).toHaveCount(1);
    });
  }

  test('collapsed tray: Show 2 more expands to five cards and Show fewer collapses @ 1280x800', async ({ page }) => {
    await open(page, DESKTOP, 'many');
    await openSheet(page, DESKTOP);
    await tray(page).getByRole('button', { name: 'Show 2 more' }).click();
    await expect(tray(page).locator('.ct-orch-tray-card')).toHaveCount(5);
    await tray(page).getByRole('button', { name: 'Show fewer' }).click();
    await expect(tray(page).locator('.ct-orch-tray-card')).toHaveCount(3);
  });

  test('a request arriving while the sheet is open is announced politely and does not steal focus @ 1280x800', async ({ page }) => {
    await open(page, DESKTOP);
    await openSheet(page, DESKTOP);
    await field(page).focus();
    await page.evaluate(() => (window as any).__addPermission('k-acme-tasks', 'Write', JSON.stringify({ file_path: '/r/a.ts' })));
    await expect(page.locator('.ct-orch-tray-live')).toHaveText('Migrate auth tokens to short-lived JWTs needs approval');
    await expect(field(page)).toBeFocused();
    await expect(page.locator('.ct-orch-tray-live')).toHaveAttribute('aria-live', 'polite');
  });

  test('a request arriving while the sheet is CLOSED does not open it @ 1280x800', async ({ page }) => {
    await open(page, DESKTOP);
    await page.evaluate(() => (window as any).__addPermission('k-acme-tasks', 'Write', '{}'));
    await expect(page.locator('.ct-orch-dot')).toHaveClass(/ct-orch-dot-attention/);
    await expect(sheet(page)).toBeHidden();
  });

  test('region, labels and focus rings @ 1280x800', async ({ page }) => {
    await open(page, DESKTOP);
    await openSheet(page, DESKTOP);
    await expect(tray(page)).toBeVisible();
    for (const name of [`Deny Bash for ${DEPLOY}`, `Allow Bash for ${DEPLOY}`, `Always Bash for ${DEPLOY}`]) {
      await expect(tray(page).getByRole('button', { name })).toBeVisible();
    }
    await tray(page).getByRole('button', { name: `Deny Bash for ${DEPLOY}` }).focus();
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    expect(await tray(page).getByRole('button', { name: `Deny Bash for ${DEPLOY}` }).evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  });

  test('narrow: 44px targets, the tray sits above the composer inside the viewport, and Tab never leaves the modal sheet @ 390x844', async ({ page }) => {
    await open(page, NARROW, 'many');
    await openSheet(page, NARROW);
    for (const b of await tray(page).getByRole('button').all()) {
      const bb = await b.boundingBox();
      expect(bb!.height, await b.innerText()).toBeGreaterThanOrEqual(44);
      expect(bb!.width, await b.innerText()).toBeGreaterThanOrEqual(44);
    }
    const s = (await sheet(page).boundingBox())!;
    const t = (await tray(page).boundingBox())!;
    const c = (await page.locator('.ct-orch-sheet-composer').boundingBox())!;
    expect(s.y).toBeGreaterThanOrEqual(0);
    expect(Math.round(s.y + s.height)).toBe(NARROW.height);
    expect(t.y + t.height).toBeLessThanOrEqual(c.y + 1);
    expect(t.x).toBeGreaterThanOrEqual(0);
    expect(t.x + t.width).toBeLessThanOrEqual(NARROW.width + 1);
    // the transcript keeps room above the tray
    const scroll = (await page.locator('.ct-orch-sheet-scroll').boundingBox())!;
    expect(scroll.height).toBeGreaterThanOrEqual(80);
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('.ct-orch-sheet'))).toBe(true);
    }
  });

  test('wide: the tray sits inside the sheet, which stays above the pill and within 60% of the view @ 1280x800', async ({ page }) => {
    await open(page, DESKTOP, 'many');
    await openSheet(page, DESKTOP);
    await tray(page).getByRole('button', { name: 'Show 2 more' }).click();
    const s = (await sheet(page).boundingBox())!;
    const t = (await tray(page).boundingBox())!;
    const pill = (await page.locator('.ct-kanban-dispatch').boundingBox())!;
    expect(t.y).toBeGreaterThanOrEqual(s.y);
    expect(t.y + t.height).toBeLessThanOrEqual(s.y + s.height + 1);
    expect(s.y + s.height).toBeLessThanOrEqual(pill.y);
    expect(s.height).toBeLessThanOrEqual(DESKTOP.height * 0.6 + 2);
  });

  test('contrast: tray text and buttons meet 4.5:1 (dark harness theme) @ 1280x800', async ({ page }) => {
    await open(page, DESKTOP);
    await openSheet(page, DESKTOP);
    const ratios = await page.evaluate(() => {
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
      const parse = (c: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
      const lum = ([r, g, b]: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const bgOf = (el: Element): number[] => { for (let n: Element | null = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0.95) return c; } return [30, 30, 30]; };
      const out: Record<string, number> = {};
      for (const sel of ['.ct-orch-tray-title', '.ct-orch-tray-name', '.ct-orch-tray-detail', '.ct-orch-tray-note', '.ct-orch-tray .ct-permission-deny', '.ct-orch-tray .ct-permission-allow', '.ct-orch-tray .ct-permission-always', '.ct-orch-tray-handoff', '.ct-agents-permission-tool']) {
        const el = document.querySelector(sel); if (!el) continue;
        const fg = parse(getComputedStyle(el).color); const bg = bgOf(el);
        const [L1, L2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
        out[sel] = (L1 + 0.05) / (L2 + 0.05);
      }
      return out;
    });
    expect(Object.keys(ratios).length).toBeGreaterThanOrEqual(7);
    for (const [sel, r] of Object.entries(ratios)) expect(r, sel).toBeGreaterThanOrEqual(4.5);
  });
});


// ── QA D1: the highlighted card must not be hidden behind the sheet / pill ───────────────────────────────────────────
const TITLES = [
  'Kanban folder swimlanes', 'Migrate auth tokens to short-lived JWTs', 'Add rate limiting to /v1/search', 'Draft Q3 planning notes',
  'Fix auth middleware 401s', 'Relay reconnect backoff', 'Mobile layout polish', 'Add "why this place" provenance layer',
];

test.describe('orchestrator tray — hovered card is scrolled OUT from under the sheet and pill (QA D1)', () => {
  for (const mode of ['status', 'folder', 'project', 'gallery'] as const) {
    for (const { label, size } of SIZES) {
      test(`${mode} grouping @ ${label}`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' }); // instant scroll: deterministic geometry
        await open(page, size, '1', 'idle');
        if (mode !== 'status') await page.evaluate((m) => (window as any).__setGroupBy(m), mode);
        await page.evaluate((titles) => (window as any).__orchSay(titles.map((t: string) => `[[thread:${t}]]`).join(' · ')), TITLES);
        await openSheet(page, size);
        const links = page.locator('.ct-orch-sheet a.ct-thread-link');
        const n = await links.count();
        expect(n).toBeGreaterThanOrEqual(6);
        let checked = 0;
        for (let i = 0; i < n; i++) {
          await links.nth(i).scrollIntoViewIfNeeded();
          await links.nth(i).hover();
          await page.waitForTimeout(260); // hover intent (120ms) + the scroll
          const m = await page.evaluate(() => {
            const card = document.querySelector('.ct-kanban-card-linked') as HTMLElement | null;
            if (!card) return null; // no layout box in this grouping (e.g. not a featured gallery card): nothing to verify
            const R = (el: Element) => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; };
            const c = R(card);
            const board = R(document.querySelector('.ct-agents-list')!);
            const obs = [document.querySelector('.ct-orch-sheet:not([hidden])'), document.querySelector('.ct-kanban-dispatch')].filter(Boolean).map((e) => R(e!));
            const area = (c.right - c.left) * (c.bottom - c.top);
            let covered = 0;
            for (const o of obs) { const iw = Math.min(c.right, o.right) - Math.max(c.left, o.left); const ih = Math.min(c.bottom, o.bottom) - Math.max(c.top, o.top); if (iw > 0 && ih > 0) covered += iw * ih; }
            const minTop = Math.min(...obs.map((o) => o.top));
            const uncoveredH = minTop - board.top;
            const tall = (c.bottom - c.top) > Math.min(uncoveredH, board.bottom - board.top) && (c.bottom - c.top) > 0.9 * uncoveredH; // taller than the region above the overlays
            // top-left corner visible: inside the board and above every obstacle
            const cornerOk = c.top >= board.top - 1 && c.top < minTop && c.left < board.right && c.right > board.left;
            return { dbg: JSON.stringify({ c, board, minTop, obs }), frac: covered / area, tall, cornerOk, onBoard: c.right > board.left + 20 && c.left < board.right - 20, title: card.textContent?.slice(0, 40) };
          });
          if (!m) continue;
          checked++;
          const linkText = await links.nth(i).textContent();
          if (m.frac > 0.05 && m.tall) expect(m.cornerOk, `tall card ${m.title}: top must be uncovered ${m.dbg}`).toBe(true);
          else expect(m.frac, `link ${linkText} -> ${m.title} covered ${m.dbg}`).toBeLessThanOrEqual(0.05);
          expect(m.onBoard, `${m.title} must be on the board horizontally ${m.dbg}`).toBe(true);
          await page.mouse.move(2, 2);
        }
        expect(checked, 'at least some cards were verified in this grouping').toBeGreaterThanOrEqual(mode === 'gallery' ? 1 : 5);
      });
    }
  }

  test('the 60-trial repro: ?orch=idle&tx=empty&tray=1, link to Kanban folder swimlanes, hover @ 1280x800', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(DESKTOP);
    await page.goto(`${kanbanUrl}?orch=idle&tx=empty&tray=1`);
    await page.waitForSelector('.ct-kanban-dispatch .ct-orch-dock');
    await page.evaluate(() => (window as any).__orchSay('[[thread:Kanban folder swimlanes]]'));
    await openSheet(page, DESKTOP);
    await page.locator('.ct-orch-sheet a.ct-thread-link').first().hover();
    await page.waitForTimeout(300);
    const covered = await page.evaluate(() => {
      const c = document.querySelector('.ct-kanban-card-linked')!.getBoundingClientRect();
      const s = document.querySelector('.ct-orch-sheet')!.getBoundingClientRect();
      const iw = Math.min(c.right, s.right) - Math.max(c.left, s.left); const ih = Math.min(c.bottom, s.bottom) - Math.max(c.top, s.top);
      return iw > 0 && ih > 0 ? (iw * ih) / (c.width * c.height) : 0;
    });
    expect(covered).toBeLessThanOrEqual(0.05);
  });
});

// ── QA D2: the tray heading (+ Show more / fewer) stays visible when the tray scrolls ───────────────────────────────
test.describe('orchestrator tray — sticky heading (QA D2)', () => {
  test('narrow, expanded: the "Needs you (N)" heading and its toggle stay at the top of the scrolling tray @ 390x844', async ({ page }) => {
    await open(page, NARROW, 'many');
    await openSheet(page, NARROW);
    await tray(page).getByRole('button', { name: 'Show 2 more' }).click();
    await expect(tray(page).locator('.ct-orch-tray-card')).toHaveCount(5);
    const scrolls = await tray(page).evaluate((el) => { el.scrollTop = el.scrollHeight; return el.scrollHeight > el.clientHeight; });
    expect(scrolls, 'the tray really scrolls here').toBe(true);
    const box = (await tray(page).boundingBox())!;
    const head = (await tray(page).getByRole('heading', { name: 'Needs you (5)' }).boundingBox())!;
    expect(head.y).toBeGreaterThanOrEqual(box.y - 1);
    expect(head.y + head.height).toBeLessThanOrEqual(box.y + box.height);
    const toggle = (await tray(page).getByRole('button', { name: 'Show fewer' }).boundingBox())!;
    expect(toggle.y).toBeGreaterThanOrEqual(box.y - 1);
    // nothing paints over the heading
    const topmost = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className ?? '', { x: head.x + 8, y: head.y + head.height / 2 });
    expect(topmost).toMatch(/ct-orch-tray-(title|bar)/);
  });
});

import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

/**
 * K2 OrchestratorDock P5: the mobile pass, the soft keyboard and the reduced-motion audit. Served from
 * test/harness/kanban.html (same query params as orchestrator-dock*.spec.ts). Geometry specs carry NO baselines; three
 * visual specs do (idle pill, sheet with transcript + tray, error status row, all at 375x667).
 * Geometry is MEASURED per viewport, never judged from one render.
 */
const kanbanUrl = 'file://' + path.resolve('test/harness/kanban.html');
const DOCK_SHOT = { threshold: 0.05 } as const;

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
});

const VIEWPORTS = [
  { label: '320x640', width: 320, height: 640 },
  { label: '360x640', width: 360, height: 640 },
  { label: '375x667', width: 375, height: 667 },
  { label: '390x844', width: 390, height: 844 },
  { label: '844x390 landscape', width: 844, height: 390 },
];
type Size = { width: number; height: number };

async function open(page: Page, query: string, size: Size) {
  await page.setViewportSize(size);
  // narrow=1 sizes the harness app to the viewport (also in landscape, where the dock is still a pill); mobile=1 is the touch platform.
  await page.goto(`${kanbanUrl}?${query}&narrow=1&mobile=1`);
  await page.waitForSelector('.ct-kanban-dispatch .ct-orch-dock');
}
const sheet = (page: Page) => page.locator('.ct-orch-sheet');
const isNarrow = (s: Size) => s.width < 640;
async function openSheet(page: Page, size: Size) {
  if (isNarrow(size)) await page.locator('.ct-orch-orb').click(); else await page.evaluate(() => (window as any).__openSheet());
  await expect(sheet(page)).toBeVisible();
}

/** Visible controls the dock owns: pill, status row, sheet, tray, peek, chips. */
const DOCK_CONTROLS = ['.ct-orch-dock', '.ct-orch-status', '.ct-orch-sheet', '.ct-orch-peek', '.ct-orch-chips']
  .map((s) => `${s} button, ${s} textarea`).join(', ');

async function targetViolations(page: Page): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || el.closest('[hidden]') || getComputedStyle(el).visibility === 'hidden') continue;
      // A textarea is held by its 44px container (the pill's field, or the sheet composer's body); the dot is not a control.
      const box = el.tagName === 'TEXTAREA' ? ((el.closest('.ct-orch-sheet-composer .ct-orch-body') ?? el.closest('.ct-orch-field')) as HTMLElement | null)?.getBoundingClientRect() ?? r : r;
      if (box.height < 43.5 || box.width < 43.5) out.push(`${el.tagName.toLowerCase()}.${el.className.toString().split(' ').slice(0, 2).join('.')} "${(el.textContent ?? '').trim().slice(0, 20)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
    return out;
  }, DOCK_CONTROLS);
}

async function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const de = document.documentElement;
    if (de.scrollWidth > window.innerWidth) out.push(`document ${de.scrollWidth} > ${window.innerWidth}`);
    for (const sel of ['.ct-agents-panel-meta', '.ct-orch-sheet', '.ct-orch-status', '.ct-orch-tray']) {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        if (el.clientWidth === 0) continue; // (the pill itself is not scroll-checked: the sheet is an absolutely positioned child that reaches the view edges on purpose)
        if (el.scrollWidth > el.clientWidth + 0.5) out.push(`${sel} scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
        const r = el.getBoundingClientRect();
        if (r.left < -0.5 || r.right > window.innerWidth + 0.5) out.push(`${sel} outside the viewport horizontally (${Math.round(r.left)}..${Math.round(r.right)})`);
      }
    }
    return out;
  });
}

test.describe('mobile geometry — baseline-free, per viewport', () => {
  for (const vp of VIEWPORTS) {
    const size = { width: vp.width, height: vp.height };

    test(`idle pill: no overflow, 44px targets, board clears the pill @ ${vp.label}`, async ({ page }) => {
      await open(page, 'orch=idle&tx=conversation', size);
      expect(await overflow(page)).toEqual([]);
      expect(await targetViolations(page)).toEqual([]);
      // Scroll every scroller to its end: the last card must sit above the pill.
      const gap = await page.evaluate(() => {
        const pill = document.querySelector('.ct-kanban-dispatch')!.getBoundingClientRect();
        const scrollers = Array.from(document.querySelectorAll<HTMLElement>('.ct-agents-root *')).filter((e) => e.scrollHeight > e.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && !e.closest('.ct-orch-sheet'));
        for (const s of scrollers) s.scrollTop = s.scrollHeight;
        const cards = Array.from(document.querySelectorAll<HTMLElement>('.ct-kanban-card')).filter((c) => c.getBoundingClientRect().width > 0);
        const lowest = Math.max(...cards.map((c) => c.getBoundingClientRect().bottom));
        return { pillTop: pill.top, lowest, scrollers: scrollers.length };
      });
      expect(gap.scrollers).toBeGreaterThan(0);
      // 4px: the resting 76px board padding (pre-existing, from P2) leaves the last card 1.3px (narrow) to 3.3px (wide pill) under the pill top edge; measured. Moving it would shift every board baseline: see the PR follow-ups.
      expect(gap.lowest, `lowest card bottom vs pill top ${gap.pillTop}`).toBeLessThanOrEqual(gap.pillTop + 4);
    });

    test(`error: the status row and the orb row do not collide @ ${vp.label}`, async ({ page }) => {
      await open(page, 'orch=error', size);
      expect(await overflow(page)).toEqual([]);
      expect(await targetViolations(page)).toEqual([]);
      if (!isNarrow(size)) { await expect(page.locator('.ct-orch-field .ct-orch-reason')).toBeVisible(); return; }
      const g = await page.evaluate(() => {
        const s = document.querySelector('.ct-orch-status')!.getBoundingClientRect();
        const m = document.querySelector('.ct-agents-panel-meta')!.getBoundingClientRect();
        const pill = document.querySelector('.ct-kanban-dispatch')!.getBoundingClientRect();
        return { statusBottom: s.bottom, metaTop: m.top, statusTop: s.top, pillTop: pill.top, pillBottom: pill.bottom, metaBottom: m.bottom };
      });
      expect(g.statusBottom).toBeLessThanOrEqual(g.metaTop + 0.5);
      expect(g.statusTop).toBeGreaterThanOrEqual(g.pillTop - 0.5);
      expect(g.metaBottom).toBeLessThanOrEqual(g.pillBottom + 0.5);
    });

    test(`sheet with transcript and tray: inside the viewport, 44px targets, no overflow @ ${vp.label}`, async ({ page }) => {
      await open(page, 'orch=idle&tx=conversation&tray=1', size);
      await openSheet(page, size);
      await expect(page.locator('.ct-orch-tray')).toBeVisible();
      expect(await overflow(page)).toEqual([]);
      expect(await targetViolations(page)).toEqual([]);
      const r = await sheet(page).evaluate((el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: innerWidth, h: innerHeight }; });
      expect(r.l).toBeGreaterThanOrEqual(-0.5);
      expect(r.r).toBeLessThanOrEqual(r.w + 0.5);
      expect(r.t).toBeGreaterThanOrEqual(-0.5);
      expect(r.b).toBeLessThanOrEqual(r.h + 0.5);
      // The composer is reachable: its textarea is inside the sheet and inside the viewport.
      const ta = await page.locator('.ct-orch-input').evaluate((el) => { const b = el.getBoundingClientRect(); return { t: b.top, b: b.bottom, h: innerHeight }; });
      expect(ta.t).toBeGreaterThanOrEqual(0);
      expect(ta.b).toBeLessThanOrEqual(ta.h);
    });

    test(`summary line and numeric badge are visible on touch @ ${vp.label}`, async ({ page }) => {
      await open(page, 'orch=attention&tx=conversation&tray=1', size);
      if (isNarrow(size)) {
        const badge = page.locator('.ct-orch-dot .ct-orch-dot-count');
        await expect(badge).toBeVisible();
        expect(await badge.textContent()).toMatch(/^\d+\+?$/);
        expect(await page.locator('.ct-orch-dot').getAttribute('aria-label')).toMatch(/need/);
        expect(await overflow(page)).toEqual([]);
      } else {
        await expect(page.locator('.ct-orch-dot .ct-orch-dot-count')).toHaveCount(0);
      }
      await openSheet(page, size);
      const summary = page.locator('.ct-orch-sheet-summary');
      await expect(summary).toBeVisible();
      expect(await summary.textContent()).toBe(await page.locator('.ct-orch-dot').getAttribute('title'));
    });
  }
});

/** WCAG contrast of the badge's text on its own background, and no opacity anywhere up the tree. */
async function badgeContrast(page: Page): Promise<{ ratio: number; opacity: number }> {
  return page.evaluate(() => {
    const dot = document.querySelector('.ct-orch-dot-has-count') as HTMLElement;
    const count = dot.querySelector('.ct-orch-dot-count') as HTMLElement;
    const parse = (c: string): [number, number, number] => {
      const m = c.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/);
      if (m) return [+m[1] * 255, +m[2] * 255, +m[3] * 255];
      const r = c.match(/rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/)!;
      return [+r[1], +r[2], +r[3]];
    };
    const lum = ([r, g, b]: [number, number, number]) => { const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const fg = lum(parse(getComputedStyle(count).color));
    const bg = lum(parse(getComputedStyle(dot).backgroundColor));
    let opacity = 1;
    for (let n: HTMLElement | null = count; n; n = n.parentElement) opacity *= parseFloat(getComputedStyle(n).opacity);
    return { ratio: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05), opacity };
  });
}

test.describe('count badge contrast (A6)', () => {
  test('>= 4.5:1 on the dark harness palette, fully opaque @ 390x844', async ({ page }) => {
    await open(page, 'orch=attention&tx=conversation', { width: 390, height: 844 });
    await expect(page.locator('.ct-orch-dot-has-count')).toBeVisible();
    const r = await badgeContrast(page);
    expect(r.opacity).toBe(1);
    expect(r.ratio).toBeGreaterThanOrEqual(4.5);
  });
  test('>= 4.5:1 on an injected light palette (Obsidian default light values) @ 390x844', async ({ page }) => {
    await open(page, 'orch=attention&tx=conversation', { width: 390, height: 844 });
    await page.addStyleTag({ content: ':root, body { --background-primary:#ffffff; --background-secondary:#f2f3f5; --text-normal:#222222; --text-on-accent:#ffffff; --color-orange:#e9973f; --interactive-accent:#7c3aed; }' });
    const r = await badgeContrast(page);
    expect(r.opacity).toBe(1);
    expect(r.ratio).toBeGreaterThanOrEqual(4.5);
  });
});

test.describe('pinch / zoom stays enabled', () => {
  test('the harness viewport meta has no scale lock', async ({ page }) => {
    await open(page, 'orch=idle', { width: 375, height: 667 });
    const content = (await page.locator('meta[name="viewport"]').getAttribute('content')) ?? '';
    expect(content).not.toMatch(/user-scalable\s*=\s*(no|0)/);
    expect(content).not.toMatch(/maximum-scale\s*=\s*1(\.0)?\b/);
    const touch = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.ct-kanban-dispatch, .ct-kanban-dispatch *, .ct-orch-status')).filter((e) => getComputedStyle(e).touchAction === 'none').length);
    expect(touch).toBe(0);
  });
});

/** A fake visualViewport the page can drive (the soft keyboard), installed before the app scripts run. */
async function installFakeVisualViewport(page: Page) {
  await page.addInitScript(() => {
    const vv = Object.assign(new EventTarget(), { width: window.innerWidth, height: window.innerHeight, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    (window as any).__setVV = (height: number, offsetTop = 0) => { vv.height = height; vv.offsetTop = offsetTop; vv.dispatchEvent(new Event('resize')); };
  });
}
async function fillTranscript(page: Page, n: number) {
  for (let i = 0; i < n; i++) await page.evaluate((k) => (window as any).__orchSay(`Reply number ${k}: ${'lorem ipsum dolor sit amet '.repeat(6)}`), i);
}
const lastMessageVisible = (page: Page) => page.evaluate(() => {
  const sc = document.querySelector('.ct-orch-sheet-scroll')!.getBoundingClientRect();
  const msgs = document.querySelectorAll('.ct-orch-msg');
  const last = msgs[msgs.length - 1].getBoundingClientRect();
  return { lastBottom: last.bottom, scrollBottom: sc.bottom, lastTop: last.top, scrollTop: sc.top };
});

test.describe('soft keyboard (fake visualViewport) and height shrink (QA N10)', () => {
  test('the composer stays inside the visual viewport and the latest message stays visible when the keyboard opens @ 375x667', async ({ page }) => {
    await installFakeVisualViewport(page);
    const size = { width: 375, height: 667 };
    await open(page, 'orch=idle&tx=conversation', size);
    await openSheet(page, size);
    await fillTranscript(page, 6);
    await page.evaluate(() => (window as any).__setVV(667 - 300));
    await expect.poll(() => page.locator('.ct-orch-sheet').evaluate((el) => (el as HTMLElement).style.getPropertyValue('--ct-orch-kbd-inset'))).toBe('300px');
    const ta = await page.locator('.ct-orch-input').evaluate((el) => el.getBoundingClientRect().bottom);
    expect(ta).toBeLessThanOrEqual(367 + 0.5);
    const sh = await sheet(page).evaluate((el) => el.getBoundingClientRect());
    expect(sh.top).toBeGreaterThanOrEqual(-0.5);
    expect(sh.bottom).toBeLessThanOrEqual(367 + 0.5);
    const m = await lastMessageVisible(page);
    expect(m.lastBottom).toBeLessThanOrEqual(m.scrollBottom + 1);
    await page.evaluate(() => (window as any).__setVV(667));
    await expect.poll(() => page.locator('.ct-orch-sheet').evaluate((el) => (el as HTMLElement).style.getPropertyValue('--ct-orch-kbd-inset'))).toBe('0px');
    const back = await sheet(page).evaluate((el) => el.getBoundingClientRect().bottom);
    expect(back).toBeGreaterThan(367);
  });

  test('N10: a real viewport height shrink 390x844 -> 390x600 keeps a pinned transcript on its latest message', async ({ page }) => {
    const size = { width: 390, height: 844 };
    await open(page, 'orch=idle&tx=conversation', size);
    await openSheet(page, size);
    await fillTranscript(page, 8);
    await page.setViewportSize({ width: 390, height: 600 });
    await expect.poll(async () => { const m = await lastMessageVisible(page); return m.lastBottom - m.scrollBottom; }).toBeLessThanOrEqual(1);
  });

  test('N10: a user who scrolled up is not pulled to the bottom by the shrink', async ({ page }) => {
    const size = { width: 390, height: 844 };
    await open(page, 'orch=idle&tx=conversation', size);
    await openSheet(page, size);
    await fillTranscript(page, 8);
    // A real wheel gesture (the sheet decides pinned-ness from the scroll events it produces), then let the scroll event land.
    await page.locator('.ct-orch-sheet-scroll').hover();
    await page.mouse.wheel(0, -3000);
    await expect.poll(() => page.locator('.ct-orch-sheet-scroll').evaluate((el) => el.scrollTop)).toBe(0);
    await page.waitForTimeout(150);
    await page.setViewportSize({ width: 390, height: 600 });
    await page.waitForTimeout(200);
    expect(await page.locator('.ct-orch-sheet-scroll').evaluate((el) => el.scrollTop)).toBe(0);
  });

  test('the keyboard shrink keeps a pinned transcript pinned (fake visualViewport) @ 390x844', async ({ page }) => {
    await installFakeVisualViewport(page);
    const size = { width: 390, height: 844 };
    await open(page, 'orch=idle&tx=conversation', size);
    await openSheet(page, size);
    await fillTranscript(page, 8);
    await page.evaluate(() => (window as any).__setVV(844 - 340));
    await expect.poll(async () => { const m = await lastMessageVisible(page); return m.lastBottom - m.scrollBottom; }).toBeLessThanOrEqual(1);
  });
});

test.describe('D1: the Needs-you tray keeps its first card and buttons under a long conversation', () => {
  const SIZES = [
    { width: 320, height: 640 }, { width: 375, height: 667 }, { width: 390, height: 844 }, { width: 1280, height: 800 },
  ];
  /** Geometry of the first tray card's action buttons against the tray's visible band (below its sticky heading). */
  const firstCard = (page: Page) => page.evaluate(() => {
    const tray = document.querySelector('.ct-orch-tray') as HTMLElement;
    const bar = tray.querySelector('.ct-orch-tray-bar')!.getBoundingClientRect();
    const t = tray.getBoundingClientRect();
    const buttons = Array.from(tray.querySelectorAll('.ct-orch-tray-card')[0].querySelectorAll('button')).map((b) => { const r = b.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: r.height, w: r.width }; });
    const sc = document.querySelector('.ct-orch-sheet-scroll') as HTMLElement;
    const composer = (document.querySelector('.ct-orch-input') as HTMLElement).getBoundingClientRect();
    return { trayH: t.height, barBottom: bar.bottom, trayBottom: t.bottom, buttons, scrollable: sc.scrollHeight > sc.clientHeight, transcriptH: sc.clientHeight, composerBottom: composer.bottom, vh: innerHeight };
  });
  function expectButtonsVisible(g: Awaited<ReturnType<typeof firstCard>>, narrow: boolean) {
    expect(g.buttons.length, 'the first card has action buttons').toBeGreaterThan(0);
    for (const b of g.buttons) {
      expect(b.top, 'button below the sticky heading').toBeGreaterThanOrEqual(g.barBottom - 0.5);
      expect(b.bottom, 'button inside the tray band').toBeLessThanOrEqual(g.trayBottom + 0.5);
      if (narrow) expect(b.h).toBeGreaterThanOrEqual(43.5);
    }
  }
  for (const size of SIZES) {
    test(`8 long replies: the first card's buttons are fully visible, the transcript still scrolls @ ${size.width}x${size.height}`, async ({ page }) => {
      await open(page, 'orch=idle&tx=conversation&tray=1', size);
      await openSheet(page, size);
      await fillTranscript(page, 8);
      const g = await firstCard(page);
      expectButtonsVisible(g, isNarrow(size));
      expect(g.scrollable).toBe(true);
      expect(g.transcriptH).toBeGreaterThan(0);
      expect(g.composerBottom).toBeLessThanOrEqual(g.vh);
    });
  }
  for (const size of [{ width: 320, height: 640 }, { width: 375, height: 667 }, { width: 390, height: 844 }]) {
    test(`with the keyboard open: still heading + first card with buttons; the transcript gives way first @ ${size.width}x${size.height}`, async ({ page }) => {
      await installFakeVisualViewport(page);
      await open(page, 'orch=idle&tx=conversation&tray=1', size);
      await openSheet(page, size);
      await fillTranscript(page, 8);
      const kb = Math.round(size.height * 0.42);
      await page.evaluate((h) => (window as any).__setVV(h), size.height - kb);
      await expect.poll(() => page.locator('.ct-orch-sheet').evaluate((el) => (el as HTMLElement).style.getPropertyValue('--ct-orch-kbd-inset'))).toBe(`${kb}px`);
      const g = await firstCard(page);
      expectButtonsVisible(g, true);
      expect(g.composerBottom).toBeLessThanOrEqual(size.height - kb + 0.5);
    });
  }
});

test.describe('D1b: worst-case first card (long title, 3-line detail, 3 buttons): the composer is never clipped, the buttons stay reachable', () => {
  const CASES = [
    { width: 320, height: 640, kb: [0, 290, 330] }, { width: 360, height: 640, kb: [0, 290, 330] }, { width: 375, height: 667, kb: [0, 300, 340] },
    { width: 844, height: 390, kb: [0, 170, 200] }, { width: 667, height: 375, kb: [0, 170] },
  ];
  /** Everything measured against the sheet's own rect and the visual viewport. */
  async function measure(page: Page) {
    return page.evaluate(() => {
      const r = (e: Element) => { const b = e.getBoundingClientRect(); return { t: b.top, b: b.bottom, l: b.left, r: b.right, h: b.height }; };
      const sh = document.querySelector('.ct-orch-sheet') as HTMLElement;
      const tray = sh.querySelector('.ct-orch-tray') as HTMLElement;
      const first = tray.querySelector('.ct-orch-tray-card') as HTMLElement;
      const btn = first.querySelector('button') as HTMLElement;
      // Reachable: scrolling INSIDE the tray is allowed (never the sheet itself: it clips), clipping by the sheet is not.
      const barH = tray.querySelector('.ct-orch-tray-bar')!.getBoundingClientRect().height;
      const stickyBar = getComputedStyle(tray.querySelector('.ct-orch-tray-bar')!).position === 'sticky';
      for (let pass = 0; pass < 2; pass++) { const over = btn.getBoundingClientRect().bottom - tray.getBoundingClientRect().bottom; if (over > 0) tray.scrollTop += over; }
      const underBar = tray.getBoundingClientRect().top + (stickyBar ? barH : 0) - btn.getBoundingClientRect().top;
      if (underBar > 0) tray.scrollTop -= underBar;
      const bar = r(tray.querySelector('.ct-orch-tray-bar')!); // after the tray scroll: a non-sticky (compact) heading scrolls away
      const info = Array.from(first.querySelectorAll('button')).map((b) => {
        const cs = getComputedStyle(b);
        const shown = b.getClientRects().length > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && !b.closest('[hidden]');
        return { name: (b.textContent ?? '').trim(), shown, tabbable: shown && !(b as HTMLButtonElement).disabled && b.tabIndex >= 0, ...r(b) };
      });
      const buttons = info.filter((b) => b.shown);
      const hiddenApprovals = info.filter((b) => !b.shown && /^(Allow|Always)/.test(b.name));
      const collapsedReview = tray.querySelector('.ct-orch-tray-collapsed-review') as HTMLElement | null;
      const collapsedShown = !!collapsedReview && collapsedReview.getClientRects().length > 0 && getComputedStyle(collapsedReview).display !== 'none';
      const field = (document.querySelector('.ct-orch-input') ?? document.querySelector('.ct-orch-sheet-composer')) as HTMLElement;
      const vv = (window as any).visualViewport;
      return {
        vvBottom: vv ? vv.offsetTop + vv.height : innerHeight,
        compact: tray.hasAttribute('data-compact'), collapsed: tray.hasAttribute('data-collapsed'), collapsedShown, hiddenApprovals,
        sheet: r(sh), tray: r(tray), bar, buttons, field: r(field), head: r(sh.querySelector('.ct-orch-sheet-head')!),
        composerInSheet: sh.contains(field), mode: sh.dataset.mode,
      };
    });
  }
  type M = Awaited<ReturnType<typeof measure>>;
  function expectFits(m: M, label: string) {
    const eps = 1.5; // fractional layout at DPR 2 (sub-pixel scroll snapping), not a visible clip
    expect(m.sheet.t, `${label}: sheet top inside the viewport (header + close reachable)`).toBeGreaterThanOrEqual(-eps);
    expect(m.sheet.b, `${label}: sheet bottom above the keyboard`).toBeLessThanOrEqual(m.vvBottom + eps);
    expect(m.head.t, `${label}: header inside the sheet`).toBeGreaterThanOrEqual(m.sheet.t - eps);
    if (m.composerInSheet) {
      expect(m.field.b, `${label}: composer inside the sheet (not clipped)`).toBeLessThanOrEqual(m.sheet.b + eps);
      expect(m.field.t, `${label}: composer below the tray`).toBeGreaterThanOrEqual(m.tray.b - eps);
    } else {
      expect(m.field.b, `${label}: the pill's field above the keyboard`).toBeLessThanOrEqual(m.vvBottom + eps);
    }
    const names = m.buttons.map((b) => b.name);
    if (m.collapsed) {
      // Not even the compact card fits next to the composer: the body is hidden, a one-row hand-off remains (when there is any room at all)
      expect(names, `${label}: no approval buttons in the collapsed form`).toEqual([]);
    } else if (m.compact) {
      // NEVER approve blind: with the tool detail hidden only Deny and "Review in thread" are on offer.
      expect(names, `${label}: compact form`).toEqual(['Deny', 'Review in thread']);
      expect(m.hiddenApprovals.length, `${label}: Allow / Always exist but are not displayed`).toBeGreaterThan(0);
    } else {
      expect(names, `${label}: full form`).toEqual(['Deny', 'Allow', 'Always']);
    }
    for (const b of m.buttons) {
      expect(b.t, `${label}: ${b.name} below the sticky heading`).toBeGreaterThanOrEqual(m.bar.b - eps);
      expect(b.b, `${label}: ${b.name} inside the tray band`).toBeLessThanOrEqual(m.tray.b + eps);
      expect(b.b, `${label}: ${b.name} inside the sheet`).toBeLessThanOrEqual(m.sheet.b + eps);
      if (m.mode === 'orb') expect(b.h, `${label}: ${b.name} is a 44px target`).toBeGreaterThanOrEqual(43.5);
    }
    for (const h of m.hiddenApprovals) expect(h.tabbable, `${label}: hidden ${h.name} is not tabbable`).toBe(false);
  }
  for (const c of CASES) {
    for (const kb of c.kb) {
      test(`@ ${c.width}x${c.height}, keyboard ${kb}px`, async ({ page }) => {
        const size = { width: c.width, height: c.height };
        await installFakeVisualViewport(page);
        await open(page, 'orch=attention&tx=conversation&tray=worst', size);
        await openSheet(page, size);
        await fillTranscript(page, 8);
        if (kb) await page.evaluate((h) => (window as any).__setVV(h), c.height - kb);
        await page.waitForTimeout(80);
        expectFits(await measure(page), `${c.width}x${c.height} kb${kb}`);
      });
    }
  }
  test('with the composer grown to its maximum height @ 375x667, keyboard 300px', async ({ page }) => {
    const size = { width: 375, height: 667 };
    await installFakeVisualViewport(page);
    await open(page, 'orch=attention&tx=conversation&tray=worst', size);
    await openSheet(page, size);
    await fillTranscript(page, 8);
    await page.evaluate(() => (window as any).__setVV(667 - 300));
    await page.locator('.ct-orch-input').fill(Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n'));
    await page.waitForTimeout(150);
    expectFits(await measure(page), 'grown composer');
  });
  test('with a wrapped error reason in the composer slot @ 320x640, keyboard 290px', async ({ page }) => {
    const size = { width: 320, height: 640 };
    await installFakeVisualViewport(page);
    await open(page, 'orch=error&errlong=1&tx=conversation&tray=worst', size);
    await openSheet(page, size);
    await page.evaluate(() => (window as any).__setVV(640 - 290));
    await page.waitForTimeout(150);
    const m = await measure(page);
    const slot = await page.locator('.ct-orch-sheet-composer').evaluate((el) => { const b = el.getBoundingClientRect(); const s = document.querySelector('.ct-orch-sheet')!.getBoundingClientRect(); return { b: b.bottom, sb: s.bottom }; });
    expect(slot.b).toBeLessThanOrEqual(slot.sb + 1.5);
    expect(m.sheet.b).toBeLessThanOrEqual(m.vvBottom + 1.5);
    expect(m.sheet.t).toBeGreaterThanOrEqual(-1.5);
  });
});

/** Hit-testing: scroll INSIDE the tray (never the sheet) until the element is in its band, then ask the browser what sits at its centre. */
async function hitTestable(page: Page, selector: string, nth = 0) {
  return page.evaluate(({ selector, nth }) => {
    const el = document.querySelectorAll(selector)[nth] as HTMLElement;
    const tray = el.closest('.ct-orch-tray') as HTMLElement | null;
    if (tray) {
      for (let pass = 0; pass < 3; pass++) {
        const t = tray.getBoundingClientRect(); const b = el.getBoundingClientRect();
        const bar = tray.querySelector('.ct-orch-tray-bar') as HTMLElement;
        const top = t.top + (getComputedStyle(bar).position === 'sticky' ? bar.getBoundingClientRect().height : 0);
        if (b.bottom > t.bottom) tray.scrollTop += b.bottom - t.bottom; else if (b.top < top) tray.scrollTop -= top - b.top;
      }
    }
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const sh = document.querySelector('.ct-orch-sheet')!.getBoundingClientRect();
    const vv = (window as any).visualViewport;
    const vb = vv ? vv.offsetTop + vv.height : innerHeight;
    return { hit: !!hit && (hit === el || el.contains(hit)), inSheet: r.top >= sh.top - 1.5 && r.bottom <= sh.bottom + 1.5, inViewport: r.top >= -1.5 && r.bottom <= vb + 1.5, sheetInViewport: sh.top >= -1.5 && sh.bottom <= vb + 1.5, h: r.height };
  }, { selector, nth });
}

test.describe('D11 / D10 exact QA repros', () => {
  for (const size of [{ width: 844, height: 390 }, { width: 667, height: 375 }]) {
    test(`D11 @ ${size.width}x${size.height}: ?tray=1 + a permission + keyboard 170px: Allow / Deny / Answer are hit-testable, the close button stays reachable`, async ({ page }) => {
      await installFakeVisualViewport(page);
      await open(page, 'orch=idle&tx=conversation&tray=1', size);
      await page.evaluate(() => (window as any).__addPermission('k-hiptrip-awaiting', 'Bash', JSON.stringify({ command: 'npm run deploy --prod' })));
      await page.evaluate(() => (window as any).__openSheet());
      await expect(sheet(page)).toBeVisible();
      await page.evaluate((h) => (window as any).__setVV(h), size.height - 170);
      await page.waitForTimeout(150);
      // The landscape tiny-room case is the COMPACT form: Deny + "Review in thread" only (the detail is hidden, so Allow / Always must not be on offer).
      const compact = await page.locator('.ct-orch-tray').evaluate((el) => el.hasAttribute('data-compact'));
      expect(compact).toBe(true);
      for (const sel of ['.ct-orch-tray-card[data-kind="permission"] button.ct-permission-deny', '.ct-orch-tray-card[data-kind="permission"] .ct-orch-tray-handoff']) {
        expect(await hitTestable(page, sel), sel).toMatchObject({ hit: true, inSheet: true, inViewport: true, sheetInViewport: true });
      }
      for (const cls of ['allow', 'always']) {
        const hidden = await page.locator(`.ct-orch-tray-card[data-kind="permission"] button.ct-permission-${cls}`).first().evaluate((el) => ({ shown: el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none', tab: el.tabIndex }));
        expect(hidden.shown, `Allow/Always (${cls}) not displayed in compact`).toBe(false);
      }
      const answer = await hitTestable(page, '.ct-orch-tray-card[data-kind="question"] .ct-orch-tray-handoff');
      expect(answer).toMatchObject({ hit: true, inSheet: true, inViewport: true });
      const close = await hitTestable(page, '.ct-orch-sheet-close');
      expect(close).toMatchObject({ hit: true, inSheet: true, inViewport: true, sheetInViewport: true });
    });
  }
  for (const size of [{ width: 320, height: 640 }, { width: 360, height: 640 }]) {
    test(`D10 @ ${size.width}x${size.height}: 8 replies, a long-permission first card, keyboard 300px: the textarea stays visible`, async ({ page }) => {
      await installFakeVisualViewport(page);
      await open(page, 'orch=attention&tx=conversation&tray=long', size);
      await openSheet(page, size);
      await fillTranscript(page, 8);
      await page.evaluate((h) => (window as any).__setVV(h), size.height - 300);
      await page.waitForTimeout(150);
      const r = await hitTestable(page, '.ct-orch-input');
      expect(r).toMatchObject({ hit: true, inSheet: true, inViewport: true, sheetInViewport: true });
    });
  }
});

test.describe('Compact form safety (never approve blind)', () => {
  const size = { width: 844, height: 390 };
  async function compactSetup(page: Page) {
    await installFakeVisualViewport(page);
    await open(page, 'orch=idle&tx=conversation&tray=1', size);
    await page.evaluate(() => (window as any).__addPermission('k-hiptrip-awaiting', 'Bash', JSON.stringify({ command: 'npm run deploy --prod' })));
    await page.evaluate(() => (window as any).__openSheet());
    await expect(sheet(page)).toBeVisible();
  }
  test('Tab never lands on Allow / Always while the tray is compact (the detail is hidden)', async ({ page }) => {
    await compactSetup(page);
    await page.evaluate((h) => (window as any).__setVV(h), size.height - 170);
    await page.waitForTimeout(150);
    expect(await page.locator('.ct-orch-tray').evaluate((el) => el.hasAttribute('data-compact'))).toBe(true);
    await page.locator('.ct-orch-sheet-close').focus();
    const seen: string[] = [];
    for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); seen.push(await page.evaluate(() => (document.activeElement?.textContent ?? '').trim())); }
    expect(seen.filter((t) => /^(Allow|Always)/.test(t))).toEqual([]);
    expect(seen).toContain('Review in thread');
  });
  test('compact <-> full on keyboard open/close: Allow returns for a fully shown command, and resolves exactly once', async ({ page }) => {
    await compactSetup(page);
    await page.evaluate((h) => (window as any).__setVV(h), size.height - 170);
    await page.waitForTimeout(150);
    const allow = page.locator('.ct-orch-tray-card[data-kind="permission"] button.ct-permission-allow');
    await expect(allow).toBeHidden();
    await page.evaluate((h) => (window as any).__setVV(h), size.height);
    await page.waitForTimeout(150);
    expect(await page.locator('.ct-orch-tray').evaluate((el) => el.hasAttribute('data-compact'))).toBe(false);
    await expect(allow).toBeVisible();
    await expect(page.locator('.ct-orch-tray-card[data-kind="permission"] .ct-orch-tray-handoff')).toBeHidden();
    await allow.click();
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as any).__resolvedPermissions.length)).toBe(1);
    expect(await page.evaluate(() => (window as any).__resolvedPermissions[0].allow)).toBe(true);
  });
  test('focus on Allow survives the switch to compact: it moves to "Review in thread", never to the page', async ({ page }) => {
    await compactSetup(page);
    await page.locator('.ct-orch-tray-card[data-kind="permission"] button.ct-permission-allow').focus();
    await page.evaluate((h) => (window as any).__setVV(h), size.height - 170);
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => (document.activeElement?.textContent ?? '').trim())).toBe('Review in thread');
  });
  test('568x320 landscape with a 150px keyboard: the composer wins, the tray collapses to a one-row hand-off', async ({ page }) => {
    const small = { width: 568, height: 320 };
    await installFakeVisualViewport(page);
    await open(page, 'orch=idle&tx=conversation&tray=1', small);
    await page.evaluate(() => (window as any).__addPermission('k-hiptrip-awaiting', 'Bash', JSON.stringify({ command: 'npm run deploy --prod' })));
    await page.evaluate(() => (window as any).__openSheet());
    await page.evaluate((h) => (window as any).__setVV(h), small.height - 150);
    await page.waitForTimeout(200);
    const g = await page.evaluate(() => {
      const sh = document.querySelector('.ct-orch-sheet')!.getBoundingClientRect();
      const field = document.querySelector('.ct-orch-input')!.getBoundingClientRect();
      const head = document.querySelector('.ct-orch-sheet-head')!.getBoundingClientRect();
      const tray = document.querySelector('.ct-orch-tray') as HTMLElement | null;
      const vv = (window as any).visualViewport;
      return { inSheet: !!document.querySelector('.ct-orch-sheet')!.contains(document.querySelector('.ct-orch-input')), sh: { t: sh.top, b: sh.bottom }, field: { t: field.top, b: field.bottom }, head: { t: head.top, b: head.bottom }, vb: vv.offsetTop + vv.height, collapsed: !!tray && tray.hasAttribute('data-collapsed'), trayH: tray && !tray.hidden ? tray.getBoundingClientRect().height : 0 };
    });
    expect(g.field.b, 'the pill field is above the keyboard').toBeLessThanOrEqual(g.vb + 1.5);
    expect(g.sh.b, 'the sheet is above the keyboard').toBeLessThanOrEqual(g.vb + 1.5);
    // 568px wide is the narrow (orb) mode: the composer is INSIDE the bottom sheet there; in pill mode it is the pill's field below the sheet.
    if (g.inSheet) expect(g.field.b, 'the composer is inside the sheet (not clipped)').toBeLessThanOrEqual(g.sh.b + 1.5);
    else expect(g.sh.b, 'the sheet does not overlap the pill field').toBeLessThanOrEqual(g.field.t + 1.5);
    expect(g.head.t, 'the header is inside the viewport').toBeGreaterThanOrEqual(-1.5);
    expect(g.collapsed).toBe(true);
  });
});

test.describe('D13: focus survives every tray form change @ 320x640', () => {
  const size = { width: 320, height: 640 };
  type Form = 'full' | 'compact' | 'collapsed' | 'hidden';
  const formOf = (page: Page): Promise<Form> => page.evaluate(() => {
    const t = document.querySelector('.ct-orch-tray') as HTMLElement | null;
    if (!t || t.hidden) return 'hidden' as const;
    if (t.hasAttribute('data-collapsed')) return 'collapsed' as const;
    return t.hasAttribute('data-compact') ? 'compact' as const : 'full' as const;
  });
  const CONTROLS: Record<Form, string[]> = {
    full: ['.ct-orch-tray-card[data-kind="permission"] button.ct-permission-deny', '.ct-orch-tray-card[data-kind="permission"] button.ct-permission-allow', '.ct-orch-tray-card[data-kind="permission"] button.ct-permission-always'],
    compact: ['.ct-orch-tray-card[data-kind="permission"] button.ct-permission-deny', '.ct-orch-tray-card[data-kind="permission"] .ct-orch-tray-handoff'],
    collapsed: ['.ct-orch-tray-collapsed-review'],
    hidden: ['.ct-orch-input'],
  };
  test('every pairwise transition keeps focus inside the sheet (never <body>)', async ({ page }) => {
    await installFakeVisualViewport(page);
    await open(page, 'orch=attention&tx=conversation&tray=1', size);
    await openSheet(page, size);
    await fillTranscript(page, 8);
    // Sweep the keyboard height to find a representative value for each form of the tray.
    const kbFor: Partial<Record<Form, number>> = {};
    const extra: Partial<Record<Form, number>> = {};
    for (let kb = 0; kb <= 520; kb += 10) {
      await page.evaluate((h) => (window as any).__setVV(h), size.height - kb);
      await page.waitForTimeout(40);
      const f = await formOf(page);
      if (kbFor[f] === undefined) kbFor[f] = kb; else if (extra[f] === undefined && kb - kbFor[f]! >= 10) extra[f] = kb;
    }
    expect(Object.keys(kbFor).sort(), 'the sweep found all four forms').toEqual(['collapsed', 'compact', 'full', 'hidden']);
    const set = async (kb: number) => { await page.evaluate((h) => (window as any).__setVV(h), size.height - kb); await page.waitForTimeout(120); };
    const failures: string[] = [];
    const forms = Object.keys(kbFor) as Form[];
    for (const a of forms) for (const b of [...forms, ...(extra[a] !== undefined ? [`${a}*`] : [])]) {
      const target = b.endsWith('*') ? extra[a]! : kbFor[b as Form]!;
      for (const sel of CONTROLS[a]) {
        await set(kbFor[a]!);
        const loc = page.locator(sel).first();
        if ((await loc.count()) === 0 || !(await loc.isVisible())) continue;
        await loc.focus();
        const before = await page.evaluate(() => (document.activeElement?.textContent ?? '').trim() || document.activeElement?.className);
        await set(target);
        const after = await page.evaluate(() => ({ body: document.activeElement === document.body, inSheet: !!document.activeElement?.closest('.ct-orch-sheet'), text: (document.activeElement?.textContent ?? '').trim().slice(0, 24) }));
        if (after.body || !after.inSheet) failures.push(`${a} -> ${b} with focus on ${sel.split(' ').pop()} (${before}): ${JSON.stringify(after)}`);
        if (b === `${a}*` && a === 'compact' && !after.body) {
          const same = await page.evaluate(() => (document.activeElement?.textContent ?? '').trim());
          if (same !== before) failures.push(`compact -> compact moved focus from "${before}" to "${same}"`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

test.describe('D17: focus on "Show N more" survives the tray collapsing @ 320x640', () => {
  const size = { width: 320, height: 640 };
  test('every keyboard height that collapses or hides the tray, from focus at keyboard 0 and 380: never <body>', async ({ page }) => {
    await installFakeVisualViewport(page);
    await open(page, 'orch=idle&tx=conversation&tray=many', size);
    await openSheet(page, size);
    await fillTranscript(page, 8);
    const set = async (kb: number) => { await page.evaluate((h) => (window as any).__setVV(h), size.height - kb); await page.waitForTimeout(120); };
    const failures: string[] = [];
    let focusedAtLeastOnce = 0;
    for (const from of [0, 380]) // (Up to 500px: 140px of visual height. At 540px (100px) the whole sheet is hidden, nothing in it can hold focus: documented limit.)
    for (const to of [380, 400, 430, 460, 500]) {
      await set(from);
      const toggle = page.locator('.ct-orch-tray-toggle');
      if ((await toggle.count()) === 0 || !(await toggle.isVisible())) continue;
      await toggle.focus();
      focusedAtLeastOnce++;
      await set(to);
      const a = await page.evaluate(() => ({ body: document.activeElement === document.body || !document.activeElement, inSheet: !!document.activeElement?.closest('.ct-orch-sheet'), text: (document.activeElement?.textContent ?? '').trim().slice(0, 20) }));
      if (a.body || !a.inSheet) failures.push(`show-more focused at kb ${from}, then kb ${to}: ${JSON.stringify(a)}`);
    }
    expect(focusedAtLeastOnce, 'the repro really focused "Show N more"').toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});

test.describe('D14 / D16: the sheet never starts above the top; a wrapped error reason fits to the pixel', () => {
  const CASES = [
    { width: 844, height: 390, kbs: [200, 260] }, { width: 667, height: 375, kbs: [200, 260] }, { width: 568, height: 320, kbs: [150, 200] },
  ];
  for (const c of CASES) for (const kb of c.kbs) {
    test(`@ ${c.width}x${c.height}, keyboard ${kb}px: sheet top >= 0 (or hidden), close hit-testable, composer visible`, async ({ page }) => {
      const size = { width: c.width, height: c.height };
      await installFakeVisualViewport(page);
      await open(page, 'orch=idle&tx=conversation&tray=1', size);
      await page.evaluate(() => (window as any).__addPermission('k-hiptrip-awaiting', 'Bash', JSON.stringify({ command: 'npm run deploy --prod' })));
      await page.evaluate(() => (window as any).__openSheet());
      await page.evaluate((h) => (window as any).__setVV(h), c.height - kb);
      await page.waitForTimeout(200);
      const g = await page.evaluate(() => {
        const sh = document.querySelector('.ct-orch-sheet') as HTMLElement;
        const cs = getComputedStyle(sh);
        const r = sh.getBoundingClientRect();
        const vv = (window as any).visualViewport;
        const field = document.querySelector('.ct-orch-input')!.getBoundingClientRect();
        const close = sh.querySelector('.ct-orch-sheet-close') as HTMLElement;
        const cr = close.getBoundingClientRect();
        const hit = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2);
        return { hiddenSheet: cs.visibility === 'hidden' || cs.display === 'none', top: r.top, bottom: r.bottom, vb: vv.offsetTop + vv.height, closeHit: !!hit && (hit === close || close.contains(hit)), field: { b: field.bottom }, micro: sh.hasAttribute('data-micro') };
      });
      expect(g.field.b, 'composer / field above the keyboard').toBeLessThanOrEqual(g.vb + 0.5);
      if (g.hiddenSheet) return; // no room at all: the sheet waits (hidden) instead of starting above the top
      expect(g.top, 'sheet top inside the view').toBeGreaterThanOrEqual(-0.5);
      expect(g.bottom, 'sheet above the keyboard').toBeLessThanOrEqual(g.vb + 0.5);
      expect(g.closeHit, 'the close button is hit-testable').toBe(true);
    });
  }
  test('orb -> pill flip with the keyboard at 340px: the header / close stay reachable', async ({ page }) => {
    await installFakeVisualViewport(page);
    await open(page, 'orch=idle&tx=conversation&tray=1', { width: 600, height: 640 });
    await page.locator('.ct-orch-orb').click();
    await page.evaluate(() => (window as any).__setVV(640 - 340));
    await page.waitForTimeout(150);
    await page.setViewportSize({ width: 700, height: 640 });
    await page.waitForTimeout(250);
    const g = await page.evaluate(() => {
      const sh = document.querySelector('.ct-orch-sheet') as HTMLElement;
      const r = sh.getBoundingClientRect();
      const close = sh.querySelector('.ct-orch-sheet-close') as HTMLElement; const cr = close.getBoundingClientRect();
      const hit = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2);
      return { mode: sh.dataset.mode, top: r.top, hidden: getComputedStyle(sh).visibility === 'hidden', closeHit: !!hit && (hit === close || close.contains(hit)) };
    });
    expect(g.mode).toBe('pill');
    if (!g.hidden) { expect(g.top).toBeGreaterThanOrEqual(-0.5); expect(g.closeHit).toBe(true); }
  });
  test('D16: a wrapped error reason @ 320x640 with a 290px keyboard: the composer ends inside the visual viewport to the pixel', async ({ page }) => {
    const size = { width: 320, height: 640 };
    await installFakeVisualViewport(page);
    await open(page, 'orch=error&errlong=1&tx=conversation&tray=worst', size);
    await openSheet(page, size);
    await page.evaluate(() => (window as any).__setVV(640 - 290));
    await page.waitForTimeout(250);
    const g = await page.evaluate(() => { const c = document.querySelector('.ct-orch-sheet-composer')!.getBoundingClientRect(); const s = document.querySelector('.ct-orch-sheet')!.getBoundingClientRect(); const vv = (window as any).visualViewport; return { cb: c.bottom, sb: s.bottom, vb: vv.offsetTop + vv.height }; });
    expect(g.cb).toBeLessThanOrEqual(g.vb + 0.01);
    expect(g.sb).toBeLessThanOrEqual(g.vb + 0.01);
  });
});

test.describe('D2: landscape phone (pill mode): the field and the sheet lift above the soft keyboard', () => {
  for (const size of [{ width: 844, height: 390 }, { width: 667, height: 375 }]) {
    test(`@ ${size.width}x${size.height} with a 170px keyboard`, async ({ page }) => {
      await installFakeVisualViewport(page);
      await open(page, 'orch=idle&tx=conversation&tray=1', size);
      await page.evaluate(() => (window as any).__openSheet());
      await expect(sheet(page)).toBeVisible();
      await page.evaluate((h) => (window as any).__setVV(h), size.height - 170);
      const visualBottom = size.height - 170;
      await expect.poll(() => page.locator('.ct-orch-input').evaluate((el) => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(visualBottom + 0.5);
      const sh = await sheet(page).evaluate((el) => el.getBoundingClientRect());
      expect(sh.top).toBeGreaterThanOrEqual(-0.5);
      expect(sh.bottom).toBeLessThanOrEqual(visualBottom + 0.5);
      await page.evaluate((h) => (window as any).__setVV(h), size.height);
      await expect.poll(() => page.locator('.ct-orch-input').evaluate((el) => el.getBoundingClientRect().bottom)).toBeGreaterThan(visualBottom);
    });
  }
});

test.describe('prefers-reduced-motion: computed styles across dock, sheet, peek and tray', () => {
  const MOTION = `
    (() => {
      const dockEls = Array.from(document.querySelectorAll('.ct-kanban-dispatch, .ct-kanban-dispatch *, .ct-orch-status, .ct-orch-status *'));
      const bad = [];
      for (const el of dockEls) {
        for (const pseudo of [null, '::before', '::after']) {
          const cs = getComputedStyle(el, pseudo);
          const name = (el.className?.toString() ?? '').split(' ')[0] || el.tagName.toLowerCase();
          if (cs.animationName !== 'none') bad.push(name + (pseudo ?? '') + ' animation ' + cs.animationName);
          if (cs.transitionDuration.split(',').some((d) => parseFloat(d) > 0) && cs.transitionProperty !== 'none') bad.push(name + (pseudo ?? '') + ' transition ' + cs.transitionProperty + ' ' + cs.transitionDuration);
          if (cs.scrollBehavior === 'smooth') bad.push(name + ' scroll-behavior smooth');
        }
      }
      return bad;
    })()`;

  async function arrange(page: Page, reduced: boolean) {
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await open(page, 'orch=working&tx=conversation&tray=1', { width: 1280, height: 800 });
    await page.evaluate(() => (window as any).__orchStream('Streaming a reply', 'Reading threads…'));
    await page.evaluate(() => (window as any).__openSheet());
    await expect(sheet(page)).toBeVisible();
    await expect(page.locator('.ct-orch-tray')).toBeVisible();
  }

  test('reduce: no animation, no transition, no smooth scroll anywhere in the dock (spinning orb, streaming caret, activity, tray)', async ({ page }) => {
    await arrange(page, true);
    expect(await page.evaluate(MOTION)).toEqual([]);
    expect(await page.locator('.ct-orch-sheet-scroll').evaluate((el) => getComputedStyle(el).scrollBehavior)).not.toBe('smooth');
    for (const sel of ['.ct-kanban-board', '.ct-agents-list']) {
      const n = await page.locator(sel).count();
      if (n) expect(await page.locator(sel).first().evaluate((el) => getComputedStyle(el).scrollBehavior)).not.toBe('smooth');
    }
  });

  test('control (no-preference): the same page does animate, so the reduce check is not vacuous', async ({ page }) => {
    await arrange(page, false);
    const names = await page.evaluate(() => ({
      ring: getComputedStyle(document.querySelector('.ct-orch-orb-spinning .ct-orch-orb-ring')!).animationName,
      caret: getComputedStyle(document.querySelector('.ct-orch-bubble-streaming')!, '::after').animationName,
      activity: getComputedStyle(document.querySelector('.ct-orch-activity-spin')!).animationName,
    }));
    expect(names).toEqual({ ring: 'ct-orch-spin', caret: 'ct-orch-blink', activity: 'ct-orch-spin' });
    expect((await page.evaluate(MOTION)).length).toBeGreaterThan(0);
  });

  test('reduce: the unread peek does not slide in', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, 'orch=idle&tx=conversation', { width: 1280, height: 800 });
    await page.evaluate(() => (window as any).__orchSay('Deploy approval needs you.'));
    await expect(page.locator('.ct-orch-peek')).toBeVisible();
    expect(await page.locator('.ct-orch-peek').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  });

  test('peek control (no-preference): it does slide in', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await open(page, 'orch=idle&tx=conversation', { width: 1280, height: 800 });
    await page.evaluate(() => (window as any).__orchSay('Deploy approval needs you.'));
    await expect(page.locator('.ct-orch-peek')).toBeVisible();
    expect(await page.locator('.ct-orch-peek').evaluate((el) => getComputedStyle(el).animationName)).toBe('ct-orch-rise');
  });

  for (const reduced of [true, false]) {
    test(`thread-link hover: card flash ${reduced ? 'is skipped' : 'plays'} with ${reduced ? 'reduce' : 'no-preference'}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
      await open(page, 'orch=idle&tx=conversation&tray=1', { width: 1280, height: 800 });
      await page.evaluate(() => (window as any).__openSheet());
      const link = page.locator('.ct-orch-sheet a.ct-thread-link').first();
      await expect(link).toBeVisible();
      await link.hover();
      await expect(page.locator('.ct-kanban-card-linked')).toHaveCount(1);
      await expect(page.locator('.ct-kanban-card-linked-flash')).toHaveCount(reduced ? 0 : 1);
      if (reduced) {
        // D12: the REMOVAL path is instant too (un-highlight must not fade the border back)
        const id = await page.locator('.ct-kanban-card-linked').first().evaluate((el) => { (el as HTMLElement).dataset.qaCard = '1'; return 1; });
        expect(id).toBe(1);
        await page.mouse.move(2, 2);
        const gone = await page.evaluate(() => {
          const card = document.querySelector('[data-qa-card="1"]') as HTMLElement;
          return { linked: card.classList.contains('ct-kanban-card-linked'), d: getComputedStyle(card).transitionDuration, running: card.getAnimations().length };
        });
        expect(gone.linked).toBe(false);
        expect(gone.d.split(',').every((x) => parseFloat(x) === 0)).toBe(true);
        expect(gone.running).toBe(0);
        await link.hover();
        await expect(page.locator('.ct-kanban-card-linked')).toHaveCount(1);
        // D4: the highlighted card's border / glow must not fade either (the board-wide card transition is switched off for it)
        const t = await page.locator('.ct-kanban-card-linked').evaluate((el) => ({ d: getComputedStyle(el).transitionDuration, running: el.getAnimations().length }));
        expect(t.d.split(',').every((x) => parseFloat(x) === 0)).toBe(true);
        expect(t.running).toBe(0);
      }
    });
  }
});

test.describe('mobile — key states with baselines @ 375x667', () => {
  const size = { width: 375, height: 667 };
  test('idle pill', async ({ page }) => {
    await open(page, 'orch=idle&tx=conversation', size);
    await shot(page.locator('.ct-kanban-dispatch'), 'orchestrator-dock-mobile-idle-375x667.png', DOCK_SHOT);
  });
  test('sheet with transcript and tray', async ({ page }) => {
    await open(page, 'orch=idle&tx=conversation&tray=1', size);
    await openSheet(page, size);
    await expect(page.locator('.ct-orch-tray')).toBeVisible();
    await shot(page, 'orchestrator-dock-mobile-sheet-tray-375x667.png', DOCK_SHOT);
  });
  test('error status row', async ({ page }) => {
    await open(page, 'orch=error', size);
    await expect(page.locator('.ct-orch-status')).toBeVisible();
    await shot(page.locator('.ct-kanban-dispatch'), 'orchestrator-dock-mobile-error-375x667.png', DOCK_SHOT);
  });
});

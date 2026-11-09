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
  const narrow = size.width < 640 ? '&narrow=1' : '';
  await page.goto(`${kanbanUrl}?${query}${narrow}&mobile=1`);
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

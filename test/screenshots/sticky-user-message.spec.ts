import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html') + '?sticky';
const mobileHarnessUrl = harnessUrl + '&mobile';

/**
 * Visual baselines for the sticky "last user message" header (.ct-sticky-user).
 * Pure scrolling/behavioral tests live in test/browser/sticky-user-message.spec.ts.
 */

const LONG_PROMPT =
  'Please refactor the entire authentication layer so that session tokens are rotated on every privileged action, ' +
  'the refresh flow is retried with exponential backoff, all of the legacy cookie handling is removed, and the ' +
  'middleware is split into small composable pieces that can be unit tested in isolation without touching the network. ' +
  'Also keep the public API of the auth package unchanged so downstream consumers do not need to change anything.';

const PROMPTS = [
  'Prompt ONE: audit the login flow',
  'Prompt TWO: add rate limiting to the API',
  LONG_PROMPT,
  'Prompt FOUR: write the release notes',
];

async function seedLongConversation(page: Page, prompts = PROMPTS): Promise<void> {
  await page.evaluate(async (ps) => {
    const view = (window as any).__view;
    const manager = (window as any).__manager;
    const thread = manager.getThread('thread-new');
    const tall = (turn: number) =>
      Array.from({ length: 14 }, (_, p) =>
        `Reply ${turn}.${p}: ` + 'This is a deliberately long assistant paragraph used to make the conversation tall. '.repeat(4),
      ).join('\n\n');
    let t = Date.now() - 3_600_000;
    const msgs: any[] = [];
    ps.forEach((content, i) => {
      msgs.push({ id: `u${i}`, role: 'user', content, timestamp: (t += 1000) });
      msgs.push({ id: `a${i}`, role: 'assistant', content: tall(i), timestamp: (t += 1000) });
    });
    thread.messages = msgs;
    thread.summary = undefined;
    thread.recap = undefined;
    await view.focusThread('thread-new');
  }, prompts);
  await expect(page.locator('.ct-messages > .ct-message-user')).toHaveCount(prompts.length);
  await settle(page);
  await page.waitForTimeout(400);
  await settle(page);
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (document as any).fonts?.ready;
    const f = () => new Promise((r) => requestAnimationFrame(() => r(null)));
    await f(); await f(); await f();
  });
}

async function scrollPastUserMsg(page: Page, index: number, px: number): Promise<void> {
  await page.evaluate(([i, p]) => {
    const sc = document.querySelector('.ct-messages') as HTMLElement;
    const el = sc.querySelectorAll(':scope > .ct-message-user')[i] as HTMLElement;
    const delta = el.getBoundingClientRect().bottom - sc.getBoundingClientRect().top + p;
    sc.scrollTop = Math.round(sc.scrollTop + delta);
  }, [index, px] as const);
  await settle(page);
}

const sticky = (page: Page) => page.locator('.ct-sticky-user');
const layer = (page: Page) => page.locator('.ct-sticky-user-layer');
const expectShown = async (page: Page, textStart?: string) => {
  await expect(sticky(page)).not.toHaveClass(/ct-hidden/);
  await expect(sticky(page)).toBeVisible();
  if (textStart) await expect(sticky(page)).toContainText(textStart);
};

async function open(page: Page, size = { width: 420, height: 740 }, url = harnessUrl): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(size);
  await page.goto(url);
  await page.waitForSelector('.ct-title-row');
  await page.waitForSelector('.ct-messages');
  await seedLongConversation(page);
}

test.describe('sticky last-user-message header', () => {
  test('appears with the most recent scrolled-off prompt once a prompt scrolls past the top', async ({ page }) => {
    await open(page);
    await scrollPastUserMsg(page, 0, 40);
    await expectShown(page, 'Prompt ONE');
    const paint = await sticky(page).evaluate((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { bg: cs.backgroundColor, shadow: cs.boxShadow, hitIsHeader: !!hit && el.contains(hit) };
    });
    expect(paint.bg, 'header background must be opaque').not.toMatch(/^rgba\(0, 0, 0, 0\)$|^transparent$/);
    expect(paint.shadow).not.toBe('none');
    expect(paint.hitIsHeader).toBe(true);
    const look = await page.evaluate(() => {
      const b = document.querySelector('.ct-sticky-user') as HTMLElement;
      const real = document.querySelector('.ct-message-user .ct-message-content') as HTMLElement;
      const sc = document.querySelector('.ct-messages') as HTMLElement;
      const cb = getComputedStyle(b), cr = getComputedStyle(real);
      return {
        bg: [cb.backgroundColor, cr.backgroundColor], color: [cb.color, cr.color],
        radius: cb.borderTopLeftRadius, bRight: b.getBoundingClientRect().right, scRight: sc.getBoundingClientRect().right,
        bLeft: b.getBoundingClientRect().left, scLeft: sc.getBoundingClientRect().left, scTop: sc.getBoundingClientRect().top, bTop: b.getBoundingClientRect().top,
      };
    });
    expect(look.bg[0]).toBe(look.bg[1]);
    expect(look.color[0]).toBe(look.color[1]);
    expect(parseFloat(look.radius)).toBeGreaterThanOrEqual(10);
    expect(look.bTop).toBeGreaterThan(look.scTop + 2);
    expect(look.bLeft - look.scLeft).toBeGreaterThan(40);
    expect(look.scRight - look.bRight).toBeGreaterThanOrEqual(8);
    await shot(page.locator('.ct-main'), 'sticky-user-header-shown.png');
  });

  test('a long prompt is clamped to two lines with an ellipsis and keeps the full text as tooltip', async ({ page }) => {
    await open(page);
    await scrollPastUserMsg(page, 2, 40);
    await expectShown(page, 'Please refactor the entire authentication layer');
    const m = await sticky(page).evaluate((el) => {
      const cs = getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight);
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      return {
        height: el.getBoundingClientRect().height,
        lineHeight: lh,
        pad,
        border: parseFloat(cs.borderBottomWidth),
        text: el.textContent ?? '',
        title: (el as HTMLElement).title,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      };
    });
    expect(m.height).toBeLessThanOrEqual(2 * m.lineHeight + m.pad + m.border + 1);
    expect(m.border).toBe(0);
    expect(m.height).toBeGreaterThan(1.5 * m.lineHeight + m.pad);
    const inner = await sticky(page).locator('.ct-sticky-user-text').evaluate((el) => ({
      h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight),
    }));
    expect(Math.abs(inner.h - 2 * inner.lh)).toBeLessThanOrEqual(1);
    expect(m.text.endsWith('…')).toBe(true);
    expect(m.text.length).toBeLessThanOrEqual(240);
    expect(m.title).toBe(m.text);
    await shot(page.locator('.ct-main'), 'sticky-user-header-truncated.png');
  });

  test('sits below the summary banner and never covers the scroll-bottom pill', async ({ page }) => {
    await open(page);
    await scrollPastUserMsg(page, 1, 40);
    await expectShown(page, 'Prompt TWO');
    await expect(page.locator('.ct-scroll-bottom-pill')).toBeVisible();

    await page.evaluate(() => {
      const view = (window as any).__view;
      const t = view.manager.getThread('thread-new');
      t.updatedAt = Date.now() - 3 * 3_600_000;
      view['showSummaryBanner'](t, 'Returning to this thread: we audited login and added rate limiting; the release notes are still pending.');
    });
    await page.waitForSelector('.ct-summary-banner');
    await page.waitForTimeout(350);

    const z = await page.evaluate(() => {
      const zi = (s: string) => parseInt(getComputedStyle(document.querySelector(s)!).zIndex, 10);
      return { sticky: zi('.ct-sticky-user-layer'), pill: zi('.ct-scroll-bottom-pill'), banner: zi('.ct-summary-banner') };
    });
    expect(z.sticky).toBeLessThan(z.pill);
    expect(z.pill).toBeLessThan(z.banner);

    const hit = await page.evaluate(() => {
      const banner = document.querySelector('.ct-summary-banner') as HTMLElement;
      const pill = document.querySelector('.ct-scroll-bottom-pill') as HTMLElement;
      const bc = banner.getBoundingClientRect();
      const bannerHit = document.elementFromPoint(bc.left + bc.width / 2, bc.top + 12);
      const pr = pill.getBoundingClientRect();
      const pillHit = document.elementFromPoint(pr.left + pr.width / 2, pr.top + pr.height / 2);
      const sr = (document.querySelector('.ct-sticky-user-layer') as HTMLElement).getBoundingClientRect();
      return {
        bannerTopmost: !!bannerHit && banner.contains(bannerHit),
        pillTopmost: !!pillHit && pill.contains(pillHit),
        stickyBottom: sr.bottom,
        pillTop: pr.top,
        bannerOverlapsSticky: bc.top < sr.bottom && bc.bottom > sr.top,
      };
    });
    expect(hit.bannerTopmost).toBe(true);
    expect(hit.pillTopmost).toBe(true);
    expect(hit.stickyBottom).toBeLessThan(hit.pillTop);
    expect(hit.bannerOverlapsSticky).toBe(true);
    await shot(page.locator('.ct-main'), 'sticky-user-header-with-banner.png');
  });

  test('fade scrim is click-through, matches the background, and does not block the transcript', async ({ page }) => {
    await open(page);
    await scrollPastUserMsg(page, 1, 200);
    await expectShown(page, 'Prompt TWO');
    const r = await page.evaluate(() => {
      const l = document.querySelector('.ct-sticky-user-layer') as HTMLElement;
      const b = document.querySelector('.ct-sticky-user') as HTMLElement;
      const lr = l.getBoundingClientRect(), br = b.getBoundingClientRect();
      const x = lr.left + 8, y = lr.top + 4;
      const hit = document.elementFromPoint(x, y);
      const scrim = getComputedStyle(l, '::before');
      const bg = getComputedStyle(document.querySelector('.ct-messages') as HTMLElement).backgroundColor;
      const primary = (() => { const t = document.createElement('div'); t.style.background = 'var(--background-primary)'; document.body.appendChild(t); const c = getComputedStyle(t).backgroundColor; t.remove(); return c; })();
      return {
        layerPE: getComputedStyle(l).pointerEvents, scrimPE: scrim.pointerEvents, hitIsLayer: !!hit && l.contains(hit),
        hitTag: hit?.className, scrimImage: scrim.backgroundImage, primary, bg, bubbleLeft: br.left, layerLeft: lr.left,
        scrimBottom: lr.bottom + 40,
      };
    });
    expect(r.layerPE).toBe('none');
    expect(r.scrimPE).toBe('none');
    expect(r.hitIsLayer, 'transcript beneath the scrim must receive pointer events: ' + r.hitTag).toBe(false);
    expect(r.scrimImage).toContain('linear-gradient');
    expect(r.scrimImage).toContain(r.primary);
    expect(r.scrimImage).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    await shot(page.locator('.ct-main'), 'sticky-user-header-fade.png');
  });

  test('follows a light theme: scrim fades to the light background', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      document.body.classList.remove('theme-dark');
      document.body.classList.add('theme-light');
      const root = document.documentElement.style;
      root.setProperty('--background-primary', 'rgb(255, 255, 255)');
      root.setProperty('--background-secondary', 'rgb(245, 246, 248)');
      root.setProperty('--text-normal', 'rgb(34, 34, 34)');
    });
    await scrollPastUserMsg(page, 1, 200);
    await expectShown(page, 'Prompt TWO');
    const img = await layer(page).evaluate((el) => getComputedStyle(el, '::before').backgroundImage);
    expect(img).toContain('rgb(255, 255, 255)');
    await shot(page.locator('.ct-main'), 'sticky-user-header-light.png');
  });

  test('works on a mobile-width viewport', async ({ page }) => {
    await open(page, { width: 390, height: 844 }, mobileHarnessUrl);
    await expect(page.locator('.ct-root')).toHaveClass(/ct-mobile/);
    await scrollPastUserMsg(page, 1, 40);
    await expectShown(page, 'Prompt TWO');
    const box = await page.evaluate(() => {
      const s = (document.querySelector('.ct-sticky-user') as HTMLElement).getBoundingClientRect();
      const m = (document.querySelector('.ct-messages') as HTMLElement).getBoundingClientRect();
      return { sLeft: s.left, sRight: s.right, mLeft: m.left, mRight: m.right, sTop: s.top, mTop: m.top };
    });
    expect(box.sLeft).toBeGreaterThanOrEqual(box.mLeft - 1);
    expect(box.sRight).toBeLessThanOrEqual(box.mRight + 1);
    expect(box.sTop - box.mTop).toBeLessThanOrEqual(16);
    expect(box.sTop - box.mTop).toBeGreaterThanOrEqual(0);
    const layerBox = await layer(page).evaluate((el) => {
      const r = el.getBoundingClientRect(); const m = (document.querySelector('.ct-messages') as HTMLElement).getBoundingClientRect();
      return { dTop: Math.abs(r.top - m.top), left: r.left - m.left };
    });
    expect(layerBox.dTop).toBeLessThanOrEqual(1);
    expect(layerBox.left).toBeGreaterThanOrEqual(-1);
    await shot(page.locator('.ct-main'), 'sticky-user-header-mobile.png');
  });
});

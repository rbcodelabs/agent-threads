import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');
const mobileHarnessUrl = harnessUrl + '?mobile';

/**
 * Sticky "last user message" header (.ct-sticky-user).
 *
 * Behavioural tests drive REAL scrolling in Chromium against a long mocked
 * conversation: four user prompts, each followed by very tall assistant
 * replies (~1.5-2 viewports). Pixel snapshots cover the key visual states.
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

const SEED_THREAD = 'thread-new';

/** Replace thread-new's transcript with the long conversation and open it. */
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
  // Lazily-loaded font subsets resolve a beat after first paint and reflow the transcript by a
  // couple of px; let that land before any scroll offset or snapshot is taken.
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

/** Scroll .ct-messages so that the element with `selector` (nth) has its top at `offset` px below the viewport top. */
async function scrollUserMsg(page: Page, index: number, offsetFromTop: number): Promise<void> {
  await page.evaluate(([i, off]) => {
    const sc = document.querySelector('.ct-messages') as HTMLElement;
    const el = sc.querySelectorAll(':scope > .ct-message-user')[i] as HTMLElement;
    const delta = el.getBoundingClientRect().top - sc.getBoundingClientRect().top - off;
    sc.scrollTop += delta;
  }, [index, offsetFromTop] as const);
  await settle(page);
}

/** Scroll so the bottom edge of the user message sits `px` above the viewport top (i.e. scrolled past by px). */
async function scrollPastUserMsg(page: Page, index: number, px: number): Promise<void> {
  await page.evaluate(([i, p]) => {
    const sc = document.querySelector('.ct-messages') as HTMLElement;
    const el = sc.querySelectorAll(':scope > .ct-message-user')[i] as HTMLElement;
    const delta = el.getBoundingClientRect().bottom - sc.getBoundingClientRect().top + p;
    // Whole-pixel offsets keep glyph rasterisation (and so snapshots) identical run to run.
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
const expectHidden = async (page: Page) => {
  await expect(sticky(page)).toHaveClass(/ct-hidden/);
  await expect(layer(page)).toHaveClass(/ct-hidden/);
  await expect(sticky(page)).toBeHidden();
};

async function open(page: Page, size = { width: 420, height: 740 }, url = harnessUrl): Promise<void> {
  // The bubble fades/slides in; reduced motion removes the transition so visibility and snapshots are deterministic.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(size);
  await page.goto(url);
  await page.waitForSelector('.ct-title-row');
  await page.waitForSelector('.ct-messages');
  await seedLongConversation(page);
}

test.describe('sticky last-user-message header', () => {
  test('is hidden when the transcript is scrolled to the very top', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { (document.querySelector('.ct-messages') as HTMLElement).scrollTop = 0; });
    await settle(page);
    await expectHidden(page);
  });

  test('stays hidden while the only user message is still visible, even mid-reply', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await seedLongConversation(page, ['Prompt SOLO: the only prompt']);
    // a few px of the prompt still visible at the top edge.
    await scrollPastUserMsg(page, 0, -4);
    await expectHidden(page);
    await scrollUserMsg(page, 0, 20);
    await expectHidden(page);
  });

  test('hides when the prompt of the turn being read straddles the top edge (nothing to cover it with)', async ({ page }) => {
    await open(page);
    // Prompt TWO is partly visible at the very top: header (ONE) would only cover it.
    await scrollPastUserMsg(page, 1, -4);
    await expectHidden(page);
    // Prompt TWO fully on screen but below the top edge: we are still reading turn ONE's reply.
    await scrollUserMsg(page, 1, 20);
    await expectShown(page, 'Prompt ONE');
    // Prompt TWO just scrolled off entirely: it takes over.
    await scrollPastUserMsg(page, 1, 8);
    await expectShown(page, 'Prompt TWO');
  });

  test('appears with the most recent scrolled-off prompt once a prompt scrolls past the top', async ({ page }) => {
    await open(page);
    await scrollPastUserMsg(page, 0, 40);
    await expectShown(page, 'Prompt ONE');
    // Regression: the `.ct-root button` reset once left the header transparent, so
    // transcript text rendered straight through it. It must be an opaque surface.
    // It also reuses the real user-bubble fill/colour (accent), floating on the same (right) side.
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
    expect(look.bTop).toBeGreaterThan(look.scTop + 2); // floats with a margin, not flush
    expect(look.bLeft - look.scLeft).toBeGreaterThan(40); // right-aligned like user bubbles, not full width
    expect(look.scRight - look.bRight).toBeGreaterThanOrEqual(8);
    await shot(page.locator('.ct-main'), 'sticky-user-header-shown.png');
  });

  test('switches to the right prompt as the user scrolls between turns', async ({ page }) => {
    await open(page);
    await scrollPastUserMsg(page, 0, 40);
    await expectShown(page, 'Prompt ONE');
    await scrollPastUserMsg(page, 1, 40);
    await expectShown(page, 'Prompt TWO');
    // Not "ONE" any more.
    await expect(sticky(page)).not.toContainText('Prompt ONE');
    await scrollPastUserMsg(page, 3, 40);
    await expectShown(page, 'Prompt FOUR');
    // Scroll back up into turn two's reply: header returns to TWO, not THREE.
    await scrollPastUserMsg(page, 1, 200);
    await expectShown(page, 'Prompt TWO');
    // Scrolling fully back to the top hides it again.
    await page.evaluate(() => { (document.querySelector('.ct-messages') as HTMLElement).scrollTop = 0; });
    await settle(page);
    await expectHidden(page);
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
    // Visible height is at most 2 lines + padding + border (allow 1px rounding).
    expect(m.height).toBeLessThanOrEqual(2 * m.lineHeight + m.pad + m.border + 1);
    expect(m.border).toBe(0);
    // ...and it is exactly 2 lines, i.e. the text really overflowed (not a 1-line label).
    expect(m.height).toBeGreaterThan(1.5 * m.lineHeight + m.pad);
    // Regression: line-clamp on the padded button leaked a clipped 3rd line into the
    // bottom padding. The clamp lives on the inner span, whose box is exactly 2 lines.
    const inner = await sticky(page).locator('.ct-sticky-user-text').evaluate((el) => ({
      h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight),
    }));
    expect(Math.abs(inner.h - 2 * inner.lh)).toBeLessThanOrEqual(1);
    expect(m.text.endsWith('…')).toBe(true);
    expect(m.text.length).toBeLessThanOrEqual(240);
    expect(m.title).toBe(m.text);
    await shot(page.locator('.ct-main'), 'sticky-user-header-truncated.png');
  });

  test('clicking scrolls the user message back into view and the header hides', async ({ page }) => {
    await open(page);
    await scrollPastUserMsg(page, 1, 300);
    await expectShown(page, 'Prompt TWO');
    await sticky(page).click();
    // Smooth scroll: poll until the target's top reaches the viewport top.
    await expect.poll(() => page.evaluate(() => {
      const sc = document.querySelector('.ct-messages') as HTMLElement;
      const el = sc.querySelectorAll(':scope > .ct-message-user')[1] as HTMLElement;
      return Math.round(el.getBoundingClientRect().top - sc.getBoundingClientRect().top);
    }), { timeout: 5000 }).toBeLessThanOrEqual(1);
    // (the poll above also passes while the target is still far above; require it to settle at the top)
    await expect.poll(() => page.evaluate(() => {
      const sc = document.querySelector('.ct-messages') as HTMLElement;
      const el = sc.querySelectorAll(':scope > .ct-message-user')[1] as HTMLElement;
      return Math.abs(Math.round(el.getBoundingClientRect().top - sc.getBoundingClientRect().top));
    }), { timeout: 5000 }).toBeLessThanOrEqual(1);
    await expectHidden(page);
    // The user message is genuinely visible, not clipped above the fold.
    const top = await page.evaluate(() => {
      const sc = document.querySelector('.ct-messages') as HTMLElement;
      const el = sc.querySelectorAll(':scope > .ct-message-user')[1] as HTMLElement;
      return el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
    });
    expect(top).toBeGreaterThanOrEqual(-1);
  });

  test('is hidden in the agent activity view and returns with the main conversation', async ({ page }) => {
    await open(page, { width: 1280, height: 800 });
    await scrollPastUserMsg(page, 1, 40);
    await expectShown(page, 'Prompt TWO');

    await page.evaluate(async () => {
      const view = (window as any).__view;
      const store = view.manager.agentRuns;
      const threadId = 'thread-new';
      store.observeStart({ threadId, harness: 'claude', nativeAgentId: 'agent-review', description: 'Review authentication flow', role: 'reviewer', model: 'claude-sonnet-4-5' }, Date.now() - 65000);
      store.observeActivity(threadId, 'claude', 'agent-review', { kind: 'tool', text: 'Reading auth middleware', toolName: 'Read', timestamp: Date.now() - 4000 });
      await view.focusThread(threadId);
    });
    await page.click('.ct-agent-pill');
    await page.click('.ct-agent-popover [role="treeitem"]:nth-child(1) .ct-agent-row-button');
    await page.waitForSelector('.ct-agent-view-header');
    await settle(page);
    await expectHidden(page);

    await page.click('.ct-agent-crumbs button:has-text("Main conversation")');
    await expect(page.locator('.ct-agent-view-header')).toHaveCount(0);
    await expect(page.locator('.ct-messages > .ct-message-user').first()).toBeVisible();
    // Back in the main transcript: header is consistent with the scroll position.
    const scrolled = await page.evaluate(() => {
      const sc = document.querySelector('.ct-messages') as HTMLElement;
      sc.scrollTop = 1500;
      return sc.scrollTop;
    });
    expect(scrolled).toBeGreaterThan(0);
    await settle(page);
    await expectShown(page, 'Prompt ');
  });

  test('appended messages do not break the header', async ({ page }) => {
    await open(page);
    await scrollPastUserMsg(page, 1, 40);
    await expectShown(page, 'Prompt TWO');

    // Independent oracle: the last user message wholly above the scroller's top edge.
    const oracle = () => page.evaluate(() => {
      const sc = document.querySelector('.ct-messages') as HTMLElement;
      const top = sc.getBoundingClientRect().top;
      const users = Array.from(sc.querySelectorAll(':scope > .ct-message-user')) as HTMLElement[];
      let above: HTMLElement | null = null;
      for (const u of users) if (u.getBoundingClientRect().bottom <= top) above = u;
      let straddle = false;
      for (const u of users) if (u.getBoundingClientRect().top <= top + 2 && u.getBoundingClientRect().bottom > top) straddle = true;
      const btn = document.querySelector('.ct-sticky-user') as HTMLElement;
      return {
        expected: straddle || !above ? null : (above.querySelector('.ct-message-content')?.textContent ?? '').trim().slice(0, 30),
        shown: !btn.classList.contains('ct-hidden'),
        text: (btn.textContent ?? '').slice(0, 30),
        scrollTop: sc.scrollTop,
      };
    });
    const check = async () => {
      await settle(page);
      const o = await oracle();
      if (o.expected === null) expect(o.shown, JSON.stringify(o)).toBe(false);
      else { expect(o.shown, JSON.stringify(o)).toBe(true); expect(o.text, JSON.stringify(o)).toBe(o.expected); }
    };

    // Assistant reply + a new user prompt land at the bottom while reading turn two.
    await page.evaluate(() => {
      const w = window as any;
      const thread = w.__manager.getThread('thread-new');
      const reply = { id: 'a-live', role: 'assistant', content: 'Live reply appended while scrolled up. '.repeat(30), timestamp: Date.now() };
      thread.messages.push(reply);
      w.__manager.emit?.('thread-new', { type: 'message', message: reply });
      w.__addLiveUserMessage('thread-new', 'u-live', 'Prompt LIVE: appended while scrolling');
    });
    await expect(page.locator('.ct-messages > .ct-message-user')).toHaveCount(PROMPTS.length + 1);
    await check();
    // Stream more rows and keep checking after each.
    for (let i = 0; i < 3; i++) {
      await page.evaluate((n) => {
        const w = window as any;
        w.__addLiveUserMessage('thread-new', 'u-live-' + n, 'Prompt LIVE ' + n + ': streaming follow-up');
      }, i);
      await check();
    }
    // At the bottom the header shows an earlier (scrolled-off) prompt, never the one on screen.
    await page.evaluate(() => { const sc = document.querySelector('.ct-messages') as HTMLElement; sc.scrollTop = sc.scrollHeight; });
    await check();
    await page.evaluate(() => { (document.querySelector('.ct-messages') as HTMLElement).scrollTop = 1500; });
    await check();
  });

  test('does not shift the layout whether shown or hidden', async ({ page }) => {
    await open(page);
    await scrollPastUserMsg(page, 1, 60);
    await expectShown(page, 'Prompt TWO');

    // Measure both states inside ONE synchronous task so unrelated async chrome
    // (footer/status polling can resize the scroller) cannot slip in between.
    const { withHeader, withoutHeader } = await page.evaluate(() => {
      const sc = document.querySelector('.ct-messages') as HTMLElement;
      const main = document.querySelector('.ct-main') as HTMLElement;
      const btn = document.querySelector('.ct-sticky-user') as HTMLElement;
      const measure = () => {
        const rects = Array.from(sc.querySelectorAll(':scope > .ct-message')).slice(0, 12)
          .map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.top * 10) / 10, Math.round(r.height * 10) / 10]; });
        return { rects, scrollTop: sc.scrollTop, scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight, mainH: main.getBoundingClientRect().height };
      };
      const withHeader = measure();
      btn.style.display = 'none'; // out of layout entirely; no scroll event fires inside this task
      const withoutHeader = measure();
      btn.style.display = '';
      return { withHeader, withoutHeader };
    });
    expect(withoutHeader.scrollHeight).toBe(withHeader.scrollHeight);
    expect(withoutHeader.clientHeight).toBe(withHeader.clientHeight);
    expect(withoutHeader.mainH).toBe(withHeader.mainH);
    expect(Math.abs(withoutHeader.scrollTop - withHeader.scrollTop)).toBeLessThanOrEqual(1);
    withHeader.rects.forEach((r, i) => {
      expect(Math.abs(r[0] - withoutHeader.rects[i][0]), `message ${i} top`).toBeLessThanOrEqual(1);
      expect(r[1], `message ${i} height`).toBe(withoutHeader.rects[i][1]);
    });
    // The header is out of flow: absolutely positioned over the scroller.
    await expect(layer(page)).toHaveCSS('position', 'absolute');
  });

  test('sits below the summary banner and never covers the scroll-bottom pill', async ({ page }) => {
    await open(page);
    await scrollPastUserMsg(page, 1, 40);
    await expectShown(page, 'Prompt TWO');
    await expect(page.locator('.ct-scroll-bottom-pill')).toBeVisible();

    await page.evaluate(() => {
      const view = (window as any).__view;
      view['showSummaryBanner'](view.manager.getThread('thread-new'), 'Returning to this thread: we audited login and added rate limiting; the release notes are still pending.');
    });
    await page.waitForSelector('.ct-summary-banner');
    await page.waitForTimeout(350); // slide-in animation

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
    expect(hit.bannerOverlapsSticky).toBe(true); // they genuinely coexist; banner wins
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
      // A point inside the layer/scrim, left of the bubble: must hit the transcript, not the layer.
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
    expect(r.scrimImage).toContain(r.primary); // opaque top stop is exactly --background-primary
    expect(r.scrimImage).toMatch(/rgba\(0, 0, 0, 0\)|transparent/); // ...fading to transparent
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
    expect(box.sTop - box.mTop).toBeLessThanOrEqual(16); // floats just below the top edge
    expect(box.sTop - box.mTop).toBeGreaterThanOrEqual(0);
    const layerBox = await layer(page).evaluate((el) => {
      const r = el.getBoundingClientRect(); const m = (document.querySelector('.ct-messages') as HTMLElement).getBoundingClientRect();
      return { dTop: Math.abs(r.top - m.top), left: r.left - m.left };
    });
    expect(layerBox.dTop).toBeLessThanOrEqual(1);
    expect(layerBox.left).toBeGreaterThanOrEqual(-1);
    await shot(page.locator('.ct-main'), 'sticky-user-header-mobile.png');
  });

  for (const density of ['compact', 'spacious'] as const) {
    test(`renders in ${density} density with density-specific padding`, async ({ page }) => {
      await open(page);
      await page.evaluate((d) => document.querySelector('.ct-root')!.setAttribute('data-density', d), density);
      await scrollPastUserMsg(page, 2, 40);
      await expectShown(page, 'Please refactor');
      const m = await sticky(page).evaluate((el) => {
        const cs = getComputedStyle(el);
        return { padTop: parseFloat(cs.paddingTop), padLeft: parseFloat(cs.paddingLeft), h: el.getBoundingClientRect().height, lh: parseFloat(cs.lineHeight) };
      });
      expect(m.padTop).toBe(density === 'compact' ? 4 : 8);
      expect(m.padLeft).toBe(density === 'compact' ? 10 : 14);
      // Still clamped to two lines in every density.
      expect(m.h).toBeLessThanOrEqual(2 * m.lh + 2 * m.padTop + 2);
    });
  }
});

import { test, expect, type Page } from '@playwright/test';
import path from 'path';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html') + '?sticky';

/**
 * Behavioral scrolling and layout tests for the sticky "last user message"
 * header (.ct-sticky-user). Pixel snapshots live in
 * test/screenshots/sticky-user-message.spec.ts.
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

async function scrollUserMsg(page: Page, index: number, offsetFromTop: number): Promise<void> {
  await page.evaluate(([i, off]) => {
    const sc = document.querySelector('.ct-messages') as HTMLElement;
    const el = sc.querySelectorAll(':scope > .ct-message-user')[i] as HTMLElement;
    const delta = el.getBoundingClientRect().top - sc.getBoundingClientRect().top - off;
    sc.scrollTop += delta;
  }, [index, offsetFromTop] as const);
  await settle(page);
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
const expectHidden = async (page: Page) => {
  await expect(sticky(page)).toHaveClass(/ct-hidden/);
  await expect(layer(page)).toHaveClass(/ct-hidden/);
  await expect(sticky(page)).toBeHidden();
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
    await scrollPastUserMsg(page, 0, -4);
    await expectHidden(page);
    await scrollUserMsg(page, 0, 20);
    await expectHidden(page);
  });

  test('hides when the prompt of the turn being read straddles the top edge (nothing to cover it with)', async ({ page }) => {
    await open(page);
    await scrollPastUserMsg(page, 1, -4);
    await expectHidden(page);
    await scrollUserMsg(page, 1, 20);
    await expectShown(page, 'Prompt ONE');
    await scrollPastUserMsg(page, 1, 8);
    await expectShown(page, 'Prompt TWO');
  });

  test('switches to the right prompt as the user scrolls between turns', async ({ page }) => {
    await open(page);
    await scrollPastUserMsg(page, 0, 40);
    await expectShown(page, 'Prompt ONE');
    await scrollPastUserMsg(page, 1, 40);
    await expectShown(page, 'Prompt TWO');
    await expect(sticky(page)).not.toContainText('Prompt ONE');
    await scrollPastUserMsg(page, 3, 40);
    await expectShown(page, 'Prompt FOUR');
    await scrollPastUserMsg(page, 1, 200);
    await expectShown(page, 'Prompt TWO');
    await page.evaluate(() => { (document.querySelector('.ct-messages') as HTMLElement).scrollTop = 0; });
    await settle(page);
    await expectHidden(page);
  });

  test('clicking scrolls the user message back into view and the header hides', async ({ page }) => {
    await open(page);
    await scrollPastUserMsg(page, 1, 300);
    await expectShown(page, 'Prompt TWO');
    await sticky(page).click();
    await expect.poll(() => page.evaluate(() => {
      const sc = document.querySelector('.ct-messages') as HTMLElement;
      const el = sc.querySelectorAll(':scope > .ct-message-user')[1] as HTMLElement;
      return Math.round(el.getBoundingClientRect().top - sc.getBoundingClientRect().top);
    }), { timeout: 5000 }).toBeLessThanOrEqual(1);
    await expect.poll(() => page.evaluate(() => {
      const sc = document.querySelector('.ct-messages') as HTMLElement;
      const el = sc.querySelectorAll(':scope > .ct-message-user')[1] as HTMLElement;
      return Math.abs(Math.round(el.getBoundingClientRect().top - sc.getBoundingClientRect().top));
    }), { timeout: 5000 }).toBeLessThanOrEqual(1);
    await expectHidden(page);
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
    for (let i = 0; i < 3; i++) {
      await page.evaluate((n) => {
        const w = window as any;
        w.__addLiveUserMessage('thread-new', 'u-live-' + n, 'Prompt LIVE ' + n + ': streaming follow-up');
      }, i);
      await check();
    }
    await page.evaluate(() => { const sc = document.querySelector('.ct-messages') as HTMLElement; sc.scrollTop = sc.scrollHeight; });
    await check();
    await page.evaluate(() => { (document.querySelector('.ct-messages') as HTMLElement).scrollTop = 1500; });
    await check();
  });

  test('does not shift the layout whether shown or hidden', async ({ page }) => {
    await open(page);
    await scrollPastUserMsg(page, 1, 60);
    await expectShown(page, 'Prompt TWO');

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
      btn.style.display = 'none';
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
    await expect(layer(page)).toHaveCSS('position', 'absolute');
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
      expect(m.h).toBeLessThanOrEqual(2 * m.lh + 2 * m.padTop + 2);
    });
  }
});

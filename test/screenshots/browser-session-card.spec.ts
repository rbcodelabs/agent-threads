/**
 * Browser session card (docs/mockups/browser-session-card).
 *
 * One card per in-app browser session replaces the generic tool pills, and the
 * login "Take control" handoff (ADR-0014) shows up in the SAME card as a distinct
 * amber "you're in control" mode. The harness runs the REAL ThreadsView,
 * BrowserSessionPresenter and LoginHandoffController; only Geode's popup bridge
 * and the login guest are faked (test/harness/index.ts), exactly as the Agent
 * Browser preview harness does.
 *
 * Fixtures: test/harness/browser-fixtures.ts (persisted sessions) and the live
 * helpers window.__browserStep / __browserResult / __browserImage (live ones).
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');
const LOGIN_URL = 'https://accounts.acme.io/login';

type Win = { [k: string]: any };
const w = (page: Page) => page;

async function boot(page: Page, opts: { width?: number; fixedTime?: boolean } = {}): Promise<void> {
  if (opts.fixedTime !== false) await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  await page.setViewportSize({ width: opts.width ?? 420, height: 740 });
  await page.goto(harnessUrl);
  await page.waitForSelector('.ct-title-row');
  await page.waitForSelector('.ct-messages');
  await page.waitForTimeout(400);
}

const show = (page: Page, kind: string, running = false) =>
  page.evaluate(([k, r]) => (window as Win).__showBrowserFixture(k, r), [kind, running] as const);

/** Drive a live session up to "navigate done, screenshot done, click in flight". */
async function liveSession(page: Page, stopAt: 'navigating' | 'live'): Promise<void> {
  await show(page, 'live', true);
  await page.evaluate(() => (window as Win).__browserStep({ id: 'ln', name: 'browser_navigate', summary: 'https://acme.io/pricing' }));
  if (stopAt === 'navigating') return;
  await page.evaluate(() => {
    const win = window as Win;
    win.__browserResult('ln', 'success', { pageUrl: 'https://acme.io/pricing', durationMs: 1200 });
    win.__browserStep({ id: 'ls', name: 'browser_screenshot' });
    win.__browserResult('ls', 'success', { durationMs: 300 });
    // The screenshot's image arrives before any message carries it.
    win.__browserImage(win.__pricingImage);
    win.__browserStep({ id: 'lc', name: 'browser_click', summary: 'e5' });
  });
}

const card = (page: Page) => page.locator('.ct-bc').first();

test.describe('Browser session card — agent-driven states', () => {
  test.beforeEach(async ({ page }) => { await boot(page); });

  test('navigating: indeterminate progress over a skeleton', async ({ page }) => {
    await liveSession(page, 'navigating');
    await expect(card(page)).toHaveClass(/is-navigating/);
    await expect(card(page).locator('.ct-bc-status')).toHaveText('Loading');
    await expect(card(page).locator('.ct-bc-verb')).toHaveText('navigate');
    await expect(card(page).locator('.ct-bc-skel')).toBeVisible();
    await shot(page, 'browser-session-navigating.png');
  });

  test('live: the real screenshot from a not-yet-committed image, current step in the caption', async ({ page }) => {
    await liveSession(page, 'live');
    await expect(card(page)).toHaveClass(/is-live/);
    await expect(card(page).locator('.ct-bc-verb')).toHaveText('click');
    await expect(card(page).locator('.ct-bc-target')).toContainText('element e5');
    await expect(card(page).locator('.ct-bc-view img')).toBeVisible();
    await expect(card(page).locator('.ct-bc-skel')).toHaveCount(0);
    // A screenshot appears once, inside the card — never also as a loose image.
    await expect(page.locator('.ct-tool-result-images')).toHaveCount(0);
    await shot(page, 'browser-session-live.png');
  });

  test('a live session is ONE card updated in place, and never doubles as pills', async ({ page }) => {
    await liveSession(page, 'live');
    await expect(page.locator('.ct-bc')).toHaveCount(1);
    await expect(page.locator('.ct-tool-pill')).toHaveCount(0);
    await expect(page.locator('.ct-tool-group')).toHaveCount(0);
    await page.evaluate(() => (window as Win).__browserResult('lc', 'success', { pageUrl: 'https://acme.io/pricing/startup' }));
    await expect(card(page).locator('.ct-bc-url-text b')).toHaveText('/pricing/startup');
    await expect(page.locator('.ct-bc')).toHaveCount(1);
    // Every call is still on record: the step list carries what the pills used to.
    await card(page).locator('.ct-bc-steps-toggle').click();
    await expect(card(page).locator('.ct-bc-step')).toHaveCount(3);
    await expect(card(page).locator('.ct-bc-step-v')).toHaveText(['navigate', 'screenshot', 'click']);
  });

  test('when the turn ends the card settles to a collapsed finished chip', async ({ page }) => {
    await liveSession(page, 'live');
    await page.evaluate(() => (window as Win).__browserResult('lc', 'success'));
    await expect(card(page)).toHaveClass(/is-live/);
    await page.evaluate(() => (window as Win).__endTurn());
    await expect(card(page)).toHaveClass(/is-done/);
    await expect(card(page)).toHaveClass(/is-collapsed/);
    await expect(card(page).locator('.ct-bc-chip-l1')).toHaveText('Browsed acme.io');
  });

  test('finished: collapsed to a one-line chip by default', async ({ page }) => {
    await show(page, 'finished');
    await expect(card(page)).toHaveClass(/is-collapsed/);
    await expect(card(page).locator('.ct-bc-chip-l1')).toHaveText('Browsed acme.io');
    await expect(card(page).locator('.ct-bc-chip-l2')).toContainText('4 steps');
    await expect(card(page).locator('.ct-bc-thumb img')).toBeVisible();
    // The screenshot on the FINAL message is claimed by the card, not shown loose.
    await expect(page.locator('.ct-tool-result-images')).toHaveCount(0);
    await shot(page, 'browser-session-finished-collapsed.png');
  });

  test('finished: expanding shows the viewport and steps, and the choice survives a re-render', async ({ page }) => {
    await show(page, 'finished');
    await card(page).locator('.ct-bc-chip').click();
    await expect(card(page)).not.toHaveClass(/is-collapsed/);
    await card(page).locator('.ct-bc-steps-toggle').click();
    await expect(card(page).locator('.ct-bc-steps-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(card(page).locator('.ct-bc-step')).toHaveCount(4);
    await shot(page, 'browser-session-finished-expanded.png');

    // Force the refresh path the live view uses on every result/turn change.
    await page.evaluate(() => (window as Win).__emitEvent('thread-new', { type: 'tool_result_status', toolUseId: 'bt-1', status: 'success' }));
    await page.waitForTimeout(150);
    await expect(card(page)).not.toHaveClass(/is-collapsed/);
    await expect(card(page).locator('.ct-bc-steps-toggle')).toHaveAttribute('aria-expanded', 'true');

    // Collapse returns focus to the chip.
    await card(page).locator('.ct-bc-collapse').click();
    await expect(card(page)).toHaveClass(/is-collapsed/);
    await expect(card(page).locator('.ct-bc-chip')).toBeFocused();
  });

  test('error: red, stays expanded, names the failed step', async ({ page }) => {
    await show(page, 'error');
    await expect(card(page)).toHaveClass(/is-error/);
    await expect(card(page)).not.toHaveClass(/is-collapsed/);
    await expect(card(page).locator('.ct-bc-overlay[role="alert"]')).toContainText('Click failed');
    await expect(card(page).locator('.ct-bc-status')).toHaveText('Failed');
    await shot(page, 'browser-session-error.png');
  });

  test('ended: browser_close mutes the card and collapses it', async ({ page }) => {
    await show(page, 'ended');
    await expect(card(page)).toHaveClass(/is-closed/);
    await expect(card(page)).toHaveClass(/is-collapsed/);
    await expect(card(page).locator('.ct-bc-chip-l1')).toHaveText('Session ended');
    await shot(page, 'browser-session-ended.png');
  });

  test('clicking the screenshot opens it in a lightbox (an Obsidian Modal)', async ({ page }) => {
    await show(page, 'finished');
    await card(page).locator('.ct-bc-chip').click();
    await card(page).locator('button.ct-bc-view').click();
    const modalImg = page.locator('.modal-container .ct-bc-lightbox-body img, .modal-overlay .ct-bc-lightbox-body img');
    await expect(modalImg).toBeVisible();
    await expect(modalImg).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/);
  });

  test('reduced motion turns every card animation off', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await liveSession(page, 'live');
    const names = await card(page).locator('.ct-bc-status i').evaluate((el) => getComputedStyle(el).animationName);
    expect(names).toBe('none');
    const scan = await card(page).locator('.ct-bc-view').evaluate((el) => getComputedStyle(el, '::after').animationName);
    expect(scan).toBe('none');
  });

  test('wide pane: viewport left, steps always visible right', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 740 });
    await page.evaluate(() => { document.getElementById('app')!.style.width = '780px'; });
    await show(page, 'error');
    await expect(card(page)).toHaveCSS('display', 'grid');
    await expect(card(page).locator('.ct-bc-steps')).toBeVisible();
    await expect(card(page).locator('.ct-bc-steps-toggle')).toBeHidden();
    await shot(page, 'browser-session-wide.png');
  });

  test('light theme: darker teal and burnt-amber accents on white', async ({ page }) => {
    await page.evaluate(() => {
      document.body.classList.remove('theme-dark');
      document.body.classList.add('theme-light');
      const root = document.documentElement.style;
      for (const [k, v] of Object.entries({
        '--background-primary': '#ffffff', '--background-secondary': '#f3f4f6', '--background-secondary-alt': '#eceef1',
        '--background-modifier-border': '#d4d7dd', '--background-modifier-hover': 'rgba(0,0,0,0.05)',
        '--text-normal': '#222226', '--text-muted': '#5c5c64', '--text-faint': '#85858e',
      })) root.setProperty(k, v);
    });
    await liveSession(page, 'live');
    await expect(card(page)).toHaveClass(/is-live/);
    await shot(page, 'browser-session-light-live.png');
    await page.evaluate(() => (window as Win).__fireLoginOpen('https://accounts.acme.io/login'));
    await page.locator('.ct-bc-btn.is-primary').click();
    await expect(page.locator('.ct-bc.is-control')).toBeVisible();
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('.ct-bc-view.is-frame img');
      return !!img && !img.classList.contains('is-pending') && img.complete && img.naturalWidth > 0;
    });
    await shot(page, 'browser-session-light-control.png');
  });
});

test.describe('Browser session card — sign-in handoff (amber "you are in control")', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
    await show(page, 'handoff', true);
    await expect(page.locator('.ct-bc')).toHaveCount(1);
  });

  const waitForFrame = (page: Page) => page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>('.ct-bc-view.is-frame img');
    return !!img && !img.classList.contains('is-pending') && img.complete && img.naturalWidth > 0;
  });

  test('requested: countdown ring, Take control / Not now, privacy line', async ({ page }) => {
    await page.evaluate(() => (window as Win).__fireLoginOpen('https://accounts.acme.io/login'));
    const c = page.locator('.ct-bc.is-request');
    await expect(c).toBeVisible();
    await expect(c.locator('.ct-bc-mode strong')).toHaveText('Sign-in needed');
    await expect(c.locator('.ct-bc-mode-sub')).toContainText('accounts.acme.io wants you to sign in');
    await expect(c.locator('.ct-bc-ring b')).toHaveText('30');
    await expect(c.locator('.ct-bc-privacy')).toContainText("Claude can't see the sign-in page or what you type.");
    await expect(c.getByRole('button', { name: 'Take control' })).toBeVisible();
    await expect(c.getByRole('button', { name: 'Not now' })).toBeVisible();
    await expect(c.locator('.ct-bc-agent')).toContainText('Claude is waiting');
    // Requesting does not steal the composer or show the control chip.
    await expect(page.locator('.ct-bc-control-chip')).toBeHidden();
    await shot(page, 'browser-session-request.png');
  });

  test('requested: the ring counts down in place, and only the mode change is announced', async ({ page }) => {
    await boot(page, { fixedTime: false });
    await show(page, 'handoff', true);
    await page.clock.install();
    await page.evaluate(() => (window as Win).__fireLoginOpen('https://accounts.acme.io/login'));
    await expect(page.locator('.ct-bc.is-request')).toBeVisible();
    await page.clock.runFor(6000);
    await expect(page.locator('.ct-bc-ring b')).toHaveText('24');
    await expect(page.locator('.ct-bc-mode-sub')).toContainText('24s left');
    // One announcement for the mode change; the 6 ticks added none.
    await expect(page.locator('.ct-bc-live')).toHaveText(/Action needed: accounts\.acme\.io wants you to sign in/);
  });

  test('"Not now" dismisses the request', async ({ page }) => {
    await page.evaluate(() => (window as Win).__fireLoginOpen('https://accounts.acme.io/login'));
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(page.locator('.ct-bc.is-request')).toHaveCount(0);
    await expect(page.locator('.ct-bc.is-live')).toBeVisible();
  });

  test('control: solid amber banner, framed viewport streaming the login page, chip + composer cue', async ({ page }) => {
    await page.evaluate(() => (window as Win).__fireLoginOpen('https://accounts.acme.io/login'));
    await page.getByRole('button', { name: 'Take control' }).click();
    const c = page.locator('.ct-bc.is-control');
    await expect(c).toBeVisible();
    await expect(c.locator('.ct-bc-mode strong')).toHaveText("You're in control");
    await expect(c.locator('.ct-bc-cue')).toHaveText('Your input is being sent to this page');
    await expect(c.locator('.ct-bc-privacy')).toContainText("Claude can't see this page or what you type.");
    await expect(c.locator('.ct-bc-url-text')).toContainText('accounts.acme.io');
    await waitForFrame(page);
    // The persistent chip and the composer placeholder.
    const chip = page.locator('.ct-bc-control-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("You're in control · Claude is waiting");
    await expect(page.locator('.ct-input')).toHaveAttribute('placeholder', 'Claude is waiting while you sign in…');
    // Announced once, politely, and focus moved to the mode's primary action.
    await expect(page.locator('.ct-bc-live')).toHaveText(/You're in control\. Claude is waiting/);
    await expect(page.locator('.ct-bc-live')).toHaveAttribute('aria-live', 'polite');
    await expect(c.getByRole('button', { name: 'Return control' })).toBeFocused();
    expect(await page.evaluate(() => (window as Win).__handoffCalls.focus)).toBe(1);
    await shot(page, 'browser-session-control.png');
  });

  test('control: pointer and keyboard on the frame reach the login guest, never the transcript', async ({ page }) => {
    await page.evaluate(() => (window as Win).__fireLoginOpen('https://accounts.acme.io/login'));
    await page.getByRole('button', { name: 'Take control' }).click();
    await waitForFrame(page);
    const before = await page.evaluate(() => JSON.stringify((window as Win).__manager.getThreads()));
    const pendingBefore = await page.evaluate(() => (window as Win).__manager.getPendingToolResultImages('thread-new').length);

    const view = page.locator('.ct-bc-view.is-frame');
    await view.click({ position: { x: 100, y: 60 } });
    await view.focus();
    await page.keyboard.type('hunter2');
    await page.keyboard.press('Enter');
    // Let a few 250ms frames arrive as well.
    await page.waitForTimeout(700);

    const input = await page.evaluate(() => (window as Win).__handoffCalls.input as Array<{ type: string; keyCode?: string }>);
    expect(input.some((e) => e.type === 'mouseDown')).toBe(true);
    expect(input.filter((e) => e.type === 'keyDown').map((e) => e.keyCode).join('')).toBe('hunter2Return');

    // PRIVACY: nothing typed or captured leaked into any agent-visible/persisted structure.
    const after = await page.evaluate(() => JSON.stringify((window as Win).__manager.getThreads()));
    expect(after).toBe(before);
    expect(after).not.toContain('hunter2');
    expect(after).not.toContain('data:image/png');
    expect(await page.evaluate(() => (window as Win).__manager.getPendingToolResultImages('thread-new').length)).toBe(pendingBefore);
    expect(await page.evaluate(() => JSON.stringify((window as Win).__view.plugin.settings))).not.toContain('hunter2');
    // The login frame exists only as the <img> in the DOM.
    expect(await page.evaluate(() => document.querySelector<HTMLImageElement>('.ct-bc-view.is-frame img')!.src.startsWith('data:image/png'))).toBe(true);
  });

  test('"Return control" (button or chip) releases the login guest and shows the resumed confirmation', async ({ page }) => {
    await page.evaluate(() => (window as Win).__fireLoginOpen('https://accounts.acme.io/login'));
    await page.getByRole('button', { name: 'Take control' }).click();
    await waitForFrame(page);
    await page.locator('.ct-bc-control-chip').getByRole('button', { name: 'Return' }).click();

    expect(await page.evaluate(() => (window as Win).__handoffCalls.release)).toEqual([{ threadId: 'thread-new', reason: 'login-complete' }]);
    const c = page.locator('.ct-bc.is-returned');
    await expect(c).toBeVisible();
    await expect(c.locator('.ct-bc-mode strong')).toHaveText('Signed in to accounts.acme.io');
    await expect(c.locator('.ct-bc-mode-sub')).toHaveText('Claude resumed');
    await expect(page.locator('.ct-bc-control-chip')).toBeHidden();
    await expect(page.locator('.ct-input')).not.toHaveAttribute('placeholder', /waiting while you sign in/);
    await shot(page, 'browser-session-returned.png');

    // ~4s later it folds back to a normal teal card that remembers the sign-in step.
    await expect(page.locator('.ct-bc.is-returned')).toHaveCount(0, { timeout: 8000 });
    const back = page.locator('.ct-bc.is-live');
    await expect(back).toBeVisible();
    await back.locator('.ct-bc-steps-toggle').click();
    await expect(back.locator('.ct-bc-step-v')).toContainText(['sign in']);
    await expect(back.locator('.ct-bc-step-t', { hasText: 'you · accounts.acme.io' })).toBeVisible();
  });

  test('the login window closing itself returns control automatically', async ({ page }) => {
    await page.evaluate(() => (window as Win).__fireLoginOpen('https://accounts.acme.io/login'));
    await page.getByRole('button', { name: 'Take control' }).click();
    await waitForFrame(page);
    await page.evaluate(() => (window as Win).__fireLoginClose());
    await expect(page.locator('.ct-bc.is-returned')).toBeVisible();
    expect(await page.evaluate(() => (window as Win).__handoffCalls.release)).toEqual([{ threadId: 'thread-new', reason: 'login-complete' }]);
  });

  test('expired: muted dashed card that says what to do', async ({ page }) => {
    await boot(page, { fixedTime: false });
    await show(page, 'handoff', true);
    await page.clock.install();
    await page.evaluate(() => (window as Win).__fireLoginOpen('https://accounts.acme.io/login'));
    await expect(page.locator('.ct-bc.is-request')).toBeVisible();
    await page.clock.fastForward('00:31');
    const c = page.locator('.ct-bc.is-expired');
    await expect(c).toBeVisible();
    await expect(c.locator('.ct-bc-mode strong')).toHaveText('Sign-in request expired');
    await expect(c.locator('.ct-bc-mode-sub')).toHaveText('Ask Claude to try again');
    await expect(c.locator('.ct-bc-hint b')).toHaveText('Ask Claude to retry');
    await expect(c.getByRole('button', { name: 'Take control' })).toHaveCount(0);
    await shot(page, 'browser-session-expired.png');
  });

  test('requested card is reachable by keyboard', async ({ page }) => {
    await page.evaluate(() => (window as Win).__fireLoginOpen('https://accounts.acme.io/login'));
    const take = page.getByRole('button', { name: 'Take control' });
    await expect(take).toBeVisible();
    // The card can re-render right after it appears, dropping focus mid-sequence;
    // retry focus + Tab as a unit until the whole move lands.
    await expect(async () => {
      await take.focus();
      await expect(take).toBeFocused({ timeout: 500 });
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: 'Not now' })).toBeFocused({ timeout: 500 });
    }).toPass();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ct-bc.is-control')).toBeVisible();
  });

  test('a request on a thread with no browser session gets its own standalone card', async ({ page }) => {
    await show(page, 'live', true);
    await expect(page.locator('.ct-bc')).toHaveCount(0);
    await page.evaluate(() => (window as Win).__fireLoginOpen('https://accounts.acme.io/login'));
    await expect(page.locator('.ct-bc-standalone .ct-bc.is-request')).toBeVisible();
    await page.getByRole('button', { name: 'Take control' }).click();
    await expect(page.locator('.ct-bc-standalone .ct-bc.is-control')).toBeVisible();
  });

  test("another thread's handoff never surfaces on the active thread", async ({ page }) => {
    await page.evaluate(() => (window as Win).__view.focusThread('thread-fix-auth'));
    await page.waitForTimeout(200);
    await page.evaluate(() => (window as Win).__fireLoginOpen('https://accounts.acme.io/login'));
    await page.waitForTimeout(200);
    await expect(page.locator('.ct-bc')).toHaveCount(0);
    await expect(page.locator('.ct-bc-control-chip')).toBeHidden();
    // Switching to the thread that owns it shows the request.
    await page.evaluate(() => (window as Win).__view.focusThread('thread-new'));
    await expect(page.locator('.ct-bc.is-request, .ct-bc-standalone .ct-bc.is-request')).toBeVisible();
  });
});

/**
 * "Sign in to Claude" card for a thread on a plain REMOTE daemon (docs/remote-daemon.md, "Signing in to Claude on a
 * remote daemon"). The REAL ThreadsView, sign-in card and client flow (src/remote/remoteSignIn.ts) run; only the
 * daemon socket is faked (test/harness/index.ts: window.__emitSignin / __signinCommands), so the whole user-facing
 * exchange is exercised:
 *
 *   remote with `auth.signin`  start -> url -> paste code -> token -> retry
 *   remote without it          instructions card (`ssh <host> -t claude /login`), nothing is started
 *   unknown capabilities       tries the remote flow (the start command decides)
 *   host / managed local       unchanged: `claude auth login` on this computer / the container's own sign-in
 *
 * Each behaviour runs at desktop (1280x800) and mobile-width (390x844) viewports; the layout states are also
 * captured as screenshots. The fake token is a placeholder; the specs assert it is never rendered.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html') + '?remote=1';
const THREAD = 'thread-fix-auth';
const FAKE_TOKEN = 'sk-ant-oat01-FAKE-PLACEHOLDER-NOT-A-REAL-TOKEN';
const MESSAGE = 'Claude sign-in expired — run `claude auth login`\n\n'
  + 'Failed to authenticate: OAuth session expired and could not be refreshed';

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

type Win = { [k: string]: any };

interface BootOpts {
  width: number;
  height: number;
  /** Which daemon the thread runs on; undefined = a host thread. */
  daemon?: 'my-server' | 'plain-box' | 'local-box';
  /** Capabilities the daemon advertises (null = not reached yet); omit to keep the harness default. */
  caps?: string[] | null;
}

async function boot(page: Page, o: BootOpts): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  await page.setViewportSize({ width: o.width, height: o.height });
  await page.goto(harnessUrl);
  await page.waitForSelector('.ct-title-row');
  await page.waitForSelector('.ct-messages');
  await page.waitForTimeout(300);
  await page.evaluate(([daemon, caps, hasCaps, message]) => {
    const w = window as Win;
    if (daemon === 'local-box') w.__addLocalContainerDaemon();
    if (hasCaps && daemon) w.__setDaemonCaps(daemon, caps);
    if (daemon) w.__markRemote(w.__THREAD, daemon);
    const manager = w.__manager;
    const thread = manager.getThread(w.__THREAD);
    thread.messages.push({ id: 'auth-pending', role: 'user', content: 'Summarize the open PRs', timestamp: Date.now() });
    thread.status = 'error';
    thread.lastError = message;
    thread.authRequired = { message, at: Date.now() };
    w.__retryCalls = [];
    manager.retryAfterSignIn = async (threadId: string) => { w.__retryCalls.push(threadId); return true; };
    w.__view.focusThread(w.__THREAD);
  }, [o.daemon ?? null, o.caps ?? null, o.caps !== undefined, MESSAGE] as const);
  await page.waitForSelector('.ct-auth-required');
}

const card = (page: Page) => page.locator('.ct-auth-required');
const signinBtn = (page: Page) => card(page).getByRole('button', { name: 'Sign in to Claude' });
const commands = (page: Page): Promise<Array<{ type: string; payload: Record<string, any> }>> => page.evaluate(() => (window as Win).__signinCommands);
const commandTypes = async (page: Page) => (await commands(page)).map((c) => c.type);
const emit = (page: Page, e: Record<string, unknown>) => page.evaluate((ev) => (window as Win).__emitSignin(ev), e);

const WITH_CAP = ['host.tools', 'harness.claude', 'auth.signin'];

test.beforeEach(async ({ page }) => {
  await page.addInitScript((id) => { (window as Win).__THREAD = id; }, THREAD);
});

for (const vp of VIEWPORTS) {
  test.describe(`Remote daemon Claude sign-in card (${vp.name} ${vp.width}x${vp.height})`, () => {
    test('with the auth.signin capability: start, link, paste code, token, retry', async ({ page }) => {
      await boot(page, { width: vp.width, height: vp.height, daemon: 'my-server', caps: WITH_CAP });
      await expect(card(page).locator('.ct-error-text')).toHaveText('Claude sign-in expired');
      await expect(signinBtn(page)).toBeVisible();
      await expect(card(page).getByRole('button', { name: 'Retry' })).toBeVisible();
      await shot(page, `remote-claude-sign-in-${vp.name}-card.png`);

      // 1. Sign in starts the flow ON the daemon (never `claude auth login` here).
      await signinBtn(page).click();
      await expect.poll(() => commandTypes(page)).toEqual(['auth.signin.start']);
      await expect(signinBtn(page)).toBeDisabled();
      await expect(card(page).locator('.ct-auth-status')).toHaveText('Starting sign-in on the daemon…');
      expect(await page.evaluate(() => (window as Win).__spawnCalls)).toEqual([]);

      // 2. The daemon reports progress and the sign-in URL: the browser opens and the link is the fallback.
      await emit(page, { kind: 'progress', text: 'Waiting for the browser sign-in…' });
      await expect(card(page).locator('.ct-auth-status')).toHaveText('Waiting for the browser sign-in…');
      await emit(page, { kind: 'url', url: 'https://claude.ai/oauth/authorize?code=true&client_id=demo' });
      // (The harness's createEl does not apply the `href` shorthand that Obsidian does, so the link is asserted by presence and text; the URL by window.open.)
      await expect(card(page).locator('a.ct-auth-link')).toHaveText('Browser didn’t open? Open the sign-in page');
      expect(await page.evaluate(() => (window as Win).__openedUrls)).toEqual(['https://claude.ai/oauth/authorize?code=true&client_id=demo']);

      // 3. The daemon asks for the code; the paste field appears (a second prompt must not stack another).
      await emit(page, { kind: 'prompt' });
      await emit(page, { kind: 'prompt' });
      await expect(card(page).locator('.ct-auth-code-prompt')).toHaveCount(1);
      await expect(card(page).locator('.ct-auth-code-input')).toBeFocused();
      await shot(page, `remote-claude-sign-in-${vp.name}-code-prompt.png`);

      // 4. Submitting sends the code to the daemon, tagged with the flow id.
      await card(page).locator('.ct-auth-code-input').fill('  PASTED-LOGIN-CODE  ');
      await card(page).getByRole('button', { name: 'Submit' }).click();
      await expect.poll(() => commandTypes(page)).toEqual(['auth.signin.start', 'auth.signin.code']);
      expect((await commands(page))[1].payload).toEqual({ flowId: 'flow-1', code: 'PASTED-LOGIN-CODE' });
      await expect(card(page).locator('.ct-auth-code-prompt')).toHaveCount(0);

      // 5. The token arrives: it is kept (for the keychain), the message is resent, the card goes away.
      await emit(page, { kind: 'token', token: FAKE_TOKEN });
      await expect(card(page)).toHaveCount(0);
      expect(await page.evaluate(() => (window as Win).__retryCalls)).toEqual([THREAD]);
      expect(await page.evaluate(() => (window as Win).__storedRemoteToken)).toBe(FAKE_TOKEN);
      expect(await page.locator('body').innerText()).not.toContain(FAKE_TOKEN);
      expect(await page.content()).not.toContain(FAKE_TOKEN);
    });

    test('an event from another flow is ignored once the flow id is known', async ({ page }) => {
      await boot(page, { width: vp.width, height: vp.height, daemon: 'my-server', caps: WITH_CAP });
      await signinBtn(page).click();
      await expect.poll(() => commandTypes(page)).toEqual(['auth.signin.start']);
      await page.waitForTimeout(100); // let the start ack record flow-1
      await emit(page, { kind: 'token', token: FAKE_TOKEN, flowId: 'someone-elses-flow' });
      await expect(card(page)).toHaveCount(1);
      expect(await page.evaluate(() => (window as Win).__retryCalls)).toEqual([]);
      expect(await page.evaluate(() => (window as Win).__storedRemoteToken)).toBeNull();
    });

    test('a failure on the daemon shows the reason, re-enables Sign in and does not retry', async ({ page }) => {
      await boot(page, { width: vp.width, height: vp.height, daemon: 'my-server', caps: WITH_CAP });
      await signinBtn(page).click();
      await expect.poll(() => commandTypes(page)).toEqual(['auth.signin.start']);
      await emit(page, { kind: 'error', message: 'Neither expect nor script is installed on the daemon (apt install expect).' });
      await expect(card(page).locator('.ct-auth-status')).toHaveText('Neither expect nor script is installed on the daemon (apt install expect).');
      await expect(card(page).locator('.ct-auth-status')).toHaveClass(/is-error/);
      await expect(signinBtn(page)).toBeEnabled();
      expect(await page.evaluate(() => (window as Win).__retryCalls)).toEqual([]);
      await shot(page, `remote-claude-sign-in-${vp.name}-error.png`);
    });

    test('cancelling the code prompt cancels the flow on the daemon', async ({ page }) => {
      await boot(page, { width: vp.width, height: vp.height, daemon: 'my-server', caps: WITH_CAP });
      await signinBtn(page).click();
      await expect.poll(() => commandTypes(page)).toEqual(['auth.signin.start']);
      await page.waitForTimeout(100);
      await emit(page, { kind: 'prompt' });
      await card(page).getByRole('button', { name: 'Cancel' }).click();
      await expect(card(page).locator('.ct-auth-status')).toHaveText('Sign-in cancelled.');
      await expect.poll(() => commandTypes(page)).toEqual(['auth.signin.start', 'auth.signin.cancel']);
      expect((await commands(page))[1].payload).toEqual({ flowId: 'flow-1' });
      await expect(signinBtn(page)).toBeEnabled();
    });

    test('an empty code is treated as cancel, never sent', async ({ page }) => {
      await boot(page, { width: vp.width, height: vp.height, daemon: 'my-server', caps: WITH_CAP });
      await signinBtn(page).click();
      await expect.poll(() => commandTypes(page)).toEqual(['auth.signin.start']);
      await emit(page, { kind: 'prompt' });
      await card(page).locator('.ct-auth-code-input').fill('   ');
      await card(page).getByRole('button', { name: 'Submit' }).click();
      await expect(card(page).locator('.ct-auth-status')).toHaveText('Sign-in cancelled.');
      expect(await commandTypes(page)).not.toContain('auth.signin.code');
    });

    test('a daemon that rejects the admin scope says to add an admin token', async ({ page }) => {
      await boot(page, { width: vp.width, height: vp.height, daemon: 'my-server', caps: WITH_CAP });
      await page.evaluate(() => { (window as Win).__signinStartError = { code: 'forbidden', message: 'admin scope required' }; });
      await signinBtn(page).click();
      await expect(card(page).locator('.ct-auth-status')).toHaveText('Signing in on the daemon needs an admin token. Add one in Settings, Remote daemons, Edit.');
      await expect(signinBtn(page)).toBeEnabled();
    });

    test('without the capability: instructions to sign in over ssh, nothing is started', async ({ page }) => {
      await boot(page, { width: vp.width, height: vp.height, daemon: 'plain-box' });
      await signinBtn(page).click();
      const status = card(page).locator('.ct-auth-status');
      await expect(status).toContainText('"plain-box" runs an older daemon that cannot sign in from here');
      await expect(status).toContainText('ssh plain.example.ts.net -t claude /login');
      await expect(status).toContainText('press Retry');
      await expect(status).toHaveClass(/is-error/);
      expect(await commands(page)).toEqual([]);
      expect(await page.evaluate(() => (window as Win).__spawnCalls)).toEqual([]);
      expect(await page.evaluate(() => (window as Win).__retryCalls)).toEqual([]);
      await expect(signinBtn(page)).toBeEnabled();
      await shot(page, `remote-claude-sign-in-${vp.name}-ssh-hint.png`);

      // Retry stays available and resends once the user has signed in over ssh.
      await card(page).getByRole('button', { name: 'Retry' }).click();
      await expect(card(page)).toHaveCount(0);
      expect(await page.evaluate(() => (window as Win).__retryCalls)).toEqual([THREAD]);
    });

    test('a daemon not reached yet (capabilities unknown) still tries the remote flow', async ({ page }) => {
      await boot(page, { width: vp.width, height: vp.height, daemon: 'my-server', caps: null });
      await signinBtn(page).click();
      await expect.poll(() => commandTypes(page)).toEqual(['auth.signin.start']);
    });

    test('host thread: unchanged, runs `claude auth login` on this computer, never the daemon flow', async ({ page }) => {
      await boot(page, { width: vp.width, height: vp.height });
      await signinBtn(page).click();
      await expect.poll(() => page.evaluate(() => (window as Win).__spawnCalls)).toEqual([['/opt/homebrew/bin/claude', 'auth', 'login']]);
      expect(await commands(page)).toEqual([]);
    });

    test('managed local daemon: unchanged, signs in inside its container (forced), never the remote flow', async ({ page }) => {
      await boot(page, { width: vp.width, height: vp.height, daemon: 'local-box' });
      await signinBtn(page).click();
      await expect.poll(() => page.evaluate(() => (window as Win).__localSignInCalls)).toEqual([{ force: true }]);
      expect(await commands(page)).toEqual([]);
      expect(await page.evaluate(() => (window as Win).__spawnCalls)).toEqual([]);
      // Its card completes through the same Retry path.
      await expect(card(page)).toHaveCount(0);
      expect(await page.evaluate(() => (window as Win).__retryCalls)).toEqual([THREAD]);
    });
  });
}


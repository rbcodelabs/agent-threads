import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { settleView } from './helpers';

/**
 * Functional (non-pixel) spec for per-daemon "Always Allow" on remote threads. Drives the REAL ThreadsView,
 * ThreadManager, KanbanView/AgentDashboard and SettingsTab in the Chromium harnesses. What is simulated: the
 * thread's `remote` field (no daemon process) and the permission request (manager.permissionHandler is called
 * directly, as ThreadManager does for a harness permission request). No baselines; screenshots go to QA_SHOTS.
 */
const harness = 'file://' + path.resolve('test/harness/index.html');
const kanban = 'file://' + path.resolve('test/harness/kanban.html');
const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
const SHOTS = process.env.QA_SHOTS;
const REMOTE_THREAD = 'thread-fix-auth';

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) });
}

async function openThreads(page: Page, width = 1280, height = 800, daemonId = 'my-server') {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  await page.setViewportSize({ width, height });
  await page.goto(harness);
  await page.waitForSelector('.ct-title-row');
  await page.waitForSelector('.ct-messages');
  await page.waitForTimeout(300);
  await page.evaluate(([id, d]) => {
    const w = window as any;
    w.__markRemote(id);
    w.__manager.getThread(id).remote.daemonId = d;
    w.__view.plugin.settings.alwaysAllowedTools = [];
    w.__view.plugin.settings.remoteAlwaysAllowedTools = {};
    w.__saves = 0;
    w.__view.plugin.saveSettings = async () => { w.__saves++; };
    return w.__view.focusThread(id);
  }, [REMOTE_THREAD, daemonId]);
  await page.waitForTimeout(200);
}

/** Starts a permission request on a thread; the decision lands in window.__decisions[key]. */
function request(page: Page, threadId: string, tool: string, key: string, detail = '{"file":"a.txt"}') {
  return page.evaluate(([t, n, k, d]) => {
    const w = window as any;
    w.__decisions ??= {};
    w.__decisions[k] = null;
    w.__view.manager.permissionHandler(t, n, d).then((v: boolean) => { w.__decisions[k] = v; });
  }, [threadId, tool, key, detail]);
}
const decision = (page: Page, key: string) => page.evaluate((k) => (window as any).__decisions[k], key);
const settingsOf = (page: Page) => page.evaluate(() => {
  const s = (window as any).__view.plugin.settings;
  return { local: s.alwaysAllowedTools, remote: s.remoteAlwaysAllowedTools };
});
const always = (page: Page) => page.locator('.ct-permission-card').getByRole('button', { name: 'Always Allow', exact: true });

test.describe('ThreadsView: Always Allow on a remote thread', () => {
  test('shows the button, persists under the daemon, and skips the card next time', async ({ page }) => {
    await openThreads(page);
    await request(page, REMOTE_THREAD, 'mcp__x__read_file', 'a');
    await expect(page.locator('.ct-permission-card')).toBeVisible();
    await expect(always(page)).toBeVisible();
    await settleView(page);
    await page.addStyleTag({ content: '.ct-scroll-bottom-pill { display: none !important; }' });
    await shot(page, 'threads-remote-card-1280.png');
    await always(page).click();
    await expect(page.locator('.ct-permission-card')).toHaveCount(0);
    expect(await decision(page, 'a')).toBe(true);
    expect(await settingsOf(page)).toEqual({ local: [], remote: { 'my-server': ['mcp__x__read_file'] } });
    expect(await page.evaluate(() => (window as any).__saves)).toBeGreaterThanOrEqual(1);

    await request(page, REMOTE_THREAD, 'mcp__x__read_file', 'b');
    await page.waitForTimeout(100);
    expect(await decision(page, 'b')).toBe(true);
    await expect(page.locator('.ct-permission-card')).toHaveCount(0);

    // A different tool on the same daemon still prompts.
    await request(page, REMOTE_THREAD, 'mcp__x__write_file', 'c');
    await expect(page.locator('.ct-permission-card')).toBeVisible();
    expect(await decision(page, 'c')).toBeNull();
  });

  test('another daemon is still prompted for a tool allowed on the first', async ({ page }) => {
    await openThreads(page, 1280, 800, 'plain-box');
    await page.evaluate(() => { (window as any).__view.plugin.settings.remoteAlwaysAllowedTools = { 'my-server': ['mcp__x__read_file'] }; });
    await request(page, REMOTE_THREAD, 'mcp__x__read_file', 'a');
    await expect(page.locator('.ct-permission-card')).toBeVisible();
    expect(await decision(page, 'a')).toBeNull();
  });

  test('a local thread is not approved by a daemon entry and does not feed it', async ({ page }) => {
    await openThreads(page);
    const localId = await page.evaluate((remote) => (window as any).__manager.getThreads().find((t: any) => t.id !== remote && !t.remote).id, REMOTE_THREAD);
    await page.evaluate(() => { (window as any).__view.plugin.settings.remoteAlwaysAllowedTools = { 'my-server': ['mcp__x__read_file'] }; });
    await page.evaluate((id) => (window as any).__view.focusThread(id), localId);
    await request(page, localId, 'mcp__x__read_file', 'a');
    await expect(page.locator('.ct-permission-card')).toBeVisible();
    expect(await decision(page, 'a')).toBeNull();
    await always(page).click();
    expect(await decision(page, 'a')).toBe(true);
    expect(await settingsOf(page)).toEqual({ local: ['mcp__x__read_file'], remote: { 'my-server': ['mcp__x__read_file'] } });
  });

  test('the local list and trusted built-ins do not approve a remote thread', async ({ page }) => {
    await openThreads(page);
    await page.evaluate(() => { (window as any).__view.plugin.settings.alwaysAllowedTools = ['mcp__x__read_file']; });
    await request(page, REMOTE_THREAD, 'mcp__x__read_file', 'a');
    await expect(page.locator('.ct-permission-card')).toBeVisible();
    expect(await decision(page, 'a')).toBeNull();
    await page.locator('.ct-permission-card').getByRole('button', { name: 'Deny' }).click();
    expect(await decision(page, 'a')).toBe(false);
    await request(page, REMOTE_THREAD, 'mcp__claude_threads__threads_list', 'b');
    await expect(page.locator('.ct-permission-card')).toBeVisible();
    expect(await decision(page, 'b')).toBeNull();
  });

  for (const tool of ['host_exec', 'mcp__claude_threads__host_exec', 'sync_resolve_conflict', 'mcp__claude_threads__sync_resolve_conflict']) {
    test(`${tool} has no Always Allow button and is not pre-approved even if hand-edited into data.json`, async ({ page }) => {
      await openThreads(page);
      await page.evaluate((t) => { (window as any).__view.plugin.settings.remoteAlwaysAllowedTools = { 'my-server': [t] }; }, tool);
      await request(page, REMOTE_THREAD, tool, 'a', '{"command":"ls"}');
      await expect(page.locator('.ct-permission-card')).toBeVisible();
      await expect(always(page)).toHaveCount(0);
      await expect(page.locator('.ct-permission-card').getByRole('button', { name: 'Allow once' }).or(page.locator('.ct-permission-card').getByRole('button', { name: 'Allow', exact: true }))).toBeVisible();
      expect(await decision(page, 'a')).toBeNull();
      if (SHOTS && tool === 'host_exec') await shot(page, 'threads-remote-host-exec-1280.png');
    });
  }

  test('mobile width: remote card with Always Allow fits and is tappable', async ({ page }) => {
    await openThreads(page, 390, 844);
    await request(page, REMOTE_THREAD, 'mcp__x__read_file', 'a');
    const card = page.locator('.ct-permission-card');
    await expect(card).toBeVisible();
    expect(await card.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
    const box = await always(page).boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await settleView(page);
    await page.addStyleTag({ content: '.ct-scroll-bottom-pill { display: none !important; }' });
    await shot(page, 'threads-remote-card-390.png');
    await always(page).click();
    expect(await decision(page, 'a')).toBe(true);
  });
});

for (const [label, query, always_name] of [['AgentDashboard', '?dashboard=1', 'Always Allow'], ['KanbanView', '', 'Always']] as const) {
  test.describe(`${label}: Always Allow on a remote thread`, () => {
    async function openBoard(page: Page, width = 1280, height = 800) {
      await page.setViewportSize({ width, height });
      await page.goto(kanban + query);
      await page.waitForTimeout(600);
      await page.evaluate(() => {
        const w = window as any;
        const m = w.__manager;
        const t = m.getThread('k-hiptrip-awaiting');
        t.remote = { daemonId: 'my-server', ownership: 'client', remoteCwd: '/srv/x', lastSeq: 0, ownerClientId: 'h' };
        m.pendingPermissions.set('k-hiptrip-awaiting', { toolName: 'mcp__x__read_file', detail: '{"file":"a"}' });
        w.__resolved = [];
        m.registerPermissionResolver('k-hiptrip-awaiting', (allow: boolean) => w.__resolved.push(allow));
        const plugin = (w.__kanban as any).plugin;
        plugin.settings.alwaysAllowedTools = [];
        plugin.settings.remoteAlwaysAllowedTools = {};
        w.__saves0 = w.__getSaveSettingsCalls();
        (w.__kanban as any).render();
      });
      await page.waitForTimeout(300);
    }
    const btn = (page: Page) => page.locator('.ct-permission-always');

    test('shows Always on the card and stores under the daemon', async ({ page }) => {
      await openBoard(page);
      await expect(btn(page).first()).toBeVisible();
      await shot(page, `${label}-remote-1280.png`);
      await btn(page).first().click();
      const r = await page.evaluate(() => {
        const w = window as any; const s = (w.__kanban as any).plugin.settings;
        return { local: s.alwaysAllowedTools, remote: s.remoteAlwaysAllowedTools, resolved: w.__resolved, saves: w.__getSaveSettingsCalls() - w.__saves0 };
      });
      expect(r).toEqual({ local: [], remote: { 'my-server': ['mcp__x__read_file'] }, resolved: [true], saves: 1 });
      expect(always_name).toBeTruthy();
    });

    test('no Always button for host_exec on a remote thread', async ({ page }) => {
      await openBoard(page);
      await page.evaluate(() => {
        const w = window as any;
        w.__manager.pendingPermissions.set('k-hiptrip-awaiting', { toolName: 'mcp__claude_threads__host_exec', detail: '{"command":"ls"}' });
        (w.__kanban as any).render();
      });
      await page.waitForTimeout(300);
      await expect(page.locator('.ct-permission-btn.ct-permission-allow').first()).toBeVisible();
      await expect(btn(page).filter({ hasText: /^Always( Allow)?$/ })).toHaveCount(0);
    });

    test('mobile width fits', async ({ page }) => {
      await openBoard(page, 390, 844);
      await expect(btn(page).first()).toBeVisible();
      await shot(page, `${label}-remote-390.png`);
    });
  });
}

test.describe('Settings: always-allowed tools on remote daemons', () => {
  async function openTools(page: Page, width = 1280, height = 900) {
    await page.setViewportSize({ width, height });
    await page.goto(settingsUrl);
    await page.waitForSelector('.ct-settings-shell');
    await page.evaluate(() => {
      const w = window as any;
      w.__settings.remoteDaemons = [{ id: 'my-server', name: 'my-server', url: 'wss://x', tokenSecretName: 'T' }];
      w.__settings.remoteAlwaysAllowedTools = { 'my-server': ['mcp__x__read_file', 'mcp__x__write_file'], 'gone-daemon': ['mcp__y__list'] };
      w.__settings.alwaysAllowedTools = ['LocalOnly'];
    });
    await page.getByLabel('Settings section').selectOption('tools');
    await page.evaluate(() => (window as any).__settingsTab.display());
    await page.getByLabel('Settings section').selectOption('tools');
    await expect(page.getByText('Always-allowed tools on remote daemons')).toBeVisible();
  }

  test('lists per daemon, flags the unconfigured one, and Remove revokes only that entry', async ({ page }) => {
    await openTools(page);
    const list = page.locator('.ct-allowed-tools-list').nth(1);
    await expect(list).toContainText('my-server');
    await expect(list).toContainText('gone-daemon (daemon no longer configured)');
    await list.scrollIntoViewIfNeeded();
    await shot(page, 'settings-remote-list-1280.png');
    await list.locator('.setting-item', { hasText: 'gone-daemon' }).getByRole('button', { name: 'Remove' }).click();
    expect(await page.evaluate(() => (window as any).__settings.remoteAlwaysAllowedTools)).toEqual({ 'my-server': ['mcp__x__read_file', 'mcp__x__write_file'] });
    expect(await page.evaluate(() => (window as any).__settings.alwaysAllowedTools)).toEqual(['LocalOnly']);
    await expect(list).not.toContainText('gone-daemon');
    for (let i = 0; i < 2; i++) await list.getByRole('button', { name: 'Remove' }).first().click();
    expect(await page.evaluate(() => (window as any).__settings.remoteAlwaysAllowedTools)).toEqual({});
    await expect(list).toContainText('No tools always allowed on remote daemons yet.');
  });

  test('mobile width renders the list without horizontal overflow', async ({ page }) => {
    await openTools(page, 390, 844);
    const list = page.locator('.ct-allowed-tools-list').nth(1);
    await list.scrollIntoViewIfNeeded();
    expect(await list.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
    await shot(page, 'settings-remote-list-390.png');
  });
});

import { expect, test } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Drives the REAL plugin build inside the REAL Geode app (Geode's @rbcodelabs/geode-plugin-test harness).
// Only the daemon connection is faked. Run: npm run build && npm run test:real-app
const GEODE = process.env.GEODE_REPO;
test.skip(!GEODE, 'set GEODE_REPO (npm run test:real-app does this via scripts/geode-harness.mts)');

test('connection pill menu opens directly under the pill and stays in the window', async () => {
  const { launchApp } = await import(pathToFileURL(path.join(GEODE!, 'packages/plugin-test/src/index.ts')).href);
  const h = await launchApp({ plugins: [{ id: 'claude-threads', dir: path.resolve(__dirname, '../../dist') }], viewport: { width: 1200, height: 800 } });
  try {
    await h.page.evaluate(() => (window as any).app.commands.executeCommandById('claude-threads:open-claude-threads'));
    await h.page.waitForSelector('.ct-input');
    await h.page.evaluate(async () => {
      const plugin = (window as any).app.pluginManager.getPlugin('claude-threads');
      const conn = { status: 'connected', attempt: 0 };
      // Same surface test/harness/index.ts fakes for the screenshot suite.
      plugin.daemonRegistry = {
        nameOf: () => 'my-server', capabilitiesOf: () => ['host.tools', 'harness.claude'], warm: async () => {},
        clientFor: () => ({ connect() {}, get connection() { return conn; } }),
        stateOf: () => conn, onState: () => () => {},
      };
      const t = plugin.manager.createThread('Pill test');
      t.remote = { daemonId: 'my-server', ownership: 'client', remoteCwd: '/srv/workspaces/agent-threads', lastSeq: 0, ownerClientId: 'harness' };
      await (window as any).app.workspace.getLeavesOfType('claude-threads:chat')[0]?.view?.focusThread?.(t.id);
    });
    const pill = h.page.locator('[data-testid="remote-pill"]');
    await expect(pill).toHaveText('Connected');
    const p = (await pill.boundingBox())!;
    await pill.click();
    const menu = h.page.locator('.menu');
    await expect(menu.locator('.menu-item')).toContainText(['Restart session', 'Reconnect']);
    const m = (await menu.boundingBox())!;
    const vp = h.page.viewportSize()!;
    expect(m.y).toBeGreaterThanOrEqual(p.y + p.height - 1); // below the pill, not covering it
    expect(m.y - (p.y + p.height)).toBeLessThan(8);          // and right under it
    expect(m.x + m.width).toBeLessThanOrEqual(vp.width);
    if (process.env.PILL_SHOT) await h.page.screenshot({ path: process.env.PILL_SHOT });
  } finally { await h.close(); }
});

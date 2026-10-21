// End-to-end "user journey" in real WebKit (iPhone profile) against Geode's real mobile renderer:
// Settings -> Community plugins -> Supported plugins -> Install Agent Threads (catalog fetch, size
// limit, SHA-256 verification, manifest agreement) -> enable -> plugin loads, no console errors.
//   GEODE_DIR=~/projects/geode CATALOG=<path to supported-plugins.v1.json> node scripts/check-mobile-install.mjs <dir with release main.js/manifest.json/styles.css>
import { webkit, devices } from 'playwright-core';
import fs from 'fs';
const dir = process.argv[2]; const geodeDir = process.env.GEODE_DIR || `${process.env.HOME}/projects/geode`;
const catalog = JSON.parse(fs.readFileSync(process.env.CATALOG, 'utf8'));
const entry = catalog.plugins.find(p => p.id === 'claude-threads');
const tag = entry.manifest.releaseTag;
const url = `file://${geodeDir}/dist/mobile/index.html?external-vault-proof=1`;
const CORS = { 'access-control-allow-origin': '*' };
const b = await webkit.launch();
const ctx = await b.newContext({ ...devices['iPhone 13'], bypassCSP: true });
const page = await ctx.newPage();
const logs = []; page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`.slice(0, 300))); page.on('pageerror', e => logs.push('[pageerror] ' + String(e).slice(0, 300)));
// The browser build keeps vault files in localStorage (~5 MB quota); a real iPhone writes to the
// Capacitor filesystem. Overflow values the quota rejects into memory so the 7.6 MB bundle fits.
await page.addInitScript(() => {
  const proto = Storage.prototype, set = proto.setItem, get = proto.getItem, rm = proto.removeItem, over = new Map();
  proto.setItem = function (k, v) { try { set.call(this, k, v); over.delete(k); } catch (e) { if (e && e.name === 'QuotaExceededError' || /quota/i.test(String(e))) { over.set(k, String(v)); } else throw e; } };
  proto.getItem = function (k) { return over.has(k) ? over.get(k) : get.call(this, k); };
  proto.removeItem = function (k) { over.delete(k); rm.call(this, k); };
});
await page.route('https://geode.rbcodelabs.com/supported-plugins/v1.json', r => r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(catalog) }));
const requested = [];
await page.route(`https://github.com/${entry.github.owner}/${entry.github.repo}/releases/download/${tag}/*`, r => {
  const f = r.request().url().split('/').pop(); requested.push(f);
  fs.existsSync(`${dir}/${f}`) ? r.fulfill({ status: 200, contentType: 'application/octet-stream', headers: CORS, body: fs.readFileSync(`${dir}/${f}`) }) : r.fulfill({ status: 404, headers: CORS, body: 'nf' });
});
const step = (m) => console.log('•', m); let failed = false; const fail = (m) => { failed = true; console.log('✗', m); };
try {
  await page.goto(url); 
  await page.waitForSelector('[aria-label="Mobile navigation"]', { state: 'attached', timeout: 20000 });
  await page.evaluate(() => window.app.commands.execute('open-another-vault'));
  await page.getByRole('button', { name: 'Choose folder in Files' }).click();
  await page.waitForFunction(() => window.app?.vault?.root === 'external://browser-provider-proof', null, { timeout: 15000 });
  await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'More' }).click();
  await page.locator('.menu.mod-mobile-more').getByText('Settings', { exact: true }).click();
  const sel = page.locator('.modal.mod-settings .settings-section-selector');
  if (await sel.isVisible()) { await sel.click(); await page.getByRole('dialog', { name: 'Settings sections' }).locator('.settings-section-row', { hasText: 'Community plugins & themes' }).click(); }
  else await page.locator('.modal.mod-settings .vertical-tab-nav-item', { hasText: 'Community plugins & themes' }).click();
  const row = page.locator('.supported-plugin-catalog [data-plugin-id="claude-threads"]');
  await row.waitFor({ timeout: 15000 });
  const text = await row.innerText(); step('catalog row: ' + text.replace(/\s+/g, ' ').slice(0, 160));
  if (/Desktop only/.test(text)) fail('row still says Desktop only');
  await row.getByRole('button', { name: /Install|Reinstall/ }).click();
  const status = row.locator('.supported-plugin-status');
  await page.waitForFunction(el => /Installed Agent Threads|Integrity|large|fail|Error|cannot/i.test(el.textContent || ''), await status.elementHandle(), { timeout: 60000 });
  const st = await status.innerText(); step('install status: ' + st);
  if (!/^Installed Agent Threads/.test(st)) fail('install failed: ' + st);
  step('downloaded: ' + requested.sort().join(', '));
  const enabled = await page.evaluate(async () => { try { await window.app.pluginManager.enable('claude-threads'); } catch (e) { return 'threw: ' + e.message; } return window.app.pluginManager.isEnabled('claude-threads'); });
  step('enable result: ' + enabled); if (enabled !== true) fail('plugin did not enable: ' + enabled);
  await page.waitForTimeout(2000);
  const view = await page.evaluate(async () => { const ws = window.app.workspace; const leaf = ws.getRightLeaf(false); await leaf.setViewState({ type: 'claude-threads:mobile', active: true }); ws.revealLeaf(leaf); await new Promise(r => setTimeout(r, 1500)); return document.body.innerText.includes('Not connected'); });
  step('mobile view rendered: ' + view); if (!view) fail('mobile view did not render');
} catch (e) { fail('exception: ' + String(e).slice(0, 400)); try { console.log('  status now:', await page.locator('.supported-plugin-catalog [data-plugin-id="claude-threads"] .supported-plugin-status').innerText()); } catch {} console.log('  requested:', requested.join(',')); console.log(logs.slice(-6).join('\n')); }
const errs = logs.filter(l => /^\[(error|pageerror)\]/.test(l)); if (errs.length) { fail('console errors:\n  ' + errs.join('\n  ')); }
console.log(failed ? 'FAILED' : 'PASS: install from supported catalog -> enable -> mobile view, clean console');
await b.close(); process.exit(failed ? 1 : 0);

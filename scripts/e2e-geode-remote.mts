#!/usr/bin/env node
/**
 * Geode end-to-end for remote threads (PR 5). Launches the REAL Geode app
 * (hidden: GEODE_HEADLESS=1, throwaway --user-data-dir) with the REAL built
 * plugin, against a locally running daemon (`--fake-harness`), and checks:
 *
 *   1. a thread created on the daemon streams tokens into the chat incrementally and the
 *      final message persists (in memory and in data.json);
 *   2. dropping the socket mid-turn (a killable TCP proxy) resumes with no lost or duplicated text;
 *   3. quitting Geode mid-turn leaves the turn running on the daemon, and reopening completes
 *      the transcript without any user action;
 *   4. the host badge / connection pill render (screenshots saved);
 *   5. vault path mapping: with a vault mapping configured, choosing "Run on" in the real composer for a
 *      thread whose folder is inside the vault pre-fills the mapped remote folder, the thread runs there
 *      on a daemon whose workspace allowlist is that root, its system prompt carries the vault-mirror
 *      addendum, and `path.check` answers allowed / not allowed over the wire;
 *   6. folder discovery: the same composer shows the folders the daemon itself advertises (a dropdown, no
 *      text field to type a path into), the vault-kind folder is detected from its marker directory, the
 *      mapped folder is preselected for the vault thread, and Browse lists subfolders over `path.list`.
 *
 *   npm run build && npm run build:daemon && node scripts/e2e-geode-remote.mts
 *
 * Needs a Geode checkout with node_modules + dist (default ~/projects/geode, override GEODE_REPO).
 * Clean up stragglers with `npm run e2e:kill` in the Geode checkout.
 */
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startKillableProxy, type KillableProxy } from '../test/helpers/killableProxy.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const GEODE = process.env.GEODE_REPO ?? path.join(os.homedir(), 'projects/geode');
const SHOTS = process.env.E2E_SHOTS ?? path.join(os.tmpdir(), 'remote-threads-e2e-shots');
const req = createRequire(path.join(GEODE, 'package.json'));
const { _electron: electron } = req('@playwright/test');

const PLUGIN_ID = 'claude-threads';
const TOKEN_SECRET = 'AT_E2E_TOKEN';
const SECRET_KEY = 'ct-secret-at-e2e-token'; // secretStorageKey(TOKEN_SECRET)
const DAEMON_ID = 'e2e';
const REMOTE_CWD = '/srv/workspaces/e2e';

let failures = 0;
const log = (m: string) => console.log(m);
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | false | undefined> | T | false | undefined, ms = 20000, step = 50): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(step);
  }
}
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
const tokens = (n: number, size = 0) => Array.from({ length: n }, (_, i) => { const b = `t${i}:`; return size > b.length ? b.padEnd(size, 'x') : b; }).join('');

async function main(): Promise<void> {
  for (const f of ['dist/main.js', 'dist/manifest.json', 'dist/styles.css', 'dist/agent-threads.cjs']) {
    if (!existsSync(path.join(repo, f))) throw new Error(`missing ${f}; run npm run build && npm run build:daemon`);
  }
  if (!existsSync(path.join(GEODE, 'dist/main.js'))) throw new Error(`Geode is not built at ${GEODE}`);
  await fs.mkdir(SHOTS, { recursive: true });

  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-threads-e2e-'));
  const daemonDir = path.join(base, 'daemon');
  const userData = path.join(base, 'userdata');
  const vault = path.join(base, 'vault');
  const plugin = path.join(vault, '.geode/plugins', PLUGIN_ID);
  // The "remote" vault mirror the daemon is allowed to work in, and the matching local vault folder.
  const remoteVault = path.join(base, 'remote-vault');
  await Promise.all([fs.mkdir(daemonDir), fs.mkdir(userData), fs.mkdir(plugin, { recursive: true }),
    fs.mkdir(path.join(remoteVault, 'Projects/Alpha'), { recursive: true }), fs.mkdir(path.join(remoteVault, '.obsidian'), { recursive: true }), fs.mkdir(path.join(vault, 'Projects/Alpha'), { recursive: true })]);

  let daemon: ChildProcess | undefined;
  let proxy: KillableProxy | undefined;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    // ── daemon ──────────────────────────────────────────────────────────────
    const daemonPort = await freePort();
    daemon = spawn(process.execPath, [path.join(repo, 'dist/agent-threads.cjs'), 'serve', '--fake-harness', '--data-dir', daemonDir, '--port', String(daemonPort), '--listen', '127.0.0.1', '--workspace', remoteVault, '--workspace', '/srv/workspaces'], { stdio: ['ignore', 'pipe', 'pipe'] });
    daemon.stdout!.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`[daemon] ${d}`));
    daemon.stderr!.on('data', (d) => process.stderr.write(`[daemon:err] ${d}`));
    await until('daemon health', async () => fetch(`http://127.0.0.1:${daemonPort}/healthz`).then((r) => r.ok).catch(() => false), 15000);
    const tokenOut = await new Promise<string>((resolve, reject) => {
      const p = spawn(process.execPath, [path.join(repo, 'dist/agent-threads.cjs'), 'token', 'create', '--name', 'e2e', '--scope', 'admin', '--data-dir', daemonDir]);
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`token create exited ${code}`))));
    });
    const token = /token:\s+(\S+)/.exec(tokenOut)![1];
    proxy = await startKillableProxy('127.0.0.1', daemonPort);
    log(`daemon on :${daemonPort}, proxy on :${proxy.port}`);

    // ── vault + plugin install ──────────────────────────────────────────────
    for (const f of ['main.js', 'manifest.json', 'styles.css']) await fs.copyFile(path.join(repo, 'dist', f), path.join(plugin, f));
    await fs.writeFile(path.join(plugin, 'data.json'), JSON.stringify({
      offerChiefOfStaffOnFirstRun: false,
      debugLogging: !!process.env.E2E_VERBOSE,
      remoteClientId: 'e2e-client',
      remoteDaemons: [{ id: DAEMON_ID, name: 'e2e-box', url: `ws://127.0.0.1:${proxy.port}`, tokenSecretName: TOKEN_SECRET }],
      projects: [], threads: [],
    }));
    await fs.writeFile(path.join(vault, '.geode/plugins.json'), JSON.stringify([PLUGIN_ID]));
    await fs.writeFile(path.join(vault, 'Welcome.md'), '# e2e vault\n');
    await fs.writeFile(path.join(userData, 'geode.json'), JSON.stringify({ lastVault: vault, recentVaults: [vault] }));

    const launch = () => electron.launch({
      args: [GEODE, `--user-data-dir=${userData}`],
      cwd: GEODE,
      env: { ...process.env, GEODE_HEADLESS: '1', NODE_OPTIONS: `--require ${path.join(here, 'e2e', 'no-keychain.cjs')}` },
    });
    const bootPage = async () => {
      app = await launch();
      const page = await app.firstWindow();
      page.on('pageerror', (e: Error) => console.log(`[page error] ${e.message}`));
      if (process.env.E2E_VERBOSE) page.on('console', (m: any) => { if (/DaemonClient|RemoteHarness/.test(m.text())) console.log(`[page] ${m.text().slice(0, 300)}`); });
      await until('plugin loaded', () => page.evaluate((id) => !!(window as any).app?.plugins?.plugins?.[id]?.manager, PLUGIN_ID), 60000, 250);
      return page;
    };
    const P = `window.app.plugins.plugins['${PLUGIN_ID}']`;

    // ── launch 1 ────────────────────────────────────────────────────────────
    let page = await bootPage();
    check('plugin loaded in real Geode', true);
    await page.evaluate(([key, value]) => (window as any).app.secretStorage.setSecret(key, value), [SECRET_KEY, token]);
    check('token stored through app.secretStorage', await page.evaluate((k) => !!(window as any).app.secretStorage.getSecret(k), SECRET_KEY));
    await page.evaluate(`(() => { window.__states = []; ${P}.daemonRegistry.onState((id, s) => window.__states.push(s.status + ':' + s.attempt + (s.detail ? ':' + s.detail : ''))); })()`);

    // 1. create a thread on the daemon and watch it stream
    const threadId: string = await page.evaluate(`${P}.dispatchNewThread('/tokens 60 burst=1 delay=40', undefined, 'e2e remote', { remote: { daemonId: '${DAEMON_ID}', cwd: '${REMOTE_CWD}' } })`);
    await page.evaluate(`${P}.openThreadInChatView('${threadId}')`);
    check('thread is marked remote', await page.evaluate(`!!${P}.manager.getThread('${threadId}')?.remote`));
    const lengths: number[] = [];
    const assistantCount = () => page.evaluate(`${P}.manager.getThread('${threadId}').messages.filter(m => m.role === 'assistant').length`) as Promise<number>;
    const streamingLen = () => page.evaluate(`document.querySelector('.ct-streaming .ct-message-content')?.textContent?.length ?? 0`) as Promise<number>;
    const t0 = Date.now();
    while ((await assistantCount()) < 1 && Date.now() - t0 < 30000) { const l = await streamingLen(); if (l > 0) lengths.push(l); await sleep(25); }
    const distinct = [...new Set(lengths)];
    const monotonic = lengths.every((v, i) => i === 0 || v >= lengths[i - 1]);
    check('tokens render incrementally in the chat', distinct.length >= 8 && monotonic, `${distinct.length} distinct streaming lengths over ${lengths.length} samples`);
    await sleep(300);
    const expected1 = tokens(60);
    const msgs1: string[] = await page.evaluate(`${P}.manager.getThread('${threadId}').messages.filter(m => m.role === 'assistant').map(m => m.content)`);
    check('final message persisted in the transcript, exactly once and complete', msgs1.length === 1 && msgs1[0] === expected1, `len ${msgs1[0]?.length} vs ${expected1.length}`);
    check('final message rendered in the DOM', (await page.evaluate(`[...document.querySelectorAll('.ct-message-assistant:not(.ct-streaming) .ct-message-content')].some(e => e.textContent.includes('t59:'))`)) === true);
    const dataJson = () => JSON.parse(readFileSync(path.join(plugin, 'data.json'), 'utf8'));
    await until('data.json has the message', () => dataJson().threads?.find((t: any) => t.id === threadId)?.messages?.some((m: any) => m.role === 'assistant' && m.content === expected1), 15000);
    check('final message persisted to data.json', true);
    const badgeText = await page.evaluate(`document.querySelector('[data-testid=remote-badge] .ct-remote-badge-name')?.textContent`);
    const pillState = await page.evaluate(`document.querySelector('[data-testid=remote-pill]')?.getAttribute('data-state')`);
    check('remote strip shows host and Connected', badgeText?.trim() === 'e2e-box' && pillState === 'connected', `badge=${JSON.stringify(badgeText)} pill=${pillState}`);
    await page.screenshot({ path: path.join(SHOTS, 'remote-strip-connected.png') });

    // 2. drop the socket mid-turn
    await page.evaluate(`${P}.manager.sendMessage('${threadId}', '/tokens 100 burst=1 delay=40')`);
    await until('streaming past 30 chars', async () => (await streamingLen()) > 30, 20000, 25);
    const killed = proxy.killAll();
    log(`killed ${killed} connection(s) mid-turn`);
    await until('reconnecting pill', async () => ['reconnecting', 'connecting', 'unreachable'].includes(await page.evaluate(`document.querySelector('[data-testid=remote-pill]')?.getAttribute('data-state')`) as string), 8000, 10).catch(() => undefined);
    await page.screenshot({ path: path.join(SHOTS, 'remote-strip-after-drop.png') });
    await until('second turn to complete', async () => (await assistantCount()) >= 2, 30000, 100);
    const expected2 = tokens(100);
    const msgs2: string[] = await page.evaluate(`${P}.manager.getThread('${threadId}').messages.filter(m => m.role === 'assistant').map(m => m.content)`);
    check('resume after dropped socket: transcript has the exact text (no loss, no duplicate)', msgs2.length === 2 && msgs2[1] === expected2, `assistant messages ${msgs2.length}, last len ${msgs2[1]?.length} vs ${expected2.length}`);
    const states: string[] = await page.evaluate('window.__states');
    const names = states.map((s) => s.split(':')[0]);
    check('client went through reconnect and back to connected, with no spurious extra connection', names.join('>') === 'connecting>connected>reconnecting>connected', states.join(' > '));

    // 3. quit Geode mid-turn
    await page.evaluate(`${P}.manager.sendMessage('${threadId}', '/tokens 150 burst=1 delay=40')`);
    await until('streaming past 20 chars', async () => (await streamingLen()) > 20, 20000, 25);
    await until('turnPending persisted before quitting', () => dataJson().threads?.find((t: any) => t.id === threadId)?.remote?.turnPending === true, 10000, 50);
    const quitAt = Date.now();
    await app!.close();
    app = undefined;
    log('Geode closed mid-turn');
    // The daemon keeps going without Geode: its journal reaches onDone.
    const journal = path.join(daemonDir, 'journal', `${threadId}.ndjson`);
    await until('daemon to finish the turn while Geode is closed', () => existsSync(journal) && (readFileSync(journal, 'utf8').match(/"onDone"/g)?.length ?? 0) >= 3, 30000, 200);
    check('turn kept running on the daemon while Geode was closed', true, `${Math.round((Date.now() - quitAt) / 1000)}s after quit`);
    const persistedBefore = dataJson().threads.find((t: any) => t.id === threadId);
    check('transcript was NOT complete when Geode quit', persistedBefore.messages.filter((m: any) => m.role === 'assistant').length === 2 && persistedBefore.remote.turnPending === true);

    // reopen
    page = await bootPage();
    const expected3 = tokens(150);
    await until('transcript to complete after reopen', async () => (await page.evaluate(`${P}.manager.getThread('${threadId}')?.messages.filter(m => m.role === 'assistant').length`)) >= 3, 30000, 100);
    const msgs3: string[] = await page.evaluate(`${P}.manager.getThread('${threadId}').messages.filter(m => m.role === 'assistant').map(m => m.content)`);
    check('after reopen the transcript completes with the exact text, once', msgs3.length === 3 && msgs3[2] === expected3, `assistant messages ${msgs3.length}, last len ${msgs3[2]?.length} vs ${expected3.length}`);
    const status = await until('status settles', async () => (await page.evaluate(`${P}.manager.getThread('${threadId}').status`)) === 'waiting', 10000, 100).then(() => 'waiting').catch(() => 'not waiting');
    check('thread settles to waiting and turnPending clears', status === 'waiting' && (await page.evaluate(`${P}.manager.getThread('${threadId}').remote.turnPending === undefined`)) === true);
    await until('data.json updated after reopen', () => dataJson().threads?.find((t: any) => t.id === threadId)?.messages?.filter((m: any) => m.role === 'assistant').length === 3, 15000);
    check('reopened transcript persisted to data.json', true);
    await page.evaluate(`${P}.openThreadInChatView('${threadId}')`);
    await sleep(500);
    await page.screenshot({ path: path.join(SHOTS, 'remote-strip-after-reopen.png') });

    // 5. vault path mapping, driven through the real composer
    const mappedCwd = path.join(remoteVault, 'Projects/Alpha');
    await page.evaluate(`(() => { const p = ${P}; const d = p.settings.remoteDaemons[0]; d.vaultMapping = { remoteRoot: ${JSON.stringify(remoteVault)} }; d.defaultCwdRoot = '/srv/workspaces'; p.settings.defaultCwd = p.manager.vaultRoot + '/Projects/Alpha'; })()`);
    await page.evaluate(`${P}.activateAgentView()`);
    await until('composer mounted', () => page.evaluate(`!!document.querySelector('.ct-agents-dispatch-btn')`), 15000, 100);
    await page.evaluate(`document.querySelector('.ct-agents-dispatch-btn').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
    await until('Run on menu', () => page.evaluate(`!!document.querySelector('.ct-run-on-item[data-run-on="${DAEMON_ID}"]')`), 5000, 50);
    await page.evaluate(`document.querySelector('.ct-run-on-item[data-run-on="${DAEMON_ID}"]').click()`);
    await until('folder dropdown (advertised by the daemon)', () => page.evaluate(`!!document.querySelector('.ct-run-on-folder-select')`), 10000, 50);
    const suggested = await page.evaluate(`document.querySelector('.ct-run-on-folder-select')?.value`);
    check('composer preselects the mapped remote folder for a vault cwd, from the daemon\'s own list', suggested === mappedCwd, `${suggested} vs ${mappedCwd}`);
    check('composer explains the suggestion', (await page.evaluate(`document.querySelector('[data-testid=run-on-folder-hint]')?.classList.contains('is-hidden')`)) === false);
    check('no text field to type a remote path into', (await page.evaluate(`!!document.querySelector('.ct-run-on-folder-input')`)) === false);
    const options: Array<{ value: string; text: string }> = await page.evaluate(`[...document.querySelectorAll('.ct-run-on-folder-select option')].map(o => ({ value: o.value, text: o.textContent }))`);
    const advertisedVault = options.find((o) => o.value === remoteVault);
    check('dropdown lists the daemon workspaces, with the vault detected from its marker folder',
      !!advertisedVault && advertisedVault.text.includes('(vault)') && options.some((o) => o.value === '/srv/workspaces'), JSON.stringify(options.map((o) => o.value)));
    const wire = await page.evaluate(`${P}.daemonRegistry.clientFor('${DAEMON_ID}').command('workspaces.list', {})`) as { workspaces: Array<{ path: string; kind: string; isDefault: boolean }> };
    check('workspaces.list over the wire: vault kind detected, first workspace is the default',
      wire.workspaces.find((w) => w.path === remoteVault)?.kind === 'vault' && wire.workspaces[0].isDefault === true && wire.workspaces[0].path === remoteVault, JSON.stringify(wire.workspaces));
    await page.evaluate(`document.querySelector('.ct-run-on-browse-btn').click()`);
    await until('browse panel lists the current folder', () => page.evaluate(`!document.querySelector('[data-testid=run-on-browser]').classList.contains('is-hidden') && !!document.querySelector('.ct-run-on-browse-up')`), 10000, 50);
    await page.evaluate(`document.querySelector('.ct-run-on-browse-up').click()`);
    const browsed: string[] = await until('subfolders of the parent', async () => {
      const names: string[] = await page.evaluate(`[...document.querySelectorAll('.ct-run-on-browse-item')].map(e => e.textContent)`);
      return names.length ? names : false;
    }, 10000, 50);
    check('Browse lists the daemon\'s subfolders over path.list', browsed.includes('Alpha'), JSON.stringify(browsed));
    await page.screenshot({ path: path.join(SHOTS, 'run-on-vault-folder.png') });
    check('browsing did not change the preselected folder', (await page.evaluate(`document.querySelector('.ct-run-on-folder-select')?.value`)) === mappedCwd);
    await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`); // closes the menu
    await page.evaluate(`(() => { const ta = document.querySelector('.ct-agents-dispatch-input'); ta.value = '/tokens 5 burst=5 delay=1'; document.querySelector('.ct-agents-dispatch-btn').click(); })()`);
    const vaultThreadId: string = await until('vault thread to exist', () => page.evaluate(`(() => { const all = ${P}.manager.getThreads(); const t = all.find(t => t.remote && t.remote.remoteCwd === ${JSON.stringify(mappedCwd)}); return t ? t.id : false; })()`), 15000, 100) as string;
    check('thread created from the composer runs at the mapped remote folder', !!vaultThreadId, vaultThreadId);
    await until('vault thread turn', () => page.evaluate(`${P}.manager.getThread('${vaultThreadId}').messages.some(m => m.role === 'assistant') && ${P}.manager.getThread('${vaultThreadId}').status === 'waiting'`), 30000, 100);
    const meta = JSON.parse(readFileSync(path.join(daemonDir, 'sessions', `${vaultThreadId}.json`), 'utf8'));
    check('daemon opened the session in the mapped folder', meta.spec.cwd === mappedCwd, meta.spec.cwd);
    check('session prompt has the vault-mirror addendum with remote paths and no Mac path',
      typeof meta.spec.appendSystemPrompt === 'string' && meta.spec.appendSystemPrompt.includes('Vault (synced mirror):')
      && meta.spec.appendSystemPrompt.includes(`mirrored on this machine at ${remoteVault}`) && meta.spec.appendSystemPrompt.includes('Never delete or rename vault files')
      && !meta.spec.appendSystemPrompt.includes(vault));
    const pc = (p: string) => page.evaluate(`${P}.daemonRegistry.clientFor('${DAEMON_ID}').command('path.check', { path: ${JSON.stringify(p)} })`) as Promise<Record<string, unknown>>;
    const okRoot = await pc(remoteVault);
    const badRoot = await pc('/etc');
    check('path.check over the wire: mapped root allowed', okRoot.allowed === true && okRoot.exists === true && okRoot.isDirectory === true, JSON.stringify(okRoot));
    check('path.check over the wire: unrelated folder refused', badRoot.allowed === false, JSON.stringify(badRoot));

    // pill when the daemon becomes unreachable
    await proxy.close();
    await until('unreachable pill', async () => (await page.evaluate(`document.querySelector('[data-testid=remote-pill]')?.getAttribute('data-state')`)) === 'unreachable', 40000, 250).catch(() => undefined);
    await page.screenshot({ path: path.join(SHOTS, 'remote-strip-unreachable.png') });
    check('pill reads unreachable when the daemon is gone', (await page.evaluate(`document.querySelector('[data-testid=remote-pill]')?.getAttribute('data-state')`)) === 'unreachable');
  } finally {
    await app?.close().catch(() => undefined);
    daemon?.kill('SIGTERM');
    await proxy?.close().catch(() => undefined);
    await fs.rm(base, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().then(() => {
  console.log(failures === 0 ? '\nE2E PASS' : `\nE2E FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error(`\nE2E ERROR: ${err instanceof Error ? err.stack : err}`);
  process.exit(2);
});

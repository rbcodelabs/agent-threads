/**
 * `repos.sync` / `repos.status` against a real daemon, with local bare repositories as the remotes (no network).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeDriverFactory } from '../../daemon/claudeDriver';
import { CredStore } from '../../daemon/credStore';
import { ReposManager } from '../../daemon/repos';
import { TestClient, startTestDaemon, sleep, type TestDaemon } from '../helpers/daemonTestClient';
import { age, git, makeRemote, tempDir } from '../helpers/gitFixtures';
import { ScriptedHarness, scriptedFactory } from '../helpers/scriptedHarness';

let base: string;
let dataDir: string;
let remote: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  base = tempDir('repos-int-');
  dataDir = tempDir('repos-int-data-');
  remote = makeRemote(base);
  // Local remotes are refused unless the operator opts in (config.json only).
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ allowLocalRepoUrls: true }));
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  rmSync(base, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

async function daemon(extra: Parameters<typeof startTestDaemon>[0] = {}): Promise<TestDaemon> {
  const td = await startTestDaemon({ dataDir, ...extra });
  cleanups.push(() => td.cleanup());
  return td;
}
async function client(td: TestDaemon, token = td.adminToken): Promise<TestClient> {
  const c = await TestClient.connect(td.daemon.url, token);
  cleanups.push(() => c.close().catch(() => {}));
  return c;
}

describe('repos.sync and repos.status', () => {
  it('stores the list in config.json, clones, and reports the state to a read-scope client', async () => {
    const td = await daemon();
    const admin = await client(td);
    const reply = await admin.cmd('repos.sync', { repos: [{ name: 'proj', url: remote, branch: 'main' }], wait: true });
    expect(reply).toMatchObject({ type: 'ack', result: { root: join(dataDir, 'workspace'), repos: [{ name: 'proj', state: 'cloned', path: join(dataDir, 'workspace', 'proj') }] } });
    expect(readFileSync(join(dataDir, 'workspace', 'proj', 'README.md'), 'utf8')).toBe('hello\n');
    const cfg = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
    expect(cfg.repos).toEqual([{ name: 'proj', url: remote, branch: 'main' }]);
    expect(cfg.allowLocalRepoUrls).toBe(true); // other keys survive

    const viewer = await client(td, td.daemon.tokens.create('viewer', 'read').token);
    expect(await viewer.cmd('repos.status', {})).toMatchObject({ type: 'ack', result: { repos: [{ name: 'proj', state: 'cloned' }] } });
  });

  it('answers at once with syncing and finishes in the background when not asked to wait', async () => {
    const td = await daemon();
    const admin = await client(td);
    const first = await admin.cmd('repos.sync', { repos: [{ name: 'proj', url: remote }] });
    expect((first as any).result.repos[0].state).toBe('syncing');
    for (let i = 0; i < 200 && (await admin.cmd('repos.status', {}) as any).result.repos[0].state === 'syncing'; i++) await sleep(25);
    expect((await admin.cmd('repos.status', {}) as any).result.repos[0].state).toBe('cloned');
  });

  it('is admin-only to change and refuses bad specs without touching the list', async () => {
    const td = await daemon();
    const control = await client(td, td.daemon.tokens.create('ctl', 'control').token);
    expect(await control.cmd('repos.sync', { repos: [] })).toMatchObject({ type: 'err', code: 'forbidden' });
    const admin = await client(td);
    const bad = await admin.cmd('repos.sync', { repos: [{ name: 'x', url: 'https://tok:secret@github.com/o/r.git' }] });
    expect(bad).toMatchObject({ type: 'err', code: 'bad_frame' });
    expect(JSON.stringify(bad)).not.toContain('secret');
    expect(await admin.cmd('repos.sync', { repos: [{ name: '../escape', url: remote }] })).toMatchObject({ type: 'err', code: 'bad_frame' });
    expect(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')).repos).toBeUndefined();
  });

  it('does not offer the repo root as a folder before anything is cloned', async () => {
    const td = await daemon();
    const admin = await client(td);
    expect(((await admin.cmd('workspaces.list', {}) as any).result.workspaces as Array<{ path: string }>).map((w) => w.path)).not.toContain(join(dataDir, 'workspace'));
  });

  it('refuses a local-path remote unless the operator allowed it', async () => {
    writeFileSync(join(dataDir, 'config.json'), '{}');
    const td = await daemon();
    const admin = await client(td);
    expect(await admin.cmd('repos.sync', { repos: [{ name: 'p', url: remote }] })).toMatchObject({ type: 'err', code: 'bad_frame' });
  });

  it('syncs the configured repositories when the daemon starts, and allowlists the repo root', async () => {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ allowLocalRepoUrls: true, repos: [{ name: 'proj', url: remote }] }));
    const td = await daemon();
    await td.daemon.startup;
    const admin = await client(td);
    expect((await admin.cmd('repos.status', {}) as any).result.repos[0].state).toBe('cloned');
    // Offered as a folder once something is cloned there (not before: see the next test's daemon).
    expect(((await admin.cmd('workspaces.list', {}) as any).result.workspaces as Array<{ path: string }>).map((w) => w.path)).toContain(join(dataDir, 'workspace'));
    const checked = await admin.cmd('path.check', { path: join(dataDir, 'workspace', 'proj') });
    expect(checked).toMatchObject({ type: 'ack', result: { allowed: true, exists: true, isDirectory: true, readOnly: false } });
    // Nothing else under the data dir is allowed: the creds and journals stay out of reach.
    expect(await admin.cmd('path.check', { path: join(dataDir, 'creds') })).toMatchObject({ result: { allowed: false } });
  });

  it('opens a session inside a clone, and prunes an idle worktree at the next start', async () => {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ allowLocalRepoUrls: true, repos: [{ name: 'proj', url: remote }] }));
    let td = await daemon();
    await td.daemon.startup;
    const repo = join(dataDir, 'workspace', 'proj');
    const old = join(dataDir, 'workspace', '.worktrees', 'proj', 'old');
    mkdirSync(join(old, '..'), { recursive: true });
    git(['worktree', 'add', old, '-b', 'old'], repo);
    const c = await client(td);
    expect(await c.cmd('session.open', { threadId: 't', spec: { harness: 'claude', cwd: repo, permissionMode: 'default', extraEnvRaw: '' } })).toMatchObject({ type: 'ack' });
    await c.close();
    await td.cleanup();
    cleanups.length = 0;

    age(old, 30); age(git(['rev-parse', '--absolute-git-dir'], old), 30);
    td = await daemon();
    await td.daemon.startup;
    expect(existsSync(old)).toBe(false);
  });
});

describe('the agent\'s process environment', () => {
  it('gets GH_TOKEN and the askpass wiring in secretEnv only, never in the stored spec or the journal', async () => {
    const TOKEN = 'ghp_INTEGRATIONTOKEN0123456789';
    const creds = new CredStore(dataDir);
    creds.push('github', 0, { GH_TOKEN: TOKEN });
    const repos = new ReposManager({ dataDir, root: join(dataDir, 'workspace'), creds, getRepos: () => [], setRepos: () => {} });
    const made: ScriptedHarness[] = [];
    const workspace = tempDir('repos-ws-');
    mkdirSync(join(workspace, 'proj'));
    const td = await startTestDaemon({
      dataDir,
      config: { harness: 'claude', workspaces: [workspace] },
      driverFactory: createClaudeDriverFactory({ createHarness: scriptedFactory(made), env: {}, creds, sessionEnv: () => repos.sessionEnv() }),
    });
    cleanups.push(() => td.cleanup());
    const c = await client(td);
    await c.cmd('session.open', { threadId: 't', spec: { harness: 'claude', cwd: join(workspace, 'proj'), permissionMode: 'default', extraEnvRaw: '' } });
    for (let i = 0; i < 100 && !made[0]?.options; i++) await sleep(5);
    const options = made[0].options!;
    expect(options.secretEnv).toMatchObject({ GH_TOKEN: TOKEN, AGENT_THREADS_GIT_PASSWORD: TOKEN, GIT_TERMINAL_PROMPT: '0' });
    expect(options.extraEnvRaw).not.toContain(TOKEN);
    await td.cleanup();
    cleanups.length = 0;
    // Nothing the daemon persisted (journals, session meta, audit log) holds the token; only creds/ does.
    const leaks: string[] = [];
    const scan = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (p !== join(dataDir, 'creds')) scan(p); }
        else if (readFileSync(p, 'utf8').includes(TOKEN)) leaks.push(p);
      }
    };
    scan(dataDir);
    expect(leaks).toEqual([]);
    rmSync(workspace, { recursive: true, force: true });
  });

  it.each([
    ['a notice when the preflight reports missing GitHub auth', 'GitHub auth unavailable', true],
    ['no notice when the preflight is satisfied', null, false],
  ])('journals %s, without delaying the session start', async (_name, notice, expected) => {
    const made: ScriptedHarness[] = [];
    const workspace = tempDir('repos-ws-');
    mkdirSync(join(workspace, 'proj'));
    const td = await startTestDaemon({
      dataDir,
      config: { harness: 'claude', workspaces: [workspace] },
      driverFactory: createClaudeDriverFactory({ createHarness: scriptedFactory(made), env: {}, authPreflight: async () => notice }),
    });
    cleanups.push(() => td.cleanup());
    const c = await client(td);
    await c.cmd('session.open', { threadId: 't', spec: { harness: 'claude', cwd: join(workspace, 'proj'), permissionMode: 'default', extraEnvRaw: '' } });
    await c.cmd('attach', { ch: 't:t', afterSeq: 0 });
    for (let i = 0; i < 100 && !made[0]?.options; i++) await sleep(5);
    await sleep(50);
    const notices = c.events().filter((f) => f.name === 'onNotification');
    expect(notices.length).toBe(expected ? 1 : 0);
    if (expected) expect(JSON.stringify(notices[0])).toContain('GitHub auth unavailable');
    rmSync(workspace, { recursive: true, force: true });
  });
});

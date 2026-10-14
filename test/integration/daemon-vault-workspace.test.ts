/**
 * A vault-like folder as a daemon workspace: the allowlist (symlinks, odd
 * names), `path.check`, and read-only workspaces, over the real wire server
 * with the real ClaudeSessionDriver and a scripted harness (no Claude process).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeDriverFactory } from '../../daemon/claudeDriver';
import { TestClient, sleep, startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';
import { ScriptedHarness, scriptedFactory } from '../helpers/scriptedHarness';

let base: string;
let vault: string;       // <base>/home/rick/vault  (the allowlisted root; a symlink target in the symlink case)
let outside: string;
let made: ScriptedHarness[];
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'vault-ws-')));
  vault = join(base, 'rick', 'vault');
  outside = join(base, 'rick', 'secrets');
  mkdirSync(join(vault, 'Products', 'Agent Threads'), { recursive: true });
  mkdirSync(join(vault, 'Daily'), { recursive: true });
  mkdirSync(join(vault, '.obsidian'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(vault, 'Daily', '2026-10-14.md'), '# day\n');
  symlinkSync(outside, join(vault, 'sneaky'));
  made = [];
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  rmSync(base, { recursive: true, force: true });
});

async function daemon(config: Record<string, unknown>): Promise<TestDaemon> {
  const td = await startTestDaemon({
    config: { harness: 'claude', ...config } as never,
    driverFactory: createClaudeDriverFactory({ createHarness: scriptedFactory(made), env: {} }),
  });
  cleanups.push(() => td.cleanup());
  return td;
}
async function client(td: TestDaemon): Promise<TestClient> {
  const c = await TestClient.connect(td.daemon.url, td.adminToken);
  cleanups.push(() => c.close().catch(() => {}));
  return c;
}
const spec = (cwd: string, over: Record<string, unknown> = {}) => ({ harness: 'claude', cwd, permissionMode: 'default', extraEnvRaw: '', ...over });
const harness = async (n = 0): Promise<ScriptedHarness> => {
  for (let i = 0; i < 100 && !made[n]?.options; i++) await sleep(5);
  return made[n];
};

describe('a vault as an allowed workspace', () => {
  it('runs sessions at the vault root and in nested folders', async () => {
    const c = await client(await daemon({ workspaces: [vault] }));
    expect((await c.cmd('session.open', { threadId: 'root', spec: spec(vault) })).type).toBe('ack');
    expect((await c.cmd('session.open', { threadId: 'nested', spec: spec(join(vault, 'Products', 'Agent Threads')) })).type).toBe('ack');
    expect((await harness(1)).options.cwd).toBe(join(vault, 'Products', 'Agent Threads'));
  });

  it('refuses a symlink inside the vault that points outside it, and a ".." escape', async () => {
    const c = await client(await daemon({ workspaces: [vault] }));
    expect(await c.cmd('session.open', { threadId: 'a', spec: spec(join(vault, 'sneaky')) })).toMatchObject({ type: 'err', code: 'forbidden' });
    expect(await c.cmd('session.open', { threadId: 'b', spec: spec(join(vault, 'Daily', '..', '..', 'secrets')) })).toMatchObject({ type: 'err', code: 'forbidden' });
    expect(made).toHaveLength(0);
  });

  it('works when the vault root itself is a symlink (e.g. ~/vault -> /data/vault)', async () => {
    const link = join(base, 'rick', 'vault-link');
    symlinkSync(vault, link);
    const c = await client(await daemon({ workspaces: [link] }));
    // Allowed both through the link and by the real path: the allowlist is compared after realpath.
    expect((await c.cmd('session.open', { threadId: 'via-link', spec: spec(join(link, 'Daily')) })).type).toBe('ack');
    expect((await c.cmd('session.open', { threadId: 'via-real', spec: spec(join(vault, 'Daily')) })).type).toBe('ack');
    expect(await c.cmd('session.open', { threadId: 'out', spec: spec(outside) })).toMatchObject({ type: 'err', code: 'forbidden' });
  });

  it('accepts a vault path given with a trailing slash in config and a space in a folder name', async () => {
    mkdirSync(join(vault, 'My Notes'));
    const c = await client(await daemon({ workspaces: [`${vault}/`] }));
    expect((await c.cmd('session.open', { threadId: 's', spec: spec(join(vault, 'My Notes')) })).type).toBe('ack');
  });
});

describe('path.check', () => {
  it('reports allowed/exists/isDirectory for the vault and its folders', async () => {
    const c = await client(await daemon({ workspaces: [vault] }));
    expect((await c.cmd('path.check', { path: vault })).result).toEqual({ allowed: true, exists: true, isDirectory: true, readOnly: false });
    expect((await c.cmd('path.check', { path: join(vault, 'Daily', '2026-10-14.md') })).result).toEqual({ allowed: true, exists: true, isDirectory: false, readOnly: false });
    expect((await c.cmd('path.check', { path: join(vault, 'Nope') })).result).toEqual({ allowed: true, exists: false, isDirectory: false, readOnly: false });
  });

  it('says only "not allowed" for anything outside the workspaces, existing or not, symlink or not', async () => {
    const c = await client(await daemon({ workspaces: [vault] }));
    const notAllowed = { allowed: false, exists: false, isDirectory: false, readOnly: false };
    expect((await c.cmd('path.check', { path: outside })).result).toEqual(notAllowed);
    expect((await c.cmd('path.check', { path: join(base, 'does-not-exist') })).result).toEqual(notAllowed);
    expect((await c.cmd('path.check', { path: join(vault, 'sneaky') })).result).toEqual(notAllowed);
    expect((await c.cmd('path.check', { path: 'relative/path' })).result).toEqual(notAllowed);
  });

  it('needs only read scope and is advertised in capabilities', async () => {
    const td = await daemon({ workspaces: [vault] });
    const read = td.daemon.tokens.create('ro', 'read').token;
    const c = await TestClient.connect(td.daemon.url, read);
    cleanups.push(() => c.close().catch(() => {}));
    expect((await c.cmd('path.check', { path: vault })).type).toBe('ack');
    expect((await c.waitFor((f) => f.type === 'welcome')).capabilities).toContain('path.check');
  });

  it('is answered even when the session host is the unpoliced fake harness', async () => {
    const td = await startTestDaemon({ config: { workspaces: [vault], readOnlyWorkspaces: [] } });
    cleanups.push(() => td.cleanup());
    const c = await client(td);
    expect((await c.cmd('path.check', { path: vault })).result).toMatchObject({ allowed: true, exists: true, isDirectory: true });
  });

  it('rejects a frame without a path as bad_frame', async () => {
    const c = await client(await daemon({ workspaces: [vault] }));
    expect(await c.cmd('path.check', {})).toMatchObject({ type: 'err', code: 'bad_frame' });
  });
});

describe('read-only workspaces', () => {
  it('allows the folder as cwd, denies the edit tools, and reports readOnly in path.check', async () => {
    const c = await client(await daemon({ workspaces: [], readOnlyWorkspaces: [vault] }));
    expect((await c.cmd('path.check', { path: join(vault, 'Daily') })).result).toMatchObject({ allowed: true, readOnly: true });
    expect((await c.cmd('session.open', { threadId: 'ro', spec: spec(join(vault, 'Daily'), { disallowedTools: ['WebFetch'] }) })).type).toBe('ack');
    const denied = (await harness()).options.disallowedTools as string[];
    expect(denied).toEqual(expect.arrayContaining(['WebFetch', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']));
  });

  it('refuses acceptEdits, auto and bypass at open and at runtime; default, plan and dontAsk are fine', async () => {
    const c = await client(await daemon({ workspaces: [], readOnlyWorkspaces: [vault], allowBypass: true }));
    for (const mode of ['acceptEdits', 'auto', 'bypassPermissions']) {
      const r = await c.cmd('session.open', { threadId: `x-${mode}`, spec: spec(vault, { permissionMode: mode }) });
      expect(r, mode).toMatchObject({ type: 'err', code: 'forbidden' });
      expect(r.message).toMatch(/read-only/);
    }
    expect(made).toHaveLength(0);
    for (const mode of ['default', 'plan', 'dontAsk']) {
      expect((await c.cmd('session.open', { threadId: `ok-${mode}`, spec: spec(vault, { permissionMode: mode }) })).type, mode).toBe('ack');
    }
    expect(await c.cmd('session.setPermissionMode', { threadId: 'ok-default', mode: 'acceptEdits' })).toMatchObject({ type: 'err', code: 'forbidden' });
    expect((await c.cmd('session.setPermissionMode', { threadId: 'ok-default', mode: 'plan' })).type).toBe('ack');
  });

  it('a read-write workspace nested inside a read-only one stays writable; the rest of the parent does not', async () => {
    const c = await client(await daemon({ workspaces: [join(vault, 'Products')], readOnlyWorkspaces: [vault] }));
    expect((await c.cmd('path.check', { path: join(vault, 'Products', 'Agent Threads') })).result).toMatchObject({ readOnly: false });
    expect((await c.cmd('path.check', { path: join(vault, 'Daily') })).result).toMatchObject({ readOnly: true });
    expect((await c.cmd('session.open', { threadId: 'rw', spec: spec(join(vault, 'Products'), { permissionMode: 'acceptEdits' }) })).type).toBe('ack');
    expect(((await harness()).options.disallowedTools ?? []) as string[]).not.toContain('Edit');
    expect(await c.cmd('session.open', { threadId: 'ro', spec: spec(join(vault, 'Daily'), { permissionMode: 'acceptEdits' }) })).toMatchObject({ type: 'err', code: 'forbidden' });
  });

  it('a read-only additional directory makes the whole session read-only', async () => {
    const c = await client(await daemon({ workspaces: [join(vault, 'Products')], readOnlyWorkspaces: [join(vault, 'Daily')] }));
    const r = await c.cmd('session.open', { threadId: 'mix', spec: spec(join(vault, 'Products'), { additionalDirectories: [join(vault, 'Daily')], permissionMode: 'acceptEdits' }) });
    expect(r).toMatchObject({ type: 'err', code: 'forbidden' });
  });

  it('leaves ordinary workspaces exactly as before (no edit tools denied)', async () => {
    const c = await client(await daemon({ workspaces: [vault] }));
    expect((await c.cmd('session.open', { threadId: 'rw', spec: spec(vault, { permissionMode: 'acceptEdits' }) })).type).toBe('ack');
    expect((await harness()).options.disallowedTools ?? []).toEqual([]);
  });
});

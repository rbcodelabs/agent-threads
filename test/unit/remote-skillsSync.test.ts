import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillError, SkillStore } from '../../daemon/skillStore';
import type { FsLike } from '../../src/localDaemon/containerFiles';
import { SKILL_LIMITS } from '../../src/protocol/skills';
import { DaemonCommandError } from '../../src/remote/DaemonClient';
import { RemoteSkillsSync, chunkFiles, resolveSkillsSyncMode } from '../../src/remote/skillsSync';
import type { RemoteDaemonConfig } from '../../src/types';

const daemon = (over: Partial<RemoteDaemonConfig> = {}): RemoteDaemonConfig => ({ id: 'box', name: 'my-server', url: 'ws://x', tokenSecretName: 't', ...over });

function treeFs(files: Record<string, string>, bump = { n: 1 }): FsLike {
  const dirs = new Set<string>();
  for (const p of Object.keys(files)) { let d = p; while ((d = d.slice(0, d.lastIndexOf('/')))) dirs.add(d); }
  return {
    realpath: (p) => { if (dirs.has(p) || p in files) return p; throw new Error('ENOENT'); },
    readdir: (p) => [...new Set(Object.keys(files).filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1).split('/')[0]))],
    stat: (p) => (dirs.has(p) ? { dir: true, file: false, size: 0, mtimeMs: 0, mode: 0o755 }
      : p in files ? { dir: false, file: true, size: files[p].length, mtimeMs: bump.n, mode: p.endsWith('.sh') ? 0o755 : 0o644 } : null),
    readBase64: (p) => Buffer.from(files[p]).toString('base64'),
  };
}

describe('resolveSkillsSyncMode', () => {
  it('missing is auto, off is off, unknown fails closed, and the managed daemon is not handled here', () => {
    expect(resolveSkillsSyncMode(daemon())).toBe('auto');
    expect(resolveSkillsSyncMode(daemon({ skillsSync: 'auto' }))).toBe('auto');
    expect(resolveSkillsSyncMode(daemon({ skillsSync: 'off' }))).toBe('off');
    expect(resolveSkillsSyncMode(daemon({ skillsSync: 'selected' as never }))).toBe('off');
    expect(resolveSkillsSyncMode(daemon({ managed: 'local-container' }))).toBe('n/a');
    expect(resolveSkillsSyncMode(daemon({ managed: 'local-container', skillsSync: 'off' }))).toBe('n/a');
    expect(resolveSkillsSyncMode(undefined)).toBe('n/a');
  });
});

describe('chunkFiles', () => {
  const f = (p: string, size: number) => ({ p, m: 0o644, b64: '', size });
  it('splits at the size boundary and lets one oversized file travel alone', () => {
    expect(chunkFiles([f('a', 5), f('b', 5), f('c', 1)], 10).map((c) => c.map((x) => x.p))).toEqual([['a', 'b'], ['c']]);
    expect(chunkFiles([f('a', 5), f('b', 6)], 10).map((c) => c.map((x) => x.p))).toEqual([['a'], ['b']]);
    expect(chunkFiles([f('a', 50), f('b', 1)], 10).map((c) => c.map((x) => x.p))).toEqual([['a'], ['b']]);
  });
});

describe('RemoteSkillsSync', () => {
  let dataDir: string;
  let store: SkillStore;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'skillsync-')); store = new SkillStore(dataDir); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  interface Opts { adminToken?: string | null; capabilities?: string[] | null; reachable?: boolean; failOn?: string; files?: Record<string, string>; plugins?: string[] }
  function setup(o: Opts = {}) {
    const sent: string[] = [];
    const created: Array<{ token: string; disposed: boolean }> = [];
    const syncSizes: number[] = [];
    const caps = o.capabilities === undefined ? ['skills.sync'] : o.capabilities;
    const client = {
      daemonInfo: o.reachable === false || caps === null ? undefined : { capabilities: caps, epoch: 'e1' },
      async command(type: string, payload: Record<string, unknown>) {
        sent.push(type);
        if (type === 'skills.sync') syncSizes.push((payload.trees as unknown[]).length);
        if (o.failOn === type) throw new DaemonCommandError('unreachable', 'daemon unreachable');
        try {
          if (type === 'skills.sync') return { ...store.sync(payload.trees) };
          if (type === 'skills.put') return { ...store.put(payload.upload, payload.dir, payload.seq, payload.files) };
          if (type === 'skills.commit') return { ...store.commit(payload.upload, payload.dir, payload.hash, payload.files, payload.bytes) };
        } catch (e) { if (e instanceof SkillError) throw new DaemonCommandError('bad_frame', e.message); throw e; }
        throw new Error(`unexpected ${type}`);
      },
    };
    const files = o.files ?? { '/vault/skills/a/SKILL.md': 'A', '/vault/skills/a/run.sh': '#!/bin/sh' };
    const sync = new RemoteSkillsSync({
      resolver: { nameOf: () => 'my-server' },
      adminToken: () => (o.adminToken === null ? undefined : o.adminToken ?? 'atd_admin'),
      createClient: (_d, token) => {
        const rec = { token, disposed: false };
        created.push(rec);
        return { get daemonInfo() { return client.daemonInfo; }, command: client.command, dispose: () => { rec.disposed = true; } } as never;
      },
      skillPlugins: () => (o.plugins ?? ['/vault/skills/a']).map((path) => ({ path })),
      fs: treeFs(files),
      sha256: () => createHash('sha256'),
    });
    return { sync, sent, syncSizes, created };
  }

  const manyTrees = (n: number) => {
    const files: Record<string, string> = {};
    const plugins: string[] = [];
    for (let i = 0; i < n; i++) { files[`/vault/skills/t${i}/SKILL.md`] = `skill ${i}`; plugins.push(`/vault/skills/t${i}`); }
    return { files, plugins };
  };

  it('batches skills.sync at the daemon tree limit and keeps every tree in order', async () => {
    const { sync, sent, syncSizes } = setup(manyTrees(70));
    const r = await sync.prepare(daemon());
    expect(syncSizes).toEqual([32, 32, 6]);
    expect(sent.filter((t) => t === 'skills.sync')).toHaveLength(3);
    expect(r.notices).toEqual(['Synced 70 skill folders to my-server.']);
    expect(r.pluginPaths).toHaveLength(70);
    expect(r.pluginPaths.map((p) => p.split('/').pop()!.replace(/-[0-9a-f]{12}$/, ''))).toEqual(Array.from({ length: 70 }, (_, i) => `skills-t${i}`));
  });

  it('already-present trees from every batch are not re-uploaded', async () => {
    const { sync, sent } = setup(manyTrees(40));
    await sync.prepare(daemon());
    sent.length = 0;
    const again = await sync.prepare(daemon());
    expect(sent).toEqual(['skills.sync', 'skills.sync']);
    expect(again.pluginPaths).toHaveLength(40);
    expect(again.notices).toEqual([]);
  });

  it('sends a single skills.sync for exactly the limit', async () => {
    const { sync, syncSizes } = setup(manyTrees(SKILL_LIMITS.maxTrees));
    expect((await sync.prepare(daemon())).pluginPaths).toHaveLength(SKILL_LIMITS.maxTrees);
    expect(syncSizes).toEqual([SKILL_LIMITS.maxTrees]);
  });

  it('uploads a missing tree, hands back absolute daemon paths, and says how many folders it synced', async () => {
    const { sync, sent } = setup();
    const r = await sync.prepare(daemon());
    expect(r.pluginPaths).toHaveLength(1);
    expect(r.pluginPaths[0].startsWith(`${join(dataDir, 'skills')}/skills-a-`)).toBe(true);
    expect(readFileSync(join(r.pluginPaths[0], 'SKILL.md'), 'utf8')).toBe('A');
    expect(r.notices).toEqual(['Synced 1 skill folder to my-server.']);
    expect(sent).toEqual(['skills.sync', 'skills.put', 'skills.commit']);
  });

  it('talks to the daemon over its own connection with the stored admin token, and closes it afterwards', async () => {
    const { sync, created } = setup({ adminToken: 'atd_admin_secret' });
    const r = await sync.prepare(daemon());
    expect(r.notices).toEqual(['Synced 1 skill folder to my-server.']);
    expect(created).toEqual([{ token: 'atd_admin_secret', disposed: true }]);
  });

  it('closes the admin connection when the sync fails', async () => {
    const { sync, created } = setup({ failOn: 'skills.sync' });
    await sync.prepare(daemon());
    expect(created).toEqual([{ token: 'atd_admin', disposed: true }]);
  });

  it('without a stored admin token it says where to add one, opens no connection and syncs nothing', async () => {
    const { sync, sent, created } = setup({ adminToken: null });
    const r = await sync.prepare(daemon());
    expect(created).toEqual([]);
    expect(sent).toEqual([]);
    expect(r.pluginPaths).toEqual([]);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain('Skills not synced to my-server: syncing skills needs an admin token');
    expect(r.notices[0]).toContain('Admin token for secrets and skills');
    expect(r.notices[0]).toContain('agent-threads token create --name geode-admin --scope admin');
  });

  it('a missing admin token is not mentioned when there are no skills to send', async () => {
    const { sync } = setup({ adminToken: null, plugins: [] });
    expect(await sync.prepare(daemon())).toEqual({ pluginPaths: [], notices: [] });
  });

  it('a refused admin token says the token needs scope admin', async () => {
    const forbidden = new RemoteSkillsSync({
      resolver: { nameOf: () => 'my-server' },
      adminToken: () => 'atd_control_by_mistake',
      createClient: () => ({ daemonInfo: { capabilities: ['skills.sync'], epoch: 'e1' }, command: async () => { throw new DaemonCommandError('forbidden', 'no'); } }),
      skillPlugins: () => [{ path: '/vault/skills/a' }],
      fs: treeFs({ '/vault/skills/a/SKILL.md': 'A' }),
      sha256: () => createHash('sha256'),
    });
    const r = await forbidden.prepare(daemon());
    expect(r.notices[0]).toContain('the saved admin token was refused');
  });

  it('an unchanged tree costs one round trip and no notice', async () => {
    const { sync, sent } = setup();
    const first = await sync.prepare(daemon());
    sent.length = 0;
    const again = await sync.prepare(daemon());
    expect(sent).toEqual(['skills.sync']);
    expect(again).toEqual({ pluginPaths: first.pluginPaths, notices: [] });
  });

  it('dedupes plugins that resolve to the same folder', async () => {
    const { sync } = setup({ plugins: ['/vault/skills/a', '/vault/skills/a'] });
    expect((await sync.prepare(daemon())).pluginPaths).toHaveLength(1);
  });

  it('off sends nothing, and so does the managed daemon', async () => {
    for (const d of [daemon({ skillsSync: 'off' }), daemon({ managed: 'local-container' }), daemon({ skillsSync: 'bogus' as never })]) {
      const { sync, sent } = setup();
      expect(await sync.prepare(d)).toEqual({ pluginPaths: [], notices: [] });
      expect(sent).toEqual([]);
    }
  });

  it('a daemon without the capability is skipped with one notice per connection', async () => {
    const { sync, sent } = setup({ capabilities: ['creds.push'] });
    const r = await sync.prepare(daemon());
    expect(r.pluginPaths).toEqual([]);
    expect(r.notices).toEqual(['Skills not synced to my-server: this daemon predates skill sync. Update the daemon.']);
    expect(sent).toEqual([]);
    expect((await sync.prepare(daemon())).notices).toEqual([]);
  });

  it('an unreachable daemon leaves the session startable, with a notice', async () => {
    const { sync } = setup({ reachable: false });
    const r = await sync.prepare(daemon());
    expect(r.pluginPaths).toEqual([]);
    expect(r.notices).toEqual(['Skills not synced to my-server: the daemon is not reachable']);
  });

  it('a failure mid-upload yields a notice and no path for that tree, and a later retry succeeds', async () => {
    const bad = setup({ failOn: 'skills.commit' });
    const r = await bad.sync.prepare(daemon());
    expect(r.pluginPaths).toEqual([]);
    expect(r.notices[0]).toMatch(/^Skills not synced to my-server: skills-a: /);
    const good = setup();
    expect((await good.sync.prepare(daemon())).pluginPaths).toHaveLength(1);
  });

  it('keeps the trees that landed when another one fails', async () => {
    const files = { '/v/one/SKILL.md': '1', '/v/two/SKILL.md': '2' };
    const { sync } = setup({ files, plugins: ['/v/one', '/v/two'] });
    // Second tree is over the file cap on the daemon side is awkward to stage; fail it by making its commit throw.
    const real = store.commit.bind(store);
    store.commit = (...args: Parameters<SkillStore['commit']>) => { if (String(args[1]).startsWith('v-two-')) throw new SkillError('boom'); return real(...args); };
    const r = await sync.prepare(daemon());
    expect(r.pluginPaths).toHaveLength(1);
    expect(r.pluginPaths[0]).toMatch(/\/v-one-/);
    expect(r.notices.join('\n')).toMatch(/two: boom/);
  });

  it('skips a tree over the size limits with a notice and still syncs the others', async () => {
    const big: Record<string, string> = { '/v/ok/SKILL.md': 'ok' };
    for (let i = 0; i <= SKILL_LIMITS.maxFiles; i++) big[`/v/big/f${i}`] = '';
    const { sync } = setup({ files: big, plugins: ['/v/big', '/v/ok'] });
    const r = await sync.prepare(daemon());
    expect(r.pluginPaths).toHaveLength(1);
    expect(r.notices.join('\n')).toMatch(/big is over the size limits/);
  });
});

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

  interface Opts { capabilities?: string[] | null; reachable?: boolean; failOn?: string; files?: Record<string, string>; plugins?: string[] }
  function setup(o: Opts = {}) {
    const sent: string[] = [];
    const caps = o.capabilities === undefined ? ['skills.sync'] : o.capabilities;
    const client = {
      daemonInfo: o.reachable === false || caps === null ? undefined : { capabilities: caps, epoch: 'e1' },
      async command(type: string, payload: Record<string, unknown>) {
        sent.push(type);
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
      resolver: { clientFor: () => client as never, nameOf: () => 'my-server', warm: async () => {} },
      skillPlugins: () => (o.plugins ?? ['/vault/skills/a']).map((path) => ({ path })),
      fs: treeFs(files),
      sha256: () => createHash('sha256'),
    });
    return { sync, sent };
  }

  it('uploads a missing tree, hands back absolute daemon paths, and says how many folders it synced', async () => {
    const { sync, sent } = setup();
    const r = await sync.prepare(daemon());
    expect(r.pluginPaths).toHaveLength(1);
    expect(r.pluginPaths[0].startsWith(`${join(dataDir, 'skills')}/skills-a-`)).toBe(true);
    expect(readFileSync(join(r.pluginPaths[0], 'SKILL.md'), 'utf8')).toBe('A');
    expect(r.notices).toEqual(['Synced 1 skill folder to my-server.']);
    expect(sent).toEqual(['skills.sync', 'skills.put', 'skills.commit']);
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

  it('a forbidden token is explained as needing admin', async () => {
    const { sync } = setup();
    const client = (sync as unknown as { deps: { resolver: { clientFor(): { command: unknown } } } }).deps.resolver.clientFor();
    client.command = async () => { throw new DaemonCommandError('forbidden', 'no'); };
    expect((await sync.prepare(daemon())).notices[0]).toMatch(/needs an admin token/);
  });
});

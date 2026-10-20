/**
 * `skills.sync` / `skills.put` / `skills.commit` against a real daemon (fake harness), driven both frame by frame and
 * through the production client logic (RemoteSkillsSync) over a real socket.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeFs } from '../../src/localDaemon/containerFiles';
import { SKILL_LIMITS } from '../../src/protocol/skills';
import { DaemonCommandError } from '../../src/remote/DaemonClient';
import { RemoteSkillsSync } from '../../src/remote/skillsSync';
import type { RemoteDaemonConfig } from '../../src/types';
import { TestClient, startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';
import { wireTree } from '../helpers/skillTree';

const cleanups: Array<() => Promise<void> | void> = [];
let td: TestDaemon;
let scratch: string;

beforeEach(async () => {
  td = await startTestDaemon();
  cleanups.push(() => td.cleanup());
  scratch = mkdtempSync(join(tmpdir(), 'skills-src-'));
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
});
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function connect(token = td.adminToken): Promise<TestClient> {
  const c = await TestClient.connect(td.daemon.url, token);
  cleanups.push(() => c.close().catch(() => {}));
  return c;
}
const skillsRoot = () => join(td.dataDir, 'skills');

/** The production sync logic with the test socket as its client. `sent` records every skills.* frame. */
function clientSync(c: TestClient, opts: { capabilities?: string[]; plugins: string[]; sent?: string[] }) {
  const client = {
    daemonInfo: { capabilities: opts.capabilities ?? ['skills.sync'], epoch: 'e' },
    async command(type: string, payload: object) {
      opts.sent?.push(type);
      const r = await c.cmd(type, payload);
      if (r.type === 'err') throw new DaemonCommandError(r.code, r.message);
      return r.result ?? {};
    },
  };
  return new RemoteSkillsSync({
    resolver: { clientFor: () => client as never, nameOf: () => 'box', warm: async () => {} },
    skillPlugins: () => opts.plugins.map((path) => ({ path })),
    fs: nodeFs(),
    sha256: () => createHash('sha256'),
  });
}
const daemonCfg = (over: Partial<RemoteDaemonConfig> = {}): RemoteDaemonConfig => ({ id: 'box', name: 'box', url: 'ws://x', tokenSecretName: 't', ...over });

describe('skills over the wire', () => {
  it('advertises the capability and refuses non-admin tokens', async () => {
    const admin = await TestClient.open(td.daemon.url);
    const welcome = await admin.cmd('hello', { protocol: 1, client: 'cli', clientVersion: 't', token: td.adminToken });
    expect(welcome.capabilities).toContain('skills.sync');
    await admin.close();
    const t = wireTree('s', { 'a.md': '1' });
    for (const scope of ['read', 'control'] as const) {
      const c = await connect(td.daemon.tokens.create(scope, scope).token);
      expect(await c.cmd('skills.sync', { trees: [t.manifest] })).toMatchObject({ type: 'err', code: 'forbidden' });
      expect(await c.cmd('skills.put', { upload: 'upload-0001', dir: t.manifest.dir, seq: 0, files: t.wire })).toMatchObject({ type: 'err', code: 'forbidden' });
    }
    expect(existsSync(skillsRoot())).toBe(false);
  });

  it('round trip: sync, put, commit lands files under <dataDir>/skills; a second sync reports have', async () => {
    const c = await connect();
    const t = wireTree('demo', { 'SKILL.md': 'hi', 'bin/x.sh': '#!/bin/sh' }, { 'bin/x.sh': 0o755 });
    const plan = await c.cmd('skills.sync', { trees: [t.manifest] });
    expect(plan.result).toEqual({ root: skillsRoot(), have: [], missing: [t.manifest.dir] });
    expect((await c.cmd('skills.put', { upload: 'upload-0001', dir: t.manifest.dir, seq: 0, files: t.wire })).type).toBe('ack');
    expect((await c.cmd('skills.commit', { upload: 'upload-0001', ...t.commit })).result).toEqual({ dir: t.manifest.dir, created: true });
    expect(readFileSync(join(skillsRoot(), t.manifest.dir, 'SKILL.md'), 'utf8')).toBe('hi');
    expect(statSync(join(skillsRoot(), t.manifest.dir, 'bin/x.sh')).mode & 0o777).toBe(0o755);
    expect((await c.cmd('skills.sync', { trees: [t.manifest] })).result).toMatchObject({ have: [t.manifest.dir], missing: [] });
    // Nothing leaked outside the data directory's skills folder.
    expect(readdirSync(skillsRoot()).filter((n) => !n.startsWith('.'))).toEqual([t.manifest.dir]);
  });

  it('refuses path escapes and oversized frames on the wire, writing nothing outside', async () => {
    const c = await connect();
    const t = wireTree('demo', { 'a.md': '1' });
    for (const p of ['../../escape.md', '/tmp/abs.md', 'a/../../b', 'a\\b', 'a//b']) {
      expect(await c.cmd('skills.put', { upload: 'upload-0001', dir: t.manifest.dir, seq: 0, files: [{ p, m: 0o644, b64: '' }] })).toMatchObject({ type: 'err', code: 'bad_frame' });
    }
    const tooMany = Array.from({ length: SKILL_LIMITS.maxFiles + 1 }, (_, i) => ({ p: `f${i}`, m: 0o644, b64: '' }));
    expect(await c.cmd('skills.put', { upload: 'upload-0001', dir: t.manifest.dir, seq: 0, files: tooMany })).toMatchObject({ type: 'err', code: 'bad_frame' });
    expect(await c.cmd('skills.sync', { trees: [{ ...t.manifest, files: SKILL_LIMITS.maxFiles + 1 }] })).toMatchObject({ type: 'err', code: 'bad_frame' });
    expect(existsSync(join(td.dataDir, 'escape.md'))).toBe(false);
    expect(existsSync(join(skillsRoot(), 'escape.md'))).toBe(false);
  });

  it('rejects a commit whose hash does not match the staged content', async () => {
    const c = await connect();
    const t = wireTree('demo', { 'a.md': '1' });
    await c.cmd('skills.put', { upload: 'upload-0001', dir: t.manifest.dir, seq: 0, files: [{ ...t.wire[0], b64: Buffer.from('2').toString('base64') }] });
    expect(await c.cmd('skills.commit', { upload: 'upload-0001', ...t.commit })).toMatchObject({ type: 'err', code: 'bad_frame' });
    expect(existsSync(join(skillsRoot(), t.manifest.dir))).toBe(false);
  });

  it('a socket dropped mid-upload followed by a retry succeeds, and a repeated commit is a no-op', async () => {
    const t = wireTree('demo', { 'a.md': '1', 'b.md': '2' });
    const first = await connect();
    await first.cmd('skills.put', { upload: 'upload-0001', dir: t.manifest.dir, seq: 0, files: [t.wire[0]] });
    first.kill();
    const second = await connect();
    // Same upload id: the already-staged file is accepted again, the rest is added.
    expect((await second.cmd('skills.put', { upload: 'upload-0001', dir: t.manifest.dir, seq: 0, files: t.wire })).type).toBe('ack');
    expect((await second.cmd('skills.commit', { upload: 'upload-0001', ...t.commit })).result).toMatchObject({ created: true });
    expect((await second.cmd('skills.commit', { upload: 'upload-0002', ...t.commit })).result).toMatchObject({ created: false });
    // The same command id replayed is answered from the idempotency cache.
    const id = 'replay-1';
    const a = await second.cmd('skills.sync', { trees: [t.manifest] }, id);
    const b = await second.cmd('skills.sync', { trees: [t.manifest] }, id);
    expect(b.result).toEqual(a.result);
  });
});

describe('the client logic against the daemon', () => {
  function makeSkill(name: string): string {
    const dir = join(scratch, name);
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `# ${name}`);
    writeFileSync(join(dir, 'sub', 'run.sh'), '#!/bin/sh', { mode: 0o755 });
    return dir;
  }

  it('syncs a skill folder, sends symlinked content as regular files, and a second run only asks', async () => {
    const dir = makeSkill('alpha');
    const shared = join(scratch, 'shared');
    mkdirSync(shared);
    writeFileSync(join(shared, 'linked.md'), 'via link');
    symlinkSync(join(shared, 'linked.md'), join(dir, 'link.md'));
    symlinkSync(shared, join(dir, 'linkdir'));
    const c = await connect();
    const sent: string[] = [];
    const sync = clientSync(c, { plugins: [dir], sent });
    const r = await sync.prepare(daemonCfg());
    expect(r.notices).toEqual(['Synced 1 skill folder to box.']);
    const [path] = r.pluginPaths;
    expect(path.startsWith(skillsRoot())).toBe(true);
    expect(readFileSync(join(path, 'link.md'), 'utf8')).toBe('via link');
    expect(readFileSync(join(path, 'linkdir', 'linked.md'), 'utf8')).toBe('via link');
    expect(statSync(join(path, 'sub', 'run.sh')).mode & 0o111).not.toBe(0);
    expect(readdirSync(path).every((n) => !statLink(join(path, n)))).toBe(true);
    sent.length = 0;
    expect((await sync.prepare(daemonCfg())).pluginPaths).toEqual([path]);
    expect(sent).toEqual(['skills.sync']);
  });

  it('a capability-less daemon is skipped with a notice and receives no skills.* frame', async () => {
    const c = await connect();
    const sent: string[] = [];
    const r = await clientSync(c, { plugins: [makeSkill('beta')], capabilities: ['creds.push'], sent }).prepare(daemonCfg());
    expect(r.pluginPaths).toEqual([]);
    expect(r.notices[0]).toMatch(/predates skill sync/);
    expect(sent).toEqual([]);
    expect(existsSync(skillsRoot())).toBe(false);
  });

  it('off sends nothing and leaves earlier synced data alone', async () => {
    const c = await connect();
    const dir = makeSkill('gamma');
    const sent: string[] = [];
    const sync = clientSync(c, { plugins: [dir], sent });
    const { pluginPaths } = await sync.prepare(daemonCfg());
    sent.length = 0;
    expect(await sync.prepare(daemonCfg({ skillsSync: 'off' }))).toEqual({ pluginPaths: [], notices: [] });
    expect(sent).toEqual([]);
    expect(existsSync(pluginPaths[0])).toBe(true);
  });
});

function statLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

import { describe, expect, it } from 'vitest';
import { assessInstall, unitFromCgroup, type InstallProbe } from '../../daemon/update/install';

const USER_CGROUP = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/agent-threads.service\n';

function probe(over: Partial<InstallProbe> & { files?: Record<string, string>; restart?: string | null; writable?: boolean } = {}): InstallProbe & { ran: string[][] } {
  const files = over.files ?? { '/proc/self/cgroup': USER_CGROUP, '/proc/1/cgroup': '0::/init.scope\n' };
  const ran: string[][] = [];
  return {
    platform: 'linux',
    env: { INVOCATION_ID: 'abc' },
    bundlePath: '/home/u/.local/share/agent-threads/dist/agent-threads.cjs',
    exists: (p) => p in files,
    readText: (p) => files[p] ?? null,
    canWriteDir: () => over.writable ?? true,
    run: async (cmd, args) => {
      ran.push([cmd, ...args]);
      return over.restart === null ? { ok: false, stdout: '' } : { ok: true, stdout: `${over.restart ?? 'on-failure'}\n` };
    },
    ran,
    ...over,
  } as InstallProbe & { ran: string[][] };
}

describe('unitFromCgroup', () => {
  it('finds the user and system units', () => {
    expect(unitFromCgroup(USER_CGROUP)).toEqual({ name: 'agent-threads.service', scope: 'user' });
    expect(unitFromCgroup('0::/system.slice/agent-threads.service\n')).toEqual({ name: 'agent-threads.service', scope: 'system' });
  });
  it('returns null outside a service', () => {
    expect(unitFromCgroup('0::/user.slice/user-1000.slice/session-3.scope\n')).toBeNull();
    expect(unitFromCgroup('')).toBeNull();
  });
});

describe('assessInstall', () => {
  it('accepts a writable script install under a restart-on-failure user unit', async () => {
    const p = probe();
    const a = await assessInstall(p);
    expect(a).toMatchObject({ available: true, kind: 'systemd', unit: { name: 'agent-threads.service', scope: 'user', restart: 'on-failure' } });
    expect(p.ran[0]).toEqual(['systemctl', '--user', 'show', 'agent-threads.service', '-p', 'Restart', '--value']);
  });
  it('accepts Restart=always and a system-scope unit', async () => {
    const a = await assessInstall(probe({ restart: 'always', files: { '/proc/self/cgroup': '0::/system.slice/agent-threads.service\n' } }));
    expect(a).toMatchObject({ available: true, unit: { scope: 'system', restart: 'always' } });
  });
  it.each(['no', 'on-success', 'on-abnormal', 'on-abort'])('refuses Restart=%s: a restart exit would leave it down', async (restart) => {
    const a = await assessInstall(probe({ restart }));
    expect(a.available).toBe(false);
    expect(a.reason).toContain(`Restart=${restart}`);
  });
  it('refuses when the Restart= policy cannot be read', async () => {
    expect(await assessInstall(probe({ restart: null }))).toMatchObject({ available: false, reason: expect.stringContaining('Restart=') });
  });
  it('is unavailable in Docker and says to pull a newer image', async () => {
    for (const files of [{ '/.dockerenv': '' }, { '/run/.containerenv': '' }, { '/proc/1/cgroup': '0::/docker/abc123\n' }]) {
      const a = await assessInstall(probe({ files }));
      expect(a).toMatchObject({ available: false, kind: 'container' });
      expect(a.reason).toMatch(/image tag/);
    }
  });
  it('is unavailable when the bundle directory is read-only', async () => {
    expect(await assessInstall(probe({ writable: false }))).toMatchObject({ available: false, reason: expect.stringContaining('not writable') });
  });
  it('is unavailable from a source checkout, on macOS, and when not started by systemd', async () => {
    expect(await assessInstall(probe({ bundlePath: undefined }))).toMatchObject({ available: false, kind: 'source' });
    expect(await assessInstall(probe({ platform: 'darwin' }))).toMatchObject({ available: false, kind: 'unsupported' });
    expect(await assessInstall(probe({ env: {} }))).toMatchObject({ available: false, reason: expect.stringContaining('INVOCATION_ID') });
    expect(await assessInstall(probe({ files: { '/proc/self/cgroup': '0::/user.slice/user-1000.slice/session-3.scope\n' } }))).toMatchObject({ available: false });
  });
  it('from the CLI, looks for the agent-threads unit (user, then system)', async () => {
    const p = probe({ env: {} });
    let n = 0;
    p.run = async (cmd, args) => { p.ran.push([cmd, ...args]); return ++n === 1 ? { ok: false, stdout: '' } : { ok: true, stdout: 'on-failure\n' }; };
    const a = await assessInstall(p, 'cli');
    expect(a).toMatchObject({ available: true, unit: { scope: 'system' } });
    expect(p.ran.map((r) => r.includes('--user'))).toEqual([true, false]);
  });
});

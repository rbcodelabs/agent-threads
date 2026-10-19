import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../daemon/cli';
import { capabilitiesFor } from '../../daemon/connection';
import { checkAutoUpdate, type Probes } from '../../daemon/cmd/doctor';
import { EXIT } from '../../daemon/cmd/exit';
import { runUpdate, type UpdateDeps } from '../../daemon/cmd/update';
import { resolveConfig } from '../../daemon/config';
import { IdleGate } from '../../daemon/update/idle';
import type { LatestRelease } from '../../daemon/update/release';
import { readState, takeRequest, writeState, writeStatus, type UpdateStatus } from '../../daemon/update/state';
import { DAEMON_VERSION } from '../../daemon/version';

const REL = (v: string): LatestRelease => ({ version: v, tag: `v${v}`, bundleUrl: 'https://github.com/a', checksumUrl: 'https://github.com/b' });
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'at-cli-update-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function deps(over: Partial<UpdateDeps> & { latest?: LatestRelease | null; throws?: Error } = {}): UpdateDeps & { applied: string[] } {
  const applied: string[] = [];
  return {
    currentVersion: '0.68.2',
    dataDir: dir,
    releases: { latest: async () => { if (over.throws) throw over.throws; return over.latest === undefined ? REL('0.69.0') : over.latest; } },
    assess: async () => ({ available: true, kind: 'systemd', bundlePath: '/b/agent-threads.cjs', unit: { name: 'agent-threads.service', scope: 'user', restart: 'on-failure' } }),
    apply: async (r) => { applied.push(r.version); return { from: '0.68.2', to: r.version, prevPath: '/b/agent-threads.cjs.prev-0.68.2', bundlePath: '/b/agent-threads.cjs' }; },
    settings: () => ({ enabled: false, intervalMinutes: 360, quietMinutes: 2 }),
    now: () => 1_000,
    pidAlive: () => false,
    ...over,
    applied,
  } as UpdateDeps & { applied: string[] };
}

async function run(opts: Partial<Parameters<typeof runUpdate>[0]>, d: UpdateDeps): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runUpdate({ check: false, apply: false, now: false, json: false, ...opts }, d, (l) => out.push(l), (l) => err.push(l));
  return { code, out, err };
}

const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  pid: 4242, version: '0.68.2', enabled: true, available: true, phase: 'idle', intervalMinutes: 360, quietMinutes: 2, updatedAt: 500, ...over,
});

describe('update --check', () => {
  it('shows current vs latest, auto-update off, and the manual path', async () => {
    const { code, out } = await run({ check: true }, deps());
    expect(code).toBe(EXIT.OK);
    expect(out).toEqual([
      'current:      0.68.2',
      'latest:       0.69.0  (update available)',
      'auto-update:  off (from config/environment; the daemon was not seen running)',
      'this install: can update itself (agent-threads.service, Restart=on-failure)',
      'applies:      not automatically (auto-update is off); run `agent-threads update --apply`',
    ]);
  });
  it('says when it would apply with auto-update on (config)', async () => {
    const { out } = await run({ check: true }, deps({ settings: () => ({ enabled: true, intervalMinutes: 60, quietMinutes: 5 }) }));
    expect(out.at(-1)).toBe("applies:      at the daemon's next check (every 60 min), then once it has been idle for 5 min");
  });
  it('prefers what the running daemon reports, including a pending restart', async () => {
    writeStatus(dir, status({ phase: 'waiting_for_idle', pendingVersion: '0.69.0', waiting: { busyThreads: 2, quietRemainingMs: 120_000 } }));
    const { out } = await run({ check: true }, deps({ pidAlive: (pid) => pid === 4242 }));
    expect(out).toContain('auto-update:  on, checks every 360 min, restarts after 2 min idle');
    expect(out).toContain('daemon:       running, waiting_for_idle');
    expect(out.at(-1)).toBe('applies:      0.69.0 is installed; restarting once idle (2 busy thread(s), 2 min of quiet still needed)');
  });
  it('says plainly when this install cannot update itself (Docker)', async () => {
    const { out } = await run({ check: true }, deps({ assess: async () => ({ available: false, kind: 'container', reason: 'running in a container: pull a newer image tag' }), settings: () => ({ enabled: true, intervalMinutes: 360, quietMinutes: 2 }) }));
    expect(out).toContain('this install: cannot update itself: running in a container: pull a newer image tag');
    expect(out.at(-1)).toMatch(/^applies:      not automatically: this install cannot update itself/);
  });
  it('reports up to date, ahead, and no release', async () => {
    expect((await run({ check: true }, deps({ latest: REL('0.68.2') }))).out[1]).toBe('latest:       0.68.2  (up to date)');
    expect((await run({ check: true }, deps({ latest: REL('0.60.0') }))).out[1]).toBe('latest:       0.60.0  (newer than the latest release)');
    expect((await run({ check: true }, deps({ latest: null }))).out[1]).toBe('latest:       (no stable release found)  (unknown)');
  });
  it('reports a major bump and a held release as not automatic', async () => {
    expect((await run({ check: true }, deps({ latest: REL('1.0.0') }))).out.at(-1)).toBe('applies:      not automatically: 1.0.0 is a new major version');
    writeState(dir, { held: { version: '0.69.0', reason: 'speaks wire protocol v2', at: 1 } });
    expect((await run({ check: true }, deps())).out.at(-1)).toBe('applies:      not automatically: speaks wire protocol v2');
  });
  it('--json is one object', async () => {
    const { out } = await run({ check: true, json: true }, deps());
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0])).toMatchObject({ current: '0.68.2', latest: '0.69.0', relation: 'update_available', autoUpdate: { enabled: false }, install: { available: true } });
  });
  it('a failed lookup is exit 1 with the reason, not a crash', async () => {
    await expect(run({ check: true }, deps({ throws: new Error('offline') }))).rejects.toMatchObject({ code: EXIT.FAILED, message: expect.stringContaining('offline') });
  });
});

describe('update --apply', () => {
  it('installs through the safe path and asks a running daemon to restart when idle', async () => {
    writeStatus(dir, status());
    const d = deps({ pidAlive: () => true });
    const { code, out } = await run({ apply: true }, d);
    expect(code).toBe(EXIT.OK);
    expect(d.applied).toEqual(['0.69.0']);
    expect(out[0]).toBe('installed 0.69.0 (was 0.68.2); the previous bundle is kept at /b/agent-threads.cjs.prev-0.68.2');
    expect(out[1]).toMatch(/once it is idle .* A running turn is never interrupted/);
    expect(takeRequest(dir)).toEqual({ version: '0.69.0', now: false, requestedAt: 1_000 });
  });
  it('--now records an explicit restart-now request', async () => {
    writeStatus(dir, status());
    const { out } = await run({ apply: true, now: true }, deps({ pidAlive: () => true }));
    expect(out[1]).toMatch(/restart now/);
    expect(takeRequest(dir)).toMatchObject({ now: true });
  });
  it('with no running daemon, tells you to restart it yourself', async () => {
    const { out } = await run({ apply: true }, deps());
    expect(out[1]).toMatch(/No running daemon was found/);
  });
  it('does nothing when already current, and never downgrades', async () => {
    const d = deps({ latest: REL('0.68.2') });
    expect((await run({ apply: true }, d)).out[0]).toMatch(/already up to date/);
    const d2 = deps({ latest: REL('0.60.0') });
    expect((await run({ apply: true }, d2)).out[0]).toMatch(/already up to date/);
    expect(d.applied.concat(d2.applied)).toEqual([]);
    expect(takeRequest(dir)).toBeNull();
  });
  it('refuses on an install that cannot update itself, changing nothing', async () => {
    const d = deps({ assess: async () => ({ available: false, kind: 'container', reason: 'running in a container' }) });
    await expect(run({ apply: true }, d)).rejects.toMatchObject({ code: EXIT.FAILED, message: expect.stringContaining('running in a container') });
    expect(d.applied).toEqual([]);
  });
  it('a failed step is exit 1, says nothing was changed, and requests no restart', async () => {
    const { UpdateError } = await import('../../daemon/update/release');
    const d = deps({ apply: async () => { throw new UpdateError('checksum', 'checksum mismatch'); } });
    await expect(run({ apply: true }, d)).rejects.toMatchObject({ code: EXIT.FAILED, message: expect.stringMatching(/checksum step; the installed bundle was not changed/) });
    expect(takeRequest(dir)).toBeNull();
  });
  it('a held release is reported, not installed', async () => {
    const { UpdateHeld } = await import('../../daemon/update/release');
    const d = deps({ apply: async () => { throw new UpdateHeld('0.69.0', 'speaks wire protocol v2'); } });
    await expect(run({ apply: true }, d)).rejects.toMatchObject({ message: 'speaks wire protocol v2' });
    expect(takeRequest(dir)).toBeNull();
  });
  it('needs exactly one of --check / --apply, and --now only with --apply', async () => {
    await expect(run({}, deps())).rejects.toMatchObject({ code: EXIT.USAGE });
    await expect(run({ check: true, apply: true }, deps())).rejects.toMatchObject({ code: EXIT.USAGE });
    await expect(run({ check: true, now: true }, deps())).rejects.toMatchObject({ code: EXIT.USAGE });
  });
});

describe('runCli', () => {
  it('--version --json carries the protocol the updater checks; plain --version is unchanged', async () => {
    const out: string[] = [];
    await runCli(['--version', '--json'], { out: (l) => out.push(l), err: () => {} });
    expect(JSON.parse(out[0])).toMatchObject({ version: DAEMON_VERSION, protocol: 1 });
    const plain: string[] = [];
    await runCli(['--version'], { out: (l) => plain.push(l), err: () => {} });
    expect(plain).toEqual([DAEMON_VERSION]);
  });
  it('update without a mode is a usage error', async () => {
    const err: string[] = [];
    expect(await runCli(['update', '--data-dir', dir], { out: () => {}, err: (l) => err.push(l) })).toBe(EXIT.USAGE);
    expect(err.join('\n')).toMatch(/--check \| --apply/);
  });
});

describe('config', () => {
  const cfg = (flags = {}, env: NodeJS.ProcessEnv = {}) => resolveConfig({ flags: { dataDir: dir, ...flags }, env });
  it('is off by default with 6h / 2min', () => {
    expect(cfg()).toMatchObject({ autoUpdate: false, autoUpdateIntervalMinutes: 360, autoUpdateQuietMinutes: 2 });
  });
  it('flag > env > config.json', () => {
    expect(cfg({}, { AGENT_THREADS_AUTO_UPDATE: '1' }).autoUpdate).toBe(true);
    expect(cfg({}, { AGENT_THREADS_AUTO_UPDATE: 'true' }).autoUpdate).toBe(true);
    expect(cfg({ autoUpdate: true }, { AGENT_THREADS_AUTO_UPDATE: '0' }).autoUpdate).toBe(true);
    expect(cfg({}, { AGENT_THREADS_AUTO_UPDATE: '0' }).autoUpdate).toBe(false);
    expect(cfg({}, { AGENT_THREADS_AUTO_UPDATE_INTERVAL_MINUTES: '30', AGENT_THREADS_AUTO_UPDATE_QUIET_MINUTES: '10' })).toMatchObject({ autoUpdateIntervalMinutes: 30, autoUpdateQuietMinutes: 10 });
  });
  it('enforces the 15 minute floor on the interval', () => {
    expect(() => cfg({ autoUpdateIntervalMinutes: 5 })).toThrow(/autoUpdateIntervalMinutes/);
    expect(cfg({ autoUpdateIntervalMinutes: 15 }).autoUpdateIntervalMinutes).toBe(15);
  });
  it('reads config.json', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ autoUpdate: true, autoUpdateIntervalMinutes: 60 }));
    expect(cfg()).toMatchObject({ autoUpdate: true, autoUpdateIntervalMinutes: 60 });
  });
  it('the CLI flags reach the daemon config (parsed, not just declared)', async () => {
    const { parseArgs } = await import('../../daemon/cli');
    const p = parseArgs(['serve', '--auto-update', '--auto-update-interval-minutes', '30']);
    expect(p.bools.has('auto-update')).toBe(true);
    expect(p.flags.get('auto-update-interval-minutes')).toEqual(['30']);
  });
});

describe('welcome capability', () => {
  it('advertises update.auto only when the daemon will update itself', () => {
    expect(capabilitiesFor('claude', ['claude'])).not.toContain('update.auto');
    expect(capabilitiesFor('claude', ['claude'], false, true)).toContain('update.auto');
  });
});

describe('IdleGate', () => {
  it('needs both no busy thread and a quiet window since the last activity or busy sighting', () => {
    let now = 10_000;
    let busy: string[] = ['a'];
    let last = 0;
    const gate = new IdleGate({ activity: () => ({ busy, lastActivityAt: last }) }, 1000, () => now);
    expect(gate.evaluate()).toMatchObject({ idle: false, busyThreads: 1 });
    busy = [];
    expect(gate.evaluate()).toMatchObject({ idle: false, quietRemainingMs: 1000 }); // busy was seen just now
    now += 600;
    expect(gate.evaluate().quietRemainingMs).toBe(400);
    last = now; // a command arrives
    expect(gate.evaluate().quietRemainingMs).toBe(1000);
    now += 1000;
    expect(gate.evaluate()).toMatchObject({ idle: true, quietRemainingMs: 0 });
  });
});

describe('doctor check', () => {
  const probes = (files: Record<string, string>): Probes => ({ readFile: (p: string) => files[p] ?? null } as unknown as Probes);
  const target = (autoUpdate?: boolean) => ({ dataDir: '/d', autoUpdate } as never);
  it('skips when off, with the way to opt in', () => {
    expect(checkAutoUpdate(probes({}), target(false))).toMatchObject({ status: 'skip', detail: expect.stringContaining('--auto-update') });
  });
  it('skips when on but not reported yet', () => {
    expect(checkAutoUpdate(probes({}), target(true)).status).toBe('skip');
  });
  it('warns with the reason when on but unavailable', () => {
    const r = checkAutoUpdate(probes({ '/d/update-status.json': JSON.stringify(status({ available: false, reason: 'running in a container' })) }), target());
    expect(r).toMatchObject({ status: 'warn', detail: expect.stringContaining('running in a container') });
  });
  it('passes when working, warns when held or paused', () => {
    expect(checkAutoUpdate(probes({ '/d/update-status.json': JSON.stringify(status()) }), target()).status).toBe('pass');
    expect(checkAutoUpdate(probes({ '/d/update-status.json': JSON.stringify(status({ phase: 'paused_after_rollback' })) }), target()).status).toBe('warn');
  });
  it('trusts the daemon over the config when they disagree (a --auto-update flag on the service)', () => {
    expect(checkAutoUpdate(probes({ '/d/update-status.json': JSON.stringify(status()) }), target(false)).status).toBe('pass');
  });
});

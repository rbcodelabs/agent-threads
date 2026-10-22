import { describe, it, expect } from 'vitest';
import { makeHarness } from '../helpers/localDaemonHarness';
import { CONTAINER_AUTH_TOKEN_SECRET } from '../../src/claudeContainerAuthCli';
import { looksOutOfMemory, parseBootLogExit, parseInspectedContainer } from '../../src/localDaemon/parse';
import { buildLocalDaemonView, formatClockTime } from '../../src/localDaemon/view';

const CLAUDE = 'sk-ant-oat01-TESTTOKEN';

async function setUp() {
  const h = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
  await h.controller.setUp();
  return h;
}

// Lines copied from real `container logs --boot` output (Apple container 1.5.0, 256 MB container, node allocating Buffers).
const START = '2026-10-22T01:09:08.100Z info vminitd: id: NAME starting managed process';
const KERNEL_OOM = [
  '[    3.031246] [    128] 10001   128   252403    65198    65120       78         0  1073152        0             0 node',
  '[    3.031370] oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=NAME,mems_allowed=0,oom_memcg=/container/NAME,task_memcg=/container/NAME,task=node,pid=128,uid=10001',
  '[    3.031590] Memory cgroup out of memory: Killed process 128 (node) total-vm:1009612kB, anon-rss:260480kB, file-rss:312kB, shmem-rss:0kB, UID:10001 pgtables:1048kB oom_score_adj:0',
];
const exited = (n: number) => `2026-10-22T01:09:11.457Z info vminitd: id: NAME, status: ${n} managed process exit`;
const KILLED = ['2026-10-22T01:09:21.945Z info vminitd: id: NAME sending signal 9 to process 129'];
const LOGS = { oom: [START, ...KERNEL_OOM, exited(137)], kill: [START, ...KILLED, exited(137)], clean: [START, exited(0)] };

function crash(h: Awaited<ReturnType<typeof setUp>>, bootLog: string[]) {
  const s = h.readState();
  s.containers[h.name] = { ...s.containers[h.name], state: 'stopped', bootLog: bootLog.map((l) => l.replaceAll('NAME', h.name)) };
  h.writeState(s);
}

describe('real `container` CLI output shapes', () => {
  it('inspect of a stopped container carries no exit facts (only state and labels)', () => {
    const real = JSON.stringify([{ status: { networks: [], startedDate: '2026-10-22T01:09:11Z', state: 'stopped' }, configuration: { id: 'x', labels: {} } }]);
    expect(parseInspectedContainer(real)).toEqual({ state: 'stopped', labels: {} });
  });
});

describe('parseBootLogExit', () => {
  it('a kernel OOM kill ends with exit 137 and the kernel line', () => {
    expect(parseBootLogExit(LOGS.oom.join('\n'))).toEqual({ exitStatus: 137, oomKill: true });
  });
  it('a plain container kill is exit 137 WITHOUT the kernel line', () => {
    expect(parseBootLogExit(LOGS.kill.join('\n'))).toEqual({ exitStatus: 137, oomKill: false });
  });
  it('a clean exit is status 0', () => {
    expect(parseBootLogExit(LOGS.clean.join('\n'))).toEqual({ exitStatus: 0, oomKill: false });
  });
  it('only the last run counts: an OOM from an earlier start does not leak into a later clean run', () => {
    expect(parseBootLogExit([...LOGS.oom, ...LOGS.clean].join('\n'))).toEqual({ exitStatus: 0, oomKill: false });
  });
  it('an empty or unrecognised log is neutral', () => {
    expect(parseBootLogExit('')).toEqual({ oomKill: false });
  });
  it('looksOutOfMemory needs the kernel line AND exit 137', () => {
    expect(looksOutOfMemory({ oomKill: true, exitStatus: 137 })).toBe(true);
    expect(looksOutOfMemory({ oomKill: false, exitStatus: 137 })).toBe(false);
    expect(looksOutOfMemory({ oomKill: true, exitStatus: 0 })).toBe(false);
    expect(looksOutOfMemory({ oomKill: true })).toBe(false);
  });
});

describe('out-of-memory detection', () => {
  it('a container the kernel OOM-killed shows the out-of-memory view with a Restart button', async () => {
    const h = await setUp();
    // a fresh controller (a new plugin session) did not stop it
    const fresh = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE }, vaultPath: h.vaultPath, settings: h.settings });
    fresh.writeState(h.readState());
    crash(fresh, LOGS.oom);
    const snap = await fresh.controller.snapshot({ quick: true });
    expect(snap.observed.stoppedOutOfMemory).toBe(true);
    const view = buildLocalDaemonView(snap);
    expect(view.statusLabel).toMatch(/out of memory/i);
    expect(view.tone).toBe('error');
    expect(view.hint).toMatch(/memory/i);
    expect(view.buttons[0]).toMatchObject({ id: 'restart', cta: true });
  });

  it('a bare exit 137 with no kernel OOM line (an external kill) is just Stopped', async () => {
    const h = await setUp();
    const fresh = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE }, vaultPath: h.vaultPath, settings: h.settings });
    fresh.writeState(h.readState());
    crash(fresh, LOGS.kill);
    const snap = await fresh.controller.snapshot({ quick: true });
    expect(snap.observed.stoppedOutOfMemory).toBeUndefined();
    expect(buildLocalDaemonView(snap).statusLabel).toBe('Stopped');
  });

  it('an exit after our own stop or kill is not reported as out of memory', async () => {
    const h = await setUp();
    await h.controller.kill();
    crash(h, LOGS.oom);
    const snap = await h.controller.snapshot({ quick: true });
    expect(snap.observed.stoppedOutOfMemory).toBeUndefined();
    expect(buildLocalDaemonView(snap).statusLabel).toBe('Stopped');
  });

  it('a clean exit is just Stopped', async () => {
    const h = await setUp();
    const fresh = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE }, vaultPath: h.vaultPath, settings: h.settings });
    fresh.writeState(h.readState());
    crash(fresh, LOGS.clean);
    expect((await fresh.controller.snapshot({ quick: true })).observed.stoppedOutOfMemory).toBeUndefined();
  });

  it('a running container never reads the boot log', async () => {
    const h = await setUp();
    const before = h.calls().length;
    await h.controller.snapshot({ quick: true });
    expect(h.calls().slice(before).some((c) => c.includes('--boot'))).toBe(false);
  });

  it('Restart brings an out-of-memory container back', async () => {
    const h = await setUp();
    crash(h, LOGS.oom);
    await h.controller.restart();
    expect(h.readState().containers[h.name]?.state).toBe('running');
  });
});

describe('controller watchdog', () => {
  it('force-restarts a wedged daemon, surfaces it in the snapshot, and stops cleanly', async () => {
    const h = await setUp();
    const startedAt = h.calls().length;
    // wedged until the container has been started again
    h.deps.healthz = async () => h.calls().slice(startedAt).some((c) => c.startsWith('start '));
    h.controller.startWatchdog({ intervalMs: 15, failuresBeforeRecovery: 2 });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && h.controller['watchdog']?.getState().lastRestartAt === undefined) {
      await new Promise((r) => setTimeout(r, 20));
    }
    h.controller.stopWatchdog();
    const added = h.calls().slice(startedAt).join('\n');
    expect(added).toMatch(/^stop /m);
    expect(added).toMatch(/^start /m);
    expect(h.readState().containers[h.name]?.state).toBe('running');
  });

  it('is off when the setting is false and never starts a stopped daemon', async () => {
    const h = await setUp();
    h.setSettings({ ...h.settings!, watchdog: false });
    const before = h.calls().length;
    h.deps.healthz = async () => false;
    h.controller.startWatchdog({ intervalMs: 10, failuresBeforeRecovery: 1 });
    await new Promise((r) => setTimeout(r, 150));
    h.controller.stopWatchdog();
    expect(h.calls().slice(before).filter((c) => /^(stop|kill|start) /.test(c))).toEqual([]);
  });

  it('does nothing to a daemon the user stopped', async () => {
    const h = await setUp();
    await h.controller.stop();
    const before = h.calls().length;
    h.deps.healthz = async () => false;
    h.controller.startWatchdog({ intervalMs: 10, failuresBeforeRecovery: 1 });
    await new Promise((r) => setTimeout(r, 150));
    h.controller.stopWatchdog();
    expect(h.calls().slice(before).filter((c) => /^(stop|kill|start) /.test(c))).toEqual([]);
    expect(h.readState().containers[h.name]?.state).toBe('stopped');
  });
});

describe('watchdog in the view', () => {
  it('shows the auto-restart time and the give-up message', async () => {
    const h = await setUp();
    const snap = await h.controller.snapshot({ quick: true });
    const at = new Date(2026, 9, 20, 9, 7).getTime();
    const restarted = buildLocalDaemonView({ ...snap, watchdog: { status: 'watching', consecutiveFailures: 0, attempts: 1, maxAttempts: 3, lastRestartAt: at, lastRestartOk: true } });
    expect(restarted.lines).toContainEqual({ label: 'Auto-recovery', value: 'Auto-restarted at 09:07' });
    expect(formatClockTime(at)).toBe('09:07');
    const gaveUp = buildLocalDaemonView({ ...snap, watchdog: { status: 'gave-up', consecutiveFailures: 3, attempts: 3, maxAttempts: 3 } });
    expect(gaveUp.lines.find((l) => l.label === 'Auto-recovery')?.value).toMatch(/^Watchdog gave up after 3 attempts/);
    expect(buildLocalDaemonView(snap).lines.some((l) => l.label === 'Auto-recovery')).toBe(false);
  });
});

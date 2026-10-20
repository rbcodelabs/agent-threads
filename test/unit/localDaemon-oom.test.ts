import { describe, it, expect } from 'vitest';
import { makeHarness } from '../helpers/localDaemonHarness';
import { CONTAINER_AUTH_TOKEN_SECRET } from '../../src/claudeContainerAuthCli';
import { looksOutOfMemory, parseInspectedContainer } from '../../src/localDaemon/parse';
import { buildLocalDaemonView, formatClockTime } from '../../src/localDaemon/view';

const CLAUDE = 'sk-ant-oat01-TESTTOKEN';

async function setUp() {
  const h = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
  await h.controller.setUp();
  return h;
}

function crash(h: Awaited<ReturnType<typeof setUp>>, extra: { exitCode?: number; oomKilled?: boolean }) {
  const s = h.readState();
  s.containers[h.name] = { ...s.containers[h.name], state: 'stopped', ...extra };
  h.writeState(s);
}

describe('parseInspectedContainer exit facts', () => {
  const wrap = (entry: object) => JSON.stringify([entry]);
  it('reads exit code and OOMKilled from either shape', () => {
    expect(parseInspectedContainer(wrap({ status: { state: 'stopped', exitCode: 137 } }))).toMatchObject({ state: 'stopped', exitCode: 137 });
    expect(parseInspectedContainer(wrap({ status: 'stopped', exitCode: 137 }))?.exitCode).toBe(137);
    expect(parseInspectedContainer(wrap({ State: { Status: 'exited', ExitCode: 0, OOMKilled: true } }))).toMatchObject({ exitCode: 0, oomKilled: true });
    expect(parseInspectedContainer(wrap({ status: 'stopped' }))).toEqual({ state: 'stopped', labels: {} });
  });
  it('looksOutOfMemory is true for OOMKilled or exit 137 only', () => {
    expect(looksOutOfMemory({ oomKilled: true })).toBe(true);
    expect(looksOutOfMemory({ exitCode: 137 })).toBe(true);
    expect(looksOutOfMemory({ exitCode: 0 })).toBe(false);
    expect(looksOutOfMemory({ exitCode: 143 })).toBe(false);
  });
});

describe('out-of-memory detection', () => {
  it('a container that exited 137 on its own shows the out-of-memory view with a Restart button', async () => {
    const h = await setUp();
    // a fresh controller (a new plugin session) did not stop it
    const fresh = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE }, vaultPath: h.vaultPath, settings: h.settings });
    fresh.writeState(h.readState());
    crash(fresh, { exitCode: 137 });
    const snap = await fresh.controller.snapshot({ quick: true });
    expect(snap.observed.stoppedOutOfMemory).toBe(true);
    const view = buildLocalDaemonView(snap);
    expect(view.statusLabel).toMatch(/out of memory/i);
    expect(view.tone).toBe('error');
    expect(view.hint).toMatch(/memory/i);
    expect(view.buttons[0]).toMatchObject({ id: 'restart', cta: true });
  });

  it('an OOMKilled flag counts even for a container we stopped', async () => {
    const h = await setUp();
    await h.controller.stop();
    crash(h, { exitCode: 1, oomKilled: true });
    expect((await h.controller.snapshot({ quick: true })).observed.stoppedOutOfMemory).toBe(true);
  });

  it('a plain exit 137 after our own stop or kill is not reported as out of memory', async () => {
    const h = await setUp();
    await h.controller.kill();
    crash(h, { exitCode: 137 });
    const snap = await h.controller.snapshot({ quick: true });
    expect(snap.observed.stoppedOutOfMemory).toBeUndefined();
    expect(buildLocalDaemonView(snap).statusLabel).toBe('Stopped');
  });

  it('a clean exit is just Stopped', async () => {
    const h = await setUp();
    crash(h, { exitCode: 0 });
    expect((await h.controller.snapshot({ quick: true })).observed.stoppedOutOfMemory).toBeUndefined();
  });

  it('Restart brings an out-of-memory container back', async () => {
    const h = await setUp();
    crash(h, { oomKilled: true });
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

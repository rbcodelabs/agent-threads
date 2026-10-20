/**
 * A real daemon (scripted harness, real sockets, real ThreadHost) with the auto-updater running on short real
 * intervals: a newer release is staged, but the daemon does not ask to restart while a turn is running or a request
 * is open, and does once everything has ended and a quiet window has passed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TestClient, SPEC, startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';
import type { LatestRelease } from '../../daemon/update/release';

const RELEASE: LatestRelease = { version: '0.1.1', tag: 'v0.1.1', bundleUrl: 'https://github.com/x', checksumUrl: 'https://github.com/y' };
const QUIET_MS = 400;

interface Harness { td: TestDaemon; restarts: Array<{ to: string; at: number }>; applied: string[] }
let live: Harness | null = null;

async function start(extra: { enabled?: boolean; available?: boolean } = {}): Promise<Harness> {
  const restarts: Harness['restarts'] = [];
  const applied: string[] = [];
  const td = await startTestDaemon({
    config: { autoUpdate: extra.enabled ?? true },
    onRestartRequested: (i) => restarts.push({ to: i.to, at: Date.now() }),
    autoUpdate: {
      currentVersion: '0.1.0',
      assessment: { available: extra.available ?? true, kind: 'systemd', bundlePath: '/nowhere/agent-threads.cjs', ...(extra.available === false ? { reason: 'running in a container' } : {}) },
      releases: { latest: async () => RELEASE },
      apply: async (r) => { applied.push(r.version); return { from: '0.1.0', to: r.version, prevPath: '/nowhere/prev', bundlePath: '/nowhere/agent-threads.cjs' }; },
      tickMs: 25, initialDelayMs: 0, intervalMs: 60_000, quietMs: QUIET_MS,
    },
  });
  live = { td, restarts, applied };
  return live;
}
afterEach(async () => { await live?.td.cleanup(); live = null; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 4000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(10); }
}

describe('auto-update against a real daemon', () => {
  it('does not exit during a running turn, and does after it ends (plus the quiet window)', async () => {
    const h = await start();
    const c = await TestClient.connect(h.td.daemon.url, h.td.adminToken);
    expect((await c.cmd('session.open', { threadId: 't1', spec: SPEC })).type).toBe('ack');
    expect((await c.cmd('session.send', { threadId: 't1', text: '/hang', userMessageUuid: 'u1' })).type).toBe('ack');

    await until(() => h.applied.length === 1, 4000, 'the update to be staged');
    expect(h.td.daemon.threads.list()[0]).toMatchObject({ turnInFlight: true });
    await sleep(QUIET_MS * 3); // far longer than the quiet window, with the turn still running
    expect(h.restarts).toEqual([]);
    expect(h.td.daemon.updater.currentPhase).toBe('waiting_for_idle');

    await c.cmd('session.interrupt', { threadId: 't1' });
    await until(() => !h.td.daemon.threads.list()[0].turnInFlight, 4000, 'the turn to end');
    const endedAt = Date.now();
    await until(() => h.restarts.length === 1, 4000, 'the restart request');
    expect(h.restarts[0].to).toBe('0.1.1');
    expect(h.restarts[0].at - endedAt).toBeGreaterThanOrEqual(QUIET_MS - 100);
    await c.close();
  });

  it('an open permission request blocks the restart until it is answered', async () => {
    const h = await start();
    const c = await TestClient.connect(h.td.daemon.url, h.td.adminToken);
    await c.cmd('session.open', { threadId: 't2', spec: SPEC });
    await c.cmd('attach', { ch: 't:t2', afterSeq: 0 });
    await c.cmd('session.send', { threadId: 't2', text: '/permission', userMessageUuid: 'u2' });
    const req = await c.waitFor((f) => f.name === 'permission_request', 4000, 'permission_request');
    await sleep(QUIET_MS * 3);
    expect(h.restarts).toEqual([]);
    const requestId = (req.args as { requestId: string }).requestId;
    expect((await c.cmd('resolve.permission', { threadId: 't2', requestId, allow: true })).type).toBe('ack');
    await until(() => h.restarts.length === 1, 4000, 'the restart after the request was answered');
    await c.close();
  });

  it('a new turn during the quiet window pushes the restart back', async () => {
    const h = await start();
    const c = await TestClient.connect(h.td.daemon.url, h.td.adminToken);
    await c.cmd('session.open', { threadId: 't3', spec: SPEC });
    await c.cmd('session.send', { threadId: 't3', text: '/hang', userMessageUuid: 'u3' });
    await until(() => h.applied.length === 1);
    await c.cmd('session.interrupt', { threadId: 't3' });
    await until(() => !h.td.daemon.threads.list()[0].turnInFlight);
    await sleep(QUIET_MS / 2);
    expect(h.restarts).toEqual([]);
    await c.cmd('session.send', { threadId: 't3', text: '/hang', userMessageUuid: 'u3b' }); // inside the window
    await sleep(QUIET_MS * 2);
    expect(h.restarts).toEqual([]);
    await c.cmd('session.interrupt', { threadId: 't3' });
    await until(() => h.restarts.length === 1, 4000, 'the restart after the second turn');
    await c.close();
  });

  it('advertises update.auto in welcome only when it will update itself', async () => {
    let h = await start();
    let c = await TestClient.connect(h.td.daemon.url, h.td.adminToken);
    expect(c.frames.find((f) => f.type === 'welcome')?.capabilities).toContain('update.auto');
    await c.close();
    await live!.td.cleanup();
    h = await start({ available: false });
    c = await TestClient.connect(h.td.daemon.url, h.td.adminToken);
    expect(c.frames.find((f) => f.type === 'welcome')?.capabilities).not.toContain('update.auto');
    await sleep(200);
    expect(h.applied).toEqual([]);
    expect(h.restarts).toEqual([]);
    await c.close();
  });

  it('with auto-update off the daemon never checks or restarts', async () => {
    const h = await start({ enabled: false });
    await sleep(300);
    expect(h.applied).toEqual([]);
    expect(h.restarts).toEqual([]);
  });
});

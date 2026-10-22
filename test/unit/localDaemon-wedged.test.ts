import { describe, it, expect, vi } from 'vitest';
import { makeHarness } from '../helpers/localDaemonHarness';
import { CONTAINER_AUTH_TOKEN_SECRET } from '../../src/claudeContainerAuthCli';

const CLAUDE = 'sk-ant-oat01-TESTTOKEN';

async function setUp() {
  const h = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
  await h.controller.setUp();
  return h;
}

describe('observe against a wedged VM', () => {
  it('skips the exec probes and the image/volume checks when healthz is down', async () => {
    const h = await setUp();
    h.writeState({ ...h.readState(), unhealthy: true });
    const before = h.calls().length;
    const snap = await h.controller.snapshot();
    const added = h.calls().slice(before).join('\n');
    expect(snap.assessment).toMatchObject({ status: 'degraded', degraded: 'health-down' });
    expect(snap.assessment.plan).toContain('restart-container');
    expect(added).toMatch(/^inspect /m);
    expect(added).not.toMatch(/^exec /m);
    expect(added).not.toMatch(/^volume inspect/m);
    expect(added).not.toMatch(/^image inspect/m);
  });

  it('a quick snapshot of a running daemon makes no exec, image or volume calls', async () => {
    const h = await setUp();
    const before = h.calls().length;
    const snap = await h.controller.snapshot({ quick: true });
    expect(snap.assessment.status).toBe('running');
    expect(h.calls().slice(before).filter((c) => !c.startsWith('inspect '))).toEqual([]);
  });

  it('a healthy daemon is still fully probed by the full snapshot', async () => {
    const h = await setUp();
    const before = h.calls().length;
    await h.controller.snapshot();
    expect(h.calls().slice(before).some((c) => c.startsWith('exec '))).toBe(true);
  });
});

describe('restart and kill against a wedged VM', () => {
  it('restart falls through stop and kill to ending the VM helper, then starts', async () => {
    const h = await setUp();
    const killVmHelper = vi.fn(async () => { h.writeState({ ...h.readState(), helperKilled: true }); });
    h.deps.killVmHelper = killVmHelper;
    h.setFail(['stop:wedged', 'kill:wedged']);
    const before = h.calls().length;
    await h.controller.restart();
    const added = h.calls().slice(before).join('\n');
    expect(killVmHelper).toHaveBeenCalledWith(h.name);
    expect(added.indexOf('stop ')).toBeGreaterThanOrEqual(0);
    expect(added.indexOf('kill ')).toBeGreaterThan(added.indexOf('stop '));
    expect(added.lastIndexOf('start ')).toBeGreaterThan(added.indexOf('kill '));
    expect(h.readState().containers[h.name]?.state).toBe('running');
  });

  it('restart does not touch the VM helper or kill when a plain stop works', async () => {
    const h = await setUp();
    const killVmHelper = vi.fn(async () => undefined);
    h.deps.killVmHelper = killVmHelper;
    await h.controller.restart();
    expect(killVmHelper).not.toHaveBeenCalled();
    expect(h.calls().join('\n')).not.toMatch(/^kill /m);
  });

  it('kill skips the graceful stop', async () => {
    const h = await setUp();
    const before = h.calls().length;
    await h.controller.kill();
    const added = h.calls().slice(before);
    expect(added.some((c) => c.startsWith('kill '))).toBe(true);
    expect(added.some((c) => c.startsWith('stop '))).toBe(false);
    expect(h.readState().containers[h.name]?.state).toBe('stopped');
  });

  it('reports an error when nothing could stop the container', async () => {
    const h = await setUp();
    h.setFail(['stop:wedged', 'kill:wedged']);
    await expect(h.controller.kill()).rejects.toMatchObject({ code: 'stop' });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { makeHarness } from '../helpers/localDaemonHarness';
import { snap } from '../helpers/localDaemonSnap';
import { parseHarnessProbe } from '../../src/localDaemon/parse';
import { LocalDaemonController } from '../../src/localDaemon/controller';
import { buildLocalDaemonView } from '../../src/localDaemon/view';
import { CODEX_VERSION, buildThinImageArgs, dataVolumeFor, localImageRef } from '../../src/localDaemon/spec';

const older = `${CODEX_VERSION}-alpha.1`;
const ahead = `${Number(CODEX_VERSION.split('.')[0]) + 1}.0.0`;

describe('Codex harness freshness', () => {
  it('probes the actual binary version and preserves its pre-release suffix', () => {
    expect(parseHarnessProbe('codex.cli=1\ncodex.version=codex-cli 0.169.0-alpha.2\ncodex.auth=1'))
      .toEqual({ codex: { cli: true, signedIn: true, version: '0.169.0-alpha.2' } });
    expect(parseHarnessProbe('codex.cli=1\ncodex.version=not a version'))
      .toEqual({ codex: { cli: true, signedIn: false } });
  });

  it('supplies an exact Codex version when building the managed image', () => {
    const args = buildThinImageArgs({ version: '0.76.1', harnesses: ['codex'], dockerfilePath: 'Containerfile', contextDir: '.' });
    expect(args.find((arg) => arg.startsWith('CODEX_VERSION='))).toMatch(/^CODEX_VERSION=\d+\.\d+\.\d+$/);
  });

  it('shows the measured version and offers an explicit update only when needed', () => {
    const snapshot = snap({ harnessProbe: { codex: { cli: true, signedIn: true, version: older } } }, {
      harnesses: ['codex'], codexUpdate: { from: older, to: CODEX_VERSION, availability: 'idle' },
    });
    const view = buildLocalDaemonView(snapshot);
    expect(view.harnessRows.find(({id}) => id === 'codex')?.status).toContain(older);
    expect(view.buttons).toContainEqual(expect.objectContaining({ id: 'update-harnesses', label: 'Update harnesses' }));
    expect(buildLocalDaemonView({ ...snapshot, codexUpdate: undefined }).buttons.some(({id}) => id === 'update-harnesses')).toBe(false);
  });

  async function legacy() {
    const h = makeHarness({ settings: { enabled: true, port: 7433, harnesses: ['codex'] } });
    await h.controller.setUp();
    const state = h.readState();
    const oldImage = localImageRef(h.pluginVersion, ['codex']);
    state.images[oldImage].codexVersion = older;
    state.volumes[dataVolumeFor(h.vaultPath)].auth = { codex: true };
    h.writeState(state);
    return { h, oldImage, state };
  }

  it('preserves the previous image, named volumes and registration across success and Stop/Start', async () => {
    const { h, oldImage, state } = await legacy();
    const availability = vi.fn(async () => 'idle' as const);
    const controller = new LocalDaemonController({ ...h.deps, harnessMaintenance: availability });
    const registered = h.registered;
    const preview = (await controller.snapshot()).codexUpdate!;
    expect(preview).toMatchObject({ from: older, to: CODEX_VERSION });
    await controller.updateHarnesses(preview);
    const after = h.readState();
    expect(after.images[oldImage]).toBeDefined();
    expect(after.containers[h.name].image).not.toBe(oldImage);
    expect(after.volumes).toEqual(state.volumes);
    expect(h.registered).toEqual(registered);
    expect((await controller.snapshot()).observed.harnessProbe?.codex?.version).toBe(CODEX_VERSION);
    await controller.stop();
    await new LocalDaemonController({ ...h.deps, harnessMaintenance: availability }).start();
    expect(h.readState().containers[h.name].image).toBe(after.containers[h.name].image);
    h.setSettings({ ...h.settings!, memory: '8G' });
    await controller.update();
    expect(h.readState().containers[h.name].image).toBe(after.containers[h.name].image);

  }, 30_000);

  it('leaves a busy daemon running when an active turn arrives after preview', async () => {
    const { h, oldImage } = await legacy();
    const controller = new LocalDaemonController({ ...h.deps, harnessMaintenance: async (_port, _token, method) => method === 'POST' ? 'busy' : 'idle' });
    const preview = (await controller.snapshot()).codexUpdate!;
    const offset = h.calls().length;
    await expect(controller.updateHarnesses(preview)).rejects.toMatchObject({ code: 'busy' });
    expect(h.readState().containers[h.name]).toMatchObject({ image: oldImage, state: 'running' });
    expect(h.calls().slice(offset).filter((c) => c === `stop ${h.name}` || c === `rm ${h.name}`)).toEqual([]);
  }, 30_000);

  it('restores the prior image and data when the candidate fails to start', async () => {
    const { h, oldImage, state } = await legacy();
    h.setFail(['run:codex-candidate']);
    const controller = new LocalDaemonController({ ...h.deps, harnessMaintenance: async () => 'idle' });
    const preview = (await controller.snapshot()).codexUpdate!;
    await expect(controller.updateHarnesses(preview)).rejects.toThrow(/previous daemon image was restored/i);
    expect(h.readState().containers[h.name]).toMatchObject({ image: oldImage, state: 'running' });
    expect(h.readState().volumes).toEqual(state.volumes);
  }, 30_000);

  it('withholds the update if the measured binary is ahead of the pin', async () => {
    const { h, oldImage } = await legacy();
    const state = h.readState();
    state.images[oldImage].codexVersion = ahead;
    h.writeState(state);
    const controller = new LocalDaemonController({ ...h.deps, harnessMaintenance: async () => 'idle' });
    const snapshot = await controller.snapshot();
    expect(snapshot.observed.harnessProbe?.codex?.version).toBe(ahead);
    expect(snapshot.codexUpdate).toBeUndefined();
  }, 30_000);
});

import { describe, it, expect, vi } from 'vitest';
import { makeHarness } from '../helpers/localDaemonHarness';
import { LocalDaemonAbortedError, LocalDaemonError } from '../../src/localDaemon/provision';
import { LOCAL_DAEMON_ID } from '../../src/localDaemon/spec';
import { LOCAL_DAEMON_TOKEN_SECRET } from '../../src/localDaemon/registration';
import { CONTAINER_AUTH_TOKEN_SECRET } from '../../src/claudeContainerAuthCli';
import { dataVolumeFor, localImageRef, publishedImageRef } from '../../src/localDaemon/spec';

const CLAUDE = 'sk-ant-oat01-TESTTOKEN';

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, `expected LocalDaemonError ${code}`).toBeInstanceOf(LocalDaemonError);
  expect((err as LocalDaemonError).code).toBe(code);
  return err as LocalDaemonError;
}

describe('set up', () => {
  it('goes from nothing to a registered, running daemon with a token in the keychain', async () => {
    const h = makeHarness({ runtime: { installed: false, running: false }, secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
    const progress: string[] = [];
    const a = await h.controller.setUp({ onProgress: (p) => progress.push(p.label) });
    expect(a.status).toBe('running');
    expect(h.runtimeCalls).toEqual(['install', 'start']);
    const s = h.readState();
    expect(s.images[publishedImageRef(h.pluginVersion)]).toBeTruthy();
    expect(s.images[localImageRef(h.pluginVersion)]?.built).toBe(true);
    expect(Object.keys(s.volumes)).toHaveLength(2);
    expect(Object.values(s.volumes).every((v) => v.owner === 10001)).toBe(true);
    // the credential was written into the data volume via stdin, and is nowhere in any argv
    expect(s.volumes[dataVolumeFor(h.vaultPath)]?.credential).toBe(CLAUDE);
    expect(h.calls().join('\n')).not.toContain(CLAUDE);
    // the token exists in the keychain and the daemon accepts it
    const token = h.token();
    expect(token).toMatch(/^secret-/);
    expect(s.volumes[dataVolumeFor(h.vaultPath)]?.tokens?.some((t) => t.token === token && t.revokedAt === null)).toBe(true);
    expect(h.calls().join('\n')).not.toContain(token!);
    // registered as a managed daemon on loopback with the vault mapped
    expect(h.registered).toMatchObject({
      id: LOCAL_DAEMON_ID, managed: 'local-container', url: 'ws://127.0.0.1:7433',
      vaultMapping: { localRoot: h.vaultPath, remoteRoot: '/vault' },
    });
    expect(h.settings).toMatchObject({ enabled: true, port: 7433, credentialWritten: true });
    expect(progress.length).toBeGreaterThan(2);
    // the container is loopback only, with the config dirs masked
    const run = h.calls().find((c) => c.startsWith('run --detach'))!;
    expect(run).toContain('127.0.0.1:7433:7433');
    expect(run).toContain(`${h.vaultPath}/.geode:/vault/.geode:ro`);
    expect(run).toContain(`${h.vaultPath}/.obsidian:/vault/.obsidian:ro`);
  });

  it('without a Claude credential it still runs and reports that sign-in is needed', async () => {
    const h = makeHarness();
    const a = await h.controller.setUp();
    expect(a.status).toBe('needs-sign-in');
    expect(a.needsSignIn).toBe(true);
    expect(h.readState().volumes[dataVolumeFor(h.vaultPath)]?.credential).toBeUndefined();
    expect(h.settings?.credentialWritten).toBe(false);
  });

  it('is idempotent: a second run does nothing destructive and reaches the same state', async () => {
    const h = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
    await h.controller.setUp();
    const token = h.token();
    const before = h.calls().length;
    const a = await h.controller.setUp();
    expect(a.status).toBe('running');
    expect(h.token()).toBe(token);
    const added = h.calls().slice(before).join('\n');
    expect(added).not.toMatch(/^run --detach|volume create|token create|image pull|build/m);
  });

  it('observe after set up yields an empty plan (apply then re-observe)', async () => {
    const h = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
    await h.controller.setUp();
    expect((await h.controller.snapshot()).assessment.plan).toEqual([]);
  });

  it('picks the next free port when 7433 is taken and remembers it', async () => {
    const h = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
    const s = h.readState(); h.writeState({ ...s, portsTaken: [7433, 7434] });
    await h.controller.setUp();
    expect(h.settings?.port).toBe(7435);
    expect(h.registered?.url).toBe('ws://127.0.0.1:7435');
  });
});

describe('set up failures', () => {
  it.each([
    ['pull:denied', 'pull-denied', /Public/],
    ['pull:404', 'pull-not-found', /not published yet/],
    ['pull:network', 'pull-network', /ghcr\.io/],
    ['build', 'build', /Claude CLI/],
  ])('%s -> %s', async (fail, code, message) => {
    const h = makeHarness({ fail: [fail] });
    const err = await expectCode(h.controller.setUp(), code);
    expect(err.message).toMatch(message);
    expect(h.registered).toBeUndefined();
    expect((await h.controller.snapshot()).lastError?.code).toBe(code);
  });

  it('a failed pull leaves nothing half-created, and Retry succeeds once the image exists', async () => {
    const h = makeHarness({ fail: ['pull:404'] });
    await expectCode(h.controller.setUp(), 'pull-not-found');
    expect(Object.keys(h.readState().containers)).toHaveLength(0);
    expect(Object.keys(h.readState().volumes)).toHaveLength(0);
    h.setFail([]);
    expect((await h.controller.setUp()).status).toBe('needs-sign-in');
    expect((await h.controller.snapshot()).lastError).toBeNull();
  });

  it('refuses a container the plugin did not create', async () => {
    const h = makeHarness();
    h.writeState({ ...h.readState(), containers: { [h.name]: { state: 'running', labels: {}, hostPort: 1, volumes: [], env: [], cmd: [], publish: '' } } });
    await expectCode(h.controller.setUp(), 'name-conflict');
    expect(h.readState().containers[h.name]).toBeTruthy();
    expect((await h.controller.snapshot()).assessment.status).toBe('conflict');
  });

  it('reports a daemon that never answers, with its log tail', async () => {
    const h = makeHarness();
    h.writeState({ ...h.readState(), unhealthy: true, eaccess: true });
    const err = await expectCode(h.controller.setUp(), 'health');
    expect(err.message).toMatch(/cannot write its data folder/);
  });

  it('when the token cannot be created the setup fails with no token leaked', async () => {
    const h = makeHarness({ fail: ['exec:token'] });
    await expectCode(h.controller.setUp(), 'token');
    expect(h.token()).toBeUndefined();
  });

  it('a keychain that cannot store the token revokes the one just minted', async () => {
    const h = makeHarness();
    h.deps.secrets.set = ((n: string) => { if (n === LOCAL_DAEMON_TOKEN_SECRET) throw new Error('keychain locked'); }) as never;
    await expectCode(h.controller.setUp(), 'keychain');
    const tokens = h.readState().volumes[dataVolumeFor(h.vaultPath)]?.tokens ?? [];
    expect(tokens.length).toBe(1);
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);
  });

  it('refuses an unsupported Mac before touching anything', async () => {
    const h = makeHarness({ runtime: { supported: false, reason: 'Sandboxed VMs require macOS 26 or later' } });
    const err = await expectCode(h.controller.setUp(), 'unsupported');
    expect(err.message).toMatch(/macOS 26/);
    expect(h.calls()).toEqual([]);
    expect((await h.controller.snapshot()).assessment.status).toBe('unsupported');
  });

  it('refuses a vault path the runtime cannot mount', async () => {
    const h = makeHarness({ vaultPath: '/tmp/my:vault' });
    await expectCode(h.controller.setUp(), 'unsupported');
  });
});

describe('crash resume', () => {
  it('a token minted but never stored is revoked and replaced on the next run', async () => {
    const h = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
    await h.controller.setUp();
    const orphan = h.token();
    // crash between create and keychain write: the keychain lost the token
    h.secrets.delete(LOCAL_DAEMON_TOKEN_SECRET);
    await h.controller.start();
    const tokens = h.readState().volumes[dataVolumeFor(h.vaultPath)]!.tokens!;
    expect(tokens.filter((t) => t.revokedAt === null)).toHaveLength(1);
    expect(h.token()).not.toBe(orphan);
    expect(tokens.find((t) => t.token === orphan)?.revokedAt).not.toBeNull();
  });

  it('adopts a container left running by a crashed or reloaded Geode (no recreate)', async () => {
    const h = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
    await h.controller.setUp();
    const before = h.calls().length;
    // new controller, same world and settings: a plugin reload
    const a = await h.controller.start();
    expect(a.status).toBe('running');
    expect(h.calls().slice(before).join('\n')).not.toMatch(/run --detach|rm --force|volume create/);
  });

  it('recreates a container the user removed, keeping data and token', async () => {
    const h = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
    await h.controller.setUp();
    const token = h.token();
    const s = h.readState(); delete s.containers[h.name]; h.writeState(s);
    expect((await h.controller.snapshot()).assessment.status).toBe('stopped');
    const a = await h.controller.start();
    expect(a.status).toBe('running');
    expect(h.token()).toBe(token);
  });

  it('a runtime that stopped (reboot) is started again, then the container', async () => {
    const h = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
    await h.controller.setUp();
    h.runtimeState.running = false;
    const s = h.readState(); s.containers[h.name]!.state = 'stopped'; h.writeState(s);
    const a = await h.controller.start();
    expect(a.status).toBe('running');
    expect(h.runtimeCalls).toContain('start');
  });
});

describe('start, stop, restart', () => {
  it('stop leaves the container stopped (data kept); start brings it back', async () => {
    const h = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
    await h.controller.setUp();
    await h.controller.stop();
    expect(h.readState().containers[h.name]?.state).toBe('stopped');
    expect((await h.controller.snapshot()).assessment.status).toBe('stopped');
    await h.controller.start();
    expect(h.readState().containers[h.name]?.state).toBe('running');
  });

  it('restart stops then starts the same container', async () => {
    const h = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
    await h.controller.setUp();
    const before = h.calls().length;
    await h.controller.restart();
    const added = h.calls().slice(before).join('\n');
    expect(added).toMatch(/^stop /m);
    expect(added).toMatch(/^start /m);
    expect(added).not.toMatch(/run --detach/);
  });

  it('start refuses before Set up', async () => {
    const h = makeHarness();
    await expectCode(h.controller.start(), 'not-set-up');
  });

  it('a daemon whose token was rejected gets a new one', async () => {
    const h = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
    await h.controller.setUp();
    h.secrets.set(LOCAL_DAEMON_TOKEN_SECRET, 'wrong');
    expect((await h.controller.snapshot()).assessment).toMatchObject({ status: 'degraded', degraded: 'token-rejected' });
    await h.controller.start();
    expect((await h.controller.snapshot()).assessment.status).toBe('running');
  });
});

describe('ensureRunning (lazy start for a thread)', () => {
  it('is a no-op fast path when the daemon is already healthy', async () => {
    const h = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
    await h.controller.setUp();
    const before = h.calls().length;
    await h.controller.ensureRunning();
    expect(h.calls().length).toBe(before);
  });

  it('starts a stopped daemon on first use', async () => {
    const h = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
    await h.controller.setUp();
    await h.controller.stop();
    await h.controller.ensureRunning();
    expect(h.readState().containers[h.name]?.state).toBe('running');
  });

  it('explains what to do when not set up or not signed in', async () => {
    const a = makeHarness();
    await expectCode(a.controller.ensureRunning(), 'not-set-up');
    const b = makeHarness();
    await b.controller.setUp();
    const err = await expectCode(b.controller.ensureRunning(), 'needs-sign-in');
    expect(err.message).toMatch(/Sign in to Claude/);
  });

  it('concurrent threads share one start', async () => {
    const h = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
    await h.controller.setUp();
    await h.controller.stop();
    const before = h.calls().filter((c) => c.startsWith('start ')).length;
    await Promise.all([h.controller.ensureRunning(), h.controller.ensureRunning(), h.controller.ensureRunning()]);
    expect(h.calls().filter((c) => c.startsWith('start ')).length - before).toBe(1);
  });
});

describe('single flight and cancel', () => {
  it('a different operation while one runs is refused, the same one joins', async () => {
    const h = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
    const first = h.controller.setUp();
    const joined = h.controller.setUp();
    await expectCode(h.controller.stop(), 'busy');
    const [a, b] = await Promise.all([first, joined]);
    expect(a.status).toBe('running');
    expect(b.status).toBe('running');
    expect(h.calls().filter((c) => c.startsWith('run --detach'))).toHaveLength(1);
  });

  it('cancel aborts the run and reports it as cancelled, not failed', async () => {
    const h = makeHarness();
    const ac = new AbortController();
    const p = h.controller.setUp({ signal: ac.signal });
    ac.abort();
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LocalDaemonAbortedError);
    expect((await h.controller.snapshot()).lastError).toBeNull();
    expect(h.controller.getBusy()).toBeNull();
  });
});

describe('sign in', () => {
  it('reuses an existing container sign-in without prompting', async () => {
    const signIn = vi.fn();
    const h = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE }, signIn });
    await h.controller.setUp();
    const r = await h.controller.signIn({ onProgress: vi.fn(), onUrl: vi.fn(), onCodePrompt: async () => null });
    expect(r).toEqual({ ok: true });
    expect(signIn).not.toHaveBeenCalled();
  });

  it('runs the in-container flow once, stores the token and writes it to the daemon', async () => {
    const signIn = vi.fn(async () => ({ ok: true as const, token: CLAUDE }));
    const h = makeHarness({ signIn });
    await h.controller.setUp();
    expect((await h.controller.snapshot()).assessment.status).toBe('needs-sign-in');
    const r = await h.controller.signIn({ onProgress: vi.fn(), onUrl: vi.fn(), onCodePrompt: async () => 'code' });
    expect(r).toEqual({ ok: true });
    expect(signIn).toHaveBeenCalledWith(expect.objectContaining({ containerName: h.name, containerBinaryPath: '/opt/claude/.local/bin/claude' }));
    expect(h.claude()).toBe(CLAUDE);
    expect(h.readState().volumes[dataVolumeFor(h.vaultPath)]?.credential).toBe(CLAUDE);
    expect((await h.controller.snapshot()).assessment.status).toBe('running');
    expect(h.calls().join('\n')).not.toContain(CLAUDE);
  });

  it('a failed or cancelled sign-in changes nothing', async () => {
    const h = makeHarness({ signIn: async () => ({ ok: false as const, error: 'Sign-in timed out' }) });
    await h.controller.setUp();
    expect(await h.controller.signIn({ onProgress: vi.fn(), onUrl: vi.fn(), onCodePrompt: async () => null })).toEqual({ ok: false, error: 'Sign-in timed out' });
    expect(h.claude()).toBeUndefined();
    expect((await h.controller.snapshot()).assessment.status).toBe('needs-sign-in');
  });

  it('a keychain failure after sign-in is reported, not swallowed', async () => {
    const h = makeHarness({ signIn: async () => ({ ok: true as const, token: CLAUDE }) });
    await h.controller.setUp();
    h.deps.secrets.set = (() => { throw new Error('locked'); }) as never;
    const r = await h.controller.signIn({ onProgress: vi.fn(), onUrl: vi.fn(), onCodePrompt: async () => 'c' });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/saving the token failed/) });
  });
});

describe('update, reset, remove', () => {
  it('update replaces the container at the plugin version but keeps the volumes and token', async () => {
    const h = makeHarness({ pluginVersion: '0.64.0', secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
    await h.controller.setUp();
    const token = h.token();
    // the plugin updates to 0.65.0
    (h.deps as { pluginVersion: string }).pluginVersion = '0.65.0';
    const snap = await h.controller.snapshot();
    expect(snap.assessment.update).toBe('available');
    expect(snap.assessment.status).toBe('running');
    const a = await h.controller.update();
    expect(h.token()).toBe(token);
    expect(a.update).toBe('none');
    expect(a.status).toBe('running');
    const s = h.readState();
    expect(s.images[localImageRef('0.65.0')]).toBeTruthy();
    expect(s.images[localImageRef('0.64.0')]).toBeUndefined();
    expect(s.containers[h.name]?.labels['com.rbcodelabs.agent-threads.local-daemon.version']).toBe('0.65.0');
    expect(s.volumes[dataVolumeFor(h.vaultPath)]?.credential).toBe(CLAUDE);
  });

  it('update says the image is not published yet and leaves the old daemon running', async () => {
    const h = makeHarness({ pluginVersion: '0.64.0', secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
    await h.controller.setUp();
    (h.deps as { pluginVersion: string }).pluginVersion = '0.65.0';
    h.setFail(['pull:404']);
    await expectCode(h.controller.update(), 'pull-not-found');
    expect(h.readState().containers[h.name]?.state).toBe('running');
    expect((await h.controller.snapshot()).assessment).toMatchObject({ status: 'running', update: 'available' });
  });

  it('reset wipes data and sets up again with a fresh token', async () => {
    const h = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
    await h.controller.setUp();
    const token = h.token();
    const a = await h.controller.reset();
    expect(a.status).toBe('running');
    expect(h.token()).not.toBe(token);
    expect(h.readState().volumes[dataVolumeFor(h.vaultPath)]?.credential).toBe(CLAUDE);
  });

  it('remove deletes container, data, token and registration but keeps the shared Claude sign-in', async () => {
    const h = makeHarness({ secrets: { [CONTAINER_AUTH_TOKEN_SECRET]: CLAUDE } });
    await h.controller.setUp();
    await h.controller.remove();
    const s = h.readState();
    expect(Object.keys(s.containers)).toHaveLength(0);
    expect(Object.keys(s.volumes)).toHaveLength(0);
    expect(h.token()).toBeFalsy();
    expect(h.registered).toBeUndefined();
    expect(h.settings?.enabled).toBe(false);
    expect(h.claude()).toBe(CLAUDE);
    expect((await h.controller.snapshot()).assessment.status).toBe('not-set-up');
  });

  it('remove never deletes a container it did not create', async () => {
    const h = makeHarness({ settings: { enabled: true, port: 7433 } });
    h.writeState({ ...h.readState(), containers: { [h.name]: { state: 'running', labels: {}, hostPort: 1, volumes: [], env: [], cmd: [], publish: '' } } });
    await h.controller.remove();
    expect(h.readState().containers[h.name]).toBeTruthy();
  });
});

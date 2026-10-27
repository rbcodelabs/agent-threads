/**
 * Managed policy for daemons: registry connections, secret push, skills sync, MCP sync availability, and the
 * local-daemon controller. A disallowed daemon is never contacted; nothing is deleted or rewritten.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DaemonRegistry } from '../../src/remote/DaemonRegistry';
import { RemoteSecretPush, type PushClient } from '../../src/remote/secretPush';
import { RemoteSkillsSync } from '../../src/remote/skillsSync';
import { McpSyncEngine } from '../../src/remote/mcpSync';
import { daemonUseDenial, type ThreadExecutionPolicy } from '../../src/managedPolicy';
import { LocalDaemonError } from '../../src/localDaemon/provision';
import { LOCAL_DAEMON_ID } from '../../src/localDaemon/spec';
import { makeHarness } from '../helpers/localDaemonHarness';
import { CONTAINER_AUTH_TOKEN_SECRET } from '../../src/claudeContainerAuthCli';
import type { RemoteDaemonConfig } from '../../src/types';

const policy = (te: Record<string, unknown>): ThreadExecutionPolicy => ({
  machine: { enabled: true }, localDaemon: { enabled: true }, remoteDaemon: { enabled: true }, ...te,
}) as ThreadExecutionPolicy;

const remote = (over: Partial<RemoteDaemonConfig> = {}): RemoteDaemonConfig => ({
  id: 'homelab', name: 'Homelab', url: 'wss://threads.corp.example:8443', tokenSecretName: 'tok', pushedSecrets: ['GH_TOKEN'], ...over,
});
const local = (): RemoteDaemonConfig => ({
  id: LOCAL_DAEMON_ID, name: 'This Mac', url: 'ws://127.0.0.1:7433', tokenSecretName: 'tok2', managed: 'local-container',
});

const denial = (p: ThreadExecutionPolicy | undefined) => (d: RemoteDaemonConfig): string | undefined =>
  daemonUseDenial(p, d.managed === 'local-container' && d.id === LOCAL_DAEMON_ID ? { kind: 'localDaemon' } : { kind: 'remoteDaemon', url: d.url });

describe('daemonUseDenial', () => {
  it('is undefined with no policy', () => {
    expect(daemonUseDenial(undefined, { kind: 'remoteDaemon', url: 'ws://x:1' })).toBeUndefined();
  });
  it('names the cause', () => {
    expect(daemonUseDenial(policy({ remoteDaemon: { enabled: false } }), { kind: 'remoteDaemon', url: 'wss://a:1' })).toMatch(/remote daemons is disabled/);
    expect(daemonUseDenial(policy({ localDaemon: { enabled: false } }), { kind: 'localDaemon' })).toMatch(/local daemon is disabled/);
    expect(daemonUseDenial(policy({ remoteDaemon: { enabled: true, hosts: ['wss://ok:1'] } }), { kind: 'remoteDaemon', url: 'wss://bad:1' })).toMatch(/list of hosts/);
    expect(daemonUseDenial(policy({ remoteDaemon: { enabled: true, hosts: [] } }), { kind: 'remoteDaemon', url: 'wss://bad:1' })).toMatch(/not allowed any remote daemon host/);
    expect(daemonUseDenial(policy({ localDaemon: { enabled: true, harnesses: [] } }), { kind: 'localDaemon' })).toMatch(/not available/);
  });
  it('machine disabled does not block daemons', () => {
    expect(daemonUseDenial(policy({ machine: { enabled: false } }), { kind: 'localDaemon' })).toBeUndefined();
    expect(daemonUseDenial(policy({ machine: { enabled: false } }), { kind: 'remoteDaemon', url: 'wss://a:1' })).toBeUndefined();
  });
});

describe('DaemonRegistry', () => {
  function registry(p: ThreadExecutionPolicy | undefined, daemons: RemoteDaemonConfig[]) {
    const createSocket = vi.fn();
    const r = new DaemonRegistry({
      getDaemons: () => daemons, getToken: () => 'tok', createSocket: createSocket as never, clientVersion: '1.0.0',
      policy: { peek: () => p }, localDaemonId: LOCAL_DAEMON_ID,
    });
    return { r, createSocket };
  }

  it('hands out no client (so nothing can connect) for a disallowed remote daemon', () => {
    const { r } = registry(policy({ remoteDaemon: { enabled: false } }), [remote()]);
    expect(r.clientFor('homelab')).toBeUndefined();
    expect(r.stateOf('homelab')).toBeUndefined();
  });

  it('refuses a host that is not on the list, allows the listed one (exact origin)', () => {
    const p = policy({ remoteDaemon: { enabled: true, hosts: ['wss://threads.corp.example:8443'] } });
    const { r } = registry(p, [remote(), remote({ id: 'other', url: 'wss://threads.corp.example:9999' }), remote({ id: 'tricky', url: 'wss://threads.corp.example:8443@evil.test' })]);
    expect(r.clientFor('homelab')).toBeDefined();
    expect(r.clientFor('other')).toBeUndefined();
    expect(r.clientFor('tricky')).toBeUndefined();
  });

  it('classifies the managed container as the local daemon, anything else as remote', () => {
    const { r } = registry(undefined, [local(), remote(), remote({ id: LOCAL_DAEMON_ID + '-x', url: 'ws://127.0.0.1:1', managed: 'local-container' })]);
    expect(r.targetOf(LOCAL_DAEMON_ID)?.kind).toBe('localDaemon');
    expect(r.targetOf('homelab')?.kind).toBe('remoteDaemon');
    expect(r.targetOf(LOCAL_DAEMON_ID + '-x')?.kind).toBe('remoteDaemon');
    expect(r.targetOf('missing')).toBeUndefined();
  });

  it('remote off still allows the local daemon, local off still allows remote', () => {
    const { r: a } = registry(policy({ remoteDaemon: { enabled: false } }), [local()]);
    expect(a.clientFor(LOCAL_DAEMON_ID)).toBeDefined();
    const { r: b } = registry(policy({ localDaemon: { enabled: false } }), [local(), remote()]);
    expect(b.clientFor(LOCAL_DAEMON_ID)).toBeUndefined();
    expect(b.clientFor('homelab')).toBeDefined();
  });

  it('does not tear down an existing connection mid-run when policy tightens', () => {
    let p: ThreadExecutionPolicy | undefined = undefined;
    const r = new DaemonRegistry({
      getDaemons: () => [remote()], getToken: () => 'tok', createSocket: vi.fn() as never, clientVersion: '1.0.0',
      policy: { peek: () => p }, localDaemonId: LOCAL_DAEMON_ID,
    });
    const client = r.clientFor('homelab');
    expect(client).toBeDefined();
    p = policy({ remoteDaemon: { enabled: false } });
    expect(r.clientFor('homelab')).toBeUndefined();
    // relaxing returns the SAME client: nothing was disposed or rewritten
    p = undefined;
    expect(r.clientFor('homelab')).toBe(client);
  });
});

describe('RemoteSecretPush', () => {
  function rig(p: ThreadExecutionPolicy | undefined) {
    const createClient = vi.fn((): PushClient => ({ command: vi.fn(async () => ({})), dispose: vi.fn() }) as never);
    const push = new RemoteSecretPush({
      daemons: () => [remote()], adminToken: () => 'atd_admin', resolveEnv: () => ({ GH_TOKEN: 'ghp_secretvalue0123456789abcdef' }), createClient, policyDenial: denial(p),
    });
    return { push, createClient };
  }

  it('prepare sends nothing and opens no admin connection for a disallowed daemon', async () => {
    const { push, createClient } = rig(policy({ remoteDaemon: { enabled: false } }));
    const prep = await push.prepare('homelab', undefined);
    expect(createClient).not.toHaveBeenCalled();
    expect(prep.envKind).toBeUndefined();
    expect(prep.warnings[0]).toMatch(/not sent.*disabled by your administrator/);
  });

  it('prepare refuses a daemon off the host list', async () => {
    const { push, createClient } = rig(policy({ remoteDaemon: { enabled: true, hosts: ['wss://elsewhere:1'] } }));
    await push.prepare('homelab', undefined);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('reconcile and stop never contact a disallowed daemon', async () => {
    const { push, createClient } = rig(policy({ remoteDaemon: { enabled: false } }));
    await push.reconcile();
    await push.stop();
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe('RemoteSkillsSync', () => {
  it('syncs nothing and creates no client for a disallowed daemon', async () => {
    const createClient = vi.fn();
    const sync = new RemoteSkillsSync({
      resolver: { nameOf: () => 'Homelab' }, adminToken: () => 'atd_admin', createClient: createClient as never,
      skillPlugins: () => [{ path: '/vault/skills/a' }], fs: {} as never, sha256: () => createHash('sha256'),
      policyDenial: denial(policy({ remoteDaemon: { enabled: false } })),
    });
    const result = await sync.prepare(remote({ skillsSync: 'auto' }));
    expect(createClient).not.toHaveBeenCalled();
    expect(result.pluginPaths).toEqual([]);
    expect(result.notices[0]).toMatch(/Skills not synced to Homelab.*administrator/);
  });
});

describe('McpSyncEngine availability', () => {
  it('reports a policy reason and never asks for a transport', async () => {
    const d = remote({ mcpSync: { srv: { enabled: true } } });
    const transportFor = vi.fn();
    const engine = new McpSyncEngine({
      daemons: () => [d], settings: () => ({ mcpServers: { srv: { type: 'http', url: 'https://x.example/mcp' } } }), readSecret: () => undefined,
      capabilitiesOf: () => ['mcp.sync'], transportFor: transportFor as never, saveSettings: async () => undefined,
      policyDenial: denial(policy({ remoteDaemon: { enabled: false } })),
    });
    expect(engine.availability('homelab')).toMatchObject({ ok: false, code: 'policy' });
    await engine.sync('homelab', 'force');
    await engine.probeAdmin('homelab');
    expect(transportFor).not.toHaveBeenCalled();
  });
});

describe('local daemon controller', () => {
  const secrets = { [CONTAINER_AUTH_TOKEN_SECRET]: 'sk-ant-oat01-TEST' };

  async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
    const err = await p.then(() => null, (e: unknown) => e);
    return err instanceof LocalDaemonError ? err.code : undefined;
  }

  it('set up, start, restart, update, reset and ensureRunning are refused before any container command runs', async () => {
    const h = makeHarness({ secrets });
    h.deps.policyDenial = () => 'Running threads on the local daemon is disabled by your administrator.';
    for (const op of [() => h.controller.setUp(), () => h.controller.start(), () => h.controller.restart(), () => h.controller.update(), () => h.controller.reset(), () => h.controller.ensureRunning()]) {
      expect(await codeOf(op())).toBe('policy');
    }
    expect(h.calls()).toEqual([]);
    expect(h.registered).toBeUndefined();
    expect(h.settings).toBeUndefined();
  });

  it('an existing container is left exactly as it is: not started, not attached, not deleted, settings untouched', async () => {
    const h = makeHarness({ secrets });
    await h.controller.setUp();
    await h.controller.stop();
    const stateBefore = JSON.stringify(h.readState().containers);
    const settingsBefore = JSON.stringify(h.settings);
    const registeredBefore = JSON.stringify(h.registered);
    const callsBefore = h.calls().length;
    h.deps.policyDenial = () => 'Running threads on the local daemon is disabled by your administrator.';

    expect(await codeOf(h.controller.ensureRunning())).toBe('policy');
    expect(await codeOf(h.controller.start())).toBe('policy');

    expect(h.calls().length).toBe(callsBefore);
    expect(JSON.stringify(h.readState().containers)).toBe(stateBefore);
    expect(Object.values(h.readState().containers).every((c) => c.state === 'stopped')).toBe(true);
    expect(JSON.stringify(h.settings)).toBe(settingsBefore);
    expect(JSON.stringify(h.registered)).toBe(registeredBefore);
  });

  it('relaxing the policy resumes with no other action', async () => {
    const h = makeHarness({ secrets });
    await h.controller.setUp();
    await h.controller.stop();
    let deny: string | undefined = 'disabled by your administrator';
    h.deps.policyDenial = () => deny;
    expect(await codeOf(h.controller.start())).toBe('policy');
    deny = undefined;
    const a = await h.controller.start();
    expect(a.status).toBe('running');
  });

  it('stop and remove stay available while policy forbids the local daemon', async () => {
    const h = makeHarness({ secrets });
    await h.controller.setUp();
    h.deps.policyDenial = () => 'disabled by your administrator';
    await h.controller.stop();
    expect(Object.values(h.readState().containers).every((c) => c.state === 'stopped')).toBe(true);
    await h.controller.remove({ removeData: true });
    expect(Object.keys(h.readState().containers)).toHaveLength(0);
  });

  it('no policy dependency: behaves as before', async () => {
    const h = makeHarness({ secrets });
    expect((await h.controller.setUp()).status).toBe('running');
  });
});

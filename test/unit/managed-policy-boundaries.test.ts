/**
 * Managed `threadExecution` policy at the REAL choke points: HarnessFactory.createHarnessSession,
 * ThreadManager.sendMessage / resumeRemoteTurns / switchHarness / moveThreadExecution / createRemoteThread.
 * A fake policy source denies one thing at a time; the assertions are that nothing was constructed, spawned,
 * connected or pushed, and that the thread is untouched.
 */
import os from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadExecutionPolicy, ManagedPolicySource, PolicyTarget } from '../../src/managedPolicy';
import { ManagedPolicyError } from '../../src/managedPolicy';
import { DEFAULT_SETTINGS, type Thread } from '../../src/types';

const spawned = vi.hoisted(() => ({ created: [] as string[], started: 0 }));

vi.mock('../../src/ThreadSession', () => ({ ThreadSession: class { constructor() { spawned.created.push('claude'); } } }));
vi.mock('../../src/CodexSession', () => ({ CodexSession: class { constructor() { spawned.created.push('codex'); } } }));
vi.mock('../../src/OpenCodeSession', () => ({ OpenCodeSession: class { constructor() { spawned.created.push('opencode'); } } }));
vi.mock('../../src/ReplaySession', () => ({ ReplaySession: class {}, parseReplayScript: () => ({}) }));
vi.mock('../../src/remote/RemoteHarnessSession', () => ({ RemoteHarnessSession: class { constructor() { spawned.created.push('remote'); } } }));

// Each created session needs the surface sendMessage touches. Patch the prototype methods onto the mocks above.
const sessionSurface = {
  turnInFlight: false,
  cwd: undefined as string | undefined,
  async start() { spawned.started++; },
  send() { /* a prompt would go to the model here */ },
  async prepareForSend() { /* */ },
  async setModel() { /* */ },
  async setPermissionMode() { /* */ },
  close() { /* */ },
  async interrupt() { /* */ },
  async getContextUsage() { return null; },
  async getUsageSnapshot() { return null; },
};

const { createHarnessSession } = await import('../../src/HarnessFactory');
const { ThreadSession } = await import('../../src/ThreadSession');
const { CodexSession } = await import('../../src/CodexSession');
const { OpenCodeSession } = await import('../../src/OpenCodeSession');
const { RemoteHarnessSession } = await import('../../src/remote/RemoteHarnessSession');
for (const klass of [ThreadSession, CodexSession, OpenCodeSession, RemoteHarnessSession]) Object.assign(klass.prototype, sessionSurface);
const { ThreadManager } = await import('../../src/ThreadManager');

// ── fixtures ────────────────────────────────────────────────────────────────

/** Shapes as Geode's `effective.threadExecution` delivers them. */
const policy = (te: Record<string, unknown>): ThreadExecutionPolicy => ({
  machine: { enabled: true }, localDaemon: { enabled: true }, remoteDaemon: { enabled: true },
  hostExec: { enabled: true, allowAlways: true }, mobileRemoteAccess: true,
  ...te,
}) as ThreadExecutionPolicy;

function fakeSource(initial: ThreadExecutionPolicy | undefined) {
  let current = initial;
  const reads = vi.fn(async () => current);
  const source: ManagedPolicySource & { set(p: ThreadExecutionPolicy | undefined): void; reads: typeof reads } = {
    read: reads,
    peek: () => current,
    subscribe: () => () => undefined,
    set: (p) => { current = p; },
    reads,
  };
  return source;
}

function fakeDaemons(url = 'wss://threads.corp.example:8443') {
  const clientFor = vi.fn(() => ({}) as never);
  const targets: Record<string, PolicyTarget> = {
    'this-mac-container': { kind: 'localDaemon', url: 'ws://127.0.0.1:7433' },
    homelab: { kind: 'remoteDaemon', url },
  };
  return {
    resolver: {
      clientFor,
      nameOf: (id: string) => id,
      targetOf: (id: string) => targets[id],
      capabilitiesOf: () => undefined,
    },
    clientFor,
  };
}

const localThread = (over: Partial<Thread> = {}): Thread => ({
  id: 't-local', title: 'Local', cwd: os.tmpdir(), messages: [], createdAt: 1, updatedAt: 1, status: 'waiting', agentHarness: 'claude', ...over,
});
const remoteThread = (daemonId: string, over: Partial<Thread> = {}): Thread => ({
  ...localThread({ id: `t-${daemonId}`, agentHarness: 'claude' }),
  remote: { daemonId, ownership: 'client', remoteCwd: '/srv/w', lastSeq: 0, ownerClientId: 'c' },
  ...over,
});

beforeEach(() => { spawned.created.length = 0; spawned.started = 0; });

// ── createHarnessSession: the last-resort synchronous guard ──────────────────

describe('createHarnessSession with a launch policy', () => {
  const settings = DEFAULT_SETTINGS;

  it('constructs nothing for a machine thread when machine is disabled', () => {
    const p = policy({ machine: { enabled: false } });
    expect(() => createHarnessSession(localThread(), settings, undefined, undefined, {}, { policy: p })).toThrow(ManagedPolicyError);
    expect(spawned.created).toEqual([]);
  });

  it.each(['claude', 'codex', 'opencode'] as const)('constructs nothing for %s when the harness list excludes it', (harness) => {
    const allowedOthers = (['claude', 'codex', 'opencode'] as const).filter((h) => h !== harness);
    const p = policy({ harnesses: allowedOthers });
    expect(() => createHarnessSession(localThread({ agentHarness: harness }), settings, undefined, undefined, {}, { policy: p })).toThrow(/administrator/);
    expect(spawned.created).toEqual([]);
  });

  it('intersects the global and the per-target lists', () => {
    const p = policy({ harnesses: ['claude', 'codex'], machine: { enabled: true, harnesses: ['codex'] } });
    expect(() => createHarnessSession(localThread({ agentHarness: 'claude' }), settings, undefined, undefined, {}, { policy: p })).toThrow(ManagedPolicyError);
    createHarnessSession(localThread({ agentHarness: 'codex' }), settings, undefined, undefined, {}, { policy: p });
    expect(spawned.created).toEqual(['codex']);
  });

  it('creates no client for a remote thread when remote daemons are disabled', () => {
    const { resolver, clientFor } = fakeDaemons();
    const p = policy({ remoteDaemon: { enabled: false } });
    expect(() => createHarnessSession(remoteThread('homelab'), settings, resolver as never, undefined, {}, { policy: p })).toThrow(/remote daemons is disabled/);
    expect(clientFor).not.toHaveBeenCalled();
    expect(spawned.created).toEqual([]);
  });

  it('refuses a remote daemon whose origin is not on the hosts list, and never asks for its client', () => {
    const { resolver, clientFor } = fakeDaemons('wss://evil.example:8443');
    const p = policy({ remoteDaemon: { enabled: true, hosts: ['wss://threads.corp.example:8443'] } });
    expect(() => createHarnessSession(remoteThread('homelab'), settings, resolver as never, undefined, {}, { policy: p })).toThrow(/list of hosts/);
    expect(clientFor).not.toHaveBeenCalled();
  });

  it('machine off + localDaemon on: the container thread starts, the host thread does not', () => {
    const { resolver } = fakeDaemons();
    const p = policy({ machine: { enabled: false } });
    createHarnessSession(remoteThread('this-mac-container'), settings, resolver as never, undefined, {}, { policy: p });
    expect(spawned.created).toEqual(['remote']);
    expect(() => createHarnessSession(localThread(), settings, resolver as never, undefined, {}, { policy: p })).toThrow(ManagedPolicyError);
  });

  it('with no launch policy argument (daemon, tests) nothing changes', () => {
    createHarnessSession(localThread(), settings, undefined, undefined, {});
    expect(spawned.created).toEqual(['claude']);
  });
});

// ── ThreadManager.sendMessage ────────────────────────────────────────────────

describe('ThreadManager.sendMessage reads policy fresh and refuses first', () => {
  function build(thread: Thread, source: ManagedPolicySource | undefined, daemons = fakeDaemons()) {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    manager.loadThreads([thread]);
    manager.remoteDaemons = daemons.resolver as never;
    if (source) manager.managedPolicy = source;
    const beforeRemoteSend = vi.fn(async () => undefined);
    manager.beforeRemoteSend = beforeRemoteSend;
    return { manager, beforeRemoteSend, ...daemons };
  }

  it('refuses a machine thread: no session, no transcript entry, status untouched', async () => {
    const thread = localThread();
    const { manager } = build(thread, fakeSource(policy({ machine: { enabled: false } })));
    await expect(manager.sendMessage(thread.id, 'hi')).rejects.toThrow(/this computer is disabled by your administrator/);
    expect(spawned.created).toEqual([]);
    expect(thread.messages).toEqual([]);
    expect(thread.status).toBe('waiting');
  });

  it('says the whole product is disabled when the effective set is empty', async () => {
    const thread = localThread();
    const { manager } = build(thread, fakeSource(policy({ machine: { enabled: false }, localDaemon: { enabled: false }, remoteDaemon: { enabled: false } })));
    await expect(manager.sendMessage(thread.id, 'hi')).rejects.toThrow('Claude Threads is disabled by your administrator.');
  });

  it('refuses BEFORE beforeRemoteSend: no daemon start, secret push, MCP or skills sync, no client', async () => {
    const thread = remoteThread('homelab');
    const { manager, beforeRemoteSend, clientFor } = build(thread, fakeSource(policy({ remoteDaemon: { enabled: false } })));
    await expect(manager.sendMessage(thread.id, 'hi')).rejects.toThrow(ManagedPolicyError);
    expect(beforeRemoteSend).not.toHaveBeenCalled();
    expect(clientFor).not.toHaveBeenCalled();
    expect(spawned.created).toEqual([]);
  });

  it('refuses the local daemon thread before beforeRemoteSend when localDaemon is off', async () => {
    const thread = remoteThread('this-mac-container');
    const { manager, beforeRemoteSend } = build(thread, fakeSource(policy({ localDaemon: { enabled: false } })));
    await expect(manager.sendMessage(thread.id, 'hi')).rejects.toThrow(/local daemon is disabled/);
    expect(beforeRemoteSend).not.toHaveBeenCalled();
  });

  it('refuses a disallowed harness on a remote daemon', async () => {
    const thread = remoteThread('homelab', { agentHarness: 'opencode' });
    const { manager, beforeRemoteSend } = build(thread, fakeSource(policy({ remoteDaemon: { enabled: true, harnesses: ['claude', 'codex'] } })));
    await expect(manager.sendMessage(thread.id, 'hi')).rejects.toThrow(/OpenCode is not allowed/);
    expect(beforeRemoteSend).not.toHaveBeenCalled();
  });

  it('allows what policy allows, and evaluates FRESH each time (relax, then tighten)', async () => {
    const thread = localThread();
    const source = fakeSource(policy({ machine: { enabled: false } }));
    const { manager } = build(thread, source);
    await expect(manager.sendMessage(thread.id, 'one')).rejects.toThrow(ManagedPolicyError);
    source.set(policy({}));
    await manager.sendMessage(thread.id, 'two');
    expect(spawned.created).toEqual(['claude']);
    expect(thread.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['two']);
    // Tighten again while the session is live: the running thread is not killed, but the NEXT send is refused.
    source.set(policy({ machine: { enabled: false } }));
    await expect(manager.sendMessage(thread.id, 'three')).rejects.toThrow(ManagedPolicyError);
    expect(thread.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['two']);
    expect(source.reads).toHaveBeenCalledTimes(3);
  });

  it('is unrestricted when the host has no policy source or the source reports none', async () => {
    const a = localThread({ id: 'a' });
    await build(a, undefined).manager.sendMessage('a', 'x');
    const b = localThread({ id: 'b' });
    await build(b, fakeSource(undefined)).manager.sendMessage('b', 'x');
    expect(spawned.created).toEqual(['claude', 'claude']);
  });
});

// ── resume ───────────────────────────────────────────────────────────────────

describe('ThreadManager.resumeRemoteTurns', () => {
  const pending = (daemonId: string): Thread => {
    const t = remoteThread(daemonId);
    t.remote!.turnPending = true;
    return t;
  };

  it('does not attach a turn on a disallowed daemon and keeps it pending for later', () => {
    const t = pending('homelab');
    const { resolver, clientFor } = fakeDaemons();
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    manager.remoteDaemons = resolver as never;
    manager.loadThreads([t]);
    expect(manager.resumeRemoteTurns({ policy: policy({ remoteDaemon: { enabled: false } }) })).toEqual([]);
    expect(clientFor).not.toHaveBeenCalled();
    expect(t.remote!.turnPending).toBe(true);
    expect(spawned.created).toEqual([]);
  });

  it('attaches when policy allows', () => {
    const t = pending('homelab');
    const { resolver } = fakeDaemons();
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    manager.remoteDaemons = resolver as never;
    manager.loadThreads([t]);
    expect(manager.resumeRemoteTurns({ policy: policy({}) })).toEqual([t.id]);
  });

  it('falls back to the manager source snapshot when no policy is passed', () => {
    const t = pending('homelab');
    const { resolver } = fakeDaemons();
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    manager.remoteDaemons = resolver as never;
    manager.managedPolicy = fakeSource(policy({ remoteDaemon: { enabled: false } }));
    manager.loadThreads([t]);
    expect(manager.resumeRemoteTurns()).toEqual([]);
  });
});

// ── switchHarness / moveThreadExecution / createRemoteThread ─────────────────

describe('switchHarness, moveThreadExecution and createRemoteThread', () => {
  function build(thread: Thread, p: ThreadExecutionPolicy) {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    const { resolver } = fakeDaemons();
    manager.remoteDaemons = resolver as never;
    manager.managedPolicy = fakeSource(p);
    manager.loadThreads([thread]);
    return manager;
  }

  it('switchHarness refuses a harness the policy removed where the thread runs, before persisting anything', async () => {
    const thread = localThread();
    const manager = build(thread, policy({ harnesses: ['claude'] }));
    const persist = vi.fn(async () => undefined);
    await expect(manager.switchHarness(thread.id, 'codex', persist)).rejects.toThrow(/Codex is not allowed/);
    expect(persist).not.toHaveBeenCalled();
    expect(thread.agentHarness).toBe('claude');
    expect(thread.pendingHarnessHandoff).toBeUndefined();
  });

  it('switchHarness is judged on the thread\'s own target (a remote thread uses the remote list)', async () => {
    const thread = remoteThread('homelab');
    const manager = build(thread, policy({ remoteDaemon: { enabled: true, harnesses: ['claude'] }, machine: { enabled: true, harnesses: ['claude', 'codex'] } }));
    await expect(manager.switchHarness(thread.id, 'codex', async () => undefined)).rejects.toThrow(ManagedPolicyError);
  });

  it('moveThreadExecution to this computer is refused when machine is disabled; the thread stays put', async () => {
    const thread = remoteThread('this-mac-container');
    const manager = build(thread, policy({ machine: { enabled: false } }));
    const persist = vi.fn(async () => undefined);
    await expect(manager.moveThreadExecution(thread.id, { kind: 'host', cwd: '/x' }, persist)).rejects.toThrow(/this computer is disabled/);
    expect(persist).not.toHaveBeenCalled();
    expect(thread.remote?.daemonId).toBe('this-mac-container');
  });

  it('moveThreadExecution to a remote daemon is refused when remote daemons are off or the host is not allowed', async () => {
    for (const p of [policy({ remoteDaemon: { enabled: false } }), policy({ remoteDaemon: { enabled: true, hosts: ['wss://other.example:1'] } })]) {
      const thread = localThread();
      const manager = build(thread, p);
      const persist = vi.fn(async () => undefined);
      await expect(manager.moveThreadExecution(thread.id, { kind: 'daemon', daemonId: 'homelab', remoteCwd: '/srv', clientId: 'c' }, persist)).rejects.toThrow(ManagedPolicyError);
      expect(persist).not.toHaveBeenCalled();
      expect(thread.remote).toBeUndefined();
    }
  });

  it('moveThreadExecution to the local daemon works when only the machine is off', async () => {
    const thread = localThread();
    const manager = build(thread, policy({ machine: { enabled: false } }));
    const persist = vi.fn(async () => undefined);
    await manager.moveThreadExecution(thread.id, { kind: 'daemon', daemonId: 'this-mac-container', remoteCwd: '/vault', clientId: 'c' }, persist);
    expect(persist).toHaveBeenCalled();
    expect(thread.remote?.daemonId).toBe('this-mac-container');
  });

  it('createRemoteThread refuses (from the last snapshot) a disallowed daemon or harness', () => {
    const manager = build(localThread(), policy({ remoteDaemon: { enabled: true, harnesses: ['claude'] } }));
    expect(() => manager.createRemoteThread('t', { daemonId: 'homelab', remoteCwd: '/s', clientId: 'c', agentHarness: 'codex' })).toThrow(/Codex is not allowed/);
    expect(manager.getThreads().filter((t) => t.remote)).toHaveLength(0);
    expect(manager.createRemoteThread('t', { daemonId: 'homelab', remoteCwd: '/s', clientId: 'c', agentHarness: 'claude' }).remote?.daemonId).toBe('homelab');
  });

  it('checkLaunch / assertLaunchAllowedNow read fresh', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    const source = fakeSource(policy({ machine: { enabled: false } }));
    manager.managedPolicy = source;
    expect((await manager.checkLaunch({ kind: 'machine' }, 'claude')).allowed).toBe(false);
    source.set(undefined);
    expect((await manager.checkLaunch({ kind: 'machine' }, 'claude')).allowed).toBe(true);
    await expect(manager.assertLaunchAllowedNow({ kind: 'machine' }, 'claude')).resolves.toBeUndefined();
  });
});

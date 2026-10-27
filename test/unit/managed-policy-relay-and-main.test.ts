/**
 * Managed policy at the plugin boundary: the desktop RelayClient (mobileRemoteAccess), main.ts dispatchNewThread /
 * initDesktopRelayClient / agent-created threads / scheduled threads, the summarizer and constrained-run guards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ClaudeThreadsPlugin from '../../src/main';
import { RelayClient } from '../../src/RelayClient';
import { Scheduler } from '../../src/Scheduler';
import { InProcessSummarizer } from '../../src/InProcessSummarizer';
import { createConstrainedQueryRunner } from '../../src/ConstrainedRun';
import { ManagedPolicyError, type ManagedPolicySource, type ThreadExecutionPolicy } from '../../src/managedPolicy';
import { DEFAULT_SETTINGS } from '../../src/types';

const policy = (te: Record<string, unknown>): ThreadExecutionPolicy => ({
  machine: { enabled: true }, localDaemon: { enabled: true }, remoteDaemon: { enabled: true },
  hostExec: { enabled: true, allowAlways: true }, mobileRemoteAccess: true, ...te,
}) as ThreadExecutionPolicy;

function source(initial: ThreadExecutionPolicy | undefined) {
  let current = initial;
  const s: ManagedPolicySource & { set(p: ThreadExecutionPolicy | undefined): void } = {
    read: vi.fn(async () => current), peek: () => current, subscribe: () => () => undefined, set: (p) => { current = p; },
  };
  return s;
}

/** A WebSocket stand-in that records every construction. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  closed: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Array<(e: unknown) => void>>();
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  addEventListener(type: string, fn: (e: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  emit(type: string, event: unknown = {}) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
  send() { /* */ }
  close(code?: number, reason?: string) { this.closed = { code, reason }; this.readyState = 3; this.emit('close'); }
}

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe('desktop RelayClient and mobileRemoteAccess', () => {
  beforeEach(() => { FakeWebSocket.instances = []; vi.stubGlobal('WebSocket', FakeWebSocket); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const manager = () => ({
    sendMessage: vi.fn(async () => undefined),
    createThread: vi.fn(() => ({ id: 'new' })),
    assertLaunchAllowedNow: vi.fn(async () => undefined),
    defaultHarness: () => 'claude',
    getThreads: () => [],
    getThread: () => undefined,
    subscribe: () => () => undefined,
  });

  it('opens no connection at all while mobileRemoteAccess is false', async () => {
    const client = new RelayClient('desktop', 'wss://relay.example', 'room', manager() as never, source(policy({ mobileRemoteAccess: false })));
    client.connect();
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(0);
    client.disconnect();
  });

  it('keeps retrying quietly and connects as soon as the policy is relaxed (pairing state is never touched)', async () => {
    const src = source(policy({ mobileRemoteAccess: false }));
    const client = new RelayClient('desktop', 'wss://relay.example', 'room', manager() as never, src);
    client.connect();
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(0);
    src.set(policy({ mobileRemoteAccess: true }));
    await vi.advanceTimersByTimeAsync(31_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    client.disconnect();
  });

  it('a live policy change disconnects an open relay', async () => {
    const src = source(policy({}));
    const client = new RelayClient('desktop', 'wss://relay.example', 'room', manager() as never, src);
    client.connect();
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    src.set(policy({ mobileRemoteAccess: false }));
    await vi.advanceTimersByTimeAsync(16_000);
    expect(FakeWebSocket.instances[0].closed?.reason).toMatch(/managed policy/);
    // and it does not reconnect while forbidden
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    client.disconnect();
  });

  it('a phone command that arrives after the policy turned off is not executed', async () => {
    const src = source(policy({}));
    const m = manager();
    const client = new RelayClient('desktop', 'wss://relay.example', 'room', m as never, src);
    client.connect();
    await flush();
    const ws = FakeWebSocket.instances[0];
    src.set(policy({ mobileRemoteAccess: false }));
    ws.emit('message', { data: JSON.stringify({ type: 'send_message', threadId: 't', text: 'rm everything' }) });
    await flush();
    expect(m.sendMessage).not.toHaveBeenCalled();
    expect(ws.closed).not.toBeNull();
    client.disconnect();
  });

  it('create_thread from a phone goes through the machine/default-harness policy check and creates nothing when refused', async () => {
    const src = source(policy({}));
    const m = manager();
    m.assertLaunchAllowedNow = vi.fn(async () => { throw new ManagedPolicyError('target-disabled', 'Running threads on this computer is disabled by your administrator.'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new RelayClient('desktop', 'wss://relay.example', 'room', m as never, src);
    client.connect();
    await flush();
    FakeWebSocket.instances[0].emit('message', { data: JSON.stringify({ type: 'create_thread', title: 'x', cwd: '/y' }) });
    await flush();
    expect(m.assertLaunchAllowedNow).toHaveBeenCalledWith({ kind: 'machine' }, 'claude');
    expect(m.createThread).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    client.disconnect();
  });

  it('create_thread is created when allowed', async () => {
    const m = manager();
    const client = new RelayClient('desktop', 'wss://relay.example', 'room', m as never, source(policy({})));
    client.connect();
    await flush();
    FakeWebSocket.instances[0].emit('message', { data: JSON.stringify({ type: 'create_thread', title: 'x', cwd: '/y' }) });
    await flush();
    expect(m.createThread).toHaveBeenCalledWith('x', '/y');
    client.disconnect();
  });

  it('without a policy source the connection is opened synchronously, as before', () => {
    const client = new RelayClient('desktop', 'wss://relay.example', 'room', manager() as never);
    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    client.disconnect();
  });

  it('mobile mode is never policed', () => {
    const client = new RelayClient('mobile', 'wss://relay.example', 'room', undefined, source(policy({ mobileRemoteAccess: false })));
    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    client.disconnect();
  });
});

describe('main.ts initDesktopRelayClient', () => {
  beforeEach(() => { FakeWebSocket.instances = []; vi.stubGlobal('WebSocket', FakeWebSocket); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function fakePlugin(src: ManagedPolicySource, extra: Record<string, unknown> = {}) {
    return {
      settings: { ...DEFAULT_SETTINGS, remoteAccess: { enabled: true, roomId: 'r', relayUrl: 'wss://relay.example', pairingExpiresAt: null, devices: [{ id: 'phone' }] } },
      manager: { subscribe: () => () => undefined, getThreads: () => [], getThread: () => undefined },
      managedPolicy: src,
      relayClient: null,
      register: vi.fn(),
      saveSettings: vi.fn(async () => undefined),
      ...extra,
    };
  }

  it('creates the client but opens no WebSocket when policy forbids it, and leaves paired-device state alone', async () => {
    const plugin = fakePlugin(source(policy({ mobileRemoteAccess: false })));
    const before = JSON.stringify(plugin.settings.remoteAccess);
    ClaudeThreadsPlugin.prototype.initDesktopRelayClient.call(plugin);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(JSON.stringify(plugin.settings.remoteAccess)).toBe(before);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    (plugin.relayClient as unknown as RelayClient).disconnect();
  });

  it('opens it when allowed', async () => {
    const plugin = fakePlugin(source(policy({})));
    ClaudeThreadsPlugin.prototype.initDesktopRelayClient.call(plugin);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    (plugin.relayClient as unknown as RelayClient).disconnect();
  });
});

describe('main.ts dispatchNewThread', () => {
  function harness(p: ThreadExecutionPolicy | undefined, daemons: Record<string, { kind: string; url?: string }> = {}) {
    const src = source(p);
    const manager = {
      managedPolicy: src,
      policyTargetFor: (id?: string) => (id === undefined ? { kind: 'machine' } : daemons[id] ?? { kind: 'remoteDaemon' }),
      assertLaunchAllowedNow: vi.fn(async (target: never, harness: never) => {
        const { assertLaunchAllowed } = await import('../../src/managedPolicy');
        assertLaunchAllowed(await src.read(), target, harness);
      }),
      getProject: vi.fn(),
      getProjectCwd: vi.fn(),
      createThread: vi.fn(() => ({ id: 'thread', cwd: '/x' })),
      createRemoteThread: vi.fn(() => ({ id: 'rthread', cwd: '/s' })),
      setThreadModel: vi.fn(), setThreadPermissionMode: vi.fn(), setThreadGoal: vi.fn(), commitThreadGoal: vi.fn(),
      sendMessage: vi.fn(async () => undefined),
    };
    const scheduler = { createItem: vi.fn(async () => undefined) };
    const plugin = {
      manager, scheduler,
      settings: { ...DEFAULT_SETTINGS, remoteDaemons: [{ id: 'homelab', name: 'homelab', url: 'wss://threads.corp.example:8443', tokenSecretName: 'x' }] },
      getEffectiveCwd: () => '/global',
      saveSettings: vi.fn(async () => undefined),
    };
    return { plugin, manager, scheduler };
  }
  const dispatch = (plugin: unknown, opts?: Record<string, unknown>) =>
    ClaudeThreadsPlugin.prototype.dispatchNewThread.call(plugin, 'do it', undefined, undefined, opts as never);

  it('machine disabled: no thread, no scheduled loop, no send', async () => {
    const { plugin, manager, scheduler } = harness(policy({ machine: { enabled: false } }));
    await expect(dispatch(plugin, { loop: { intervalSeconds: 60 } })).rejects.toThrow(/this computer is disabled by your administrator/);
    expect(manager.createThread).not.toHaveBeenCalled();
    expect(scheduler.createItem).not.toHaveBeenCalled();
    expect(manager.sendMessage).not.toHaveBeenCalled();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it('harness not allowed: refused, using the harness the picker chose', async () => {
    const { plugin, manager } = harness(policy({ harnesses: ['claude'] }));
    await expect(dispatch(plugin, { agentHarness: 'codex' })).rejects.toThrow(/Codex is not allowed/);
    expect(manager.createThread).not.toHaveBeenCalled();
    await dispatch(plugin, { agentHarness: 'claude' });
    expect(manager.createThread).toHaveBeenCalledTimes(1);
  });

  it('falls back to the settings default harness when the picker left it alone', async () => {
    const { plugin, manager } = harness(policy({ harnesses: ['codex'] }));
    plugin.settings.agentHarness = 'claude';
    await expect(dispatch(plugin)).rejects.toThrow(/Claude Code is not allowed|Claude is not allowed/);
    expect(manager.createThread).not.toHaveBeenCalled();
  });

  it('remote daemon off: createRemoteThread is never reached', async () => {
    const { plugin, manager } = harness(policy({ remoteDaemon: { enabled: false } }), { homelab: { kind: 'remoteDaemon', url: 'wss://threads.corp.example:8443' } });
    await expect(dispatch(plugin, { remote: { daemonId: 'homelab', cwd: '/srv' } })).rejects.toThrow(/remote daemons is disabled/);
    expect(manager.createRemoteThread).not.toHaveBeenCalled();
  });

  it('remote host not on the list: refused', async () => {
    const { plugin, manager } = harness(
      policy({ remoteDaemon: { enabled: true, hosts: ['wss://other.example:1'] } }),
      { homelab: { kind: 'remoteDaemon', url: 'wss://threads.corp.example:8443' } },
    );
    await expect(dispatch(plugin, { remote: { daemonId: 'homelab', cwd: '/srv' } })).rejects.toThrow(/list of hosts/);
    expect(manager.createRemoteThread).not.toHaveBeenCalled();
  });

  it('no policy: unchanged', async () => {
    const { plugin, manager } = harness(undefined);
    await dispatch(plugin);
    expect(manager.createThread).toHaveBeenCalledTimes(1);
    expect(manager.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('other creation paths in main.ts', () => {
  it('an agent-created thread is refused from the last snapshot', () => {
    const plugin = {
      managedPolicy: source(policy({ machine: { enabled: false } })),
      settings: { ...DEFAULT_SETTINGS },
      manager: { createThread: vi.fn(), getThread: () => undefined },
    };
    expect(() => ClaudeThreadsPlugin.prototype.createThreadFromAgent.call(plugin, 'creator', 'title')).toThrow(ManagedPolicyError);
    expect(plugin.manager.createThread).not.toHaveBeenCalled();
  });

  it('the claude-on-this-computer guard follows the machine target and the Claude harness', async () => {
    const guard = (src: ManagedPolicySource) => (ClaudeThreadsPlugin.prototype as unknown as { assertClaudeMayRunOnThisComputer(this: unknown): Promise<void> })
      .assertClaudeMayRunOnThisComputer.call({ managedPolicy: src });
    await expect(guard(source(undefined))).resolves.toBeUndefined();
    await expect(guard(source(policy({})))).resolves.toBeUndefined();
    await expect(guard(source(policy({ machine: { enabled: false } })))).rejects.toThrow(ManagedPolicyError);
    await expect(guard(source(policy({ harnesses: ['codex'] })))).rejects.toThrow(/administrator/);
    // the container being allowed does not make a host subprocess allowed
    await expect(guard(source(policy({ machine: { enabled: false }, localDaemon: { enabled: true } })))).rejects.toThrow(ManagedPolicyError);
  });
});

describe('scheduler refuses with a reason on the item, without crashing', () => {
  beforeEach(() => { vi.useFakeTimers(); (globalThis as Record<string, unknown>).window = globalThis; });
  afterEach(() => { vi.useRealTimers(); delete (globalThis as Record<string, unknown>).window; });

  it('records an error run (with the policy reason), creates no thread and keeps the schedule alive', async () => {
    const createThread = vi.fn().mockReturnValue({ id: 'thread' });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const scheduler = new Scheduler({
      getItems: () => [],
      saveItem: vi.fn().mockResolvedValue(undefined),
      removeItem: vi.fn().mockResolvedValue(undefined),
      createThread,
      sendMessage,
      assertCanLaunchNewThread: async () => { throw new ManagedPolicyError('target-disabled', 'Running threads on this computer is disabled by your administrator.'); },
      getDefaultCwd: () => '/tmp',
    } as never);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    scheduler.start([{ id: 'item-1', name: 'Job', prompt: 'go', schedule: { type: 'interval', intervalSeconds: 3600 }, enabled: true, nextRun: Date.now() - 1_000 } as never]);
    await vi.advanceTimersByTimeAsync(6_000);
    errors.mockRestore();

    expect(createThread).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    const history = scheduler.getItem('item-1')?.runHistory ?? [];
    expect(history).toHaveLength(1);
    expect(history[0].outcome).toBe('error');
    expect(history[0].note).toMatch(/disabled by your administrator/);
    // The item is still scheduled for its next cycle: relaxing the policy resumes it with no user action.
    expect(scheduler.getItem('item-1')?.nextRun).toBeGreaterThan(Date.now());
    scheduler.destroy();
  });

  it('fires normally when the check passes', async () => {
    const createThread = vi.fn().mockReturnValue({ id: 'thread' });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const scheduler = new Scheduler({
      getItems: () => [], saveItem: vi.fn().mockResolvedValue(undefined), removeItem: vi.fn().mockResolvedValue(undefined),
      createThread, sendMessage, assertCanLaunchNewThread: async () => undefined, getDefaultCwd: () => '/tmp',
    } as never);
    scheduler.start([{ id: 'item-1', name: 'Job', prompt: 'go', schedule: { type: 'interval', intervalSeconds: 3600 }, enabled: true, nextRun: Date.now() - 1_000 } as never]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(scheduler.getItem('item-1')?.runHistory?.[0].outcome).toBe('fired');
    scheduler.destroy();
  });
});

describe('non-thread claude subprocess guards', () => {
  it('the summarizer starts no query when its guard refuses', async () => {
    const summarizer = new InProcessSummarizer();
    summarizer.spawnGuard = async () => { throw new ManagedPolicyError('target-disabled', 'Running threads on this computer is disabled by your administrator.'); };
    await expect(summarizer.summarizeMessage('a long assistant answer that would be summarised', '/bin/claude', 'haiku', '')).rejects.toThrow(/administrator/);
  });

  it('a constrained run starts no query when its guard refuses', async () => {
    const runQuery = vi.fn();
    const run = createConstrainedQueryRunner(() => ({ claudeBinaryPath: '/bin/claude', extraEnv: '', provider: 'anthropic' } as never), runQuery as never, () => ({}), async () => {
      throw new ManagedPolicyError('target-disabled', 'Running threads on this computer is disabled by your administrator.');
    });
    await expect(run({ prompt: 'p', options: { model: 'm', systemInstructions: 's', maxTurns: 1, maxBudgetUsd: 1, timeoutMs: 1000 }, signal: new AbortController().signal })).rejects.toThrow(/administrator/);
    expect(runQuery).not.toHaveBeenCalled();
  });
});

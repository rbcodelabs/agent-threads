/**
 * Tests for ThreadManager's ADR-0015 wiring: does `buildThreadSessionOptions`
 * attach `claude.vm` routing inputs for the right threads under the right
 * `harnessVmMode` settings, and does thread deletion tear down a harness-owned
 * sandbox container.
 *
 * `HarnessFactory` is mocked exactly as `harness-switching-send.test.ts` does,
 * so this exercises real `ThreadManager` code without a real Agent SDK query()
 * or a live `container` runtime.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import type { SessionCallbacks } from '../../src/ThreadSession';
import { DEFAULT_SETTINGS, type Thread } from '../../src/types';
import type { HarnessSessionOptions } from '../../src/HarnessSession';

const fake = vi.hoisted(() => ({
  lastOptions: undefined as HarnessSessionOptions | undefined,
}));

vi.mock('../../src/HarnessFactory', () => ({
  createHarnessSession: () => ({
    turnInFlight: false, cwd: undefined,
    start: async (options: HarnessSessionOptions) => {
      fake.lastOptions = options;
    },
    send: () => {}, prepareForSend: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
    close: () => {}, interrupt: async () => {}, getContextUsage: async () => null,
    getUsageSnapshot: async () => null,
  }),
}));

const resolveClaudeVmRouting = vi.hoisted(() => vi.fn());
vi.mock('../../src/harnessVmRouting', async () => {
  const actual = await vi.importActual<typeof import('../../src/harnessVmRouting')>('../../src/harnessVmRouting');
  return { ...actual, resolveClaudeVmRouting };
});

const { ThreadManager } = await import('../../src/ThreadManager');

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't1', title: 'Test', cwd: os.tmpdir(), sessionGeneration: 1,
    messages: [], createdAt: 1, updatedAt: 1, status: 'waiting',
    ...overrides,
  };
}

beforeEach(() => { fake.lastOptions = undefined; resolveClaudeVmRouting.mockReset(); });

describe('ThreadManager — ADR-0015 Claude VM routing inputs', () => {
  it('attaches claude.vm for a Claude thread under the default (auto) settings', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread({ agentHarness: 'claude' })]);
    await manager.sendMessage('t1', 'hi');

    expect(fake.lastOptions?.claude?.vm).toMatchObject({ mode: 'auto', image: 'claude-threads-harness:1' });
  });

  it('attaches a skill mount plan to claude.vm, and every mount is a distinct guest path', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread({ agentHarness: 'claude' })]);
    await manager.sendMessage('t1', 'hi');

    const plan = fake.lastOptions?.claude?.vm?.skillMountPlan;
    expect(plan).toBeDefined();
    const guests = plan!.mounts.map((m) => m.guestPath);
    expect(new Set(guests).size).toBe(guests.length);
  });

  it('omits claude.vm entirely when harnessVmMode is "never" — zero behavior change', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, harnessVmMode: 'never' });
    manager.loadThreads([thread({ agentHarness: 'claude' })]);
    await manager.sendMessage('t1', 'hi');

    expect(fake.lastOptions?.claude?.vm).toBeUndefined();
  });

  it('omits claude.vm for a non-Claude harness even when harnessVmMode is "always" — Claude-only for this ADR', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, harnessVmMode: 'always' });
    manager.vmMcpServerFactory = vi.fn(() => ({}));
    manager.loadThreads([thread({ agentHarness: 'codex' })]);
    await manager.sendMessage('t1', 'hi');

    expect(fake.lastOptions?.claude?.vm).toBeUndefined();
    expect(manager.vmMcpServerFactory).not.toHaveBeenCalled();
  });

  it('honors a custom harnessVmImage setting', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, harnessVmImage: 'my-custom-harness:2' });
    manager.loadThreads([thread({ agentHarness: 'claude' })]);
    await manager.sendMessage('t1', 'hi');

    expect(fake.lastOptions?.claude?.vm?.image).toBe('my-custom-harness:2');
  });

  it('builds a VM-only MCP roster from the ordinary roster without changing Codex/OpenCode configs', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    const host = { loopback: { type: 'http' as const, url: 'http://127.0.0.1:5555' } };
    const vm = { loopback: { type: 'sdk' as const, name: 'loopback', instance: {} as never } };
    manager.mcpServerFactory = () => host;
    manager.vmMcpServerFactory = (_threadId, ordinary) => {
      expect(ordinary).toBe(host);
      return vm;
    };
    manager.loadThreads([thread({ agentHarness: 'claude' })]);
    await manager.sendMessage('t1', 'hi');

    expect(fake.lastOptions?.claude?.mcpServers).toBe(host);
    expect(fake.lastOptions?.claude?.vmMcpServers).toBe(vm);
    expect(fake.lastOptions?.codex?.mcpServers).toEqual({ loopback: host.loopback });
    expect(fake.lastOptions?.opencode?.mcpServers).toEqual({ loopback: host.loopback });
  });

  it('the vm inputs reference the SAME SandboxVmManager instance getSandboxVmManager(threadId) returns, so routing and teardown see the same container state', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread({ agentHarness: 'claude' })]);
    await manager.sendMessage('t1', 'hi');

    expect(fake.lastOptions?.claude?.vm?.vmManager).toBe(manager.getSandboxVmManager('t1'));
  });
});

describe('ThreadManager — sandbox VM teardown at thread deletion (ADR-0015 §3, Open Question #4)', () => {
  it('tears down a harness-owned container when the thread is deleted', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread({ agentHarness: 'claude' })]);

    const vmManager = manager.getSandboxVmManager('t1');
    const exitSpy = vi.spyOn(vmManager, 'exit').mockResolvedValue({ success: true, removedContainer: 'x' });

    manager.deleteThread('t1');

    expect(exitSpy).toHaveBeenCalledWith({ force: true, allowHarnessOwned: true });
  });

  it('does nothing when no sandbox VM manager was ever created for the thread (no-op, not an error)', () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread({ agentHarness: 'claude' })]);
    expect(() => manager.deleteThread('t1')).not.toThrow();
  });

  it('a deleted thread\'s sandbox VM manager is dropped from tracking (a later re-creation with the same id starts fresh)', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread({ agentHarness: 'claude' })]);
    const first = manager.getSandboxVmManager('t1');
    vi.spyOn(first, 'exit').mockResolvedValue({ success: true, removedContainer: 'x' });

    manager.deleteThread('t1');
    const second = manager.getSandboxVmManager('t1');

    expect(second).not.toBe(first);
  });
});

describe('ThreadManager — ADR-0015 follow-up: getClaudeVmRouting() reflects the actual routing decision', () => {
  it('is undefined before any Claude session has started', () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread({ agentHarness: 'claude' })]);
    expect(manager.getClaudeVmRouting('t1')).toBeUndefined();
  });

  it('records the container routing SessionCallbacks.onVmRouting reports, keyed by threadId', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread({ agentHarness: 'claude' })]);
    await manager.sendMessage('t1', 'hi');

    fake.lastOptions?.callbacks.onVmRouting?.({ containerName: 'claude-threads-vm-t1', containerBinaryPath: '/home/node/.local/bin/claude' });

    expect(manager.getClaudeVmRouting('t1')).toEqual({
      containerName: 'claude-threads-vm-t1',
      containerBinaryPath: '/home/node/.local/bin/claude',
    });
  });

  it('records a host-local (null) decision the same way', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread({ agentHarness: 'claude' })]);
    await manager.sendMessage('t1', 'hi');

    fake.lastOptions?.callbacks.onVmRouting?.(null);

    expect(manager.getClaudeVmRouting('t1')).toBeNull();
  });

  it('is cleared when the thread is deleted', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread({ agentHarness: 'claude' })]);
    await manager.sendMessage('t1', 'hi');
    fake.lastOptions?.callbacks.onVmRouting?.({ containerName: 'x', containerBinaryPath: '/claude' });
    expect(manager.getClaudeVmRouting('t1')).not.toBeUndefined();

    manager.deleteThread('t1');

    expect(manager.getClaudeVmRouting('t1')).toBeUndefined();
  });
});

describe('ThreadManager — resolveClaudeVmRoutingForSignIn() (sign-in card rebuilt after a plugin reload)', () => {
  const ROUTING = { containerName: 'claude-threads-vm-t1', containerBinaryPath: '/home/node/.local/bin/claude' };

  it('resolves the routing itself when no session has started yet — the reload case that used to fall back to the host flow', async () => {
    resolveClaudeVmRouting.mockResolvedValue({ routed: true, routing: ROUTING });
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread({ agentHarness: 'claude' })]);
    expect(manager.getClaudeVmRouting('t1')).toBeUndefined(); // the precondition that caused the bug

    await expect(manager.resolveClaudeVmRoutingForSignIn('t1')).resolves.toEqual(ROUTING);
    expect(resolveClaudeVmRouting).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'auto', image: 'claude-threads-harness:1', mountPath: os.tmpdir(),
    }));
  });

  it('remembers the answer: getClaudeVmRouting() then reports it and a second call does not re-resolve', async () => {
    resolveClaudeVmRouting.mockResolvedValue({ routed: true, routing: ROUTING });
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread({ agentHarness: 'claude' })]);

    await manager.resolveClaudeVmRoutingForSignIn('t1');
    await manager.resolveClaudeVmRoutingForSignIn('t1');

    expect(manager.getClaudeVmRouting('t1')).toEqual(ROUTING);
    expect(resolveClaudeVmRouting).toHaveBeenCalledTimes(1);
  });

  it('a routed:false decision resolves to null (host flow) and is remembered too', async () => {
    resolveClaudeVmRouting.mockResolvedValue({ routed: false });
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread({ agentHarness: 'claude' })]);

    await expect(manager.resolveClaudeVmRoutingForSignIn('t1')).resolves.toBeNull();
    expect(manager.getClaudeVmRouting('t1')).toBeNull();
  });

  it('never routes when harnessVmMode is "never", without touching the container runtime', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, harnessVmMode: 'never' });
    manager.loadThreads([thread({ agentHarness: 'claude' })]);

    await expect(manager.resolveClaudeVmRoutingForSignIn('t1')).resolves.toBeNull();
    expect(resolveClaudeVmRouting).not.toHaveBeenCalled();
  });

  it('is Claude-only: a Codex thread gets the host flow', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread({ agentHarness: 'codex' })]);

    await expect(manager.resolveClaudeVmRoutingForSignIn('t1')).resolves.toBeNull();
    expect(resolveClaudeVmRouting).not.toHaveBeenCalled();
  });

  it('a resolution failure (e.g. "always" mode, container will not start) degrades to the host flow instead of throwing', async () => {
    resolveClaudeVmRouting.mockRejectedValue(new Error('harnessVmMode is "always" but the sandbox VM is not ready'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, harnessVmMode: 'always' });
    manager.loadThreads([thread({ agentHarness: 'claude' })]);

    await expect(manager.resolveClaudeVmRoutingForSignIn('t1')).resolves.toBeNull();
    warn.mockRestore();
  });

  it('an unknown thread id resolves to null', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    await expect(manager.resolveClaudeVmRoutingForSignIn('nope')).resolves.toBeNull();
  });
});

describe('ThreadManager — containerAuthToken plumbing', () => {
  it('passes the resolver\'s token to the session as containerAuthToken (NOT inside secretEnv)', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.containerAuthTokenResolver = () => 'sk-ant-oat01-abc';
    manager.loadThreads([thread({ agentHarness: 'claude' })]);
    await manager.sendMessage('t1', 'hi');

    expect(fake.lastOptions?.containerAuthToken).toBe('sk-ant-oat01-abc');
    expect(JSON.stringify(fake.lastOptions?.secretEnv ?? {})).not.toContain('sk-ant-oat01-abc');
  });

  it('is undefined when no token has been saved yet', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread({ agentHarness: 'claude' })]);
    await manager.sendMessage('t1', 'hi');

    expect(fake.lastOptions?.containerAuthToken).toBeUndefined();
  });
});

describe('ThreadManager — in-thread "Run this thread in a sandbox?" offer', () => {
  async function started(settings = DEFAULT_SETTINGS) {
    const manager = new ThreadManager(settings);
    manager.sandboxSetupSupported = () => true; // CI is Linux; the real check is exercised in sandboxRuntime tests
    manager.loadThreads([thread({ agentHarness: 'claude' })]);
    const events: Array<{ type: string; reason?: string }> = [];
    manager.subscribe((_id, e) => events.push(e as never));
    await manager.sendMessage('t1', 'hi');
    return { manager, events, report: (reason?: string) => fake.lastOptions?.callbacks.onVmRouting?.(null, reason as never) };
  }
  const offers = (events: Array<{ type: string }>) => events.filter((e) => e.type === 'sandbox_setup_offer');

  it.each(['runtime-missing', 'runtime-stopped', 'image-missing'])('offers setup when auto mode fell back because of %s', async (reason) => {
    const { manager, events, report } = await started();
    report(reason);
    expect(offers(events)).toEqual([{ type: 'sandbox_setup_offer', reason }]);
    expect(manager.getSandboxSetupOffer('t1')).toBe(reason);
  });

  it.each(['unsupported', 'never', 'start-failed', undefined])('does NOT offer setup for fallback reason %s', async (reason) => {
    const { manager, events, report } = await started();
    report(reason);
    expect(offers(events)).toHaveLength(0);
    expect(manager.getSandboxSetupOffer('t1')).toBeUndefined();
  });

  it('does not offer when the sandbox routed successfully', async () => {
    const { events } = await started();
    fake.lastOptions?.callbacks.onVmRouting?.({ containerName: 'c', containerBinaryPath: '/claude' });
    expect(offers(events)).toHaveLength(0);
  });

  it('does not offer in "always" mode (that mode errors instead of falling back)', async () => {
    const { events, report } = await started({ ...DEFAULT_SETTINGS, harnessVmMode: 'always' });
    report('runtime-missing');
    expect(offers(events)).toHaveLength(0);
  });

  it('does not offer once "Don\'t ask again" was persisted', async () => {
    const { events, report } = await started({ ...DEFAULT_SETTINGS, sandboxSetupPromptDismissed: true });
    report('runtime-missing');
    expect(offers(events)).toHaveLength(0);
  });

  it('does not offer where setup cannot run on this machine', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.sandboxSetupSupported = () => false;
    manager.loadThreads([thread({ agentHarness: 'claude' })]);
    const events: Array<{ type: string }> = [];
    manager.subscribe((_id, e) => events.push(e));
    await manager.sendMessage('t1', 'hi');
    fake.lastOptions?.callbacks.onVmRouting?.(null, 'runtime-missing');
    expect(offers(events)).toHaveLength(0);
  });

  it('offers at most once per thread per app session, even after "Not now" and further session starts', async () => {
    const { manager, events, report } = await started();
    report('runtime-missing');
    report('runtime-missing');
    manager.clearSandboxSetupOffer('t1'); // "Not now"
    report('image-missing');
    expect(offers(events)).toHaveLength(1);
    expect(manager.getSandboxSetupOffer('t1')).toBeUndefined();
  });

  it('forgets a deleted thread\'s offer state', async () => {
    const { manager, report } = await started();
    report('runtime-missing');
    manager.deleteThread('t1');
    expect(manager.getSandboxSetupOffer('t1')).toBeUndefined();
  });
});

describe('per-thread harnessVmMode override', () => {
  it('resolveEffectiveHarnessVmMode: thread override > settings > auto', async () => {
    const { resolveEffectiveHarnessVmMode } = await import('../../src/types');
    expect(resolveEffectiveHarnessVmMode(undefined, undefined)).toBe('auto');
    expect(resolveEffectiveHarnessVmMode(undefined, 'never')).toBe('never');
    expect(resolveEffectiveHarnessVmMode('always', 'never')).toBe('always');
    expect(resolveEffectiveHarnessVmMode('never', 'always')).toBe('never');
  });

  it('thread override "never" wins over global "always" when building routing inputs', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, harnessVmMode: 'always' });
    manager.loadThreads([thread({ agentHarness: 'claude', harnessVmMode: 'never' })]);
    await manager.sendMessage('t1', 'hi');
    expect(fake.lastOptions?.claude?.vm).toBeUndefined();
  });

  it('thread override "always" wins over global "never"', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, harnessVmMode: 'never' });
    manager.loadThreads([thread({ agentHarness: 'claude', harnessVmMode: 'always' })]);
    await manager.sendMessage('t1', 'hi');
    expect(fake.lastOptions?.claude?.vm).toMatchObject({ mode: 'always' });
  });

  it('setThreadHarnessVmMode persists the override, resets the native session on a host<->container flip, and sets a handoff', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread({ sessionId: 'native-1', summary: 'Keep going.' })]);
    const persist = vi.fn(async () => {});
    await manager.setThreadHarnessVmMode('t1', 'never', persist);
    const t = manager.getThread('t1')!;
    expect(persist).toHaveBeenCalledTimes(1);
    expect(t.harnessVmMode).toBe('never');
    expect(t.sessionId).toBeUndefined();
    expect(t.sessionGeneration).toBe(2);
    expect(t.pendingHarnessHandoff).toMatchObject({ sourceHarness: 'claude', targetHarness: 'claude', summary: 'Keep going.' });

    await manager.setThreadHarnessVmMode('t1', undefined, persist);
    expect(manager.getThread('t1')!.harnessVmMode).toBeUndefined();
  });

  it('keeps the native session when both modes are containerized (auto -> always)', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread({ sessionId: 'native-1' })]);
    await manager.setThreadHarnessVmMode('t1', 'always', async () => {});
    const t = manager.getThread('t1')!;
    expect(t.harnessVmMode).toBe('always');
    expect(t.sessionId).toBe('native-1');
    expect(t.pendingHarnessHandoff).toBeUndefined();
  });

  it('rolls back on persistence failure', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread({ sessionId: 'native-1' })]);
    await expect(manager.setThreadHarnessVmMode('t1', 'never', async () => { throw new Error('disk'); })).rejects.toThrow('disk');
    const t = manager.getThread('t1')!;
    expect(t.harnessVmMode).toBeUndefined();
    expect(t.sessionId).toBe('native-1');
    expect(t.sessionGeneration).toBe(1);
    expect(t.pendingHarnessHandoff).toBeUndefined();
  });

  it('is blocked while a lifecycle state blocks harness switching, and for non-Claude harnesses', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread({ pendingPlan: 'approve me' }), thread({ id: 't2', agentHarness: 'codex' })]);
    const persist = vi.fn(async () => {});
    await expect(manager.setThreadHarnessVmMode('t1', 'never', persist)).rejects.toThrow(/plan/i);
    await expect(manager.setThreadHarnessVmMode('t2', 'never', persist)).rejects.toThrow(/Claude/);
    expect(persist).not.toHaveBeenCalled();
    expect(manager.getThread('t1')!.harnessVmMode).toBeUndefined();
  });
});

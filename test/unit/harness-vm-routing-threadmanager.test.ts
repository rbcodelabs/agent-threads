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

  it('omits claude.vm entirely when harnessVmMode is "never" — zero behavior change', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, harnessVmMode: 'never' });
    manager.loadThreads([thread({ agentHarness: 'claude' })]);
    await manager.sendMessage('t1', 'hi');

    expect(fake.lastOptions?.claude?.vm).toBeUndefined();
  });

  it('omits claude.vm for a non-Claude harness even when harnessVmMode is "always" — Claude-only for this ADR', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, harnessVmMode: 'always' });
    manager.loadThreads([thread({ agentHarness: 'codex' })]);
    await manager.sendMessage('t1', 'hi');

    expect(fake.lastOptions?.claude?.vm).toBeUndefined();
  });

  it('honors a custom harnessVmImage setting', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, harnessVmImage: 'my-custom-harness:2' });
    manager.loadThreads([thread({ agentHarness: 'claude' })]);
    await manager.sendMessage('t1', 'hi');

    expect(fake.lastOptions?.claude?.vm?.image).toBe('my-custom-harness:2');
  });

  it('the vm inputs reference the SAME SandboxVmManager instance getSandboxVmManager(threadId) returns, so agent enter_vm/vm_exec calls see the same container state', async () => {
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

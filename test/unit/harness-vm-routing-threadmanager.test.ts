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

const { ThreadManager } = await import('../../src/ThreadManager');

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't1', title: 'Test', cwd: os.tmpdir(), sessionGeneration: 1,
    messages: [], createdAt: 1, updatedAt: 1, status: 'waiting',
    ...overrides,
  };
}

beforeEach(() => { fake.lastOptions = undefined; });

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

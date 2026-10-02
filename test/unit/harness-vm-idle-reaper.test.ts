/**
 * ThreadManager.reapIdleHarnessVms: an idle thread's session is closed and its
 * harness container stopped; busy / pending / recently-active threads are left alone.
 */
import { describe, expect, it, vi } from 'vitest';
import os from 'os';
import { DEFAULT_SETTINGS, type Thread } from '../../src/types';
import { SandboxVmManager, containerNameForThread, type VmCommandRunner } from '../../src/sandboxVm';

vi.mock('../../src/HarnessFactory', () => ({ createHarnessSession: () => ({}) }));

const { ThreadManager } = await import('../../src/ThreadManager');

const IDLE = 60_000;

function thread(id: string): Thread {
  return { id, title: id, cwd: os.tmpdir(), sessionGeneration: 1, messages: [], createdAt: 1, updatedAt: 1, status: 'waiting' };
}

async function setup(session: Partial<{ turnInFlight: boolean; hasPendingPermission: boolean }> | null) {
  const calls: string[] = [];
  const run: VmCommandRunner = async (args) => { calls.push(args.join(' ')); return { exitCode: 0, stdout: '', stderr: '' }; };
  const manager = new ThreadManager(DEFAULT_SETTINGS);
  manager.loadThreads([thread('t1')]);
  const vm = new SandboxVmManager({ containerName: () => containerNameForThread('t1'), run });
  await vm.ensureHarnessContainer({ image: 'img', mountPath: '/w', network: 'default' });
  (manager as unknown as { sandboxVmManagers: Map<string, SandboxVmManager> }).sandboxVmManagers.set('t1', vm);
  const close = vi.fn();
  if (session) {
    (manager as unknown as { sessions: Map<string, unknown> }).sessions.set('t1', {
      turnInFlight: false, hasPendingPermission: false, close, ...session,
    });
  }
  calls.length = 0;
  return { manager, vm, calls, close };
}

const later = () => Date.now() + IDLE * 2;

describe('ThreadManager — reapIdleHarnessVms', () => {
  it('stops VM lifecycle timers before graceful shutdown without closing an active session', async () => {
    const { manager, vm, close } = await setup({ turnInFlight: true });
    const dispose = vi.fn(async () => {});
    Object.assign(vm, { dispose });
    await (manager as unknown as { stopVmIdleLifecycle(): Promise<void> }).stopVmIdleLifecycle();
    expect(dispose).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });
  it('destroy disposes every VM manager so old idle timers cannot stop replacement sessions', async () => {
    const { manager, vm, calls } = await setup(null);
    const dispose = vi.fn(async () => {});
    Object.assign(vm, { dispose });
    await manager.destroy();
    expect(dispose).toHaveBeenCalledOnce();
    expect(calls).toEqual([]);
  });
  it.each(['pendingPlan', 'pendingQuestions', 'pendingBackgroundTasks'])(
    'skips persisted %s after a reload even without a session', async (key) => {
      const { manager, calls } = await setup(null);
      const existing = (manager as unknown as { threads: Map<string, Record<string, unknown>> }).threads.get('t1')!;
      existing[key] = key === 'pendingPlan' ? 'Approve this plan' : [{}];
      expect(await manager.reapIdleHarnessVms(IDLE, later())).toEqual([]);
      expect(calls).toEqual([]);
    });
  it.each(['pendingPermissions', 'pendingQuestionResolvers', 'pendingPlanResolvers', 'pendingUserMessageIds', 'queuedMessages'])(
    'skips %s even if the session is absent', async (key) => {
      const { manager, calls } = await setup(null);
      const map = (manager as unknown as Record<string, Map<string, unknown>>)[key];
      map.set('t1', key === 'queuedMessages' || key === 'pendingUserMessageIds' ? ['pending'] : {});
      expect(await manager.reapIdleHarnessVms(IDLE, later())).toEqual([]);
      expect(calls).toEqual([]);
    });
  it('closes the idle session and stops the container', async () => {
    const { manager, calls, close } = await setup({});
    expect(await manager.reapIdleHarnessVms(IDLE, later())).toEqual(['t1']);
    expect(close).toHaveBeenCalledOnce();
    expect(calls.some((c) => c.startsWith('stop '))).toBe(true);
    expect(calls.some((c) => c.startsWith('rm '))).toBe(false);
  });

  it('stops a container whose session is already gone', async () => {
    const { manager, calls } = await setup(null);
    expect(await manager.reapIdleHarnessVms(IDLE, later())).toEqual(['t1']);
    expect(calls.some((c) => c.startsWith('stop '))).toBe(true);
  });

  it('skips a thread with a turn in flight', async () => {
    const { manager, calls, close } = await setup({ turnInFlight: true });
    expect(await manager.reapIdleHarnessVms(IDLE, later())).toEqual([]);
    expect(close).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('skips a thread with a pending permission', async () => {
    const { manager, close } = await setup({ hasPendingPermission: true });
    expect(await manager.reapIdleHarnessVms(IDLE, later())).toEqual([]);
    expect(close).not.toHaveBeenCalled();
  });

  it('skips a recently used container', async () => {
    const { manager, close } = await setup({});
    expect(await manager.reapIdleHarnessVms(IDLE, Date.now() + 1000)).toEqual([]);
    expect(close).not.toHaveBeenCalled();
  });

  it('skips recent thread activity', async () => {
    const { manager, close } = await setup({});
    (manager as unknown as { lastActivityAt: Map<string, number> }).lastActivityAt.set('t1', Date.now() + IDLE * 2 - 1000);
    expect(await manager.reapIdleHarnessVms(IDLE, later())).toEqual([]);
    expect(close).not.toHaveBeenCalled();
  });

  it('is disabled when idleMs is 0', async () => {
    const { manager } = await setup({});
    expect(await manager.reapIdleHarnessVms(0, later())).toEqual([]);
  });
});

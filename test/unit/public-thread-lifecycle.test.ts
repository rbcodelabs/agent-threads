import { describe, expect, it, vi } from 'vitest';
import { createPublicThreadLifecycle } from '../../src/publicThreadLifecycle';

function setup() {
  const threads = [{ id: 'one', title: 'One', reviewed: false, updatedAt: 10 }, { id: 'two', title: 'Two', reviewed: false, updatedAt: 20 }];
  const running = new Set<string>();
  const deps = {
    getThreads: () => threads,
    isRunning: (id: string) => running.has(id),
    getOrchestratorContext: () => ({ portfolioThreadId: undefined as string | undefined, projects: [] }),
    confirm: vi.fn(async () => true),
    cancelWakeups: vi.fn(async (_id: string) => {}),
    archiveThread: vi.fn(async (id: string) => { threads.splice(threads.findIndex(t => t.id === id), 1); }),
    saveSettings: vi.fn(async () => {}),
    notifyReviewed: vi.fn(),
  };
  const lifecycle = createPublicThreadLifecycle(deps);
  return { threads, running, deps, lifecycle };
}

describe('public thread lifecycle', () => {
  it('awaits wakeup cancellation, archival and persistence before success', async () => {
    const { deps, lifecycle } = setup();
    await expect(lifecycle.archive('one', () => {})).resolves.toEqual({ status: 'archived', threadId: 'one' });
    expect(deps.cancelWakeups.mock.invocationCallOrder[0]).toBeLessThan(deps.archiveThread.mock.invocationCallOrder[0]);
    expect(deps.archiveThread.mock.invocationCallOrder[0]).toBeLessThan(deps.saveSettings.mock.invocationCallOrder[0]);
    expect(deps.confirm).not.toHaveBeenCalled();
  });
  it('blocks the last thread and missing targets', async () => {
    const { lifecycle } = setup();
    await lifecycle.archive('one', () => {});
    await expect(lifecycle.archive('two', () => {})).rejects.toThrow('last remaining');
    await expect(lifecycle.archive('missing', () => {})).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });
  });
  it('uses host confirmation for running targets and respects cancellation', async () => {
    const { running, deps, lifecycle } = setup();
    running.add('one'); deps.confirm.mockResolvedValue(false);
    await expect(lifecycle.archive('one', () => {})).resolves.toEqual({ status: 'cancelled', threadId: 'one' });
    expect(deps.confirm).toHaveBeenCalledOnce();
    expect(deps.archiveThread).not.toHaveBeenCalled();
  });
  it('requires host confirmation for orchestrators', async () => {
    const { deps, lifecycle } = setup();
    deps.getOrchestratorContext = () => ({ portfolioThreadId: 'one', projects: [] });
    await lifecycle.archive('one', () => {});
    expect(deps.confirm).toHaveBeenCalledOnce();
  });
  it('revalidates generation and last-thread protection after a dialog', async () => {
    const { running, deps, threads, lifecycle } = setup();
    running.add('one');
    deps.confirm.mockImplementation(async () => { threads.pop(); return true; });
    await expect(lifecycle.archive('one', () => {})).rejects.toThrow('last remaining');
    expect(deps.archiveThread).not.toHaveBeenCalled();
    threads.push({ id: 'two', title: 'Two', reviewed: false, updatedAt: 20 });
    let active = true;
    deps.confirm.mockImplementation(async () => { active = false; return true; });
    await expect(lifecycle.archive('one', () => { if (!active) throw new Error('stale'); })).rejects.toThrow('stale');
    expect(deps.cancelWakeups).not.toHaveBeenCalled();
  });
  it('serializes concurrent archives so the last thread survives', async () => {
    const { threads, lifecycle } = setup();
    const outcomes = await Promise.allSettled(['one', 'two'].map(id => lifecycle.archive(id, () => {})));
    expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(threads).toHaveLength(1);
  });
  it('does not evict after wakeup failure or report success after persistence failure', async () => {
    const { deps, lifecycle } = setup();
    deps.cancelWakeups.mockRejectedValueOnce(new Error('wakeup disk failure'));
    await expect(lifecycle.archive('one', () => {})).rejects.toThrow('wakeup disk failure');
    expect(deps.archiveThread).not.toHaveBeenCalled();
    deps.saveSettings.mockRejectedValueOnce(new Error('settings failure'));
    await expect(lifecycle.archive('one', () => {})).rejects.toThrow('settings failure');
  });
  it('marks reviewed idempotently without changing recency', async () => {
    const { threads, deps, lifecycle } = setup();
    await expect(lifecycle.markReviewed('one', () => {})).resolves.toEqual({ threadId: 'one', reviewed: true, changed: true });
    await expect(lifecycle.markReviewed('one', () => {})).resolves.toMatchObject({ changed: false });
    expect(threads[0].updatedAt).toBe(10);
    expect(deps.notifyReviewed).toHaveBeenCalledExactlyOnceWith('one');
    expect(deps.saveSettings).toHaveBeenCalledOnce();
  });
  it('rejects running/missing reviews and restores the flag after save failure', async () => {
    const { threads, running, deps, lifecycle } = setup();
    running.add('one');
    await expect(lifecycle.markReviewed('one', () => {})).rejects.toMatchObject({ code: 'THREAD_BUSY' });
    await expect(lifecycle.markReviewed('missing', () => {})).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });
    running.clear(); deps.saveSettings.mockRejectedValueOnce(new Error('disk failure'));
    await expect(lifecycle.markReviewed('one', () => {})).rejects.toThrow('disk failure');
    expect(threads[0].reviewed).toBe(false);
    expect(deps.notifyReviewed).not.toHaveBeenCalled();
  });
  it('does not report a newer completed run as reviewed', async () => {
    const { threads, deps, lifecycle } = setup();
    deps.saveSettings.mockImplementationOnce(async () => { threads[0].updatedAt++; threads[0].reviewed = false; });
    await expect(lifecycle.markReviewed('one', () => {})).rejects.toMatchObject({ code: 'THREAD_BUSY' });
    expect(threads[0].reviewed).toBe(false);
    expect(deps.notifyReviewed).not.toHaveBeenCalled();
  });
  it('rejects changed protection after wakeup cleanup without a misleading cancellation', async () => {
    const { running, deps, lifecycle } = setup();
    deps.cancelWakeups.mockImplementationOnce(async () => { running.add('one'); });
    await expect(lifecycle.archive('one', () => {})).rejects.toMatchObject({ code: 'THREAD_BUSY' });
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.archiveThread).not.toHaveBeenCalled();
  });
  it('treats retained archived records as unavailable, not remaining live threads', async () => {
    const { threads, lifecycle } = setup();
    Object.assign(threads[0], { status: 'archived' });
    await expect(lifecycle.markReviewed('one', () => {})).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });
    await expect(lifecycle.archive('two', () => {})).rejects.toThrow('last remaining');
  });
});

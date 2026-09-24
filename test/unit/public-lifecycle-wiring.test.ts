import { describe, expect, it, vi } from 'vitest';
import ClaudeThreadsPlugin from '../../src/main';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';
import { promptConfirm } from '../../src/confirmModal';
import { AgentDashboard } from '../../src/AgentDashboard';
import { KanbanView } from '../../src/KanbanView';

vi.mock('../../src/confirmModal', () => ({ promptConfirm: vi.fn(async () => true) }));

function setup() {
  const settings = { ...DEFAULT_SETTINGS, saveThreadsToVault: true };
  const manager = new ThreadManager(settings);
  const one = manager.createThread('One', '/tmp');
  manager.createThread('Two', '/tmp');
  const plugin = Object.assign(Object.create(ClaudeThreadsPlugin.prototype), {
    app: { workspace: { trigger: vi.fn() } }, settings, manager,
    scheduler: { listItems: () => [{ id: 'wake', origin: 'wakeup', enabled: true, targetThreadId: one.id }], deleteItem: vi.fn(async () => {}) },
    persistence: { saveThread: vi.fn(async () => {}) },
    saveSettings: vi.fn(async () => {}),
  }) as ClaudeThreadsPlugin;
  plugin.initializePublicApi();
  return { plugin, manager, one };
}

describe('peer lifecycle host wiring', () => {
  it('archives through the real host path only after awaited wakeup removal', async () => {
    const { plugin, manager, one } = setup();
    let release!: () => void;
    vi.mocked(plugin.scheduler.deleteItem).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const result = plugin.api!.v1.threads.archive(one.id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(manager.getThread(one.id)).toBe(one);
    expect(plugin.persistence!.saveThread).not.toHaveBeenCalled();
    release();
    await expect(result).resolves.toMatchObject({ status: 'archived' });
    expect(manager.getThread(one.id)).toBeUndefined();
    expect(plugin.persistence!.saveThread).toHaveBeenCalledWith(expect.objectContaining({ id: one.id, status: 'archived' }));
    expect(plugin.saveSettings).toHaveBeenCalled();
  });
  it('keeps the thread on wakeup or vault write failure', async () => {
    const { plugin, manager, one } = setup();
    vi.mocked(plugin.scheduler.deleteItem).mockRejectedValueOnce(new Error('wakeup write'));
    await expect(plugin.api!.v1.threads.archive(one.id)).rejects.toThrow('wakeup write');
    expect(manager.getThread(one.id)).toBe(one);
    vi.mocked(plugin.persistence!.saveThread).mockRejectedValueOnce(new Error('vault write'));
    await expect(plugin.api!.v1.threads.archive(one.id)).rejects.toThrow('vault write');
    expect(manager.getThread(one.id)).toBe(one);
  });
  it('publishes reviewed_changed without focus or recency mutation', async () => {
    const { plugin, manager, one } = setup();
    const originalTime = one.updatedAt;
    const listener = vi.fn(); manager.subscribe(listener);
    await expect(plugin.api!.v1.threads.markReviewed(one.id)).resolves.toMatchObject({ changed: true });
    expect(one.reviewed).toBe(true);
    expect(one.updatedAt).toBe(originalTime);
    expect(listener).toHaveBeenCalledExactlyOnceWith(one.id, { type: 'reviewed_changed' });
  });
  it('rechecks last-thread protection after asynchronous vault persistence', async () => {
    const { plugin, manager, one } = setup();
    vi.mocked(plugin.persistence!.saveThread).mockImplementationOnce(async () => {
      const other = manager.getThreads().find(thread => thread.id !== one.id)!;
      manager.deleteThread(other.id);
    });
    await expect(plugin.api!.v1.threads.archive(one.id)).rejects.toThrow('last remaining');
    expect(manager.getThread(one.id)).toBe(one);
  });
  it('restores prepared project settings if a safety check fails before retirement', async () => {
    const { plugin, manager, one } = setup();
    const project = manager.createProject('Example', 'Projects/Example');
    manager.updateProject(project.id, { orchestratorEnabled: true, orchestratorThreadId: one.id });
    let safe = true;
    vi.mocked(plugin.persistence!.saveThread).mockImplementationOnce(async () => { safe = false; });
    await expect(plugin.archiveThreadById(one.id, false, () => { if (!safe) throw new Error('state changed'); })).rejects.toThrow('state changed');
    expect(manager.getProject(project.id)).toMatchObject({ orchestratorEnabled: true, orchestratorThreadId: one.id });
    expect(manager.getThread(one.id)).toBe(one);
  });
  it('uses the host dialog and does not mutate after API revocation during confirmation', async () => {
    const { plugin, manager, one } = setup();
    plugin.settings.orchestratorThreadId = one.id;
    const api = plugin.api!.v1;
    vi.mocked(promptConfirm).mockImplementationOnce(async () => { plugin.initializePublicApi(); return true; });
    await expect(api.threads.archive(one.id)).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' });
    expect(promptConfirm).toHaveBeenCalledWith(plugin.app, expect.objectContaining({ confirmLabel: 'Archive anyway' }));
    expect(plugin.scheduler.deleteItem).not.toHaveBeenCalled();
    expect(manager.getThread(one.id)).toBe(one);
  });
  it('refreshes list and board buckets after review without selecting a thread', () => {
    for (const prototype of [AgentDashboard.prototype, KanbanView.prototype]) {
      const view = Object.assign(Object.create(prototype), {
        scheduleRender: vi.fn(), cardPlacements: new Map(), manager: { getThread: () => undefined },
        setActiveRow: vi.fn(), setActiveCard: vi.fn(),
      });
      view.handleEvent('one', { type: 'reviewed_changed' });
      expect(view.scheduleRender).toHaveBeenCalledOnce();
      expect(view.setActiveRow).not.toHaveBeenCalled();
      expect(view.setActiveCard).not.toHaveBeenCalled();
    }
  });
});

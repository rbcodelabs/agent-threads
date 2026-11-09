/**
 * ensure-orchestrator-thread.test.ts
 *
 * Core creates/designates/retires orchestrator threads but no longer owns any
 * heartbeat or wake-up scheduling (the Threads Orchestrator plugin does).
 *
 * Follows the same construction pattern as save-settings-race.test.ts:
 * a minimal ClaudeThreadsPlugin instance built via
 * Object.create(ClaudeThreadsPlugin.prototype), bypassing Obsidian's Plugin
 * constructor (no real App/manifest needed for this method).
 */

import { describe, it, expect, vi } from 'vitest';
import ClaudeThreadsPlugin from '../../src/main';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS, type ScheduledItem } from '../../src/types';

function makePlugin() {
  const plugin = Object.create(ClaudeThreadsPlugin.prototype) as ClaudeThreadsPlugin;
  plugin.manager = new ThreadManager({ ...DEFAULT_SETTINGS });
  plugin.settings = { ...DEFAULT_SETTINGS, defaultCwd: '/tmp', scheduledItems: [] };
  (plugin as unknown as { saveData: (d: unknown) => Promise<void> }).saveData = vi.fn().mockResolvedValue(undefined);
  (plugin as unknown as { openThreadInChatView: (id: string) => Promise<void> }).openThreadInChatView =
    vi.fn().mockResolvedValue(undefined);

  const deleteItem = vi.fn().mockResolvedValue(undefined);
  const createItem = vi.fn().mockImplementation(async (item: ScheduledItem) => {
    plugin.settings.scheduledItems = [...(plugin.settings.scheduledItems ?? []), { ...item, id: item.id ?? crypto.randomUUID() }];
  });
  (plugin as unknown as { scheduler: { deleteItem: typeof deleteItem; createItem: typeof createItem } }).scheduler = {
    deleteItem,
    createItem,
  };

  return { plugin, deleteItem, createItem };
}

describe('ClaudeThreadsPlugin orchestrator thread lifecycle (no core heartbeat)', () => {
  it('keeps the live orchestrator and reference when archive persistence fails', async () => {
    const { plugin, deleteItem } = makePlugin();
    const orchestrator = plugin.manager.createThread('Portfolio', '/tmp');
    plugin.settings.orchestratorThreadId = orchestrator.id;
    plugin.settings.saveThreadsToVault = true;
    plugin.persistence = { saveThread: vi.fn().mockRejectedValue(new Error('vault write failed')) } as never;

    await expect(plugin.archiveThreadById(orchestrator.id)).rejects.toThrow('vault write failed');

    expect(plugin.manager.getThread(orchestrator.id)).toBe(orchestrator);
    expect(plugin.settings.orchestratorThreadId).toBe(orchestrator.id);
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it('retires portfolio and Project orchestrators by clearing refs without touching the scheduler', async () => {
    const { plugin, deleteItem } = makePlugin();
    const portfolio = plugin.manager.createThread('Portfolio', '/tmp');
    plugin.settings.orchestratorThreadId = portfolio.id;
    const project = plugin.manager.createProject('HipTrip', 'HipTrip');
    const projectOrch = plugin.manager.createThread('HipTrip Orchestrator', '/tmp', project.id);
    plugin.manager.updateProject(project.id, { orchestratorThreadId: projectOrch.id });

    await plugin.retireOrchestratorThread(portfolio.id);
    await plugin.retireOrchestratorThread(projectOrch.id);

    expect(deleteItem).not.toHaveBeenCalled();
    expect(plugin.settings.orchestratorThreadId).toBeUndefined();
    expect(plugin.manager.getProject(project.id)?.orchestratorThreadId).toBeUndefined();
    expect(plugin.manager.getProject(project.id)?.orchestratorEnabled).toBe(false);
  });

  it('creates one Project orchestrator without opening it and without scheduling anything', async () => {
    const { plugin, createItem } = makePlugin();
    plugin.manager.vaultRoot = '/vault';
    const project = plugin.manager.createProject('HipTrip', 'Products/HipTrip', undefined, '/repos/hiptrip');

    const threadId = await plugin.ensureProjectOrchestratorThread(project.id, false);
    const reusedId = await plugin.ensureProjectOrchestratorThread(project.id, false);

    expect(reusedId).toBe(threadId);
    expect(plugin.manager.getProject(project.id)?.orchestratorThreadId).toBe(threadId);
    expect(plugin.manager.getThread(threadId!)!).toMatchObject({ title: 'HipTrip Orchestrator', cwd: '/repos/hiptrip', projectId: project.id });
    expect(createItem).not.toHaveBeenCalled();
    expect(plugin.openThreadInChatView).not.toHaveBeenCalled();
    expect(plugin.manager.getProject(project.id)?.orchestratorEnabled).toBe(true);
  });

  it('ensureOrchestratorThread creates the portfolio thread, schedules nothing, and only opens when asked', async () => {
    const { plugin, createItem, deleteItem } = makePlugin();
    await plugin.ensureOrchestratorThread(false);
    const id = plugin.settings.orchestratorThreadId;
    expect(id).toBeDefined();
    expect(plugin.openThreadInChatView).not.toHaveBeenCalled();
    await plugin.ensureOrchestratorThread();
    expect(plugin.settings.orchestratorThreadId).toBe(id);
    expect(plugin.openThreadInChatView).toHaveBeenCalledWith(id);
    expect(createItem).not.toHaveBeenCalled();
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it('disables a Project before persistence when its orchestrator is archived', async () => {
    const { plugin } = makePlugin();
    const project = plugin.manager.createProject('HipTrip', 'HipTrip');
    const orchestrator = plugin.manager.createThread('HipTrip Orchestrator', '/tmp', project.id);
    plugin.manager.updateProject(project.id, { orchestratorThreadId: orchestrator.id });
    const saveData = (plugin as unknown as { saveData: ReturnType<typeof vi.fn> }).saveData;

    await plugin.archiveThreadById(orchestrator.id);

    expect(plugin.manager.getProject(project.id)).toMatchObject({ orchestratorEnabled: false, orchestratorThreadId: undefined });
    expect(saveData).toHaveBeenCalled();
    expect(plugin.manager.getThread(orchestrator.id)).toBeUndefined();
  });

  it('does not automatically create an orchestrator for a disabled Project', async () => {
    const { plugin } = makePlugin();
    const project = plugin.manager.createProject('HipTrip', 'HipTrip');
    plugin.manager.updateProject(project.id, { orchestratorEnabled: false });
    await expect(plugin.ensureProjectOrchestratorThread(project.id, false)).resolves.toBeUndefined();
    expect(plugin.manager.getThreadsByProject(project.id)).toHaveLength(0);
  });

  it('deliberate open re-enables a disabled Project idempotently', async () => {
    const { plugin } = makePlugin();
    const project = plugin.manager.createProject('HipTrip', 'HipTrip');
    plugin.manager.updateProject(project.id, { orchestratorEnabled: false });
    const first = await plugin.ensureProjectOrchestratorThread(project.id, true);
    const second = await plugin.ensureProjectOrchestratorThread(project.id, true);
    expect(second).toBe(first);
    expect(plugin.manager.getProject(project.id)?.orchestratorEnabled).toBe(true);
  });

  it('restores Project enablement and reference when persisting retirement fails', async () => {
    const { plugin } = makePlugin();
    const project = plugin.manager.createProject('HipTrip', 'HipTrip');
    const orchestrator = plugin.manager.createThread('HipTrip Orchestrator', '/tmp', project.id);
    plugin.manager.updateProject(project.id, { orchestratorThreadId: orchestrator.id });
    (plugin as unknown as { saveData: ReturnType<typeof vi.fn> }).saveData.mockRejectedValueOnce(new Error('save failed'));

    await expect(plugin.retireOrchestratorThread(orchestrator.id)).rejects.toThrow('save failed');

    expect(plugin.manager.getProject(project.id)).toMatchObject({ orchestratorEnabled: true, orchestratorThreadId: orchestrator.id });
  });
});

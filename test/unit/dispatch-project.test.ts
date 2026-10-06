import { describe, expect, it, vi } from 'vitest';
import ClaudeThreadsPlugin from '../../src/main';

function pluginHarness() {
  const project = { id: 'project', name: 'Project', vaultFolder: 'Projects/Project', cwdOverride: '/repos/project', createdAt: 1 };
  const manager = {
    getProject: vi.fn((id: string) => id === project.id ? project : undefined),
    getProjectCwd: vi.fn(() => '/repos/project'),
    createThread: vi.fn((title: string, cwd: string, projectId?: string, agentHarness?: string) => ({
      id: 'thread', title, cwd, projectId, agentHarness,
    })),
    setThreadModel: vi.fn(),
    setThreadGoal: vi.fn(),
    commitThreadGoal: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
  const scheduler = { createItem: vi.fn().mockResolvedValue(undefined) };
  const plugin = {
    manager,
    scheduler,
    getEffectiveCwd: () => '/global',
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
  return { plugin, manager, scheduler };
}

describe('dispatchNewThread project context', () => {
  it('validates the selected project and creates the thread in its resolved cwd', async () => {
    const { plugin, manager } = pluginHarness();

    await ClaudeThreadsPlugin.prototype.dispatchNewThread.call(plugin, 'ship it', undefined, undefined, {
      projectId: 'project', agentHarness: 'codex',
    });

    expect(manager.createThread).toHaveBeenCalledWith('ship it', '/repos/project', 'project', 'codex');
  });

  it('rejects an unknown selected project before creating a thread', async () => {
    const { plugin, manager } = pluginHarness();

    await expect(ClaudeThreadsPlugin.prototype.dispatchNewThread.call(plugin, 'ship it', undefined, undefined, {
      projectId: 'missing',
    })).rejects.toThrow('Project not found: missing');
    expect(manager.createThread).not.toHaveBeenCalled();
  });

  it('preserves selected project and cwd on loop schedules', async () => {
    const { plugin, scheduler } = pluginHarness();

    await ClaudeThreadsPlugin.prototype.dispatchNewThread.call(plugin, 'check CI', undefined, undefined, {
      projectId: 'project', loop: { intervalSeconds: 60 },
    });

    expect(scheduler.createItem).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project', cwd: '/repos/project', targetThreadId: 'thread',
    }));
  });
});

describe('dispatchNewThread run mode', () => {
  it('applies the chosen container/host mode to a new Claude thread before the first message', async () => {
    const { plugin, manager } = pluginHarness();
    (manager as any).setInitialThreadHarnessVmMode = vi.fn();
    const order: string[] = [];
    (manager as any).setInitialThreadHarnessVmMode.mockImplementation(() => order.push('mode'));
    manager.sendMessage.mockImplementation(async () => { order.push('send'); });

    await ClaudeThreadsPlugin.prototype.dispatchNewThread.call(plugin, 'ship it', undefined, undefined, {
      agentHarness: 'claude', harnessVmMode: 'always',
    });

    expect((manager as any).setInitialThreadHarnessVmMode).toHaveBeenCalledWith('thread', 'always');
    expect(order).toEqual(['mode', 'send']);
  });

  it('ignores the mode for non-Claude harnesses', async () => {
    const { plugin, manager } = pluginHarness();
    (manager as any).setInitialThreadHarnessVmMode = vi.fn();
    await ClaudeThreadsPlugin.prototype.dispatchNewThread.call(plugin, 'ship it', undefined, undefined, {
      agentHarness: 'codex', harnessVmMode: 'never',
    });
    expect((manager as any).setInitialThreadHarnessVmMode).not.toHaveBeenCalled();
  });
});

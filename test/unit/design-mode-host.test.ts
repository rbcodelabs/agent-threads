import { describe, expect, it, vi } from 'vitest';
import ClaudeThreadsPlugin from '../../src/main';

function hostFixture(saveSettings = vi.fn(async () => {})) {
  const thread = { id: 'provisional-design', title: 'Design' };
  const restoreThreadSelection = vi.fn(async () => {});
  const manager = {
    createThread: vi.fn(() => thread),
    deleteThread: vi.fn(),
    getProject: vi.fn(),
    artifactCleanupSettled: Promise.resolve(),
  };
  const plugin = Object.assign(Object.create(ClaudeThreadsPlugin.prototype), {
    manager,
    saveSettings,
    getActiveThreadId: () => 'previous-thread',
    getEffectiveCwd: () => '/vault',
    getView: () => ({ restoreThreadSelection }),
  }) as any;
  return { plugin, thread, manager, saveSettings, restoreThreadSelection };
}

describe('provisional peer thread host bridge', () => {
  it('persists creation and commits without exposing selection repair to the peer', async () => {
    const { plugin, thread, saveSettings } = hostFixture();
    const handle = await plugin.beginPublicProvisionalThread({ title: 'Design', origin: 'threads-design' });
    expect(handle.thread).toBe(thread);
    expect(saveSettings).toHaveBeenCalledOnce();
    await handle.commit();
    expect(saveSettings).toHaveBeenCalledTimes(2);
  });

  it('deletes the thread and restores the previous selection on rollback', async () => {
    const { plugin, thread, manager, restoreThreadSelection } = hostFixture();
    const handle = await plugin.beginPublicProvisionalThread({ title: 'Design' });
    await handle.rollback();
    expect(manager.deleteThread).toHaveBeenCalledWith(thread.id);
    expect(restoreThreadSelection).toHaveBeenCalledWith('previous-thread');
  });

  it('removes an in-memory thread when initial persistence fails', async () => {
    const saveSettings = vi.fn(async () => { throw new Error('disk full'); });
    const { plugin, thread, manager, restoreThreadSelection } = hostFixture(saveSettings);
    await expect(plugin.beginPublicProvisionalThread({ title: 'Design' })).rejects.toThrow('disk full');
    expect(manager.deleteThread).toHaveBeenCalledWith(thread.id);
    expect(restoreThreadSelection).toHaveBeenCalledWith('previous-thread');
  });
});

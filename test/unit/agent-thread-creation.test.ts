import { describe, expect, it, vi } from 'vitest';
import { createAgentThreadCallback, CROSS_PROJECT_SPAWN_TOOL } from '../../src/main';

function setup(overrides: Partial<Parameters<typeof createAgentThreadCallback>[0]> = {}) {
  const sourceThread = { cwd: '/source/repo', projectId: 'project-1' };
  const createThread = vi.fn().mockReturnValue({ id: 'thread-1', title: 'Created' });
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const sendMessage = vi.fn().mockReturnValue(new Promise<void>(() => {}));
  const requestApproval = vi.fn().mockResolvedValue(true);
  const callback = createAgentThreadCallback({
    sourceThreadId: 'source-thread',
    getThread: vi.fn().mockReturnValue(sourceThread),
    createThread,
    saveSettings,
    sendMessage,
    requestApproval,
    getProjectName: id => (id === 'project-2' ? 'Geode' : undefined),
    ...overrides,
  });
  return { callback, createThread, saveSettings, sendMessage, requestApproval };
}

describe('agent thread creation wiring', () => {
  it('inherits source context, queues the prompt, and returns identity without approval', async () => {
    const { callback, createThread, sendMessage, saveSettings, requestApproval } = setup();
    await expect(callback({ prompt: 'Investigate auth' })).resolves.toEqual({
      threadId: 'thread-1',
      title: 'Created',
    });
    expect(createThread).toHaveBeenCalledWith('Investigate auth', '/source/repo', 'project-1');
    expect(sendMessage).toHaveBeenCalledWith('thread-1', 'Investigate auth');
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('treats explicit values equal to the source (including trailing slash) as in-project', async () => {
    const { callback, createThread, requestApproval } = setup();
    await callback({ prompt: 'Same place', projectId: 'project-1', cwd: '/source/repo/' });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(createThread).toHaveBeenCalledWith('Same place', '/source/repo/', 'project-1');
  });

  it('asks for approval when targeting a different project, then creates and sends', async () => {
    const { callback, createThread, sendMessage, requestApproval } = setup();
    await expect(callback({ prompt: 'Fix bug\nmore detail', projectId: 'project-2', cwd: '/geode' })).resolves.toEqual({
      threadId: 'thread-1',
      title: 'Created',
    });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    const [toolName, detail] = requestApproval.mock.calls[0]!;
    expect(toolName).toBe(CROSS_PROJECT_SPAWN_TOOL);
    expect(detail).toContain('Geode');
    expect(detail).toContain('/geode');
    expect(detail).toContain('Fix bug');
    expect(detail).not.toContain('more detail');
    expect(createThread).toHaveBeenCalledWith('Fix bug', '/geode', 'project-2');
    expect(sendMessage).toHaveBeenCalledWith('thread-1', 'Fix bug\nmore detail');
  });

  it('asks for approval when clearing the project with projectId: null', async () => {
    const { callback, requestApproval } = setup();
    await callback({ prompt: 'Independent', projectId: null });
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('falls back to the project id when the name is unresolvable', async () => {
    const { callback, requestApproval } = setup();
    await callback({ prompt: 'x', projectId: 'project-9' });
    expect(requestApproval.mock.calls[0]![1]).toContain('project-9');
  });

  it('asks for approval when only the cwd differs', async () => {
    const { callback, requestApproval, createThread } = setup();
    await callback({ prompt: 'Other dir', cwd: '/elsewhere' });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(createThread).toHaveBeenCalledWith('Other dir', '/elsewhere', 'project-1');
  });

  it('rejects a denied cross-project spawn before creating, saving, or sending anything', async () => {
    const { callback, createThread, saveSettings, sendMessage, requestApproval } = setup();
    requestApproval.mockResolvedValue(false);
    await expect(callback({ prompt: 'Nope', projectId: 'project-2' })).rejects.toThrow(
      'Cross-project spawn was denied by the user.',
    );
    expect(createThread).not.toHaveBeenCalled();
    expect(saveSettings).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('fails closed when cross-project and no approval dependency is supplied', async () => {
    const { callback, createThread, saveSettings, sendMessage } = setup({ requestApproval: undefined });
    await expect(callback({ prompt: 'Nope', cwd: '/elsewhere' })).rejects.toThrow(
      'Cross-project spawn was denied by the user.',
    );
    expect(createThread).not.toHaveBeenCalled();
    expect(saveSettings).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('lets the coordination-scope rejection win before any approval prompt', async () => {
    const { callback, requestApproval, createThread } = setup({ authorizeProject: () => false });
    await expect(callback({ prompt: 'Out of scope', projectId: 'project-2' })).rejects.toThrow(
      'Requested Project is outside coordination scope.',
    );
    expect(requestApproval).not.toHaveBeenCalled();
    expect(createThread).not.toHaveBeenCalled();
  });
});

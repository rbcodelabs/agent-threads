import { describe, expect, it, vi } from 'vitest';
import { dispatchNewConversation } from '../../src/newConversationDispatch';

vi.mock('obsidian', () => ({ Notice: class {} }));

describe('dispatchNewConversation: the new composer\'s remote create carries the chosen harness', () => {
  const input = { restoreFailedDraft: vi.fn() } as never;
  const deps = (dispatchNewThread = vi.fn(async () => 't1')) => ({
    app: {} as never, settings: { escalationEnabled: false, escalationKeyword: '' }, dispatchNewThread, input,
  });

  it.each(['claude', 'codex', 'opencode'] as const)('forwards %s and the daemon folder to dispatchNewThread', async (agentHarness) => {
    const dispatch = vi.fn(async () => 't1');
    const id = await dispatchNewConversation(deps(dispatch), { text: 'do it', images: [], attachment: null, agentHarness, remote: { daemonId: 'box', cwd: '/srv/w' } } as never);
    expect(id).toBe('t1');
    const call = dispatch.mock.calls[0] as unknown as unknown[];
    expect(call[0]).toBe('do it');
    expect(call[3]).toMatchObject({ agentHarness, remote: { daemonId: 'box', cwd: '/srv/w' } });
  });
});

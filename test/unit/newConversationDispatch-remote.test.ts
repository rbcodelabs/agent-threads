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

  it('forwards the model and permission mode chosen in the settings popover; a /model directive wins', async () => {
    const dispatch = vi.fn(async () => 't1');
    await dispatchNewConversation(deps(dispatch), { text: 'do it', images: [], attachment: null, model: 'opus', permissionMode: 'plan' } as never);
    expect((dispatch.mock.calls[0] as unknown as unknown[])[3]).toMatchObject({ model: 'opus', permissionMode: 'plan' });
    const second = vi.fn(async () => 't2');
    await dispatchNewConversation(deps(second), { text: '/model sonnet fix it', images: [], attachment: null, model: 'opus' } as never);
    expect((second.mock.calls[0] as unknown as unknown[])[3]).toMatchObject({ model: expect.stringMatching(/sonnet/i) });
  });

  it('adds neither key when nothing was chosen', async () => {
    const dispatch = vi.fn(async () => 't1');
    await dispatchNewConversation(deps(dispatch), { text: 'do it', images: [], attachment: null } as never);
    const opts = (dispatch.mock.calls[0] as unknown as unknown[])[3] as Record<string, unknown>;
    expect('model' in opts).toBe(false);
    expect('permissionMode' in opts).toBe(false);
  });
});

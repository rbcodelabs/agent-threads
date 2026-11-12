import { describe, expect, it, vi } from 'vitest';

const ctor = vi.fn();
vi.mock('../../src/DispatchInput', async (orig) => {
  const actual = await orig<typeof import('../../src/DispatchInput')>();
  return {
    ...actual,
    DispatchInput: class {
      constructor(options: unknown) { ctor(options); }
      mount() {}
    },
  };
});

import { ThreadsView } from '../../src/ThreadsView';

// The thread composer and the new-conversation (Dispatch) composer must offer
// the same /skill list. The new composer previously received no
// extraSkillDirs, so typing "/" only listed ~/.claude/skills and built-ins.
describe('ThreadsView new-conversation composer', () => {
  it('passes the shared extra skill dirs to DispatchInput', () => {
    const dirs = [{ dir: '/vault/Skills', prefix: 'local' }, { dir: '/src/skills' }];
    const host = {
      app: {},
      plugin: { settings: {} },
      computeExtraSkillDirs: vi.fn(() => dirs),
      refreshNewConversationContext: vi.fn(),
    };
    const panel = { createDiv: () => ({}) } as unknown as HTMLElement;
    (ThreadsView.prototype as unknown as { buildNewConversationComposer(this: unknown, p: HTMLElement): void })
      .buildNewConversationComposer.call(host, panel);

    expect(host.computeExtraSkillDirs).toHaveBeenCalledTimes(1);
    expect(ctor).toHaveBeenCalledTimes(1);
    expect((ctor.mock.calls[0][0] as { extraSkillDirs?: unknown }).extraSkillDirs).toBe(dirs);
  });
});

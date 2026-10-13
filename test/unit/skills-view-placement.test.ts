import { describe, expect, it, vi } from 'vitest';
import ClaudeThreadsPlugin from '../../src/main';

const SKILLS_VIEW_TYPE = 'claude-threads:skills';

function pluginWithWorkspace(workspace: unknown, conversationFirst = false): ClaudeThreadsPlugin {
  const plugin = Object.create(ClaudeThreadsPlugin.prototype) as ClaudeThreadsPlugin;
  Object.defineProperty(plugin, 'app', { value: { workspace } });
  Object.defineProperty(plugin, 'isConversationFirst', { value: () => conversationFirst });
  return plugin;
}

describe('Skills Manager placement', () => {
  it('opens a new Skills Manager in a main-area tab in classic mode', async () => {
    const leaf = { setViewState: vi.fn().mockResolvedValue(undefined) };
    const workspace = {
      getLeavesOfType: vi.fn().mockReturnValue([]),
      getLeaf: vi.fn().mockReturnValue(leaf),
      getLeftLeaf: vi.fn(),
      revealLeaf: vi.fn(),
    };

    await pluginWithWorkspace(workspace, false).activateSkillsView();

    expect(workspace.getLeaf).toHaveBeenCalledWith('tab');
    expect(workspace.getLeftLeaf).not.toHaveBeenCalled();
    expect(leaf.setViewState).toHaveBeenCalledWith({
      type: SKILLS_VIEW_TYPE,
      active: true,
    });
    expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf);
  });

  it('opens a new Skills Manager in the left sidebar in conversation-first mode', async () => {
    const leaf = { setViewState: vi.fn().mockResolvedValue(undefined) };
    const workspace = {
      getLeavesOfType: vi.fn().mockReturnValue([]),
      getLeaf: vi.fn(),
      getLeftLeaf: vi.fn().mockReturnValue(leaf),
      revealLeaf: vi.fn(),
    };

    await pluginWithWorkspace(workspace, true).activateSkillsView();

    expect(workspace.getLeftLeaf).toHaveBeenCalledWith(false);
    expect(workspace.getLeaf).not.toHaveBeenCalled();
    expect(leaf.setViewState).toHaveBeenCalledWith({
      type: SKILLS_VIEW_TYPE,
      active: true,
    });
    expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf);
  });

  it('reveals an existing Skills Manager without creating or relocating it, regardless of placement', async () => {
    for (const conversationFirst of [false, true]) {
      const existingLeaf = { setViewState: vi.fn() };
      const workspace = {
        getLeavesOfType: vi.fn().mockReturnValue([existingLeaf]),
        getLeaf: vi.fn(),
        getLeftLeaf: vi.fn(),
        revealLeaf: vi.fn(),
      };

      await pluginWithWorkspace(workspace, conversationFirst).activateSkillsView();

      expect(workspace.getLeaf).not.toHaveBeenCalled();
      expect(workspace.getLeftLeaf).not.toHaveBeenCalled();
      expect(existingLeaf.setViewState).not.toHaveBeenCalled();
      expect(workspace.revealLeaf).toHaveBeenCalledWith(existingLeaf);
    }
  });
});

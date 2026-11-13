/**
 * @vitest-environment jsdom
 *
 * B2 (QA on 926c51bd): a link opened from the dock sheet must ALWAYS reach a browser. The old build always used the system
 * browser; the Web Viewer / context-panel path throws a plain Error ("chat must be open") when no chat leaf exists, and
 * only ContextPanelViewError used to fall back. ANY failure of that path now falls back, and nothing throws out.
 */
import '../setup/obsidian-dom';
import { describe, expect, it, vi } from 'vitest';
import { createDockMessageHostDeps } from '../../src/dockMessageHost';

function make(over: { conversationFirst?: boolean; webViewer?: boolean; setViewStateInNewTab?: () => Promise<void>; openWebViewer?: () => void } = {}) {
  const app = {
    vault: { getAbstractFileByPath: () => null, adapter: {} },
    internalPlugins: { plugins: { webviewer: { enabled: over.webViewer ?? true } } },
    commands: { executeCommandById: () => { throw new Error('no webviewer command'); } },
    workspace: { getLeaf: () => { throw new Error('no leaf'); } },
  };
  const plugin = {
    settings: {},
    isConversationFirst: () => over.conversationFirst ?? true,
    contextPanel: { setViewStateInNewTab: over.setViewStateInNewTab ?? (async () => { throw new Error('Agent Threads chat must be open before contextual content can be shown.'); }) },
  };
  const openSystem = vi.fn();
  const deps = createDockMessageHostDeps(app as never, plugin as never, { getThread: () => undefined }, { openSystem });
  return { deps, openSystem };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('dock sheet: opening an http(s) link', () => {
  it('falls back to the system browser when the context panel throws a PLAIN Error (no chat leaf open)', async () => {
    const t = make();
    t.deps.openExternal!('https://example.com/x', false);
    await settle();
    expect(t.openSystem).toHaveBeenCalledWith('https://example.com/x');
  });

  it('Cmd/Ctrl-click always uses the system browser', async () => {
    const t = make();
    t.deps.openExternal!('https://example.com/x', true);
    await settle();
    expect(t.openSystem).toHaveBeenCalledWith('https://example.com/x');
  });

  it('falls back when the Web Viewer path itself throws (not conversation-first)', async () => {
    const t = make({ conversationFirst: false });
    expect(() => t.deps.openExternal!('https://example.com/y', false)).not.toThrow();
    await settle();
    expect(t.openSystem).toHaveBeenCalledWith('https://example.com/y');
  });

  it('opens in the context panel when it works (no system browser)', async () => {
    const set = vi.fn(async () => {});
    const t = make({ setViewStateInNewTab: set });
    t.deps.openExternal!('https://example.com/z', false);
    await settle();
    expect(set).toHaveBeenCalled();
    expect(t.openSystem).not.toHaveBeenCalled();
  });
});

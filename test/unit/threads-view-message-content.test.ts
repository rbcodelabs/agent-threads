// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ThreadsView } from '../../src/ThreadsView';
import { MessageContentProviderRegistry, formatMessageContentReference } from '../../src/MessageContent';
import { MessageContentMountManager } from '../../src/messageContentRenderer';

describe('transcript origin for inline content', () => {
  it('hydrates only a matching assistant transcript message, not ancillary/user/tool text', async () => {
    const content = formatMessageContentReference({ providerId: 'example.cards', id: 'one', schemaVersion: 1, title: 'Reference', data: {} });
    const registry = new MessageContentProviderRegistry();
    const present = vi.fn(() => ({ kind: 'card' as const, title: 'Hydrated' }));
    registry.register({ pluginId: 'example' }, { providerId: 'example.cards', present });
    const mounts = new MessageContentMountManager(registry, { openView: async () => 'tab' });
    const view = Object.create(ThreadsView.prototype);
    Object.assign(view, {
      activeThreadId: 'thread', messageContentController: new AbortController(), messageContentManager: mounts,
      plugin: { settings: { enableInlineVisualizations: false } },
      manager: { getThread: () => ({ messages: [{ id: 'assistant', role: 'assistant', content }, { id: 'user', role: 'user', content }] }) },
    });
    const el = document.createElement('div'); document.body.appendChild(el);
    for (const options of [{}, { messageId: 'user' }, { messageId: 'tool' }]) {
      await view.renderMarkdown(content, el, options);
      expect(el.textContent).toContain('agent-content'); el.replaceChildren();
    }
    expect(present).not.toHaveBeenCalled();
    await view.renderMarkdown(content, el, { messageId: 'assistant' });
    await vi.waitFor(() => expect(el.textContent).toContain('Hydrated'));
    expect(present).toHaveBeenCalledOnce();
    mounts.dispose(); el.remove();
  });
});

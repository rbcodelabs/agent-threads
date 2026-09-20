import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystemAdapter } from 'obsidian';
import ClaudeThreadsPlugin from '../../src/main';
import type { Thread } from '../../src/types';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('design mode host callback', () => {
  it('creates and reuses the calling thread artifact even when another thread is selected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'design-host-'));
    roots.push(root);
    const adapter = new FileSystemAdapter();
    adapter.getBasePath = () => root;
    const caller = { id: 'caller' } as Thread;
    const selected = { id: 'selected' } as Thread;
    const plugin = Object.create(ClaudeThreadsPlugin.prototype);
    const openView = vi.fn(async () => 'tab' as const);
    const view = {
      refreshArtifactCard: vi.fn(),
      artifactActionHost: vi.fn(() => ({ openView, revealInFolder: vi.fn(async () => true), updateArtifact: vi.fn(async () => {}) })),
    };
    Object.assign(plugin, {
      app: { vault: { adapter } }, settings: { permissionMode: 'default' },
      manager: { getThread: (id: string) => id === 'caller' ? caller : selected, sendMessage: vi.fn() },
      getActiveThreadId: () => selected.id,
      getView: () => view,
      openThreadInChatView: vi.fn(async () => {}),
      saveSettings: vi.fn(async () => {}),
    });
    const first = await plugin.enterDesignMode('caller', 'Settings');
    expect(first.created).toBe(true);
    expect(selected.artifacts).toBeUndefined();
    expect(caller.artifacts).toHaveLength(1);
    expect(await readFile(first.artifact.manifestPath, 'utf8')).toContain('"createdByThreadId": "caller"');
    expect(plugin.openThreadInChatView).toHaveBeenCalledWith('caller');
    expect(view.refreshArtifactCard).toHaveBeenCalledOnce();
    expect(plugin.manager.sendMessage).not.toHaveBeenCalled();
    expect((await plugin.enterDesignMode('caller', 'Revise')).created).toBe(false);
    caller.permissionMode = 'plan';
    await expect(plugin.enterDesignMode('caller', 'Blocked')).rejects.toThrow('Plan mode');
  });

  it('rejects non-filesystem hosts clearly', async () => {
    const plugin = Object.create(ClaudeThreadsPlugin.prototype);
    plugin.app = { vault: { adapter: {} } };
    await expect(plugin.enterDesignMode('caller', 'Brief')).rejects.toThrow('desktop vault');
  });
});

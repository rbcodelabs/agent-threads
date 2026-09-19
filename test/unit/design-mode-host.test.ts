import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystemAdapter } from 'obsidian';
import ClaudeThreadsPlugin from '../../src/main';
import { ThreadsView } from '../../src/ThreadsView';
import { ArtifactProviderRegistry } from '../../src/ArtifactContributions';
import { createArtifactStore } from '../../src/artifactStore';
import { createClaudeThreadsApiV1 } from '../../src/PublicApi';
import { createDesignArtifactContribution, DESIGN_PROVIDER_OWNER } from '../../src/designArtifactProvider';
import type { Thread } from '../../src/types';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/**
 * Wires the plugin the way `registerPublicApi` does, so the design entry under
 * test reaches the artifact only through public API v1 — no view handle, no
 * registry handle, no manager handle. Anything the built-in needs here, a peer
 * can also reach; that equivalence is the whole point of ADR-0008.
 */
function wireDesignHost(root: string, threads: Record<string, Thread>) {
  const adapter = new FileSystemAdapter();
  adapter.getBasePath = () => root;
  const plugin = Object.create(ClaudeThreadsPlugin.prototype);
  const openView = vi.fn(async () => 'tab' as const);
  const artifactProviders = new ArtifactProviderRegistry();

  const view = Object.create(ThreadsView.prototype);
  Object.assign(view, {
    plugin,
    manager: { getThread: (id: string) => threads[id] },
    refreshArtifactCard: vi.fn(),
    // The card is DOM-bound and irrelevant here; the action path under test is
    // the real prototype method above it.
    renderArtifactCard: vi.fn(),
    openArtifactView: openView,
    revealArtifactPath: vi.fn(async () => true),
  });

  Object.assign(plugin, {
    app: { vault: { adapter } }, settings: { permissionMode: 'default' },
    manager: { vaultRoot: root, getThread: (id: string) => threads[id], sendMessage: vi.fn() },
    artifactProviders,
    getActiveThreadId: () => 'selected',
    getView: () => view,
    openThreadInChatView: vi.fn(async () => {}),
    saveSettings: vi.fn(async () => {}),
  });

  const service = createClaudeThreadsApiV1({
    getThreads: () => [], getThread: (id: string) => threads[id], isRunning: () => false,
    createThread: () => ({ id: 'x' }), sendMessage: async () => {}, openThread: async () => {},
    subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null,
    triggerHostEvent: () => {},
    artifactProviders,
    artifactStore: createArtifactStore({
      vaultRoot: () => root,
      getThread: (id: string) => threads[id],
      saveSettings: () => plugin.saveSettings(),
      invokeAction: (threadId, artifactId, actionId) => plugin.getView()?.invokeArtifactAction(threadId, artifactId, actionId),
      onChanged: () => plugin.getView()?.refreshArtifactCard(),
    }),
  } as never);
  service.api.extensions.registerArtifactProvider(DESIGN_PROVIDER_OWNER, createDesignArtifactContribution());
  plugin.api = Object.freeze({ v1: service.api });
  return { plugin, view, openView, api: service.api };
}

describe('design mode host callback', () => {
  it('creates and reuses the calling thread artifact even when another thread is selected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'design-host-'));
    roots.push(root);
    const caller = { id: 'caller' } as Thread;
    const selected = { id: 'selected' } as Thread;
    const { plugin, view, openView } = wireDesignHost(root, { caller, selected });

    const first = await plugin.enterDesignMode('caller', 'Settings');
    expect(first.created).toBe(true);
    expect(first.preview).toEqual({ status: 'opened' });
    expect(selected.artifacts).toBeUndefined();
    expect(caller.artifacts).toHaveLength(1);
    expect(await readFile(first.artifact.manifestPath, 'utf8')).toContain('"createdByThreadId": "caller"');
    expect(plugin.openThreadInChatView).toHaveBeenCalledWith('caller');
    expect(view.refreshArtifactCard).toHaveBeenCalledOnce();
    // Preview went through the provider's named action, not a privileged call.
    expect(openView).toHaveBeenCalledWith({ type: 'geode-artifact', state: { root: first.artifact.root } });
    expect(plugin.manager.sendMessage).not.toHaveBeenCalled();
    expect((await plugin.enterDesignMode('caller', 'Revise')).created).toBe(false);
    // Re-entry is idempotent on artifact id: one card, not two.
    expect(caller.artifacts).toHaveLength(1);
    caller.permissionMode = 'plan';
    await expect(plugin.enterDesignMode('caller', 'Blocked')).rejects.toThrow('Plan mode');
  });

  it('attaches host-owned identity and a validated storage root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'design-host-'));
    roots.push(root);
    const caller = { id: 'caller' } as Thread;
    const { plugin, api } = wireDesignHost(root, { caller });

    const { artifact } = await plugin.enterDesignMode('caller', 'Settings');
    const [attached] = await api.artifacts.list('caller');
    expect(attached).toMatchObject({ providerId: 'agent-threads.design', kind: 'design-static', schemaVersion: 1 });
    // The host stores the *resolved* root (macOS /var is a symlink to
    // /private/var), because that is the path it would later delete.
    expect(attached.storageRoot).toBe(await realpath(artifact.root));
    expect((await stat(artifact.root)).isDirectory()).toBe(true);
  });

  it('keeps the durable artifact when the preview cannot be placed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'design-host-'));
    roots.push(root);
    const caller = { id: 'caller' } as Thread;
    const { plugin, view } = wireDesignHost(root, { caller });
    // Host cannot place the view anywhere, and there is no source to reveal.
    Object.assign(view, { openArtifactView: async () => 'unavailable' as const, revealArtifactPath: async () => false });

    const result = await plugin.enterDesignMode('caller', 'Settings');
    expect(result.created).toBe(true);
    expect(result.preview.status).toBe('unavailable');
    expect(caller.artifacts).toHaveLength(1);
  });

  it('rejects non-filesystem hosts clearly', async () => {
    const plugin = Object.create(ClaudeThreadsPlugin.prototype);
    plugin.app = { vault: { adapter: {} } };
    await expect(plugin.enterDesignMode('caller', 'Brief')).rejects.toThrow('desktop vault');
  });
});

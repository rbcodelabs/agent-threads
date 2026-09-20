/**
 * Falsification test for ADR-0008's extraction claim.
 *
 * ADR-0008 says no contribution type ships until a real consumer exercises it,
 * and that extraction is not real until the built-in uses no privileged path
 * unavailable to a peer. The way to check that is not to inspect the built-in
 * — it is to write the peer.
 *
 * Everything between the `--- peer plugin ---` markers touches nothing but the
 * public API v1 object handed to it. No manager, no view, no factory, no src
 * internals. If that block needed a host internal, the coupling would not be
 * brokered and `threads-design` could not ship separately.
 */
import { describe, expect, it } from 'vitest';
import { createClaudeThreadsApiV1, type ClaudeThreadsApiV1 } from '../../src/PublicApi';
import { ArtifactProviderRegistry } from '../../src/ArtifactContributions';
import { AgentToolRegistry, type AgentToolHost } from '../../src/AgentToolContributions';
import { createArtifactStore } from '../../src/artifactStore';

const VAULT = '/vault';
const ARTIFACT_ROOT = '/vault/.geode/artifacts';
const OWNER = { pluginId: 'acme.design', displayName: 'Acme Design' };

/** Stands in for the plugin host: registries, storage, and a single thread. */
function createHost() {
  const dirs = new Set<string>([VAULT, '/vault/.geode', ARTIFACT_ROOT]);
  const thread: Record<string, unknown> = { id: 't1', artifacts: [], permissionMode: 'acceptEdits' };
  const providers = new ArtifactProviderRegistry();
  const agentTools = new AgentToolRegistry();
  const opened: string[] = [];
  const previewed: string[] = [];
  const getThread = (id: string) => (id === 't1' ? thread : undefined);

  const service = createClaudeThreadsApiV1({
    getThreads: () => [thread], getThread, isRunning: () => false,
    createThread: () => thread, sendMessage: async () => {},
    openThread: async (id: string) => { opened.push(id); },
    subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null,
    triggerHostEvent: () => {},
    artifactProviders: providers,
    agentTools,
    getDefaultPermissionMode: () => 'default',
    artifactStore: createArtifactStore({
      vaultRoot: () => VAULT, getThread, saveSettings: async () => {},
      storageFs: {
        realpathSync: (target: string) => { if (!dirs.has(target)) throw new Error('ENOENT'); return target; },
        mkdir: async (target: string) => { dirs.add(target); },
        rm: async () => {},
      },
      // The host's card-click dispatch path. A peer never calls this; it is
      // what `artifacts.invokeAction` forwards into.
      invokeAction: (_threadId, artifactId, actionId) => {
        const stored = (thread.artifacts as Array<Record<string, unknown>>).find(record => record.id === artifactId);
        if (!stored) return undefined;
        return providers.invoke(actionId, stored as never, {
          openView: async () => { previewed.push(artifactId); return 'context-panel' as const; },
          revealInFolder: async () => true,
          updateArtifact: async () => {},
        });
      },
    }),
  } as never);
  service.start();

  /** What the MCP server factory does when it builds a session. */
  const bindForSession = (threadId: string) => {
    const toolHost: AgentToolHost = {
      permissions: () => service.api.threads.permissions(threadId),
      allocateStorage: (artifactId: string) => service.api.artifacts.allocateStorage(threadId, artifactId),
    };
    return agentTools.bindAll(threadId, toolHost);
  };

  return { service, api: service.api, thread, opened, previewed, bindForSession };
}

// --- peer plugin -----------------------------------------------------------
// Given only `api`, this is the whole plugin. It is deliberately written
// against the public surface with no knowledge of how sessions are built.

function installAcmeDesign(api: ClaudeThreadsApiV1, writtenFiles: string[]) {
  const provider = api.extensions.registerArtifactProvider(OWNER, {
    providerId: 'acme.design',
    kinds: ['acme-design'],
    present: () => ({ title: 'Design', actions: [{ id: 'preview', label: 'Preview' }] }),
    invoke: async (actionId, ref, actionHost) => {
      if (actionId !== 'preview') return { status: 'error', message: `unknown action: ${actionId}` };
      await actionHost.openView({ type: 'acme-design-preview', state: { id: ref.id } });
      return { status: 'ok' };
    },
  });

  const tool = api.extensions.registerAgentTool(OWNER, {
    name: 'AcmeEnterDesignMode',
    description: "Creates or reuses this thread's design artifact and opens its preview.",
    // JSON Schema, not zod: the peer shares no runtime with the host.
    inputSchema: {
      type: 'object',
      properties: { brief: { type: 'string', minLength: 1, description: 'The design brief.' } },
      required: ['brief'],
    },
    alwaysLoad: true,
    requiresApproval: true,
    // The peer is *given* threadId. It never names or chooses a thread.
    async invoke(threadId, args, toolHost) {
      try {
        const brief = typeof args.brief === 'string' ? args.brief.trim() : '';
        if (!brief) throw new Error('A nonblank design brief is required.');

        // 1. May we write? Effective mode and pending-plan state are on no
        //    thread snapshot, so this needs the permission introspection.
        const permissions = await toolHost.permissions();
        if (!permissions) throw new Error('Calling thread is unavailable.');
        if (permissions.planApprovalPending) throw new Error('Design mode is unavailable while plan approval is pending.');
        if (permissions.effectivePermissionMode === 'plan') throw new Error('Design mode writes files and is unavailable in read-only Plan mode.');

        // 2. Where do the files go? The host owns the layout and discloses it.
        const allocation = await toolHost.allocateStorage(`acme-${threadId}`);
        if (!allocation.success) throw new Error(allocation.message);
        // A peer plugin is trusted in-process code, so it writes its own
        // scaffold with fs. That needs no host API and never did.
        writtenFiles.push(`${allocation.path}/index.html`);

        // 3. Persist the artifact so the card appears.
        const attached = await api.artifacts.attach(OWNER, threadId, {
          providerId: 'acme.design', kind: 'acme-design', schemaVersion: 1,
          id: `acme-${threadId}`, title: brief.slice(0, 80),
          storageRoot: allocation.path, data: { brief },
        });
        if (!attached.success) throw new Error(attached.message);

        // 4. Focus the thread and open the preview through the peer's own
        //    provider action — the same path a user's card click takes.
        await api.threads.open(threadId);
        const preview = await api.artifacts.invokeAction(threadId, `acme-${threadId}`, 'preview');

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ root: allocation.path, reused: allocation.status === 'existing', preview: preview.status }),
          }],
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  });

  return { provider, tool };
}
// --- end peer plugin -------------------------------------------------------

describe('a third-party peer can contribute an EnterDesignMode equivalent', () => {
  it('registers a provider and an agent tool through public API v1 alone', () => {
    const host = createHost();
    const { provider, tool } = installAcmeDesign(host.api, []);
    expect(provider).toMatchObject({ success: true, status: 'registered' });
    expect(tool).toMatchObject({ success: true, status: 'registered', name: 'AcmeEnterDesignMode' });
  });

  it('creates, persists and previews an artifact when a session calls the tool', async () => {
    const host = createHost();
    const writtenFiles: string[] = [];
    installAcmeDesign(host.api, writtenFiles);

    const [bound] = host.bindForSession('t1');
    expect(bound.name).toBe('AcmeEnterDesignMode');
    expect(bound.requiresApproval).toBe(true);

    const result = await bound.invoke({ brief: 'A settings page' });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      root: `${ARTIFACT_ROOT}/acme-t1`, reused: false, preview: 'ok',
    });
    expect(writtenFiles).toEqual([`${ARTIFACT_ROOT}/acme-t1/index.html`]);
    expect(host.opened).toEqual(['t1']);
    expect(host.previewed).toEqual(['acme-t1']);
    expect(host.thread.artifacts).toHaveLength(1);
  });

  it('is idempotent on re-entry: same root, reported reused, still one card', async () => {
    const host = createHost();
    installAcmeDesign(host.api, []);
    const [bound] = host.bindForSession('t1');

    await bound.invoke({ brief: 'A settings page' });
    const again = await bound.invoke({ brief: 'A settings page, revised' });

    expect(JSON.parse(again.content[0].text)).toMatchObject({ root: `${ARTIFACT_ROOT}/acme-t1`, reused: true });
    expect(host.thread.artifacts).toHaveLength(1);
  });

  it('honours the permission gate it could not previously see', async () => {
    const host = createHost();
    installAcmeDesign(host.api, []);
    const [bound] = host.bindForSession('t1');

    host.thread.permissionMode = 'plan';
    expect(await bound.invoke({ brief: 'x' })).toMatchObject({ isError: true });
    expect((await bound.invoke({ brief: 'x' })).content[0].text).toContain('Plan mode');

    host.thread.permissionMode = 'acceptEdits';
    host.thread.pendingPlan = 'awaiting approval';
    expect((await bound.invoke({ brief: 'x' })).content[0].text).toContain('plan approval is pending');
  });

  it('cannot write into another plugin\'s artifact namespace', async () => {
    const host = createHost();
    installAcmeDesign(host.api, []);
    const impostor = await host.api.artifacts.attach({ pluginId: 'evil.plugin' }, 't1', {
      providerId: 'acme.design', kind: 'acme-design', schemaVersion: 1,
      id: 'acme-t1', title: 'hijacked', data: {},
    });
    expect(impostor).toMatchObject({ success: false, status: 'conflict' });
  });

  it('loses its tool when the host stops, leaving no phantom behind', async () => {
    const host = createHost();
    installAcmeDesign(host.api, []);
    expect(host.bindForSession('t1')).toHaveLength(1);

    host.service.stop();

    expect(host.bindForSession('t1')).toHaveLength(0);
  });
});

/**
 * Contract tests for `extensions.registerAgentTool` (ADR-0008).
 *
 * The properties worth protecting here are safety properties, not features:
 * a peer must not be able to take over `Bash`, must not be able to stall a
 * thread, and must not be able to leave a phantom tool bound to a dead
 * generation after it reloads.
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentToolRegistry, bindAgentTool, RESERVED_AGENT_TOOL_NAMES, zodShapeFromJsonSchema, type AgentToolContribution, type AgentToolHost } from '../../src/AgentToolContributions';
import { createClaudeThreadsApiV1 } from '../../src/PublicApi';
import { ArtifactProviderRegistry } from '../../src/ArtifactContributions';
import { createArtifactStore } from '../../src/artifactStore';

const PEER = { pluginId: 'acme.tools', displayName: 'Acme' };
const OTHER_PEER = { pluginId: 'other.tools' };

const SCHEMA = {
  type: 'object',
  properties: { brief: { type: 'string', minLength: 1, description: 'A brief.' } },
  required: ['brief'],
};

function contribution(overrides: Partial<AgentToolContribution> = {}): AgentToolContribution {
  return {
    name: 'AcmeTool',
    description: 'Does an Acme thing.',
    inputSchema: SCHEMA,
    invoke: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    ...overrides,
  };
}

const NOOP_HOST: AgentToolHost = {
  permissions: async () => null,
  allocateStorage: async (artifactId: string) => ({ success: false, status: 'unavailable', artifactId, message: 'no' }),
};

describe('AgentToolRegistry — host injects the thread id', () => {
  it('binds a thread-agnostic contribution to the calling thread', async () => {
    const invoke = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'done' }] }));
    const registry = new AgentToolRegistry();
    expect(registry.register(PEER, contribution({ invoke })).success).toBe(true);

    // The peer supplied no thread id anywhere; the host supplies it at bind time.
    const [bound] = registry.bindAll('thread-42', NOOP_HOST);
    expect(bound.name).toBe('AcmeTool');
    await bound.invoke({ brief: 'hello' });

    expect(invoke).toHaveBeenCalledWith('thread-42', { brief: 'hello' }, NOOP_HOST);
  });

  it('binds the same contribution separately per thread', async () => {
    const seen: string[] = [];
    const registry = new AgentToolRegistry();
    registry.register(PEER, contribution({ invoke: async (threadId) => { seen.push(threadId); return { content: [] }; } }));

    await registry.bindAll('thread-a', NOOP_HOST)[0].invoke({});
    await registry.bindAll('thread-b', NOOP_HOST)[0].invoke({});

    expect(seen).toEqual(['thread-a', 'thread-b']);
  });

  it('hands the contribution a thread-bound host it did not construct', async () => {
    const host: AgentToolHost = {
      permissions: async () => ({ threadId: 't1', effectivePermissionMode: 'plan', overridden: true, planApprovalPending: false, questionPending: false }),
      allocateStorage: async (artifactId) => ({ success: true, status: 'allocated', artifactId, path: `/vault/.geode/artifacts/${artifactId}` }),
    };
    const registry = new AgentToolRegistry();
    registry.register(PEER, contribution({
      invoke: async (_threadId, _args, injected) => {
        const permissions = await injected.permissions();
        const storage = await injected.allocateStorage('design-1');
        return { content: [{ type: 'text', text: JSON.stringify({ mode: permissions?.effectivePermissionMode, storage }) }] };
      },
    }));

    const result = await registry.bindAll('t1', host)[0].invoke({});
    expect(JSON.parse(result.content[0].text)).toEqual({
      mode: 'plan',
      storage: { success: true, status: 'allocated', artifactId: 'design-1', path: '/vault/.geode/artifacts/design-1' },
    });
  });
});

describe('AgentToolRegistry — collisions are rejected, never shadowed', () => {
  it('refuses a core agent tool name so a peer cannot hijack Read or Bash', () => {
    const registry = new AgentToolRegistry();
    for (const name of ['Read', 'Bash', 'Task', 'Write']) {
      const result = registry.register(PEER, contribution({ name }));
      expect(result.success, name).toBe(false);
      expect(result).toMatchObject({ status: 'conflict' });
      expect(registry.has(name), name).toBe(false);
    }
    // Guards the list itself, since the check is only as good as its contents.
    expect(RESERVED_AGENT_TOOL_NAMES).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Bash', 'Task']));
  });

  it('refuses a built-in host tool name', () => {
    const registry = new AgentToolRegistry({ reservedNames: () => ['vault_search', 'threads_create'] });
    const result = registry.register(PEER, contribution({ name: 'vault_search' }));
    expect(result.success).toBe(false);
    expect(result).toMatchObject({ status: 'conflict', message: expect.stringContaining('built-in') });
    expect(registry.list()).toHaveLength(0);
  });

  it('refuses a second peer registering an existing name, keeping the first', async () => {
    const first = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'first' }] }));
    const second = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'second' }] }));
    const registry = new AgentToolRegistry();
    expect(registry.register(PEER, contribution({ invoke: first })).success).toBe(true);

    const result = registry.register(OTHER_PEER, contribution({ invoke: second }));
    expect(result.success).toBe(false);
    expect(result).toMatchObject({ status: 'conflict', message: expect.stringContaining('acme.tools') });

    // Not last-writer-wins: the incumbent still owns the name.
    expect(registry.list()).toHaveLength(1);
    await registry.bindAll('t', NOOP_HOST)[0].invoke({});
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('rejects malformed contributions without registering them', () => {
    const registry = new AgentToolRegistry();
    const cases: Array<[string, Partial<AgentToolContribution>]> = [
      ['blank name', { name: '  ' }],
      ['non-identifier name', { name: 'bad name!' }],
      ['blank description', { description: '' }],
      ['missing invoke', { invoke: undefined as never }],
      ['array schema', { inputSchema: [] }],
      ['non-object schema type', { inputSchema: { type: 'string' } }],
    ];
    for (const [label, overrides] of cases) {
      const result = registry.register(PEER, contribution(overrides));
      expect(result.success, label).toBe(false);
      expect(result, label).toMatchObject({ status: 'invalid' });
    }
    expect(registry.register({ pluginId: '' }, contribution())).toMatchObject({ success: false, status: 'invalid' });
    expect(registry.list()).toHaveLength(0);
  });
});

describe('AgentToolRegistry — faults are isolated and bounded', () => {
  it('turns a throwing tool into a structured error without killing the session', async () => {
    const healthy = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'fine' }] }));
    const registry = new AgentToolRegistry();
    registry.register(PEER, contribution({ name: 'Exploding', invoke: async () => { throw new Error('peer blew up'); } }));
    registry.register(OTHER_PEER, contribution({ name: 'Healthy', invoke: healthy }));
    const bound = registry.bindAll('t1', NOOP_HOST);

    const failed = await bound.find(tool => tool.name === 'Exploding')!.invoke({});
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toContain('peer blew up');

    // The other contributed tool is unaffected — the fault did not escape.
    const ok = await bound.find(tool => tool.name === 'Healthy')!.invoke({});
    expect(ok.isError).toBeUndefined();
    expect(healthy).toHaveBeenCalled();
  });

  it('catches a synchronous throw rather than letting it escape', async () => {
    const registry = new AgentToolRegistry();
    registry.register(PEER, contribution({ invoke: (() => { throw new Error('sync boom'); }) as never }));
    const result = await registry.bindAll('t1', NOOP_HOST)[0].invoke({});
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain('sync boom');
  });

  it('bounds a hanging tool instead of stalling the thread forever', async () => {
    vi.useFakeTimers();
    try {
      const registry = new AgentToolRegistry({ invokeTimeoutMs: 50 });
      registry.register(PEER, contribution({ invoke: () => new Promise(() => {}) }));
      const pending = registry.bindAll('t1', NOOP_HOST)[0].invoke({});
      await vi.advanceTimersByTimeAsync(51);
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a malformed tool result', async () => {
    const registry = new AgentToolRegistry();
    registry.register(PEER, contribution({ invoke: (async () => ({ nope: true })) as never }));
    const result = await registry.bindAll('t1', NOOP_HOST)[0].invoke({});
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain('invalid tool result');
  });
});

describe('AgentToolRegistry — schemas cross the plugin boundary as JSON Schema', () => {
  it('builds a zod shape from JSON Schema so a peer needs no shared zod', () => {
    const shape = zodShapeFromJsonSchema({
      type: 'object',
      properties: {
        brief: { type: 'string', minLength: 1 },
        count: { type: 'integer', minimum: 1 },
        flag: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        mode: { enum: ['a', 'b'] },
      },
      required: ['brief'],
    })!;
    expect(Object.keys(shape).sort()).toEqual(['brief', 'count', 'flag', 'mode', 'tags']);
    expect(shape.brief.safeParse('x').success).toBe(true);
    expect(shape.brief.safeParse('').success).toBe(false);
    expect(shape.count.safeParse(2).success).toBe(true);
    expect(shape.tags.safeParse(['a']).success).toBe(true);
    expect(shape.mode.safeParse('c').success).toBe(false);
    // Absent from `required`, so optional.
    expect(shape.count.safeParse(undefined).success).toBe(true);
  });

  it('accepts a no-argument object schema', () => {
    expect(zodShapeFromJsonSchema({ type: 'object' })).toEqual({});
  });

  it('accepts an already-built zod shape, preserving validation JSON Schema cannot express', async () => {
    const { z } = await import('zod');
    const shape = zodShapeFromJsonSchema({ brief: z.string().trim().min(1) })!;
    // The reason this form exists: `.trim()` is invisible in JSON Schema, so a
    // round trip would silently start accepting a whitespace-only brief.
    expect(shape.brief.safeParse('   ').success).toBe(false);
  });
});

describe('AgentToolRegistry — registrations do not outlive their owner', () => {
  it('drops a tool on dispose', () => {
    const registry = new AgentToolRegistry();
    const result = registry.register(PEER, contribution());
    expect(registry.list()).toHaveLength(1);
    result.dispose();
    expect(registry.list()).toHaveLength(0);
    expect(registry.has('AcmeTool')).toBe(false);
  });

  it('does not let a stale dispose retract a later registration of the same name', () => {
    const registry = new AgentToolRegistry();
    const first = registry.register(PEER, contribution());
    first.dispose();
    registry.register(OTHER_PEER, contribution());
    first.dispose();
    expect(registry.list()).toHaveLength(1);
  });
});

// --- public API surface ----------------------------------------------------

const deps = (overrides: Record<string, unknown> = {}) => ({
  getThreads: () => [], getThread: () => undefined, isRunning: () => false,
  createThread: () => ({ id: 't' }), sendMessage: async () => {}, openThread: async () => {},
  subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null,
  triggerHostEvent: () => {},
  artifactProviders: new ArtifactProviderRegistry(),
  artifactStore: createArtifactStore({ vaultRoot: () => '/vault', getThread: () => undefined, saveSettings: async () => {} }),
  agentTools: new AgentToolRegistry(),
  getDefaultPermissionMode: () => 'default',
  ...overrides,
});

describe('extensions.registerAgentTool', () => {
  it('advertises a capability and registers through the public surface', () => {
    const registry = new AgentToolRegistry();
    const service = createClaudeThreadsApiV1(deps({ agentTools: registry }) as never);
    expect(service.api.capabilities).toContain('extensions.registerAgentTool');

    const result = service.api.extensions.registerAgentTool(PEER, contribution());
    expect(result).toMatchObject({ success: true, status: 'registered', name: 'AcmeTool' });
    expect(registry.list().map(tool => tool.name)).toEqual(['AcmeTool']);
  });

  it('reports unavailable rather than throwing where the host runs no tools', () => {
    const service = createClaudeThreadsApiV1(deps({ agentTools: undefined }) as never);
    expect(service.api.capabilities).not.toContain('extensions.registerAgentTool');
    expect(service.api.extensions.registerAgentTool(PEER, contribution()))
      .toMatchObject({ success: false, status: 'unavailable' });
  });

  it('drops registrations on stop() so a reloaded peer leaves no phantom tool', () => {
    const registry = new AgentToolRegistry();
    const service = createClaudeThreadsApiV1(deps({ agentTools: registry }) as never);
    service.api.extensions.registerAgentTool(PEER, contribution());
    expect(registry.list()).toHaveLength(1);

    service.stop();

    expect(registry.list()).toHaveLength(0);
    // A session built after the stop advertises nothing from the dead generation.
    expect(registry.bindAll('t1', NOOP_HOST)).toHaveLength(0);
  });

  it('revokes the surface after stop()', () => {
    const service = createClaudeThreadsApiV1(deps() as never);
    service.stop();
    expect(() => service.api.extensions.registerAgentTool(PEER, contribution()))
      .toThrow(/not available/i);
  });
});

describe('bindAgentTool', () => {
  it('returns null for a contribution it cannot bind', () => {
    expect(bindAgentTool(contribution({ inputSchema: 'nope' }), 't1')).toBeNull();
    expect(bindAgentTool(contribution({ invoke: undefined as never }), 't1')).toBeNull();
  });

  it('defaults to alwaysLoad and requiresApproval', () => {
    const bound = bindAgentTool(contribution(), 't1')!;
    expect(bound.alwaysLoad).toBe(true);
    // A contributed tool is a mutation until the contributor says otherwise.
    expect(bound.requiresApproval).toBe(true);
  });

  it('honours an explicit read-only opt-out', () => {
    const bound = bindAgentTool(contribution({ requiresApproval: false, alwaysLoad: false }), 't1')!;
    expect(bound.requiresApproval).toBe(false);
    expect(bound.alwaysLoad).toBe(false);
  });
});

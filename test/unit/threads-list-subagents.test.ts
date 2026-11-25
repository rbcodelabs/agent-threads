import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools }),
}));

import { AgentRunStore } from '../../src/agentRuns/AgentRunStore';
import {
  buildSubagentList,
  classifySubagentStatus,
  MAX_SUBAGENTS,
  MAX_SUBAGENT_TEXT,
} from '../../src/agentRuns/subagentSnapshot';
import { createClaudeThreadsMcpServers } from '../../src/ObsidianTools';
import { LEGACY_TO_CANONICAL_TOOL_NAMES, TOOL_NAMES_BY_DOMAIN, BUILT_IN_TOOL_ORDER } from '../../src/tools/toolNames';
import { createThreadTools } from '../../src/tools/threads';
import { isTrustedBuiltInTool } from '../../src/toolNameUtils';
import { NEVER_OFFERED, domainOf } from '../../src/toolRouting';
import type { AgentRun, AgentRunStatus } from '../../src/types';

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;

const TOOL = 'threads_list_subagents';
const call = async (tools: Record<string, unknown>, args: Record<string, unknown> = {}) => {
  const res = await (tools[TOOL] as { handler: Handler }).handler(args, {});
  return { res, body: JSON.parse(res.content[0]!.text!) };
};

/** Tools bound to one thread over an in-memory store, exactly as main.ts binds them. */
const toolsFor = (store: AgentRunStore, threadId: string) =>
  createThreadTools({ options: { threadId, getAgentRuns: id => store.getByThread(id) } });

const baseRun = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: 'run-1', threadId: 't', nativeAgentId: 'native-1', harness: 'claude', description: 'd',
  status: 'working', startedAt: 1, updatedAt: 2,
  capabilities: { viewTranscript: true, sendMessage: false, interrupt: false }, events: [], ...over,
});

describe('threads_list_subagents', () => {
  it('rediscovers a forgotten subagent id from nothing but the thread binding', async () => {
    const store = new AgentRunStore();
    const started = store.observeStart({
      threadId: 'parent', harness: 'claude', nativeAgentId: 'a7f3c2d1', taskId: 'task-9',
      description: 'Audit the auth module', role: 'general-purpose', model: 'sonnet',
    }, 1000);

    // The "parent" has no memory of the id: the only input is its own thread binding.
    const { res, body } = await call(toolsFor(store, 'parent'));
    expect(res.isError).toBeUndefined();
    expect(body.count).toBe(1);
    const [agent] = body.subagents;
    expect(agent.nativeAgentId).toBe('a7f3c2d1'); // the SendMessage / TaskStop target
    expect(agent.id).toBe(started.id);
    expect(agent.taskId).toBe('task-9');
    expect(agent.description).toBe('Audit the auth module');
    expect(agent.role).toBe('general-purpose');
    expect(agent.model).toBe('sonnet');
    expect(agent.status).toBe('working');
    expect(agent.statusKnown).toBe(true);
    expect(agent.startedAt).toBe(1000);
  });

  it('returns an empty list, not an error, for a thread with no agent runs', async () => {
    const { res, body } = await call(toolsFor(new AgentRunStore(), 'lonely'));
    expect(res.isError).toBeUndefined();
    expect(body).toEqual({ threadId: 'lonely', count: 0, truncated: false, total: 0, subagents: [] });
  });

  it('only returns the calling thread\'s runs and ignores a foreign thread id argument', async () => {
    const store = new AgentRunStore();
    store.observeStart({ threadId: 'A', harness: 'claude', nativeAgentId: 'a-native', description: 'A work' }, 10);
    store.observeStart({ threadId: 'B', harness: 'claude', nativeAgentId: 'b-native', description: 'B work' }, 20);

    const a = (await call(toolsFor(store, 'A'))).body;
    const b = (await call(toolsFor(store, 'B'))).body;
    expect(a.subagents.map((s: { nativeAgentId: string }) => s.nativeAgentId)).toEqual(['a-native']);
    expect(a.subagents.map((s: { description: string }) => s.description)).toEqual(['A work']);
    expect(b.subagents.map((s: { nativeAgentId: string }) => s.nativeAgentId)).toEqual(['b-native']);
    expect(JSON.stringify(a)).not.toContain('B work');
    expect(JSON.stringify(b)).not.toContain('A work');

    // The tool declares no input at all, so there is no parameter that could name another thread...
    expect((toolsFor(store, 'A')[TOOL] as unknown as { inputSchema: object }).inputSchema).toEqual({});
    // ...and extra arguments a caller sends anyway are ignored.
    const forged = (await call(toolsFor(store, 'A'), { threadId: 'B', elevatedProjectId: 'x' })).body;
    expect(forged.threadId).toBe('A');
    expect(forged.subagents.map((s: { nativeAgentId: string }) => s.nativeAgentId)).toEqual(['a-native']);
  });

  it('defends in depth: a runs source that leaks another thread\'s run is filtered', () => {
    const list = buildSubagentList('A', [baseRun({ id: 'x', threadId: 'A' }), baseRun({ id: 'y', threadId: 'B', description: 'secret' })]);
    expect(list.subagents.map(s => s.id)).toEqual(['x']);
    expect(JSON.stringify(list)).not.toContain('secret');
  });

  it('maps stored lifecycle statuses faithfully and reports anything else as unknown', () => {
    const known: AgentRunStatus[] = ['starting', 'working', 'waiting', 'completed', 'failed', 'interrupted'];
    for (const status of known) {
      expect(classifySubagentStatus(status)).toEqual({ status, statusKnown: true });
    }
    for (const bad of ['unavailable', 'exploded', '', undefined, null, 7]) {
      expect(classifySubagentStatus(bad)).toEqual({ status: 'unknown', statusKnown: false });
    }

    const runs = [...known, 'unavailable', 'exploded'].map((status, i) =>
      baseRun({ id: `r${i}`, nativeAgentId: `n${i}`, status: status as AgentRunStatus, updatedAt: 100 - i }));
    const byNative = Object.fromEntries(buildSubagentList('t', runs).subagents.map(s => [s.nativeAgentId, s]));
    known.forEach((status, i) => {
      expect(byNative[`n${i}`]).toMatchObject({ status, statusKnown: true, storedStatus: status });
    });
    expect(byNative.n6).toMatchObject({ status: 'unknown', statusKnown: false, storedStatus: 'unavailable' });
    expect(byNative.n7).toMatchObject({ status: 'unknown', statusKnown: false, storedStatus: 'exploded' });
  });

  it('omits storedStatus and reports unknown when a run has no status at all', () => {
    const run = baseRun();
    delete (run as Partial<AgentRun>).status;
    const [entry] = buildSubagentList('t', [run]).subagents;
    expect(entry).toMatchObject({ status: 'unknown', statusKnown: false });
    expect(entry).not.toHaveProperty('storedStatus');
  });

  it('reports a run restored from persistence with its last known state', async () => {
    const live = new AgentRunStore();
    live.observeStart({ threadId: 't', harness: 'claude', nativeAgentId: 'was-running', description: 'in flight' }, 10);
    live.observeStart({ threadId: 't', harness: 'claude', nativeAgentId: 'was-done', description: 'finished' }, 11);
    live.observeStatus('t', 'claude', 'was-done', 'completed', 'all green', undefined, 50);
    live.observeStart({ threadId: 't', harness: 'claude', nativeAgentId: 'was-failed', description: 'broke' }, 12);
    live.observeStatus('t', 'claude', 'was-failed', 'failed', undefined, 'boom', 60);
    const persisted = JSON.parse(JSON.stringify(live.snapshot('t'))) as AgentRun[];

    const restored = new AgentRunStore();
    restored.restore('t', persisted);
    const { body } = await call(toolsFor(restored, 't'));
    const byNative = Object.fromEntries(body.subagents.map((s: { nativeAgentId: string }) => [s.nativeAgentId, s]));
    // Was active when saved and its session is gone: unknown, never "working".
    expect(byNative['was-running']).toMatchObject({ status: 'unknown', statusKnown: false, storedStatus: 'unavailable' });
    // Terminal states survive a restore as their last known value.
    expect(byNative['was-done']).toMatchObject({ status: 'completed', statusKnown: true, resultSummary: 'all green', completedAt: 50 });
    expect(byNative['was-failed']).toMatchObject({ status: 'failed', statusKnown: true, error: 'boom' });
  });

  it('orders most recently updated first, caps the list and flags truncation', () => {
    const runs = Array.from({ length: MAX_SUBAGENTS + 5 }, (_, i) =>
      baseRun({ id: `r${i}`, nativeAgentId: `n${i}`, updatedAt: i }));
    const list = buildSubagentList('t', runs);
    expect(list.count).toBe(MAX_SUBAGENTS);
    expect(list.total).toBe(MAX_SUBAGENTS + 5);
    expect(list.truncated).toBe(true);
    expect(list.subagents[0]!.nativeAgentId).toBe(`n${MAX_SUBAGENTS + 4}`);
    const updated = list.subagents.map(s => s.updatedAt);
    expect(updated).toEqual([...updated].sort((a, b) => b - a));
    expect(buildSubagentList('t', runs.slice(0, 3)).truncated).toBe(false);
  });

  it('truncates long free text and carries parent linkage', () => {
    const long = 'x'.repeat(MAX_SUBAGENT_TEXT * 3);
    const [entry] = buildSubagentList('t', [baseRun({ error: long, resultSummary: long, parentAgentRunId: 'p', parentNativeAgentId: 'pn', status: 'failed' })]).subagents;
    expect(entry!.error!.length).toBeLessThan(MAX_SUBAGENT_TEXT + 40);
    expect(entry!.error!.endsWith('[truncated]')).toBe(true);
    expect(entry!.resultSummary!.endsWith('[truncated]')).toBe(true);
    expect(entry).toMatchObject({ parentAgentRunId: 'p', parentNativeAgentId: 'pn' });
  });

  it('is read-only: store contents are unchanged and the tool can only read the caller\'s runs', async () => {
    const store = new AgentRunStore();
    store.observeStart({ threadId: 't', harness: 'claude', nativeAgentId: 'n', description: 'd' }, 5);
    store.observeActivity('t', 'claude', 'n', { kind: 'activity', text: 'reading', timestamp: 6, nativeEventId: 'e1' });
    store.restore('t', [baseRun({ id: 'old', nativeAgentId: 'old-n', status: 'working' })]);
    const before = JSON.stringify(store.snapshot('t'));
    const deepFreeze = <T,>(value: T): T => {
      if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
      return value;
    };
    // Frozen runs make any write by the serializer throw (ES modules are strict), surfacing as an error result.
    const getAgentRuns = vi.fn((id: string) => deepFreeze(structuredClone(store.getByThread(id))));
    const tools = createThreadTools({ options: { threadId: 't', getAgentRuns } });

    const first = await call(tools);
    const second = await call(tools);

    expect(first.res.isError).toBeUndefined();
    expect(second.body).toEqual(first.body);
    expect(JSON.stringify(store.snapshot('t'))).toBe(before);
    // The tool port exposes no send, emit or setter: the only manager touch is reading the caller's own runs.
    expect(getAgentRuns.mock.calls).toEqual([['t'], ['t']]);
  });

  it('errors cleanly when the context has no thread binding or no run source', async () => {
    const noThread = await call(createThreadTools({ options: { getAgentRuns: () => [] } }));
    expect(noThread.res.isError).toBe(true);
    const noSource = await call(createThreadTools({ options: { threadId: 't' } }));
    expect(noSource.res.isError).toBe(true);
  });

  describe('registration', () => {
    const app = {
      plugins: { plugins: {} },
      workspace: { getLeavesOfType: () => [], onLayoutReady: (cb: () => void) => cb() },
      vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
      metadataCache: { on: () => {} },
    } as unknown as App;

    it('is canonical-only: in the threads domain and built-in order with no obsidian_ alias', () => {
      expect(TOOL_NAMES_BY_DOMAIN.threads).toContain(TOOL);
      expect(BUILT_IN_TOOL_ORDER).toContain(TOOL);
      expect(Object.values(LEGACY_TO_CANONICAL_TOOL_NAMES)).not.toContain(TOOL);
      expect(domainOf(TOOL)).toBe('threads');
      expect(NEVER_OFFERED.has(TOOL)).toBe(false); // read-only, so not in the never-offered mutating set
      expect(isTrustedBuiltInTool(`mcp__claude_threads__${TOOL}`)).toBe(true);
    });

    it('is served by the real MCP tool definitions and runs through the real handler', async () => {
      const store = new AgentRunStore();
      store.observeStart({ threadId: 'me', harness: 'claude', nativeAgentId: 'n-me', description: 'mine', role: 'Explore' }, 1);
      store.observeStart({ threadId: 'other', harness: 'claude', nativeAgentId: 'n-other', description: 'theirs' }, 2);
      const servers = createClaudeThreadsMcpServers(app, { threadId: 'me', getAgentRuns: (id: string) => store.getByThread(id) } as never) as unknown as {
        claude_threads: { tools: Array<{ name: string; handler: Handler }>; harnessTools: Array<{ name: string; requiresApproval: boolean; invoke: (a: Record<string, unknown>) => Promise<{ success: boolean; text: string }> }> };
        obsidian: { tools: Array<{ name: string }> };
      };
      const sdk = servers.claude_threads.tools.find(t => t.name === TOOL)!;
      expect(sdk).toBeDefined();
      const body = JSON.parse((await sdk.handler({}, {})).content[0]!.text!);
      expect(body.subagents.map((s: { nativeAgentId: string; role: string }) => [s.nativeAgentId, s.role])).toEqual([['n-me', 'Explore']]);
      expect(JSON.stringify(body)).not.toContain('theirs');

      // Same canonical name on the deprecated-alias server (no obsidian_ rename), and approval-free on the harness path.
      expect(servers.obsidian.tools.map(t => t.name)).toContain(TOOL);
      const harness = servers.claude_threads.harnessTools.find(t => t.name === TOOL)!;
      expect(harness.requiresApproval).toBe(false);
      const viaHarness = await harness.invoke({});
      expect(viaHarness.success).toBe(true);
      expect(JSON.parse(viaHarness.text).subagents[0].nativeAgentId).toBe('n-me');
    });
  });
});

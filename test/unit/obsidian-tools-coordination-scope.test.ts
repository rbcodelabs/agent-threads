import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools }),
}));

import { createClaudeThreadsMcpServers } from '../../src/ObsidianTools';

const app = { plugins: { plugins: {} }, workspace: { getLeavesOfType: () => [], onLayoutReady: (cb: () => void) => cb() }, vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] }, metadataCache: { on: () => {} } } as unknown as App;

describe('coordination tool scoping', () => {
  it('passes explicit elevation to list and direct-target authorization', async () => {
    const authorizeThread = vi.fn().mockReturnValue(false);
    const server = createClaudeThreadsMcpServers(app, {
      getAllThreads: () => [{ id: 'a', title: 'A', projectId: 'project-a' } as never],
      getThreadDetail: () => ({ id: 'a', title: 'A', projectId: 'project-a', messages: [] } as never),
      authorizeThread,
    }).claude_threads as unknown as { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }> };

    const list = server.tools.find(tool => tool.name === 'threads_list')!;
    const listed = await list.handler({ projectId: 'project-a' });
    expect(authorizeThread).toHaveBeenCalledWith('a', 'project-a', 'read');
    expect(JSON.parse(listed.content[0]!.text)).toEqual([]);

    const messages = server.tools.find(tool => tool.name === 'threads_get_messages')!;
    const denied = await messages.handler({ threadId: 'a', elevatedProjectId: 'project-a' });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toContain('outside coordination scope');
  });

  it('requires authorization for both reassignment source and destination', async () => {
    const authorizeThread = vi.fn().mockReturnValue(true);
    const authorizeProjectDestination = vi.fn().mockReturnValue(false);
    const setThreadProject = vi.fn();
    const server = createClaudeThreadsMcpServers(app, { authorizeThread, authorizeProjectDestination, setThreadProject }).claude_threads as unknown as { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }> };
    const tool = server.tools.find(candidate => candidate.name === 'threads_set_project')!;

    const denied = await tool.handler({ threadId: 'worker-a', projectId: 'project-b', elevatedProjectId: 'project-a' });

    expect(authorizeThread).toHaveBeenCalledWith('worker-a', 'project-a', 'write');
    // The target thread id is the third argument so the authorizer can tell
    // self-assignment (allowed for an unassigned caller) from moving someone else.
    expect(authorizeProjectDestination).toHaveBeenCalledWith('project-b', 'project-a', 'worker-a');
    expect(denied.isError).toBe(true);
    expect(setThreadProject).not.toHaveBeenCalled();
  });

  it('denies project updates before lookup when the project is outside scope', async () => {
    const authorizeProjectDestination = vi.fn().mockReturnValue(false);
    const updateProject = vi.fn();
    const server = createClaudeThreadsMcpServers(app, { authorizeProjectDestination, updateProject }).claude_threads as unknown as { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }> };
    const result = await server.tools.find(tool => tool.name === 'threads_update_project')!.handler({ projectId: 'secret-project', name: 'Renamed', elevatedProjectId: 'other-project' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('outside coordination scope');
    expect(updateProject).not.toHaveBeenCalled();
  });

  it.each([
    ['own Project', undefined],
    ['matching Portfolio elevation', 'project-a'],
  ])('allows project updates for %s', async (_label, elevatedProjectId) => {
    const authorizeProjectDestination = vi.fn().mockReturnValue(true);
    const updateProject = vi.fn().mockResolvedValue({ id: 'project-a', name: 'Renamed', effectiveCwd: '/vault/A' });
    const server = createClaudeThreadsMcpServers(app, { authorizeProjectDestination, updateProject }).claude_threads as unknown as { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean }> }> };
    const result = await server.tools.find(tool => tool.name === 'threads_update_project')!.handler({ projectId: 'project-a', name: 'Renamed', elevatedProjectId });
    expect(result.isError).toBeUndefined();
    expect(authorizeProjectDestination).toHaveBeenCalledWith('project-a', elevatedProjectId);
    expect(updateProject).toHaveBeenCalledOnce();
  });

  it('forwards the target thread id so an unassigned thread can assign itself', async () => {
    const authorizeThread = vi.fn().mockReturnValue(true);
    const setThreadProject = vi.fn();
    // Stands in for main.ts's authorizeProjectAssignment wiring: self only.
    const authorizeProjectDestination = vi.fn((_projectId, _elevated, targetThreadId) => targetThreadId === 'self');
    const server = createClaudeThreadsMcpServers(app, { authorizeThread, authorizeProjectDestination, setThreadProject }).claude_threads as unknown as { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }> };
    const tool = server.tools.find(candidate => candidate.name === 'threads_set_project')!;

    const allowed = await tool.handler({ threadId: 'self', projectId: 'project-a', alignCwd: true });

    expect(authorizeProjectDestination).toHaveBeenCalledWith('project-a', undefined, 'self');
    expect(allowed.isError).toBeUndefined();
    expect(setThreadProject).toHaveBeenCalledWith('self', 'project-a', true);

    const denied = await tool.handler({ threadId: 'other', projectId: 'project-a' });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toContain('Destination Project is outside coordination scope');
    expect(setThreadProject).toHaveBeenCalledTimes(1);
  });

  it('enforces the central boundary across every direct coordination tool', async () => {
    const authorizeThread = vi.fn().mockReturnValue(false);
    const server = createClaudeThreadsMcpServers(app, {
      threadId: 'caller', authorizeThread,
      getThreadDetail: () => ({ id: 'target', title: 'Target', messages: [] } as never),
      openThread: vi.fn(),
      readThreadLog: vi.fn(), isThreadRunning: vi.fn(), sendMessageToThread: vi.fn(), archiveThread: vi.fn(),
      setThreadProject: vi.fn(), setThreadNotes: vi.fn(), setThreadProposedReply: vi.fn(), clearThreadProposedReply: vi.fn(),
    }).claude_threads as unknown as { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean }> }> };
    const cases = [
      ['threads_get_messages', { threadId: 'target' }], ['threads_get_log', { threadId: 'target' }],
      ['threads_open', { threadId: 'target' }],
      ['threads_wait', { threadId: 'target' }], ['threads_send_message', { threadId: 'target', message: 'hi' }],
      ['threads_archive', { threadId: 'target' }], ['threads_set_project', { threadId: 'target', projectId: null }],
      ['threads_set_notes', { threadId: 'target', notes: 'n' }], ['threads_set_proposed_reply', { threadId: 'target', text: 'r' }],
      ['threads_clear_proposed_reply', { threadId: 'target' }],
    ] as const;
    for (const [name, args] of cases) {
      const result = await server.tools.find(tool => tool.name === name)!.handler(args);
      expect(result.isError, name).toBe(true);
    }
    expect(authorizeThread).toHaveBeenCalledTimes(cases.length);
  });
});

describe('threads_set_proposed_reply with an open decision', () => {
  type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  const setReply = (opts: Record<string, unknown>) =>
    (createClaudeThreadsMcpServers(app, opts as never).claude_threads as unknown as { tools: Array<{ name: string; handler: Handler }> }).tools
      .find(tool => tool.name === 'threads_set_proposed_reply')!.handler;
  const decision = { id: 'dec-1', question: 'Ship?', header: 'Ship', options: [], multiSelect: false, allowOther: true, createdAt: 1, sourceThreadId: 'orch' };

  it('rejects staging while a decision is open and does not stage', async () => {
    const setThreadProposedReply = vi.fn();
    const res = await setReply({ threadId: 'orch', setThreadProposedReply, getThreadDetail: () => ({ id: 'w', pendingDecisions: [decision] }) })({ threadId: 'w', text: 'yes' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('open decision awaiting Rick');
    expect(res.content[0]!.text).toContain('dec-1');
    expect(res.content[0]!.text).toContain('threads_clear_decision');
    expect(setThreadProposedReply).not.toHaveBeenCalled();
  });

  it('allows staging once the decision is answered or cleared (no pendingDecisions) so the answer can be relayed', async () => {
    for (const detail of [{ id: 'w' }, { id: 'w', pendingDecisions: [] }]) {
      const setThreadProposedReply = vi.fn();
      const res = await setReply({ threadId: 'orch', setThreadProposedReply, getThreadDetail: () => detail })({ threadId: 'w', text: 'Ship it, per your answer' });
      expect(res.isError).toBeUndefined();
      expect(setThreadProposedReply).toHaveBeenCalledWith('w', 'Ship it, per your answer');
    }
  });

  it('transitions from blocked to allowed when the decision is removed', async () => {
    let pending: unknown[] | undefined = [decision];
    const setThreadProposedReply = vi.fn();
    const call = setReply({ threadId: 'orch', setThreadProposedReply, getThreadDetail: () => ({ id: 'w', pendingDecisions: pending }) });
    expect((await call({ threadId: 'w', text: 'x' })).isError).toBe(true);
    pending = undefined;
    expect((await call({ threadId: 'w', text: 'x' })).isError).toBeUndefined();
    expect(setThreadProposedReply).toHaveBeenCalledTimes(1);
  });

  it('still stages when the host gives no thread detail (guard needs state to act)', async () => {
    const setThreadProposedReply = vi.fn();
    const res = await setReply({ threadId: 'orch', setThreadProposedReply })({ threadId: 'w', text: 'x' });
    expect(res.isError).toBeUndefined();
    expect(setThreadProposedReply).toHaveBeenCalled();
  });
});


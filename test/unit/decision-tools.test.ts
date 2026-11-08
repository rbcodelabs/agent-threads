import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools }),
}));

import { createClaudeThreadsMcpServers } from '../../src/ObsidianTools';
import { canonicalToolName } from '../../src/tools/toolNames';

const app = { plugins: { plugins: {} }, workspace: { getLeavesOfType: () => [], onLayoutReady: (cb: () => void) => cb() }, vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] }, metadataCache: { on: () => {} } } as unknown as App;
type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const tools = (opts: Record<string, unknown>) =>
  (createClaudeThreadsMcpServers(app, opts as never).claude_threads as unknown as { tools: Array<{ name: string; handler: Handler }> }).tools;
const find = (opts: Record<string, unknown>, name: string) => tools(opts).find((t) => t.name === name)!.handler;

const OPTIONS = [{ label: 'Ship' }, { label: 'Hold', description: 'wait' }];

describe('threads_post_decision / threads_clear_decision', () => {
  it('are registered under canonical names with legacy aliases', () => {
    const names = tools({ threadId: 'orch' }).map((t) => t.name);
    expect(names).toContain('threads_post_decision');
    expect(names).toContain('threads_clear_decision');
    expect(canonicalToolName('obsidian_post_thread_decision')).toBe('threads_post_decision');
    expect(canonicalToolName('obsidian_clear_thread_decision')).toBe('threads_clear_decision');
  });

  it('defaults to the calling thread without a scope check (portfolio-level item)', async () => {
    const authorizeThread = vi.fn().mockReturnValue(false);
    const postThreadDecision = vi.fn().mockReturnValue('dec-1');
    const res = await find({ threadId: 'orch', authorizeThread, postThreadDecision }, 'threads_post_decision')({ question: 'Ship?', options: OPTIONS });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual({ success: true, threadId: 'orch', decisionId: 'dec-1' });
    expect(authorizeThread).not.toHaveBeenCalled();
    expect(postThreadDecision).toHaveBeenCalledWith('orch', expect.objectContaining({
      question: 'Ship?', options: [{ label: 'Ship', description: '' }, { label: 'Hold', description: 'wait' }],
    }));
  });

  it('requires write authorization for another thread and does not post when denied', async () => {
    const authorizeThread = vi.fn().mockReturnValue(false);
    const postThreadDecision = vi.fn();
    const res = await find({ threadId: 'orch', authorizeThread, postThreadDecision }, 'threads_post_decision')({ threadId: 'worker', question: 'q', options: OPTIONS, elevatedProjectId: 'p' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('outside coordination scope');
    expect(authorizeThread).toHaveBeenCalledWith('worker', 'p', 'write');
    expect(postThreadDecision).not.toHaveBeenCalled();
  });

  it('surfaces validation and ownership errors from the host as tool errors', async () => {
    const postThreadDecision = vi.fn(() => { throw new Error('A decision needs 2 to 4 options.'); });
    const clearThreadDecision = vi.fn(() => { throw new Error('That decision was posted by another orchestrator.'); });
    const post = await find({ threadId: 'orch', postThreadDecision }, 'threads_post_decision')({ question: 'q', options: OPTIONS });
    expect(post.isError).toBe(true);
    const clear = await find({ threadId: 'orch', clearThreadDecision }, 'threads_clear_decision')({ decisionId: 'x' });
    expect(clear.isError).toBe(true);
    expect(clear.content[0].text).toContain('another orchestrator');
  });

  it('clear returns whether the decision was pending and checks scope for other threads', async () => {
    const clearThreadDecision = vi.fn().mockReturnValue(true);
    const authorizeThread = vi.fn().mockReturnValue(true);
    const res = await find({ threadId: 'orch', authorizeThread, clearThreadDecision }, 'threads_clear_decision')({ threadId: 'worker', decisionId: 'd1' });
    expect(JSON.parse(res.content[0].text)).toEqual({ success: true, threadId: 'worker', cleared: true });
    expect(authorizeThread).toHaveBeenCalledWith('worker', undefined, 'write');
    expect(clearThreadDecision).toHaveBeenCalledWith('worker', 'd1');
  });

  it('threads_list passes pendingDecisions through to the orchestrator unchanged', async () => {
    const pendingDecisions = [{ id: 'd1', question: 'Ship?', header: 'H', options: [], multiSelect: false, allowOther: true, createdAt: 1, sourceThreadId: 'orch' }];
    const list = find({ threadId: 'orch', getAllThreads: () => [{ id: 'a', title: 'A', pendingDecisions }] }, 'threads_list');
    const res = await list({});
    expect(JSON.parse(res.content[0].text)[0].pendingDecisions).toEqual(pendingDecisions);
  });
});

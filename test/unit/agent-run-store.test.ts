import { describe, expect, it } from 'vitest';
import { AgentRunStore } from '../../src/agentRuns/AgentRunStore';

describe('AgentRunStore', () => {
  it('builds nested agent trees and replays duplicate events idempotently', () => {
    const store = new AgentRunStore();
    const child = store.observeStart({ threadId: 'thread-1', harness: 'codex', nativeAgentId: 'child', description: 'Audit' }, 100);
    store.observeStart({ threadId: 'thread-1', harness: 'codex', nativeAgentId: 'nested', parentNativeAgentId: 'child', description: 'Inspect tests' }, 110);
    store.observeActivity('thread-1', 'codex', 'nested', { kind: 'activity', text: 'Reading fixtures', timestamp: 120, nativeEventId: 'evt-1' });
    store.observeActivity('thread-1', 'codex', 'nested', { kind: 'activity', text: 'Reading fixtures', timestamp: 120, nativeEventId: 'evt-1' });

    const tree = store.getTree('thread-1');
    expect(tree).toHaveLength(1);
    expect(tree[0].run.id).toBe(child.id);
    expect(tree[0].children[0].run.nativeAgentId).toBe('nested');
    expect(tree[0].children[0].run.events.filter(e => e.nativeEventId === 'evt-1')).toHaveLength(1);
  });

  it('resolves an orphan when its parent arrives later', () => {
    const store = new AgentRunStore();
    const nested = store.observeStart({ threadId: 't', harness: 'claude', nativeAgentId: 'nested', parentNativeAgentId: 'parent', description: 'Nested' }, 1);
    expect(nested.parentAgentRunId).toBeUndefined();
    const parent = store.observeStart({ threadId: 't', harness: 'claude', nativeAgentId: 'parent', description: 'Parent' }, 2);
    expect(store.getByNativeId('t', 'claude', 'nested')?.parentAgentRunId).toBe(parent.id);
  });

  it('restores snapshots, marks active agents unavailable, and preserves terminal agents', () => {
    const store = new AgentRunStore();
    store.restore('t', [
      { id: 'working', threadId: 't', nativeAgentId: 'a', harness: 'claude', description: 'Working', status: 'working', startedAt: 1, updatedAt: 2, capabilities: { viewTranscript: true, sendMessage: false, interrupt: false }, events: [] },
      { id: 'done', threadId: 't', nativeAgentId: 'b', harness: 'claude', description: 'Done', status: 'completed', startedAt: 1, updatedAt: 2, completedAt: 2, capabilities: { viewTranscript: true, sendMessage: false, interrupt: false }, events: [] },
    ]);
    expect(store.getById('working')?.status).toBe('unavailable');
    expect(store.getById('done')?.status).toBe('completed');
  });

  it('does not classify ordinary background tasks as agents', () => {
    expect(AgentRunStore.isAgentTask({ skipTranscript: true })).toBe(false);
    expect(AgentRunStore.isAgentTask({ skipTranscript: true, taskType: 'subagent' })).toBe(true);
    expect(AgentRunStore.isAgentTask({ skipTranscript: false, taskType: 'subagent' })).toBe(true);
    expect(AgentRunStore.isAgentTask({ skipTranscript: false, taskType: 'agent' })).toBe(true);
    expect(AgentRunStore.isAgentTask({ skipTranscript: false, subagentType: 'Explore' })).toBe(true);
  });

  it('clears completedAt when a completed agent run is revived to working or waiting', () => {
    const store = new AgentRunStore();
    store.observeStart({ threadId: 't', harness: 'antigravity', nativeAgentId: 'sub-1', description: 'Worker' }, 10);
    store.observeStatus('t', 'antigravity', 'sub-1', 'completed', 'Finished pass 1', undefined, 20);
    expect(store.getByNativeId('t', 'antigravity', 'sub-1')?.completedAt).toBe(20);

    store.observeStatus('t', 'antigravity', 'sub-1', 'working', 'Worker', undefined, 30);
    const revived = store.getByNativeId('t', 'antigravity', 'sub-1');
    expect(revived?.status).toBe('working');
    expect(revived?.completedAt).toBeUndefined();
  });
});

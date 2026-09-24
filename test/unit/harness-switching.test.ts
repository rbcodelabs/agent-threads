import { describe, expect, it, vi } from 'vitest';
import { ThreadManager, buildHarnessHandoffPrompt } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS, type Thread } from '../../src/types';
import { AgentRunStore } from '../../src/agentRuns/AgentRunStore';
import { decodeThreadRecoverySnapshot, encodeThreadRecoverySnapshot } from '../../src/threadRecoverySnapshot';

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1', title: 'Harness switching', cwd: '/workspace',
    agentHarness: 'claude', messages: [], createdAt: 1, updatedAt: 1,
    status: 'waiting', ...overrides,
  };
}

describe('harness switching', () => {
  it('builds a bounded reference handoff without replaying transcript messages', () => {
    const value = thread({
      summary: 'A'.repeat(3000), noteFile: 'Claude/thread.md', rawLogPath: 'Claude/logs/thread.jsonl',
      messages: [{ id: 'm1', role: 'user', content: 'SECRET TRANSCRIPT LINE', timestamp: 2 }],
    });
    const prompt = buildHarnessHandoffPrompt(value, 'claude', 'codex');
    expect(prompt).toContain('threads_get_messages');
    expect(prompt).toContain('threads_get_log');
    expect(prompt).toContain('Claude/thread.md');
    expect(prompt).not.toContain('SECRET TRANSCRIPT LINE');
    expect(prompt.length).toBeLessThan(5000);
  });

  it('reports one authoritative reason for every blocked lifecycle state', () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread({ pendingPlan: 'approve me' })]);
    expect(manager.getHarnessSwitchBlockReason('thread-1')).toMatch(/plan/i);
  });

  it('switches durable ownership, clears provider state, and rolls back failed persistence', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    const value = thread({
      sessionId: 'claude-native', model: 'sonnet', summary: 'Continue the feature.',
      usageSnapshot: { provider: 'claude', windows: [], updatedAt: 2 },
      tasks: [{ id: '1', content: 'old task', status: 'pending' }], recap: 'temporary', lastError: 'stale',
      messages: [{ id: 'a1', role: 'assistant', content: 'prior', timestamp: 2 }],
    });
    manager.loadThreads([value]);
    await manager.switchHarness('thread-1', 'codex', vi.fn().mockResolvedValue(undefined));
    expect(value.agentHarness).toBe('codex');
    expect(value.sessionId).toBeUndefined();
    expect(value.model).toBeUndefined();
    expect(value.pendingHarnessHandoff?.targetHarness).toBe('codex');
    expect(value.messages[0].agentHarness).toBe('claude');

    const original = thread({ sessionId: 'source', model: 'opus' });
    const rollback = new ThreadManager(DEFAULT_SETTINGS);
    rollback.loadThreads([original]);
    await expect(rollback.switchHarness('thread-1', 'codex', vi.fn().mockRejectedValue(new Error('disk full')))).rejects.toThrow('disk full');
    expect(original.agentHarness).toBe('claude');
    expect(original.sessionId).toBe('source');
    expect(original.model).toBe('opus');
  });

  it('round-trips pending handoff state and isolates reused native agent IDs by generation', () => {
    const value = thread({ sessionGeneration: 2, pendingHarnessHandoff: {
      sourceHarness: 'claude', targetHarness: 'codex', summary: 'Continue.',
      threadId: 'thread-1', createdAt: 10,
    } });
    expect(decodeThreadRecoverySnapshot(encodeThreadRecoverySnapshot(value))?.pendingHarnessHandoff).toEqual(value.pendingHarnessHandoff);

    const store = new AgentRunStore();
    const first = store.observeStart({ threadId: 'thread-1', harness: 'claude', nativeAgentId: 'agent-1', description: 'first', sessionGeneration: 0 });
    const second = store.observeStart({ threadId: 'thread-1', harness: 'claude', nativeAgentId: 'agent-1', description: 'second', sessionGeneration: 2 });
    expect(second.id).not.toBe(first.id);
    expect(store.getByThread('thread-1')).toHaveLength(2);
  });
});

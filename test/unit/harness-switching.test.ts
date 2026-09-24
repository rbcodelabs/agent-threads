import { describe, expect, it, vi } from 'vitest';
import { ThreadManager, buildHarnessHandoffPrompt, resolveHarnessPrompt } from '../../src/ThreadManager';
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

  it.each([
    ['queued message', (manager: any) => manager.queuedMessages.set('thread-1', [{ text: 'queued' }]), /queued/i],
    ['permission', (manager: any) => manager.pendingPermissions.set('thread-1', { toolName: 'Write', detail: 'x' }), /permission/i],
    ['question', (manager: any) => manager.pendingQuestionResolvers.set('thread-1', () => {}), /question/i],
    ['background task', (manager: any) => manager.activeBgTasks.set('thread-1', new Map([['task', { description: 'x', startedAt: 1 }]])), /background/i],
    ['recoverable background task', (manager: any) => {
      manager.getThread('thread-1').pendingBackgroundTasks = [{ taskId: 'task', description: 'x', startedAt: 1, pollCount: 0 }];
    }, /background/i],
    ['goal transition', (manager: any) => manager.goalContextStates.set('thread-1', { desiredRevision: 1, appliedRevision: 0, durableRevision: 0, durableGoal: undefined, refreshRequested: true, processing: false }), /goal/i],
    ['concurrent switch', (manager: any) => manager.harnessSwitches.add('thread-1'), /already in progress/i],
  ])('blocks switching for %s', (_label, setup, expected) => {
    const manager = new ThreadManager(DEFAULT_SETTINGS) as any;
    manager.loadThreads([thread()]);
    setup(manager);
    expect(manager.getHarnessSwitchBlockReason('thread-1')).toMatch(expected);
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

  it('attaches parent and child runs within the current session generation', () => {
    const store = new AgentRunStore();
    const oldParent = store.observeStart({ threadId: 'thread-1', harness: 'claude', nativeAgentId: 'parent', description: 'old', sessionGeneration: 0 });
    const child = store.observeStart({ threadId: 'thread-1', harness: 'claude', nativeAgentId: 'child', parentNativeAgentId: 'parent', description: 'child', sessionGeneration: 2 });
    const parent = store.observeStart({ threadId: 'thread-1', harness: 'claude', nativeAgentId: 'parent', description: 'current', sessionGeneration: 2 });
    expect(child.parentAgentRunId).toBe(parent.id);
    expect(child.parentAgentRunId).not.toBe(oldParent.id);
  });

  it('claims a pending handoff for only one concurrent outbound prompt and can release it for retry', () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS) as any;
    const value = thread({ pendingHarnessHandoff: {
      sourceHarness: 'claude', targetHarness: 'codex', summary: 'Continue.', threadId: 'thread-1', createdAt: 1,
    } });
    manager.loadThreads([value]);
    const first = manager.claimHarnessHandoff('thread-1');
    const followup = manager.claimHarnessHandoff('thread-1');
    expect(first).toBe(value.pendingHarnessHandoff);
    expect(followup).toBeUndefined();
    manager.releaseHarnessHandoffClaim('thread-1');
    expect(manager.claimHarnessHandoff('thread-1')).toBe(value.pendingHarnessHandoff);
  });

  it('does not complete a switch after the thread is deleted during persistence', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    const value = thread();
    manager.loadThreads([value]);
    const events: string[] = [];
    manager.subscribe((_id, event) => events.push(event.type));
    let release!: () => void;
    const persisted = new Promise<void>(resolve => { release = resolve; });
    const switching = manager.switchHarness('thread-1', 'codex', () => persisted);
    manager.deleteThread('thread-1');
    release();
    await expect(switching).rejects.toThrow(/deleted/i);
    expect(manager.getThread('thread-1')).toBeUndefined();
    expect(events).not.toContain('harness_changed');
  });

  it('rejects Claude escalation syntax for Codex', () => {
    expect(() => resolveHarnessPrompt('codex', '/escalate investigate', DEFAULT_SETTINGS)).toThrow(/Claude.*Codex/i);
    expect(resolveHarnessPrompt('claude', '/escalate investigate', DEFAULT_SETTINGS).promptText).toBe('investigate');
  });

  it('surfaces a failed compensating save after deletion during persistence', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread()]);
    let release!: () => void;
    const first = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const switching = manager.switchHarness('thread-1', 'codex', async () => {
      calls++;
      if (calls === 1) return first;
      throw new Error('compensation disk failure');
    });
    manager.deleteThread('thread-1');
    release();
    await expect(switching).rejects.toThrow(/compensation.*failure/i);
    expect(calls).toBe(2);
  });

  it('ignores all late UI events from a retired session generation', () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS) as any;
    const value = thread({ sessionGeneration: 1 });
    manager.loadThreads([value]);
    const callbacks = manager.buildSessionCallbacks('thread-1', value);
    value.sessionGeneration = 2;
    const events: string[] = [];
    manager.subscribe((_id: string, event: { type: string }) => events.push(event.type));
    callbacks.onNotification?.('late', 'high');
    callbacks.onApiRetry?.(1, 2, 'late');
    callbacks.onModelFallback?.('late', 'a', 'b');
    callbacks.onToolProgress?.('tool', 'Read', 1);
    callbacks.onMemoryRecall?.([], 'select');
    callbacks.onCommandsChanged?.([]);
    callbacks.onGitOperation?.('late');
    callbacks.onToolResult?.('tool', 'success', 1);
    callbacks.onEnterPlanMode?.();
    expect(events).toEqual([]);
  });
});

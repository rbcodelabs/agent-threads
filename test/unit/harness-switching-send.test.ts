import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import type { SessionCallbacks } from '../../src/ThreadSession';
import { DEFAULT_SETTINGS, type Thread } from '../../src/types';

const fake = vi.hoisted(() => ({
  prompts: [] as string[], callbacks: undefined as SessionCallbacks | undefined,
  failStart: false, startCount: 0, startGate: undefined as Promise<void> | undefined,
}));

vi.mock('../../src/HarnessFactory', () => ({
  createHarnessSession: () => ({
    turnInFlight: false, cwd: undefined,
    start: async (options: { callbacks: SessionCallbacks }) => {
      fake.startCount++;
      fake.callbacks = options.callbacks;
      if (fake.failStart) throw new Error('startup failed');
      await fake.startGate;
    },
    send: (prompt: string) => { fake.prompts.push(prompt); },
    prepareForSend: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
    close: () => {}, interrupt: async () => {}, getContextUsage: async () => null,
    getUsageSnapshot: async () => null,
  }),
}));

const { ThreadManager } = await import('../../src/ThreadManager');

function switchedThread(): Thread {
  return {
    id: 't', title: 'Switch', cwd: os.tmpdir(), agentHarness: 'codex', sessionGeneration: 1,
    messages: [{ id: 'a', role: 'assistant', content: 'prior', timestamp: 1, agentHarness: 'claude' }],
    pendingHarnessHandoff: { sourceHarness: 'claude', targetHarness: 'codex', summary: 'Summary', threadId: 't', createdAt: 1 },
    createdAt: 1, updatedAt: 1, status: 'waiting',
  };
}

beforeEach(() => { fake.prompts = []; fake.callbacks = undefined; fake.failStart = false; fake.startCount = 0; fake.startGate = undefined; });

describe('harness handoff send lifecycle', () => {
  it('injects a pending handoff into exactly one concurrent prompt and clears it on successful completion', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    const thread = switchedThread();
    manager.loadThreads([thread]);
    await Promise.all([manager.sendMessage('t', 'first'), manager.sendMessage('t', 'follow-up')]);
    expect(fake.prompts.filter(prompt => prompt.includes('## Harness handoff'))).toHaveLength(1);
    fake.callbacks!.onDone('codex-session', 0, 1);
    expect(thread.pendingHarnessHandoff).toBeUndefined();
  });

  it('retains and releases the handoff claim after target startup failure', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    const thread = switchedThread();
    manager.loadThreads([thread]);
    fake.failStart = true;
    await manager.sendMessage('t', 'fails');
    expect(thread.pendingHarnessHandoff).toBeDefined();
    fake.failStart = false;
    await manager.sendMessage('t', 'retry');
    expect(fake.prompts.at(-1)).toContain('## Harness handoff');
  });

  it('retains and releases the handoff claim after a terminal target error', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    const thread = switchedThread();
    manager.loadThreads([thread]);
    await manager.sendMessage('t', 'fails after startup');
    fake.callbacks!.onError(new Error('target failed'));
    expect(thread.pendingHarnessHandoff).toBeDefined();

    await manager.sendMessage('t', 'retry');
    expect(fake.prompts.at(-1)).toContain('## Harness handoff');
  });

  it('queues a send during switch persistence and releases it to the committed target', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    const thread = switchedThread();
    thread.agentHarness = 'claude';
    delete thread.pendingHarnessHandoff;
    manager.loadThreads([thread]);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const switching = manager.switchHarness('t', 'codex', () => pending);
    await manager.sendMessage('t', 'racing send');
    expect(manager.getQueuedCount('t')).toBe(1);
    release();
    await switching;
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1));
    expect(fake.prompts[0]).toContain('## Harness handoff');
    expect(manager.getQueuedCount('t')).toBe(0);
  });

  it('releases a send to the restored source after switch persistence rolls back', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    const thread = switchedThread();
    thread.agentHarness = 'claude';
    thread.sessionId = 'claude-session';
    delete thread.pendingHarnessHandoff;
    manager.loadThreads([thread]);
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const switching = manager.switchHarness('t', 'codex', () => pending);
    await manager.sendMessage('t', 'racing send');

    reject(new Error('disk full'));
    await expect(switching).rejects.toThrow('disk full');
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1));
    expect(thread.agentHarness).toBe('claude');
    expect(thread.sessionId).toBe('claude-session');
    expect(fake.prompts[0]).not.toContain('## Harness handoff');
    expect(manager.getQueuedCount('t')).toBe(0);
  });

  it('drains multiple persistence-queued sends sequentially across deferred target startup', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    const thread = switchedThread();
    thread.agentHarness = 'claude';
    delete thread.pendingHarnessHandoff;
    manager.loadThreads([thread]);
    let persist!: () => void;
    let start!: () => void;
    const persistence = new Promise<void>(resolve => { persist = resolve; });
    fake.startGate = new Promise<void>(resolve => { start = resolve; });
    const switching = manager.switchHarness('t', 'codex', () => persistence);
    await manager.sendMessage('t', 'first queued');
    await manager.sendMessage('t', 'second queued');
    persist();
    await Promise.resolve();
    expect(fake.startCount).toBe(1);
    expect(fake.prompts).toEqual([]);
    start();
    await switching;
    expect(fake.startCount).toBe(1);
    expect(fake.prompts.map(prompt => prompt.endsWith('first queued') ? 'first' : prompt.endsWith('second queued') ? 'second' : 'unknown')).toEqual(['first', 'second']);
    expect(fake.prompts.filter(prompt => prompt.includes('## Harness handoff'))).toHaveLength(1);
  });

  it('rejects a Claude-only escalation keyword on Codex before transcript or startup', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, escalationEnabled: true, escalationKeyword: '/escalate' });
    const thread = switchedThread();
    manager.loadThreads([thread]);
    const before = thread.messages.length;
    await expect(manager.sendMessage('t', '/escalate investigate')).rejects.toThrow(/Claude.*Codex/i);
    expect(thread.messages).toHaveLength(before);
    expect(fake.startCount).toBe(0);
  });
});

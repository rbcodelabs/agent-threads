import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import type { SessionCallbacks } from '../../src/ThreadSession';
import { DEFAULT_SETTINGS, type Thread } from '../../src/types';

const fake = vi.hoisted(() => ({
  prompts: [] as string[], callbacks: undefined as SessionCallbacks | undefined,
  failStart: false,
}));

vi.mock('../../src/HarnessFactory', () => ({
  createHarnessSession: () => ({
    turnInFlight: false, cwd: undefined,
    start: async (options: { callbacks: SessionCallbacks }) => {
      fake.callbacks = options.callbacks;
      if (fake.failStart) throw new Error('startup failed');
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

beforeEach(() => { fake.prompts = []; fake.callbacks = undefined; fake.failStart = false; });

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
});

/**
 * ThreadManager.requestSessionRestart(): a live session is rebuilt at the next
 * safe turn boundary (resuming the same conversation), so skill sources added
 * since it started are loaded. Used by "Set up Chief of Staff" when it re-adds
 * the pack for an existing home thread.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import { DEFAULT_SETTINGS, type Thread } from '../../src/types';

const fake = vi.hoisted(() => ({ starts: 0, closes: 0, inFlight: false }));

vi.mock('../../src/HarnessFactory', () => ({
  createHarnessSession: () => {
    fake.starts++;
    return {
      get turnInFlight() { return fake.inFlight; },
      cwd: undefined,
      start: async () => {},
      send: () => {},
      prepareForSend: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
      close: () => { fake.closes++; }, interrupt: async () => {}, getContextUsage: async () => null,
      getUsageSnapshot: async () => null,
    };
  },
}));

const { ThreadManager } = await import('../../src/ThreadManager');

function thread(): Thread {
  return { id: 't', title: 'Chief of Staff', cwd: os.tmpdir(), messages: [], createdAt: 1, updatedAt: 1, status: 'waiting' };
}

beforeEach(() => { fake.starts = 0; fake.closes = 0; fake.inFlight = false; });

describe('ThreadManager.requestSessionRestart', () => {
  it('returns false and does nothing when the thread has no live session', () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread()]);
    expect(manager.requestSessionRestart('t')).toBe(false);
  });

  it('rebuilds a live idle session on the next send, keeping the conversation', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    const t = thread();
    t.sessionId = 'resume-me';
    manager.loadThreads([t]);
    await manager.sendMessage('t', 'first');
    expect(fake.starts).toBe(1);

    expect(manager.requestSessionRestart('t')).toBe(true);
    expect(fake.closes).toBe(0); // not torn down eagerly

    await manager.sendMessage('t', 'second');
    expect(fake.closes).toBe(1);
    expect(fake.starts).toBe(2);
    expect(t.sessionId).toBe('resume-me');

    await manager.sendMessage('t', 'third');
    expect(fake.starts).toBe(2); // one-shot
  });

  it('does not close a session mid-turn; the rebuild waits for a later send', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread()]);
    await manager.sendMessage('t', 'first');
    manager.requestSessionRestart('t');

    fake.inFlight = true;
    await manager.sendMessage('t', 'coalesced');
    expect(fake.closes).toBe(0);

    fake.inFlight = false;
    await manager.sendMessage('t', 'next turn');
    expect(fake.closes).toBe(1);
    expect(fake.starts).toBe(2);
  });
});

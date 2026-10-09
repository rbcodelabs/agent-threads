import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import type { SessionCallbacks } from '../../src/ThreadSession';
import { DEFAULT_SETTINGS, type Thread } from '../../src/types';
import { formatSignInExpiredMessage } from '../../src/claudeAuthRecovery';

const fake = vi.hoisted(() => ({
  sends: [] as Array<{ prompt: string; uuid?: string }>,
  callbacks: undefined as SessionCallbacks | undefined,
  sessionsCreated: 0,
  closes: 0,
}));

vi.mock('../../src/HarnessFactory', () => ({
  createHarnessSession: () => {
    fake.sessionsCreated++;
    return {
      turnInFlight: false, cwd: undefined,
      start: async (options: { callbacks: SessionCallbacks }) => { fake.callbacks = options.callbacks; },
      send: (prompt: string, _images: unknown, uuid?: string) => { fake.sends.push({ prompt, uuid }); },
      prepareForSend: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
      close: () => { fake.closes++; }, interrupt: async () => {}, getContextUsage: async () => null,
      getUsageSnapshot: async () => null,
    };
  },
}));

const { ThreadManager } = await import('../../src/ThreadManager');

function thread(): Thread {
  return {
    id: 't', title: 'Auth', cwd: os.tmpdir(), agentHarness: 'claude',
    messages: [], createdAt: 1, updatedAt: 1, status: 'waiting',
  };
}

const EXPIRED = formatSignInExpiredMessage('Failed to authenticate: OAuth session expired and could not be refreshed');

beforeEach(() => { fake.sends = []; fake.callbacks = undefined; fake.sessionsCreated = 0; fake.closes = 0; });

describe('ThreadManager — expired Claude sign-in', () => {
  it('shows a transient reconnecting state on the silent retry, not an error', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    const t = thread();
    manager.loadThreads([t]);
    const events: string[] = [];
    manager.subscribe((_id, e) => events.push(e.type));
    await manager.sendMessage('t', 'hello');
    fake.callbacks!.onAuthRetry!('OAuth session expired');
    expect(t.status).toBe('reconnecting');
    expect(events).toContain('auth_retry');
    expect(events).not.toContain('error');
  });

  it('records the sign-in-required state and emits an error the view can recognise', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    const t = thread();
    manager.loadThreads([t]);
    const errors: string[] = [];
    manager.subscribe((_id, e) => { if (e.type === 'error') errors.push(e.error.message); });
    await manager.sendMessage('t', 'hello');
    fake.callbacks!.onAuthRequired!(EXPIRED);
    expect(t.status).toBe('error');
    expect(t.lastError).toBe(EXPIRED);
    expect(t.authRequired).toEqual({ message: EXPIRED, at: expect.any(Number) });
    expect(errors).toEqual([EXPIRED]);
    // The failed user message stays in the transcript, exactly once.
    expect(t.messages.filter(m => m.role === 'user').map(m => m.content)).toEqual(['hello']);
  });

  it('retryAfterSignIn resends the pending message on a fresh session without duplicating it', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    const t = thread();
    manager.loadThreads([t]);
    const added: string[] = [];
    manager.subscribe((_id, e) => { if (e.type === 'user_message_added') added.push(e.message.content); });
    await manager.sendMessage('t', 'hello');
    const userMsgId = t.messages[0].id;
    fake.callbacks!.onAuthRequired!(EXPIRED);

    const retried = await manager.retryAfterSignIn('t');

    expect(retried).toBe(true);
    expect(fake.closes).toBe(1);
    expect(fake.sessionsCreated).toBe(2);
    expect(fake.sends.map(s => s.prompt)).toEqual(['hello', 'hello']);
    expect(fake.sends[1].uuid).toBe(userMsgId);
    expect(t.messages.filter(m => m.role === 'user')).toHaveLength(1);
    expect(added).toEqual(['hello']);
    expect(t.authRequired).toBeUndefined();
    expect(t.status).toBe('active');
  });

  it('retryAfterSignIn drops a trailing synthetic auth-error reply and resends the user turn', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    const t = thread();
    manager.loadThreads([t]);
    await manager.sendMessage('t', 'hello');
    fake.callbacks!.onAuthRequired!(EXPIRED);
    t.messages.push({ id: 'a1', role: 'assistant', content: 'API Error: Could not load credentials from any providers', timestamp: Date.now() } as never);

    const retried = await manager.retryAfterSignIn('t');

    expect(retried).toBe(true);
    expect(fake.sends.map(s => s.prompt)).toEqual(['hello', 'hello']);
    expect(t.messages.filter(m => m.role === 'assistant')).toHaveLength(0);
    expect(t.messages.filter(m => m.role === 'user')).toHaveLength(1);
  });

  it('retryAfterSignIn is a no-op when nothing is pending', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread()]);
    expect(await manager.retryAfterSignIn('t')).toBe(false);
    expect(fake.sends).toHaveLength(0);
  });

  it('a new user message clears the sign-in-required state', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    const t = thread();
    manager.loadThreads([t]);
    await manager.sendMessage('t', 'hello');
    fake.callbacks!.onAuthRequired!(EXPIRED);
    await manager.sendMessage('t', 'try again');
    expect(t.authRequired).toBeUndefined();
  });
});

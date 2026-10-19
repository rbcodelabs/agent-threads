/**
 * ThreadManager's injectable clock (design 4.3 "Replay and time"). A turn replayed from a remote
 * daemon hours after it happened must keep its original times; live events keep real time.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'os';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { ThreadSessionOptions } from '../../src/ThreadSession';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { ImageAttachment } from '../../src/types';

const mock = vi.hoisted(() => ({
  callbacks: null as SessionCallbacks | null,
  prompt: null as string | null,
  sentPrompts: [] as string[],
  images: null as ImageAttachment[] | undefined,
  sentImages: [] as (ImageAttachment[] | undefined)[],
  sentUserMessageUuids: [] as (string | undefined)[],
  model: undefined as string | undefined,
  resumeSessionId: undefined as string | undefined,
  lastKnownSessionId: undefined as string | undefined,
  constructCount: 0,
  startCallCount: 0,
  sendCallCount: 0,
}));

vi.mock('../../src/ThreadSession', () => ({
  ThreadSession: class {
    private _turnInFlight = false;
    constructor(_claudePath: string) { mock.constructCount += 1; }
    get turnInFlight(): boolean { return this._turnInFlight; }
    async start(options: ThreadSessionOptions): Promise<void> {
      mock.startCallCount += 1;
      mock.model = options.model;
      mock.resumeSessionId = options.resume;
      mock.lastKnownSessionId = options.resume;
      const raw = options.callbacks;
      mock.callbacks = {
        ...raw,
        onDone: (sessionId, cost, numTurns) => {
          mock.lastKnownSessionId = sessionId;
          raw.onDone(sessionId, cost, numTurns);
          this._turnInFlight = false;
        },
        onInterrupted: (sessionId) => {
          raw.onInterrupted(sessionId);
          this._turnInFlight = false;
        },
        onError: (err) => {
          raw.onError(err);
          this._turnInFlight = false;
        },
      };
    }
    send(text: string, images?: ImageAttachment[], userMessageUuid?: string): void {
      mock.sendCallCount += 1;
      mock.prompt = text;
      mock.sentPrompts.push(text);
      mock.images = images;
      mock.sentImages.push(images);
      mock.sentUserMessageUuids.push(userMessageUuid);
      this._turnInFlight = true;
    }
    async interrupt(): Promise<void> {
      mock.callbacks?.onInterrupted(mock.lastKnownSessionId ?? '');
    }
    async setModel(model?: string): Promise<void> { mock.model = model; }
    async setPermissionMode(_mode: unknown): Promise<void> {}
    async restart(): Promise<void> {}
    close(): void {}
    async getContextUsage(): Promise<null> { return null; }
  },
}));


// Import AFTER vi.mock so the mock is in place
const { ThreadManager } = await import('../../src/ThreadManager');

const HOUR = 3_600_000;
const REAL = 1_800_000_000_000; // the fake "wall clock" now
const ORIGINAL = REAL - 5 * HOUR; // when the replayed events really happened

function makeManager() {
  const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
  manager.clock = () => REAL;
  return manager;
}

beforeEach(() => { mock.callbacks = null; });

describe('ThreadManager.now / runAtTime', () => {
  it('defaults to the clock, pins inside runAtTime, nests, and always restores', () => {
    const m = makeManager();
    expect(m.now()).toBe(REAL);
    m.runAtTime(ORIGINAL, () => {
      expect(m.now()).toBe(ORIGINAL);
      m.runAtTime(ORIGINAL + 1000, () => expect(m.now()).toBe(ORIGINAL + 1000));
      expect(m.now()).toBe(ORIGINAL);
    });
    expect(m.now()).toBe(REAL);
    expect(() => m.runAtTime(ORIGINAL, () => { throw new Error('boom'); })).toThrow('boom');
    expect(m.now()).toBe(REAL);
  });

  it('never stamps the future: a daemon clock ahead of this one is clamped', () => {
    const m = makeManager();
    expect(m.runAtTime(REAL + 10 * HOUR, () => m.now())).toBe(REAL);
    expect(m.runAtTime(Number.NaN, () => m.now())).toBe(REAL);
  });
});

describe('callbacks stamp with now()', () => {
  async function started() {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    await manager.sendMessage(thread.id, 'go');
    return { manager, thread, cb: mock.callbacks! };
  }

  it('a live message is stamped with the real clock', async () => {
    const { thread, cb } = await started();
    cb.onMessage('live', []);
    expect(thread.messages.at(-1)!.timestamp).toBe(REAL);
    expect(thread.updatedAt).toBe(REAL);
  });

  it('a replayed message, compact marker, usage and task keep their original time', async () => {
    const { manager, thread, cb } = await started();
    const rank = thread.updatedAt;
    manager.runAtTime(ORIGINAL, () => {
      cb.onMessage('while you were away', []);
      cb.onCompact('auto', 1000);
      cb.onTaskStarted('t1', 'index', false, undefined, undefined, 'general', undefined, undefined);
      cb.onTaskNotification('t1', 'completed', 'done');
      cb.onAuthRequired('sign in');
    });
    const assistant = thread.messages.find((m) => m.content === 'while you were away')!;
    expect(assistant.timestamp).toBe(ORIGINAL);
    expect(thread.messages.find((m) => m.role === 'compact')!.timestamp).toBe(ORIGINAL);
    const run = manager.getAgentRuns(thread.id)[0];
    expect(run.events.every((e) => e.timestamp === ORIGINAL)).toBe(true);
    expect(thread.authRequired!.at).toBe(ORIGINAL);
    // updatedAt never moves backwards just because an old event was replayed.
    expect(thread.updatedAt).toBeGreaterThanOrEqual(rank);
  });

  it('is back to real time for the next live event after a replayed one', async () => {
    const { manager, thread, cb } = await started();
    manager.runAtTime(ORIGINAL, () => cb.onMessage('old', []));
    cb.onMessage('new', []);
    const stamps = thread.messages.filter((m) => m.role === 'assistant').map((m) => m.timestamp);
    expect(stamps).toEqual([ORIGINAL, REAL]);
  });

  it('the session callbacks never read Date.now() directly (audit guard)', () => {
    const text = readFileSync(join(__dirname, '../../src/ThreadManager.ts'), 'utf8');
    const from = text.indexOf('private buildSessionCallbacks(');
    const to = text.indexOf('private emitRunStateSettledWhenIdle');
    expect(from).toBeGreaterThan(0);
    const body = text.slice(from, to) + text.slice(text.indexOf('private applyTaskEvent('), text.indexOf('/** Skill plugins as host paths.'));
    expect(body).not.toMatch(/Date\.now\(\)/);
    const clearFrom = text.indexOf('private clearReconnectingStatus(');
    expect(text.slice(clearFrom, clearFrom + 400)).not.toMatch(/Date\.now\(\)/);
  });
});

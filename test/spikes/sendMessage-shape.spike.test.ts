import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { ThreadSessionOptions } from '../../src/ThreadSession';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { ImageAttachment } from '../../src/types';
import type { ThreadEvent } from '../../src/ThreadManager';

// ─── canonical ThreadSession mock (see test/unit/session-message-handlers.test.ts) ──
//
// ADR-0002 Stage 2 replaced the old per-turn ClaudeSession (one instance,
// one `run()` call, per user turn — `run()` stayed pending until the mock
// explicitly resolved it) with a long-lived ThreadSession (one instance per
// THREAD, reused across every turn via start() once + send() per turn).
// `start()` resolves quickly — ThreadManager.sendMessage() itself resolves
// shortly after start()/send(), well before any 'done'/'error'/'interrupted'
// — so tests `await manager.sendMessage(...)` and then drive `mock.callbacks!`
// synchronously, rather than holding a `sendPromise` open until a manual
// `mock.resolve()` (which no longer exists).

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

const makeManager = () => new ThreadManager({ ...DEFAULT_SETTINGS });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

beforeEach(() => {
  Object.assign(mock, { callbacks: null, prompt: null, sentPrompts: [], images: undefined, sentImages: [],
    sentUserMessageUuids: [], model: undefined, resumeSessionId: undefined, lastKnownSessionId: undefined,
    constructCount: 0, startCallCount: 0, sendCallCount: 0 });
});

describe('S4 sendMessage shape (spike, real ThreadManager + mocked ThreadSession)', () => {
  it('user message: pushed to thread.messages, announced via user_message_added (NOT `message`)', async () => {
    const m = makeManager(); const t = m.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    m.subscribe((_, e) => events.push(e));
    await m.sendMessage(t.id, 'hi');
    expect(t.messages.map(x => x.role)).toEqual(['user']);
    expect(events.map(e => e.type)).toEqual(['user_message_added', 'streaming_start']);
    expect(events.some(e => e.type === 'message')).toBe(false);
  });

  it('full turn order incl. tool_use + run_state_settled; `message` is assistant-only', async () => {
    const m = makeManager(); const t = m.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    m.subscribe((_, e) => events.push(e));
    await m.sendMessage(t.id, 'hi');
    mock.callbacks!.onToken('Hel'); mock.callbacks!.onToken('lo');
    mock.callbacks!.onMessage('Hello', []);
    mock.callbacks!.onDone('s1', 0, 1);
    await flush();
    expect(events.map(e => e.type)).toEqual(['user_message_added', 'streaming_start', 'token', 'token', 'message', 'done', 'run_state_settled']);
    const msgEvt = events.find(e => e.type === 'message') as Extract<ThreadEvent, { type: 'message' }>;
    expect(msgEvt.message.role).toBe('assistant');
    expect(m.isRunning(t.id)).toBe(false);
  });

  it('send while in flight coalesces: no `queued`, 2 user messages, one session', async () => {
    const m = makeManager(); const t = m.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    m.subscribe((_, e) => events.push(e));
    await m.sendMessage(t.id, 'one');
    await m.sendMessage(t.id, 'two');
    expect(events.filter(e => e.type === 'user_message_added')).toHaveLength(2);
    expect(events.some(e => e.type === 'queued')).toBe(false);
    expect(m.getQueuedMessages(t.id)).toEqual([]);
    expect(mock.constructCount).toBe(1);
  });

  it('`queued` is emitted only on the local gate (pending plan): message NOT appended, not sent', async () => {
    const m = makeManager(); const t = m.createThread('T', os.tmpdir());
    (t as unknown as { pendingPlan: string }).pendingPlan = 'plan';
    const events: ThreadEvent[] = [];
    m.subscribe((_, e) => events.push(e));
    await m.sendMessage(t.id, 'held');
    expect(events.map(e => e.type)).toEqual(['queued']);
    expect(t.messages).toHaveLength(0); // no user_message_added until dequeued
    expect(mock.sendCallCount).toBe(0);
    expect(m.getQueuedMessages(t.id)).toEqual([{ text: 'held', images: undefined }]);
  });

  it('interrupt(): emits `interrupted` and ROLLS BACK unresolved user messages from thread.messages (no per-message removal event)', async () => {
    const m = makeManager(); const t = m.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    m.subscribe((_, e) => events.push(e));
    await m.sendMessage(t.id, 'one');
    await m.sendMessage(t.id, 'two');
    expect(t.messages).toHaveLength(2);
    await m.interrupt(t.id);
    await flush();
    expect(t.messages).toHaveLength(0);
    expect(events.map(e => e.type).slice(-2)).toEqual(['interrupted', 'run_state_settled']);
    expect(m.isRunning(t.id)).toBe(false);
  });

  it('two UI surfaces subscribed to one thread: each sees each event exactly once; one send => one message', async () => {
    const m = makeManager(); const t = m.createThread('T', os.tmpdir());
    const a: ThreadEvent[] = []; const b: ThreadEvent[] = [];
    m.subscribe((_, e) => a.push(e)); m.subscribe((_, e) => b.push(e));
    await m.sendMessage(t.id, 'from dock');
    mock.callbacks!.onMessage('reply', []); mock.callbacks!.onDone('s', 0, 1);
    await flush();
    expect(a.map(e => e.type)).toEqual(b.map(e => e.type));
    expect(a.filter(e => e.type === 'user_message_added')).toHaveLength(1);
    expect(a.filter(e => e.type === 'message')).toHaveLength(1);
    expect(t.messages.map(x => x.role)).toEqual(['user', 'assistant']);
  });

  it('manager does NOT dedupe: two surfaces each calling sendMessage with the same text => two sends (guard must be in the UI)', async () => {
    const m = makeManager(); const t = m.createThread('T', os.tmpdir());
    await m.sendMessage(t.id, 'same'); await m.sendMessage(t.id, 'same');
    expect(t.messages.filter(x => x.role === 'user')).toHaveLength(2);
  });
});

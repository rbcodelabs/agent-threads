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
const { Scheduler } = await import('../../src/Scheduler');

function makeManager(overrides = {}) {
  return new ThreadManager({ ...DEFAULT_SETTINGS, ...overrides });
}

// Helper: drive a complete successful response through the mock
function driveResponse(content: string, sessionId = 'sess-1') {
  const cb = mock.callbacks!;
  cb.onToken(content);
  cb.onMessage(content, []);
  cb.onDone(sessionId, 0.001, 1);
}

beforeEach(() => {
  mock.callbacks = null;
  mock.prompt = null;
  mock.sentPrompts = [];
  mock.images = undefined;
  mock.sentImages = [];
  mock.sentUserMessageUuids = [];
  mock.model = undefined;
  mock.resumeSessionId = undefined;
  mock.lastKnownSessionId = undefined;
  mock.constructCount = 0;
  mock.startCallCount = 0;
  mock.sendCallCount = 0;
});

describe('send message → event flow', () => {
  it('emits user_message_added, streaming_start, token, message, done in order', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'Hello');
    driveResponse('Hi there');

    // 'run_state_settled' fires once turnInFlight has actually flipped false
    // (deferred via queueMicrotask — see run-state-settled.test.ts) — flush
    // one microtask so it lands before asserting the full sequence.
    await Promise.resolve();
    await Promise.resolve();

    expect(events.map(e => e.type)).toEqual(['user_message_added', 'streaming_start', 'token', 'message', 'done', 'run_state_settled']);
  });

  it('appends user and assistant messages to the thread', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    await manager.sendMessage(thread.id, 'Ping');
    driveResponse('Pong');

    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[0]).toMatchObject({ role: 'user', content: 'Ping' });
    expect(thread.messages[1]).toMatchObject({ role: 'assistant', content: 'Pong' });
  });

  it('forwards the created user message id to the harness', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    await manager.sendMessage(thread.id, 'Correlate me');

    expect(mock.sentUserMessageUuids).toEqual([thread.messages[0].id]);
  });

  it('stores sessionId and cost on done', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onToken('Hey');
    mock.callbacks!.onMessage('Hey', []);
    mock.callbacks!.onDone('session-xyz', 0.0042, 1);

    expect(thread.sessionId).toBe('session-xyz');
    expect(thread.messages[1].cost).toBe(0.0042);
  });

  it('isRunning is true during session, false after done', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    await manager.sendMessage(thread.id, 'Hi');
    expect(manager.isRunning(thread.id)).toBe(true);
    driveResponse('Done');
    expect(manager.isRunning(thread.id)).toBe(false);
  });

  it('a second sendMessage() while the first is in flight coalesces into the SAME generation — there is no queue anymore (ADR-0002)', async () => {
    // ADR-0002 §2's live-CLI probe confirmed send() is safe to call
    // unconditionally, even while a turn is already in flight — the CLI
    // itself coalesces a concurrent push into the generation already
    // running. ThreadManager.sendMessage() no longer has an "is this thread
    // busy?" gate to queue behind (queuedMessages/'queued'/'dequeued' are
    // unreachable dead code paths now — nothing in sendMessage() ever
    // writes to that map anymore).
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'First');
    await manager.sendMessage(thread.id, 'Second');

    expect(events.find(e => e.type === 'queued')).toBeUndefined();
    expect(mock.constructCount).toBe(1); // same ThreadSession, not a second one
    expect(mock.sendCallCount).toBe(2);
    expect(thread.messages.filter(m => m.role === 'user')).toHaveLength(2);
    expect(thread.messages[0].content).toBe('First');
    expect(thread.messages[1].content).toBe('Second');

    // Both pushes land in the same live generation — one onDone answers both.
    driveResponse('Reply');

    expect(thread.messages.filter(m => m.role === 'assistant')).toHaveLength(1);
    expect(events.find(e => e.type === 'dequeued')).toBeUndefined();
  });

  it('a second sendMessage() with images while the first is in flight pushes the images straight through send() (no queue to preserve them in)', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const attachment = { type: 'base64' as const, mediaType: 'image/png' as const, data: 'abc123', name: 'shot.png' };

    await manager.sendMessage(thread.id, 'First');
    await manager.sendMessage(thread.id, 'Second', [attachment]);

    expect(mock.sentImages[1]).toEqual([attachment]);
    expect(thread.messages[1].images).toEqual([attachment]);

    driveResponse('Reply');
    expect(thread.messages.filter(m => m.role === 'assistant')).toHaveLength(1);
  });

  it('emits error event and cleans up session on failure', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onError(new Error('Network failure'));

    expect(events.find(e => e.type === 'error')).toBeTruthy();
    expect(manager.isRunning(thread.id)).toBe(false);
  });

  it('throws when thread id does not exist', async () => {
    const manager = makeManager();
    await expect(manager.sendMessage('bad-id', 'Hi')).rejects.toThrow('Thread not found');
  });
});

describe('model escalation', () => {
  it('emits escalated event when keyword present (independent of whether the model actually reaches the session)', async () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '/opus', escalationModel: 'opus' });
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, '/opus design the architecture');
    driveResponse('Here is the design');

    const escalated = events.find(e => e.type === 'escalated') as { type: 'escalated'; model: string } | undefined;
    expect(escalated).toBeTruthy();
    expect(escalated!.model).toBe('opus');
  });

  it('regression (found while rewriting this suite, then fixed): the escalation keyword\'s model reaches the session on a thread\'s first-ever message too', async () => {
    // ThreadManager.sendMessage() computes an escalation-aware `model` local
    // (`keywordModel ?? thread.model ?? settings.defaultModel`) but
    // buildThreadSessionOptions() (the object passed to a NEW session's
    // start()) used to independently recompute its own `model` field as just
    // `thread.model ?? settings.defaultModel`, never consulting the
    // escalation-aware local — so a thread's very first message silently
    // dropped the /escalate keyword, even though sendMessage()'s `else`
    // branch (an EXISTING session) already applied it correctly via
    // `session.setModel()` (see the next test). Fixed by threading the
    // escalation-aware `model` into buildThreadSessionOptions() as an
    // explicit `modelOverride` parameter, used only by sendMessage() — other
    // call sites (e.g. setThreadCwd()'s cwd-change restart) correctly omit
    // it, since there's no user message/escalation keyword in that context.
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '/opus', escalationModel: 'opus' });
    const thread = manager.createThread('T', os.tmpdir());

    await manager.sendMessage(thread.id, '/opus design the architecture');
    driveResponse('Here is the design');

    expect(mock.model).toBe('opus');
  });

  it('escalation DOES correctly reach the session via setModel() on a later turn of an already-started session', async () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '/opus', escalationModel: 'opus' });
    const thread = manager.createThread('T', os.tmpdir());

    // First turn — no escalation keyword, establishes the session.
    await manager.sendMessage(thread.id, 'plain message');
    driveResponse('ok', 'sess-1');
    expect(mock.model).toBeUndefined();

    // Second turn — same (already-started) session, escalation keyword now
    // present. This goes through sendMessage()'s `else` branch
    // (`await session.setModel(model)`), which DOES use the correct
    // escalation-aware `model` local — unlike the new-session start() path
    // exercised by the previous test.
    await manager.sendMessage(thread.id, '/opus now go big');
    driveResponse('ok', 'sess-1');
    expect(mock.model).toBe('opus');
  });

  it('strips keyword from prompt sent to Claude', async () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '/opus', escalationModel: 'opus' });
    const thread = manager.createThread('T', os.tmpdir());

    await manager.sendMessage(thread.id, '/opus write me a poem');
    driveResponse('Roses are red');

    expect(mock.prompt).toBe('write me a poem');
  });

  it('preserves original text in the stored user message', async () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '/opus', escalationModel: 'opus' });
    const thread = manager.createThread('T', os.tmpdir());

    await manager.sendMessage(thread.id, '/opus write me a poem');
    driveResponse('Roses are red');

    expect(thread.messages[0].content).toBe('/opus write me a poem');
  });

  it('does not escalate when feature is disabled', async () => {
    const manager = makeManager({ escalationEnabled: false, escalationKeyword: '/opus', escalationModel: 'opus' });
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, '/opus do something');
    driveResponse('OK');

    expect(events.find(e => e.type === 'escalated')).toBeUndefined();
    expect(mock.model).toBeUndefined();
  });

  it('does not escalate when keyword not in message', async () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '/opus', escalationModel: 'opus' });
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'just a normal message');
    driveResponse('Sure');

    expect(events.find(e => e.type === 'escalated')).toBeUndefined();
    expect(mock.model).toBeUndefined();
  });

  it('respects custom escalation keyword', async () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '!expert', escalationModel: 'opus' });
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, '!expert help me');
    driveResponse('Expert answer');

    expect(events.find(e => e.type === 'escalated')).toBeTruthy();
    expect(mock.prompt).toBe('help me');
  });
});

describe('permission handler', () => {
  it('stays pending for Kanban classification until the user responds', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    let respond!: (allow: boolean) => void;
    manager.permissionHandler = () => new Promise<boolean>((resolve) => { respond = resolve; });

    await manager.sendMessage(thread.id, 'Hi');
    const resultPromise = mock.callbacks!.onPermissionRequest('MCP: github', 'Allow search_repositories?');
    await Promise.resolve();

    expect(manager.hasPendingPermission(thread.id)).toBe(true);
    expect(manager.getPendingPermission(thread.id)).toEqual({
      toolName: 'MCP: github',
      detail: 'Allow search_repositories?',
    });

    respond(true);
    await expect(resultPromise).resolves.toBe(true);
    expect(manager.hasPendingPermission(thread.id)).toBe(false);
    driveResponse('Done');
  });

  it('calls permissionHandler and allows when it resolves true', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    manager.permissionHandler = async () => true;

    await manager.sendMessage(thread.id, 'Hi');
    const result = await mock.callbacks!.onPermissionRequest('Write', '/some/file.ts');
    driveResponse('Done');

    expect(result).toBe(true);
  });

  it('calls permissionHandler and denies when it resolves false', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    manager.permissionHandler = async () => false;

    await manager.sendMessage(thread.id, 'Hi');
    const result = await mock.callbacks!.onPermissionRequest('Bash', 'rm -rf /');
    driveResponse('Done');

    expect(result).toBe(false);
  });

  describe('concurrent requests on one thread', () => {
    const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

    it('serializes: only the first is pending; resolving it surfaces the second', async () => {
      const manager = makeManager();
      const thread = manager.createThread('T', os.tmpdir());
      const asked: string[] = [];
      const responders: Array<(allow: boolean) => void> = [];
      manager.permissionHandler = (_id, _tool, detail) => new Promise<boolean>((resolve) => {
        asked.push(detail);
        responders.push(resolve);
      });
      const events: ThreadEvent[] = [];
      manager.subscribe((_, e) => events.push(e));

      await manager.sendMessage(thread.id, 'Hi');
      const first = mock.callbacks!.onPermissionRequest('Read', 'a.md');
      const second = mock.callbacks!.onPermissionRequest('Read', 'b.md');
      await flush();

      expect(asked).toEqual(['a.md']);
      expect(manager.getPendingPermission(thread.id)).toEqual({ toolName: 'Read', detail: 'a.md' });
      expect(events.filter(e => e.type === 'permission_request')).toHaveLength(1);

      responders[0](true);
      await expect(first).resolves.toBe(true);
      await flush();

      expect(asked).toEqual(['a.md', 'b.md']);
      expect(manager.getPendingPermission(thread.id)).toEqual({ toolName: 'Read', detail: 'b.md' });

      responders[1](false);
      await expect(second).resolves.toBe(false);
      expect(manager.hasPendingPermission(thread.id)).toBe(false);
      expect(events.filter(e => e.type === 'permission_request')).toHaveLength(2);
      expect(events.filter(e => e.type === 'permission_resolved')).toHaveLength(2);
      driveResponse('Done');
    });

    it('a rejected earlier request does not block the next one', async () => {
      const manager = makeManager();
      const thread = manager.createThread('T', os.tmpdir());
      let call = 0;
      manager.permissionHandler = async () => {
        call += 1;
        if (call === 1) throw new Error('boom');
        return true;
      };

      await manager.sendMessage(thread.id, 'Hi');
      const first = mock.callbacks!.onPermissionRequest('Read', 'a.md');
      const second = mock.callbacks!.onPermissionRequest('Read', 'b.md');

      await expect(first).rejects.toThrow('boom');
      await expect(second).resolves.toBe(true);
      expect(manager.hasPendingPermission(thread.id)).toBe(false);
      driveResponse('Done');
    });

    it('denies a queued request whose session generation went stale while waiting', async () => {
      const manager = makeManager();
      const thread = manager.createThread('T', os.tmpdir());
      const asked: string[] = [];
      let respondFirst!: (allow: boolean) => void;
      manager.permissionHandler = (_id, _tool, detail) => new Promise<boolean>((resolve) => {
        asked.push(detail);
        if (asked.length === 1) respondFirst = resolve;
      });

      await manager.sendMessage(thread.id, 'Hi');
      const first = mock.callbacks!.onPermissionRequest('Read', 'a.md');
      const second = mock.callbacks!.onPermissionRequest('Read', 'b.md');
      await flush();

      thread.sessionGeneration = (thread.sessionGeneration ?? 0) + 1;
      respondFirst(true);
      await first;

      await expect(second).resolves.toBe(false);
      expect(asked).toEqual(['a.md']);
      expect(manager.hasPendingPermission(thread.id)).toBe(false);
    });
  });
});

describe('AskUserQuestion handler', () => {
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const q = (text: string) => [{ question: text, header: 'h', options: [{ label: 'a', description: '' }], multiSelect: false }] as any;

  it('serializes concurrent questions on one thread', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const asked: string[] = [];
    const responders: Array<(a: Record<string, string>) => void> = [];
    manager.questionHandler = (_id, questions) => new Promise((resolve) => {
      asked.push(questions[0].question);
      responders.push(resolve);
    });

    await manager.sendMessage(thread.id, 'Hi');
    const first = mock.callbacks!.onAskUserQuestion(q('one'));
    const second = mock.callbacks!.onAskUserQuestion(q('two'));
    await flush();

    expect(asked).toEqual(['one']);
    expect(thread.pendingQuestions?.[0].question).toBe('one');

    responders[0]({ one: 'a' });
    await expect(first).resolves.toEqual({ one: 'a' });
    await flush();

    expect(asked).toEqual(['one', 'two']);
    expect(thread.pendingQuestions?.[0].question).toBe('two');

    responders[1]({ two: 'b' });
    await expect(second).resolves.toEqual({ two: 'b' });
    expect(thread.pendingQuestions).toBeUndefined();
    driveResponse('Done');
  });

  it('a rejected earlier question does not block the next one', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    let call = 0;
    manager.questionHandler = async () => {
      call += 1;
      if (call === 1) throw new Error('boom');
      return { ok: 'yes' };
    };

    await manager.sendMessage(thread.id, 'Hi');
    const first = mock.callbacks!.onAskUserQuestion(q('one'));
    const second = mock.callbacks!.onAskUserQuestion(q('two'));
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toEqual({ ok: 'yes' });
    driveResponse('Done');
  });

  it('interrupt releases the active question and drops queued ones without prompting', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const asked: string[] = [];
    manager.questionHandler = (id, questions) => new Promise((resolve) => {
      asked.push(questions[0].question);
      manager.registerQuestionResolver(id, resolve);
    });

    await manager.sendMessage(thread.id, 'Hi');
    const first = mock.callbacks!.onAskUserQuestion(q('one'));
    const second = mock.callbacks!.onAskUserQuestion(q('two'));
    await flush();

    await manager.interrupt(thread.id);
    await expect(first).resolves.toEqual({});
    await expect(second).resolves.toEqual({});
    expect(asked).toEqual(['one']);
    expect(thread.pendingQuestions).toBeUndefined();
  });
});

describe('tool use events', () => {
  it('emits tool_use event and stores tool calls on message', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'Do something');
    const toolRecord = { name: 'Write', summary: 'Write: src/foo.ts' };
    mock.callbacks!.onToolUse(toolRecord);
    mock.callbacks!.onMessage('Done', [toolRecord]);
    mock.callbacks!.onDone('s1', 0, 1);

    const toolEvent = events.find(e => e.type === 'tool_use') as { type: 'tool_use'; record: typeof toolRecord } | undefined;
    expect(toolEvent?.record.name).toBe('Write');
    const assistantMsg = thread.messages.find(m => m.role === 'assistant');
    expect(assistantMsg?.toolCalls?.[0].name).toBe('Write');
  });
});

describe('recap events', () => {
  it('stores recap on thread and emits recap event', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onRecap('Used Write (2 calls)');
    driveResponse('Done');

    expect(thread.recap).toBe('Used Write (2 calls)');
    expect(events.find(e => e.type === 'recap')).toBeTruthy();
  });
});

describe('image attachments', () => {
  it('passes images to session.send', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const images: ImageAttachment[] = [
      { base64: 'abc123', mediaType: 'image/png', name: 'screenshot.png' },
    ];

    await manager.sendMessage(thread.id, 'Look at this', images);
    driveResponse('I see it');

    expect(mock.images).toEqual(images);
    expect(mock.prompt).toBe('Look at this');
  });

  it('passes undefined images when none provided', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    await manager.sendMessage(thread.id, 'No images here');
    driveResponse('OK');

    expect(mock.images).toBeUndefined();
  });

  it('stores user message content as the text prompt regardless of images', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const images: ImageAttachment[] = [
      { base64: 'xyz', mediaType: 'image/jpeg', name: 'photo.jpg' },
    ];

    await manager.sendMessage(thread.id, 'Describe this', images);
    driveResponse('Sure');

    expect(thread.messages[0]).toMatchObject({ role: 'user', content: 'Describe this' });
  });
});

describe('system events', () => {
  it('emits status event when onStatus is called', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onStatus!('compacting');
    driveResponse('Done');

    const statusEvent = events.find(e => e.type === 'status') as { type: 'status'; status: string } | undefined;
    expect(statusEvent?.status).toBe('compacting');
  });

  it('emits status null to clear compacting', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onStatus!(null);
    driveResponse('Done');

    const statusEvent = events.find(e => e.type === 'status') as { type: 'status'; status: null } | undefined;
    expect(statusEvent?.status).toBeNull();
  });

  it('emits task_started event', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskStarted!('task-1', 'Running security audit', false);
    driveResponse('Done');

    const taskEvent = events.find(e => e.type === 'task_started') as
      { type: 'task_started'; taskId: string; description: string; skipTranscript: boolean } | undefined;
    expect(taskEvent?.taskId).toBe('task-1');
    expect(taskEvent?.description).toBe('Running security audit');
    expect(taskEvent?.skipTranscript).toBe(false);
  });

  it('emits task_progress event', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskProgress!('task-1', 'Scanning files', 'Grep');
    driveResponse('Done');

    const evt = events.find(e => e.type === 'task_progress') as
      { type: 'task_progress'; taskId: string; description: string; lastToolName?: string } | undefined;
    expect(evt?.taskId).toBe('task-1');
    expect(evt?.lastToolName).toBe('Grep');
  });

  it('emits task_notification on completion', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskNotification!('task-1', 'completed', 'Found 3 issues');
    driveResponse('Done');

    const evt = events.find(e => e.type === 'task_notification') as
      { type: 'task_notification'; taskId: string; status: string; summary: string } | undefined;
    expect(evt?.status).toBe('completed');
    expect(evt?.summary).toBe('Found 3 issues');
  });

  it('emits task_notification on failure', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskNotification!('task-1', 'failed', 'Timed out');
    driveResponse('Done');

    const evt = events.find(e => e.type === 'task_notification') as
      { type: 'task_notification'; status: string } | undefined;
    expect(evt?.status).toBe('failed');
  });

  it('emits notification event', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onNotification!('Deploy succeeded', 'high');
    driveResponse('Done');

    const evt = events.find(e => e.type === 'notification') as
      { type: 'notification'; text: string; priority: string } | undefined;
    expect(evt?.text).toBe('Deploy succeeded');
    expect(evt?.priority).toBe('high');
  });

  it('emits api_retry event', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onApiRetry!(1, 3, 'server_error');
    driveResponse('Done');

    const evt = events.find(e => e.type === 'api_retry') as
      { type: 'api_retry'; attempt: number; maxRetries: number; error: string } | undefined;
    expect(evt?.attempt).toBe(1);
    expect(evt?.maxRetries).toBe(3);
    expect(evt?.error).toBe('server_error');
  });

  it('emits rate_limit event for rejected status', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onRateLimit!('rejected', 1700000000000);
    driveResponse('Done');

    const evt = events.find(e => e.type === 'rate_limit') as
      { type: 'rate_limit'; limitStatus: string; resetsAt?: number } | undefined;
    expect(evt?.limitStatus).toBe('rejected');
    expect(evt?.resetsAt).toBe(1700000000000);
  });

  it('emits rate_limit event for warning status without resetsAt', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onRateLimit!('allowed_warning', undefined);
    driveResponse('Done');

    const evt = events.find(e => e.type === 'rate_limit') as
      { type: 'rate_limit'; limitStatus: string; resetsAt?: number } | undefined;
    expect(evt?.limitStatus).toBe('allowed_warning');
    expect(evt?.resetsAt).toBeUndefined();
  });
});

describe('reconnecting status — auto-retry transport-error signal (Stage D regression)', () => {
  // Under the old per-turn ClaudeSession model, ThreadManager.sendMessage()'s
  // own onError branch drove the "reconnecting" UI state directly, because a
  // transport-error retry was a brand-new sendMessage() call. Under
  // ThreadSession, the retry is entirely internal (restart() + a
  // continuation send(), inside ThreadSession.pumpMessages()'s catch block —
  // see ADR-0002 Stage D) — ThreadManager only finds out via the new
  // onReconnecting callback. This describe block exercises the ThreadManager
  // wiring that consumes it: `onReconnecting` sets thread.status and emits
  // 'reconnecting', and `clearReconnectingStatus()` (invoked from
  // onToken/onMessage/onStatus — whichever fires first once the continuation
  // resumes) clears it back to 'active'.
  it('sets thread.status to reconnecting, emits the event, and clears back to active once onToken fires', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'Hi');
    expect(thread.status).toBe('active');

    mock.callbacks!.onReconnecting!('Stream closed');

    expect(thread.status).toBe('reconnecting');
    const reconnectEvt = events.find(e => e.type === 'reconnecting') as
      Extract<ThreadEvent, { type: 'reconnecting' }> | undefined;
    expect(reconnectEvt).toBeTruthy();
    expect(reconnectEvt!.error).toBe('Stream closed');

    // includePartialMessages streams text deltas before the final assistant
    // message — onToken is expected to fire first in the common case.
    mock.callbacks!.onToken('continuing...');
    expect(thread.status).toBe('active');
  });

  it('clears via onMessage when the continuation\'s first action has no preceding token deltas (e.g. straight to a tool call)', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onReconnecting!('Stream closed');
    expect(thread.status).toBe('reconnecting');

    mock.callbacks!.onMessage('resumed', []);
    expect(thread.status).toBe('active');
  });

  it('clears via onStatus when the continuation immediately flips a compacting/requesting status', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onReconnecting!('Stream closed');
    expect(thread.status).toBe('reconnecting');

    mock.callbacks!.onStatus!('compacting');
    expect(thread.status).toBe('active');
  });

  it('does NOT clear on an unrelated status while not reconnecting (guard: only leaves the reconnecting state, never re-enters it via a stray clear)', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    await manager.sendMessage(thread.id, 'Hi');
    expect(thread.status).toBe('active');

    // No onReconnecting fired — a normal onToken must simply leave status alone.
    mock.callbacks!.onToken('normal streaming');
    expect(thread.status).toBe('active');
  });
});

describe('interrupt / stop behavior', () => {
  it('emits interrupted event (not done) when stop is hit', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'Hello');
    await manager.interrupt(thread.id);

    const types = events.map(e => e.type);
    expect(types).toContain('interrupted');
    expect(types).not.toContain('done');
  });

  it('rolls back the orphaned user message from thread.messages', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    await manager.sendMessage(thread.id, 'Hello');
    // Message is in the array while running
    expect(thread.messages).toHaveLength(1);
    await manager.interrupt(thread.id);

    // After interrupt it should be removed
    expect(thread.messages).toHaveLength(0);
  });

  it('preserves the prior session ID — does not corrupt it', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    thread.sessionId = 'prior-session-id';

    await manager.sendMessage(thread.id, 'Hello');
    await manager.interrupt(thread.id);

    expect(thread.sessionId).toBe('prior-session-id');
  });

  it('isRunning is false after interrupt', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    await manager.sendMessage(thread.id, 'Hello');
    expect(manager.isRunning(thread.id)).toBe(true);
    await manager.interrupt(thread.id);
    expect(manager.isRunning(thread.id)).toBe(false);
  });

  it('preserves all prior messages from successful turns — only interrupted turn is rolled back', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    // First turn completes successfully
    await manager.sendMessage(thread.id, 'First');
    driveResponse('First response', 'sess-1');

    expect(thread.messages).toHaveLength(2);

    // Second message gets interrupted before any response
    await manager.sendMessage(thread.id, 'Second');
    await manager.interrupt(thread.id);

    // Only the first turn's messages remain; session ID is still the successful one
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[0]).toMatchObject({ role: 'user', content: 'First' });
    expect(thread.messages[1]).toMatchObject({ role: 'assistant', content: 'First response' });
    expect(thread.sessionId).toBe('sess-1');
  });

  it('the same ThreadSession persists across an interrupted turn and a resumed one — session continuity is the SDK\'s job now, not a per-turn resume parameter', async () => {
    // Under the old per-turn ClaudeSession model, each turn constructed a
    // brand-new session and had to be told which sessionId to resume via a
    // fresh `resume` argument — this test used to assert that 3rd-turn
    // argument was 'sess-1', not corrupted by the interrupted 2nd turn.
    // Under ThreadSession there is only ever ONE Query for the thread's
    // whole lifetime (constructed once, on the very first turn) — later
    // turns just push onto the same open channel, with no re-resume step to
    // get right or wrong. What actually matters now: the SAME ThreadSession
    // instance persists through the interrupt (never torn down/reconstructed)
    // and thread.sessionId still ends up correct once a later turn succeeds.
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    await manager.sendMessage(thread.id, 'First');
    driveResponse('First response', 'sess-1');
    expect(mock.constructCount).toBe(1);
    expect(mock.resumeSessionId).toBeUndefined(); // brand-new thread, nothing to resume

    await manager.sendMessage(thread.id, 'Interrupted');
    await manager.interrupt(thread.id);

    await manager.sendMessage(thread.id, 'Third');
    driveResponse('Third response', 'sess-2');

    expect(mock.constructCount).toBe(1); // never reconstructed
    expect(thread.messages).toHaveLength(4);
    expect(thread.sessionId).toBe('sess-2');
  });

  it('interrupting after a coalesced second message rolls back both — no dequeued/queued event ever fires (nothing was ever queued)', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'First');
    await manager.sendMessage(thread.id, 'Queued');

    expect(thread.messages).toHaveLength(2);

    await manager.interrupt(thread.id);

    expect(thread.messages).toHaveLength(0);
    expect(events.find(e => e.type === 'dequeued')).toBeUndefined();
    expect(events.find(e => e.type === 'queued')).toBeUndefined();
  });
});

describe('Scheduler + ThreadManager: busy-thread dedup on loop tick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as Record<string, unknown>).window = globalThis;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).window;
  });

  it('defers a loop tick that arrives while the kickoff turn is still running', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    const scheduler = new Scheduler({
      getItems: () => [],
      saveItem: async () => {},
      removeItem: async () => {},
      createThread: () => ({ id: 'unused' }),
      sendMessage: (id, prompt) => manager.sendMessage(id, prompt),
      getDefaultCwd: () => os.tmpdir(),
      threadExists: (id) => id === thread.id,
      isThreadBusy: (id) => manager.isRunning(id),
    });
    scheduler.start([]);

    // Simulate Fix 1's immediate kickoff: a message is sent right away and is
    // still in flight (no onDone/onError/onInterrupted has fired yet).
    await manager.sendMessage(thread.id, 'kickoff prompt');
    expect(manager.isRunning(thread.id)).toBe(true);
    expect(mock.sendCallCount).toBe(1);

    scheduler.createItem({
      name: 'Loop: recurring',
      prompt: 'loop prompt',
      schedule: { type: 'interval', intervalSeconds: 10 },
      enabled: true,
      targetThreadId: thread.id,
    });

    // The interval elapses while the kickoff turn is still running. The tick
    // must be deferred (retried) rather than firing a second sendMessage
    // that would coalesce into the still-live generation as an unrelated
    // duplicate turn.
    await vi.advanceTimersByTimeAsync(11_000);
    expect(mock.sendCallCount).toBe(1);

    // Finish the kickoff turn — the thread becomes free.
    const cb = mock.callbacks!;
    cb.onToken('kickoff done');
    cb.onMessage('kickoff done', []);
    cb.onDone('sess-1', 0.001, 1);
    expect(manager.isRunning(thread.id)).toBe(false);

    // The scheduler's retry (capped at 15s) should now find the thread free
    // and send the loop prompt exactly once.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mock.sendCallCount).toBe(2);
    expect(mock.sentPrompts[1]).toBe('loop prompt');

    // Clean up the still-running loop turn so the test doesn't leak a
    // dangling promise.
    await manager.interrupt(thread.id);
    scheduler.destroy();
  });
});

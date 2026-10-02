/**
 * Tests for the new message handler callbacks added in the SDK alignment gap pass:
 *   - model_fallback    → onModelFallback
 *   - task_updated      → onTaskUpdated (patch applied to thread via ThreadManager)
 *   - tool_progress     → onToolProgress
 *   - memory_recall     → onMemoryRecall
 *   - commands_changed  → onCommandsChanged
 *   - permission_denied → onPermissionDenied
 *
 * Pattern: mock ThreadSession (ADR-0002 Stage 2 — replaces the old per-turn
 * ClaudeSession) so test code drives individual callbacks directly through
 * ThreadManager.sendMessage(), then assert on the ThreadEvents emitted.
 *
 * Mock shape notes (see ThreadSession's real contract in src/ThreadSession.ts):
 *   - start(options) captures options.callbacks and resolves immediately —
 *     it does NOT block for the turn's lifetime the way the old ClaudeSession
 *     mock's run() did. ThreadManager.sendMessage() itself resolves shortly
 *     after start()/send(), well before a 'done'/'error'/'interrupted' — so
 *     tests `await manager.sendMessage(...)` and then drive `mock.callbacks!`
 *     synchronously, rather than holding a `sendPromise` open until the mock
 *     "resolves" it (there is no separate resolve step anymore).
 *   - send(text, images) is synchronous and sets turnInFlight = true.
 *   - turnInFlight flips back to false right after onDone/onInterrupted/
 *     onError is invoked, mirroring ThreadSession.pumpMessages()'s real
 *     case 'result': handler (callback fires, then the flag flips).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { ThreadSessionOptions } from '../../src/ThreadSession';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { ImageAttachment } from '../../src/types';
import type { ThreadEvent } from '../../src/ThreadManager';

// ─── hoisted mock state ───────────────────────────────────────────────────────

const mock = vi.hoisted(() => ({
  callbacks: null as SessionCallbacks | null,
  lastKnownSessionId: undefined as string | undefined,
  startCallCount: 0,
  sendCallCount: 0,
}));

vi.mock('../../src/ThreadSession', () => ({
  ThreadSession: class {
    private _turnInFlight = false;
    constructor(_claudePath: string) {}
    get turnInFlight(): boolean { return this._turnInFlight; }
    async start(options: ThreadSessionOptions): Promise<void> {
      mock.startCallCount += 1;
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
    send(_text: string, _images?: ImageAttachment[]): void {
      mock.sendCallCount += 1;
      this._turnInFlight = true;
    }
    async interrupt(): Promise<void> {
      mock.callbacks?.onInterrupted(mock.lastKnownSessionId ?? '');
    }
    async setModel(_model?: string): Promise<void> {}
    async setPermissionMode(_mode: unknown): Promise<void> {}
    async restart(): Promise<void> {}
    close(): void {}
    async getContextUsage(): Promise<null> { return null; }
    async getUsageSnapshot(): Promise<import('../../src/Usage').UsageSnapshot | null> { return null; }
  },
}));

const { ThreadManager } = await import('../../src/ThreadManager');

function makeManager() {
  return new ThreadManager({ ...DEFAULT_SETTINGS });
}

function driveResponse(sessionId = 'sess-1') {
  const cb = mock.callbacks!;
  cb.onToken('ok');
  cb.onMessage('ok', []);
  cb.onDone(sessionId, 0.001, 1);
}

beforeEach(() => {
  mock.callbacks = null;
  mock.lastKnownSessionId = undefined;
  mock.startCallCount = 0;
  mock.sendCallCount = 0;
});

describe('usage snapshot propagation', () => {
  it('stores the latest provider snapshot and emits a usage event', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, event) => events.push(event));
    await manager.sendMessage(thread.id, 'hi');

    mock.callbacks!.onUsage!({
      provider: 'claude', updatedAt: 123, estimatedCostUsd: 0.1,
      quotaWindows: [{ label: 'Five hour', usedPercent: 80 }],
    });

    expect(manager.getThread(thread.id)?.usageSnapshot).toMatchObject({ provider: 'claude', estimatedCostUsd: 0.1 });
    expect(events).toContainEqual(expect.objectContaining({ type: 'usage' }));
    driveResponse();
  });
});

// ─── model_fallback ───────────────────────────────────────────────────────────

describe('model_fallback → onModelFallback', () => {
  it('emits model_fallback event with trigger, fromModel, toModel', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onModelFallback!('overloaded', 'claude-opus-4', 'claude-sonnet-4-5');
    driveResponse();

    const evt = events.find(e => e.type === 'model_fallback') as
      Extract<ThreadEvent, { type: 'model_fallback' }> | undefined;
    expect(evt).toBeDefined();
    expect(evt!.trigger).toBe('overloaded');
    expect(evt!.fromModel).toBe('claude-opus-4');
    expect(evt!.toModel).toBe('claude-sonnet-4-5');
  });

  it('does not throw when onModelFallback is called without a subscriber', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');

    await manager.sendMessage(thread.id, 'hi');
    expect(() =>
      mock.callbacks!.onModelFallback!('overloaded', 'model-a', 'model-b'),
    ).not.toThrow();
    driveResponse();
  });
});

// ─── active model ─────────────────────────────────────────────────────────────

describe('onActiveModel → thread.activeModel', () => {
  it('records the reported model once and emits active_model only on change', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onActiveModel!('us.anthropic.claude-opus-5-5');
    mock.callbacks!.onActiveModel!('us.anthropic.claude-opus-5-5');
    driveResponse();

    expect(manager.getThread(thread.id)?.activeModel).toBe('us.anthropic.claude-opus-5-5');
    expect(events.filter(e => e.type === 'active_model')).toHaveLength(1);
  });

  it('clears activeModel when the thread model selection changes', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    await manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onActiveModel!('claude-opus-4-8');
    driveResponse();

    manager.setThreadModel(thread.id, 'opus');
    expect(manager.getThread(thread.id)?.activeModel).toBeUndefined();
  });
});

describe('Claude refusal events', () => {
  it('emits distinct typed fallback and no-fallback events without replacing Codex fallback', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, event) => events.push(event));
    await manager.sendMessage(thread.id, 'hi');

    mock.callbacks!.onModelRefusalFallback!({
      content: 'Retried safely.', originalModel: 'opus', fallbackModel: 'sonnet',
      scope: 'session', category: 'cyber', explanation: 'Refused',
    });
    mock.callbacks!.onModelRefusalNoFallback!({
      content: 'Could not answer.', originalModel: 'opus', category: 'bio',
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'model_refusal_fallback', content: 'Retried safely.', fallbackModel: 'sonnet',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'model_refusal_no_fallback', content: 'Could not answer.', originalModel: 'opus',
    }));
    driveResponse();
  });
});

// ─── task_updated ─────────────────────────────────────────────────────────────

describe('task_updated → onTaskUpdated', () => {
  it('emits task_updated event with taskId and patch fields', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onTaskUpdated!('task-7', { status: 'completed', description: 'Done!' });
    driveResponse();

    const evt = events.find(e => e.type === 'task_updated') as
      Extract<ThreadEvent, { type: 'task_updated' }> | undefined;
    expect(evt).toBeDefined();
    expect(evt!.taskId).toBe('task-7');
    expect(evt!.status).toBe('completed');
    expect(evt!.description).toBe('Done!');
  });

  it('emits task_updated with error field when patch contains error', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onTaskUpdated!('task-3', { status: 'failed', error: 'Timeout after 30s' });
    driveResponse();

    const evt = events.find(e => e.type === 'task_updated') as
      Extract<ThreadEvent, { type: 'task_updated' }> | undefined;
    expect(evt).toBeDefined();
    expect(evt!.error).toBe('Timeout after 30s');
    expect(evt!.status).toBe('failed');
  });

  it('emits task_updated with only the provided patch fields', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onTaskUpdated!('task-1', { status: 'in_progress' });
    driveResponse();

    const evt = events.find(e => e.type === 'task_updated') as
      Extract<ThreadEvent, { type: 'task_updated' }> | undefined;
    expect(evt).toBeDefined();
    expect(evt!.status).toBe('in_progress');
    expect(evt!.description).toBeUndefined();
    expect(evt!.error).toBeUndefined();
  });
});

// ─── tool_progress ────────────────────────────────────────────────────────────

describe('tool_progress → onToolProgress', () => {
  it('emits tool_progress event with toolUseId, toolName, elapsedSeconds', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onToolProgress!('tool-use-abc', 'Bash', 14);
    driveResponse();

    const evt = events.find(e => e.type === 'tool_progress') as
      Extract<ThreadEvent, { type: 'tool_progress' }> | undefined;
    expect(evt).toBeDefined();
    expect(evt!.toolUseId).toBe('tool-use-abc');
    expect(evt!.toolName).toBe('Bash');
    expect(evt!.elapsedSeconds).toBe(14);
  });

  it('can fire multiple tool_progress events for the same tool', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onToolProgress!('tid-1', 'Bash', 5);
    mock.callbacks!.onToolProgress!('tid-1', 'Bash', 10);
    mock.callbacks!.onToolProgress!('tid-1', 'Bash', 15);
    driveResponse();

    const progressEvents = events.filter(e => e.type === 'tool_progress') as
      Extract<ThreadEvent, { type: 'tool_progress' }>[];
    expect(progressEvents).toHaveLength(3);
    expect(progressEvents.map(e => e.elapsedSeconds)).toEqual([5, 10, 15]);
  });
});

// ─── memory_recall ────────────────────────────────────────────────────────────

describe('memory_recall → onMemoryRecall', () => {
  it('emits memory_recall event with paths and mode', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onMemoryRecall!(
      ['~/.claude/CLAUDE.md', '~/projects/my-app/.claude/CLAUDE.md'],
      'select',
    );
    driveResponse();

    const evt = events.find(e => e.type === 'memory_recall') as
      Extract<ThreadEvent, { type: 'memory_recall' }> | undefined;
    expect(evt).toBeDefined();
    expect(evt!.paths).toEqual(['~/.claude/CLAUDE.md', '~/projects/my-app/.claude/CLAUDE.md']);
    expect(evt!.mode).toBe('select');
  });

  it('emits memory_recall with synthesize mode', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onMemoryRecall!(['~/.claude/CLAUDE.md'], 'synthesize');
    driveResponse();

    const evt = events.find(e => e.type === 'memory_recall') as
      Extract<ThreadEvent, { type: 'memory_recall' }> | undefined;
    expect(evt!.mode).toBe('synthesize');
  });
});

// ─── commands_changed ─────────────────────────────────────────────────────────

describe('commands_changed → onCommandsChanged', () => {
  it('emits commands_changed event with the command array', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const newCommands = [
      { name: 'brain-dump', description: 'Brain dump skill' },
      { name: 'deep-research', description: 'Deep research skill' },
    ];

    await manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onCommandsChanged!(newCommands as never);
    driveResponse();

    const evt = events.find(e => e.type === 'commands_changed') as
      Extract<ThreadEvent, { type: 'commands_changed' }> | undefined;
    expect(evt).toBeDefined();
    expect(evt!.commands).toHaveLength(2);
    expect(evt!.commands[0].name).toBe('brain-dump');
    expect(evt!.commands[1].name).toBe('deep-research');
  });

  it('emits commands_changed with an empty array when all skills are removed', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onCommandsChanged!([]);
    driveResponse();

    const evt = events.find(e => e.type === 'commands_changed') as
      Extract<ThreadEvent, { type: 'commands_changed' }> | undefined;
    expect(evt).toBeDefined();
    expect(evt!.commands).toEqual([]);
  });
});

// ─── permission_denied ────────────────────────────────────────────────────────

describe('permission_denied → onPermissionDenied', () => {
  it('emits permission_denied event with tool name, use id, message, and reason', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onPermissionDenied!('Bash', 'tool-use-9', 'Denied by rule', 'agent-2', 'rule');
    driveResponse();

    const evt = events.find(e => e.type === 'permission_denied') as
      Extract<ThreadEvent, { type: 'permission_denied' }> | undefined;
    expect(evt).toBeDefined();
    expect(evt!.toolName).toBe('Bash');
    expect(evt!.toolUseId).toBe('tool-use-9');
    expect(evt!.message).toBe('Denied by rule');
    expect(evt!.agentId).toBe('agent-2');
    expect(evt!.decisionReasonType).toBe('rule');
  });

  it('emits permission_denied with optional fields undefined when omitted', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    await manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onPermissionDenied!('Write', 'tool-use-1', 'Auto-denied');
    driveResponse();

    const evt = events.find(e => e.type === 'permission_denied') as
      Extract<ThreadEvent, { type: 'permission_denied' }> | undefined;
    expect(evt).toBeDefined();
    expect(evt!.toolName).toBe('Write');
    expect(evt!.agentId).toBeUndefined();
    expect(evt!.decisionReasonType).toBeUndefined();
  });

  it('does not throw when onPermissionDenied is called without a subscriber', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');

    await manager.sendMessage(thread.id, 'hi');
    expect(() =>
      mock.callbacks!.onPermissionDenied!('Bash', 'tid', 'nope'),
    ).not.toThrow();
    driveResponse();
  });
});

/**
 * Integration tests for plan mode persistence.
 *
 * Exercises the full lifecycle:
 *   onPlanReady → thread.pendingPlan set → events emitted
 *   approve / reject → pendingPlan cleared → original callback called
 *   onDone safety-net → stale pendingPlan wiped
 *   JSON round-trip → pendingPlan survives serialization (reload simulation)
 *   per-thread permissionMode → overrides global setting
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'os';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { ThreadSessionOptions } from '../../src/ThreadSession';
import type { ImageAttachment } from '../../src/types';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { ThreadEvent } from '../../src/ThreadManager';

// ─── Shared mock state (mirrors thread-manager-events.test.ts pattern) ────────

const mock = vi.hoisted(() => ({
  callbacks: null as SessionCallbacks | null,
  prompt: null as string | null,
  permissionMode: null as unknown,
  resumeSessionId: undefined as string | undefined,
}));

vi.mock('../../src/ThreadSession', () => ({
  ThreadSession: class {
    private _turnInFlight = false;
    constructor(_claudePath: string) {}
    get turnInFlight(): boolean { return this._turnInFlight; }
    async start(options: ThreadSessionOptions): Promise<void> {
      mock.permissionMode = options.permissionMode;
      mock.resumeSessionId = options.resume;
      const raw = options.callbacks;
      mock.callbacks = {
        ...raw,
        onDone: (sessionId, cost, numTurns) => {
          mock.resumeSessionId = sessionId;
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
    send(text: string, _images?: ImageAttachment[]): void {
      mock.prompt = text;
      this._turnInFlight = true;
    }
    async interrupt(): Promise<void> {
      mock.callbacks?.onInterrupted(mock.resumeSessionId ?? '');
      this._turnInFlight = false;
    }
    async setModel(_model?: string): Promise<void> {}
    async setPermissionMode(_mode: unknown): Promise<void> {}
    async restart(): Promise<void> {}
    close(): void {}
    async getContextUsage(): Promise<null> { return null; }
  },
}));

const { ThreadManager } = await import('../../src/ThreadManager');

function makeManager(overrides: Record<string, unknown> = {}) {
  return new ThreadManager({ ...DEFAULT_SETTINGS, ...overrides });
}

function driveResponse(content: string, sessionId = 'sess-1') {
  const cb = mock.callbacks!;
  cb.onToken(content);
  cb.onMessage(content, []);
  cb.onDone(sessionId, 0.001, 1);
}

/** Collect events emitted while a thunk runs, then wait for the session. */
async function collectEvents(
  manager: InstanceType<typeof ThreadManager>,
  threadId: string,
  fn: (events: ThreadEvent[]) => Promise<void> | void,
): Promise<ThreadEvent[]> {
  const events: ThreadEvent[] = [];
  const unsub = manager.subscribe((id, e) => { if (id === threadId) events.push(e); });
  try {
    await fn(events);
  } finally {
    unsub();
  }
  return events;
}

beforeEach(() => {
  mock.callbacks = null;
  mock.prompt = null;
  mock.permissionMode = null;
  mock.resumeSessionId = undefined;
});

// ─── pendingPlan lifecycle ────────────────────────────────────────────────────

describe('pendingPlan — set and persist', () => {
  it('persists a Codex-requested transition to per-thread Plan mode', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((id, event) => { if (id === thread.id) events.push(event); });

    await manager.sendMessage(thread.id, 'Investigate first');
    await mock.callbacks!.onPlanModeRequested!();

    expect(thread.permissionMode).toBe('plan');
    expect(events).toContainEqual({ type: 'permission_mode_changed', mode: 'plan' });
    driveResponse('Done');
  });

  it('emits Default mode only after approval has mutated the persisted thread', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    thread.agentHarness = 'codex';
    thread.permissionMode = 'plan';
    let modeAtEvent: unknown;
    let modeAtFirstSaveEvent: unknown;
    manager.subscribe((id, event) => {
      if (id !== thread.id) return;
      if (modeAtFirstSaveEvent === undefined
        && (event.type === 'permission_mode_changed' || event.type === 'pending_plan_changed')) {
        modeAtFirstSaveEvent = thread.permissionMode;
      }
      if (event.type === 'permission_mode_changed') modeAtEvent = thread.permissionMode;
    });

    // Build callbacks without selecting the real Codex adapter in this fixture.
    thread.agentHarness = 'claude';
    await manager.sendMessage(thread.id, 'Plan');
    thread.agentHarness = 'codex';
    mock.callbacks!.onPlanReady!('Plan', () => {}, () => false);
    modeAtFirstSaveEvent = undefined;
    manager.getPendingPlanResolvers(thread.id)!.approve();
    expect(thread.pendingPlan).toBe('Plan');
    expect(thread.permissionMode).toBe('plan');
    mock.callbacks!.onPlanApprovalCommitted!();

    expect(modeAtEvent).toBe('default');
    expect(modeAtFirstSaveEvent).toBe('default');
    expect(thread.permissionMode).toBe('default');
    driveResponse('Done');
  });

  it('keeps the Codex plan card and resolver retryable until approval settings commit', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    thread.permissionMode = 'plan';
    await manager.sendMessage(thread.id, 'Plan');
    thread.agentHarness = 'codex';
    const approve = vi.fn();
    mock.callbacks!.onPlanReady!('Retry me', approve, () => false);

    manager.getPendingPlanResolvers(thread.id)!.approve();
    mock.callbacks!.onPlanTransitionError!(new Error('settings failed'));

    expect(approve).toHaveBeenCalledOnce();
    expect(thread.permissionMode).toBe('plan');
    expect(thread.pendingPlan).toBe('Retry me');
    expect(manager.getPendingPlanResolvers(thread.id)).toBeDefined();
  });

  it('appends an explicit rejection reason after queued feedback without suppressing it', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const dequeued: string[] = [];
    manager.subscribe((id, event) => {
      if (id === thread.id && event.type === 'dequeued') dequeued.push(event.text);
    });

    await manager.sendMessage(thread.id, 'Plan');
    mock.callbacks!.onPlanReady!('Plan', () => {}, () => false);
    await manager.sendMessage(thread.id, 'First revision feedback');
    await manager.sendMessage(thread.id, 'Second revision feedback');

    const hadFeedback = manager.getPendingPlanResolvers(thread.id)!.reject();
    await manager.sendMessage(thread.id, 'Explicit rejection reason');
    await vi.waitFor(() => expect(dequeued).toHaveLength(3));

    expect(hadFeedback).toBe(true);
    expect(manager.getQueuedCount(thread.id)).toBe(0);
    expect(dequeued).toEqual([
      'First revision feedback',
      'Second revision feedback',
      'Explicit rejection reason',
    ]);
  });

  it('leaves rejection feedback queued when goal persistence blocks dispatch', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    await manager.sendMessage(thread.id, 'Plan');
    mock.callbacks!.onPlanReady!('Plan', () => {}, () => false);
    await manager.sendMessage(thread.id, 'Feedback');
    const state = (manager as any).getGoalContextState(thread.id);
    state.persistencePendingRevision = 1;

    manager.getPendingPlanResolvers(thread.id)!.reject();
    await Promise.resolve();

    expect(manager.getQueuedMessages(thread.id).map((item) => item.text)).toEqual(['Feedback']);
    expect((manager as any).releasingPlanFeedback.has(thread.id)).toBe(false);
  });

  it('surfaces a rejected feedback dispatch and clears its release gate', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const errors: Error[] = [];
    manager.subscribe((id, event) => { if (id === thread.id && event.type === 'error') errors.push(event.error); });
    (manager as any).queuedMessages.set(thread.id, [{ text: 'Feedback' }]);
    vi.spyOn(manager, 'sendMessage').mockRejectedValueOnce(new Error('dispatch rejected'));

    (manager as any).releaseRejectedPlanFeedback(thread.id);
    await vi.waitFor(() => expect(errors).toHaveLength(1));

    expect(errors[0].message).toBe('dispatch rejected');
    expect((manager as any).releasingPlanFeedback.has(thread.id)).toBe(false);
  });

  it('stops feedback draining when the thread is deleted', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    (manager as any).queuedMessages.set(thread.id, [{ text: 'Feedback' }]);
    const send = vi.spyOn(manager, 'sendMessage').mockImplementation(async () => {
      manager.deleteThread(thread.id);
    });

    (manager as any).releaseRejectedPlanFeedback(thread.id);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());

    expect(manager.getThread(thread.id)).toBeUndefined();
    expect((manager as any).releasingPlanFeedback.has(thread.id)).toBe(false);
  });

  it('queues fresh user sends while plan approval is pending and releases them after a later done', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    await manager.sendMessage(thread.id, 'Make a plan');
    mock.callbacks!.onPlanReady!('Plan', () => {}, () => {});
    const promptBeforePendingSend = mock.prompt;

    await manager.sendMessage(thread.id, 'Do not bypass the approval');

    expect(manager.getQueuedCount(thread.id)).toBe(1);
    expect(mock.prompt).toBe(promptBeforePendingSend);

    manager.getPendingPlanResolvers(thread.id)!.approve();
    driveResponse('Implementation done');
    await vi.waitFor(() => expect(manager.getQueuedCount(thread.id)).toBe(0));
    expect(mock.prompt).toBe('Do not bypass the approval');
  });

  it('sets thread.pendingPlan when onPlanReady fires', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    await manager.sendMessage(thread.id, 'Make a plan');
    // Simulate ClaudeSession calling the onPlanReady callback
    mock.callbacks!.onPlanReady!('Step 1\nStep 2', () => {}, () => {});

    expect(thread.pendingPlan).toBe('Step 1\nStep 2');

    driveResponse('Done');
  });

  it('emits pending_plan_changed with the plan text', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    const events = await collectEvents(manager, thread.id, async () => {
      await manager.sendMessage(thread.id, 'Make a plan');
      mock.callbacks!.onPlanReady!('Step 1\nStep 2', () => {}, () => {});
      driveResponse('Done');
    });

    const planChangedEvents = events.filter(e => e.type === 'pending_plan_changed') as
      Array<{ type: 'pending_plan_changed'; planText: string | undefined }>;
    // At least one 'set' event (plan arrives) plus one 'clear' event (onDone safety-net)
    expect(planChangedEvents.length).toBeGreaterThanOrEqual(1);
    expect(planChangedEvents[0].planText).toBe('Step 1\nStep 2');
  });

  it('plan_ready event carries the wrapped approve/reject callbacks', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    let capturedApprove: ((edited?: string) => void) | undefined;
    let capturedReject: (() => void) | undefined;
    const unsub = manager.subscribe((_, e) => {
      if (e.type === 'plan_ready') {
        capturedApprove = e.approve;
        capturedReject = e.reject;
      }
    });

    await manager.sendMessage(thread.id, 'Make a plan');
    mock.callbacks!.onPlanReady!('My plan', () => {}, () => {});

    unsub();
    expect(capturedApprove).toBeTypeOf('function');
    expect(capturedReject).toBeTypeOf('function');

    driveResponse('Done');
  });

  it('pendingPlan survives JSON serialization (reload simulation)', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    await manager.sendMessage(thread.id, 'Make a plan');
    mock.callbacks!.onPlanReady!('## Plan\n1. Do A\n2. Do B', () => {}, () => {});

    // Simulate what Obsidian's saveData/loadData does: JSON round-trip the thread.
    const serialized = JSON.stringify(thread);
    const restored = JSON.parse(serialized);
    expect(restored.pendingPlan).toBe('## Plan\n1. Do A\n2. Do B');

    driveResponse('Done');
  });
});

// ─── approve path ─────────────────────────────────────────────────────────────

describe('pendingPlan — approve clears it', () => {
  it('clears thread.pendingPlan when the wrapped approve is called', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    let capturedApprove: ((edited?: string) => void) | undefined;
    const unsub = manager.subscribe((_, e) => {
      if (e.type === 'plan_ready') capturedApprove = e.approve;
    });

    await manager.sendMessage(thread.id, 'Make a plan');
    mock.callbacks!.onPlanReady!('My plan', () => {}, () => {});
    unsub();

    expect(thread.pendingPlan).toBe('My plan');
    capturedApprove!();
    expect(thread.pendingPlan).toBeUndefined();

    driveResponse('Implementing');
  });

  it('emits pending_plan_changed with undefined when approve fires', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    let capturedApprove: ((edited?: string) => void) | undefined;
    const planEvents: Array<{ type: 'pending_plan_changed'; planText: string | undefined }> = [];
    const unsub = manager.subscribe((_, e) => {
      if (e.type === 'plan_ready') capturedApprove = e.approve;
      if (e.type === 'pending_plan_changed') planEvents.push(e as typeof planEvents[number]);
    });

    await manager.sendMessage(thread.id, 'Make a plan');
    mock.callbacks!.onPlanReady!('My plan', () => {}, () => {});
    capturedApprove!();
    unsub();

    const clearEvent = planEvents.find(e => e.planText === undefined);
    expect(clearEvent).toBeTruthy();

    driveResponse('Done');
  });

  it('passes edited plan text through to the original approve callback', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    let receivedEdited: string | undefined = 'sentinel';
    let capturedApprove: ((edited?: string) => void) | undefined;
    const unsub = manager.subscribe((_, e) => {
      if (e.type === 'plan_ready') capturedApprove = e.approve;
    });

    await manager.sendMessage(thread.id, 'Plan');
    mock.callbacks!.onPlanReady!('Original', (ed) => { receivedEdited = ed; }, () => {});
    unsub();

    capturedApprove!('Edited plan text');
    expect(receivedEdited).toBe('Edited plan text');

    driveResponse('Done');
  });

  it('passes undefined to original approve callback when no edits', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    let receivedEdited: string | undefined = 'sentinel';
    let capturedApprove: ((edited?: string) => void) | undefined;
    const unsub = manager.subscribe((_, e) => {
      if (e.type === 'plan_ready') capturedApprove = e.approve;
    });

    await manager.sendMessage(thread.id, 'Plan');
    mock.callbacks!.onPlanReady!('Original', (ed) => { receivedEdited = ed; }, () => {});
    unsub();

    capturedApprove!(undefined);
    expect(receivedEdited).toBeUndefined();

    driveResponse('Done');
  });
});

// ─── reject path ──────────────────────────────────────────────────────────────

describe('pendingPlan — reject clears it', () => {
  it('clears thread.pendingPlan when the wrapped reject is called', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    let capturedReject: (() => void) | undefined;
    const unsub = manager.subscribe((_, e) => {
      if (e.type === 'plan_ready') capturedReject = e.reject;
    });

    await manager.sendMessage(thread.id, 'Make a plan');
    mock.callbacks!.onPlanReady!('My plan', () => {}, () => {});
    unsub();

    expect(thread.pendingPlan).toBe('My plan');
    capturedReject!();
    expect(thread.pendingPlan).toBeUndefined();

    driveResponse('Stopping');
  });

  it('calls the original reject callback', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    let rejectCalled = false;
    let capturedReject: (() => void) | undefined;
    const unsub = manager.subscribe((_, e) => {
      if (e.type === 'plan_ready') capturedReject = e.reject;
    });

    await manager.sendMessage(thread.id, 'Plan');
    mock.callbacks!.onPlanReady!('My plan', () => {}, () => { rejectCalled = true; });
    unsub();

    capturedReject!();
    expect(rejectCalled).toBe(true);

    driveResponse('Done');
  });
});

// ─── onDone safety-net ────────────────────────────────────────────────────────

describe('pendingPlan — onDone safety-net', () => {
  it('clears a stale pendingPlan when the session completes normally', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    await manager.sendMessage(thread.id, 'Hi');
    // Manually set pendingPlan (simulates a stale value from a prior session)
    thread.pendingPlan = 'Stale plan';

    driveResponse('Done', 'sess-1');

    expect(thread.pendingPlan).toBeUndefined();
  });

  it('emits pending_plan_changed when safety-net clears the plan', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((id, e) => { if (id === thread.id) events.push(e); });

    await manager.sendMessage(thread.id, 'Hi');
    thread.pendingPlan = 'Stale plan';

    driveResponse('Done');

    const clearEvent = events.find(e =>
      e.type === 'pending_plan_changed' &&
      (e as { type: 'pending_plan_changed'; planText: string | undefined }).planText === undefined,
    );
    expect(clearEvent).toBeTruthy();
  });
});

// ─── per-thread permission mode ───────────────────────────────────────────────

describe('per-thread permissionMode', () => {
  it('uses the global setting when thread has no override', async () => {
    const manager = makeManager({ permissionMode: 'acceptEdits' });
    const thread = manager.createThread('T', os.tmpdir());

    await manager.sendMessage(thread.id, 'Hi');
    expect(mock.permissionMode).toBe('acceptEdits');

    driveResponse('Done');
  });

  it('uses thread.permissionMode when set, overriding the global setting', async () => {
    const manager = makeManager({ permissionMode: 'acceptEdits' });
    const thread = manager.createThread('T', os.tmpdir());
    thread.permissionMode = 'plan';

    await manager.sendMessage(thread.id, 'Hi');
    expect(mock.permissionMode).toBe('plan');

    driveResponse('Done');
  });

  it('falls back to global when thread.permissionMode is cleared (undefined)', async () => {
    const manager = makeManager({ permissionMode: 'dontAsk' });
    const thread = manager.createThread('T', os.tmpdir());

    // Set then clear
    manager.setThreadPermissionMode(thread.id, 'plan');
    manager.setThreadPermissionMode(thread.id, undefined);

    await manager.sendMessage(thread.id, 'Hi');
    expect(mock.permissionMode).toBe('dontAsk');

    driveResponse('Done');
  });

  it('setThreadPermissionMode stores the override on the thread', () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    manager.setThreadPermissionMode(thread.id, 'bypassPermissions');
    expect(thread.permissionMode).toBe('bypassPermissions');
  });

  it('setThreadPermissionMode with undefined deletes the override', () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    manager.setThreadPermissionMode(thread.id, 'plan');
    manager.setThreadPermissionMode(thread.id, undefined);
    expect(thread.permissionMode).toBeUndefined();
  });

  it('permissionMode override survives JSON serialization', () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    manager.setThreadPermissionMode(thread.id, 'plan');

    const restored = JSON.parse(JSON.stringify(thread));
    expect(restored.permissionMode).toBe('plan');
  });
});

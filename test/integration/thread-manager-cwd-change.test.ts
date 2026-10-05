import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'os';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { ThreadSessionOptions } from '../../src/ThreadSession';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { ImageAttachment } from '../../src/types';

// ─── ThreadSession mock (extends the canonical one in thread-manager-events.test.ts) ──
//
// This variant additionally captures options.cwd on start(), counts close()
// calls, exposes a live `get cwd()` returning the last-started cwd, and models
// `turnInFlight` via send()/onDone() — everything the deferred-cwd-rebuild
// path in ThreadManager keys off of.

const mock = vi.hoisted(() => ({
  callbacks: null as SessionCallbacks | null,
  sentPrompts: [] as string[],
  startedCwd: undefined as string | undefined,
  startedCwds: [] as (string | undefined)[],
  resumeSessionId: undefined as string | undefined,
  lastKnownSessionId: undefined as string | undefined,
  constructCount: 0,
  startCallCount: 0,
  sendCallCount: 0,
  closeCallCount: 0,
}));

vi.mock('../../src/ThreadSession', () => ({
  ThreadSession: class {
    private _turnInFlight = false;
    private _cwd: string | undefined = undefined;
    constructor(_claudePath: string) { mock.constructCount += 1; }
    get turnInFlight(): boolean { return this._turnInFlight; }
    get cwd(): string | undefined { return this._cwd; }
    async start(options: ThreadSessionOptions): Promise<void> {
      mock.startCallCount += 1;
      mock.startedCwd = options.cwd;
      mock.startedCwds.push(options.cwd);
      mock.resumeSessionId = options.resume;
      mock.lastKnownSessionId = options.resume;
      this._cwd = options.cwd;
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
    send(text: string, _images?: ImageAttachment[]): void {
      mock.sendCallCount += 1;
      mock.sentPrompts.push(text);
      this._turnInFlight = true;
    }
    async interrupt(): Promise<void> {
      mock.callbacks?.onInterrupted(mock.lastKnownSessionId ?? '');
    }
    async setModel(_model?: string): Promise<void> {}
    async setPermissionMode(_mode: unknown): Promise<void> {}
    async restart(): Promise<void> {}
    close(): void { mock.closeCallCount += 1; }
    async getContextUsage(): Promise<null> { return null; }
  },
}));

// Import AFTER vi.mock so the mock is in place
const { ThreadManager } = await import('../../src/ThreadManager');

function makeManager(overrides = {}) {
  return new ThreadManager({ ...DEFAULT_SETTINGS, ...overrides });
}

// The two distinct working directories used across these tests. Both must
// exist on disk, otherwise ensureCwdExists() reroutes them to an ancestor and
// the cwd we assert on never sticks. os.tmpdir() and os.homedir() are both
// real, distinct directories.
const OLD_CWD = os.tmpdir();
const NEW_CWD = os.homedir();

beforeEach(() => {
  mock.callbacks = null;
  mock.sentPrompts = [];
  mock.startedCwd = undefined;
  mock.startedCwds = [];
  mock.resumeSessionId = undefined;
  mock.lastKnownSessionId = undefined;
  mock.constructCount = 0;
  mock.startCallCount = 0;
  mock.sendCallCount = 0;
  mock.closeCallCount = 0;
});

describe('deferred cwd rebuild (EnterWorktree hang fix)', () => {
  it('does NOT tear down the transport when setThreadCwd lands mid-turn', () => {
    // The core anti-hang assertion. enter_worktree calls setThreadCwd()
    // synchronously mid-tool-call, before its own tool_result has returned.
    // If setThreadCwd() closed/restarted the live session here, it would
    // strand that tool_result and hang the turn forever.
    const manager = makeManager();
    const thread = manager.createThread('T', OLD_CWD);

    void manager.sendMessage(thread.id, 'do work');

    // Turn is now in flight (send() flipped turnInFlight true).
    const constructsBefore = mock.constructCount;
    const closesBefore = mock.closeCallCount;

    manager.setThreadCwd(thread.id, NEW_CWD);

    expect(mock.closeCallCount).toBe(closesBefore); // no close mid-turn
    expect(mock.constructCount).toBe(constructsBefore); // no new session built
  });

  it('does not resurrect the old-cwd sessionId when onDone fires after a mid-turn cwd change', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', OLD_CWD);

    await manager.sendMessage(thread.id, 'do work');
    // cwd changes while the turn is still in flight
    manager.setThreadCwd(thread.id, NEW_CWD);
    expect(manager.getThread(thread.id)!.sessionId).toBeUndefined();

    // The in-flight turn now settles with a sessionId from the OLD cwd's project.
    mock.callbacks!.onMessage('done', []);
    mock.callbacks!.onDone('old-cwd-session', 0.001, 1);

    // The guard must refuse to write it back — otherwise the next turn would
    // try to resume an old-dir session in the new dir.
    expect(manager.getThread(thread.id)!.sessionId).toBeUndefined();
  });

  it('rebuilds the session in the new cwd on the next turn, unresumed, with a history preamble', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', OLD_CWD);

    await manager.sendMessage(thread.id, 'first turn');
    mock.callbacks!.onMessage('reply one', []);
    mock.callbacks!.onDone('old-cwd-session', 0.001, 1);

    // cwd change after the first turn settles (turnInFlight already false).
    manager.setThreadCwd(thread.id, NEW_CWD);

    const constructsBefore = mock.constructCount;

    await manager.sendMessage(thread.id, 'second turn');

    expect(mock.closeCallCount).toBe(1); // old session closed
    expect(mock.constructCount).toBe(constructsBefore + 1); // new session built
    expect(mock.startedCwd).toBe(NEW_CWD); // opened against the new cwd
    expect(mock.resumeSessionId).toBeUndefined(); // fresh, not resumed
    // history preamble prepended so the model isn't amnesiac after the switch
    const lastPrompt = mock.sentPrompts[mock.sentPrompts.length - 1];
    expect(lastPrompt).toContain(`The current working directory is ${NEW_CWD}`);
    expect(lastPrompt).toContain('reply one');
    expect(lastPrompt).toContain('second turn');
  });

  it('does not rebuild when the cwd is unchanged across turns', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', OLD_CWD);

    await manager.sendMessage(thread.id, 'first');
    mock.callbacks!.onMessage('reply', []);
    mock.callbacks!.onDone('sess-1', 0.001, 1);

    const constructsBefore = mock.constructCount;

    await manager.sendMessage(thread.id, 'second');

    expect(mock.constructCount).toBe(constructsBefore); // same session reused
    expect(mock.closeCallCount).toBe(0); // never closed
  });
});

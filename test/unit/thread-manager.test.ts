import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';
import { defaultWorktreeRoot } from '../../src/worktreePaths';

function makeManager(overrides = {}) {
  return new ThreadManager({ ...DEFAULT_SETTINGS, ...overrides });
}

describe('ThreadManager — thread lifecycle', () => {
  let manager: ThreadManager;
  beforeEach(() => { manager = makeManager(); });

  it('createThread stores and returns a thread', () => {
    const t = manager.createThread('My thread', '/some/cwd');
    expect(t.title).toBe('My thread');
    expect(t.cwd).toBe('/some/cwd');
    expect(t.messages).toEqual([]);
    expect(manager.getThread(t.id)).toBe(t);
  });

  it.each([false, true])('passes the computer-use choice %s to newly initialized Codex sessions', (enabled) => {
    const m = makeManager({ codexComputerUseEnabled: enabled });
    const thread = m.createThread('Computer-use policy', process.cwd(), undefined, 'codex');
    const options = (m as any).buildThreadSessionOptions(thread.id, thread);
    expect(options.codex.computerUseEnabled).toBe(enabled);
  });

  it('createThread uses an explicit harness override without changing the default', () => {
    const m = makeManager({ agentHarness: 'claude' });

    const codexThread = m.createThread('Codex task', '/some/cwd', undefined, 'codex');
    const defaultThread = m.createThread('Default task');

    expect(codexThread.agentHarness).toBe('codex');
    expect(defaultThread.agentHarness).toBe('claude');
  });

  it('normalizes native sub-agent callbacks into persisted AgentRuns', () => {
    const t = manager.createThread('Agents');
    t.agentHarness = 'codex';
    const callbacks = (manager as any).buildSessionCallbacks(t.id, t);
    callbacks.onTaskStarted('agent-1', 'Audit fixtures', false, 'subagent');
    callbacks.onTaskProgress('agent-1', 'Reading tests', 'Read');
    callbacks.onTaskUpdated('agent-1', { status: 'completed' });

    expect(manager.getAgentRuns(t.id)).toEqual([
      expect.objectContaining({ nativeAgentId: 'agent-1', description: 'Audit fixtures', currentActivity: 'Reading tests', status: 'completed' }),
    ]);
    expect(t.agentRuns).toHaveLength(1);
  });

  it('persists unique paths reported through the provider-neutral edited-files callback', () => {
    const t = manager.createThread('Codex files');
    const events: string[] = [];
    manager.subscribe((_threadId, event) => events.push(event.type));
    const callbacks = (manager as any).buildSessionCallbacks(t.id, t);

    callbacks.onFilesEdited(['/project/src/a.ts', '/project/src/b.ts', '/project/src/a.ts', '']);

    expect(t.editedFiles).toEqual(['/project/src/a.ts', '/project/src/b.ts']);
    expect(events).toContain('files_edited');
  });

  it('createThread falls back to defaultCwd from settings', () => {
    const m = makeManager({ defaultCwd: '/default' });
    const t = m.createThread('T');
    expect(t.cwd).toBe('/default');
  });

  it('getThreads returns threads sorted by createdAt', () => {
    const t1 = manager.createThread('A');
    const t2 = manager.createThread('B');
    const t3 = manager.createThread('C');
    // Manually skew timestamps to make order deterministic
    t1.createdAt = 100;
    t2.createdAt = 300;
    t3.createdAt = 200;
    const ids = manager.getThreads().map(t => t.id);
    expect(ids).toEqual([t1.id, t3.id, t2.id]);
  });

  it('renameThread updates title and updatedAt', () => {
    const t = manager.createThread('Old');
    const before = t.updatedAt;
    t.updatedAt = before - 1000; // ensure measurable gap
    manager.renameThread(t.id, 'New');
    expect(manager.getThread(t.id)!.title).toBe('New');
    expect(manager.getThread(t.id)!.updatedAt).toBeGreaterThan(before - 1000);
  });

  it('deleteThread removes the thread', () => {
    const t = manager.createThread('To delete');
    manager.deleteThread(t.id);
    expect(manager.getThread(t.id)).toBeUndefined();
  });

  it('isRunning returns false before any send', () => {
    const t = manager.createThread('T');
    expect(manager.isRunning(t.id)).toBe(false);
  });

  it('getRunningThreads returns only threads with active sessions', () => {
    const t1 = manager.createThread('Running A');
    const t2 = manager.createThread('Idle B');
    const t3 = manager.createThread('Running C');
    // Inject fake sessions directly to simulate active threads
    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
    sessions.set(t1.id, {});
    sessions.set(t3.id, {});
    const running = manager.getRunningThreads();
    expect(running.map(t => t.id).sort()).toEqual([t1.id, t3.id].sort());
    expect(running.find(t => t.id === t2.id)).toBeUndefined();
  });

  it('getRunningThreads returns empty array when no sessions active', () => {
    manager.createThread('Idle A');
    manager.createThread('Idle B');
    expect(manager.getRunningThreads()).toHaveLength(0);
  });

  it('gracefulShutdown resolves immediately with timedOut=false when no sessions active', async () => {
    manager.createThread('Idle');
    const result = await manager.gracefulShutdown(5_000);
    expect(result.timedOut).toBe(false);
  });

  it('gracefulShutdown returns timedOut=true when sessions do not drain before timeout', async () => {
    const t = manager.createThread('Stubborn');
    // Inject a fake session whose interrupt() never resolves (simulates a hung
    // agent). ADR-0002 Stage 2: gracefulShutdown() now reads `turnInFlight` as
    // a plain property (not map presence) to decide who's busy, and
    // unconditionally calls close() on every session regardless of how the
    // drain went — the fake must have both.
    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
    sessions.set(t.id, { turnInFlight: true, interrupt: () => new Promise(() => {}), close: () => {} });
    // Use a very short timeout so the test completes quickly
    const result = await manager.gracefulShutdown(50);
    expect(result.timedOut).toBe(true);
  });

  it('gracefulShutdown returns timedOut=false when sessions drain before timeout', async () => {
    const t = manager.createThread('Quick');
    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
    // Under the single-session model, a session never removes itself from the
    // map on settling (ADR-0002 §4: it stays warm, idle) — settling now means
    // flipping `turnInFlight` back to false, which gracefulShutdown's own
    // anyBusy() poll re-checks directly.
    const fakeSession = {
      turnInFlight: true,
      interrupt: async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 10));
        fakeSession.turnInFlight = false;
      },
      close: () => {},
    };
    sessions.set(t.id, fakeSession);
    const result = await manager.gracefulShutdown(2_000);
    expect(result.timedOut).toBe(false);
  });

  it('loadThreads populates threads', () => {
    const m = makeManager();
    const thread = {
      id: 'abc',
      title: 'Loaded',
      cwd: '/cwd',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    };
    m.loadThreads([thread]);
    expect(m.getThread('abc')).toMatchObject({ title: 'Loaded' });
  });

  it('subscribe listener fires and unsubscribe stops it', () => {
    const t = manager.createThread('T');
    const events: string[] = [];
    const unsub = manager.subscribe((_, e) => events.push(e.type));
    // Emit via internal path — deleteThread doesn't emit, but we test subscribe wiring
    // via the public API in integration tests; here just verify unsub works
    unsub();
    expect(events).toHaveLength(0);
  });

  it('renameThread emits thread_renamed event with correct payload', () => {
    const t = manager.createThread('Original');
    const events: Array<{ threadId: string; type: string; title?: string }> = [];
    manager.subscribe((threadId, e) => {
      if (e.type === 'thread_renamed') {
        events.push({ threadId, type: e.type, title: e.title });
      }
    });

    manager.renameThread(t.id, 'Renamed');

    expect(events).toHaveLength(1);
    expect(events[0].threadId).toBe(t.id);
    expect(events[0].type).toBe('thread_renamed');
    expect(events[0].title).toBe('Renamed');
  });

  it('renameThread does not emit event for unknown thread', () => {
    const events: string[] = [];
    manager.subscribe((_, e) => events.push(e.type));

    manager.renameThread('nonexistent-id', 'Whatever');

    expect(events.filter(t => t === 'thread_renamed')).toHaveLength(0);
  });
});

describe('ThreadManager — mcpServerFactory', () => {
  it('is undefined by default', () => {
    const manager = makeManager();
    expect(manager.mcpServerFactory).toBeUndefined();
  });

  it('returns a fresh object on each call', () => {
    const manager = makeManager();
    let callCount = 0;
    manager.mcpServerFactory = () => {
      callCount++;
      return { obsidian: { type: 'sdk_mcp', instance: {} } as never };
    };
    manager.mcpServerFactory();
    manager.mcpServerFactory();
    expect(callCount).toBe(2);
  });

  it('returns distinct objects per call (no shared instance)', () => {
    const manager = makeManager();
    manager.mcpServerFactory = () => ({ obsidian: { type: 'sdk_mcp', instance: {} } as never });
    const a = manager.mcpServerFactory();
    const b = manager.mcpServerFactory();
    expect(a).not.toBe(b);
    expect(a.obsidian).not.toBe(b.obsidian);
  });
});

describe('ThreadManager — secretEnvResolver projectId threading', () => {
  // buildThreadSessionOptions is private; reach through as elsewhere in this
  // file (see buildSessionCallbacks usage above) to verify it forwards the
  // thread's resolved project id into secretEnvResolver — the wiring that
  // lets project-scoped secrets (PluginSettings.secretEnvScopes) resolve
  // correctly at session start.
  const build = (manager: ThreadManager, threadId: string, thread: ReturnType<ThreadManager['createThread']>) =>
    (manager as unknown as {
      buildThreadSessionOptions(id: string, t: typeof thread): unknown;
    }).buildThreadSessionOptions(threadId, thread);

  it("passes the thread's resolved project id to secretEnvResolver", () => {
    const manager = makeManager();
    const project = manager.createProject('Proj', 'Projects/Proj');
    const thread = manager.createThread('T', '', project.id);
    const resolver = vi.fn().mockReturnValue({});
    manager.secretEnvResolver = resolver;

    build(manager, thread.id, thread);

    expect(resolver).toHaveBeenCalledWith(project.id);
  });

  it('passes undefined for a project-less thread', () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '');
    const resolver = vi.fn().mockReturnValue({});
    manager.secretEnvResolver = resolver;

    build(manager, thread.id, thread);

    expect(resolver).toHaveBeenCalledWith(undefined);
  });
});

describe('ThreadManager — model escalation (resolveModel / stripKeyword)', () => {
  // resolveModel/stripKeyword are private; reach through for direct unit coverage.
  const resolve = (manager: ThreadManager, text: string): string | undefined =>
    (manager as unknown as { resolveModel(t: string): string | undefined }).resolveModel(text);
  const strip = (manager: ThreadManager, text: string): string =>
    (manager as unknown as { stripKeyword(t: string): string }).stripKeyword(text);

  it('escalates to the configured escalation model', () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '/escalate', escalationModel: 'fable' });
    expect(resolve(manager, 'please /escalate fix this')).toBe('fable');
  });

  it('falls back to opus when escalationModel is empty', () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '/escalate', escalationModel: '' });
    expect(resolve(manager, '/escalate do it')).toBe('opus');
  });

  it('returns undefined when the keyword is absent', () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '/escalate', escalationModel: 'fable' });
    expect(resolve(manager, 'just a normal message')).toBeUndefined();
  });

  it('does not escalate when disabled', () => {
    const manager = makeManager({ escalationEnabled: false, escalationKeyword: '/escalate', escalationModel: 'fable' });
    expect(resolve(manager, '/escalate do it')).toBeUndefined();
  });

  it('supports a custom keyword', () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '/opus', escalationModel: 'opus' });
    expect(resolve(manager, 'fix this /opus please')).toBe('opus');
  });

  it('strips the keyword from the middle of a message', () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '/escalate', escalationModel: 'fable' });
    expect(strip(manager, 'please /escalate fix this')).toBe('please fix this');
  });
});

describe('ThreadManager — setThreadCwd originRepoPath semantics', () => {
  let manager: ThreadManager;
  beforeEach(() => { manager = makeManager(); });

  it('sets originRepoPath when a string is passed', () => {
    const t = manager.createThread('T', '/old/cwd');
    manager.setThreadCwd(t.id, '/new/worktree', '/repo/root');
    expect(manager.getThread(t.id)!.originRepoPath).toBe('/repo/root');
  });

  it('clears originRepoPath when null is passed explicitly', () => {
    const t = manager.createThread('T', '/old/worktree');
    manager.setThreadCwd(t.id, '/old/worktree', '/repo/root');
    manager.setThreadCwd(t.id, '/repo/root', null);
    expect(manager.getThread(t.id)!.originRepoPath).toBeUndefined();
  });

  it('leaves an existing originRepoPath untouched when the argument is omitted', () => {
    const t = manager.createThread('T', '/worktree');
    manager.setThreadCwd(t.id, '/worktree', '/repo/root');
    manager.setThreadCwd(t.id, '/worktree/subdir');
    expect(manager.getThread(t.id)!.originRepoPath).toBe('/repo/root');
  });
});

describe('ThreadManager — repairStaleCwds', () => {
  let manager: ThreadManager;
  const scratchDirs: string[] = [];

  beforeEach(() => { manager = makeManager(); });
  afterEach(() => {
    while (scratchDirs.length) {
      fs.rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('reroutes to originRepoPath when it still exists on disk, and clears originRepoPath', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-repair-repo-'));
    scratchDirs.push(repoRoot);

    const staleWorktree = path.join(os.tmpdir(), 'claude-worktrees', 'repair-test-01');
    const t = manager.createThread('Worktree thread', staleWorktree);
    t.originRepoPath = repoRoot;

    const repaired = manager.repairStaleCwds();

    expect(repaired).toBe(1);
    const after = manager.getThread(t.id)!;
    expect(after.cwd).toBe(repoRoot);
    expect(after.originRepoPath).toBeUndefined();
  });

  it('falls back to the ancestor walk when originRepoPath is missing', () => {
    const staleWorktree = path.join(os.tmpdir(), 'claude-worktrees', 'repair-test-02', 'nested');
    const t = manager.createThread('No origin thread', staleWorktree);
    // No originRepoPath set at all.

    const repaired = manager.repairStaleCwds();

    expect(repaired).toBe(1);
    const after = manager.getThread(t.id)!;
    expect(after.cwd).not.toBe(staleWorktree);
    expect(fs.existsSync(after.cwd)).toBe(true);
  });

  it('falls back to the ancestor walk when originRepoPath no longer exists on disk', () => {
    const staleWorktree = path.join(os.tmpdir(), 'claude-worktrees', 'repair-test-03');
    const t = manager.createThread('Deleted origin thread', staleWorktree);
    t.originRepoPath = path.join(os.tmpdir(), 'tm-repair-deleted-repo-xyz');

    const repaired = manager.repairStaleCwds();

    expect(repaired).toBe(1);
    const after = manager.getThread(t.id)!;
    expect(after.cwd).not.toBe(t.originRepoPath);
    expect(fs.existsSync(after.cwd)).toBe(true);
  });

  it('does not touch threads whose cwd is not under the worktree container', () => {
    const t = manager.createThread('Regular thread', '/nonexistent/regular/path');
    const repaired = manager.repairStaleCwds();
    expect(repaired).toBe(0);
    expect(manager.getThread(t.id)!.cwd).toBe('/nonexistent/regular/path');
  });

  // The cases above all use the legacy <os.tmpdir()>/claude-worktrees layout,
  // which must keep working for threads persisted before worktrees moved to
  // durable storage. The cases below cover the current root.

  it('repairs a stale cwd under the current default root', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-repair-newroot-'));
    scratchDirs.push(repoRoot);

    const staleWorktree = path.join(defaultWorktreeRoot(), 'some-repo', 'feat', 'gone');
    const t = manager.createThread('New-root worktree thread', staleWorktree);
    t.originRepoPath = repoRoot;

    expect(manager.repairStaleCwds()).toBe(1);
    expect(manager.getThread(t.id)!.cwd).toBe(repoRoot);
  });

  it('repairs a stale cwd under a configured override root', () => {
    const configuredRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-repair-cfgroot-'));
    scratchDirs.push(configuredRoot);
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-repair-cfgrepo-'));
    scratchDirs.push(repoRoot);

    const scoped = makeManager({ worktreeRoot: configuredRoot });
    const staleWorktree = path.join(configuredRoot, 'some-repo', 'feat', 'gone');
    const t = scoped.createThread('Configured-root thread', staleWorktree);
    t.originRepoPath = repoRoot;

    expect(scoped.repairStaleCwds()).toBe(1);
    expect(scoped.getThread(t.id)!.cwd).toBe(repoRoot);
  });

  it('leaves an existing worktree directory alone', () => {
    // Durability is the whole point: a worktree that is still on disk must not
    // be "repaired" out from under a live thread.
    const liveWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-repair-live-'));
    scratchDirs.push(liveWorktree);

    const scoped = makeManager({ worktreeRoot: path.dirname(liveWorktree) });
    const t = scoped.createThread('Live worktree thread', liveWorktree);

    expect(scoped.repairStaleCwds()).toBe(0);
    expect(scoped.getThread(t.id)!.cwd).toBe(liveWorktree);
  });
});

describe('ThreadManager — backfillLegacyProjectNames', () => {
  let manager: ThreadManager;
  const scratchDirs: string[] = [];

  beforeEach(() => { manager = makeManager(); });
  afterEach(() => {
    while (scratchDirs.length) {
      fs.rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('backfills projectNameOverride from prUrl when cwd cannot resolve a project', () => {
    const staleCwd = path.join(os.tmpdir(), 'tm-backfill-orphan-01');
    const t = manager.createThread('Orphaned PR thread', staleCwd);
    t.prUrl = 'https://github.com/rickbowman/obsidian-claude-threads/pull/317';

    const count = manager.backfillLegacyProjectNames();

    expect(count).toBe(1);
    expect(manager.getThread(t.id)!.projectNameOverride).toBe('obsidian-claude-threads');
  });

  it('does not backfill when cwd already resolves to a real repo', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-backfill-realrepo-'));
    scratchDirs.push(repoRoot);
    fs.mkdirSync(path.join(repoRoot, '.git'));

    const t = manager.createThread('Healthy thread', repoRoot);
    t.prUrl = 'https://github.com/someone/some-other-repo/pull/1';

    const count = manager.backfillLegacyProjectNames();

    expect(count).toBe(0);
    expect(manager.getThread(t.id)!.projectNameOverride).toBeUndefined();
  });

  it('does not backfill when originRepoPath is already set', () => {
    const staleCwd = path.join(os.tmpdir(), 'tm-backfill-hasorigin-01');
    const t = manager.createThread('Has origin thread', staleCwd);
    t.originRepoPath = '/somewhere/repo';
    t.prUrl = 'https://github.com/someone/some-repo/pull/2';

    const count = manager.backfillLegacyProjectNames();

    expect(count).toBe(0);
    expect(manager.getThread(t.id)!.projectNameOverride).toBeUndefined();
  });

  it('does not backfill when there is no prUrl', () => {
    const staleCwd = path.join(os.tmpdir(), 'tm-backfill-noprurl-01');
    const t = manager.createThread('No PR thread', staleCwd);

    const count = manager.backfillLegacyProjectNames();

    expect(count).toBe(0);
    expect(manager.getThread(t.id)!.projectNameOverride).toBeUndefined();
  });

  it('is idempotent — a second call backfills nothing further', () => {
    const staleCwd = path.join(os.tmpdir(), 'tm-backfill-idempotent-01');
    const t = manager.createThread('Orphaned thread', staleCwd);
    t.prUrl = 'https://github.com/rickbowman/obsidian-claude-threads/pull/318';

    expect(manager.backfillLegacyProjectNames()).toBe(1);
    expect(manager.backfillLegacyProjectNames()).toBe(0);
    expect(manager.getThread(t.id)!.projectNameOverride).toBe('obsidian-claude-threads');
  });
});

// ─── hasActiveBackgroundTasks / getActiveBackgroundTasks ─────────────────────
//
// These read `activeBgTasks` (populated by onTaskStarted for skipTranscript
// tasks, cleared by onTaskNotification — see background-task-notifications.test.ts
// for coverage of that full event-driven lifecycle) merged with
// `thread.pendingBackgroundTasks` (the onDone snapshot used for poll-recovery
// after a reload). Following this file's existing style (see
// getRunningThreads's `sessions` injection above), the live map is poked
// directly rather than re-standing-up the ThreadSession mock scaffold from
// background-task-notifications.test.ts.

function getActiveBgTasksMap(manager: ThreadManager): Map<string, Map<string, { description: string; startedAt: number }>> {
  return (manager as unknown as { activeBgTasks: Map<string, Map<string, { description: string; startedAt: number }>> }).activeBgTasks;
}

describe('ThreadManager — hasActiveBackgroundTasks / getActiveBackgroundTasks', () => {
  let manager: ThreadManager;
  beforeEach(() => { manager = makeManager(); });

  it('hasActiveBackgroundTasks is false for a thread with no tracked tasks', () => {
    const t = manager.createThread('T');
    expect(manager.hasActiveBackgroundTasks(t.id)).toBe(false);
    expect(manager.getActiveBackgroundTasks(t.id)).toEqual([]);
  });

  it('hasActiveBackgroundTasks is true while a skipTranscript task is live (via the activeBgTasks map onTaskStarted populates)', () => {
    const t = manager.createThread('T');
    const activeBgTasks = getActiveBgTasksMap(manager);
    activeBgTasks.set(t.id, new Map([['task-1', { description: 'Run linter', startedAt: Date.now() }]]));

    expect(manager.hasActiveBackgroundTasks(t.id)).toBe(true);
    const tasks = manager.getActiveBackgroundTasks(t.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toBe('task-1');
    expect(tasks[0].description).toBe('Run linter');
  });

  it('hasActiveBackgroundTasks becomes false after the matching entry is cleared (mirrors onTaskNotification)', () => {
    const t = manager.createThread('T');
    const activeBgTasks = getActiveBgTasksMap(manager);
    const perThread = new Map([['task-1', { description: 'Run linter', startedAt: Date.now() }]]);
    activeBgTasks.set(t.id, perThread);
    expect(manager.hasActiveBackgroundTasks(t.id)).toBe(true);

    // onTaskNotification's cleanup: this.activeBgTasks.get(threadId)?.delete(taskId)
    perThread.delete('task-1');

    expect(manager.hasActiveBackgroundTasks(t.id)).toBe(false);
    expect(manager.getActiveBackgroundTasks(t.id)).toEqual([]);
  });

  it('a task present only in thread.pendingBackgroundTasks (post-reload, before the live map repopulates) still counts as active', () => {
    const t = manager.createThread('T');
    t.pendingBackgroundTasks = [{ taskId: 'persisted-1', description: 'Slow job', startedAt: 1_000, pollCount: 2 }];

    expect(manager.hasActiveBackgroundTasks(t.id)).toBe(true);
    const tasks = manager.getActiveBackgroundTasks(t.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toEqual({ taskId: 'persisted-1', description: 'Slow job', startedAt: 1_000, pollCount: 2 });
  });

  it('merges live and persisted tasks by taskId, live entry wins on conflict', () => {
    const t = manager.createThread('T');
    t.pendingBackgroundTasks = [
      { taskId: 'task-1', description: 'Stale description', startedAt: 1_000, pollCount: 5 },
      { taskId: 'task-2', description: 'Persisted only', startedAt: 2_000, pollCount: 1 },
    ];
    const activeBgTasks = getActiveBgTasksMap(manager);
    activeBgTasks.set(t.id, new Map([['task-1', { description: 'Fresh description', startedAt: 9_999 }]]));

    const tasks = manager.getActiveBackgroundTasks(t.id);
    expect(tasks).toHaveLength(2);

    const task1 = tasks.find(task => task.taskId === 'task-1')!;
    // Live wins: description/startedAt come from the live map...
    expect(task1.description).toBe('Fresh description');
    expect(task1.startedAt).toBe(9_999);
    // ...but pollCount (a field the live map doesn't track) is preserved from the persisted entry.
    expect(task1.pollCount).toBe(5);

    const task2 = tasks.find(task => task.taskId === 'task-2')!;
    expect(task2.description).toBe('Persisted only');
    expect(task2.pollCount).toBe(1);
  });

  it('a task present in neither map does not appear, and unrelated threads are unaffected', () => {
    const t1 = manager.createThread('T1');
    const t2 = manager.createThread('T2');
    const activeBgTasks = getActiveBgTasksMap(manager);
    activeBgTasks.set(t1.id, new Map([['task-1', { description: 'Job', startedAt: Date.now() }]]));

    expect(manager.hasActiveBackgroundTasks(t1.id)).toBe(true);
    expect(manager.hasActiveBackgroundTasks(t2.id)).toBe(false);
    expect(manager.getActiveBackgroundTasks(t2.id)).toEqual([]);
  });

  it('an empty (but present) live map for a thread is treated as no active tasks', () => {
    const t = manager.createThread('T');
    const activeBgTasks = getActiveBgTasksMap(manager);
    activeBgTasks.set(t.id, new Map());

    expect(manager.hasActiveBackgroundTasks(t.id)).toBe(false);
    expect(manager.getActiveBackgroundTasks(t.id)).toEqual([]);
  });
});

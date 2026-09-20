import './obsidian-mock'; // must be first — sets up HTMLElement.prototype
import { KanbanView } from '../../src/KanbanView';
import { AgentDashboard } from '../../src/AgentDashboard';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';
import {
  kanbanFixtureThreads,
  kanbanFixtureProjects,
  kanbanRunningThreadId,
  kanbanAwaitingThreadId,
  kanbanAwaitingPermission,
  kanbanRunningActivity,
  kanbanWaitingThreadId,
  kanbanWaitingFireAt,
  kanbanWaitingReason,
} from './fixtures';
import { getHeaderUpdateCalls, mockLeaf } from './obsidian-mock';
import { Platform } from 'obsidian';
import { SlashCommandRegistry } from '../../src/SlashCommandContributions';
import { createDesignSlashCommand } from '../../src/designSlashCommand';

const settings = { ...DEFAULT_SETTINGS, claudeBinaryPath: '/opt/homebrew/bin/claude' };
const dashboardMode = new URLSearchParams(window.location.search).has('dashboard');
if (new URLSearchParams(window.location.search).has('mobile')) Platform.isMobile = true;
const manager = new ThreadManager(settings);
manager.loadProjects(kanbanFixtureProjects);
const agentFixtureThread = kanbanFixtureThreads.find(thread => thread.id === kanbanRunningThreadId);
if (dashboardMode && agentFixtureThread) {
  agentFixtureThread.agentRuns = Array.from({ length: 7 }, (_, index) => ({
    id: `dashboard-agent-${index}`,
    threadId: agentFixtureThread.id,
    nativeAgentId: `native-${index}`,
    harness: 'claude' as const,
    role: 'engineer',
    description: `Sub-agent ${index + 1}`,
    status: index === 0 ? 'working' as const : 'completed' as const,
    startedAt: Date.now() - 10_000,
    updatedAt: Date.now(),
    capabilities: { viewTranscript: true, sendMessage: true, interrupt: true },
    events: [],
  }));
}
if (dashboardMode) {
  const planFixtureThread = kanbanFixtureThreads.find(thread => thread.title.includes('Going too?'));
  if (planFixtureThread) planFixtureThread.pendingPlan = 'Approve the rollout plan';
  const questionFixtureThread = kanbanFixtureThreads.find(thread => thread.title === 'Mobile layout polish');
  if (questionFixtureThread) questionFixtureThread.pendingQuestions = [{
    question: 'Which mobile density should we ship?', header: 'Density', multiSelect: false,
    options: [{ label: 'Compact', description: 'Show more threads' }],
  }];
}
manager.loadThreads(kanbanFixtureThreads);
// Restore intentionally marks persisted non-terminal runs unavailable. Turn this
// deterministic fixture back into a live run after hydration.
const liveFixtureRun = manager.getAgentRuns(kanbanRunningThreadId)[0];
if (dashboardMode && liveFixtureRun) liveFixtureRun.status = 'working';

// Running / Awaiting state lives in the manager's private session & permission
// maps, not on the Thread. Seed them directly so the Working and Awaiting
// columns render deterministically in the harness (no live Claude session).
const m = manager as unknown as {
  sessions: Map<string, unknown>;
  pendingPermissions: Map<string, { toolName: string; detail: string }>;
  threadActivity: Map<string, string>;
  lastActivityAt: Map<string, number>;
};
// `isRunning()` reads `session.turnInFlight` (the unified long-lived-session
// model — see ThreadManager.sessions), so a bare `{}` reads as NOT running and
// the Working/Awaiting columns would never populate. Seed the flag so both
// the running and the awaiting (running + pending permission) threads classify
// correctly.
m.sessions.set(kanbanRunningThreadId, { turnInFlight: true });
m.sessions.set(kanbanAwaitingThreadId, { turnInFlight: true });
m.pendingPermissions.set(kanbanAwaitingThreadId, kanbanAwaitingPermission);
m.threadActivity.set(kanbanRunningThreadId, kanbanRunningActivity);
// Seed a fresh activity heartbeat so these actively-running demo threads are
// NOT classified as stale (isRunStale) — they represent live, progressing work
// whose spinners should keep animating. Without this the private-map seeding
// leaves lastActivityAt unset (msSinceActivity === Infinity), which would
// immediately apply `.ct-stale` and pause the spinners.
m.lastActivityAt.set(kanbanRunningThreadId, Date.now());
m.lastActivityAt.set(kanbanAwaitingThreadId, Date.now());

// Scheduled-wakeup state (not running, has a pending wake-up) so the
// Kanban "Waiting" column renders deterministically in the harness — mirrors
// the pendingWakeups map in test/harness/index.ts.
const pendingWakeups = new Map<string, { timerId: number; fireAt: number; reason: string }[]>();
pendingWakeups.set(kanbanWaitingThreadId, [{ timerId: 0, fireAt: kanbanWaitingFireAt, reason: kanbanWaitingReason }]);
const dispatchCalls: unknown[][] = [];
const openedAgentTeams: string[] = [];
/** Threads archived via the right-click menu, in order — asserted by ui.spec.ts. */
const archivedThreadIds: string[] = [];
let saveSettingsCalls = 0;

const mockPlugin = {
  app: (mockLeaf as any).app,
  settings,
  manager,
  slashCommands: new SlashCommandRegistry(),
  persistence: null,
  saveSettings: async () => { saveSettingsCalls += 1; },
  getActiveThreadId: () => null,
  openThreadInChatView: async () => {},
  openAgentTeamInChatView: async (threadId: string) => { openedAgentTeams.push(threadId); },
  dispatchNewThread: async (...args: unknown[]) => {
    dispatchCalls.push(args);
    return 'new-thread';
  },
  getPendingWakeups: (threadId: string) =>
    [...(pendingWakeups.get(threadId) ?? [])].sort((a, b) => a.fireAt - b.fireAt),
  hasPendingWakeup: (threadId: string) => (pendingWakeups.get(threadId)?.length ?? 0) > 0,
  // Without these two the archive context menu throws the moment an item is
  // clicked. deleteThread emits `thread_deleted`, which both views already map
  // to scheduleRender(), so the card really does disappear in the harness.
  archiveThreadById: async (threadId: string) => {
    archivedThreadIds.push(threadId);
    manager.deleteThread(threadId);
  },
  cancelWakeups: (threadId: string) => { pendingWakeups.delete(threadId); },
};

mockPlugin.slashCommands.register({ pluginId: 'agent-threads.design' }, createDesignSlashCommand({
  getState: () => null, isDesktopFilesystem: () => true,
  prepare: async () => { throw new Error('Thread preparation is not wired in this harness.'); },
  send: async () => {}, dispatch: async () => 'design-thread',
}));

const container = document.getElementById('app')!;
const view = dashboardMode
  ? new AgentDashboard(mockLeaf as any, mockPlugin as any)
  : new KanbanView(mockLeaf as any, mockPlugin as any);
container.appendChild(view.containerEl);
void view.onOpen();

// Expose for Playwright
(window as any).__kanban = view;
(window as any).__dashboard = view;
(window as any).__manager = manager;
(window as any).__dispatchCalls = dispatchCalls;
(window as any).__openedAgentTeams = openedAgentTeams;
(window as any).__archivedThreadIds = archivedThreadIds;
(window as any).__getSaveSettingsCalls = () => saveSettingsCalls;
(window as any).__getAgentsGroupBy = () => settings.agentsGroupBy;
(window as any).__getHeaderUpdateCalls = getHeaderUpdateCalls;
(window as any).__replaceAgentRuns = (threadId: string, statuses: Array<'starting' | 'working' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'unavailable'>) => {
  const store = manager.agentRuns as unknown as { runs: Map<string, { threadId: string }> };
  for (const [id, run] of store.runs) {
    if (run.threadId === threadId) store.runs.delete(id);
  }
  const thread = manager.getThread(threadId);
  if (!thread) return;
  const runs = statuses.map((status, index) => ({
    id: `replacement-agent-${threadId}-${index}`,
    threadId,
    nativeAgentId: `replacement-native-${index}`,
    harness: 'claude' as const,
    description: `Replacement agent ${index + 1}`,
    status,
    startedAt: Date.now() - 10_000,
    updatedAt: Date.now(),
    capabilities: { viewTranscript: true, sendMessage: true, interrupt: true },
    events: [],
  }));
  manager.agentRuns.restore(threadId, runs);
  manager.getAgentRuns(threadId).forEach((run, index) => { run.status = statuses[index]; });
  (manager as unknown as { emit(threadId: string, event: { type: string; agentRuns: unknown[] }): void })
    .emit(threadId, { type: 'agent_runs_changed', agentRuns: manager.getAgentRuns(threadId) });
};
(window as any).__setGroupBy = (mode: 'status' | 'folder' | 'project') => {
  if (dashboardMode) return;
  settings.kanbanGroupBy = mode;
  (view as KanbanView).render();
  // Keep the toggle button glyph/state in sync with the forced mode.
  (view as KanbanView & { updateGroupByBtn?: () => void }).updateGroupByBtn?.();
};

// Lets screenshot tests seed settings.orchestratorThreadId so the bot badge
// (appendOrchestratorBadge) renders on the matching card's title.
(window as any).__setOrchestrator = (threadId: string | undefined) => {
  settings.orchestratorThreadId = threadId;
  view.render();
};

// ── fix/scheduled-wakeup-visibility regression helpers ──────────────────────
// Mirrors the equivalent helpers in test/harness/index.ts — lets screenshot
// tests drive the real ThreadManager → KanbanView.handleEvent → scheduleRender
// pipeline through the exact event the fix introduced, instead of calling
// view.render() directly (which would trivially pass even if the event wiring
// were missing).
(window as any).__setThreadRunning = (threadId: string, running: boolean) => {
  // Seed `turnInFlight` so isRunning() reports true (see the sessions seeding above).
  if (running) m.sessions.set(threadId, { turnInFlight: true });
  else m.sessions.delete(threadId);
};
(window as any).__addWakeup = (threadId: string, fireAt: number, reason: string) => {
  pendingWakeups.set(threadId, [{ timerId: 0, fireAt, reason }]);
};
(window as any).__fireRunStateSettled = (threadId: string) => {
  (manager as unknown as { emit(threadId: string, event: { type: string }): void }).emit(threadId, { type: 'run_state_settled' });
};

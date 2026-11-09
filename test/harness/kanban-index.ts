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
import { createDesignSlashCommand } from './design-plugin/designSlashCommand';
import { applyGalleryFixtures } from './gallery-fixtures';

const KT_ORCH = Date.UTC(2026, 0, 15, 9, 0, 0); // one hour before the spec's pinned clock (2026-01-15T10:00Z)
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
// ?inbox=1 seeds the orchestrator-inbox states (proposed reply, notes, a pending
// question and an orchestrator decision) so the Needs you lane renders. No
// managerNotesUpdatedAt: its "updated Nd ago" label is wall-clock dependent.
if (new URLSearchParams(window.location.search).has('inbox')) {
  const byTitle = (title: string) => kanbanFixtureThreads.find(thread => thread.title === title);
  const reply = byTitle('Social "Going too?" nudge');
  if (reply) {
    reply.proposedReply = {
      text: 'Looks good. Ship the nudge behind the existing flag, then confirm the open-rate dashboard before widening the rollout.',
      generatedAt: 1,
      sourceThreadId: kanbanRunningThreadId,
    };
    reply.managerNotes = 'Goal: ship the nudge\nStatus: awaiting Rick\nLast reviewed update: 1';
  }
  const decided = byTitle('Kanban folder swimlanes');
  if (decided) decided.pendingDecisions = [{
    id: 'dec-fixture-1', header: 'Lane order', question: 'Sort swimlanes by recency or alphabetically?',
    options: [{ label: 'Alphabetical', description: 'Stable positions' }, { label: 'Recency', description: 'Busy lanes first' }],
    multiSelect: false, allowOther: true, createdAt: 1, sourceThreadId: kanbanRunningThreadId,
  }];
  const asked = byTitle('Mobile layout polish');
  if (asked) asked.pendingQuestions = [{
    question: 'Which mobile density should we ship?', header: 'Density', multiSelect: false,
    options: [{ label: 'Compact', description: 'Show more threads' }, { label: 'Comfortable', description: 'Larger touch targets' }],
  }];
  const noted = byTitle('Fix auth middleware 401s');
  if (noted) noted.managerNotes = 'Goal: fix 401s\nStatus: done, PR merged';
}
// ?gallery=1 gives existing fixture threads tool-result images for Gallery mode.
if (new URLSearchParams(window.location.search).has('gallery')) applyGalleryFixtures(kanbanFixtureThreads);
// ?narrow=1 sizes #app to the viewport so a 390px screenshot is really 390px wide.
if (new URLSearchParams(window.location.search).has('narrow')) document.body.classList.add('ct-harness-narrow');
// ?orch=idle|attention|working|error|offline seeds the portfolio orchestrator for the OrchestratorDock
// states (`first-run`, or no param, leaves settings.orchestratorThreadId unset: the "No portfolio
// orchestrator yet" affordance). The orchestrator is a normal card on the board, as in production.
const orchFixture = new URLSearchParams(window.location.search).get('orch');
const orchestratorFixtureId = 'k-orchestrator';
if (orchFixture && orchFixture !== 'first-run') {
  kanbanFixtureThreads.push({
    id: orchestratorFixtureId,
    title: 'Portfolio Orchestrator',
    cwd: '/Users/mock/projects',
    messages: [{ id: 'k-orch-1', role: 'assistant', content: 'Two things are waiting on you.', timestamp: KT_ORCH }],
    createdAt: KT_ORCH - 3_600_000,
    updatedAt: KT_ORCH,
    reviewed: true,
    // `&errlong=1`: a 160-char error, to exercise the widest wrapped reason (the dock shows the first 60 characters).
    ...(orchFixture === 'error'
      ? { lastError: new URLSearchParams(window.location.search).has('errlong') ? 'Claude process exited unexpectedly (code 1): connection reset by peer while streaming the response body from the upstream API gateway; retries exhausted'.padEnd(160, '.') : 'Claude process exited unexpectedly (code 1)' }
      : {}),
    ...(orchFixture === 'offline'
      ? { remote: { daemonId: 'd-offline', ownership: 'client' as const, remoteCwd: '/srv/workspaces', lastSeq: 0, ownerClientId: 'harness' } }
      : {}),
  } as (typeof kanbanFixtureThreads)[number]);
  settings.orchestratorThreadId = orchestratorFixtureId;
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
// `idle` / `working` orchestrator fixtures need a calm board: nothing else running or awaiting, so the
// dot has nothing to report and deriveDockState reaches idle (or working, when the orchestrator runs).
if (orchFixture === 'idle' || orchFixture === 'working') {
  m.sessions.delete(kanbanRunningThreadId);
  m.sessions.delete(kanbanAwaitingThreadId);
  m.pendingPermissions.delete(kanbanAwaitingThreadId);
  if (orchFixture === 'working') m.sessions.set(orchestratorFixtureId, { turnInFlight: true });
}
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
/** Times a "New thread" button asked the plugin to open the conversation panel in new-conversation mode. */
const newConversationCalls: unknown[][] = [];
const openedAgentTeams: string[] = [];
/** Threads opened from a card (title link, card click), in order. */
const openedThreadIds: string[] = [];
/** Threads archived via the right-click menu, in order — asserted by ui.spec.ts. */
const archivedThreadIds: string[] = [];
let saveSettingsCalls = 0;
/** Archived-thread fixtures (vault notes) surfaced by "Show archived"; restored ids are recorded. */
const restoredThreadIds: string[] = [];
const archivedFixtures = kanbanFixtureThreads
  .filter(thread => thread.projectId)
  .slice(0, 4)
  .map((thread, index) => ({
    ...thread,
    id: `archived-${index}`,
    title: ['Retire legacy auth routes', 'Spike: offline itinerary cache', 'Rate limiter postmortem', 'Q2 dependency sweep'][index],
    summary: ['Removed /v0 endpoints and the shim.', 'Prototype works; needs IndexedDB quota handling.', undefined, undefined][index],
    status: 'archived' as const,
    updatedAt: Date.now() - (index + 3) * 86_400_000,
    messages: thread.messages.slice(0, 1),
    pendingPlan: undefined,
    pendingQuestions: undefined,
    agentRuns: [],
  }));

/** `open` argument of every ensureOrchestratorThread call: the dock must pass false (set up without opening). */
const ensureOrchestratorCalls: boolean[] = [];
/** Messages the dock sent through manager.sendMessage (the real one would spawn a Claude session). */
const sentMessages: Array<{ threadId: string; text: string }> = [];
manager.sendMessage = async (threadId: string, text: string) => { sentMessages.push({ threadId, text }); };
const reconnectCalls: string[] = [];
const mockDaemonRegistry = {
  nameOf: (id: string) => id,
  // `?orch=offline`: the orchestrator's daemon is unreachable (a state deriveDockState treats as offline).
  stateOf: (_id: string) => (orchFixture === 'offline' ? { status: 'unreachable' as const, attempt: 3 } : undefined),
  onState: (_l: unknown) => () => {},
  clientFor: (id: string) => ({ reconnectNow: () => { reconnectCalls.push(id); } }),
};

const mockPlugin = {
  daemonRegistry: mockDaemonRegistry,
  ensureOrchestratorThread: async (open = true) => {
    ensureOrchestratorCalls.push(open);
    if (!settings.orchestratorThreadId || !manager.getThread(settings.orchestratorThreadId)) {
      settings.orchestratorThreadId = manager.createThread('Portfolio Orchestrator', '/Users/mock/projects').id;
    }
    if (open) openedThreadIds.push(settings.orchestratorThreadId);
  },
  app: (mockLeaf as any).app,
  settings,
  manager,
  slashCommands: new SlashCommandRegistry(),
  persistence: null,
  saveSettings: async () => { saveSettingsCalls += 1; },
  getActiveThreadId: () => null,
  openThreadInChatView: async (threadId: string) => { openedThreadIds.push(threadId); },
  loadArchivedThreads: async () => archivedFixtures.filter(thread => !restoredThreadIds.includes(thread.id)),
  restoreArchivedThread: async (thread: { id: string }) => { restoredThreadIds.push(thread.id); },
  openAgentTeamInChatView: async (threadId: string) => { openedAgentTeams.push(threadId); },
  openNewConversation: async (...args: unknown[]) => {
    newConversationCalls.push(args);
    return true;
  },
  activateKanbanView: async () => {},
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
  getEffectiveCwd: () => settings.defaultCwd || '',
  // `?daemonoffer=1`: the managed local daemon can run here but is not set up (the picker offers to set it up).
  isLocalDaemonSetupOffered: () => new URLSearchParams(window.location.search).has('daemonoffer'),
  openLocalDaemonSettings: () => { (window as any).__localDaemonSettingsOpened = true; },
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
(window as any).__newConversationCalls = newConversationCalls;
(window as any).__ensureOrchestratorCalls = ensureOrchestratorCalls;
(window as any).__sentMessages = sentMessages;
(window as any).__reconnectCalls = reconnectCalls;
(window as any).__openedAgentTeams = openedAgentTeams;
(window as any).__openedThreadIds = openedThreadIds;
(window as any).__archivedThreadIds = archivedThreadIds;
(window as any).__getSaveSettingsCalls = () => saveSettingsCalls;
(window as any).__getRestoredThreadIds = () => restoredThreadIds;
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
(window as any).__setGroupBy = (mode: 'status' | 'folder' | 'project' | 'gallery') => {
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

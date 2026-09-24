import './obsidian-mock'; // must be first — sets up HTMLElement.prototype
import { ThreadsView } from '../../src/ThreadsView';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';
import { fixtureThreads } from './fixtures';
import { mockLeaf, mockWorkspace } from './obsidian-mock';
import { Platform } from 'obsidian';
import { enterDesignMode, assertDesignWriteAllowed } from './design-plugin/designArtifact';
import { ArtifactProviderRegistry } from '../../src/ArtifactContributions';
import { createArtifactStore } from '../../src/artifactStore';
import { createClaudeThreadsApiV1 } from '../../src/PublicApi';
import { SlashCommandRegistry } from '../../src/SlashCommandContributions';
import { createDesignSlashCommand } from './design-plugin/designSlashCommand';
import { THREAD_BUILTIN_COMMANDS, DISPATCH_BUILTIN_COMMANDS, escalationCommand } from '../../src/slashCommands';
import {
  createDesignArtifactContribution, DESIGN_ACTION_PREVIEW, DESIGN_ARTIFACT_KIND, DESIGN_ARTIFACT_SCHEMA_VERSION,
  DESIGN_PROVIDER_ID, DESIGN_PROVIDER_OWNER,
} from './design-plugin/designArtifactProvider';

if (new URLSearchParams(window.location.search).has('mobile')) Platform.isMobile = true;

// threadViewPlacement is pinned explicitly rather than inherited from
// DEFAULT_SETTINGS: this harness backs the large majority of screenshot/unit
// fixtures that exercise ThreadsView rendering independent of placement, and
// letting it silently follow whatever the production default is would churn
// every one of those baselines whenever the default changes. Tests that need
// conversation-first mode opt in explicitly via window.__setConversationFirst.
const settings = { ...DEFAULT_SETTINGS, claudeBinaryPath: '/opt/homebrew/bin/claude', threadViewPlacement: 'classic' as const };
const manager = new ThreadManager(settings);
manager.loadThreads(fixtureThreads);

// Minimal scheduler mock — ThreadsView reads this for the scheduled-activity
// pill and popover. No fixture thread has
// a loop by default, so listItems() starts empty; tests that need to
// exercise the loop UI can call __setLoop below.
const loopItems = new Map<string, any>();
let nextDeleteError: Error | null = null;
let nextSaveGate: Promise<void> | null = null;
let releaseNextSave: (() => void) | null = null;
let nextSaveError: Error | null = null;
const goalKickoffs: Array<{ threadId: string; revision: number; message: string }> = [];
const mockScheduler = {
  listItems: () => [...loopItems.values()],
  createItem: (params: any) => {
    const item = { ...params, id: `loop-${loopItems.size + 1}` };
    loopItems.set(item.id, item);
    return item;
  },
  deleteItem: async (id: string) => {
    loopItems.delete(id);
    if (nextDeleteError) {
      const error = nextDeleteError;
      nextDeleteError = null;
      throw error;
    }
  },
  updateItem: (id: string, patch: any) => {
    const existing = loopItems.get(id);
    if (!existing) throw new Error(`Scheduled item not found: ${id}`);
    const updated = { ...existing, ...patch };
    loopItems.set(id, updated);
    return updated;
  },
};
(window as any).__failNextScheduleDelete = (message: string) => { nextDeleteError = new Error(message); };
(window as any).__removeWakeupsSilently = (threadId: string) => {
  for (const item of [...loopItems.values()]) {
    if (item.origin === 'wakeup' && item.targetThreadId === threadId) loopItems.delete(item.id);
  }
};

// The harness runs from file://, which Chromium does not treat as a secure
// context, so crypto.randomUUID is withheld. The public API mints its
// generation id with it at construction — shim it before that happens.
if (typeof crypto !== 'undefined' && typeof (crypto as { randomUUID?: unknown }).randomUUID !== 'function') {
  (crypto as unknown as { randomUUID: () => string }).randomUUID = () =>
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
      const random = Math.floor(Math.random() * 16);
      return (char === 'x' ? random : (random & 0x3) | 0x8).toString(16);
    });
}

const artifactProviders = new ArtifactProviderRegistry();
const slashCommands = new SlashCommandRegistry({ reservedNames: () => [
  ...THREAD_BUILTIN_COMMANDS.map(c => c.name), ...DISPATCH_BUILTIN_COMMANDS.map(c => c.name),
  'fork', escalationCommand(settings)?.name ?? '',
] });
artifactProviders.register(DESIGN_PROVIDER_OWNER, createDesignArtifactContribution());

const mockPlugin = {
  app: (mockLeaf as any).app,
  settings,
  manager,
  artifactProviders,
  slashCommands,
  persistence: null,
  scheduler: mockScheduler,
  summarizer: { summarize: async () => ({ title: '', summary: '' }) },
  inProcessSummarizer: {
    summarize: async () => ({ title: '', summary: '' }),
    summarizeMessage: async () => 'Fixed JWT_SECRET missing in staging by updating auth.ts to fail fast on startup.',
    generateForkPrompt: async () => 'I need to fix the authentication bug in src/auth/jwt.ts. The JWT validation is rejecting valid tokens when the expiry is within 30 seconds. We decided to add a 60-second clock skew buffer to the validation logic.',
  },
  saveSettings: async () => {
    (window as any).__saveSettingsCalls = ((window as any).__saveSettingsCalls ?? 0) + 1;
    if (nextSaveGate) {
      const gate = nextSaveGate;
      nextSaveGate = null;
      await gate;
    }
    if (nextSaveError) {
      const error = nextSaveError;
      nextSaveError = null;
      throw error;
    }
  },
  getEffectiveCwd: () => '/Users/mock/projects/my-app',
  isConversationFirst: () => settings.threadViewPlacement === 'conversation-first',
  contextPanel: {
    openLinkText: async (href: string, sourcePath: string) => { (window as any).__contextLinkCalls.push([href, sourcePath]); },
  },
  // Empty on purpose: this harness has no vault skills fixture, and the
  // Skills Manager harness (skills-index.ts) is where the populated case is
  // screenshotted. Must still be present — ThreadsView calls it while
  // building the /-autocomplete skill dirs.
  getPluginSkillsRoot: () => '',
  getPendingWakeups: (threadId: string) => [...loopItems.values()]
    .filter((item: any) => item.origin === 'wakeup' && item.enabled && item.targetThreadId === threadId)
    .map((item: any) => ({ fireAt: item.nextRun ?? item.schedule.fireAt, reason: item.name.replace(/^Wakeup: /, '') }))
    .filter((item: any) => item.fireAt != null)
    .sort((a: any, b: any) => a.fireAt - b.fireAt),
  hasPendingWakeup: (threadId: string) => [...loopItems.values()]
    .some((item: any) => item.origin === 'wakeup' && item.enabled && item.targetThreadId === threadId),
  cancelWakeups: (threadId: string) => {
    for (const item of [...loopItems.values()]) {
      if (item.origin === 'wakeup' && item.enabled && item.targetThreadId === threadId) loopItems.delete(item.id);
    }
    manager.notifyWakeupChanged(threadId);
  },
};
// A registered artifact leaf models the host preview boundary; the entry,
// persistence ordering, focus, and toolbar below use the production workflow.
const designPreviewLeaf = {
  setViewState: async () => {},
  getViewState: () => ({ type: 'geode-artifact' }),
};
// A real public API v1 instance, so the design entry below takes exactly the
// path a third-party peer would: attach through `artifacts`, then invoke a
// named provider action. Only the artifact dependencies are real; the rest is
// stubbed, because nothing in this harness exercises them.
const harnessApi = createClaudeThreadsApiV1({
  getThreads: () => [],
  getThread: (id: string) => manager.getThread(id),
  isRunning: () => false,
  createThread: () => { throw new Error('Thread creation is not wired in this harness.'); },
  sendMessage: async () => {},
  openThread: async () => {},
  subscribe: () => () => {},
  listOrchestrators: () => [],
  resolveOrchestrator: async () => null,
  triggerHostEvent: () => {},
  artifactProviders,
  slashCommands,
  artifactStore: createArtifactStore({
    vaultRoot: () => '/vault',
    getThread: (id: string) => manager.getThread(id),
    saveSettings: () => mockPlugin.saveSettings(),
    invokeAction: (threadId: string, artifactId: string, actionId: string) =>
      ((window as any).__view as ThreadsView | undefined)?.invokeArtifactAction(threadId, artifactId, actionId),
    onChanged: () => ((window as any).__view as ThreadsView | undefined)?.refreshArtifactCard(),
  }),
} as never).api;
(window as any).__api = harnessApi;
harnessApi.extensions.registerSlashCommand(DESIGN_PROVIDER_OWNER, createDesignSlashCommand({
  getState: id => {
    const thread = manager.getThread(id);
    return thread ? { hasArtifacts: !!thread.artifacts?.length, existingTitle: thread.artifacts?.find(a => a.kind === 'design-static')?.title } : null;
  },
  isDesktopFilesystem: () => true,
  prepare: (id, brief) => (window as any).__enterDesignMode(id, brief),
  send: (id, prompt) => manager.sendMessage(id, prompt),
  dispatch: async () => { throw new Error('Design dispatch is covered in the dispatch integration harness.'); },
}));

(window as any).__enterDesignMode = (threadId: string, brief: string) => enterDesignMode(threadId, '/vault', brief, {
  getThread: id => manager.getThread(id),
  assertWritable: thread => assertDesignWriteAllowed(thread, settings.permissionMode),
  saveSettings: () => mockPlugin.saveSettings(),
  openThread: async id => { await (window as any).__view.focusThread(id); },
  openPreview: async artifact => {
    Object.assign(mockWorkspace, { getLeavesOfType: () => [], getLeaf: () => designPreviewLeaf, revealLeaf: () => {} });
    const attached = await harnessApi.artifacts.attach(DESIGN_PROVIDER_OWNER, threadId, {
      providerId: DESIGN_PROVIDER_ID,
      kind: DESIGN_ARTIFACT_KIND,
      schemaVersion: DESIGN_ARTIFACT_SCHEMA_VERSION,
      id: artifact.id,
      title: artifact.title,
      storageRoot: artifact.root,
      data: artifact,
    });
    if (!attached.success) throw new Error(attached.message);
    const result = await harnessApi.artifacts.invokeAction(threadId, artifact.id, DESIGN_ACTION_PREVIEW);
    if (result.status === 'ok') return { status: 'opened' as const };
    if (result.status === 'warning') return { status: 'unavailable' as const, warning: result.message };
    throw new Error(result.message);
  },
}, { mkdir: async () => {}, writeFile: async () => {} });
(window as any).__contextLinkCalls = [];
(window as any).__setConversationFirst = (enabled: boolean) => {
  settings.threadViewPlacement = enabled ? 'conversation-first' : 'classic';
};

// Goal-action probes let Playwright exercise delayed persistence and thread
// switching without launching a real harness process from the static UI
// fixture. Session rollover itself is covered by the ThreadManager unit suite.
manager.requestGoalKickoff = async (threadId: string, revision: number, message: string) => {
  manager.commitThreadGoal(threadId, revision);
  goalKickoffs.push({ threadId, revision, message });
  return true;
};
(window as any).__goalKickoffs = goalKickoffs;
(window as any).__blockNextSave = () => {
  nextSaveGate = new Promise<void>((resolve) => { releaseNextSave = resolve; });
};
(window as any).__releaseNextSave = () => {
  releaseNextSave?.();
  releaseNextSave = null;
};
(window as any).__failNextSave = (message: string) => { nextSaveError = new Error(message); };

// Expose for Playwright — lets screenshot tests seed a loop for a thread.
(window as any).__setLoop = (threadId: string, prompt: string, intervalSeconds: number) => {
  mockScheduler.createItem({
    name: `Loop: ${prompt.slice(0, 40)}`,
    prompt,
    schedule: { type: 'interval', intervalSeconds },
    enabled: true,
    targetThreadId: threadId,
    nextRun: Date.now() + intervalSeconds * 1000,
  });
};

// Lets screenshot tests seed the "Scheduled: <name>" footer pill, mirroring
// what Scheduler.createThread records on a thread created by a cron fire.
(window as any).__setScheduledOrigin = (threadId: string, scheduledItemId: string, scheduledItemName: string) => {
  const thread = manager.getThread(threadId);
  if (!thread) throw new Error(`Thread not found: ${threadId}`);
  thread.scheduledItemId = scheduledItemId;
  thread.scheduledItemName = scheduledItemName;
};

// Seed durable wakeup items so screenshot tests exercise the same scheduler
// source of truth used by the production pill, dashboard, and Kanban surfaces.
(window as any).__setWakeup = (threadId: string, fireAt: number, reason: string) => {
  const id = `wakeup-${loopItems.size + 1}`;
  loopItems.set(id, {
    id,
    name: `Wakeup: ${reason}`,
    prompt: reason,
    origin: 'wakeup',
    schedule: { type: 'once', fireAt },
    enabled: true,
    targetThreadId: threadId,
    nextRun: fireAt,
  });
  manager.notifyWakeupChanged(threadId);
};

// ── fix/scheduled-wakeup-visibility regression helpers ──────────────────────
// `sessions`/`lingeringSessions` are TS `private` on ThreadManager (compile-time
// only — erased at runtime), so poking them here is the same technique the
// Kanban harness already uses to seed Working/Awaiting state. This lets
// screenshot tests drive the run-state transition while scheduled activity is
// present, confirming that the compact pill remains accurate throughout.
const mgrInternals = manager as unknown as {
  sessions: Map<string, unknown>;
  emit(threadId: string, event: { type: string }): void;
};
(window as any).__setThreadRunning = (threadId: string, running: boolean) => {
  // `isRunning()` reads `session.turnInFlight` (the unified long-lived-session
  // model — see ThreadManager.sessions), so a bare `{}` reads as NOT running.
  // Seed the flag so Working/Awaiting classification behaves as it does against
  // a real busy session.
  if (running) mgrInternals.sessions.set(threadId, { turnInFlight: true });
  else mgrInternals.sessions.delete(threadId);
};
(window as any).__fireRunStateSettled = (threadId: string) => {
  mgrInternals.emit(threadId, { type: 'run_state_settled' });
};

// Generic event-emit passthrough for screenshot/E2E tests that need to drive
// arbitrary ThreadEvents directly (e.g. synthesizing a burst of live
// tool_use/tool_result_status events for the live tool-call-grouping tests)
// without standing up a real ClaudeSession. Mirrors the pattern of the
// bespoke helpers above but isn't limited to one event type.
(window as any).__emitEvent = (threadId: string, event: { type: string; [key: string]: unknown }) => {
  mgrInternals.emit(threadId, event);
};
(window as any).__addLiveUserMessage = (threadId: string, id: string, content: string) => {
  const thread = manager.getThread(threadId);
  if (!thread) throw new Error(`Thread not found: ${threadId}`);
  const message = { id, role: 'user' as const, content, timestamp: Date.now() };
  thread.messages.push(message);
  mgrInternals.emit(threadId, { type: 'user_message_added', message } as any);
};

const view = new ThreadsView(mockLeaf as any, mockPlugin as any);
const container = document.getElementById('app')!;
container.appendChild(view.containerEl);
const hostHeader = view.containerEl.querySelector<HTMLElement>(':scope > .view-header')!;
hostHeader.style.display = new URLSearchParams(window.location.search).has('document') ? 'flex' : 'none';
view.onOpen();

// Expose for Playwright
(window as any).__view = view;
(window as any).__manager = manager;
(window as any).__setDocumentPane = (enabled: boolean) => {
  hostHeader.style.display = enabled ? 'flex' : 'none';
  mockWorkspace.trigger('layout-change');
};
(window as any).__closeView = async () => {
  await view.onClose();
  (view as any).unload();
};

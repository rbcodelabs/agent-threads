import './obsidian-mock'; // must be first — sets up HTMLElement.prototype
import { ThreadsView } from '../../src/ThreadsView';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';
import { fixtureThreads, inlineContentMessages, kanbanFixtureProjects } from './fixtures';
import { createAgentThreadCallback } from '../../src/agentThreadCreation';
import { browserFixtureMessages, PRICING_IMAGE, type BrowserFixtureKind } from './browser-fixtures';
import { LoginHandoffController } from '../../src/agentBrowser/LoginHandoffController';
import type { AgentBrowserPool } from '../../src/agentBrowser/AgentBrowserPool';
import type { AgentBrowserGuest } from '../../src/agentBrowser/AgentBrowserGuest';
import loginSvg from '../../docs/mockups/browser-session-card/assets/shot-login.svg';
import { mockLeaf, mockWorkspace } from './obsidian-mock';
import { Platform } from 'obsidian';
import { enterDesignMode, assertDesignWriteAllowed } from './design-plugin/designArtifact';
import { ArtifactProviderRegistry } from '../../src/ArtifactContributions';
import { MessageContentProviderRegistry } from '../../src/MessageContent';
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

// The sticky last-user-message bubble floats over the top of any scrolled transcript, so it would
// repaint every unrelated screenshot baseline. Hide it by default; its own spec opts in with ?sticky.
if (!new URLSearchParams(window.location.search).has('sticky')) {
  const hideSticky = document.createElement('style');
  hideSticky.textContent = '.ct-sticky-user-layer { display: none !important; }';
  document.head.appendChild(hideSticky);
}

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
const messageContentProviders = new MessageContentProviderRegistry();
const slashCommands = new SlashCommandRegistry({ reservedNames: () => [
  ...THREAD_BUILTIN_COMMANDS.map(c => c.name), ...DISPATCH_BUILTIN_COMMANDS.map(c => c.name),
  'fork', escalationCommand(settings)?.name ?? '',
] });
artifactProviders.register(DESIGN_PROVIDER_OWNER, createDesignArtifactContribution());

// ── Login handoff (ADR-0014): the REAL controller over a fake pool/bridge ────
// The chat's browser session card subscribes to plugin.loginHandoff. Geode's
// popup bridge and the login guest are faked exactly like the Agent Browser
// preview harness does; everything between them (state machine, capture loop,
// input forwarding, card rendering) is production code.
const HANDOFF_THREAD = 'thread-new';
const handoffCalls = { acquire: [] as Array<{ threadId: string; url: string }>, release: [] as Array<{ threadId: string; reason: string }>, input: [] as unknown[], focus: 0 };
let handoffOpenCb: ((r: { url: string; guestId: number; disposition: string }) => void) | null = null;
const handoffIpc = new Map<string, Array<(...a: unknown[]) => void>>();
async function loginFrameBytes(): Promise<Uint8Array> {
  const img = new Image();
  img.src = 'data:image/svg+xml;base64,' + btoa(loginSvg);
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 400;
  canvas.getContext('2d')!.drawImage(img, 0, 0, 640, 400);
  return Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), (ch) => ch.charCodeAt(0));
}
const fakeLoginGuest = {
  capture: loginFrameBytes,
  focus: () => { handoffCalls.focus += 1; },
  sendInputEvent: (event: unknown) => { handoffCalls.input.push(event); },
  facts: () => ({ viewport: { width: 1280, height: 800 } }),
} as unknown as AgentBrowserGuest;
const fakeHandoffPool = {
  findPrimaryByWebContentsId: (id: number) => (id === 42 ? HANDOFF_THREAD : null),
  findLoginByWebContentsId: (id: number) => (id === 43 ? HANDOFF_THREAD : null),
  acquireLoginGuest: async (threadId: string, url: string) => { handoffCalls.acquire.push({ threadId, url }); return fakeLoginGuest; },
  releaseLoginGuest: (threadId: string, reason: string) => { handoffCalls.release.push({ threadId, reason }); },
} as unknown as AgentBrowserPool;
const loginHandoff = new LoginHandoffController({
  getPool: () => fakeHandoffPool,
  bridgeDeps: {
    geode: { onAgentBrowserWindowOpen: (cb) => { handoffOpenCb = cb as typeof handoffOpenCb; return () => { handoffOpenCb = null; }; } },
    ipcRenderer: {
      on: (channel, listener) => { handoffIpc.set(channel, [...(handoffIpc.get(channel) ?? []), listener]); },
      removeListener: (channel, listener) => { handoffIpc.set(channel, (handoffIpc.get(channel) ?? []).filter((l) => l !== listener)); },
    },
  },
});
loginHandoff.start();
(window as any).__loginHandoff = loginHandoff;
(window as any).__handoffCalls = handoffCalls;
/** Geode reports a denied window.open() from the agent's page. */
(window as any).__fireLoginOpen = (url: string) => handoffOpenCb?.({ url, guestId: 42, disposition: 'foreground-tab' });
/** The login popup closes itself (window.close()). */
(window as any).__fireLoginClose = () => (handoffIpc.get('agent-browser-window-close') ?? []).forEach((l) => l({}, 43));

const mockPlugin = {
  app: (mockLeaf as any).app,
  settings,
  discoveredModelsByHarness: { claude: [], codex: [], opencode: [] },
  manager,
  artifactProviders,
  slashCommands,
  messageContentProviders,
  persistence: null,
  scheduler: mockScheduler,
  loginHandoff,
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
  messageContentProviders,
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
/**
 * Load one of the browser session card fixtures (browser-fixtures.ts) onto the
 * otherwise-empty 'thread-new' thread, mirroring __showInlineContent, so the
 * shared thread list stays untouched. `running` seeds a live turn.
 */
(window as any).__showBrowserFixture = async (kind: BrowserFixtureKind, running = false) => {
  const thread = manager.getThread(HANDOFF_THREAD)!;
  thread.title = 'Pricing research';
  thread.messages = JSON.parse(JSON.stringify(browserFixtureMessages[kind]));
  (window as any).__setThreadRunning(HANDOFF_THREAD, running);
  await view.focusThread(HANDOFF_THREAD);
  if (running) mgrInternals.emit(HANDOFF_THREAD, { type: 'streaming_start' });
};
/** Tool-result images that arrived but are not yet on a persisted message. */
(manager as any).pendingToolResultImages = (manager as any).pendingToolResultImages ?? new Map();
(window as any).__setPendingToolImages = (threadId: string, images: Array<{ mediaType: string; data: string }>) => {
  (manager as any).pendingToolResultImages.set(threadId, [...images]);
};
(window as any).__pricingImage = PRICING_IMAGE;
/**
 * Replay what a live browser call does in production: the tool_use event, the
 * committed tool-only message carrying the SAME record, and (later) an in-place
 * status mutation + tool_result_status. Drives the real row/refresh path.
 */
(window as any).__browserStep = (spec: { id: string; name: string; summary?: string }) => {
  const thread = manager.getThread(HANDOFF_THREAD)!;
  const record = { name: 'mcp__claude_threads__' + spec.name, summary: spec.summary ?? '', timestamp: Date.now(), toolUseId: spec.id, status: 'pending' };
  const message = { id: 'live-' + spec.id, role: 'assistant' as const, content: '', timestamp: Date.now(), toolCalls: [record] };
  thread.messages.push(message as any);
  mgrInternals.emit(HANDOFF_THREAD, { type: 'tool_use', record } as any);
  mgrInternals.emit(HANDOFF_THREAD, { type: 'message', message } as any);
};
(window as any).__browserResult = (id: string, status: 'success' | 'error', extra: { pageUrl?: string; error?: string; durationMs?: number } = {}) => {
  const thread = manager.getThread(HANDOFF_THREAD)!;
  for (const m of thread.messages) {
    const record = m.toolCalls?.find((t: any) => t.toolUseId === id) as any;
    if (!record) continue;
    record.status = status;
    record.durationMs = extra.durationMs ?? 400;
    if (extra.pageUrl || extra.error) record.browser = { pageUrl: extra.pageUrl, error: extra.error };
  }
  mgrInternals.emit(HANDOFF_THREAD, { type: 'tool_result_status', toolUseId: id, status } as any);
};
(window as any).__browserImage = (image: { mediaType: string; data: string }) => {
  (window as any).__setPendingToolImages(HANDOFF_THREAD, [...((manager as any).pendingToolResultImages.get(HANDOFF_THREAD) ?? []), image]);
  mgrInternals.emit(HANDOFF_THREAD, { type: 'tool_result_images', images: [image] } as any);
};
(window as any).__endTurn = () => {
  (window as any).__setThreadRunning(HANDOFF_THREAD, false);
  mgrInternals.emit(HANDOFF_THREAD, { type: 'done' } as any);
};
(window as any).__addLiveUserMessage = (threadId: string, id: string, content: string) => {
  const thread = manager.getThread(threadId);
  if (!thread) throw new Error(`Thread not found: ${threadId}`);
  const message = { id, role: 'user' as const, content, timestamp: Date.now() };
  thread.messages.push(message);
  mgrInternals.emit(threadId, { type: 'user_message_added', message } as any);
};

/**
 * Drive the REAL createAgentThreadCallback (src/agentThreadCreation.ts) against
 * the REAL ThreadManager: approval goes through manager.requestToolApproval ->
 * the view's permissionHandler -> the real permission card. Only saveSettings
 * and sendMessage are stubbed (no agent turn runs in the harness). The thrown
 * error is surfaced as an errored tool call on the source thread, standing in
 * for the agent turn that would normally render the tool result.
 */
(window as any).__spawnFromThread = (sourceThreadId: string, params: { prompt: string; title?: string; cwd?: string; projectId?: string | null }) => {
  manager.loadProjects(kanbanFixtureProjects);
  const outcome: { threadId?: string; error?: string; done: boolean } = { done: false };
  (window as any).__spawnOutcome = outcome;
  const callback = createAgentThreadCallback({
    sourceThreadId,
    getThread: id => manager.getThread(id),
    createThread: (title, cwd, projectId) => manager.createThread(title, cwd, projectId),
    saveSettings: async () => {},
    sendMessage: async () => {},
    requestApproval: (toolName, detail) => manager.requestToolApproval(sourceThreadId, toolName, detail),
    getProjectName: id => manager.getProject(id)?.name,
  });
  callback(params).then(
    result => { outcome.threadId = result.threadId; },
    (error: Error) => {
      outcome.error = error.message;
      const thread = manager.getThread(sourceThreadId)!;
      const record = { name: 'mcp__claude_threads__threads_create', summary: error.message, timestamp: Date.now(), toolUseId: 'spawn-denied', status: 'error' };
      const message = { id: 'spawn-error', role: 'assistant' as const, content: `threads_create failed: ${error.message}`, timestamp: Date.now(), toolCalls: [record] };
      thread.messages.push(message as any);
      mgrInternals.emit(sourceThreadId, { type: 'message', message } as any);
    },
  ).finally(() => { outcome.done = true; });
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
(window as any).__showInlineContent = async () => {
  const thread = manager.getThread('thread-new')!;
  thread.title = 'Quarterly review';
  thread.messages = JSON.parse(JSON.stringify(inlineContentMessages));
  await view.focusThread(thread.id);
};
(window as any).__setDocumentPane = (enabled: boolean) => {
  hostHeader.style.display = enabled ? 'flex' : 'none';
  mockWorkspace.trigger('layout-change');
};
(window as any).__closeView = async () => {
  await view.onClose();
  (view as any).unload();
};

import './obsidian-mock'; // must be first — sets up HTMLElement.prototype
import { ClaudeThreadsSettingTab, RequestSecretModal } from '../../src/SettingsTab';
import { DEFAULT_SETTINGS, type PluginSettings, type Project, type ScheduledItem, type WatchedDocument } from '../../src/types';
import { mockApp } from './obsidian-mock';
import { McpRegistrationModal } from '../../src/confirmModal';

(window as any).__openMcpRegistration = (type: 'stdio' | 'http' = 'stdio') => {
  (window as any).__mcpRegistrationResult = undefined;
  const entry = type === 'stdio'
    ? { name: 'example-tools', type, command: 'npx', args: ['-y', '@example/mcp-server'], env: { API_TOKEN: '${EXAMPLE_TOKEN}' } }
    : { name: 'example-tools', type, url: 'https://mcp.example.com/agent/tools', headers: { Authorization: 'Bearer ${EXAMPLE_TOKEN}' } };
  new McpRegistrationModal(mockApp as any, entry, result => { (window as any).__mcpRegistrationResult = result; }).open();
};

const fixtureProjects: Project[] = [
  {
    id: 'proj-1',
    name: 'Acme Webapp',
    vaultFolder: 'Work/Acme',
    cwdOverride: '/Users/mock/projects/acme-webapp',
    description: 'Next.js app. Prefer server components; run pnpm test before pushing.',
    createdAt: 1700000000000,
  },
  {
    id: 'proj-2',
    name: 'Personal Notes',
    vaultFolder: 'Personal',
    createdAt: 1700000100000,
  },
];

const FIXTURE_NOW = new Date('2026-08-29T14:00:00-04:00').getTime();
Date.now = () => FIXTURE_NOW;

const fixtureScheduled: ScheduledItem[] = [
  {
    id: 'sched-1',
    name: 'Morning inbox triage',
    prompt: 'Triage my email inbox and summarize anything urgent.',
    schedule: { type: 'daily', timeOfDay: '09:00', activeHours: { start: '07:00', end: '18:00' } },
    enabled: true,
    cwd: '/Users/mock/work/acme',
    projectId: 'proj-1',
    lastRun: FIXTURE_NOW - 24 * 60 * 60_000,
    nextRun: FIXTURE_NOW - 5 * 60_000,
    lastThreadId: 'thread-morning',
    gate: { command: 'test -s inbox/pending.txt', timeoutSeconds: 15 },
    runHistory: [
      { ts: FIXTURE_NOW - 48 * 60 * 60_000, outcome: 'skipped-gate', gateExitCode: 1 },
      { ts: FIXTURE_NOW - 24 * 60 * 60_000, outcome: 'fired' },
    ],
  },
  {
    id: 'sched-2',
    name: 'Weekly PR sweep',
    prompt: 'Review and triage all open PRs.',
    schedule: { type: 'weekly', daysOfWeek: [1], timeOfDay: '08:30' },
    enabled: false,
  },
  {
    id: 'sched-3',
    name: 'Project pulse',
    prompt: 'Summarize project progress.',
    schedule: { type: 'interval', intervalSeconds: 4 * 60 * 60 },
    enabled: true,
    nextRun: FIXTURE_NOW + 42 * 60_000,
    projectId: 'proj-1',
  },
  {
    id: 'loop-1',
    name: 'Loop: watch CI',
    prompt: 'Check whether CI has finished.',
    schedule: { type: 'interval', intervalSeconds: 10 * 60 },
    enabled: true,
    nextRun: FIXTURE_NOW + 8 * 60_000,
    targetThreadId: 'thread-ci',
  },
  {
    id: 'wakeup-1',
    name: 'Wakeup: deployment check',
    prompt: 'Resume and inspect the deployment.',
    schedule: { type: 'once', fireAt: FIXTURE_NOW + 20 * 60_000 },
    enabled: true,
    nextRun: FIXTURE_NOW + 20 * 60_000,
    targetThreadId: 'thread-deploy',
    origin: 'wakeup',
  },
  {
    id: 'heartbeat-1',
    name: 'Thread Orchestrator heartbeat',
    prompt: 'Review threads.',
    schedule: { type: 'interval', intervalSeconds: 60 * 60 },
    enabled: true,
    nextRun: FIXTURE_NOW + 5 * 60_000,
    targetThreadId: 'thread-orchestrator',
    isOrchestratorHeartbeat: true,
  },
];

// Two watches for the Settings → Scheduled tab's "Watched documents" card:
// one with a live owning thread and a recorded alert, one whose owning
// thread no longer exists (covers the "Thread no longer exists" label and
// the missing "Open owning thread" button).
const fixtureWatchedDocuments: WatchedDocument[] = [
  {
    id: 'watch-1',
    path: 'Reports/Weekly Report.md',
    threadId: 'thread-doc-watch',
    enabled: true,
    createdAt: FIXTURE_NOW - 3 * 24 * 60 * 60_000,
    lastStamp: '1700000000000:2048',
    lastAlertedAt: FIXTURE_NOW - 90 * 60_000,
  },
  {
    id: 'watch-2',
    path: 'Specs/Orphaned Watch.md',
    threadId: 'thread-gone',
    enabled: true,
    createdAt: FIXTURE_NOW - 10 * 24 * 60 * 60_000,
  },
];

// One server per transport for the Settings → MCP tab screenshot. `compass`
// references ${COMPASS_API_KEY}, which is deliberately NOT in secretEnvKeys
// below, so the baseline also captures the "will be skipped" warning that
// replaced silently injecting a blank Authorization header.
const fixtureMcpServers: PluginSettings['mcpServers'] = {
  obsidian_notes: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@example/obsidian-notes-mcp'],
    env: { NOTES_API_TOKEN: '${NOTES_API_TOKEN}' },
  },
  compass: {
    type: 'http',
    url: 'https://compass.rbcodelabs.com/api/mcp',
    headers: { Authorization: 'Bearer ${COMPASS_API_KEY}' },
  },
  team_events: {
    type: 'sse',
    url: 'https://events.example.com/sse',
  },
};

// Two OAuth MCP servers for the Settings → MCP tab's "OAuth MCP servers"
// panel, covering the two visually distinct statuses `describeOAuthMcpStatus`
// renders: a healthy 'connected' server (green dot, live countdown) and an
// 'error' server (red dot, plus the inline warning line). The countdown is a
// fixed offset from FIXTURE_NOW (not Date.now()) so "expires in 2h 45m"
// renders identically on every run — using the real clock would make the
// screenshot's text drift and fail the pixel-diff a few minutes later.
const fixtureOAuthMcpServers: PluginSettings['oauthMcpServers'] = {
  vercel: {
    url: 'https://mcp.vercel.com/',
    scopes: 'read write',
    authorizationServerUrl: 'https://mcp.vercel.com/',
  },
  figma: {
    url: 'https://mcp.figma.com/',
    authorizationServerUrl: 'https://mcp.figma.com/',
  },
};

const fixtureOAuthMcpState: PluginSettings['oauthMcpState'] = {
  vercel: {
    serverName: 'vercel',
    clientId: 'dcr-client-vercel',
    asMetadataUrl: 'https://mcp.vercel.com/',
    proxyPort: 51231,
    status: 'connected',
    accessTokenExpiresAt: FIXTURE_NOW + 165 * 60_000, // -> "expires in 2h 45m"
    hasRefreshToken: true,
    tokenEndpoint: 'https://mcp.vercel.com/oauth/token',
  },
  figma: {
    serverName: 'figma',
    clientId: 'dcr-client-figma',
    asMetadataUrl: 'https://mcp.figma.com/',
    proxyPort: 0,
    status: 'error',
    errorMessage: 'Refresh failed: invalid_grant — re-authorize this server.',
    hasRefreshToken: false,
    tokenEndpoint: 'https://mcp.figma.com/oauth/token',
  },
};

const settings: PluginSettings = {
  ...DEFAULT_SETTINGS,
  claudeBinaryPath: '/opt/homebrew/bin/claude',
  defaultModel: 'sonnet',
  secretEnvKeys: ['STRIPE_SECRET_KEY', 'NOTES_API_TOKEN'],
  mcpServers: fixtureMcpServers,
  oauthMcpServers: fixtureOAuthMcpServers,
  oauthMcpState: fixtureOAuthMcpState,
  alwaysAllowedTools: ['Bash', 'Read', 'mcp__obsidian__obsidian_search_vault'],
  escalationEnabled: true,
  summarizationEnabled: true,
  projects: fixtureProjects,
  scheduledItems: fixtureScheduled,
  watchedDocuments: fixtureWatchedDocuments,
};

const scheduledCreateCalls: {
  dispatches: Array<{ prompt: string; title: string | undefined }>;
  openedThreadIds: string[];
  updatedItemIds: string[];
  deletedItemIds: string[];
} = {
  dispatches: [],
  openedThreadIds: [],
  updatedItemIds: [],
  deletedItemIds: [],
};

const mockPlugin = {
  app: mockApp,
  settings,
  discoveredModelsByHarness: {
    claude: [],
    codex: [{ value: 'gpt-5.6-codex', displayName: 'GPT-5.6 Codex' }],
  },
  manager: {
    getProjects: () => settings.projects,
    getProject: (id: string) => settings.projects.find((project) => project.id === id),
    getProjectCwd: (project: Project) => project.cwdOverride ?? `/Users/mock/vault/${project.vaultFolder}`,
    updateProject: (id: string, updates: Partial<Project>) => {
      const project = settings.projects.find((candidate) => candidate.id === id);
      if (project) Object.assign(project, updates);
    },
    getThreadsByProject: (id: string) => id === 'proj-1'
      ? [{ id: 'thread-1' }, { id: 'thread-2' }]
      : [{ id: 'thread-3' }],
    deleteProject: (id: string) => { settings.projects = settings.projects.filter(project => project.id !== id); },
    createProject: (name: string, vaultFolder: string, description?: string, cwdOverride?: string) => {
      const project = { id: `proj-${settings.projects.length + 1}`, name, vaultFolder, description, cwdOverride, orchestratorEnabled: true, createdAt: Date.now() };
      settings.projects.push(project);
      return project;
    },
    updateSettings: () => {},
    getThread: (id: string) => {
      if (id === 'thread-morning') return { id, title: 'Morning inbox triage run' };
      if (id === 'thread-ci') return { id, title: 'CI watcher', agentHarness: 'codex', model: 'gpt-5.6-codex' };
      if (id === 'thread-doc-watch') return { id, title: 'Weekly report review' };
      return undefined;
    },
  },
  scheduler: {
    updateItem: async (id: string, patch: Partial<ScheduledItem>) => {
      scheduledCreateCalls.updatedItemIds.push(id);
      const item = settings.scheduledItems.find((candidate) => candidate.id === id);
      if (item) Object.assign(item, patch);
    },
    deleteItem: async (id: string) => {
      scheduledCreateCalls.deletedItemIds.push(id);
      settings.scheduledItems = settings.scheduledItems.filter((candidate) => candidate.id !== id);
    },
    getEffectiveCwd: (item: ScheduledItem) => item.cwd ?? (item.projectId
      ? (settings.projects.find((project) => project.id === item.projectId)?.cwdOverride ?? `/Users/mock/vault/${settings.projects.find((project) => project.id === item.projectId)?.vaultFolder}`)
      : '/Users/mock/vault'),
  },
  oauthMcpRegistry: {
    status: (name: string) => settings.oauthMcpState[name],
    disconnect: async (name: string) => {
      delete settings.oauthMcpServers[name];
      delete settings.oauthMcpState[name];
    },
  },
  wakeLock: { setEnabled: () => {} },
  relayClient: null,
  initDesktopRelayClient: () => {},
  initMobileRelayClient: () => {},
  saveSettings: async () => {},
  ensureProjectOrchestratorThread: async () => {},
  deleteProject: async (id: string) => { settings.projects = settings.projects.filter(project => project.id !== id); },
  getView: () => null,
  getEffectiveCwd: () => '/Users/mock/vault',
  dispatchNewThread: async (prompt: string, _images: unknown, title: string | undefined) => {
    scheduledCreateCalls.dispatches.push({ prompt, title });
    return 'thread-created';
  },
  openThreadInChatView: async (threadId: string) => {
    scheduledCreateCalls.openedThreadIds.push(threadId);
  },
  unwatchDocument: async (threadId: string, opts: { id?: string; path?: string }) => {
    const before = settings.watchedDocuments.length;
    settings.watchedDocuments = settings.watchedDocuments.filter((w) => {
      if (w.threadId !== threadId) return true;
      if (opts.id && w.id === opts.id) return false;
      if (opts.path && w.path === opts.path) return false;
      return true;
    });
    return { removed: before - settings.watchedDocuments.length };
  },
};

const tab = new ClaudeThreadsSettingTab(mockApp as any, mockPlugin as any);
const container = document.getElementById('app')!;
container.appendChild(tab.containerEl);
tab.display();

// Expose for Playwright
(window as any).__settingsTab = tab;
(window as any).__settings = settings;
(window as any).__settingsPlugin = mockPlugin;
(window as any).__scheduledCreateCalls = scheduledCreateCalls;

/**
 * Opens a RequestSecretModal and resolves when the user saves or cancels.
 * Used by the request-secret-modal screenshot spec.
 */
(window as any).__openRequestSecretModal = (force: boolean): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const modal = new RequestSecretModal(
      mockApp as any,
      'MY_API_KEY',
      'to authenticate with the My API service',
      (saved) => resolve(saved),
      force,
    );
    modal.open();
  });

/**
 * Plugin wiring for Chief of Staff onboarding (spec §10): first run creates the
 * home thread through the real ThreadManager, falls back to the static guide
 * (with the command pointer) when setup fails, respects the opt-out setting,
 * and the "Set up Chief of Staff" command is idempotent.
 *
 * Same construction pattern as ensure-orchestrator-thread.test.ts: a minimal
 * plugin via Object.create(prototype), no real App.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Notice } from 'obsidian';
import ClaudeThreadsPlugin from '../../src/main';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS, type SkillSource } from '../../src/types';
import {
  CHIEF_OF_STAFF_REPO_URL,
  CHIEF_OF_STAFF_SETUP_PROMPT,
  CHIEF_OF_STAFF_COMMAND_NAME,
  CHIEF_OF_STAFF_REF,
  decideFirstRun,
  isFreshInstallData,
} from '../../src/chiefOfStaffOnboarding';

type Internals = {
  firstRunSetup(offer: boolean): Promise<void>;
  openFirstRunPanels(): Promise<void>;
  isHarnessResolvable(h: string): boolean;
  isGitAvailable(): Promise<boolean>;
  getSkillSourceCloneBase(): string | null;
  runChiefOfStaffCommand(): Promise<void>;
};

function makePlugin(opts: { harnessReady?: boolean; resolvable?: string[]; gitAvailable?: boolean; cloneFails?: boolean; sources?: SkillSource[] } = {}) {
  const plugin = Object.create(ClaudeThreadsPlugin.prototype) as ClaudeThreadsPlugin & Internals;
  plugin.settings = { ...DEFAULT_SETTINGS, defaultCwd: '/tmp', threads: [], skillSources: opts.sources ?? [] };
  plugin.manager = new ThreadManager(plugin.settings);
  const sendMessage = vi.spyOn(plugin.manager, 'sendMessage').mockResolvedValue(undefined as never);
  (plugin as unknown as { saveData: (d: unknown) => Promise<void> }).saveData = vi.fn().mockResolvedValue(undefined);
  const openThread = vi.fn().mockResolvedValue(undefined);
  (plugin as unknown as { openThreadInChatView: typeof openThread }).openThreadInChatView = openThread;
  plugin.openFirstRunPanels = vi.fn().mockResolvedValue(undefined);
  plugin.isHarnessResolvable = (h: string) => (opts.harnessReady === false ? false : (opts.resolvable ?? ['claude', 'codex', 'opencode']).includes(h));
  plugin.isGitAvailable = vi.fn(async () => opts.gitAvailable ?? true);
  plugin.getSkillSourceCloneBase = () => '/tmp/vault/.obsidian/plugins/claude-threads/skill-sources';

  const created = new Map<string, string>();
  const vault = {
    getAbstractFileByPath: vi.fn(() => null),
    createFolder: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(async (path: string, content: string) => { created.set(path, content); }),
  };
  (plugin as unknown as { app: unknown }).app = { vault, workspace: {} };
  (plugin as unknown as { isConversationFirst: () => boolean }).isConversationFirst = () => true;
  (plugin as unknown as { contextPanel: unknown }).contextPanel = { openFile: vi.fn() };

  // Replace the real clone with a fake so no network is touched.
  const addSource = vi.fn(async (repoUrl: string, ref?: string): Promise<SkillSource> => {
    if (opts.cloneFails) throw new Error('Could not resolve host: github.com');
    const source: SkillSource = { id: 'gh-cos', name: 'Chief of Staff', type: 'github', repoUrl, ref, clonePath: '/tmp/x' };
    plugin.settings.skillSources = [...plugin.settings.skillSources, source];
    return source;
  });
  const realAddSource = plugin.addManagedGithubSkillSource;
  plugin.addManagedGithubSkillSource = addSource;

  return { plugin, openThread, sendMessage, vault, created, addSource, realAddSource };
}

beforeEach(() => { Notice.messages = []; Notice.hidden = []; });

describe('first run — Chief of Staff offered', () => {
  it('creates the Chief of Staff thread, starts cos-setup, opens it, and writes no guide', async () => {
    const { plugin, openThread, sendMessage, created, addSource } = makePlugin();
    await plugin.firstRunSetup(true);

    const threads = plugin.manager.getThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0]!.title).toBe('Chief of Staff');
    expect(plugin.settings.chiefOfStaffThreadId).toBe(threads[0]!.id);
    expect(addSource).toHaveBeenCalledWith(CHIEF_OF_STAFF_REPO_URL, CHIEF_OF_STAFF_REF);
    expect(threads[0]!.agentHarness ?? 'claude').toBe('claude');
    expect(plugin.settings.skillSources.map(s => s.repoUrl)).toEqual([CHIEF_OF_STAFF_REPO_URL]);
    expect(sendMessage).toHaveBeenCalledWith(threads[0]!.id, CHIEF_OF_STAFF_SETUP_PROMPT);
    expect(openThread).toHaveBeenCalledWith(threads[0]!.id);
    expect(plugin.openFirstRunPanels).toHaveBeenCalled();
    expect(created.size).toBe(0);
    expect(plugin.settings.hasSeenWelcome).toBe(true);
  });

  it('falls back to the static guide with the command pointer when the clone fails', async () => {
    const { plugin, created } = makePlugin({ cloneFails: true });
    await plugin.firstRunSetup(true);

    expect(plugin.manager.getThreads()).toHaveLength(0);
    const [path, content] = [...created.entries()][0]!;
    expect(path).toMatch(/Getting Started with Agent Threads\.md$/);
    expect(content).toContain('# Getting Started with Agent Threads');
    expect(content).toContain(`"${CHIEF_OF_STAFF_COMMAND_NAME}"`);
    expect(plugin.settings.hasSeenWelcome).toBe(true);
  });

  it('falls back to the static guide when the harness is not ready', async () => {
    const { plugin, created } = makePlugin({ harnessReady: false });
    await plugin.firstRunSetup(true);
    expect(plugin.manager.getThreads()).toHaveLength(0);
    expect([...created.values()][0]).toContain(CHIEF_OF_STAFF_COMMAND_NAME);
  });

  it('falls back to the static guide when thread creation throws', async () => {
    const { plugin, created } = makePlugin();
    vi.spyOn(plugin.manager, 'createThread').mockImplementation(() => { throw new Error('boom'); });
    await plugin.firstRunSetup(true);
    expect([...created.values()][0]).toContain(CHIEF_OF_STAFF_COMMAND_NAME);
    expect(plugin.settings.hasSeenWelcome).toBe(true);
  });
});

describe('first run — review fixes', () => {
  it('shows a persistent progress notice during setup and hides it afterwards', async () => {
    const { plugin } = makePlugin();
    await plugin.firstRunSetup(true);
    expect(Notice.messages).toContainEqual({ message: 'Setting up your Chief of Staff…', duration: 0 });
    expect(Notice.hidden).toContain('Setting up your Chief of Staff…');
  });

  it('hides the progress notice on failure too', async () => {
    const { plugin } = makePlugin({ cloneFails: true });
    await plugin.firstRunSetup(true);
    expect(Notice.hidden).toContain('Setting up your Chief of Staff…');
  });

  it('falls back without attempting a clone when git is missing', async () => {
    const { plugin, created, addSource } = makePlugin({ gitAvailable: false });
    await plugin.firstRunSetup(true);
    expect(addSource).not.toHaveBeenCalled();
    expect(plugin.manager.getThreads()).toHaveLength(0);
    expect([...created.values()][0]).toContain(CHIEF_OF_STAFF_COMMAND_NAME);
  });

  it('falls back when the vault has no clone base (getSkillSourceCloneBase() → null)', async () => {
    const { plugin, created, realAddSource } = makePlugin();
    plugin.addManagedGithubSkillSource = realAddSource;
    plugin.getSkillSourceCloneBase = () => null;
    await plugin.firstRunSetup(true);
    expect(plugin.manager.getThreads()).toHaveLength(0);
    expect([...created.values()][0]).toContain(CHIEF_OF_STAFF_COMMAND_NAME);
    expect(plugin.settings.hasSeenWelcome).toBe(true);
  });

  it('creates the thread on Claude when OpenCode is the selected harness', async () => {
    const { plugin } = makePlugin();
    plugin.settings.agentHarness = 'opencode';
    await plugin.firstRunSetup(true);
    const [thread] = plugin.manager.getThreads();
    expect(thread!.agentHarness).toBe('claude');
  });

  it('uses Codex when OpenCode is selected and Claude is not installed', async () => {
    const { plugin } = makePlugin({ resolvable: ['codex', 'opencode'] });
    plugin.settings.agentHarness = 'opencode';
    await plugin.firstRunSetup(true);
    expect(plugin.manager.getThreads()[0]!.agentHarness).toBe('codex');
  });

  it('falls back to the static guide when only OpenCode is available', async () => {
    const { plugin, created } = makePlugin({ resolvable: ['opencode'] });
    plugin.settings.agentHarness = 'opencode';
    await plugin.firstRunSetup(true);
    expect(plugin.manager.getThreads()).toHaveLength(0);
    expect([...created.values()][0]).toContain(CHIEF_OF_STAFF_COMMAND_NAME);
  });
});

describe('fresh-install gate', () => {
  // loadSettings() sets isFreshInstall = isFreshInstallData(await loadData()).
  it('is fresh only when there is no saved data at all', () => {
    expect(isFreshInstallData(null)).toBe(true);
    expect(isFreshInstallData(undefined)).toBe(true);
    expect(isFreshInstallData({})).toBe(false);
    expect(isFreshInstallData({ hasSeenWelcome: false })).toBe(false);
  });

  it('a pre-flag user with saved data and no threads gets the static guide; a fresh install gets Chief of Staff', () => {
    const base = { hasSeenWelcome: false, threadCount: 0, offerChiefOfStaff: true };
    expect(decideFirstRun({ ...base, isFreshInstall: isFreshInstallData({ vaultFolder: 'x' }) })).toBe('static-guide');
    expect(decideFirstRun({ ...base, isFreshInstall: isFreshInstallData(null) })).toBe('chief-of-staff');
  });
});

describe('first run — offer turned off', () => {
  it('writes the original static guide with no pointer and touches no source or thread', async () => {
    const { plugin, created, addSource } = makePlugin();
    await plugin.firstRunSetup(false);
    expect(plugin.manager.getThreads()).toHaveLength(0);
    expect(addSource).not.toHaveBeenCalled();
    const content = [...created.values()][0]!;
    expect(content).toContain('# Getting Started with Agent Threads');
    expect(content).not.toContain(CHIEF_OF_STAFF_COMMAND_NAME);
  });
});

describe('"Set up Chief of Staff" command', () => {
  it('is idempotent: a second run focuses the same thread instead of creating another', async () => {
    const { plugin, openThread, sendMessage, addSource } = makePlugin();
    await plugin.runChiefOfStaffCommand();
    await plugin.runChiefOfStaffCommand();

    const threads = plugin.manager.getThreads();
    expect(threads).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(addSource).toHaveBeenCalledTimes(1);
    expect(openThread).toHaveBeenCalledTimes(2);
    expect(openThread).toHaveBeenLastCalledWith(threads[0]!.id);
    expect(plugin.settings.skillSources).toHaveLength(1);
  });

  it('concurrent invocations share one run and create a single thread', async () => {
    const { plugin, sendMessage } = makePlugin();
    await Promise.all([plugin.runChiefOfStaffCommand(), plugin.runChiefOfStaffCommand()]);
    expect(plugin.manager.getThreads()).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('tells the user when the home thread exists but the skills could not be (re)added', async () => {
    const { plugin, openThread } = makePlugin({ cloneFails: true });
    const home = plugin.manager.createThread('Chief of Staff', '/tmp');
    await plugin.runChiefOfStaffCommand();
    expect(openThread).toHaveBeenCalledWith(home.id);
    expect(Notice.messages.map(n => n.message)).toContain(
      'Opened your Chief of Staff thread, but the Chief of Staff skills could not be added: Could not resolve host: github.com',
    );
  });

  it('restarts a live home-thread session when the source is re-added, and says so', async () => {
    const { plugin } = makePlugin();
    const home = plugin.manager.createThread('Chief of Staff', '/tmp');
    const restart = vi.spyOn(plugin.manager, 'requestSessionRestart').mockReturnValue(true);
    await plugin.runChiefOfStaffCommand();
    expect(restart).toHaveBeenCalledWith(home.id);
    expect(Notice.messages.map(n => n.message)).toContain('Chief of Staff skills added. The thread restarts on your next message so they load.');
  });

  it('explains via Notice when only OpenCode is available', async () => {
    const { plugin } = makePlugin({ resolvable: ['opencode'] });
    plugin.settings.agentHarness = 'opencode';
    await plugin.runChiefOfStaffCommand();
    expect(plugin.manager.getThreads()).toHaveLength(0);
    expect(Notice.messages.map(n => n.message).join('\n')).toMatch(/OpenCode sessions do not load skill sources/);
  });

  it('works for an existing user who already has the source and other threads', async () => {
    const { plugin, addSource } = makePlugin({
      sources: [{ id: 'mine', name: 'CoS', type: 'github', repoUrl: CHIEF_OF_STAFF_REPO_URL, clonePath: '/tmp/cos' }],
    });
    plugin.manager.createThread('Some other work', '/tmp');
    await plugin.runChiefOfStaffCommand();
    expect(addSource).not.toHaveBeenCalled();
    expect(plugin.manager.getThreads().map(t => t.title).sort()).toEqual(['Chief of Staff', 'Some other work']);
  });
});

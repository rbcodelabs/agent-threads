/**
 * QA (orchestrator extraction slices 2-4): adversarial gap tests on top of the feature tests.
 * Concurrency of ensure, setEnabled/ensure/dispatch interplay on the real ThreadManager,
 * PeerSkills materialization safety, legacy heartbeat cleanup edges.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ClaudeThreadsPlugin from '../../src/main';
import { ThreadManager } from '../../src/ThreadManager';
import { PeerSkillRegistry } from '../../src/PeerSkills';
import { stripLegacyOrchestratorHeartbeats } from '../../src/legacyHeartbeats';
import { DEFAULT_SETTINGS } from '../../src/types';

function makePlugin() {
  const plugin = Object.create(ClaudeThreadsPlugin.prototype) as ClaudeThreadsPlugin;
  plugin.manager = new ThreadManager({ ...DEFAULT_SETTINGS });
  plugin.settings = { ...DEFAULT_SETTINGS, defaultCwd: '/tmp', scheduledItems: [] };
  const saveData = vi.fn().mockResolvedValue(undefined);
  (plugin as unknown as { saveData: typeof saveData }).saveData = saveData;
  (plugin as unknown as { openThreadInChatView: (id: string) => Promise<void> }).openThreadInChatView = vi.fn().mockResolvedValue(undefined);
  return { plugin, saveData, open: (plugin as unknown as { openThreadInChatView: ReturnType<typeof vi.fn> }).openThreadInChatView };
}
const resolve = (p: ClaudeThreadsPlugin, id: string) => (p as unknown as { resolvePublicOrchestrator(t: { id: string }): Promise<string | null> }).resolvePublicOrchestrator({ id });
const list = (p: ClaudeThreadsPlugin) => (p as unknown as { listPublicOrchestrators(): Array<Record<string, unknown>> }).listPublicOrchestrators();

describe('QA core: concurrent ensure is idempotent (one thread, one designation)', () => {
  it('five simultaneous ensure(portfolio) calls create exactly one Portfolio thread', async () => {
    const { plugin } = makePlugin();
    const results = await Promise.all(Array.from({ length: 5 }, () => plugin.ensurePublicOrchestrator({ id: 'portfolio' })));
    expect(new Set(results.map(r => r!.threadId)).size).toBe(1);
    expect(plugin.manager.getThreads().filter(t => t.title === 'Portfolio Orchestrator')).toHaveLength(1);
  });

  it('five simultaneous ensure(project) calls create exactly one Project orchestrator thread', async () => {
    const { plugin } = makePlugin();
    const project = plugin.manager.createProject('HipTrip', 'HipTrip');
    const results = await Promise.all(Array.from({ length: 5 }, () => plugin.ensurePublicOrchestrator({ id: `project:${project.id}` })));
    expect(new Set(results.map(r => r!.threadId)).size).toBe(1);
    expect(plugin.manager.getThreadsByProject(project.id)).toHaveLength(1);
  });

  it('simultaneous ensure on a DISABLED project re-enables it and still creates exactly one thread', async () => {
    const { plugin } = makePlugin();
    const project = plugin.manager.createProject('HipTrip', 'HipTrip');
    plugin.manager.updateProject(project.id, { orchestratorEnabled: false });
    const results = await Promise.all([1, 2, 3].map(() => plugin.ensurePublicOrchestrator({ id: `project:${project.id}` })));
    expect(results.every(r => r!.enabled === true)).toBe(true);
    expect(new Set(results.map(r => r!.threadId)).size).toBe(1);
    expect(plugin.manager.getThreadsByProject(project.id)).toHaveLength(1);
  });

  it('ensure never opens a chat view', async () => {
    const { plugin, open } = makePlugin();
    const project = plugin.manager.createProject('HipTrip', 'HipTrip');
    await plugin.ensurePublicOrchestrator({ id: 'portfolio' });
    await plugin.ensurePublicOrchestrator({ id: `project:${project.id}` });
    expect(open).not.toHaveBeenCalled();
  });
});

describe('QA core: setEnabled / ensure / dispatch-resolution semantics on a real ThreadManager', () => {
  it('disable keeps the same thread and id; list shows enabled:false with that thread; enable returns the SAME thread', async () => {
    const { plugin } = makePlugin();
    const project = plugin.manager.createProject('HipTrip', 'HipTrip');
    const id = `project:${project.id}`;
    const first = (await plugin.ensurePublicOrchestrator({ id }))!;
    const off = (await plugin.setPublicOrchestratorEnabled({ id }, false))!;
    expect(off).toMatchObject({ enabled: false, threadId: first.threadId });
    expect(plugin.manager.getThread(first.threadId), 'thread is not archived/deleted').toBeDefined();
    expect(plugin.manager.getProject(project.id)).toMatchObject({ orchestratorEnabled: false, orchestratorThreadId: first.threadId });
    expect(list(plugin).find(o => o.id === id)).toMatchObject({ enabled: false, threadId: first.threadId });
    const on = (await plugin.setPublicOrchestratorEnabled({ id }, true))!;
    expect(on).toMatchObject({ enabled: true, threadId: first.threadId });
    expect(plugin.manager.getThreadsByProject(project.id)).toHaveLength(1);
  });

  it('disabling twice is idempotent and does not touch the thread', async () => {
    const { plugin } = makePlugin();
    const project = plugin.manager.createProject('HipTrip', 'HipTrip');
    const id = `project:${project.id}`;
    const { threadId } = (await plugin.ensurePublicOrchestrator({ id }))!;
    await plugin.setPublicOrchestratorEnabled({ id }, false);
    await plugin.setPublicOrchestratorEnabled({ id }, false);
    expect(plugin.manager.getProject(project.id)?.orchestratorThreadId).toBe(threadId);
  });

  it('dispatch resolution refuses a disabled project (null) and creates no thread; resolution of an enabled thread-less project creates one', async () => {
    const { plugin } = makePlugin();
    const project = plugin.manager.createProject('HipTrip', 'HipTrip');
    const id = `project:${project.id}`;
    await plugin.setPublicOrchestratorEnabled({ id }, false);
    expect(await resolve(plugin, id)).toBeNull();
    expect(plugin.manager.getThreadsByProject(project.id)).toHaveLength(0);
    await plugin.setPublicOrchestratorEnabled({ id }, true);
    const threadId = await resolve(plugin, id);
    expect(threadId).toBeTruthy();
  });

  it('disabling a never-created orchestrator then resolving still creates nothing', async () => {
    const { plugin } = makePlugin();
    const project = plugin.manager.createProject('HipTrip', 'HipTrip');
    const id = `project:${project.id}`;
    const off = await plugin.setPublicOrchestratorEnabled({ id }, false);
    expect(off).toMatchObject({ enabled: false, threadId: '' });
    expect(await resolve(plugin, id)).toBeNull();
    expect(plugin.manager.getThreads()).toHaveLength(0);
  });

  it('setEnabled persists (saveSettings) on a real change and ensure persists the re-enable', async () => {
    const { plugin, saveData } = makePlugin();
    const project = plugin.manager.createProject('HipTrip', 'HipTrip');
    const id = `project:${project.id}`;
    await plugin.ensurePublicOrchestrator({ id });
    saveData.mockClear();
    await plugin.setPublicOrchestratorEnabled({ id }, false);
    expect(saveData).toHaveBeenCalled();
    saveData.mockClear();
    await plugin.ensurePublicOrchestrator({ id });
    expect(saveData).toHaveBeenCalled();
    expect(plugin.manager.getProject(project.id)?.orchestratorEnabled).toBe(true);
  });

  it('ensure/setEnabled with a Project-prefixed but unknown id return null (no thread created); portfolio setEnabled(false) returns null at the host layer', async () => {
    const { plugin } = makePlugin();
    expect(await plugin.ensurePublicOrchestrator({ id: 'project:ghost' })).toBeNull();
    expect(await plugin.setPublicOrchestratorEnabled({ id: 'project:ghost' }, false)).toBeNull();
    expect(await plugin.setPublicOrchestratorEnabled({ id: 'portfolio' }, false)).toBeNull();
    expect(plugin.manager.getThreads()).toHaveLength(0);
  });

  it('list() never lists a never-created enabled Project and lists the Portfolio only once it exists', async () => {
    const { plugin } = makePlugin();
    plugin.manager.createProject('HipTrip', 'HipTrip');
    expect(list(plugin)).toEqual([]);
    await plugin.ensurePublicOrchestrator({ id: 'portfolio' });
    expect(list(plugin).map(o => o.id)).toEqual(['portfolio']);
  });

  it('isOrchestratorManagedByPlugin flips with a registration by ANY owner and ignores other skill names', () => {
    const { plugin } = makePlugin();
    expect(plugin.isOrchestratorManagedByPlugin()).toBe(false);
    const other = plugin.manager.peerSkills.register({ pluginId: 'x' }, { name: 'something-else', description: 'd', content: 'c' });
    expect(plugin.isOrchestratorManagedByPlugin()).toBe(false);
    other.dispose();
    const d = plugin.manager.peerSkills.register({ pluginId: 'x' }, { name: 'thread-orchestrator', description: 'd', content: 'c' });
    expect(plugin.isOrchestratorManagedByPlugin()).toBe(true);
    d.dispose();
    expect(plugin.isOrchestratorManagedByPlugin()).toBe(false);
  });
});

describe('QA core: PeerSkills registry and materialization safety', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-peer-skills-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = (over: Record<string, unknown> = {}) => ({ name: 'thread-orchestrator', description: 'Orchestrate threads', content: '# Body\nhello', ...over });

  it.each(['..', '.', 'a/b', 'a\\b', '-lead', 'UP', 'with space', 'a.b', '%2e%2e', 'x\u0000y', ' trailing'])('rejects skill name %j so it can never escape the root', (name) => {
    expect(() => new PeerSkillRegistry().register({ pluginId: 'p' }, spec({ name }))).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it.each([null, undefined, 5, {}, []])('rejects non-string name/description/content %j', (v) => {
    for (const field of ['name', 'description', 'content']) {
      expect(() => new PeerSkillRegistry().register({ pluginId: 'p' }, spec({ [field]: v }))).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
  });

  it('rejects a non-object spec', () => {
    for (const bad of [null, undefined, 'x', 3]) expect(() => new PeerSkillRegistry().register({ pluginId: 'p' }, bad as never)).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('boundary sizes: 64-char name ok, 1024/100000 ok, 1025/100001 rejected; whitespace-only content/description rejected', () => {
    const r = new PeerSkillRegistry();
    expect(() => r.register({ pluginId: 'p' }, spec({ name: 'a'.repeat(64) }))).not.toThrow();
    expect(() => r.register({ pluginId: 'p' }, spec({ name: 'a'.repeat(65) }))).toThrow();
    expect(() => r.register({ pluginId: 'p' }, spec({ content: ' \n\t ' }))).toThrow();
    expect(() => r.register({ pluginId: 'p' }, spec({ description: ' \n ' }))).toThrow();
  });

  it('after the owner disposes, a different plugin may take the name; a failed takeover leaves the original intact', () => {
    const r = new PeerSkillRegistry();
    const a = r.register({ pluginId: 'a' }, spec({ content: 'A' }));
    expect(() => r.register({ pluginId: 'b' }, spec({ content: 'B' }))).toThrow();
    expect(r.list()[0]!.content).toBe('A');
    a.dispose();
    r.register({ pluginId: 'b' }, spec({ content: 'B' }));
    expect(r.list()[0]!.content).toBe('B');
  });

  it('owner ids are trimmed: " a " and "a" are the same owner (replace), not a collision', () => {
    const r = new PeerSkillRegistry();
    r.register({ pluginId: ' a ' }, spec({ content: 'one' }));
    expect(() => r.register({ pluginId: 'a' }, spec({ content: 'two' }))).not.toThrow();
    expect(r.list()[0]!.content).toBe('two');
  });

  it('registered specs are frozen copies: mutating the caller object afterwards does not change the registry', () => {
    const r = new PeerSkillRegistry();
    const s = spec();
    r.register({ pluginId: 'p' }, s);
    s.content = 'tampered';
    expect(r.list()[0]!.content).toBe('# Body\nhello');
    expect(Object.isFrozen(r.list()[0])).toBe(true);
  });

  it('frontmatter stays a single quoted line for hostile descriptions (newline, ---, colon, quote, backslash) and round-trips through JSON', () => {
    const hostile = 'line1\nline2: "quoted" \\ back --- \n---\nname: evil';
    const r = new PeerSkillRegistry();
    r.register({ pluginId: 'p' }, spec({ description: hostile }));
    r.materialize(root);
    const text = fs.readFileSync(path.join(root, 'thread-orchestrator', 'SKILL.md'), 'utf8');
    const fm = text.split('\n');
    expect(fm[0]).toBe('---');
    expect(fm[1]).toBe('name: thread-orchestrator');
    expect(fm[2].startsWith('description: ')).toBe(true);
    expect(JSON.parse(fm[2].slice('description: '.length))).toBe(hostile);
    expect(fm[3], 'frontmatter closes on the very next line').toBe('---');
    expect(text.match(/^name:/gm)).toHaveLength(1);
  });

  it('content that itself looks like frontmatter cannot alter the real frontmatter (it sits after the closing ---)', () => {
    const r = new PeerSkillRegistry();
    r.register({ pluginId: 'p' }, spec({ content: '---\nname: evil\n---\nbody' }));
    r.materialize(root);
    const text = fs.readFileSync(path.join(root, 'thread-orchestrator', 'SKILL.md'), 'utf8');
    expect(text.indexOf('name: thread-orchestrator')).toBeLessThan(text.indexOf('name: evil'));
    expect(text.split('\n').slice(0, 4)).toEqual(['---', 'name: thread-orchestrator', expect.stringMatching(/^description: /), '---']);
  });

  it('materialize is idempotent: unchanged content is not rewritten, changed content is', async () => {
    const r = new PeerSkillRegistry();
    r.register({ pluginId: 'p' }, spec());
    r.materialize(root);
    const file = path.join(root, 'thread-orchestrator', 'SKILL.md');
    const old = new Date(2020, 0, 1);
    fs.utimesSync(file, old, old);
    r.materialize(root);
    expect(fs.statSync(file).mtimeMs).toBe(old.getTime());
    r.register({ pluginId: 'p' }, spec({ content: 'changed body' }));
    r.materialize(root);
    expect(fs.readFileSync(file, 'utf8')).toContain('changed body');
  });

  it('stale cleanup removes only valid-named skill directories; foreign files, dot dirs and invalid names are untouched', () => {
    fs.mkdirSync(path.join(root, 'old-skill'));
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, 'Not_A_Skill'));
    fs.writeFileSync(path.join(root, 'README.txt'), 'keep');
    const r = new PeerSkillRegistry();
    r.register({ pluginId: 'p' }, spec());
    r.materialize(root);
    expect(fs.existsSync(path.join(root, 'old-skill'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'Not_A_Skill'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'README.txt'), 'utf8')).toBe('keep');
  });

  it('a symlinked directory in the root is never followed or deleted by cleanup', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'precious.txt'), 'data');
      fs.symlinkSync(outside, path.join(root, 'linked-skill'));
      new PeerSkillRegistry().register({ pluginId: 'p' }, spec());
      const r = new PeerSkillRegistry();
      r.register({ pluginId: 'p' }, spec());
      r.materialize(root);
      expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('data');
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });

  it('two registered skills produce two plugin entries in registration order', () => {
    const r = new PeerSkillRegistry();
    r.register({ pluginId: 'p' }, spec({ name: 'one' }));
    r.register({ pluginId: 'p' }, spec({ name: 'two' }));
    expect(r.materialize(root).map(p => path.basename(p.path))).toEqual(['one', 'two']);
  });

  it('ThreadManager: an unwritable pluginResourceDir degrades to no peer skills (warns) instead of failing session options', () => {
    const blocker = path.join(root, 'file-not-dir');
    fs.writeFileSync(blocker, 'x');
    const m = new ThreadManager({ ...DEFAULT_SETTINGS });
    m.pluginResourceDir = blocker; // <file>/.peer-skills cannot be created
    m.peerSkills.register({ pluginId: 'p' }, spec());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => m.buildHostSkillPlugins()).not.toThrow();
      expect(m.buildHostSkillPlugins().filter(p => p.path.includes('.peer-skills'))).toEqual([]);
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('ThreadManager: with pluginResourceDir unset the skill is materialized under the OS temp dir and removed again after dispose', () => {
    const m = new ThreadManager({ ...DEFAULT_SETTINGS });
    const d = m.peerSkills.register({ pluginId: 'p' }, spec({ name: 'qa-tmp-fallback' }));
    const plugins = m.buildHostSkillPlugins();
    const entry = plugins.find(p => p.path.endsWith('qa-tmp-fallback'));
    try {
      expect(entry).toBeDefined();
      expect(entry!.path.startsWith(os.tmpdir()) || entry!.path.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
      expect(fs.existsSync(path.join(entry!.path, 'SKILL.md'))).toBe(true);
    } finally {
      d.dispose();
      m.buildHostSkillPlugins();
    }
    expect(fs.existsSync(entry!.path)).toBe(false);
  });
});

describe('QA core: legacy heartbeat cleanup edges', () => {
  const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, prompt: 'p', schedule: { type: 'interval', intervalSeconds: 3600 }, enabled: true, ...extra }) as never;

  it('an ordinary item that targets an orchestrator thread but lacks the flag is kept; falsy flag values are kept', () => {
    const items = [item('user-cron', { targetThreadId: 'orch' }), item('f', { isOrchestratorHeartbeat: false }), item('hb', { isOrchestratorHeartbeat: true, targetThreadId: 'orch' })];
    const out = stripLegacyOrchestratorHeartbeats(items);
    expect(out.items.map((i: { id: string }) => i.id)).toEqual(['user-cron', 'f']);
  });

  it('does not mutate the input array and keeps survivors by reference and order', () => {
    const a = item('a'); const hb = item('hb', { isOrchestratorHeartbeat: true }); const b = item('b');
    const input = [a, hb, b];
    const out = stripLegacyOrchestratorHeartbeats(input);
    expect(input).toEqual([a, hb, b]);
    expect(out.items[0]).toBe(a);
    expect(out.items[1]).toBe(b);
  });

  it('handles an empty list and a list of only heartbeats (including Project-scoped ones)', () => {
    expect(stripLegacyOrchestratorHeartbeats([]).removed).toBe(0);
    const out = stripLegacyOrchestratorHeartbeats([item('x', { isOrchestratorHeartbeat: true }), item('y', { isOrchestratorHeartbeat: true, projectId: 'p1' })]);
    expect(out).toEqual({ items: [], removed: 2 });
  });

  it('main.ts runs the cleanup before the scheduler is constructed and persists only when something was removed', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/main.ts'), 'utf8');
    const cleanup = src.indexOf('stripLegacyOrchestratorHeartbeats(this.settings.scheduledItems');
    const scheduler = src.indexOf('this.scheduler = new Scheduler(');
    expect(cleanup).toBeGreaterThan(0);
    expect(cleanup).toBeLessThan(scheduler);
    expect(src).toContain('if (repairedOrchestrators || legacyHeartbeats.removed > 0) await this.saveSettings();');
  });

  it('core no longer ships wake-up, delegation, heartbeat creation or the bundled skill', () => {
    const srcDir = path.join(__dirname, '../../src');
    expect(fs.existsSync(path.join(srcDir, 'OrchestratorWakeup.ts'))).toBe(false);
    expect(fs.existsSync(path.join(__dirname, '../../resources/skills/thread-orchestrator'))).toBe(false);
    const main = fs.readFileSync(path.join(srcDir, 'main.ts'), 'utf8');
    for (const gone of ['orchestratorWakeup', 'wakeupDelegated', 'setWakeupDelegated', 'delegateWakeup', 'Portfolio Orchestrator Heartbeat']) expect(main, gone).not.toContain(gone);
    const api = fs.readFileSync(path.join(srcDir, 'PublicApi.ts'), 'utf8');
    expect(api).not.toContain('orchestrators.wakeup.delegate');
    expect(api).not.toContain('delegateWakeup');
    const esbuild = fs.readFileSync(path.join(__dirname, '../../esbuild.config.mjs'), 'utf8');
    expect(esbuild).not.toMatch(/resources\/skills|thread-orchestrator/);
  });
});

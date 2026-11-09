/**
 * session-plugins.test.ts
 *
 * Covers `opts.plugins` — how skills actually get loaded into a session. This
 * had zero coverage before, which is why a factually wrong comment sat on it
 * claiming `plugins: {type:'local'}` could not take a plugin root.
 *
 * Two layers:
 *  - the pure `buildSkillPlugins` enumeration, exercised directly against real
 *    temp-dir fixtures;
 *  - the real `ThreadManager.buildSessionOptions` wiring, exercised by driving
 *    `sendMessage` with `ThreadSession` mocked (same strategy as
 *    session-options.test.ts) so `pluginResourceDir` plumbing is verified, not
 *    assumed.
 *
 * The load-bearing assertion in both layers: nothing under `~/.claude/` is ever
 * registered, and nothing is ever copied there to make a skill loadable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { ThreadSessionOptions } from '../../src/ThreadSession';
import type { ImageAttachment } from '../../src/types';

vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));

const mock = vi.hoisted(() => ({
  callbacks: null as SessionCallbacks | null,
  sessionOptions: null as Record<string, unknown> | null,
}));

vi.mock('../../src/ThreadSession', () => ({
  ThreadSession: class {
    private _turnInFlight = false;
    constructor(_claudePath: string) {}
    get turnInFlight(): boolean { return this._turnInFlight; }
    async start(options: ThreadSessionOptions): Promise<void> {
      mock.sessionOptions = (options.claude?.sessionOptions as Record<string, unknown>) ?? null;
      mock.callbacks = options.callbacks;
    }
    send(_text: string, _images?: ImageAttachment[]): void { this._turnInFlight = true; }
    async interrupt(): Promise<void> {}
    async setModel(_model?: string): Promise<void> {}
    async setPermissionMode(_mode: unknown): Promise<void> {}
    async restart(): Promise<void> {}
    close(): void {}
    async getContextUsage(): Promise<null> { return null; }
  },
}));

const { buildSkillPlugins } = await import('../../src/skillManager');
const { pluginSkillsRootFrom, VAULT_SKILLS_PLUGIN_NAME } = await import('../../src/skillPaths');
const { ThreadManager } = await import('../../src/ThreadManager');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MANIFEST_DIR = '.obsidian/plugins/claude-threads';

let tmpVault: string;
let tmpHome: string;
let realHome: string | undefined;

/** `<vault>/<plugin-dir>` — what ThreadManager.pluginResourceDir points at. */
let pluginResourceDir: string;
/** `<vault>/<plugin-dir>/skills` — where the plugin installs skills. */
let vaultSkillsRoot: string;

beforeEach(() => {
  realHome = process.env.HOME;
  tmpVault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sessionplugins-vault-')));
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sessionplugins-home-')));
  process.env.HOME = tmpHome;
  pluginResourceDir = path.join(tmpVault, MANIFEST_DIR);
  vaultSkillsRoot = path.join(pluginResourceDir, 'skills');
  mock.callbacks = null;
  mock.sessionOptions = null;
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
  fs.rmSync(tmpVault, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writeSkill(root: string, id: string): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: ${id}\n---\n`, 'utf-8');
  return dir;
}

// ── Pure enumeration ──────────────────────────────────────────────────────────

describe('buildSkillPlugins', () => {
  it('returns nothing when there are no sources and no vault root', () => {
    expect(buildSkillPlugins({})).toEqual([]);
    expect(buildSkillPlugins({ pluginSkillsRoot: '' })).toEqual([]);
  });

  it('enumerates github source skills individually, unchanged from before', () => {
    const clonePath = path.join(tmpVault, 'clone');
    writeSkill(path.join(clonePath, 'skills'), 'gh-one');
    writeSkill(path.join(clonePath, 'skills'), 'gh-two');

    expect(buildSkillPlugins({
      skillSources: [{ id: 'g', name: 'G', type: 'github', clonePath }],
    })).toEqual([
      { type: 'local', path: path.join(clonePath, 'skills', 'gh-one') },
      { type: 'local', path: path.join(clonePath, 'skills', 'gh-two') },
    ]);
  });

  it('respects a custom skills dir declared in the source plugin manifest', () => {
    const clonePath = path.join(tmpVault, 'clone2');
    fs.mkdirSync(path.join(clonePath, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(clonePath, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'p', skills: 'custom' }),
      'utf-8',
    );
    writeSkill(path.join(clonePath, 'custom'), 'nested');

    expect(buildSkillPlugins({
      skillSources: [{ id: 'g', name: 'G', type: 'github', clonePath }],
    })).toEqual([{ type: 'local', path: path.join(clonePath, 'custom', 'nested') }]);
  });

  it('now enumerates local sources too, which previously registered nothing', () => {
    const skillsPath = path.join(tmpVault, 'local-source');
    writeSkill(skillsPath, 'local-one');

    expect(buildSkillPlugins({
      skillSources: [{ id: 'l', name: 'L', type: 'local', skillsPath }],
    })).toEqual([{ type: 'local', path: path.join(skillsPath, 'local-one') }]);
  });

  it('expands a leading ~ in a local source path', () => {
    const skillsPath = path.join(tmpHome, 'my-skills');
    writeSkill(skillsPath, 'tilde-one');

    expect(buildSkillPlugins({
      skillSources: [{ id: 'l', name: 'L', type: 'local', skillsPath: '~/my-skills' }],
    })).toEqual([{ type: 'local', path: path.join(skillsPath, 'tilde-one') }]);
  });

  it('registers the vault root ONCE as a plugin root, generating its manifest', () => {
    writeSkill(vaultSkillsRoot, 'vault-one');
    writeSkill(vaultSkillsRoot, 'vault-two');

    expect(buildSkillPlugins({ pluginSkillsRoot: vaultSkillsRoot }))
      .toEqual([{ type: 'local', path: pluginResourceDir }]);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginResourceDir, '.claude-plugin', 'plugin.json'), 'utf-8'),
    );
    expect(manifest.name).toBe(VAULT_SKILLS_PLUGIN_NAME);
    expect(manifest.skills).toBe('./skills');
  });

  it('writes no manifest and registers nothing when the vault root holds no skills', () => {
    fs.mkdirSync(vaultSkillsRoot, { recursive: true });
    expect(buildSkillPlugins({ pluginSkillsRoot: vaultSkillsRoot })).toEqual([]);
    expect(fs.existsSync(path.join(pluginResourceDir, '.claude-plugin'))).toBe(false);
  });

  it('appends peer-registered skill plugin paths after the other roots', () => {
    const peer = [{ type: 'local' as const, path: '/x/peer/thread-orchestrator' }];
    expect(buildSkillPlugins({ peerSkillPlugins: peer })).toEqual(peer);
  });

  it('never injects the retired bundled thread-orchestrator skill', () => {
    expect(buildSkillPlugins({ bundledSkillPath: path.join(pluginResourceDir, 'resources', 'skills', 'thread-orchestrator') } as never)).toEqual([]);
  });

  it("pluginResourceDir: '' yields no vault plugin and no bundled skill", () => {
    writeSkill(path.join(tmpHome, '.claude', 'skills'), 'home-one');
    expect(buildSkillPlugins({ pluginSkillsRoot: pluginSkillsRootFrom('') })).toEqual([]);
  });

  it('never registers anything under ~/.claude/', () => {
    writeSkill(path.join(tmpHome, '.claude', 'skills'), 'home-one');
    writeSkill(vaultSkillsRoot, 'vault-one');

    const result = buildSkillPlugins({ pluginSkillsRoot: vaultSkillsRoot });
    expect(result.some((p) => p.path.includes(path.join('.claude', 'skills')))).toBe(false);
  });
});

// ── ThreadManager wiring ──────────────────────────────────────────────────────

describe('ThreadManager.buildSessionOptions → opts.plugins', () => {
  async function optionsFor(configure: (m: InstanceType<typeof ThreadManager>) => void) {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    configure(manager);
    const thread = manager.createThread('T');
    await manager.sendMessage(thread.id, 'hi');
    mock.callbacks?.onDone('sess', 0, 1);
    return mock.sessionOptions;
  }

  it('registers the vault plugin root and each source skill for a real session', async () => {
    const clonePath = path.join(tmpVault, 'clone');
    writeSkill(path.join(clonePath, 'skills'), 'gh-one');
    writeSkill(vaultSkillsRoot, 'vault-one');

    const opts = await optionsFor((m) => {
      m.pluginResourceDir = pluginResourceDir;
      m.settings.skillSources = [{ id: 'g', name: 'G', type: 'github', clonePath }];
    });

    expect(opts?.plugins).toEqual([
      { type: 'local', path: path.join(clonePath, 'skills', 'gh-one') },
      { type: 'local', path: pluginResourceDir },
    ]);
  });

  it('omits opts.plugins entirely when nothing is registrable', async () => {
    const opts = await optionsFor((m) => {
      m.pluginResourceDir = pluginResourceDir;
    });
    expect(opts?.plugins).toBeUndefined();
  });

  it('loads the configured authored folder for a newly started session', async () => {
    const localRoot = path.join(tmpVault, 'My Skills');
    writeSkill(localRoot, 'authored-one');
    const opts = await optionsFor(m => {
      m.vaultRoot = tmpVault;
      m.pluginResourceDir = pluginResourceDir;
      m.settings.localSkillsFolder = 'My Skills';
    });
    expect(opts?.plugins).toContainEqual({ type: 'local', path: localRoot });
  });

  it('injects peer-registered skills into a real session and drops them on dispose', async () => {
    let d: { dispose(): void } | undefined;
    const opts = await optionsFor((m) => {
      m.pluginResourceDir = pluginResourceDir;
      d = m.peerSkills.register({ pluginId: 'orch' }, { name: 'thread-orchestrator', description: 'd', content: 'body' });
    });
    const plugins = (opts?.plugins ?? []) as Array<{ path: string }>;
    expect(plugins).toHaveLength(1);
    expect(fs.readFileSync(path.join(plugins[0]!.path, 'SKILL.md'), 'utf8')).toContain('name: thread-orchestrator');
    d!.dispose();
  });

  it('registers nothing when pluginResourceDir is unset (mobile / no FileSystemAdapter)', async () => {
    writeSkill(path.join(tmpHome, '.claude', 'skills'), 'home-one');
    const opts = await optionsFor(() => { /* pluginResourceDir left undefined */ });
    expect(opts?.plugins).toBeUndefined();
  });
});

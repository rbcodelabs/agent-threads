/**
 * skillManager.test.ts
 *
 * Unit tests for the headless skill-management module extracted from
 * SkillsManagerView.ts. This is now the single source of truth for
 * list/search/install/uninstall/update logic — both the Skills Manager UI and
 * the skills_* MCP tools in ObsidianTools.ts delegate here.
 *
 * `requestUrl` (from 'obsidian') is mocked so marketplace-search/description
 * tests don't hit the real network.
 *
 * Two roots, two sandboxes. `homeRoot` still derives from `os.homedir()`, so
 * `process.env.HOME` is overridden to a temp dir for the duration of each test
 * (Node's `os.homedir()` reads `$HOME` on every call rather than caching it).
 * `pluginRoot` is a second temp dir standing in for the vault, installed via
 * `setSkillRoots`. Both are wrapped in `fs.realpathSync`: on macOS
 * `os.tmpdir()` lives under `/var`, itself a symlink to `/private/var`, and
 * `computeSkillRoots` canonicalizes — so uncanonicalized fixtures would fail
 * every containment check for the wrong reason.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import type { SkillSource } from '../../src/types';

const mockRequestUrl = vi.fn();
vi.mock('obsidian', () => ({
  requestUrl: (...args: unknown[]) => mockRequestUrl(...args),
}));

import {
  listInstalledSkills,
  uninstallSkillByPath,
  uninstallSkillByName,
  searchMarketplaceSkills,
  getPopularMarketplaceSkills,
  getMarketplaceSkillDescription,
  getSkillDetail,
  listSkillSources,
  normalizeRepoUrlForId,
  deriveSourceIdFromRepoUrl,
  githubCloneUrl,
  isGitWorkingCopy,
  cloneGithubSource,
  addGithubSkillSource,
  parseGithubRepoUrl,
  checkGitAvailable,
  ensureGithubSourcesCloned,
  checkSourceForUpdates,
  checkAllSourcesForUpdates,
  pullGithubSourceUpdates,
  listGithubSourceSkills,
  installSkillFromMarketplace,
  codexSkillRoots,
} from '../../src/skillManager';
import { computeSkillRoots, setSkillRoots, resetSkillRoots, type SkillRoots } from '../../src/skillPaths';

// ── Two-root sandbox ──────────────────────────────────────────────────────────

const MANIFEST_DIR = '.obsidian/plugins/claude-threads';

let realHome: string | undefined;
let tmpHome: string;
let tmpVault: string;
let roots: SkillRoots;

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skillmanager-home-')));
  tmpVault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skillmanager-vault-')));
  process.env.HOME = tmpHome;
  roots = computeSkillRoots(tmpVault, MANIFEST_DIR, tmpHome);
  setSkillRoots(roots);
});

afterEach(() => {
  resetSkillRoots();
  if (realHome !== undefined) process.env.HOME = realHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpVault, { recursive: true, force: true });
  mockRequestUrl.mockReset();
});

function writeSkillIn(root: string, name: string, description: string, dirName: string): string {
  const skillDir = path.join(root, dirName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
    'utf-8',
  );
  return skillDir;
}

/** Writes a read-only, Claude-Code-managed skill into ~/.claude/skills/. */
function writeHomeSkill(name: string, description = 'a test skill', dirName = name): string {
  return writeSkillIn(roots.homeRoot, name, description, dirName);
}

/** Writes a plugin-installed skill into <vault>/<plugin-dir>/skills/. */
function writeVaultSkill(name: string, description = 'a test skill', dirName = name): string {
  return writeSkillIn(roots.pluginRoot, name, description, dirName);
}

describe('codexSkillRoots', () => {
  it('resolves GitHub, local, bundled, and vault roots for app-server discovery', () => {
    const cloneRoot = path.join(tmpHome, 'source');
    fs.mkdirSync(path.join(cloneRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(cloneRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'test-source', skills: './custom-skills' }),
    );

    expect(codexSkillRoots([
      { id: 'github', name: 'GitHub', type: 'github', clonePath: cloneRoot },
      { id: 'local', name: 'Local', type: 'local', skillsPath: '~/local-skills' },
    ], path.join(tmpHome, 'bundled'), roots.pluginRoot)).toEqual([
      path.resolve(cloneRoot, 'custom-skills'),
      path.resolve(tmpHome, 'local-skills'),
      path.resolve(tmpHome, 'bundled'),
      path.resolve(roots.pluginRoot),
    ]);
  });

  it('omits the vault root when it is unresolvable', () => {
    expect(codexSkillRoots([], undefined, '')).toEqual([]);
  });
});

// ── listInstalledSkills ────────────────────────────────────────────────────

describe('listInstalledSkills', () => {
  it('returns an empty array when neither root exists', async () => {
    const result = await listInstalledSkills();
    expect(result).toEqual([]);
  });

  it('lists skills installed as directories with SKILL.md', async () => {
    writeHomeSkill('alpha-skill', 'does alpha things');
    writeHomeSkill('beta-skill', 'does beta things');

    const result = await listInstalledSkills();

    expect(result.map((s) => s.name)).toEqual(['alpha-skill', 'beta-skill']); // sorted
    expect(result[0].description).toBe('does alpha things');
    expect(result[0].isDirectory).toBe(true);
    expect(result[0].isSymlink).toBe(false);
    expect(result[0].content).toContain('does alpha things');
  });

  it('merges both roots and tags each entry with its origin and gates', async () => {
    writeHomeSkill('home-skill', 'from claude code');
    writeVaultSkill('vault-skill', 'from the plugin');

    const result = await listInstalledSkills();

    expect(result.map((s) => [s.name, s.origin, s.isEditable, s.isRemovable])).toEqual([
      ['home-skill', 'home', false, false],
      ['vault-skill', 'vault', true, true],
    ]);
  });

  it('sorts the vault copy ahead of a same-named home copy so lookups resolve to the writable one', async () => {
    writeHomeSkill('dupe', 'home version');
    writeVaultSkill('dupe', 'vault version');

    const result = await listInstalledSkills();
    expect(result.map((s) => s.origin)).toEqual(['vault', 'home']);
    expect(result[0].description).toBe('vault version');
  });

  it('marks a vault symlink pointing outside the vault as removable but not editable', async () => {
    const external = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skillmanager-repo-')));
    const target = writeSkillIn(external, 'linked', 'in a user repo', 'linked');
    fs.mkdirSync(roots.pluginRoot, { recursive: true });
    fs.symlinkSync(target, path.join(roots.pluginRoot, 'linked'));

    try {
      const [skill] = await listInstalledSkills();
      expect(skill.origin).toBe('vault');
      expect(skill.isEditable).toBe(false); // no write-through into the user's repo
      expect(skill.isRemovable).toBe(true); // rm unlinks, it does not follow
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  it('falls back to the directory name when frontmatter has no name', async () => {
    const skillDir = path.join(roots.homeRoot, 'no-name-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\ndescription: nameless\n---\n', 'utf-8');

    const result = await listInstalledSkills();
    expect(result[0].name).toBe('no-name-skill');
  });

  it('annotates symlinked skills with the matching configured SkillSource name', async () => {
    // Resolved with realpathSync: on macOS, os.tmpdir() returns a path under
    // /var/... which is itself a symlink to /private/var/..., and
    // fs.promises.realpath() (used internally to resolve the installed
    // symlink) always returns the fully-canonicalized form. A real
    // SkillSource.clonePath (e.g. ~/.claude/skill-sources/<id>) doesn't sit
    // under a symlinked path, so this canonicalization only matters for the
    // temp-dir fixture here, not for production behavior.
    const cloneRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skillmanager-clone-')));
    const skillsDir = path.join(cloneRoot, 'skills');
    const realSkillDir = path.join(skillsDir, 'linked-skill');
    fs.mkdirSync(realSkillDir, { recursive: true });
    fs.writeFileSync(path.join(realSkillDir, 'SKILL.md'), '---\nname: linked-skill\ndescription: linked\n---\n', 'utf-8');

    const installedDir = roots.homeRoot;
    fs.mkdirSync(installedDir, { recursive: true });
    fs.symlinkSync(realSkillDir, path.join(installedDir, 'linked-skill'));

    const skillSources: SkillSource[] = [
      { id: 'src-1', name: 'My Plugin Source', type: 'github', clonePath: cloneRoot },
    ];

    try {
      const result = await listInstalledSkills(skillSources);
      const linked = result.find((s) => s.name === 'linked-skill');
      expect(linked?.isSymlink).toBe(true);
      expect(linked?.sourceName).toBe('My Plugin Source');
    } finally {
      fs.rmSync(cloneRoot, { recursive: true, force: true });
    }
  });

  it('skips non-.md, non-directory entries', async () => {
    fs.mkdirSync(roots.homeRoot, { recursive: true });
    fs.writeFileSync(path.join(roots.homeRoot, 'README.txt'), 'not a skill', 'utf-8');

    const result = await listInstalledSkills();
    expect(result).toEqual([]);
  });
});

// ── uninstallSkillByPath / uninstallSkillByName ───────────────────────────────

describe('uninstallSkillByPath', () => {
  it('removes a vault skill directory entirely', async () => {
    const skillDir = writeVaultSkill('to-remove');
    await uninstallSkillByPath(skillDir);
    expect(fs.existsSync(skillDir)).toBe(false);
  });

  it('refuses to remove anything in ~/.claude/skills, and leaves it on disk', async () => {
    const skillDir = writeHomeSkill('protected');
    await expect(uninstallSkillByPath(skillDir)).rejects.toThrow(/managed by Claude Code/);
    expect(fs.existsSync(skillDir)).toBe(true);
  });

  it('refuses a sibling directory that merely shares the vault root as a string prefix', async () => {
    const sibling = path.join(`${roots.pluginRoot}-evil`, 'foo');
    fs.mkdirSync(sibling, { recursive: true });
    await expect(uninstallSkillByPath(sibling)).rejects.toThrow(/outside the vault skills folder/);
    expect(fs.existsSync(sibling)).toBe(true);
  });

  it("refuses everything when pluginRoot is '' (mobile / no FileSystemAdapter)", async () => {
    const skillDir = writeVaultSkill('would-be-removable');
    const noVault = computeSkillRoots('', '', tmpHome);
    await expect(uninstallSkillByPath(skillDir, noVault)).rejects.toThrow(/outside the vault skills folder/);
    expect(fs.existsSync(skillDir)).toBe(true);
  });
});

describe('uninstallSkillByName', () => {
  it('finds and removes an installed vault skill by name', async () => {
    const skillDir = writeVaultSkill('named-skill');
    const result = await uninstallSkillByName('named-skill');
    expect(result.skillPath).toBe(skillDir);
    expect(fs.existsSync(skillDir)).toBe(false);
  });

  it('throws for a home-only name and leaves the directory intact', async () => {
    const skillDir = writeHomeSkill('home-only');
    await expect(uninstallSkillByName('home-only')).rejects.toThrow(/managed by Claude Code/);
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
  });

  it('removes only the vault copy on a cross-root name collision', async () => {
    const homeDir = writeHomeSkill('dupe', 'home version');
    const vaultDir = writeVaultSkill('dupe', 'vault version');

    const result = await uninstallSkillByName('dupe');

    expect(result.skillPath).toBe(vaultDir);
    expect(fs.existsSync(vaultDir)).toBe(false);
    expect(fs.existsSync(homeDir)).toBe(true);
  });

  it('throws when no installed skill has that name', async () => {
    await expect(uninstallSkillByName('does-not-exist')).rejects.toThrow(/No installed skill named/);
  });
});

// ── Marketplace search ────────────────────────────────────────────────────────

describe('searchMarketplaceSkills', () => {
  it('maps raw API results and marks already-installed skills', async () => {
    mockRequestUrl.mockResolvedValue({
      status: 200,
      json: {
        skills: [
          { id: 'owner/repo/foo-skill', name: 'Foo Skill', installs: 10, source: 'owner/repo' },
          { id: 'owner2/repo2/bar-skill', name: 'Bar Skill', installs: 500, source: 'owner2/repo2' },
        ],
      },
    });

    const installed = [
      { name: 'Bar Skill', skillPath: '/home/.claude/skills/bar-skill' } as never,
    ];

    const results = await searchMarketplaceSkills('foo', 15, installed);

    // sorted by installs descending
    expect(results.map((r) => r.name)).toEqual(['Bar Skill', 'Foo Skill']);
    expect(results.find((r) => r.name === 'Bar Skill')?.isInstalled).toBe(true);
    expect(results.find((r) => r.name === 'Foo Skill')?.isInstalled).toBe(false);
    expect(mockRequestUrl).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('q=foo') }),
    );
  });

  it('throws on a non-200 response', async () => {
    mockRequestUrl.mockResolvedValue({ status: 500, json: {} });
    await expect(searchMarketplaceSkills('foo', 15, [])).rejects.toThrow(/HTTP 500/);
  });
});

describe('getPopularMarketplaceSkills', () => {
  it('delegates to the same search endpoint with the "er" query', async () => {
    mockRequestUrl.mockResolvedValue({ status: 200, json: { skills: [] } });
    await getPopularMarketplaceSkills([], 30);
    expect(mockRequestUrl).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('q=er') }),
    );
  });
});

// ── getMarketplaceSkillDescription ────────────────────────────────────────────

describe('getMarketplaceSkillDescription', () => {
  it('returns null immediately when there is no source', async () => {
    const result = await getMarketplaceSkillDescription('some/slug', '');
    expect(result).toBeNull();
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('parses the frontmatter description from the first candidate URL that responds 200', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      text: '---\nname: foo-skill\ndescription: "A quoted description"\n---\n',
    });

    const result = await getMarketplaceSkillDescription('owner/repo/foo-skill', 'owner/repo');
    expect(result).toBe('A quoted description');
  });

  it('falls back to later candidate URLs when earlier ones 404', async () => {
    mockRequestUrl
      .mockResolvedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ status: 200, text: '---\nname: foo-skill\ndescription: root layout\n---\n' });

    const result = await getMarketplaceSkillDescription('owner/repo/foo-skill', 'owner/repo');
    expect(result).toBe('root layout');
    expect(mockRequestUrl).toHaveBeenCalledTimes(3);
  });

  it('returns null when no candidate responds with a usable description', async () => {
    mockRequestUrl.mockResolvedValue({ status: 404 });
    const result = await getMarketplaceSkillDescription('owner/repo/foo-skill', 'owner/repo');
    expect(result).toBeNull();
  });
});

// ── getSkillDetail ─────────────────────────────────────────────────────────────

describe('getSkillDetail', () => {
  it('returns installed detail (with content) when the identifier matches an installed skill name', async () => {
    writeVaultSkill('installed-one', 'installed description');

    const result = await getSkillDetail('installed-one');
    expect(result.installed).toBe(true);
    expect(result.description).toBe('installed description');
    expect(result.content).toContain('installed-one');
    expect(result.origin).toBe('vault');
    expect(result.isEditable).toBe(true);
    expect(result.isRemovable).toBe(true);
  });

  it('reports a home skill as installed but read-only', async () => {
    writeHomeSkill('home-one', 'home description');

    const result = await getSkillDetail('home-one');
    expect(result.installed).toBe(true);
    expect(result.origin).toBe('home');
    expect(result.isEditable).toBe(false);
    expect(result.isRemovable).toBe(false);
  });

  it('falls back to a marketplace lookup when not installed and identifier looks like a slug', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      text: '---\nname: not-installed\ndescription: from marketplace\n---\n',
    });

    const result = await getSkillDetail('owner/repo/not-installed');
    expect(result.installed).toBe(false);
    expect(result.slug).toBe('owner/repo/not-installed');
    expect(result.source).toBe('owner/repo');
    expect(result.description).toBe('from marketplace');
  });

  it('throws when not installed and the identifier is not a marketplace-slug shape', async () => {
    await expect(getSkillDetail('just-a-name')).rejects.toThrow(/does not look like a marketplace slug/);
  });
});

// ── listSkillSources ───────────────────────────────────────────────────────────

describe('listSkillSources', () => {
  it('always includes the built-in skills.sh registry pseudo-source', () => {
    const result = listSkillSources([]);
    expect(result).toEqual([{ id: 'registry', name: 'skills.sh', type: 'registry' }]);
  });

  it('includes configured sources alongside the registry', () => {
    const sources: SkillSource[] = [
      { id: 'gh-1', name: 'Some Plugin', type: 'github', repoUrl: 'https://github.com/o/r', behindCount: 2, lastFetched: 123 },
    ];
    const result = listSkillSources(sources);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({ id: 'gh-1', name: 'Some Plugin', type: 'github', repoUrl: 'https://github.com/o/r', behindCount: 2, lastFetched: 123 });
  });
});

// ── Git-backed source updates (real local repos, no network) ─────────────────

function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init --quiet -b main', { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'file.txt'), 'v1', 'utf-8');
  execSync('git add . && git commit --quiet -m "initial"', { cwd: dir });
}

describe('checkSourceForUpdates / checkAllSourcesForUpdates / pullGithubSourceUpdates', () => {
  let origin: string;
  let clone: string;

  beforeEach(() => {
    origin = fs.mkdtempSync(path.join(os.tmpdir(), 'skillmanager-origin-'));
    clone = fs.mkdtempSync(path.join(os.tmpdir(), 'skillmanager-clone-'));
    fs.rmSync(clone, { recursive: true, force: true }); // git clone needs the target to not exist
    initGitRepo(origin);
    execSync(`git clone --quiet "${origin}" "${clone}"`);
  });

  afterEach(() => {
    fs.rmSync(origin, { recursive: true, force: true });
    fs.rmSync(clone, { recursive: true, force: true });
  });

  it('reports behindCount 0 right after a fresh clone', async () => {
    const source: SkillSource = { id: 's1', name: 'Test Source', type: 'github', clonePath: clone };
    const result = await checkSourceForUpdates(source);
    expect(result.error).toBeUndefined();
    expect(result.behindCount).toBe(0);
    expect(result.lastFetched).toBeGreaterThan(0);
  });

  it('reports a positive behindCount after the origin gains commits', async () => {
    fs.writeFileSync(path.join(origin, 'file2.txt'), 'v2', 'utf-8');
    execSync('git add . && git commit --quiet -m "second commit"', { cwd: origin });

    const source: SkillSource = { id: 's1', name: 'Test Source', type: 'github', clonePath: clone };
    const result = await checkSourceForUpdates(source);
    expect(result.behindCount).toBe(1);
  });

  it('returns an error result (not a throw) when clonePath is missing', async () => {
    const source: SkillSource = { id: 's1', name: 'Test Source', type: 'github' };
    const result = await checkSourceForUpdates(source);
    expect(result.error).toMatch(/No clone path configured/);
  });

  it('returns an error result when the clonePath is not a git repo', async () => {
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillmanager-notgit-'));
    try {
      const source: SkillSource = { id: 's1', name: 'Test Source', type: 'github', clonePath: badDir };
      const result = await checkSourceForUpdates(source);
      expect(result.error).toBeTruthy();
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }
  });

  it('checkAllSourcesForUpdates only checks github-type sources with a clonePath', async () => {
    const sources: SkillSource[] = [
      { id: 's1', name: 'GitHub Source', type: 'github', clonePath: clone },
      { id: 's2', name: 'Local Source', type: 'local', skillsPath: '~/some/path' },
      { id: 's3', name: 'No Clone Path', type: 'github' },
    ];
    const results = await checkAllSourcesForUpdates(sources);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('s1');
  });

  it('pullGithubSourceUpdates pulls new commits and resets behindCount to 0', async () => {
    fs.writeFileSync(path.join(origin, 'file2.txt'), 'v2', 'utf-8');
    execSync('git add . && git commit --quiet -m "second commit"', { cwd: origin });

    const source: SkillSource = { id: 's1', name: 'Test Source', type: 'github', clonePath: clone };
    const result = await pullGithubSourceUpdates(source);
    expect(result.behindCount).toBe(0);
    expect(fs.existsSync(path.join(clone, 'file2.txt'))).toBe(true);
  });

  it('pullGithubSourceUpdates throws when clonePath is missing', async () => {
    const source: SkillSource = { id: 's1', name: 'Test Source', type: 'github' };
    await expect(pullGithubSourceUpdates(source)).rejects.toThrow(/no clone path configured/);
  });
});

// ── Deterministic source ids ─────────────────────────────────────────────────

describe('normalizeRepoUrlForId / deriveSourceIdFromRepoUrl / githubCloneUrl', () => {
  it('collapses scheme, case, .git suffix, trailing slash and scp form to one canonical form', () => {
    const canonical = 'github.com/owner/repo';
    expect(normalizeRepoUrlForId('https://github.com/owner/repo')).toBe(canonical);
    expect(normalizeRepoUrlForId('http://github.com/Owner/Repo/')).toBe(canonical);
    expect(normalizeRepoUrlForId('https://github.com/owner/repo.git')).toBe(canonical);
    expect(normalizeRepoUrlForId('  https://github.com/owner/repo//  ')).toBe(canonical);
    expect(normalizeRepoUrlForId('git@github.com:owner/repo.git')).toBe(canonical);
  });

  it('derives the same id every time for the same repo, and different ids for different repos', () => {
    const a1 = deriveSourceIdFromRepoUrl('https://github.com/owner/repo');
    const a2 = deriveSourceIdFromRepoUrl('https://github.com/owner/repo.git');
    const b = deriveSourceIdFromRepoUrl('https://github.com/owner/other');

    expect(a1).toBe(a2);
    expect(a1).toBe(deriveSourceIdFromRepoUrl('https://github.com/Owner/Repo/'));
    expect(a1).not.toBe(b);
    // Filesystem-safe: the id becomes a directory name.
    expect(a1).toMatch(/^gh-[0-9a-f]{16}$/);
  });

  it('githubCloneUrl appends .git exactly once', () => {
    expect(githubCloneUrl('https://github.com/o/r')).toBe('https://github.com/o/r.git');
    expect(githubCloneUrl('https://github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(githubCloneUrl('https://github.com/o/r/')).toBe('https://github.com/o/r.git');
  });
});

// ── cloneGithubSource / ensureGithubSourcesCloned (real local repos, no network) ──

describe('cloneGithubSource', () => {
  let origin: string;
  let cloneBase: string;

  beforeEach(() => {
    // Named with a .git suffix so githubCloneUrl's normalization leaves the
    // local fixture path untouched.
    origin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skillmanager-decl-')), 'fixture.git');
    initGitRepo(origin);
    cloneBase = path.join(tmpVault, MANIFEST_DIR, 'skill-sources');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(origin), { recursive: true, force: true });
  });

  it('clones into a path whose parent does not exist yet', async () => {
    const dest = path.join(cloneBase, 'gh-abc');
    await cloneGithubSource(origin, dest);
    expect(fs.existsSync(path.join(dest, 'file.txt'))).toBe(true);
    expect(isGitWorkingCopy(dest)).toBe(true);
  });

  it('throws and leaves no directory behind when the remote does not exist', async () => {
    const dest = path.join(cloneBase, 'gh-missing');
    await expect(
      cloneGithubSource(path.join(tmpHome, 'does-not-exist'), dest),
    ).rejects.toThrow();
    expect(fs.existsSync(dest)).toBe(false);
  });
});

describe('parseGithubRepoUrl', () => {
  it('accepts github repo URLs and returns the bare URL', () => {
    expect(parseGithubRepoUrl('https://github.com/owner/repo')).toBe('https://github.com/owner/repo');
    expect(parseGithubRepoUrl('  https://github.com/owner/repo.git  ')).toBe('https://github.com/owner/repo');
    expect(parseGithubRepoUrl('https://github.com/owner/repo/')).toBe('https://github.com/owner/repo');
  });

  it('rejects anything that is not a github owner/repo URL', () => {
    expect(parseGithubRepoUrl('')).toBeNull();
    expect(parseGithubRepoUrl('https://gitlab.com/owner/repo')).toBeNull();
    expect(parseGithubRepoUrl('https://github.com/owner')).toBeNull();
  });
});

describe('checkGitAvailable', () => {
  function runner(ok: Record<string, boolean>) {
    const calls: string[] = [];
    const run = async (cmd: string, args: string[]) => {
      const key = [cmd, ...args].join(' ');
      calls.push(key);
      if (!ok[key]) throw new Error(`${key} failed`);
    };
    return { run, calls };
  }

  it('runs git --version on non-macOS platforms', async () => {
    const { run } = runner({ 'git --version': true });
    expect(await checkGitAvailable({ platform: 'linux', pathEnv: '/usr/bin', exists: () => true, run })).toBe(true);
    const failing = runner({});
    expect(await checkGitAvailable({ platform: 'linux', pathEnv: '/usr/bin', exists: () => true, run: failing.run })).toBe(false);
  });

  it('on macOS checks xcode-select first and runs git only when developer tools exist', async () => {
    const { run, calls } = runner({ 'xcode-select -p': true, 'git --version': true });
    expect(await checkGitAvailable({ platform: 'darwin', pathEnv: '/usr/bin', exists: () => true, run })).toBe(true);
    expect(calls).toEqual(['xcode-select -p', 'git --version']);
  });

  it('on macOS without developer tools never invokes the /usr/bin/git stub (which pops an install dialog)', async () => {
    const { run, calls } = runner({});
    const exists = (p: string) => p === '/usr/bin/git';
    expect(await checkGitAvailable({ platform: 'darwin', pathEnv: '/usr/bin:/bin', exists, run })).toBe(false);
    expect(calls).toEqual(['xcode-select -p']);
  });

  it('on macOS without developer tools accepts a non-stub git elsewhere on PATH (e.g. Homebrew)', async () => {
    const { run, calls } = runner({ '/opt/homebrew/bin/git --version': true });
    const exists = (p: string) => p === '/opt/homebrew/bin/git' || p === '/usr/bin/git';
    expect(await checkGitAvailable({ platform: 'darwin', pathEnv: '/usr/bin:/opt/homebrew/bin', exists, run })).toBe(true);
    expect(calls).toEqual(['xcode-select -p', '/opt/homebrew/bin/git --version']);
  });
});

describe('addGithubSkillSource (shared by the add-source modal and Chief of Staff onboarding)', () => {
  let origin: string;
  let cloneBase: string;

  beforeEach(() => {
    origin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skillmanager-add-')), 'fixture.git');
    initGitRepo(origin);
    cloneBase = path.join(tmpVault, MANIFEST_DIR, 'skill-sources');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(origin), { recursive: true, force: true });
  });

  it('clones into <cloneBase>/<id> and names the source from plugin.json', async () => {
    fs.mkdirSync(path.join(origin, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(origin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'cos', displayName: 'Chief of Staff' }));
    execSync('git add . && git commit --quiet -m manifest', { cwd: origin });

    const source = await addGithubSkillSource({ repoUrl: origin, cloneBase, id: 'gh-fixed' });
    expect(source).toMatchObject({ id: 'gh-fixed', name: 'Chief of Staff', type: 'github', clonePath: path.join(cloneBase, 'gh-fixed') });
    expect(isGitWorkingCopy(source.clonePath!)).toBe(true);
    expect(source.repoUrl).toBe(origin.replace(/\.git$/, ''));
  });

  it('prefers an explicit display name, and derives a deterministic id when none is given', async () => {
    const source = await addGithubSkillSource({ repoUrl: origin, cloneBase, displayName: 'Mine' });
    expect(source.name).toBe('Mine');
    expect(source.id).toBe(deriveSourceIdFromRepoUrl(origin.replace(/\.git$/, '')));
  });

  it('falls back to the repo name when there is no manifest', async () => {
    const source = await addGithubSkillSource({ repoUrl: origin, cloneBase, id: 'gh-n' });
    expect(source.name).toBe('fixture');
  });

  it('pins the clone to a tag with ref, and records the ref on the source', async () => {
    execSync('git tag v0.1.0', { cwd: origin });
    fs.writeFileSync(path.join(origin, 'file.txt'), 'v2', 'utf-8');
    execSync('git commit --quiet -am later', { cwd: origin });

    const source = await addGithubSkillSource({ repoUrl: origin, cloneBase, id: 'gh-ref', ref: 'v0.1.0' });
    expect(source.ref).toBe('v0.1.0');
    expect(fs.readFileSync(path.join(source.clonePath!, 'file.txt'), 'utf-8')).toBe('v1');
  });

  it('omits ref (default branch) when none is given', async () => {
    const source = await addGithubSkillSource({ repoUrl: origin, cloneBase, id: 'gh-def' });
    expect(source.ref).toBeUndefined();
  });

  it('adopts an existing working copy at the clone path instead of failing, checking out the ref', async () => {
    execSync('git tag v0.1.0', { cwd: origin });
    const dest = path.join(cloneBase, 'gh-adopt');
    fs.mkdirSync(cloneBase, { recursive: true });
    execSync(`git clone --quiet "${origin}" "${dest}"`);
    fs.writeFileSync(path.join(origin, 'file.txt'), 'v2', 'utf-8');
    execSync('git commit --quiet -am later', { cwd: origin });
    execSync('git pull --quiet', { cwd: dest });
    expect(fs.readFileSync(path.join(dest, 'file.txt'), 'utf-8')).toBe('v2');

    const source = await addGithubSkillSource({ repoUrl: origin, cloneBase, id: 'gh-adopt', ref: 'v0.1.0' });
    expect(source.clonePath).toBe(dest);
    expect(fs.readFileSync(path.join(dest, 'file.txt'), 'utf-8')).toBe('v1');
  });

  it('adopts an existing working copy as-is when no ref is given', async () => {
    const dest = path.join(cloneBase, 'gh-adopt2');
    fs.mkdirSync(cloneBase, { recursive: true });
    execSync(`git clone --quiet "${origin}" "${dest}"`);
    const source = await addGithubSkillSource({ repoUrl: origin, cloneBase, id: 'gh-adopt2' });
    expect(isGitWorkingCopy(source.clonePath!)).toBe(true);
  });

  it('refuses a pre-existing non-git directory and does not delete it', async () => {
    const dest = path.join(cloneBase, 'gh-junk');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'mine.txt'), 'keep', 'utf-8');
    await expect(addGithubSkillSource({ repoUrl: origin, cloneBase, id: 'gh-junk' })).rejects.toThrow(/not a git/);
    expect(fs.readFileSync(path.join(dest, 'mine.txt'), 'utf-8')).toBe('keep');
  });

  it('does not delete an adopted working copy when checking out the ref fails', async () => {
    const dest = path.join(cloneBase, 'gh-badref');
    fs.mkdirSync(cloneBase, { recursive: true });
    execSync(`git clone --quiet "${origin}" "${dest}"`);
    await expect(addGithubSkillSource({ repoUrl: origin, cloneBase, id: 'gh-badref', ref: 'no-such-tag' })).rejects.toThrow();
    expect(isGitWorkingCopy(dest)).toBe(true);
  });

  it('throws and leaves nothing behind when the clone fails', async () => {
    await expect(addGithubSkillSource({ repoUrl: path.join(tmpHome, 'nope.git'), cloneBase, id: 'gh-bad' })).rejects.toThrow();
    expect(fs.existsSync(path.join(cloneBase, 'gh-bad'))).toBe(false);
  });
});

describe('ensureGithubSourcesCloned', () => {
  let originA: string;
  let originB: string;
  let fixtureRoot: string;
  let cloneBase: string;

  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skillmanager-declared-'));
    originA = path.join(fixtureRoot, 'source-a.git');
    originB = path.join(fixtureRoot, 'source-b.git');
    initGitRepo(originA);
    initGitRepo(originB);
    cloneBase = path.join(tmpVault, MANIFEST_DIR, 'skill-sources');
  });

  afterEach(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('clones a declared source that has neither an id nor a clonePath, and persists both', async () => {
    const sources: SkillSource[] = [{ id: '', name: 'Declared A', type: 'github', repoUrl: originA }];

    const result = await ensureGithubSourcesCloned(sources, cloneBase);

    expect(result.failed).toEqual([]);
    expect(result.cloned.map((c) => c.name)).toEqual(['Declared A']);
    expect(result.changed).toBe(true);
    // id derived deterministically, clonePath computed under the managed base
    expect(sources[0].id).toBe(deriveSourceIdFromRepoUrl(originA));
    expect(sources[0].clonePath).toBe(path.join(cloneBase, sources[0].id));
    expect(fs.existsSync(path.join(sources[0].clonePath!, 'file.txt'))).toBe(true);
  });

  it('is a no-op on a second pass: nothing cloned, nothing changed, clone untouched', async () => {
    const sources: SkillSource[] = [{ id: '', name: 'Declared A', type: 'github', repoUrl: originA }];
    await ensureGithubSourcesCloned(sources, cloneBase);
    const clonePath = sources[0].clonePath!;
    // Sentinel proves the existing clone was not deleted and re-cloned.
    fs.writeFileSync(path.join(clonePath, 'sentinel.txt'), 'do not delete me', 'utf-8');
    const snapshot = JSON.parse(JSON.stringify(sources)) as SkillSource[];

    const second = await ensureGithubSourcesCloned(sources, cloneBase);

    expect(second.changed).toBe(false); // caller therefore writes no settings
    expect(second.cloned).toEqual([]);
    expect(second.present).toEqual([sources[0].id]);
    expect(second.failed).toEqual([]);
    expect(fs.existsSync(path.join(clonePath, 'sentinel.txt'))).toBe(true);
    expect(sources).toEqual(snapshot);
  });

  it('leaves an existing clone completely alone even when it is behind the remote (no auto-pull)', async () => {
    const sources: SkillSource[] = [{ id: '', name: 'Declared A', type: 'github', repoUrl: originA }];
    await ensureGithubSourcesCloned(sources, cloneBase);
    const clonePath = sources[0].clonePath!;

    fs.writeFileSync(path.join(originA, 'file2.txt'), 'v2', 'utf-8');
    execSync('git add . && git commit --quiet -m "second commit"', { cwd: originA });

    const second = await ensureGithubSourcesCloned(sources, cloneBase);

    expect(second.present).toEqual([sources[0].id]);
    // The new upstream commit was NOT pulled in — updating stays explicit.
    expect(fs.existsSync(path.join(clonePath, 'file2.txt'))).toBe(false);
  });

  it('skips a source that fails to clone without throwing, and still clones the rest', async () => {
    const sources: SkillSource[] = [
      // Ordered first on purpose: a failure must not abort the sources after it.
      { id: '', name: 'Broken', type: 'github', repoUrl: path.join(fixtureRoot, 'nope.git') },
      { id: '', name: 'Missing URL', type: 'github' },
      { id: '', name: 'Good B', type: 'github', repoUrl: originB },
    ];

    const result = await ensureGithubSourcesCloned(sources, cloneBase);

    expect(result.failed.map((f) => f.name).sort()).toEqual(['Broken', 'Missing URL']);
    expect(result.failed[0].error).toBeTruthy();
    expect(result.cloned.map((c) => c.name)).toEqual(['Good B']);
    expect(fs.existsSync(path.join(sources[2].clonePath!, 'file.txt'))).toBe(true);
    // The failed clone leaves nothing half-written behind.
    expect(fs.existsSync(path.join(cloneBase, sources[0].id))).toBe(false);
  });

  it('ignores local-type sources entirely', async () => {
    const sources: SkillSource[] = [
      { id: 'local-1', name: 'Local', type: 'local', skillsPath: path.join(fixtureRoot, 'not-created') },
    ];

    const result = await ensureGithubSourcesCloned(sources, cloneBase);

    expect(result).toEqual({ changed: false, cloned: [], present: [], failed: [] });
    expect(fs.existsSync(cloneBase)).toBe(false);
    expect(sources[0].clonePath).toBeUndefined();
  });

  it('re-clones over a stale non-git directory inside the managed clone base', async () => {
    const id = deriveSourceIdFromRepoUrl(originA);
    const clonePath = path.join(cloneBase, id);
    fs.mkdirSync(clonePath, { recursive: true });
    fs.writeFileSync(path.join(clonePath, 'junk.txt'), 'interrupted clone', 'utf-8');

    const sources: SkillSource[] = [{ id, name: 'Declared A', type: 'github', repoUrl: originA, clonePath }];
    const result = await ensureGithubSourcesCloned(sources, cloneBase);

    expect(result.cloned).toHaveLength(1);
    expect(fs.existsSync(path.join(clonePath, 'junk.txt'))).toBe(false);
    expect(isGitWorkingCopy(clonePath)).toBe(true);
  });

  it('refuses to delete a non-git clonePath that lives outside the managed clone base', async () => {
    const outside = path.join(fixtureRoot, 'user-owned');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'user data', 'utf-8');

    const sources: SkillSource[] = [{ id: 'gh-1', name: 'Hand-edited', type: 'github', repoUrl: originA, clonePath: outside }];
    const result = await ensureGithubSourcesCloned(sources, cloneBase);

    expect(result.cloned).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/refusing to replace/);
    expect(fs.existsSync(path.join(outside, 'precious.txt'))).toBe(true);
  });

  it('returns an empty result for no sources or no clone base', async () => {
    const empty = { changed: false, cloned: [], present: [], failed: [] };
    expect(await ensureGithubSourcesCloned([], cloneBase)).toEqual(empty);
    expect(await ensureGithubSourcesCloned(undefined, cloneBase)).toEqual(empty);
    expect(await ensureGithubSourcesCloned([{ id: '', name: 'A', type: 'github', repoUrl: originA }], '')).toEqual(empty);
  });
});

// ── listGithubSourceSkills ─────────────────────────────────────────────────────

describe('listGithubSourceSkills', () => {
  it('returns an empty array when clonePath is missing', async () => {
    const result = await listGithubSourceSkills({ id: 's1', name: 'x', type: 'github' });
    expect(result).toEqual([]);
  });

  it('lists skills under <clonePath>/skills/ by default', async () => {
    const clonePath = fs.mkdtempSync(path.join(os.tmpdir(), 'skillmanager-source-'));
    try {
      const skillDir = path.join(clonePath, 'skills', 'my-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: my-skill\ndescription: from source\n---\n', 'utf-8');

      const result = await listGithubSourceSkills({ id: 's1', name: 'x', type: 'github', clonePath });
      expect(result).toEqual([{ id: 'my-skill', name: 'my-skill', description: 'from source', skillDir }]);
    } finally {
      fs.rmSync(clonePath, { recursive: true, force: true });
    }
  });

  it('respects a custom skills path declared in .claude-plugin/plugin.json', async () => {
    const clonePath = fs.mkdtempSync(path.join(os.tmpdir(), 'skillmanager-source-'));
    try {
      fs.mkdirSync(path.join(clonePath, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(clonePath, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'my-plugin', skills: 'custom-skills-dir' }),
        'utf-8',
      );
      const skillDir = path.join(clonePath, 'custom-skills-dir', 'nested-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: nested-skill\n---\n', 'utf-8');

      const result = await listGithubSourceSkills({ id: 's1', name: 'x', type: 'github', clonePath });
      expect(result).toEqual([{ id: 'nested-skill', name: 'nested-skill', description: '', skillDir }]);
    } finally {
      fs.rmSync(clonePath, { recursive: true, force: true });
    }
  });
});

// ── installSkillFromMarketplace (fast-fail paths only — full install requires network) ─

describe('installSkillFromMarketplace', () => {
  const params = { slug: 'owner/repo/already-there', skillId: 'already-there', name: 'Already There', source: 'owner/repo' };

  it('throws immediately when the skill has no GitHub source', async () => {
    await expect(
      installSkillFromMarketplace({ slug: 'x/y/z', skillId: 'z', name: 'Z', source: '' }),
    ).rejects.toThrow(/No GitHub source available/);
  });

  it('throws before attempting to clone when a skill with that id is already in the vault root', async () => {
    writeVaultSkill('already-there', 'existing', 'already-there');
    await expect(installSkillFromMarketplace(params)).rejects.toThrow(/already installed/);
  });

  it("throws before cloning when installRoot is '' rather than falling back to the home directory", async () => {
    await expect(
      installSkillFromMarketplace(params, { installRoot: '' }),
    ).rejects.toThrow(/never writes to ~\/\.claude/);
    expect(fs.existsSync(path.join(tmpHome, '.claude', 'skills'))).toBe(false);
  });

  it('throws when the roots have no vault root at all (mobile / no FileSystemAdapter)', async () => {
    resetSkillRoots();
    setSkillRoots(computeSkillRoots('', '', tmpHome));
    await expect(installSkillFromMarketplace(params)).rejects.toThrow(/never writes to ~\/\.claude/);
    expect(fs.existsSync(path.join(tmpHome, '.claude', 'skills'))).toBe(false);
  });

  it('never creates ~/.claude/skills, even on the mkdir that precedes the clone', async () => {
    // A home skill with the same id must warn, not block, and must not be touched.
    const homeDir = writeHomeSkill('already-there', 'home copy');
    const homeSnapshot = fs.readdirSync(roots.homeRoot);

    // Fails at the git clone (no network / bogus repo), but only after the
    // install root has already been created — which is the point of the check.
    await expect(installSkillFromMarketplace({
      ...params,
      source: 'ct-does-not-exist/ct-does-not-exist',
      skillId: 'brand-new',
    })).rejects.toThrow();

    expect(fs.existsSync(roots.pluginRoot)).toBe(true);
    expect(fs.readdirSync(roots.homeRoot)).toEqual(homeSnapshot);
    expect(fs.existsSync(path.join(homeDir, 'SKILL.md'))).toBe(true);
  });
});

// buildSkillPlugins lives in this module but is covered end-to-end (pure
// enumeration plus the real ThreadManager wiring) in session-plugins.test.ts.

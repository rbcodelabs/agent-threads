/**
 * Headless skill-management module: list/search/install/uninstall/update logic
 * for installed skills and configured SkillSources.
 *
 * This is the single source of truth for skill management — both
 * `SkillsManagerView.ts` (the UI) and the `skills_*` MCP tools in
 * `ObsidianTools.ts` delegate here. Zero DOM/UI dependencies: no
 * `ItemView`/`containerEl`, no `Notice`, no rendering. Callers own presentation
 * (Notices, re-renders, progress UI) and persistence of `SkillSource[]` mutations.
 *
 * Write policy: everything this module creates or deletes lives under
 * `SkillRoots.pluginRoot` (`<vault>/<plugin-dir>/skills`). `~/.claude/skills`
 * and `~/.claude/agents` are listed so the UI can show what the Claude CLI
 * loads, but are never written to. See `skillPaths.ts`.
 */
import { requestUrl } from 'obsidian';
import fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile, execSync } from 'child_process';
import { createHash } from 'crypto';
import type { SkillSource } from './types';
import { getSkillsDirForSource, readPluginManifest } from './claudeSettings';
import {
  type SkillRoots,
  getSkillRoots,
  requirePluginRoot,
  canEditSkill,
  canRemoveSkill,
  enumerateSkillDirs,
  ensureVaultSkillsPluginManifest,
  expandHome,
  isInsideRoot,
  isCurrentLocalRoot,
} from './skillPaths';

/** Resolve configured sources to roots containing Codex skill directories. */
export function codexSkillRoots(
  skillSources: SkillSource[] = [],
  bundledSkillsRoot?: string,
  pluginSkillsRoot?: string,
  localSkillsRoot?: string,
): string[] {
  const roots: string[] = [];
  for (const source of skillSources) {
    if (source.type === 'github' && source.clonePath) {
      roots.push(getSkillsDirForSource(source.clonePath));
    } else if (source.type === 'local' && source.skillsPath) {
      roots.push(expandHome(source.skillsPath, os.homedir()));
    }
  }
  if (bundledSkillsRoot) roots.push(bundledSkillsRoot);
  if (pluginSkillsRoot) roots.push(pluginSkillsRoot);
  if (localSkillsRoot) roots.push(localSkillsRoot);
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

/**
 * Builds the `opts.plugins` list handed to the Claude Agent SDK.
 *
 * Two different registration shapes, deliberately:
 *
 * - **GitHub / local sources** register one `{type:'local'}` per skill
 *   directory, which the SDK names `<skill>:<skill>`. Ugly, but it is what
 *   Rick's existing ~40 slash commands already read as; changing it is a
 *   separate decision and a separate PR.
 * - **The vault skills root** registers ONCE, as a plugin root holding a
 *   generated `.claude-plugin/plugin.json` plus the `skills/` subdir, which
 *   the SDK names `vault:<skill>`. Verified against the real `claude` CLI:
 *   the root form works and produces strictly better names than per-skill
 *   registration.
 */
export function buildSkillPlugins(options: {
  localSkillsRoot?: string;
  skillSources?: SkillSource[];
  /** `<vault>/<plugin-dir>/skills`, or '' when unresolvable. */
  pluginSkillsRoot?: string;
  /** Absolute path to the bundled thread-orchestrator skill directory. */
  bundledSkillPath?: string;
  fsModule?: typeof import('fs');
}): Array<{ type: 'local'; path: string }> {
  const fsModule = options.fsModule ?? fs;
  const plugins: Array<{ type: 'local'; path: string }> = [];

  for (const src of options.skillSources ?? []) {
    let skillsDir: string;
    if (src.type === 'github' && src.clonePath) {
      skillsDir = getSkillsDirForSource(src.clonePath);
    } else if (src.type === 'local' && src.skillsPath) {
      skillsDir = expandHome(src.skillsPath, os.homedir());
    } else {
      continue;
    }
    for (const dir of enumerateSkillDirs(skillsDir, fsModule)) {
      plugins.push({ type: 'local', path: dir });
    }
  }

  // Vault-installed skills, registered as a single plugin so they share one
  // prefix. Skipped entirely when the root holds no skills, so the generated
  // manifest is never written for users who have installed nothing.
  if (options.pluginSkillsRoot && enumerateSkillDirs(options.pluginSkillsRoot, fsModule).length > 0) {
    const vaultPluginRoot = ensureVaultSkillsPluginManifest(options.pluginSkillsRoot, fsModule);
    if (vaultPluginRoot) plugins.push({ type: 'local', path: vaultPluginRoot });
  }

  // Bundled thread-orchestrator skill — ships inside the plugin's own dist/
  if (options.localSkillsRoot && enumerateSkillDirs(options.localSkillsRoot, fsModule).length > 0) {
    const root = options.localSkillsRoot;
    const manifestDir = path.join(root, '.claude-plugin');
    const manifestPath = path.join(manifestDir, 'plugin.json');
    for (const candidate of [root, manifestDir, manifestPath]) {
      try {
        if (fsModule.lstatSync(candidate).isSymbolicLink()) throw new Error('Local skills manifest cannot use a symlink');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    fsModule.mkdirSync(manifestDir, { recursive: true });
    const expected = { name: 'local', version: '1.0.0', skills: './' };
    if (fsModule.existsSync(manifestPath)) {
      if (JSON.stringify(JSON.parse(fsModule.readFileSync(manifestPath, 'utf8'))) !== JSON.stringify(expected)) {
        throw new Error('Local skills folder already contains a different plugin manifest; choose a dedicated folder');
      }
    } else fsModule.writeFileSync(manifestPath, JSON.stringify(expected) + '\n', { encoding: 'utf8', flag: 'wx' });
    plugins.push({ type: 'local', path: root });
  }

  // (copied there by esbuild.config.mjs from resources/skills/), so it is
  // discoverable in every session with nothing copied into ~/.claude/skills/.
  if (options.bundledSkillPath) {
    try {
      if (fsModule.existsSync(path.join(options.bundledSkillPath, 'SKILL.md'))) {
        plugins.push({ type: 'local', path: options.bundledSkillPath });
      }
    } catch { /* bundled skill missing — plugin dist may be stale, skip silently */ }
  }

  return plugins;
}

// ── Frontmatter parsing ───────────────────────────────────────────────────────

/** Parses `name`/`description` out of a SKILL.md's YAML frontmatter block. */
export function parseFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: '', description: '' };
  const fm = match[1];

  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const name = nameMatch?.[1]?.trim() ?? '';

  // Parse description, handling YAML block scalar indicators (>- >  |- |)
  const descLineMatch = fm.match(/^description:(.*)$/m);
  if (!descLineMatch) return { name, description: '' };

  const afterColon = descLineMatch[1].trim();

  // Block scalar: value on the key line is just the indicator (> >- | |-), content follows on indented lines
  if (/^[>|]-?$/.test(afterColon)) {
    const isFolded = afterColon.startsWith('>');
    const fmLines = fm.split(/\r?\n/);
    const keyLineIndex = fmLines.findIndex((l) => /^description:/.test(l));
    const bodyLines: string[] = [];
    for (let i = keyLineIndex + 1; i < fmLines.length; i++) {
      const line = fmLines[i];
      // Indented lines (at least one space) or blank lines belong to the block
      if (line === '' || /^\s/.test(line)) {
        bodyLines.push(line.trim());
      } else {
        break;
      }
    }
    // Strip trailing empty lines (chomping)
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') {
      bodyLines.pop();
    }
    const description = isFolded
      ? bodyLines.join(' ').trim()
      : bodyLines.join('\n').trim();
    return { name, description };
  }

  // Inline value: strip surrounding quotes
  const description = afterColon.replace(/^["']|["']$/g, '');
  return { name, description };
}

// ── Installed skills ──────────────────────────────────────────────────────────

/** Which root a skill was found in. `'home'` entries are strictly read-only. */
export type SkillOrigin = 'vault' | 'home' | 'local';

export interface InstalledSkillInfo {
  identifier?: string;
  name: string;
  description: string;
  /** Path inside the root it was found in (may be a symlink) */
  skillPath: string;
  /** Resolved real path after following symlinks */
  realPath: string;
  isSymlink: boolean;
  isDirectory: boolean;
  /** Absolute path to the SKILL.md (or .md file) to read/write */
  skillMdPath: string;
  content: string;
  /** Name of the configured SkillSource this skill's real path belongs to, if any */
  sourceName?: string;
  /** `'vault'` = installed by this plugin; `'home'` = Claude-Code-managed, read-only. */
  origin: SkillOrigin;
  /** Whether this plugin may write to `skillMdPath`. False for everything under `~/.claude/`. */
  isEditable: boolean;
  /** Whether this plugin may delete `skillPath`. False for everything under `~/.claude/`. */
  isRemovable: boolean;
}

/**
 * Scans one skills root and returns every skill it holds (directories
 * containing a SKILL.md, or standalone .md files).
 */
async function scanSkillsRoot(
  root: string,
  origin: SkillOrigin,
  roots: SkillRoots,
): Promise<InstalledSkillInfo[]> {
  if (!root) return [];

  let entries: import('fs').Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: InstalledSkillInfo[] = [];

  if (origin === 'local' && !isCurrentLocalRoot(root)) return skills;

  for (const entry of entries) {
    if (origin === 'local' && (entry.name.startsWith('.') || !entry.isDirectory())) continue;
    const skillPath = path.join(root, entry.name);

    try {
      const isSymlink = entry.isSymbolicLink();
      let realPath = skillPath;
      if (isSymlink) {
        try {
          realPath = await fsp.realpath(skillPath);
        } catch {
          realPath = skillPath;
        }
      }

      const stat = await fsp.stat(skillPath);
      const isDirectory = stat.isDirectory();

      // Determine where SKILL.md lives
      let skillMdPath: string;
      if (isDirectory) {
        skillMdPath = path.join(realPath, 'SKILL.md');
      } else if (entry.name.endsWith('.md')) {
        skillMdPath = realPath;
      } else {
        continue; // skip non-.md non-directory entries
      }

      let content = '';
      if (origin === 'local' && (!fs.existsSync(skillMdPath) || !fs.lstatSync(skillMdPath).isFile())) continue;
      try {
        content = await fsp.readFile(skillMdPath, 'utf-8');
      } catch {
        // SKILL.md missing — keep empty content
      }

      const { name, description } = parseFrontmatter(content);

      skills.push({
        identifier: `${origin}:${entry.name.replace(/\.md$/, '')}`,
        name: name || entry.name.replace(/\.md$/, ''),
        description,
        skillPath,
        realPath,
        isSymlink,
        isDirectory,
        skillMdPath,
        content,
        origin,
        isEditable: canEditSkill({ skillPath, realPath }, roots),
        isRemovable: canRemoveSkill({ skillPath }, roots),
      });
    } catch (err) {
      console.warn(`[ClaudeThreads] Skipping skill entry "${entry.name}":`, err);
    }
  }

  return skills;
}

/**
 * Returns every skill visible to a session: the plugin's own vault-local
 * installs plus whatever Claude Code has in `~/.claude/skills/`, annotated with
 * which configured SkillSource (if any) a symlinked skill belongs to.
 *
 * Home entries are included because the CLI genuinely loads them into every
 * session — hiding them would be misleading — but they come back with
 * `origin: 'home'` and both gates false.
 */
export async function listInstalledSkills(
  skillSources: SkillSource[] = [],
  roots: SkillRoots = getSkillRoots(),
): Promise<InstalledSkillInfo[]> {
  const [vaultSkills, homeSkills, localSkills] = await Promise.all([
    scanSkillsRoot(roots.pluginRoot, 'vault', roots),
    scanSkillsRoot(roots.homeRoot, 'home', roots),
    scanSkillsRoot(roots.localRoot ?? '', 'local', roots),
  ]);

  const skills = [...vaultSkills, ...homeSkills, ...localSkills];

  // Vault entries sort ahead of same-named home entries so that every
  // find-by-name lookup (detail, uninstall) resolves to the writable one.
  skills.sort((a, b) =>
    a.name.localeCompare(b.name) ||
    (a.origin === b.origin ? 0 : a.origin === 'vault' ? -1 : 1),
  );

  // Compute sourceName for symlinked skills by matching against configured SkillSources
  if (skillSources.length > 0) {
    for (const skill of skills) {
      if (!skill.isSymlink) continue;
      for (const source of skillSources) {
        const sourcePath = source.type === 'github' ? source.clonePath : (source.skillsPath ?? '');
        const expandedSourcePath = expandHome(sourcePath ?? '', os.homedir());
        if (expandedSourcePath && skill.realPath.startsWith(expandedSourcePath)) {
          skill.sourceName = source.name;
          break;
        }
      }
    }
  }

  return skills;
}

/** Error message shared by every guard that refuses to touch `~/.claude/`. */
function readOnlyRootMessage(skillPath: string): string {
  return `Refusing to remove "${skillPath}": it lives outside the vault skills folder. ` +
    'Skills in ~/.claude/skills are managed by Claude Code and are read-only to this plugin — remove it with the `claude` CLI or by hand.';
}

/**
 * Removes an installed skill's directory/file entirely. Caller resolves the
 * path first (e.g. via `listInstalledSkills`).
 *
 * Throws for anything outside `roots.pluginRoot`. This is the last line of
 * defense for the agent-callable `skills_uninstall` MCP tool, which has no
 * confirmation dialog.
 */
export async function uninstallSkillByPath(
  skillPath: string,
  roots: SkillRoots = getSkillRoots(),
): Promise<void> {
  if (!canRemoveSkill({ skillPath }, roots)) {
    throw new Error(readOnlyRootMessage(skillPath));
  }
  await fsp.rm(skillPath, { recursive: true, force: true });
}

/**
 * Looks up an installed skill by name and removes it. Throws if no skill with
 * that name is installed, or if the match is a read-only home skill.
 *
 * On a name collision across roots the vault copy wins, so shadowing a home
 * skill and then uninstalling it removes only the vault copy.
 */
export async function uninstallSkillByName(
  name: string,
  skillSources: SkillSource[] = [],
  roots: SkillRoots = getSkillRoots(),
): Promise<{ skillPath: string }> {
  const installed = await listInstalledSkills(skillSources, roots);
  const candidates = installed.filter(s => s.name === name || s.identifier === name);
  const identified = installed.find(s => s.identifier === name);
  if (!identified && candidates.some(s => s.origin === 'local') && candidates.length > 1) {
    throw new Error(`Ambiguous skill name "${name}". Use a qualified identifier from skills_list_installed.`);
  }
  const match = identified
    ?? installed.find((s) => s.name === name && s.origin === 'local')
    ?? installed.find((s) => s.name === name && s.origin === 'vault')
    ?? installed.find((s) => s.name === name);
  if (!match) {
    throw new Error(`No installed skill named "${name}"`);
  }
  await uninstallSkillByPath(match.skillPath, roots);
  return { skillPath: match.skillPath };
}

// ── Marketplace (skills.sh) search ────────────────────────────────────────────

export interface MarketplaceSkill {
  name: string;
  /** Full skills.sh id, e.g. "owner/repo/skill-name". Used as the canonical key. */
  slug: string;
  /** Bare skill folder name (last path segment of slug). Used as the install dir basename. */
  skillId: string;
  source: string;
  installs: number;
  isInstalled: boolean;
}

interface RawMarketplaceSkill {
  id: string;
  skillId?: string;
  name: string;
  installs: number;
  source: string;
}

function toMarketplaceSkills(
  raw: RawMarketplaceSkill[],
  installedSkills: InstalledSkillInfo[],
): MarketplaceSkill[] {
  const installedNames = new Set(installedSkills.map((s) => s.name));
  const installedSlugs = new Set(installedSkills.map((s) => s.skillPath.split('/').pop() ?? ''));

  return raw
    .map((s) => {
      const skillId = s.skillId || s.id.split('/').pop() || s.id;
      return {
        name: s.name,
        slug: s.id,
        skillId,
        source: s.source ?? '',
        installs: s.installs ?? 0,
        isInstalled: installedNames.has(s.name) || installedSlugs.has(skillId),
      };
    })
    .sort((a, b) => b.installs - a.installs);
}

/** Searches the skills.sh marketplace registry for the given query, annotating results already installed locally. */
export async function searchMarketplaceSkills(
  query: string,
  limit: number,
  installedSkills: InstalledSkillInfo[],
): Promise<MarketplaceSkill[]> {
  const res = await requestUrl({
    url: `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    method: 'GET',
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);

  const data = res.json as { skills: RawMarketplaceSkill[] };
  return toMarketplaceSkills(data.skills ?? [], installedSkills);
}

/**
 * Fetches a "popular skills" list shown when browsing with no search query.
 * Uses the same underlying search endpoint as `searchMarketplaceSkills` with a
 * broad query — there's no dedicated "popular" endpoint on skills.sh.
 */
export async function getPopularMarketplaceSkills(
  installedSkills: InstalledSkillInfo[],
  limit = 30,
): Promise<MarketplaceSkill[]> {
  return searchMarketplaceSkills('er', limit, installedSkills);
}

/** Fetches and parses a marketplace skill's SKILL.md description from its GitHub source, trying a few common repo layouts. Returns null if none could be found/parsed. */
export async function getMarketplaceSkillDescription(slug: string, source: string): Promise<string | null> {
  if (!source) return null;

  // Derive the skill's own ID (last path segment after removing the source prefix)
  const skillId = slug.startsWith(source + '/') ? slug.slice(source.length + 1) : slug;

  // Try common SKILL.md locations in the repo, in order
  const candidates = [
    `https://raw.githubusercontent.com/${source}/main/skills/${skillId}/SKILL.md`,
    `https://raw.githubusercontent.com/${source}/main/${skillId}/SKILL.md`,
    `https://raw.githubusercontent.com/${source}/main/SKILL.md`,
  ];

  for (const url of candidates) {
    try {
      const res = await requestUrl({ url, method: 'GET', throw: false });
      if (res.status === 200 && res.text) {
        const { description: fm } = parseFrontmatter(res.text);
        if (fm) {
          return fm.replace(/^["']|["']$/g, '');
        }
        // No frontmatter description — try first non-heading, non-empty paragraph
        const lines = res.text.split('\n');
        const start = lines.findIndex((l) => l.startsWith('---')) >= 0
          ? lines.findIndex((l, i) => i > 0 && l.startsWith('---')) + 1
          : 0;
        const body = lines.slice(start).join('\n');
        const para = body.match(/(?:^|\n)(?!#|\s*```)[^\n]{20,}/m);
        if (para) {
          return para[0].trim();
        }
      }
    } catch { /* try next candidate */ }
  }

  return null;
}

// ── Skill detail (installed or marketplace) ───────────────────────────────────

export interface SkillDetailResult {
  name: string;
  description: string;
  installed: boolean;
  /** Full SKILL.md content — only present when `installed` is true. */
  content?: string;
  skillPath?: string;
  realPath?: string;
  isSymlink?: boolean;
  sourceName?: string;
  /** `'vault'` (plugin-managed) or `'home'` (Claude-Code-managed, read-only). Installed skills only. */
  origin?: SkillOrigin;
  /** Whether this plugin may write to the skill's SKILL.md. Installed skills only. */
  isEditable?: boolean;
  /** Whether this plugin may delete the skill. Installed skills only. */
  isRemovable?: boolean;
  /** Marketplace fields — only present when `installed` is false. */
  slug?: string;
  skillId?: string;
  source?: string;
}

/**
 * Returns full detail for one skill, whether installed or not.
 * `identifier` is either an installed skill's name, or a marketplace slug in
 * "owner/repo/skill-id" form (as returned by `searchMarketplaceSkills`).
 */
export async function getSkillDetail(
  identifier: string,
  skillSources: SkillSource[] = [],
  roots: SkillRoots = getSkillRoots(),
): Promise<SkillDetailResult> {
  const installed = await listInstalledSkills(skillSources, roots);
  const matches = (s: InstalledSkillInfo) => s.identifier === identifier || s.name === identifier || path.basename(s.skillPath) === identifier;
  // Vault copy wins on a cross-root name collision, matching uninstallSkillByName.
  const match = installed.find(s => s.identifier === identifier)
    ?? installed.find((s) => matches(s) && s.origin === 'vault') ?? installed.find(matches);
  if (match) {
    return {
      name: match.name,
      description: match.description,
      installed: true,
      content: match.content,
      skillPath: match.skillPath,
      realPath: match.realPath,
      isSymlink: match.isSymlink,
      sourceName: match.sourceName,
      origin: match.origin,
      isEditable: match.isEditable,
      isRemovable: match.isRemovable,
    };
  }

  const parts = identifier.split('/');
  if (parts.length < 2) {
    throw new Error(
      `No installed skill named "${identifier}", and it does not look like a marketplace slug (expected "owner/repo/skill-id")`,
    );
  }
  const skillId = parts[parts.length - 1];
  const source = parts.slice(0, -1).join('/');
  const description = await getMarketplaceSkillDescription(identifier, source);

  return {
    name: skillId,
    description: description ?? '',
    installed: false,
    slug: identifier,
    skillId,
    source,
  };
}

// ── Sources ────────────────────────────────────────────────────────────────

export interface SkillSourceListItem {
  id: string;
  name: string;
  type: 'registry' | 'github' | 'local';
  repoUrl?: string;
  behindCount?: number;
  lastFetched?: number;
}

/** Lists all configured skill sources, plus the built-in skills.sh registry as a pseudo-source with id "registry". */
export function listSkillSources(skillSources: SkillSource[] = []): SkillSourceListItem[] {
  return [
    { id: 'registry', name: 'skills.sh', type: 'registry' },
    ...skillSources.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      repoUrl: s.repoUrl,
      behindCount: s.behindCount,
      lastFetched: s.lastFetched,
    })),
  ];
}

// ── Cloning GitHub sources ────────────────────────────────────────────────────

/** Wall-clock ceiling for a single `git clone`, after which the child is killed. */
export const SKILL_SOURCE_CLONE_TIMEOUT_MS = 60_000;

/** Best-effort human-readable message from a failed child_process call (git writes the useful part to stderr). */
function execErrorMessage(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string } | undefined)?.stderr;
  if (stderr && String(stderr).trim()) return String(stderr).trim();
  return err instanceof Error ? err.message : String(err);
}

/**
 * Canonical form of a repo URL, used as the hash input for deterministic source
 * ids. Collapses everything that does not change *which repo is meant*: scheme,
 * `git@host:` scp form, a `user@` prefix, a trailing `.git`, trailing slashes,
 * and case. So `https://github.com/O/R`, `github.com/o/r.git` and
 * `git@github.com:o/r` all hash to the same id.
 */
export function normalizeRepoUrlForId(repoUrl: string): string {
  return repoUrl
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^git@([^:/]+):/, '$1/')
    .replace(/^[^/@]+@/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

/**
 * Deterministic source id derived from the repo URL.
 *
 * Deliberately NOT `crypto.randomUUID()`: a vault can declare its skill sources
 * in a committed config (`data.json` checked into a dotfiles/config repo) with
 * no id at all, and every machine that loads it must resolve the same id — and
 * therefore the same clone directory — so the reconciliation pass below is a
 * no-op on the second launch instead of re-cloning under a fresh UUID.
 * `randomUUID()` is still correct for a brand-new source the user adds by hand.
 */
export function deriveSourceIdFromRepoUrl(repoUrl: string): string {
  const digest = createHash('sha256').update(normalizeRepoUrlForId(repoUrl)).digest('hex');
  return `gh-${digest.slice(0, 16)}`;
}

/** `git clone` needs the `.git` suffix even though we display and store the bare URL. */
export function githubCloneUrl(repoUrl: string): string {
  const trimmed = repoUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('.git') ? trimmed : `${trimmed}.git`;
}

/** True when `dirPath` looks like a git working copy (`.git` dir, or a `.git` file for worktrees/submodules). */
export function isGitWorkingCopy(dirPath: string): boolean {
  if (!dirPath) return false;
  try {
    return fs.existsSync(path.join(dirPath, '.git'));
  } catch {
    return false;
  }
}

/**
 * Shallow-clones a GitHub source into `clonePath`. The single implementation of
 * this — `SettingsTab` (add-source) and `SkillsManagerView` (reinstall) both
 * call here, as does the startup reconciliation pass below.
 *
 * Three deliberate choices:
 * - **`execFile`, not `execSync`.** The startup pass must never block Obsidian's
 *   main thread; a synchronous clone would freeze the UI for up to the timeout.
 *   Both interactive callers are already `async`, so they just `await`.
 * - **Argument array, not a shell string.** `repoUrl` can come from a config
 *   file, so it never reaches a shell for interpolation. `--` terminates options.
 * - **Non-interactive git.** `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=echo` make a
 *   private or nonexistent repo fail immediately instead of blocking on a
 *   credential prompt until the timeout. Configured credential helpers (macOS
 *   keychain, gh) still work, so private repos the user can already clone do.
 *
 * Removes a partial clone before rethrowing, so a failure never leaves a
 * half-populated directory that later looks "already cloned".
 */
export async function cloneGithubSource(
  repoUrl: string,
  clonePath: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await fsp.mkdir(path.dirname(clonePath), { recursive: true });
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'git',
        ['clone', '--depth', '1', '--', githubCloneUrl(repoUrl), clonePath],
        {
          timeout: options.timeoutMs ?? SKILL_SOURCE_CLONE_TIMEOUT_MS,
          windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
        },
        (err, _stdout, stderr) => {
          if (!err) return resolve();
          const detail = stderr ? String(stderr).trim() : '';
          reject(new Error(detail || err.message));
        },
      );
    });
  } catch (err) {
    try { fs.rmSync(clonePath, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Validates a user-entered GitHub repo URL and returns it in the bare form we
 * store (`https://github.com/owner/repo`, no `.git`, no trailing slash), or
 * `null` when it is not a GitHub owner/repo URL.
 */
export function parseGithubRepoUrl(raw: string): string | null {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(https?:\/\/github\.com\/[^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return match ? match[1] : null;
}

/**
 * Clones a GitHub repo as a new managed skill source and returns the
 * `SkillSource` to add. The single "add a GitHub source" implementation, shared
 * by the Add skill source modal and Chief of Staff onboarding.
 *
 * Does not touch settings: the caller pushes the result into
 * `settings.skillSources` and persists. Throws on clone failure, having already
 * removed any partial clone (see `cloneGithubSource`).
 *
 * `id` defaults to the deterministic repo-derived id; the modal passes a random
 * UUID to keep its historical behavior.
 */
export async function addGithubSkillSource(opts: {
  repoUrl: string;
  cloneBase: string;
  displayName?: string;
  id?: string;
  timeoutMs?: number;
}): Promise<SkillSource> {
  const repoUrl = opts.repoUrl.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const id = opts.id ?? deriveSourceIdFromRepoUrl(repoUrl);
  const clonePath = path.join(opts.cloneBase, id);

  await cloneGithubSource(repoUrl, clonePath, { timeoutMs: opts.timeoutMs });

  const manifest = readPluginManifest(clonePath);
  const repoName = repoUrl.split('/').pop() || 'Unknown';
  const name = opts.displayName?.trim() || manifest?.displayName || manifest?.name || repoName;

  return { id, name, type: 'github', repoUrl, clonePath, lastFetched: Date.now() };
}

export interface EnsureGithubSourcesResult {
  /** True when any source object was mutated and the caller must persist settings. */
  changed: boolean;
  /** Sources cloned on this pass. */
  cloned: { id: string; name: string }[];
  /** Ids of sources whose clone was already on disk — left completely untouched. */
  present: string[];
  /** Sources that could not be materialized. Logged and skipped, never thrown. */
  failed: { id: string; name: string; error: string }[];
}

/**
 * Materializes every declared GitHub-type skill source that has no clone on
 * disk. Safe to call on every load: idempotent, and a pass where everything is
 * already present mutates nothing (`changed: false`, zero writes).
 *
 * Fills in the two machine-specific fields a *declared* source is allowed to
 * omit — `id` (derived deterministically from `repoUrl`) and `clonePath`
 * (`<cloneBase>/<id>`) — so a committed config needs neither a UUID nor an
 * absolute path.
 *
 * **Clone-if-missing only.** Existing clones are never fetched, pulled, or
 * touched: pulling on launch would put network latency in every startup and
 * mutate skills underneath a running session. Updating stays an explicit action
 * (`checkAllSourcesForUpdates` / `pullGithubSourceUpdates`).
 *
 * **Never throws.** Every source is attempted inside its own try/catch, so an
 * unreachable host, a private repo, a rate limit, a missing `git` binary or a
 * timeout is recorded in `failed` and the remaining sources still run. Callers
 * are expected to log `failed` and carry on.
 *
 * `type: 'local'` sources are ignored outright — those paths belong to the user.
 */
export async function ensureGithubSourcesCloned(
  skillSources: SkillSource[] | undefined,
  cloneBase: string,
  options: { timeoutMs?: number } = {},
): Promise<EnsureGithubSourcesResult> {
  const result: EnsureGithubSourcesResult = { changed: false, cloned: [], present: [], failed: [] };
  if (!skillSources?.length || !cloneBase) return result;

  for (const source of skillSources) {
    // Local sources point at directories the user maintains — not ours to create.
    if (source.type !== 'github') continue;
    const label = source.name || source.repoUrl || source.id || '(unnamed source)';
    try {
      if (!source.repoUrl) {
        result.failed.push({ id: source.id ?? '', name: label, error: 'GitHub source has no repoUrl, so there is nothing to clone' });
        continue;
      }
      if (!source.id) {
        source.id = deriveSourceIdFromRepoUrl(source.repoUrl);
        result.changed = true;
      }
      if (!source.clonePath) {
        source.clonePath = path.join(cloneBase, source.id);
        result.changed = true;
      }

      if (isGitWorkingCopy(source.clonePath)) {
        result.present.push(source.id);
        continue;
      }

      if (fs.existsSync(source.clonePath)) {
        // Something is there but it is not a git working copy — an interrupted
        // clone, or a directory someone created by hand. Only ever clear it when
        // it sits inside the clone base we manage; a clonePath pointing outside
        // that (a hand-edited setting) is left alone rather than deleted, since
        // silently removing a user directory at startup is far worse than
        // skipping one source.
        if (!isInsideRoot(source.clonePath, cloneBase)) {
          result.failed.push({
            id: source.id,
            name: label,
            error: `clonePath "${source.clonePath}" exists but is not a git repo, and is outside the managed skill-sources folder — refusing to replace it`,
          });
          continue;
        }
        fs.rmSync(source.clonePath, { recursive: true, force: true });
      }

      await cloneGithubSource(source.repoUrl, source.clonePath, options);
      source.lastFetched = Date.now();
      source.behindCount = 0;
      result.changed = true;
      result.cloned.push({ id: source.id, name: label });
    } catch (err) {
      result.failed.push({ id: source.id ?? '', name: label, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

// ── Update checks / pulls (GitHub sources) ────────────────────────────────────

export interface SourceUpdateCheckResult {
  id: string;
  name: string;
  behindCount?: number;
  lastFetched?: number;
  error?: string;
}

/** Runs `git fetch` + counts commits behind origin/HEAD for one GitHub-type source. Returns `error` instead of throwing on failure. */
export async function checkSourceForUpdates(source: SkillSource): Promise<SourceUpdateCheckResult> {
  if (!source.clonePath) {
    return { id: source.id, name: source.name, error: 'No clone path configured for this source' };
  }
  try {
    // Note: `git fetch` has no `--timeout` flag (that was a pre-existing bug —
    // this call always failed with "unknown option" on real git). The
    // `timeout: 20_000` execSync option below already enforces a wall-clock
    // timeout by killing the process, so no git-side flag is needed.
    execSync(`git -C "${source.clonePath}" fetch --quiet`, {
      stdio: 'pipe',
      timeout: 20_000,
    });
    const countOutput = execSync(
      `git -C "${source.clonePath}" rev-list HEAD..origin/HEAD --count`,
      { stdio: 'pipe', timeout: 5_000 },
    );
    const count = parseInt(countOutput.toString().trim(), 10);
    return {
      id: source.id,
      name: source.name,
      behindCount: isNaN(count) ? 0 : count,
      lastFetched: Date.now(),
    };
  } catch (err) {
    return { id: source.id, name: source.name, error: execErrorMessage(err) };
  }
}

/** Runs `checkSourceForUpdates` across every configured GitHub-type source with a clone path, in parallel. */
export async function checkAllSourcesForUpdates(skillSources: SkillSource[] = []): Promise<SourceUpdateCheckResult[]> {
  const githubSources = skillSources.filter((s) => s.type === 'github' && s.clonePath);
  return Promise.all(githubSources.map((source) => checkSourceForUpdates(source)));
}

/** Pulls the latest commits for a GitHub-type source's local clone. Throws on failure (bad path, git error, etc). */
export async function pullGithubSourceUpdates(source: SkillSource): Promise<{ behindCount: number; lastFetched: number }> {
  if (!source.clonePath) {
    throw new Error(`Source "${source.name}" has no clone path configured`);
  }
  execSync(`git -C "${source.clonePath}" pull`, { stdio: 'pipe', timeout: 60_000 });
  return { behindCount: 0, lastFetched: Date.now() };
}

/** Scans a GitHub source's configured skills directory for the skills it provides (used by the Installed-tab source tree). */
export interface SourceSkillInfo {
  id: string;
  name: string;
  description: string;
  skillDir: string;
}

export async function listGithubSourceSkills(source: SkillSource): Promise<SourceSkillInfo[]> {
  if (!source.clonePath) return [];
  const skillsDir = getSkillsDirForSource(source.clonePath);
  const skills: SourceSkillInfo[] = [];

  try {
    const entries = await fsp.readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillDir = path.join(skillsDir, entry.name);
      const skillMdPath = path.join(skillDir, 'SKILL.md');
      try {
        await fsp.access(skillMdPath);
      } catch {
        continue;
      }
      let content = '';
      try {
        content = await fsp.readFile(skillMdPath, 'utf-8');
      } catch { /* empty */ }
      const { name, description } = parseFrontmatter(content);
      skills.push({ id: entry.name, name: name || entry.name, description, skillDir });
    }
  } catch { /* ignore */ }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Install from marketplace ──────────────────────────────────────────────────

export interface InstallSkillParams {
  slug: string;
  skillId: string;
  name: string;
  source: string;
}

export interface InstallSkillOptions {
  /**
   * Where to install. Defaults to `roots.pluginRoot`. Passing `''` explicitly
   * throws rather than falling back — there is no legal home-directory target.
   */
  installRoot?: string;
  /**
   * Called with human-readable progress messages ("Cloning…", "Locating skill
   * files…", "Copying files…") for UI callers — purely informational, has no
   * effect on the install itself.
   */
  onProgress?: (message: string) => void;
  roots?: SkillRoots;
}

/**
 * Installs a skill from the marketplace by shallow-cloning its GitHub source
 * repo to a tmpdir, locating the skill's directory within it, and copying it
 * into `<vault>/<plugin-dir>/skills/<skillId>`.
 *
 * Takes an options object rather than positional params: a second positional
 * argument would have silently kept working at both call sites while quietly
 * meaning something different.
 */
export async function installSkillFromMarketplace(
  params: InstallSkillParams,
  options: InstallSkillOptions = {},
): Promise<{ name: string; targetDir: string }> {
  if (!params.source) {
    throw new Error('No GitHub source available for this skill');
  }

  const onProgress = options.onProgress;
  const roots = options.roots ?? getSkillRoots();
  // requirePluginRoot throws a named error for an unresolvable/empty root
  // instead of letting the install land somewhere unintended.
  const skillsDir = requirePluginRoot({
    ...roots,
    pluginRoot: options.installRoot ?? roots.pluginRoot,
  });
  const tmpDir = path.join(os.tmpdir(), `ct-skill-${Date.now()}`);
  const targetDir = path.join(skillsDir, params.skillId);

  try {
    await fsp.mkdir(skillsDir, { recursive: true });

    if (fs.existsSync(targetDir)) {
      throw new Error(`A skill named "${params.skillId}" is already installed`);
    }

    // A same-named skill in ~/.claude/skills is a warning, not a block: home
    // skills can no longer be uninstalled through the plugin, so blocking here
    // would make them permanently un-shadowable.
    if (roots.homeRoot && fs.existsSync(path.join(roots.homeRoot, params.skillId))) {
      console.warn(
        `[ClaudeThreads] "${params.skillId}" also exists in ~/.claude/skills; the vault copy will shadow it in the Skills Manager.`,
      );
    }

    onProgress?.(`Cloning ${params.source}…`);
    execSync(
      `git clone --depth 1 "https://github.com/${params.source}.git" "${tmpDir}"`,
      { stdio: 'pipe', timeout: 60_000 },
    );

    onProgress?.('Locating skill files…');
    const skillSrcDir = await findSkillDir(tmpDir, params.skillId, params.name, fs, path);
    if (!skillSrcDir) {
      throw new Error(`Skill "${params.skillId}" not found in ${params.source}`);
    }

    onProgress?.('Copying files…');
    await copySkillFiles(skillSrcDir, targetDir);

    // Remove .git and other dev-only artifacts from root-level installs
    const dotGit = path.join(targetDir, '.git');
    if (fs.existsSync(dotGit)) {
      await fsp.rm(dotGit, { recursive: true, force: true });
    }

    return { name: params.name, targetDir };
  } finally {
    // Clean up temp dir (best-effort)
    try {
      if (fs.existsSync(tmpDir)) {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  }
}

// ── Skill Install Helpers ────────────────────────────────────────────────────

/**
 * Copy a skill's source directory to the target install path.
 *
 * `dereference: true` is critical: some skill repos (e.g. nextlevelbuilder/ui-ux-pro-max-skill)
 * contain `data/` and `scripts/` as intra-repo symlinks. Without dereferencing, those symlinks
 * would be copied as-is, pointing into the now-deleted temp clone directory and leaving the
 * installed skill permanently broken.
 */
export async function copySkillFiles(src: string, dest: string): Promise<void> {
  await fsp.cp(src, dest, { recursive: true, dereference: true });
}

// ── Skill Discovery ──────────────────────────────────────────────────────────

/** Find the directory inside a cloned repo that contains the target skill's SKILL.md. */
export async function findSkillDir(
  repoDir: string,
  skillId: string,
  name: string,
  fsModule: typeof import('fs'),
  pathModule: typeof import('path'),
): Promise<string | null> {
  // 1. Repo root is the skill itself
  if (fsModule.existsSync(pathModule.join(repoDir, 'SKILL.md'))) {
    return repoDir;
  }

  // 2. Scan for SKILL.md files up to 4 levels deep.
  //    Skip git/CI/dependency junk only — not all dotfile dirs, since some repos
  //    nest skills under `.claude/skills/<skill-id>/` (e.g. the Claude plugin layout).
  const SKIP = new Set(['.git', '.github', '.gitlab', '.vscode', '.idea', 'node_modules']);
  const candidates: string[] = [];
  const scan = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: import('fs').Dirent[];
    try {
      entries = fsModule.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (SKIP.has(ent.name)) continue;
      if (!ent.isDirectory()) continue;
      const sub = pathModule.join(dir, ent.name);
      if (fsModule.existsSync(pathModule.join(sub, 'SKILL.md'))) {
        candidates.push(sub);
      } else {
        scan(sub, depth + 1);
      }
    }
  };
  scan(repoDir, 0);

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // 3. Multiple candidates: match by directory basename
  const byDir = candidates.find(
    (d) => pathModule.basename(d) === skillId || pathModule.basename(d) === name,
  );
  if (byDir) return byDir;

  // 4. Match by SKILL.md name frontmatter
  for (const dir of candidates) {
    try {
      const raw = fsModule.readFileSync(pathModule.join(dir, 'SKILL.md'), 'utf-8');
      const { name: skillName } = parseFrontmatter(raw);
      if (skillName === skillId || skillName === name) return dir;
    } catch { /* skip */ }
  }

  // 5. Fallback: first found
  return candidates[0] ?? null;
}

// ── Skill Import (folder / .skill archive) Helpers ────────────────────────────

/**
 * Slugify a skill's display name into an install-directory-safe id: lowercase,
 * runs of non-alphanumeric characters collapsed to a single hyphen, and
 * leading/trailing hyphens trimmed.
 *
 * Used for manually-imported skills (folder or .skill/.zip file), which have no
 * canonical registry `skillId` the way skills.sh browse results do.
 */
export function deriveSkillId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Extract a zip archive to `destDir` using the pure-JS `adm-zip` library (no
 * shelling out to `unzip`/`tar`/`ditto`).
 *
 * Even though adm-zip sanitizes entry paths internally before writing, this
 * wrapper adds an explicit zip-slip guard as defense-in-depth for user-supplied
 * archives: every entry's resolved absolute path is checked to stay under
 * `destDir` *before* any extraction happens. If any entry would escape, the
 * whole extraction is aborted (nothing is written).
 */
export async function extractZipToDir(zipPath: string, destDir: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AdmZip = require('adm-zip') as typeof import('adm-zip');

  const zip = new AdmZip(zipPath);
  const resolvedDest = path.resolve(destDir);

  for (const entry of zip.getEntries()) {
    const resolvedEntry = path.resolve(resolvedDest, entry.entryName);
    if (resolvedEntry !== resolvedDest && !resolvedEntry.startsWith(resolvedDest + path.sep)) {
      throw new Error(`Zip entry "${entry.entryName}" would extract outside the destination directory`);
    }
  }

  await zip.extractAllToAsync(destDir, true, false);
}

/**
 * Shared core of both manual-import flows (folder picker and .skill/.zip file
 * picker). `sourceDir` is a directory already on disk (either the user-picked
 * folder, or a tmpdir a zip was already extracted into) that is expected to
 * contain a SKILL.md somewhere inside it.
 */
export async function importSkillFromPath(
  sourceDir: string,
  skillsDir: string,
  fsModule: typeof import('fs'),
  pathModule: typeof import('path'),
  fallbackName?: string,
): Promise<{ id: string; name: string; targetDir: string }> {
  const locatedDir = await findSkillDir(sourceDir, '', '', fsModule, pathModule);
  if (!locatedDir) {
    throw new Error('No SKILL.md found in the selected folder/file');
  }

  let name = fallbackName ?? pathModule.basename(locatedDir);
  try {
    const raw = fsModule.readFileSync(pathModule.join(locatedDir, 'SKILL.md'), 'utf-8');
    const { name: frontmatterName } = parseFrontmatter(raw);
    if (frontmatterName) name = frontmatterName;
  } catch { /* fall back to fallbackName / dir basename */ }

  const id = deriveSkillId(name);
  const targetDir = pathModule.join(skillsDir, id);

  if (fsModule.existsSync(targetDir)) {
    throw new Error(`A skill named "${id}" is already installed`);
  }

  await fsModule.promises.mkdir(skillsDir, { recursive: true });
  await copySkillFiles(locatedDir, targetDir);

  // Strip .git the same way installSkillFromMarketplace does. Imports now land
  // inside the vault, where a stray nested repo would confuse both Obsidian
  // Sync and any git tooling pointed at the vault.
  const dotGit = pathModule.join(targetDir, '.git');
  if (fsModule.existsSync(dotGit)) {
    await fsModule.promises.rm(dotGit, { recursive: true, force: true });
  }

  return { id, name, targetDir };
}

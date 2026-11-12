// Directory fixtures. readdir/readdirSync are path-aware: returning the same
// entries for every path made the Skills Manager render each skill twice (once
// as a skill, once as an "agent") and made it impossible to screenshot the
// vault-vs-read-only split at all.
export const HOME_SKILLS_DIR = '/Users/mock/.claude/skills';
export const HOME_AGENTS_DIR = '/Users/mock/.claude/agents';
export const VAULT_SKILLS_DIR = '/Users/mock/vault/.obsidian/plugins/claude-threads/skills';
export const LOCAL_SKILLS_DIR = '/Users/mock/vault/Skills';
const authoredSkills = new Map<string, string>();
export function seedAuthoredSkill(id: string, content: string): void { authoredSkills.set(id, content); }

const SKILLS: Array<{ name: string; description: string; content: string }> = [
  {
    name: 'brain-dump',
    description: 'Interactive knowledge extraction — structured interview to capture tacit knowledge.',
    content: '',
  },
  {
    name: 'brainstorm',
    description: 'Active ideation partner — Claude leads the session, proposes angles, surfaces frameworks.',
    content: '',
  },
  {
    name: 'chief-of-staff',
    description: 'Standing behavioral rules for how Claude acts as your chief of staff.',
    content: '',
  },
  {
    name: 'nextjs-local-dev',
    description: 'Manage a local Next.js dev server — start, stop, restart, monitor logs.',
    content: '',
  },
  {
    name: 'pr-checklist',
    description: 'Run the pre-PR definition-of-done checklist before opening a pull request.',
    content: '',
  },
  {
    name: 'vercel-tools',
    description: 'Vercel CLI recipes — check deploy status, apply migrations, watch deployments.',
    content: '',
  },
];

// Skills this plugin installed into the vault — editable.
const VAULT_SKILLS: Array<{ name: string; description: string; content: string }> = [
  {
    name: 'release-manager',
    description: 'Triage, merge, and ship every open PR on a repo as one batch.',
    content: '',
  },
  {
    name: 'stash',
    description: 'Park the current work as a resumable handoff note in the vault.',
    content: '',
  },
];

// Agent profiles in ~/.claude/agents — read-only.
const AGENTS: Array<{ name: string; description: string; content: string }> = [
  {
    name: 'engineer',
    description: 'Senior engineer — implements features, fixes bugs, refactors.',
    content: '',
  },
  {
    name: 'reviewer',
    description: 'Code reviewer — audits a diff for correctness and security.',
    content: '',
  },
];

// build content from name/description
for (const s of [...SKILLS, ...VAULT_SKILLS, ...AGENTS]) {
  s.content = `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n# ${s.name}\n\nThis skill teaches Claude how to ${s.description.toLowerCase()}\n`;
}

function fixtureFor(dirPath: string) {
  if (dirPath.startsWith(HOME_AGENTS_DIR)) return AGENTS;
  if (dirPath.startsWith(VAULT_SKILLS_DIR)) return VAULT_SKILLS;
  if (dirPath.startsWith(HOME_SKILLS_DIR)) return SKILLS;
  return [];
}

function makeEntries(dirPath: string) {
  if (dirPath === LOCAL_SKILLS_DIR) return [...authoredSkills.keys()].map(name => ({ name, isSymbolicLink: () => false, isDirectory: () => true }));
  return fixtureFor(dirPath).map((s) => ({
    name: `${s.name}.md`,
    isSymbolicLink: () => false,
    isDirectory: () => false,
  }));
}

// NOTE: there is deliberately no ~/.claude/settings.json fixture here any more.
// MCP servers moved into the plugin's own settings (PluginSettings.mcpServers);
// see the fixture in test/harness/settings-index.ts. Nothing in src/ reads that
// file, so mocking it would only mask a regression.

// Fixture for the inline `visualize` card screenshot. A Codex fragment: no
// doctype, no <html>/<body>, and no external resources — the whole point of the
// card is that the plugin wraps it into a themed, sandboxed document. Kept
// deterministic (no animation, no randomness, no CDN) so the baseline is stable.
export const VISUALIZE_FRAGMENT = `<div id="quarterly-revenue">
  <h2>Quarterly revenue</h2>
  <div class="viz-grid">
    <div class="card viz-stat">
      <span class="text-muted text-small">Bookings</span>
      <span class="viz-stat-value">$4.2M</span>
      <span class="text-muted text-small">+12% vs Q2</span>
    </div>
    <div class="card viz-stat">
      <span class="text-muted text-small">Net revenue</span>
      <span class="viz-stat-value">$3.1M</span>
      <span class="text-muted text-small">+8% vs Q2</span>
    </div>
  </div>
  <table class="table table-sm">
    <thead><tr><th>Region</th><th class="text-end">Revenue</th><th>Share</th></tr></thead>
    <tbody>
      <tr>
        <td>North America</td><td class="text-end">$1.8M</td>
        <td><div class="progress" role="progressbar" aria-label="North America share" aria-valuenow="58" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width:58%"></div></div></td>
      </tr>
      <tr>
        <td>Europe</td><td class="text-end">$0.9M</td>
        <td><div class="progress" role="progressbar" aria-label="Europe share" aria-valuenow="29" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width:29%"></div></div></td>
      </tr>
      <tr>
        <td>APAC</td><td class="text-end">$0.4M</td>
        <td><div class="progress" role="progressbar" aria-label="APAC share" aria-valuenow="13" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width:13%"></div></div></td>
      </tr>
    </tbody>
  </table>
  <div class="viz-row">
    <span class="viz-badge">Q3 2026</span>
    <button type="button" class="btn btn-primary">Export</button>
    <button type="button" class="btn">Compare</button>
  </div>
</div>`;

/** Only the visualize fixture path serves the fragment — see isVisualizePath. */
const VISUALIZE_PATH_RE = /\/viz\/[^/]+\.html?$/i;

function resolveContent(filePath: string): string {
  if (filePath.startsWith(LOCAL_SKILLS_DIR + '/')) return authoredSkills.get(filePath.slice(LOCAL_SKILLS_DIR.length + 1).split('/')[0]) ?? '';
  if (VISUALIZE_PATH_RE.test(filePath)) return VISUALIZE_FRAGMENT;
  for (const s of [...SKILLS, ...VAULT_SKILLS, ...AGENTS]) {
    if (filePath.includes(s.name)) return s.content;
  }
  return '';
}

// Named exports so dynamic require('fs') at runtime returns the right shape.
// (esbuild wraps ESM as { __esModule: true, default: ..., ...namedExports };
// callers using require() get the namespace, not the default, so named exports
// are required for dynamic require() calls in SkillsManagerView to work.)

export const existsSync = (p: string) => p === LOCAL_SKILLS_DIR || (p.startsWith(LOCAL_SKILLS_DIR + '/') && authoredSkills.has(p.slice(LOCAL_SKILLS_DIR.length + 1).split('/')[0]));
export const lstatSync = (p: string) => {
  if (!existsSync(p)) throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' });
  return { isDirectory: () => !p.endsWith('/SKILL.md'), isFile: () => p.endsWith('/SKILL.md'), isSymbolicLink: () => false };
};
export const readdirSync = (p: string) =>
  p === LOCAL_SKILLS_DIR ? [...authoredSkills.keys()] : fixtureFor(p).map((s) => `${s.name}.md`);
export const readFileSync = (p: string, _enc: string): string => resolveContent(p);
// Seeded authored skills are directories (DispatchInput's extra-dir scan skips anything else).
export const statSync = (p: string) => ({ isDirectory: () => p.startsWith(LOCAL_SKILLS_DIR + '/') && existsSync(p) && !p.endsWith('.md') });
// realpathSync/mkdirSync/writeFileSync are no-ops in the harness — the MCP
// settings tab reads via readFileSync above; writes (Add/Edit/Remove) are
// exercised by the unit tests against the real fs, not this browser harness.
export const realpathSync = (p: string) => p;
export const mkdirSync = (_p: string, _opts?: unknown) => undefined;
export const writeFileSync = (_p: string, _data: string, _enc?: string) => undefined;

export const promises = {
  readdir: async (dirPath: string, _opts?: unknown) => makeEntries(dirPath),
  // isFile/size/mtimeMs are read by visualizeRenderer's fragment guards, and
  // the fixed mtime keeps its document cache key stable across a screenshot
  // run. They are reported ONLY for the visualize fixture path: every other
  // caller in the harness has to keep seeing the original shape, because a
  // stat that suddenly claims isFile() for every path changes what unrelated
  // code does (attachment and diff lookups especially) and shows up as
  // intermittent scroll-offset diffs in screenshots that have nothing to do
  // with visualizations.
  stat: async (p: string) =>
    p.startsWith(LOCAL_SKILLS_DIR) ? lstatSync(p) : VISUALIZE_PATH_RE.test(p)
      ? {
          isDirectory: () => false,
          isFile: () => true,
          size: resolveContent(p).length,
          mtimeMs: 1_700_000_000_000,
        }
      : { isDirectory: () => false },
  realpath: async (p: string) => p,
  readFile: async (p: string, _enc: string) => resolveContent(p),
  writeFile: async (_p: string, _data: string, _enc: string) => {},
  rm: async (_p: string, _opts?: unknown) => {},
  mkdir: async (_p: string, _opts?: unknown) => {},
  cp: async (_src: string, _dst: string, _opts?: unknown) => {},
  // Used by skillManager.ts's listGithubSourceSkills to check a SKILL.md
  // exists before reading it. No screenshot test expands a GitHub source
  // node, so always resolving (never throwing) is enough to satisfy the
  // static `import * as fsp from 'fs/promises'` binding without crashing.
  access: async (_p: string) => {},
};

// Also keep a default export for static `import fs from 'fs'` usage.
export default {
  lstatSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  promises,
};

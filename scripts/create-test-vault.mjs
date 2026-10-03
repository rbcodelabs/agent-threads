/**
 * create-test-vault.mjs
 *
 * Spins up an isolated Obsidian test vault with the current plugin build
 * installed, registered in Obsidian's vault picker, and pre-seeded with
 * notes about the current branch/changes.
 *
 * Usage:
 *   node scripts/create-test-vault.mjs [--update] [--open] [--name <n>]
 *
 *   --update / -u   Rebuild and re-copy dist only; don't recreate vault structure or notes
 *   --open   / -o   Open vault in Obsidian after finishing
 *   --name <n>      Override vault name (default: derived from branch)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const update = args.includes('--update') || args.includes('-u');
const open   = args.includes('--open')   || args.includes('-o');
const nameIdx = args.findIndex(a => a === '--name' || a === '-n');
const forceName = nameIdx !== -1 ? args[nameIdx + 1] : null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: repoRoot, encoding: 'utf8', ...opts }).trim();
}

function tryRun(cmd) {
  try {
    return run(cmd, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Gather context
// ---------------------------------------------------------------------------

const branch = tryRun('git rev-parse --abbrev-ref HEAD') || 'unknown';

// Read plugin version from dist/manifest.json (preferred) or manifest.json
let pluginVersion = 'unknown';
const distManifest = path.join(repoRoot, 'dist', 'manifest.json');
const srcManifest  = path.join(repoRoot, 'manifest.json');
const manifestPath = fs.existsSync(distManifest) ? distManifest : srcManifest;
try {
  pluginVersion = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version ?? 'unknown';
} catch {
  // leave as 'unknown'
}

// Sanitize branch name for filesystem: replace / with -, strip chars that
// aren't alphanumeric, -, or _
const sanitized = branch.replace(/\//g, '-').replace(/[^a-zA-Z0-9\-_]/g, '');
const vaultName = forceName ?? `ct-${sanitized}`;
const vaultPath = path.join(os.homedir(), '.claude', 'test-vaults', vaultName);
const pluginDir = path.join(vaultPath, '.obsidian', 'plugins', 'claude-threads');

// ---------------------------------------------------------------------------
// Build step (always runs)
// ---------------------------------------------------------------------------

console.log('Building plugin...');
try {
  execSync('npm run build', { cwd: repoRoot, stdio: 'inherit' });
} catch (err) {
  // The build step may fail if OBSIDIAN_PLUGIN_DIR or extraVaults paths don't exist on
  // this machine (the obsidian-sync esbuild plugin throws on missing destinations).
  // That's fine as long as dist/main.js was produced — the test vault copy below handles it.
  if (!fs.existsSync(path.join(repoRoot, 'dist', 'main.js'))) {
    throw err; // real build failure — re-throw
  }
  console.log('Warning: build sync step failed but dist/ was produced — continuing.');
}

// Re-read version from dist/manifest.json now that the build is done
try {
  pluginVersion = JSON.parse(fs.readFileSync(distManifest, 'utf8')).version ?? pluginVersion;
} catch {
  // keep whatever we had
}

// ---------------------------------------------------------------------------
// Vault creation (skipped when --update AND vault already exists)
// ---------------------------------------------------------------------------

const vaultExists = fs.existsSync(vaultPath);

if (!vaultExists) {
  console.log(`\nCreating test vault at ${vaultPath} ...`);

  // Directory structure
  fs.mkdirSync(pluginDir, { recursive: true });

  // .obsidian/app.json
  fs.writeFileSync(
    path.join(vaultPath, '.obsidian', 'app.json'),
    '{}\n',
  );

  // .obsidian/community-plugins.json
  fs.writeFileSync(
    path.join(vaultPath, '.obsidian', 'community-plugins.json'),
    JSON.stringify(['claude-threads'], null, 2) + '\n',
  );

  // Testing Notes.md
  const now = new Date().toISOString();
  const testingNotes = `# Testing: ${branch}

**Branch:** \`${branch}\`
**Created:** ${now}
**Plugin version:** v${pluginVersion}

## What to Test

- [ ] Plugin loads without errors
- [ ] Core functionality works as expected
- [ ] No console errors on startup

## Test Notes

<!-- Add notes as you test -->

## Issues Found

<!-- Document any bugs or unexpected behavior -->
`;
  fs.writeFileSync(path.join(vaultPath, 'Testing Notes.md'), testingNotes);

  // Branch Changes.md — populate with git context
  const recentCommits = tryRun('git log --oneline -15');

  // git diff against main with fallback for detached HEAD / no main ref
  const changedFiles = tryRun('git diff main...HEAD --name-only') ||
                       tryRun('git diff HEAD~5...HEAD --name-only');
  const changeStat   = tryRun('git diff main...HEAD --stat')      ||
                       tryRun('git diff HEAD~5...HEAD --stat');

  const branchChanges = `# Branch Changes: ${branch}

## Recent Commits

\`\`\`
${recentCommits}
\`\`\`

## Files Changed

\`\`\`
${changedFiles}
\`\`\`

## Change Summary

\`\`\`
${changeStat}
\`\`\`
`;
  fs.writeFileSync(path.join(vaultPath, 'Branch Changes.md'), branchChanges);
}

// ---------------------------------------------------------------------------
// Register vault in Obsidian's vault picker (best-effort)
// ---------------------------------------------------------------------------

const obsidianJsonPath = path.join(
  os.homedir(),
  'Library', 'Application Support', 'obsidian', 'obsidian.json',
);

try {
  let obsidianConfig = {};
  if (fs.existsSync(obsidianJsonPath)) {
    obsidianConfig = JSON.parse(fs.readFileSync(obsidianJsonPath, 'utf8'));
  }

  const vaults = obsidianConfig.vaults ?? {};

  // Check whether this vault path is already registered
  const alreadyRegistered = Object.values(vaults).some(v => v.path === vaultPath);

  if (!alreadyRegistered) {
    const vaultId = crypto.createHash('sha256').update(vaultPath).digest('hex').slice(0, 16);
    vaults[vaultId] = { path: vaultPath, ts: Date.now() };
    obsidianConfig.vaults = vaults;
    fs.writeFileSync(obsidianJsonPath, JSON.stringify(obsidianConfig, null, 2) + '\n');
    console.log(`\nRegistered vault "${vaultName}" in Obsidian`);
  } else {
    console.log(`\nVault "${vaultName}" already registered in Obsidian`);
  }
} catch (err) {
  console.warn(`\nWarning: could not register vault in Obsidian (${err.message}). Open it manually if needed.`);
}

// ---------------------------------------------------------------------------
// Copy dist files (always runs)
// ---------------------------------------------------------------------------

console.log('\nCopying dist files to plugin directory...');
fs.mkdirSync(pluginDir, { recursive: true });

for (const file of ['main.js', 'styles.css', 'manifest.json']) {
  const src = path.join(repoRoot, 'dist', file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(pluginDir, file));
  } else {
    console.warn(`  Warning: dist/${file} not found, skipping`);
  }
}

// ---------------------------------------------------------------------------
// Final output
// ---------------------------------------------------------------------------

const homeRelative = vaultPath.replace(os.homedir(), '~');
console.log(`
Test vault ready: ${homeRelative}

  First open: Obsidian will prompt to enable community plugins — click "Turn off Restricted Mode" once.
  To reload plugin after changes: run with --update, then Cmd+R in Obsidian (or use BRAT's reload command).

Vault path: ${vaultPath}
`);

if (open) {
  // Open by filesystem path — more reliable than ?vault=<name> which requires
  // a matching "name" field in obsidian.json (not present in auto-registered vaults).
  console.log(`Opening: ${vaultPath}`);
  execSync(`open -a Obsidian "${vaultPath}"`);
}

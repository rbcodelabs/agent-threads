/**
 * create-test-vault.mjs
 *
 * Spins up an isolated Geode test vault with the current plugin build
 * installed under .geode/plugins, listed in Geode's recent vaults, and
 * pre-seeded with notes about the current branch/changes.
 *
 * Usage:
 *   node scripts/create-test-vault.mjs [--update] [--open] [--name <n>]
 *
 *   --update / -u   Rebuild and re-copy dist only; don't recreate vault structure or notes
 *   --open   / -o   Open vault in Geode after finishing
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
const geodeDir  = path.join(vaultPath, '.geode');
const pluginDir = path.join(geodeDir, 'plugins', 'claude-threads');

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

  // .geode/app.json
  fs.writeFileSync(path.join(geodeDir, 'app.json'), '{}\n');

  // .geode/plugins.json — ids of enabled plugins
  fs.writeFileSync(
    path.join(geodeDir, 'plugins.json'),
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
// List the vault in Geode's recent vaults (best-effort)
// ---------------------------------------------------------------------------

const geodeJsonPath = path.join(
  os.homedir(),
  'Library', 'Application Support', 'geode', 'geode.json',
);

try {
  let geodeConfig = {};
  if (fs.existsSync(geodeJsonPath)) {
    geodeConfig = JSON.parse(fs.readFileSync(geodeJsonPath, 'utf8'));
  }
  const recent = geodeConfig.recentVaults ?? [];
  if (!recent.includes(vaultPath)) {
    // Leave lastVault alone: it decides which vault Geode launches into.
    geodeConfig.recentVaults = [vaultPath, ...recent];
    fs.mkdirSync(path.dirname(geodeJsonPath), { recursive: true });
    fs.writeFileSync(geodeJsonPath, JSON.stringify(geodeConfig, null, 2) + '\n');
    console.log(`\nAdded "${vaultName}" to Geode's recent vaults`);
  } else {
    console.log(`\nVault "${vaultName}" already in Geode's recent vaults`);
  }
} catch (err) {
  console.warn(`\nWarning: could not update Geode's recent vaults (${err.message}). Open it manually if needed.`);
}

// ---------------------------------------------------------------------------
// Copy dist files (always runs)
// ---------------------------------------------------------------------------

console.log('\nCopying dist files to plugin directory...');
fs.mkdirSync(pluginDir, { recursive: true });

fs.cpSync(path.join(repoRoot, 'dist', 'resources'), path.join(pluginDir, 'resources'), { recursive: true });
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

  To reload plugin after changes: run with --update, then use "Reload plugin (safe)" in Geode.

Vault path: ${vaultPath}
`);

if (open) {
  console.log(`Opening: ${vaultPath}`);
  execSync(`open -a Geode "${vaultPath}"`);
}

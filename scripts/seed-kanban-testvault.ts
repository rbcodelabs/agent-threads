#!/usr/bin/env node
/**
 * Seeds a test vault's claude-threads plugin data.json with fake threads and
 * projects spanning multiple folders, so the Kanban board has something to show
 * — including the folder-swimlane layout. Reuses the same fixtures the
 * screenshot harness uses.
 *
 * Usage: node scripts/seed-kanban-testvault.ts [vaultPath]
 *   vaultPath defaults to ~/.claude/test-vaults/ct-feat-kanban-folder-swimlanes
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DEFAULT_SETTINGS } from '../src/types.ts';
import { kanbanFixtureThreads, kanbanFixtureProjects } from '../test/harness/fixtures.ts';

const vaultPath =
  process.argv[2] ??
  path.join(os.homedir(), '.claude', 'test-vaults', 'ct-feat-kanban-folder-swimlanes');

const pluginDir = path.join(vaultPath, '.obsidian', 'plugins', 'claude-threads');
const dataPath = path.join(pluginDir, 'data.json');

if (!fs.existsSync(pluginDir)) {
  console.error(`Plugin dir not found: ${pluginDir}\nCreate the vault first: node scripts/create-test-vault.mjs`);
  process.exit(1);
}

// Don't persist vault notes/raw logs for these synthetic threads — keep the
// test vault clean and avoid the plugin trying to reconcile missing note files.
const data = {
  ...DEFAULT_SETTINGS,
  threads: kanbanFixtureThreads,
  projects: kanbanFixtureProjects,
  kanbanGroupBy: 'folder',
  saveThreadsToVault: false,
  saveRawLogs: false,
  hasSeenWelcome: true,
};

fs.writeFileSync(dataPath, JSON.stringify(data, null, 2) + '\n');

console.log(`Seeded ${kanbanFixtureThreads.length} threads across ${kanbanFixtureProjects.length} projects + 2 folder-derived lanes.`);
console.log(`Wrote: ${dataPath}`);
console.log(`Default view: Kanban grouped by folder.`);

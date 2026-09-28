#!/usr/bin/env node
/**
 * Run (or update) the Playwright screenshot suite on the canonical Linux
 * renderer from a Mac, without pushing.
 *
 * Why this exists: baselines are platform-neutral and rendered on Linux inside
 * the official Playwright container — the exact image CI uses
 * (.github/workflows/ci.yml). A Mac render will never match them, so running
 * `npm run test:screenshots` on a Mac is advisory at best. This script syncs
 * the working tree (including uncommitted edits) to a Linux host with podman,
 * runs the suite in that image there, and copies results back.
 *
 * Usage:
 *   npm run test:screenshots:remote                   # verify
 *   npm run test:screenshots:remote:update            # regenerate baselines
 *   npm run test:screenshots:remote -- -g "main view" # extra playwright args
 *
 * Env:
 *   SCREENSHOT_HOST   ssh host with podman (default: dev-builder)
 *
 * After --update, the regenerated test/screenshots/snapshots/ and docs/*.png
 * are copied back into this checkout. After a failed verify run, the HTML
 * report and diff images land in ./playwright-report and ./test-results.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.SCREENSHOT_HOST ?? 'dev-builder';

const rawArgs = process.argv.slice(2);
const update = rawArgs.includes('--update');
const playwrightArgs = rawArgs.filter((arg) => arg !== '--update');

// The image tag must equal the exactly-pinned @playwright/test version, or the
// container's browsers will not match the test runner.
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  devDependencies: Record<string, string>;
};
const playwrightVersion = pkg.devDependencies['@playwright/test'];
if (!/^\d+\.\d+\.\d+$/.test(playwrightVersion)) {
  fail(`@playwright/test must be pinned to an exact version (found "${playwrightVersion}").`);
}
const image = `mcr.microsoft.com/playwright:v${playwrightVersion}-noble`;

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'detached';
const remoteDir = `.cache/agent-threads-screenshots/${branch.replace(/[^A-Za-z0-9._-]/g, '_')}`;

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function fail(message: string): never {
  console.error(`screenshots-remote: ${message}`);
  process.exit(1);
}

function run(command: string, args: string[]): number {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  return result.status ?? 1;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// 1. Reachability — say plainly what the fallback costs.
if (run('ssh', ['-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes', host, 'command -v podman >/dev/null']) !== 0) {
  fail(
    `cannot reach "${host}" over ssh, or podman is not installed there.\n` +
      '  Fallback: `npm run test:screenshots` on this machine. On a Mac that result is ADVISORY ONLY —\n' +
      '  Mac renders do not match the Linux baselines. Trust the PR\'s "Screenshot Tests" CI job instead,\n' +
      '  and never commit baselines rendered on a Mac.',
  );
}

// 2. Sync the working tree (uncommitted edits included). Excluded paths are
//    left alone on the remote, so its Linux node_modules survives between runs.
const excludes = [
  '.git', 'node_modules', '.pnpm-store', '.worktrees', '.claude/worktrees', '.serena',
  'test/harness/dist', 'playwright-report', 'test-results', 'dist',
];
console.log(`screenshots-remote: syncing to ${host}:~/${remoteDir}`);
if (run('ssh', [host, `mkdir -p ${shellQuote(remoteDir)}`]) !== 0) fail('could not create remote directory.');
if (
  run('rsync', [
    '-az', '--delete',
    ...excludes.flatMap((pattern) => ['--exclude', pattern]),
    `${repoRoot}/`, `${host}:${remoteDir}/`,
  ]) !== 0
) {
  fail('rsync to the remote host failed.');
}

// 3. Run the suite in the same container image CI uses.
const npmScript = update ? 'test:screenshots:update' : 'test:screenshots';
const inner = [
  'npm ci --no-audit --no-fund --loglevel=error',
  `rm -rf playwright-report test-results`,
  `npm run ${npmScript}${playwrightArgs.length ? ' -- ' + playwrightArgs.map(shellQuote).join(' ') : ''}`,
].join(' && ');
const remoteCommand = [
  'cd', shellQuote(remoteDir), '&&',
  'podman', 'run', '--rm', '--ipc=host', '-e', 'CI=1',
  '-v', '"$PWD":/work', '-w', '/work', image,
  'bash', '-c', shellQuote(inner),
].join(' ');
console.log(`screenshots-remote: running ${npmScript} in ${image}`);
const status = run('ssh', [host, remoteCommand]);

// 4. Bring results home.
if (update) {
  // Only prune stale baselines on a full run; a filtered run must not delete
  // the baselines it did not render.
  const prune = playwrightArgs.length === 0 ? ['--delete'] : [];
  run('rsync', ['-az', ...prune, `${host}:${remoteDir}/test/screenshots/snapshots/`, `${repoRoot}/test/screenshots/snapshots/`]);
  run('rsync', ['-az', '--include', 'screenshot-*.png', '--exclude', '*', `${host}:${remoteDir}/docs/`, `${repoRoot}/docs/`]);
  console.log('screenshots-remote: regenerated baselines copied back — review `git status` before committing.');
}
if (status !== 0) {
  run('rsync', ['-az', '--delete', `${host}:${remoteDir}/playwright-report/`, `${repoRoot}/playwright-report/`]);
  run('rsync', ['-az', '--delete', `${host}:${remoteDir}/test-results/`, `${repoRoot}/test-results/`]);
  console.error('screenshots-remote: failures copied to ./playwright-report and ./test-results (npx playwright show-report).');
}
process.exit(status);

/**
 * Ensures a built Geode checkout at the commit pinned in test/real-app/geode-pin.json and prints its path.
 * Honors GEODE_REPO (use that checkout as-is: it must already contain packages/plugin-test and a build).
 * Otherwise clones/fetches into .geode-harness/ (gitignored), checks out the pin, installs and builds.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pin = JSON.parse(readFileSync(path.join(root, 'test/real-app/geode-pin.json'), 'utf8')) as { repo: string; ref: string };
const run = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 2, 2] });

export function ensureGeode(): string {
  if (process.env.GEODE_REPO) return process.env.GEODE_REPO;
  const dir = process.env.GEODE_HARNESS_DIR ?? path.join(root, '.geode-harness');
  if (!existsSync(path.join(dir, '.git'))) run('git', ['clone', pin.repo, dir], root);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  if (head !== pin.ref) {
    run('git', ['fetch', 'origin', pin.ref], dir);
    run('git', ['checkout', '--detach', pin.ref], dir);
  }
  const stamp = path.join(dir, '.harness-pin');
  const built = existsSync(stamp) && readFileSync(stamp, 'utf8') === pin.ref && existsSync(path.join(dir, 'dist/renderer.js'));
  if (!built) {
    run('npm', ['ci', '--no-audit', '--no-fund'], dir);
    run('npm', ['run', 'build'], dir);
    writeFileSync(stamp, pin.ref);
  }
  return dir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(ensureGeode());

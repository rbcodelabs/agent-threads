/** Real git against local bare repositories: no network, no credentials. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

export function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
}

export const tempDir = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

/** A bare repository with one commit on `main`; returns its path (usable as a clone URL when local URLs are allowed). */
export function makeRemote(base: string, name = 'remote'): string {
  const bare = join(base, `${name}.git`);
  mkdirSync(bare, { recursive: true });
  git(['init', '--bare', '-b', 'main', bare]);
  const seed = join(base, `${name}-seed`);
  git(['clone', bare, seed]);
  writeFileSync(join(seed, 'README.md'), 'hello\n');
  git(['add', '.'], seed);
  git(['commit', '-m', 'first'], seed);
  git(['push', 'origin', 'HEAD:main'], seed);
  return bare;
}

/** Add a commit to the remote's main (through a scratch clone). */
export function pushCommit(remote: string, base: string, file: string): void {
  const scratch = mkdtempSync(join(base, 'scratch-'));
  git(['clone', remote, scratch]);
  writeFileSync(join(scratch, file), `${file}\n`);
  git(['add', '.'], scratch);
  git(['commit', '-m', `add ${file}`], scratch);
  git(['push', 'origin', 'HEAD:main'], scratch);
}

/** Set every file and folder under `dir` to `ageDays` ago. */
export function age(dir: string, ageDays: number, now = Date.now()): void {
  const t = new Date(now - ageDays * 86_400_000);
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      utimesSync(p, t, t);
    }
    utimesSync(d, t, t);
  };
  walk(dir);
}

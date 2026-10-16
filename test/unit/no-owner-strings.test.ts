/**
 * This plugin ships to other people. The maintainer's own hosts, tailnet and
 * home directories must never appear in code, comments, docs, scripts, test
 * fixtures or screenshot fixtures; examples use neutral names (`my-server`,
 * `wss://my-server.tailnet-name.ts.net:8443`, `/home/user/vault`, `/srv/workspaces`).
 * The maintainer's own setup notes belong in their vault, not here.
 *
 * There is no allowlist. The denylist is assembled from fragments so this file
 * does not contain the strings it forbids.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');

const DENYLIST: string[] = [
  ['claude', 'box'].join('-'),
  ['rick', 'bowman'].join(''),
  ['/home', 'rick'].join('/'),
  ['/Users', 'rick/'].join('/'),
  ['taila', '7f'].join(''),
  ['100', '113', '251'].join('.'),
  ['geode', 'mac'].join('-'),
];

const SCANNED_DIRS = ['src', 'daemon', 'docs', 'scripts', 'process', 'test'];
const SCANNED_ROOT_FILES = ['README.md', 'CLAUDE.md', 'TODO.md'];

function trackedAndNewFiles(): string[] {
  // --others lists files not yet committed, so a fresh file is checked before it is ever pushed.
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...SCANNED_DIRS, ...SCANNED_ROOT_FILES], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  }).toString('utf8');
  return out.split('\0').filter(Boolean);
}

describe('no owner-specific strings in the repository', () => {
  it('finds no denylisted host, tailnet, address or home directory (file:line on failure)', () => {
    const hits: string[] = [];
    let scanned = 0;
    for (const file of trackedAndNewFiles()) {
      let buf: Buffer;
      try { buf = readFileSync(join(ROOT, file)); } catch { continue; } // deleted in the working tree
      if (buf.includes(0)) continue; // binary (screenshot baselines are checked via their fixtures)
      scanned++;
      const lines = buf.toString('utf8').split('\n');
      lines.forEach((line, i) => {
        const lower = line.toLowerCase();
        for (const needle of DENYLIST) {
          if (lower.includes(needle.toLowerCase())) hits.push(`${file}:${i + 1}: contains an owner-specific value (${needle.length} chars, starts "${needle.slice(0, 3)}")`);
        }
      });
    }
    expect(scanned, 'the scan must actually read files').toBeGreaterThan(100);
    expect(hits).toEqual([]);
  });

  it('the denylist itself is not spelled out in this file', () => {
    const self = readFileSync(__filename, 'utf8').toLowerCase();
    for (const needle of DENYLIST) expect(self.includes(needle.toLowerCase())).toBe(false);
  });
});

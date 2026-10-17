/**
 * Copying small file trees into the daemon container: the host-side tree walk, and the in-container copy script,
 * which is EXECUTED here with node (the same node the daemon image ships) against a temp data directory.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COPY_SCRIPT,
  copyFilesArgs,
  copyFilesToContainer,
  listDirArgs,
  nodeFs,
  readTree,
  removeDirArgs,
  shortHash,
  type FsLike,
} from '../../src/localDaemon/containerFiles';
import { DAEMON_UID, DATA_MOUNT } from '../../src/localDaemon/spec';
import type { VmCommandRunner } from '../../src/containerCli';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });
const tmp = (): string => { root = realpathSync(mkdtempSync(join(tmpdir(), 'cf-test-'))); return root; };

describe('readTree (real filesystem)', () => {
  it('reads files, keeps executable bits, follows symlinks, and skips .git and node_modules', () => {
    const r = tmp();
    mkdirSync(join(r, 'skills/a/scripts'), { recursive: true });
    writeFileSync(join(r, 'skills/a/SKILL.md'), '# a');
    writeFileSync(join(r, 'skills/a/scripts/run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    mkdirSync(join(r, 'skills/a/node_modules/x'), { recursive: true });
    writeFileSync(join(r, 'skills/a/node_modules/x/big.js'), 'x');
    mkdirSync(join(r, 'skills/a/.git'), { recursive: true });
    writeFileSync(join(r, 'skills/a/.git/HEAD'), 'ref');
    // a link into another tree (as ~/.claude/skills/x -> ../../.agents/skills/x)
    mkdirSync(join(r, 'agents/shared'), { recursive: true });
    writeFileSync(join(r, 'agents/shared/SKILL.md'), '# shared');
    symlinkSync(join(r, 'agents/shared'), join(r, 'skills/linked'));

    const t = readTree(nodeFs(), join(r, 'skills'));
    expect(t.files.map((f) => f.p).sort()).toEqual(['a/SKILL.md', 'a/scripts/run.sh', 'linked/SKILL.md']);
    expect(t.files.find((f) => f.p === 'a/scripts/run.sh')!.m).toBe(0o700);
    expect(t.files.find((f) => f.p === 'a/SKILL.md')!.m).toBe(0o600);
    expect(Buffer.from(t.files.find((f) => f.p === 'linked/SKILL.md')!.b, 'base64').toString()).toBe('# shared');
    expect(t.fingerprint).toContain('a/SKILL.md:3:');
  });

  it('cuts symlink cycles and respects the file and byte limits, listing what it skipped', () => {
    const r = tmp();
    mkdirSync(join(r, 'd'), { recursive: true });
    symlinkSync(join(r, 'd'), join(r, 'd/self'));
    for (const n of ['1', '2', '3']) writeFileSync(join(r, 'd', n), 'xxxx');
    const t = readTree(nodeFs(), join(r, 'd'), { maxFiles: 2, maxBytes: 1000, maxDepth: 5 });
    expect(t.files).toHaveLength(2);
    expect(t.skipped).toEqual(['3']);
    const small = readTree(nodeFs(), join(r, 'd'), { maxFiles: 10, maxBytes: 5, maxDepth: 5 });
    expect(small.files).toHaveLength(1);
  });

  it('a changed file changes the fingerprint; an unchanged tree does not', () => {
    const r = tmp();
    writeFileSync(join(r, 'f'), 'one');
    const a = readTree(nodeFs(), r).fingerprint;
    expect(readTree(nodeFs(), r).fingerprint).toBe(a);
    writeFileSync(join(r, 'f'), 'longer content');
    expect(readTree(nodeFs(), r).fingerprint).not.toBe(a);
  });

  it('works over an injected filesystem and survives unreadable entries', () => {
    const fs: FsLike = {
      realpath: (p) => p,
      readdir: (p) => (p === '/r' ? ['ok', 'bad', 'dir'] : ['inner']),
      stat: (p) => (p === '/r/dir' ? { dir: true, file: false, size: 0, mtimeMs: 0, mode: 0o755 }
        : p === '/r/bad' ? null : { dir: false, file: true, size: 2, mtimeMs: 5, mode: 0o644 }),
      readBase64: (p) => { if (p.endsWith('inner')) throw new Error('EACCES'); return 'b2s='; },
    };
    const t = readTree(fs, '/r');
    expect(t.files.map((f) => f.p)).toEqual(['ok']);
  });
});

describe('copy script (executed)', () => {
  const run = (data: string, payload: unknown) =>
    spawnSync(process.execPath, ['-e', COPY_SCRIPT, data], { input: JSON.stringify(payload), encoding: 'utf8' });

  it('writes files with their modes under the destination, creating directories', () => {
    const data = tmp();
    const dest = join(data, 'skills/x-1');
    const r = run(data, { dest, clean: false, files: [
      { p: 'SKILL.md', b: Buffer.from('hello').toString('base64') },
      { p: 'scripts/run.sh', b: Buffer.from('#!/bin/sh').toString('base64'), m: 0o700 },
    ] });
    expect(r.status).toBe(0);
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe('hello');
    expect(statSync(join(dest, 'scripts/run.sh')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dest, 'SKILL.md')).mode & 0o777).toBe(0o600);
  });

  it('clean replaces the destination, dropping files that are no longer sent', () => {
    const data = tmp();
    const dest = join(data, 'home/.aws');
    run(data, { dest, clean: true, files: [{ p: 'config', b: Buffer.from('a').toString('base64') }, { p: 'sso/cache/old.json', b: Buffer.from('o').toString('base64') }] });
    run(data, { dest, clean: true, files: [{ p: 'config', b: Buffer.from('b').toString('base64') }] });
    expect(readFileSync(join(dest, 'config'), 'utf8')).toBe('b');
    expect(existsSync(join(dest, 'sso/cache/old.json'))).toBe(false);
  });

  it('refuses a destination outside the data directory and a file path that escapes the destination', () => {
    const data = tmp();
    const bad = run(data, { dest: '/tmp/elsewhere', clean: false, files: [] });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('outside the data directory');
    const traversal = run(data, { dest: join(data, 'skills/x'), clean: false, files: [{ p: '../../escape', b: 'eA==' }] });
    expect(traversal.status).toBe(2);
    expect(existsSync(join(data, 'escape'))).toBe(false);
    const sibling = run(data, { dest: `${data}-sibling/x`, clean: false, files: [] });
    expect(sibling.status).toBe(2);
  });
});

describe('argv and the runner seam', () => {
  it('runs node as the daemon user with the data directory as its only argument, nothing secret in argv', async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const run: VmCommandRunner = async (args, opts) => { calls.push({ args, input: opts.input }); return { exitCode: 0, stdout: '', stderr: '' }; };
    await copyFilesToContainer(run, 'c1', `${DATA_MOUNT}/skills/x`, [{ p: 'f', b: Buffer.from('SECRET').toString('base64') }], { clean: true });
    expect(calls[0].args.slice(0, 5)).toEqual(['exec', '-i', '--user', String(DAEMON_UID), 'c1']);
    expect(calls[0].args.at(-1)).toBe(DATA_MOUNT);
    expect(JSON.stringify(calls[0].args)).not.toContain(Buffer.from('SECRET').toString('base64'));
    expect(JSON.parse(calls[0].input!)).toMatchObject({ dest: `${DATA_MOUNT}/skills/x`, clean: true });
    expect(copyFilesArgs('c1')).toContain('node');
    expect(listDirArgs('c1', '/a b')).toContain("ls -1 '/a b' 2>/dev/null || true");
    expect(removeDirArgs('c1', '/x')).toEqual(['exec', '--user', '10001', 'c1', 'rm', '-rf', '/x']);
  });

  it('reports the tail of stderr when the copy fails', async () => {
    const run: VmCommandRunner = async () => ({ exitCode: 2, stdout: '', stderr: 'a\nb\ndestination outside the data directory\n' });
    await expect(copyFilesToContainer(run, 'c', '/x', [])).rejects.toThrow(/exit 2.*destination outside/);
  });

  it('shortHash is stable and sensitive to its input', () => {
    expect(shortHash('a')).toBe(shortHash('a'));
    expect(shortHash('a')).not.toBe(shortHash('b'));
    expect(shortHash('a')).toMatch(/^[0-9a-f]{12}$/);
  });
});


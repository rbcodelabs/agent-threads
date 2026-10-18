import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredStore } from '../../daemon/credStore';
import { RepoError, ReposManager, askpassScript, repoHost, repoUrlProblem, type GitRunner } from '../../daemon/repos';
import { git, makeRemote, pushCommit, tempDir } from '../helpers/gitFixtures';
import type { RepoSpec } from '../../src/protocol';

let base: string;
let dataDir: string;
let root: string;
let stored: RepoSpec[];

beforeEach(() => {
  base = tempDir('repos-base-');
  dataDir = tempDir('repos-data-');
  root = join(dataDir, 'workspace');
  stored = [];
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

const manager = (extra: Partial<ConstructorParameters<typeof ReposManager>[0]> = {}): ReposManager => new ReposManager({
  dataDir, root, creds: new CredStore(dataDir), getRepos: () => stored, setRepos: (r) => { stored = r; }, allowLocalUrls: true, ...extra,
});

describe('repoUrlProblem', () => {
  it('accepts https, ssh and scp-like remotes', () => {
    for (const url of ['https://github.com/o/r.git', 'ssh://git@github.com/o/r.git', 'git@github.com:o/r.git']) expect(repoUrlProblem(url, false)).toBeNull();
  });
  it('refuses credentials in the URL, other transports and (by default) local paths', () => {
    expect(repoUrlProblem('https://user:pw@github.com/o/r.git', false)).toMatch(/credentials/);
    expect(repoUrlProblem('https://ghp_abc@github.com/o/r.git', false)).toMatch(/credentials/);
    expect(repoUrlProblem('ext::sh -c evil', false)).not.toBeNull();
    expect(repoUrlProblem('http://github.com/o/r.git', false)).not.toBeNull();
    expect(repoUrlProblem('/srv/other/repo', false)).toMatch(/local paths/);
    expect(repoUrlProblem('/srv/other/repo', true)).toBeNull();
  });
  it('finds the host', () => {
    expect(repoHost('https://GitHub.com/o/r')).toBe('github.com');
    expect(repoHost('git@gitlab.example.com:o/r.git')).toBe('gitlab.example.com');
    expect(repoHost('/srv/x')).toBeUndefined();
  });
});

describe('askpassScript', () => {
  const run = (hosts: string[], prompt: string, token = 'tok-123'): { out: string; code: number } => {
    const file = join(base, 'askpass.sh');
    writeFileSync(file, askpassScript(hosts), { mode: 0o700 });
    try {
      return { out: execFileSync('sh', [file, prompt], { env: { AGENT_THREADS_GIT_PASSWORD: token, PATH: process.env.PATH }, encoding: 'utf8' }).trim(), code: 0 };
    } catch (e) {
      return { out: '', code: (e as { status: number }).status };
    }
  };
  it('answers the username and password prompts for a configured host', () => {
    expect(run(['github.com'], "Username for 'https://github.com': ").out).toBe('x-access-token');
    expect(run(['github.com'], "Password for 'https://x-access-token@github.com': ").out).toBe('tok-123');
    expect(run(['github.com'], "Password for 'https://github.com/owner/repo': ").out).toBe('tok-123');
  });
  it('gives nothing to another host, including look-alikes', () => {
    expect(run(['github.com'], "Password for 'https://evil.example': ").code).toBe(1);
    expect(run(['github.com'], "Password for 'https://github.com.evil.example': ").code).toBe(1);
    expect(run(['github.com'], "Password for 'https://evilgithub.com': ").code).toBe(1);
  });
  it('drops host names that could break out of the pattern', () => {
    expect(run(['x; rm -rf /'], "Password for 'https://x': ").code).toBe(1);
  });
});

describe('ReposManager with real git and a local remote', () => {
  it('clones a missing repository and reports it cloned', async () => {
    const remote = makeRemote(base);
    const m = manager();
    const reply = await m.sync([{ name: 'proj', url: remote }], true);
    expect(reply.root).toBe(root);
    expect(reply.repos[0]).toMatchObject({ name: 'proj', state: 'cloned', path: join(root, 'proj') });
    expect(readFileSync(join(root, 'proj', 'README.md'), 'utf8')).toBe('hello\n');
    expect(stored).toEqual([{ name: 'proj', url: remote }]);
    expect(reply.repos[0].syncedAt).toBeGreaterThan(0);
  });

  it('fetches and fast-forwards a clean checkout; a later status survives a new manager', async () => {
    const remote = makeRemote(base);
    await manager().sync([{ name: 'proj', url: remote, branch: 'main' }], true);
    pushCommit(remote, base, 'second.txt');
    const m = manager();
    expect((await m.sync(undefined, true)).repos[0].state).toBe('cloned');
    expect(existsSync(join(root, 'proj', 'second.txt'))).toBe(true);
    expect(manager().status().repos[0].state).toBe('cloned');
  });

  it('leaves a dirty checkout alone but still fetches', async () => {
    const remote = makeRemote(base);
    const m = manager();
    await m.sync([{ name: 'proj', url: remote }], true);
    writeFileSync(join(root, 'proj', 'README.md'), 'edited\n');
    pushCommit(remote, base, 'third.txt');
    await m.sync(undefined, true);
    expect(readFileSync(join(root, 'proj', 'README.md'), 'utf8')).toBe('edited\n');
    expect(existsSync(join(root, 'proj', 'third.txt'))).toBe(false);
    expect(git(['rev-parse', 'origin/main'], join(root, 'proj'))).not.toBe(git(['rev-parse', 'HEAD'], join(root, 'proj')));
  });

  it('is stale when the last good fetch is old, and not_cloned before any sync', async () => {
    const remote = makeRemote(base);
    let now = 1_000_000;
    const m = manager({ now: () => now, staleAfterMs: 1000 });
    stored = [{ name: 'proj', url: remote }];
    expect(m.status().repos[0].state).toBe('not_cloned');
    await m.sync(undefined, true);
    expect(m.status().repos[0].state).toBe('cloned');
    now += 5000;
    expect(m.status().repos[0].state).toBe('stale');
  });

  it('reports a failed clone as error with the git message, and keeps no half-clone', async () => {
    const m = manager();
    const reply = await m.sync([{ name: 'nope', url: join(base, 'missing.git') }], true);
    expect(reply.repos[0].state).toBe('error');
    expect(reply.repos[0].error).toBeTruthy();
    expect(existsSync(join(root, 'nope'))).toBe(false);
    expect(execFileSync('ls', ['-A', root], { encoding: 'utf8' }).trim()).toBe('');
  });

  it('refuses a name that is a non-empty non-git folder', async () => {
    const remote = makeRemote(base);
    writeFileSync(join(base, 'file'), 'x');
    const m = manager();
    await m.sync([{ name: 'proj', url: remote }], true);
    rmSync(join(root, 'proj', '.git'), { recursive: true, force: true });
    const reply = await m.sync(undefined, true);
    expect(reply.repos[0].state).toBe('error');
    expect(reply.repos[0].error).toMatch(/not a git repository/);
  });

  it('rejects bad specs without changing the stored list', async () => {
    const m = manager({ allowLocalUrls: false });
    stored = [{ name: 'keep', url: 'https://github.com/o/keep.git' }];
    await expect(m.sync([{ name: '../x', url: 'https://github.com/o/r' }])).rejects.toBeInstanceOf(RepoError);
    await expect(m.sync([{ name: 'a', url: 'https://tok@github.com/o/r' }])).rejects.toThrow(/credentials/);
    await expect(m.sync([{ name: 'a', url: '/etc' }])).rejects.toThrow(/local paths/);
    await expect(m.sync([{ name: 'a', url: 'https://github.com/o/r' }, { name: 'A', url: 'https://github.com/o/r2' }])).rejects.toThrow(/used twice/);
    expect(stored).toEqual([{ name: 'keep', url: 'https://github.com/o/keep.git' }]);
  });

  it('keeps the clone of a repository removed from the list', async () => {
    const remote = makeRemote(base);
    const m = manager();
    await m.sync([{ name: 'proj', url: remote }], true);
    await m.sync([], true);
    expect(m.status().repos).toEqual([]);
    expect(existsSync(join(root, 'proj', '.git'))).toBe(true);
  });

  it('refreshForCwd fetches a stale clone in the background and ignores other folders', async () => {
    const remote = makeRemote(base);
    let now = 1_000;
    const m = manager({ now: () => now, refreshMinGapMs: 100 });
    await m.sync([{ name: 'proj', url: remote }], true);
    pushCommit(remote, base, 'late.txt');
    m.refreshForCwd(join(base, 'elsewhere'));
    m.refreshForCwd(join(root, 'proj', 'sub'));
    expect(m.status().repos[0].state).toBe('cloned'); // within the gap: not refetched
    now += 1000;
    m.refreshForCwd(join(root, 'proj'));
    expect(m.status().repos[0].state).toBe('syncing');
    await m.sync(undefined, true);
    expect(existsSync(join(root, 'proj', 'late.txt'))).toBe(true);
  });
});

describe('ReposManager authentication', () => {
  const TOKEN = 'ghp_SECRETTOKENVALUE0123456789';
  interface Call { args: string[]; env: NodeJS.ProcessEnv }
  const recording = (fail?: string): { runner: GitRunner; calls: Call[] } => {
    const calls: Call[] = [];
    const runner: GitRunner = async (args, opts) => {
      calls.push({ args, env: opts.env });
      if (fail && args.includes('clone')) throw new Error(fail);
      return { stdout: '', stderr: '' };
    };
    return { runner, calls };
  };
  const withToken = (): CredStore => {
    const creds = new CredStore(dataDir);
    creds.push('github', 0, { GH_TOKEN: TOKEN });
    return creds;
  };

  it('hands the token to git only through the environment, via a 0700 askpass script', async () => {
    const { runner, calls } = recording();
    const m = manager({ git: runner, creds: withToken() });
    await m.sync([{ name: 'p', url: 'https://github.com/o/p.git' }], true);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(JSON.stringify(c.args)).not.toContain(TOKEN);
      expect(c.args.join(' ')).not.toMatch(/x-access-token|@github/);
    }
    const clone = calls.find((c) => c.args.includes('clone'))!;
    expect(clone.env.AGENT_THREADS_GIT_PASSWORD).toBe(TOKEN);
    expect(clone.env.GIT_TERMINAL_PROMPT).toBe('0');
    const script = clone.env.GIT_ASKPASS!;
    expect(statSync(script).mode & 0o777).toBe(0o700);
    expect(readFileSync(script, 'utf8')).not.toContain(TOKEN);
    expect(readFileSync(script, 'utf8')).toContain('github.com');
  });

  it('classifies a refused token as auth_failed and never repeats the token', async () => {
    const { runner } = recording(`remote: Invalid username or password.\nfatal: Authentication failed for 'https://x-access-token:${TOKEN}@github.com/o/p.git/'`);
    const m = manager({ git: runner, creds: withToken() });
    const reply = await m.sync([{ name: 'p', url: 'https://github.com/o/p.git' }], true);
    expect(reply.repos[0].state).toBe('auth_failed');
    expect(JSON.stringify(reply)).not.toContain(TOKEN);
    expect(readFileSync(join(dataDir, 'repos-state.json'), 'utf8')).not.toContain(TOKEN);
  });

  it('says so when auth fails because no token was ever pushed', async () => {
    const { runner } = recording('fatal: could not read Username for \'https://github.com\': terminal prompts disabled');
    const m = manager({ git: runner });
    const reply = await m.sync([{ name: 'p', url: 'https://github.com/o/p.git' }], true);
    expect(reply.repos[0].state).toBe('auth_failed');
    expect(reply.repos[0].error).toContain('creds push github GH_TOKEN');
  });

  it('a later good sync clears auth_failed', async () => {
    let fail = true;
    const runner: GitRunner = async (args) => {
      if (args.includes('clone')) {
        if (fail) throw new Error('fatal: Authentication failed');
        mkdirSync(join(args.at(-1)!, '.git'), { recursive: true });
      }
      return { stdout: '', stderr: '' };
    };
    const m = manager({ git: runner, creds: withToken() });
    stored = [{ name: 'p', url: 'https://github.com/o/p.git' }];
    expect((await m.sync(undefined, true)).repos[0].state).toBe('auth_failed');
    fail = false;
    expect((await m.sync(undefined, true)).repos[0]).toMatchObject({ state: 'cloned' });
  });

  it('sessionEnv carries GH_TOKEN and the askpass wiring only when a token is stored', () => {
    expect(manager().sessionEnv()).toEqual({});
    const env = manager({ creds: withToken() }).sessionEnv();
    expect(env.GH_TOKEN).toBe(TOKEN);
    expect(env.GIT_ASKPASS).toBeTruthy();
    expect(env.AGENT_THREADS_GIT_PASSWORD).toBe(TOKEN);
  });

  it('an expired or removed token stops being used', () => {
    const creds = withToken();
    creds.push('github', 0, {});
    expect(manager({ creds }).sessionEnv()).toEqual({});
  });
});

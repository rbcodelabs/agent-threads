import { describe, expect, it } from 'vitest';
import { DaemonCommandError } from '../../src/remote/DaemonClient';
import type { RemoteDaemonResolver } from '../../src/remote/DaemonRegistry';
import { createRemoteReposSource, defaultRepoName, describeRepo, formatRepoLines, parseRepoLines } from '../../src/remote/repos';

describe('defaultRepoName', () => {
  it('takes the last part of the URL without .git', () => {
    expect(defaultRepoName('https://github.com/o/agent-threads.git')).toBe('agent-threads');
    expect(defaultRepoName('git@github.com:o/thing')).toBe('thing');
    expect(defaultRepoName('https://github.com/o/r/')).toBe('r');
    expect(defaultRepoName('https://')).toBeUndefined();
  });
});

describe('parseRepoLines', () => {
  it('reads url, optional branch and optional name; skips blanks and comments', () => {
    const { repos, errors } = parseRepoLines('# mine\n\nhttps://github.com/o/a.git\nhttps://github.com/o/b.git develop\nhttps://github.com/o/c.git main as see\n');
    expect(errors).toEqual([]);
    expect(repos).toEqual([
      { name: 'a', url: 'https://github.com/o/a.git' },
      { name: 'b', url: 'https://github.com/o/b.git', branch: 'develop' },
      { name: 'see', url: 'https://github.com/o/c.git', branch: 'main' },
    ]);
  });
  it('reports bad lines with their numbers and keeps the good ones', () => {
    const { repos, errors } = parseRepoLines('https://u:pw@github.com/o/a.git\nhttps://github.com/o/b.git x y\nhttps://github.com/o/ok.git\nhttps://github.com/p/ok.git\nhttps://\n');
    expect(repos.map((r) => r.name)).toEqual(['ok']);
    expect(errors).toEqual([
      'Line 1: remove the credentials from the URL; the token is stored on the daemon',
      'Line 2: unexpected "y"',
      'Line 4: the name "ok" is used twice',
      'Line 5: could not derive a name from the URL; add "as <name>"',
    ]);
  });
  it('round-trips through formatRepoLines', () => {
    const repos = [{ name: 'a', url: 'https://github.com/o/a.git' }, { name: 'x', url: 'https://github.com/o/b.git', branch: 'dev' }];
    expect(formatRepoLines(repos)).toBe('https://github.com/o/a.git\nhttps://github.com/o/b.git dev as x');
    expect(parseRepoLines(formatRepoLines(repos)).repos).toEqual(repos);
  });
});

describe('describeRepo', () => {
  const base = { name: 'r', url: 'u', path: '/p' };
  it('flags everything except cloned and syncing as a problem', () => {
    const now = 10_000_000;
    expect(describeRepo({ ...base, state: 'cloned', syncedAt: now - 5 * 60_000 }, now)).toEqual({ text: 'r: cloned · fetched 5 min ago', ok: true });
    expect(describeRepo({ ...base, state: 'syncing' }, now).ok).toBe(true);
    expect(describeRepo({ ...base, state: 'auth_failed', error: 'Authentication failed' }, now)).toEqual({ text: 'r: auth failed (Authentication failed)', ok: false });
    expect(describeRepo({ ...base, state: 'stale', syncedAt: now - 3 * 86_400_000 }, now)).toEqual({ text: 'r: stale · fetched 3 d ago', ok: false });
    expect(describeRepo({ ...base, state: 'not_cloned' }, now).ok).toBe(false);
  });
});

describe('createRemoteReposSource', () => {
  const resolver = (command: (type: string, args: unknown) => Promise<unknown>): RemoteDaemonResolver => ({
    clientFor: (id) => (id === 'd' ? ({ command } as never) : undefined),
    nameOf: (id) => id,
  });
  it('returns the reply and passes the repos through', async () => {
    const seen: unknown[] = [];
    const src = createRemoteReposSource(resolver(async (type, args) => { seen.push([type, args]); return { root: '/w', repos: [{ name: 'a', url: 'u', path: '/w/a', state: 'cloned' }] }; }));
    expect(await src.status('d')).toMatchObject({ ok: true, value: { root: '/w', repos: [{ name: 'a' }] } });
    await src.sync('d', [{ name: 'a', url: 'u' }]);
    expect(seen).toEqual([['repos.status', {}], ['repos.sync', { repos: [{ name: 'a', url: 'u' }] }]]);
  });
  it('turns daemon refusals into values with a reason', async () => {
    const fail = (code: string) => createRemoteReposSource(resolver(async () => { throw new DaemonCommandError(code as never, `boom ${code}`); }));
    expect(await fail('unknown_command').status('d')).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(await fail('forbidden').sync('d')).toMatchObject({ ok: false, reason: 'forbidden', detail: expect.stringContaining('admin token') });
    expect(await fail('bad_frame').sync('d')).toMatchObject({ ok: false, reason: 'error', detail: 'boom bad_frame' });
    expect(await fail('bad_frame').status('nobody')).toMatchObject({ ok: false, reason: 'error' });
  });
});

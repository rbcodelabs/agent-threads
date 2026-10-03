import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import type { SkillSource } from '../../src/types';

vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));

import { setGitAuthProvider, setGitHttpClient } from '../../src/gitClient';
import { createGithubGitAuth, githubRepoFromUrl } from '../../src/skillSourceGithubAuth';
import { GithubConnectionError, repoNotGrantedError } from '../../src/githubCredentials';
import { autoUpdateGithubSources, cloneGithubSource } from '../../src/skillManager';
import { createLocalGitHttp, localGitUrl } from '../helpers/localGitHttp';

const TOKEN = 'ghs_SECRET_installation_token';

const git = (cwd: string, cmd: string) =>
  execSync(`git -C "${cwd}" -c user.email=t@t -c user.name=t ${cmd}`, { stdio: 'pipe' }).toString();

afterAll(() => {
  setGitHttpClient(undefined);
  setGitAuthProvider(undefined);
});

describe('githubRepoFromUrl', () => {
  it('returns owner/repo for https github.com URLs only', () => {
    expect(githubRepoFromUrl('https://github.com/acme/skills.git')).toBe('acme/skills');
    expect(githubRepoFromUrl('https://GitHub.com/acme/skills/')).toBe('acme/skills');
    expect(githubRepoFromUrl('http://github.com/acme/skills')).toBeNull();
    expect(githubRepoFromUrl('https://github.com.evil.test/acme/skills')).toBeNull();
    expect(githubRepoFromUrl('https://evil.test/github.com/acme/skills')).toBeNull();
    expect(githubRepoFromUrl('https://user:pw@github.com/acme/skills')).toBeNull();
    expect(githubRepoFromUrl('https://github.com/acme')).toBeNull();
    expect(githubRepoFromUrl('not a url')).toBeNull();
  });
});

describe('private skill sources via the GitHub connection', () => {
  let tmp: string;
  let origin: string;
  let requests: { url: string; authed: boolean }[];
  let broker: { available: boolean; getToken: ReturnType<typeof vi.fn>; requireRepo: ReturnType<typeof vi.fn> };
  let enabled: boolean;

  const useTransport = (opts: { requireToken?: string } = { requireToken: TOKEN }) => {
    requests = [];
    setGitHttpClient(createLocalGitHttp({
      mapPath: (p) => (p === '/acme/private' ? origin : undefined),
      onRequest: (r) => requests.push(r),
      ...opts,
    }));
  };

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ghauth-')));
    origin = path.join(tmp, 'origin');
    fs.mkdirSync(origin);
    git(origin, 'init -q -b main');
    fs.writeFileSync(path.join(origin, 'a'), 'a');
    git(origin, 'add -A');
    git(origin, 'commit -q -m a');
    enabled = true;
    broker = {
      available: true,
      getToken: vi.fn(async () => TOKEN),
      requireRepo: vi.fn(async () => ({ covered: true, installationId: 1, installUrl: null })),
    };
    setGitAuthProvider(createGithubGitAuth({ broker: broker as never, isEnabled: () => enabled }));
    useTransport();
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const clonePrivate = (dest = path.join(tmp, 'clone')) => cloneGithubSource('https://github.com/acme/private', dest).then(() => dest);

  it('clones a private repo using the connection token, sent on every request after the 401', async () => {
    const dest = await clonePrivate();
    expect(fs.existsSync(path.join(dest, 'a'))).toBe(true);
    expect(broker.getToken).toHaveBeenCalledTimes(1);
    expect(requests[0].authed).toBe(false); // anonymous first
    expect(requests.slice(1).every((r) => r.authed)).toBe(true);
  });

  it('updates a private clone with the token too', async () => {
    const dest = await clonePrivate();
    fs.writeFileSync(path.join(origin, 'b'), 'b');
    git(origin, 'add -A');
    git(origin, 'commit -q -m b');
    const source = { id: 's', name: 'S', type: 'github', repoUrl: 'https://github.com/acme/private', clonePath: dest } as SkillSource;
    const r = await autoUpdateGithubSources([source]);
    expect(r.failed).toEqual([]);
    expect(r.updated).toHaveLength(1);
    expect(fs.existsSync(path.join(dest, 'b'))).toBe(true);
  });

  it('never asks for a token when the repo is public', async () => {
    useTransport({});
    await clonePrivate();
    expect(broker.getToken).not.toHaveBeenCalled();
  });

  it('never sends the token to a host other than github.com', async () => {
    setGitHttpClient(createLocalGitHttp({ requireToken: TOKEN, onRequest: (r) => requests.push(r) }));
    await expect(cloneGithubSource(localGitUrl(origin), path.join(tmp, 'c'))).rejects.toThrow(/HTTP Error: 401/);
    expect(broker.getToken).not.toHaveBeenCalled();
    expect(requests.every((r) => !r.authed)).toBe(true);
  });

  it('stays anonymous when the connection is turned off, and says how to fix it', async () => {
    enabled = false;
    await expect(clonePrivate()).rejects.toThrow(/private.*connect GitHub/i);
    expect(broker.getToken).not.toHaveBeenCalled();
  });

  it('stays anonymous when there is no GitHub bridge (Obsidian / old Geode)', async () => {
    broker.available = false;
    await expect(clonePrivate()).rejects.toThrow(/private.*connect GitHub/i);
    expect(broker.getToken).not.toHaveBeenCalled();
  });

  it('surfaces the actionable error when GitHub is not connected', async () => {
    broker.getToken.mockRejectedValue(new GithubConnectionError('not_connected', 'GitHub is not connected. Open Geode → Settings → GitHub and choose Connect, then retry.'));
    const err = await clonePrivate().catch((e) => e);
    expect(err).toBeInstanceOf(GithubConnectionError);
    expect(err.message).toMatch(/GitHub is not connected/);
    expect(fs.existsSync(path.join(tmp, 'clone'))).toBe(false);
  });

  it('points at the install URL when the App cannot see the repo', async () => {
    useTransport({ requireToken: 'a-different-token' }); // our token is rejected
    broker.requireRepo.mockRejectedValue(repoNotGrantedError('acme/private', 'https://github.com/apps/geode/installations/new'));
    const err = await clonePrivate().catch((e) => e);
    expect(err).toBeInstanceOf(GithubConnectionError);
    expect(err.message).toContain('https://github.com/apps/geode/installations/new');
    expect(broker.requireRepo).toHaveBeenCalledWith('acme/private');
  });

  it('never puts the token in an error message', async () => {
    useTransport({ requireToken: 'a-different-token' });
    const err = await clonePrivate().catch((e) => e);
    expect(String(err.message)).not.toContain(TOKEN);
    expect(String(err.stack)).not.toContain(TOKEN);
  });
});

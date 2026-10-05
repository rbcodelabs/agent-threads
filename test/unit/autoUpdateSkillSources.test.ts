import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import type { SkillSource } from '../../src/types';
import { setGitHttpClient } from '../../src/gitClient';
import { localGitHttp, localGitUrl } from '../helpers/localGitHttp';

vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));

import { autoUpdateGithubSources, cloneGithubSource } from '../../src/skillManager';

beforeAll(() => setGitHttpClient(localGitHttp));
afterAll(() => setGitHttpClient(undefined));

const git = (cwd: string, cmd: string) =>
  execSync(`git -C "${cwd}" -c user.email=t@t -c user.name=t ${cmd}`, { stdio: 'pipe' }).toString();

describe('autoUpdateGithubSources', () => {
  let tmp: string;
  let origin: string;
  let clone: string;
  const mk = (over: Partial<SkillSource> = {}): SkillSource => ({
    id: 's1', name: 'S1', type: 'github', repoUrl: 'x/y', clonePath: clone, ...over,
  } as SkillSource);
  const commit = (file: string) => {
    fs.writeFileSync(path.join(origin, file), file);
    git(origin, 'add -A');
    git(origin, `commit -q -m ${file}`);
  };

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autoupd-')));
    origin = path.join(tmp, 'origin');
    clone = path.join(tmp, 'clone');
    fs.mkdirSync(origin);
    git(origin, 'init -q -b main');
    commit('a');
    execSync(`git clone -q "${origin}" "${clone}"`);
    git(clone, `remote set-url origin ${localGitUrl(origin)}`);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('fast-forwards a source that is behind', async () => {
    commit('b');
    const src = mk();
    const r = await autoUpdateGithubSources([src]);
    expect(r.updated).toEqual([{ id: 's1', name: 'S1', behindCount: 1 }]);
    expect(fs.existsSync(path.join(clone, 'b'))).toBe(true);
    expect(src.behindCount).toBe(0);
    expect(r.changed).toBe(true);
  });

  it('reports current sources without pulling', async () => {
    const r = await autoUpdateGithubSources([mk()]);
    expect(r.updated).toEqual([]);
    expect(r.current).toEqual(['s1']);
  });

  it('fails (without merging) when the clone has diverged', async () => {
    commit('b');
    fs.writeFileSync(path.join(clone, 'local'), 'x');
    git(clone, 'add -A');
    git(clone, 'commit -q -m local');
    const r = await autoUpdateGithubSources([mk()]);
    expect(r.updated).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(fs.existsSync(path.join(clone, 'b'))).toBe(false);
  });

  it('skips pinned, local, and missing-clone sources', async () => {
    commit('b');
    const r = await autoUpdateGithubSources([
      mk({ ref: 'v1' }),
      { id: 'l', name: 'L', type: 'local' } as SkillSource,
      mk({ id: 'gone', clonePath: path.join(tmp, 'nope') }),
    ]);
    expect(r).toEqual({ updated: [], current: [], failed: [], changed: false });
    expect(fs.existsSync(path.join(clone, 'b'))).toBe(false);
  });

  it('records an error for an unreachable origin without throwing', async () => {
    fs.rmSync(origin, { recursive: true, force: true });
    const r = await autoUpdateGithubSources([mk()]);
    expect(r.failed).toHaveLength(1);
  });

  it('does not overwrite a locally modified file that upstream also changed, and leaves the clone untouched', async () => {
    fs.writeFileSync(path.join(origin, 'a'), 'upstream change');
    git(origin, 'add -A');
    git(origin, 'commit -q -m a2');
    fs.writeFileSync(path.join(clone, 'a'), 'my edit');
    const r = await autoUpdateGithubSources([mk()]);
    expect(r.updated).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(fs.readFileSync(path.join(clone, 'a'), 'utf-8')).toBe('my edit');
    // The branch was put back, so there is no half-applied update.
    expect(git(clone, 'log --oneline').trim().split('\n')).toHaveLength(1);
  });

  describe('a clone made by the pure-JS client (no git binary involved in cloning)', () => {
    let jsClone: string;
    beforeEach(async () => {
      jsClone = path.join(tmp, 'jsclone');
      await cloneGithubSource(localGitUrl(origin), jsClone);
    });

    it('clones the default branch at depth 1', () => {
      expect(fs.existsSync(path.join(jsClone, 'a'))).toBe(true);
      expect(git(jsClone, 'rev-list --count HEAD').trim()).toBe('1');
    });

    it('fast-forwards, and removes files deleted upstream', async () => {
      commit('b');
      git(origin, 'rm -q a');
      git(origin, 'commit -q -m rm-a');
      const r = await autoUpdateGithubSources([mk({ clonePath: jsClone })]);
      expect(r.updated).toHaveLength(1);
      expect(fs.existsSync(path.join(jsClone, 'b'))).toBe(true);
      expect(fs.existsSync(path.join(jsClone, 'a'))).toBe(false);
    });

    it('treats a clone rolled back by hand as behind, and brings it forward', async () => {
      commit('b');
      await autoUpdateGithubSources([mk({ clonePath: jsClone })]); // now at b
      git(jsClone, `fetch -q --depth=2 "${origin}" main`);
      git(jsClone, 'reset -q --hard HEAD~1');
      expect(fs.existsSync(path.join(jsClone, 'b'))).toBe(false);
      const r = await autoUpdateGithubSources([mk({ clonePath: jsClone })]);
      expect(r.failed).toEqual([]);
      expect(r.updated).toHaveLength(1);
      expect(fs.existsSync(path.join(jsClone, 'b'))).toBe(true);
    });

    it('refuses to discard a local commit', async () => {
      fs.writeFileSync(path.join(jsClone, 'local'), 'x');
      git(jsClone, 'add -A');
      git(jsClone, 'commit -q -m local');
      commit('b');
      const r = await autoUpdateGithubSources([mk({ clonePath: jsClone })]);
      expect(r.updated).toEqual([]);
      expect(r.failed[0]?.error).toMatch(/local commits/);
      expect(fs.existsSync(path.join(jsClone, 'local'))).toBe(true);
      expect(fs.existsSync(path.join(jsClone, 'b'))).toBe(false);
    });
  });
});

describe('no git binary dependency', () => {
  it.each(['skillManager.ts', 'gitClient.ts', 'chiefOfStaffOnboarding.ts'])('%s does not shell out', (file) => {
    const src = fs.readFileSync(path.join(__dirname, '../../src', file), 'utf-8');
    expect(src).not.toMatch(/child_process|execSync|execFile/);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import type { SkillSource } from '../../src/types';

vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));

import { autoUpdateGithubSources } from '../../src/skillManager';

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
});

import { describe, expect, it } from 'vitest';
import { buildHostGitEnv, stripHostOnlyGitEnv } from '../../src/githubCredentialHelper';

describe('stripHostOnlyGitEnv', () => {
  it('removes every key buildHostGitEnv adds but keeps user secrets', () => {
    const host = buildHostGitEnv({ dir: '/tmp/x', baseEnv: { PATH: '/usr/bin' }, identity: { name: 'A', email: 'a@b.c' } });
    const out = stripHostOnlyGitEnv({ ...host, MY_SECRET: 's' });
    expect(out).toEqual({ MY_SECRET: 's' });
  });
});

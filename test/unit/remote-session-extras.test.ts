/**
 * The two session-spec fields the managed local daemon uses: `envKind` (the NAME of a credential kind) and
 * `pluginPaths` (guest paths of copied skills). Wire shape, projection and daemon policy.
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateSpec } from '../../daemon/sessionPolicy';
import { specToSessionOptions, sessionEnvFromCreds } from '../../daemon/claudeDriver';
import type { CredStore } from '../../daemon/credStore';
import { validateSpecShape, SESSION_ENV_KIND_PATTERN, type RemoteSessionSpec } from '../../src/protocol/spec';
import { projectSessionOptions } from '../../src/remote/sessionSpec';
import type { Thread } from '../../src/types';
import type { HarnessSessionOptions } from '../../src/HarnessSession';

const base = { harness: 'claude', cwd: '/srv/workspaces/p', permissionMode: 'default', extraEnvRaw: '' } as const;
const thread = { id: 't', remote: { daemonId: 'd', remoteCwd: '/srv/workspaces/p', clientId: 'c' } } as unknown as Thread;
const options = (claude: HarnessSessionOptions['claude']): HarnessSessionOptions => ({
  cwd: '/x', permissionMode: 'default', extraEnvRaw: 'AWS_PROFILE=secret-profile\nTOKEN=abc', callbacks: {} as never, claude,
});

describe('projection onto the wire', () => {
  it('carries the credential kind NAME and the plugin paths, and still never the environment itself', () => {
    const spec = projectSessionOptions(options({ remoteEnvKind: 'sessenv-p1', remotePluginPaths: ['/var/lib/agent-threads/skills/a-1'] }), thread);
    expect(spec.envKind).toBe('sessenv-p1');
    expect(spec.pluginPaths).toEqual(['/var/lib/agent-threads/skills/a-1']);
    expect(spec.extraEnvRaw).toBe('');
    expect(JSON.stringify(spec)).not.toContain('secret-profile');
    expect(JSON.stringify(spec)).not.toContain('abc');
  });

  it('omits both when there is nothing to send', () => {
    const spec = projectSessionOptions(options({}), thread);
    expect(spec).not.toHaveProperty('envKind');
    expect(spec).not.toHaveProperty('pluginPaths');
  });
});

describe('shape validation', () => {
  it('accepts a sessenv- kind and string paths; refuses any other kind name or a malformed list', () => {
    expect(validateSpecShape({ ...base, envKind: 'sessenv-proj-1', pluginPaths: ['/a/b'] })).toBeNull();
    for (const bad of ['github', 'mcp', 'sessenv-', 'sessenv-UPPER', 'sessenv-a/b', 42, '']) {
      expect(validateSpecShape({ ...base, envKind: bad }), String(bad)).toMatch(/envKind/);
    }
    expect(validateSpecShape({ ...base, pluginPaths: 'nope' })).toMatch(/pluginPaths/);
    expect(validateSpecShape({ ...base, pluginPaths: [1] })).toMatch(/pluginPaths/);
    expect(SESSION_ENV_KIND_PATTERN.test(`sessenv-${'a'.repeat(56)}`)).toBe(true);
    expect(SESSION_ENV_KIND_PATTERN.test(`sessenv-${'a'.repeat(57)}`)).toBe(false);
  });
});

describe('daemon policy', () => {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'extras-policy-')));
  const policy = { workspaces: [ws], allowBypass: false, pluginRoot: '/var/lib/agent-threads/skills' };
  const run = (over: Partial<RemoteSessionSpec>) => validateSpec({ ...base, cwd: ws, ...over } as RemoteSessionSpec, policy);

  it('keeps only plugin paths strictly inside the skills folder', () => {
    const kept = run({ pluginPaths: [
      '/var/lib/agent-threads/skills/ok-1',
      '/var/lib/agent-threads/skills/../creds',
      '/var/lib/agent-threads/skills',
      '/var/lib/agent-threads/skills-evil/x',
      '/etc',
      'relative/skills/x',
    ] }).pluginPaths;
    expect(kept).toEqual(['/var/lib/agent-threads/skills/ok-1']);
  });

  it('drops plugin paths when the daemon has no skills folder configured', () => {
    const none = validateSpec({ ...base, cwd: ws, pluginPaths: ['/var/lib/agent-threads/skills/a'] } as RemoteSessionSpec, { workspaces: [ws], allowBypass: false });
    expect(none.pluginPaths).toBeUndefined();
  });

  it('keeps only a well-formed sessenv- kind', () => {
    expect(run({ envKind: 'sessenv-x' }).envKind).toBe('sessenv-x');
    expect(run({ envKind: 'github' }).envKind).toBeUndefined();
  });
});

describe('daemon projection and lookup', () => {
  it('turns plugin paths into SDK local plugins', () => {
    const o = specToSessionOptions({ ...base, pluginPaths: ['/var/lib/agent-threads/skills/a-1'] } as RemoteSessionSpec, { callbacks: {} as never });
    expect(o.claude?.sessionOptions?.plugins).toEqual([{ type: 'local', path: '/var/lib/agent-threads/skills/a-1' }]);
  });

  it('reads the environment only from a sessenv- kind of the credential store', () => {
    const creds = { get: (k: string) => (k === 'sessenv-x' ? { A: '1' } : k === 'github' ? { GH_TOKEN: 'no' } : undefined) } as unknown as CredStore;
    expect(sessionEnvFromCreds(creds, { ...base, envKind: 'sessenv-x' } as RemoteSessionSpec)).toEqual({ A: '1' });
    expect(sessionEnvFromCreds(creds, { ...base, envKind: 'github' } as RemoteSessionSpec)).toEqual({});
    expect(sessionEnvFromCreds(creds, base as RemoteSessionSpec)).toEqual({});
    expect(sessionEnvFromCreds(undefined, { ...base, envKind: 'sessenv-x' } as RemoteSessionSpec)).toEqual({});
  });
});

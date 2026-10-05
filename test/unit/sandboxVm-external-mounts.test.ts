/**
 * Tests for the read-only /ext/<label> bind mounts of Geode external roots:
 * argv construction, label dedupe, untrusted-input filtering, and recreation of
 * a leftover container whose mount set changed. The container CLI is mocked.
 */
import { describe, it, expect } from 'vitest';
import {
  SandboxVmManager,
  VM_WORKDIR,
  buildRunArgs,
  containerNameForThread,
  mergeExtraMounts,
  resolveExternalMounts,
  sanitizeMountLabel,
  type VmCommandResult,
  type VmCommandRunner,
} from '../../src/sandboxVm';
import { mountSignature, type VmExtraMount } from '../../src/skillMounts';

const NAME = containerNameForThread('ext-mounts-thread');

const ro = (hostPath: string, name: string): VmExtraMount => ({ hostPath, guestPath: `/ext/${name}` });

function makeManager(responder: (argv: string[]) => Partial<VmCommandResult> | undefined = () => undefined) {
  const calls: string[][] = [];
  const run: VmCommandRunner = async (args) => {
    calls.push([...args]);
    return { exitCode: 0, stdout: '', stderr: '', ...(responder(args) ?? {}) };
  };
  return { manager: new SandboxVmManager({ containerName: () => NAME, run }), calls };
}

describe('buildRunArgs — external mounts (main extraMountArgs + labels)', () => {
  it('emits --volume host:guest:ro and the signature label, after the /work mount', () => {
    const mounts = [ro('/data/notes', 'notes')];
    const args = buildRunArgs({
      containerName: 'c', image: 'img:1', mountPath: '/w', network: 'default', extraMounts: mounts,
      labels: { 'claude-threads.mounts': mountSignature(mounts) },
    });
    expect(args).toEqual([
      'run', '--detach', '--name', 'c',
      '--volume', `/w:${VM_WORKDIR}`,
      '--volume', '/data/notes:/ext/notes:ro',
      '--label', `claude-threads.mounts=${mountSignature(mounts)}`,
      '--workdir', VM_WORKDIR,
      '--memory', '4G', '--cpus', '4',
      'img:1', 'sleep', 'infinity',
    ]);
  });
});

describe('mergeExtraMounts', () => {
  it('keeps skill mounts and /ext mounts side by side, first guest path wins', () => {
    const skills = [{ hostPath: '/h/s', guestPath: '/skills/s-1' }];
    const ext = [ro('/data/n', 'n'), { hostPath: '/other', guestPath: '/skills/s-1' }];
    expect(mergeExtraMounts(skills, ext, undefined)).toEqual([skills[0], ro('/data/n', 'n')]);
  });
});

describe('sanitizeMountLabel', () => {
  it('keeps labels readable and never yields an unsafe segment', () => {
    expect(sanitizeMountLabel('My Notes (2024)')).toBe('My-Notes-2024');
    expect(sanitizeMountLabel('a/b\\c')).toBe('a-b-c');
    expect(sanitizeMountLabel('..')).toBe('root');
    expect(sanitizeMountLabel('')).toBe('root');
    expect(sanitizeMountLabel('日本語')).toBe('root');
  });
});

describe('resolveExternalMounts', () => {
  const allDirs = { workPath: '/work/repo', isDirectory: () => true };

  it('dedupes colliding labels with -2, -3', () => {
    const mounts = resolveExternalMounts([
      { label: 'Docs', path: '/a' },
      { label: 'docs', path: '/b' },
      { label: 'Docs', path: '/c' },
    ], allDirs);
    expect(mounts.map((m) => m.guestPath)).toEqual(['/ext/Docs', '/ext/docs-2', '/ext/Docs-3']);
  });

  it('drops untrusted or unusable entries', () => {
    const mounts = resolveExternalMounts([
      { label: 'rel', path: 'relative/dir' },
      { label: 'colon', path: '/has:colon' },
      { label: 'nul', path: '/has\0nul' },
      { label: 'dotdot', path: '/a/../etc' },
      { label: 'missing', path: '/missing' },
      { label: 'same', path: '/work/repo' },
      { label: 'inside', path: '/work/repo/sub' },
      { label: 'inside-slash', path: '/work/repo/' },
      { label: 'nopath' },
      { label: 'ok', path: '/work/repo-sibling' },
      { label: 'dup-path', path: '/work/repo-sibling/' },
    ], { workPath: '/work/repo/', isDirectory: (p) => p !== '/missing' });
    expect(mounts).toEqual([ro('/work/repo-sibling', 'ok')]);
  });

  it('treats a throwing directory check as not-a-directory and tolerates non-array input', () => {
    expect(resolveExternalMounts([{ label: 'x', path: '/x' }], { workPath: '/w', isDirectory: () => { throw new Error('EACCES'); } })).toEqual([]);
    expect(resolveExternalMounts(undefined, allDirs)).toEqual([]);
    expect(resolveExternalMounts(null, allDirs)).toEqual([]);
  });
});

describe('SandboxVmManager.enter — extra mounts', () => {
  const inspectMissing = (argv: string[]) => (argv[0] === 'inspect' ? { exitCode: 1, stderr: 'not found' } : undefined);

  it('passes extra mounts to container run and reports them', async () => {
    const { manager, calls } = makeManager(inspectMissing);
    const mounts = [ro('/data/notes', 'notes')];
    const result = await manager.enter({ image: 'i', mountPath: '/w', network: 'default', extraMounts: mounts });
    expect(result).toMatchObject({ success: true, extraMounts: mounts });
    expect(calls.find((c) => c[0] === 'run')).toContain('/data/notes:/ext/notes:ro');
    expect(manager.getActive()?.extraMounts).toEqual(mounts);
  });

  it('no extra mounts (no-host fallback) starts as before with an empty list', async () => {
    const { manager, calls } = makeManager(inspectMissing);
    const result = await manager.enter({ image: 'i', mountPath: '/w', network: 'default' });
    expect(result).toMatchObject({ success: true });
    expect(calls.find((c) => c[0] === 'run')).not.toContain('--label');
  });

  it('preserves a leftover container and reports its old mounts when the requested set changes', async () => {
    const stale = ro('/old', 'old');
    const { manager, calls } = makeManager((argv) => (argv[0] === 'inspect'
      ? { stdout: JSON.stringify([{ configuration: { labels: { 'claude-threads.mounts': mountSignature([stale]) } } }]) }
      : undefined));
    const fresh = [ro('/new', 'new')];
    const result = await manager.enter({ image: 'i', mountPath: '/w', network: 'default', extraMounts: fresh });
    expect(result.success).toBe(true);
    const verbs = calls.map((c) => c[0]);
    expect(verbs.indexOf('rm')).toBeGreaterThan(-1);
    expect(verbs.indexOf('rm')).toBeLessThan(verbs.indexOf('run'));
    expect(calls.find((c) => c[0] === 'run')).toContain('/new:/ext/new:ro');
  });

  it('recreates an unlabeled leftover when mounts are now requested', async () => {
    const { manager, calls } = makeManager((argv) => (argv[0] === 'inspect' ? { stdout: '[{"configuration":{}}]' } : undefined));
    const result = await manager.enter({ image: 'i', mountPath: '/w', network: 'default', extraMounts: [ro('/new', 'new')] });
    expect(result.success).toBe(true);
    expect(calls.some((c) => c[0] === 'rm')).toBe(true);
  });

  it('keeps the existing-container error when the mount set is unchanged', async () => {
    const same = [ro('/same', 'same')];
    const { manager, calls } = makeManager((argv) => (argv[0] === 'inspect'
      ? { stdout: JSON.stringify([{ configuration: { labels: { 'claude-threads.mounts': mountSignature(same) } } }]) }
      : undefined));
    const result = await manager.enter({ image: 'i', mountPath: '/w', network: 'default', extraMounts: same });
    expect(result).toMatchObject({ success: false });
    expect(calls.some((c) => c[0] === 'run' || c[0] === 'rm')).toBe(false);
  });

  it('reports a failed recreate instead of starting on top of the stale container', async () => {
    const { manager, calls } = makeManager((argv) => {
      if (argv[0] === 'inspect') return { stdout: '[{}]' };
      if (argv[0] === 'rm') return { exitCode: 1, stderr: 'busy' };
      return undefined;
    });
    const result = await manager.enter({ image: 'i', mountPath: '/w', network: 'default', extraMounts: [ro('/n', 'n')] });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('busy') });
    expect(calls.some((c) => c[0] === 'run')).toBe(false);
  });
});

describe('SandboxVmManager.ensureHarnessContainer — extra mounts', () => {
  const inspectMissing = (argv: string[]) => (argv[0] === 'inspect' ? { exitCode: 1, stderr: 'not found' } : undefined);

  it('mounts /ext read-only into a fresh harness container and marks it harness-owned', async () => {
    const { manager, calls } = makeManager(inspectMissing);
    const mounts = [ro('/data/notes', 'notes')];
    const result = await manager.ensureHarnessContainer({ image: 'i', mountPath: '/w', network: 'default', extraMounts: mounts });
    expect(result).toMatchObject({ success: true, extraMounts: mounts });
    expect(calls.find((c) => c[0] === 'run')).toContain('/data/notes:/ext/notes:ro');
    expect(manager.getActive()).toMatchObject({ origin: 'harness', extraMounts: mounts });
  });

  it('recreates a leftover container whose mount set changed', async () => {
    const { manager, calls } = makeManager((argv) => (argv[0] === 'inspect'
      ? { stdout: JSON.stringify([{ configuration: { labels: { 'claude-threads.origin': 'harness', 'claude-threads.mounts': mountSignature([ro('/old', 'old')]) } } }]) }
      : undefined));
    const result = await manager.ensureHarnessContainer({ image: 'i', mountPath: '/w', network: 'default', extraMounts: [ro('/new', 'new')] });
    expect(result).toMatchObject({ success: true, extraMounts: [ro('/old', 'old')] });
    const verbs = calls.map((c) => c[0]);
    expect(verbs).not.toContain('rm');
    expect(verbs).not.toContain('run');
  });

  it('adopts a leftover container whose mount set is unchanged', async () => {
    const same = [ro('/same', 'same')];
    const { manager, calls } = makeManager((argv) => (argv[0] === 'inspect'
      ? { stdout: JSON.stringify([{ configuration: { labels: { 'claude-threads.origin': 'harness', 'claude-threads.mounts': mountSignature(same) } } }]) }
      : undefined));
    const result = await manager.ensureHarnessContainer({ image: 'i', mountPath: '/w', network: 'default', extraMounts: same });
    expect(result.success).toBe(true);
    expect(calls.some((c) => c[0] === 'run' || c[0] === 'rm')).toBe(false);
  });
});

/**
 * Tests for extra read-only mounts on the harness container (skills exposed to
 * the VM-routed Claude CLI). The `container` CLI is mocked — nothing shells out.
 */
import { describe, it, expect } from 'vitest';
import {
  SandboxVmManager,
  buildInspectArgs,
  buildRunArgs,
  containerNameForThread,
  type VmCommandResult,
  type VmCommandRunner,
} from '../../src/sandboxVm';

type Scripted = Partial<VmCommandResult>;

const NAME = containerNameForThread('a1b2c3d4-0000-4000-8000-abcdefabcdef');
const MISSING = { exitCode: 1, stderr: 'not found' };
const CLI_OK_NO_CONTAINER: Record<string, Scripted> = {
  '--version': { stdout: 'container CLI version 1.3.1\n' },
  [buildInspectArgs(NAME).join(' ')]: MISSING,
};

function makeManager(script: Record<string, Scripted> = {}) {
  const calls: string[][] = [];
  const run: VmCommandRunner = async (args) => {
    calls.push([...args]);
    return { exitCode: 0, stdout: '', stderr: '', ...(script[args.join(' ')] ?? {}) };
  };
  const manager = new SandboxVmManager({ containerName: () => NAME, run });
  const ran = (...prefix: string[]) => calls.some((c) => prefix.every((t, i) => c[i] === t));
  return { manager, calls, ran };
}

describe('buildRunArgs — extra read-only mounts and labels', () => {
  const base = { containerName: 'c', image: 'img:1', mountPath: '/tmp/work', network: 'default' as const };

  it('adds each extra mount as --volume host:guest:ro, after the cwd mount', () => {
    const args = buildRunArgs({ ...base, extraMounts: [{ hostPath: '/h/a', guestPath: '/skills/a' }] });
    const i = args.indexOf('/h/a:/skills/a:ro');
    expect(i).toBeGreaterThan(0);
    expect(args[i - 1]).toBe('--volume');
    expect(args.indexOf('/tmp/work:/work')).toBeLessThan(i);
  });

  it('is unchanged when there are no extra mounts or labels', () => {
    expect(buildRunArgs(base)).toEqual([
      'run', '--detach', '--name', 'c', '--volume', '/tmp/work:/work', '--workdir', '/work', '--memory', '4G', '--cpus', '4', 'img:1', 'sleep', 'infinity',
    ]);
  });

  it('dedupes by guest path', () => {
    const args = buildRunArgs({
      ...base,
      extraMounts: [{ hostPath: '/h/a', guestPath: '/skills/a' }, { hostPath: '/h/a', guestPath: '/skills/a' }],
    });
    expect(args.filter((a) => a === '/h/a:/skills/a:ro')).toHaveLength(1);
  });

  it('rejects a colon in either path of an extra mount', () => {
    expect(() => buildRunArgs({ ...base, extraMounts: [{ hostPath: '/h/a:b', guestPath: '/g' }] })).toThrow(/colon/i);
    expect(() => buildRunArgs({ ...base, extraMounts: [{ hostPath: '/h/a', guestPath: '/g:b' }] })).toThrow(/colon/i);
  });

  it('rejects a relative guest path', () => {
    expect(() => buildRunArgs({ ...base, extraMounts: [{ hostPath: '/h/a', guestPath: 'rel' }] })).toThrow(/absolute/i);
  });

  it('emits --label flags before the image', () => {
    const args = buildRunArgs({ ...base, labels: { 'x.y': 'z' } });
    const i = args.indexOf('x.y=z');
    expect(args[i - 1]).toBe('--label');
    expect(i).toBeLessThan(args.indexOf('img:1'));
  });
});

describe('SandboxVmManager — ensureHarnessContainer with extra mounts', () => {
  const MOUNTS = [{ hostPath: '/h/a', guestPath: '/skills/a' }];
  const SIG = JSON.stringify([['/h/a', '/skills/a']]);
  const inspectKey = buildInspectArgs(NAME).join(' ');
  const inspectWith = (labels: Record<string, string>) => ({
    exitCode: 0,
    stdout: JSON.stringify([{ configuration: { labels } }]),
  });
  const ensure = (manager: SandboxVmManager, extraMounts = MOUNTS) =>
    manager.ensureHarnessContainer({ image: 'img:1', mountPath: '/work', network: 'default', extraMounts });

  it('starts a fresh container with ro mounts, signature + origin labels, and reports the mounts', async () => {
    const { manager, calls } = makeManager(CLI_OK_NO_CONTAINER);
    const result = await ensure(manager);
    expect(result).toMatchObject({ success: true, extraMounts: MOUNTS });
    const run = calls.find((c) => c[0] === 'run')!;
    expect(run).toContain('/h/a:/skills/a:ro');
    expect(run).toContain(`claude-threads.mounts=${SIG}`);
    expect(run).toContain('claude-threads.origin=harness');
  });

  it('passes validated memory/cpus to the harness container run', async () => {
    const { manager, calls } = makeManager(CLI_OK_NO_CONTAINER);
    await manager.ensureHarnessContainer({ image: 'img:1', mountPath: '/work', network: 'default', memory: '6g', cpus: 3 });
    const run = calls.find((c) => c[0] === 'run')!;
    expect(run.slice(run.indexOf('--memory'), run.indexOf('--memory') + 4)).toEqual(['--memory', '6G', '--cpus', '3']);
  });

  it('adopts a harness container whose mount signature matches (no recreate)', async () => {
    const { manager, ran } = makeManager({
      '--version': { stdout: 'v\n' },
      [inspectKey]: inspectWith({ 'claude-threads.origin': 'harness', 'claude-threads.mounts': SIG }),
    });
    const result = await ensure(manager);
    expect(result).toMatchObject({ success: true, extraMounts: MOUNTS });
    expect(ran('run')).toBe(false);
    expect(ran('rm')).toBe(false);
  });

  it('preserves an untracked harness container and its native sessions when mounts change', async () => {
    const { manager, ran } = makeManager({
      '--version': { stdout: 'v\n' },
      [inspectKey]: inspectWith({ 'claude-threads.origin': 'harness', 'claude-threads.mounts': '' }),
    });
    const result = await ensure(manager);
    expect(result.success).toBe(true);
    expect(result).not.toHaveProperty('extraMounts');
    expect(ran('stop')).toBe(false);
    expect(ran('rm')).toBe(false);
    expect(ran('run')).toBe(false);
  });

  it('reports the old mounts when a reload requests a different skill set', async () => {
    const oldMounts = [{ hostPath: '/h/old', guestPath: '/skills/old' }];
    const { manager, ran } = makeManager({
      '--version': { stdout: 'v\n' },
      [inspectKey]: inspectWith({
        'claude-threads.origin': 'harness',
        'claude-threads.mounts': JSON.stringify([['/h/old', '/skills/old']]),
      }),
    });
    expect(await ensure(manager)).toMatchObject({ success: true, extraMounts: oldMounts });
    expect(ran('rm')).toBe(false);
    expect(ran('run')).toBe(false);
  });

  it('never recreates a container not labelled harness-owned (could hold agent state)', async () => {
    const { manager, ran } = makeManager({
      '--version': { stdout: 'v\n' },
      [inspectKey]: inspectWith({}),
    });
    const result = await ensure(manager);
    expect(result.success).toBe(true);
    expect(result).not.toHaveProperty('extraMounts');
    expect(ran('rm')).toBe(false);
    expect(ran('run')).toBe(false);
  });

  it('treats unparseable inspect output as an adopt with no known mounts', async () => {
    const { manager, ran } = makeManager({
      '--version': { stdout: 'v\n' },
      [inspectKey]: { exitCode: 0, stdout: 'not json' },
    });
    const result = await ensure(manager);
    expect(result.success).toBe(true);
    expect(result).not.toHaveProperty('extraMounts');
    expect(ran('rm')).toBe(false);
  });

  it('never recreates a container this manager already tracks (a session may be live in it)', async () => {
    const { manager, calls } = makeManager(CLI_OK_NO_CONTAINER);
    await ensure(manager, []);
    const before = calls.length;
    const second = await ensure(manager, MOUNTS);
    expect(second.success).toBe(true);
    expect(second).not.toHaveProperty('extraMounts');
    expect(calls.length).toBe(before);
  });
});

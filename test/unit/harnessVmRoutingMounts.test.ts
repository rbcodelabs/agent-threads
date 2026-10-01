/**
 * resolveClaudeVmRouting + skill mounts: the plan's mounts reach `container run`
 * as read-only volumes and the routing reports the mounts the container really has.
 */
import { describe, it, expect } from 'vitest';
import { resolveClaudeVmRouting } from '../../src/harnessVmRouting';
import {
  SandboxVmManager,
  buildImageInspectArgs,
  buildInspectArgs,
  type VmCommandResult,
  type VmCommandRunner,
} from '../../src/sandboxVm';

const NAME = 'claude-threads-vm-test-thread';
const IMAGE = 'claude-threads-harness:1';

function makeManager(script: Record<string, Partial<VmCommandResult>>) {
  const calls: string[][] = [];
  const run: VmCommandRunner = async (args) => {
    calls.push([...args]);
    return { exitCode: 0, stdout: '', stderr: '', ...(script[args.join(' ')] ?? {}) };
  };
  return { manager: new SandboxVmManager({ containerName: () => NAME, run }), calls };
}

const CAPABLE: Record<string, Partial<VmCommandResult>> = {
  '--version': { stdout: 'container CLI version 1.3.1\n' },
  [buildInspectArgs(NAME).join(' ')]: { exitCode: 1, stderr: 'not found' },
  [buildImageInspectArgs(IMAGE).join(' ')]: { exitCode: 0 },
};

describe('resolveClaudeVmRouting — skill mounts', () => {
  const plan = {
    mounts: [{ hostPath: '/h/skill', guestPath: '/skills/skill-abc' }],
    pluginGuestPaths: { '/h/skill': '/skills/skill-abc' },
  };

  it('passes plan mounts to container run as ro volumes and reports them as mounted', async () => {
    const { manager, calls } = makeManager(CAPABLE);
    const result = await resolveClaudeVmRouting({
      mode: 'auto', image: IMAGE, vmManager: manager, mountPath: '/work',
      platform: 'darwin', arch: 'arm64', skillMountPlan: plan,
    });
    expect(result).toMatchObject({ routed: true, routing: { mountedExtra: plan.mounts } });
    expect(calls.find((c) => c[0] === 'run')).toContain('/h/skill:/skills/skill-abc:ro');
  });

  it('reports no mounted extras when no plan is given', async () => {
    const { manager } = makeManager(CAPABLE);
    const result = await resolveClaudeVmRouting({
      mode: 'auto', image: IMAGE, vmManager: manager, mountPath: '/work', platform: 'darwin', arch: 'arm64',
    });
    expect(result).toMatchObject({ routed: true, routing: { mountedExtra: [] } });
  });
});

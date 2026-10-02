/**
 * The vault is always mounted READ-WRITE at /vault in sandbox/harness VMs:
 * argv flags, label comparison (incl. backward compatibility with old labels),
 * mount vetting, and harness routing. The `container` CLI is mocked.
 */
import { describe, it, expect } from 'vitest';
import { resolveClaudeVmRouting } from '../../src/harnessVmRouting';
import {
  SandboxVmManager,
  buildImageInspectArgs,
  buildInspectArgs,
  buildRunArgs,
  resolveVaultMount,
  VM_VAULT_MOUNT,
  type VmCommandResult,
  type VmCommandRunner,
} from '../../src/sandboxVm';
import { mountSignature, parseMountSignature, type VmExtraMount } from '../../src/skillMounts';

const NAME = 'claude-threads-vm-vault-test';
const IMAGE = 'claude-threads-harness:1';
const vault: VmExtraMount = { hostPath: '/v', guestPath: VM_VAULT_MOUNT, readWrite: true };
const roMount: VmExtraMount = { hostPath: '/h/a', guestPath: '/skills/a' };

describe('buildRunArgs — rw vs ro', () => {
  it('omits :ro only for readWrite mounts', () => {
    const args = buildRunArgs({
      containerName: 'c', image: 'img:1', mountPath: '/w', network: 'default', extraMounts: [roMount, vault],
    });
    expect(args).toContain('/h/a:/skills/a:ro');
    expect(args).toContain('/v:/vault');
    expect(args).not.toContain('/v:/vault:ro');
  });

  it('still rejects colons and relative paths for rw mounts', () => {
    const run = (m: VmExtraMount) =>
      buildRunArgs({ containerName: 'c', image: 'i', mountPath: '/w', network: 'default', extraMounts: [m] });
    expect(() => run({ hostPath: '/a:b', guestPath: '/vault', readWrite: true })).toThrow(/colon/);
    expect(() => run({ hostPath: 'v', guestPath: '/vault', readWrite: true })).toThrow(/absolute/);
  });
});

describe('mount signature label', () => {
  it('keeps the ro form unchanged, distinguishes rw, and round-trips', () => {
    expect(mountSignature([roMount])).toBe('[["/h/a","/skills/a"]]');
    expect(mountSignature([{ ...vault, readWrite: false }])).not.toBe(mountSignature([vault]));
    expect(mountSignature([roMount])).not.toBe(mountSignature([roMount, vault]));
    expect(parseMountSignature(mountSignature([roMount, vault]))).toEqual([roMount, vault]);
  });
});

describe('resolveVaultMount', () => {
  it('vets the path and tolerates a missing vault', () => {
    const yes = () => true;
    expect(resolveVaultMount('/v/', yes)).toEqual([vault]);
    expect(resolveVaultMount('', yes)).toEqual([]);
    expect(resolveVaultMount(undefined, yes)).toEqual([]);
    expect(resolveVaultMount('rel', yes)).toEqual([]);
    expect(resolveVaultMount('/a:b', yes)).toEqual([]);
    expect(resolveVaultMount('/a/../b', yes)).toEqual([]);
    expect(resolveVaultMount('/v', () => false)).toEqual([]);
  });
});

describe('ensureHarnessContainer — stale label without /vault', () => {
  it('recreates a harness-owned container and mounts /vault rw', async () => {
    const calls: string[][] = [];
    const oldLabels = JSON.stringify([{ configuration: { labels: {
      'claude-threads.origin': 'harness', 'claude-threads.mounts': mountSignature([roMount]),
    } } }]);
    const run: VmCommandRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === 'inspect' && args.length === 2) return { exitCode: 0, stdout: oldLabels, stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const manager = new SandboxVmManager({ containerName: () => NAME, run });
    const res = await manager.ensureHarnessContainer({
      image: 'img', mountPath: '/w', network: 'default', extraMounts: [roMount, vault],
    });
    expect(res.success).toBe(true);
    expect(calls.some((c) => c[0] === 'rm')).toBe(true);
    expect(calls.find((c) => c[0] === 'run')).toContain('/v:/vault');
  });
});

describe('resolveClaudeVmRouting — vault mount', () => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-rw-'));
  const CAPABLE: Record<string, Partial<VmCommandResult>> = {
    '--version': { stdout: 'container CLI version 1.3.1\n' },
    [buildInspectArgs(NAME).join(' ')]: { exitCode: 1, stderr: 'not found' },
    [buildImageInspectArgs(IMAGE).join(' ')]: { exitCode: 0 },
  };
  const make = () => {
    const calls: string[][] = [];
    const run: VmCommandRunner = async (args) => {
      calls.push([...args]);
      return { exitCode: 0, stdout: '', stderr: '', ...(CAPABLE[args.join(' ')] ?? {}) };
    };
    return { manager: new SandboxVmManager({ containerName: () => NAME, run }), calls };
  };
  const base = { mode: 'auto' as const, image: IMAGE, platform: 'darwin', arch: 'arm64' };

  it('mounts the vault rw at /vault alongside /work', async () => {
    const { manager, calls } = make();
    const result = await resolveClaudeVmRouting({ ...base, vmManager: manager, mountPath: '/work', getVaultPath: () => vaultDir });
    expect(result).toMatchObject({ routed: true, routing: { mountedExtra: [{ hostPath: vaultDir, guestPath: '/vault', readWrite: true }] } });
    expect(calls.find((c) => c[0] === 'run')).toContain(`${vaultDir}:/vault`);
  });

  it('mounts /vault even when the cwd is the vault root (same dir twice)', async () => {
    const { manager, calls } = make();
    await resolveClaudeVmRouting({ ...base, vmManager: manager, mountPath: vaultDir, getVaultPath: () => vaultDir });
    const run = calls.find((c) => c[0] === 'run')!;
    expect(run).toContain(`${vaultDir}:/work`);
    expect(run).toContain(`${vaultDir}:/vault`);
  });

  it('skips silently when the vault path is unavailable', async () => {
    for (const getVaultPath of [undefined, () => '', () => '/nonexistent/vault-xyz']) {
      const { manager, calls } = make();
      const result = await resolveClaudeVmRouting({ ...base, vmManager: manager, mountPath: '/work', getVaultPath });
      expect(result).toMatchObject({ routed: true, routing: { mountedExtra: [] } });
      expect(calls.find((c) => c[0] === 'run')!.join(' ')).not.toContain('/vault');
    }
  });
});

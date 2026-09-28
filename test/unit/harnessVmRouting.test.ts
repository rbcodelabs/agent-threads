/**
 * Tests for harnessVmRouting — the ADR-0015 decision of whether a thread's
 * Claude harness process runs inside its sandbox container, plus the
 * spawn-argv construction and secret-redaction helpers that decision feeds
 * into `ThreadSession.start()`.
 *
 * The container CLI is mocked throughout via SandboxVmManager's own injected
 * runner, exactly as sandboxVm.test.ts does — nothing here shells out.
 */
import { describe, it, expect, vi } from 'vitest';
import { SandboxVmManager, buildInspectArgs, buildImageInspectArgs, VM_WORKDIR } from '../../src/sandboxVm';
import type { VmCommandResult, VmCommandRunner } from '../../src/sandboxVm';
import {
  CLAUDE_CONTAINER_BINARY_PATH,
  DEFAULT_HARNESS_VM_IMAGE,
  buildHarnessSpawnArgs,
  checkHarnessVmCapability,
  redactSecretsInArgv,
  resolveClaudeVmRouting,
} from '../../src/harnessVmRouting';

const NAME = 'claude-threads-vm-test-thread';
const IMAGE = 'claude-threads-harness:1';

type Scripted = Partial<VmCommandResult> | Error;

function makeRunner(script: Record<string, Scripted> = {}) {
  const calls: string[][] = [];
  const run: VmCommandRunner = async (args) => {
    calls.push([...args]);
    const entry = script[args.join(' ')];
    if (entry instanceof Error) throw entry;
    return { exitCode: 0, stdout: '', stderr: '', ...(entry ?? {}) };
  };
  return { run, calls, ran: (...prefix: string[]) => calls.some((c) => prefix.every((t, i) => c[i] === t)) };
}

/** Fully capable: CLI present, no leftover container, image exists. */
const CAPABLE_SCRIPT: Record<string, Scripted> = {
  '--version': { stdout: 'container CLI version 1.3.1\n' },
  [buildInspectArgs(NAME).join(' ')]: { exitCode: 1, stderr: 'not found' },
  [buildImageInspectArgs(IMAGE).join(' ')]: { exitCode: 0 },
};

function makeManager(script: Record<string, Scripted> = {}) {
  const runner = makeRunner(script);
  const manager = new SandboxVmManager({ containerName: () => NAME, run: runner.run });
  return { manager, runner };
}

describe('checkHarnessVmCapability', () => {
  it('is capable when platform, probe, and image all check out', async () => {
    const { manager } = makeManager(CAPABLE_SCRIPT);
    const result = await checkHarnessVmCapability({ vmManager: manager, image: IMAGE, platform: 'darwin', arch: 'arm64' });
    expect(result).toEqual({ capable: true });
  });

  it('rejects anything but macOS on Apple silicon before touching the CLI at all', async () => {
    const { manager, runner } = makeManager(CAPABLE_SCRIPT);
    const result = await checkHarnessVmCapability({ vmManager: manager, image: IMAGE, platform: 'linux', arch: 'x64' });
    expect(result.capable).toBe(false);
    expect(result.reason).toContain('Apple silicon');
    expect(runner.calls).toHaveLength(0);
  });

  it('reports an unavailable CLI distinctly from a missing image', async () => {
    const { manager } = makeManager({ '--version': { exitCode: 1, stderr: 'not found' } });
    const result = await checkHarnessVmCapability({ vmManager: manager, image: IMAGE, platform: 'darwin', arch: 'arm64' });
    expect(result.capable).toBe(false);
    expect(result.reason).toMatch(/container/i);
  });

  it('reports a missing harness image with the exact build command', async () => {
    const { manager } = makeManager({
      '--version': { stdout: 'ok' },
      [buildImageInspectArgs(IMAGE).join(' ')]: { exitCode: 1 },
    });
    const result = await checkHarnessVmCapability({ vmManager: manager, image: IMAGE, platform: 'darwin', arch: 'arm64' });
    expect(result.capable).toBe(false);
    expect(result.reason).toContain(`container build --tag ${IMAGE} -f sandbox/Dockerfile.harness sandbox/`);
  });
});

describe('resolveClaudeVmRouting', () => {
  it('never mode: does not touch the CLI at all', async () => {
    const { manager, runner } = makeManager(CAPABLE_SCRIPT);
    const result = await resolveClaudeVmRouting({ mode: 'never', image: IMAGE, vmManager: manager, mountPath: '/work' });
    expect(result).toEqual({ routed: false });
    expect(runner.calls).toHaveLength(0);
  });

  it('auto mode: routes into the VM when capable, starting the container', async () => {
    const { manager, runner } = makeManager(CAPABLE_SCRIPT);
    const result = await resolveClaudeVmRouting({
      mode: 'auto', image: IMAGE, vmManager: manager, mountPath: '/work', platform: 'darwin', arch: 'arm64',
    });
    expect(result).toEqual({ routed: true, routing: { containerName: NAME, containerBinaryPath: CLAUDE_CONTAINER_BINARY_PATH } });
    expect(runner.ran('run', '--detach')).toBe(true);
  });

  it('auto mode: falls back to host spawn silently when incapable', async () => {
    const { manager } = makeManager({ '--version': { exitCode: 1 } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await resolveClaudeVmRouting({
      mode: 'auto', image: IMAGE, vmManager: manager, mountPath: '/work', platform: 'darwin', arch: 'arm64',
    });
    expect(result).toEqual({ routed: false });
    warn.mockRestore();
  });

  it('auto mode: falls back to host spawn silently on an unsupported platform', async () => {
    const { manager, runner } = makeManager(CAPABLE_SCRIPT);
    const result = await resolveClaudeVmRouting({
      mode: 'auto', image: IMAGE, vmManager: manager, mountPath: '/work', platform: 'linux', arch: 'x64',
    });
    expect(result).toEqual({ routed: false });
    expect(runner.calls).toHaveLength(0);
  });

  it('auto mode: falls back silently when the capability check passes but the container fails to start', async () => {
    const { manager } = makeManager({
      ...CAPABLE_SCRIPT,
      'run --detach --name claude-threads-vm-test-thread --volume /work:/work --workdir /work claude-threads-harness:1 sleep infinity': { exitCode: 1, stderr: 'boom' },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await resolveClaudeVmRouting({
      mode: 'auto', image: IMAGE, vmManager: manager, mountPath: '/work', platform: 'darwin', arch: 'arm64',
    });
    expect(result).toEqual({ routed: false });
    warn.mockRestore();
  });

  it('always mode: routes into the VM exactly like auto when capable', async () => {
    const { manager } = makeManager(CAPABLE_SCRIPT);
    const result = await resolveClaudeVmRouting({
      mode: 'always', image: IMAGE, vmManager: manager, mountPath: '/work', platform: 'darwin', arch: 'arm64',
    });
    expect(result).toEqual({ routed: true, routing: { containerName: NAME, containerBinaryPath: CLAUDE_CONTAINER_BINARY_PATH } });
  });

  it('always mode: THROWS instead of silently falling back when incapable', async () => {
    const { manager } = makeManager({ '--version': { exitCode: 1 } });
    await expect(resolveClaudeVmRouting({
      mode: 'always', image: IMAGE, vmManager: manager, mountPath: '/work', platform: 'darwin', arch: 'arm64',
    })).rejects.toThrow(/harnessVmMode is "always"/);
  });

  it('always mode: THROWS when capable but the container itself fails to start', async () => {
    const { manager } = makeManager({
      ...CAPABLE_SCRIPT,
      'run --detach --name claude-threads-vm-test-thread --volume /work:/work --workdir /work claude-threads-harness:1 sleep infinity': { exitCode: 1, stderr: 'boom' },
    });
    await expect(resolveClaudeVmRouting({
      mode: 'always', image: IMAGE, vmManager: manager, mountPath: '/work', platform: 'darwin', arch: 'arm64',
    })).rejects.toThrow(/sandbox container could not be started/);
  });

  it('respects a custom containerBinaryPath override', async () => {
    const { manager } = makeManager(CAPABLE_SCRIPT);
    const result = await resolveClaudeVmRouting({
      mode: 'auto', image: IMAGE, vmManager: manager, mountPath: '/work', containerBinaryPath: '/custom/claude',
      platform: 'darwin', arch: 'arm64',
    });
    expect(result).toEqual({ routed: true, routing: { containerName: NAME, containerBinaryPath: '/custom/claude' } });
  });

  it('defaults the harness image to DEFAULT_HARNESS_VM_IMAGE when unset', () => {
    expect(DEFAULT_HARNESS_VM_IMAGE).toBe('claude-threads-harness:1');
  });
});

describe('buildHarnessSpawnArgs', () => {
  it('builds an interactive exec against /work with secrets scoped to --env', () => {
    const args = buildHarnessSpawnArgs({
      containerName: NAME,
      command: CLAUDE_CONTAINER_BINARY_PATH,
      args: ['--print'],
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
    });
    expect(args).toEqual([
      'exec', '--interactive', '--workdir', VM_WORKDIR,
      '--env', 'CLAUDE_CODE_OAUTH_TOKEN=tok-secret',
      '--env', 'CLAUDE_CODE_ENABLE_TODO_TOOLS=1',
      NAME, CLAUDE_CONTAINER_BINARY_PATH, '--print',
    ]);
  });
});

describe('redactSecretsInArgv', () => {
  it('redacts by content match, not by argv position', () => {
    const argv = ['exec', '--env', 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-live-secret', 'c', 'claude'];
    const redacted = redactSecretsInArgv(argv, ['sk-ant-oat-live-secret']);
    expect(redacted).toEqual(['exec', '--env', 'CLAUDE_CODE_OAUTH_TOKEN=<redacted>', 'c', 'claude']);
  });

  it('keeps redacting correctly even when the argv shape changes — the exact bug the ADR-0015 spike hit', () => {
    // A positional slice (args.slice(0, 4)) would silently stop protecting the
    // secret here because it moved to a different index than an earlier probe
    // assumed. Content match doesn't care where it lands.
    const shiftedArgv = ['exec', '--interactive', '--workdir', '/work', '--env', 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-live-secret', 'c', 'claude', '--print'];
    const redacted = redactSecretsInArgv(shiftedArgv, ['sk-ant-oat-live-secret']);
    expect(redacted.join(' ')).not.toContain('sk-ant-oat-live-secret');
  });

  it('ignores empty/undefined secret values instead of matching everything', () => {
    const argv = ['a', 'b', ''];
    expect(redactSecretsInArgv(argv, [undefined, '', 'x'])).toEqual(argv.map((a) => a.split('x').join('<redacted>')));
  });

  it('is a no-op when no real secrets are supplied', () => {
    const argv = ['a', 'b', 'c'];
    expect(redactSecretsInArgv(argv, [undefined, ''])).toBe(argv);
  });
});

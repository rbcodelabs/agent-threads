/**
 * Tests for sandboxVm — command construction and lifecycle state transitions
 * for the Apple `container`-backed sandbox VM.
 *
 * The container CLI is MOCKED throughout. Nothing here shells out: the runtime
 * only exists on macOS 26 + Apple silicon, and CI has neither. The seam under
 * test is exactly the one that matters — which argv we hand the CLI, and how we
 * react to what it returns.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VM_EXEC_TIMEOUT_SECONDS,
  DEFAULT_VM_IMAGE,
  MAX_VM_EXEC_TIMEOUT_SECONDS,
  MIN_VM_EXEC_TIMEOUT_SECONDS,
  SandboxVmManager,
  VM_CONTAINER_NAME_PREFIX,
  VM_INTERNAL_NETWORK_NAME,
  VM_NETWORK_MODES,
  VM_OUTPUT_LIMIT_BYTES,
  VM_WORKDIR,
  VmUnavailableError,
  buildExecArgs,
  buildInspectArgs,
  buildNetworkCreateArgs,
  buildNetworkListArgs,
  buildRemoveArgs,
  buildRunArgs,
  buildStopArgs,
  containerNameForThread,
  isVmNetworkMode,
  networkArgsFor,
  resolveExecTimeoutSeconds,
  resolveVmImage,
  resolveVmNetwork,
  sanitizeContainerName,
  truncateOutput,
  type VmCommandResult,
  type VmCommandRunner,
} from '../../src/sandboxVm';

// ── Mock CLI ─────────────────────────────────────────────────────────────────

type Scripted = Partial<VmCommandResult> | Error;

/**
 * Fake `container` CLI keyed on the joined argv. Any command with no scripted
 * entry succeeds with empty output, which keeps each test's script down to the
 * responses it actually cares about.
 */
function makeRunner(script: Record<string, Scripted> = {}) {
  const calls: Array<{ args: string[]; timeoutMs: number }> = [];
  const run: VmCommandRunner = async (args, opts) => {
    calls.push({ args: [...args], timeoutMs: opts.timeoutMs });
    const entry = script[args.join(' ')];
    if (entry instanceof Error) throw entry;
    return { exitCode: 0, stdout: '', stderr: '', ...(entry ?? {}) };
  };
  return {
    run,
    calls,
    argvs: () => calls.map((c) => c.args.join(' ')),
    /** True if any call started with these argv tokens. */
    ran: (...prefix: string[]) =>
      calls.some((c) => prefix.every((token, i) => c.args[i] === token)),
  };
}

const THREAD_ID = 'a1b2c3d4-0000-4000-8000-abcdefabcdef';
const NAME = containerNameForThread(THREAD_ID);
const MISSING = { exitCode: 1, stderr: 'not found' };

function makeManager(script: Record<string, Scripted> = {}) {
  const runner = makeRunner(script);
  const manager = new SandboxVmManager({ containerName: () => NAME, run: runner.run });
  return { manager, runner };
}

/** Script fragment for "the CLI works and no container exists yet". */
const CLI_OK_NO_CONTAINER: Record<string, Scripted> = {
  '--version': { stdout: 'container CLI version 1.3.1\n' },
  [buildInspectArgs(NAME).join(' ')]: MISSING,
};

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('sandboxVm — sanitizeContainerName', () => {
  it('passes a UUID thread ID through unchanged', () => {
    expect(sanitizeContainerName(THREAD_ID)).toBe(THREAD_ID);
  });

  it('lowercases and collapses anything a container ID would reject', () => {
    expect(sanitizeContainerName('Thread ID/With Spaces')).toBe('thread-id-with-spaces');
    expect(sanitizeContainerName('a__b***c')).toBe('a-b-c');
  });

  it('never starts or ends with a dash', () => {
    const name = sanitizeContainerName('///weird///');
    expect(name).toBe('weird');
    expect(name.startsWith('-')).toBe(false);
    expect(name.endsWith('-')).toBe(false);
  });

  it('never returns an empty name', () => {
    expect(sanitizeContainerName('')).toBe('session');
    expect(sanitizeContainerName('!!!')).toBe('session');
  });

  it('caps the length so the full container name stays reasonable', () => {
    expect(sanitizeContainerName('x'.repeat(200))).toHaveLength(48);
  });

  it('strips shell/flag metacharacters, so an ID cannot smuggle argv', () => {
    // Not a shell-injection vector (execFile takes an argv array), but a name
    // starting with "-" would be parsed as a flag by the CLI itself.
    expect(sanitizeContainerName('--rm -f evil')).toBe('rm-f-evil');
    expect(sanitizeContainerName('a; rm -rf /')).toBe('a-rm-rf');
  });
});

describe('sandboxVm — containerNameForThread', () => {
  it('is deterministic, so a container survives a plugin reload and is still findable', () => {
    expect(containerNameForThread(THREAD_ID)).toBe(containerNameForThread(THREAD_ID));
  });

  it('prefixes every container so strays are identifiable on the host', () => {
    expect(containerNameForThread(THREAD_ID).startsWith(VM_CONTAINER_NAME_PREFIX)).toBe(true);
  });

  it('gives different threads different containers', () => {
    expect(containerNameForThread('one')).not.toBe(containerNameForThread('two'));
  });
});

describe('sandboxVm — network mode resolution', () => {
  it('recognises exactly the three supported modes', () => {
    expect([...VM_NETWORK_MODES]).toEqual(['default', 'internal', 'none']);
    for (const mode of VM_NETWORK_MODES) expect(isVmNetworkMode(mode)).toBe(true);
    for (const bad of ['bridge', '', null, undefined, 7]) expect(isVmNetworkMode(bad)).toBe(false);
  });

  it('prefers the explicit argument over the configured default', () => {
    expect(resolveVmNetwork('none', 'internal')).toBe('none');
  });

  it('falls back to the configured default when no argument is given', () => {
    expect(resolveVmNetwork(undefined, 'internal')).toBe('internal');
    expect(resolveVmNetwork(null, 'none')).toBe('none');
  });

  it('defaults to full egress when nothing is configured', () => {
    // Explicit product decision: npm install / git remotes / web must work.
    expect(resolveVmNetwork(undefined, undefined)).toBe('default');
  });

  it('ignores an unrecognised setting rather than failing the call', () => {
    expect(resolveVmNetwork(undefined, 'bridge')).toBe('default');
    expect(resolveVmNetwork('nonsense', 'internal')).toBe('internal');
  });
});

describe('sandboxVm — resolveVmImage', () => {
  it('prefers the argument, then the setting, then the built-in default', () => {
    expect(resolveVmImage('a:1', 'b:2')).toBe('a:1');
    expect(resolveVmImage(undefined, 'b:2')).toBe('b:2');
    expect(resolveVmImage(undefined, undefined)).toBe(DEFAULT_VM_IMAGE);
  });

  it('treats blank and whitespace-only values as unset', () => {
    expect(resolveVmImage('   ', '  ')).toBe(DEFAULT_VM_IMAGE);
    expect(resolveVmImage('', 'b:2')).toBe('b:2');
  });

  it('trims surrounding whitespace from a pasted setting', () => {
    expect(resolveVmImage(undefined, '  b:2  ')).toBe('b:2');
  });
});

describe('sandboxVm — resolveExecTimeoutSeconds', () => {
  it('defaults to 300 seconds', () => {
    expect(resolveExecTimeoutSeconds(undefined)).toBe(DEFAULT_VM_EXEC_TIMEOUT_SECONDS);
    expect(resolveExecTimeoutSeconds(null)).toBe(DEFAULT_VM_EXEC_TIMEOUT_SECONDS);
  });

  it('clamps into a sane band instead of accepting 0 or a week', () => {
    expect(resolveExecTimeoutSeconds(0)).toBe(MIN_VM_EXEC_TIMEOUT_SECONDS);
    expect(resolveExecTimeoutSeconds(-10)).toBe(MIN_VM_EXEC_TIMEOUT_SECONDS);
    expect(resolveExecTimeoutSeconds(999_999)).toBe(MAX_VM_EXEC_TIMEOUT_SECONDS);
  });

  it('floors fractional seconds and rejects NaN/Infinity', () => {
    expect(resolveExecTimeoutSeconds(12.9)).toBe(12);
    expect(resolveExecTimeoutSeconds(Number.NaN)).toBe(DEFAULT_VM_EXEC_TIMEOUT_SECONDS);
    expect(resolveExecTimeoutSeconds(Number.POSITIVE_INFINITY)).toBe(DEFAULT_VM_EXEC_TIMEOUT_SECONDS);
  });
});

describe('sandboxVm — argument construction', () => {
  it('default network passes no --network flag at all (the CLI default is full egress)', () => {
    const args = buildRunArgs({ containerName: 'c', image: 'img:1', mountPath: '/host/work', network: 'default' });
    expect(args).not.toContain('--network');
    expect(networkArgsFor('default')).toEqual([]);
  });

  it('internal network attaches the shared --internal network', () => {
    const args = buildRunArgs({ containerName: 'c', image: 'img:1', mountPath: '/host/work', network: 'internal' });
    expect(args.join(' ')).toContain(`--network ${VM_INTERNAL_NETWORK_NAME}`);
    expect(networkArgsFor('internal')).toEqual(['--network', VM_INTERNAL_NETWORK_NAME]);
  });

  it('none network attaches no route', () => {
    expect(networkArgsFor('none')).toEqual(['--network', 'none']);
  });

  it('builds a detached run that bind-mounts the host dir at /work and stays alive', () => {
    expect(buildRunArgs({ containerName: 'c', image: 'img:1', mountPath: '/host/work', network: 'default' }))
      .toEqual([
        'run', '--detach',
        '--name', 'c',
        '--volume', `/host/work:${VM_WORKDIR}`,
        '--workdir', VM_WORKDIR,
        'img:1',
        'sleep', 'infinity',
      ]);
  });

  it('puts the image before the container command, as the CLI requires', () => {
    const args = buildRunArgs({ containerName: 'c', image: 'img:1', mountPath: '/m', network: 'none' });
    expect(args.indexOf('img:1')).toBeLessThan(args.indexOf('sleep'));
    expect(args.indexOf('--network')).toBeLessThan(args.indexOf('img:1'));
  });

  it('runs exec commands through bash -lc from /work', () => {
    expect(buildExecArgs({ containerName: 'c', command: 'npm test' }))
      .toEqual(['exec', '--workdir', VM_WORKDIR, 'c', 'bash', '-lc', 'npm test']);
  });

  it('keeps the whole command as one argv element, so the host never re-splits it', () => {
    const command = 'echo "a b"; ls $HOME && printf \'%s\\n\' done';
    const args = buildExecArgs({ containerName: 'c', command });
    expect(args[args.length - 1]).toBe(command);
    expect(args.filter((a) => a === command)).toHaveLength(1);
  });

  it('builds stop, remove, inspect and network arguments', () => {
    expect(buildStopArgs('c')).toEqual(['stop', 'c']);
    expect(buildRemoveArgs({ containerName: 'c' })).toEqual(['rm', 'c']);
    expect(buildRemoveArgs({ containerName: 'c', force: true })).toEqual(['rm', '--force', 'c']);
    expect(buildInspectArgs('c')).toEqual(['inspect', 'c']);
    expect(buildNetworkListArgs()).toEqual(['network', 'list', '--quiet']);
    expect(buildNetworkCreateArgs('n')).toEqual(['network', 'create', '--internal', 'n']);
  });
});

describe('sandboxVm — truncateOutput', () => {
  it('leaves output under the cap untouched', () => {
    expect(truncateOutput('hello')).toBe('hello');
    expect(truncateOutput('')).toBe('');
  });

  it('keeps the head and marks the truncation explicitly', () => {
    const text = 'x'.repeat(VM_OUTPUT_LIMIT_BYTES + 500);
    const out = truncateOutput(text);
    expect(out.startsWith('x'.repeat(100))).toBe(true);
    expect(out).toContain('truncated 500 of');
    expect(out.length).toBeLessThan(text.length + 200);
  });

  it('honours a custom limit', () => {
    expect(truncateOutput('abcdef', 3)).toMatch(/^abc\n\n\[\.\.\. truncated 3 of 6 characters/);
  });
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe('SandboxVmManager — enter', () => {
  it('probes the CLI, checks for a stale container, then starts a detached VM', async () => {
    const { manager, runner } = makeManager(CLI_OK_NO_CONTAINER);

    const result = await manager.enter({ image: 'img:1', mountPath: '/host/work', network: 'default' });

    expect(result).toEqual({
      success: true,
      containerName: NAME,
      image: 'img:1',
      mountedFrom: '/host/work',
      network: 'default',
    });
    expect(runner.argvs()).toEqual([
      '--version',
      `inspect ${NAME}`,
      buildRunArgs({ containerName: NAME, image: 'img:1', mountPath: '/host/work', network: 'default' }).join(' '),
    ]);
    expect(manager.getActive()?.containerName).toBe(NAME);
  });

  it('refuses a second enter while one is already tracked, and starts nothing', async () => {
    const { manager, runner } = makeManager(CLI_OK_NO_CONTAINER);
    await manager.enter({ image: 'img:1', mountPath: '/a', network: 'default' });
    const before = runner.calls.length;

    const second = await manager.enter({ image: 'img:2', mountPath: '/b', network: 'none' });

    expect(second).toEqual({
      success: false,
      error: expect.stringContaining('already running'),
    });
    expect((second as { error: string }).error).toContain('exit_vm');
    expect(runner.calls.length).toBe(before);
    // The first VM's state must survive the rejected call.
    expect(manager.getActive()?.mountedFrom).toBe('/a');
  });

  it('reports a leftover container from an earlier session instead of silently adopting it', async () => {
    // Adopting would ignore the image/network/mount just requested.
    const { manager, runner } = makeManager({ '--version': { stdout: 'v' } });

    const result = await manager.enter({ image: 'img:1', mountPath: '/a', network: 'default' });

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain(NAME);
    expect((result as { error: string }).error).toContain('exit_vm');
    expect(runner.ran('run')).toBe(false);
    expect(manager.getActive()).toBeNull();
  });

  it('creates the shared internal network on demand when it is missing', async () => {
    const { manager, runner } = makeManager({
      ...CLI_OK_NO_CONTAINER,
      'network list --quiet': { stdout: 'default\n' },
    });

    const result = await manager.enter({ image: 'img:1', mountPath: '/a', network: 'internal' });

    expect(result.success).toBe(true);
    expect(runner.argvs()).toContain(`network create --internal ${VM_INTERNAL_NETWORK_NAME}`);
    expect(runner.argvs().at(-1)).toContain(`--network ${VM_INTERNAL_NETWORK_NAME}`);
  });

  it('does not recreate the internal network when it already exists', async () => {
    const { manager, runner } = makeManager({
      ...CLI_OK_NO_CONTAINER,
      'network list --quiet': { stdout: `default\n${VM_INTERNAL_NETWORK_NAME}\n` },
    });

    expect((await manager.enter({ image: 'img:1', mountPath: '/a', network: 'internal' })).success).toBe(true);
    expect(runner.ran('network', 'create')).toBe(false);
  });

  it('never touches the network commands for default or none', async () => {
    for (const network of ['default', 'none'] as const) {
      const { manager, runner } = makeManager(CLI_OK_NO_CONTAINER);
      await manager.enter({ image: 'img:1', mountPath: '/a', network });
      expect(runner.ran('network'), network).toBe(false);
    }
  });

  it('fails with the creation error when the internal network cannot be made', async () => {
    const { manager, runner } = makeManager({
      ...CLI_OK_NO_CONTAINER,
      'network list --quiet': { stdout: 'default\n' },
      [`network create --internal ${VM_INTERNAL_NETWORK_NAME}`]: { exitCode: 1, stderr: 'vmnet permission denied\n' },
    });

    const result = await manager.enter({ image: 'img:1', mountPath: '/a', network: 'internal' });

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('vmnet permission denied');
    expect(runner.ran('run')).toBe(false);
  });

  it('surfaces a run failure with the CLI stderr and leaves no tracked state', async () => {
    const { manager } = makeManager({
      ...CLI_OK_NO_CONTAINER,
      [buildRunArgs({ containerName: NAME, image: 'img:1', mountPath: '/a', network: 'default' }).join(' ')]:
        { exitCode: 125, stderr: 'image not found: img:1\nsecond line\n' },
    });

    const result = await manager.enter({ image: 'img:1', mountPath: '/a', network: 'default' });

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('image not found: img:1');
    expect(manager.getActive()).toBeNull();
  });

  it('returns a clean install hint instead of throwing when the CLI is missing', async () => {
    const { manager } = makeManager({ '--version': new VmUnavailableError('ENOENT') });

    const result = await manager.enter({ image: 'img:1', mountPath: '/a', network: 'default' });

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('brew install container');
    expect((result as { error: string }).error).toContain('container system start');
  });

  it('reports a stopped container runtime rather than a bare non-zero exit', async () => {
    const { manager } = makeManager({ '--version': { exitCode: 1, stderr: 'XPC connection error\n' } });

    const result = await manager.enter({ image: 'img:1', mountPath: '/a', network: 'default' });

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('container system start');
    expect((result as { error: string }).error).toContain('XPC connection error');
  });

  it('never throws even when the runner rejects with a plain error', async () => {
    const { manager } = makeManager({ '--version': new Error('boom') });
    await expect(manager.enter({ image: 'i', mountPath: '/a', network: 'default' }))
      .resolves.toEqual({ success: false, error: 'boom' });
  });
});

describe('SandboxVmManager — execCommand', () => {
  async function entered(extra: Record<string, Scripted> = {}) {
    const ctx = makeManager({ ...CLI_OK_NO_CONTAINER, ...extra });
    await ctx.manager.enter({ image: 'img:1', mountPath: '/a', network: 'default' });
    ctx.runner.calls.length = 0;
    return ctx;
  }

  it('runs the command in the tracked container from /work', async () => {
    const { manager, runner } = await entered({
      [buildExecArgs({ containerName: NAME, command: 'npm test' }).join(' ')]: { stdout: 'ok\n' },
    });

    const result = await manager.execCommand({ command: 'npm test', timeoutSeconds: 30 });

    expect(result).toEqual({ success: true, exitCode: 0, stdout: 'ok\n', stderr: '' });
    expect(runner.argvs()).toEqual([`exec --workdir ${VM_WORKDIR} ${NAME} bash -lc npm test`]);
  });

  it('passes the timeout through in milliseconds', async () => {
    const { manager, runner } = await entered();
    await manager.execCommand({ command: 'sleep 1', timeoutSeconds: 45 });
    expect(runner.calls[0]!.timeoutMs).toBe(45_000);
  });

  it('reports a non-zero exit code as a normal result, not a tool error', async () => {
    // A failing test run is information the model needs, not an infrastructure fault.
    const { manager } = await entered({
      [buildExecArgs({ containerName: NAME, command: 'false' }).join(' ')]:
        { exitCode: 3, stdout: 'partial', stderr: 'nope' },
    });

    expect(await manager.execCommand({ command: 'false', timeoutSeconds: 5 }))
      .toEqual({ success: true, exitCode: 3, stdout: 'partial', stderr: 'nope' });
  });

  it('truncates oversized stdout and stderr with an explicit marker', async () => {
    // 10x the cap — a real runaway build log, not a marginal overflow.
    const huge = 'y'.repeat(VM_OUTPUT_LIMIT_BYTES * 10);
    const { manager } = await entered({
      [buildExecArgs({ containerName: NAME, command: 'noisy' }).join(' ')]: { stdout: huge, stderr: huge },
    });

    const result = await manager.execCommand({ command: 'noisy', timeoutSeconds: 5 }) as
      { success: true; stdout: string; stderr: string };

    for (const stream of [result.stdout, result.stderr]) {
      expect(stream).toContain(`truncated ${VM_OUTPUT_LIMIT_BYTES * 9} of ${huge.length}`);
      // The whole point: the payload is bounded by the cap plus the marker,
      // however large the command's output was.
      expect(stream.length).toBeLessThan(VM_OUTPUT_LIMIT_BYTES + 200);
    }
  });

  it('tells the caller to run enter_vm first when no container exists', async () => {
    const { manager, runner } = makeManager(CLI_OK_NO_CONTAINER);

    const result = await manager.execCommand({ command: 'ls', timeoutSeconds: 5 });

    expect(result).toEqual({ success: false, error: 'No sandbox VM is running for this thread. Call enter_vm first.' });
    expect(runner.ran('exec')).toBe(false);
  });

  it('adopts a container left running by a previous session (plugin reload)', async () => {
    // Untracked in memory, but the deterministic name still finds it.
    const { manager, runner } = makeManager({ '--version': { stdout: 'v' } });

    const result = await manager.execCommand({ command: 'ls', timeoutSeconds: 5 });

    expect(result).toEqual({ success: true, exitCode: 0, stdout: '', stderr: '' });
    expect(runner.ran('exec')).toBe(true);
    expect(manager.getActive()?.containerName).toBe(NAME);
  });

  it('returns the install hint rather than throwing when the CLI is gone', async () => {
    const { manager } = makeManager({ '--version': new VmUnavailableError() });
    const result = await manager.execCommand({ command: 'ls', timeoutSeconds: 5 });
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('brew install container');
  });
});

describe('SandboxVmManager — exit', () => {
  async function entered(extra: Record<string, Scripted> = {}) {
    const ctx = makeManager({ ...CLI_OK_NO_CONTAINER, ...extra });
    await ctx.manager.enter({ image: 'img:1', mountPath: '/a', network: 'default' });
    ctx.runner.calls.length = 0;
    return ctx;
  }

  it('stops gracefully, then removes, and clears the tracked state', async () => {
    const { manager, runner } = await entered();

    expect(await manager.exit()).toEqual({ success: true, removedContainer: NAME });
    expect(runner.argvs()).toEqual([`stop ${NAME}`, `rm --force ${NAME}`]);
    expect(manager.getActive()).toBeNull();
  });

  it('skips the graceful stop when force is set', async () => {
    const { manager, runner } = await entered();

    expect((await manager.exit({ force: true })).success).toBe(true);
    expect(runner.ran('stop')).toBe(false);
    expect(runner.argvs()).toEqual([`rm --force ${NAME}`]);
  });

  it('still removes the container when the graceful stop fails', async () => {
    const { manager, runner } = await entered({ [`stop ${NAME}`]: { exitCode: 1, stderr: 'already stopped' } });

    expect((await manager.exit()).success).toBe(true);
    expect(runner.ran('rm')).toBe(true);
  });

  it('leaves the VM tracked when removal fails, so a retry is still possible', async () => {
    const { manager } = await entered({ [`rm --force ${NAME}`]: { exitCode: 1, stderr: 'container is busy\n' } });

    const result = await manager.exit();

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('container is busy');
    expect(manager.getActive()?.containerName).toBe(NAME);
  });

  it('after exit, exec reports there is no VM again', async () => {
    const { manager } = await entered({ [buildInspectArgs(NAME).join(' ')]: MISSING });
    await manager.exit();

    expect(await manager.execCommand({ command: 'ls', timeoutSeconds: 5 }))
      .toEqual({ success: false, error: 'No sandbox VM is running for this thread. Call enter_vm first.' });
  });

  it('after exit, enter can start a fresh VM', async () => {
    const { manager } = await entered({ [buildInspectArgs(NAME).join(' ')]: MISSING });
    await manager.exit();

    expect((await manager.enter({ image: 'img:2', mountPath: '/b', network: 'none' })).success).toBe(true);
    expect(manager.getActive()?.image).toBe('img:2');
  });

  it('removes an untracked container left over from a previous session', async () => {
    const { manager, runner } = makeManager({ '--version': { stdout: 'v' } });

    expect(await manager.exit()).toEqual({ success: true, removedContainer: NAME });
    expect(runner.ran('rm')).toBe(true);
  });

  it('reports plainly when there is nothing to remove', async () => {
    const { manager, runner } = makeManager(CLI_OK_NO_CONTAINER);

    expect(await manager.exit()).toEqual({ success: false, error: 'No sandbox VM is running for this thread.' });
    expect(runner.ran('rm')).toBe(false);
  });

  it('returns the install hint rather than throwing when the CLI is gone', async () => {
    const { manager } = makeManager({ '--version': new VmUnavailableError() });
    const result = await manager.exit();
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('brew install container');
  });
});

describe('SandboxVmManager — mobile safety', () => {
  it('constructing a manager with the real runner touches no Node builtin', () => {
    // The default runner requires child_process inside its closure, so merely
    // building one — which every session does, on every platform — is inert.
    expect(() => new SandboxVmManager({ containerName: () => NAME })).not.toThrow();
  });
});

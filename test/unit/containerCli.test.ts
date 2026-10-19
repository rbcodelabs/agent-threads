/**
 * containerCli.ts: the thin seam over Apple's `container` CLI that the local daemon
 * uses. The real runner is exercised against `node` standing in for the binary.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VM_CPUS,
  DEFAULT_VM_MEMORY,
  VM_LIFECYCLE_TIMEOUT_MS,
  VM_UNAVAILABLE_HINT,
  VmUnavailableError,
  createDefaultVmCommandRunner,
  parseContainerLabels,
  runnerEnv,
} from '../../src/containerCli';

const node = createDefaultVmCommandRunner(process.execPath);

describe('createDefaultVmCommandRunner', () => {
  it('resolves exit 0 with captured stdout and stderr', async () => {
    const r = await node(['-e', 'process.stdout.write("out"); process.stderr.write("err")'], { timeoutMs: VM_LIFECYCLE_TIMEOUT_MS });
    expect(r).toEqual({ exitCode: 0, stdout: 'out', stderr: 'err' });
  });

  it('resolves (does not reject) with the exit code of a command that ran and failed', async () => {
    const r = await node(['-e', 'process.stderr.write("boom"); process.exit(3)'], { timeoutMs: VM_LIFECYCLE_TIMEOUT_MS });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toBe('boom');
  });

  it('rejects with VmUnavailableError when the binary cannot be spawned at all', async () => {
    const missing = createDefaultVmCommandRunner('/nonexistent/container-binary');
    await expect(missing(['--version'], { timeoutMs: 1000 })).rejects.toBeInstanceOf(VmUnavailableError);
  });

  it('writes `input` to the child stdin and closes it (secrets stay out of argv)', async () => {
    const r = await node(['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d.toUpperCase()))'], {
      timeoutMs: VM_LIFECYCLE_TIMEOUT_MS,
      input: 'secret-token',
    });
    expect(r.stdout).toBe('SECRET-TOKEN');
  });

  it('streams output lines to onOutput, splitting on carriage returns too', async () => {
    const lines: string[] = [];
    await node(['-e', 'process.stdout.write("a\\rb\\nc\\n")'], { timeoutMs: VM_LIFECYCLE_TIMEOUT_MS, onOutput: (l) => lines.push(l) });
    expect(lines).toEqual(['a', 'b', 'c']);
  });
});

describe('VmUnavailableError', () => {
  it('names the local daemon and the manual fallback, with the detail appended', () => {
    expect(VM_UNAVAILABLE_HINT).toContain('local daemon');
    expect(VM_UNAVAILABLE_HINT).toContain('brew install container');
    expect(new VmUnavailableError('ENOENT').message).toBe(`${VM_UNAVAILABLE_HINT} (ENOENT)`);
    expect(new VmUnavailableError().message).toBe(VM_UNAVAILABLE_HINT);
  });
});

describe('runnerEnv', () => {
  it('prepends the Homebrew locations so a GUI-launched app finds the CLI', () => {
    const path = runnerEnv(null).PATH!;
    expect(path.startsWith('/opt/homebrew/bin:/usr/local/bin:')).toBe(true);
  });
});

describe('daemon container defaults', () => {
  it('keeps the memory and cpu ceilings the local daemon spec relies on', () => {
    expect(DEFAULT_VM_MEMORY).toBe('4G');
    expect(DEFAULT_VM_CPUS).toBe(4);
  });
});

describe('parseContainerLabels', () => {
  it('reads labels from the `container inspect` array shape', () => {
    const json = JSON.stringify([{ configuration: { labels: { a: '1', b: '2', n: 3 } } }]);
    expect(parseContainerLabels(json)).toEqual({ a: '1', b: '2' });
  });

  it('accepts the flat and docker-style shapes', () => {
    expect(parseContainerLabels(JSON.stringify({ labels: { x: 'y' } }))).toEqual({ x: 'y' });
    expect(parseContainerLabels(JSON.stringify([{ Config: { Labels: { x: 'y' } } }]))).toEqual({ x: 'y' });
  });

  it('returns null for unrecognised or invalid output', () => {
    expect(parseContainerLabels('not json')).toBeNull();
    expect(parseContainerLabels(JSON.stringify([{ configuration: {} }]))).toBeNull();
  });
});

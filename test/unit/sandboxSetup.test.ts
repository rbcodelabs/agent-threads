/**
 * Orchestrator + status tests. Every collaborator is injected, so nothing here
 * touches a real `container` runtime, the network, or the user's VMs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SandboxSetupAbortedError,
  SandboxSetupError,
  estimateSetup,
  getSandboxSetupStatus,
  isSandboxSetupRunning,
  parsePercent,
  runSandboxSetup,
  type SandboxSetupDeps,
  type SandboxSetupProgress,
  type SandboxSetupStatus,
} from '../../src/sandboxSetup';
import { RuntimeAbortError, RuntimeInstallError, RUNTIME_PKG_BYTES, type RuntimeStatus } from '../../src/sandboxRuntime';
import { SandboxImageAbortedError, SandboxImageError } from '../../src/sandboxImage';
import { VmUnavailableError, type VmCommandRunner } from '../../src/sandboxVm';

const SYSTEM_BIN = '/opt/homebrew/bin/container';
const MANAGED_BIN = '/Users/x/Library/Application Support/claude-threads/runtime/1.5.0/bin/container';
const runner: VmCommandRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' });

interface World {
  runtime: RuntimeStatus;
  images: { base: 'ok' | 'missing'; harness: 'ok' | 'missing' | 'stale' };
}
const MISSING: RuntimeStatus = { supported: true, running: false };
const STOPPED: RuntimeStatus = { supported: true, running: false, detected: { source: 'system', binary: SYSTEM_BIN, version: '1.5.0' } };
const RUNNING: RuntimeStatus = { supported: true, running: true, detected: { source: 'system', binary: SYSTEM_BIN, version: '1.5.0' } };

/** Builds mock deps whose call log records global ordering. */
function makeDeps(world: World) {
  const log: string[] = [];
  const deps: SandboxSetupDeps = {
    runtimeDeps: {} as never,
    getRuntimeStatus: vi.fn(async () => world.runtime),
    installManagedRuntime: vi.fn(async (opts) => {
      log.push('install');
      opts?.onProgress?.({ phase: 'downloading', percent: 40, message: 'Downloading' });
      world.runtime = { supported: true, running: false, detected: { source: 'managed', binary: MANAGED_BIN, version: '1.5.0' } };
      return { binary: MANAGED_BIN, version: '1.5.0', alreadyInstalled: false };
    }) as never,
    startRuntime: vi.fn(async (opts) => {
      log.push(`start:${opts.binary}`);
      opts.onProgress?.({ phase: 'starting', message: 'Starting' });
      world.runtime = { ...world.runtime, running: true };
      return { started: true, alreadyRunning: false };
    }) as never,
    getSandboxImageStatus: vi.fn(async () => { log.push('imageStatus'); return world.images; }) as never,
    ensureSandboxImages: vi.fn(async (opts) => {
      log.push('ensure');
      opts.onProgress?.('[1/2] Fetching image 45%');
      return { pulledBase: world.images.base !== 'ok', builtHarness: world.images.harness !== 'ok' };
    }),
    createRunner: vi.fn(() => { log.push('createRunner'); return runner; }),
  };
  return { deps, log };
}

const ALL_OK = { base: 'ok', harness: 'ok' } as const;
const NONE = { base: 'missing', harness: 'missing' } as const;

describe('getSandboxSetupStatus', () => {
  it('reports unsupported with the reason and never probes anything else', async () => {
    const { deps } = makeDeps({ runtime: { supported: false, reason: 'needs macOS 26', running: false }, images: ALL_OK });
    const s = await getSandboxSetupStatus({ deps });
    expect(s).toMatchObject({ supported: false, reason: 'needs macOS 26', runtime: 'missing', running: false });
    expect(s.images).toEqual({ base: 'unknown', harness: 'unknown' });
    expect(deps.getSandboxImageStatus).not.toHaveBeenCalled();
    expect(deps.createRunner).not.toHaveBeenCalled();
  });

  it('runtime missing: images are unknown and NO image probe (or runner) is made', async () => {
    const { deps } = makeDeps({ runtime: MISSING, images: ALL_OK });
    const s = await getSandboxSetupStatus({ deps });
    expect(s).toEqual({ supported: true, runtime: 'missing', running: false, images: { base: 'unknown', harness: 'unknown' } });
    expect(deps.getSandboxImageStatus).not.toHaveBeenCalled();
    expect(deps.createRunner).not.toHaveBeenCalled();
  });

  it('runtime installed but stopped: images unknown, no probe', async () => {
    const { deps } = makeDeps({ runtime: STOPPED, images: ALL_OK });
    const s = await getSandboxSetupStatus({ deps });
    expect(s).toMatchObject({ runtime: 'installed', runtimeSource: 'system', runtimeVersion: '1.5.0', running: false });
    expect(s.images).toEqual({ base: 'unknown', harness: 'unknown' });
    expect(deps.getSandboxImageStatus).not.toHaveBeenCalled();
  });

  it('running: reports the real image status, probing the requested harness image', async () => {
    const { deps } = makeDeps({ runtime: RUNNING, images: { base: 'ok', harness: 'stale' } });
    const s = await getSandboxSetupStatus({ harnessImage: 'custom:2', deps });
    expect(s.images).toEqual({ base: 'ok', harness: 'stale' });
    expect(deps.getSandboxImageStatus).toHaveBeenCalledWith(runner, 'custom:2');
  });

  it('a VmUnavailableError from the image probe degrades to unknown instead of escaping', async () => {
    const { deps } = makeDeps({ runtime: RUNNING, images: ALL_OK });
    deps.getSandboxImageStatus = vi.fn(async () => { throw new VmUnavailableError('ENOENT'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await getSandboxSetupStatus({ deps });
    expect(s.images).toEqual({ base: 'unknown', harness: 'unknown' });
    expect(s.running).toBe(true);
    warn.mockRestore();
  });

  it('managed runtime is reported with its source', async () => {
    const { deps } = makeDeps({
      runtime: { supported: true, running: true, detected: { source: 'managed', binary: MANAGED_BIN, version: '1.5.0' } },
      images: ALL_OK,
    });
    expect((await getSandboxSetupStatus({ deps })).runtimeSource).toBe('managed');
  });
});

describe('runSandboxSetup — step selection', () => {
  beforeEach(() => { expect(isSandboxSetupRunning()).toBe(false); });

  it('fresh Mac: runs install → start → images, in that order, and builds the runner only after install', async () => {
    const { deps, log } = makeDeps({ runtime: MISSING, images: NONE });
    const result = await runSandboxSetup({ deps });
    expect(log).toEqual(['install', `start:${MANAGED_BIN}`, 'createRunner', 'ensure']);
    expect(result).toEqual({
      installedRuntime: true, startedRuntime: true, pulledBase: true, builtHarness: true,
      stepsRun: ['runtime', 'start', 'images'],
    });
    expect(deps.ensureSandboxImages).toHaveBeenCalledWith(expect.objectContaining({ runner, harnessImage: 'claude-threads-harness:1' }));
  });

  it('starts using the SYSTEM binary when a system runtime exists but is stopped (no install)', async () => {
    const { deps, log } = makeDeps({ runtime: STOPPED, images: NONE });
    const result = await runSandboxSetup({ deps });
    expect(deps.installManagedRuntime).not.toHaveBeenCalled();
    expect(log[0]).toBe(`start:${SYSTEM_BIN}`);
    expect(result.stepsRun).toEqual(['start', 'images']);
    expect(result.installedRuntime).toBe(false);
  });

  it('running runtime, missing images: only the image step runs', async () => {
    const { deps } = makeDeps({ runtime: RUNNING, images: { base: 'ok', harness: 'missing' } });
    const result = await runSandboxSetup({ deps });
    expect(deps.installManagedRuntime).not.toHaveBeenCalled();
    expect(deps.startRuntime).not.toHaveBeenCalled();
    expect(result).toMatchObject({ stepsRun: ['images'], pulledBase: false, builtHarness: true });
  });

  it('stale harness image is rebuilt', async () => {
    const { deps } = makeDeps({ runtime: RUNNING, images: { base: 'ok', harness: 'stale' } });
    expect((await runSandboxSetup({ deps })).stepsRun).toEqual(['images']);
  });

  it('everything already in place: no step runs and no progress is reported (safe to click twice)', async () => {
    const { deps } = makeDeps({ runtime: RUNNING, images: ALL_OK });
    const onProgress = vi.fn();
    const result = await runSandboxSetup({ deps, onProgress });
    expect(result.stepsRun).toEqual([]);
    expect(deps.installManagedRuntime).not.toHaveBeenCalled();
    expect(deps.startRuntime).not.toHaveBeenCalled();
    expect(deps.ensureSandboxImages).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('running twice in a row: the second run is a no-op', async () => {
    const world: World = { runtime: MISSING, images: NONE };
    const { deps } = makeDeps(world);
    (deps.ensureSandboxImages as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      world.images = ALL_OK;
      return { pulledBase: true, builtHarness: true };
    });
    await runSandboxSetup({ deps });
    const second = await runSandboxSetup({ deps });
    expect(second.stepsRun).toEqual([]);
    expect(deps.installManagedRuntime).toHaveBeenCalledTimes(1);
    expect(deps.startRuntime).toHaveBeenCalledTimes(1);
  });

  it('unsupported: throws a "check" SandboxSetupError with the reason, running nothing', async () => {
    const { deps } = makeDeps({ runtime: { supported: false, reason: 'needs macOS 26', running: false }, images: ALL_OK });
    const err = await runSandboxSetup({ deps }).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxSetupError);
    expect(err).toMatchObject({ step: 'check', detail: 'needs macOS 26' });
    expect(deps.installManagedRuntime).not.toHaveBeenCalled();
  });
});

describe('runSandboxSetup — progress', () => {
  it('emits a unified model with fixed step numbering, percent and lines', async () => {
    const { deps } = makeDeps({ runtime: MISSING, images: NONE });
    const seen: SandboxSetupProgress[] = [];
    await runSandboxSetup({ deps, onProgress: (p) => seen.push(p) });
    const byStep = (step: string) => seen.filter((p) => p.step === step);
    expect(byStep('runtime').at(-1)).toMatchObject({ stepNumber: 1, totalSteps: 3, percent: 40, line: 'Downloading' });
    expect(byStep('start').at(-1)).toMatchObject({ stepNumber: 2, totalSteps: 3, label: 'Starting the runtime', line: 'Starting' });
    expect(byStep('images').at(-1)).toMatchObject({ stepNumber: 3, percent: 45, line: '[1/2] Fetching image 45%' });
    expect(seen.map((p) => p.stepNumber)).toEqual([...seen.map((p) => p.stepNumber)].sort());
  });

  it('a throwing progress callback never breaks the run', async () => {
    const { deps } = makeDeps({ runtime: MISSING, images: NONE });
    await expect(runSandboxSetup({ deps, onProgress: () => { throw new Error('ui exploded'); } })).resolves.toBeDefined();
  });

  it('parsePercent reads a trailing NN% and rejects nonsense', () => {
    expect(parsePercent('Fetching 7%')).toBe(7);
    expect(parsePercent('100% done')).toBe(100);
    expect(parsePercent('no number')).toBeUndefined();
    expect(parsePercent('999%')).toBeUndefined();
  });
});

describe('runSandboxSetup — errors', () => {
  it('maps a runtime install failure to the runtime step', async () => {
    const { deps } = makeDeps({ runtime: MISSING, images: NONE });
    deps.installManagedRuntime = vi.fn(async () => { throw new RuntimeInstallError('Downloaded runtime failed its SHA-256 check.'); });
    const err = await runSandboxSetup({ deps }).catch((e) => e);
    expect(err).toMatchObject({ name: 'SandboxSetupError', step: 'runtime', detail: 'Downloaded runtime failed its SHA-256 check.' });
    expect(err.message).toContain('Installing the container runtime failed');
    expect(deps.startRuntime).not.toHaveBeenCalled();
  });

  it('maps a start failure to the start step and does not touch images', async () => {
    const { deps } = makeDeps({ runtime: STOPPED, images: NONE });
    deps.startRuntime = vi.fn(async () => { throw new RuntimeInstallError('container system start failed: boom'); });
    const err = await runSandboxSetup({ deps }).catch((e) => e);
    expect(err).toMatchObject({ step: 'start' });
    expect(deps.ensureSandboxImages).not.toHaveBeenCalled();
  });

  it('maps an image failure to the images step, keeping the output tail', async () => {
    const { deps } = makeDeps({ runtime: RUNNING, images: NONE });
    deps.ensureSandboxImages = vi.fn(async () => { throw new SandboxImageError('build', 'Building x failed (exit 1):\nno space left'); });
    const err = await runSandboxSetup({ deps }).catch((e) => e);
    expect(err).toMatchObject({ step: 'images' });
    expect(err.detail).toContain('no space left');
  });

  it('turns VmUnavailableError during images into a friendly images-step error', async () => {
    const { deps } = makeDeps({ runtime: RUNNING, images: NONE });
    deps.ensureSandboxImages = vi.fn(async () => { throw new VmUnavailableError('ENOENT'); });
    const err = await runSandboxSetup({ deps }).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxSetupError);
    expect(err.step).toBe('images');
    expect(err.detail).toContain('could not be run');
  });

  it('wraps unexpected errors with the step they happened in', async () => {
    const { deps } = makeDeps({ runtime: MISSING, images: NONE });
    deps.installManagedRuntime = vi.fn(async () => { throw new Error('EPERM'); });
    expect(await runSandboxSetup({ deps }).catch((e) => e)).toMatchObject({ step: 'runtime', detail: 'EPERM' });
  });

  it('a failed run releases the in-flight slot so the next click can retry', async () => {
    const { deps } = makeDeps({ runtime: MISSING, images: NONE });
    deps.installManagedRuntime = vi.fn(async () => { throw new RuntimeInstallError('offline'); });
    await runSandboxSetup({ deps }).catch(() => undefined);
    expect(isSandboxSetupRunning()).toBe(false);
  });
});

describe('runSandboxSetup — abort', () => {
  it('an already-aborted signal rejects with an AbortError and starts no work', async () => {
    const { deps } = makeDeps({ runtime: MISSING, images: NONE });
    const c = new AbortController(); c.abort();
    const err = await runSandboxSetup({ deps, signal: c.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxSetupAbortedError);
    expect(err.name).toBe('AbortError');
  });

  it('aborting mid-install cancels the run and threads the signal into the installer', async () => {
    const { deps } = makeDeps({ runtime: MISSING, images: NONE });
    let installSignal: AbortSignal | undefined;
    deps.installManagedRuntime = vi.fn((opts) => new Promise((_res, rej) => {
      installSignal = opts?.signal;
      opts?.signal?.addEventListener('abort', () => rej(new RuntimeAbortError()));
    })) as never;
    const c = new AbortController();
    const p = runSandboxSetup({ deps, signal: c.signal });
    await vi.waitFor(() => expect(installSignal).toBeDefined());
    c.abort();
    await expect(p).rejects.toBeInstanceOf(SandboxSetupAbortedError);
    expect(installSignal!.aborted).toBe(true);
    expect(deps.startRuntime).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(isSandboxSetupRunning()).toBe(false));
  });

  it('an aborted image step surfaces as an abort, not a failure', async () => {
    const { deps } = makeDeps({ runtime: RUNNING, images: NONE });
    deps.ensureSandboxImages = vi.fn(async () => { throw new SandboxImageAbortedError(); });
    const c = new AbortController();
    const err = await runSandboxSetup({ deps, signal: c.signal }).catch((e) => e);
    // Not aborted by the caller, but the helper's abort error must still map to an abort.
    expect(err).toBeInstanceOf(SandboxSetupAbortedError);
  });
});

describe('runSandboxSetup — concurrency', () => {
  function gatedDeps() {
    const world: World = { runtime: MISSING, images: NONE };
    const { deps, log } = makeDeps(world);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const install = deps.installManagedRuntime as ReturnType<typeof vi.fn>;
    const base = install.getMockImplementation()!;
    install.mockImplementation(async (opts: never) => { await gate; return base(opts); });
    return { deps, log, release };
  }

  it('concurrent calls share ONE run (one install, one start, one image pass)', async () => {
    const { deps, release } = gatedDeps();
    const a = runSandboxSetup({ deps });
    const b = runSandboxSetup({ deps });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    expect(deps.installManagedRuntime).toHaveBeenCalledTimes(1);
    expect(deps.startRuntime).toHaveBeenCalledTimes(1);
    expect(deps.ensureSandboxImages).toHaveBeenCalledTimes(1);
  });

  it('a joiner gets the current progress immediately and the live stream after', async () => {
    const { deps, release } = gatedDeps();
    const first: SandboxSetupProgress[] = [];
    const second: SandboxSetupProgress[] = [];
    const a = runSandboxSetup({ deps, onProgress: (p) => first.push(p) });
    await vi.waitFor(() => expect(first.length).toBeGreaterThan(0));
    const b = runSandboxSetup({ deps, onProgress: (p) => second.push(p) });
    expect(second[0]).toEqual(first[0]); // replayed
    release();
    await Promise.all([a, b]);
    expect(second.at(-1)).toEqual(first.at(-1));
  });

  it('one caller aborting does not cancel the run while another is still attached', async () => {
    const { deps, release } = gatedDeps();
    const c1 = new AbortController();
    const a = runSandboxSetup({ deps, signal: c1.signal });
    const b = runSandboxSetup({ deps });
    c1.abort();
    await expect(a).rejects.toBeInstanceOf(SandboxSetupAbortedError);
    release();
    await expect(b).resolves.toMatchObject({ stepsRun: ['runtime', 'start', 'images'] });
  });

  it('the run is cancelled once every caller has aborted', async () => {
    const { deps } = gatedDeps();
    const c1 = new AbortController(); const c2 = new AbortController();
    const a = runSandboxSetup({ deps, signal: c1.signal });
    const b = runSandboxSetup({ deps, signal: c2.signal });
    c1.abort(); c2.abort();
    await expect(a).rejects.toBeInstanceOf(SandboxSetupAbortedError);
    await expect(b).rejects.toBeInstanceOf(SandboxSetupAbortedError);
    await vi.waitFor(() => expect(isSandboxSetupRunning()).toBe(false));
  });
});

describe('estimateSetup', () => {
  const base: SandboxSetupStatus = { supported: true, runtime: 'missing', running: false, images: { base: 'unknown', harness: 'unknown' } };

  it('fresh Mac: states the measured runtime + kernel sizes, "several hundred MB" for the image, and no invented figure', () => {
    const text = estimateSetup(base);
    expect(text).toContain(`about ${Math.round(RUNTIME_PKG_BYTES / 1e6)} MB`);
    expect(text).toContain('about 29 MB');
    expect(text).toContain('several hundred MB');
    expect(text).toContain('Claude CLI');
    expect(text).toContain('1.2 GB of free disk space');
    expect(text.match(/\d+(\.\d+)? ?(MB|GB)/g)).toEqual(['118 MB', '29 MB', '1.2 GB']);
  });

  it('runtime present and running, only the harness layer stale: no runtime, kernel or base download', () => {
    const text = estimateSetup({ ...base, runtime: 'installed', running: true, images: { base: 'ok', harness: 'stale' } });
    expect(text).not.toContain('118');
    expect(text).not.toContain('kernel');
    expect(text).not.toContain('several hundred MB');
    expect(text).toContain('Claude CLI');
  });

  it('runtime installed but stopped: hedges the kernel download', () => {
    const text = estimateSetup({ ...base, runtime: 'installed', running: false });
    expect(text).toContain('only if this Mac has not run the runtime before');
    expect(text).not.toContain('118');
  });

  it('ready: says there is nothing to download', () => {
    expect(estimateSetup({ ...base, runtime: 'installed', running: true, images: { base: 'ok', harness: 'ok' } }))
      .toContain('Nothing to download');
  });
});

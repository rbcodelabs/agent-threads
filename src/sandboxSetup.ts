/**
 * sandboxSetup.ts — the one-click "Set up sandbox" orchestrator.
 *
 * Glues `sandboxRuntime` (install + start Apple's `container` runtime) and
 * `sandboxImage` (pull the base image, build the Claude layer) into a single
 * abortable, progress-reporting run, plus a status snapshot a UI can render.
 * No UI code lives here; `sandboxSetupView.ts` turns these types into text.
 *
 * ## Steps (fixed numbering so the UI can say "Step 2 of 3")
 *
 *   1 runtime  install the managed runtime          (skipped if any runtime exists)
 *   2 start    start the runtime's system service   (skipped if running)
 *   3 images   pull the base + build the harness    (skipped if both current)
 *
 * ## Why the image runner is built AFTER install
 *
 * The image helpers drive the `container` CLI by name, found via
 * `runnerEnv()`, which only appends the managed runtime's `bin` directory once
 * it exists on disk. A runner created before step 1 would work today (the env
 * is read per call) but only by accident, so the runner is always created
 * lazily, after the install/start steps.
 */

import {
  RuntimeAbortError,
  RuntimeInstallError,
  RUNTIME_MIN_FREE_BYTES,
  RUNTIME_PKG_BYTES,
  createDefaultRuntimeDeps,
  getRuntimeStatus,
  installManagedRuntime,
  startRuntime,
  type RuntimeDeps,
  type RuntimeProgress,
  type RuntimeSource,
} from './sandboxRuntime';
import {
  SandboxImageAbortedError,
  SandboxImageError,
  SANDBOX_CODING_IMAGE,
  ensureSandboxImages,
  getSandboxImageStatus,
  removeSandboxImages,
  type EnsureSandboxImagesOptions,
  type EnsureSandboxImagesResult,
  type SandboxImageStatus,
} from './sandboxImage';
import {
  VmUnavailableError,
  createDefaultVmCommandRunner,
  type VmCommandRunner,
} from './sandboxVm';
import { DEFAULT_HARNESS_VM_IMAGE } from './harnessVmRouting';

// ── Types ────────────────────────────────────────────────────────────────────

export type SandboxSetupStep = 'runtime' | 'start' | 'images';

export const SANDBOX_SETUP_STEP_NUMBER: Record<SandboxSetupStep, number> = { runtime: 1, start: 2, images: 3 };
export const SANDBOX_SETUP_TOTAL_STEPS = 3;

/** Images are 'unknown' when the runtime is missing or stopped: probing them would fail. */
export type SandboxImageState<T extends string> = T | 'unknown';

export interface SandboxSetupStatus {
  supported: boolean;
  /** Present when `supported` is false. */
  reason?: string;
  runtime: 'missing' | 'installed';
  runtimeSource?: RuntimeSource;
  runtimeVersion?: string;
  running: boolean;
  images: {
    base: SandboxImageState<SandboxImageStatus['base']>;
    harness: SandboxImageState<SandboxImageStatus['harness']>;
  };
}

export interface SandboxSetupProgress {
  step: SandboxSetupStep;
  stepNumber: number;
  totalSteps: number;
  /** Short present-tense description of the step, e.g. "Starting the runtime". */
  label: string;
  /** 0-100 when the current operation reports one (downloads). */
  percent?: number;
  /** Latest human-readable detail (a phase message or a line of CLI output). */
  line?: string;
}
export type SandboxSetupProgressFn = (p: SandboxSetupProgress) => void;

export interface SandboxSetupResult {
  installedRuntime: boolean;
  startedRuntime: boolean;
  pulledBase: boolean;
  builtHarness: boolean;
  /** Steps that actually ran, in order. Empty when everything was already in place. */
  stepsRun: SandboxSetupStep[];
}

export type SandboxSetupErrorStep = SandboxSetupStep | 'check';

/** A failed setup; `step` names where, `detail` is the underlying message (with any output tail). */
export class SandboxSetupError extends Error {
  constructor(readonly step: SandboxSetupErrorStep, readonly detail: string) {
    super(`${STEP_FAILED_PREFIX[step]}: ${detail}`);
    this.name = 'SandboxSetupError';
  }
}

export class SandboxSetupAbortedError extends Error {
  constructor() {
    super('Sandbox setup was cancelled.');
    this.name = 'AbortError';
  }
}

const STEP_FAILED_PREFIX: Record<SandboxSetupErrorStep, string> = {
  check: 'Sandbox setup is not available',
  runtime: 'Installing the container runtime failed',
  start: 'Starting the container runtime failed',
  images: 'Preparing the sandbox image failed',
};

const STEP_LABEL: Record<SandboxSetupStep, string> = {
  runtime: 'Installing the container runtime',
  start: 'Starting the runtime',
  images: 'Preparing the sandbox image',
};

// ── Dependency seam ──────────────────────────────────────────────────────────

/** Every collaborator, injectable so unit tests need no runtime, network or macOS 26. */
export interface SandboxSetupDeps {
  runtimeDeps?: RuntimeDeps;
  getRuntimeStatus?: typeof getRuntimeStatus;
  installManagedRuntime?: typeof installManagedRuntime;
  startRuntime?: typeof startRuntime;
  getSandboxImageStatus?: typeof getSandboxImageStatus;
  removeSandboxImages?: typeof removeSandboxImages;
  ensureSandboxImages?: (opts: EnsureSandboxImagesOptions) => Promise<EnsureSandboxImagesResult>;
  /** Called lazily, once per operation that needs it, never before the runtime step has finished. */
  createRunner?: () => VmCommandRunner;
}

interface ResolvedDeps {
  runtimeDeps: RuntimeDeps;
  getRuntimeStatus: typeof getRuntimeStatus;
  installManagedRuntime: typeof installManagedRuntime;
  startRuntime: typeof startRuntime;
  getSandboxImageStatus: typeof getSandboxImageStatus;
  removeSandboxImages: typeof removeSandboxImages;
  ensureSandboxImages: (opts: EnsureSandboxImagesOptions) => Promise<EnsureSandboxImagesResult>;
  createRunner: () => VmCommandRunner;
}

function resolveDeps(deps: SandboxSetupDeps = {}): ResolvedDeps {
  return {
    runtimeDeps: deps.runtimeDeps ?? createDefaultRuntimeDeps(),
    getRuntimeStatus: deps.getRuntimeStatus ?? getRuntimeStatus,
    installManagedRuntime: deps.installManagedRuntime ?? installManagedRuntime,
    startRuntime: deps.startRuntime ?? startRuntime,
    getSandboxImageStatus: deps.getSandboxImageStatus ?? getSandboxImageStatus,
    removeSandboxImages: deps.removeSandboxImages ?? removeSandboxImages,
    ensureSandboxImages: deps.ensureSandboxImages ?? ensureSandboxImages,
    createRunner: deps.createRunner ?? (() => createDefaultVmCommandRunner()),
  };
}

// ── Status ───────────────────────────────────────────────────────────────────

export interface SandboxSetupStatusOptions {
  /** Harness image tag to check; defaults to `claude-threads-harness:1`. */
  harnessImage?: string;
  deps?: SandboxSetupDeps;
}

const UNKNOWN_IMAGES: SandboxSetupStatus['images'] = { base: 'unknown', harness: 'unknown' };

/**
 * One snapshot for a UI. Image probes only run when the runtime is installed
 * AND running (they would fail with `VmUnavailableError` otherwise); any
 * failure while probing degrades to `'unknown'` instead of escaping.
 */
export async function getSandboxSetupStatus(opts: SandboxSetupStatusOptions = {}): Promise<SandboxSetupStatus> {
  return (await readStatus(opts)).status;
}

async function readStatus(opts: SandboxSetupStatusOptions): Promise<{ status: SandboxSetupStatus; binary?: string }> {
  const d = resolveDeps(opts.deps);
  const rt = await d.getRuntimeStatus(d.runtimeDeps);
  if (!rt.supported) {
    return { status: { supported: false, reason: rt.reason, runtime: 'missing', running: false, images: { ...UNKNOWN_IMAGES } } };
  }
  if (!rt.detected) {
    return { status: { supported: true, runtime: 'missing', running: false, images: { ...UNKNOWN_IMAGES } } };
  }
  const binary = rt.detected.binary;
  const base = {
    supported: true,
    runtime: 'installed' as const,
    runtimeSource: rt.detected.source,
    ...(rt.detected.version ? { runtimeVersion: rt.detected.version } : {}),
    running: rt.running,
  };
  if (!rt.running) return { status: { ...base, images: { ...UNKNOWN_IMAGES } }, binary };

  try {
    const images = await d.getSandboxImageStatus(d.createRunner(), opts.harnessImage ?? DEFAULT_HARNESS_VM_IMAGE);
    return { status: { ...base, images }, binary };
  } catch (err) {
    // VmUnavailableError (CLI vanished between probes) or a timeout: a status
    // read must never throw into the UI.
    console.warn('[ClaudeThreads] sandbox image status unavailable:', err instanceof Error ? err.message : err);
    return { status: { ...base, images: { ...UNKNOWN_IMAGES } }, binary };
  }
}

/** True when nothing is left to do. */
export function isSandboxReady(status: SandboxSetupStatus): boolean {
  return status.supported && status.runtime === 'installed' && status.running
    && status.images.base === 'ok' && status.images.harness === 'ok';
}

// ── Estimate ─────────────────────────────────────────────────────────────────

const KERNEL_MB = 29; // observed (verified) size of the Linux kernel `container system start` fetches

/**
 * Honest description of what a run would download. Only figures we have
 * measured are stated; the base image is deliberately "several hundred MB".
 */
export function estimateSetup(status: SandboxSetupStatus): string {
  const items: string[] = [];
  const runtimeMissing = status.runtime === 'missing';
  if (runtimeMissing) {
    items.push(`the container runtime (about ${Math.round(RUNTIME_PKG_BYTES / 1e6)} MB)`);
  }
  if (runtimeMissing || !status.running) {
    items.push(runtimeMissing
      ? `a Linux kernel (about ${KERNEL_MB} MB)`
      : `a Linux kernel (about ${KERNEL_MB} MB, only if this Mac has not run the runtime before)`);
  }
  const baseNeeded = status.images.base !== 'ok';
  const harnessNeeded = status.images.harness !== 'ok';
  if (baseNeeded) items.push('the sandbox base image (several hundred MB)');
  if (harnessNeeded) items.push('the Claude CLI, installed from Anthropic while building the final image layer');
  if (items.length === 0) return 'Nothing to download — the sandbox is already set up.';
  const list = items.length === 1 ? items[0]! : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  const disk = runtimeMissing ? ` You need at least ${(RUNTIME_MIN_FREE_BYTES / 1e9).toFixed(1)} GB of free disk space.` : '';
  return `This will download ${list}.${disk}`;
}

// ── Run ──────────────────────────────────────────────────────────────────────

export interface RunSandboxSetupOptions {
  onProgress?: SandboxSetupProgressFn;
  signal?: AbortSignal;
  /** Harness image tag to build; defaults to `claude-threads-harness:1`. */
  harnessImage?: string;
  deps?: SandboxSetupDeps;
}

interface SharedRun {
  harnessImage: string;
  promise: Promise<SandboxSetupResult>;
  controller: AbortController;
  listeners: Set<SandboxSetupProgressFn>;
  /** Callers still attached and not aborted; the run is cancelled only when this hits 0. */
  subscribers: number;
  last?: SandboxSetupProgress;
}

let sharedRun: SharedRun | null = null;

/** True while a setup run is in flight in this process. */
export function isSandboxSetupRunning(): boolean {
  return sharedRun !== null;
}

/**
 * Runs whatever setup is still needed. Idempotent: satisfied steps are
 * skipped, so a second click is safe. Concurrent calls (same harness image)
 * share ONE run — a joiner receives the current progress immediately and the
 * live stream after; the run is aborted only once every attached caller has
 * aborted. Rejects with `SandboxSetupAbortedError` on cancel and
 * `SandboxSetupError` (naming the step) on failure.
 */
export async function runSandboxSetup(opts: RunSandboxSetupOptions = {}): Promise<SandboxSetupResult> {
  const harnessImage = opts.harnessImage ?? DEFAULT_HARNESS_VM_IMAGE;
  while (sharedRun && sharedRun.harnessImage !== harnessImage) {
    await sharedRun.promise.catch(() => undefined);
  }
  if (!sharedRun) sharedRun = startSharedRun(harnessImage, opts.deps);
  return subscribe(sharedRun, opts.onProgress, opts.signal);
}

function startSharedRun(harnessImage: string, deps?: SandboxSetupDeps): SharedRun {
  const controller = new AbortController();
  const listeners = new Set<SandboxSetupProgressFn>();
  const run: SharedRun = {
    harnessImage, controller, listeners, subscribers: 0,
    promise: Promise.resolve(null as never),
  };
  const emit: SandboxSetupProgressFn = (p) => {
    run.last = p;
    for (const l of listeners) {
      try { l(p); } catch { /* a UI callback must not break the run */ }
    }
  };
  run.promise = execute({ harnessImage, signal: controller.signal, emit, deps }).finally(() => {
    if (sharedRun === run) sharedRun = null;
  });
  // The run's own rejection is delivered to subscribers; this stops it also being reported as unhandled.
  run.promise.catch(() => undefined);
  return run;
}

function subscribe(run: SharedRun, onProgress?: SandboxSetupProgressFn, signal?: AbortSignal): Promise<SandboxSetupResult> {
  return new Promise<SandboxSetupResult>((resolve, reject) => {
    let attached = true;
    const listener: SandboxSetupProgressFn = (p) => { if (attached) onProgress?.(p); };
    const detach = () => {
      if (!attached) return;
      attached = false;
      run.listeners.delete(listener);
      signal?.removeEventListener('abort', onAbort);
      run.subscribers--;
    };
    const onAbort = () => {
      if (!attached) return;
      detach();
      if (run.subscribers === 0) run.controller.abort();
      reject(new SandboxSetupAbortedError());
    };
    run.subscribers++;
    run.listeners.add(listener);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (run.last) listener(run.last);
    run.promise.then(
      (result) => { if (attached) { detach(); resolve(result); } },
      (err) => { if (attached) { detach(); reject(err); } },
    );
  });
}

/** Extracts a trailing "NN%" from a CLI output line (pull output); undefined when absent. */
export function parsePercent(line: string): number | undefined {
  const m = /(\d{1,3})%/.exec(line);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 0 && n <= 100 ? n : undefined;
}

async function execute(params: {
  harnessImage: string;
  signal: AbortSignal;
  emit: SandboxSetupProgressFn;
  deps?: SandboxSetupDeps;
}): Promise<SandboxSetupResult> {
  const { harnessImage, signal, emit } = params;
  const d = resolveDeps(params.deps);
  const result: SandboxSetupResult = {
    installedRuntime: false, startedRuntime: false, pulledBase: false, builtHarness: false, stepsRun: [],
  };
  const report = (step: SandboxSetupStep, extra: { percent?: number; line?: string } = {}) =>
    emit({
      step, stepNumber: SANDBOX_SETUP_STEP_NUMBER[step], totalSteps: SANDBOX_SETUP_TOTAL_STEPS,
      label: STEP_LABEL[step], ...extra,
    });
  const checkAborted = () => { if (signal.aborted) throw new SandboxSetupAbortedError(); };

  const read = await readStatus({ harnessImage, deps: params.deps });
  const status = read.status;
  checkAborted();
  if (!status.supported) throw new SandboxSetupError('check', status.reason ?? 'This Mac cannot run sandboxed VMs.');

  // Maps a step's failure onto SandboxSetupError / SandboxSetupAbortedError.
  const guard = async <T>(step: SandboxSetupStep, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (signal.aborted || err instanceof RuntimeAbortError || err instanceof SandboxImageAbortedError
        || err instanceof SandboxSetupAbortedError) {
        throw new SandboxSetupAbortedError();
      }
      if (err instanceof SandboxSetupError) throw err;
      if (err instanceof VmUnavailableError) {
        throw new SandboxSetupError(step, 'The `container` command could not be run even after setup. '
          + 'Reopen Obsidian and try again.');
      }
      if (err instanceof RuntimeInstallError || err instanceof SandboxImageError) {
        throw new SandboxSetupError(step, err.message);
      }
      throw new SandboxSetupError(step, err instanceof Error ? err.message : String(err));
    }
  };

  let binary = read.binary;

  // (1) runtime
  if (status.runtime === 'missing') {
    result.stepsRun.push('runtime');
    report('runtime', { line: 'Preparing to download' });
    const installed = await guard('runtime', () => d.installManagedRuntime({
      signal,
      deps: d.runtimeDeps,
      onProgress: (p: RuntimeProgress) => report('runtime', {
        ...(p.percent !== undefined ? { percent: p.percent } : {}),
        ...(p.message ? { line: p.message } : {}),
      }),
    }));
    result.installedRuntime = !installed.alreadyInstalled;
    binary = installed.binary;
  }
  checkAborted();

  // (2) start
  if (status.runtime === 'missing' || !status.running) {
    result.stepsRun.push('start');
    report('start', { line: 'Starting the container runtime (first start downloads a Linux kernel)' });
    if (!binary) {
      throw new SandboxSetupError('start', 'Could not find the container command to start.');
    }
    const startBinary = binary;
    const started = await guard('start', () => d.startRuntime({
      binary: startBinary,
      deps: d.runtimeDeps,
      onProgress: (p: RuntimeProgress) => report('start', p.message ? { line: p.message } : {}),
    }));
    result.startedRuntime = started.started;
  }
  checkAborted();

  // (3) images — unknown counts as "needed" (the runtime was down when we looked)
  const imagesCurrent = status.images.base === 'ok' && status.images.harness === 'ok';
  if (!imagesCurrent) {
    result.stepsRun.push('images');
    report('images', { line: 'Checking images' });
    const ensured = await guard('images', () => d.ensureSandboxImages({
      // Built now, after the runtime is installed/started (see file header).
      runner: d.createRunner(),
      harnessImage,
      signal,
      onProgress: (line) => {
        const percent = parsePercent(line);
        report('images', { line, ...(percent !== undefined ? { percent } : {}) });
      },
    }));
    result.pulledBase = ensured.pulledBase;
    result.builtHarness = ensured.builtHarness;
  }
  return result;
}

// ── Reset ────────────────────────────────────────────────────────────────────

/** What a reset will do, for the confirmation dialog. */
export function describeReset(harnessImage: string = DEFAULT_HARNESS_VM_IMAGE): string {
  return `This removes the local sandbox images (${SANDBOX_CODING_IMAGE} and ${harnessImage}) and downloads and `
    + 'rebuilds them from scratch (the base image is several hundred MB). Stop any running sandbox VMs first, '
    + 'otherwise the images cannot be removed. Threads started afterwards use the fresh image. Continue?';
}

/**
 * Removes the local coding + harness images, then runs the normal setup so
 * they are pulled/rebuilt from scratch. Fails up front, before removing
 * anything, if a setup run is already in flight; if removal fails (an image in
 * use by a running VM) it stops with that error rather than rebuilding on top
 * of a half-removed state. When the runtime is not installed/running there is
 * nothing to remove and this is just a normal setup.
 */
export async function resetSandbox(opts: RunSandboxSetupOptions = {}): Promise<SandboxSetupResult> {
  const harnessImage = opts.harnessImage ?? DEFAULT_HARNESS_VM_IMAGE;
  if (isSandboxSetupRunning()) {
    throw new SandboxSetupError('check', 'A sandbox setup is already running. Wait for it to finish, then reset.');
  }
  const d = resolveDeps(opts.deps);
  const { status } = await readStatus({ harnessImage, deps: opts.deps });
  if (!status.supported) throw new SandboxSetupError('check', status.reason ?? 'This Mac cannot run sandboxed VMs.');
  if (status.runtime === 'installed' && status.running) {
    opts.onProgress?.({
      step: 'images', stepNumber: SANDBOX_SETUP_STEP_NUMBER.images, totalSteps: SANDBOX_SETUP_TOTAL_STEPS,
      label: 'Removing the old sandbox images',
    });
    try {
      await d.removeSandboxImages({ runner: d.createRunner(), harnessImage, signal: opts.signal });
    } catch (err) {
      if (opts.signal?.aborted || err instanceof SandboxImageAbortedError) throw new SandboxSetupAbortedError();
      if (err instanceof VmUnavailableError) {
        throw new SandboxSetupError('images', 'The `container` command could not be run. Reopen Obsidian and try again.');
      }
      throw new SandboxSetupError('images', err instanceof Error ? err.message : String(err));
    }
  }
  return runSandboxSetup(opts);
}

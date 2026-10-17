/**
 * Local daemon: the container-runtime steps (install the managed runtime,
 * start its system service), reusing `sandboxRuntime.ts` unchanged. Kept here
 * rather than refactoring `sandboxSetup.ts` so the sandbox feature and its
 * tests are untouched; the error mapping mirrors that file's `guard`.
 */

import {
  RuntimeAbortError,
  RuntimeInstallError,
  createDefaultRuntimeDeps,
  getRuntimeStatus,
  installManagedRuntime,
  startRuntime,
  type RuntimeDeps,
  type RuntimeProgress,
  type RuntimeStatus,
} from '../sandboxRuntime';
import { VmUnavailableError } from '../sandboxVm';
import { LocalDaemonAbortedError, LocalDaemonError } from './provision';

/** The runtime operations, injectable so tests need no macOS 26 and no download. */
export interface RuntimeApi {
  status(): Promise<RuntimeStatus>;
  install(opts: { signal?: AbortSignal; onProgress?: (p: RuntimeProgress) => void }): Promise<{ binary: string }>;
  start(opts: { binary: string; onProgress?: (p: RuntimeProgress) => void }): Promise<unknown>;
}

export function createDefaultRuntimeApi(deps: RuntimeDeps = createDefaultRuntimeDeps()): RuntimeApi {
  return {
    status: () => getRuntimeStatus(deps),
    install: ({ signal, onProgress }) => installManagedRuntime({ signal, deps, onProgress }),
    start: ({ binary, onProgress }) => startRuntime({ binary, deps, onProgress }),
  };
}

export interface RuntimeFacts {
  supported: boolean;
  reason?: string;
  installed: boolean;
  running: boolean;
  binary?: string;
}

export async function readRuntime(api: RuntimeApi): Promise<RuntimeFacts> {
  try {
    const s = await api.status();
    if (!s.supported) return { supported: false, ...(s.reason ? { reason: s.reason } : {}), installed: false, running: false };
    return { supported: true, installed: !!s.detected, running: s.running, ...(s.detected ? { binary: s.detected.binary } : {}) };
  } catch {
    // A status read must never throw into the UI: treat as supported-but-not-running.
    return { supported: true, installed: false, running: false };
  }
}

function mapError(err: unknown, signal?: AbortSignal): never {
  if (signal?.aborted || err instanceof RuntimeAbortError || err instanceof LocalDaemonAbortedError) throw new LocalDaemonAbortedError();
  if (err instanceof LocalDaemonError) throw err;
  if (err instanceof VmUnavailableError) {
    throw new LocalDaemonError('runtime', 'The `container` command could not be run even after setup. Reopen Geode and try again.');
  }
  if (err instanceof RuntimeInstallError) throw new LocalDaemonError('runtime', err.message);
  throw new LocalDaemonError('runtime', err instanceof Error ? err.message : String(err));
}

export async function installRuntime(api: RuntimeApi, d: { signal?: AbortSignal; report?: (line: string) => void }): Promise<string> {
  d.report?.('Installing the container runtime');
  try {
    const r = await api.install({ signal: d.signal, onProgress: (p) => { if (p.message) d.report?.(p.message); } });
    return r.binary;
  } catch (err) {
    return mapError(err, d.signal);
  }
}

export async function startRuntimeService(api: RuntimeApi, binary: string, d: { signal?: AbortSignal; report?: (line: string) => void }): Promise<void> {
  d.report?.('Starting the container runtime (first start downloads a Linux kernel)');
  try {
    await api.start({ binary, onProgress: (p) => { if (p.message) d.report?.(p.message); } });
  } catch (err) {
    mapError(err, d.signal);
  }
}

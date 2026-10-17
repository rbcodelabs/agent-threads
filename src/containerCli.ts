/**
 * containerCli.ts — thin seam over Apple's `container` CLI, used by the local
 * daemon (src/localDaemon/*) to provision and manage its container.
 *
 * (This file was `sandboxVm.ts` when the plugin also ran per-thread sandbox
 * VMs. Those are gone; only the command runner and the few helpers the local
 * daemon needs remain.)
 *
 * ## Node builtins are required lazily
 *
 * This plugin loads on Obsidian desktop AND mobile, where `require()` returns
 * null for Node built-ins. `child_process` is `require`d inside the runner
 * closure — never at module scope. Importing this module is therefore always
 * safe; only *calling* into the CLI needs a Node environment.
 */

import { managedRuntimeBinDirIfPresent } from './sandboxRuntime';

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Apple's `container` CLI defaults to 1 GiB per VM, which is too little for the
 * daemon once the harness is resident. Cap is a ceiling, not a reservation.
 */
export const DEFAULT_VM_MEMORY = '4G';
export const DEFAULT_VM_CPUS = 4;

/** Byte cap applied to captured stdout/stderr of CLI calls. */
export const VM_OUTPUT_LIMIT_BYTES = 100_000;

/** Longest any lifecycle command (run/exec-probe/stop/rm/network) may take. */
export const VM_LIFECYCLE_TIMEOUT_MS = 120_000;

/** The binary. Not configurable: the whole design is specific to this CLI's semantics. */
export const VM_BINARY = 'container';

/**
 * Shown whenever the CLI cannot be found or reached. Names the two setup steps
 * people actually miss — installing it, and starting the system service — so a
 * failed call is self-diagnosing instead of a bare ENOENT.
 */
export const VM_UNAVAILABLE_HINT =
  `The \`${VM_BINARY}\` CLI is unavailable. The local daemon needs Apple's container runtime `
  + '(macOS 26+ on Apple silicon). Agent Threads can set it up for you from the Local daemon panel. '
  + 'Manual fallback: `brew install container`, then `container system start`. '
  + 'The local daemon is desktop-only and is not available on mobile.';


// ── Command execution seam ───────────────────────────────────────────────────

export interface VmCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Minimal seam over `child_process.execFile`, mirroring `GitDiffExecFile` in
 * GitDiffService: injected so tests exercise real command construction and
 * state transitions without a macOS 26 runtime (CI has none).
 *
 * Implementations must RESOLVE with a non-zero `exitCode` for a command that
 * ran and failed, and REJECT only when the binary itself could not be run.
 */
export type VmCommandRunner = (
  args: string[],
  opts: VmCommandRunOptions,
) => Promise<VmCommandResult>;

/**
 * Options for a single runner call. Everything but `timeoutMs` is optional and
 * only used by long-running, chatty commands (image pull/build): `onOutput`
 * receives stdout/stderr lines as they arrive, `maxBufferBytes` raises the
 * captured-output cap, and `signal` kills the child when aborted.
 */
export interface VmCommandRunOptions {
  timeoutMs: number;
  onOutput?: (line: string) => void;
  maxBufferBytes?: number;
  signal?: AbortSignal;
  /**
   * Written to the child's stdin, then closed. Lets secrets (the GitHub token)
   * reach the guest without appearing in argv, which other host processes can read.
   */
  input?: string;
}

/** Thrown by the default runner when the CLI binary cannot be spawned at all. */
export class VmUnavailableError extends Error {
  constructor(detail?: string) {
    super(detail ? `${VM_UNAVAILABLE_HINT} (${detail})` : VM_UNAVAILABLE_HINT);
    this.name = 'VmUnavailableError';
  }
}

/**
 * PATH additions for locating a Homebrew-installed binary.
 *
 * Obsidian is launched from the GUI, so its PATH is the bare launchd default
 * and does not include Homebrew — exactly the reason a `container` that works
 * in Terminal appears missing to the plugin.
 */
export function runnerEnv(
  managedBin: string | null = managedRuntimeBinDirIfPresent(),
): Record<string, string | undefined> {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const extraPath = ['/opt/homebrew/bin', '/usr/local/bin'];
  // The managed runtime goes LAST so a system install (brew / Apple pkg) always wins.
  const tail = managedBin ? `:${managedBin}` : '';
  return { ...env, PATH: `${extraPath.join(':')}:${env.PATH ?? ''}${tail}` };
}

/**
 * Real runner. `child_process` is required inside the returned closure so that
 * building a runner — which happens for every session, on every platform — is
 * inert until a VM tool is actually called.
 */
export function createDefaultVmCommandRunner(binary: string = VM_BINARY): VmCommandRunner {
  return (args, opts) =>
    new Promise<VmCommandResult>((resolve, reject) => {
      let execFile: typeof import('child_process').execFile | undefined;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        execFile = (require('child_process') as typeof import('child_process'))?.execFile;
      } catch (err) {
        reject(new VmUnavailableError(err instanceof Error ? err.message : String(err)));
        return;
      }
      if (typeof execFile !== 'function') {
        reject(new VmUnavailableError('child_process is not available on this platform'));
        return;
      }

      const child = execFile(
        binary,
        args,
        {
          timeout: opts.timeoutMs,
          env: runnerEnv() as NodeJS.ProcessEnv,
          maxBuffer: opts.maxBufferBytes ?? VM_OUTPUT_LIMIT_BYTES * 4,
          encoding: 'utf8',
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
            return;
          }
          const code = (error as NodeJS.ErrnoException).code;
          // ENOENT means the binary itself is missing — a setup problem, not a
          // command failure, so it must not be reported as "exit code 1".
          if (code === 'ENOENT' || code === 'EACCES') {
            reject(new VmUnavailableError(String(code)));
            return;
          }
          const exitCode = typeof (error as { code?: unknown }).code === 'number'
            ? (error as unknown as { code: number }).code
            : 1;
          resolve({ exitCode, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        },
      );
      if (opts.onOutput) forwardLines(child, opts.onOutput);
      if (opts.input !== undefined) {
        // EPIPE if the child exits early is reported through the exit code, not here.
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(opts.input);
      }
    });
}

/** Splits a child's stdout+stderr into lines (split on \n or \r, so progress bars update) for a callback. */
function forwardLines(child: import('child_process').ChildProcess, onLine: (line: string) => void): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      const parts = (pending + chunk).split(/[\r\n]+/);
      pending = parts.pop() ?? '';
      for (const line of parts) if (line.trim()) onLine(line);
    });
    stream.on('end', () => {
      if (pending.trim()) onLine(pending);
    });
  }
}

/** Labels from `container inspect` JSON, or null when the shape is not recognised. */
export function parseContainerLabels(stdout: string): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const entry = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | undefined;
    const labels = (entry?.configuration as Record<string, unknown> | undefined)?.labels
      ?? entry?.labels ?? (entry?.Config as Record<string, unknown> | undefined)?.Labels;
    if (!labels || typeof labels !== 'object') return null;
    return Object.fromEntries(Object.entries(labels).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  } catch {
    return null;
  }
}

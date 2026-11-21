/**
 * Shared POSIX process-group lifecycle helpers.
 *
 * Spawning harness CLIs and stdio MCP servers as their own process-group leaders
 * (`detached: true` on POSIX) ensures teardown signals the entire process tree
 * (`-pid`) rather than only the direct child, preventing orphaned grandchildren
 * (e.g. `serena`, `ts-lsp`, or shell subcommands) from lingering after idle reap
 * or session close.
 *
 * Uses type-only `child_process` imports and lazy `require('child_process')` so
 * importing this module remains inert on mobile.
 */
import type { ChildProcess, SpawnOptions } from 'child_process';
import type { SpawnOptions as ClaudeSpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

export const DEFAULT_KILL_GRACE_MS = 3000;

/**
 * Spawn options that place the child in its own process group on POSIX
 * (`detached: true`) or hide the console window on Windows (`windowsHide: true`).
 */
export function processGroupSpawnOptions(): Pick<SpawnOptions, 'detached' | 'windowsHide'> {
  return process.platform === 'win32' ? { windowsHide: true } : { detached: true };
}

/**
 * Synchronously deliver `signal` to the process group led by `pid` on POSIX
 * (`process.kill(-pid, signal)`), falling back to signaling `pid` directly on
 * Windows or when `-pid` returns `ESRCH` (e.g. child is not a group leader).
 * Returns `true` if a signal was delivered, `false` if the process is already gone.
 */
export function killProcessTreeSignal(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (!pid || pid <= 0) return false;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') {
        // Fall through to direct pid signaling for EPERM or similar edge cases.
      }
    }
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function isProcessExited(child: ChildProcess): boolean {
  return child.exitCode != null || child.signalCode != null;
}

function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (killProcessTreeSignal(child.pid, signal)) return true;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

/**
 * Terminate `child` and its entire POSIX process group with `signal` (default
 * `SIGTERM`), escalating to `SIGKILL` after `graceMs` (default 3000 ms) if it
 * has not yet exited. The escalation timer is `.unref()`'d and cleared as soon
 * as the child emits `exit` or `close`.
 */
export function terminateProcessTree(
  child: ChildProcess,
  opts?: { graceMs?: number; signal?: NodeJS.Signals },
): Promise<void> {
  const signal = opts?.signal ?? 'SIGTERM';
  const graceMs = opts?.graceMs ?? DEFAULT_KILL_GRACE_MS;

  if (isProcessExited(child)) {
    // Even if the group leader already exited, grandchildren in the same PGID
    // may still be alive on POSIX — sweep the group best-effort.
    if (child.pid && process.platform !== 'win32') {
      try { process.kill(-child.pid, signal); } catch { /* group already gone */ }
    }
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const done = () => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      child.off?.('exit', done);
      child.off?.('close', done);
      resolve();
    };

    child.once?.('exit', done);
    child.once?.('close', done);

    signalChildTree(child, signal);

    if (isProcessExited(child)) {
      done();
      return;
    }

    killTimer = setTimeout(() => {
      if (settled) return;
      if (isProcessExited(child)) {
        done();
        return;
      }
      const escalated = signalChildTree(child, 'SIGKILL');
      if (!escalated) done();
    }, graceMs);
    (killTimer as { unref?: () => void }).unref?.();
  });
}

/**
 * Creates a `spawnClaudeCodeProcess` callback for `@anthropic-ai/claude-agent-sdk`
 * that spawns Claude Code in its own POSIX process group and routes `kill()` /
 * abort signals through `terminateProcessTree()` so child MCP servers (such as
 * `serena` or `ts-lsp`) are reaped together with the CLI process.
 */
export function createClaudeProcessGroupSpawner(
  onStderr?: (data: string) => void,
  graceMs = DEFAULT_KILL_GRACE_MS,
): (options: ClaudeSpawnOptions) => SpawnedProcess {
  return (options: ClaudeSpawnOptions): SpawnedProcess => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('child_process') as typeof import('child_process');
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...processGroupSpawnOptions(),
    });

    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        onStderr?.(chunk);
      });
      child.stderr.on('error', () => undefined);
    }

    let killed = false;

    const killTree = (signal: NodeJS.Signals = 'SIGTERM'): boolean => {
      killed = true;
      if (signal === 'SIGTERM') {
        void terminateProcessTree(child, { graceMs, signal: 'SIGTERM' });
        return true;
      }
      return signalChildTree(child, signal);
    };

    const onAbort = () => {
      killTree('SIGTERM');
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
        const cleanupAbort = () => {
          options.signal.removeEventListener('abort', onAbort);
        };
        child.once('exit', cleanupAbort);
        child.once('error', cleanupAbort);
      }
    }

    return {
      stdin: child.stdin,
      stdout: child.stdout,
      get killed() {
        return killed || child.killed;
      },
      get exitCode() {
        return child.exitCode;
      },
      get signalCode() {
        return child.signalCode;
      },
      kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
        return killTree(signal);
      },
      on(event: 'exit' | 'error', listener: (...args: any[]) => void): void {
        child.on(event, listener);
      },
      once(event: 'exit' | 'error', listener: (...args: any[]) => void): void {
        child.once(event, listener);
      },
      off(event: 'exit' | 'error', listener: (...args: any[]) => void): void {
        child.off(event, listener);
      },
    };
  };
}

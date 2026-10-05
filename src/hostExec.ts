/**
 * hostExec.ts — the `host_exec` tool's validation and execution core.
 *
 * `host_exec` lets a VM-routed thread (ADR-0015) run ONE command on the real
 * host after an explicit human approval. This module owns everything that is
 * independent of the MCP/UI wiring so it can be tested without either:
 * input validation, the scrubbed environment, bounded output capture, and
 * timeout handling (TERM, then KILL).
 *
 * The approval gate itself lives in `createHostExecHandler`, deliberately NOT
 * in the harness permission path: bypassPermissions / dontAsk / auto-approve
 * never reach it, so no permission mode can skip the prompt. The prompt is the
 * thread's ordinary in-chat permission card, requested through
 * `ThreadManager.requestHostExecApproval`, which forces the card regardless of
 * `alwaysAllowedTools` and offers Allow once / Deny only.
 */
import fs from 'fs';
import path from 'path';
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process';

export const HOST_EXEC_DEFAULT_TIMEOUT_SECONDS = 300;
export const HOST_EXEC_MAX_TIMEOUT_SECONDS = 3600;
/** Per-stream cap. Output past this is drained and discarded, with an explicit marker. */
export const HOST_EXEC_MAX_OUTPUT_BYTES = 64 * 1024;
/** Grace between SIGTERM and SIGKILL when a command times out. */
export const HOST_EXEC_KILL_GRACE_MS = 5000;

/**
 * Variables copied from the host process. An allowlist, not a denylist: the
 * host process environment can hold harness credentials, Anthropic tokens and
 * keychain-derived secrets, and any variable we forgot to deny would leak.
 */
export const HOST_EXEC_ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR',
];

const FALLBACK_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

export function buildHostExecEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of HOST_EXEC_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  if (!env.PATH) env.PATH = FALLBACK_PATH;
  return env;
}

export function resolveHostExecTimeoutSeconds(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return HOST_EXEC_DEFAULT_TIMEOUT_SECONDS;
  }
  return Math.min(Math.floor(requested) || 1, HOST_EXEC_MAX_TIMEOUT_SECONDS);
}

export interface HostExecRequest {
  command: string;
  cwd: string;
  reason: string;
  timeoutSeconds: number;
}

export type HostExecValidation =
  | { ok: true; request: HostExecRequest }
  | { ok: false; error: string };

/** Validates the agent's input. `defaultCwd` is the thread's effective cwd. */
export function validateHostExecInput(
  args: { command?: unknown; cwd?: unknown; reason?: unknown; timeoutSeconds?: unknown },
  defaultCwd: string | undefined,
): HostExecValidation {
  // Native harnesses call handlers without SDK schema parsing, so re-check types.
  if (typeof args.command !== 'string' || args.command.trim() === '') {
    return { ok: false, error: 'command must be a non-empty string.' };
  }
  if (typeof args.reason !== 'string' || args.reason.trim() === '') {
    return { ok: false, error: 'reason must be a non-empty string: the user is shown it when deciding.' };
  }
  const cwd = args.cwd === undefined ? defaultCwd : args.cwd;
  if (typeof cwd !== 'string' || cwd === '') {
    return { ok: false, error: 'No working directory set. Pass an absolute cwd or call set_working_directory first.' };
  }
  if (!path.isAbsolute(cwd)) return { ok: false, error: `cwd must be an absolute path: ${cwd}` };
  let isDir = false;
  try { isDir = fs.statSync(cwd).isDirectory(); } catch { isDir = false; }
  if (!isDir) return { ok: false, error: `cwd is not an existing directory: ${cwd}` };
  const timeout = typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : undefined;
  return {
    ok: true,
    request: {
      command: args.command,
      cwd,
      reason: args.reason.trim(),
      timeoutSeconds: resolveHostExecTimeoutSeconds(timeout),
    },
  };
}

/** The `detail` string for the permission card: command is the headline, the rest expand under Details. */
export function formatHostExecPermissionDetail(request: HostExecRequest): string {
  return JSON.stringify({
    command: request.command,
    cwd: request.cwd,
    reason: request.reason,
    timeoutSeconds: request.timeoutSeconds,
  });
}

export interface HostExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface RunHostCommandOptions {
  /** Test seam. */
  spawn?: SpawnFn;
  env?: Record<string, string>;
  killGraceMs?: number;
  maxOutputBytes?: number;
}

class BoundedCollector {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    const room = this.max - this.size;
    if (room <= 0) { this.truncated = true; return; }
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.size += room;
      this.truncated = true;
    } else {
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
  }
  text(): string {
    const body = Buffer.concat(this.chunks).toString('utf8');
    return this.truncated ? `${body}\n[output truncated at ${this.max} bytes]` : body;
  }
}

/** Runs `command` through `/bin/sh -c` with the scrubbed env. Never rejects for a non-zero exit. */
export function runHostCommand(request: HostExecRequest, options: RunHostCommandOptions = {}): Promise<HostExecResult> {
  const spawnFn = options.spawn ?? (nodeSpawn as SpawnFn);
  const max = options.maxOutputBytes ?? HOST_EXEC_MAX_OUTPUT_BYTES;
  const grace = options.killGraceMs ?? HOST_EXEC_KILL_GRACE_MS;

  return new Promise<HostExecResult>((resolve, reject) => {
    const stdout = new BoundedCollector(max);
    const stderr = new BoundedCollector(max);
    let timedOut = false;
    let settled = false;
    let termTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    // `detached` puts the shell in its own process group so a timeout can take
    // down whatever it spawned, not just the shell. POSIX only (the host here
    // is macOS; the tool is never exposed elsewhere).
    const child = spawnFn('/bin/sh', ['-c', request.command], {
      cwd: request.cwd,
      env: options.env ?? buildHostExecEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    const signalTree = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch { /* already gone */ }
      }
    };

    const finish = (result: HostExecResult) => {
      if (settled) return;
      settled = true;
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    child.stdout?.on('data', (d: Buffer) => stdout.push(Buffer.from(d)));
    child.stderr?.on('data', (d: Buffer) => stderr.push(Buffer.from(d)));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      finish({
        exitCode: code,
        signal: signal ?? null,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
      });
    });

    termTimer = setTimeout(() => {
      timedOut = true;
      signalTree('SIGTERM');
      killTimer = setTimeout(() => signalTree('SIGKILL'), grace);
    }, request.timeoutSeconds * 1000);
  });
}

export interface HostExecHooks {
  /** False for scheduled / headless threads: nobody is present to approve. */
  isInteractive: () => boolean;
  /** Shows the approval card. Resolves true only for an explicit "Allow once". */
  requestApproval: (request: HostExecRequest) => Promise<boolean>;
  /** Defaults to {@link runHostCommand}; tests inject a fake. */
  run?: (request: HostExecRequest) => Promise<HostExecResult>;
  redact?: (text: string) => string;
}

export interface HostExecToolResult {
  success: boolean;
  [key: string]: unknown;
}

/**
 * The gate. Order matters: validate, refuse non-interactive, ask, and only
 * then execute. Nothing here consults the thread's permission mode.
 */
export function createHostExecHandler(hooks: HostExecHooks, getDefaultCwd: () => string | undefined) {
  const redact = hooks.redact ?? ((s: string) => s);
  return async (args: { command?: unknown; cwd?: unknown; reason?: unknown; timeoutSeconds?: unknown }): Promise<HostExecToolResult> => {
    const validation = validateHostExecInput(args, getDefaultCwd());
    if (!validation.ok) return { success: false, status: 'invalid', error: validation.error };
    const request = validation.request;

    if (!hooks.isInteractive()) {
      return {
        success: false,
        status: 'denied',
        error: 'host_exec needs interactive approval and this thread cannot prompt the user (scheduled or headless). The command was not run.',
      };
    }

    let approved = false;
    try {
      approved = await hooks.requestApproval(request);
    } catch {
      return { success: false, status: 'denied', error: 'Host approval was unavailable. The command was not run.' };
    }
    if (!approved) {
      return { success: false, status: 'denied', error: 'The user denied this host command. It was not run.' };
    }

    try {
      const result = await (hooks.run ?? ((r) => runHostCommand(r)))(request);
      return {
        success: true,
        status: 'approved',
        decision: 'allowed-once',
        command: request.command,
        cwd: request.cwd,
        exitCode: result.exitCode,
        ...(result.signal ? { signal: result.signal } : {}),
        ...(result.timedOut ? { timedOut: true, timeoutSeconds: request.timeoutSeconds } : {}),
        stdout: redact(result.stdout),
        stderr: redact(result.stderr),
        ...(result.stdoutTruncated || result.stderrTruncated
          ? { truncated: { stdout: result.stdoutTruncated, stderr: result.stderrTruncated } }
          : {}),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, status: 'approved', decision: 'allowed-once', error: `Approved, but the command failed to start: ${msg}` };
    }
  };
}

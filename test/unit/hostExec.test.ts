import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import {
  buildHostExecEnv,
  createHostExecHandler,
  resolveHostExecTimeoutSeconds,
  runHostCommand,
  validateHostExecInput,
  HOST_EXEC_DEFAULT_TIMEOUT_SECONDS,
  HOST_EXEC_MAX_TIMEOUT_SECONDS,
  type HostExecHooks,
  type HostExecResult,
} from '../../src/hostExec';

const cwd = os.tmpdir();
const okResult: HostExecResult = {
  exitCode: 0, signal: null, stdout: 'hi\n', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false,
};
const args = { command: 'echo hi', reason: 'need host', cwd };

function hooks(over: Partial<HostExecHooks> = {}): HostExecHooks & { requestApproval: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn> } {
  return {
    isInteractive: () => true,
    requestApproval: vi.fn(async () => true),
    run: vi.fn(async () => okResult),
    ...over,
  } as never;
}

describe('validateHostExecInput', () => {
  it('rejects an empty command', () => {
    expect(validateHostExecInput({ command: '  ', reason: 'r', cwd }, cwd)).toMatchObject({ ok: false });
  });
  it('rejects a relative or missing cwd', () => {
    expect(validateHostExecInput({ command: 'ls', reason: 'r', cwd: 'rel' }, undefined)).toMatchObject({ ok: false });
    expect(validateHostExecInput({ command: 'ls', reason: 'r', cwd: '/definitely/not/here' }, undefined)).toMatchObject({ ok: false });
  });
  it('rejects a cwd that is a file', () => {
    const file = `${fs.mkdtempSync(`${cwd}/hx-`)}/f`;
    fs.writeFileSync(file, 'x');
    expect(validateHostExecInput({ command: 'ls', reason: 'r', cwd: file }, undefined)).toMatchObject({ ok: false });
  });
  it('defaults cwd to the thread cwd', () => {
    const v = validateHostExecInput({ command: 'ls', reason: 'r' }, cwd);
    expect(v).toMatchObject({ ok: true, request: { cwd } });
  });
});

describe('timeout resolution', () => {
  it('defaults and caps', () => {
    expect(resolveHostExecTimeoutSeconds(undefined)).toBe(HOST_EXEC_DEFAULT_TIMEOUT_SECONDS);
    expect(resolveHostExecTimeoutSeconds(-5)).toBe(HOST_EXEC_DEFAULT_TIMEOUT_SECONDS);
    expect(resolveHostExecTimeoutSeconds(99999)).toBe(HOST_EXEC_MAX_TIMEOUT_SECONDS);
    expect(resolveHostExecTimeoutSeconds(10)).toBe(10);
  });
});

describe('createHostExecHandler approval gate', () => {
  it('asks for approval on every call and runs only when allowed', async () => {
    const h = hooks();
    const run = createHostExecHandler(h, () => cwd);
    const first = await run(args);
    const second = await run(args);
    expect(h.requestApproval).toHaveBeenCalledTimes(2);
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({ success: true, decision: 'allowed-once', exitCode: 0, stdout: 'hi\n' });
    expect(second.success).toBe(true);
  });

  it('prompts even when the thread is in bypassPermissions (the gate ignores permission mode)', async () => {
    // The handler has no access to, and never reads, a permission mode: the
    // only path to execution is requestApproval resolving true.
    const h = hooks({ requestApproval: vi.fn(async () => false) as never });
    const result = await createHostExecHandler(h, () => cwd)(args);
    expect(h.requestApproval).toHaveBeenCalledTimes(1);
    expect(h.run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, status: 'denied' });
  });

  it('shows the approval card the exact command, cwd and reason', async () => {
    const h = hooks();
    await createHostExecHandler(h, () => cwd)({ ...args, command: 'rm -rf build' });
    expect(h.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ command: 'rm -rf build', cwd, reason: 'need host' }));
  });

  it('auto-denies when the thread is non-interactive, without prompting', async () => {
    const h = hooks({ isInteractive: () => false });
    const result = await createHostExecHandler(h, () => cwd)(args);
    expect(h.requestApproval).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, status: 'denied' });
    expect(String(result.error)).toMatch(/cannot prompt/);
  });

  it('denies when the approval UI throws', async () => {
    const h = hooks({ requestApproval: vi.fn(async () => { throw new Error('gone'); }) as never });
    const result = await createHostExecHandler(h, () => cwd)(args);
    expect(h.run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, status: 'denied' });
  });

  it('does not prompt for invalid input', async () => {
    const h = hooks();
    const result = await createHostExecHandler(h, () => cwd)({ command: '', reason: 'x' });
    expect(h.requestApproval).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, status: 'invalid' });
  });

  it('reports a non-zero exit as a normal result and redacts output', async () => {
    const h = hooks({
      run: vi.fn(async () => ({ ...okResult, exitCode: 3, stdout: 'secret', timedOut: true })) as never,
      redact: s => s.replace('secret', '***'),
    });
    const result = await createHostExecHandler(h, () => cwd)(args);
    expect(result).toMatchObject({ success: true, exitCode: 3, timedOut: true, stdout: '***' });
  });
});

describe('buildHostExecEnv', () => {
  it('passes only the allowlist and drops credentials', () => {
    const env = buildHostExecEnv({
      PATH: '/bin', HOME: '/home/x', ANTHROPIC_API_KEY: 'sk-ant', CLAUDE_CODE_OAUTH_TOKEN: 't', GITHUB_TOKEN: 'g', AWS_SECRET_ACCESS_KEY: 'a',
    } as NodeJS.ProcessEnv);
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/x' });
  });
  it('supplies a fallback PATH', () => {
    expect(buildHostExecEnv({} as NodeJS.ProcessEnv).PATH).toBeTruthy();
  });
});

describe('runHostCommand (real shell)', () => {
  const base = { cwd, reason: 'r', timeoutSeconds: 30 };

  it('does not leak the host process credentials into the command', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-leak-test';
    try {
      const r = await runHostCommand({ ...base, command: 'echo "[$ANTHROPIC_API_KEY]"' });
      expect(r.stdout.trim()).toBe('[]');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('returns a non-zero exit code as a result', async () => {
    const r = await runHostCommand({ ...base, command: 'echo err >&2; exit 7' });
    expect(r.exitCode).toBe(7);
    expect(r.stderr.trim()).toBe('err');
  });

  it('truncates output with an explicit marker', async () => {
    const r = await runHostCommand({ ...base, command: 'yes x | head -c 5000' }, { maxOutputBytes: 100 });
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stdout).toContain('[output truncated at 100 bytes]');
    expect(r.stdout.length).toBeLessThan(200);
  });

  it('times out with TERM then KILL', async () => {
    const started = Date.now();
    const r = await runHostCommand(
      { ...base, timeoutSeconds: 0.2, command: "trap '' TERM; while true; do sleep 1; done" },
      { killGraceMs: 200 },
    );
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe('SIGKILL');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('uses the requested cwd', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(`${cwd}/hxcwd-`));
    const r = await runHostCommand({ ...base, cwd: dir, command: 'pwd -P' });
    expect(r.stdout.trim()).toBe(dir);
  });
});

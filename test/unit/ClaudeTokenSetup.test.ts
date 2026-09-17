import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { extractSetupToken, runClaudeSetupToken, type SpawnFn, type SpawnedProcess } from '../../src/ClaudeTokenSetup';

function fakeProcess(): { proc: SpawnedProcess; stdout: EventEmitter; stderr: EventEmitter; main: EventEmitter; kill: ReturnType<typeof vi.fn> } {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const main = new EventEmitter();
  const kill = vi.fn();
  const proc: SpawnedProcess = {
    stdout: { on: (event, listener) => stdout.on(event, listener) },
    stderr: { on: (event, listener) => stderr.on(event, listener) },
    on: (event, listener) => main.on(event, listener as (...args: unknown[]) => void),
    kill,
  };
  return { proc, stdout, stderr, main, kill };
}

describe('extractSetupToken', () => {
  it('finds a single sk-ant- token amid surrounding CLI chrome', () => {
    const output = '\x1B[32mLogin successful\x1B[0m\nYour token:\nsk-ant-oat01-abcdefghijklmnopqrstuvwxyz\n\nPress Enter to continue.';
    expect(extractSetupToken(output)).toBe('sk-ant-oat01-abcdefghijklmnopqrstuvwxyz');
  });

  it('returns null when no token-shaped string is present', () => {
    expect(extractSetupToken('Login failed: network error')).toBeNull();
  });

  it('returns null when it finds more than one candidate (ambiguous — do not guess)', () => {
    const output = 'sk-ant-oat01-aaaaaaaaaaaaaaaaaaaa sk-ant-api03-bbbbbbbbbbbbbbbbbbbb';
    expect(extractSetupToken(output)).toBeNull();
  });
});

describe('runClaudeSetupToken', () => {
  it('resolves ok with the token on a clean exit', async () => {
    const { proc, stdout, main } = fakeProcess();
    const spawnFn: SpawnFn = vi.fn(() => proc);
    const resultPromise = runClaudeSetupToken('claude', spawnFn);
    stdout.emit('data', Buffer.from('sk-ant-oat01-abcdefghijklmnopqrstuvwxyz\n'));
    main.emit('close', 0);
    await expect(resultPromise).resolves.toEqual({ ok: true, token: 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz' });
    expect(spawnFn).toHaveBeenCalledWith('claude', ['setup-token']);
  });

  it('resolves ok:false with the raw output when no token is found', async () => {
    const { proc, stderr, main } = fakeProcess();
    const spawnFn: SpawnFn = vi.fn(() => proc);
    const resultPromise = runClaudeSetupToken('claude', spawnFn);
    stderr.emit('data', 'not logged in\n');
    main.emit('close', 1);
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('exited with code 1');
      expect(result.rawOutput).toContain('not logged in');
    }
  });

  it('resolves ok:false when the process itself fails to start', async () => {
    const { proc, main } = fakeProcess();
    const spawnFn: SpawnFn = vi.fn(() => proc);
    const resultPromise = runClaudeSetupToken('claude', spawnFn);
    main.emit('error', new Error('ENOENT'));
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('ENOENT');
  });

  it('kills the process and resolves cancelled when the signal aborts', async () => {
    const { proc, kill } = fakeProcess();
    const spawnFn: SpawnFn = vi.fn(() => proc);
    const controller = new AbortController();
    const resultPromise = runClaudeSetupToken('claude', spawnFn, controller.signal);
    controller.abort();
    const result = await resultPromise;
    expect(kill).toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: 'Cancelled.', rawOutput: '' });
  });

  it('resolves cancelled immediately when the signal is already aborted', async () => {
    const { proc } = fakeProcess();
    const spawnFn: SpawnFn = vi.fn(() => proc);
    const controller = new AbortController();
    controller.abort();
    const result = await runClaudeSetupToken('claude', spawnFn, controller.signal);
    expect(result).toEqual({ ok: false, error: 'Cancelled.', rawOutput: '' });
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

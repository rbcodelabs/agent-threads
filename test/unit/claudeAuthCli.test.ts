import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { signInToClaude, type SpawnLike } from '../../src/claudeAuthCli';

/** Minimal fake ChildProcess driven by the test. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => { child.emit('close', null, 'SIGTERM'); return true; });
  return child;
}

function scriptedSpawn(script: Record<string, (child: ReturnType<typeof fakeChild>) => void>) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn: SpawnLike = (command, args) => {
    calls.push({ command, args });
    const child = fakeChild();
    const key = args.join(' ');
    queueMicrotask(() => script[key]?.(child));
    return child as never;
  };
  return { spawn, calls };
}

describe('signInToClaude', () => {
  it('runs `claude auth login`, then confirms with `claude auth status`', async () => {
    const { spawn, calls } = scriptedSpawn({
      'auth login': (c) => {
        c.stdout.emit('data', Buffer.from('Opening browser to sign in…\nIf the browser did not open, visit: https://claude.ai/oauth/authorize?code=abc\n'));
        c.emit('close', 0, null);
      },
      'auth status': (c) => { c.stdout.emit('data', Buffer.from('{"loggedIn": true}')); c.emit('close', 0, null); },
    });
    const progress: string[] = [];
    const urls: string[] = [];
    const result = await signInToClaude('/opt/homebrew/bin/claude', {
      spawn, env: {}, onProgress: (p) => progress.push(p), onUrl: (u) => urls.push(u),
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      { command: '/opt/homebrew/bin/claude', args: ['auth', 'login'] },
      { command: '/opt/homebrew/bin/claude', args: ['auth', 'status'] },
    ]);
    expect(progress).toEqual(['Waiting for browser sign-in…', 'Checking sign-in…']);
    expect(urls).toEqual(['https://claude.ai/oauth/authorize?code=abc']);
  });

  it('fails with the CLI output when login exits non-zero', async () => {
    const { spawn, calls } = scriptedSpawn({
      'auth login': (c) => { c.stderr.emit('data', Buffer.from('Login cancelled')); c.emit('close', 1, null); },
    });
    const result = await signInToClaude('claude', { spawn, env: {} });
    expect(result).toEqual({ ok: false, error: 'Login cancelled' });
    expect(calls).toHaveLength(1);
  });

  it('fails when status still reports signed out', async () => {
    const { spawn } = scriptedSpawn({
      'auth login': (c) => c.emit('close', 0, null),
      'auth status': (c) => { c.stdout.emit('data', Buffer.from('{"loggedIn": false}')); c.emit('close', 1, null); },
    });
    const result = await signInToClaude('claude', { spawn, env: {} });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/still signed out/i);
  });

  it('kills the login process and fails on timeout', async () => {
    vi.useFakeTimers();
    try {
      let loginChild: ReturnType<typeof fakeChild> | undefined;
      const spawn: SpawnLike = () => { loginChild = fakeChild(); return loginChild as never; };
      const pending = signInToClaude('claude', { spawn, env: {}, timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1001);
      const result = await pending;
      expect(loginChild!.kill).toHaveBeenCalled();
      expect(result).toEqual({ ok: false, error: expect.stringMatching(/timed out/i) });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails cleanly when the binary cannot be spawned', async () => {
    const spawn: SpawnLike = () => {
      const c = fakeChild();
      queueMicrotask(() => c.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })));
      return c as never;
    };
    const result = await signInToClaude('claude', { spawn, env: {} });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('ENOENT') });
  });
});

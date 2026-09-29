import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  signInToClaudeInContainer,
  extractToken,
  stripAnsi,
  buildContainerSetupTokenExpectArgs,
  buildContainerSetupTokenEnv,
  EXPECT_BINARY,
  buildKillLeftoverSetupTokenArgs,
  KILL_LEFTOVER_SETUP_TOKEN_SCRIPT,
  CT_CONTAINER_NAME_ENV,
  CT_BINARY_PATH_ENV,
  type SpawnLike,
} from '../../src/claudeContainerAuthCli';

/**
 * Minimal fake `ChildProcess` driven by the test — mirrors claudeAuthCli.
 * test.ts's `fakeChild()` exactly, plus a `stdin.write` spy (the container
 * flow writes the pasted code back through it; the host flow never needs
 * stdin at all).
 */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn() };
  child.kill = vi.fn(() => { child.emit('close', null, 'SIGTERM'); return true; });
  return child;
}

function scriptedSpawnChild(_a: unknown) { return fakeChild() as never; }

function scriptedSpawn() {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    const child = fakeChild();
    children.push(child);
    return child as never;
  };
  return { spawn, calls, children };
}

/** Runs under `vi.useFakeTimers()`; advances past the idle debounce window so the pending onCodePrompt() call fires. */
async function advancePastIdle(ms = 950) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('buildContainerSetupTokenExpectArgs / buildContainerSetupTokenEnv', () => {
  it('builds a fixed Tcl script that reads containerName/containerBinaryPath via $env(...), never interpolated', () => {
    const args = buildContainerSetupTokenExpectArgs();
    expect(args[0]).toBe('-c');
    expect(args[1]).toContain(`$env(${CT_CONTAINER_NAME_ENV})`);
    expect(args[1]).toContain(`$env(${CT_BINARY_PATH_ENV})`);
    expect(args[1]).toContain('spawn container exec -i -t');
    expect(args[1]).toContain('setup-token;');
    expect(args[1]).toMatch(/; interact$/);
    // Never embeds an actual container name or path — the script text is
    // identical regardless of what those values are.
    expect(args[1]).not.toContain('claude-threads-vm');
  });

  it('carries the actual values through the environment instead', () => {
    const env = buildContainerSetupTokenEnv({ PATH: '/bin' }, 'claude-threads-vm-t1', '/home/node/.local/bin/claude');
    expect(env).toEqual({
      PATH: '/bin',
      [CT_CONTAINER_NAME_ENV]: 'claude-threads-vm-t1',
      [CT_BINARY_PATH_ENV]: '/home/node/.local/bin/claude',
    });
  });
});

describe('extractToken', () => {
  it('prefers the documented sk-ant-oat prefix', () => {
    expect(extractToken('some preamble\nsk-ant-oat01-abc123XYZ_-\n')).toBe('sk-ant-oat01-abc123XYZ_-');
  });

  it('picks the LAST prefixed match when more than one appears', () => {
    expect(extractToken('sk-ant-oat01-first\nnoise\nsk-ant-oat01-second')).toBe('sk-ant-oat01-second');
  });

  it('falls back to a bare-token-shaped last line when no prefix matches', () => {
    expect(extractToken('Signed in.\nabcDEF123456789012345\n')).toBe('abcDEF123456789012345');
  });

  it('refuses to guess from a line with spaces or punctuation', () => {
    expect(extractToken('Signed in successfully.')).toBeUndefined();
  });

  it('returns undefined for empty output', () => {
    expect(extractToken('')).toBeUndefined();
  });
});

describe('signInToClaudeInContainer', () => {
  it('spawns /usr/bin/expect with the fixed script and env-carried container identity', async () => {
    const { spawn, calls, children } = scriptedSpawn();
    const pending = signInToClaudeInContainer({
      spawn, hostEnv: { PATH: '/bin' }, containerName: 'claude-threads-vm-t1', containerBinaryPath: '/home/node/.local/bin/claude',
      onCodePrompt: async () => null,
    });
    children[0].stdout.emit('data', Buffer.from('no url yet\n'));
    children[0].emit('close', 1);
    await pending;

    expect(calls[0].command).toBe(EXPECT_BINARY);
    expect(calls[0].args).toEqual(buildContainerSetupTokenExpectArgs());
    expect(calls[0].env).toEqual(buildContainerSetupTokenEnv({ PATH: '/bin' }, 'claude-threads-vm-t1', '/home/node/.local/bin/claude'));
  });

  it('reports the URL, waits for stdout to go idle, prompts for a code once, writes it back with a trailing \\r, and resolves with the token', async () => {
    vi.useFakeTimers();
    try {
      const { spawn, children } = scriptedSpawn();
      const urls: string[] = [];
      const progress: string[] = [];
      const onCodePrompt = vi.fn(async () => '123-456');

      const pending = signInToClaudeInContainer({
        spawn, hostEnv: {}, containerName: 'c', containerBinaryPath: '/claude',
        onProgress: (t) => progress.push(t), onUrl: (u) => urls.push(u), onCodePrompt,
      });
      const child = children[0];
      child.stdout.emit('data', Buffer.from('Open this URL to authorize: https://claude.ai/oauth/authorize?x=1\n'));

      await advancePastIdle();
      expect(onCodePrompt).toHaveBeenCalledTimes(1);
      // Let the onCodePrompt() promise's .then() callback run and write.
      await vi.advanceTimersByTimeAsync(0);
      // Text first, Enter as its own later write (a long code + Enter in one
      // burst is swallowed as a paste by the real TUI — reproduced live).
      expect(child.stdin.write).toHaveBeenCalledTimes(1);
      expect(child.stdin.write).toHaveBeenLastCalledWith('123-456');
      await vi.advanceTimersByTimeAsync(400);
      expect(child.stdin.write).toHaveBeenCalledTimes(2);
      expect(child.stdin.write).toHaveBeenLastCalledWith('\r');

      child.stdout.emit('data', Buffer.from('Success! Your token:\nsk-ant-oat01-final-token\n'));
      child.emit('close', 0);

      const result = await pending;
      expect(result).toEqual({ ok: true, token: 'sk-ant-oat01-final-token' });
      expect(urls).toEqual(['https://claude.ai/oauth/authorize?x=1']);
      expect(progress).toEqual(['Waiting for browser sign-in…', 'Waiting for your login code…', 'Verifying code…']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('strips the CLI\'s own OSC-8 dimmed-copy re-render from the captured URL (live-observed against the real harness image)', async () => {
    vi.useFakeTimers();
    try {
      const { spawn, children } = scriptedSpawn();
      const urls: string[] = [];
      const pending = signInToClaudeInContainer({
        spawn, hostEnv: {}, containerName: 'c', containerBinaryPath: '/claude',
        onUrl: (u) => urls.push(u), onCodePrompt: async () => null,
      });
      const child = children[0];
      // Byte-for-byte the shape `claude setup-token` actually emits: an
      // OSC-8 hyperlink escape wrapping the real URL, closed by BEL, then
      // an SGR-dimmed second copy of the same URL for on-screen display —
      // no whitespace between the two, only control bytes. A plain `\S+`
      // regex spans straight through into the second copy; verified live
      // against claude-threads-harness:1 that this exact byte sequence is
      // what the CLI prints.
      const real = 'https://claude.com/cai/oauth/authorize?code=true&state=abc';
      child.stdout.emit('data', Buffer.from(
        `\x1b]8;id=x;${real}\x07\x1b[37m${real.slice(0, 40)}\x1b[39m\x1b]8;;\x07\r\n`,
      ));
      child.emit('close', 1);
      await pending;

      expect(urls).toEqual([real]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never prompts twice even if more output resets the idle timer after the first prompt fired', async () => {
    vi.useFakeTimers();
    try {
      const { spawn, children } = scriptedSpawn();
      const onCodePrompt = vi.fn(async () => '000-000');
      const pending = signInToClaudeInContainer({
        spawn, hostEnv: {}, containerName: 'c', containerBinaryPath: '/claude', onCodePrompt,
      });
      const child = children[0];
      child.stdout.emit('data', Buffer.from('visit https://claude.ai/a\n'));
      await advancePastIdle();
      expect(onCodePrompt).toHaveBeenCalledTimes(1);

      // More chatter after the prompt already fired — must not re-trigger it.
      child.stdout.emit('data', Buffer.from('still working...\n'));
      await advancePastIdle();
      child.stdout.emit('data', Buffer.from('sk-ant-oat01-tok\n'));
      child.emit('close', 0);
      await pending;

      expect(onCodePrompt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves with a cancellation error and never writes to stdin when onCodePrompt resolves null', async () => {
    vi.useFakeTimers();
    try {
      const { spawn, children } = scriptedSpawn();
      const pending = signInToClaudeInContainer({
        spawn, hostEnv: {}, containerName: 'c', containerBinaryPath: '/claude', onCodePrompt: async () => null,
      });
      const child = children[0];
      child.stdout.emit('data', Buffer.from('https://claude.ai/x\n'));
      await advancePastIdle();
      await vi.advanceTimersByTimeAsync(0);

      const result = await pending;
      expect(result).toEqual({ ok: false, error: 'Sign-in cancelled.' });
      expect(child.stdin.write).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails when the process exits non-zero, and never leaks an already-printed token unredacted', async () => {
    vi.useFakeTimers();
    try {
      const { spawn, children } = scriptedSpawn();
      const pending = signInToClaudeInContainer({
        spawn, hostEnv: {}, containerName: 'c', containerBinaryPath: '/claude', onCodePrompt: async () => '111-111',
      });
      const child = children[0];
      child.stdout.emit('data', Buffer.from('https://claude.ai/x\n'));
      await advancePastIdle();
      await vi.advanceTimersByTimeAsync(0);
      // A token got printed before the process died mid-verification (edge
      // case) — the returned error must never contain it verbatim.
      child.stdout.emit('data', Buffer.from('sk-ant-oat01-leaked-secret\nerror: verification failed\n'));
      child.emit('close', 1);

      const result = await pending;
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).not.toContain('sk-ant-oat01-leaked-secret');
      expect(!result.ok && result.error).toContain('<redacted>');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails when the process exits 0 but no token appears anywhere in the output', async () => {
    vi.useFakeTimers();
    try {
      const { spawn, children } = scriptedSpawn();
      const pending = signInToClaudeInContainer({
        spawn, hostEnv: {}, containerName: 'c', containerBinaryPath: '/claude', onCodePrompt: async () => '222-222',
      });
      const child = children[0];
      child.stdout.emit('data', Buffer.from('https://claude.ai/x\n'));
      await advancePastIdle();
      await vi.advanceTimersByTimeAsync(0);
      child.stdout.emit('data', Buffer.from('Signed in, but nothing token-shaped here.\n'));
      child.emit('close', 0);

      const result = await pending;
      expect(result).toEqual({
        ok: false,
        error: expect.stringMatching(/^Sign-in finished but no token was found in the output\.[\s\S]*nothing token-shaped here/),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out, kills the child, and never resolves twice', async () => {
    vi.useFakeTimers();
    try {
      const { spawn, children } = scriptedSpawn();
      const pending = signInToClaudeInContainer({
        spawn, hostEnv: {}, containerName: 'c', containerBinaryPath: '/claude',
        onCodePrompt: async () => new Promise<string | null>(() => {}), // never resolves
        timeoutMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(1001);
      const result = await pending;
      expect(result).toEqual({ ok: false, error: expect.stringMatching(/timed out/i) });
      expect(children[0].kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails cleanly when the binary cannot be spawned (e.g. expect is missing)', async () => {
    const spawn: SpawnLike = () => {
      const c = fakeChild();
      queueMicrotask(() => c.emit('error', Object.assign(new Error('spawn /usr/bin/expect ENOENT'), { code: 'ENOENT' })));
      return c as never;
    };
    const result = await signInToClaudeInContainer({
      spawn, hostEnv: {}, containerName: 'c', containerBinaryPath: '/claude', onCodePrompt: async () => null,
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('ENOENT') });
  });

  describe('reaping the in-container process (abandoned sign-ins piled up in the container)', () => {
    it('after every outcome, runs a reaper via `container exec` that targets only this binary\'s setup-token process', async () => {
      const { spawn, calls, children } = scriptedSpawn();
      const pending = signInToClaudeInContainer({
        spawn, hostEnv: { PATH: '/bin' }, containerName: 'claude-threads-vm-t1', containerBinaryPath: '/home/node/.local/bin/claude',
        onCodePrompt: async () => null,
      });
      children[0].emit('close', 1);
      await pending;

      expect(calls).toHaveLength(2);
      expect(calls[1].command).toBe('container');
      expect(calls[1].args).toEqual(buildKillLeftoverSetupTokenArgs('claude-threads-vm-t1', '/home/node/.local/bin/claude'));
    });

    it('passes the binary path as a positional argument, never interpolated into the script text', () => {
      const args = buildKillLeftoverSetupTokenArgs('c', '/weird path; rm -rf /');
      expect(args).toEqual(['exec', 'c', 'sh', '-c', KILL_LEFTOVER_SETUP_TOKEN_SCRIPT, 'sh', '/weird path; rm -rf /']);
      expect(KILL_LEFTOVER_SETUP_TOKEN_SCRIPT).not.toContain('weird');
    });

    it('only matches a cmdline that STARTS with the binary, so the reaper\'s own sh -c can never match itself', () => {
      expect(KILL_LEFTOVER_SETUP_TOKEN_SCRIPT).toContain('"$1 setup-token"*)');
    });

    it('a reaper that fails to spawn never affects the sign-in result', async () => {
      let n = 0;
      const spawn: SpawnLike = (...a) => {
        n++;
        if (n === 2) throw new Error('container CLI vanished');
        return scriptedSpawnChild(a);
      };
      const first = fakeChild();
      const wrapped: SpawnLike = (c, a, o) => (n === 0 ? (n++, first as never) : spawn(c, a, o));
      const pending = signInToClaudeInContainer({
        spawn: wrapped, hostEnv: {}, containerName: 'c', containerBinaryPath: '/claude', onCodePrompt: async () => null,
      });
      first.emit('close', 1);
      await expect(pending).resolves.toEqual(expect.objectContaining({ ok: false }));
    });
  });

  describe('after the code is submitted (live-run robustness)', () => {
    /** Drives a run up to the point the code has been written; returns the child. */
    async function runToSubmit(extra: { onProgress?: (t: string) => void } = {}) {
      const { spawn, children } = scriptedSpawn();
      const pending = signInToClaudeInContainer({
        spawn, hostEnv: {}, containerName: 'c', containerBinaryPath: '/claude',
        onCodePrompt: async () => 'abc#xyz', ...extra,
      });
      const child = children[0];
      child.stdout.emit('data', Buffer.from('Open: https://claude.com/oauth/authorize?x=1\n'));
      await advancePastIdle();
      await vi.advanceTimersByTimeAsync(0);
      expect(child.stdin.write).toHaveBeenCalledWith('abc#xyz');
      await vi.advanceTimersByTimeAsync(400);
      expect(child.stdin.write).toHaveBeenLastCalledWith('\r');
      return { pending, child };
    }

    it('resolves as soon as a token appears, WITHOUT waiting for the process to exit', async () => {
      vi.useFakeTimers();
      try {
        const { pending, child } = await runToSubmit();
        child.stdout.emit('data', Buffer.from('\x1b[32m✓ Long-lived token created\x1b[39m\nsk-ant-oat01-LIVE_token-123\n'));
        await vi.advanceTimersByTimeAsync(900);
        await expect(pending).resolves.toEqual({ ok: true, token: 'sk-ant-oat01-LIVE_token-123' });
        expect(child.kill).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('extracts the token from the real success screen (live-observed: cursor-positioned words, masked code echo, no exit)', async () => {
      vi.useFakeTimers();
      try {
        const { pending, child } = await runToSubmit();
        // Shape captured from a real successful run against the harness image:
        // the masked code echo, then the success text with each word placed by
        // an ESC[nG cursor move and the token on its own unwrapped line.
        child.stdout.emit('data', Buffer.from(
          '\\x1b[2GPaste\\x1b[8Gcode\\x1b[13Ghere\\x1b[18Gif\\x1b[21Gprompted\\x1b[30G>\\r\\n' +
          '(B**************************************DQv6BY\\r\\n' +
          '\\x1b[32m✓\\x1b[39m \\x1b[1mLong-lived\\x1b[22m authentication token created successfully!\\r\\n' +
          'Your\\x1b[6GOAuth\\x1b[12Gtoken\\x1b[18G(valid\\x1b[25Gfor\\x1b[29G1\\x1b[31Gyear):\\r\\n' +
          '\\x1b]8;;\\x07sk-ant-oat01-Real_Looking-Token0123456789abcdef\\r\\n' +
          'Store\\x1b[7Gthis\\x1b[12Gtoken\\x1b[18Gsecurely.\\r\\n',
        ));
        await vi.advanceTimersByTimeAsync(900);
        await expect(pending).resolves.toEqual({ ok: true, token: 'sk-ant-oat01-Real_Looking-Token0123456789abcdef' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('reassembles a token whose bytes are interleaved with terminal escape codes', async () => {
      vi.useFakeTimers();
      try {
        const { pending, child } = await runToSubmit();
        child.stdout.emit('data', Buffer.from('\x1b[1mToken:\x1b[22m \x1b]8;;\x07sk-ant-oat01-AAAA\x1b[0mBBBB_cc-dd\x1b[39m\r\n'));
        await vi.advanceTimersByTimeAsync(900);
        await expect(pending).resolves.toEqual({ ok: true, token: 'sk-ant-oat01-AAAABBBB_cc-dd' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('waits for trailing token characters that arrive in a later chunk', async () => {
      vi.useFakeTimers();
      try {
        const { pending, child } = await runToSubmit();
        child.stdout.emit('data', Buffer.from('sk-ant-oat01-first'));
        await vi.advanceTimersByTimeAsync(300);
        child.stdout.emit('data', Buffer.from('-second\n'));
        await vi.advanceTimersByTimeAsync(900);
        await expect(pending).resolves.toEqual({ ok: true, token: 'sk-ant-oat01-first-second' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('surfaces the CLI\'s own "OAuth error" immediately instead of hanging', async () => {
      vi.useFakeTimers();
      try {
        const { pending, child } = await runToSubmit();
        child.stdout.emit('data', Buffer.from('\x1b[95mOAuth error: Invalid code. Please make sure the full code was copied\x1b[39m\nPress Enter to retry.\n'));
        const result = await pending;
        expect(result).toEqual({ ok: false, error: expect.stringContaining('OAuth error: Invalid code') });
        expect(child.kill).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not mistake pre-submit output for a post-submit result', async () => {
      vi.useFakeTimers();
      try {
        const { spawn, children } = scriptedSpawn();
        const pending = signInToClaudeInContainer({
          spawn, hostEnv: {}, containerName: 'c', containerBinaryPath: '/claude', onCodePrompt: async () => 'code',
        });
        const child = children[0];
        // An "OAuth error" from before the code was ever typed must not fail the run.
        child.stdout.emit('data', Buffer.from('OAuth error: stale\nhttps://claude.com/oauth/authorize?x=1\n'));
        await advancePastIdle();
        await vi.advanceTimersByTimeAsync(0);
        child.stdout.emit('data', Buffer.from('sk-ant-oat01-ok\n'));
        await vi.advanceTimersByTimeAsync(900);
        await expect(pending).resolves.toEqual({ ok: true, token: 'sk-ant-oat01-ok' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('never sits on "Verifying code…" forever: after the watchdog it fails and shows the CLI\'s last output (token-redacted)', async () => {
      vi.useFakeTimers();
      try {
        const { pending, child } = await runToSubmit();
        child.stdout.emit('data', Buffer.from('Exchanging code…\n'));
        await vi.advanceTimersByTimeAsync(61_000);
        const result = await pending;
        expect(result).toEqual({ ok: false, error: expect.stringContaining('Exchanging code') });
        expect(child.kill).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a zero exit with no token reports what the CLI printed rather than a bare message', async () => {
      vi.useFakeTimers();
      try {
        const { pending, child } = await runToSubmit();
        child.stdout.emit('data', Buffer.from('Something unexpected happened\n'));
        child.emit('close', 0);
        const result = await pending;
        expect(result).toEqual({ ok: false, error: expect.stringContaining('Something unexpected happened') });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('stripAnsi', () => {
    it('removes OSC hyperlinks, CSI codes, and carriage returns but keeps text', () => {
      expect(stripAnsi('\x1b]8;id=1;https://x.y\x07\x1b[37mhttps://x.y\x1b[39m\x1b]8;;\x07\r\n')).toBe('https://x.y\n');
    });
  });

  it('sizes expect\'s OWN pty (which container exec forwards), not an inner stty the container resets to 0x0', () => {
    const script = buildContainerSetupTokenExpectArgs()[1];
    // Live-observed: an `stty` run inside the container is reset to 0x0 shortly
    // after start; sizing the host-side pty sticks. Without a wide terminal
    // the CLI hard-wraps the ~108-char token and a truncated one got saved.
    expect(script).toContain('stty rows 50 columns 500 < $spawn_out(slave,name)');
    expect(script).not.toContain('sh -c');
    // Must happen after spawn (the pty doesn't exist before) and before interact.
    expect(script.indexOf('spawn ')).toBeLessThan(script.indexOf('stty rows'));
    expect(script.indexOf('stty rows')).toBeLessThan(script.indexOf('interact'));
  });

  it('fails cleanly when spawn itself throws synchronously', async () => {
    const spawn: SpawnLike = () => { throw new Error('spawn failed'); };
    const result = await signInToClaudeInContainer({
      spawn, hostEnv: {}, containerName: 'c', containerBinaryPath: '/claude', onCodePrompt: async () => null,
    });
    expect(result).toEqual({ ok: false, error: 'spawn failed' });
  });
});

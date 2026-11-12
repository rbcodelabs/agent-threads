import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SigninEvent } from '../../src/protocol';
import type { SpawnLike } from '../../src/setupTokenSession';
import {
  SIGNIN_CLAUDE_BIN_ENV,
  SigninError,
  SigninManager,
  buildSetupTokenPtyCommand,
  findPtyTool,
  reapLeftoverSetupTokens,
  type PtyTool,
} from '../../daemon/signin';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'sk-ant-oat01-SECRETSECRETSECRET_abc-123';
const URL_TEXT = 'https://claude.ai/oauth/authorize?code=true&state=s1';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { write: ReturnType<typeof vi.fn> }; kill: ReturnType<typeof vi.fn> };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn() };
  child.kill = vi.fn(() => { child.emit('close', null, 'SIGTERM'); return true; });
  return child;
}

const EXPECT: PtyTool = { kind: 'expect', path: '/usr/bin/expect' };

function setup(over: { tool?: PtyTool | null; claude?: string | null } = {}) {
  const children: ReturnType<typeof fakeChild>[] = [];
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    const c = fakeChild();
    children.push(c);
    return c as never;
  };
  const audit: Array<Record<string, unknown>> = [];
  const reaped: string[] = [];
  const manager = new SigninManager({
    spawn,
    env: { PATH: '/usr/bin' },
    claudeBinary: () => ('claude' in over ? over.claude ?? null : '/home/u/.local/bin/claude'),
    ptyTool: () => ('tool' in over ? over.tool ?? null : EXPECT),
    reap: (bin) => { reaped.push(bin); },
    audit: (r) => { audit.push(r); },
  });
  const events: SigninEvent[] = [];
  return { manager, children, calls, audit, reaped, events, emit: (e: SigninEvent) => { events.push(e); } };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function startAndShowUrl(s: ReturnType<typeof setup>, connId = 1) {
  const { flowId } = s.manager.start(connId, s.emit);
  await vi.advanceTimersByTimeAsync(0);
  s.children[0].stdout.emit('data', Buffer.from(`Open ${URL_TEXT}\n`));
  await vi.advanceTimersByTimeAsync(1000);
  return flowId;
}

describe('buildSetupTokenPtyCommand', () => {
  it('expect: fixed script reading the binary from the environment, 50x500 pty', () => {
    const { command, args } = buildSetupTokenPtyCommand(EXPECT);
    expect(command).toBe('/usr/bin/expect');
    expect(args[0]).toBe('-c');
    expect(args[1]).toContain(`$env(${SIGNIN_CLAUDE_BIN_ENV}) setup-token`);
    expect(args[1]).toContain('stty rows 50 columns 500');
    expect(args[1]).toMatch(/; interact$/);
  });
  it('script: util-linux form; never interpolates the binary path', () => {
    const { command, args } = buildSetupTokenPtyCommand({ kind: 'script', path: '/usr/bin/script' });
    expect(command).toBe('/usr/bin/script');
    expect(args.slice(0, 3)).toEqual(['-q', '-e', '-c']);
    // The shell must EXPAND the variable (a bare name would be "exec: CT_CLAUDE_BIN: not found").
    expect(args[3]).toContain(`exec "$${SIGNIN_CLAUDE_BIN_ENV}" setup-token`);
    // Actually run the shell snippet: the env var's path is what gets exec'd.
    const out = spawnSync('/bin/sh', ['-c', args[3]!.replace(/^stty[^;]*;\s*/, '')], { env: { ...process.env, [SIGNIN_CLAUDE_BIN_ENV]: '/bin/echo' }, encoding: 'utf8' });
    expect(out.stdout.trim()).toBe('setup-token');
    expect(args[4]).toBe('/dev/null');
  });
});

describe('findPtyTool', () => {
  it('finds nothing in an empty PATH search that has no tools, and never offers BSD script on macOS', () => {
    expect(findPtyTool({ PATH: '/definitely/not/here' }, 'darwin')?.kind).not.toBe('script');
  });
});

describe('SigninManager', () => {
  it('runs setup-token in a pty with the claude path in the environment, then relays url, prompt and token', async () => {
    const s = setup();
    const flowId = await startAndShowUrl(s);
    expect(s.calls[0].command).toBe('/usr/bin/expect');
    expect(s.calls[0].env[SIGNIN_CLAUDE_BIN_ENV]).toBe('/home/u/.local/bin/claude');
    expect(s.events.map((e) => e.kind)).toEqual(['progress', 'url', 'progress', 'prompt']);
    expect(s.events.find((e) => e.kind === 'url')).toMatchObject({ flowId, url: URL_TEXT });

    s.manager.code(1, flowId, '  abc#def  ');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.children[0].stdin.write).toHaveBeenCalledWith('abc#def');
    await vi.advanceTimersByTimeAsync(400);
    expect(s.children[0].stdin.write).toHaveBeenLastCalledWith('\r');
    s.children[0].stdout.emit('data', Buffer.from(`Your token:\n${TOKEN}\n`));
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.events.at(-1)).toEqual({ kind: 'token', flowId, token: TOKEN });
    expect(s.manager.active).toBe(false);
  });

  it('never audits the token or the CLI output, only the outcome', async () => {
    const s = setup();
    const flowId = await startAndShowUrl(s);
    s.manager.code(1, flowId, 'abc');
    await vi.advanceTimersByTimeAsync(400);
    s.children[0].stdout.emit('data', Buffer.from(`${TOKEN}\n`));
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.audit.map((a) => a.event)).toEqual(['signin_start', 'signin']);
    expect(JSON.stringify(s.audit)).not.toContain('sk-ant');
    expect(s.audit.at(-1)).toMatchObject({ outcome: 'ok' });
  });

  it('a rejected code comes back as an error event without the token machinery', async () => {
    const s = setup();
    const flowId = await startAndShowUrl(s);
    s.manager.code(1, flowId, 'bad');
    await vi.advanceTimersByTimeAsync(400);
    s.children[0].stdout.emit('data', Buffer.from('OAuth error: invalid code Press Enter to retry.'));
    await vi.advanceTimersByTimeAsync(10);
    expect(s.events.at(-1)).toMatchObject({ kind: 'error', message: expect.stringContaining('OAuth error: invalid code') });
    expect(s.audit.at(-1)).toMatchObject({ outcome: 'failed' });
  });

  it('allows one flow at a time', async () => {
    const s = setup();
    s.manager.start(1, s.emit);
    expect(() => s.manager.start(2, () => {})).toThrowError(expect.objectContaining({ code: 'conflict' }));
  });

  it('only the starting connection may answer or cancel', async () => {
    const s = setup();
    const flowId = await startAndShowUrl(s);
    expect(() => s.manager.code(2, flowId, 'x')).toThrowError(expect.objectContaining({ code: 'forbidden' }));
    expect(() => s.manager.cancel(2)).toThrowError(expect.objectContaining({ code: 'forbidden' }));
    expect(s.children[0].kill).not.toHaveBeenCalled();
  });

  it('cancel kills the process, reaps leftovers and reports cancelled', async () => {
    const s = setup();
    const flowId = await startAndShowUrl(s);
    s.manager.cancel(1, flowId);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.children[0].kill).toHaveBeenCalled();
    expect(s.reaped).toEqual(['/home/u/.local/bin/claude']);
    expect(s.events.at(-1)).toMatchObject({ kind: 'error', message: 'Sign-in cancelled.' });
    expect(s.audit.at(-1)).toMatchObject({ outcome: 'cancelled' });
    expect(s.manager.active).toBe(false);
    // Idempotent, and a new flow can start.
    s.manager.cancel(1);
    expect(() => s.manager.start(1, s.emit)).not.toThrow();
  });

  it('a disconnect ends the flow and kills the process', async () => {
    const s = setup();
    await startAndShowUrl(s);
    s.manager.connectionGone(7); // someone else: no effect
    expect(s.children[0].kill).not.toHaveBeenCalled();
    s.manager.connectionGone(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.children[0].kill).toHaveBeenCalled();
    expect(s.reaped).toHaveLength(1);
    expect(s.manager.active).toBe(false);
  });

  it('a code for an unknown or finished flow is not_found', async () => {
    const s = setup();
    expect(() => s.manager.code(1, 'nope', 'x')).toThrowError(expect.objectContaining({ code: 'not_found' }));
  });

  it('fails clearly when there is no pty tool or no claude CLI', () => {
    expect(() => setup({ tool: null }).manager.start(1, () => {})).toThrowError(SigninError);
    expect(() => setup({ tool: null }).manager.start(1, () => {})).toThrowError(/expect/);
    expect(() => setup({ claude: null }).manager.start(1, () => {})).toThrowError(/claude CLI is not installed/);
  });

  it('delivers no event before start() returns (the ack goes first)', () => {
    const s = setup();
    s.manager.start(1, s.emit);
    expect(s.events).toEqual([]);
  });
});

describe('reapLeftoverSetupTokens', () => {
  it('kills only claude setup-token processes, never the wrapper or other commands', () => {
    vi.useRealTimers();
    const proc = mkdtempSync(join(tmpdir(), 'proc-'));
    const put = (pid: string, argv: string[]) => { mkdirSync(join(proc, pid)); writeFileSync(join(proc, pid, 'cmdline'), `${argv.join('\0')}\0`); };
    put('101', ['/home/u/.local/bin/claude', 'setup-token']);
    put('102', ['node', '/home/u/.local/bin/claude', 'setup-token']);
    put('103', ['expect', '-c', 'spawn $env(CT_CLAUDE_BIN) setup-token; interact']);
    put('104', ['/home/u/.local/bin/claude', 'chat']);
    put('105', ['vim', 'setup-token']);
    const killed: number[] = [];
    try {
      const n = reapLeftoverSetupTokens('/home/u/.local/bin/claude', proc, (pid) => killed.push(pid));
      expect(killed.sort()).toEqual([101, 102]);
      expect(n).toBe(2);
    } finally {
      rmSync(proc, { recursive: true, force: true });
    }
  });
  it('is a no-op where /proc does not exist', () => {
    expect(reapLeftoverSetupTokens('claude', '/definitely/not/here')).toBe(0);
  });
});

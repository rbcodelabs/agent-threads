/**
 * CLI hardening: nothing a daemon (or the model) writes into a name, id or header can repaint the terminal or fake a
 * line, `--port` typos are usage errors, plain ws:// to another machine warns, and `token create --save` keeps 0600.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { portFlag, runCli, type Io } from '../../daemon/cli';
import { plaintextWarning } from '../../daemon/cmd/connection';
import { Follower } from '../../daemon/cmd/follow';
import { field, TextRenderer } from '../../daemon/cmd/render';
import type { DaemonClient } from '../../src/remote/DaemonClient';
import type { EventFrame } from '../../src/protocol';

const ESC = '\u001b';
const hostile = `Bash${ESC}[2J${ESC}]0;pwned\u0007\rFAKE LINE\n[permission 99] Allow`;
// eslint-disable-next-line no-control-regex
const hasControl = (s: string): boolean => /[\u001b\r\u0007\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(s);

let seq = 0;
const ev = (name: string, args: unknown): EventFrame => ({ v: 1, ch: 't:x', seq: ++seq, ts: 1, type: 'event', name, args }) as unknown as EventFrame;

describe('terminal escape injection', () => {
  it('field() flattens control characters and bounds length', () => {
    expect(hasControl(field(hostile))).toBe(false);
    expect(field(hostile)).not.toContain('\n');
    expect(field('x'.repeat(500)).length).toBeLessThanOrEqual(80);
    expect(field(undefined, 'fallback')).toBe('fallback');
  });

  it('the renderer never emits an escape, CR or fake line from a tool name, id, requester or outcome', () => {
    let out = '';
    const r = new TextRenderer({ write: (s) => { out += s; } });
    r.event(ev('onToolUse', [{ name: hostile, summary: 'ok', toolUseId: 'u1' }]));
    r.event(ev('onToolResult', ['u1', 'error', 1]));
    r.event(ev('permission_request', { requestId: hostile, toolName: hostile, detail: 'd' }));
    r.event(ev('question_request', { requestId: hostile, questions: [] }));
    r.event(ev('plan_ready', { requestId: hostile, planText: 'p' }));
    r.event(ev('elicitation_request', { requestId: hostile, request: { message: 'm' } }));
    r.event(ev('request_resolved', { requestId: hostile, by: hostile, outcome: hostile }));
    r.event(ev('onPermissionDenied', [hostile, 'u', 'reason']));
    r.event(ev('onTaskNotification', ['a', hostile, 'm']));
    r.event(ev('session.state', { closed: hostile }));
    expect(hasControl(out.replace(/\n/g, ''))).toBe(false);
    // Every output line starts with one of the renderer's own prefixes: no injected "[permission 99]" line of its own.
    for (const line of out.split('\n').filter(Boolean)) expect(line).toMatch(/^(\[|\s{2,})/);
    expect(out.split('\n').filter((l) => l.startsWith('[permission 99]'))).toEqual([]);
  });
});

describe('prompts at the terminal', () => {
  function followerWith(requestEvent: EventFrame) {
    const asked: string[] = [];
    const notes: string[] = [];
    let handlers!: { onEvent(f: EventFrame, m: { reopen: boolean; replay: boolean }): void; onAttached(i: unknown): void };
    const client = {
      subscribe: (_t: string, h: typeof handlers) => { handlers = h; return { close() {}, ack() {} }; },
      command: async () => ({}),
    } as unknown as DaemonClient;
    const f = new Follower({
      client, threadId: 't', afterSeq: 0, observe: false, json: false, answer: 'terminal', stopOn: 'never',
      prompter: { ask: async (p) => { asked.push(p); return 'n'; } },
      io: { out: () => undefined, err: (t) => { notes.push(t); } },
    });
    f.start();
    handlers.onAttached({ lastSeq: requestEvent.seq, lowWater: 0, epoch: 'e', resync: false, controller: true });
    handlers.onEvent(requestEvent, { reopen: false, replay: false });
    return { asked, notes };
  }

  it('Allow <tool>? shows a sanitized tool name', async () => {
    const { asked } = followerWith(ev('permission_request', { requestId: 'r1', toolName: hostile, detail: 'd' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^Allow Bash/);
    expect(hasControl(asked[0])).toBe(false);
    expect(asked[0]).not.toContain('\n');
  });

  it('question header and text are flattened too (the answer hint line is the CLI\'s own)', async () => {
    const { asked } = followerWith(ev('question_request', { requestId: 'r2', questions: [{ header: hostile, question: hostile, options: [{ label: 'a' }], multiSelect: false }] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toHaveLength(1);
    const [first, second] = asked[0].split('\n');
    expect(hasControl(first)).toBe(false);
    expect(second).toMatch(/^ {2}answer \(number/);
    expect(asked[0].split('\n')).toHaveLength(2);
  });
});

describe('--port', () => {
  const parsed = (port?: string) => ({ flags: new Map(port === undefined ? [] : [['port', [port]]]), bools: new Set<string>(), positionals: [] }) as never;
  it('accepts whole numbers 0-65535 and rejects NaN, floats, negatives and junk', () => {
    expect(portFlag(parsed())).toBeUndefined();
    expect(portFlag(parsed('7433'))).toBe(7433);
    expect(portFlag(parsed('0'))).toBe(0);
    for (const bad of ['abc', '74.5', '-1', '70000', '', '1e3', '0x10']) expect(() => portFlag(parsed(bad)), bad).toThrow(/--port must be a whole number/);
  });
  it('doctor --port NaN is a usage error (exit 2), not a probe of http://127.0.0.1:NaN', async () => {
    let err = '';
    const io: Io = { out: () => undefined, err: (l) => { err += l; }, write: () => undefined, writeErr: () => undefined };
    const code = await runCli(['doctor', '--port', 'NaN'], io, { env: {}, stdinIsTTY: false, cwd: '/tmp', onInterrupt: () => () => undefined });
    expect(code).toBe(2);
    expect(err).toMatch(/--port must be a whole number/);
  });
});

describe('plain ws:// to another machine', () => {
  it('warns for ws:// to a non-loopback host, not for loopback or wss://', () => {
    expect(plaintextWarning('ws://192.168.1.20:7433/v1/ws')).toMatch(/plain ws:\/\/.*readable on the network/);
    expect(plaintextWarning('ws://box.example.com:7433/v1/ws')).toContain('box.example.com:7433');
    expect(plaintextWarning('ws://127.0.0.1:7433/v1/ws')).toBeUndefined();
    expect(plaintextWarning('ws://[::1]:7433/v1/ws')).toBeUndefined();
    expect(plaintextWarning('ws://localhost:7433/v1/ws')).toBeUndefined();
    expect(plaintextWarning('wss://box.example.com/v1/ws')).toBeUndefined();
  });
});

describe('token create --save', () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
  it('writes the saved token file with mode 0600 and the data dir without group/other access', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'at-save-'));
    dirs.push(dir);
    const io: Io = { out: () => undefined, err: () => undefined, write: () => undefined, writeErr: () => undefined };
    const code = await runCli(['token', 'create', '--name', 'cli', '--save', '--data-dir', dir], io, { env: {}, stdinIsTTY: false, cwd: '/tmp', onInterrupt: () => () => undefined });
    expect(code).toBe(0);
    expect(statSync(join(dir, 'cli-token')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o077).toBe(0);
    expect(statSync(join(dir, 'tokens.json'), { throwIfNoEntry: false })?.mode ? statSync(join(dir, 'tokens.json')).mode & 0o077 : 0).toBe(0);
  });
});

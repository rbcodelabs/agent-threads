/**
 * The CLI against a REAL daemon (fake harness): list, run, detach + attach replay, answering requests
 * from the terminal, and the one-writer seat with a second client instance standing in for Geode.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, type Io } from '../../daemon/cli';
import { nodeSocketFactory } from '../../daemon/cmd/connection';
import type { Prompter } from '../../daemon/cmd/follow';
import type { CliRuntime } from '../../daemon/cmd/runtime';
import { DaemonClient } from '../../src/remote/DaemonClient';
import { expectGolden } from '../helpers/golden';
import { startKillableProxy } from '../helpers/killableProxy';
import { startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';

let td: TestDaemon;
let controlToken: string;
let readToken: string;
const clients: DaemonClient[] = [];

beforeEach(async () => {
  td = await startTestDaemon();
  controlToken = td.daemon.tokens.create('cli', 'control').token;
  readToken = td.daemon.tokens.create('viewer', 'read').token;
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.dispose();
  await td.cleanup();
});

interface Captured { code: number; out: string; err: string }

async function cli(argv: string[], rt: Partial<CliRuntime> = {}, token = controlToken, url = td.daemon.url): Promise<Captured> {
  let out = ''; let err = '';
  const io: Io = {
    out: (l) => { out += `${l}\n`; }, err: (l) => { err += `${l}\n`; },
    write: (t) => { out += t; }, writeErr: (t) => { err += t; },
  };
  const code = await runCli(argv, io, {
    env: { AGENT_THREADS_URL: url, AGENT_THREADS_TOKEN: token }, stdinIsTTY: false, cwd: '/tmp',
    onInterrupt: () => () => {}, ...rt,
  });
  return { code, out, err };
}

/** A scripted terminal: answers prompts in order and records what it was asked. */
function scripted(answers: Array<string | null>): Prompter & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ask: async (prompt, signal) => {
      asked.push(prompt);
      const next = answers.shift();
      if (next !== undefined) return next;
      // Nothing scripted: wait until the prompt is withdrawn (answered elsewhere).
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }));
    },
  };
}

/** A second client instance sharing the token, standing in for Geode. */
async function geode(threadId?: string): Promise<DaemonClient> {
  const c = new DaemonClient({ url: td.daemon.url, getToken: () => controlToken, createSocket: nodeSocketFactory, client: 'geode-plugin', clientVersion: '99.0.0', instanceId: 'geode-instance', ackDebounceMs: 10 });
  clients.push(c);
  c.connect();
  await until(() => c.isConnected);
  void threadId;
  return c;
}

const until = async (fn: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const SPEC = { harness: 'claude', cwd: '/srv/workspaces/x', permissionMode: 'default', extraEnvRaw: '' } as const;

describe('list', () => {
  it('shows an empty daemon, then the threads (text and NDJSON)', async () => {
    const empty = await cli(['list']);
    expect(empty).toMatchObject({ code: 0, out: '(no threads)\n' });
    await cli(['run', '--cwd', '/srv/workspaces/x', '--thread', 'demo-1', 'hi']);
    const text = await cli(['list']);
    expect(text.out).toMatch(/^THREAD\s+STATE\s+SEQ\s+CWD\ndemo-1\s+idle\s+\d+\s+\/srv\/workspaces\/x\n$/);
    const json = await cli(['list', '--json']);
    const rec = JSON.parse(json.out.trim());
    expect(rec).toMatchObject({ threadId: 'demo-1', state: 'idle', open: true, cwd: '/srv/workspaces/x' });
    expect(Object.keys(rec)).toEqual(['threadId', 'state', 'lastSeq', 'open', 'turnInFlight', 'hasPendingPermission', 'cwd', 'nativeSessionId', 'lastActivityAt']);
  });

  it('a read-scope token can list', async () => {
    expect((await cli(['list'], {}, readToken)).code).toBe(0);
  });
});

describe('connection failures map to exit codes', () => {
  it('bad token -> 4, nothing listening -> 3, no token at all -> 4', async () => {
    const bad = await cli(['list'], {}, 'atd_wrong');
    expect(bad.code).toBe(4);
    expect(bad.err).toMatch(/rejected the token/);
    const dead = await cli(['list'], {}, controlToken, 'ws://127.0.0.1:1');
    expect(dead.code).toBe(3);
    expect(dead.err).toMatch(/cannot reach the daemon/);
    // --data-dir pins the token lookup to this test's own (empty) dir; otherwise the CLI falls back to the
    // machine's real /var/lib/agent-threads/cli-token (or ~/.agent-threads) when one is installed.
    const none = await cli(['--data-dir', td.dataDir, 'list'], { env: { AGENT_THREADS_URL: td.daemon.url } });
    expect(none.code).toBe(4);
    expect(none.err).toMatch(/no access token/);
  });

  it('a read token cannot run (scope), exit 4', async () => {
    const r = await cli(['run', '--cwd', '/srv/workspaces/x', 'hi'], {}, readToken);
    expect(r.code).toBe(4);
  });
});

describe('run', () => {
  it('streams the answer and exits 0', async () => {
    const r = await cli(['run', '--cwd', '/srv/workspaces/x', 'echo hi']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('echo: echo hi\n[done] 1 turn\n');
    expect(r.err).toMatch(/^\[cli\] thread run-[0-9a-f]{8} \(cwd \/srv\/workspaces\/x, permission mode default\)\n$/);
  });

  it('prompt may start with dashes after --', async () => {
    const r = await cli(['run', '--cwd', '/srv/workspaces/x', '--', '--weird prompt']);
    expect(r.out).toContain('echo: --weird prompt');
  });

  it('needs a prompt (exit 2) and a valid permission mode (exit 2)', async () => {
    expect((await cli(['run', '--cwd', '/srv/workspaces/x'])).code).toBe(2);
    expect((await cli(['run', '--permission-mode', 'yolo', 'x'])).code).toBe(2);
  });

  it('golden: --json stream (volatile fields normalised)', async () => {
    const r = await cli(['run', '--json', '--cwd', '/srv/workspaces/x', '--thread', 'golden-1', '/tokens 3']);
    expect(r.code).toBe(0);
    const normalised = r.out.trim().split('\n').map((l) => {
      const o = JSON.parse(l) as Record<string, unknown>;
      if ('ts' in o) o.ts = 0;
      if ('epoch' in o) o.epoch = 'EPOCH';
      return JSON.stringify(o);
    }).join('\n');
    expectGolden('cli/run.ndjson', `${normalised}\n`);
  });

  it('fails with exit 7 when a request is raised and nobody can answer (no terminal)', async () => {
    const r = await cli(['run', '--cwd', '/srv/workspaces/x', '/permission']);
    expect(r.code).toBe(7);
    expect(r.err).toMatch(/nobody could answer it/);
    expect(r.out).toContain('"allow":false');
  });

  it('--unattended defaults to dontAsk; a request that is raised anyway is refused and ends the run (exit 7)', async () => {
    const r = await cli(['run', '--unattended', '--cwd', '/srv/workspaces/x', '/question']);
    expect(r.code).toBe(7);
    expect(r.err).toContain('permission mode dontAsk');
  });

  it('answers a permission request typed at the terminal', async () => {
    const prompter = scripted(['y']);
    const r = await cli(['run', '--cwd', '/srv/workspaces/x', '/permission'], { stdinIsTTY: true, prompter });
    expect(r.code).toBe(0);
    expect(prompter.asked[0]).toMatch(/Allow Bash\? \[y\/N\]/);
    expect(r.out).toContain('permission resolved: {"allow":true}');
    const denied = await cli(['run', '--cwd', '/srv/workspaces/x', '/permission'], { stdinIsTTY: true, prompter: scripted(['n']) });
    expect(denied.out).toContain('{"allow":false}');
  });

  it('answers a question by option number', async () => {
    const r = await cli(['run', '--cwd', '/srv/workspaces/x', '/question'], { stdinIsTTY: true, prompter: scripted(['1']) });
    expect(r.code).toBe(0);
    expect(r.out).toContain('"answers":{"Pick one?":"a"}');
  });

  it('--json: a request is answered by an NDJSON command on stdin', async () => {
    const { PassThrough } = await import('node:stream');
    const stdin = new PassThrough();
    const p = cli(['run', '--json', '--cwd', '/srv/workspaces/x', '/permission'], { stdin });
    await new Promise((r) => setTimeout(r, 400));
    stdin.write('{"cmd":"resolve.permission","requestId":"permission-1","allow":true}\n');
    const r = await p;
    expect(r.code).toBe(0);
    expect(r.out).toContain('"kind":"command_result","cmd":"resolve.permission","requestId":"permission-1","ok":true');
  });

  it('--json: stdin closing with a request open refuses it (exit 7)', async () => {
    const { PassThrough } = await import('node:stream');
    const stdin = new PassThrough();
    const p = cli(['run', '--json', '--cwd', '/srv/workspaces/x', '/permission'], { stdin });
    await new Promise((r) => setTimeout(r, 300));
    stdin.end();
    expect((await p).code).toBe(7);
  });

  it('Ctrl-C interrupts the turn, exits 130, and the session is still listed', async () => {
    let fire: () => void = () => {};
    const p = cli(['run', '--cwd', '/srv/workspaces/x', '--thread', 'hang-1', '/hang'], { onInterrupt: (h) => { fire = h; return () => {}; } });
    await new Promise((r) => setTimeout(r, 400));
    fire();
    const r = await p;
    expect(r.code).toBe(130);
    expect(r.out).toContain('[interrupted]');
  });
});

describe('run and the thread it did not make', () => {
  it('closes the ephemeral session it created, but leaves a --thread session open', async () => {
    const live = (id: string): boolean => td.daemon.threads.list().some((t) => t.threadId === id && t.open);
    const ephemeral = await cli(['run', '--cwd', '/srv/workspaces/x', '--json', 'hello']);
    expect(ephemeral.code).toBe(0);
    const started = ephemeral.out.split('\n').map((l) => { try { return JSON.parse(l) as { kind?: string; threadId?: string }; } catch { return {}; } }).find((o) => o.kind === 'started');
    await until(() => !live(started!.threadId!));
    const named = await cli(['run', '--cwd', '/srv/workspaces/x', '--thread', 'keep-me', 'hello']);
    expect(named.code).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(live('keep-me')).toBe(true);
  });
});

describe('observer against a daemon that predates the observe flag', () => {
  it('warns, gives the seat back and exits 5 instead of locking the real client out', async () => {
    // An older daemon ignores `observe` and hands the seat out: simulate it by stripping the flag on the way out.
    const stripObserve = (url: string) => {
      const ws = nodeSocketFactory(url);
      const send = ws.send.bind(ws);
      ws.send = (data: string) => send(data.replace(/,?"observe":true/, ''));
      return ws;
    };
    const g = await geode();
    await g.command('session.open', { threadId: 'old-1', spec: SPEC });
    await g.command('session.detach', { threadId: 'old-1' }); // the seat is free; the real client is about to come back
    const r = await cli(['attach', 'old-1', '--until-idle'], { createSocket: stripObserve });
    expect(r.code).toBe(5);
    expect(r.err).toMatch(/older than the CLI/);
    expect(r.err).toMatch(/Detached again/);
    // The seat is free again: Geode can take it back.
    let controller: boolean | undefined;
    g.subscribe('old-1', { onEvent: () => {}, onAttached: (i) => { controller = i.controller; } }, 0);
    await until(() => controller !== undefined);
    expect(controller).toBe(true);
  }, 15000);
});

describe('detach + attach', () => {
  it('--detach prints the thread id and exits; attach replays everything', async () => {
    const d = await cli(['run', '--detach', '--cwd', '/srv/workspaces/x', '--thread', 'bg-1', '/tokens 5']);
    expect(d).toMatchObject({ code: 0, out: 'bg-1\n' });
    const a = await cli(['attach', 'bg-1', '--until-idle']);
    expect(a.code).toBe(0);
    expect(a.out).toBe('t0:t1:t2:t3:t4:\n[done] 1 turn\n');
    // The same replay as NDJSON ends with an `end` record.
    const j = await cli(['attach', 'bg-', '--until-idle', '--json']);
    const lines = j.out.trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>);
    expect(lines[0]).toMatchObject({ type: 'cli', kind: 'attached', threadId: 'bg-1', controller: false });
    expect(lines.filter((l) => l.name === 'onToken')).toHaveLength(5);
    expect(lines.at(-1)).toMatchObject({ type: 'cli', kind: 'end', outcome: 'idle', exitCode: 0 });
  });

  it('--from N replays only what came after, --from end shows nothing old', async () => {
    await cli(['run', '--cwd', '/srv/workspaces/x', '--thread', 'cur-1', '/tokens 4']);
    const mid = await cli(['attach', 'cur-1', '--until-idle', '--from', '5', '--json']);
    const seqs = mid.out.trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>).filter((l) => l.type === 'event').map((l) => l.seq);
    expect(seqs.length).toBeGreaterThan(0);
    expect(Math.min(...seqs)).toBeGreaterThan(5);
    const end = await cli(['attach', 'cur-1', '--until-idle', '--from', 'end']);
    expect(end.out).toBe('');
    expect((await cli(['attach', 'cur-1', '--from', 'soon'])).code).toBe(2);
  });

  it('attach to an unknown thread fails clearly', async () => {
    const r = await cli(['attach', 'nope']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no thread "nope"/);
    expect((await cli(['attach'])).code).toBe(2);
  });

  it('a reconnecting attach resumes from its cursor (connection cut mid-stream: no gap, no duplicate)', async () => {
    await cli(['run', '--detach', '--cwd', '/srv/workspaces/x', '--thread', 'slow-1', '/tokens 40 burst=1 delay=40']);
    const proxy = await startKillableProxy('127.0.0.1', td.daemon.port);
    const p = cli(['attach', 'slow-1', '--until-idle'], {}, controlToken, `ws://127.0.0.1:${proxy.port}`);
    await new Promise((r) => setTimeout(r, 500));
    // Cut the TCP connection mid-stream; the client reconnects (1 s ladder) and resumes after its cursor.
    expect(proxy.killAll()).toBeGreaterThan(0);
    const r = await p;
    expect(r.code).toBe(0);
    const tokens = r.out.split('\n')[0].match(/t\d+:/g) ?? [];
    expect(tokens.map((t) => Number(t.slice(1, -1)))).toEqual([...Array(40).keys()]);
    expect(r.err).toMatch(/connection lost/);
    await proxy.close();
  });
});

describe('the read-write seat', () => {
  async function geodeHoldsPermission(threadId: string): Promise<DaemonClient> {
    const g = await geode();
    await g.command('session.open', { threadId, spec: SPEC });
    g.subscribe(threadId, { onEvent: () => {} }, 0);
    await until(() => g.isConnected);
    await g.command('session.send', { threadId, text: '/permission', userMessageUuid: 'u1' });
    await new Promise((r) => setTimeout(r, 200));
    return g;
  }

  it('attach is a read-only observer by default: it shows the request, never prompts, and Geode keeps the seat', async () => {
    const g = await geodeHoldsPermission('seat-1');
    const prompter = scripted([]);
    const p = cli(['attach', 'seat-1', '--until-idle'], { stdinIsTTY: true, prompter });
    await new Promise((r) => setTimeout(r, 500));
    expect(prompter.asked).toEqual([]);
    // Geode (the seat holder) can still answer: the observer did not take or disturb the seat.
    await g.command('resolve.permission', { threadId: 'seat-1', requestId: 'permission-1', allow: true });
    const r = await p;
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[permission permission-1\] Bash/);
    expect(r.err).toMatch(/read-only view/);
  }, 15000);

  it('--claim while Geode holds the seat: stays read-only, says so, and Geode can still answer', async () => {
    const g = await geodeHoldsPermission('seat-2');
    const prompter = scripted([]);
    const p = cli(['attach', 'seat-2', '--claim', '--until-idle'], { stdinIsTTY: true, prompter });
    await new Promise((r) => setTimeout(r, 500));
    expect(prompter.asked).toEqual([]);
    await g.command('resolve.permission', { threadId: 'seat-2', requestId: 'permission-1', allow: true });
    const r = await p;
    expect(r.err).toMatch(/another client holds this thread's read-write seat/);
    expect(r.out).toMatch(/\[permission permission-1\] Bash/);
    expect(r.out).toMatch(/\[resolved permission-1\]/);
    expect(r.code).toBe(0);
  }, 15000);

  it('--claim on a free thread takes the seat and answers; the loser of the race hears it was answered', async () => {
    await cli(['run', '--detach', '--cwd', '/srv/workspaces/x', '--thread', 'seat-3', '/permission']);
    const prompter = scripted(['y']);
    const r = await cli(['attach', 'seat-3', '--claim', '--until-idle'], { stdinIsTTY: true, prompter });
    expect(prompter.asked).toHaveLength(1);
    expect(r.code).toBe(0);
    expect(r.out).toContain('permission resolved: {"allow":true}');
    // A late second answer (what Geode would send) is refused by the daemon: first resolver wins.
    const g = await geode();
    g.subscribe('seat-3', { onEvent: () => {} }, 0);
    await expect(g.command('resolve.permission', { threadId: 'seat-3', requestId: 'permission-1', allow: true })).rejects.toThrow(/no pending permission/);
  }, 15000);

  it('a prompt is withdrawn when someone else answers first', async () => {
    await cli(['run', '--detach', '--cwd', '/srv/workspaces/x', '--thread', 'seat-4', '/permission']);
    const prompter = scripted([]); // never answers on its own
    const p = cli(['attach', 'seat-4', '--claim', '--until-idle'], { stdinIsTTY: true, prompter });
    await until(() => prompter.asked.length === 1);
    // The CLI holds the seat now, so the "other client" is the same token on another connection with the SAME
    // instance id: the daemon lets an instance take its own seat back, and answers first.
    const same = new DaemonClient({ url: td.daemon.url, getToken: () => controlToken, createSocket: nodeSocketFactory, client: 'cli', clientVersion: '1', instanceId: undefined });
    clients.push(same);
    same.connect();
    await until(() => same.isConnected);
    await same.command('resolve.permission', { threadId: 'seat-4', requestId: 'permission-1', allow: false });
    const r = await p;
    expect(r.err).toMatch(/answered elsewhere/);
    expect(r.code).toBe(0);
  }, 15000);
});

describe('creds push', () => {
  const dataDirOf = () => td.dataDir;

  it('pushes env fields without argv values, never prints them, and removes the kind', async () => {
    const adminToken = td.adminToken;
    const pushed = await cli(['creds', 'push', 'mcp', 'DOCS_TOKEN', '--ttl', '1h'], { env: { AGENT_THREADS_URL: td.daemon.url, AGENT_THREADS_TOKEN: adminToken, DOCS_TOKEN: 'cli-secret-value' } }, adminToken);
    expect(pushed.code).toBe(0);
    expect(pushed.out).toContain('pushed 1 field to "mcp": DOCS_TOKEN');
    expect(pushed.out + pushed.err).not.toContain('cli-secret-value');
    expect(JSON.parse(readFileSync(join(dataDirOf(), 'creds', 'mcp.json'), 'utf8'))).toMatchObject({ fields: { DOCS_TOKEN: 'cli-secret-value' } });
    expect(JSON.parse(readFileSync(join(dataDirOf(), 'creds', 'mcp.json'), 'utf8')).expiresAt).toBeGreaterThan(Date.now());

    const removed = await cli(['creds', 'push', 'mcp', '--remove', '--json'], {}, adminToken);
    expect(removed.code).toBe(0);
    expect(JSON.parse(removed.out)).toMatchObject({ kind: 'mcp', removed: true });
    expect(existsSync(join(dataDirOf(), 'creds', 'mcp.json'))).toBe(false);
  });

  it('reads a JSON object from stdin', async () => {
    const adminToken = td.adminToken;
    const stdin = Readable.from([JSON.stringify({ A: 'stdin-secret', B: 'b' })]);
    const r = await cli(['creds', 'push', 'k', '--stdin', '--json'], { stdin: stdin as unknown as NodeJS.ReadableStream }, adminToken);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ kind: 'k', fields: ['A', 'B'] });
    expect(r.out + r.err).not.toContain('stdin-secret');
  });

  it('refuses NAME=value in argv (exit 2) and a non-admin token (exit 4)', async () => {
    const argv = await cli(['creds', 'push', 'k', 'A=topsecret'], {}, td.adminToken);
    expect(argv.code).toBe(2);
    expect(argv.err).not.toContain('topsecret');
    expect(existsSync(join(dataDirOf(), 'creds', 'k.json'))).toBe(false);
    const denied = await cli(['creds', 'push', 'k', 'A'], { env: { AGENT_THREADS_URL: td.daemon.url, AGENT_THREADS_TOKEN: controlToken, A: 'x' } });
    expect(denied.code).toBe(4);
  });
});

describe('mcp sync', () => {
  const DOCS = { type: 'http', url: 'https://docs.example.test/mcp', headers: { Authorization: 'Bearer ${mcpsync-p.DOCS_TOKEN}' } };
  const stdinOf = (v: unknown) => Readable.from([JSON.stringify(v)]) as unknown as NodeJS.ReadableStream;

  it('replaces the synced set from stdin, prints names and reasons only, and --json prints the reply', async () => {
    const r = await cli(['mcp', 'sync', '--stdin'], { stdin: stdinOf({ docs: DOCS, bad: { type: 'http' }, tool: { command: 'x' } }) }, td.adminToken);
    expect(r.code).toBe(0);
    expect(r.out).toContain('synced 1 server: docs');
    expect(r.out).toContain('rejected bad:');
    expect(r.out).toContain('rejected tool:');
    expect(r.out).toContain('needs credentials (push with "creds push"): mcpsync-p.DOCS_TOKEN');
    expect(r.out + r.err).not.toContain('docs.example.test');
    expect(JSON.parse(readFileSync(join(td.dataDir, 'synced-mcp.json'), 'utf8')).servers.docs.def.url).toBe('https://docs.example.test/mcp');

    const json = await cli(['mcp', 'sync', '--stdin', '--json'], { stdin: stdinOf({ docs: DOCS }) }, td.adminToken);
    expect(JSON.parse(json.out)).toEqual({ accepted: ['docs'], rejected: [], requiredCreds: ['mcpsync-p.DOCS_TOKEN'], shadowed: [] });
  });

  it('--strict exits 1 when something was rejected', async () => {
    const r = await cli(['mcp', 'sync', '--stdin', '--strict'], { stdin: stdinOf({ bad: { type: 'http' } }) }, td.adminToken);
    expect(r.code).toBe(1);
  });

  it('exits 1 and keeps the previous set when every server is rejected, with or without --strict', async () => {
    await cli(['mcp', 'sync', '--stdin'], { stdin: stdinOf({ docs: DOCS }) }, td.adminToken);
    const file = join(td.dataDir, 'synced-mcp.json');
    const before = readFileSync(file, 'utf8');
    const r = await cli(['mcp', 'sync', '--stdin'], { stdin: stdinOf({ bad: { type: 'http' }, tool: { command: 'x' } }) }, td.adminToken);
    expect(r.code).toBe(1);
    expect(r.out).toContain('previously synced set was kept unchanged');
    expect(r.out).toContain('rejected bad:');
    expect(r.out).not.toContain('no servers are synced now');
    expect(readFileSync(file, 'utf8')).toBe(before);
    const json = await cli(['mcp', 'sync', '--stdin', '--json'], { stdin: stdinOf({ bad: { type: 'http' } }) }, td.adminToken);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({ accepted: [], kept: true, rejected: [{ name: 'bad' }] });
    expect((await cli(['mcp', 'sync', '--stdin', '--strict'], { stdin: stdinOf({ bad: { type: 'http' } }) }, td.adminToken)).code).toBe(1);
    // Partial rejection still exits 0 without --strict.
    expect((await cli(['mcp', 'sync', '--stdin'], { stdin: stdinOf({ docs: DOCS, bad: { type: 'http' } }) }, td.adminToken)).code).toBe(0);
  });

  it('--clear removes the synced set', async () => {
    await cli(['mcp', 'sync', '--stdin'], { stdin: stdinOf({ docs: DOCS }) }, td.adminToken);
    const r = await cli(['mcp', 'sync', '--stdin', '--clear'], { stdin: stdinOf({}) }, td.adminToken);
    expect(r.code).toBe(0);
    expect(r.out).toContain('no servers are synced now');
    expect(JSON.parse(readFileSync(join(td.dataDir, 'synced-mcp.json'), 'utf8')).servers).toEqual({});
  });

  it('needs --stdin, refuses an empty set without --clear, and needs an admin token (exit 4)', async () => {
    expect((await cli(['mcp', 'sync'], {}, td.adminToken)).code).toBe(2);
    expect((await cli(['mcp', 'sync', '--stdin'], { stdin: stdinOf({}) }, td.adminToken)).code).toBe(2);
    expect((await cli(['mcp', 'sync', '--stdin', '--clear'], { stdin: stdinOf({}) }, td.adminToken)).code).toBe(0);
    expect((await cli(['mcp', 'sync', '--stdin'], { stdin: stdinOf({ docs: DOCS }) }, controlToken)).code).toBe(4);
    expect((await cli(['mcp', 'push'], {}, td.adminToken)).code).toBe(2);
  });
});
